/**
 * The Decisions/Copies -> Launchpad handoff, proven against a real PostgreSQL.
 *
 * WHY A SEAM AND NOT A UNIT TEST. Every guarantee this handoff makes is a
 * database guarantee:
 *
 *   - single use is ONE conditional UPDATE (`consumedAt IS NULL`), so only real
 *     concurrent sessions racing a real row can show that exactly one wins;
 *   - account scoping is a WHERE clause, and the defect it fixes was a row
 *     minted with a NULL `provider_account_id` that no account-scoped reader
 *     could see — provable only by writing through the mint and reading back
 *     through `listMetaLaunchDrafts`;
 *   - the origin integrity check defends against an EDITED `payload_json`, so
 *     the edit has to be a real `jsonb_set` against a real row.
 *
 * A mocked `sql` returns whatever it is told and proves none of that. The
 * corresponding vitest file used to gate on a hand-set
 * `META_HANDOFF_TEST_DATABASE_URL` and therefore SKIPPED in every normal
 * acceptance run — a skip that reads exactly like a pass in the summary line.
 * This script is what turns it into a pass, and
 * `scripts/verify-database-seams.sh` (which `.github/workflows/ci.yml` invokes)
 * runs it.
 *
 * Safety, restated because this file creates schema and writes rows:
 * - ports 5432 (local volume Postgres) and 15432 (the live production tunnel)
 *   are refused outright;
 * - `DATABASE_URL` is force-set on every child's env, and `@next/env` never
 *   overrides a pre-existing value, so `.env.local`'s production tunnel cannot
 *   leak into a migration or a test run;
 * - the cluster and its temp directory are torn down in `finally`, on success
 *   and on failure alike;
 * - no Meta client is imported anywhere in this seam. Real provider writes
 *   performed: zero.
 *
 * Usage: npm run test:launchpad-handoff-seam
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { createRequire } from "node:module";

/**
 * Vitest's REAL JavaScript entrypoint, resolved through Node's module
 * resolution — never `node_modules/.bin/vitest`. The `.bin` shim is an npm
 * implementation detail: under npm it is a JS symlink `process.execPath` can
 * run, under pnpm it is a `#!/bin/sh` script that `node` cannot parse, so
 * spawning the shim silently couples this seam to one package manager. The
 * package's own `bin` field is the portable, injection-safe contract (no
 * shell is involved; the resolved absolute path is passed as an argv entry).
 */
function resolveVitestEntry(): string {
  const requireHere = createRequire(import.meta.url);
  const pkgPath = requireHere.resolve("vitest/package.json");
  const pkg = JSON.parse(fs.readFileSync(pkgPath, "utf8")) as {
    bin?: string | Record<string, string>;
  };
  const bin = typeof pkg.bin === "string" ? pkg.bin : pkg.bin?.vitest;
  if (!bin) throw new Error("vitest package.json has no usable bin entry");
  return path.join(path.dirname(pkgPath), bin);
}
const VITEST_ENTRY = resolveVitestEntry();

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const USER = "postgres";
const DB = "launchpad_handoff_seam";
const LABEL = "[launchpad-handoff-seam]";
/**
 * The two files this seam turns from SKIP into PASS.
 *
 * They are run as SEPARATE vitest invocations, not one. The store file clears
 * `meta_launch_drafts` wholesale in its own `beforeEach`; the route file writes
 * drafts and then counts them. Run in one invocation vitest would schedule the
 * two files in parallel workers against the same cluster and the truncation
 * would land in the middle of a count. Serialising them is the fix, and it is
 * cheap.
 */
const HANDOFF_STORE_TEST = "lib/meta/launchpad-handoff.db.test.ts";
const HANDOFF_ROUTE_TEST = "app/api/meta/launchpad-handoff/route.db.test.ts";
const HANDOFF_TESTS = [HANDOFF_STORE_TEST, HANDOFF_ROUTE_TEST];

