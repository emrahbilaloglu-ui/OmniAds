import { createHash } from "node:crypto";
import { stableCanonicalJson } from "./canonical-evaluation";
import type { NativeArchiveGeneration } from "./native-evidence-archive";

/** Offline/read-only preparation. No production caller or eviction executor. */
export const NATIVE_PIN_CENSUS_CONTRACT = "bounded-native-pin-census.v1" as const;
export const NATIVE_PIN_CLASSES = ["snapshots", "outcomes", "episodes", "assignments", "events",
  "job_dependencies", "reuse_attempts", "shared_input_evidence", "action_lineage"] as const;
export type NativePinClass = typeof NATIVE_PIN_CLASSES[number];
export interface NativeArchiveForeignKeyReference {
  childSchema: string; childTable: string; constraint: string;
  parentSchema: string; parentTable: string; pinClass: NativePinClass | null; count: string;
}
export interface NativeArchivePinCensus {
  contract: typeof NATIVE_PIN_CENSUS_CONTRACT;
  coverage: "catalog_incoming_and_declared_non_fk";
  generation: NativeArchiveGeneration;
  observedAt: string;
  jobFinishedAt: string;
  jobRowCount: string;
  evaluationCount: string;
  catalogHash: string;
  counts: { pinClass: NativePinClass; count: string }[];
  /** Every non-internal catalog edge is measured, including unclassified ZERO edges. */
  foreignKeyReferences: NativeArchiveForeignKeyReference[];
  /** Unknown FK edges, missing tables/columns or explicitly unmodeled readers veto. */
  unknownReferences: string[];
  /** Known pin-free is not a production closure, archive adoption or deletion permit. */
  reclaimEligible: false;
}
interface QueryReader {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const CORE = ["engine_v3_job_runs", "engine_v3_ad_decision_evaluation_contexts",
  "engine_v3_ad_decision_evaluations", "engine_v3_ad_decision_input_evidence",
  "engine_v3_ad_decision_snapshots_daily"];
const CLASSES: Record<string, NativePinClass> = {
  engine_v3_ad_decision_snapshots_daily: "snapshots",
  engine_v3_ad_decision_outcomes_daily: "outcomes",
  engine_v3_ad_recommendation_episodes: "episodes",
  meta_controlled_random_assignments: "assignments",
  engine_v3_ad_decision_events: "events",
  engine_v3_job_runs: "job_dependencies",
  meta_ads_action_log: "action_lineage",
  engine_v3_creative_lifecycle_daily: "job_dependencies",
};
function fail(message: string): never { throw new Error(`Native pin census refused: ${message}`); }
function quote(name: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(name)) fail("invalid catalog identifier");
  return `"${name}"`;
}
function count(value: unknown): string {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) fail("invalid exact count");
  return value;
}
export function assessNativeArchivePins(census: NativeArchivePinCensus,
  generation: NativeArchiveGeneration) {
  if (census.contract !== NATIVE_PIN_CENSUS_CONTRACT ||
      census.coverage !== "catalog_incoming_and_declared_non_fk" || census.reclaimEligible !== false ||
      stableCanonicalJson(census.generation) !== stableCanonicalJson(generation) ||
      !Number.isFinite(Date.parse(census.observedAt)) || !Number.isFinite(Date.parse(census.jobFinishedAt)) ||
      Date.parse(census.jobFinishedAt) > Date.parse(census.observedAt) ||
      !/^[0-9a-f]{64}$/.test(census.catalogHash)) fail("identity/clock/catalog mismatch");
  const classes = new Map(census.counts.map(c => [c.pinClass, count(c.count)]));
  if (census.counts.length !== NATIVE_PIN_CLASSES.length || classes.size !== NATIVE_PIN_CLASSES.length ||
      NATIVE_PIN_CLASSES.some(c => !classes.has(c)) || !Array.isArray(census.unknownReferences) ||
      census.unknownReferences.some(r => typeof r !== "string" || !r.trim())) fail("incomplete pin classes");
  if (!Array.isArray(census.foreignKeyReferences)) fail("FK reference inventory absent");
  const edgeKeys = new Set<string>();
  for (const edge of census.foreignKeyReferences) {
    if ([edge.childSchema, edge.childTable, edge.constraint, edge.parentSchema, edge.parentTable]
        .some(v => typeof v !== "string" || !v.trim()) ||
        (edge.pinClass !== null && !NATIVE_PIN_CLASSES.includes(edge.pinClass))) fail("invalid FK reference inventory");
    const key = stableCanonicalJson([edge.childSchema, edge.childTable, edge.constraint]);
    if (edgeKeys.has(key)) fail("duplicate FK reference");
    edgeKeys.add(key); count(edge.count);
  }
  for (const pinClass of NATIVE_PIN_CLASSES) {
    const fkCount = census.foreignKeyReferences.filter(e => e.pinClass === pinClass)
      .reduce((sum, e) => sum + BigInt(e.count), BigInt(0));
    if (BigInt(classes.get(pinClass)!) < fkCount) fail("FK/class count mismatch");
  }
  if (count(census.jobRowCount) !== count(census.evaluationCount) || census.evaluationCount === "0") fail("incomplete evaluation generation");
  const pinned = NATIVE_PIN_CLASSES.filter(c => classes.get(c) !== "0");
  const unclassifiedLive = census.foreignKeyReferences.filter(e => e.pinClass === null && e.count !== "0");
  const unknown = census.unknownReferences.length > 0 || unclassifiedLive.length > 0;
  return { candidateWithinSupportedScope: !unknown && !pinned.length,
    reason: unknown ? "unsupported_reference_inventory" : pinned.length ? "live_pins" : "pin_free_supported_scope",
    pinClasses: pinned, unclassifiedLiveReferences: unclassifiedLive,
    ageSeconds: (Date.parse(census.observedAt) - Date.parse(census.jobFinishedAt)) / 1000,
    reclaimEligible: false as const };
}

