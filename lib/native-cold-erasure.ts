import { constants } from "node:fs";
import { lstat,open,opendir,readdir,rmdir,unlink } from "node:fs/promises";
import { join } from "node:path";
import { archiveCanonical,archiveDigest,assertSafeArchiveDirectory,readSafeArchiveFile } from "./business-archive-configuration";
import { COLD_ROOT,COLD_COPY_ROOT,assertColdWriter,coldJson,coldPath,writeColdJson } from "../scripts/native-cold-lifecycle/files";
import { createEraseRequest,readReplicaAck,removeReplicaRequest,verifyReplicaAck,type ReplicaAck,type ReplicaRequest } from "../scripts/native-cold-lifecycle/replica";
import { need,UUID } from "../scripts/native-storage-batch/common";
import { cleanupOwnedColdSession,type OwnedColdSession } from "./native-cold-session";
import type { PoolClient } from "pg";

export interface ColdBusinessErasureProof {contract:"native-cold-business-erasure.v1";businessId:string;attemptId:string;
  request:ReplicaRequest;ack:ReplicaAck;localCopiesAbsent:true;localJobsAbsent:true;outboxAbsent:true}
const PURPOSE=/^[a-f0-9]{12}$/;
const COPY_FILE=/^(?:[a-f0-9]{64}\.bin|[a-f0-9]{64}\.trust\.json|leaf-[a-f0-9]{64}\.json|capture\.json|config\.json(?:\.gz)?|intent\.json)(?:\.pending)?$/;
async function absent(path:string){try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return true;}}
async function sync(path:string){const f=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await f.sync();}finally{await f.close();}}
export function validateColdBusinessErasureProof(p:ColdBusinessErasureProof,businessId:string,attemptId:string){
  need(p?.contract==="native-cold-business-erasure.v1"&&UUID.test(businessId)&&UUID.test(attemptId)&&
    p.businessId===businessId&&p.attemptId===attemptId&&p.request.kind==="erase"&&p.request.businessId===businessId&&
    p.request.purpose===archiveDigest(`business-erasure:${businessId}:${attemptId}`).slice(0,12)&&
    p.localCopiesAbsent===true&&p.localJobsAbsent===true&&p.outboxAbsent===true,"EXACT_COLD_ERASURE_PROOF");
  // An acknowledged absence stays valid while the hidden-business barrier and
  // shared publisher lock prevent all later copy creation. It need not be
  // re-dated during the existing30m database cleanup transaction.
  verifyReplicaAck(p.ack,p.request,Date.now(),false);
}
export async function assertColdBusinessLocalAbsent(businessId:string){
  need(UUID.test(businessId),"EXACT_COLD_ERASURE_BUSINESS");
  for(const path of [join(COLD_COPY_ROOT,businessId),coldPath("jobs",businessId),coldPath("replication","outbox",businessId)]){
    if(await absent(path))continue;await assertSafeArchiveDirectory(path);
    need((await readdir(path)).length===0,"COLD_BUSINESS_COPIES_REMAIN");
  }
}
/** Exact tenant-owned derived files only. No source DB, key, foreign directory,
 * arbitrary recursive rm, provider operation or customer-visible cleanup. */
