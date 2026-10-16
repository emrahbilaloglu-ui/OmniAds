import { constants } from "node:fs";
import { lstat, mkdir, open, realpath, unlink, link } from "node:fs/promises";
import { join, resolve, isAbsolute } from "node:path";
import { nativeArchiveByteDigest, openImmutableNativeHistoricalArchiveCatalog } from "./native-historical-archive";
import { decodeNativeHistoricalRoutingRoot, decodeNativeHistoricalRoutingShard, decodeNativeHistoricalRoutingLeaf,
  NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT, NATIVE_HISTORICAL_ROUTING_BOUNDS as bounds,
  type NativeHistoricalMetadataRead } from "./native-historical-catalog-routing";
import { readLocalNativeHistoricalMetadata } from "./native-historical-catalog-routing-store";
import type { TenantCatalogDelta, TenantCatalogFile } from "./native-tenant-catalog";

const cap={root:bounds.rootBytes,legacy:bounds.legacyBytes,shard:bounds.shardBytes,leaf:bounds.leafBytes};
const UUID=/^[a-f0-9]{8}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{4}-[a-f0-9]{12}$/;
function need(value:unknown):asserts value {if(!value)throw new Error("native_tenant_catalog_store_refused");}
function reference(f:TenantCatalogFile):NativeHistoricalMetadataRead {
  need(Object.hasOwn(cap,f.kind)&&/^[a-f0-9]{64}$/.test(f.sha256)&&Number.isSafeInteger(f.bytes)&&
    f.bytes>0&&f.bytes<=cap[f.kind]&&f.content.length===f.bytes&&nativeArchiveByteDigest(f.content)===f.sha256&&
    (f.kind==="leaf"?UUID.test(f.businessId??""):f.businessId===undefined));
  return {kind:f.kind,sha256:f.sha256,bytes:f.bytes,maxBytes:cap[f.kind],...(f.businessId?{businessId:f.businessId}:{})};
}
async function safeDirectory(path:string,uid:number) {
  need(isAbsolute(path)&&resolve(path)===path&&await realpath(path)===path);
  const s=await lstat(path);need(s.isDirectory()&&!s.isSymbolicLink()&&s.uid===uid&&!(s.mode&0o022));return s;
}
async function syncDirectory(path:string) {const d=await open(path,constants.O_RDONLY|constants.O_DIRECTORY|constants.O_NOFOLLOW);try{await d.sync();}finally{await d.close();}}
async function ensureDirectory(path:string,uid:number){await mkdir(path,{mode:0o700}).catch(e=>{if(e.code!=="EEXIST")throw e;});await safeDirectory(path,uid);}

/** Staging only: no active pointer, source row, old metadata or ciphertext is
 * changed. The caller holds the archive publisher exclusion and pins the
 * previous root again at activation. Every referenced new path is verified. */
