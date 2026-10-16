import { constants } from "node:fs";
import { mkdir,open,rename,unlink } from "node:fs/promises";
import { join } from "node:path";
import { activateBusinessArchivePointer,archiveCanonical,archiveDigest,assertSafeArchiveDirectory,businessArchiveBaseFingerprint,
  BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY,
  readSafeArchiveFile,resolveBusinessArchiveConfiguration,type BusinessArchiveConfiguration,type BusinessArchivePointer } from "../../lib/business-archive-configuration";
import { decodeNativeHistoricalRoutingRoot,decodeNativeHistoricalRoutingShard,nativeHistoricalGenerationBucket,
  NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT,NATIVE_HISTORICAL_ROUTING_BOUNDS as bounds } from "../../lib/creative-decision-engine/native-historical-catalog-routing";
import { readLocalNativeHistoricalMetadata } from "../../lib/creative-decision-engine/native-historical-catalog-routing-store";
import { prepareTenantCatalogAppend,prepareTenantCatalogMigration } from "../../lib/creative-decision-engine/native-tenant-catalog";
import { persistTenantCatalogDelta } from "../../lib/creative-decision-engine/native-tenant-catalog-store";
import { openImmutableNativeHistoricalArchiveCatalog,type NativeHistoricalArchiveCatalogEntry } from "../../lib/creative-decision-engine/native-historical-archive";
import { persistLocalNativeArchive } from "../../lib/creative-decision-engine/native-historical-local-store";
import type { UnitConfig } from "../native-storage-batch/capture";
import { need,UUID } from "../native-storage-batch/common";
import { assertColdWriter,COLD_COPY_ROOT } from "./files";

