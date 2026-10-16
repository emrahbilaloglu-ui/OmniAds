import { statfs } from "node:fs/promises";
import { Client } from "pg";
import { archiveCanonical,archiveDigest,configuredBusinessArchive,readSafeArchiveFile,resolveBusinessArchiveConfiguration } from "../../lib/business-archive-configuration";
import { evaluateDbGrowthFence } from "../../lib/sync/db-growth-fence";
import { assessCompactNativeStorageMaintenanceAdmission,COMPACT_NATIVE_STORAGE_SCOPE,type NativeStorageOperation } from "../../lib/sync/native-storage-maintenance-admission";
import { NATIVE_ARCHIVE_ROOT_ENCODING } from "../../lib/creative-decision-engine/native-archive-root-codec";
import { NATIVE_HISTORICAL_TENANT_OBJECT_LAYOUT } from "../../lib/creative-decision-engine/native-historical-archive";
import { databaseAdmissionFacts } from "../native-storage-batch/maintenance";
import { need } from "../native-storage-batch/common";
import { assertColdWriter,COLD_ROOT,coldJson,coldPath } from "./files";
import { verifyRuntimeColdInventory } from "./inventory";
import { readReplicaAck } from "./replica";
import type { ColdUnitState } from "./types";

const GiB=1024**3;
export async function sourceConnection(operation:"controller"|"facts"){
  need(new URL(process.env.DATABASE_URL??"").pathname==="/adsecute_prod","EXACT_SOURCE_DATABASE_REQUIRED");
  const db=new Client({connectionString:process.env.DATABASE_URL,application_name:`native-cold-${operation}`,
    connectionTimeoutMillis:4000,query_timeout:8500});db.on("error",()=>undefined);await db.connect();
  try{const r=(await db.query("SELECT current_user u,session_user s,current_database() d")).rows[0];
    need(r.u==="adsecute_app"&&r.s==="adsecute_app"&&r.d==="adsecute_prod","EXACT_SOURCE_ROLE_REQUIRED");
    await db.query("SET jit=off; SET statement_timeout='7500ms'; SET lock_timeout='1000ms'");return db;
  }catch(e){await db.end();throw e;}
}
export function verifyRuntimeObservation(r:any,now=Date.now()){
  need(r?.contract==="native-cold-runtime-observation.v1"&&r.valid===true&&
    Date.parse(r.observedAt)<=now&&now-Date.parse(r.observedAt)<=60_000,"FRESH_EXACT_ROLE_OBSERVATION_REQUIRED");
  const roles=r.roles;need(roles&&Object.keys(roles).sort().join(",")==="archive-erasure,web,worker","EXACT_THREE_RUNTIME_ROLES");
  for(const [name,v] of Object.entries(roles) as [string,any][]){
    need(v.running===true&&v.buildId===process.env.APP_BUILD_ID&&v.immutableBuildId===process.env.APP_BUILD_ID&&
      v.ociRevision===process.env.APP_BUILD_ID&&/^sha256:[a-f0-9]{64}$/.test(v.imageId)&&
      v.imageRole===(name==="web"?"web-runner":"worker-runner"),"EXACT_IMMUTABLE_RUNTIME_IMAGES");
    if(name==="worker"){need(v.mounts.length===0,"PROVIDER_WORKER_ARCHIVE_FREE");continue;}
    need(archiveCanonical(v.archive.base)===archiveCanonical(configuredBusinessArchive())&&
      v.archive.activePointer==="/run/adsecute-business-erasure/active.json"&&
      v.archive.keySha256===process.env.NATIVE_COLD_KEY_SHA256&&v.archive.replicaRequired===true,"SAME_WEB_ARCHIVE_CONFIGURATION");
    if(name==="archive-erasure")need(v.archive.coldEnabled===true,"EXPLICIT_ARCHIVE_WRITER_ENABLED");
    for(const [destination,source] of [["/run/adsecute-native-archive","/var/www/adsecute/native-archive"],
      ["/run/adsecute-business-erasure","/var/www/adsecute/business-erasure-control"]]){
      const m=v.mounts.filter((x:any)=>x.destination===destination);
      need(m.length===1&&m[0].type==="bind"&&m[0].source===source&&m[0].writable===(name==="archive-erasure"),"EXACT_SHARED_ARCHIVE_MOUNTS");
    }
  }
  return r.observedAt as string;
}
export async function staticColdGate(){
  assertColdWriter();need(process.env.NATIVE_COLD_REPLICA_REQUIRED==="true","LIFETIME_REPLICA_ERASURE_REQUIRED");
  const inventory=await verifyRuntimeColdInventory();
  const reviewBytes=await readSafeArchiveFile(coldPath("source-review.json"),128*1024);
  need(archiveDigest(reviewBytes)===process.env.NATIVE_COLD_SOURCE_REVIEW_SHA256,"ACTUAL_REVIEW_DIGEST_REQUIRED");
  const review=JSON.parse(reviewBytes.toString());
  need(review.contract==="native-cold-source-review.v1"&&review.verdict==="APPROVE_EXECUTION"&&
    review.sourceInventorySha256===inventory&&review.reviewer==="Codex"&&review.canonicalPassed===true,"COMPLETED_EXACT_SOURCE_REVIEW_REQUIRED");
  const install=await coldJson<any>(coldPath("installation.json"));
  need(install.contract==="native-cold-installation.v1"&&install.sourceInventorySha256===inventory&&
    install.keySha256===process.env.NATIVE_COLD_KEY_SHA256&&install.offlineRecoveryMatch===true&&
    install.sourceDataAndWalSameDevice===true&&install.replicaRootSeparateFromSourceData===true&&
    install.restoreDataAndSocketOnAppRoot===true&&install.privateRestoreNetwork==="none", "EXACT_COLD_INSTALLATION_REQUIRED");
  verifyRuntimeObservation(await coldJson(coldPath("replication","runtime.json")));
  return {inventory,reviewSha256:archiveDigest(reviewBytes)};
}
/** Full DB/physical proof runs BEFORE the retirement child acquires AX locks.
 * The parent callback below must never re-query either locked source table. */
