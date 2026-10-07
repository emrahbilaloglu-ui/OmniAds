import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { readNativeEvaluationContextUnit, assessNativeEvaluationContextUnit } from "../../lib/creative-decision-engine/native-evaluation-context-unit";
import { readNativeArchivePinCensus, assessNativeArchivePins } from "../../lib/creative-decision-engine/native-archive-pin-census";
import { readNativeJobEvaluationSelection } from "../../lib/creative-decision-engine/native-job-evaluation-selection";
import { readNativeJobSnapshotSelection } from "../../lib/creative-decision-engine/native-job-snapshot-selection";
import { NATIVE_REFERENCE_ARCHIVE_TABLES, buildNativeSupersededReferenceEvidenceArchive,
  type NativeArchiveGeneration, type NativeArchiveSchema, type NativeArchiveTable } from "../../lib/creative-decision-engine/native-evidence-archive";
import { NATIVE_CALIBRATION_PARENT_TABLES, buildNativeCalibrationParentArchive,
  type NativeCalibrationParentBundle } from "../../lib/creative-decision-engine/native-calibration-parent-archive";
import { splitNativeReferenceArchive, reassembleNativeReferenceArchive } from "../../lib/creative-decision-engine/native-reference-archive-segments";
import { sealCompressedNativeHistoricalArchive, openNativeHistoricalArchiveEnvelope, openImmutableNativeHistoricalArchiveCatalog,
  nativeHistoricalArchiveStorageVersion, NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT,
  type NativeHistoricalArchiveContentTrust } from "../../lib/creative-decision-engine/native-historical-archive";
import { persistLocalNativeArchive, NATIVE_LOCAL_ARCHIVE_BUCKET } from "../../lib/creative-decision-engine/native-historical-local-store";
import { CLOSED_DAY_BUFFER_MS, CONTEXT, DECLARED_CLOSURE_GAP, EVAL, EXPECTED_INCOMING_FKS, NATIVE_JOB, NON_FK_CLASSES,
  UNIT_CONFIG_CONTRACT, UNIT_TABLES, UUID, type UnitTable, canonical, canonicalSha, need, rowSetHash, same, sha256, writeExclusive, BatchRefusal,
  privateDirectory, readExact } from "./common";
import { archiveEngineVeto } from "./archive-engine-eligibility";
import { INPUT_EVIDENCE_LIFECYCLE, readInputEvidenceCatalog, type InputEvidenceConfig } from "./input-evidence-lifecycle";

/** Generic whole-original collector. Same mechanics as the reviewed known1134
 * collector, with its literal job/tenant/count/build replaced by the exact
 * frozen unit identity. One READ ONLY REPEATABLE READ snapshot, bounded rows,
 * EXPLAIN hot-table veto, ROLLBACK before any sealing. No source write. */
export interface Q { query(sql: string, values?: unknown[]): Promise<{ rows: any[]; command?: string; rowCount?: number | null }> }
const cap = Object.freeze({ evaluations: 1134, contexts: 4, objects: 1134, batches: 6, cells: 1000, parentJobs: 16,
  encodedRows: 32 * 1024 * 1024, plaintext: 64 * 1024 * 1024, statements: 256, wholeMs: 90_000 });
const HOT = ["engine_v3_ad_decision_evaluations", "engine_v3_ad_decision_snapshots_daily",
  "engine_v3_ad_campaign_context_objects", "engine_v3_ad_decision_input_evidence"];
/** Exact SELECT texts whose quoted literal contains a DML keyword ('copy'
 * handoff origin). Only these full-text digests bypass the keyword filter; the
 * transaction is still READ ONLY and the statement still gets the EXPLAIN veto. */
export const KNOWN_READ_SELECT_SHA256 = new Set<string>([
  // native-evaluation-context-unit launch-handoff query (origin IN ('decision','copy')); same digest as the reviewed d60 exception.
  "7bc18a1783ce5ad0d7831538ef3e7620fe2715cd40a84c528a9779ed8561a442"]);

export function inspectPlan(value: unknown, sqlSha256 = "") {
  const root = typeof value === "string" ? JSON.parse(value) : value;
  need(Array.isArray(root) && root.length === 1 && root[0]?.Plan, "EXPLAIN_PLAN_REQUIRED");
  let nodes = 0; const scans: string[] = [];
  const walk = (node: any) => {
    need(++nodes <= 2048 && node && typeof node === "object", "FINITE_PLAN_NODES");
    if (node["Node Type"] === "Seq Scan" && HOT.includes(node["Relation Name"])) scans.push(node["Relation Name"]);
    for (const child of node.Plans ?? []) walk(child);
  };
  walk(root[0].Plan);
  need(!scans.length, `GLOBAL_HOT_SEQ_SCAN_REFUSED:${scans[0]}:${sqlSha256.slice(0, 12)}`);
}
/** SELECT/transaction-only adapter; one statement per call; hot-table EXPLAIN veto. */
export function readOnlyAdapter(client: Q) {
  let statements = 0, rolledBack = false;
  const run = (sql: string, values?: unknown[]) => client.query(sql, values);
  return { query: async (sql: string, values?: unknown[]) => {
    need(typeof sql === "string" && !sql.includes(";"), "ONE_READ_STATEMENT_REQUIRED");
    need(++statements <= cap.statements, "FINITE_SOURCE_STATEMENT_LIMIT");
    const text = sql.trim();
    if (text === "ROLLBACK") { need(!rolledBack, "ONE_TERMINAL_ROLLBACK_ONLY"); rolledBack = true; return run(sql, values); }
    need(!rolledBack, "SOURCE_READ_AFTER_ROLLBACK_REFUSED");
    const tx = text === "BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY";
    const setting = /^SET LOCAL (?:statement_timeout='7500ms'|lock_timeout='1000ms'|timezone='UTC')$/.test(text);
    const dml = /\b(?:INSERT|DELETE|UPDATE|MERGE|CREATE|DROP|ALTER|COPY|CALL|DO|TRUNCATE|GRANT|FOR\s+UPDATE|FOR\s+SHARE)\b/i.test(text);
    const select = /^(SELECT|WITH)\b/i.test(text) && (!dml || KNOWN_READ_SELECT_SHA256.has(sha256(sql)));
    need(tx || setting || select, `READ_ONLY_SQL_KIND_REQUIRED:${sha256(sql).slice(0, 12)}`);
    if (select && HOT.some(t => new RegExp(`\\b${t}\\b`).test(sql))) {
      const plan = await run(`EXPLAIN (FORMAT JSON) ${sql}`, values);
      need(plan.rows.length === 1, "ONE_EXPLAIN_RESULT_REQUIRED"); inspectPlan(plan.rows[0]["QUERY PLAN"], sha256(sql));
    }
    return run(sql, values);
  } };
}

