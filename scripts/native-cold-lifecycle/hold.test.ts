import { expect,it } from "vitest";
import { validateColdOwnerHold } from "./hold";
import type { ColdUnitState } from "./types";
const generation={businessId:"00000000-0000-4000-8000-000000000001",jobRunId:"00000000-0000-4000-8000-000000000002",asOfDate:"2026-09-27",engineVersion:"engine"};
const intent={businessId:generation.businessId,jobRunId:generation.jobRunId,purpose:"a".repeat(12),sourceBuildId:"a".repeat(40),sourceInventorySha256:"f".repeat(64)};
function unit(){return {contract:"native-cold-unit-state.v1",businessId:generation.businessId,jobRunId:generation.jobRunId,purpose:intent.purpose,generation,sourceBuildId:intent.sourceBuildId,sourceInventorySha256:intent.sourceInventorySha256,
  phase:"owner_attention",failure:{phase:"published",code:"ACTUAL_HTTP_NO_STORE_REQUIRED"},publication:{rootSha256:"c".repeat(64)},capture:{proofSha256:"b".repeat(64)},
  hold:{contract:"native-cold-source-intact-hold.v1",observedAt:new Date().toISOString(),originalProofSha256:"b".repeat(64),previousUnitSha256:"d".repeat(64),sourceFullBytesMatch:true,privateCopiesMatch:true,retirementDispatched:false}} as ColdUnitState;}
it("keeps the exact proved pre-C3 original on hold across an execution build change",()=>{
  const s=unit();
  expect(validateColdOwnerHold(generation,s,intent)).toBe("SOURCE_INTACT_OWNER_HOLD");
  expect(s.phase).toBe("owner_attention");expect(s.retirement).toBeUndefined();
});
it.each(["dispatched","wrong_job","wrong_purpose","wrong_proof","unproved_source","no_copy","wrong_failure","future"])("refuses an invalid owner hold: %s",kind=>{
  const s=unit();
  if(kind==="dispatched")s.retirement={committed:true} as never;
  if(kind==="wrong_job")s.generation={...generation,jobRunId:"00000000-0000-4000-8000-000000000003"};
  if(kind==="wrong_purpose")s.purpose="f".repeat(12);
  if(kind==="wrong_proof")s.hold!.originalProofSha256="e".repeat(64);
  if(kind==="unproved_source")s.hold!.sourceFullBytesMatch=false as never;
  if(kind==="no_copy")s.hold!.privateCopiesMatch=false as never;
  if(kind==="wrong_failure")s.failure!.phase="retiring";
  if(kind==="future")s.hold!.observedAt=new Date(Date.now()+60_000).toISOString();
  expect(()=>validateColdOwnerHold(generation,s,intent)).toThrow("EXACT_SOURCE_INTACT_OWNER_HOLD_REQUIRED");
});
