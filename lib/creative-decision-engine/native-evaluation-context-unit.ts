import { createHash } from "node:crypto";
import type { NativeArchiveGeneration } from "./native-evidence-archive";
import { readNativeJobEvaluationSelection } from "./native-job-evaluation-selection";

/** SELECT-only preparation; the original ledger, shared evidence and parents stay live.
 * This narrower unit is distinct from the five-table archival copy and its whole-core pin veto.
 * No production caller, exporter, delete executor or physical-maintenance permission. */
export const NATIVE_EVALUATION_UNIT_CONTRACT = "native-evaluation-context-measurement.v1" as const;
const EVAL = "engine_v3_ad_decision_evaluations";
const CONTEXT = "engine_v3_ad_decision_evaluation_contexts";
const INTERNAL_CHILD_COLUMNS = ["context_id","business_ref_id","business_id","provider_account_ref_id",
  "provider_account_id","as_of_date","engine_version","scope_type","scope_id","contract_version","job_run_id"];
const INTERNAL_PARENT_COLUMNS = ["id",...INTERNAL_CHILD_COLUMNS.slice(1)];
const NON_FK = ["action_lineage", "workflow_state", "workflow_events", "proposal_identity", "launch_handoff_possible_identity"] as const;
type NonFkClass = typeof NON_FK[number];
interface Reader { query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>; }
interface Edge {
  childSchema: string; childTable: string; constraint: string; parentTable: string;
  childColumns: string[]; parentColumns: string[]; count: string; internalSelectedMembership: boolean;
}
export interface NativeEvaluationContextMeasurement {
  contract: typeof NATIVE_EVALUATION_UNIT_CONTRACT;
  generation: NativeArchiveGeneration; observedAt: string; jobFinishedAt: string;
  originalJobRowCount: string; evaluationCount: string; selectedContextCount: string;
  contextSharingCount: string; incomingReferences: Edge[];
  nonFkCounts: { pinClass: NonFkClass; count: string }[];
  unknownReferences: string[]; schemaHash: string; consumerInventorySha256: string;
  retainedRoots: readonly ["original_jobs", "calibration_parents", "shared_input_evidence", "provider_roots"];
  providerAuthority: false; reclaimEligible: false;
}
function refuse(reason: string): never { throw new Error(`Native evaluation unit refused: ${reason}`); }
function id(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) refuse("invalid catalog identifier");
  return `"${value}"`;
}
function exact(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) refuse("invalid exact count");
  return value;
}
function sha(value: unknown): string {
  if (typeof value !== "string" || !/^[a-f0-9]{64}$/.test(value)) refuse("missing pinned consumer inventory");
  return value;
}
function sameGeneration(a: NativeArchiveGeneration, b: NativeArchiveGeneration): boolean {
  return a.businessId === b.businessId && a.jobRunId === b.jobRunId &&
    a.asOfDate === b.asOfDate && a.engineVersion === b.engineVersion;
}
export function assessNativeEvaluationContextUnit(value: NativeEvaluationContextMeasurement,
  generation: NativeArchiveGeneration) {
  if (value.contract !== NATIVE_EVALUATION_UNIT_CONTRACT || !sameGeneration(value.generation, generation) ||
      value.providerAuthority !== false || value.reclaimEligible !== false ||
      !Number.isFinite(Date.parse(value.observedAt)) || !Number.isFinite(Date.parse(value.jobFinishedAt)) ||
      Date.parse(value.jobFinishedAt) > Date.parse(value.observedAt)) refuse("contract/identity/clock mismatch");
  sha(value.schemaHash); sha(value.consumerInventorySha256);
  if (JSON.stringify(value.retainedRoots) !== JSON.stringify([
    "original_jobs", "calibration_parents", "shared_input_evidence", "provider_roots",
  ])) refuse("retained root contract mismatch");
  if (exact(value.originalJobRowCount) !== exact(value.evaluationCount) || value.evaluationCount === "0" ||
      BigInt(value.evaluationCount) > BigInt(10000) || exact(value.selectedContextCount) === "0")
    refuse("incomplete or unsupported generation");
  exact(value.contextSharingCount);
  const classes = new Map(value.nonFkCounts.map(x => [x.pinClass, exact(x.count)]));
  if (value.nonFkCounts.length !== NON_FK.length || classes.size !== NON_FK.length ||
      NON_FK.some(x => !classes.has(x)) || value.unknownReferences.some(x => typeof x !== "string" || !x.trim()))
    refuse("incomplete reference inventory");
  const seen = new Set<string>();
  for (const edge of value.incomingReferences) {
    const key = JSON.stringify([edge.childSchema, edge.childTable, edge.constraint]);
    if (seen.has(key) || !edge.childColumns.length || edge.childColumns.length !== edge.parentColumns.length ||
        ![EVAL, CONTEXT].includes(edge.parentTable)) refuse("invalid incoming FK inventory");
    seen.add(key); exact(edge.count);
    if (edge.internalSelectedMembership && !(edge.childTable === EVAL && edge.parentTable === CONTEXT &&
        JSON.stringify(edge.childColumns) === JSON.stringify(INTERNAL_CHILD_COLUMNS) &&
        JSON.stringify(edge.parentColumns) === JSON.stringify(INTERNAL_PARENT_COLUMNS) &&
        edge.count === value.evaluationCount))
      refuse("unsupported internal edge");
  }
  const fkPins = value.incomingReferences.filter(x => !x.internalSelectedMembership && x.count !== "0");
  if (!value.incomingReferences.some(x => x.internalSelectedMembership)) refuse("internal lineage inventory absent");
  const jsonPins = value.nonFkCounts.filter(x => x.count !== "0");
  const unknown = value.unknownReferences.length > 0;
  const pinFree = !unknown && !fkPins.length && !jsonPins.length && value.contextSharingCount === "0";
  return { pinFreeWithinMeasuredScope: pinFree,
    reason: unknown ? "unsupported_reference_inventory" : pinFree ? "pin_free_measured_scope" : "retained_reference",
    fkPins, nonFkPins: jsonPins, providerAuthority: false as const, reclaimEligible: false as const,
    productionConsumerClosureProved: false as const, physicalBytesReclaimed: "0" };
}

