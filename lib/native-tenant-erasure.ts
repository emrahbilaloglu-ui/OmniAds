import { constants } from "node:fs";
import { lstat, mkdir, open, opendir, rename, unlink,statfs } from "node:fs/promises";
import { dirname, join, relative } from "node:path";
import type { PoolClient } from "pg";
import { activateBusinessArchivePointer,archiveCanonical,archiveDigest,archiveNeed,assertSafeArchiveDirectory,
  businessArchiveBaseFingerprint,BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY,
  configuredBusinessArchive,validateBusinessArchivePointer,readSafeArchiveFile,resolveBusinessArchiveConfiguration,scopedArchivePath,type BusinessArchiveConfiguration,
  type BusinessArchivePointer } from "./business-archive-configuration";
import { inventoryBusinessArchive,prepareLegacyBusinessArchiveErasurePlan,type ArchivedBusinessInputKey } from "./business-archive-erasure";
import { openImmutableNativeHistoricalArchiveCatalog,openNativeHistoricalArchiveEnvelope } from "./creative-decision-engine/native-historical-archive";
import { decodeNativeHistoricalRoutingRoot,decodeNativeHistoricalRoutingShard,NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT,
  NATIVE_HISTORICAL_ROUTING_BOUNDS as caps } from "./creative-decision-engine/native-historical-catalog-routing";
import { readLocalNativeHistoricalMetadata } from "./creative-decision-engine/native-historical-catalog-routing-store";
import { prepareTenantCatalogBusinessRemoval } from "./creative-decision-engine/native-tenant-catalog";
import { assertNativeHistoricalRuntimeObjectBound } from "./creative-decision-engine/native-historical-read-controls";

export const TENANT_ERASURE_CONTRACT="business-tenant-archive-erasure.v1";
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
const SHA=/^[a-f0-9]{64}$/;
const LEAF_PAGE=4,MAX_FILES=2048,MAX_METADATA=16*1024**2;
const INPUT_ROWS_SQL=`SELECT t.contract_version,t.input_hash::text input_hash,to_jsonb(t)::text bytes
  FROM unnest($1::text[],$2::character(64)[]) k(contract_version,input_hash)
  CROSS JOIN LATERAL (SELECT * FROM public.engine_v3_ad_decision_input_evidence i
    WHERE i.contract_version=k.contract_version AND i.input_hash=k.input_hash OFFSET 0) t`;
type FileProof={path:string;sha256:string;bytes:number};
type Publication=FileProof&{contentBase64:string};
export type TenantArchiveErasurePlan={contract:typeof TENANT_ERASURE_CONTRACT;businessId:string;baseFingerprint:string;
  before:BusinessArchiveConfiguration;after:BusinessArchiveConfiguration;pointer:BusinessArchivePointer;
  baseline:FileProof[];remove:string[];publication:Publication[];inputKeys:ArchivedBusinessInputKey[];planSha256:string};
