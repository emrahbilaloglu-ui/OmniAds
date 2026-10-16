import { randomBytes } from "node:crypto";
import { join } from "node:path";
import type { Client } from "pg";
import { BUSINESS_ERASURE_LOCK_NAMESPACE } from "../../lib/business-deletion";
import { archiveCanonical,archiveDigest,resolveBusinessArchiveConfiguration } from "../../lib/business-archive-configuration";
import { cleanupOwnedColdSession } from "../../lib/native-cold-session";
import { evaluateLaneAdmission } from "../../lib/sync/global-kill-switch";
import { selectClosedDayCandidates } from "../native-storage-batch/maintenance";
import { acceptPrepared } from "../native-storage-batch/retire";
import { need,safeError,sha256 } from "../native-storage-batch/common";
import { runColdChild } from "./child";
import { COLD_COPY_ROOT,coldJson,coldPath,writeColdJson } from "./files";
import { freshColdGate,sourceConnection,staticColdGate,verifyRuntimeObservation } from "./gate";
import { collectColdHttpProof,verifyColdHttpProof } from "./http";
import { readColdPrivateConfig } from "./private-original";
import { dropPrivateRestore } from "./private-restore";
import { createCapacityRequest,createCopyRequest,readReplicaAck,removeReplicaRequest,waitReplicaAck } from "./replica";
import { ensureTenantRouting,publishServedOriginal } from "./routing";
import type { ColdControllerState,ColdUnitState } from "./types";

export const COLD_CADENCE_MS=60_000;
export const COLD_READ_WINDOW_MS=15*60_000;
export const COLD_AUTOMATION_READ_BUDGET=48; // Leave16/64 for normal historical inspection.
export function reserveColdReads(state:ColdControllerState,businessId:string,requests:number,downloadBytes:number,now=Date.now()){
  state.reads=state.reads.filter(x=>Date.parse(x.observedAt)>now-COLD_READ_WINDOW_MS);
  const used=state.reads.filter(x=>x.businessId===businessId).reduce((n,x)=>n+x.requests,0);
  const bytes=state.reads.filter(x=>x.businessId===businessId).reduce((n,x)=>n+x.downloadBytes,0);
  need(Number.isInteger(requests)&&requests>=1&&used+requests<=COLD_AUTOMATION_READ_BUDGET&&
    Number.isSafeInteger(downloadBytes)&&downloadBytes>=0&&bytes+downloadBytes<=24*1024**2,"COLD_HTTP_BUDGET_DEFERRED");
  state.reads.push({businessId,observedAt:new Date(now).toISOString(),requests,downloadBytes});
}
function empty():ColdControllerState{return {contract:"native-cold-controller.v1",cursor:null,active:null,nextEligibleAt:null,
  archivedOriginals:0,vetoes:[],lastSuccess:null,lastFailure:null,reads:[],observations:[]};}
async function state(){try{const s=await coldJson<ColdControllerState>(coldPath("state.json"));
  need(s.contract==="native-cold-controller.v1"&&s.vetoes.length<=64&&s.reads.length<=256&&s.observations.length<=96,"FINITE_COLD_CONTROLLER_JOURNAL");return s;
}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return empty();}}
async function noHidden(db:Client,s?:ColdUnitState){
  const r=await db.query("SELECT 1 FROM business_deletion_jobs WHERE hidden_at IS NOT NULL LIMIT 1");
  need(r.rows.length===0,"BUSINESS_ERASURE_TAKES_PRIORITY");
  if(s)need((await db.query("SELECT 1 FROM businesses WHERE id=$1::uuid",[s.businessId])).rows.length===1,"SOURCE_BUSINESS_STILL_EXISTS");
}
const isRetirementDispatched=(s:ColdUnitState)=>["retiring","retired","readback","complete"].includes(s.phase);
/** One finite original. Reuses the erasure publisher exclusion and existing
 * capture/restore/C3 kernels; this is orchestration, never a decision core. */
