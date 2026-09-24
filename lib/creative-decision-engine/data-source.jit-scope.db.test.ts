/**
 * Creative decision reads run without LLVM JIT, on the backend that runs them.
 *
 * WHY. The D101/D105/D106 decision statements are large enough that their
 * planner estimate crosses jit_optimize_above_cost on real data, and on the
 * PostgreSQL 16 build production and CI use (Ubuntu, LLVM JIT, jit=on) one
 * calibration statement measured 316 ms with jit=off against 7.3 s with jit=on.
 * `getCreativeDecisionReadDb` scopes `jit = off` to these reads only.
 *
 * WHAT IS PROVEN HERE, against a real cluster this file provisions (so it can
 * read the server's own statement log):
 *
 *   - a scoped pooled read sees jit=off, and the SAME backend is back at the
 *     server default for the next unscoped read (DB_POOL_MAX=1 pins it);
 *   - inside a transaction opened without the scope, a scoped read sees
 *     jit=off, still does after ROLLBACK TO SAVEPOINT, and the setting ends
 *     with the transaction;
 *   - a transaction opened inside the scope is jit=off throughout;
 *   - a real `WarehouseDataSource.listCreativeInputs` call -- the lifecycle
 *     table read and the full creative hydration statement -- executes on a
 *     backend whose lease set `jit = off` immediately before it and reset it
 *     immediately after, read from the server's log by backend PID.
 *
 * A JIT-less build (Homebrew) still proves the setting; whether compilation
 * would have happened is a property of the build, not of this code.
 */
import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

/** Never the local volume, never the production tunnel. */
const FORBIDDEN_PORTS = new Set([5432, 15432]);
const DB_NAME = "adsecute_decision_jit_scope";
const DB_USER = "postgres";
const BUSINESS_ID = "d0000000-0000-4000-8000-0000000009a1";
const AS_OF = "2026-05-04";

function postgresBinDir(): string | null {
  const candidates = [
    process.env.EPHEMERAL_PG_BIN_DIR ?? "",
    "/opt/homebrew/opt/postgresql@16/bin",
    "/opt/homebrew/bin",
    "/usr/local/opt/postgresql@16/bin",
    "/usr/bin",
  ].filter(Boolean);
  return (
    candidates.find((dir) =>
      ["initdb", "pg_ctl", "createdb"].every((bin) =>
        fs.existsSync(path.join(dir, bin)),
      ),
    ) ?? null
  );
}

const PG_BIN = postgresBinDir();

function run(command: string, args: string[]) {
  const result = spawnSync(command, args, {
    encoding: "utf8",
    env: { ...process.env, LC_ALL: "C" },
  });
  if (result.status !== 0) {
    throw new Error(
      `${command} ${args.join(" ")} failed:\n${result.stdout}\n${result.stderr}`,
    );
  }
  return result.stdout;
}

async function freePort(): Promise<number> {
  return new Promise((resolve, reject) => {
    const server = net.createServer();
    server.once("error", reject);
    server.listen(0, "127.0.0.1", () => {
      const address = server.address();
      const port = typeof address === "object" && address ? address.port : 0;
      server.close((error) => (error ? reject(error) : resolve(port)));
    });
  });
}

async function migrate(databaseUrl: string) {
  const code = await new Promise<number>((resolve, reject) => {
    const child = spawn(
      process.execPath,
      ["--import", "tsx", path.join("scripts", "run-migrations.ts")],
      {
        cwd: process.cwd(),
        stdio: "ignore",
        env: {
          ...process.env,
          LC_ALL: "C",
          DATABASE_URL: databaseUrl,
          DATABASE_URL_UNPOOLED: databaseUrl,
          DB_SSL_MODE: "disable",
        },
      },
    );
    child.once("error", reject);
    child.once("exit", (status) => resolve(status ?? 1));
  });
  if (code !== 0) throw new Error(`run-migrations exited ${code}`);
}

type LoggedStatement = { pid: string; text: string };

