#!/usr/bin/env node
/**
 * D088 — the additive proposal migration, against a real PostgreSQL cluster.
 *
 * Two things have to be true at once: a `budget` proposal must become storable,
 * and every proposal written before this slice must still read. A widened CHECK
 * that quietly rejected an old row would be a migration that broke the queue it
 * was meant to extend.
 *
 * Boots its own cluster, applies the REAL migration registry, destroys it.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

function pgBinDir(): string {
  const need = ["initdb", "pg_ctl", "createdb"];
  const linux = fs.existsSync("/usr/lib/postgresql")
    ? fs.readdirSync("/usr/lib/postgresql", { withFileTypes: true })
      .filter((entry) => entry.isDirectory())
      .map((entry) => path.join("/usr/lib/postgresql", entry.name, "bin"))
    : [];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    "/usr/local/opt/postgresql@16/bin",
    ...linux,
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter(Boolean) as string[];
  const found = candidates.find((dir) => need.every((bin) => fs.existsSync(path.join(dir, bin))));
  if (!found) throw new Error("PostgreSQL binaries not found for the D088 seam.");
  return found;
}

async function freePort(): Promise<number> {
  return new Promise<number>((resolve, reject) => {
    const server = net.createServer();
    server.unref();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close(() => (port ? resolve(port) : reject(new Error("no free port"))));
    });
  });
}

function run(bin: string, args: string[], label: string, logFile?: string): void {
  const out = spawnSync(bin, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C", LANG: "C" },
  });
  if (out.status !== 0) {
    const log = logFile && fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8") : "";
    throw new Error(`${label} failed: ${out.stderr || out.stdout}\n${log}`);
  }
}

export interface D088MigrationReport {
  ok: boolean;
  postgresVersion: string;
  checks: Array<{ check: string; detail: string }>;
  failures: string[];
}

export async function runD088MigrationSeam(): Promise<D088MigrationReport> {
  const bin = pgBinDir();
  const port = await freePort();
  const tmp = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-d088-"));
  const dataDir = path.join(tmp, "data");
  const logFile = path.join(tmp, "postgres.log");
  try {
    run(path.join(bin, "initdb"),
      ["-D", dataDir, "-U", "d088", "--auth=trust", "--no-locale"], "initdb");
    run(path.join(bin, "pg_ctl"), [
      "-D", dataDir, "-l", logFile, "-w", "-o",
      `-p ${port} -c listen_addresses=127.0.0.1 -c unix_socket_directories='' -c fsync=off`,
      "start",
    ], "pg_ctl start", logFile);
    run(path.join(bin, "createdb"),
      ["-h", "127.0.0.1", "-p", String(port), "-U", "d088", "d088_migration"], "createdb");

    const url = `postgres://d088@127.0.0.1:${port}/d088_migration`;
    const child = spawnSync(
      path.join(process.cwd(), "node_modules/.bin/tsx"),
      [path.join(process.cwd(), "scripts/d088-budget-proposal-migration-child.ts")],
      {
        encoding: "utf8",
        cwd: process.cwd(),
        maxBuffer: 64 * 1024 * 1024,
        env: {
          ...process.env, LC_ALL: "C", LANG: "C",
          DATABASE_URL: url, POSTGRES_URL: url, D088_EXPECTED_URL: url,
        },
      },
    );
    const marker = child.stdout?.lastIndexOf("__D088__") ?? -1;
    if (marker < 0) {
      return {
        ok: false, postgresVersion: "", checks: [],
        failures: [`child produced no report: ${child.stderr?.slice(-3000) ?? ""}`],
      };
    }
    return JSON.parse(child.stdout!.slice(marker + "__D088__".length)) as D088MigrationReport;
  } finally {
    spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C" },
    });
    fs.rmSync(tmp, { recursive: true, force: true });
  }
}

if (process.argv[1] && process.argv[1].endsWith("d088-budget-proposal-migration-seam.ts")) {
  runD088MigrationSeam().then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  });
}
