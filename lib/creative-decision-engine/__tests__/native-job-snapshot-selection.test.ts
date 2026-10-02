import assert from "node:assert/strict";
import { it } from "vitest";
import { readNativeJobSnapshotSelection } from "../native-job-snapshot-selection";

const child = ["evaluation_id", "business_ref_id", "business_id", "provider_account_ref_id",
  "provider_account_id", "decision_entity_type", "decision_entity_id", "ad_id", "as_of_date",
  "engine_version", "scope_type", "scope_id", "input_hash", "decision_hash", "job_run_id"];
const evalChild = ["context_id", "business_ref_id", "business_id", "provider_account_ref_id",
  "provider_account_id", "as_of_date", "engine_version", "scope_type", "scope_id", "contract_version", "job_run_id"];
const settings = { readonly: "on", isolation: "repeatable read", timeout_ms: "7500", replication_role: "origin" };
const lineage = (keys = child) => ({ validated: true, deferrable: false, triggers_enforced: true,
  child_columns: [...keys], parent_columns: ["id", ...keys.slice(1)], child_not_null: keys.map(() => true) });
async function selection(rows: Record<string, unknown>[], mode = settings, evalRows = [lineage(evalChild)]) {
  const calls: { sql: string; values?: unknown[] }[] = [];
  const result = await readNativeJobSnapshotSelection({ query: async (sql, values) => {
    calls.push({ sql, values });
    return { rows: sql.includes("current_setting") ? [mode] :
      values?.[1] === "engine_v3_ad_decision_snapshots_daily" ? rows : evalRows };
  } }, "public");
  return { result, calls };
}
it("complete enforced snapshot lineage preserves original job identity through the complete evaluation selector", async () => {
  const { result } = await selection([lineage()]);
  assert.equal(result.route, "validated_evaluation_lineage");
  assert(result.sql.includes("selection_snapshot.job_run_id=$1::uuid"));
  assert(result.sql.includes("selection_context.job_run_id=$1::uuid"));
  assert(!result.sql.includes("LIMIT") && !result.sql.includes("business_ref_id=$2"));
  assert.equal((result.sql.match(/selection_snapshot\."/g) ?? []).length, 15);
});
for (const [name, changed] of [
  ["unvalidated", { validated: false }], ["deferrable", { deferrable: true }],
  ["disabled trigger", { triggers_enforced: false }], ["missing trigger metadata", { triggers_enforced: undefined }],
  ["incomplete job lineage", { child_columns: child.slice(0, -1), parent_columns: ["id", ...child.slice(1, -1)] }],
  ["wrong ordered parent", { parent_columns: [...child] }],
  ["nullable key", { child_not_null: [false, ...child.slice(1).map(() => true)] }],
  ["malformed nullability", { child_not_null: "true" }],
] as const) it(name + " retains every direct-job snapshot instead of hiding unmatched rows", async () => {
  const { result, calls } = await selection([{ ...lineage(), ...changed }]);
  assert.equal(result.route, "direct_job_scan");
  assert.equal(result.sql, 'SELECT * FROM "public".engine_v3_ad_decision_snapshots_daily WHERE job_run_id=$1::uuid');
  assert.equal(calls.length, 2);
});
it.each([{ rows: [] }, { rows: [lineage(), lineage()] }])("missing or ambiguous lineage retains the complete direct scan", async ({ rows }) => {
  assert.equal((await selection(rows)).result.route, "direct_job_scan");
});
it("unsafe evaluation lineage still uses the complete evaluation scan inside a safe snapshot join", async () => {
  const { result } = await selection([lineage()], settings, [{ ...lineage(evalChild), validated: false }]);
  assert.equal(result.route, "validated_evaluation_lineage");
  assert(result.sql.includes('SELECT * FROM "public".engine_v3_ad_decision_evaluations WHERE job_run_id=$1::uuid'));
  assert(!result.sql.includes("selection_context"));
});
it("replica sessions cannot infer historical FK completeness", async () => {
  const { result, calls } = await selection([lineage()], { ...settings, replication_role: "replica" });
  assert.equal(result.route, "direct_job_scan"); assert.equal(calls.length, 1);
});
it.each([{ ...settings, readonly: "off" }, { ...settings, isolation: "read committed" },
  { ...settings, timeout_ms: "0" }, { ...settings, timeout_ms: "7501" }])("unsafe transactions refuse before catalog reads", async mode => {
  await assert.rejects(() => selection([lineage()], mode));
});
it("unsafe identifiers cannot reach a query", async () => {
  let calls = 0;
  await assert.rejects(() => readNativeJobSnapshotSelection({ query: async () => { calls++; return { rows: [] }; } }, 'public";DROP SCHEMA public;--'));
  assert.equal(calls, 0);
});