/** Caller must hold ONE read-only repeatable-read transaction and <=7.5s SQL timeout.
 * Each count is a separate statement; no correlated per-evaluation CTE and no write.
 * Passing a bounded registry is never proof that every production JSON reader was found.
 */
export async function readNativeArchivePinCensus(db: QueryReader, input: {
  schema: string; generation: NativeArchiveGeneration; unmodeledReferences: string[];
}): Promise<NativeArchivePinCensus> {
  const schema = quote(input.schema), g = input.generation;
  const settings = (await db.query(`SELECT current_setting('transaction_read_only') AS readonly,
    current_setting('transaction_isolation') AS isolation,
    EXTRACT(epoch FROM current_setting('statement_timeout')::interval)*1000 AS timeout_ms,
    transaction_timestamp()::text AS observed`)).rows[0];
  if (settings?.readonly !== "on" || settings.isolation !== "repeatable read" ||
      !(Number(settings.timeout_ms) > 0 && Number(settings.timeout_ms) <= 7500)) fail("read-only snapshot/timeout required");
  const jobs = (await db.query(`SELECT id::text, row_count::text, to_jsonb(finished_at)#>>'{}' AS finished_at
    FROM ${schema}.engine_v3_job_runs WHERE id=$1::uuid AND business_ref_id=$2::uuid
      AND as_of_date=$3::date AND engine_version=$4 AND status='success'
      AND job_name='engine_v3_native_ad_decisions_shadow_job'`,
  [g.jobRunId, g.businessId, g.asOfDate, g.engineVersion])).rows;
  if (jobs.length !== 1 || !jobs[0]?.finished_at) fail("original successful job absent");
  const evaluations = (await db.query(`SELECT count(*)::text AS n FROM ${schema}.engine_v3_ad_decision_evaluations
    WHERE job_run_id=$1::uuid`, [g.jobRunId])).rows[0];
  const columns = (await db.query(`SELECT c.relname AS table, a.attname AS column FROM pg_class c
    JOIN pg_namespace n ON n.oid=c.relnamespace JOIN pg_attribute a ON a.attrelid=c.oid
    WHERE n.nspname=$1 AND a.attnum>0 AND NOT a.attisdropped ORDER BY c.relname,a.attnum`, [input.schema])).rows;
  const fks = (await db.query(`SELECT con.conname AS name, cn.nspname AS child_schema, child.relname AS child,
    pn.nspname AS parent_schema, parent.relname AS parent,
    array_agg(ca.attname::text ORDER BY k.ord) AS child_columns,
    array_agg(pa.attname::text ORDER BY k.ord) AS parent_columns
    FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_namespace cn ON cn.oid=child.relnamespace JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(child_key,parent_key,ord)
    JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=k.child_key
    JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.parent_key
    WHERE con.contype='f' AND pn.nspname=$1 AND parent.relname=ANY($2::text[])
      GROUP BY con.conname,cn.nspname,child.relname,pn.nspname,parent.relname
    ORDER BY cn.nspname,child.relname,con.conname`, [input.schema, CORE])).rows;
  const counts = Object.fromEntries(NATIVE_PIN_CLASSES.map(c => [c, BigInt(0)])) as Record<NativePinClass, bigint>;
  const unknown = [...input.unmodeledReferences];
  const foreignKeyReferences: NativeArchiveForeignKeyReference[] = [];
  const add = async (pinClass: NativePinClass, sql: string, values: unknown[]) => {
    const row = (await db.query(sql, values)).rows[0]; counts[pinClass] += BigInt(count(row?.n));
  };
  for (const fk of fks) {
    const child = String(fk.child), parent = String(fk.parent);
    // These references are internal membership, validated by the bundle reader.
    if (fk.child_schema === input.schema &&
        ((child === "engine_v3_ad_decision_evaluations" && parent === "engine_v3_ad_decision_evaluation_contexts") ||
        (child === "engine_v3_ad_decision_evaluation_contexts" && parent === "engine_v3_job_runs"))) continue;
    const pinClass = fk.child_schema === input.schema ? CLASSES[child] ?? null : null;
    const childColumns = fk.child_columns as string[], parentColumns = fk.parent_columns as string[];
    if (!childColumns.length || childColumns.length !== parentColumns.length) fail("invalid composite FK catalog");
    const join = childColumns.map((c, i) => `c.${quote(c)}=p.${quote(parentColumns[i]!)}`).join(" AND ");
    const predicate = parent === "engine_v3_job_runs" ? "p.id=$1::uuid" :
      parent === "engine_v3_ad_decision_input_evidence" ? `EXISTS (SELECT 1
        FROM ${schema}.engine_v3_ad_decision_evaluations selected WHERE selected.job_run_id=$1::uuid
        AND selected.contract_version=p.contract_version AND selected.input_hash=p.input_hash)` : "p.job_run_id=$1::uuid";
    const n = count((await db.query(`SELECT count(*)::text AS n FROM ${quote(String(fk.child_schema))}.${quote(child)} c
      JOIN ${schema}.${quote(parent)} p ON ${join} WHERE ${predicate}`, [g.jobRunId])).rows[0]?.n);
    foreignKeyReferences.push({ childSchema: String(fk.child_schema), childTable: child, constraint: String(fk.name),
      parentSchema: String(fk.parent_schema), parentTable: parent, pinClass, count: n });
    if (pinClass) counts[pinClass] += BigInt(n);
    else if (n !== "0") unknown.push(`unclassified_live_reference:${String(fk.child_schema)}.${child}.${String(fk.name)}`);
  }
  // Missing required leaf classes are UNKNOWN, never measured zero.
  for (const table of Object.keys(CLASSES)) if (!columns.some(c => c.table === table)) unknown.push(`missing_table:${table}`);
  for (const table of ["engine_v3_ad_decision_snapshots_daily", "engine_v3_ad_decision_outcomes_daily",
    "engine_v3_ad_recommendation_episodes", "meta_controlled_random_assignments"]) {
    if (!fks.some(fk => fk.child_schema === input.schema && fk.child === table &&
        fk.parent === "engine_v3_ad_decision_evaluations")) unknown.push(`missing_evaluation_fk:${table}`);
  }
  if (!columns.some(c => c.table === "engine_v3_job_runs" && c.column === "dependency_run_id")) unknown.push("missing_dependency_lineage_column");
  else await add("job_dependencies", `SELECT count(*)::text AS n FROM ${schema}.engine_v3_job_runs
    WHERE dependency_run_id=$1::uuid AND id<>$1::uuid`, [g.jobRunId]);
  if (!columns.some(c => c.table === "engine_v3_job_runs" && c.column === "error_json")) unknown.push("missing_reuse_metadata");
  else await add("reuse_attempts", `SELECT count(*)::text AS n FROM ${schema}.engine_v3_job_runs
    WHERE error_json#>>'{metadata,reused_job_run_id}'=$1 AND id<>$1::uuid`, [g.jobRunId]);
  await add("shared_input_evidence", `SELECT count(*)::text AS n FROM ${schema}.engine_v3_ad_decision_evaluations retained
    JOIN (SELECT DISTINCT contract_version,input_hash FROM ${schema}.engine_v3_ad_decision_evaluations
      WHERE job_run_id=$1::uuid) selected USING (contract_version,input_hash)
    WHERE retained.job_run_id<>$1::uuid`, [g.jobRunId]);
  // Operator-response and controlled registry have distinct typed lineage columns.
  for (const [column, parent] of [
    ["decision_evaluation_id", "engine_v3_ad_decision_evaluations"],
    ["decision_snapshot_id", "engine_v3_ad_decision_snapshots_daily"],
    ["source_evaluation_id", "engine_v3_ad_decision_evaluations"],
    ["source_snapshot_id", "engine_v3_ad_decision_snapshots_daily"],
  ]) {
    if (!columns.some(c => c.table === "meta_ads_action_log" && c.column === column))
      unknown.push(`missing_action_lineage_column:${column}`);
    else await add("action_lineage", `SELECT count(*)::text AS n FROM ${schema}.meta_ads_action_log a
      JOIN ${schema}.${quote(parent!)} p ON p.id=a.${quote(column!)} WHERE p.job_run_id=$1::uuid`, [g.jobRunId]);
  }
  const census: NativeArchivePinCensus = {
    contract: NATIVE_PIN_CENSUS_CONTRACT, coverage: "catalog_incoming_and_declared_non_fk",
    generation: { ...g }, observedAt: String(settings.observed), jobFinishedAt: String(jobs[0]!.finished_at),
    jobRowCount: count(jobs[0]!.row_count), evaluationCount: count(evaluations?.n),
    catalogHash: createHash("sha256").update(stableCanonicalJson({ columns, fks })).digest("hex"),
    counts: NATIVE_PIN_CLASSES.map(pinClass => ({ pinClass, count: counts[pinClass].toString() })),
    foreignKeyReferences,
    unknownReferences: [...new Set(unknown)].sort(), reclaimEligible: false,
  };
  assessNativeArchivePins(census, g);
  return census;
}