export async function persistTenantCatalogDelta(root:string,delta:TenantCatalogDelta,purpose:string) {
  need(/^[a-f0-9]{12}$/.test(purpose)&&delta.contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT&&
    delta.providerAuthority===false&&delta.reclaimEligible===false&&delta.files.length>0&&delta.files.length<=514);
  const uid=process.getuid?.();need(uid!==undefined);await safeDirectory(root,uid);
  const roots=delta.files.filter(f=>f.kind==="root");need(roots.length===1);
  const rootFile=roots[0]!;reference(rootFile);
  need(rootFile.sha256===delta.root.sha256&&rootFile.bytes===delta.root.bytes);
  const raw=JSON.parse(rootFile.content.toString("utf8"));
  const decoded=decodeNativeHistoricalRoutingRoot(rootFile.content,delta.root.sha256,raw.legacy?.sha256);
  need(decoded.contract===NATIVE_HISTORICAL_TENANT_ROUTING_CONTRACT);
  const identities=new Set(delta.files.map(f=>JSON.stringify([f.kind,f.businessId??null,f.sha256])));need(identities.size===delta.files.length);
  const staged=new Map(delta.files.map(f=>{reference(f);return [JSON.stringify([f.kind,f.businessId??null,f.sha256]),f];}));
  for(const kind of Object.keys(cap))await ensureDirectory(join(root,kind),uid);
  for(const f of delta.files){
    let directory=join(root,f.kind);if(f.businessId){directory=join(directory,f.businessId);await ensureDirectory(directory,uid);}
    const target=join(directory,`${f.sha256}.json`),temporary=join(directory,`.${purpose}-${f.sha256}.writing`);
    // A crash can happen after chmod/link but before unlinking our temporary
    // alias. Recover only the exact owned content/prefix; a two-link inode must
    // name BOTH this target and this exact purpose-bound temporary name.
    try{
      const old=await open(temporary,constants.O_RDONLY|constants.O_NOFOLLOW|constants.O_NONBLOCK);
      try{const s=await old.stat();need(s.isFile()&&[1,2].includes(s.nlink)&&s.uid===uid&&!(s.mode&0o022)&&s.size<=f.bytes);
        const b=Buffer.alloc(s.size+1),r=await old.read(b,0,b.length,0),end=await old.stat();
        need(r.bytesRead===s.size&&end.size===s.size&&end.mtimeMs===s.mtimeMs&&end.ctimeMs===s.ctimeMs&&
          b.subarray(0,r.bytesRead).equals(f.content.subarray(0,s.size))&&
          ((s.mode&0o777)===0o600||s.size===f.bytes&&(s.mode&0o777)===0o440));
        if(s.nlink===2){const named=await lstat(target);need(named.dev===s.dev&&named.ino===s.ino&&s.size===f.bytes);}
      }finally{await old.close();}
      await unlink(temporary);await syncDirectory(directory);
    }catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    let existing=false;
    try{await lstat(target);existing=true;}catch(e){if((e as NodeJS.ErrnoException).code!=="ENOENT")throw e;}
    if(!existing){
      const output=await open(temporary,constants.O_WRONLY|constants.O_CREAT|constants.O_EXCL|constants.O_NOFOLLOW,0o600);
      try{await output.writeFile(f.content);await output.chmod(0o440);await output.sync();}finally{await output.close();}
      try{await link(temporary,target);}catch(e){if((e as NodeJS.ErrnoException).code!=="EEXIST")throw e;}
      await unlink(temporary);await syncDirectory(directory);
    }
    await readLocalNativeHistoricalMetadata(root,reference(f));
  }
  const legacyBytes=await readLocalNativeHistoricalMetadata(root,{kind:"legacy",...decoded.legacy,maxBytes:cap.legacy});
  const legacy=openImmutableNativeHistoricalArchiveCatalog(legacyBytes,decoded.legacy.sha256);
  need(JSON.stringify([...new Set(legacy.entries.map(e=>e.generation.jobRunId))].sort())===JSON.stringify(decoded.legacy.jobRunIds));
  const referencedLeaves=new Set<string>(),referencedShards=new Set<string>();
  for(const s of decoded.shards){
    const content=await readLocalNativeHistoricalMetadata(root,{kind:"shard",...s,maxBytes:cap.shard});
    const shard=decodeNativeHistoricalRoutingShard(content,s,decoded.legacy.jobRunIds);referencedShards.add(s.sha256);
    // New shards may introduce leaves. Unchanged shards remain bound by the
    // previous root; the caller verifies its unchanged references at activation.
    if(!staged.has(JSON.stringify(["shard",null,s.sha256])))continue;
    for(const record of shard.records){
      const ref={kind:"leaf" as const,...record.leaf,businessId:record.generation.businessId,maxBytes:cap.leaf};
      const leaf=await readLocalNativeHistoricalMetadata(root,ref);
      decodeNativeHistoricalRoutingLeaf(leaf,ref.sha256,record.generation,ref.bytes);
      referencedLeaves.add(JSON.stringify([ref.businessId,ref.sha256]));
    }
  }
  need(delta.files.every(f=>f.kind==="root"||f.kind==="legacy"&&f.sha256===decoded.legacy.sha256||
    f.kind==="shard"&&referencedShards.has(f.sha256)||f.kind==="leaf"&&referencedLeaves.has(JSON.stringify([f.businessId,f.sha256]))));
  await syncDirectory(root);
  return {root:delta.root,previousRootSha256:delta.previousRootSha256,staged:true as const,activated:false as const,
    providerAuthority:false as const,reclaimEligible:false as const};
}