const deadline=(at:number)=>archiveNeed(Date.now()<at);
const identity=(k:{contractVersion:string;inputHash:string})=>JSON.stringify([k.contractVersion,k.inputHash]);
async function absent(path:string){try{await lstat(path);return false;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;return true;}}
async function sync(path:string){const f=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await f.sync();}finally{await f.close();}}
async function discardPartial(root:string,name:string,content:Buffer){
  const pending=scopedArchivePath(root,name)+".writing";if(await absent(pending))return;
  await assertSafeArchiveDirectory(dirname(pending));
  const old=await open(pending,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
  try{const s=await old.stat();archiveNeed(s.isFile()&&s.nlink===1&&!(s.mode&0o077)&&s.size<=content.length);
    const b=Buffer.alloc(s.size+1),r=await old.read(b,0,b.length,0),end=await old.stat();
    archiveNeed(r.bytesRead===s.size&&end.size===s.size&&end.ctimeMs===s.ctimeMs&&end.mtimeMs===s.mtimeMs&&
      b.subarray(0,r.bytesRead).equals(content.subarray(0,s.size)));}finally{await old.close();}
  await unlink(pending);await sync(dirname(pending));
}
async function put(root:string,name:string,content:Buffer){
  const path=scopedArchivePath(root,name),pieces=name.split("/");let parent=root;await assertSafeArchiveDirectory(root);
  for(const piece of pieces.slice(0,-1)){parent=join(parent,piece);await mkdir(parent,{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});await assertSafeArchiveDirectory(parent);}
  if(!await absent(path)){await readSafeArchiveFile(path,content.length,archiveDigest(content));return;}
  const pending=path+".writing";
  // The durable plan owns only this exact complete content. A partial write
  // may be discarded only after proving it is an exact prefix of that intent.
  await discardPartial(root,name,content);
  const f=await open(pending,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
  try{await f.writeFile(content);await f.sync();}finally{await f.close();}
  await rename(pending,path);await sync(dirname(path));
}
/** Small global routing metadata only. Foreign tenant leaf/ciphertext forests
 * are never enumerated or decoded to erase one business. */
async function routingFiles(root:string,at:number){
  const result:(FileProof&{content:Buffer;kind:"root"|"shard"|"legacy"})[]=[];let total=0;
  const store=join(root,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY);await assertSafeArchiveDirectory(store);
  for(const kind of ["root","shard","legacy"] as const){
    const dir=join(store,kind);await assertSafeArchiveDirectory(dir);const entries=await opendir(dir);
    for await(const entry of entries){deadline(at);archiveNeed(entry.isFile()&&/^[a-f0-9]{64}\.json$/.test(entry.name));
      const path=join(dir,entry.name),sha256=entry.name.slice(0,-5),content=await readSafeArchiveFile(path,
        kind==="legacy"?caps.legacyBytes:kind==="root"?caps.rootBytes:caps.shardBytes,sha256);
      total+=content.length;archiveNeed(total<=MAX_METADATA&&result.length<1024);
      const raw=JSON.parse(content.toString("utf8"));
      if(kind==="root")archiveNeed(decodeNativeHistoricalRoutingRoot(content,sha256,raw.legacy?.sha256).contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT);
      else if(kind==="shard")decodeNativeHistoricalRoutingShard(content,{bucket:raw.bucket,sha256,bytes:content.length},[]);
      else openImmutableNativeHistoricalArchiveCatalog(content,sha256);
      result.push({path:relative(root,path),sha256,bytes:content.length,content,kind});
    }
  }
  return result;
}
async function leafPage(root:string,businessId:string,at:number){
  const path=join(root,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY,"leaf",businessId);
  if(await absent(path))return [];
  await assertSafeArchiveDirectory(path);const entries=await opendir(path),result:FileProof[]=[];
  for await(const entry of entries){deadline(at);archiveNeed(entry.isFile()&&/^[a-f0-9]{64}\.json$/.test(entry.name));
    const sha256=entry.name.slice(0,-5),content=await readSafeArchiveFile(join(path,entry.name),caps.leafBytes,sha256);
    const catalog=openImmutableNativeHistoricalArchiveCatalog(content,sha256);
    archiveNeed(catalog.entries.length>0&&catalog.entries.every(e=>e.generation.businessId===businessId));
    result.push({path:relative(root,join(path,entry.name)),sha256,bytes:content.length});if(result.length===LEAF_PAGE)break;
  }
  return result;
}

/** One finite page, persisted before any mutation. Shared input keys are
 * carried across pages only while a full original row is ACTUALLY live. D150
 * retirement already proves every absent archived key has zero live references;
 * business deletion still captures every live owned evaluation's keys and
 * applies its indexed GLOBAL reference proof under writer exclusion. */
export async function prepareTenantArchiveErasurePlan(businessId:string,client:Pick<PoolClient,"query">,at:number,
  previousKeys:ArchivedBusinessInputKey[]=[]):Promise<TenantArchiveErasurePlan>{
  deadline(at);archiveNeed(UUID.test(businessId));
  const before=await resolveBusinessArchiveConfiguration(),root=before.localRoot;
  archiveNeed(root&&before.routingEnabled&&before.rootSha256&&before.catalogSha256&&before.catalogPath&&
    before.routingDirectory===join(root,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY));
  const legacy=await prepareLegacyBusinessArchiveErasurePlan(businessId,client,at,
    {...before,routingEnabled:false,routingDirectory:null,rootSha256:null},true);
  const legacyBytes=await readSafeArchiveFile(before.catalogPath,caps.legacyBytes,before.catalogSha256);
  const rootBytes=await readLocalNativeHistoricalMetadata(before.routingDirectory,{kind:"root",sha256:before.rootSha256,maxBytes:caps.rootBytes});
  const decoded=decodeNativeHistoricalRoutingRoot(rootBytes,before.rootSha256,before.catalogSha256);
  archiveNeed(decoded.contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT);
  const shards:Buffer[]=[];
  for(const s of decoded.shards){deadline(at);const b=await readLocalNativeHistoricalMetadata(before.routingDirectory,{kind:"shard",...s,maxBytes:caps.shardBytes});
    decodeNativeHistoricalRoutingShard(b,s,decoded.legacy.jobRunIds);shards.push(b);}
  const delta=prepareTenantCatalogBusinessRemoval({root:rootBytes,rootSha256:before.rootSha256,legacy:legacyBytes,shards,businessId});
  const nextRoot=JSON.parse(delta.files.find(f=>f.kind==="root")!.content.toString("utf8"));
  const nextLegacy=delta.files.find(f=>f.kind==="legacy")!;
  const catalogPath=`filtered/${nextLegacy.sha256}.json`;
  const publication:Publication[]=[...legacy.publication,
    {path:catalogPath,sha256:nextLegacy.sha256,bytes:nextLegacy.bytes,contentBase64:nextLegacy.content.toString("base64")},
    ...delta.files.map(f=>({path:`${BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY}/${f.kind}/${f.sha256}.json`,
      sha256:f.sha256,bytes:f.bytes,contentBase64:f.content.toString("base64")}))];
  const byPublication=new Map(publication.map(f=>[f.path,f]));
  const routing=await routingFiles(root,at),leaves=await leafPage(root,businessId,at),baseline:FileProof[]=[...legacy.baseline,...routing,...leaves];
  const remove=new Set(legacy.remove),keys=new Map([...previousKeys,...legacy.inputKeys].map(k=>[identity(k),k]));
  const retainedShards=new Set<string>(nextRoot.shards.map((s:{sha256:string})=>s.sha256));
  for(const f of routing)if(f.kind==="root"?f.sha256!==delta.root.sha256:f.kind==="shard"?!retainedShards.has(f.sha256):f.sha256!==nextLegacy.sha256)remove.add(f.path);
  const inputKeys=new Map<string,[string,string]>();
  for(const leaf of leaves){deadline(at);const content=await readSafeArchiveFile(join(root,leaf.path),leaf.bytes,leaf.sha256);
    const catalog=openImmutableNativeHistoricalArchiveCatalog(content,leaf.sha256);
    for(const e of catalog.entries){deadline(at);
      assertNativeHistoricalRuntimeObjectBound(e);
      archiveNeed(e.generation.businessId===businessId&&(e.object.layout==="tenant.v1"||
        e.object.layout===undefined&&legacy.baseline.some(f=>f.path===e.object.key&&f.sha256===e.ciphertextSha256))&&
        e.encryptionKeyId===process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID&&
        /^[a-f0-9]{64}$/.test(process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX??""));
      const bytes=await readSafeArchiveFile(scopedArchivePath(root,e.object.key),e.ciphertextBytes,e.ciphertextSha256);
      const opened=openNativeHistoricalArchiveEnvelope(bytes,e,Buffer.from(process.env.ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX!,"hex"),e.generation);
      for(const row of opened.view.readCoreTable("engine_v3_ad_decision_input_evidence")){
        const v=JSON.parse(row.rowJson);archiveNeed(typeof v.contract_version==="string"&&v.contract_version.length<=256&&SHA.test(v.input_hash));
        inputKeys.set(JSON.stringify([v.contract_version,v.input_hash]),[v.contract_version,v.input_hash]);archiveNeed(inputKeys.size<=12800);
      }
      baseline.push({path:e.object.key,sha256:e.ciphertextSha256,bytes:e.ciphertextBytes});remove.add(e.object.key);
    }
    remove.add(leaf.path);
  }
  const tuples=[...inputKeys.values()];
  for(let i=0;i<tuples.length;i+=400){deadline(at);
    const page=tuples.slice(i,i+400),values=[page.map(k=>k[0]),page.map(k=>k[1])];
    const plans=(await client.query(`EXPLAIN (FORMAT JSON) ${INPUT_ROWS_SQL}`,values)).rows;
    let probes=0,nodes=0;
    const walk=(n:Record<string,unknown>)=>{archiveNeed(++nodes<=2048&&n&&typeof n==="object");
      if(n["Relation Name"]==="engine_v3_ad_decision_input_evidence"){
        archiveNeed(["Index Scan","Index Only Scan"].includes(String(n["Node Type"]))&&
          /contract_version.*=/.test(String(n["Index Cond"]))&&/input_hash.*=/.test(String(n["Index Cond"])));probes++;}
      for(const child of (n.Plans??[]) as Record<string,unknown>[])walk(child);};
    archiveNeed(plans.length===1&&plans[0]["QUERY PLAN"]?.length===1);walk(plans[0]["QUERY PLAN"][0].Plan);archiveNeed(probes>0);
    const present=(await client.query<{contract_version:string;input_hash:string;bytes:string}>(INPUT_ROWS_SQL,values)).rows;
    archiveNeed(present.length<=page.length&&present.every(r=>page.some(k=>k[0]===r.contract_version&&k[1]===r.input_hash)));
    for(const row of present){const key={contractVersion:row.contract_version,inputHash:row.input_hash,frozenRowSha256:archiveDigest(row.bytes)};
      const old=keys.get(identity(key));archiveNeed(!old||old.frozenRowSha256===key.frozenRowSha256);keys.set(identity(key),key);}
  }
  archiveNeed(keys.size<=16384&&baseline.length<=MAX_FILES);
  const pointer:BusinessArchivePointer={contract:BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT,baseFingerprint:businessArchiveBaseFingerprint(),
    catalog:{path:catalogPath,sha256:nextLegacy.sha256},routing:{directory:BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY,sha256:delta.root.sha256}};
  const after={...before,catalogPath:join(root,catalogPath),catalogSha256:nextLegacy.sha256,rootSha256:delta.root.sha256};
  const body={contract:TENANT_ERASURE_CONTRACT as typeof TENANT_ERASURE_CONTRACT,businessId,baseFingerprint:businessArchiveBaseFingerprint(),before,after,pointer,
    baseline:[...new Map(baseline.map(f=>[f.path,{path:f.path,sha256:f.sha256,bytes:f.bytes}])).values()],
    remove:[...remove].filter(p=>!byPublication.has(p)).sort(),publication:[...byPublication.values()],inputKeys:[...keys.values()]};
  return {...body,planSha256:archiveDigest(archiveCanonical(body))};
}

export function validateTenantArchiveErasurePlan(p:TenantArchiveErasurePlan,businessId:string){
  const {planSha256,...body}=p;
  archiveNeed(p.contract===TENANT_ERASURE_CONTRACT&&UUID.test(businessId)&&p.businessId===businessId&&
    p.baseFingerprint===businessArchiveBaseFingerprint()&&planSha256===archiveDigest(archiveCanonical(body))&&
    p.before.localRoot&&p.before.localRoot===configuredBusinessArchive().localRoot&&p.before.localRoot===p.after.localRoot&&
    p.before.transport==="filesystem"&&p.before.routingEnabled===true&&configuredBusinessArchive().routingEnabled===true&&
    p.baseline.length<=MAX_FILES&&p.inputKeys.length<=16384&&p.publication.length<=514&&
    p.before.routingDirectory===join(p.before.localRoot,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY)&&
    p.after.routingDirectory===p.before.routingDirectory&&p.pointer.contract===BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT);
  validateBusinessArchivePointer(p.pointer,configuredBusinessArchive());
  const baseline=new Map(p.baseline.map(f=>[f.path,f]));archiveNeed(baseline.size===p.baseline.length);
  for(const f of p.baseline){scopedArchivePath(p.before.localRoot,f.path);archiveNeed(SHA.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&f.bytes>0&&f.bytes<=64*1024**2);}
  archiveNeed(new Set(p.remove).size===p.remove.length&&p.remove.every(path=>baseline.has(path)));
  for(const f of p.publication){scopedArchivePath(p.before.localRoot,f.path);const b=Buffer.from(f.contentBase64,"base64");
    archiveNeed(b.length===f.bytes&&b.length<=caps.legacyBytes&&archiveDigest(b)===f.sha256&&!b.includes(businessId)&&!p.remove.includes(f.path));}
  archiveNeed(new Set(p.publication.map(f=>f.path)).size===p.publication.length);
  archiveNeed(p.publication.reduce((n,f)=>n+f.bytes,0)<=2*MAX_METADATA&&new Set(p.inputKeys.map(identity)).size===p.inputKeys.length);
  archiveNeed(archiveCanonical(p.after)===archiveCanonical({...p.before,catalogPath:join(p.before.localRoot,p.pointer.catalog.path),
    catalogSha256:p.pointer.catalog.sha256,rootSha256:p.pointer.routing?.sha256}));
  for(const key of p.inputKeys)archiveNeed(typeof key.contractVersion==="string"&&key.contractVersion.length<=256&&SHA.test(key.inputHash)&&
    (key.frozenRowSha256===null||SHA.test(key.frozenRowSha256)));
}

/** Exact frozen page only; never recursive rm of a live archive forest.
 * Returns incomplete until all selected leaves/objects are independently
 * absent. The durable owner queue carries actual live shared keys to DB GC. */
export async function applyTenantArchiveErasurePlan(p:TenantArchiveErasurePlan,at:number,onPhase?:(phase:"published"|"purging"|"verified")=>Promise<void>){
  validateTenantArchiveErasurePlan(p,p.businessId);deadline(at);const root=p.before.localRoot!;
  for(const f of p.publication){deadline(at);await discardPartial(root,f.path,Buffer.from(f.contentBase64,"base64"));}
  async function verify(){
    for(const f of p.baseline){deadline(at);const path=join(root,f.path);
      if(await absent(path)){archiveNeed(p.remove.includes(f.path));continue;}await readSafeArchiveFile(path,f.bytes,f.sha256);}
    const expected=new Map([...p.baseline,...p.publication].map(f=>[f.path,f]));
    for(const f of await inventoryBusinessArchive(root,new Set(p.remove.filter(s=>s.endsWith(".bin"))),at,true)){
      const known=expected.get(f.path);archiveNeed(known?.sha256===f.sha256&&known.bytes===f.bytes);}
    for(const f of await routingFiles(root,at)){const known=expected.get(f.path);archiveNeed(known?.sha256===f.sha256&&known.bytes===f.bytes);}
  }
  await verify();
  const space=await statfs(root);archiveNeed(space.bavail*space.bsize>=8*1024**3+512*1024**2+p.publication.reduce((n,f)=>n+f.bytes,0));
  for(const f of p.publication){deadline(at);await put(root,f.path,Buffer.from(f.contentBase64,"base64"));}
  const current=await resolveBusinessArchiveConfiguration();
  if(archiveCanonical(current)===archiveCanonical(p.before))await activateBusinessArchivePointer(p.pointer,p.before);
  else archiveNeed(archiveCanonical(current)===archiveCanonical(p.after));
  await onPhase?.("published");
  // Existing readers have a hard 10s total deadline. Preserve obsolete route
  // metadata for that whole interval before unlinking it for the new pointer.
  if(p.before.rootSha256!==p.after.rootSha256){archiveNeed(Date.now()+11_000<at);await new Promise(r=>setTimeout(r,11_000));}
  await verify();await onPhase?.("purging");
  const baseline=new Map(p.baseline.map(f=>[f.path,f]));
  for(const name of p.remove){deadline(at);const path=join(root,name),f=baseline.get(name)!;
    if(await absent(path))continue;await readSafeArchiveFile(path,f.bytes,f.sha256);await unlink(path);await sync(dirname(path));}
  await verify();await onPhase?.("verified");
  return {pageComplete:true as const,remaining:(await leafPage(root,p.businessId,at)).length>0};
}

export async function assertNoTenantArchiveRecords(businessId:string){
  archiveNeed(UUID.test(businessId));const c=await resolveBusinessArchiveConfiguration(),root=c.localRoot;
  archiveNeed(root&&c.routingDirectory===join(root,BUSINESS_ARCHIVE_TENANT_ROUTING_DIRECTORY)&&c.catalogSha256&&c.rootSha256);
  const raw=await readLocalNativeHistoricalMetadata(c.routingDirectory,{kind:"root",sha256:c.rootSha256,maxBytes:caps.rootBytes});
  const decoded=decodeNativeHistoricalRoutingRoot(raw,c.rootSha256,c.catalogSha256);
  archiveNeed(decoded.contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT);
  for(const s of decoded.shards){const b=await readLocalNativeHistoricalMetadata(c.routingDirectory,{kind:"shard",...s,maxBytes:caps.shardBytes});
    archiveNeed(!decodeNativeHistoricalRoutingShard(b,s,decoded.legacy.jobRunIds).records.some(r=>r.generation.businessId===businessId));}
  for(const f of await routingFiles(root,Date.now()+30_000))archiveNeed(!f.content.includes(businessId));
  for(const path of [join(c.routingDirectory,"leaf",businessId),join(root,"native","v2",businessId)]){
    if(await absent(path))continue;await assertSafeArchiveDirectory(path);const dir=await opendir(path);
    for await(const _entry of dir){archiveNeed(false);}
  }
  for(const f of await inventoryBusinessArchive(root,new Set(),Date.now()+30_000,true)){
    const content=f.content;archiveNeed(!content?.includes(businessId));}
}
