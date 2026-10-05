import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import * as maintenance from "./maintenance";
import { databaseUrl } from "./backend";
import { REPO_ROOT, TSX_LOADER } from "./source-pack";
import { CONTEXT, EVAL, safeError, writeExclusive } from "./common";

/** OWNED REAL-PG SEAM (fixture only; never imported by the executor). The
 * post-retirement TOAST observation on a full run-migrations schema: exactly the
 * two target TOAST relations, catalog/pg_stat metadata only, one READ ONLY RR
 * snapshot ending in ROLLBACK, no VACUUM/DDL/DML text, no vacuum counter change,
 * and explicit non-claims. Also the stage entry: the observation op runs, and a
 * TOAST VACUUM request is refused before any database connection. */
const PG = "/opt/homebrew/opt/postgresql@16/bin";
const PG_ENV: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
const OUT = process.env.NSB_RESULT_DIR ?? "";
const PRIVATE_BASE = "/Users/harmelek/.codex/private";
const hex = randomBytes(6).toString("hex"), STATE = `${PRIVATE_BASE}/nsb-toastobs-${hex}`;
const checks: Record<string, unknown> = {};
let step = "init";
const refusal = async (fn: () => Promise<unknown>) => { try { await fn(); return "NO_REFUSAL"; } catch (e) { return safeError(e).code; } };
const WRITE_OR_MAINTENANCE = /\b(VACUUM|ANALYZE|REINDEX|CLUSTER|DROP|DELETE|UPDATE|INSERT|ALTER|CREATE|TRUNCATE|GRANT|COPY)\b/i;

async function main() {
  assert(OUT.startsWith("/") && !OUT.startsWith(PRIVATE_BASE), "NSB_RESULT_DIR required");
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  step = "cluster";
  const data = join(STATE, "pg", "data"), sock = join(STATE, "pg", "sock"), port = 24000 + randomBytes(2).readUInt16BE() % 5000;
  await mkdir(sock, { recursive: true, mode: 0o700 });
  execFileSync(`${PG}/initdb`, ["-D", data, "-U", "nsb_owner", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], { stdio: "ignore", env: PG_ENV });
  await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${sock}'\nunix_socket_permissions = 0700\nport = ${port}\n`);
  execFileSync(`${PG}/pg_ctl`, ["-D", data, "-l", join(STATE, "pg", "log"), "-w", "-t", "60", "start"], { stdio: "ignore", env: PG_ENV });
  const psql = (sql: string) => execFileSync(`${PG}/psql`, ["-h", sock, "-p", String(port), "-U", "nsb_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql],
    { encoding: "utf8", env: PG_ENV }).trim();
  const srcDb = `nsb_source_${hex}`, emptyDb = `nsb_source_${hex}_01`;
  for (const name of [srcDb, emptyDb]) psql(`CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  const url = (db: string) => databaseUrl("nsb_owner", sock, port, db);
  const migrated = await new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, join(REPO_ROOT, "scripts/run-migrations.ts")], { cwd: STATE, stdio: "ignore",
      env: { NODE_ENV: "production", PATH: PG_ENV.PATH, HOME: STATE, TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"), DATABASE_URL: url(srcDb),
        DATABASE_URL_UNPOOLED: url(srcDb), DB_SSL_MODE: "disable", ENABLE_RUNTIME_MIGRATIONS: "1", ADSECUTE_EPHEMERAL_DB_SEAM: "1" } });
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
  assert.equal(migrated, 0, "full run-migrations schema");
  const connect = async (db = srcDb) => { const c = new Client({ host: sock, port, user: "nsb_owner", database: db, application_name: "nsb-toastobs" });
    c.on("error", () => undefined); await c.connect(); return c; };
  const admin = await connect();
  try {
    const toast = (await admin.query(`SELECT c.relname::text relation,c.reltoastrelid::text toast FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace
      WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [[EVAL, CONTEXT]])).rows as { relation: string; toast: string }[];
    const counters = async () => (await admin.query(`SELECT relid::text relid,vacuum_count::text v,autovacuum_count::text av,analyze_count::text a
      FROM pg_stat_all_tables WHERE relid=ANY($1::oid[]) ORDER BY relid`, [toast.map(t => t.toast)])).rows;

    step = "direct-observation";
    const before = await counters();
    const statements: string[] = [];
    const observed = await connect();
    let value: any;
    try {
      const logged = { query: (sql: string, values?: unknown[]) => { statements.push(sql); return observed.query(sql, values); } };
      value = await maintenance.observeTargetToast(logged);
    } finally { await observed.end(); }
    const after = await counters();
    checks.direct = { contract: value.contract, readOnly: value.readOnly, vacuumCommandExecuted: value.vacuumCommandExecuted,
      toastVacuumAcknowledged: value.toastVacuumAcknowledged, reusableBytesClaimed: value.reusableBytesClaimed,
      osReturnedBytesClaimed: value.osReturnedBytesClaimed,
      relations: value.relations.map((r: any) => [r.relation, r.toastOid]),
      exactTargetToastOids: JSON.stringify(value.relations.map((r: any) => [r.relation, r.toastOid])) === JSON.stringify(toast.map(t => [t.relation, t.toast])),
      metadataOnlyStatements: statements.every(s => !WRITE_OR_MAINTENANCE.test(s)),
      readOnlyRepeatableRead: statements[0] === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY",
      readLimitsUnchanged: statements.includes("SET LOCAL statement_timeout='7500ms'") && statements.includes("SET LOCAL lock_timeout='1000ms'"),
      endedWithRollback: statements.at(-1) === "ROLLBACK", vacuumCountersUnchanged: JSON.stringify(before) === JSON.stringify(after) };
    assert.deepEqual(checks.direct, { contract: "native-post-retirement-toast-observation.v1", readOnly: true, vacuumCommandExecuted: false,
      toastVacuumAcknowledged: false, reusableBytesClaimed: 0, osReturnedBytesClaimed: 0, relations: toast.map(t => [t.relation, t.toast]),
      exactTargetToastOids: true, metadataOnlyStatements: true, readOnlyRepeatableRead: true, readLimitsUnchanged: true, endedWithRollback: true,
      vacuumCountersUnchanged: true });

    step = "missing-target-relations-refuse";
    const empty = await connect(emptyDb);
    try { checks.missingTargets = await refusal(() => maintenance.observeTargetToast(empty)); } finally { await empty.end(); }
    assert.equal(checks.missingTargets, "EXACT_TWO_TARGET_TOAST_RELATIONS");

    step = "stage-entry";
    const stage = (request: Record<string, unknown>) => {
      const r = spawnSync(process.execPath, ["--import", TSX_LOADER, join(REPO_ROOT, "scripts/native-storage-batch/stage-entry.ts")], {
        cwd: STATE, input: `${JSON.stringify({ targetRevision: head, ...request })}\n`, encoding: "utf8", timeout: 60_000,
        env: { NODE_ENV: "production", PATH: PG_ENV.PATH, HOME: STATE, TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"), NSB_HOST_MODE: "owned",
          NSB_STATE_ROOT: STATE, APP_BUILD_ID: head, DB_SSL_MODE: "disable", DATABASE_URL: url(srcDb), DATABASE_URL_UNPOOLED: url(srcDb) } });
      const line = JSON.parse(r.stdout.trim().split("\n").at(-1) ?? "{}");
      return { exit: r.status, type: line.type, code: line.code ?? null, value: line.value };
    };
    const ok = stage({ op: "toast-observation" }), retired = stage({ op: "vacuum", component: "toast", jobRunIds: ["11111111-1111-4111-8111-111111111111"] });
    checks.stageEntry = { observation: [ok.exit, ok.type, ok.value?.vacuumCommandExecuted, ok.value?.relations?.length], toastVacuum: [retired.exit, retired.type, retired.code] };
    assert.deepEqual(checks.stageEntry, { observation: [0, "result", false, 2], toastVacuum: [1, "error", "VACUUM_TOAST_STAGE_RETIRED"] });
    assert.deepEqual(await counters(), before, "no vacuum through the stage entry");
  } finally { await admin.end(); }
  return data;
}