function log(message: string) {
  console.log(`${LABEL} ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`launchpad handoff seam FAILED: ${message}`);
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
      // Pre-set so `@next/env`'s loadEnvConfig cannot substitute the production
      // tunnel from .env.local: it skips keys already present in env.
      DATABASE_URL: databaseUrl,
      DATABASE_URL_UNPOOLED: databaseUrl,
      DB_SSL_MODE: "disable",
      ENABLE_RUNTIME_MIGRATIONS: "1",
      ADSECUTE_EPHEMERAL_DB_SEAM: "1",
      // Cleared deliberately. If an operator has this pointed somewhere by
      // hand, the test file would prefer it over the cluster this script just
      // built and the seam would be verifying a different database.
      META_HANDOFF_TEST_DATABASE_URL: "",
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
 * The negative control.
 *
 * A seam whose test file can silently skip is not a seam. Run WITHOUT the flag
 * and without a pointed URL, the same file must report zero executed tests —
 * which is exactly the state this script exists to replace, and pinning it here
 * means nobody can "fix" a failure by removing the gate.
 */
async function assertSkipsWithoutTheHarness() {
  log("running the negative control (the file must SKIP without the harness)...");
  const result = spawnSync(
    process.execPath,
    [VITEST_ENTRY, "run", ...HANDOFF_TESTS, "--reporter=json", "--silent"],
    {
      cwd: process.cwd(),
      encoding: "utf8",
      maxBuffer: 20 * 1024 * 1024,
      env: {
        ...process.env,
        ADSECUTE_EPHEMERAL_DB_SEAM: "",
        META_HANDOFF_TEST_DATABASE_URL: "",
        // Never a real database. The control proves the file does not run; if
        // the gate were broken this would be the connection it reached for.
        DATABASE_URL: "postgresql://unused@127.0.0.1:1/never",
        DATABASE_URL_UNPOOLED: "postgresql://unused@127.0.0.1:1/never",
      },
    },
  );
  const stdout = result.stdout ?? "";
  const start = stdout.indexOf("{");
  assert(start >= 0, "the negative control produced no JSON report");
  const report = JSON.parse(stdout.slice(start)) as {
    numPassedTests?: number;
    numPendingTests?: number;
    numFailedTests?: number;
  };
  assert(
    (report.numFailedTests ?? 0) === 0,
    `the negative control FAILED tests instead of skipping them (${report.numFailedTests})`,
  );
  assert(
    (report.numPassedTests ?? 0) === 0,
    `the negative control EXECUTED ${report.numPassedTests} tests without the harness; the prod-tunnel gate is not holding`,
  );
  assert(
    (report.numPendingTests ?? 0) > 0,
    "the negative control found no skipped tests, so the gated suite may have vanished",
  );
  log(
    `negative control OK: ${report.numPendingTests} tests skip without the harness.`,
  );
}

async function main() {
  // Cheap, and it fails the whole seam before a cluster is built.
  await assertSkipsWithoutTheHarness();

  const bin = pgBinDir();
  const port = await freePort();
  assert(!FORBIDDEN_PORTS.has(port), `refusing port ${port}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-handoff-seam-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  let started = false;

  log(`pg binaries: ${bin}`);
  log(`port:        ${port} (never 5432 / 15432)`);

  try {
    run(
      path.join(bin, "initdb"),
      [
        "-D",
        dataDir,
        "-U",
        USER,
        "--auth=trust",
        "--encoding=UTF8",
        "--no-locale",
      ],
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

    const databaseUrl = `postgresql://${USER}@127.0.0.1:${port}/${DB}`;

    // The repo's REAL deploy entry point, from zero. The handoff writes into
    // `meta_launch_drafts`, whose `provider_account_id` column is itself an
    // additive migration — so "the column exists after a from-zero migration"
    // is part of what this proves.
    await runChild(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
      databaseUrl,
      "migrations from zero",
    );

    await runChild(
      process.execPath,
      [VITEST_ENTRY, "run", HANDOFF_STORE_TEST],
      databaseUrl,
      "launchpad handoff persistence (real PostgreSQL)",
    );

    // The MINT ENDPOINT, behaviourally. Its reviewer refusal, its
    // provider-account assignment gate, its cross-business gate and its
    // response shape had no coverage at all; every one of those gates is a
    // database fact (a session joined to a membership, a selected binding row,
    // an INSERT whose id is the reference handed back), so it belongs here and
    // not in a mocked route test.
    await runChild(
      process.execPath,
      [VITEST_ENTRY, "run", HANDOFF_ROUTE_TEST],
      databaseUrl,
      "launchpad handoff mint endpoint (real PostgreSQL)",
    );

    log(
      "PASS: mint, consume, single use, account scoping, origin integrity, and the mint endpoint's refusals and response shape.",
    );
  } finally {
    if (started) {
      const stop = spawnSync(
        path.join(bin, "pg_ctl"),
        ["-D", dataDir, "-m", "immediate", "-w", "-t", "30", "stop"],
        { encoding: "utf8" },
      );
      if (stop.status !== 0) {
        console.error(
          `${LABEL} warning: pg_ctl stop exited with ${stop.status}: ${stop.stderr?.trim() ?? ""}`,
        );
      }
    }
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

main()
  .then(() => process.exit(0))
  .catch((error) => {
    console.error(
      error instanceof Error ? (error.stack ?? error.message) : error,
    );
    process.exit(1);
  });
