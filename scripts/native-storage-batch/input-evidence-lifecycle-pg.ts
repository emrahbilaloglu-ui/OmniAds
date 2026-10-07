import assert from "node:assert/strict";
import { execFileSync, spawn, spawnSync } from "node:child_process";
import { randomBytes } from "node:crypto";
import { appendFile, mkdir, readFile, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { Client } from "pg";
import type { DbClient } from "../../lib/db";
import { adDecisionsJobAdvisoryLockKey, runAdDecisionsJob } from "../../lib/creative-decision-engine/jobs/ad-decisions-job";
import { openNativeHistoricalArchiveEvidence, type NativeHistoricalArchiveContentTrust } from "../../lib/creative-decision-engine/native-historical-archive";
import { NATIVE_STORAGE_BATCH_CONTRACT, runFiniteNativeStorageBatch, validateNativeStorageBatchPlan,
  type NativeStorageBatchPlan } from "../../lib/creative-decision-engine/native-finite-storage-lifecycle";
import { validateNativeRetainedReaderLedger } from "../../lib/creative-decision-engine/native-retained-reader-lifecycle";
import { nativeRetainedReaderSources } from "../native-retained-reader-lifecycle-guard";
import { collectWholeOriginal, sealAndPersist, verifyCopies, type UnitConfig } from "./capture";
import { retireOnceWithParentChallenge, prepareUnitRetirement } from "./retire";
import { independentReadback, readSelectedPinClosure, spaceReadback, vacuumComponent, observeTargetToast } from "./maintenance";
import { collectMaintenanceSettlement, verifyMaintenanceSettlement } from "./maintenance-settlement";
import { restoreIntoOwnedNewDatabase } from "./restore";
import { databaseUrl, unitLockKey } from "./backend";
import { computeSourcePack, REPO_ROOT, TSX_LOADER } from "./source-pack";
import { CONTEXT, EVAL, INPUT, UNIT_TABLES, canonicalSha, safeError, sha256, writeExclusive } from "./common";
import { addObservedProductionReferenceIndex, seedCalibration, seedGeneration, seedTenant, type OwnedTenant } from "./owned-fixture";
import { ZERO_REFERENCE_SQL, advisoryLockParts, producerExclusionKey, readReferenceIndexes } from "./input-evidence-lifecycle";
import { ACTOR_FILE } from "./production-transport";
import { pythonOutcomes, tsOutcome, type ParityCase } from "./__tests__/d150-parent-parity-cases";

/** OWNED REAL-PG GUARD (fixture only; never imported by the executor). D150 v3
 * zero-live-reference input-evidence lifecycle on a NEW random socket-only PG16
 * cluster, the ACTUAL run-migrations full DDL plus ONE labeled added
 * real-production index prerequisite (owned-fixture.ts), generations written by
 * the ACTUAL producer writer, the ACTUAL producer job (runAdDecisionsJob) for the
 * lock races, and the actual capture/copies/restore/pins/retire/readback/
 * maintenance/settlement code. Fixture scale only: no production scale,
 * performance, reclaim or closure claim. NSB_CIE_SCENARIOS limits scenarios
 * (mutation runs). */
const PG = "/opt/homebrew/opt/postgresql@16/bin";
const PG_ENV: NodeJS.ProcessEnv = { NODE_ENV: "production", PATH: process.env.PATH ?? "/usr/bin:/bin", LC_ALL: "C" };
const OUT = process.env.NSB_RESULT_DIR ?? "";
const ONLY = (process.env.NSB_CIE_SCENARIOS ?? "").split(",").filter(Boolean);
const PRIVATE_BASE = "/Users/harmelek/.codex/private";
const hex = randomBytes(6).toString("hex"), STATE = `${PRIVATE_BASE}/nsb-cie-${hex}`;
const APP = "cie-harness";
const checks: Record<string, any> = {};
let step = "init";
const today = new Date().toISOString().slice(0, 10);
const day = (n: number) => new Date(Date.parse(`${today}T00:00:00Z`) - n * 86_400_000).toISOString().slice(0, 10);
const two = (n: number) => String(n).padStart(2, "0");
const clock = (d: string, h: number) => `${d}T${two(h)}:00:00.000001Z`;
const refusal = async (fn: () => Promise<unknown>) => { try { await fn(); return "NO_REFUSAL"; } catch (e) { return safeError(e).code; } };
const wanted = (name: string) => ONLY.length === 0 || ONLY.includes(name);
type Key = [string, string];

async function cluster(port: number) {
  const data = join(STATE, "pg", "data"), sock = join(STATE, "pg", "sock");
  await mkdir(sock, { recursive: true, mode: 0o700 });
  execFileSync(`${PG}/initdb`, ["-D", data, "-U", "nsb_owner", "--auth=trust", "--encoding=UTF8", "--locale=C", "--no-instructions"], { stdio: "ignore", env: PG_ENV });
  // enable_seqscan=off: tiny owned tables; same setting as every owned batch harness (capture's EXPLAIN hot-table veto).
  await appendFile(join(data, "postgresql.conf"), `\nlisten_addresses = ''\nunix_socket_directories = '${sock}'\nunix_socket_permissions = 0700\nport = ${port}\nenable_seqscan = off\n`);
  execFileSync(`${PG}/pg_ctl`, ["-D", data, "-l", join(STATE, "pg", "log"), "-w", "-t", "60", "start"], { stdio: "ignore", env: PG_ENV });
  return { data, sock, port };
}
type Cluster = Awaited<ReturnType<typeof cluster>>;
const psql = (c: Cluster, sql: string) =>
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
  const pg = await cluster(24000 + randomBytes(2).readUInt16BE() % 5000);
  const srcTpl = `nsb_srctpl_${hex}`, rstTpl = `nsb_restore_${hex}`;
  for (const name of [srcTpl, rstTpl]) psql(pg, `CREATE DATABASE ${name} TEMPLATE template0 ENCODING 'UTF8' LC_COLLATE 'C' LC_CTYPE 'C'`);
  assert.deepEqual(await Promise.all([srcTpl, rstTpl].map(n => migrate(databaseUrl("nsb_owner", pg.sock, pg.port, n)))), [0, 0], "actual run-migrations full DDL");
  const connect = async (database: string, options?: string) => {
    const c = new Client({ host: pg.sock, port: pg.port, user: "nsb_owner", database, application_name: APP, ...(options ? { options } : {}) });
    c.on("error", () => undefined); await c.connect(); return c;
  };
  {
    const tpl = await connect(srcTpl);
    try {
      const read = (s: string, v?: unknown[]) => tpl.query(s, v);
      const before = (await readReferenceIndexes(read)).map(i => i.name);
      const added = await addObservedProductionReferenceIndex(tpl);
      checks.indexPrerequisite = { runMigrationsAloneQualifyingIndexes: before, added, afterAdd: (await readReferenceIndexes(read)).map(i => i.name),
        label: "ADDED real-production index prerequisite (observed PG16 production catalog); NOT created by run-migrations" };
      assert.deepEqual([before, checks.indexPrerequisite.afterAdd], [[], ["idx_engine_v3_ad_evaluations_contract_input"]]);
    } finally { await tpl.end(); }
  }
  const flags = (businessId: string) => ({ businessId, enabled: true, surfaceVisible: false, shadowOnly: true, presetOverride: null,
    source: { enabled: "env", surfaceVisible: "env", shadowOnly: "env", presetOverride: null }, envDefaults: { enabled: true, surfaceVisible: false, shadowOnly: true } }) as never;
  let worlds = 0;

  /** A fresh source database from the migrated+index template, seeded through the actual producer writer. */
  async function world(label: string) {
    const name = `nsb_source_${hex}_${two(worlds++)}`;
    psql(pg, `CREATE DATABASE "${name}" TEMPLATE "${srcTpl}"`);
    const db = await connect(name);
    await db.query("SET timezone='UTC'");
    const t = await seedTenant(db, 2), f = await seedTenant(db, 1);
    const cal = { t14: await seedCalibration(db, t, day(14), clock(day(14), 1)), t1: await seedCalibration(db, t, day(1), clock(day(1), 1)),
      f14: await seedCalibration(db, f, day(14), clock(day(14), 1)), f1: await seedCalibration(db, f, day(1), clock(day(1), 1)) };
    // G2: an unchanged same-day rerun (same tag/date/clock) -> the actual producer shares exactly one input key with G1.
    const G1 = await seedGeneration(db, t, { date: day(14), clock: clock(day(14), 1), finishedAt: clock(day(14), 2), producer: cal.t14, perAccount: [2, 1], tag: "sh" });
    const G2 = await seedGeneration(db, t, { date: day(14), clock: clock(day(14), 1), finishedAt: clock(day(14), 3), producer: cal.t14, perAccount: [1, 0], tag: "sh" });
    const later = await seedGeneration(db, t, { date: day(1), clock: clock(day(1), 1), finishedAt: clock(day(1), 2), producer: cal.t1, perAccount: [1, 0], tag: "later" });
    const F1 = await seedGeneration(db, f, { date: day(14), clock: clock(day(14), 1), finishedAt: clock(day(14), 2), producer: cal.f14, perAccount: [2], tag: "fx" });
    await seedGeneration(db, f, { date: day(1), clock: clock(day(1), 1), finishedAt: clock(day(1), 2), producer: cal.f1, perAccount: [1], tag: "fl" });
    const generation = { businessId: t.business, jobRunId: G1.jobRunId, asOfDate: day(14),
      engineVersion: (await db.query("SELECT engine_version v FROM public.engine_v3_job_runs WHERE id=$1::uuid", [G1.jobRunId])).rows[0].v as string };
    const keysOf = async (jobRunId: string) => (await db.query(`SELECT DISTINCT contract_version cv,input_hash::text ih FROM public.${EVAL} WHERE job_run_id=$1::uuid ORDER BY 1,2`,
      [jobRunId])).rows.map((r: any) => [r.cv, r.ih] as Key);
    const g1Keys = await keysOf(G1.jobRunId), g2Ids = new Set((await keysOf(G2.jobRunId)).map(k => JSON.stringify(k)));
    const shared = g1Keys.filter(k => g2Ids.has(JSON.stringify(k))), zero = g1Keys.filter(k => !g2Ids.has(JSON.stringify(k)));
    assert(shared.length === 1 && zero.length === 2, `${label}: actual producer shared-key shape`);
    const producerJobs: string[] = [];
    return { label, name, db, t, f, G1, G2, later, F1, generation, shared, zero, producerJobs, connect: (o?: string) => connect(name, o) };
  }
  type World = Awaited<ReturnType<typeof world>>;
  const freeze = async (w: World) => {
    const ro = await w.connect();
    try { return await collectWholeOriginal(ro, { generation: w.generation, expectedEvaluations: w.G1.evaluations, expectedContexts: w.G1.contexts,
      sourceRevision: head, consumerInventorySha256: pack.sourceManifestSha256 }); }
    finally { await ro.end(); }
  };
  /** Every row of every unit table, by table (full JSONB bytes). */
  const state = async (w: World) => {
    const out: Record<string, string[]> = {};
    for (const table of UNIT_TABLES) out[table] = (await w.db.query(`SELECT to_jsonb(t)::text b FROM public.${table} t`)).rows.map((r: any) => r.b as string).sort();
    return out;
  };
  const diff = (a: Record<string, string[]>, b: Record<string, string[]>) => Object.fromEntries(UNIT_TABLES.map(t => {
    const x = new Set(a[t]), y = new Set(b[t]);
    return [t, { removed: a[t]!.filter(v => !y.has(v)), added: b[t]!.filter(v => !x.has(v)) }];
  })) as Record<string, { removed: string[]; added: string[] }>;
  /** Only the producer's own skip/failure receipts may appear; nothing else changes. */
  const unchangedExceptProducerReceipts = (w: World, d: ReturnType<typeof diff>) => UNIT_TABLES.every(t => d[t]!.removed.length === 0 &&
    d[t]!.added.every(v => t === "engine_v3_job_runs" && w.producerJobs.includes(JSON.parse(v).id)));
  const lockHolders = async (w: World) => {
    const { classid, objid } = advisoryLockParts(producerExclusionKey(w.generation)), c = await w.connect();
    try { return (await c.query(`SELECT pid,granted,mode FROM pg_locks WHERE locktype='advisory' AND classid=$1::oid AND objid=$2::oid AND objsubid=1 ORDER BY pid`,
      [classid, objid])).rows as { pid: number; granted: boolean; mode: string }[]; } finally { await c.end(); }
  };
  const backendGone = async (w: World, pid: number) => {
    const c = await w.connect();
    try { for (let i = 0; i < 50; i++) { if ((await c.query("SELECT count(*)::int n FROM pg_stat_activity WHERE pid=$1", [pid])).rows[0].n === 0) return true;
      await new Promise(r => setTimeout(r, 100)); } return false; } finally { await c.end(); }
  };
  /** The ACTUAL native producer job for (business, asOf). Its only substitution is the
   * transport: after its own pg_try_advisory_xact_lock statement, an ACQUIRED lock is
   * held at `whileHolding` (if given) and the job is then stopped before any decision
   * work; a refused lock lets it run its real skip path to completion. */
  const actualProducer = async (w: World, whileHolding?: (pid: number) => Promise<void>) => {
    const c = await w.connect(); let acquired: boolean | null = null;
    const pid = (await c.query("SELECT pg_backend_pid() p")).rows[0].p as number;
    const adapter = { query: async (sql: string, values?: unknown[]) => {
      const rows = (await c.query(sql, values)).rows;
      if (/pg_try_advisory_xact_lock/.test(sql)) {
        acquired = rows[0]?.acquired === true;
        if (acquired) { if (whileHolding) await whileHolding(pid); throw new Error("HARNESS_STOPPED_PRODUCER_AFTER_ACQUIRED_LOCK"); }
      }
      return rows;
    } } as unknown as DbClient;
    const tx = async <T>(fn: () => Promise<T>) => { await c.query("BEGIN"); try { const r = await fn(); await c.query("COMMIT"); return r; }
      catch (e) { await c.query("ROLLBACK"); throw e; } };
    try {
      const result = await runAdDecisionsJob({ businessId: w.t.business, asOf: day(14) }, { db: adapter, transaction: tx,
        businessGuard: async () => null, resolveFlags: async () => flags(w.t.business) });
      if (result.jobRunId) w.producerJobs.push(result.jobRunId);
      return { acquired, status: result.status, message: (result as { errorMessage?: string }).errorMessage ?? null };
    } finally { await c.end(); }
  };
  /** The retirement client, optionally intercepting the instant before its RR transaction is opened. */
  const retireClient = async (w: World, beforeBegin?: () => Promise<void>, options?: string) => {
    const c = await w.connect(options); let fired = false;
    const pid = (await c.query("SELECT pg_backend_pid() p")).rows[0].p as number;
    return { pid, client: { query: async (sql: string, values?: unknown[]) => {
      if (beforeBegin && !fired && sql === "BEGIN ISOLATION LEVEL REPEATABLE READ READ WRITE") { fired = true; await beforeBegin(); }
      return c.query(sql, values);
    }, end: () => c.end() } };
  };
  const challenge = (frozen: { proofSha256: string }, line: any) => ({ action: "COMMIT_EXACT_UNIT_ONCE", preparedSha256: line.preparedSha256,
    challengeNonce: line.challengeNonce, proofSha256: frozen.proofSha256 });
  const request = (frozen: Awaited<ReturnType<typeof freeze>>) => ({ config: frozen.config, proofSha256: frozen.proofSha256,
    unitLockKey: unitLockKey(frozen.config.generation.jobRunId), producerLockKey: producerExclusionKey(frozen.config.generation) });
  const evidenceBytes = async (w: World, keys: Key[]) => Object.fromEntries((await w.db.query(`SELECT contract_version cv,input_hash::text ih,to_jsonb(t)::text b
    FROM public.${INPUT} t JOIN unnest($1::text[],$2::character(64)[]) k(c,h) ON t.contract_version=k.c AND t.input_hash=k.h`,
  [keys.map(k => k[0]), keys.map(k => k[1])])).rows.map((r: any) => [JSON.stringify([r.cv, r.ih]), r.b as string]));
  const globalDangling = async (w: World) => (await w.db.query(`SELECT count(*)::int n FROM public.${EVAL} e WHERE NOT EXISTS
    (SELECT 1 FROM public.${INPUT} i WHERE i.contract_version=e.contract_version AND i.input_hash=e.input_hash)`)).rows[0].n as number;
  const close = async (w: World) => { await w.db.end(); };

  try {
    // ---------------- S1: GREEN full lifecycle ----------------
    if (wanted("green")) {
      step = "green-seed"; const w = await world("green");
      try {
        const frozen = await freeze(w);
        checks.greenFreeze = { unitConfigContract: frozen.config.contract, lifecycle: frozen.config.inputEvidence?.lifecycle,
          frozenKeys: frozen.config.inputKeys.length, perKeyRowSha: frozen.config.inputEvidence?.rowSha256.length };
        assert.deepEqual([checks.greenFreeze.unitConfigContract, checks.greenFreeze.frozenKeys, checks.greenFreeze.perKeyRowSha], ["finite-native-storage-unit-config.v2", 3, 3]);
        step = "green-two-encrypted-copies-and-restore";
        const key = randomBytes(32), archiveRoot = join(STATE, `archive-${w.name}`), copyDirectory = join(STATE, `copy-${w.name}`);
        await mkdir(archiveRoot, { recursive: true, mode: 0o700 }); await mkdir(copyDirectory, { recursive: true, mode: 0o700 });
        const metadata = await sealAndPersist(frozen, `cie-${hex}`, key, archiveRoot, copyDirectory);
        const whole = await verifyCopies(metadata, key, archiveRoot, copyDirectory);
        const restoreDb = `nsb_restore_${hex}_${two(worlds)}`;
        psql(pg, `CREATE DATABASE "${restoreDb}" TEMPLATE "${rstTpl}"`);
        const rdb = await connect(restoreDb); let restored;
        try { restored = await restoreIntoOwnedNewDatabase(rdb, whole, frozen.config); } finally { await rdb.end(); }
        psql(pg, `DROP DATABASE "${restoreDb}"`);
        checks.greenCopiesRestore = { parts: metadata.parts.length, frozenProofParity: restored.frozenProofParity,
          inputEvidenceRestoredFullBytes: JSON.stringify(restored.tableHashes[INPUT]) === JSON.stringify(frozen.config.tableHashes[INPUT]) };
        assert.deepEqual([checks.greenCopiesRestore.frozenProofParity, checks.greenCopiesRestore.inputEvidenceRestoredFullBytes], [true, true]);
        const pc = await w.connect();
        try { checks.greenPins = (await readSelectedPinClosure(pc, frozen.config)).selectedPinClosureMatches; } finally { await pc.end(); }
        assert.equal(checks.greenPins, true);

        step = "green-retire";
        const allKeys = frozen.config.inputKeys as Key[], originalEvidence = await evidenceBytes(w, allKeys);
        const originalEvaluations = Object.fromEntries((await w.db.query(`SELECT id::text id,to_jsonb(e)::text b FROM public.${EVAL} e WHERE job_run_id=$1::uuid`,
          [w.G1.jobRunId])).rows.map((r: any) => [r.id, r.b]));
        const before = await state(w);
        const interval: Record<string, unknown> = {};
        const rc = await retireClient(w, async () => {
          // Immediately before the RR transaction exists: the session exclusion is already held, so the actual producer skips.
          interval.beforeBegin = { holders: await lockHolders(w), producer: await actualProducer(w) };
        });
        const result = await retireOnceWithParentChallenge(rc.client, request(frozen), async line => {
          const p = (line as any).prepared;
          interval.prepared = { indexesUsed: p.inputEvidence.indexesUsed, deleted: p.inputEvidence.deleted.keys, shared: p.inputEvidence.retainedShared.keys,
            danglingAfterDelete: p.inputEvidence.danglingAfterDelete, pidMatches: p.producerExclusion.pid === rc.pid,
            acquiredBeforeTransaction: p.producerExclusion.acquiredBeforeTransaction };
          // The production actor's own Python prepared_gate on THIS real prepared line (and three single-field tamperings).
          const real = (f?: (x: any) => void): ParityCase => { const copy = structuredClone(p); f?.(copy);
            return { prepared: copy, config: frozen.config, producerLockKey: producerExclusionKey(frozen.config.generation), ts: "", py: "" }; };
          const actorCases = { realValid: real(), realWrongDeletedKeyedDigest: real(x => { x.inputEvidence.deleted.keyedSha256 = "0".repeat(64); }),
            realWrongSharedKeyedDigest: real(x => { x.inputEvidence.retainedShared.keyedSha256 = "0".repeat(64); }),
            realUnverifiedReferenceIndex: real(x => { x.inputEvidence.indexesUsed = ["engine_v3_ad_evaluations_pkey"]; }) };
          interval.actorParity = { python: pythonOutcomes(ACTOR_FILE, actorCases).cases,
            ts: Object.fromEntries(Object.entries(actorCases).map(([n, c]) => [n, tsOutcome(c)])),
            preparedSha256Matches: (line as any).preparedSha256 === sha256(JSON.stringify(p)) };
          // Parent prepare->commit interval: exclusion held by the retiring backend; an arriving actual producer skips.
          interval.parentInterval = { holders: await lockHolders(w), producer: await actualProducer(w) };
          return challenge(frozen, line);
        });
        interval.result = result;
        interval.afterRelease = { holders: await lockHolders(w), retireBackendGone: await backendGone(w, rc.pid) };
        const after = await state(w), d = diff(before, after);
        const g1Rows = Object.values(originalEvaluations);
        checks.green = { interval,
          evaluationsRemovedExactlyG1: d[EVAL]!.removed.length === g1Rows.length && d[EVAL]!.removed.every(v => g1Rows.includes(v)) && d[EVAL]!.added.length === 0,
          contextsRemoved: d[CONTEXT]!.removed.length, contextsAdded: d[CONTEXT]!.added.length,
          inputRemovedExactlyZeroRef: JSON.stringify(d[INPUT]!.removed.sort()) === JSON.stringify(w.zero.map(k => originalEvidence[JSON.stringify(k)]).sort()) && d[INPUT]!.added.length === 0,
          sharedKeyByteIdentical: (await evidenceBytes(w, w.shared))[JSON.stringify(w.shared[0])] === originalEvidence[JSON.stringify(w.shared[0])],
          otherTablesAndForeignTenantUnchanged: UNIT_TABLES.filter(t => ![EVAL, CONTEXT, INPUT].includes(t as never)).every(t =>
            d[t]!.removed.length === 0 && d[t]!.added.every(v => t === "engine_v3_job_runs" && w.producerJobs.includes(JSON.parse(v).id) && JSON.parse(v).status === "skipped")),
          producerSkipReceipts: w.producerJobs.length, globalDanglingEvaluations: await globalDangling(w) };
        const g = checks.green;
        assert.deepEqual([g.evaluationsRemovedExactlyG1, g.contextsRemoved, g.contextsAdded, g.inputRemovedExactlyZeroRef, g.sharedKeyByteIdentical,
          g.otherTablesAndForeignTenantUnchanged, g.producerSkipReceipts, g.globalDanglingEvaluations],
        [true, w.G1.contexts, 0, true, true, true, 2, 0]);
        const ib = interval.beforeBegin as any, pi = interval.parentInterval as any, pr = interval.prepared as any, ar = interval.afterRelease as any;
        assert.deepEqual([ib.holders.map((h: any) => h.pid), ib.producer.acquired, ib.producer.status], [[rc.pid], false, "skipped"], "pre-RR exclusion visible to the actual producer");
        assert.deepEqual([pi.holders.map((h: any) => h.pid), pi.producer.acquired, pi.producer.status], [[rc.pid], false, "skipped"], "prepare->commit exclusion");
        assert.deepEqual([pr.indexesUsed, pr.deleted, pr.shared, pr.danglingAfterDelete, pr.pidMatches, pr.acquiredBeforeTransaction],
          [["idx_engine_v3_ad_evaluations_contract_input"], 2, 1, 0, true, true]);
        assert.deepEqual([result.committed, result.producerExclusionRelease, ar.holders, ar.retireBackendGone], [true, "unlocked", [], true]);
        assert.deepEqual(interval.actorParity, { python: { realValid: "COMMIT_EXACT_UNIT_ONCE", realWrongDeletedKeyedDigest: "PREPARED_INPUT_EVIDENCE_PARTITION",
          realWrongSharedKeyedDigest: "PREPARED_INPUT_EVIDENCE_PARTITION", realUnverifiedReferenceIndex: "PREPARED_INPUT_REFERENCE_PROOF" },
        ts: { realValid: "true", realWrongDeletedKeyedDigest: "PREPARED_INPUT_EVIDENCE_PARTITION", realWrongSharedKeyedDigest: "PREPARED_INPUT_EVIDENCE_PARTITION",
          realUnverifiedReferenceIndex: "PREPARED_INPUT_REFERENCE_PROOF" }, preparedSha256Matches: true }, "actor parity on the real prepared line");

        step = "green-producer-after-release";
        const free = await w.connect();
        try { await free.query("BEGIN"); checks.greenProducerLockAfterRelease = (await free.query("SELECT pg_try_advisory_xact_lock($1::bigint) a",
          [adDecisionsJobAdvisoryLockKey({ businessId: w.t.business, asOf: day(14) }).toString()])).rows[0].a; await free.query("ROLLBACK"); } finally { await free.end(); }
        assert.equal(checks.greenProducerLockAfterRelease, true);

        step = "green-independent-readback";
        const r = await w.connect(); let back;
        try { back = await independentReadback(r, frozen.config); } finally { await r.end(); }
        checks.greenReadback = { exactUnitAbsent: back.exactUnitAbsent, retainedRootsFullBytesMatch: back.retainedRootsFullBytesMatch, inputEvidence: back.inputEvidence };
        assert.deepEqual([back.exactUnitAbsent, back.retainedRootsFullBytesMatch, back.inputEvidence?.presentShared, back.inputEvidence?.absentRetired,
          back.inputEvidence?.danglingAbsent, back.inputEvidence?.presentUnreferenced, back.inputEvidence?.presentBytesMatch], [true, true, 1, 2, 0, 0, true]);

        step = "green-archived-reader-parity";
        const trusts: NativeHistoricalArchiveContentTrust[] = [];
        for (const name of (await readdir(copyDirectory)).filter(n => n.endsWith(".trust.json")))
          trusts.push(JSON.parse(await readFile(join(copyDirectory, name), "utf8")));
        const parity = [];
        for (const [evaluationId, bytes] of Object.entries(originalEvaluations)) {
          const row = JSON.parse(bytes as string), trust = trusts.find(x => x.segment?.evaluationIds.includes(evaluationId))!;
          const served = await readFile(join(archiveRoot, "native/v2", `${trust.ciphertextSha256}.bin`));
          const ev = openNativeHistoricalArchiveEvidence(served, trust, key, { generation: frozen.config.generation,
            providerAccountId: row.provider_account_id, adId: row.ad_id, evaluationId });
          parity.push({ evaluation: ev.rowJson.evaluation === bytes, inputEvidence: ev.rowJson.inputEvidence === originalEvidence[JSON.stringify([row.contract_version, row.input_hash])],
            keyRetired: w.zero.some(k => k[1] === row.input_hash) });
        }
        checks.greenArchivedReaderParity = parity;
        assert(parity.length === 3 && parity.every(p => p.evaluation && p.inputEvidence) && parity.filter(p => p.keyRetired).length === 2, "archived full-byte reader parity");

        step = "green-bounded-explain";
        const ex = await w.connect();
        try {
          const all = frozen.config.inputKeys as Key[];
          const plan = (await ex.query(`EXPLAIN (FORMAT JSON) ${ZERO_REFERENCE_SQL}`, [all.map(k => k[0]), all.map(k => k[1])])).rows[0]["QUERY PLAN"];
          const nodes: unknown[] = []; const walk = (n: any) => { nodes.push({ type: n["Node Type"], relation: n["Relation Name"] ?? null, index: n["Index Name"] ?? null,
            indexCond: n["Index Cond"] ?? null }); for (const c of n.Plans ?? []) walk(c); }; walk(plan[0].Plan);
          checks.greenExplain = { nodes, planner: "owned fixture, enable_seqscan=off; production costs differ and the runtime EXPLAIN guard refuses otherwise" };
        } finally { await ex.end(); }

        step = "green-ordinary-maintenance";
        const m = await w.connect(), notices: string[] = []; m.on("notice", n => notices.push(String(n.code)));
        try {
          const v = await vacuumComponent(m, "main", [w.G1.jobRunId], notices);
          const s = await spaceReadback(m), o = await observeTargetToast(m);
          checks.greenMaintenance = { vacuumAcknowledged: v.acknowledged, spaceRelations: s.relations.map((x: any) => x.relation).sort(),
            toastObservationRelations: o.relations.map(x => x.relation) };
        } finally { await m.end(); }
        assert.deepEqual([checks.greenMaintenance.vacuumAcknowledged, checks.greenMaintenance.spaceRelations, checks.greenMaintenance.toastObservationRelations.length],
          [true, [CONTEXT, EVAL, INPUT].sort(), 2]);

        step = "green-settlement";
        const now = Date.now(), iso = (ms: number) => new Date(ms).toISOString();
        const binding = (planContract: string) => ({ purpose: hex, planDigest: "a".repeat(64), planContract,
          unacknowledged: { stage: "vacuum-main", jobRunIds: [w.G1.jobRunId], sequence: 9 }, journalRecords: 11, journalHeadSha256: "b".repeat(64),
          journalFinishedAt: iso(now - 2000), markerSha256: "c".repeat(64), units: [{ jobRunId: w.G1.jobRunId, originalProofSha256: frozen.proofSha256 }],
          expectedDatabase: w.name, operatorRevision: head, runtimeRevision: head, sourceManifestSha256: pack.sourceManifestSha256 });
        const sc = await w.connect(); const settled: Record<string, unknown> = {};
        try {
          for (const contract of [NATIVE_STORAGE_BATCH_CONTRACT, "finite-native-storage-batch.v2"]) {
            const proof = await collectMaintenanceSettlement(sc, binding(contract), [frozen.config]);
            const verified = verifyMaintenanceSettlement(JSON.parse(JSON.stringify(proof)), binding(contract), Date.now());
            settled[contract] = { mainRelations: verified.targets.mainRelations, unitsReadback: verified.units };
          }
        } finally { await sc.end(); }
        checks.greenSettlement = settled;
        assert.deepEqual([(settled[NATIVE_STORAGE_BATCH_CONTRACT] as any).mainRelations, (settled["finite-native-storage-batch.v2"] as any).mainRelations], [3, 2]);
      } finally { await close(w); }
    }

    // ---------------- S2: actual second-session busy refusal ----------------
    if (wanted("busy")) {
      step = "busy"; const w = await world("busy");
      try {
        const frozen = await freeze(w);
        let observed: any = null;
        const producer = await actualProducer(w, async producerPid => {
          const before = await state(w), rc = await retireClient(w);
          const code = await refusal(() => retireOnceWithParentChallenge(rc.client, request(frozen), async line => challenge(frozen, line)));
          const after = await state(w);
          observed = { code, holders: (await lockHolders(w)).map(h => h.pid), producerPid, unchanged: unchangedExceptProducerReceipts(w, diff(before, after)),
            retireBackendGone: await backendGone(w, rc.pid) };
        });
        checks.busy = { observed, producer };
        assert.deepEqual([observed.code, observed.holders, observed.unchanged, observed.retireBackendGone, producer.acquired],
          ["PRODUCER_EXCLUSION_BUSY", [observed.producerPid], true, true, true]);
      } finally { await close(w); }
    }

    // ---------------- S3: session-lock cleanup (rollback / abort / client failure) ----------------
    if (wanted("cleanup")) {
      step = "cleanup"; const w = await world("cleanup");
      try {
        const frozen = await freeze(w), out: Record<string, unknown> = {};
        // Parent ROLLBACK (refused challenge).
        let before = await state(w); let rc = await retireClient(w);
        out.rollback = { code: await refusal(() => retireOnceWithParentChallenge(rc.client, request(frozen), async line => ({ ...challenge(frozen, line), challengeNonce: "0".repeat(32) }))) };
        Object.assign(out.rollback as object, { holders: await lockHolders(w), unchanged: unchangedExceptProducerReceipts(w, diff(before, await state(w))), backendGone: await backendGone(w, rc.pid) });
        // Client failure inside the prepare->commit interval: the retiring backend is terminated before COMMIT.
        before = await state(w); rc = await retireClient(w);
        const admin = await w.connect();
        try {
          out.clientFailure = { code: await refusal(() => retireOnceWithParentChallenge(rc.client, request(frozen), async line => {
            await admin.query("SELECT pg_terminate_backend($1)", [rc.pid]); return challenge(frozen, line); })) };
        } finally { await admin.end(); }
        Object.assign(out.clientFailure as object, { holders: await lockHolders(w), unchanged: unchangedExceptProducerReceipts(w, diff(before, await state(w))), backendGone: await backendGone(w, rc.pid) });
        // Abort inside preparation after the exclusion was taken (frozen input bytes drifted): prepare's own ROLLBACK + unlock.
        await w.db.query(`UPDATE public.${INPUT} SET updated_at=updated_at+interval '1 microsecond' WHERE contract_version=$1 AND input_hash=$2`, w.zero[0]);
        before = await state(w); rc = await retireClient(w);
        out.abort = { code: await refusal(() => retireOnceWithParentChallenge(rc.client, request(frozen), async line => challenge(frozen, line))) };
        Object.assign(out.abort as object, { holders: await lockHolders(w), unchanged: unchangedExceptProducerReceipts(w, diff(before, await state(w))), backendGone: await backendGone(w, rc.pid) });
        // Abort with the client kept open (direct prepare): the connection must be usable, outside any transaction, with no lock row.
        const direct = await w.connect();
        try {
          out.abortClientOpen = { code: await refusal(() => prepareUnitRetirement(direct, frozen.config, frozen.proofSha256, unitLockKey(w.G1.jobRunId), producerExclusionKey(w.generation))),
            ownLocks: (await direct.query("SELECT count(*)::int n FROM pg_locks WHERE locktype='advisory' AND pid=pg_backend_pid()")).rows[0].n,
            inTransaction: (await direct.query("SELECT transaction_timestamp()<>statement_timestamp() t")).rows[0].t };
        } finally { await direct.end(); }
        checks.cleanup = out;
        const o = out as any;
        assert.deepEqual([o.rollback.code, o.rollback.holders, o.rollback.unchanged, o.rollback.backendGone], ["EXACT_SINGLE_PARENT_COMMIT_CHALLENGE", [], true, true]);
        assert.deepEqual([o.clientFailure.holders, o.clientFailure.unchanged, o.clientFailure.backendGone], [[], true, true]);
        assert.notEqual(o.clientFailure.code, "NO_REFUSAL");
        assert.deepEqual([o.abort.code, o.abort.holders, o.abort.unchanged, o.abort.backendGone], ["SOURCE_DRIFT_INPUT_EVIDENCE_BYTES", [], true, true]);
        assert.deepEqual([o.abortClientOpen.code, o.abortClientOpen.ownLocks, o.abortClientOpen.inTransaction], ["SOURCE_DRIFT_INPUT_EVIDENCE_BYTES", 0, false]);
      } finally { await close(w); }
    }

    // ---------------- S4: byte drift on the SHARED key also refuses ----------------
    if (wanted("drift")) {
      step = "drift"; const w = await world("drift");
      try {
        const frozen = await freeze(w);
        await w.db.query(`UPDATE public.${INPUT} SET input_evidence_json=input_evidence_json||'{"nsbDrift":1}'::jsonb WHERE contract_version=$1 AND input_hash=$2`, w.shared[0]);
        const before = await state(w), rc = await retireClient(w);
        const code = await refusal(() => retireOnceWithParentChallenge(rc.client, request(frozen), async line => challenge(frozen, line)));
        checks.drift = { code, unchanged: unchangedExceptProducerReceipts(w, diff(before, await state(w))), holders: await lockHolders(w) };
        assert.deepEqual([checks.drift.code, checks.drift.unchanged, checks.drift.holders], ["SOURCE_DRIFT_INPUT_EVIDENCE_BYTES", true, []]);
      } finally { await close(w); }
    }

    // ---------------- S5: index precondition + bounded plan, fail closed ----------------
    if (wanted("index")) {
      step = "index"; const w = await world("index");
      try {
        const frozen = await freeze(w), out: Record<string, unknown> = {};
        const attempt = async (name: string, options?: string) => {
          const before = await state(w), rc = await retireClient(w, undefined, options);
          const code = await refusal(() => retireOnceWithParentChallenge(rc.client, request(frozen), async line => challenge(frozen, line)));
          out[name] = { code, unchanged: unchangedExceptProducerReceipts(w, diff(before, await state(w))), holders: (await lockHolders(w)).length };
        };
        await attempt("plannerCannotProbeIndex", "-c enable_indexscan=off -c enable_indexonlyscan=off -c enable_bitmapscan=off");
        await w.db.query("DROP INDEX public.idx_engine_v3_ad_evaluations_contract_input");
        await attempt("missingIndex");
        await w.db.query(`CREATE INDEX nsb_cie_partial ON public.${EVAL} (contract_version,input_hash) WHERE contract_version IS NOT NULL`);
        await attempt("partialIndexOnly");
        await w.db.query("DROP INDEX public.nsb_cie_partial");
        await w.db.query(`CREATE INDEX nsb_cie_reversed ON public.${EVAL} (input_hash,contract_version)`);
        await attempt("reversedLeadingKeys");
        checks.index = out;
        const o = out as any;
        assert.deepEqual(Object.values(o).map((x: any) => [x.code, x.unchanged, x.holders]), [["INPUT_REFERENCE_PLAN_NOT_INDEXED", true, 0],
          ["INPUT_REFERENCE_INDEX_PRECONDITION_MISSING", true, 0], ["INPUT_REFERENCE_INDEX_PRECONDITION_MISSING", true, 0],
          ["INPUT_REFERENCE_INDEX_PRECONDITION_MISSING", true, 0]]);
      } finally { await close(w); }
    }

    // ---------------- S6: GLOBAL references (another tenant) keep the key ----------------
    if (wanted("global")) {
      step = "global"; const w = await world("global");
      try {
        const frozen = await freeze(w);
        // SYNTHETIC cross-tenant reference (raw UPDATE; the producer cannot write it because hashes bind business/day).
        const target = w.zero[0]!;
        const foreign = (await w.db.query(`SELECT id::text id FROM public.${EVAL} WHERE job_run_id=$1::uuid AND contract_version=$2 ORDER BY id LIMIT 1`, [w.F1.jobRunId, target[0]])).rows[0].id;
        await w.db.query(`UPDATE public.${EVAL} SET input_hash=$2 WHERE id=$1::uuid`, [foreign, target[1]]);
        const originalEvidence = await evidenceBytes(w, frozen.config.inputKeys as Key[]), before = await state(w), rc = await retireClient(w);
        const result = await retireOnceWithParentChallenge(rc.client, request(frozen), async line => challenge(frozen, line));
        const d = diff(before, await state(w)), kept = await evidenceBytes(w, [target]);
        const r = await w.connect(); let back;
        try { back = await independentReadback(r, frozen.config); } finally { await r.end(); }
        checks.global = { committed: result.committed, crossTenantReferencedKeyKeptByteIdentical: kept[JSON.stringify(target)] === originalEvidence[JSON.stringify(target)],
          inputRemoved: d[INPUT]!.removed.length, globalDanglingEvaluations: await globalDangling(w), readback: back.inputEvidence };
        assert.deepEqual([result.committed, checks.global.crossTenantReferencedKeyKeptByteIdentical, checks.global.inputRemoved, checks.global.globalDanglingEvaluations,
          back.retainedRootsFullBytesMatch, back.inputEvidence?.presentShared, back.inputEvidence?.absentRetired], [true, true, 1, 0, true, 2, 1]);
      } finally { await close(w); }
    }

    // ---------------- S7: unknown consumers (database catalog + source ledger) ----------------
    if (wanted("consumer")) {
      step = "consumer"; const w = await world("consumer");
      try {
        const out: Record<string, unknown> = {};
        await w.db.query(`CREATE VIEW public.nsb_cie_unknown_input_reader AS SELECT contract_version FROM public.${INPUT}`);
        out.viewBeforeFreeze = await refusal(() => freeze(w));
        await w.db.query("DROP VIEW public.nsb_cie_unknown_input_reader");
        const frozen = await freeze(w);
        for (const [name, ddl, undo] of [["viewAfterFreeze", `CREATE VIEW public.nsb_cie_unknown_input_reader AS SELECT contract_version FROM public.${INPUT}`, "DROP VIEW public.nsb_cie_unknown_input_reader"],
          ["triggerAfterFreeze", `CREATE TRIGGER nsb_cie_input_trigger BEFORE DELETE ON public.${INPUT} FOR EACH ROW EXECUTE FUNCTION suppress_redundant_updates_trigger()`,
            `DROP TRIGGER nsb_cie_input_trigger ON public.${INPUT}`]] as const) {
          await w.db.query(ddl);
          const before = await state(w), rc = await retireClient(w);
          out[name] = { code: await refusal(() => retireOnceWithParentChallenge(rc.client, request(frozen), async line => challenge(frozen, line))),
            unchanged: unchangedExceptProducerReceipts(w, diff(before, await state(w))), holders: (await lockHolders(w)).length };
          await w.db.query(undo);
        }
        const sources = nativeRetainedReaderSources(REPO_ROOT), ledger = JSON.parse(await readFile(join(REPO_ROOT, "docs/architecture/native-retained-reader-ledger.json"), "utf8"));
        out.ledgerActual = validateNativeRetainedReaderLedger(sources, ledger).issues;
        const mutated = new Map(sources); mutated.set("scripts/nsb-cie-unclassified-reader.ts", `SELECT * FROM engine_v3_ad_decision_input_evidence`);
        out.ledgerUnclassified = validateNativeRetainedReaderLedger(mutated, ledger).issues;
        checks.consumer = out;
        const o = out as any;
        assert.deepEqual([o.viewBeforeFreeze, o.viewAfterFreeze.code, o.viewAfterFreeze.unchanged, o.viewAfterFreeze.holders, o.triggerAfterFreeze.code,
          o.triggerAfterFreeze.unchanged, o.ledgerUnclassified], ["INPUT_EVIDENCE_UNKNOWN_CONSUMER_VETO", "INPUT_EVIDENCE_UNKNOWN_CONSUMER_VETO", true, 0,
          "INPUT_EVIDENCE_UNKNOWN_CONSUMER_VETO", true, [...o.ledgerActual, "scripts/nsb-cie-unclassified-reader.ts: unclassified retained-table consumer"]]);
        // A source-mutation run changes pinned sources by construction; the unmutated full run must match the ledger exactly.
        if (ONLY.length === 0) assert.deepEqual(o.ledgerActual, []);
      } finally { await close(w); }
    }

    // ---------------- S8: consumed v2 purpose / v1 unit config never run as v3 ----------------
    if (wanted("v2")) {
      step = "v2"; const w = await world("v2");
      try {
        const frozen = await freeze(w);
        const plan = { contract: "finite-native-storage-batch.v2", purpose: hex, targetRevision: head, sourceManifestSha256: pack.sourceManifestSha256,
          actualSourceReviewSha256: "d".repeat(64), expectedDatabaseBudgetBytes: 1, cutoffObservedAt: new Date(Date.now() - 60_000).toISOString(),
          units: [{ generation: frozen.config.generation, evaluations: frozen.config.evaluations, contexts: frozen.config.contexts, originalProofSha256: frozen.proofSha256 }] } as unknown as NativeStorageBatchPlan;
        let backendCalls = 0;
        const journal = { begin: async () => { backendCalls++; }, intent: async () => { backendCalls++; }, receipt: async () => { backendCalls++; }, finish: async () => { backendCalls++; } };
        const backend = { freshEvidence: async () => { backendCalls++; throw new Error("NEVER"); }, execute: async () => { backendCalls++; throw new Error("NEVER"); },
          verifyAcknowledged: async () => { backendCalls++; return true; } };
        const v1 = { ...frozen.config, contract: "finite-native-storage-unit-config.v1" } as UnitConfig; delete v1.inputEvidence;
        const before = await state(w), c = await w.connect();
        let v1Code;
        try { v1Code = await refusal(() => prepareUnitRetirement(c, v1, canonicalSha(v1), unitLockKey(w.G1.jobRunId), producerExclusionKey(w.generation))); }
        finally { await c.end(); }
        checks.v2 = { validate: await refusal(async () => validateNativeStorageBatchPlan(plan)),
          resume: await refusal(() => runFiniteNativeStorageBatch(plan, journal as never, backend as never)), backendOrJournalCalls: backendCalls,
          v1UnitConfigRetire: v1Code, unchanged: unchangedExceptProducerReceipts(w, diff(before, await state(w))), holders: (await lockHolders(w)).length };
        assert.deepEqual(Object.values(checks.v2), ["RETIRED_V2_BYTE_RETAINED_INPUT_SCHEDULE", "RETIRED_V2_BYTE_RETAINED_INPUT_SCHEDULE", 0,
          "RETIRED_UNIT_CONFIG_NOT_EXECUTABLE", true, 0]);
      } finally { await close(w); }
    }
  } finally { /* worlds closed above */ }
  return pg;
}