/** SELECT-only catalog inventory of the two target relations (C3 catalog-reader). */
export async function readTargetCatalog(read: (sql: string, values?: unknown[]) => Promise<any[]>) {
  const tables = [EVAL, CONTEXT];
  const r: Record<string, unknown> = {};
  const relations = await read(`SELECT c.oid::text oid,n.nspname schema,c.relname name,c.relkind kind,c.relrowsecurity "rowSecurity",c.relforcerowsecurity "forceRowSecurity",c.relispartition partition,c.relhassubclass "hasSubclass" FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname='public' AND c.relname=ANY($1::text[]) ORDER BY c.relname`, [tables]);
  need(relations.length === 2, "EXACT_TWO_RELATIONS_REQUIRED"); r.relations = relations;
  const oids = relations.map(x => x.oid);
  r.foreignKeys = await read(`SELECT con.conname "constraint",cn.nspname "childSchema",ch.relname "childTable",pn.nspname "parentSchema",pa.relname "parentTable",con.confdeltype "deleteAction",con.convalidated validated,con.condeferrable deferrable,con.condeferred deferred,ARRAY(SELECT a.attname::text FROM unnest(con.conkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.conrelid AND a.attnum=k.num ORDER BY k.ord) "childColumns",ARRAY(SELECT a.attname::text FROM unnest(con.confkey) WITH ORDINALITY k(num,ord) JOIN pg_attribute a ON a.attrelid=con.confrelid AND a.attnum=k.num ORDER BY k.ord) "parentColumns",pg_get_constraintdef(con.oid) definition FROM pg_constraint con JOIN pg_class ch ON ch.oid=con.conrelid JOIN pg_namespace cn ON cn.oid=ch.relnamespace JOIN pg_class pa ON pa.oid=con.confrelid JOIN pg_namespace pn ON pn.oid=pa.relnamespace WHERE con.contype='f' AND con.confrelid=ANY($1::oid[]) ORDER BY cn.nspname,ch.relname,con.conname`, [oids]);
  r.triggers = await read(`SELECT t.tgname name,t.tgrelid::regclass::text relation,t.tgenabled enabled,t.tgfoid::regprocedure::text function,pg_get_triggerdef(t.oid) definition FROM pg_trigger t WHERE NOT t.tgisinternal AND t.tgrelid=ANY($1::oid[]) ORDER BY t.tgrelid,t.tgname`, [oids]);
  r.rewriteDependents = await read(`SELECT DISTINCT n.nspname schema,c.relname name,c.relkind kind,r.rulename rule FROM pg_depend d JOIN pg_rewrite r ON d.classid='pg_rewrite'::regclass AND r.oid=d.objid JOIN pg_class c ON c.oid=r.ev_class JOIN pg_namespace n ON n.oid=c.relnamespace WHERE d.refclassid='pg_class'::regclass AND d.refobjid=ANY($1::oid[]) ORDER BY n.nspname,c.relname,r.rulename`, [oids]);
  r.policies = await read(`SELECT p.polrelid::regclass::text relation,p.polname name,p.polcmd command FROM pg_policy p WHERE p.polrelid=ANY($1::oid[]) ORDER BY p.polrelid,p.polname`, [oids]);
  r.publications = await read(`SELECT DISTINCT p.pubname name FROM pg_publication p WHERE p.puballtables OR EXISTS(SELECT 1 FROM pg_publication_rel pr WHERE pr.prpubid=p.oid AND pr.prrelid=ANY($1::oid[])) OR EXISTS(SELECT 1 FROM pg_publication_namespace pn JOIN pg_class c ON c.relnamespace=pn.pnnspid WHERE pn.pnpubid=p.oid AND c.oid=ANY($1::oid[])) ORDER BY p.pubname`, [oids]);
  r.inheritance = await read(`SELECT inhrelid::regclass::text child,inhparent::regclass::text parent FROM pg_inherits WHERE inhrelid=ANY($1::oid[]) OR inhparent=ANY($1::oid[]) ORDER BY inhparent,inhrelid`, [oids]);
  r.functionTokenReferences = await read(`SELECT n.nspname schema,p.proname name,p.oid::regprocedure::text signature,md5(pg_get_functiondef(p.oid)) "definitionMd5" FROM pg_proc p JOIN pg_namespace n ON n.oid=p.pronamespace WHERE n.nspname NOT IN ('pg_catalog','information_schema') AND p.prokind IN ('f','p') AND (p.prosrc LIKE '%engine_v3_ad_decision_evaluations%' OR p.prosrc LIKE '%engine_v3_ad_decision_evaluation_contexts%') ORDER BY n.nspname,p.proname,p.oid LIMIT 65`);
  const fingerprint = sha256(JSON.stringify(r));
  const fks = r.foreignKeys as { constraint: string; validated: boolean; deferrable: boolean }[];
  // Any additional actual-table FK into either relation, or a non-enforced one, vetoes.
  need(same(fks.map(f => f.constraint).sort(), EXPECTED_INCOMING_FKS) && fks.every(f => f.validated && !f.deferrable),
    "ACTUAL_TABLE_FK_SET_VETO");
  need([r.triggers, r.rewriteDependents, r.policies, r.publications, r.inheritance, r.functionTokenReferences]
    .every(x => Array.isArray(x) && x.length === 0), "UNKNOWN_CONCRETE_DATABASE_CONSUMER_VETO");
  return { catalog: r, fingerprint };
}

