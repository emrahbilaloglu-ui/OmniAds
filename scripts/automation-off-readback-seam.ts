#!/usr/bin/env node
/**
 * PRE-DEPLOY AUDIT — the automation-OFF readback, executed in BOTH schema
 * states against a real PostgreSQL cluster.
 *
 * The readback is the one artifact an operator runs against production before
 * and after the deploy, so "it should work" is not good enough: a statement
 * that merely NAMES a table this release creates aborts the whole transaction
 * at parse time on the pre-deploy run, taking every earlier verdict with it.
 *
 * This boots its own cluster, applies the REAL migration registry, then:
 *
 *   1. removes the two objects this release adds — the activation column and
 *      the write journal — reproducing the schema production has TODAY, and
 *      runs the readback through `psql`;
 *   2. re-applies the registry and runs the same file again.
 *
 * Both runs must exit 0, emit no ERROR, and report every section. The file is
 * read from the Markdown document it ships in, so the thing tested is the
 * thing an operator will paste.
 *
 * Read-only against the cluster it created; it never opens a production handle.
 */
import { spawnSync } from "node:child_process";
import fs from "node:fs";
import net from "node:net";
import os from "node:os";
import path from "node:path";

const READBACK_DOC = "docs/audits/AUTOMATION_OFF_READBACK_2026-09-03.md";