export async function runNativeColdLifecycleTick(stopping:()=>boolean=()=>false){
  if(process.env.NATIVE_COLD_LIFECYCLE_ENABLED!=="true"||!evaluateLaneAdmission({lane:"native_archive"}).enabled)return {outcome:"disabled"};
  const checked=await staticColdGate(),db=await sourceConnection("controller");let locked=false;
  const global=await state();let unit:ColdUnitState|undefined;
  const saveGlobal=()=>writeColdJson(coldPath("state.json"),global).then(()=>undefined);
  const saveUnit=()=>writeColdJson(coldPath("jobs",unit!.businessId,unit!.purpose,"state.json"),unit).then(()=>undefined);
  const active=async()=>{need(!stopping(),"COLD_STOP_REQUESTED");await noHidden(db,unit);
    need(Date.now()<Date.parse(unit!.deadlineAt),"FINITE_COLD_PURPOSE_EXPIRED");};
  try{
    locked=(await db.query("SELECT pg_try_advisory_lock($1::int,0) acquired",[BUSINESS_ERASURE_LOCK_NAMESPACE])).rows[0].acquired===true;
    if(!locked)return {outcome:"busy"};await noHidden(db);
    if(global.active){
      unit=await coldJson<ColdUnitState>(coldPath("jobs",global.active.businessId,global.active.purpose,"state.json"));
      need(unit.businessId===global.active.businessId&&unit.jobRunId===global.active.jobRunId&&unit.purpose===global.active.purpose,"EXACT_ACTIVE_COLD_UNIT");
      if(unit.phase==="owner_attention")return {outcome:"owner_attention"};
      // A process death after dispatch cannot prove whether COMMIT was received.
      // Never replay it or label independent absence a successful commit ACK.
      need(!isRetirementDispatched(unit),"COLD_DISPATCHED_STATUS_ONLY_NO_REPLAY");
      need(unit.phase!=="capturing","COLD_CAPTURE_INTERRUPTED_STATUS_ONLY");
    }else{
      if(global.nextEligibleAt&&Date.now()<Date.parse(global.nextEligibleAt))return {outcome:"waiting_cadence"};
      const selected=await selectClosedDayCandidates(db,{cursor:global.cursor,limit:64,cutoffObservedAt:new Date().toISOString(),maxEvaluations:3200});
      for(const candidate of selected.candidates){
        global.cursor={asOfDate:candidate.generation.asOfDate,jobRunId:candidate.generation.jobRunId};
        if(candidate.metadataVeto){global.vetoes.push({generation:candidate.generation,reason:candidate.metadataVeto,observedAt:new Date().toISOString()});
          global.vetoes=global.vetoes.slice(-64);continue;}
        const now=Date.now(),purpose=randomBytes(6).toString("hex");
        unit={contract:"native-cold-unit-state.v1",businessId:candidate.generation.businessId,jobRunId:candidate.generation.jobRunId,
          purpose,generation:candidate.generation,evaluations:candidate.evaluations,contexts:candidate.contexts,
          sourceBuildId:process.env.APP_BUILD_ID!,sourceInventorySha256:checked.inventory,sourceReviewSha256:checked.reviewSha256,
          startedAt:new Date(now).toISOString(),deadlineAt:new Date(now+30*60_000).toISOString(),phase:"sampling"};
        await saveUnit();
        await writeColdJson(join(COLD_COPY_ROOT,unit.businessId,unit.jobRunId,"intent.json"),{
          contract:"native-cold-copy-intent.v1",businessId:unit.businessId,jobRunId:unit.jobRunId,purpose,
          sourceBuildId:unit.sourceBuildId,sourceInventorySha256:checked.inventory,startedAt:unit.startedAt,deadlineAt:unit.deadlineAt},true);
        global.active={businessId:unit.businessId,jobRunId:unit.jobRunId,purpose};break;
      }
      if(!unit){if(selected.candidates.length<64){global.cursor=null;global.nextEligibleAt=new Date(Date.now()+24*60*60_000).toISOString();}
        await saveGlobal();return {outcome:"no_eligible_original",metadataHeadersRead:selected.candidates.length};}
      await saveGlobal();
    }
    await active();
    if(unit.session){await cleanupOwnedColdSession(db,unit.session);delete unit.session;await saveUnit();}
    if(unit.phase==="sampling"){
      unit.capacityRequest??=await createCapacityRequest(unit.businessId,unit.jobRunId,archiveDigest(`capacity:${unit.purpose}`).slice(0,12),Date.parse(unit.deadlineAt));
      await saveUnit();await waitReplicaAck(unit.capacityRequest,Math.min(Date.now()+100_000,Date.parse(unit.deadlineAt)));
      const before=await freshColdGate(unit,"read-original");unit.measurements={before,after:{}};
      await active();unit.phase="capturing";await saveUnit();
      unit.capture=await runColdChild(unit,"capture");unit.phase="captured";await saveUnit();
    }
    if(unit.phase==="captured"){
      await active();await dropPrivateRestore(unit.purpose);unit.restore=await runColdChild(unit,"restore");
      need(unit.restore?.restored===true&&unit.restore.frozenProofParity===true&&unit.restore.plaintextRestoreDropped===true&&
        unit.restore.completeOriginalCopiesMatch===true,"ACTUAL_FULL_PRIVATE_RESTORE_REQUIRED");unit.phase="restored";await saveUnit();
    }
    if(unit.phase==="restored"){
      await active();unit.replicaRequest??=await createCopyRequest(unit.businessId,unit.jobRunId,unit.purpose,Date.parse(unit.deadlineAt));
      await saveUnit();unit.replicaAck=await waitReplicaAck(unit.replicaRequest,Math.min(Date.now()+100_000,Date.parse(unit.deadlineAt)));
      if(unit.capacityRequest){await removeReplicaRequest(unit.capacityRequest);delete unit.capacityRequest;}
      unit.phase="replicated";await saveUnit();
    }
    const {config}=await readColdPrivateConfig(join(COLD_COPY_ROOT,unit.businessId,unit.jobRunId,"primary"),unit.capture!.proofSha256);
    if(unit.phase==="replicated"){
      const authorize=async(bytes:number)=>{await active();await freshColdGate(unit!,"publish-original",bytes);};
      await ensureTenantRouting(unit.purpose,authorize);
      unit.publication=await publishServedOriginal(config,unit.capture!.leafSha256,unit.purpose,authorize);
      unit.phase="published";await saveUnit();
    }
    if(unit.phase==="published"){
      await active();
      // Reserve BOTH phases before any source retirement. Reserving the second
      // half only after COMMIT could exhaust our own budget after deleting it.
      if(!unit.httpBudget){const requests=unit.capture!.samples.length*2,downloadBytes=unit.capture!.archiveBytes*4;
        reserveColdReads(global,unit.businessId,requests,downloadBytes);await saveGlobal();
        unit.httpBudget={reservedAt:new Date().toISOString(),requests,downloadBytes};await saveUnit();}
      unit.httpBefore=await collectColdHttpProof(db,unit,config,"before",saveUnit);
      unit.phase="http_verified";await saveUnit();
    }
    if(unit.phase==="http_verified"){
      await active();unit.httpBefore=await verifyColdHttpProof(unit,config,"before");
      const pins=await runColdChild(unit,"pins");need(pins.selectedPinClosureMatches===true,"FRESH_SELECTED_PIN_CLOSURE_REQUIRED");
      const gate=await freshColdGate(unit,"retire-original",0,true);
      unit.phase="retiring";await saveUnit();
      unit.retirement=await runColdChild(unit,"retire",async prepared=>{
        await active();need(Date.now()-Date.parse(gate.observedAt)<=60_000,"PRE_COMMIT_GATE_EXPIRED");
        need(prepared.preparedSha256===sha256(JSON.stringify(prepared.prepared)),"ACTUAL_PREPARED_DIGEST");
        acceptPrepared(prepared.prepared as Parameters<typeof acceptPrepared>[0],config);
        verifyRuntimeObservation(await coldJson(coldPath("replication","runtime.json")));
        await readReplicaAck(unit!.replicaRequest!);
        need((await resolveBusinessArchiveConfiguration()).rootSha256===unit!.publication!.rootSha256,"PRE_COMMIT_ROOT_UNCHANGED");
        return {action:"COMMIT_EXACT_UNIT_ONCE",preparedSha256:prepared.preparedSha256,
          challengeNonce:prepared.challengeNonce,proofSha256:unit!.capture!.proofSha256};
      });
      need(unit.retirement?.committed===true,"ACTUAL_C3_COMMIT_ACK_REQUIRED");unit.phase="retired";await saveUnit();
      unit.readback=await runColdChild(unit,"readback");need(unit.readback?.exactUnitAbsent===true&&
        unit.readback.retainedRootsFullBytesMatch===true&&unit.readback.inputEvidence?.match===true,"INDEPENDENT_SOURCE_ABSENCE_AND_RETAINED_BYTES_REQUIRED");
      unit.phase="readback";await saveUnit();
      unit.httpAfter=await collectColdHttpProof(db,unit,config,"after",saveUnit);
      const current=(a:ColdUnitState["httpAfter"])=>a!.current.map(({bodySha256,...x})=>x);
      need(archiveCanonical(current(unit.httpBefore))===archiveCanonical(current(unit.httpAfter)),"NORMAL_CURRENT_ROUTE_CHANGED_BY_RETIREMENT");
      unit.measurements!.after=await freshColdGate(unit,"read-original");
      unit.phase="complete";await saveUnit();
      global.archivedOriginals++;global.lastSuccess={businessId:unit.businessId,jobRunId:unit.jobRunId,purpose:unit.purpose,
        completedAt:new Date().toISOString(),evaluations:unit.evaluations,contexts:unit.contexts,archiveBytes:unit.capture!.archiveBytes,
        privateBytes:unit.restore!.privateBytes,parts:unit.capture!.parts,historicalRequests:unit.httpBefore.requests+unit.httpAfter.requests,
        actualCommitAcknowledged:true,independentReadback:true};
      const after=unit.measurements!.after as any;
      global.observations.push({observedAt:after.observedAt,databaseBytes:after.business.databaseBytes,
        accountedBytes:after.business.databaseAccounting?.accountedDatabaseBytes??after.business.databaseBytes,
        appArchiveBytes:unit.restore!.privateBytes*2+unit.capture!.archiveBytes,replicaAvailableBytes:after.replicaAvailableBytes});
      global.observations=global.observations.slice(-96);global.lastFailure=null;global.active=null;
      global.nextEligibleAt=new Date(Date.now()+COLD_CADENCE_MS).toISOString();await saveGlobal();
      await removeReplicaRequest(unit.replicaRequest!);return {outcome:"archived_original",evaluations:unit.evaluations,contexts:unit.contexts};
    }
    throw Error("COLD_UNRECOGNIZED_PHASE");
  }catch(error){
    const failure=safeError(error);
    if(unit){
      // These stable collector refusals occur before any seal/private write.
      // Preserve every source row and advance; a pinned original must not
      // permanently starve all other closed generations.
      const veto=unit.phase==="capturing"&&(/^(?:RETAINED_(?:SNAPSHOT|ACTION|REUSE)_VETO|RETAINED_(?:FK_PIN|NON_FK|PIN)_VETO:)/.test(failure.code)||
        ["DECLARED_ROW_OR_BYTE_CAP","SERIALIZED_ORIGINAL_CAP","WHOLE_UNIT_SCOPE_MISMATCH:CONTEXT_SHARED"].includes(failure.code));
      if(veto){unit.failure={...failure,phase:unit.phase,observedAt:new Date().toISOString()};unit.phase="owner_attention";await saveUnit();
        if(unit.capacityRequest)await removeReplicaRequest(unit.capacityRequest);
        global.vetoes.push({generation:unit.generation,reason:failure.code,observedAt:new Date().toISOString()});global.vetoes=global.vetoes.slice(-64);
        global.active=null;await saveGlobal();return {outcome:"original_vetoed",reason:failure.code};}
      const retryable=!isRetirementDispatched(unit)&&Date.now()<Date.parse(unit.deadlineAt)&&
        (failure.code.startsWith("COLD_ADMISSION_REFUSED:")||["COLD_HTTP_BUDGET_DEFERRED","REPLICA_ACK_DEADLINE","BUSINESS_ERASURE_TAKES_PRIORITY","COLD_STOP_REQUESTED"].includes(failure.code));
      global.lastFailure={businessId:unit.businessId,jobRunId:unit.jobRunId,purpose:unit.purpose,...failure,observedAt:new Date().toISOString(),retryable};
      if(!retryable){unit.failure={...failure,phase:unit.phase,observedAt:new Date().toISOString()};unit.phase="owner_attention";await saveUnit();}
      await saveGlobal();return {outcome:retryable?"deferred":"owner_attention",reason:failure.code};
    }
    if(failure.code==="BUSINESS_ERASURE_TAKES_PRIORITY")return {outcome:"erasure_priority"};throw error;
  }finally{
    if(locked)await db.query("SELECT pg_advisory_unlock($1::int,0)",[BUSINESS_ERASURE_LOCK_NAMESPACE]);await db.end();
  }
}
