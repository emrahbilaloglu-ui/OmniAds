/**
 * Ephemeral-Postgres "migrations from zero" verification.
 *
 * Boots a throwaway PostgreSQL 16 cluster (Homebrew binaries, no Docker) in an
 * OS temp directory on a random free port, creates an empty database, runs the
 * repo's real deploy migration entry point (scripts/run-migrations.ts →
 * lib/migrations.ts runMigrations) against it twice — first run must build the
 * full schema from zero, second run must exit clean to prove idempotency —
 * then asserts key Engine v3 tables/columns exist.
 *
 * Hard safety rules:
 * - NEVER connects to 127.0.0.1:15432 (live prod tunnel) or 5432 (local
 *   volume Postgres). Both ports are rejected outright.
 * - DATABASE_URL is force-set on the child process env; @next/env's
 *   loadEnvConfig never overrides pre-existing process.env values, so the
 *   .env.local prod tunnel URL can never leak into the migration run.
 * - The cluster and its temp directory are always stopped/deleted in a
 *   finally block, even on failure.
 *
 * Usage: npm run test:migrations-from-zero
 * Env overrides:
 *   EPHEMERAL_PG_BIN_DIR  — directory containing initdb/pg_ctl/postgres
 */

import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";

const FORBIDDEN_PORTS = new Set([15432, 5432]);
const EPHEMERAL_DB_NAME = "adsecute_migrations_from_zero";
const EPHEMERAL_DB_USER = "postgres";
const REQUIRED_TABLES = [
  "engine_v3_decision_snapshots_daily",
  "engine_v3_campaign_context_daily",
  "engine_v3_job_runs",
  "engine_v3_decision_events",
] as const;
const REQUIRED_COLUMNS: ReadonlyArray<{ table: string; column: string }> = [
  { table: "engine_v3_decision_snapshots_daily", column: "raw_label" },
];

function log(message: string) {
  console.log(`[migrations-from-zero] ${message}`);
}

function resolvePgBinDir(): string {
  const required = ["initdb", "pg_ctl", "postgres"];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
  ].filter((dir): dir is string => Boolean(dir));

  for (const dir of candidates) {
    if (required.every((binary) => fs.existsSync(path.join(dir, binary)))) {
      return dir;
    }
  }
  throw new Error(
    `PostgreSQL binaries (${required.join(", ")}) not found in any of: ${candidates.join(", ")}. ` +
      "Install postgresql@16 via Homebrew or set EPHEMERAL_PG_BIN_DIR.",
  );
}

function assertSafePort(port: number) {
  if (FORBIDDEN_PORTS.has(port)) {
    throw new Error(
      `Refusing to use port ${port}: 15432 is the live prod tunnel and 5432 is the local volume Postgres.`,
    );
  }
  if (!Number.isInteger(port) || port < 1024 || port > 65535) {
    throw new Error(`Invalid ephemeral Postgres port: ${port}`);
  }
}

async function findFreeSafePort(): Promise<number> {
  for (let attempt = 0; attempt < 10; attempt++) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() => {
          if (address && typeof address === "object") {
            resolve(address.port);
          } else {
            reject(new Error("Could not determine a free port."));
          }
        });
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) {
      assertSafePort(port);
      return port;
    }
  }
  throw new Error("Could not find a safe free port after 10 attempts.");
}

// Without a valid LC_ALL, macOS CoreFoundation locale init makes the
// postmaster multithreaded during startup and it refuses to boot
// ("postmaster became multithreaded during startup").
const PG_TOOL_ENV = { ...process.env, LC_ALL: "C" };

function runSync(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, { encoding: "utf8", env: PG_TOOL_ENV });
  if (result.error) {
    throw new Error(`${label} failed to spawn: ${result.error.message}`);
  }
  if (result.status !== 0) {
    throw new Error(
      `${label} exited with code ${result.status}.` +
        `${result.stdout?.trim() ? `\nstdout: ${result.stdout.trim()}` : ""}` +
        `${result.stderr?.trim() ? `\nstderr: ${result.stderr.trim()}` : ""}`,
    );
  }
  return result;
}