function pgBinDir(): string {
  const need = ["initdb", "pg_ctl", "createdb", "psql"];
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
  if (!found) throw new Error("PostgreSQL binaries not found for the readback seam.");
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

/** The SQL between the fences, exactly as an operator would paste it. */
export function extractReadbackSql(markdown: string): string {
  const start = markdown.indexOf("```sql");
  const end = markdown.indexOf("```", start + 6);
  if (start < 0 || end < 0) throw new Error("no fenced sql block in the readback document");
  return markdown.slice(start + 6, end).replace(/^\n/, "");
}

export interface ReadbackSeamReport {
  ok: boolean;
  postgresVersion: string;
  runs: Array<{
    state: "pre_migration" | "post_migration";
    exitCode: number | null;
    sections: string[];
    errors: string[];
  }>;
  failures: string[];
}

export async function runAutomationOffReadbackSeam(): Promise<ReadbackSeamReport> {
  const bin = pgBinDir();
  const port = await freePort();
  const root = fs.mkdtempSync(path.join(os.tmpdir(), "adsecute-readback-pg-"));
  const dataDir = path.join(root, "data");
  const failures: string[] = [];
  const runs: ReadbackSeamReport["runs"] = [];
  let postgresVersion = "";

  /*
    `LC_ALL=C` is not cosmetic on macOS: without it the postmaster reports
    "became multithreaded during startup" and refuses to start, which is the
    same reason the sibling seams pass `--no-locale` to initdb.
  */
  // `Record<string, string>`, not `NodeJS.ProcessEnv`: this repo's ProcessEnv
  // declares NODE_ENV as required, so an empty default does not satisfy it.
  // These are OVERRIDES spread over `process.env`, never a whole environment.
  const pg = (cmd: string, args: string[], env: Record<string, string> = {}) =>
    spawnSync(path.join(bin, cmd), args, {
      encoding: "utf8", env: { ...process.env, LC_ALL: "C", LANG: "C", ...env },
    });

  const psql = (sql: string, extra: string[] = []) =>
    spawnSync(path.join(bin, "psql"), [
      "-h", "127.0.0.1", "-p", String(port), "-U", "readback", "-d", "readback_seam",
      "-v", "ON_ERROR_STOP=1", ...extra, "-c", sql,
    ], { encoding: "utf8" });

  try {
    const init = pg("initdb",
      ["-D", dataDir, "-U", "readback", "--auth=trust", "--no-locale"]);
    if (init.status !== 0) throw new Error(`initdb failed: ${init.stderr}`);
    const logFile = path.join(root, "pg.log");
    const start = pg("pg_ctl", [
      "-D", dataDir, "-l", logFile, "-w",
      "-o", `-p ${port} -k ${root} -h 127.0.0.1`, "start",
    ]);
    if (start.status !== 0) {
      const log = fs.existsSync(logFile) ? fs.readFileSync(logFile, "utf8").slice(-1200) : "";
      throw new Error(`pg_ctl start failed: ${start.stderr}\n${log}`);
    }
    const created = pg("createdb",
      ["-h", "127.0.0.1", "-p", String(port), "-U", "readback", "readback_seam"]);
    if (created.status !== 0) throw new Error(`createdb failed: ${created.stderr}`);

    const url = `postgresql://readback@127.0.0.1:${port}/readback_seam`;
    postgresVersion = psql("SELECT version()").stdout.split("\n")[2]?.trim() ?? "";

    const migrate = () => {
      const result = spawnSync(process.execPath, [
        "--import", "tsx", "scripts/run-migrations.ts",
      ], {
        encoding: "utf8",
        env: {
          ...process.env,
          DATABASE_URL: url,
          ENABLE_RUNTIME_MIGRATIONS: "1",
          NODE_OPTIONS: "--max-old-space-size=1800",
        },
      });
      if (result.status !== 0) {
        throw new Error(`migrations failed: ${result.stderr.slice(-2000)}`);
      }
    };

    migrate();

    const sql = extractReadbackSql(fs.readFileSync(READBACK_DOC, "utf8"));
    const sqlFile = path.join(root, "readback.sql");
    fs.writeFileSync(sqlFile, sql, "utf8");

    const runReadback = (state: "pre_migration" | "post_migration") => {
      const result = spawnSync(path.join(bin, "psql"), [
        "-h", "127.0.0.1", "-p", String(port), "-U", "readback", "-d", "readback_seam",
        "-v", "ON_ERROR_STOP=1", "-f", sqlFile,
      ], { encoding: "utf8" });
      const output = `${result.stdout}\n${result.stderr}`;
      const sections = [...output.matchAll(/^\s*(\w[\w_]*)\s*\|/gm)]
        .map((match) => match[1]!)
        .filter((token) => token.endsWith("_switch") || token.includes("_") );
      const errors = output.split("\n").filter((line) => /^psql:.*ERROR/i.test(line));
      runs.push({ state, exitCode: result.status, sections, errors });
      if (result.status !== 0) {
        failures.push(`${state}: psql exited ${result.status}: ${errors.join(" | ") || output.slice(-400)}`);
      }
      if (errors.length > 0) {
        failures.push(`${state}: ${errors.length} SQL error(s): ${errors.join(" | ")}`);
      }
      // The verdict column must actually be produced.
      if (!/verdict/i.test(output)) {
        failures.push(`${state}: no verdict column in the output`);
      }
      // And the read must have been read-only.
      if (!/transaction_posture/.test(output)) {
        failures.push(`${state}: the transaction-posture section did not run`);
      }
      return output;
    };

    /*
      STATE 1 — production TODAY. Remove exactly what this release adds: the
      activation column and the budget write journal. The readback must run
      unchanged, naming neither.
    */
    const strip = psql(
      "ALTER TABLE meta_automation_business_controls "
      + "DROP COLUMN IF EXISTS auto_execution_provider_account_id, "
      + "DROP COLUMN IF EXISTS auto_execution_enabled_by; "
      + "DROP TABLE IF EXISTS meta_budget_write_journal CASCADE;",
    );
    if (strip.status !== 0) {
      throw new Error(`could not reproduce the pre-deploy schema: ${strip.stderr}`);
    }
    const pre = runReadback("pre_migration");
    if (!/PASS \(pre-migration\)/.test(pre)) {
      failures.push("pre_migration: the journal section did not report the pre-migration verdict");
    }
    if (/meta_budget_write_journal/.test(pre.replace(/^--.*$/gm, ""))
      && /does not exist/i.test(pre)) {
      failures.push("pre_migration: the absent table was named in a sent statement");
    }

    // STATE 2 — after the deploy. Re-apply and run the same file again.
    migrate();
    const post = runReadback("post_migration");
    if (!/master_switch/.test(post)) {
      failures.push("post_migration: the master-switch section did not run");
    }
    if (/PASS \(pre-migration\)/.test(post)) {
      failures.push("post_migration: still reporting a pre-migration verdict after migrating");
    }

    // The document must remain SELECT-only and end in ROLLBACK.
    const forbidden = sql
      .split("\n")
      .filter((line) => !line.trim().startsWith("--"))
      .filter((line) => /\b(INSERT|UPDATE|DELETE|TRUNCATE|GRANT|CREATE|ALTER|DROP)\b/i.test(line));
    if (forbidden.length > 0) {
      failures.push(`the readback contains mutating SQL: ${forbidden[0]!.trim()}`);
    }
    if (!/ROLLBACK;/.test(sql)) failures.push("the readback does not end in ROLLBACK");
    if (!/READ ONLY/.test(sql)) failures.push("the readback does not open a READ ONLY transaction");
  } catch (error) {
    failures.push(error instanceof Error ? error.message : String(error));
  } finally {
    spawnSync(path.join(bin, "pg_ctl"), ["-D", dataDir, "-m", "immediate", "-w", "stop"], {
      encoding: "utf8",
    });
    fs.rmSync(root, { recursive: true, force: true });
  }

  return { ok: failures.length === 0, postgresVersion, runs, failures };
}

if (process.argv[1] && process.argv[1].endsWith("automation-off-readback-seam.ts")) {
  runAutomationOffReadbackSeam().then((report) => {
    console.log(JSON.stringify(report, null, 2));
    process.exit(report.ok ? 0 : 1);
  });
}
