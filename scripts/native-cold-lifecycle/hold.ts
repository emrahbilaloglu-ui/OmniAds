import { join } from "node:path";
import type { NativeArchiveGeneration } from "../../lib/creative-decision-engine/native-evidence-archive";
import { archiveCanonical } from "../../lib/business-archive-configuration";
import { need,SHA } from "../native-storage-batch/common";
import { COLD_COPY_ROOT,coldJson,coldPath } from "./files";
import type { ColdUnitState } from "./types";

/** A durable OWNER hold is a refusal, never retirement or restore authority.
 * The closed owner procedure preserves the source, both private copies and
 * published leaf; it does not reset/re-date an expired capture or replay C3. */
export function validateColdOwnerHold(g:NativeArchiveGeneration,s:ColdUnitState,intent:{purpose:string;businessId:string;jobRunId:string;sourceBuildId:string;sourceInventorySha256:string}){
  const h=s.hold;
  need(h?.contract==="native-cold-source-intact-hold.v1"&&h.sourceFullBytesMatch===true&&h.privateCopiesMatch===true&&
    h.retirementDispatched===false&&SHA.test(h.previousUnitSha256)&&h.originalProofSha256===s.capture?.proofSha256&&
    SHA.test(h.originalProofSha256)&&Number.isFinite(Date.parse(h.observedAt))&&Date.parse(h.observedAt)<=Date.now()&&
    s.phase==="owner_attention"&&s.failure?.phase==="published"&&s.failure.code==="ACTUAL_HTTP_NO_STORE_REQUIRED"&&
    !s.retirement&&!s.session&&!!s.publication&&archiveCanonical(s.generation)===archiveCanonical(g)&&
    s.businessId===g.businessId&&s.jobRunId===g.jobRunId&&intent.businessId===g.businessId&&intent.jobRunId===g.jobRunId&&
    intent.purpose===s.purpose&&intent.sourceBuildId===s.sourceBuildId&&intent.sourceInventorySha256===s.sourceInventorySha256,"EXACT_SOURCE_INTACT_OWNER_HOLD_REQUIRED");
  return "SOURCE_INTACT_OWNER_HOLD" as const;
}
export async function readColdOwnerHold(g:NativeArchiveGeneration){
  let intent:{purpose:string;businessId:string;jobRunId:string;sourceBuildId:string;sourceInventorySha256:string};
  try{intent=await coldJson(join(COLD_COPY_ROOT,g.businessId,g.jobRunId,"intent.json"));}
  catch(e){if((e as NodeJS.ErrnoException).code==="ENOENT")return null;throw e;}
  need(/^[a-f0-9]{12}$/.test(intent.purpose),"EXACT_OWNED_HOLD_PURPOSE");
  const s=await coldJson<ColdUnitState>(coldPath("jobs",g.businessId,intent.purpose,"state.json"));
  if(!s.hold)return null;
  return validateColdOwnerHold(g,s,intent);
}
