import { Client } from "pg";
import { join } from "node:path";
import { assertSyncLaneEnabled } from "../../lib/sync/global-kill-switch";
import { NATIVE_ARCHIVE_ROOT_ENCODING } from "../../lib/creative-decision-engine/native-archive-root-codec";
import { NATIVE_HISTORICAL_TENANT_OBJECT_LAYOUT } from "../../lib/creative-decision-engine/native-historical-archive";
import { collectWholeOriginal,sealWholeOriginal } from "../native-storage-batch/capture";
import { acceptPrepared,retireOnceWithParentChallenge,unitScope } from "../native-storage-batch/retire";
import { independentReadback,readSelectedPinClosure } from "../native-storage-batch/maintenance";
import { producerExclusionKey } from "../native-storage-batch/input-evidence-lifecycle";
import { unitLockKey } from "../native-storage-batch/backend";
import { canonicalSha,need,safeError,sha256,UUID } from "../native-storage-batch/common";
import { assertColdWriter,COLD_COPY_ROOT,coldDirectory,coldJson } from "./files";
import { verifyRuntimeColdInventory } from "./inventory";
import { restoreOriginalPrivately } from "./private-restore";
import { persistColdPrivateOriginal,readColdPrivateConfig,verifyColdPrivateOriginal } from "./private-original";

for(const k of ["log","info","warn","debug","error"] as const)console[k]=()=>undefined;
const emit=(value:unknown)=>new Promise<void>(r=>process.stdout.write(JSON.stringify(value)+"\n",()=>r()));
let buffered="",waiter:((line:string)=>void)|null=null;const lines:string[]=[];
process.stdin.setEncoding("utf8");process.stdin.on("data",(b:string)=>{
  buffered+=b;if(buffered.length>4*1024**2)process.exit(1);
  let at:number;while((at=buffered.indexOf("\n"))!==-1){const line=buffered.slice(0,at);buffered=buffered.slice(at+1);
    if(waiter){const done=waiter;waiter=null;done(line);}else lines.push(line);}
});
const line=()=>new Promise<string>((resolve,reject)=>{if(lines.length)return resolve(lines.shift()!);waiter=resolve;
  process.stdin.once("end",()=>reject(Error("COLD_CHILD_PROTOCOL_EOF")));});