export async function freshColdGate(s:ColdUnitState,operation:NativeStorageOperation,serializedBytes=0,pins=false){
  const checked=await staticColdGate();need(checked.inventory===s.sourceInventorySha256&&checked.reviewSha256===s.sourceReviewSha256,"FROZEN_REVIEW_REQUIRED");
  const ack=await readReplicaAck(s.replicaRequest??s.capacityRequest!);
  const db=await sourceConnection("facts");let facts;
  try{facts=await databaseAdmissionFacts(db,{expectedRole:"adsecute_app",jobRunIds:[s.jobRunId],
    knownApplicationNames:["omniads-web","omniads-worker","native-cold-controller","native-cold-facts"]});}
  finally{await db.end();}
  const business=await evaluateDbGrowthFence({queryTimeoutMs:8000}),app=await statfs(COLD_ROOT),now=Date.now();
  const active=await resolveBusinessArchiveConfiguration();
  need(!s.publication||active.rootSha256===s.publication.rootSha256,"EXACT_CURRENT_READER_ROOT");
  const proof=s.capture?.proofSha256??archiveDigest(archiveCanonical(s.generation));
  const evidence={operation,observedAt:new Date(now).toISOString(),sourceManifestSha256:checked.inventory,
    actualSourceReviewSha256:checked.reviewSha256,sourceMatches:true,exactRolesAndReaderRootMatch:facts.roleMatches,
    unknownDatabaseConsumers:facts.unknownDatabaseConsumers,nativeProducerIdle:facts.nativeProducerIdle,
    originalRows:s.evaluations,originalContexts:s.contexts,serializedArchiveBytes:serializedBytes,
    appVolume:{observedAt:new Date(now).toISOString(),availableBytes:app.bavail*app.bsize,minimumFreeBytes:8*GiB},
    walVolume:{observedAt:business.physical?.sampledAt??"",availableBytes:business.physical?.availableBytes??-1,minimumFreeBytes:40*GiB},
    independentOriginalRestoreMatches:s.restore?.frozenProofParity===true&&s.restore.plaintextRestoreDropped===true,
    completeOriginalCopiesMatch:s.restore?.completeOriginalCopiesMatch===true&&(!s.replicaRequest||ack.kind==="copy"),
    freshHistoricalHttpMatches:!!s.httpBefore,selectedPinClosureMatches:pins,
    alreadyAbsentWithEnforcedLineage:facts.lineage.absent===true,scopeContract:COMPACT_NATIVE_STORAGE_SCOPE,
    archiveMetadataEncoding:NATIVE_ARCHIVE_ROOT_ENCODING,archiveObjectLayout:NATIVE_HISTORICAL_TENANT_OBJECT_LAYOUT,
    originalProofSha256:proof,replicaVolume:ack.replicaVolume};
  const decision=assessCompactNativeStorageMaintenanceAdmission({business,evidence,expectedDatabaseBudgetBytes:163*GiB,nowMs:now});
  need(decision.admitted,`COLD_ADMISSION_REFUSED:${decision.issues.join(",")}`);
  return {observedAt:evidence.observedAt,business,facts,appAvailableBytes:evidence.appVolume.availableBytes,
    replicaAvailableBytes:ack.replicaVolume.availableBytes,decision};
}