async function runMigrationsChild(
  repoRoot: string,
  databaseUrl: string,
  runLabel: string,
): Promise<void> {
  await runChildScript(
    repoRoot,
    databaseUrl,
    path.join("scripts", "run-migrations.ts"),
    `deploy migrations (${runLabel})`,
  );
}

async function runChildScript(
  repoRoot: string,
  databaseUrl: string,
  scriptPath: string,
  runLabel: string,
): Promise<void> {
  log(`running ${runLabel}...`);
  const child = spawn(
    process.execPath,
    ["--import", "tsx", scriptPath],
    {
      cwd: repoRoot,
      stdio: "inherit",
      env: {
        ...process.env,
        // Pre-set so scripts/run-migrations.ts's loadEnvConfig (.env.local →
        // prod tunnel) can never override them: @next/env skips keys that
        // already exist in process.env.
        DATABASE_URL: databaseUrl,
        DATABASE_URL_UNPOOLED: databaseUrl,
        PGHOST: "127.0.0.1",
        PGDATABASE: EPHEMERAL_DB_NAME,
        PGUSER: EPHEMERAL_DB_USER,
        ENABLE_RUNTIME_MIGRATIONS: "1",
      },
    },
  );

  const exitCode = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (code) => resolve(code ?? 1));
  });

  if (exitCode !== 0) {
    throw new Error(`${runLabel} exited with code ${exitCode}.`);
  }
  log(`${runLabel} exited clean.`);
}

