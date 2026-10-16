import { join } from "node:path";
import { readSafeArchiveFile } from "./business-archive-configuration";
export interface NativeColdOwnerStatus {status:"disabled"|"running"|"owner_attention"|"unknown";archivedOriginals:number;
  lastCompletedAt:string|null;lastFailureCode:string|null;activePhase:string|null;replicaObservedAt:string|null;
  replicaOutcome:string|null;replicaFresh:boolean}
/** Only used behind requireAdmin; no business/customer screen consumes it. */
export async function getNativeColdOwnerStatus():Promise<NativeColdOwnerStatus>{
  const base:NativeColdOwnerStatus={status:process.env.NATIVE_COLD_LIFECYCLE_ENABLED==="true"?"unknown":"disabled",
    archivedOriginals:0,lastCompletedAt:null,lastFailureCode:null,activePhase:null,replicaObservedAt:null,
    replicaOutcome:null,replicaFresh:false};
  if(process.env.NATIVE_COLD_REPLICA_REQUIRED!=="true")return base;
  const root="/run/adsecute-business-erasure/cold";
  try{
    const worker=JSON.parse((await readSafeArchiveFile("/run/adsecute-business-erasure/health.json",4096)).toString());
    const workerAge=Date.now()-Date.parse(worker.observedAt);
    if(workerAge<0||workerAge>90_000||worker.outcome==="admission_unavailable")base.status="owner_attention";
    const health=JSON.parse((await readSafeArchiveFile(join(root,"replication","health.json"),8192)).toString());
    const age=Date.now()-Date.parse(health.observedAt);
    if(health.contract==="native-cold-replica-health.v1"){
      base.replicaObservedAt=health.observedAt;base.replicaOutcome=health.outcome;base.replicaFresh=age>=0&&age<=90_000;
      if(!base.replicaFresh||health.outcome==="owner_attention")base.status="owner_attention";
    }
    const s=JSON.parse((await readSafeArchiveFile(join(root,"state.json"),4*1024**2)).toString());
    if(s.contract!=="native-cold-controller.v1")throw Error("invalid");
    base.archivedOriginals=Number.isSafeInteger(s.archivedOriginals)?s.archivedOriginals:0;
    base.lastCompletedAt=s.lastSuccess?.completedAt??null;base.lastFailureCode=s.lastFailure?.code??null;
    if(s.active&&/^[a-f0-9-]{36}$/.test(s.active.businessId)&&/^[a-f0-9]{12}$/.test(s.active.purpose)){
      const u=JSON.parse((await readSafeArchiveFile(join(root,"jobs",s.active.businessId,s.active.purpose,"state.json"),4*1024**2)).toString());
      base.activePhase=u.phase;
    }
    if(base.status!=="owner_attention"&&base.status!=="disabled")base.status=
      base.activePhase==="owner_attention"||s.lastFailure?.retryable===false?"owner_attention":base.replicaFresh?"running":"unknown";
    return base;
  }catch{return {...base,status:base.status==="disabled"?"disabled":"unknown"};}
}
