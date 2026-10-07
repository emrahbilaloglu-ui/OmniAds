import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes, randomUUID } from "node:crypto";
import { appendFile, mkdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import { NATIVE_AD_ENGINE_VERSION } from "../../lib/creative-decision-engine/types";
import { collectWholeOriginal, sealAndPersist, verifyCopies } from "./capture";
import { acceptPrepared, prepareUnitRetirement } from "./retire";
import { independentReadback, readSelectedPinClosure } from "./maintenance";
import { restoreIntoOwnedNewDatabase } from "./restore";
import { databaseUrl, unitLockKey } from "./backend";
import { computeSourcePack, REPO_ROOT, TSX_LOADER } from "./source-pack";
import { rowSetHash, safeError, writeExclusive } from "./common";
import { addObservedProductionReferenceIndex, seedCalibration, seedGeneration, seedTenant } from "./owned-fixture";
import { producerExclusionKey, releaseProducerExclusion } from "./input-evidence-lifecycle";

/** OWNED REAL-PG GUARD (fixture only; never imported by the executor). Terminal
 * NO-OP proposal-projection dependents of an original decisions job on a full
 * run-migrations schema: exact retention with full row bytes through freeze,
 * sealed copies, owned full-DDL restore, fresh pre-retirement recensus,
 * one-transaction retirement and independent readback. Every unsafe dependency
 * shape, a post-freeze change, and every other pin still refuse. */
const PG = "/opt/homebrew/opt/postgresql@16/bin";
const PG_ENV: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
const OUT = process.env.NSB_RESULT_DIR ?? "";
const PRIVATE_BASE = "/Users/harmelek/.codex/private";
const hex = randomBytes(6).toString("hex"), STATE = `${PRIVATE_BASE}/nsb-tnoop-${hex}`;
const PROJECTION = "engine_v3_native_ad_proposal_projection_shadow_job";
const checks: Record<string, unknown> = {};
let step = "init";
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const two = (n: number) => String(n).padStart(2, "0");
const clock = (d: string, h: number, m = 0) => `${d}T${two(h)}:${two(m)}:00.000001Z`;
const refusal = async (fn: () => Promise<unknown>) => { try { await fn(); return "NO_REFUSAL"; } catch (e) { return safeError(e).code; } };

async function cluster(port: number) {
  const data = join(STATE, "pg", "data"), sock = join(STATE, "pg", "sock");
  await mkdir(sock, { recursive: true, mode: 0o700 });
  execFileSync(`${PG}/initdb`, ["-D", data, "-U", "nsb_owner", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], { stdio: "ignore", env: PG_ENV });
  await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${sock}'\nunix_socket_permissions = 0700\nport = ${port}\nenable_seqscan = off\n`);
  execFileSync(`${PG}/pg_ctl`, ["-D", data, "-l", join(STATE, "pg", "log"), "-w", "-t", "60", "start"], { stdio: "ignore", env: PG_ENV });
  return { data, sock, port };
}
const psql = (c: { sock: string; port: number }, sql: string) =>
  execFileSync(`${PG}/psql`, ["-h", c.sock, "-p", String(c.port), "-U", "nsb_owner", "-d", "postgres", "-v", "ON_ERROR_STOP=1", "-qAt", "-c", sql], { encoding: "utf8", env: PG_ENV }).trim();
function migrate(url: string) {
  return new Promise<number>((resolve, reject) => {
    const child = spawn(process.execPath, ["--import", TSX_LOADER, join(REPO_ROOT, "scripts/run-migrations.ts")], { cwd: STATE, stdio: "ignore",
      env: { NODE_ENV: "production", PATH: PG_ENV.PATH, HOME: STATE, TSX_TSCONFIG_PATH: join(REPO_ROOT, "tsconfig.json"), DATABASE_URL: url,
        DATABASE_URL_UNPOOLED: url, DB_SSL_MODE: "disable", ENABLE_RUNTIME_MIGRATIONS: "1", ADSECUTE_EPHEMERAL_DB_SEAM: "1" } });
    child.once("error", reject); child.once("exit", code => resolve(code ?? 1));
  });
}

async function main() {
  assert(OUT.startsWith("/") && !OUT.startsWith(PRIVATE_BASE), "NSB_RESULT_DIR required");
  await mkdir(STATE, { recursive: true, mode: 0o700 });
  const head = execFileSync("git", ["-C", REPO_ROOT, "rev-parse", "HEAD"], { encoding: "utf8" }).trim();
  const pack = await computeSourcePack(head);
  step = "cluster";
  const pg = await cluster(23000 + randomBytes(2).readUInt16BE() % 6000);
  const srcDb = `nsb_tnoop_${hex}`, tplDb = `nsb_restore_${hex}`;
  for (const name of [srcDb, tplDb]) psql(pg, `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  assert.deepEqual(await Promise.all([srcDb, tplDb].map(n => migrate(databaseUrl("nsb_owner", pg.sock, pg.port, n)))), [0, 0]);
  const connect = async (name = srcDb) => { const c = new Client({ host: pg.sock, port: pg.port, user: "nsb_owner", database: name, application_name: "nsb-tnoop" });
    c.on("error", () => undefined); await c.connect(); return c; };
  const db = await connect();
  try {
    // D150: the actual production (contract_version,input_hash) index, added to this owned sandbox only (not run-migrations).
    checks.addedProductionIndexPrerequisite = await addObservedProductionReferenceIndex(db);
    step = "seed";
    const t = await seedTenant(db, 2), other = await seedTenant(db, 1);
    const producer: Record<number, string> = {};
    for (let n = 14; n >= 1; n--) producer[n] = await seedCalibration(db, t, day(n), clock(day(n), 1));
    const gen = (n: number, tag: string, snapshots = false) => seedGeneration(db, t, { date: day(n), clock: clock(day(n), 1),
      finishedAt: clock(day(n), 2), producer: producer[n]!, perAccount: [3, 2], snapshots, tag });
    // The exact row shape the native chain's recordNativeProposalProjectionRun writes for a manual-mode slot.
    const child = async (g: { jobRunId: string }, date: string, o: Record<string, unknown> = {}) => {
      const row: Record<string, unknown> = { id: randomUUID(), job_name: PROJECTION, business_ref_id: t.business, business_id: t.business,
        as_of_date: date, engine_version: NATIVE_AD_ENGINE_VERSION, status: "skipped", dependency_run_id: g.jobRunId,
        started_at: clock(date, 5), finished_at: clock(date, 5, 1), duration_ms: 60_000, row_count: 0, error_message: "standing_mode_manual",
        created_at: clock(date, 5, 1), updated_at: clock(date, 5, 1), ...o };
      const names = Object.keys(row);
      await db.query(`INSERT INTO public.engine_v3_job_runs (${names.join(",")}) VALUES (${names.map((_, i) => `$${i + 1}`).join(",")})`, Object.values(row));
      return row.id as string;
    };
    const P = await gen(14, "pos"), P2 = await gen(13, "pos2");
    const N = { real: await gen(12, "real"), otherError: await gen(11, "err"), running: await gen(10, "run"), crossTenant: await gen(9, "xt"),
      otherDay: await gen(8, "day"), reuse: await gen(7, "reuse"), fresh: await gen(6, "fresh"), otherJob: await gen(5, "job"),
      bound: await gen(4, "bound"), lifecycle: await gen(3, "life"), snapshot: await gen(2, "snap", true) };
    await gen(1, "later");
    const pChildren = [await child(P, day(14)), await child(P, day(14), { started_at: clock(day(14), 15), finished_at: clock(day(14), 15, 1),
      created_at: clock(day(14), 15, 1), updated_at: clock(day(14), 15, 1) })].sort();
    await child(P2, day(13)); await child(P2, day(13), { started_at: clock(day(13), 15), finished_at: clock(day(13), 15, 1) });
    await child(N.real, day(12), { status: "success", row_count: 3, error_message: null });
    await child(N.otherError, day(11), { error_message: "standing_mode_unreadable" });
    await child(N.running, day(10), { status: "running", finished_at: null, row_count: null, error_message: null, duration_ms: null });
    await child(N.crossTenant, day(9), { business_ref_id: other.business, business_id: other.business });
    await child(N.otherDay, day(8), { as_of_date: day(7) });
    // Reuse metadata on the CHILD itself (naming an unrelated run, so the census reuse class of the original stays 0).
    await child(N.reuse, day(7), { error_json: { metadata: { reused_job_run_id: randomUUID() } } });
    const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
    await child(N.fresh, day(6), { started_at: iso(now - 61_000), finished_at: iso(now - 60_000), created_at: iso(now - 60_000), updated_at: iso(now - 60_000) });
    await child(N.otherJob, day(5), { job_name: "engine_v3_native_ad_operator_response_shadow_job" });
    for (let i = 0; i < 9; i++) await child(N.bound, day(4), { started_at: clock(day(4), 5, i), finished_at: clock(day(4), 5, i + 1) });
    await child(N.lifecycle, day(3));
    await db.query(`INSERT INTO public.engine_v3_creative_lifecycle_daily (business_ref_id,business_id,creative_id,as_of_date,engine_version,job_run_id)
      VALUES ($1::uuid,$2::text,'nsb_tnoop_lifecycle',$3::date,$4,$5::uuid)`, [t.business, t.business, day(3), NATIVE_AD_ENGINE_VERSION, N.lifecycle.jobRunId]);
    await child(N.snapshot, day(2));

    const generation = (g: { jobRunId: string }, n: number) => ({ businessId: t.business, jobRunId: g.jobRunId, asOfDate: day(n), engineVersion: NATIVE_AD_ENGINE_VERSION });
    const freeze = async (g: { jobRunId: string; evaluations: number; contexts: number }, n: number) => {
      const ro = await connect();
      try { return await collectWholeOriginal(ro, { generation: generation(g, n), expectedEvaluations: g.evaluations, expectedContexts: g.contexts,
        sourceRevision: head, consumerInventorySha256: pack.sourceManifestSha256 }); }
      finally { await ro.end(); }
    };
    const dependentBytes = async (jobRunId: string) => (await db.query(`SELECT id::text id,to_jsonb(j)::text bytes FROM public.engine_v3_job_runs j
      WHERE dependency_run_id=$1::uuid AND id<>$1::uuid ORDER BY id`, [jobRunId])).rows as { id: string; bytes: string }[];
    await db.query("SET timezone='UTC'");

    step = "positive-freeze";
    const frozen = await freeze(P, 14);
    const before = await dependentBytes(P.jobRunId);
    checks.positiveFreeze = { evaluations: frozen.config.evaluations, contexts: frozen.config.contexts, retainedDependents: frozen.config.retainedDependents,
      dependentsAreTheSeededChildren: JSON.stringify(frozen.config.retainedDependents.jobIds) === JSON.stringify(pChildren),
      dependentBytesFrozen: frozen.config.retainedDependents.rowByteSetSha256 === rowSetHash(before.map(r => r.bytes)),
      parentJobRetainedInRoots: frozen.config.jobIds.includes(P.jobRunId) };
    assert.deepEqual([checks.positiveFreeze].map((x: any) => [x.retainedDependents.rows, x.dependentsAreTheSeededChildren, x.dependentBytesFrozen, x.parentJobRetainedInRoots]), [[2, true, true, true]]);

    step = "positive-copies-and-full-restore";
    const key = randomBytes(32), archiveRoot = join(STATE, "archive"), copyDirectory = join(STATE, "copy");
    await mkdir(archiveRoot, { recursive: true, mode: 0o700 }); await mkdir(copyDirectory, { recursive: true, mode: 0o700 });
    const metadata = await sealAndPersist(frozen, `tnoop-${hex}`, key, archiveRoot, copyDirectory);
    const whole = await verifyCopies(metadata, key, archiveRoot, copyDirectory);
    const restoreDb = `nsb_restore_${hex}_00`;
    psql(pg, `CREATE DATABASE "${restoreDb}" TEMPLATE "${tplDb}"`);
    const rdb = await connect(restoreDb);
    let restored;
    try { restored = await restoreIntoOwnedNewDatabase(rdb, whole, frozen.config); } finally { await rdb.end(); }
    psql(pg, `DROP DATABASE "${restoreDb}"`);
    checks.positiveRestore = { frozenProofParity: restored.frozenProofParity, plaintextRestoreDropped: psql(pg, `SELECT count(*) FROM pg_database WHERE datname='${restoreDb}'`) === "0" };
    assert.deepEqual(checks.positiveRestore, { frozenProofParity: true, plaintextRestoreDropped: true });

    step = "positive-fresh-recensus";
    const pinsClient = await connect();
    try { checks.positivePins = await readSelectedPinClosure(pinsClient, frozen.config); } finally { await pinsClient.end(); }
    assert.equal((checks.positivePins as any).selectedPinClosureMatches, true);

    step = "post-freeze-change";
    // P2 frozen, then its dependents change: fresh recensus and the retirement transaction both refuse.
    const frozen2 = await freeze(P2, 13);
    const pins2 = async () => { const c = await connect(); try { return await readSelectedPinClosure(c, frozen2.config); } finally { await c.end(); } };
    const retire2 = async () => { const c = await connect(); try { return await refusal(() => prepareUnitRetirement(c, frozen2.config, frozen2.proofSha256, unitLockKey(P2.jobRunId),
      producerExclusionKey(frozen2.config.generation))); } finally { await c.end(); } };
    const extra = await child(P2, day(13), { started_at: clock(day(13), 20), finished_at: clock(day(13), 20, 1) });
    const added = { pins: await pins2(), retire: await retire2() };
    await db.query("DELETE FROM public.engine_v3_job_runs WHERE id=$1::uuid", [extra]);
    const reverted = await pins2();
    await db.query("UPDATE public.engine_v3_job_runs SET duration_ms=duration_ms+1 WHERE dependency_run_id=$1::uuid AND id<>$1::uuid AND started_at=$2::timestamptz", [P2.jobRunId, clock(day(13), 5)]);
    const changed = { pins: await pins2(), retire: await retire2() };
    checks.postFreezeChange = { added, reverted, changed };
    assert.deepEqual([added.pins.selectedPinClosureMatches, added.pins.recensusRefusal, added.retire, reverted.selectedPinClosureMatches,
      changed.pins.selectedPinClosureMatches, changed.pins.recensusRefusal, changed.retire],
    [false, "RETAINED_TERMINAL_NOOP_DEPENDENTS_CHANGED", "EXACT_RETAINED_TERMINAL_NOOP_DEPENDENTS", true,
      false, "RETAINED_TERMINAL_NOOP_DEPENDENTS_CHANGED", "RETAINED_TERMINAL_NOOP_DEPENDENT_BYTES"]);

    step = "unsafe-dependencies-refuse";
    const unsafe: Record<string, string> = {};
    for (const [name, g, n] of [["realProjection", N.real, 12], ["otherError", N.otherError, 11], ["running", N.running, 10],
      ["crossTenant", N.crossTenant, 9], ["otherDay", N.otherDay, 8], ["reuseMetadata", N.reuse, 7], ["fresh", N.fresh, 6],
      ["otherJobName", N.otherJob, 5], ["overBound", N.bound, 4], ["otherDependencyFkClass", N.lifecycle, 3],
      ["realSnapshotPinWithNoopChild", N.snapshot, 2]] as const) unsafe[name] = await refusal(() => freeze(g, n));
    checks.unsafe = unsafe;
    const q = "RETAINED_PIN_VETO:job_dependencies:unqualified_dependent";
    assert.deepEqual(unsafe, { realProjection: q, otherError: q, running: q, crossTenant: q, otherDay: q, reuseMetadata: q, fresh: q, otherJobName: q,
      overBound: "RETAINED_PIN_VETO:job_dependencies:bound", otherDependencyFkClass: "RETAINED_PIN_VETO:job_dependencies:foreign_edge",
      realSnapshotPinWithNoopChild: "RETAINED_SNAPSHOT_VETO" });

    step = "positive-retire";
    const w = await connect();
    let committed = false;
    try {
      const prepared = await prepareUnitRetirement(w, frozen.config, frozen.proofSha256, unitLockKey(P.jobRunId), producerExclusionKey(frozen.config.generation));
      acceptPrepared(prepared, frozen.config);
      committed = (await w.query("COMMIT")).command === "COMMIT";
      await releaseProducerExclusion(w, prepared.producerExclusion);
      checks.positiveRetire = { committed, retainedDependents: prepared.retainedDependents };
    } finally { if (!committed) await w.query("ROLLBACK").catch(() => undefined); await w.end(); }
    assert.equal(committed, true);

    step = "positive-independent-readback";
    const r = await connect();
    let back;
    try { back = await independentReadback(r, frozen.config); } finally { await r.end(); }
    const after = await dependentBytes(P.jobRunId);
    const parent = (await db.query("SELECT count(*)::int n FROM public.engine_v3_job_runs WHERE id=$1::uuid", [P.jobRunId])).rows[0].n;
    checks.positiveReadback = { exactUnitAbsent: back.exactUnitAbsent, retainedRootsFullBytesMatch: back.retainedRootsFullBytesMatch,
      retainedTerminalNoopDependentsMatch: back.retainedTerminalNoopDependentsMatch,
      childrenExactBytesUnchanged: JSON.stringify(after) === JSON.stringify(before), parentJobRowRetained: parent === 1 };
    assert.deepEqual(checks.positiveReadback, { exactUnitAbsent: true, retainedRootsFullBytesMatch: true, retainedTerminalNoopDependentsMatch: true,
      childrenExactBytesUnchanged: true, parentJobRowRetained: true });
  } finally { await db.end(); }
  return pg;
}

(async () => {
  let pg: { data: string } | undefined, failure: unknown = null;
  try { pg = await main(); } catch (e) { failure = e; }
  const data = pg?.data ?? join(STATE, "pg", "data");
  spawnSync(`${PG}/pg_ctl`, ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore", env: PG_ENV });
  const stopped = spawnSync(`${PG}/pg_ctl`, ["-D", data, "status"], { stdio: "ignore", env: PG_ENV }).status;
  const confirmed = stopped === 3 || stopped === 4;
  if (confirmed && STATE.startsWith(`${PRIVATE_BASE}/nsb-tnoop-`) && /^[a-f0-9]{12}$/.test(hex)) await rm(STATE, { recursive: true, force: true });
  const receipt = { contract: "native-terminal-noop-dependents-owned-real-pg.v1", stateRoot: "$STATE", stateRootRemoved: confirmed, clusterStopStatus: stopped,
    actualExitCode: failure ? 1 : 0, failedStep: failure ? step : null,
    failure: failure ? { ...safeError(failure), message: String((failure as Error)?.message ?? failure).slice(0, 400) } : null,
    checks, productionAccess: false, fixtureScope: "Owned PG16, full run-migrations schema, actual producer seeds; not production data." };
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  await writeExclusive(join(OUT, `terminal-noop-pg-receipt-${hex}.json`), JSON.stringify(receipt, null, 2), 0o400);
  process.stdout.write(`${JSON.stringify({ actualExitCode: receipt.actualExitCode, receipt: `terminal-noop-pg-receipt-${hex}.json`, failedStep: receipt.failedStep, failure: receipt.failure })}\n`);
  setTimeout(() => process.exit(receipt.actualExitCode), 200);
})();