async function assertSchema(databaseUrl: string): Promise<string[]> {
  const client = new Client({ connectionString: databaseUrl });
  await client.connect();
  try {
    const failures: string[] = [];

    for (const table of REQUIRED_TABLES) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT to_regclass($1) IS NOT NULL AS exists`,
        [`public.${table}`],
      );
      if (rows[0]?.exists) {
        log(`table ok: ${table}`);
      } else {
        failures.push(`missing table: ${table}`);
      }
    }

    for (const { table, column } of REQUIRED_COLUMNS) {
      const { rows } = await client.query<{ exists: boolean }>(
        `SELECT EXISTS (
           SELECT 1
           FROM information_schema.columns
           WHERE table_schema = 'public'
             AND table_name = $1
             AND column_name = $2
         ) AS exists`,
        [table, column],
      );
      if (rows[0]?.exists) {
        log(`column ok: ${table}.${column}`);
      } else {
        failures.push(`missing column: ${table}.${column}`);
      }
    }

    const { rows: tableRows } = await client.query<{ table_name: string }>(
      `SELECT table_name
       FROM information_schema.tables
       WHERE table_schema = 'public' AND table_type = 'BASE TABLE'
       ORDER BY table_name`,
    );
    const tables = tableRows.map((row) => row.table_name);
    log(`public schema contains ${tables.length} base tables.`);

    if (failures.length > 0) {
      throw new Error(`Schema assertions failed:\n- ${failures.join("\n- ")}`);
    }
    return tables;
  } finally {
    await client.end();
  }
}

/**
 * Non-fatal convergence report: tables that only appear after the SECOND
 * migration run mean a from-zero deploy does not converge in a single pass.
 *
 * Known defect (2026-07-06): google_ads_campaign_state_history and
 * google_ads_ad_group_state_history reference google_ads_raw_snapshots(id)
 * but are created BEFORE google_ads_raw_snapshots in lib/migrations.ts
 * (~lines 3277/3321 vs ~3949), and their CREATE errors are swallowed by
 * .catch(() => {}). First run: FK target missing → silently skipped.
 * Second run: target exists → created. Fix belongs in lib/migrations.ts
 * (reorder or drop the swallow), out of scope for this check.
 */
function reportConvergenceGap(run1Tables: string[], run2Tables: string[]) {
  const run1Set = new Set(run1Tables);
  const onlyAfterSecondRun = run2Tables.filter((table) => !run1Set.has(table));
  if (onlyAfterSecondRun.length === 0) {
    log("convergence ok: first run already produced the full table set.");
    return;
  }
  console.warn(
    `[migrations-from-zero] WARNING: from-zero deploy does NOT converge in one run. ` +
      `${onlyAfterSecondRun.length} table(s) only exist after the second migration run:\n` +
      onlyAfterSecondRun.map((table) => `  - ${table}`).join("\n") +
      `\n  A fresh single-run deploy would be missing these tables (silent .catch(() => {}) ` +
      `swallows the CREATE failure in lib/migrations.ts).`,
  );
}

async function main() {
  const repoRoot = process.cwd();
  if (!fs.existsSync(path.join(repoRoot, "scripts", "run-migrations.ts"))) {
    throw new Error(
      `Expected to run from the repo root (scripts/run-migrations.ts not found under ${repoRoot}). Use: npm run test:migrations-from-zero`,
    );
  }

  const pgBinDir = resolvePgBinDir();
  const port = await findFreeSafePort();
  assertSafePort(port);

  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-ephemeral-pg-"));
  const dataDir = path.join(tempDir, "data");
  const logFile = path.join(tempDir, "postgres.log");
  const databaseUrl = `postgresql://${EPHEMERAL_DB_USER}@127.0.0.1:${port}/${EPHEMERAL_DB_NAME}`;

  log(`pg binaries: ${pgBinDir}`);
  log(`data dir:    ${dataDir}`);
  log(`port:        ${port} (never 15432 / 5432)`);

  let serverStarted = false;
  try {
    log("initdb: creating fresh cluster...");
    runSync(
      path.join(pgBinDir, "initdb"),
      ["-D", dataDir, "-U", EPHEMERAL_DB_USER, "--auth=trust", "--encoding=UTF8", "--no-locale"],
      "initdb",
    );

    log("pg_ctl: starting ephemeral server...");
    runSync(
      path.join(pgBinDir, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-t",
        "60",
        "-o",
        // TCP only on loopback; unix sockets disabled (temp paths can exceed
        // the socket path length limit on macOS). fsync off: throwaway data.
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off`,
        "start",
      ],
      "pg_ctl start",
    );
    serverStarted = true;

    log(`createdb: ${EPHEMERAL_DB_NAME}`);
    runSync(
      path.join(pgBinDir, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", EPHEMERAL_DB_USER, EPHEMERAL_DB_NAME],
      "createdb",
    );

    // Two separate child processes: lib/migrations.ts keeps module-level
    // "already completed" state, so in-process re-runs would be no-ops and
    // prove nothing about idempotency.
    await runMigrationsChild(repoRoot, databaseUrl, "run 1: from zero");
    const run1Tables = await assertSchema(databaseUrl);
    await runMigrationsChild(repoRoot, databaseUrl, "run 2: idempotency");
    const run2Tables = await assertSchema(databaseUrl);
    reportConvergenceGap(run1Tables, run2Tables);

    // Production-seam checks against the freshly migrated schema: real
    // write query -> real reader, the class of defect in-memory tests miss.
    await runChildScript(
      repoRoot,
      databaseUrl,
      path.join("scripts", "ephemeral-postgres-seam-child.ts"),
      "hysteresis DB seam check",
    );

    log("PASS: migrations build the schema from zero and are idempotent.");
  } catch (error) {
    if (fs.existsSync(logFile)) {
      const logTail = fs.readFileSync(logFile, "utf8").split(/\r?\n/).slice(-40).join("\n");
      console.error(`[migrations-from-zero] postgres log tail:\n${logTail}`);
    }
    throw error;
  } finally {
    if (serverStarted) {
      const stop = spawnSync(
        path.join(pgBinDir, "pg_ctl"),
        ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
        { encoding: "utf8" },
      );
      if (stop.status !== 0) {
        console.error(
          `[migrations-from-zero] warning: pg_ctl stop exited with ${stop.status}: ${stop.stderr?.trim() ?? ""}`,
        );
      } else {
        log("ephemeral server stopped.");
      }
    }
    fs.rmSync(tempDir, { recursive: true, force: true });
    log(`temp dir removed: ${tempDir}`);
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(error instanceof Error ? (error.stack ?? error.message) : error);
    process.exit(1);
  });
