import { hashAdvisoryLock } from "../../lib/creative-decision-engine/jobs/advisory-lock";
import type { Q } from "./capture";
import { EVAL, INPUT, NATIVE_JOB, SHA, UUID, need, rowSetHash, same, sha256 } from "./common";

/** D150 v3 zero-live-reference lifecycle of engine_v3_ad_decision_input_evidence. Stage-safe: nothing
 * here connects, writes or spawns on import. Only frozen keys of a closed,
 * archived original whose evaluations were just deleted in the same RR
 * transaction, and that have ZERO live references in the GLOBAL evaluation
 * table, are removed; every other frozen key stays byte-identical. The global
 * NOT EXISTS runs only through a catalog-verified (contract_version,input_hash)
 * btree index and an EXPLAIN that proves a bounded, parameterized index probe;
 * anything else refuses (never a subset, never a sequential scan). */
export const INPUT_EVIDENCE_LIFECYCLE = "zero-live-reference.v3" as const;
const PAGE = 400;
type Key = [string, string];
type Read = (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>;

// ---------------- producer exclusion (session advisory lock) ----------------
/** The native producer's own job lock: hashAdvisoryLock(`${job}:${businessId}:${asOf}`)
 * (adDecisionsJobAdvisoryLockKey). The formula is not changed here; the producer
 * file is pinned byte-identical at operator and runtime revisions. */
export function producerExclusionKey(g: { businessId: string; asOfDate: string }) {
  need(UUID.test(g?.businessId) && /^\d{4}-\d{2}-\d{2}$/.test(g?.asOfDate), "EXACT_PRODUCER_EXCLUSION_IDENTITY");
  return hashAdvisoryLock(`${NATIVE_JOB}:${g.businessId}:${g.asOfDate}`).toString();
}
/** pg_locks identity of a one-bigint advisory key: high/low unsigned halves, objsubid 1. */
export function advisoryLockParts(key: string) {
  need(/^-?\d{1,19}$/.test(key), "EXACT_PRODUCER_EXCLUSION_KEY");
  const unsigned = BigInt.asUintN(64, BigInt(key));
  return { classid: (unsigned >> BigInt(32)).toString(), objid: (unsigned & BigInt(0xffffffff)).toString() };
}
export interface ProducerExclusion { key: string; classid: string; objid: string; pid: number; acquiredAt: string }
/** NONBLOCKING SESSION lock taken on the caller's own pinned client BEFORE its
 * REPEATABLE READ transaction exists (an implicit single-statement transaction),
 * so the retirement snapshot can only form after it. Busy = refusal, nothing changed. */
export async function acquireProducerExclusion(db: Q, key: string): Promise<ProducerExclusion> {
  const parts = advisoryLockParts(key);
  // Simple-protocol single statement (the key is a validated integer literal): outside an open
  // transaction block its implicit transaction starts with this statement, so the two clocks are equal.
  const r = (await db.query(`SELECT pg_try_advisory_lock(${key}::bigint) acquired,pg_backend_pid() pid,statement_timestamp()::text acquired_at,
    transaction_timestamp()=statement_timestamp() implicit_transaction`)).rows[0];
  need(r && r.implicit_transaction === true, "PRODUCER_EXCLUSION_BEFORE_TRANSACTION_REQUIRED");
  need(r.acquired === true, "PRODUCER_EXCLUSION_BUSY");
  need(Number.isSafeInteger(r.pid) && r.pid > 0 && typeof r.acquired_at === "string", "PRODUCER_EXCLUSION_IDENTITY");
  return { key, ...parts, pid: r.pid, acquiredAt: r.acquired_at };
}
const HELD_SQL = `SELECT pg_backend_pid() pid,count(*)::int locks FROM pg_locks l WHERE l.locktype='advisory' AND l.pid=pg_backend_pid()
  AND l.granted AND l.mode='ExclusiveLock' AND l.database=(SELECT oid FROM pg_database WHERE datname=current_database())
  AND l.classid=$1::oid AND l.objid=$2::oid AND l.objsubid=1`;
/** Same backend, the exact lock granted to it. */
export async function producerExclusionHeld(db: Q, x: ProducerExclusion) {
  const r = (await db.query(HELD_SQL, [x.classid, x.objid])).rows[0];
  return r?.pid === x.pid && r.locks === 1;
}
/** Own unlock after the parent's COMMIT or ROLLBACK. pg_advisory_unlock returns
 * true only for a SESSION lock this backend holds; then no lock row may remain. */
export async function releaseProducerExclusion(db: Q, x: ProducerExclusion) {
  const r = (await db.query("SELECT pg_advisory_unlock($1::bigint) released,pg_backend_pid() pid", [x.key])).rows[0];
  need(r?.released === true && r.pid === x.pid, "PRODUCER_EXCLUSION_RELEASE");
  need((await db.query(HELD_SQL, [x.classid, x.objid])).rows[0]?.locks === 0, "PRODUCER_EXCLUSION_RELEASE");
}

// ---------------- reference index + bounded plan ----------------
/** Every VALID/READY/LIVE plain btree on the evaluations table whose two leading
 * key columns are exactly (contract_version, input_hash) with default opclasses
 * and column collations, no predicate, no expressions. The production index is
 * idx_engine_v3_ad_evaluations_contract_input; run-migrations does not create it. */
export async function readReferenceIndexes(read: Read) {
  const rows = (await read(`SELECT ic.relname::text name,i.indexrelid::text oid,pg_relation_size(i.indexrelid)::text bytes,
      (SELECT c.relrowsecurity OR c.relforcerowsecurity FROM pg_class c WHERE c.oid=i.indrelid) row_security
    FROM pg_index i JOIN pg_class ic ON ic.oid=i.indexrelid JOIN pg_am am ON am.oid=ic.relam
    JOIN pg_attribute a0 ON a0.attrelid=i.indrelid AND a0.attnum=i.indkey[0] JOIN pg_attribute a1 ON a1.attrelid=i.indrelid AND a1.attnum=i.indkey[1]
    JOIN pg_opclass o0 ON o0.oid=i.indclass[0] JOIN pg_opclass o1 ON o1.oid=i.indclass[1]
    WHERE i.indrelid='public.${EVAL}'::regclass AND am.amname='btree' AND i.indnkeyatts>=2
      AND a0.attname='contract_version' AND a1.attname='input_hash' AND i.indpred IS NULL AND i.indexprs IS NULL
      AND i.indisvalid AND i.indisready AND i.indislive AND o0.opcdefault AND o1.opcdefault
      AND i.indcollation[0]=a0.attcollation AND i.indcollation[1]=a1.attcollation
    ORDER BY ic.relname`)).rows;
  return rows as { name: string; oid: string; bytes: string; row_security: boolean }[];
}
export async function requireReferenceIndex(read: Read) {
  const indexes = await readReferenceIndexes(read);
  need(indexes.length >= 1, "INPUT_REFERENCE_INDEX_PRECONDITION_MISSING");
  need(indexes.every(i => i.row_security === false), "INPUT_REFERENCE_ROW_SECURITY_VETO");
  return indexes.map(({ name, oid, bytes }) => ({ name, oid, bytes }));
}
/** Every access to the evaluations table is a parameterized probe of a verified
 * reference index (an Index Cond on both key columns): no Seq Scan, no other
 * index, no full index scan (e.g. a merge join over the whole index). */
export function inspectReferencePlan(value: unknown, indexNames: string[]) {
  const root = typeof value === "string" ? JSON.parse(value) : value;
  need(Array.isArray(root) && root.length === 1 && root[0]?.Plan, "EXPLAIN_PLAN_REQUIRED");
  let nodes = 0; const probes: string[] = [];
  const bounded = (node: any) => indexNames.includes(node["Index Name"]) && typeof node["Index Cond"] === "string" &&
    /\bcontract_version\b/.test(node["Index Cond"]) && /\binput_hash\b/.test(node["Index Cond"]);
  const walk = (node: any, bitmapHeapOnEval: boolean) => {
    need(++nodes <= 2048 && node && typeof node === "object", "FINITE_PLAN_NODES");
    const type = node["Node Type"], onEval = node["Relation Name"] === EVAL;
    if (onEval && (type === "Index Only Scan" || type === "Index Scan")) { need(bounded(node), "INPUT_REFERENCE_PLAN_NOT_INDEXED"); probes.push(node["Index Name"]); }
    else if (type === "Bitmap Index Scan" && bitmapHeapOnEval) { need(bounded(node), "INPUT_REFERENCE_PLAN_NOT_INDEXED"); probes.push(node["Index Name"]); }
    else need(!onEval || type === "Bitmap Heap Scan", "INPUT_REFERENCE_PLAN_NOT_INDEXED");
    for (const child of node.Plans ?? []) walk(child, onEval && type === "Bitmap Heap Scan");
  };
  walk(root[0].Plan, false);
  need(probes.length >= 1, "INPUT_REFERENCE_PLAN_NOT_INDEXED");
  return [...new Set(probes)].sort();
}
export const ZERO_REFERENCE_SQL = `SELECT k.contract_version,k.input_hash::text input_hash FROM unnest($1::text[],$2::character(64)[]) k(contract_version,input_hash)
  WHERE NOT EXISTS (SELECT 1 FROM public.${EVAL} e WHERE e.contract_version=k.contract_version AND e.input_hash=k.input_hash) ORDER BY 1,2`;
const REFERENCED_SQL = `SELECT count(*)::int n FROM unnest($1::text[],$2::character(64)[]) k(contract_version,input_hash)
  WHERE EXISTS (SELECT 1 FROM public.${EVAL} e WHERE e.contract_version=k.contract_version AND e.input_hash=k.input_hash)`;
const pages = (keys: Key[]) => Array.from({ length: Math.ceil(keys.length / PAGE) }, (_, i) => keys.slice(i * PAGE, (i + 1) * PAGE));
const columns = (page: Key[]) => [page.map(k => k[0]), page.map(k => k[1])];
async function explained(read: Read, sql: string, values: unknown[], indexNames: string[]) {
  const plan = (await read(`EXPLAIN (FORMAT JSON) ${sql}`, values)).rows;
  need(plan.length === 1, "ONE_EXPLAIN_RESULT_REQUIRED");
  return inspectReferencePlan(plan[0]["QUERY PLAN"], indexNames);
}
/** GLOBAL NOT EXISTS over every live evaluation (all tenants/jobs/days), paged,
 * each page EXPLAIN-verified before it runs. Returns the zero-reference keys. */
export async function globalZeroReferenceKeys(read: Read, keys: Key[], indexNames: string[]) {
  const out: Key[] = [], used = new Set<string>();
  for (const page of pages(keys)) {
    for (const name of await explained(read, ZERO_REFERENCE_SQL, columns(page), indexNames)) used.add(name);
    out.push(...(await read(ZERO_REFERENCE_SQL, columns(page))).rows.map(r => [r.contract_version, r.input_hash] as Key));
  }
  return { keys: out.sort(compareKeys), indexesUsed: [...used].sort() };
}
/** Live global evaluation references to the given keys (dangling check). */
export async function liveReferenceCount(read: Read, keys: Key[], indexNames: string[]) {
  let n = 0;
  for (const page of pages(keys)) {
    await explained(read, REFERENCED_SQL, columns(page), indexNames);
    n += Number((await read(REFERENCED_SQL, columns(page))).rows[0].n);
  }
  return n;
}

// ---------------- frozen per-key bytes ----------------
export const compareKeys = (a: Key, b: Key) => JSON.stringify(a) < JSON.stringify(b) ? -1 : JSON.stringify(a) > JSON.stringify(b) ? 1 : 0;
export interface InputEvidenceConfig { lifecycle: typeof INPUT_EVIDENCE_LIFECYCLE; rowSha256: string[]; catalogFingerprint: string }
/** Keyed digest of (key, full-row sha256) triples; any key subset is recomputable from the frozen config. */
export function keyedDigest(keys: Key[], rowSha: (k: Key) => string) {
  return sha256(JSON.stringify([...keys].sort(compareKeys).map(k => [k[0], k[1], rowSha(k)])));
}
export function frozenRowSha(config: { inputKeys: Key[]; inputEvidence: InputEvidenceConfig }) {
  const e = config.inputEvidence;
  need(e?.lifecycle === INPUT_EVIDENCE_LIFECYCLE && Array.isArray(e.rowSha256) && e.rowSha256.length === config.inputKeys.length &&
    e.rowSha256.every(x => SHA.test(x)) && SHA.test(e.catalogFingerprint) && same(config.inputKeys, [...config.inputKeys].sort(compareKeys)) &&
    new Set(config.inputKeys.map(k => JSON.stringify(k))).size === config.inputKeys.length, "EXACT_FROZEN_INPUT_EVIDENCE_CONFIG");
  const map = new Map(config.inputKeys.map((k, i) => [JSON.stringify(k), e.rowSha256[i]!]));
  return (k: Key) => { const v = map.get(JSON.stringify(k)); need(v, "UNFROZEN_INPUT_EVIDENCE_KEY"); return v; };
}
/** Exact frozen full JSONB bytes for exactly `keys` (one row each). */
export function verifyFrozenInputRows(rows: { contract_version: string; input_hash: string; bytes: string }[], keys: Key[], rowSha: (k: Key) => string) {
  const got = rows.map(r => [r.contract_version, r.input_hash] as Key).sort(compareKeys);
  need(same(got, [...keys].sort(compareKeys)) && rows.every(r => typeof r.bytes === "string"), "SOURCE_DRIFT_INPUT_EVIDENCE_KEYS");
  for (const r of rows) need(sha256(r.bytes) === rowSha([r.contract_version, r.input_hash]), "SOURCE_DRIFT_INPUT_EVIDENCE_BYTES");
  return { rows: rows.length, rowByteSetSha256: rowSetHash(rows.map(r => r.bytes)), keyedSha256: keyedDigest(keys, rowSha) };
}
export const INPUT_ROWS_SQL = `SELECT t.contract_version,t.input_hash::text input_hash,to_jsonb(t)::text bytes FROM public.${INPUT} t
  JOIN unnest($1::text[],$2::character(64)[]) k(contract_version,input_hash) ON t.contract_version=k.contract_version AND t.input_hash=k.input_hash`;
export async function readInputRows(read: Read, keys: Key[], suffix = "") {
  const rows: { contract_version: string; input_hash: string; bytes: string }[] = [];
  for (const page of pages(keys)) rows.push(...(await read(`${INPUT_ROWS_SQL}${suffix}`, columns(page))).rows);
  return rows;
}

// ---------------- concrete database consumers of the input table ----------------
/** SELECT-only: incoming FKs, triggers, views/rules, policies, publications,
 * inheritance, row security and functions naming the table. Any one vetoes. */
export async function readInputEvidenceCatalog(read: Read) {
  const r = (await read(`SELECT c.relkind kind,c.relrowsecurity OR c.relforcerowsecurity row_security,
      (SELECT coalesce(json_agg(con.conname::text ORDER BY con.conname),'[]') FROM pg_constraint con WHERE con.contype='f' AND con.confrelid=c.oid) incoming_fks,
      (SELECT coalesce(json_agg(t.tgname::text ORDER BY t.tgname),'[]') FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid=c.oid) triggers,
      (SELECT coalesce(json_agg(DISTINCT v.oid::regclass::text),'[]') FROM pg_depend d JOIN pg_rewrite w ON d.classid='pg_rewrite'::regclass AND w.oid=d.objid
        JOIN pg_class v ON v.oid=w.ev_class WHERE d.refclassid='pg_class'::regclass AND d.refobjid=c.oid AND v.oid<>c.oid) rewrite_dependents,
      (SELECT coalesce(json_agg(p.polname::text ORDER BY p.polname),'[]') FROM pg_policy p WHERE p.polrelid=c.oid) policies,
      (SELECT coalesce(json_agg(DISTINCT p.pubname::text),'[]') FROM pg_publication p WHERE p.puballtables
        OR EXISTS(SELECT 1 FROM pg_publication_rel pr WHERE pr.prpubid=p.oid AND pr.prrelid=c.oid)
        OR EXISTS(SELECT 1 FROM pg_publication_namespace pn WHERE pn.pnpubid=p.oid AND pn.pnnspid=c.relnamespace)) publications,
      (SELECT coalesce(json_agg(i.inhrelid::regclass::text||'<'||i.inhparent::regclass::text),'[]') FROM pg_inherits i WHERE i.inhrelid=c.oid OR i.inhparent=c.oid) inheritance,
      (SELECT coalesce(json_agg(p.oid::regprocedure::text ORDER BY p.oid::regprocedure::text),'[]') FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace
        WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f','p') AND p.prosrc LIKE '%${INPUT}%') functions
    FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=$1`, [INPUT])).rows;
  need(rows1(r), "EXACT_INPUT_EVIDENCE_RELATION");
  const x = r[0];
  need(x.kind === "r" && x.row_security === false, "INPUT_EVIDENCE_RELATION_SHAPE_VETO");
  need(same(x.incoming_fks, []), "INPUT_EVIDENCE_INCOMING_FK_VETO");
  need([x.triggers, x.rewrite_dependents, x.policies, x.publications, x.inheritance, x.functions].every(v => Array.isArray(v) && v.length === 0),
    "INPUT_EVIDENCE_UNKNOWN_CONSUMER_VETO");
  return { fingerprint: sha256(JSON.stringify(x)) };
}
const rows1 = (r: unknown[]) => Array.isArray(r) && r.length === 1;
