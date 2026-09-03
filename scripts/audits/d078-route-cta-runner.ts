#!/usr/bin/env node
// D078 corrections 2–3 — fast standalone runner for the actual-route CTA
// proof pair: boots the ephemeral cluster, migrates, seeds the shared
// lattice fixture, then runs (1) the node-environment actual-route test,
// which captures its route payload into a handoff file, and (2) the
// jsdom drawer/action test over that captured payload — serially, with
// full output — then tears down. Exists so the proof can be iterated in
// minutes instead of a full browser-matrix run; the acceptance path
// remains the local-UI harness (same two files, recorded as
// routeCtaProof).
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { spawn, spawnSync } from "node:child_process";
import { Client } from "pg";
import { seedD078Fixture } from "@/scripts/audits/d078-lattice-seed";

const PG_PORT = 15544;
const DB_NAME = "adsecute_d078_qa";
const DB_USER = "postgres";
const PG_TOOL_ENV = { ...process.env, LC_ALL: "C" };

function resolvePgBinDir(): string {
  const required = ["initdb", "pg_ctl", "postgres", "createdb"];
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR?.trim(),
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    ...(process.env.PATH ?? "").split(path.delimiter),
  ].filter((dir): dir is string => Boolean(dir));
  for (const dir of candidates) {
    if (required.every((binary) => fs.existsSync(path.join(dir, binary))))
      return dir;
  }
  throw new Error("PostgreSQL binaries not found");
}

function runSync(command: string, args: string[], label: string) {
  const result = spawnSync(command, args, { encoding: "utf8", env: PG_TOOL_ENV });
  if (result.status !== 0)
    throw new Error(`${label} exited ${result.status}\n${result.stderr}`);
}

async function main() {
  const binDir = resolvePgBinDir();
  const dataDir = fs.mkdtempSync(path.join(os.tmpdir(), "d078-cta-pg-"));
  const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${PG_PORT}/${DB_NAME}`;
  try {
    runSync(path.join(binDir, "initdb"), ["-D", dataDir, "-U", DB_USER, "-A", "trust"], "initdb");
    runSync(
      path.join(binDir, "pg_ctl"),
      ["-D", dataDir, "-o", `-p ${PG_PORT} -c listen_addresses=127.0.0.1`, "-w", "start", "-l", path.join(dataDir, "pg.log")],
      "pg_ctl start",
    );
    runSync(path.join(binDir, "createdb"), ["-h", "127.0.0.1", "-p", String(PG_PORT), "-U", DB_USER, DB_NAME], "createdb");
    await new Promise<void>((resolve, reject) => {
      const child = spawn(
        process.execPath,
        ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
        {
          cwd: process.cwd(),
          stdio: ["ignore", "ignore", "inherit"],
          env: {
            ...process.env,
            DATABASE_URL: databaseUrl,
            DATABASE_URL_UNPOOLED: databaseUrl,
            ENABLE_RUNTIME_MIGRATIONS: "1",
            ADSECUTE_EPHEMERAL_DB_SEAM: "1",
          },
        },
      );
      child.on("exit", (code) =>
        code === 0 ? resolve() : reject(new Error(`migrations exited ${code}`)),
      );
    });
    const client = new Client({ connectionString: databaseUrl });
    await client.connect();
    try {
      await seedD078Fixture(client);
    } finally {
      await client.end();
    }
    // Two serial vitest runs: the node route proof captures the actual
    // route payload into a handoff file inside this throwaway temp dir;
    // the jsdom drawer proof consumes it (jsdom's web transform cannot
    // import server modules, so the two proofs cannot share a process).
    const handoffPath = path.join(dataDir, "d078-cta-handoff.json");
    const routeProc = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "app/api/meta/decisions-workspace/route.lattice-cta.db.test.tsx",
        "--maxWorkers=1",
      ],
      {
        stdio: "inherit",
        env: {
          ...process.env,
          DATABASE_URL: databaseUrl,
          DATABASE_URL_UNPOOLED: databaseUrl,
          D078_LATTICE_DB: "1",
          D078_CTA_HANDOFF: handoffPath,
        },
      },
    );
    if (routeProc.status !== 0) {
      process.exitCode = routeProc.status ?? 1;
      return;
    }
    const drawerProc = spawnSync(
      "npx",
      [
        "vitest",
        "run",
        "app/api/meta/decisions-workspace/drawer-cta.db.test.tsx",
        "--maxWorkers=1",
      ],
      {
        stdio: "inherit",
        env: { ...process.env, D078_CTA_HANDOFF: handoffPath },
      },
    );
    process.exitCode = drawerProc.status ?? 1;
  } finally {
    try {
      runSync(path.join(binDir, "pg_ctl"), ["-D", dataDir, "stop", "-m", "fast"], "pg_ctl stop");
    } catch {
      // already stopped
    }
    fs.rmSync(dataDir, { recursive: true, force: true });
    console.log("[d078-cta-runner] teardown complete");
  }
}

main().catch((error) => {
  console.error(error instanceof Error ? error.message : error);
  process.exitCode = 1;
});
