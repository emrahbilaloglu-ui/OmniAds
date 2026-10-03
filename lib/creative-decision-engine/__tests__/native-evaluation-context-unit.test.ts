import assert from "node:assert/strict";
import { it } from "vitest";
import { assessNativeEvaluationContextUnit, readNativeEvaluationContextUnit } from "../native-evaluation-context-unit";
const generation={businessId:"11111111-1111-4111-8111-111111111111",jobRunId:"22222222-2222-4222-8222-222222222222",asOfDate:"2026-09-29",engineVersion:"fixture-native"};
const childColumns=["context_id","business_ref_id","business_id","provider_account_ref_id","provider_account_id","as_of_date","engine_version","scope_type","scope_id","contract_version","job_run_id"];
const value=()=>({contract:"native-evaluation-context-measurement.v1" as const,generation:{...generation},observedAt:"2026-10-01T01:00:00Z",jobFinishedAt:"2026-09-29T16:00:00Z",originalJobRowCount:"501",evaluationCount:"501",selectedContextCount:"1",contextSharingCount:"0",incomingReferences:[{childSchema:"public",childTable:"engine_v3_ad_decision_evaluations",constraint:"engine_v3_ad_evaluations_context_lineage_fk",parentTable:"engine_v3_ad_decision_evaluation_contexts",childColumns:[...childColumns],parentColumns:["id",...childColumns.slice(1)],count:"501",internalSelectedMembership:true}],nonFkCounts:(["action_lineage","workflow_state","workflow_events","proposal_identity","launch_handoff_possible_identity"] as const).map(pinClass=>({pinClass,count:"0"})),unknownReferences:[] as string[],schemaHash:"a".repeat(64),consumerInventorySha256:"b".repeat(64),retainedRoots:["original_jobs","calibration_parents","shared_input_evidence","provider_roots"] as const,providerAuthority:false as const,reclaimEligible:false as const});
const test = it;
test('pin-free measured scope keeps every permission false',()=>{
 const r=assessNativeEvaluationContextUnit(value(),generation);assert(r.pinFreeWithinMeasuredScope);assert.equal(r.reclaimEligible,false);assert.equal(r.productionConsumerClosureProved,false);assert.equal(r.providerAuthority,false);assert.equal(r.physicalBytesReclaimed,"0");
});
for(const pin of ["action_lineage","workflow_state","workflow_events","proposal_identity","launch_handoff_possible_identity"]){test(pin+' independently vetoes including terminal audit',()=>{const v=value();v.nonFkCounts.find(x=>x.pinClass===pin)!.count="1";assert.equal(assessNativeEvaluationContextUnit(v,generation).pinFreeWithinMeasuredScope,false);});}
test('unknown consumers veto rather than become zero',()=>{const v=value();v.unknownReferences.push('unclassified_json_consumer');assert.equal(assessNativeEvaluationContextUnit(v,generation).reason,'unsupported_reference_inventory');});
test('retained evaluation sharing selected context vetoes',()=>{const v=value();v.contextSharingCount="1";assert.equal(assessNativeEvaluationContextUnit(v,generation).pinFreeWithinMeasuredScope,false);});
test('unclassified cross-schema FK positive vetoes',()=>{const v=value();v.incomingReferences.push({...v.incomingReferences[0]!,childSchema:'foreign_archive',childTable:'future_audit',constraint:'future_ref',parentTable:'engine_v3_ad_decision_evaluations',childColumns:['evaluation'],parentColumns:['id'],count:'1',internalSelectedMembership:false});assert.equal(assessNativeEvaluationContextUnit(v,generation).pinFreeWithinMeasuredScope,false);});
test('duplicate FK inventory refuses',()=>{const v=value();v.incomingReferences.push(v.incomingReferences[0]!);assert.throws(()=>assessNativeEvaluationContextUnit(v,generation));});
test('incomplete original evaluation generation refuses',()=>{const v=value();v.evaluationCount='500';assert.throws(()=>assessNativeEvaluationContextUnit(v,generation));});
test('foreign exact generation refuses',()=>{assert.throws(()=>assessNativeEvaluationContextUnit(value(),{...generation,businessId:'33333333-3333-4333-8333-333333333333'}));});
test('missing JSON pin class refuses',()=>{const v=value();v.nonFkCounts.pop();assert.throws(()=>assessNativeEvaluationContextUnit(v,generation));});
test('internal shortened composite FK refuses',()=>{const v=value();v.incomingReferences[0]!.childColumns=['context_id'];v.incomingReferences[0]!.parentColumns=['id'];assert.throws(()=>assessNativeEvaluationContextUnit(v,generation));});
test('internal membership count cannot hide broken lineage',()=>{const v=value();v.incomingReferences[0]!.count='500';assert.throws(()=>assessNativeEvaluationContextUnit(v,generation));});
test('no unbounded generation measurement',()=>{const v=value();v.originalJobRowCount='10001';v.evaluationCount='10001';assert.throws(()=>assessNativeEvaluationContextUnit(v,generation));});
test('original successful clock cannot be in future',()=>{const v=value();v.jobFinishedAt='2026-10-02T00:00:00Z';assert.throws(()=>assessNativeEvaluationContextUnit(v,generation));});
it.each([{readonly:'off',isolation:'repeatable read',timeout_ms:'7500'},
 {readonly:'on',isolation:'read committed',timeout_ms:'7500'},
 {readonly:'on',isolation:'repeatable read',timeout_ms:'0'},
 {readonly:'on',isolation:'repeatable read',timeout_ms:'7501'}])('requires pinned READ ONLY isolation and timeout before data: %j', async settings => {
 let calls=0; await assert.rejects(()=>readNativeEvaluationContextUnit({query:async()=>{calls++;return {rows:[settings]};}},
  {schema:'public',generation,consumerInventorySha256:'b'.repeat(64),unmodeledConsumers:[]})); assert.equal(calls,1);
});
it('missing internal composite lineage cannot report pin-free',()=>{ const v=value(); v.incomingReferences=[]; assert.throws(()=>assessNativeEvaluationContextUnit(v,generation)); });
it('retained root declaration must preserve original/shared/parent/provider roots',()=>{ const v=value(); v.retainedRoots=[] as never; assert.throws(()=>assessNativeEvaluationContextUnit(v,generation)); });

it('measurement v2 additionally retains shared campaign objects; legacy v1 remains original',()=>{
 const original=value();assert(assessNativeEvaluationContextUnit(original,generation).pinFreeWithinMeasuredScope);
 const current={...original,contract:'native-evaluation-context-measurement.v2' as const,retainedRoots:[...original.retainedRoots,'shared_campaign_context_objects'] as const};
 assert(assessNativeEvaluationContextUnit(current,generation).pinFreeWithinMeasuredScope);
 assert.throws(()=>assessNativeEvaluationContextUnit({...current,retainedRoots:original.retainedRoots},generation));
});
