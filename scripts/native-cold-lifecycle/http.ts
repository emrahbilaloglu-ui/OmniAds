import { createCipheriv,createDecipheriv,randomBytes,randomUUID } from "node:crypto";
import { lstat,readdir,unlink } from "node:fs/promises";
import { join } from "node:path";
import type { PoolClient } from "pg";
import { archiveCanonical,archiveDigest,readSafeArchiveFile } from "../../lib/business-archive-configuration";
import { cleanupOwnedColdSession,insertOwnedColdSession,type OwnedColdSession } from "../../lib/native-cold-session";
import type { UnitConfig } from "../native-storage-batch/capture";
import { evidencePath,type Sample } from "../native-storage-batch/http-proof";
import { need,UUID,writeExclusive } from "../native-storage-batch/common";
import { coldDirectory,coldJson,coldPath,writeColdJson } from "./files";
import type { ColdUnitState,CurrentReadBaseline } from "./types";

const CONTRACT="native-cold-authenticated-http.v1",MAX=512*1024;
type Phase="before"|"after";
interface BodyRecord {evaluationId:string;path:string;status:number;cacheControl:string;observedAt:string;
  bodySha256:string;bodyBytes:number;cipherSha256:string;file:string;kind:"historical"|"current"}
interface Proof {contract:typeof CONTRACT;businessId:string;jobRunId:string;purpose:string;phase:Phase;rootSha256:string;
  sourceInventorySha256:string;observedAt:string;requests:BodyRecord[];current:CurrentReadBaseline[]}
function held(){const h=process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX;
  need(/^[a-f0-9]{64}$/.test(h??""),"HTTP_PROOF_KEY_REQUIRED");const b=Buffer.from(h!,"hex");
  need(archiveDigest(b)===process.env.NATIVE_COLD_KEY_SHA256,"HTTP_PROOF_HELD_KEY_CHANGED");return b;}
const aad=(s:ColdUnitState,p:Phase,id:string,kind:string)=>Buffer.from(archiveCanonical({contract:CONTRACT,
  businessId:s.businessId,jobRunId:s.jobRunId,purpose:s.purpose,phase:p,evaluationId:id,kind,
  rootSha256:s.publication?.rootSha256,sourceInventorySha256:s.sourceInventorySha256}));