/** `log_statement=all` lines as (backend PID, statement text), in order. */
function readStatementLog(logFile: string): LoggedStatement[] {
  const statements: LoggedStatement[] = [];
  const lines = fs.readFileSync(logFile, "utf8").split("\n");
  for (let index = 0; index < lines.length; index += 1) {
    const match = /\[(\d+)\] LOG:  (?:statement|execute [^:]*): ?(.*)$/.exec(
      lines[index]!,
    );
    if (!match) continue;
    let text = match[2]!.trim();
    // A statement that starts with a newline continues on the next line.
    for (let next = index + 1; !text && next < lines.length; next += 1) {
      if (/^\d{4}-\d{2}-\d{2} /.test(lines[next]!)) break;
      text = lines[next]!.trim();
    }
    statements.push({ pid: match[1]!, text });
  }
  return statements;
}

describe("the creative decision read handle", () => {
  it("is the only database handle data-source.ts uses", () => {
    /*
      Every read in the module must go through the JIT-scoped handle. The
      shared handle is imported under another name and referenced exactly
      once, inside `getCreativeDecisionReadDb`; `getDb` is its local alias.
    */
    const source = fs.readFileSync(
      path.join(process.cwd(), "lib", "creative-decision-engine", "data-source.ts"),
      "utf8",
    );
    expect(source).toMatch(
      /import \{ getDb as getSharedDb, type DbClient \} from "@\/lib\/db";/,
    );
    expect(source.match(/getSharedDb\(/g)).toHaveLength(1);
    expect(source).toMatch(/const getDb = getCreativeDecisionReadDb;/);
    expect(source).not.toMatch(/import \{ getDb \} from "@\/lib\/db"/);
  });
});

describe.skipIf(PG_BIN === null)(
  "creative decision reads run without LLVM JIT on their backend",
  () => {
    let pgCtl = "";
    let tempDir = "";
    let dataDir = "";
    let logFile = "";
    let socketDir = "";
    let started = false;
    const originalEnv = Object.fromEntries(
      ["DATABASE_URL", "DATABASE_URL_UNPOOLED", "DB_SSL_MODE", "DB_POOL_MAX"].map(
        (key) => [key, process.env[key]],
      ),
    );
    let db: typeof import("@/lib/db");
    let jitScope: typeof import("@/lib/db-jit-scope");
    let dataSource: typeof import("./data-source");

    const setting = async (
      handle: { query: (text: string) => Promise<Array<Record<string, unknown>>> },
    ) => {
      const [row] = await handle.query(
        "SELECT current_setting('jit') AS jit, pg_backend_pid()::text AS pid",
      );
      return { jit: String(row?.jit), pid: String(row?.pid) };
    };

    beforeAll(async () => {
      const port = await freePort();
      if (FORBIDDEN_PORTS.has(port)) {
        throw new Error(`Refusing forbidden PostgreSQL port ${port}.`);
      }
      const bin = PG_BIN!;
      pgCtl = path.join(bin, "pg_ctl");
      tempDir = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-jit-"));
      dataDir = path.join(tempDir, "data");
      logFile = path.join(tempDir, "postgres.log");
      socketDir = fs.mkdtempSync(path.join(os.tmpdir(), "jit-"));
      run(path.join(bin, "initdb"), [
        "-D", dataDir, "-U", DB_USER, "-A", "trust", "--no-locale", "--encoding=UTF8",
      ]);
      run(pgCtl, [
        "-D", dataDir, "-l", logFile,
        "-o", `-F -h 127.0.0.1 -p ${port} -k ${socketDir} -c log_statement=all`,
        "-w", "start",
      ]);
      started = true;
      run(path.join(bin, "createdb"), [
        "-h", "127.0.0.1", "-p", String(port), "-U", DB_USER, DB_NAME,
      ]);
      const databaseUrl = `postgresql://${DB_USER}@127.0.0.1:${port}/${DB_NAME}`;
      await migrate(databaseUrl);
      process.env.DATABASE_URL = databaseUrl;
      process.env.DATABASE_URL_UNPOOLED = databaseUrl;
      process.env.DB_SSL_MODE = "disable";
      // One pooled backend, so "the same backend afterwards" is guaranteed.
      process.env.DB_POOL_MAX = "1";

      db = await import("@/lib/db");
      jitScope = await import("@/lib/db-jit-scope");
      dataSource = await import("./data-source");
      expect((await setting(db.getDb())).jit).toBe("on");
    }, 180_000);

    afterAll(async () => {
      try {
        db?.resetDbClientCache?.();
        await new Promise((resolve) => setTimeout(resolve, 250));
      } catch {
        /* the cluster is going away regardless */
      }
      if (started && pgCtl && dataDir) {
        spawnSync(pgCtl, ["-D", dataDir, "-m", "immediate", "stop"], {
          encoding: "utf8",
          env: { ...process.env, LC_ALL: "C" },
        });
      }
      if (tempDir) fs.rmSync(tempDir, { recursive: true, force: true });
      if (socketDir) fs.rmSync(socketDir, { recursive: true, force: true });
      for (const [key, value] of Object.entries(originalEnv)) {
        if (value === undefined) delete process.env[key];
        else process.env[key] = value;
      }
    }, 60_000);

    it("turns jit off for a pooled read and hands the backend back at the server default", async () => {
      const scoped = await setting(dataSource.getCreativeDecisionReadDb());
      const after = await setting(db.getDb());
      expect(scoped.jit).toBe("off");
      expect(after.pid).toBe(scoped.pid);
      expect(after.jit).toBe("on");
    });

    it("scopes a read inside an outer transaction, across a savepoint rollback, and ends with it", async () => {
      let pid = "";
      await db.runDbTransaction(async () => {
        const tx = db.getDb();
        const before = await setting(tx);
        pid = before.pid;
        expect(before.jit).toBe("on");
        await tx.query("SAVEPOINT jit_scope_probe");
        expect((await setting(dataSource.getCreativeDecisionReadDb())).jit).toBe("off");
        await tx.query("ROLLBACK TO SAVEPOINT jit_scope_probe");
        // The rollback undid the SET LOCAL; the next scoped read re-applies it.
        expect((await setting(dataSource.getCreativeDecisionReadDb())).jit).toBe("off");
      });
      const after = await setting(db.getDb());
      expect(after.pid).toBe(pid);
      expect(after.jit).toBe("on");
    });

    it("keeps a transaction opened inside the scope jit-off throughout", async () => {
      await jitScope.runWithDbJitDisabled(() =>
        db.runDbTransaction(async () => {
          const tx = db.getDb();
          await tx.query("SAVEPOINT jit_scope_whole");
          await tx.query("ROLLBACK TO SAVEPOINT jit_scope_whole");
          expect((await setting(tx)).jit).toBe("off");
        }),
      );
      expect((await setting(db.getDb())).jit).toBe("on");
    });

    it("runs the real lifecycle read and creative hydration on a jit-off lease", async () => {
      const source = new dataSource.WarehouseDataSource(
        new Date(Date.now() - 1_000).toISOString(),
      );
      await source.listCreativeInputs({ businessId: BUSINESS_ID, asOf: AS_OF });

      const log = readStatementLog(logFile);
      for (const marker of ["WITH lifecycle_rows AS", "WITH input_creatives AS"]) {
        const index = log.findLastIndex((entry) => entry.text.startsWith(marker));
        expect(index, `${marker} was not executed`).toBeGreaterThan(-1);
        const { pid } = log[index]!;
        const onBackend = log
          .map((entry, position) => ({ ...entry, position }))
          .filter((entry) => entry.pid === pid);
        const at = onBackend.findIndex((entry) => entry.position === index);
        expect(onBackend[at - 1]?.text, `${marker}: setup on backend ${pid}`).toMatch(
          /^SET statement_timeout = \d+; SET jit = off$/,
        );
        expect(onBackend[at + 1]?.text, `${marker}: cleanup on backend ${pid}`).toBe(
          "RESET statement_timeout; RESET jit",
        );
      }
    });
  },
);