async function immutableFiltered(root:string,content:Buffer){
  need(content.length>0&&content.length<=bounds.legacyBytes,"FINITE_LEGACY_ROUTING");
  const dir=join(root,"filtered"),sha=archiveDigest(content),path=join(dir,`${sha}.json`);
  await mkdir(dir,{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});await assertSafeArchiveDirectory(dir);
  try{await readSafeArchiveFile(path,content.length,sha);return {path:`filtered/${sha}.json`,sha256:sha};}
  catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const pending=join(dir,`.cold-${sha}.pending`);
  try{const f=await open(pending,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
    try{const s=await f.stat();need(s.isFile()&&s.nlink===1&&!(s.mode&0o077)&&s.size<=content.length,"OWNED_FILTERED_PENDING");
      const b=Buffer.alloc(s.size+1),r=await f.read(b,0,b.length,0),end=await f.stat();
      need(r.bytesRead===s.size&&end.size===s.size&&end.ctimeMs===s.ctimeMs&&end.mtimeMs===s.mtimeMs&&
        b.subarray(0,r.bytesRead).equals(content.subarray(0,s.size)),"EXACT_FILTERED_PENDING");}finally{await f.close();}
    await unlink(pending);
  }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  const f=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await f.writeFile(content);await f.sync();}finally{await f.close();}
  await rename(pending,path);const d=await open(dir,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
  try{await d.sync();}finally{await d.close();}
  await readSafeArchiveFile(path,content.length,sha);return {path:`filtered/${sha}.json`,sha256:sha};
}
function configured(c:BusinessArchiveConfiguration){
  assertColdWriter();need(c.transport==="filesystem"&&c.localRoot==="/run/adsecute-native-archive"&&c.routingEnabled&&
    c.routingDirectory&&c.rootSha256&&c.catalogPath&&c.catalogSha256,"EXACT_EXISTING_NATIVE_ARCHIVE");
  return c as BusinessArchiveConfiguration&{localRoot:string;routingDirectory:string;rootSha256:string;catalogPath:string;catalogSha256:string};
}
/** Copy-only one-time conversion. Caller holds the existing publisher/erasure
 * exclusion; all old roots/leaves/ciphertext remain available for rollback. */
export async function ensureTenantRouting(purpose:string){
  const c=configured(await resolveBusinessArchiveConfiguration());
  const legacy=await readSafeArchiveFile(c.catalogPath,bounds.legacyBytes,c.catalogSha256);
  const root=await readLocalNativeHistoricalMetadata(c.routingDirectory,{kind:"root",sha256:c.rootSha256,maxBytes:bounds.rootBytes});
  const decoded=decodeNativeHistoricalRoutingRoot(root,c.rootSha256,c.catalogSha256);
  const target=join(c.localRoot,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY);
  if(decoded.contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT){need(c.routingDirectory===target,"EXACT_TENANT_ROUTING_PATH");return c;}
  const shards:Buffer[]=[],leaves:Buffer[]=[];
  for(const s of decoded.shards){const bytes=await readLocalNativeHistoricalMetadata(c.routingDirectory,{kind:"shard",...s,maxBytes:bounds.shardBytes});
    shards.push(bytes);const shard=decodeNativeHistoricalRoutingShard(bytes,s,decoded.legacy.jobRunIds);
    for(const r of shard.records){need(leaves.length<256,"FINITE_OLD_FOREST_MIGRATION");
      leaves.push(await readLocalNativeHistoricalMetadata(c.routingDirectory,{kind:"leaf",...r.leaf,maxBytes:bounds.leafBytes}));}}
  const delta=prepareTenantCatalogMigration({root,rootSha256:c.rootSha256,legacy,shards,leaves});
  await mkdir(target,{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});await assertSafeArchiveDirectory(target);
  await persistTenantCatalogDelta(target,delta,purpose);const catalog=await immutableFiltered(c.localRoot,legacy);
  return configured(await activateBusinessArchivePointer({contract:BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT,
    baseFingerprint:businessArchiveBaseFingerprint(),catalog,routing:{directory:BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY,sha256:delta.root.sha256}},c));
}

async function readLeaf(config:UnitConfig,leafSha256:string){
  const path=join(COLD_COPY_ROOT,config.generation.businessId,config.generation.jobRunId,"primary",`leaf-${leafSha256}.json`);
  const bytes=await readSafeArchiveFile(path,bounds.leafBytes,leafSha256),catalog=openImmutableNativeHistoricalArchiveCatalog(bytes,leafSha256);
  need(catalog.entries.every(e=>archiveCanonical(e.generation)===archiveCanonical(config.generation)&&e.object.layout==="tenant.v1"),"EXACT_FROZEN_TENANT_LEAF");
  return {bytes,catalog};
}
/** Served objects are copied only from the independently restored, immutable
 * private original. Complete catalog/GCM verification precedes caller admission. */
export async function stageServedOriginal(config:UnitConfig,leafSha256:string){
  const c=configured(await resolveBusinessArchiveConfiguration()),{bytes,catalog}=await readLeaf(config,leafSha256);
  let ciphertextBytes=0;
  for(const e of catalog.entries){
    const copy=join(COLD_COPY_ROOT,config.generation.businessId,config.generation.jobRunId,"primary",`${e.ciphertextSha256}.bin`);
    const content=await readSafeArchiveFile(copy,e.ciphertextBytes,e.ciphertextSha256);
    const result=await persistLocalNativeArchive(c.localRoot,content,e,{layout:"tenant.v1"});
    need(result.object.key===e.object.key,"EXACT_SERVED_OBJECT_KEY");ciphertextBytes+=content.length;
  }
  return {leaf:bytes,entries:catalog.entries,ciphertextBytes};
}
/** Incremental current-root append, never a forest copy. Publication is distinct
 * from source retirement; a crash still leaves the original source intact. */
export async function publishServedOriginal(config:UnitConfig,leafSha256:string,purpose:string){
  const c=configured(await resolveBusinessArchiveConfiguration());
  need(c.routingDirectory===join(c.localRoot,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY)&&UUID.test(config.generation.jobRunId),"TENANT_ROOT_REQUIRED");
  const root=await readLocalNativeHistoricalMetadata(c.routingDirectory,{kind:"root",sha256:c.rootSha256,maxBytes:bounds.rootBytes});
  const decoded=decodeNativeHistoricalRoutingRoot(root,c.rootSha256,c.catalogSha256);
  const bucket=nativeHistoricalGenerationBucket(config.generation.jobRunId),prior=decoded.shards.find(s=>s.bucket===bucket);
  const shard=prior?await readLocalNativeHistoricalMetadata(c.routingDirectory,{kind:"shard",...prior,maxBytes:bounds.shardBytes}):null;
  const previous=prior?decodeNativeHistoricalRoutingShard(shard!,prior,decoded.legacy.jobRunIds).records.find(r=>r.generation.jobRunId===config.generation.jobRunId):null;
  const leaf=await readLeaf(config,leafSha256);
  if(previous){need(archiveCanonical(previous.generation)===archiveCanonical(config.generation)&&previous.leaf.sha256===leafSha256&&previous.leaf.bytes===leaf.bytes.length,"EXACT_EXISTING_GENERATION_ROUTE");
    return {rootSha256:c.rootSha256,publishedAt:new Date().toISOString(),existing:true,previousRootSha256:c.rootSha256};}
  const delta=prepareTenantCatalogAppend({root,rootSha256:c.rootSha256,legacySha256:c.catalogSha256,shard,leaf:leaf.bytes});
  await persistTenantCatalogDelta(c.routingDirectory,delta,purpose);
  const pointer:BusinessArchivePointer={contract:BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT,baseFingerprint:businessArchiveBaseFingerprint(),
    catalog:{path:`filtered/${c.catalogSha256}.json`,sha256:c.catalogSha256},routing:{directory:BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY,sha256:delta.root.sha256}};
  need(c.catalogPath===join(c.localRoot,pointer.catalog.path),"CURRENT_FILTERED_CATALOG_REQUIRED");
  await activateBusinessArchivePointer(pointer,c);
  const publishedAt=new Date().toISOString();
  // Readers reload the pointer before routing and have a hard10s total bound.
  // Preserve their entire interval before removing only superseded metadata.
  await new Promise(r=>setTimeout(r,11_000));
  need(archiveCanonical(await resolveBusinessArchiveConfiguration())===archiveCanonical({...c,rootSha256:delta.root.sha256}),"PUBLISHER_ROOT_CHANGED");
  for(const [kind,sha,maximum] of [["root",c.rootSha256,bounds.rootBytes],...(prior?[["shard",prior.sha256,bounds.shardBytes] as const]:[])] as const){
    const path=join(c.routingDirectory,kind,`${sha}.json`);
    try{await readSafeArchiveFile(path,maximum,sha);await unlink(path);const d=await open(join(c.routingDirectory,kind),constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);
      try{await d.sync();}finally{await d.close();}}
    catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
  }
  return {rootSha256:delta.root.sha256,publishedAt,existing:false,previousRootSha256:c.rootSha256};
}
export type {NativeHistoricalArchiveCatalogEntry};