/** A pinned READ ONLY REPEATABLE READ transaction is mandatory. Each separate SELECT
 * needs <=7.5s SQL timeout. The caller owns pool/outer deadline, cancellation and ROLLBACK.
 * Passing a hash or an empty extra-consumer list does NOT establish production closure. */
export async function readNativeEvaluationContextUnit(db: Reader, input: {
  schema: string; generation: NativeArchiveGeneration; consumerInventorySha256: string;
  unmodeledConsumers: string[];
}): Promise<NativeEvaluationContextMeasurement> {
  const s = id(input.schema), g = input.generation;
  sha(input.consumerInventorySha256);
  if (!Array.isArray(input.unmodeledConsumers)) refuse("unknown consumer registry absent");
  const settings = (await db.query(`SELECT current_setting('transaction_read_only') AS readonly,
    current_setting('transaction_isolation') AS isolation,
    EXTRACT(epoch FROM current_setting('statement_timeout')::interval)*1000 AS timeout_ms,
    transaction_timestamp()::text AS observed`)).rows[0];
  if (settings?.readonly !== "on" || settings.isolation !== "repeatable read" ||
      !(Number(settings.timeout_ms) > 0 && Number(settings.timeout_ms) <= 7500)) refuse("read-only snapshot/timeout required");
  const jobs = (await db.query(`SELECT row_count::text AS n,to_jsonb(finished_at)#>>'{}' AS finished
    FROM ${s}.engine_v3_job_runs WHERE id=$1::uuid AND business_ref_id=$2::uuid AND business_id=$2::text
      AND as_of_date=$3::date AND engine_version=$4 AND status='success' AND finished_at IS NOT NULL
      AND job_name='engine_v3_native_ad_decisions_shadow_job'`,
  [g.jobRunId, g.businessId, g.asOfDate, g.engineVersion])).rows;
  if (jobs.length !== 1 || BigInt(exact(jobs[0]?.n)) === BigInt(0) || BigInt(exact(jobs[0]?.n)) > BigInt(10000))
    refuse("successful bounded original job absent");
  const selected = (await readNativeJobEvaluationSelection(db, input.schema)).sql;
  const membership = (await db.query(`SELECT count(*)::text AS n,
    count(*) FILTER (WHERE context_id IS NULL OR business_ref_id IS DISTINCT FROM $2::uuid OR business_id IS DISTINCT FROM $2::text OR as_of_date IS DISTINCT FROM $3::date
      OR engine_version IS DISTINCT FROM $4)::text AS foreign_rows,
    count(DISTINCT context_id)::text AS contexts FROM (${selected}) selected`,
  [g.jobRunId, g.businessId, g.asOfDate, g.engineVersion])).rows[0];
  if (exact(membership?.n) !== jobs[0]!.n || exact(membership?.foreign_rows) !== "0") refuse("foreign/incomplete membership");
  const contextSet = `SELECT c.* FROM ${s}.${CONTEXT} c WHERE EXISTS
    (SELECT 1 FROM (${selected}) e WHERE e.context_id=c.id)`;
  const contexts = (await db.query(`SELECT count(*)::text AS n,count(*) FILTER
    (WHERE c.job_run_id IS DISTINCT FROM $1::uuid OR c.business_ref_id IS DISTINCT FROM $2::uuid OR c.business_id IS DISTINCT FROM $2::text
      OR c.as_of_date IS DISTINCT FROM $3::date OR c.engine_version IS DISTINCT FROM $4)::text AS foreign_rows FROM (${contextSet}) c`,
  [g.jobRunId, g.businessId, g.asOfDate, g.engineVersion])).rows[0];
  if (exact(contexts?.n) !== exact(membership?.contexts) || exact(contexts?.foreign_rows) !== "0")
    refuse("context membership mismatch");
  const sharing = exact((await db.query(`SELECT count(*)::text AS n FROM ${s}.${EVAL} retained
    WHERE retained.job_run_id IS DISTINCT FROM $1::uuid AND EXISTS (SELECT 1 FROM (${selected}) e
      WHERE e.context_id=retained.context_id)`, [g.jobRunId])).rows[0]?.n);
  const columns = (await db.query(`SELECT c.relname AS table,a.attname AS column FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [input.schema])).rows;
  const fks = (await db.query(`SELECT con.conname AS name,cn.nspname AS child_schema,child.relname AS child,
    parent.relname AS parent,array_agg(ca.attname::text ORDER BY k.ord) AS child_columns,
    array_agg(pa.attname::text ORDER BY k.ord) AS parent_columns FROM pg_constraint con
    JOIN pg_class child ON child.oid=con.conrelid JOIN pg_namespace cn ON cn.oid=child.relnamespace
    JOIN pg_class parent ON parent.oid=con.confrelid JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(child_key,parent_key,ord)
    JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=k.child_key
    JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.parent_key
    WHERE con.contype='f' AND pn.nspname=$1 AND parent.relname=ANY($2::text[])
    GROUP BY con.conname,cn.nspname,child.relname,parent.relname ORDER BY cn.nspname,child.relname,con.conname`,
  [input.schema, [EVAL, CONTEXT]])).rows;
  const edges: Edge[] = [];
  for (const fk of fks) {
    const parent = String(fk.parent), child = String(fk.child), cs = String(fk.child_schema);
    const cc = fk.child_columns as string[], pc = fk.parent_columns as string[];
    if (!Array.isArray(cc) || !cc.length || !Array.isArray(pc) || pc.length !== cc.length) refuse("composite FK catalog malformed");
    const internal = cs === input.schema && child === EVAL && parent === CONTEXT;
    if (internal && (JSON.stringify(cc) !== JSON.stringify(INTERNAL_CHILD_COLUMNS) ||
        JSON.stringify(pc) !== JSON.stringify(INTERNAL_PARENT_COLUMNS))) refuse("internal lineage FK changed");
    const join = cc.map((c, i) => `child.${id(c)}=p.${id(pc[i]!)}`).join(" AND ");
    const rows = parent === EVAL ? selected : contextSet;
    const n = exact((await db.query(`SELECT count(*)::text AS n FROM ${id(cs)}.${id(child)} child
      JOIN (${rows}) p ON ${join}${internal ? " WHERE child.job_run_id=$1::uuid" : ""}`, [g.jobRunId])).rows[0]?.n);
    edges.push({ childSchema: cs, childTable: child, constraint: String(fk.name), parentTable: parent,
      childColumns: cc, parentColumns: pc, count: n, internalSelectedMembership: internal });
  }
  if (!edges.some(e => e.internalSelectedMembership && e.count === exact(membership?.n))) refuse("native evaluation/context FK absent");
  const unknown = [...input.unmodeledConsumers];
  const has = (table: string, cols: string[]) => {
    const missing = cols.filter(column => !columns.some(c => c.table === table && c.column === column));
    for (const column of missing) unknown.push(`missing_column:${table}.${column}`);
    return !missing.length;
  };
  const values = [g.jobRunId, g.businessId];
  // Launchpad sourceDecisionId is an mdd_<24hex> ENTITY hash, NOT an evaluation UUID.
  // Preserve every handoff naming a selected entity, including terminal/consumed ones.
  // This conservative possible-identity count cannot be reported as exact evaluation pins.
  const entities = (await db.query(`SELECT DISTINCT provider_account_ref_id::text AS account_ref,
    provider_account_id,ad_id,scope_type,scope_id FROM (${selected}) e`, [g.jobRunId])).rows;
  const possibleDecisionIds = entities.map(e => {
    const fields = [g.businessId,e.account_ref,e.provider_account_id,"ad",e.ad_id,e.scope_type,e.scope_id];
    if (fields.some(v => typeof v !== "string" || !v)) refuse("entity identity missing");
    return "mdd_" + createHash("sha256").update(fields.join("\u001f")).digest("hex").slice(0,24);
  });
  const counts = new Map<NonFkClass, string>(NON_FK.map(c => [c, "0"]));
  // Operator and controlled action logs have typed IDs without a direct
  // evaluation FK. Count each action once even if several IDs name this unit;
  // never rely on an optional episode/assignment to preserve audit lineage.
  if (has("meta_ads_action_log", ["decision_evaluation_id", "source_evaluation_id",
    "decision_snapshot_id", "source_snapshot_id"]) &&
      has("engine_v3_ad_decision_snapshots_daily", ["id", "evaluation_id"])) {
    const n = exact((await db.query(`SELECT count(*)::text AS n FROM ${s}.meta_ads_action_log a
      WHERE EXISTS (SELECT 1 FROM (${selected}) e
        WHERE a.decision_evaluation_id=e.id OR a.source_evaluation_id=e.id
          OR EXISTS (SELECT 1 FROM ${s}.engine_v3_ad_decision_snapshots_daily p
            WHERE p.evaluation_id=e.id AND (a.decision_snapshot_id=p.id OR a.source_snapshot_id=p.id)))`,
    [g.jobRunId])).rows[0]?.n);
    counts.set("action_lineage", n);
  }
  for (const [table, pinClass] of [["decision_workflow_state", "workflow_state"],
    ["decision_workflow_events", "workflow_events"]] as const) {
    if (!has(table, ["business_id", "decision_key"])) continue;
    const row = (await db.query(`SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM (${selected}) e
        WHERE lower(split_part(w.decision_key,':',3))=e.id::text))::text AS n,
      count(*) FILTER (WHERE w.decision_key LIKE 'native-ad:%' AND w.decision_key !~
        '^native-ad:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}:[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$')::text AS unknown
      FROM ${s}.${table} w WHERE w.business_id=$2::text`, values)).rows[0];
    counts.set(pinClass, exact(row?.n));
    if (exact(row?.unknown) !== "0") unknown.push(`unsupported_native_key:${table}`);
  }
  if (has("meta_automation_proposals", ["business_id", "rec_id", "rec_type", "evidence_ref"])) {
    const row = (await db.query(`SELECT count(*) FILTER (WHERE EXISTS (SELECT 1 FROM (${selected}) e
        WHERE e.id::text IN (lower(p.rec_id),lower(p.evidence_ref->>'recId'),lower(p.evidence_ref->>'evaluationId'))
          OR lower(split_part(p.evidence_ref->>'decisionKey',':',3))=e.id::text))::text AS n,
      count(*) FILTER (WHERE p.rec_type LIKE 'native_ad_%' AND
        (p.rec_type<>'native_ad_cut' OR jsonb_typeof(p.evidence_ref) IS DISTINCT FROM 'object'
         OR p.evidence_ref->>'recId' IS DISTINCT FROM p.rec_id
         OR p.evidence_ref->>'evaluationId' IS DISTINCT FROM p.rec_id
         OR p.rec_id IS NULL OR p.rec_id !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
         OR p.evidence_ref->>'snapshotId' IS NULL
         OR p.evidence_ref->>'snapshotId' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'
         OR EXISTS (SELECT 1 FROM jsonb_object_keys(CASE WHEN jsonb_typeof(p.evidence_ref)='object'
           THEN p.evidence_ref ELSE '{}'::jsonb END) key WHERE key <> ALL(ARRAY['recId','recType','snapshotDate',
           'engineVersion','decisionKey','creativeId','decisionHash','snapshotId','evaluationId','evidence']))))::text AS unknown
      FROM ${s}.meta_automation_proposals p WHERE p.business_id=$2::uuid`, values)).rows[0];
    counts.set("proposal_identity", exact(row?.n));
    if (exact(row?.unknown) !== "0") unknown.push("unsupported_native_proposal_contract");
  }
  if (has("meta_launch_drafts", ["business_id", "payload_json"])) {
    const row = (await db.query(`SELECT count(*) FILTER (WHERE
        d.payload_json#>>'{handoff,lineage,sourceDecisionId}'=ANY($3::text[]))::text AS n,
      count(*) FILTER (WHERE d.payload_json ? 'handoff' AND
        (d.payload_json->>'kind' IS DISTINCT FROM 'meta_launchpad_decision_handoff'
          OR d.payload_json#>>'{handoff,version}' IS DISTINCT FROM 'v1'
          OR d.payload_json#>>'{handoff,businessId}' IS DISTINCT FROM $2::text
          OR jsonb_typeof(d.payload_json->'handoff') IS DISTINCT FROM 'object'
          OR d.payload_json#>>'{handoff,origin}' NOT IN ('decision','copy')
          OR d.payload_json#>>'{handoff,origin}' IS NULL
          OR (d.payload_json#>>'{handoff,origin}'='decision' AND
            (d.payload_json#>>'{handoff,lineage,sourceDecisionId}' IS NULL
             OR d.payload_json#>>'{handoff,lineage,sourceDecisionId}' !~ '^mdd_[a-f0-9]{24}$'
             OR d.payload_json#>>'{handoff,lineage,sourceSnapshotId}' IS NULL
             OR d.payload_json#>>'{handoff,lineage,sourceSnapshotId}' !~* '^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$'))
          OR (d.payload_json#>>'{handoff,origin}'='copy' AND
            jsonb_typeof(d.payload_json#>'{handoff,lineage}') IS DISTINCT FROM 'null')))::text AS unknown
      FROM ${s}.meta_launch_drafts d WHERE d.business_id=$2::uuid
        AND EXISTS (SELECT 1 FROM ${s}.engine_v3_job_runs j WHERE j.id=$1::uuid)`,
      [g.jobRunId,g.businessId,possibleDecisionIds])).rows[0];
    counts.set("launch_handoff_possible_identity", exact(row?.n));
    if (exact(row?.unknown) !== "0") unknown.push("unsupported_launch_handoff_contract");
  }
  const result: NativeEvaluationContextMeasurement = {
    contract: NATIVE_EVALUATION_UNIT_CONTRACT, generation: { ...g }, observedAt: String(settings.observed),
    jobFinishedAt: String(jobs[0]!.finished), originalJobRowCount: exact(jobs[0]!.n),
    evaluationCount: exact(membership?.n), selectedContextCount: exact(contexts?.n), contextSharingCount: sharing,
    incomingReferences: edges, nonFkCounts: NON_FK.map(pinClass => ({ pinClass, count: counts.get(pinClass)! })),
    unknownReferences: [...new Set(unknown)].sort(),
    schemaHash: createHash("sha256").update(JSON.stringify({ columns, fks })).digest("hex"),
    consumerInventorySha256: input.consumerInventorySha256,
    retainedRoots: ["original_jobs", "calibration_parents", "shared_input_evidence", "provider_roots"],
    providerAuthority: false, reclaimEligible: false,
  };
  assessNativeEvaluationContextUnit(result, g);
  return result;
}
