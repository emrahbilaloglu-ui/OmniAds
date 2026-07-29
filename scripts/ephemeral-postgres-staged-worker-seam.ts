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

    // ── S4b. A worker shutting down is not online either ────────────────────
    //
    // The recreate in deploy-disabled leaves the OUTGOING worker's 'stopping'
    // heartbeat behind, and it stays inside the online window for minutes.
    // online_workers excluded only 'disabled', so that outgoing row counted as
    // a live worker and the staged assertion failed against a correctly staged
    // deploy — which is exactly what happened on the production cutover.
    await client.query(
      `INSERT INTO sync_worker_heartbeats (worker_id, instance_type, provider_scope, status, last_heartbeat_at)
       VALUES ('seam-outgoing-worker', 'durable_sync_worker', 'all', 'stopping', now())`,
    );
    const withOutgoing = await getSyncWorkerHealthSummary({ onlineWindowMinutes: 5 });
    assert(
      withOutgoing.onlineWorkers === 0,
      `S4b: a 'stopping' worker counted as online (online_workers=${withOutgoing.onlineWorkers}). A worker on its way out is not doing work, and after a recreate its row is still fresh.`,
    );
    await client.query(`DELETE FROM sync_worker_heartbeats WHERE worker_id = 'seam-outgoing-worker'`);
    log("S4b PASS outgoing worker: a fresh 'stopping' heartbeat does not count as an online worker, so a recreate cannot make the staged assertion fail against itself");

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

    // ── S7. The registration is DURABLE, and it refreshes ──────────────────
    //
    // Registering once is not the contract; `deploy-disabled` polls for up to a
    // minute and needs the row to still be there, still `disabled`, and getting
    // fresher, for as long as the process is up.
    const beforeRefresh = await client.query<{ status: string; at: Date }>(
      `SELECT status, last_heartbeat_at AS at FROM sync_worker_heartbeats WHERE worker_id = $1`,
      [stagedId],
    );
    await sleep(2500);
    const afterRefresh = await client.query<{ status: string; at: Date; n: string }>(
      `SELECT status, last_heartbeat_at AS at,
              (SELECT count(*) FROM sync_worker_heartbeats WHERE status = 'disabled')::text AS n
         FROM sync_worker_heartbeats WHERE worker_id = $1`,
      [stagedId],
    );
    assert(
      afterRefresh.rows[0]?.status === "disabled",
      `S7: the staged row became '${afterRefresh.rows[0]?.status}' while the process was still up`,
    );
    assert(
      afterRefresh.rows[0].at.getTime() > beforeRefresh.rows[0].at.getTime(),
      "S7: the staged heartbeat did not advance; the gate would time out against a live worker",
    );
    assert(
      afterRefresh.rows[0].n === "1",
      `S7: the staged worker is no longer a singleton (${afterRefresh.rows[0].n} disabled rows)`,
    );
    log("S7 PASS registration durable: the staged row stays 'disabled', stays a singleton, and its heartbeat advances while the process is up");

    // ── S8. The pinned build identity, end to end ──────────────────────────
    //
    // What the worker wrote has to BE the release the orchestrator pinned. The
    // heartbeat metadata and the runtime contract are written by different code
    // paths, and the check requires both.
    const buildOk = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
      "--expect-staged-idle", "--online-window-minutes", "5",
      "--expect-build-id", "staged-worker-seam"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      buildOk.status === 0,
      `S8: --expect-build-id refused the identity the worker was actually started with: ${buildOk.stdout}${buildOk.stderr}`,
    );
    const buildWrong = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
      "--expect-staged-idle", "--online-window-minutes", "5",
      "--expect-build-id", "some-other-release"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      buildWrong.status !== 0 &&
        buildWrong.stdout.includes("staged_worker_build_identity_mismatch"),
      `S8: a staged worker on the WRONG build passed. That is a stale APP_BUILD_ID certifying a release it did not build: ${buildWrong.stdout}${buildWrong.stderr}`,
    );
    log("S8 PASS build identity: --expect-build-id passes for the release the worker really is and refuses any other, so a stale env file cannot rename the running build");

    // ── S9. A registration from an earlier run does not certify this one ────
    //
    // The row is fresh and correctly staged; it just belongs to a process that
    // started before this container did. Without the run check, a worker that
    // never came up at all is certified by its predecessor.
    const futureStart = new Date(Date.now() + 60_000).toISOString();
    const notThisRun = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
      "--expect-staged-idle", "--online-window-minutes", "5",
      "--min-heartbeat-after", futureStart],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      notThisRun.status !== 0 &&
        notThisRun.stdout.includes("staged_worker_is_not_this_run"),
      `S9: a staged worker that predates the container start passed: ${notThisRun.stdout}${notThisRun.stderr}`,
    );
    log("S9 PASS wrong run refused: a correctly staged row that predates this container's start is refused, so a previous run cannot certify one that never booted");

    // ── S10. Shutdown moves the row once, and nothing puts it back ──────────
    //
    // THE production incident, at the level it actually happened. Every scope's
    // heartbeat upserts ON CONFLICT (worker_id) and `all` maps to the bare
    // worker id, so `stopping` and the staged registration are the SAME ROW.
    // Two signal handlers used to fire on one SIGTERM and a refresh tick could
    // still be in flight, so the row's final value was decided by a race.
    staged.stop();
    await sleep(2500);
    const afterStop = await client.query<{ status: string; at: Date }>(
      `SELECT status, last_heartbeat_at AS at FROM sync_worker_heartbeats WHERE worker_id = $1`,
      [stagedId],
    );
    assert(
      afterStop.rows[0]?.status === "stopping",
      `S10: after SIGTERM the staged row is '${afterStop.rows[0]?.status}', not 'stopping'. A refresh landed after the shutdown and resurrected a worker that no longer exists.`,
    );
    await sleep(2000);
    const settledAfterStop = await client.query<{ status: string; at: Date }>(
      `SELECT status, last_heartbeat_at AS at FROM sync_worker_heartbeats WHERE worker_id = $1`,
      [stagedId],
    );
    assert(
      settledAfterStop.rows[0]?.status === "stopping" &&
        settledAfterStop.rows[0].at.getTime() === afterStop.rows[0].at.getTime(),
      "S10: the row kept changing after shutdown; the refresh timer outlived the process's own shutdown",
    );
    const stagedAfterStop = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
      "--expect-staged-idle", "--online-window-minutes", "5"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      stagedAfterStop.status !== 0,
      `S10: --expect-staged-idle still passes against a worker that has shut down: ${stagedAfterStop.stdout}`,
    );
    log("S10 PASS shutdown is final: SIGTERM moves the row disabled -> stopping exactly once, nothing puts 'disabled' back, and the staged assertion stops passing");

    // ── S10b. The same invariant with a refresh always outstanding ──────────
    //
    // Driving the refresh as fast as the event loop allows means a write is
    // essentially always in flight when the signal lands. This is a GUARD, not
    // a reproduction: pooled writes complete in the order they were issued, so
    // an earlier `disabled` returning after a later `stopping` is not something
    // this harness can force. It holds the ordering against a future change —
    // a retry, a second connection, a queue — that would make the two
    // genuinely concurrent on the one upsert key they share.
    await client.query(`DELETE FROM sync_worker_heartbeats`);
    const contended = startWorker({
      ...workerEnv,
      SYNC_WORKER_STAGING_IDLE: "1",
      WORKER_HEARTBEAT_INTERVAL_MS: "1",
    });
    workers.push(contended);
    let contendedId: string | null = null;
    for (let i = 0; i < 40 && contended.exitCode == null; i += 1) {
      const { rows } = await client.query<{ worker_id: string }>(
        `SELECT worker_id FROM sync_worker_heartbeats WHERE status = 'disabled'`,
      );
      if (rows[0]) {
        contendedId = rows[0].worker_id;
        break;
      }
      await sleep(250);
    }
    assert(
      contendedId != null,
      `S10b: the contended worker never registered.\n${contended.output.slice(-1500)}`,
    );
    await sleep(1000);
    contended.stop();
    await sleep(3000);
    const contendedRow = await client.query<{ status: string }>(
      `SELECT status FROM sync_worker_heartbeats WHERE worker_id = $1`,
      [contendedId],
    );
    assert(
      contendedRow.rows[0]?.status === "stopping",
      `S10b: with a refresh in flight the row settled on '${contendedRow.rows[0]?.status}' instead of 'stopping'. Shutdown raced its own refresh for the same upsert key, and the deploy gate reads whichever won.`,
    );
    log("S10b PASS no race: with a refresh outstanding at every instant, SIGTERM still settles the row on 'stopping' — shutdown drains the refresh instead of racing it");

    // ── S11. A renamed build refuses to start at all ────────────────────────
    //
    // docker-compose `environment:` overrides the image's own ENV, so a stale
    // .env.production renames the running build without changing a byte of it.
    // The worker must not register under either name.
    await client.query(`DELETE FROM sync_worker_heartbeats`);
    const renamed = startWorker({
      ...workerEnv,
      SYNC_WORKER_STAGING_IDLE: "1",
      ADSECUTE_IMAGE_BUILD_ID: "staged-worker-seam",
      APP_BUILD_ID: "a-stale-release-from-the-env-file",
    });
    workers.push(renamed);
    for (let i = 0; i < 40 && renamed.exitCode == null; i += 1) await sleep(500);
    assert(
      renamed.exitCode != null && renamed.exitCode !== 0,
      `S11: a worker whose APP_BUILD_ID disagrees with the image it was built from stayed up.\n${renamed.output.slice(-1500)}`,
    );
    const renamedRows = await client.query<{ n: string }>(
      `SELECT count(*)::text AS n FROM sync_worker_heartbeats`,
    );
    assert(
      renamedRows.rows[0].n === "0",
      `S11: it wrote ${renamedRows.rows[0].n} heartbeat(s) before refusing; the identity must be settled before anything is written`,
    );
    log(`S11 PASS renamed build refused: image identity and APP_BUILD_ID disagreeing exits the worker (${renamed.exitCode}) before it registers as either release`);

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