export interface UnitConfig {
  /** v2 (D150): executable. v1: history only (settlement/readback of consumed purposes). */
  contract: typeof UNIT_CONFIG_CONTRACT | "finite-native-storage-unit-config.v1";
  generation: NativeArchiveGeneration;
  evaluations: number; contexts: number;
  evaluationIds: string[]; contextIds: string[];
  inputKeys: [string, string][];
  campaignObjectHashes: string[];
  jobIds: string[]; batchIds: string[]; cellIds: string[];
  tableHashes: Record<UnitTable, { rows: number; rowByteSetSha256: string }>;
  evaluationRowSha256: Record<string, string>;
  jobFinishedAt: string; schemaHash: string; catalogFingerprint: string; consumerInventorySha256: string;
  /** Exact terminal NO-OP dependents kept live with the retained original job row (full row bytes). */
  retainedDependents: RetainedDependents;
  /** v2 only: full-row sha256 per frozen input key (aligned with inputKeys) + the input table's consumer catalog. */
  inputEvidence?: InputEvidenceConfig;
}
export interface CaptureInput {
  generation: NativeArchiveGeneration; expectedEvaluations: number; expectedContexts: number;
  sourceRevision: string; consumerInventorySha256: string;
}
const parse = (raw: string) => { const v = JSON.parse(raw); need(v && typeof v === "object" && !Array.isArray(v), "ROW_SHAPE"); return v; };
const distinct = <T>(values: T[]) => [...new Set(values)];

/** Vetoes that make a generation ineligible are reported as stable codes. */
function unitVeto(unit: Awaited<ReturnType<typeof readNativeEvaluationContextUnit>>, expected: number) {
  need(unit.evaluationCount === String(expected) && unit.originalJobRowCount === String(expected), "WHOLE_UNIT_SCOPE_MISMATCH");
  need(same(unit.unknownReferences, [DECLARED_CLOSURE_GAP]), "UNKNOWN_CONSUMER_VETO");
  need(unit.contextSharingCount === "0", "WHOLE_UNIT_SCOPE_MISMATCH:CONTEXT_SHARED");
  need(same(unit.incomingReferences.map(e => e.constraint).sort(), EXPECTED_INCOMING_FKS), "ACTUAL_TABLE_FK_SET_VETO");
  need(unit.incomingReferences.filter(e => e.internalSelectedMembership && e.count === String(expected)).length === 1,
    "WHOLE_UNIT_SCOPE_MISMATCH:LINEAGE");
  for (const edge of unit.incomingReferences.filter(e => !e.internalSelectedMembership))
    need(edge.count === "0", edge.childTable === "engine_v3_ad_decision_snapshots_daily" ? "RETAINED_SNAPSHOT_VETO" : `RETAINED_FK_PIN_VETO:${edge.childTable}`);
  need(same(unit.nonFkCounts.map(x => x.pinClass).sort(), NON_FK_CLASSES), "NON_FK_INVENTORY_INCOMPLETE");
  for (const pin of unit.nonFkCounts) need(pin.count === "0", pin.pinClass === "action_lineage" ? "RETAINED_ACTION_VETO" : `RETAINED_NON_FK_VETO:${pin.pinClass}`);
}
type PinCensus = Awaited<ReturnType<typeof readNativeArchivePinCensus>>;
/** The ONLY job_dependencies an original may keep: the native chain's own
 * proposal-projection record of a MANUAL-mode slot (recordNativeProposalProjectionRun:
 * status skipped, zero rows, error standing_mode_manual, nothing else written).
 * The scheduler projects only the current UTC day's slot, so on a closed day
 * that record is terminal. It stays live beside its retained parent job row (the
 * self-FK keeps pointing at a row that is never deleted) and its FULL row bytes
 * are frozen. Every other dependency class, count or shape vetoes. */
export const TERMINAL_NOOP_DEPENDENT = Object.freeze({ jobName: "engine_v3_native_ad_proposal_projection_shadow_job",
  status: "skipped", errorMessage: "standing_mode_manual", maxPerOriginal: 8, minAgeMs: 30 * 60_000 });
export const RETAINED_DEPENDENTS_CONTRACT = "native-terminal-noop-dependents.v1" as const;
export interface RetainedDependents { contract: typeof RETAINED_DEPENDENTS_CONTRACT; jobIds: string[]; rows: number;
  rowByteSetSha256: string; dependencyForeignKey: string | null }
/** Every job row naming the original as its dependency, bounded one past the cap. */
export const DEPENDENT_ROWS_SQL = `SELECT j.id::text id,to_jsonb(j)::text bytes FROM public.engine_v3_job_runs j
  WHERE j.dependency_run_id=$1::uuid AND j.id<>$1::uuid ORDER BY j.id LIMIT ${TERMINAL_NOOP_DEPENDENT.maxPerOriginal + 1}`;
const JOB_SELF_FK_SQL = `SELECT con.conname::text "name",array_agg(ca.attname::text ORDER BY k.ord) "childColumns",
  array_agg(pa.attname::text ORDER BY k.ord) "parentColumns" FROM pg_constraint con
  JOIN pg_class child ON child.oid=con.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
  JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
  CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(child_key,parent_key,ord)
  JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=k.child_key JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.parent_key
  WHERE con.contype='f' AND cn.nspname='public' AND pn.nspname='public' AND child.relname='engine_v3_job_runs' AND parent.relname='engine_v3_job_runs'
  GROUP BY con.oid,con.conname ORDER BY con.conname`;

/** Pure classification of the census job_dependencies class. The census sums
 * every job_dependencies FK edge (job_runs self-FK, lifecycle_daily) AND a
 * separate explicit dependency_run_id count, so with the self-FK each dependent
 * is counted twice. Exactly that arithmetic must hold; any other nonzero edge,
 * count, bound, or a row that is not the typed terminal NO-OP record vetoes. */