export function sealHttpBody(body:Buffer,key:Buffer,associated:Buffer){
  need(body.length>0&&body.length<=MAX&&key.length===32,"BOUNDED_HTTP_BODY");const nonce=randomBytes(12),cipher=createCipheriv("aes-256-gcm",key,nonce);
  cipher.setAAD(associated);const bytes=Buffer.concat([cipher.update(body),cipher.final()]);
  return Buffer.concat([Buffer.from("NCH1"),nonce,cipher.getAuthTag(),bytes]);
}
export function openHttpBody(cipher:Buffer,key:Buffer,associated:Buffer){
  need(cipher.length>32&&cipher.length<=MAX+32&&cipher.subarray(0,4).toString()==="NCH1"&&key.length===32,"EXACT_HTTP_CIPHER");
  const d=createDecipheriv("aes-256-gcm",key,cipher.subarray(4,16));d.setAAD(associated);d.setAuthTag(cipher.subarray(16,32));
  return Buffer.concat([d.update(cipher.subarray(32)),d.final()]);
}
export function verifyHistoricalBody(body:Buffer,config:UnitConfig,sample:Sample){
  const e=JSON.parse(body.toString("utf8"));
  need(e.status==="historical_available"&&e.authority==="historical_read_only"&&e.providerAuthority===false&&
    e.currentDecisionEligible===false&&e.reclaimEligible===false&&archiveCanonical(e.generation)===archiveCanonical(config.generation)&&
    e.identity?.evaluationId===sample.evaluationId&&e.identity?.providerAccountId===sample.providerAccountId&&e.identity?.adId===sample.adId&&
    typeof e.rowJson?.evaluation==="string"&&archiveDigest(e.rowJson.evaluation)===config.evaluationRowSha256[sample.evaluationId],
    "ACTUAL_HTTP_ORIGINAL_BODY_MISMATCH");return e;
}
async function get(token:string,path:string){
  need(path.startsWith("/api/creatives/decision-engine-v3/evidence?"),"FIXED_HISTORICAL_HTTP_ROUTE");
  const response=await fetch("http://web:3000"+path,{method:"GET",redirect:"error",headers:{Cookie:`omniads_session=${token}`,
    Origin:"https://adsecute.com"},signal:AbortSignal.timeout(20_000)});
  const stream=response.body?.getReader();need(stream,"COMPLETE_HTTP_RESPONSE_REQUIRED");const chunks:Uint8Array[]=[];let bytes=0;
  try{for(;;){const r=await stream.read();if(r.done)break;bytes+=r.value.length;need(bytes<=MAX,"HTTP_RESPONSE_BOUND");chunks.push(r.value);}}
  finally{stream.releaseLock();}
  need(bytes>0,"NONEMPTY_ACTUAL_HTTP_BODY");return {status:response.status,body:Buffer.concat(chunks),
    cacheControl:response.headers.get("cache-control")??"",observedAt:new Date().toISOString()};
}
function currentSummary(body:Buffer,status:number,sample:Sample,asOf:string):CurrentReadBaseline{
  const b=JSON.parse(body.toString("utf8"));need(b.status!=="historical_available","CURRENT_ROUTE_UNEXPECTED_HISTORICAL_RESULT");
  return {providerAccountId:sample.providerAccountId,adId:sample.adId,asOfDate:asOf,
    httpStatus:status,status:typeof b.status==="string"?b.status:null,
    error:typeof b.error==="string"&&/^[a-z0-9_]{1,100}$/.test(b.error)?b.error:null,
    bodySha256:archiveDigest(body),historicalAuthority:false};
}
export async function verifyColdHttpProof(state:ColdUnitState,config:UnitConfig,phase:Phase){
  const directory=coldPath("jobs",state.businessId,state.purpose,`http-${phase}`),file=join(directory,"proof.json");
  const proof=await coldJson<Proof>(file,128*1024),key=held();
  try{
    need(proof.contract===CONTRACT&&proof.phase===phase&&proof.businessId===state.businessId&&proof.jobRunId===state.jobRunId&&
      proof.purpose===state.purpose&&proof.rootSha256===state.publication?.rootSha256&&proof.sourceInventorySha256===state.sourceInventorySha256,
      "EXACT_HTTP_PROOF_SCOPE");
    const samples=state.capture!.samples,history=proof.requests.filter(r=>r.kind==="historical");
    need(history.length===samples.length&&new Set(history.map(r=>r.evaluationId)).size===samples.length,"COMPLETE_HTTP_PART_SAMPLE_SET");
    const current:CurrentReadBaseline[]=[];
    for(const r of proof.requests){
      need(UUID.test(r.evaluationId)&&r.file===`${r.kind}-${r.evaluationId}.body.aes`&&Number.isFinite(Date.parse(r.observedAt))&&
        ["historical","current"].includes(r.kind)&&Date.parse(r.observedAt)>=Date.parse(state.publication!.publishedAt)&&
        Date.parse(r.observedAt)<=Date.now()&&Date.now()-Date.parse(r.observedAt)<=10*60_000,"FRESH_ACTUAL_HTTP_BODY");
      const bytes=await readSafeArchiveFile(join(directory,r.file),MAX+32,r.cipherSha256),body=openHttpBody(bytes,key,aad(state,phase,r.evaluationId,r.kind));
      need(body.length===r.bodyBytes&&archiveDigest(body)===r.bodySha256&&/no-store/.test(r.cacheControl),"REHASHED_COMPLETE_HTTP_BODY");
      if(r.kind==="historical"){
        const s=samples.find(s=>s.evaluationId===r.evaluationId);need(s&&r.status===200&&r.path===evidencePath(config.generation,s),"EXACT_LIVE_HISTORICAL_GET");
        verifyHistoricalBody(body,config,s);
      }else{
        const s=samples.find(s=>s.evaluationId===r.evaluationId);need(s,"EXACT_CURRENT_BASELINE_SAMPLE");
        const path="/api/creatives/decision-engine-v3/evidence?"+new URLSearchParams({businessId:state.businessId,
          providerAccountId:s.providerAccountId,adId:s.adId,asOf:config.generation.asOfDate});
        need(r.path===path,"EXACT_NORMAL_CURRENT_GET");current.push(currentSummary(body,r.status,s,config.generation.asOfDate));
      }
    }
    need(current.length===new Set(samples.map(s=>s.providerAccountId)).size&&
      archiveCanonical(current)===archiveCanonical(proof.current),"CURRENT_BASELINE_REDERIVED_FROM_BODY");
    return {proofSha256:archiveDigest(await readSafeArchiveFile(file,128*1024)),requests:history.length,
      observedAt:proof.observedAt,current};
  }finally{key.fill(0);}
}
export async function collectColdHttpProof(db:Pick<PoolClient,"query">,state:ColdUnitState,config:UnitConfig,phase:Phase,
  save:()=>Promise<void>){
  need(state.publication&&state.capture&&state.capture.samples.length>=1&&state.capture.samples.length<=33,"FINITE_AUTHENTICATED_HTTP_SCOPE");
  const owners=(await db.query<{owner:string}>(`SELECT b.owner_id::text owner FROM businesses b JOIN memberships m
    ON m.business_id=b.id AND m.user_id=b.owner_id AND m.role='admin' AND m.status='active'
    WHERE b.id=$1::uuid AND NOT EXISTS(SELECT 1 FROM business_deletion_jobs d WHERE d.business_ref_id=b.id AND d.hidden_at IS NOT NULL)`,[state.businessId])).rows;
  need(owners.length===1&&UUID.test(owners[0]!.owner),"ACTUAL_OWNER_MEMBERSHIP_REQUIRED");
  if(state.session){await cleanupOwnedColdSession(db,state.session);delete state.session;await save();}
  const directory=await coldDirectory(coldPath("jobs",state.businessId,state.purpose,`http-${phase}`));
  // This phase has not dispatched retirement. Refresh only its own fixed proof
  // files, including an incomplete response from an interrupted earlier read.
  const allowed=new Set(["proof.json","proof.json.pending",...state.capture.samples.flatMap(s=>[
    `historical-${s.evaluationId}.body.aes`,`current-${s.evaluationId}.body.aes`])]);
  for(const name of await readdir(directory)){need(allowed.has(name),"OWNED_HTTP_PROOF_FILES_ONLY");const path=join(directory,name),s=await lstat(path);
    need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid?.()&&!(s.mode&0o022)&&s.size<=MAX+32,"OWNED_HTTP_PROOF_FILE");await unlink(path);}
  const token=randomBytes(32).toString("hex"),session:OwnedColdSession={contract:"native-cold-temporary-session.v1",
    sessionId:randomUUID(),userId:owners[0]!.owner,businessId:state.businessId,tokenSha256:archiveDigest(token)};
  state.session=session;await save();
  const key=held(),records:BodyRecord[]=[],current:CurrentReadBaseline[]=[];
  try{
    await insertOwnedColdSession(db,session,token);
    const record=async(s:Sample,kind:"historical"|"current",path:string)=>{
      const r=await get(token,path);need(/no-store/.test(r.cacheControl),"ACTUAL_HTTP_NO_STORE_REQUIRED");
      if(kind==="historical"){need(r.status===200,"LIVE_HISTORICAL_HTTP_NOT_200");verifyHistoricalBody(r.body,config,s);}
      const sealed=sealHttpBody(r.body,key,aad(state,phase,s.evaluationId,kind)),file=`${kind}-${s.evaluationId}.body.aes`;
      await writeExclusive(join(directory,file),sealed);
      records.push({evaluationId:s.evaluationId,path,status:r.status,cacheControl:r.cacheControl,observedAt:r.observedAt,
        bodySha256:archiveDigest(r.body),bodyBytes:r.body.length,cipherSha256:archiveDigest(sealed),file,kind});return r;
    };
    for(const s of state.capture.samples)await record(s,"historical",evidencePath(config.generation,s));
    const byAccount=[...new Map(state.capture.samples.map(s=>[s.providerAccountId,s])).values()];
    for(const s of byAccount){const path="/api/creatives/decision-engine-v3/evidence?"+new URLSearchParams({businessId:state.businessId,
      providerAccountId:s.providerAccountId,adId:s.adId,asOf:config.generation.asOfDate});const r=await record(s,"current",path);
      current.push(currentSummary(r.body,r.status,s,config.generation.asOfDate));}
    const proof:Proof={contract:CONTRACT,businessId:state.businessId,jobRunId:state.jobRunId,purpose:state.purpose,phase,
      rootSha256:state.publication.rootSha256,sourceInventorySha256:state.sourceInventorySha256,observedAt:new Date().toISOString(),requests:records,current};
    await writeColdJson(join(directory,"proof.json"),proof,true);
    return await verifyColdHttpProof(state,config,phase);
  }finally{
    key.fill(0);await cleanupOwnedColdSession(db,session);delete state.session;await save();
  }
}