async function purgeCopies(businessId:string,deadlineAtMs:number){
  const business=join(COLD_COPY_ROOT,businessId);if(await absent(business))return;
  await assertSafeArchiveDirectory(business);let files=0,jobs=0;
  const entries=await opendir(business);
  for await(const entry of entries){
    need(Date.now()<deadlineAtMs&&entry.isDirectory()&&UUID.test(entry.name)&&++jobs<=30000,"FINITE_OWNED_COLD_COPY_JOBS");
    const path=join(business,entry.name);await assertSafeArchiveDirectory(path);
    const intent=await coldJson<{businessId:string;jobRunId:string;purpose:string}>(join(path,"intent.json"));
    need(intent.businessId===businessId&&intent.jobRunId===entry.name&&PURPOSE.test(intent.purpose),"OWNED_PRIVATE_COPY_INTENT");
    for(const name of await readdir(path)){
      const full=join(path,name);
      if(name==="intent.json")continue;
      need(["primary","recovery"].includes(name),"UNKNOWN_PRIVATE_COPY_PATH");await assertSafeArchiveDirectory(full);
      for(const file of await readdir(full)){
        need(Date.now()<deadlineAtMs&&COPY_FILE.test(file)&&++files<=1000000,"FINITE_OWNED_COLD_COPY_FILES");
        const target=join(full,file),s=await lstat(target);
        need(s.isFile()&&!s.isSymbolicLink()&&s.nlink===1&&s.uid===process.getuid?.()&&!(s.mode&0o022)&&s.size<=4*1024**2,
          "OWNED_PRIVATE_COPY_FILE");
        // Complete or partial/corrupt copies still belong to this exact
        // pre-capture tenant/job intent. Offboarding must erase them as well.
        // Integrity drift refuses copying/retirement; it does not change the
        // ownership of an explicitly erased tenant's private redundant bytes.
        // Partial metadata is owned by this exact pre-capture intent. No
        // successful source retirement can be inferred from a partial file.
        await unlink(target);
      }
      await sync(full);await rmdir(full);
    }
    await unlink(join(path,"intent.json"));await rmdir(path);await sync(business);
  }
  await rmdir(business);await sync(COLD_COPY_ROOT);
}
async function purgeJobJournals(businessId:string,deadlineAtMs:number,client:Pick<PoolClient,"query">){
  const business=coldPath("jobs",businessId);if(await absent(business))return;
  await assertSafeArchiveDirectory(business);let files=0;
  for(const purpose of await readdir(business)){
    need(PURPOSE.test(purpose),"OWNED_COLD_JOB_PURPOSE");const path=join(business,purpose);await assertSafeArchiveDirectory(path);
    const state=await coldJson<{businessId:string;purpose:string;session?:OwnedColdSession}>(join(path,"state.json"));
    need(state.businessId===businessId&&state.purpose===purpose,"OWNED_COLD_JOURNAL_IDENTITY");
    if(state.session){await cleanupOwnedColdSession(client,state.session);delete state.session;await writeColdJson(join(path,"state.json"),state);}
    const walk=async(dir:string,depth:number):Promise<void>=>{
      need(depth<=3,"FINITE_COLD_JOURNAL_DEPTH");await assertSafeArchiveDirectory(dir);
      for(const name of await readdir(dir)){
        need(Date.now()<deadlineAtMs&&++files<=1000000&&/^[a-zA-Z0-9_.-]{1,100}$/.test(name),"FINITE_COLD_JOURNAL_FILES");
        const full=join(dir,name),s=await lstat(full);need(!s.isSymbolicLink()&&s.uid===process.getuid?.()&&!(s.mode&0o022),"OWNED_COLD_JOURNAL_FILE");
        if(s.isDirectory()){await walk(full,depth+1);await rmdir(full);}
        else{need(s.isFile()&&s.nlink===1&&s.size<=4*1024**2,"FINITE_COLD_JOURNAL_FILE");await unlink(full);}
      }
      await sync(dir);
    };
    await walk(path,0);await rmdir(path);
  }
  await rmdir(business);await sync(coldPath("jobs"));
}
async function removeOutbox(businessId:string){
  const path=coldPath("replication","outbox",businessId);if(await absent(path))return;
  await assertSafeArchiveDirectory(path);
  for(const purpose of await readdir(path)){
    need(PURPOSE.test(purpose),"OWNED_REPLICA_OUTBOX_PURPOSE");
    const m=await coldJson<ReplicaRequest>(join(path,purpose,"manifest.json"),32768);
    need(m.businessId===businessId&&m.purpose===purpose,"OWNED_REPLICA_OUTBOX_IDENTITY");await removeReplicaRequest(m);
  }
  await rmdir(path);await sync(coldPath("replication","outbox"));
}

export async function finishColdBusinessErasure(businessId:string,attemptId:string,deadlineAtMs:number,client:Pick<PoolClient,"query">):Promise<{
  waiting:boolean;proof:ColdBusinessErasureProof|null;
}>{
  assertColdWriter();need(UUID.test(businessId)&&UUID.test(attemptId)&&Date.now()<deadlineAtMs,"EXACT_COLD_ERASURE_OPERATION");
  const required=process.env.NATIVE_COLD_REPLICA_REQUIRED==="true";
  const own=!(await absent(join(COLD_COPY_ROOT,businessId)))||!(await absent(coldPath("jobs",businessId)))||
    !(await absent(coldPath("replication","outbox",businessId)));
  if(!required&&!own)return {waiting:false,proof:null};
  const purpose=archiveDigest(`business-erasure:${businessId}:${attemptId}`).slice(0,12),m=await createEraseRequest(businessId,purpose);
  let ack:ReplicaAck;
  try{ack=await readReplicaAck(m);}catch(e){
    if((e as NodeJS.ErrnoException).code==="ENOENT"||e instanceof Error&&e.message==="FRESH_REPLICA_ACK_REQUIRED")return {waiting:true,proof:null};
    throw e;
  }
  // Copy creation for hidden businesses is refused by the lock-owning caller;
  // the single replica process prioritizes erase over every older copy request.
  await purgeCopies(businessId,deadlineAtMs);await purgeJobJournals(businessId,deadlineAtMs,client);await removeOutbox(businessId);
  const global=coldPath("state.json");
  if(!await absent(global)){
    const state=await coldJson<Record<string,unknown>>(global);
    for(const key of ["active","lastSuccess","lastFailure"]){
      const item=state[key] as {businessId?:string}|null|undefined;if(item?.businessId===businessId)state[key]=null;
    }
    const vetoes=state.vetoes as {generation?:{businessId:string}}[]|undefined;
    if(vetoes)state.vetoes=vetoes.filter(x=>x.generation?.businessId!==businessId);
    await writeColdJson(global,state);
  }
  await assertColdBusinessLocalAbsent(businessId);
  const proof:ColdBusinessErasureProof={contract:"native-cold-business-erasure.v1",businessId,attemptId,request:m,ack,
    localCopiesAbsent:true,localJobsAbsent:true,outboxAbsent:true};validateColdBusinessErasureProof(proof,businessId,attemptId);
  return {waiting:false,proof};
}
