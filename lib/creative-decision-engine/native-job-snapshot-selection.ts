import { readNativeJobEvaluationSelection } from "./native-job-evaluation-selection";

/** SELECT-only query preparation. No index creation, predicate normalization,
 * pin elision, production caller or permission to remove an original row. */
interface Reader {
  query(sql: string, values?: unknown[]): Promise<{ rows: Record<string, unknown>[] }>;
}
const SNAPSHOTS = "engine_v3_ad_decision_snapshots_daily";
const EVALUATIONS = "engine_v3_ad_decision_evaluations";
const CHILD_KEYS = ["evaluation_id", "business_ref_id", "business_id", "provider_account_ref_id",
  "provider_account_id", "decision_entity_type", "decision_entity_id", "ad_id", "as_of_date",
  "engine_version", "scope_type", "scope_id", "input_hash", "decision_hash", "job_run_id"];
const PARENT_KEYS = ["id", ...CHILD_KEYS.slice(1)];
function identifier(value: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(value)) throw new Error("Native selection refused: invalid identifier");
  return `"${value}"`;
}

/** Complete original-job snapshot selection, with no job/business/day subset.
 * A validated, nondeferrable, nonnullable fifteen-key FK enforces the snapshot's
 * original job identity against its evaluation, exposing the existing leading
 * evaluation_id index. Unsafe metadata retains the complete direct job scan.
 * Normal historical PostgreSQL constraint integrity is assumed; no audit of
 * prior superuser/replication bypass, source rate or transitive consumers. */
export async function readNativeJobSnapshotSelection(db: Reader, schema: string): Promise<{
  sql: string; route: "validated_evaluation_lineage" | "direct_job_scan";
}> {
  const s = identifier(schema);
  const settings = (await db.query(`SELECT current_setting('transaction_read_only') AS readonly,
    current_setting('transaction_isolation') AS isolation,
    EXTRACT(epoch FROM current_setting('statement_timeout')::interval)*1000 AS timeout_ms,
    current_setting('session_replication_role') AS replication_role`)).rows[0];
  if (settings?.readonly !== "on" || settings.isolation !== "repeatable read" ||
      !(Number(settings.timeout_ms) > 0 && Number(settings.timeout_ms) <= 7500))
    throw new Error("Native selection refused: read-only snapshot/timeout required");
  const direct = { sql: `SELECT * FROM ${s}.${SNAPSHOTS} WHERE job_run_id=$1::uuid`,
    route: "direct_job_scan" as const };
  if (settings.replication_role !== "origin") return direct;
  const lineage = (await db.query(`SELECT con.convalidated AS validated,con.condeferrable AS deferrable,
    array_agg(ca.attname::text ORDER BY k.ord) AS child_columns,
    array_agg(pa.attname::text ORDER BY k.ord) AS parent_columns,
    array_agg(ca.attnotnull ORDER BY k.ord) AS child_not_null,
    (SELECT count(*)=4 AND bool_and(t.tgisinternal AND t.tgenabled IN ('O','A'))
      FROM pg_trigger t WHERE t.tgconstraint=con.oid) AS triggers_enforced
    FROM pg_constraint con JOIN pg_class child ON child.oid=con.conrelid
    JOIN pg_namespace cn ON cn.oid=child.relnamespace JOIN pg_class parent ON parent.oid=con.confrelid
    JOIN pg_namespace pn ON pn.oid=parent.relnamespace
    CROSS JOIN LATERAL unnest(con.conkey,con.confkey) WITH ORDINALITY k(child_key,parent_key,ord)
    JOIN pg_attribute ca ON ca.attrelid=child.oid AND ca.attnum=k.child_key
    JOIN pg_attribute pa ON pa.attrelid=parent.oid AND pa.attnum=k.parent_key
    WHERE con.contype='f' AND cn.nspname=$1 AND pn.nspname=$1
      AND child.relname=$2 AND parent.relname=$3
    GROUP BY con.oid ORDER BY con.oid`, [schema, SNAPSHOTS, EVALUATIONS])).rows;
  const fk = lineage.length === 1 ? lineage[0] : undefined;
  if (!fk || fk.validated !== true || fk.deferrable !== false || fk.triggers_enforced !== true ||
      JSON.stringify(fk.child_columns) !== JSON.stringify(CHILD_KEYS) ||
      JSON.stringify(fk.parent_columns) !== JSON.stringify(PARENT_KEYS) ||
      !Array.isArray(fk.child_not_null) || fk.child_not_null.length !== CHILD_KEYS.length ||
      !fk.child_not_null.every(value => value === true)) return direct;
  const evaluations = (await readNativeJobEvaluationSelection(db, schema)).sql;
  const join = CHILD_KEYS.map((key, i) =>
    `selection_snapshot.${identifier(key)}=selection_eval.${identifier(PARENT_KEYS[i]!)}`).join(" AND ");
  return { sql: `SELECT selection_snapshot.* FROM (${evaluations}) selection_eval
    JOIN ${s}.${SNAPSHOTS} selection_snapshot ON ${join}
    WHERE selection_snapshot.job_run_id=$1::uuid`,
  route: "validated_evaluation_lineage" };
}
