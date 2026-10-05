/** Owned PG16 regression: progress hidden from a plain role is unknown, never false.
 * A superuser concurrently runs VACUUM only inside this random socket-only fixture. */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { CONTEXT, EVAL, safeError, writeExclusive } from "./common";
import { observeTargetToast } from "./maintenance";
const PG = "/opt/homebrew/opt/postgresql@16/bin";
const hex = randomBytes(6).toString("hex"), state = `/Users/harmelek/.codex/private/nsb-vacvis-guard-${hex}`;
const data = join(state, "data"), sock = join(state, "sock"), port = 24000 + randomBytes(2).readUInt16BE() % 5000;
const out = process.env.NSB_RESULT_DIR ?? "";
const env: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
const checks: Record<string, unknown> = {};
const clients: Client[] = [];
let failure: unknown = null, vacuum: Promise<unknown> | null = null, vacuumPid: number | null = null;
async function connect(user: string) {
  const c = new Client({ host: sock, port, user, database: "postgres", application_name: `nsb-vacvis-guard-${hex}` });
  c.on("error", () => undefined); await c.connect(); clients.push(c); return c;
}
async function run() {
  assert(out.startsWith("/") && !out.startsWith("/Users/harmelek/.codex/private"), "NSB_RESULT_DIR required");
  await mkdir(sock, { recursive: true, mode: 0o700 });
  execFileSync(`${PG}/initdb`, ["-D", data, "-U", "nsb_owner", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], { stdio: "ignore", env });
  await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses=''\nunix_socket_directories='${sock}'\nunix_socket_permissions=0700\nport=${port}\nautovacuum=off\n`);
  execFileSync(`${PG}/pg_ctl`, ["-D", data, "-l", join(state, "log"), "-w", "-t", "60", "start"], { stdio: "ignore", env });
  const admin = await connect("nsb_owner");
  await admin.query("CREATE ROLE plain_app LOGIN NOSUPERUSER NOCREATEDB NOCREATEROLE NOINHERIT");
  for (const relation of [CONTEXT, EVAL]) {
    await admin.query(`CREATE TABLE public.${relation}(id int, payload text) WITH (autovacuum_enabled=false)`);
    await admin.query(`ALTER TABLE public.${relation} ALTER COLUMN payload SET STORAGE EXTERNAL`);
  }
  await admin.query(`INSERT INTO public.${EVAL} SELECT i, repeat(md5(i::text),1000) FROM generate_series(1,2000) i`);
  await admin.query(`DELETE FROM public.${EVAL} WHERE id%2=0`);
  const target = (await admin.query(`SELECT t.oid::text oid,t.relname FROM pg_class c JOIN pg_class t ON t.oid=c.reltoastrelid WHERE c.oid=$1::regclass`, [`public.${EVAL}`])).rows[0];
  const runner = await connect("nsb_owner");
  vacuumPid = (await runner.query("SELECT pg_backend_pid() pid")).rows[0].pid;
  await runner.query("SET vacuum_cost_delay='100ms'"); await runner.query("SET vacuum_cost_limit=1");
  vacuum = runner.query(`VACUUM pg_toast.${target.relname}`).then(() => ({ completed: true }), e => ({ completed: false, sqlState: e.code }));
  let active = false;
  for (let i = 0; i < 50 && !active; i++) {
    active = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_vacuum WHERE pid=$1 AND relid=$2::oid) active", [vacuumPid, target.oid])).rows[0].active;
    if (!active) await new Promise(resolve => setTimeout(resolve, 100));
  }
  assert(active, "actual concurrent target VACUUM required"); checks.actualTargetVacuumActive = active;
  const plain = await connect("plain_app");
  checks.plainRoleHasAllStats = (await plain.query("SELECT pg_has_role(current_user,'pg_read_all_stats','USAGE') allowed")).rows[0].allowed;
  assert.equal(checks.plainRoleHasAllStats, false);
  const hidden = (await plain.query("SELECT relid FROM pg_stat_progress_vacuum WHERE pid=$1", [vacuumPid])).rows;
  assert.equal(hidden.length, 1); assert.equal(hidden[0].relid, null); checks.actualProgressHidden = true;
  const plainObs = await observeTargetToast(plain), ownerObs = await observeTargetToast(admin);
  const pick = (v: typeof plainObs) => v.relations.find(r => r.toastOid === target.oid)?.vacuumInProgress;
  checks.plainRoleObservation = pick(plainObs); checks.ownerObservation = pick(ownerObs);
  checks.stillActiveAfterBothReads = (await admin.query("SELECT EXISTS(SELECT 1 FROM pg_stat_progress_vacuum WHERE pid=$1 AND relid=$2::oid) active", [vacuumPid, target.oid])).rows[0].active;
  assert.equal(checks.stillActiveAfterBothReads, true);
  assert.equal(pick(plainObs), null, "hidden progress must be unknown, never false");
  assert.equal(pick(ownerObs), true, "visible actual target progress must be true");
  assert.equal(plainObs.readOnly, true); assert.equal(plainObs.vacuumCommandExecuted, false);
  assert.equal(plainObs.toastVacuumAcknowledged, false); assert.equal(plainObs.osReturnedBytesClaimed, 0);
}
(async () => {
  try { await run(); } catch (e) { failure = e; }
  if (vacuumPid !== null && clients[0]) {
    try { await clients[0].query("SELECT pg_cancel_backend($1)", [vacuumPid]); } catch { /* owned cluster cleanup below */ }
  }
  if (vacuum) await vacuum;
  for (const c of clients) await c.end().catch(() => undefined);
  spawnSync(`${PG}/pg_ctl`, ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore", env });
  const stopped = spawnSync(`${PG}/pg_ctl`, ["-D", data, "status"], { stdio: "ignore", env }).status;
  const removed = stopped === 3 || stopped === 4;
  if (removed) await rm(state, { recursive: true, force: true });
  const receipt = { contract: "native-toast-observation-visibility-owned-pg.v1", actualExitCode: failure || !removed ? 1 : 0,
    checks, failure: failure ? { ...safeError(failure), assertion: String((failure as Error)?.message ?? failure).slice(0,200) } : null,
    clusterStopStatus: stopped, ownedStateRemoved: removed, productionAccess: false, readPrivilegesGranted: false };
  await mkdir(out, { recursive: true, mode: 0o700 });
  await writeExclusive(join(out, `toast-visibility-pg-receipt-${hex}.json`), JSON.stringify(receipt, null, 2), 0o400);
  console.log(JSON.stringify(receipt)); process.exitCode = receipt.actualExitCode;
})();
