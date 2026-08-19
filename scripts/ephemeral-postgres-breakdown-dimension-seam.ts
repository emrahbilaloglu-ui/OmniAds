/**
 * The Meta breakdown ingestion gap, proven on a throwaway PostgreSQL.
 *
 * Boots a real cluster on a random free port, migrates it from zero with the
 * repo's own deploy entry point, and hands it to
 * `lib/meta/breakdown-dimension-reach.db.test.ts`, which asserts that:
 *   - an `age` row and a `gender` row survive as INDEPENDENT rows for one
 *     account-day, including when they share a breakdown key;
 *   - replacing one dimension's slice does not delete the other's;
 *   - an unmeasured `reach` round-trips as NULL — which fails outright unless
 *     the widening migration ran — while a MEASURED zero stays 0;
 *   - the dirty-day coverage gate still demands exactly age + country +
 *     placement, so a gender row cannot mask a missing country and a missing
 *     gender cannot condemn the entire retained history.
 *
 * Safety, restated because this file creates schema:
 * - ports 5432 (local volume Postgres) and 15432 (the live production tunnel)
 *   are refused outright;
 * - `DATABASE_URL` is force-set on the child's env, because `@next/env` never
 *   overrides a key already present — so `.env.local`'s production tunnel
 *   cannot leak into the run;
 * - the cluster and its temp directory are torn down in `finally`, on success
 *   and on failure alike;
 * - no provider client is imported anywhere in this seam. Real provider writes
 *   performed: zero.
 *
 * A SKIPPED database test reads exactly like a passing one, so the seam run is
 * asserted to have EXECUTED tests: vitest is run with a JSON reporter and the
 * result is rejected unless every test in the file actually ran.
 *
 * Usage: npx tsx scripts/ephemeral-postgres-breakdown-dimension-seam.ts
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const USER = "postgres";
const DB = "meta_breakdown_dimension_seam";
const LABEL = "[breakdown-dimension-seam]";
const SEAM_TEST = "lib/meta/breakdown-dimension-reach.db.test.ts";
const EXPECTED_TESTS = 6;

function log(message: string) {
  console.log(`${LABEL} ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`breakdown dimension seam FAILED: ${message}`);
}

function pgBinDir() {
  const need = ["initdb", "pg_ctl", "createdb"];
  const linux = fs.existsSync("/usr/lib/postgresql")
    ? fs
        .readdirSync("/usr/lib/postgresql", { withFileTypes: true })
        .filter((entry) => entry.isDirectory())
        .map((entry) => path.join("/usr/lib/postgresql", entry.name, "bin"))
    : [];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    ...linux,
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter(Boolean) as string[];
  const found = candidates.find((dir) =>
    need.every((bin) => fs.existsSync(path.join(dir, bin))),
  );
  if (!found) throw new Error("PostgreSQL binaries not found.");
  return found;
}

async function freePort() {
  for (let attempt = 0; attempt < 10; attempt += 1) {
    const port = await new Promise<number>((resolve, reject) => {
      const server = net.createServer();
      server.unref();
      server.once("error", reject);
      server.listen(0, "127.0.0.1", () => {
        const address = server.address();
        server.close(() =>
          address && typeof address === "object"
            ? resolve(address.port)
            : reject(new Error("no port")),
        );
      });
    });
    if (!FORBIDDEN_PORTS.has(port)) return port;
  }
  throw new Error("no safe port");
}

function run(bin: string, args: string[], label: string) {
  const result = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
    maxBuffer: 10 * 1024 * 1024,
  });
  if (result.status !== 0) {
    throw new Error(
      `${label} failed (${result.status}). ${result.stderr?.trim() ?? ""}`,
    );
  }
}

async function runChild(
  command: string,
  args: string[],
  databaseUrl: string,
  label: string,
) {
  log(`running ${label}...`);
  const child = spawn(command, args, {
    cwd: process.cwd(),
    stdio: "inherit",
    env: {
      ...process.env,
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      DB_SSL_MODE: "disable",
      ENABLE_RUNTIME_MIGRATIONS: "1",
      ADSECUTE_EPHEMERAL_DB_SEAM: "1",
    },
  });
  const code = await new Promise<number>((resolve, reject) => {
    child.once("error", reject);
    child.once("exit", (value) => resolve(value ?? 1));
  });
  if (code !== 0) throw new Error(`${label} exited with code ${code}.`);
  log(`${label} exited clean.`);
}

/**
 * Runs the seam file and REFUSES a run in which the tests skipped.
 *
 * The gate these tests sit behind is an environment variable, so a harness that
 * forgot to set it — or a future edit that renames it — would produce a green
 * run with zero assertions executed. The JSON report is read back and the
 * passing count must match.
 */
async function runSeamTests(databaseUrl: string, reportPath: string) {
  await runChild(
    process.execPath,
    [
      path.join("node_modules", "vitest", "vitest.mjs"),
      "run",
      SEAM_TEST,
      "--reporter=json",
      `--outputFile=${reportPath}`,
    ],
    databaseUrl,
    "breakdown dimension + reach seam",
  );

  assert(fs.existsSync(reportPath), "vitest wrote no JSON report");
  const report = JSON.parse(fs.readFileSync(reportPath, "utf8")) as {
    numTotalTests?: number;
    numPassedTests?: number;
    numPendingTests?: number;
    numFailedTests?: number;
  };
  log(
    `report: total=${report.numTotalTests} passed=${report.numPassedTests} ` +
      `skipped=${report.numPendingTests} failed=${report.numFailedTests}`,
  );
  assert(
    (report.numFailedTests ?? 0) === 0,
    `${report.numFailedTests} test(s) failed`,
  );
  assert(
    (report.numPendingTests ?? 0) === 0,
    `${report.numPendingTests} test(s) SKIPPED — a skipped database test is not a pass`,
  );
  assert(
    (report.numPassedTests ?? 0) === EXPECTED_TESTS,
    `expected ${EXPECTED_TESTS} passing tests, saw ${report.numPassedTests}`,
  );
}

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  assert(!FORBIDDEN_PORTS.has(port), `refusing port ${port}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-breakdown-dimension-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  const reportPath = path.join(tmp, "vitest-report.json");
  let started = false;

  log(`pg binaries: ${bin}`);
  log(`port:        ${port} (never 5432 / 15432)`);

  try {
    run(
      path.join(bin, "initdb"),
      ["-D", dataDir, "-U", USER, "--auth=trust", "--encoding=UTF8", "--no-locale"],
      "initdb",
    );
    run(
      path.join(bin, "pg_ctl"),
      [
        "-D",
        dataDir,
        "-l",
        logFile,
        "-w",
        "-t",
        "60",
        "-o",
        `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off -c synchronous_commit=off`,
        "start",
      ],
      "pg_ctl start",
    );
    started = true;

    run(
      path.join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", USER, DB],
      `createdb ${DB}`,
    );

    const url = `postgresql://${USER}@127.0.0.1:${port}/${DB}`;
    await runChild(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
      url,
      "migrations from zero",
    );
    await runSeamTests(url, reportPath);

    log(
      "PASS: age and gender are independent dimensions, and an unmeasured reach stays null.",
    );
  } finally {
    if (started) {
      spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "stop"], {
        encoding: "utf8",
      });
    }
    fs.rmSync(tmp, { recursive: true, force: true });
    log("cluster torn down.");
  }
}

main().catch((error) => {
  console.error(`${LABEL} ${error instanceof Error ? error.message : String(error)}`);
  process.exitCode = 1;
});
