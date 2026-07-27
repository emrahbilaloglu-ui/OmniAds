/**
 * EXECUTION proof for the staged idle worker, against a REAL PostgreSQL and the
 * REAL worker process.
 *
 * The cutover harness fakes the worker with a shell stub that always "starts".
 * That stub is why the contradiction this seam exists to prevent shipped in the
 * first place: `deploy-disabled` asserted a fresh ONLINE worker while every lane
 * was off, and the real worker treats a denied lane as fatal — so the phase was
 * unsatisfiable in production and green in CI. A stub cannot expose that,
 * because a stub has no admission logic and no CHECK constraints.
 *
 * So this runs `scripts/sync-worker.ts` itself, as a child process, against a
 * migrated database, and asserts what is actually in the tables afterwards.
 *
 * S1  the schema admits 'disabled' at all — the first staged heartbeat is an
 *     INSERT against a CHECK constraint that did not include it, and violating
 *     it crash-loops the worker on boot
 * S2  lanes off + staging on: the process STAYS UP and registers exactly one
 *     fresh 'disabled' heartbeat
 * S3  that staged worker holds nothing: zero runner leases, zero partition
 *     claims, zero checkpoint claims, zero job locks
 * S4  online_workers is 0 while it is staged — it must not read as working
 * S5  the healthcheck's --expect-staged-idle agrees, and the ordinary
 *     --min-online-workers 1 assertion FAILS against it (proving the two modes
 *     are not interchangeable and the old assertion really was unsatisfiable)
 * S6  lanes off + staging OFF: the process still EXITS non-zero. The fatal
 *     refusal is the default and the concession is opt-in only.
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const LABEL = "[staged-worker-seam]";
const DB_NAME = "staged_worker_seam";
const USER = "postgres";
const REPO_ROOT = path.resolve(__dirname, "..");

function log(message: string) {
  console.log(`${LABEL} ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`staged worker seam FAILED: ${message}`);
}

function findPgBin(): string {
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR,
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    "/usr/local/opt/postgresql@16/bin",
    ...(fs.existsSync("/usr/lib/postgresql")
      ? fs.readdirSync("/usr/lib/postgresql").map((v) => `/usr/lib/postgresql/${v}/bin`)
      : []),
    ...(process.env.PATH ?? "").split(":"),
  ].filter(Boolean) as string[];
  for (const dir of candidates) {
    if (["initdb", "pg_ctl", "createdb", "psql"].every((b) => fs.existsSync(path.join(dir, b)))) {
      return dir;
    }
  }
  throw new Error("PostgreSQL binaries not found; this seam cannot run without a real database");
}

async function freePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.on("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        const value = typeof address === "object" && address ? address.port : 0;
        server.close(() => resolve(value));
      });
    });
    if (port !== 5432 && port !== 15432) return port;
  }
  throw new Error("no safe port");
}

function run(cmd: string, args: string[], what: string) {
  const result = spawnSync(cmd, args, { encoding: "utf8" });
  if (result.status !== 0) {
    throw new Error(`${what} failed (${result.status}): ${result.stderr || result.stdout}`);
  }
  return result.stdout;
}

/** Start the REAL worker and let it run for a while. Returns how it ended. */
function startWorker(env: NodeJS.ProcessEnv) {
  const child = spawn("node", ["--import", "tsx", "scripts/sync-worker.ts"], {
    cwd: REPO_ROOT,
    env: { ...process.env, ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  let output = "";
  child.stdout.on("data", (chunk) => (output += String(chunk)));
  child.stderr.on("data", (chunk) => (output += String(chunk)));
  let exited: number | null = null;
  child.on("exit", (code) => (exited = code ?? 0));
  return {
    child,
    get output() {
      return output;
    },
    get exitCode() {
      return exited;
    },
    stop() {
      if (exited == null) child.kill("SIGTERM");
    },
  };
}

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

async function main() {
  const bin = findPgBin();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "staged-worker-seam-"));
  const dataDir = path.join(tmp, "data");
  const port = await freePort();
  let started = false;
  let client: Client | null = null;
  const workers: Array<ReturnType<typeof startWorker>> = [];

  try {
    process.env.LC_ALL = "C";
    run(path.join(bin, "initdb"), ["-D", dataDir, "-U", USER, "--auth=trust", "--no-locale"], "initdb");
    run(
      path.join(bin, "pg_ctl"),
      ["-D", dataDir, "-l", path.join(tmp, "pg.log"), "-w", "-o",
       `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`, "start"],
      "pg_ctl start",
    );
    started = true;
    run(path.join(bin, "createdb"), ["-h", "127.0.0.1", "-p", String(port), "-U", USER, DB_NAME], "createdb");

    const url = `postgresql://${USER}@127.0.0.1:${port}/${DB_NAME}`;
    const workerEnv: NodeJS.ProcessEnv = {
      DATABASE_URL: url,
      DATABASE_URL_UNPOOLED: url,
      DB_SSL_MODE: "disable",
      NODE_ENV: "production",
      INTEGRATION_TOKEN_ENCRYPTION_KEY: "staged-worker-seam-key",
      APP_BUILD_ID: "staged-worker-seam",
      SYNC_WORKER_MODE: "1",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
      // The runtime contract refuses to start in production unless these are
      // EXPLICIT. That refusal happens in scripts/sync-worker.ts before the
      // runtime is even entered, so without them this seam would only ever
      // prove that an under-configured worker exits.
      META_AUTHORITATIVE_FINALIZATION_V2: "0",
      META_RETENTION_EXECUTION_ENABLED: "0",
      SYNC_DEPLOY_GATE_MODE: "measure_only",
      SYNC_RELEASE_GATE_MODE: "measure_only",
    };

    process.env.DATABASE_URL = url;
    process.env.DATABASE_URL_UNPOOLED = url;
    process.env.DB_SSL_MODE = "disable";
    process.env.INTEGRATION_TOKEN_ENCRYPTION_KEY = "staged-worker-seam-key";
    const { resetDbClientCache } = await import("@/lib/db");
    resetDbClientCache();
    const { runMigrations } = await import("@/lib/migrations");
    await runMigrations({ force: true, reason: "staged_worker_seam" });

    client = new Client({ connectionString: url });
    await client.connect();

    // A capacity sample, as the database host's healthcheck timer supplies in
    // production. The growth fence is deliberately fatal in EVERY mode
    // including staging — being over budget is a reason not to write at all,
    // and a heartbeat is a write — so without this the seam would only ever
    // prove that the fence works, never that staging does.
    const { PHYSICAL_TELEMETRY_SOURCE, PHYSICAL_DATA_PATH } = await import(
      "@/lib/sync/db-growth-fence"
    );
    await client.query(
      `INSERT INTO system_capacity_snapshots (source, hostname, sampled_at, payload)
       VALUES ($1, 'staged-worker-seam', now(), $2::jsonb)`,
      [
        PHYSICAL_TELEMETRY_SOURCE,
        JSON.stringify({
          // A sample from another database is a sample from another machine's
          // disk, so the fence checks identity before it checks capacity.
          database: { name: DB_NAME },
          disks: [
            {
              path: PHYSICAL_DATA_PATH,
              totalBytes: 500_000_000_000,
              usedBytes: 50_000_000_000,
              availableBytes: 450_000_000_000,
            },
          ],
        }),
      ],
    );

    // ── S1. The schema admits 'disabled' ────────────────────────────────────
    //
    // This is not a formality. The staged path's FIRST heartbeat is awaited
    // with no catch, so a CHECK violation propagates out of the runtime and
    // exits the process — the exact crash-loop the staging concession exists to
    // prevent. Asserting the constraint directly says why, instead of leaving a
    // later check to fail with "the worker did not come up".
    const checkRow = await client.query<{ def: string }>(
      `SELECT pg_get_constraintdef(oid) AS def FROM pg_constraint
        WHERE conrelid = 'sync_worker_heartbeats'::regclass AND contype = 'c'
          AND pg_get_constraintdef(oid) ILIKE '%status%'`,
    );
    const defs = checkRow.rows.map((r) => r.def).join(" ");
    assert(
      defs.includes("'disabled'"),
      `S1: sync_worker_heartbeats.status does not admit 'disabled'. The staged worker's first heartbeat would violate this and exit. Constraint: ${defs || "(none found)"}`,
    );
    log("S1 PASS schema: sync_worker_heartbeats.status admits 'disabled', so a staged heartbeat can be written at all");

    // ── S2. Lanes off + staging ON: stays up, registers 'disabled' ──────────
    const staged = startWorker({
      ...workerEnv,
      SYNC_WORKER_STAGING_IDLE: "1",
      // Every lane denied. This is exactly deploy-disabled's configuration.
    });
    workers.push(staged);
    for (let i = 0; i < 40 && staged.exitCode == null; i += 1) {
      const { rows } = await client.query(
        `SELECT count(*)::int AS n FROM sync_worker_heartbeats WHERE status = 'disabled'`,
      );
      if (Number(rows[0]?.n ?? 0) > 0) break;
      await sleep(500);
    }
    assert(
      staged.exitCode == null,
      `S2: the staged worker exited with ${staged.exitCode} instead of staying up.\n${staged.output.slice(-1500)}`,
    );
    const stagedRows = await client.query<{ worker_id: string; provider_scope: string }>(
      `SELECT worker_id, provider_scope FROM sync_worker_heartbeats WHERE status = 'disabled'`,
    );
    assert(
      stagedRows.rowCount === 1,
      `S2: expected exactly one 'disabled' heartbeat, found ${stagedRows.rowCount}.\n${staged.output.slice(-1500)}`,
    );
    log(`S2 PASS staged boot: the real worker stayed up with every lane denied and registered exactly one 'disabled' heartbeat (${stagedRows.rows[0].worker_id})`);

    // ── S3. It holds nothing ────────────────────────────────────────────────
    const stagedId = stagedRows.rows[0].worker_id;
    const owned = await client.query<Record<string, number>>(
      `SELECT
         (SELECT count(*) FROM sync_runner_leases WHERE lease_owner = $1)::int          AS runner_leases,
         (SELECT count(*) FROM google_ads_runner_leases WHERE lease_owner = $1)::int    AS google_lane_leases,
         (SELECT count(*) FROM meta_sync_partitions WHERE lease_owner = $1)::int        AS meta_claims,
         (SELECT count(*) FROM google_ads_sync_partitions WHERE lease_owner = $1)::int  AS google_claims,
         (SELECT count(*) FROM meta_sync_checkpoints WHERE lease_owner = $1)::int       AS meta_checkpoints,
         (SELECT count(*) FROM google_ads_sync_checkpoints WHERE lease_owner = $1)::int AS google_checkpoints,
         (SELECT count(*) FROM provider_sync_jobs WHERE lock_owner = $1)::int           AS job_locks`,
      [stagedId],
    );
    const held = Object.entries(owned.rows[0]).filter(([, count]) => Number(count) !== 0);
    assert(
      held.length === 0,
      `S3: the staged worker holds work it must not: ${held.map(([k, v]) => `${k}=${v}`).join(", ")}`,
    );
    log("S3 PASS staged holds nothing: zero runner leases, zero lane leases, zero partition claims, zero checkpoint claims, zero job locks — across all seven tables that can grant one");

    // ── S4. It is not online ────────────────────────────────────────────────
    const { getSyncWorkerHealthSummary } = await import("@/lib/sync/worker-health");
    const summary = await getSyncWorkerHealthSummary({ onlineWindowMinutes: 5 });
    assert(
      summary.onlineWorkers === 0,
      `S4: online_workers is ${summary.onlineWorkers} while the only worker is staged. A staged worker reading as online is the failure this status exists to prevent.`,
    );
    assert(
      summary.workers.some((w) => w.workerFreshnessState === "staged"),
      `S4: no worker reported workerFreshnessState='staged'; consumers of workers[] would read it as online. Got ${JSON.stringify(summary.workers.map((w) => [w.status, w.workerFreshnessState]))}`,
    );
    log(`S4 PASS not online: online_workers=0 with a fresh staged worker present, and it reports workerFreshnessState='staged' rather than 'online'`);

    // ── S5. The healthcheck agrees, and the OLD assertion fails ─────────────
    const staged_ok = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
      "--expect-staged-idle", "--online-window-minutes", "5"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      staged_ok.status === 0,
      `S5: --expect-staged-idle did not pass against a correctly staged worker: ${staged_ok.stdout}${staged_ok.stderr}`,
    );
    const online_required = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
      "--provider-scope", "meta", "--online-window-minutes", "5", "--min-online-workers", "1"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      online_required.status !== 0,
      "S5: --min-online-workers 1 PASSED against a staged worker. That is the assertion deploy-disabled used to make, and if it passes here then a staged worker is being counted as working.",
    );
    log("S5 PASS healthcheck: --expect-staged-idle passes and --min-online-workers 1 fails against the same staged worker, so the two modes cannot be confused");

    staged.stop();
    await sleep(1500);

    // ── S6. Staging is opt-in; the fatal refusal is still the default ───────
    await client.query(`DELETE FROM sync_worker_heartbeats`);
    const unstaged = startWorker({ ...workerEnv });
    workers.push(unstaged);
    for (let i = 0; i < 40 && unstaged.exitCode == null; i += 1) await sleep(500);
    assert(
      unstaged.exitCode != null && unstaged.exitCode !== 0,
      "S6: with lanes off and SYNC_WORKER_STAGING_IDLE unset the worker stayed up. The fatal refusal must remain the default; staging is a deliberate concession, not the new behaviour.",
    );
    const leftovers = await client.query(
      `SELECT count(*)::int AS n FROM sync_worker_heartbeats WHERE status = 'disabled'`,
    );
    assert(
      Number(leftovers.rows[0].n) === 0,
      "S6: an unstaged worker wrote a 'disabled' heartbeat before exiting; refusal must happen before any heartbeat write",
    );
    log(`S6 PASS default unchanged: without staging the worker still exits (${unstaged.exitCode}) and writes no heartbeat at all`);

    console.log(`${LABEL} PASS`);
  } finally {
    for (const worker of workers) worker.stop();
    if (client) await client.end().catch(() => undefined);
    if (started) {
      spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], { encoding: "utf8" });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? (error.stack ?? error.message) : error);
  process.exit(1);
});