export function classifyTerminalNoopDependents(input: { census: PinCensus; generation: NativeArchiveGeneration; observedAt: string;
  selfForeignKeys: { name: string; childColumns: string[]; parentColumns: string[] }[]; dependents: { id: string; bytes: string }[] }): RetainedDependents {
  const fail = (ok: unknown, reason: string) => { if (!ok) throw new BatchRefusal(`RETAINED_PIN_VETO:job_dependencies:${reason}`); };
  const g = input.generation, observed = Date.parse(input.observedAt), n = BigInt(input.dependents.length);
  fail(Number.isFinite(observed), "clock");
  fail(input.dependents.length <= TERMINAL_NOOP_DEPENDENT.maxPerOriginal, "bound");
  const dependencyFks = input.selfForeignKeys.filter(f => same(f.childColumns, ["dependency_run_id"]) && same(f.parentColumns, ["id"]));
  fail(dependencyFks.length <= 1, "catalog");
  const fk = dependencyFks[0]?.name ?? null;
  const edges = input.census.foreignKeyReferences.filter(e => e.pinClass === "job_dependencies");
  const dependencyEdge = (e: (typeof edges)[number]) => fk !== null && e.constraint === fk && e.childSchema === "public" &&
    e.parentSchema === "public" && e.childTable === "engine_v3_job_runs" && e.parentTable === "engine_v3_job_runs";
  fail(edges.every(e => e.count === "0" || dependencyEdge(e)), "foreign_edge");
  const total = input.census.counts.find(c => c.pinClass === "job_dependencies")?.count;
  fail(typeof total === "string" && /^(0|[1-9][0-9]*)$/.test(total), "unexplained_count");
  const fkCounted = edges.reduce((sum, e) => sum + BigInt(e.count), BigInt(0)), own = edges.filter(dependencyEdge);
  fail(BigInt(total!) - fkCounted === n && (fk === null ? own.length === 0 : own.length === 1 && BigInt(own[0]!.count) === n), "unexplained_count");
  const settled = observed - TERMINAL_NOOP_DEPENDENT.minAgeMs, ids = input.dependents.map(d => d.id);
  for (const d of input.dependents) {
    const r = parse(d.bytes), at = (v: unknown) => typeof v === "string" ? Date.parse(v) : NaN;
    const clocks = [r.started_at, r.finished_at, r.created_at, r.updated_at].map(at);
    fail(UUID.test(d.id) && r.id === d.id && r.job_name === TERMINAL_NOOP_DEPENDENT.jobName && r.status === TERMINAL_NOOP_DEPENDENT.status &&
      r.row_count === 0 && r.error_message === TERMINAL_NOOP_DEPENDENT.errorMessage && r.error_code === null && r.error_json === null &&
      r.retry_count === 0 && r.input_hash === null && r.source_min_date === null && r.source_max_date === null && r.source_max_updated_at === null &&
      r.business_ref_id === g.businessId && r.business_id === g.businessId && r.as_of_date === g.asOfDate &&
      r.engine_version === g.engineVersion && r.dependency_run_id === g.jobRunId &&
      clocks.every(c => Number.isFinite(c) && c <= settled) && clocks[0]! <= clocks[1]!, "unqualified_dependent");
  }
  fail(same(ids, [...new Set(ids)].sort()), "unqualified_dependent");
  return { contract: RETAINED_DEPENDENTS_CONTRACT, jobIds: ids, rows: ids.length,
    rowByteSetSha256: rowSetHash(input.dependents.map(d => d.bytes)), dependencyForeignKey: fk };
}
/** Census veto in the caller's READ ONLY snapshot. job_dependencies is never a
 * blanket pass: it is exactly the classified terminal NO-OP dependents, or a veto. */
export async function censusVeto(read: (sql: string, values?: unknown[]) => Promise<{ rows: any[] }>, census: PinCensus,
  generation: NativeArchiveGeneration, observedAt: string) {
  need(census.unknownReferences.length === 0, "UNKNOWN_CONSUMER_VETO");
  const assessment = assessNativeArchivePins(census, census.generation);
  need(assessment.unclassifiedLiveReferences.length === 0, "UNKNOWN_CONSUMER_VETO");
  const count = (c: string) => census.counts.find(x => x.pinClass === c)?.count;
  need(count("snapshots") === "0", "RETAINED_SNAPSHOT_VETO");
  need(count("action_lineage") === "0", "RETAINED_ACTION_VETO");
  need(count("reuse_attempts") === "0", "RETAINED_REUSE_VETO");
  // Retained parents (job row, shared input evidence) stay; every other live class vetoes.
  for (const c of ["outcomes", "episodes", "assignments", "events"]) need(count(c) === "0", `RETAINED_PIN_VETO:${c}`);
  const selfForeignKeys = (await read(JOB_SELF_FK_SQL)).rows;
  const dependents = (await read(DEPENDENT_ROWS_SQL, [generation.jobRunId])).rows;
  return { assessment, dependents: classifyTerminalNoopDependents({ census, generation, observedAt, selfForeignKeys, dependents }) };
}

