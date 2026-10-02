import assert from "node:assert/strict";
import { it } from "vitest";
import { readNativeJobEvaluationSelection } from "../native-job-evaluation-selection";
const child=["context_id","business_ref_id","business_id","provider_account_ref_id","provider_account_id",
  "as_of_date","engine_version","scope_type","scope_id","contract_version","job_run_id"];
const settings={readonly:"on",isolation:"repeatable read",timeout_ms:"7500",replication_role:"origin"};
const lineage=()=>({validated:true,deferrable:false,triggers_enforced:true,child_columns:[...child],
  parent_columns:["id",...child.slice(1)],child_not_null:child.map(()=>true)});
async function selection(rows: Record<string,unknown>[], mode:Record<string,unknown>=settings) {
  let calls=0;
  const result=await readNativeJobEvaluationSelection({query:async()=>({rows:++calls===1?[mode]:rows})},"public");
  return {result,calls};
}
it("complete validated nonnullable lineage exposes the redundant context job index route",async()=>{
  const {result}=await selection([lineage()]); assert.equal(result.route,"validated_context_lineage");
  assert(!result.sql.includes("business_ref_id=$2"));
  assert.equal((result.sql.match(/selection_eval\."/g)??[]).length,11);
  assert(result.sql.includes("selection_context.job_run_id=$1::uuid"));
});
for(const [name,changed] of [
  ["unvalidated",{validated:false}], ["deferrable",{deferrable:true}], ["disabled trigger",{triggers_enforced:false}],
  ["shortened lineage",{child_columns:["context_id"],parent_columns:["id"]}],
  ["wrong ordered parent",{parent_columns:[...child]}], ["nullable lineage",{child_not_null:[false,...child.slice(1).map(()=>true)]}],
  ["malformed nullability",{child_not_null:"true"}], ["missing enforcement metadata",{triggers_enforced:undefined}],
] as const) it(name+" preserves the complete direct scan instead of concealing foreign rows",async()=>{
  const {result}=await selection([{...lineage(),...changed}]); assert.equal(result.route,"direct_job_scan");
  assert.equal(result.sql,'SELECT * FROM "public".engine_v3_ad_decision_evaluations WHERE job_run_id=$1::uuid');
});
it.each([{rows:[]},{rows:[lineage(),lineage()]}])("absent or ambiguous FK inventory preserves the direct scan",async ({rows})=>{
  assert.equal((await selection(rows)).result.route,"direct_job_scan");
});
it("replica sessions cannot use constraint-derived selection",async()=>{
  const {result,calls}=await selection([lineage()],{...settings,replication_role:"replica"});
  assert.equal(result.route,"direct_job_scan"); assert.equal(calls,1);
});
it.each([{...settings,readonly:"off"},{...settings,isolation:"read committed"},{...settings,timeout_ms:"0"},
  {...settings,timeout_ms:"7501"}])("unsafe source transactions refuse before catalog/data reads",async mode=>{
  await assert.rejects(()=>selection([lineage()],mode));
});
it("catalog identifier injection refuses before any query",async()=>{
  let calls=0;await assert.rejects(()=>readNativeJobEvaluationSelection({query:async()=>{calls++;return {rows:[]};}},'public";DROP SCHEMA public CASCADE;--'));
  assert.equal(calls,0);
});