async function source(op:string){
  const url=process.env.DATABASE_URL;need(url&&new URL(url).pathname==="/adsecute_prod","EXACT_SOURCE_DATABASE_REQUIRED");
  const db=new Client({connectionString:url,application_name:`native-cold-${op}`,connectionTimeoutMillis:4000,query_timeout:8500});
  db.on("error",()=>undefined);await db.connect();
  try{const r=(await db.query("SELECT current_user u,session_user s,current_database() d")).rows[0];
    need(r.u==="adsecute_app"&&r.s==="adsecute_app"&&r.d==="adsecute_prod","EXACT_SOURCE_ROLE_REQUIRED");
    await db.query("SET jit=off");return db;
  }catch(e){await db.end();throw e;}
}
function key(){
  const hex=process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX;
  need(/^[a-f0-9]{64}$/.test(hex??"")&&/^[a-f0-9]{64}$/.test(process.env.NATIVE_COLD_KEY_SHA256??""),"HELD_KEY_RECOVERY_NOT_PINNED");
  const b=Buffer.from(hex!,"hex");need(sha256(b)===process.env.NATIVE_COLD_KEY_SHA256,"HELD_KEY_DIGEST_CHANGED");return b;
}
async function main(){
  assertColdWriter();assertSyncLaneEnabled("native_archive");
  need(process.env.NATIVE_COLD_LIFECYCLE_ENABLED==="true","COLD_LIFECYCLE_DISABLED");
  const inventory=await verifyRuntimeColdInventory(),r=JSON.parse(await line());
  need(r.contract==="native-cold-unit-child.v1"&&["capture","restore","retire","pins","readback"].includes(r.op)&&
    /^[a-f0-9]{12}$/.test(r.purpose??"")&&UUID.test(r.businessId??"")&&UUID.test(r.jobRunId??"")&&
    r.sourceInventorySha256===inventory,"EXACT_COLD_CHILD_REQUEST");
  const directory=join(COLD_COPY_ROOT,r.businessId,r.jobRunId),primary=join(directory,"primary"),recovery=join(directory,"recovery");
  const intent=await coldJson<{contract:string;purpose:string;businessId:string;jobRunId:string;sourceBuildId:string;sourceInventorySha256:string;startedAt:string;deadlineAt:string}>(join(directory,"intent.json"));
  need(intent.purpose===r.purpose&&intent.businessId===r.businessId&&intent.jobRunId===r.jobRunId&&
    intent.sourceBuildId===process.env.APP_BUILD_ID&&intent.sourceInventorySha256===inventory&&intent.contract==="native-cold-copy-intent.v1"&&
    Date.parse(intent.startedAt)<=Date.now()&&Date.now()<Date.parse(intent.deadlineAt)&&
    Date.parse(intent.deadlineAt)-Date.parse(intent.startedAt)===30*60_000,"EXACT_COLD_CAPTURE_INTENT");
  if(r.op==="capture"){
    need(Object.keys(r).sort().join(",")==="businessId,contexts,contract,evaluations,generation,jobRunId,op,purpose,sourceInventorySha256"&&
      r.generation?.businessId===r.businessId&&r.generation.jobRunId===r.jobRunId,"EXACT_COLD_CAPTURE_REQUEST");
    const db=await source("capture");let original;
    try{original=await collectWholeOriginal(db,{generation:r.generation,expectedEvaluations:r.evaluations,expectedContexts:r.contexts,
      sourceRevision:process.env.APP_BUILD_ID!,consumerInventorySha256:inventory,archiveMetadataEncoding:NATIVE_ARCHIVE_ROOT_ENCODING});}
    finally{await db.end();}
    const held=key();
    try{
      const sealed=sealWholeOriginal(original,process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID??"",held,
        {metadataEncoding:NATIVE_ARCHIVE_ROOT_ENCODING,objectLayout:NATIVE_HISTORICAL_TENANT_OBJECT_LAYOUT});
      await coldDirectory(primary);await coldDirectory(recovery);
      for(const p of [primary,recovery])await persistColdPrivateOriginal(p,sealed,original.config);
      const identities=new Map(original.identities.map(x=>[x.evaluationId,x]));
      // Every encrypted fragment gets a real HTTP read. Up to eight parts also
      // read both ends; larger packages stay within16 samples and preserve
      // the existing shared historical-reader request budget.
      const sampleIds=sealed.metadata.parts.length<=8?sealed.metadata.parts.flatMap(p=>[p.firstEvaluationId,p.lastEvaluationId]):
        sealed.metadata.parts.map(p=>p.firstEvaluationId);
      const samples=[...new Set(sampleIds)].map(id=>identities.get(id)!);
      return emit({type:"result",value:{proofSha256:original.proofSha256,leafSha256:sealed.metadata.leafSha256,
        archiveBytes:sealed.metadata.archiveBytes,parts:sealed.metadata.parts.length,samples,
        evaluations:original.config.evaluations,contexts:original.config.contexts,encodedRows:original.encodedRows,
        capturedAt:new Date().toISOString(),rssBytes:process.memoryUsage().rss}});
    }finally{held.fill(0);}
  }
  need(Object.keys(r).sort().join(",")==="businessId,contract,jobRunId,op,proofSha256,purpose,sourceInventorySha256","EXACT_COLD_STAGE_REQUEST");
  const {config}=await readColdPrivateConfig(primary,r.proofSha256);unitScope(config,r.proofSha256);
  need(config.generation.businessId===r.businessId&&config.generation.jobRunId===r.jobRunId&&
    config.consumerInventorySha256===inventory&&canonicalSha(config)===r.proofSha256,"FROZEN_COLD_UNIT_BINDING");
  if(r.op==="restore"){
    const held=key();
    try{const original=await verifyColdPrivateOriginal([primary,recovery],held,r.proofSha256);
      return emit({type:"result",value:{...await restoreOriginalPrivately(original.whole,config,r.purpose),
        privateBytes:original.privateBytes,privateFiles:original.files,completeOriginalCopiesMatch:true}});
    }finally{held.fill(0);}
  }
  const db=await source(r.op);
  if(r.op==="retire"){
    // The parent independently verifies this prepared proof and fresh admission;
    // exactly ONE nonce-bound challenge can commit this frozen original.
    const result=await retireOnceWithParentChallenge(db,{config,proofSha256:r.proofSha256,
      unitLockKey:unitLockKey(r.jobRunId),producerLockKey:producerExclusionKey(config.generation)},async prepared=>{
      acceptPrepared(prepared.prepared as Parameters<typeof acceptPrepared>[0],config);
      await emit(prepared);return JSON.parse(await line());
    });
    return emit({type:"result",value:result});
  }
  try{return emit({type:"result",value:r.op==="pins"?await readSelectedPinClosure(db,config):await independentReadback(db,config)});}
  finally{await db.end();}
}
void main().then(()=>process.exit(0)).catch(async e=>{await emit({type:"error",...safeError(e)});process.exit(1);});
