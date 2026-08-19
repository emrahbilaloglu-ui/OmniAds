/**
 * ITEM 11's account-scope law, proven on a throwaway PostgreSQL.
 *
 * Boots a real cluster on a random free port, migrates it from zero with the
 * repo's own deploy entry point, and hands it to
 * `lib/meta/history-account-assignment.db.test.ts`, which asserts that Meta
 * History resolves accounts through `business_provider_accounts.is_selected`
 * and cannot reach a deselected binding or another business's account.
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
 * Usage: npx tsx scripts/ephemeral-postgres-meta-history-assignment-seam.ts
 */
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";

const FORBIDDEN_PORTS = new Set([5432, 15432]);
const USER = "postgres";
const DB = "meta_history_assignment_seam";
const LABEL = "[meta-history-assignment-seam]";
const SEAM_TEST = "lib/meta/history-account-assignment.db.test.ts";

function log(message: string) {
  console.log(`${LABEL} ${message}`);
}

function assert(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(`meta history assignment seam FAILED: ${message}`);
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

async function main() {
  const bin = pgBinDir();
  const port = await freePort();
  assert(!FORBIDDEN_PORTS.has(port), `refusing port ${port}`);
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-history-assignment-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
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
    await runChild(
      process.execPath,
      [path.join("node_modules", "vitest", "vitest.mjs"), "run", SEAM_TEST],
      url,
      "history account-assignment seam",
    );

    log("PASS: Meta History reads accounts through the current assignment only.");
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