/** One complete RO measurement + bundle. Throws a stable veto code. */
export async function collectWholeOriginal(db: Q, input: CaptureInput) {
  const g = input.generation;
  // D149: archive-engine eligibility BEFORE any source statement (no evaluation/context materialization); the receipt
  // check below then binds the actual successful job row to this exact supported engine.
  const engineVeto = archiveEngineVeto(g?.engineVersion);
  if (engineVeto) throw new BatchRefusal(engineVeto);
  need(/^[a-f0-9]{40}$/.test(input.sourceRevision) && /^[a-f0-9]{64}$/.test(input.consumerInventorySha256), "EXACT_SOURCE_IDENTITY");
  need(Number.isInteger(input.expectedEvaluations) && input.expectedEvaluations > 0 && input.expectedEvaluations <= cap.evaluations &&
    Number.isInteger(input.expectedContexts) && input.expectedContexts > 0 && input.expectedContexts <= cap.contexts, "FINITE_ORIGINAL_POPULATION");
  const source = readOnlyAdapter(db);
  let encoded = 0, began = false;
  const deadline = Date.now() + cap.wholeMs;
  const q = (sql: string, values?: unknown[]) => { need(Date.now() < deadline, "SOURCE_WHOLE_DEADLINE"); return source.query(sql, values); };
  const rows = async (query: string, values: unknown[], rowCap: number) => {
    const size = (await q(`SELECT count(*)::text n,coalesce(sum(octet_length(to_jsonb(r.bytes)::text)),0)::text bytes FROM (${query}) r`, values)).rows[0];
    need(size && /^\d+$/.test(size.n) && /^\d+$/.test(size.bytes), "SCALAR_SIZE_MISSING");
    need(Number(size.n) <= rowCap && encoded + Number(size.bytes) <= cap.encodedRows, "DECLARED_ROW_OR_BYTE_CAP");
    encoded += Number(size.bytes);
    const actual = (await q(query, values)).rows.map(r => r.bytes as string);
    need(actual.length === Number(size.n) && actual.every(x => typeof x === "string"), "SAME_SNAPSHOT_ROW_COUNT");
    return actual;
  };
  try {
    await q("BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY"); began = true;
    await q("SET LOCAL statement_timeout='7500ms'"); await q("SET LOCAL lock_timeout='1000ms'"); await q("SET LOCAL timezone='UTC'");
    const mode = (await q(`SELECT current_setting('transaction_read_only') readonly,current_setting('transaction_isolation') isolation,transaction_timestamp()::text observed`)).rows[0];
    need(mode?.readonly === "on" && mode.isolation === "repeatable read", "READONLY_RR_BOUND");
    const jobRows = await rows(`SELECT to_jsonb(j)::text bytes FROM public.engine_v3_job_runs j WHERE j.id=$1::uuid LIMIT 2`, [g.jobRunId], 1);
    need(jobRows.length === 1, "ORIGINAL_JOB_MISSING");
    const job = parse(jobRows[0]!);
    need(job.status === "success" && job.job_name === NATIVE_JOB && job.row_count === input.expectedEvaluations &&
      job.business_ref_id === g.businessId && job.business_id === g.businessId && job.as_of_date === g.asOfDate &&
      job.engine_version === g.engineVersion && typeof job.finished_at === "string", "ORIGINAL_SUCCESSFUL_RECEIPT");
    need(Date.parse(mode.observed) >= Date.parse(`${g.asOfDate}T00:00:00Z`) + CLOSED_DAY_BUFFER_MS, "CURRENT_DAY_VETO");
    const later = (await q(`SELECT count(*)::text n FROM public.engine_v3_job_runs l WHERE l.business_ref_id=$1::uuid AND l.business_id=$1::text AND l.engine_version=$2 AND l.job_name=$3 AND l.status='success' AND l.as_of_date>$4::date AND l.finished_at>$5::timestamptz`,
      [g.businessId, g.engineVersion, NATIVE_JOB, g.asOfDate, job.finished_at])).rows[0];
    need(Number(later?.n) > 0, "SUBSEQUENT_DISTINCT_DAY_SUCCESS_REQUIRED");
    const { fingerprint } = await readTargetCatalog(async (sql, values) => (await q(sql, values)).rows);
    const unit = await readNativeEvaluationContextUnit(source, { schema: "public", generation: g,
      consumerInventorySha256: input.consumerInventorySha256, unmodeledConsumers: [DECLARED_CLOSURE_GAP] });
    unitVeto(unit, input.expectedEvaluations); assessNativeEvaluationContextUnit(unit, g);
    const census = await readNativeArchivePinCensus(source, { schema: "public", generation: g, unmodeledReferences: [] });
    const { dependents: retainedDependents } = await censusVeto(q, census, g, mode.observed);
    const evalSelection = await readNativeJobEvaluationSelection(source, "public");
    need(evalSelection.route === "validated_context_lineage", "ENFORCED_EVALUATION_LINEAGE_REQUIRED");
    const evaluationRows = await rows(`SELECT to_jsonb(e)::text bytes FROM (${evalSelection.sql}) e
      JOIN public.engine_v3_job_runs j ON e.job_run_id=j.id AND e.business_ref_id=j.business_ref_id
        AND e.business_id=j.business_id AND e.as_of_date=j.as_of_date AND e.engine_version=j.engine_version
      WHERE j.id=$1::uuid LIMIT 1135`, [g.jobRunId], cap.evaluations);
    need(evaluationRows.length === input.expectedEvaluations, "FULL_ORIGINAL_EVALUATIONS");
    const evaluations = evaluationRows.map(parse);
    const contextIds = distinct(evaluations.map(x => x.context_id as string));
    need(contextIds.length === input.expectedContexts, "WHOLE_UNIT_SCOPE_MISMATCH:CONTEXTS");
    const contextRows = await rows(`SELECT to_jsonb(c)::text bytes FROM public.engine_v3_ad_decision_evaluation_contexts c WHERE c.id=ANY($1::uuid[]) LIMIT 5`, [contextIds], cap.contexts);
    need(contextRows.length === contextIds.length, "COMPLETE_CONTEXTS");
    const contracts = evaluations.map(x => x.contract_version as string), hashes = evaluations.map(x => x.input_hash as string);
    need(hashes.every(h => typeof h === "string" && /^[0-9a-f]{64}$/.test(h)) && contracts.every(c => typeof c === "string" && c.length > 0), "INPUT_ROOT_KEY_TYPES");
    const inputRows = await rows(`SELECT DISTINCT to_jsonb(i)::text bytes FROM public.engine_v3_ad_decision_input_evidence i
      JOIN unnest($1::text[],$2::character(64)[]) keys(contract_version,input_hash)
      ON i.contract_version=keys.contract_version AND i.input_hash=keys.input_hash LIMIT 1135`, [contracts, hashes], cap.evaluations);
    // D150: every frozen key has exactly its one full evidence row, frozen per key; the input table has no concrete consumer.
    const inputKeys = distinct(evaluations.map(x => JSON.stringify([x.contract_version, x.input_hash]))).sort();
    const inputByKey = new Map(inputRows.map(raw => { const r = parse(raw); return [JSON.stringify([r.contract_version, r.input_hash]), raw] as const; }));
    need(inputByKey.size === inputRows.length && inputRows.length === inputKeys.length && inputKeys.every(k => inputByKey.has(k)),
      "INCOMPLETE_ORIGINAL_INPUT_EVIDENCE");
    const inputCatalog = await readInputEvidenceCatalog(q);
    const snapshotSelection = await readNativeJobSnapshotSelection(source, "public");
    need(snapshotSelection.route === "validated_evaluation_lineage", "ENFORCED_SNAPSHOT_LINEAGE_REQUIRED");
    const snapshotRows = await rows(`SELECT to_jsonb(s)::text bytes FROM (${snapshotSelection.sql}) s LIMIT 1135`, [g.jobRunId], cap.evaluations);
    need(snapshotRows.length === 0, "RETAINED_SNAPSHOT_VETO");
    const objectHashes = distinct(evaluations.map(x => x.campaign_context_ref).filter(x => x !== null)) as string[];
    need(objectHashes.length <= cap.objects && objectHashes.every(x => typeof x === "string" && /^\\x[a-f0-9]{64}$/.test(x)), "ORIGINAL_BYTEA_CONTEXT_KEYS");
    const objectRows = await rows(`SELECT to_jsonb(raw)::text AS bytes FROM unnest($2::bytea[]) AS key(digest) CROSS JOIN LATERAL
      (SELECT o.* FROM public.engine_v3_ad_campaign_context_objects o WHERE o.business_ref_id=$1::uuid AND o.payload_sha256=key.digest OFFSET 0) raw`,
      [g.businessId, objectHashes.map(x => Buffer.from(x.slice(2), "hex"))], cap.objects);
    need(objectRows.length === objectHashes.length, "COMPLETE_ORIGINAL_SHARED_OBJECTS");
    const names = distinct([...NATIVE_REFERENCE_ARCHIVE_TABLES, ...NATIVE_CALIBRATION_PARENT_TABLES]) as string[];
    const columns = (await q(`SELECT c.relname "table",a.attname name,format_type(a.atttypid,a.atttypmod) type,NOT a.attnotnull nullable FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid WHERE n.nspname='public' AND c.relname=ANY($1::text[]) AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [names])).rows;
    const foreignKeys = (await q(`SELECT child.relname "childTable",parent.relname "parentTable",pg_get_constraintdef(con.oid) definition FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace n ON n.oid=child.relnamespace WHERE n.nspname='public' AND child.relname=ANY($1::text[]) AND con.contype='f' ORDER BY child.relname,con.conname`, [names])).rows;
    const schemaFor = <T extends string>(tables: readonly T[]) => ({ tables: tables.map(table => ({ table,
      columns: columns.filter(c => c.table === table).map(({ name, type, nullable }) => ({ name, type, nullable })) })), foreignKeys });
    const coreRows: Record<string, string[]> = { engine_v3_job_runs: jobRows, [CONTEXT]: contextRows, [EVAL]: evaluationRows,
      engine_v3_ad_decision_input_evidence: inputRows, engine_v3_ad_decision_snapshots_daily: snapshotRows,
      engine_v3_ad_campaign_context_objects: objectRows };
    const tables = NATIVE_REFERENCE_ARCHIVE_TABLES.map(table => ({ table, rowJson: coreRows[table]! }));
    const core = buildNativeSupersededReferenceEvidenceArchive({ generation: g, capturedAt: census.observedAt,
      sourceRevision: input.sourceRevision, sourceWorkspaceDirty: false,
      schema: schemaFor(NATIVE_REFERENCE_ARCHIVE_TABLES) as NativeArchiveSchema, tables, pinCensus: census });
    const batchRows: string[] = [];
    for (const raw of contextRows) {
      const ctx = parse(raw), calibration = ctx.context_json?.dataHealth?.calibration;
      need(calibration && (calibration.computedAt === null || typeof calibration.computedAt === "string"), "ORIGINAL_CALIBRATION_IDENTITY");
      if (calibration.computedAt === null) continue;
      const found = await rows(`SELECT to_jsonb(b)::text bytes FROM public.engine_v3_ad_account_calibration_batches b WHERE b.business_ref_id=$1::uuid AND b.provider_account_ref_id=$2::uuid AND b.provider_account_id=$3 AND b.as_of_date=$4::date AND b.engine_version=$5 AND b.computed_at=$6::timestamptz LIMIT 2`,
        [g.businessId, ctx.provider_account_ref_id, ctx.provider_account_id, calibration.asOfDate, g.engineVersion, calibration.computedAt], 1);
      need(found.length === 1, "MISSING_AMBIGUOUS_ORIGINAL_BATCH");
      if (!batchRows.includes(found[0]!)) batchRows.push(found[0]!);
    }
    need(batchRows.length <= cap.batches, "BATCH_CAP");
    const batches = batchRows.map(parse);
    const cells = await rows(`SELECT to_jsonb(d)::text bytes FROM public.engine_v3_ad_account_calibration_daily d WHERE d.batch_id=ANY($1::uuid[]) LIMIT 1001`, [batches.map(x => x.id)], cap.cells);
    need(batches.reduce((n, x) => n + Number(x.expected_cell_count), 0) === cells.length, "COMPLETE_ORIGINAL_CELL_COUNT");
    const parentJobIds = distinct([...batches.map(x => x.job_run_id as string), job.dependency_run_id as string].filter(Boolean));
    const parentJobs = await rows(`SELECT to_jsonb(j)::text bytes FROM public.engine_v3_job_runs j WHERE j.id=ANY($1::uuid[]) LIMIT 17`, [parentJobIds], cap.parentJobs);
    need(parentJobs.length === parentJobIds.length && !parentJobIds.includes(g.jobRunId), "ALL_ORIGINAL_PRODUCER_AND_DEPENDENCY_RECEIPTS");
    const parentRows: Record<string, string[]> = { engine_v3_ad_account_calibration_batches: batchRows,
      engine_v3_ad_account_calibration_daily: cells, engine_v3_job_runs: parentJobs };
    const parents = buildNativeCalibrationParentArchive({ core: core.bundle, coreManifestHash: core.manifestHash,
      schema: schemaFor(NATIVE_CALIBRATION_PARENT_TABLES) as never,
      tables: NATIVE_CALIBRATION_PARENT_TABLES.map(table => ({ table, rowJson: parentRows[table]! })) });
    need(Buffer.byteLength(JSON.stringify(parents.bundle)) <= cap.plaintext, "SERIALIZED_ORIGINAL_CAP");
    const tableRows: Record<UnitTable, string[]> = { engine_v3_job_runs: [...jobRows, ...parentJobs], [CONTEXT]: contextRows,
      [EVAL]: evaluationRows, engine_v3_ad_decision_input_evidence: inputRows, engine_v3_ad_decision_snapshots_daily: snapshotRows,
      engine_v3_ad_campaign_context_objects: objectRows, engine_v3_ad_account_calibration_batches: batchRows,
      engine_v3_ad_account_calibration_daily: cells } as Record<UnitTable, string[]>;
    const config: UnitConfig = { contract: UNIT_CONFIG_CONTRACT, generation: { ...g },
      evaluations: evaluations.length, contexts: contextIds.length,
      evaluationIds: evaluations.map(x => x.id as string).sort(), contextIds: [...contextIds].sort(),
      inputKeys: inputKeys.map(x => JSON.parse(x)),
      campaignObjectHashes: [...objectHashes].sort(),
      jobIds: [g.jobRunId, ...parentJobIds].sort(), batchIds: batches.map(x => x.id as string).sort(),
      cellIds: cells.map(raw => parse(raw).id as string).sort(),
      tableHashes: Object.fromEntries(UNIT_TABLES.map(t => [t, { rows: tableRows[t].length, rowByteSetSha256: rowSetHash(tableRows[t]) }])) as UnitConfig["tableHashes"],
      evaluationRowSha256: Object.fromEntries(evaluationRows.map(raw => [parse(raw).id, sha256(raw)]).sort()),
      jobFinishedAt: job.finished_at, schemaHash: parents.bundle.manifest.schemaHash, catalogFingerprint: fingerprint,
      consumerInventorySha256: input.consumerInventorySha256, retainedDependents,
      inputEvidence: { lifecycle: INPUT_EVIDENCE_LIFECYCLE, rowSha256: inputKeys.map(k => sha256(inputByKey.get(k)!)),
        catalogFingerprint: inputCatalog.fingerprint } };
    need(config.inputKeys.length > 0 && config.evaluationIds.length === new Set(config.evaluationIds).size, "EXACT_ORIGINAL_UUID_SET");
    const identities = evaluations.map(x => ({ evaluationId: x.id as string, providerAccountId: x.provider_account_id as string, adId: x.ad_id as string }));
    await q("ROLLBACK"); began = false;
    return { config, proofSha256: canonicalSha(config), bundle: parents.bundle as NativeCalibrationParentBundle,
      manifestHash: parents.manifestHash, schemaHash: parents.bundle.manifest.schemaHash, identities, encodedRows: encoded };
  } catch (error) {
    if (began) await db.query("ROLLBACK").catch(() => undefined);
    if (error instanceof BatchRefusal) throw error;
    const message = error instanceof Error ? error.message : "";
    // Library refusals carry static reason strings only (no values); keep them visible.
    throw new BatchRefusal(/^Native (evaluation unit|pin census|selection) refused/.test(message) ?
      `LIBRARY_UNIT_REFUSED:${message.replace(/^[^:]*:\s*/, "").toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 80)}` :
      (error as { code?: string })?.code === "57014" ? "SOURCE_STATEMENT_TIMEOUT_57014" : "SOURCE_CAPTURE_REFUSED");
  }
}

export interface SealedPart { ciphertextSha256: string; ciphertextBytes: number; trustSha256: string; firstEvaluationId: string; lastEvaluationId: string }
/** After ROLLBACK: split, exact reassembly, seal every part, decrypt-verify,
 * persist copy A (served object store) and copy B (independent private copy),
 * build the complete v3 leaf. The key never leaves this function. */
/** After ROLLBACK, in memory only: split, exact reassembly, seal every part,
 * decrypt-verify, build the complete v3 leaf (content-addressed local object
 * pointers). No file, no key output. */
export function sealWholeOriginal(collected: Awaited<ReturnType<typeof collectWholeOriginal>>, keyId: string, key: Buffer) {
  need(key.length === 32 && /^[a-zA-Z0-9._-]{1,80}$/.test(keyId), "SEPARATE_ENCRYPTION_KEY_REQUIRED");
  const g = collected.config.generation;
  const expected = { manifestHash: collected.manifestHash, schemaHash: collected.schemaHash, generation: g };
  const split = splitNativeReferenceArchive(collected.bundle, expected);
  need(split.parts.length > 0 && split.parts.length <= 128, "FINITE_COMPLETE_ORIGINAL_SEGMENTS");
  const re = reassembleNativeReferenceArchive(split.parts.map(p => p.bundle), split.root, split.rootDigest);
  need(canonical(re.bundle) === canonical(collected.bundle), "FULL_ORIGINAL_REASSEMBLY_PARITY");
  const entries: Record<string, unknown>[] = [], parts: SealedPart[] = [], sealedParts: { bytes: Buffer; trust: NativeHistoricalArchiveContentTrust; trustBytes: Buffer }[] = [];
  let archiveBytes = 0;
  for (const part of split.parts) {
    const ids = part.bundle.core.manifest.segment!.evaluationIds;
    const sealed = sealCompressedNativeHistoricalArchive(part.bundle, { manifestHash: part.manifestHash,
      schemaHash: part.bundle.manifest.schemaHash, generation: g }, keyId, key,
      { coverageRoot: split.root, coverageRootSha256: split.rootDigest, evaluationIds: ids });
    need(sealed.trust.plaintextBytes <= 8 * 1024 * 1024 && sealed.bytes.length <= 2 * 1024 * 1024, "UNCHANGED_PER_SEGMENT_TRANSPORT_BOUND");
    const opened = openNativeHistoricalArchiveEnvelope(sealed.bytes, sealed.trust, key, g);
    need(canonical(opened.bundle) === canonical(part.bundle) && opened.view.providerAuthority === false, "SEALED_PART_PARITY");
    const trustBytes = Buffer.from(JSON.stringify(sealed.trust)), version = nativeHistoricalArchiveStorageVersion(sealed.trust);
    const object = { bucket: NATIVE_LOCAL_ARCHIVE_BUCKET, key: `native/${version}/${sealed.trust.ciphertextSha256}.bin`, versionId: sealed.trust.ciphertextSha256 };
    const segment = sealed.trust.segment!;
    entries.push({ ...sealed.trust, segment: { coverageRootSha256: segment.coverageRootSha256, evaluationIds: segment.evaluationIds }, object });
    parts.push({ ciphertextSha256: sealed.trust.ciphertextSha256, ciphertextBytes: sealed.bytes.length,
      trustSha256: sha256(trustBytes), firstEvaluationId: ids[0]!, lastEvaluationId: ids[ids.length - 1]! });
    sealedParts.push({ bytes: Buffer.from(sealed.bytes), trust: sealed.trust, trustBytes });
    archiveBytes += sealed.bytes.length;
  }
  const leaf = Buffer.from(JSON.stringify({ contract: NATIVE_HISTORICAL_SEGMENTED_CATALOG_CONTRACT,
    groups: [{ coverageRoot: split.root, coverageRootSha256: split.rootDigest }], entries }));
  const leafSha256 = sha256(leaf);
  const catalog = openImmutableNativeHistoricalArchiveCatalog(leaf, leafSha256);
  need(new Set(catalog.entries.flatMap(e => e.segment!.evaluationIds)).size === collected.config.evaluations, "COMPLETE_LEAF_MEMBERSHIP");
  const metadata: CaptureMetadata = { contract: "finite-native-storage-capture.v1", generation: g, proofSha256: collected.proofSha256,
    manifestHash: collected.manifestHash, schemaHash: collected.schemaHash, coverageRoot: split.root,
    coverageRootSha256: split.rootDigest, parts, leafSha256, leafBytes: leaf.length, archiveBytes };
  return { metadata, sealedParts, leaf };
}
export interface CaptureMetadata { contract: "finite-native-storage-capture.v1"; generation: NativeArchiveGeneration; proofSha256: string;
  manifestHash: string; schemaHash: string; coverageRoot: unknown; coverageRootSha256: string; parts: SealedPart[];
  leafSha256: string; leafBytes: number; archiveBytes: number }
/** One complete private encrypted copy: every part + trust, the leaf, capture metadata (EXCL, fsync). */
export async function persistPrivateCopy(directory: string, sealed: ReturnType<typeof sealWholeOriginal>) {
  await privateDirectory(directory);
  for (const part of sealed.sealedParts) {
    need(sha256(part.bytes) === part.trust.ciphertextSha256 && part.bytes.length === part.trust.ciphertextBytes, "EXACT_ENCRYPTED_PART_BYTES");
    await writeExclusive(join(directory, `${part.trust.ciphertextSha256}.bin`), part.bytes);
    await writeExclusive(join(directory, `${part.trust.ciphertextSha256}.trust.json`), part.trustBytes);
  }
  need(sha256(sealed.leaf) === sealed.metadata.leafSha256, "EXACT_LEAF_BYTES");
  await writeExclusive(join(directory, `leaf-${sealed.metadata.leafSha256}.json`), sealed.leaf);
  await writeExclusive(join(directory, "capture.json"), JSON.stringify(sealed.metadata));
}
/** OWNED: served copy A in the local object store + private copy B. */
export async function sealAndPersist(collected: Awaited<ReturnType<typeof collectWholeOriginal>>, keyId: string, key: Buffer,
  archiveRoot: string, copyDirectory: string) {
  const sealed = sealWholeOriginal(collected, keyId, key);
  for (const part of sealed.sealedParts) {
    const served = await persistLocalNativeArchive(archiveRoot, part.bytes, part.trust);
    need(served.object.bucket === NATIVE_LOCAL_ARCHIVE_BUCKET && served.object.key === `native/v2/${part.trust.ciphertextSha256}.bin`, "LOCAL_SERVED_OBJECT");
  }
  await persistPrivateCopy(copyDirectory, sealed);
  return sealed.metadata;
}
/** Production parent: both PRIVATE copies (primary + recovery) re-read, equal,
 * decrypted with the operator-held key and reassembled to the original manifest. */
export async function verifyPrivateCopies(metadata: CaptureMetadata, key: Buffer, directories: [string, string]) {
  const decrypted: NativeCalibrationParentBundle[] = [];
  for (const part of metadata.parts) {
    const copies = await Promise.all(directories.map(d => readExact(join(d, `${part.ciphertextSha256}.bin`), 2 * 1024 * 1024 + 128)));
    const trusts = await Promise.all(directories.map(d => readExact(join(d, `${part.ciphertextSha256}.trust.json`), 1024 * 1024)));
    need(copies.every(c => sha256(c) === part.ciphertextSha256 && c.length === part.ciphertextBytes) &&
      trusts.every(t => sha256(t) === part.trustSha256), "ROOT_OR_CIPHER_COPY_MISMATCH");
    const trust = JSON.parse(trusts[0]!.toString("utf8")) as NativeHistoricalArchiveContentTrust;
    need(trust.segment?.coverageRootSha256 === metadata.coverageRootSha256, "ROOT_OR_CIPHER_COPY_MISMATCH");
    decrypted.push(openNativeHistoricalArchiveEnvelope(copies[0]!, trust, key, metadata.generation).bundle);
  }
  for (const d of directories) {
    need(sha256(await readExact(join(d, `leaf-${metadata.leafSha256}.json`), 944 * 1024)) === metadata.leafSha256 &&
      canonical(JSON.parse((await readExact(join(d, "capture.json"), 4 * 1024 * 1024)).toString("utf8"))) === canonical(metadata), "ROOT_OR_CIPHER_COPY_MISMATCH");
  }
  const whole = reassembleNativeReferenceArchive(decrypted, metadata.coverageRoot as never, metadata.coverageRootSha256);
  need(whole.manifestHash === metadata.manifestHash, "ROOT_OR_CIPHER_COPY_MISMATCH");
  return whole;
}

/** Re-reads BOTH complete copies (served object store + private copy), checks
 * digests, decrypts every part and verifies whole-original reassembly. */
export async function verifyCopies(metadata: { generation: NativeArchiveGeneration; coverageRoot: unknown; coverageRootSha256: string;
  manifestHash: string; parts: SealedPart[]; leafSha256: string }, key: Buffer, archiveRoot: string, copyDirectory: string) {
  const decrypted: NativeCalibrationParentBundle[] = [];
  for (const part of metadata.parts) {
    const a = await readExact(join(archiveRoot, "native/v2", `${part.ciphertextSha256}.bin`), 2 * 1024 * 1024 + 128);
    const b = await readExact(join(copyDirectory, `${part.ciphertextSha256}.bin`), 2 * 1024 * 1024 + 128);
    const trustBytes = await readExact(join(copyDirectory, `${part.ciphertextSha256}.trust.json`), 1024 * 1024);
    need(sha256(a) === part.ciphertextSha256 && sha256(b) === part.ciphertextSha256 && a.length === part.ciphertextBytes &&
      sha256(trustBytes) === part.trustSha256, "ROOT_OR_CIPHER_COPY_MISMATCH");
    const trust = JSON.parse(trustBytes.toString("utf8")) as NativeHistoricalArchiveContentTrust;
    need(trust.segment?.coverageRootSha256 === metadata.coverageRootSha256, "ROOT_OR_CIPHER_COPY_MISMATCH");
    decrypted.push(openNativeHistoricalArchiveEnvelope(b, trust, key, metadata.generation).bundle);
  }
  const leaf = await readExact(join(copyDirectory, `leaf-${metadata.leafSha256}.json`), 944 * 1024);
  need(sha256(leaf) === metadata.leafSha256, "ROOT_OR_CIPHER_COPY_MISMATCH");
  const whole = reassembleNativeReferenceArchive(decrypted, metadata.coverageRoot as never, metadata.coverageRootSha256);
  need(whole.manifestHash === metadata.manifestHash, "ROOT_OR_CIPHER_COPY_MISMATCH");
  return whole;
}
export const readCaptureMetadata = async (copyDirectory: string) =>
  JSON.parse((await readFile(join(copyDirectory, "capture.json"))).toString("utf8"));
export type { NativeArchiveTable };
