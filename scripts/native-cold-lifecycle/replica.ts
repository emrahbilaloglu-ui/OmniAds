import { readdir,unlink,rmdir } from "node:fs/promises";
import { join } from "node:path";
import { archiveCanonical,archiveDigest,readSafeArchiveFile } from "../../lib/business-archive-configuration";
import { need,UUID,SHA } from "../native-storage-batch/common";
import { COLD_COPY_ROOT,coldDirectory,coldJson,coldPath,writeColdJson } from "./files";
export interface ReplicaFile {name:string;sha256:string;bytes:number}
export interface ReplicaRequest {contract:"native-cold-replica-request.v1";kind:"copy"|"erase";businessId:string;
  purpose:string;jobRunId:string|null;expiresAt:string|null;files:ReplicaFile[]}
export interface ReplicaAck {contract:"native-cold-replica-ack.v1";kind:"copy"|"erase";businessId:string;purpose:string;
  jobRunId:string|null;manifestSha256:string;files:ReplicaFile[];observedAt:string;verified:true;sourceDeleted:false;
  replicaVolume:{observedAt:string;availableBytes:number;minimumFreeBytes:number;device:string;host:"87.99.149.56";scope:"db-root"}}
const PURPOSE=/^[a-f0-9]{12}$/;
const NAME=/^(?:[a-f0-9]{64}\.bin|leaf-[a-f0-9]{64}\.json|capture\.json|config\.json\.gz)$/;
function request(m:ReplicaRequest){
  need(m.contract==="native-cold-replica-request.v1"&&["copy","erase"].includes(m.kind)&&UUID.test(m.businessId)&&PURPOSE.test(m.purpose),"EXACT_REPLICA_REQUEST");
  if(m.kind==="erase"){need(m.jobRunId===null&&m.expiresAt===null&&m.files.length===0,"EXACT_REPLICA_ERASURE");return;}
  need(UUID.test(m.jobRunId??"")&&m.files.length>=4&&m.files.length<=19&&new Set(m.files.map(f=>f.name)).size===m.files.length&&
    m.files.every(f=>NAME.test(f.name)&&SHA.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=4*1024**2)&&
    m.files.reduce((n,f)=>n+f.bytes,0)<=32*1024**2&&typeof m.expiresAt==="string"&&Number.isFinite(Date.parse(m.expiresAt)),"FINITE_REPLICA_ORIGINAL");
}
export function verifyReplicaAck(a:ReplicaAck,m:ReplicaRequest,now=Date.now(),requireFresh=true){
  request(m);const sha=archiveDigest(archiveCanonical(m));
  if(m.kind==="copy")need(now<=Date.parse(m.expiresAt!),"REPLICA_PURPOSE_EXPIRED");
  need(a.contract==="native-cold-replica-ack.v1"&&a.kind===m.kind&&a.businessId===m.businessId&&a.purpose===m.purpose&&
    a.jobRunId===m.jobRunId&&a.manifestSha256===sha&&archiveCanonical(a.files)===archiveCanonical(m.files)&&
    a.verified===true&&a.sourceDeleted===false,"EXACT_REPLICA_ACK");
  const v=a.replicaVolume;
  need(v&&v.host==="87.99.149.56"&&v.scope==="db-root"&&/^\d+$/.test(v.device)&&
    Number.isSafeInteger(v.availableBytes)&&v.minimumFreeBytes===16*1024**3&&v.availableBytes>=v.minimumFreeBytes+512*1024**2,
    "REPLICA_ROOT_RESERVE");
  for(const at of [a.observedAt,v.observedAt])need(Number.isFinite(Date.parse(at))&&Date.parse(at)<=now&&
    (!requireFresh||now-Date.parse(at)<=60_000),"FRESH_REPLICA_ACK_REQUIRED");
  return a;
}
export async function createCopyRequest(businessId:string,jobRunId:string,purpose:string,deadlineAtMs:number){
  need(UUID.test(businessId)&&UUID.test(jobRunId)&&PURPOSE.test(purpose),"EXACT_REPLICA_IDENTITY");
  const directory=join(COLD_COPY_ROOT,businessId,jobRunId,"primary"),names=await readdir(directory);
  need(names.length>=4&&names.length<=19&&names.every(n=>NAME.test(n)),"FINITE_PRIVATE_ORIGINAL_FILES");
  const files:ReplicaFile[]=[];
  for(const name of [...names].sort()){
    const bytes=await readSafeArchiveFile(join(directory,name),4*1024**2);
    files.push({name,sha256:archiveDigest(bytes),bytes:bytes.length});
  }
  need(Number.isFinite(deadlineAtMs)&&deadlineAtMs>Date.now()&&deadlineAtMs<=Date.now()+30*60_000,"FINITE_REPLICA_PURPOSE");
  const m:ReplicaRequest={contract:"native-cold-replica-request.v1",kind:"copy",businessId,purpose,jobRunId,files,expiresAt:new Date(deadlineAtMs).toISOString()};
  request(m);await writeColdJson(coldPath("replication","outbox",businessId,purpose,"manifest.json"),m,true);return m;
}
export async function createEraseRequest(businessId:string,purpose:string){
  const m:ReplicaRequest={contract:"native-cold-replica-request.v1",kind:"erase",businessId,purpose,jobRunId:null,expiresAt:null,files:[]};
  request(m);await writeColdJson(coldPath("replication","outbox",businessId,purpose,"manifest.json"),m,true);return m;
}
export async function readReplicaAck(m:ReplicaRequest){
  const a=await coldJson<ReplicaAck>(coldPath("replication","outbox",m.businessId,m.purpose,"ack.json"),32768);
  return verifyReplicaAck(a,m);
}
export async function waitReplicaAck(m:ReplicaRequest,deadlineAtMs:number){
  while(Date.now()<deadlineAtMs){
    try{return await readReplicaAck(m);}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT"&&!(e instanceof Error&&e.message==="FRESH_REPLICA_ACK_REQUIRED"))throw e;}
    await new Promise(r=>setTimeout(r,1000));
  }
  throw Error("REPLICA_ACK_DEADLINE");
}
export async function removeReplicaRequest(m:ReplicaRequest){
  request(m);const path=coldPath("replication","outbox",m.businessId,m.purpose);await coldDirectory(path);
  const saved=await coldJson<ReplicaRequest>(join(path,"manifest.json"),32768);
  need(archiveCanonical(saved)===archiveCanonical(m),"EXACT_REPLICA_OUTBOX_REMOVAL");
  const names=await readdir(path);need(names.every(n=>["manifest.json","ack.json","ack.json.pending"].includes(n)),"UNKNOWN_REPLICA_OUTBOX_FILE");
  // The single DB replica process prioritizes a live erase request; removing a
  // completed copy request cannot remove its already durable mirrored original.
  for(const name of names)await unlink(join(path,name));await rmdir(path);
}