(async () => {
  let data: string | undefined, failure: unknown = null;
  try { data = await main(); } catch (e) { failure = e; }
  const dir = data ?? join(STATE, "pg", "data");
  spawnSync(`${PG}/pg_ctl`, ["-D", dir, "-m", "immediate", "-w", "stop"], { stdio: "ignore", env: PG_ENV });
  const stopped = spawnSync(`${PG}/pg_ctl`, ["-D", dir, "status"], { stdio: "ignore", env: PG_ENV }).status;
  const confirmed = stopped === 3 || stopped === 4;
  if (confirmed && STATE.startsWith(`${PRIVATE_BASE}/nsb-toastobs-`) && /^[a-f0-9]{12}$/.test(hex)) await rm(STATE, { recursive: true, force: true });
  const receipt = { contract: "native-toast-observation-owned-real-pg.v1", stateRoot: "$STATE", stateRootRemoved: confirmed, clusterStopStatus: stopped,
    actualExitCode: failure ? 1 : 0, failedStep: failure ? step : null,
    failure: failure ? { ...safeError(failure), message: String((failure as Error)?.message ?? failure).slice(0, 300) } : null,
    checks, productionAccess: false, fixtureScope: "Owned PG16, full run-migrations schema; not production statistics." };
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  await writeExclusive(join(OUT, `toast-observation-pg-receipt-${hex}.json`), JSON.stringify(receipt, null, 2), 0o400);
  process.stdout.write(`${JSON.stringify({ actualExitCode: receipt.actualExitCode, receipt: `toast-observation-pg-receipt-${hex}.json`, failedStep: receipt.failedStep, failure: receipt.failure })}\n`);
  setTimeout(() => process.exit(receipt.actualExitCode), 200);
})();
