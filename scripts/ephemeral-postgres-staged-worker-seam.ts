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

    // ── S12. The OUTGOING worker's lane rows, and retiring them ────────────
    //
    // The second production defect, end to end. A worker on the OLD build
    // retires `all` on shutdown and leaves meta / shopify / google_ads at
    // running or idle. Those rows stay inside the online window, so a staged
    // worker that is in every way correct still fails `deploy-disabled` — and
    // the phase polls for sixty seconds, far less than the five-minute window
    // it would have to outlast.
    //
    // Old code cannot be made to retire them; it is already running. So the
    // incoming release retires its predecessor, and only when it can prove the
    // predecessor is gone.
    await client.query(`DELETE FROM sync_worker_heartbeats`);
    const OUTGOING = "sync-worker:18:seamoutgoing";
    const outgoingStartedAt = "2026-07-29T12:22:03.480Z";
    const outgoingBuild = "8de30c461c51d3e76e7cd5cc4fb71984751d014e";
    // TypeScript loses the outer null-narrowing inside a closure, and a bare
    // assertion at each call site would be noise.
    const db = client;
    const seedOutgoing = async () => {
      await db.query(`DELETE FROM sync_worker_heartbeats WHERE worker_id LIKE $1`, [`${OUTGOING}%`]);
      for (const [scope, status] of [
        ["all", "stopping"],
        ["meta", "running"],
        ["shopify", "idle"],
        ["google_ads", "idle"],
      ] as const) {
        await db.query(
          `INSERT INTO sync_worker_heartbeats
             (worker_id, instance_type, provider_scope, status, last_heartbeat_at, meta_json)
           VALUES ($1, 'durable_sync_worker', $2, $3,
                   CASE WHEN $2 = 'all' THEN now() ELSE now() - interval '3 seconds' END,
                   $4::jsonb)`,
          [
            scope === "all" ? OUTGOING : `${OUTGOING}:${scope}`,
            scope,
            status,
            JSON.stringify({ workerBuildId: outgoingBuild, workerStartedAt: outgoingStartedAt }),
          ],
        );
      }
    };
    await seedOutgoing();

    // A correctly staged worker on the NEW build, alongside it.
    const upgraded = startWorker({
      ...workerEnv,
      SYNC_WORKER_STAGING_IDLE: "1",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
    });
    workers.push(upgraded);
    let upgradedId: string | null = null;
    for (let i = 0; i < 40 && upgraded.exitCode == null; i += 1) {
      const { rows } = await client.query<{ worker_id: string }>(
        `SELECT worker_id FROM sync_worker_heartbeats WHERE status = 'disabled'`,
      );
      if (rows[0]) { upgradedId = rows[0].worker_id; break; }
      await sleep(500);
    }
    assert(upgradedId != null, `S12: the staged worker never registered.\n${upgraded.output.slice(-1200)}`);

    const stagedCheck = () =>
      spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
        "--expect-staged-idle", "--online-window-minutes", "5"],
        { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });

    const before = stagedCheck();
    assert(
      before.status !== 0 && before.stdout.includes("unexpected_online_workers"),
      `S12: the incident shape did not fail the gate. The outgoing worker's lane rows must count as online: ${before.stdout.slice(0, 900)}`,
    );
    log("S12 PASS incident reproduced: with the outgoing worker's lane rows left at running/idle, a correctly staged worker still fails on unexpected_online_workers");

    // ── S13. Retirement: capture, prove stopped, retire exactly those rows ──
    const censusPath = path.join(tmp, "outgoing-census.json");
    const capture = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "capture", "--runtime-instance-id", OUTGOING, "--out", censusPath],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(capture.status === 0, `S13: capture failed: ${capture.stdout}${capture.stderr}`);
    const census = JSON.parse(fs.readFileSync(censusPath, "utf8"));
    assert(
      census.rows.length === 4 && census.buildId === outgoingBuild,
      `S13: the census did not record all four scopes with the outgoing build: ${JSON.stringify(census).slice(0, 400)}`,
    );

    // Without the explicit container-stopped assertion it refuses.
    const noAssertion = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "retire", "--census", censusPath,
      "--container-finished-at", new Date(Date.now() + 5_000).toISOString()],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      noAssertion.status !== 0,
      "S13: retirement proceeded without the caller asserting the container is stopped",
    );

    const retire = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "retire", "--census", censusPath, "--container-stopped",
      "--container-finished-at", new Date(Date.now() + 5_000).toISOString(),
      "--heartbeat-interval-ms", "1000"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(retire.status === 0, `S13: retirement refused a genuinely stopped worker: ${retire.stdout}${retire.stderr}`);

    const afterRows = await client.query<{ worker_id: string; status: string }>(
      `SELECT worker_id, status FROM sync_worker_heartbeats WHERE worker_id LIKE $1 ORDER BY worker_id`,
      [`${OUTGOING}%`],
    );
    assert(
      afterRows.rows.every((r) => r.status === "stopping"),
      `S13: not every outgoing row reached a terminal state: ${JSON.stringify(afterRows.rows)}`,
    );
    // The staged worker is untouched.
    const stagedStill = await client.query<{ status: string }>(
      `SELECT status FROM sync_worker_heartbeats WHERE worker_id = $1`, [upgradedId],
    );
    assert(
      stagedStill.rows[0]?.status === "disabled",
      `S13: retirement disturbed the staged worker (${stagedStill.rows[0]?.status})`,
    );

    const after = stagedCheck();
    assert(
      after.status === 0,
      `S13: the compound predicate still refuses after retirement: ${after.stdout.slice(0, 900)}`,
    );
    log("S13 PASS retirement works: capture -> proven stopped -> retire transitions exactly the outgoing rows, the staged worker is untouched, and the UNCHANGED compound predicate now passes");

    // ── S14. Retirement refuses a worker that is still alive ───────────────
    //
    // The dangerous failure mode: hiding a worker that is still holding work.
    await seedOutgoing();
    const liveCapture = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "capture", "--runtime-instance-id", OUTGOING, "--out", censusPath],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(liveCapture.status === 0, `S14: capture failed: ${liveCapture.stdout}${liveCapture.stderr}`);
    // The worker beats once more — exactly what a live process does.
    await client.query(
      `UPDATE sync_worker_heartbeats SET last_heartbeat_at = now() WHERE worker_id = $1`,
      [`${OUTGOING}:meta`],
    );
    const liveRetire = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "retire", "--census", censusPath, "--container-stopped",
      // The container exited BEFORE that extra beat, so the beat cannot be part
      // of its shutdown.
      "--container-finished-at", new Date(Date.now() - 60_000).toISOString(),
      "--heartbeat-interval-ms", "1000"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    // The refusal is now named more precisely than "it moved": the row wrote past
    // the canonical shutdown write, so it is not this worker's shutdown. Movement
    // BEFORE that point is the graceful-stop case and S19 proves it is accepted.
    assert(
      liveRetire.status !== 0 &&
        /heartbeat_after_container_exit|wrote_during_stability_window/.test(liveRetire.stdout),
      `S14: a worker that beat past its own shutdown was retired anyway: ${liveRetire.stdout.slice(0, 600)}`,
    );
    const stillRunning = await client.query<{ status: string }>(
      `SELECT status FROM sync_worker_heartbeats WHERE worker_id = $1`, [`${OUTGOING}:meta`],
    );
    assert(
      stillRunning.rows[0]?.status === "running",
      `S14: the live row was modified despite the refusal (${stillRunning.rows[0]?.status})`,
    );
    log("S14 PASS liveness refused: a worker that beats after its container exited is refused, and nothing it owns is modified");

    // ── S15. Retirement refuses a worker still holding work ────────────────
    const bizId = "00000000-0000-4000-8000-0000000000ab";
    await client.query(
      `INSERT INTO businesses (id, name) VALUES ($1, 'seam-retirement') ON CONFLICT (id) DO NOTHING`,
      [bizId],
    ).catch(() => undefined);
    await client.query(
      `UPDATE sync_worker_heartbeats SET last_heartbeat_at = (SELECT last_heartbeat_at FROM sync_worker_heartbeats WHERE worker_id = $1) WHERE worker_id = $1`,
      [`${OUTGOING}:meta`],
    );
    await seedOutgoing();
    const workCapture = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "capture", "--runtime-instance-id", OUTGOING, "--out", censusPath],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(workCapture.status === 0, `S15: capture failed: ${workCapture.stdout}${workCapture.stderr}`);
    const leaseInserted = await client
      .query(
        `INSERT INTO sync_runner_leases (business_id, provider_scope, lease_owner, lease_expires_at)
         VALUES ($1, 'meta', $2, now() + interval '5 minutes')
         ON CONFLICT DO NOTHING`,
        [bizId, `${OUTGOING}:meta`],
      )
      .then(() => true)
      .catch(() => false);
    if (leaseInserted) {
      const workRetire = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
        "retire", "--census", censusPath, "--container-stopped",
      "--container-finished-at", new Date(Date.now() + 5_000).toISOString(),
      "--heartbeat-interval-ms", "1000"],
        { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
      assert(
        workRetire.status !== 0 && workRetire.stdout.includes("worker_holds_work"),
        `S15: a worker holding a runner lease was retired: ${workRetire.stdout.slice(0, 600)}`,
      );
      await client.query(`DELETE FROM sync_runner_leases WHERE lease_owner = $1`, [`${OUTGOING}:meta`]);
      log("S15 PASS owned work refused: a worker still holding a runner lease is refused rather than hidden");
    } else {
      log("S15 SKIP owned work: could not seed a runner lease on this schema");
    }

    // ── S16. A REAL worker, captured alive, stopped, then retired ──────────
    //
    // S12-S15 seed the outgoing rows, which models the end state and proves
    // nothing about how the database reaches it. A real shutdown ALSO advances
    // the `all` row's heartbeat as it writes its own `stopping`, and a liveness
    // check placed ahead of the terminal short-circuit refuses exactly that —
    // the sequence this whole operation exists for. Only stopping a real worker
    // exercises it.
    upgraded.stop();
    await sleep(2000);
    await client.query(`DELETE FROM sync_worker_heartbeats`);

    const realWorker = startWorker({
      ...workerEnv,
      ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
      ADSECUTE_SYNC_LANE_META_SYNC_ENABLED: "enabled",
      ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED: "enabled",
      ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED: "enabled",
    });
    workers.push(realWorker);
    let realScopes = 0;
    for (let i = 0; i < 60 && realWorker.exitCode == null; i += 1) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sync_worker_heartbeats
          WHERE status NOT IN ('disabled','stopping','stopped')`,
      );
      realScopes = Number(rows[0]?.n ?? 0);
      if (realScopes >= 2) break;
      await sleep(500);
    }
    assert(
      realScopes >= 2,
      `S16: the real worker never registered its scopes (saw ${realScopes}).\n${realWorker.output.slice(-1500)}`,
    );

    // Captured WHILE IT IS RUNNING, which is the only honest moment for it.
    const realCensusPath = path.join(tmp, "real-census.json");
    const realCapture = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "capture", "--online-instance", "--out", realCensusPath],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(realCapture.status === 0, `S16: capture of the live worker failed: ${realCapture.stdout}${realCapture.stderr}`);
    const realCensus = JSON.parse(fs.readFileSync(realCensusPath, "utf8"));
    const censusAll = realCensus.rows.find((r: { providerScope: string }) => r.providerScope === "all");
    assert(censusAll != null, "S16: the census recorded no `all` row for the live worker");

    // Now stop it for real. Its own shutdown writes `stopping` and MOVES the
    // timestamps of every scope it retires.
    realWorker.stop();
    for (let i = 0; i < 40 && realWorker.exitCode == null; i += 1) await sleep(250);
    await sleep(1500);
    const movedAll = await client.query<{ status: string; at: Date }>(
      `SELECT status, last_heartbeat_at AS at FROM sync_worker_heartbeats WHERE worker_id = $1`,
      [realCensus.runtimeInstanceId],
    );
    // `stopping` then a final `stopped`: the ordinary path writes both on the way
    // out. Either is terminal, and which one lands last is not what this proves.
    assert(
      ["stopping", "stopped"].includes(String(movedAll.rows[0]?.status)),
      `S16: the stopped worker's all row is '${movedAll.rows[0]?.status}', which is not a terminal state`,
    );
    assert(
      movedAll.rows[0].at.getTime() > new Date(censusAll.lastHeartbeatAt).getTime(),
      "S16: the all row did not advance on shutdown, so this does not exercise the sequence at all",
    );

    const realRetire = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "retire", "--census", realCensusPath, "--container-stopped",
      "--container-finished-at", new Date(Date.now() + 5_000).toISOString(),
      "--heartbeat-interval-ms", "1000"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      realRetire.status === 0,
      `S16: retirement refused a genuinely stopped REAL worker whose all row moved during its own shutdown: ${realRetire.stdout}${realRetire.stderr}`,
    );
    const realAfter = await client.query<{ worker_id: string; status: string }>(
      `SELECT worker_id, status FROM sync_worker_heartbeats WHERE worker_id LIKE $1`,
      [`${realCensus.runtimeInstanceId}%`],
    );
    assert(
      realAfter.rows.length > 0 &&
        realAfter.rows.every((r) => ["stopping", "stopped"].includes(r.status)),
      `S16: not every scope of the real worker is terminal: ${JSON.stringify(realAfter.rows)}`,
    );
    const zeroOnline = await getSyncWorkerHealthSummary({ onlineWindowMinutes: 5 });
    assert(
      zeroOnline.onlineWorkers === 0,
      `S16: online_workers is ${zeroOnline.onlineWorkers} after retiring the real worker; the compound predicate would still refuse`,
    );
    log(`S16 PASS real sequence: a live worker was captured while running, stopped for real — its own shutdown moved the all row's timestamp, which is the movement a liveness check placed too early would refuse — and retirement then accepted it across ${realAfter.rows.length} scope(s), leaving online_workers at 0`);

    await client.query(`DELETE FROM sync_worker_heartbeats`);

    // ── S17. Provenance stamps must not block retirement ──────────────────
    //
    // The live-host refusal. A real worker's checkpoints keep `lease_owner`
    // forever with `lease_expires_at IS NULL` — 185 meta and 161 google on
    // production — because that column records who last ADVANCED the checkpoint,
    // not who holds it. Gating retirement on rows that merely bear the name
    // means no worker that has ever done work can be retired, which is why every
    // seeded seam above passed while the real host refused.
    await client.query(`DELETE FROM sync_worker_heartbeats`);
    const STAMPED = "sync-worker:18:seamstamped";
    const stampedStartedAt = "2026-07-29T12:22:03.480Z";
    const stampedBuild = "8de30c461c51d3e76e7cd5cc4fb71984751d014e";
    for (const [scope, status] of [["all", "stopping"], ["meta", "running"]] as const) {
      await db.query(
        `INSERT INTO sync_worker_heartbeats
           (worker_id, instance_type, provider_scope, status, last_heartbeat_at, meta_json)
         VALUES ($1, 'durable_sync_worker', $2, $3,
                 CASE WHEN $2 = 'all' THEN now() ELSE now() - interval '3 seconds' END,
                 $4::jsonb)`,
        [
          scope === "all" ? STAMPED : `${STAMPED}:${scope}`,
          scope, status,
          JSON.stringify({ workerBuildId: stampedBuild, workerStartedAt: stampedStartedAt }),
        ],
      );
    }
    // Provenance: the owner names this worker, but the lease is NOT in force.
    //
    // On production the shape is a checkpoint with `lease_expires_at IS NULL`;
    // here it is a runner lease already lapsed. Both are the same fact — a row
    // bearing the worker's name that nobody holds — and a runner lease needs no
    // partition/account FK chain, so the proof does not depend on constructing
    // one. What matters is that the two definitions DISAGREE about this row and
    // that only the held-work one gates.
    const stampBiz = "00000000-0000-4000-8000-0000000000cd";
    await client.query(
      `INSERT INTO businesses (id, name) VALUES ($1, 'seam-stamped') ON CONFLICT (id) DO NOTHING`,
      [stampBiz],
    ).catch(() => undefined);
    await client.query(
      `INSERT INTO sync_runner_leases (business_id, provider_scope, lease_owner, lease_expires_at)
       VALUES ($1, 'meta', $2, now() - interval '10 minutes')
       ON CONFLICT (business_id, provider_scope) DO UPDATE
         SET lease_owner = EXCLUDED.lease_owner, lease_expires_at = EXCLUDED.lease_expires_at`,
      [stampBiz, `${STAMPED}:meta`],
    );

    // The two definitions must genuinely differ on this row, or the test proves
    // nothing: the shared helper counts it, the held-work rule does not.
    const { getSyncWorkerOwnedWorkUnits } = await import("@/lib/sync/worker-health");
    const { readHeldWorkForWorker } = await import("@/lib/sync/worker-retirement");
    const ownedStamp = await getSyncWorkerOwnedWorkUnits([`${STAMPED}:meta`]);
    const heldStamp = await readHeldWorkForWorker([`${STAMPED}:meta`]);
    assert(
      ownedStamp.runnerLeases === 1,
      `S17: the shared owned-work helper must still count a lapsed row by name (got ${ownedStamp.runnerLeases}); if it does not, this case proves nothing`,
    );
    assert(
      heldStamp.runnerLeases === 0,
      `S17: a LAPSED lease is still being counted as held (${heldStamp.runnerLeases}); that is the live-host refusal`,
    );

    const stampCensus = path.join(tmp, "stamped-census.json");
    const sCap = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "capture", "--runtime-instance-id", STAMPED, "--out", stampCensus],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(sCap.status === 0, `S17: capture failed: ${sCap.stdout}${sCap.stderr}`);
    const sRet = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "retire", "--census", stampCensus, "--container-stopped",
      "--container-finished-at", new Date(Date.now() + 5_000).toISOString(),
      "--heartbeat-interval-ms", "1000"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      sRet.status === 0,
      `S17: a lapsed lease bearing the worker's name blocked retirement, which is the exact live-host refusal: ${sRet.stdout}${sRet.stderr}`,
    );
    const sPayload = JSON.parse(sRet.stdout.slice(sRet.stdout.indexOf("{")));
    assert(
      Object.values(sPayload.heldWork as Record<string, number>).every((n) => n === 0),
      `S17: heldWork should be zero for a lapsed lease: ${JSON.stringify(sPayload.heldWork)}`,
    );
    assert(
      sPayload.ownedWorkUnits.runnerLeases === 1,
      `S17: the report should still SHOW the row by name, for the operator: ${JSON.stringify(sPayload.ownedWorkUnits)}`,
    );
    // The row itself is not touched: retirement writes only heartbeat rows.
    const stampAfter = await client.query<{ lease_owner: string }>(
      `SELECT lease_owner FROM sync_runner_leases WHERE business_id = $1 AND provider_scope = 'meta'`,
      [stampBiz],
    );
    assert(
      stampAfter.rows[0]?.lease_owner === `${STAMPED}:meta`,
      "S17: retirement modified a lease row; its blast radius is sync_worker_heartbeats only",
    );
    await client.query(`DELETE FROM sync_runner_leases WHERE lease_owner LIKE $1`, [`${STAMPED}%`]);
    log("S17 PASS provenance not held: a lapsed lease bearing the worker's name is counted by the shared helper but NOT held, so retirement proceeds, reports it for the operator, and leaves the row untouched");

    // ── S18. A lease still IN FORCE refuses, and the bounded wait clears it ─
    await client.query(`DELETE FROM sync_worker_heartbeats WHERE worker_id LIKE $1`, [`${STAMPED}%`]);
    for (const [scope, status] of [["all", "stopping"], ["meta", "running"]] as const) {
      await db.query(
        `INSERT INTO sync_worker_heartbeats
           (worker_id, instance_type, provider_scope, status, last_heartbeat_at, meta_json)
         VALUES ($1, 'durable_sync_worker', $2, $3,
                 CASE WHEN $2 = 'all' THEN now() ELSE now() - interval '3 seconds' END,
                 $4::jsonb)`,
        [
          scope === "all" ? STAMPED : `${STAMPED}:${scope}`,
          scope, status,
          JSON.stringify({ workerBuildId: stampedBuild, workerStartedAt: stampedStartedAt }),
        ],
      );
    }
    const liveLease = await client
      .query(
        `INSERT INTO sync_runner_leases (business_id, provider_scope, lease_owner, lease_expires_at)
         VALUES ($1, 'meta', $2, now() + interval '6 seconds')
         ON CONFLICT (business_id, provider_scope) DO UPDATE
           SET lease_owner = EXCLUDED.lease_owner, lease_expires_at = EXCLUDED.lease_expires_at`,
        [stampBiz, `${STAMPED}:meta`],
      )
      .then(() => true)
      .catch(() => false);
    if (liveLease) {
      const wCap = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
        "capture", "--runtime-instance-id", STAMPED, "--out", stampCensus],
        { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
      assert(wCap.status === 0, `S18: capture failed: ${wCap.stdout}${wCap.stderr}`);

      // No budget: a lease in force refuses immediately.
      const noWait = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
        "retire", "--census", stampCensus, "--container-stopped",
      "--container-finished-at", new Date(Date.now() + 5_000).toISOString(),
      "--heartbeat-interval-ms", "1000"],
        { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
      assert(
        noWait.status !== 0 && noWait.stdout.includes("worker_holds_work"),
        `S18: a lease in force was accepted with no wait budget: ${noWait.stdout.slice(0, 500)}`,
      );

      // With a budget, it waits for THAT row to lapse and then proceeds.
      const waited = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
        "retire", "--census", stampCensus, "--container-stopped",
        "--container-finished-at", new Date(Date.now() + 120_000).toISOString(),
        "--heartbeat-interval-ms", "500",
        "--wait-for-held-work-seconds", "40"],
        { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
      assert(
        waited.status === 0,
        `S18: the bounded wait did not clear a lease that lapses in 6s: ${waited.stdout}${waited.stderr}`,
      );
      const wPayload = JSON.parse(waited.stdout.slice(waited.stdout.indexOf("{")));
      assert(
        wPayload.waitedForHeldWorkMs > 0,
        `S18: retirement reported no wait despite a lease in force at the start: ${JSON.stringify(wPayload.waitedForHeldWorkMs)}`,
      );
      await client.query(`DELETE FROM sync_runner_leases WHERE lease_owner LIKE $1`, [`${STAMPED}%`]);
      log(`S18 PASS lease in force: refused with no budget, then cleared by waiting ${wPayload.waitedForHeldWorkMs}ms for that exact row to lapse — a deadline that passes still refuses`);
    } else {
      log("S18 SKIP lease in force: could not seed a runner lease on this schema");
    }
    await client.query(`DELETE FROM sync_worker_heartbeats`);

    // ── S19. THE INCIDENT, against a real worker and a real graceful stop ──
    //
    // Production refused `row_moved` because `google_ads` legitimately advanced
    // between the pre-stop census and the moment the container reached stopped:
    // a graceful shutdown keeps beating while it finishes. Comparing every
    // post-stop row to the pre-stop census is therefore incompatible with any
    // real graceful stop — and blindly accepting movement would hide a live
    // worker. This proves the replacement: movement is accepted only when it is
    // bounded by the canonical shutdown write and the container's own exit, and
    // only when a two-sample window shows nothing writing now.
    await client.query(`DELETE FROM sync_worker_heartbeats`);
    const graceful = startWorker({
      ...workerEnv,
      ADSECUTE_SYNC_GLOBAL_ENABLED: "enabled",
      ADSECUTE_SYNC_LANE_META_SYNC_ENABLED: "enabled",
      ADSECUTE_SYNC_LANE_GOOGLE_SYNC_ENABLED: "enabled",
      ADSECUTE_SYNC_LANE_SHOPIFY_SYNC_ENABLED: "enabled",
      WORKER_HEARTBEAT_INTERVAL_MS: "500",
    });
    workers.push(graceful);
    let scopes = 0;
    for (let i = 0; i < 60 && graceful.exitCode == null; i += 1) {
      const { rows } = await client.query<{ n: string }>(
        `SELECT count(*)::text AS n FROM sync_worker_heartbeats
          WHERE status NOT IN ('disabled','stopping','stopped')`,
      );
      scopes = Number(rows[0]?.n ?? 0);
      if (scopes >= 2) break;
      await sleep(400);
    }
    assert(scopes >= 2, `S19: the worker never registered its scopes.\n${graceful.output.slice(-1200)}`);

    // Captured while it is RUNNING — the immutable identity/scope binding.
    const gCensusPath = path.join(tmp, "graceful-census.json");
    const gCap = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "capture", "--online-instance", "--out", gCensusPath],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(gCap.status === 0, `S19: capture failed: ${gCap.stdout}${gCap.stderr}`);
    const gCensus = JSON.parse(fs.readFileSync(gCensusPath, "utf8"));

    // Let it keep beating AFTER the census, which is the incident's precondition.
    await sleep(1500);
    graceful.stop();
    for (let i = 0; i < 60 && graceful.exitCode == null; i += 1) await sleep(250);
    assert(graceful.exitCode != null, "S19: the worker did not exit");
    const finishedAt = new Date().toISOString();
    await sleep(500);

    // The precondition really happened: at least one scope moved past its census.
    const post = await client.query<{ worker_id: string; last_heartbeat_at: Date }>(
      `SELECT worker_id, last_heartbeat_at FROM sync_worker_heartbeats
        WHERE worker_id = $1 OR worker_id LIKE $2`,
      [gCensus.runtimeInstanceId, `${gCensus.runtimeInstanceId}:%`],
    );
    const movedScopes = post.rows.filter((r) => {
      const censused = gCensus.rows.find((c: { workerId: string }) => c.workerId === r.worker_id);
      return censused && r.last_heartbeat_at.getTime() > new Date(censused.lastHeartbeatAt).getTime();
    });
    assert(
      movedScopes.length > 0,
      "S19: no row advanced after the census, so this run does not reproduce the incident at all",
    );

    const gRet = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "retire", "--census", gCensusPath, "--container-stopped",
      "--container-finished-at", finishedAt, "--heartbeat-interval-ms", "500"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      gRet.status === 0,
      `S19: retirement refused a real graceful stop whose rows advanced during it — the exact production refusal: ${gRet.stdout}${gRet.stderr}`,
    );
    const gPayload = JSON.parse(gRet.stdout.slice(gRet.stdout.indexOf("{")));
    assert(
      Array.isArray(gPayload.diagnostics?.movedDuringGracefulStop) &&
        gPayload.diagnostics.movedDuringGracefulStop.length > 0,
      `S19: the proof did not record the movement it accepted: ${JSON.stringify(gPayload.diagnostics)}`,
    );
    const gAfter = await client.query<{ status: string }>(
      `SELECT status FROM sync_worker_heartbeats WHERE worker_id = $1 OR worker_id LIKE $2`,
      [gCensus.runtimeInstanceId, `${gCensus.runtimeInstanceId}:%`],
    );
    assert(
      gAfter.rows.every((r) => ["stopping", "stopped"].includes(r.status)),
      `S19: not every scope is terminal after retirement: ${JSON.stringify(gAfter.rows)}`,
    );
    const gOnline = await getSyncWorkerHealthSummary({ onlineWindowMinutes: 5 });
    assert(
      gOnline.onlineWorkers === 0,
      `S19: online_workers is ${gOnline.onlineWorkers}; the compound predicate would still refuse`,
    );
    log(`S19 PASS the incident, resolved: a real worker's scope advanced ${movedScopes.length} time(s) after the census during a genuine graceful stop, retirement ACCEPTED it on positive post-stop proof (canonical terminal + exit-time bound + two-sample silence), and online_workers fell to 0`);

    // ── S20. A write after the proof still refuses ─────────────────────────
    //
    // The accepted movement above must not become a licence to accept any
    // movement. A row that advances past the canonical shutdown write is not
    // this worker's shutdown, whatever the census said.
    const laneId = `${gCensus.runtimeInstanceId}:meta`;
    await client.query(
      `UPDATE sync_worker_heartbeats SET status = 'running', last_heartbeat_at = now() + interval '1 hour'
        WHERE worker_id = $1`,
      [laneId],
    );
    const gRet2 = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-retire.ts",
      "retire", "--census", gCensusPath, "--container-stopped",
      "--container-finished-at", finishedAt, "--heartbeat-interval-ms", "500"],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(
      gRet2.status !== 0 && /heartbeat_after_container_exit/.test(gRet2.stdout),
      `S20: a row writing an hour after the container exited was accepted: ${gRet2.stdout.slice(0, 700)}`,
    );
    log("S20 PASS movement is not blanket-accepted: a row that writes after the container's exit still refuses, so accepting graceful-stop movement is not a licence to accept any movement");
    await client.query(`DELETE FROM sync_worker_heartbeats`);

    // ── S21. The EVIDENCE chain, against a real database ───────────────────
    //
    // The rehearsal that "passed" while broken: the verbose payload passed 64 KiB,
    // the shell capture truncated it, the parse raised, the staged worker id came
    // out empty, and the verdict stood. The checker's exit code was 0 and that
    // was allowed to stand for the whole proof. So the artifact is bounded, and
    // it is verified by a separate program that exits non-zero.
    await client.query(`DELETE FROM sync_worker_heartbeats`);
    const evidenceWorker = startWorker({
      ...workerEnv,
      SYNC_WORKER_STAGING_IDLE: "1",
      WORKER_HEARTBEAT_INTERVAL_MS: "1000",
    });
    workers.push(evidenceWorker);
    let evidenceId: string | null = null;
    for (let i = 0; i < 40 && evidenceWorker.exitCode == null; i += 1) {
      const { rows } = await client.query<{ worker_id: string }>(
        `SELECT worker_id FROM sync_worker_heartbeats WHERE status = 'disabled'`,
      );
      if (rows[0]) { evidenceId = rows[0].worker_id; break; }
      await sleep(400);
    }
    assert(evidenceId != null, `S21: the staged worker never registered.\n${evidenceWorker.output.slice(-1200)}`);

    // Bulk the verbose payload past 64 KiB, exactly as a real fleet does, so the
    // artifact's boundedness is proven against the condition that broke it.
    for (let i = 0; i < 260; i += 1) {
      await client.query(
        `INSERT INTO sync_worker_heartbeats
           (worker_id, instance_type, provider_scope, status, last_heartbeat_at, meta_json)
         VALUES ($1, 'durable_sync_worker', 'meta', 'stopped', now() - interval '2 hours', $2::jsonb)`,
        [
          `sync-worker:${i}:seamnoise`,
          JSON.stringify({
            consumeStage: "lifecycle_tick_succeeded".repeat(4),
            batchBusinessIds: Array.from({ length: 8 }, (_, n) => `biz-${i}-${n}`),
            runtimeContract: { buildId: "staged-worker-seam", issueCodes: [] },
          }),
        ],
      );
    }
    const summaryPath = path.join(tmp, "staged-summary.json");
    const verbosePath = path.join(tmp, "staged-verbose.json");
    const check = spawnSync("node", ["--import", "tsx", "scripts/sync-worker-healthcheck.ts",
      "--expect-staged-idle", "--online-window-minutes", "5",
      "--summary-out", summaryPath],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8", maxBuffer: 64 * 1024 * 1024 });
    fs.writeFileSync(verbosePath, check.stdout);
    assert(check.status === 0, `S21: the staged predicate refused: ${check.stdout.slice(-800)}`);
    assert(
      check.stdout.length > 65_536,
      `S21: the verbose payload is only ${check.stdout.length} bytes, so this does not exercise the truncation condition`,
    );
    const artifact = fs.readFileSync(summaryPath, "utf8");
    assert(
      artifact.length < 2_048,
      `S21: the compact artifact is ${artifact.length} bytes; it must not grow with the fleet`,
    );
    const declared = /summary_bytes=(\d+) summary_sha256=([0-9a-f]+)/.exec(check.stdout);
    assert(declared != null, "S21: the checker did not declare the artifact's size and digest");
    assert(
      Number(declared[1]) === Buffer.byteLength(artifact),
      `S21: declared ${declared[1]} bytes but the artifact is ${Buffer.byteLength(artifact)}`,
    );
    const parsedArtifact = JSON.parse(artifact);
    assert(
      parsedArtifact.stagedWorkerId === evidenceId,
      `S21: the artifact names ${parsedArtifact.stagedWorkerId}, the staged worker is ${evidenceId}`,
    );
    const actualInstances = await client.query<{ instance_id: string; service: string; build_id: string }>(
      `SELECT instance_id, service, build_id FROM sync_runtime_instances ORDER BY updated_at DESC LIMIT 6`,
    );
    assert(
      parsedArtifact.runtimeInstance?.instanceId === evidenceId &&
        parsedArtifact.runtimeInstanceMatchesStaged === true,
      `S21: the artifact does not corroborate sync_runtime_instances.\n` +
        `  artifact.runtimeInstance = ${JSON.stringify(parsedArtifact.runtimeInstance)}\n` +
        `  staged worker id         = ${evidenceId}\n` +
        `  rows present             = ${JSON.stringify(actualInstances.rows)}`,
    );
    log(`S21 PASS bounded evidence: the verbose payload is ${check.stdout.length} bytes (past the 64 KiB that truncated), the compact artifact is ${Buffer.byteLength(artifact)} bytes, declares its own size and digest, names the exact staged worker and corroborates its runtime row`);

    // ── S22. The verifier refuses a damaged artifact ───────────────────────
    const startedAtForVerify = parsedArtifact.stagedWorkerStartedAt as string;
    const verify = (file: string, extra: string[] = []) =>
      spawnSync("node", ["--import", "tsx", "scripts/verify-staged-proof.ts",
        "--summary", file, "--expect-build-id", "staged-worker-seam",
        "--min-heartbeat-after", startedAtForVerify, ...extra],
        { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });

    const good = verify(summaryPath, ["--expect-bytes", declared[1], "--expect-sha256", declared[2]]);
    assert(good.status === 0, `S22: the verifier refused an intact artifact: ${good.stdout}${good.stderr}`);

    // Truncated at 200 bytes, which is what the shell capture effectively did.
    const truncPath = path.join(tmp, "staged-summary-truncated.json");
    fs.writeFileSync(truncPath, artifact.slice(0, 200));
    const trunc = verify(truncPath, ["--expect-bytes", declared[1], "--expect-sha256", declared[2]]);
    assert(
      trunc.status !== 0 && /truncated in transit|not valid JSON|digest/.test(trunc.stdout),
      `S22: a truncated artifact verified: ${trunc.stdout}`,
    );

    // The exact symptom: an empty staged worker id that once read as success.
    const emptyIdPath = path.join(tmp, "staged-summary-emptyid.json");
    fs.writeFileSync(emptyIdPath, JSON.stringify({ ...parsedArtifact, stagedWorkerId: "" }));
    const emptyId = verify(emptyIdPath);
    assert(
      emptyId.status !== 0 && /stagedWorkerId is missing or empty/.test(emptyId.stdout),
      `S22: an empty staged worker id verified: ${emptyId.stdout}`,
    );

    // Missing runtime row, and a wrong build.
    const noRuntimePath = path.join(tmp, "staged-summary-noruntime.json");
    fs.writeFileSync(noRuntimePath, JSON.stringify({ ...parsedArtifact, runtimeInstance: null, runtimeInstanceMatchesStaged: false }));
    assert(verify(noRuntimePath).status !== 0, "S22: an artifact with no runtime row verified");
    const wrongBuild = spawnSync("node", ["--import", "tsx", "scripts/verify-staged-proof.ts",
      "--summary", summaryPath, "--expect-build-id", "some-other-release",
      "--min-heartbeat-after", startedAtForVerify],
      { cwd: REPO_ROOT, env: { ...process.env, ...workerEnv }, encoding: "utf8" });
    assert(wrongBuild.status !== 0, "S22: an artifact for the wrong build verified");

    // And the whole point: checker exit 0 does not rescue a damaged artifact.
    assert(
      check.status === 0 && trunc.status !== 0,
      "S22: the checker's exit 0 must not make a truncated artifact acceptable",
    );
    log("S22 PASS verifier fails closed: intact verifies; truncated, empty-id, missing-runtime and wrong-build all refuse — and the checker's own exit 0 does not rescue any of them");

    // ── S23. A staged runtime row must not stand in for the active worker ───
    //
    // The release gate's only worker term was "a fresh worker row on this build
    // reads healthy". During deploy-disabled that describes the STAGED worker
    // exactly: same service, same runtime_role, same build_id — the phase starts
    // the release's own worker on purpose — a genuinely 'healthy' process health,
    // and a provider_scopes array that is a static per-service constant, not the
    // lane admission set. Nothing in the row distinguished the two.
    //
    // This runs against real PostgreSQL because the fix is partly an ORDER BY. A
    // mock would happily agree that the newest row is the right one, and that is
    // the bug: during a cutover the newest worker row is the staged one.
    const { getRuntimeRegistryStatus } = await import("@/lib/sync/runtime-contract");
    // A local the closures below can narrow: `client` is nullable at this scope.
    const regClient = client;
    if (!regClient) throw new Error("S23: no database client");
    const REG_BUILD = "registry-seam-build";
    const contractJson = (service: string, staging: boolean | "absent") => {
      const config: Record<string, unknown> = { deployGateMode: "block", releaseGateMode: "block" };
      if (staging !== "absent") config.workerStagingIdle = staging;
      return JSON.stringify({
        contractVersion: 1,
        service,
        runtimeRole: service,
        buildId: REG_BUILD,
        config,
        validation: { pass: true, issues: [] },
      });
    };
    const seedInstance = async (input: {
      instanceId: string;
      service: string;
      staging: boolean | "absent";
      ageSeconds?: number;
      buildId?: string;
    }) => {
      await regClient.query(
        `INSERT INTO sync_runtime_instances (
           instance_id, service, runtime_role, build_id, db_fingerprint, config_fingerprint,
           provider_scopes, health_state, contract_json, started_at, last_seen_at, updated_at
         ) VALUES ($1,$2,$2,$3,'db','cfg',ARRAY['meta']::text[],'healthy',$4::jsonb,
           now() - ($5 || ' seconds')::interval, now() - ($5 || ' seconds')::interval,
           now() - ($5 || ' seconds')::interval)`,
        [
          input.instanceId,
          input.service,
          input.buildId ?? REG_BUILD,
          contractJson(input.service, input.staging),
          String(input.ageSeconds ?? 0),
        ],
      );
    };
    const resetInstances = () => regClient.query(`DELETE FROM sync_runtime_instances`);

    await resetInstances();
    await seedInstance({ instanceId: "web:reg:1", service: "web", staging: false });
    await seedInstance({ instanceId: "worker:reg:active", service: "worker", staging: false });
    let reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(
      reg.workerActive === true && reg.serviceHealth.worker?.stagingIdle === false,
      `S23 active-only: a proven active worker was not accepted: ${JSON.stringify({ workerActive: reg.workerActive, stagingIdle: reg.serviceHealth.worker?.stagingIdle, issues: reg.issues })}`,
    );

    await resetInstances();
    await seedInstance({ instanceId: "web:reg:1", service: "web", staging: false });
    await seedInstance({ instanceId: "worker:reg:staged", service: "worker", staging: true });
    reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(
      reg.workerPresent === true &&
        reg.workerActive === false &&
        reg.serviceHealth.worker?.healthState === "healthy" &&
        reg.issues.some((issue) => issue.includes("STAGED worker")),
      `S23 staged-only: the staged worker was accepted as active: ${JSON.stringify({ workerPresent: reg.workerPresent, workerActive: reg.workerActive, healthState: reg.serviceHealth.worker?.healthState, issues: reg.issues })}`,
    );

    // THE ORDER BY. The staged row is the NEWEST — which is what a cutover
    // produces, because the staged worker starts after the outgoing one stopped.
    await resetInstances();
    await seedInstance({ instanceId: "web:reg:1", service: "web", staging: false });
    await seedInstance({ instanceId: "worker:reg:active", service: "worker", staging: false, ageSeconds: 30 });
    await seedInstance({ instanceId: "worker:reg:staged", service: "worker", staging: true, ageSeconds: 0 });
    reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(
      reg.serviceHealth.worker?.instanceId === "worker:reg:active" && reg.workerActive === true,
      `S23 duplicate: the newer STAGED row masked the active worker: selected ${reg.serviceHealth.worker?.instanceId}, workerActive=${reg.workerActive}`,
    );

    // A row that does not say which it is cannot prove the active worker is up.
    await resetInstances();
    await seedInstance({ instanceId: "web:reg:1", service: "web", staging: false });
    await seedInstance({ instanceId: "worker:reg:legacy", service: "worker", staging: "absent" });
    reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(
      reg.serviceHealth.worker?.stagingIdle === null &&
        reg.workerActive === false &&
        reg.issues.some((issue) => issue.includes("does not state whether it is staged")),
      `S23 unstated: a row that declines to say was read as active: ${JSON.stringify({ stagingIdle: reg.serviceHealth.worker?.stagingIdle, workerActive: reg.workerActive, issues: reg.issues })}`,
    );
    // ...and it must not be preferred over a row that does say.
    await seedInstance({ instanceId: "worker:reg:active", service: "worker", staging: false, ageSeconds: 30 });
    reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(
      reg.serviceHealth.worker?.instanceId === "worker:reg:active" && reg.workerActive === true,
      `S23 unstated ordering: the unstated row outranked the proven one (NULL sorts first under DESC in PostgreSQL): selected ${reg.serviceHealth.worker?.instanceId}`,
    );

    // Wrong build: another release's rows are not this release's evidence.
    await resetInstances();
    await seedInstance({ instanceId: "web:reg:1", service: "web", staging: false });
    await seedInstance({ instanceId: "worker:other", service: "worker", staging: false, buildId: "some-other-release" });
    reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(
      reg.serviceHealth.worker === null && reg.workerActive === false,
      `S23 wrong build: a worker row from another release satisfied this build: ${JSON.stringify(reg.serviceHealth.worker)}`,
    );

    // The transition deploy-disabled -> enable: the staged container is replaced,
    // the new worker registers under a new instance id, and the gate must follow
    // the live process rather than the stale staged row it left behind.
    await resetInstances();
    await seedInstance({ instanceId: "web:reg:1", service: "web", staging: false });
    await seedInstance({ instanceId: "worker:reg:staged", service: "worker", staging: true, ageSeconds: 120 });
    reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(reg.workerActive === false, "S23 transition: staged-only was accepted before enable ran");
    await seedInstance({ instanceId: "worker:reg:enabled", service: "worker", staging: false, ageSeconds: 0 });
    reg = await getRuntimeRegistryStatus({ buildId: REG_BUILD });
    assert(
      reg.serviceHealth.worker?.instanceId === "worker:reg:enabled" && reg.workerActive === true,
      `S23 transition: after enable the active worker was not selected: ${JSON.stringify({ selected: reg.serviceHealth.worker?.instanceId, workerActive: reg.workerActive })}`,
    );
    await resetInstances();
    log("S23 PASS staged is not active: a staged runtime row is present and healthy but never satisfies the gate's worker term; a newer staged row does not mask an active one; an unstated row is refused and does not outrank a proven one; another release's row is not this one's evidence; and after enable the live worker is selected");

    await client.query(`DELETE FROM sync_worker_heartbeats`);
    evidenceWorker.stop();
    await sleep(1200);

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