(async () => {
  let pg: Cluster | undefined, failure: unknown = null;
  try { pg = await main(); } catch (e) { failure = e; }
  const data = pg?.data ?? join(STATE, "pg", "data");
  spawnSync(`${PG}/pg_ctl`, ["-D", data, "-m", "immediate", "-w", "stop"], { stdio: "ignore", env: PG_ENV });
  const stopped = spawnSync(`${PG}/pg_ctl`, ["-D", data, "status"], { stdio: "ignore", env: PG_ENV }).status;
  const confirmed = stopped === 3 || stopped === 4;
  if (confirmed && STATE.startsWith(`${PRIVATE_BASE}/nsb-cie-`) && /^[a-f0-9]{12}$/.test(hex)) await rm(STATE, { recursive: true, force: true });
  const receipt = { contract: "native-input-evidence-lifecycle-owned-real-pg.v1", scenarios: ONLY.length ? ONLY : "all", stateRoot: "$STATE",
    stateRootRemoved: confirmed, clusterStopStatus: stopped, actualExitCode: failure ? 1 : 0, failedStep: failure ? step : null,
    failure: failure ? { ...safeError(failure), message: String((failure as Error)?.message ?? failure).slice(0, 600) } : null,
    checks, productionAccess: false,
    fixtureScope: "Owned PG16, actual run-migrations full DDL + ONE added real-production index prerequisite, actual producer writer and job; not production scale/performance." };
  await mkdir(OUT, { recursive: true, mode: 0o700 });
  const name = `input-evidence-lifecycle-pg-receipt-${hex}.json`;
  await writeExclusive(join(OUT, name), JSON.stringify(receipt, null, 2), 0o400);
  process.stdout.write(`${JSON.stringify({ actualExitCode: receipt.actualExitCode, receipt: name, failedStep: receipt.failedStep, failure: receipt.failure })}\n`);
  setTimeout(() => process.exit(receipt.actualExitCode), 200);
})();
