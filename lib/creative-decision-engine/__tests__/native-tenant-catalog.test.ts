import { mkdtemp,mkdir,readFile,realpath,rm,lstat,writeFile,link } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach,describe,expect,it,vi } from "vitest";
import { businessArchiveFixture } from "../../../scripts/fixtures/business-archive-erasure";
import { archiveDigest } from "../../business-archive-configuration";
import { buildNativeHistoricalCatalogRouting,NativeHistoricalCatalogRouter,nativeHistoricalGenerationBucket,
  NATIVE_HISTORICAL_ROUTING_BOUNDS as bounds,type NativeHistoricalMetadataRead } from "../native-historical-catalog-routing";
import { prepareTenantCatalogMigration,prepareTenantCatalogAppend,prepareTenantCatalogBusinessRemoval } from "../native-tenant-catalog";
import { persistTenantCatalogDelta } from "../native-tenant-catalog-store";
import { readLocalNativeHistoricalMetadata } from "../native-historical-catalog-routing-store";
import { persistLocalNativeArchive } from "../native-historical-local-store";
import { readNativeHistoricalAdEvidence } from "../native-historical-archive-reader";

const uuid=(n:number)=>`00000000-0000-4000-9000-${String(n).padStart(12,"0")}`;
const roots:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const root of roots.splice(0))await rm(root,{recursive:true,force:true});});
async function world(){
  const base=await realpath(await mkdtemp(join(tmpdir(),"native-tenant-")));roots.push(base);
  const store=join(base,"routing-cas-v1");await mkdir(store,{mode:0o700});
  const legacy=Buffer.from(JSON.stringify({contract:"native-historical-archive-catalog.v1",entries:[]}));
  const old=buildNativeHistoricalCatalogRouting({legacy:{content:legacy,sha256:archiveDigest(legacy)},leaves:[]});
  const root=old.files.find(f=>f.kind==="root")!.content;
  const migrated=prepareTenantCatalogMigration({root,rootSha256:old.root.sha256,legacy,shards:[],leaves:[]});
  await persistTenantCatalogDelta(store,migrated,"a".repeat(12));
  return {base,store,legacy,current:migrated.root,root:migrated.files.find(f=>f.kind==="root")!.content};
}
async function append(w:Awaited<ReturnType<typeof world>>,f:Awaited<ReturnType<typeof businessArchiveFixture>>,purpose:string){
  const r=JSON.parse(w.root.toString("utf8")),bucket=nativeHistoricalGenerationBucket(f.generation.jobRunId),s=r.shards.find((v:{bucket:string})=>v.bucket===bucket);
  const shard=s?await readLocalNativeHistoricalMetadata(w.store,{kind:"shard",...s,maxBytes:bounds.shardBytes}):null;
  const delta=prepareTenantCatalogAppend({root:w.root,rootSha256:w.current.sha256,legacySha256:archiveDigest(w.legacy),shard,leaf:f.leaf!});
  await persistTenantCatalogDelta(w.store,delta,purpose);w.current=delta.root;w.root=delta.files.find(f=>f.kind==="root")!.content;return delta;
}
describe("incremental tenant native catalogs",()=>{
  it("recovers the actual chmod/hardlink crash interval without accepting foreign hardlinks",async()=>{
    const w=await world(),f=await businessArchiveFixture(uuid(10),{compactRoot:true,tenantObjects:true});
    const d=prepareTenantCatalogAppend({root:w.root,rootSha256:w.current.sha256,legacySha256:archiveDigest(w.legacy),shard:null,leaf:f.leaf!});
    const leaf=d.files.find(f=>f.kind==="leaf")!,directory=join(w.store,"leaf",f.generation.businessId),purpose="b".repeat(12);
    await mkdir(directory,{mode:0o700});const temporary=join(directory,`.${purpose}-${leaf.sha256}.writing`),target=join(directory,`${leaf.sha256}.json`);
    await writeFile(temporary,leaf.content,{mode:0o440});await link(temporary,target);expect((await lstat(target)).nlink).toBe(2);
    await persistTenantCatalogDelta(w.store,d,purpose);expect((await lstat(target)).nlink).toBe(1);
    await expect(lstat(temporary)).rejects.toMatchObject({code:"ENOENT"});
    expect(await readFile(target)).toEqual(leaf.content);
  });
  it("appends only one leaf/bucket/root, keeps prior leaf bytes, and resolves an exact tenant before file I/O",async()=>{
    const w=await world(),selected=await businessArchiveFixture(uuid(10),{compactRoot:true,jobRunId:uuid(1)});
    const first=await append(w,selected,"b".repeat(12));
    const oldLeaf=first.files.find(f=>f.kind==="leaf")!,oldPath=join(w.store,"leaf",selected.generation.businessId,`${oldLeaf.sha256}.json`);
    const before=await readFile(oldPath),beforeStat=await lstat(oldPath);
    let n=2;while(nativeHistoricalGenerationBucket(uuid(n))!==nativeHistoricalGenerationBucket(uuid(1)))n++;
    const foreign=await businessArchiveFixture(uuid(11),{compactRoot:true,jobRunId:uuid(n)}),second=await append(w,foreign,"c".repeat(12));
    expect(second.files.map(f=>f.kind).sort()).toEqual(["leaf","root","shard"]);
    expect(await readFile(oldPath)).toEqual(before);expect((await lstat(oldPath)).ino).toBe(beforeStat.ino);
    const template=JSON.parse(await readFile(join(process.cwd(),"scripts/fixtures/native-historical-worker-reference.json"),"utf8"));
    const config={directory:w.store,rootSha256:w.current.sha256,legacySha256:archiveDigest(w.legacy),readerAssetSha256:"a".repeat(64)};
    const calls:NativeHistoricalMetadataRead[]=[],load=async(r:NativeHistoricalMetadataRead)=>{calls.push(r);return readLocalNativeHistoricalMetadata(w.store,r);};
    const router=new NativeHistoricalCatalogRouter();
    const response=await router.resolve({...template.request,generation:selected.generation},config,load);
    expect(response.entry.generation).toEqual(selected.generation);
    expect(calls.find(r=>r.kind==="leaf")?.businessId).toBe(selected.generation.businessId);
    calls.length=0;
    await expect(router.resolve({...template.request,generation:{...selected.generation,businessId:foreign.generation.businessId}},config,load)).rejects.toThrow();
    expect(calls.some(r=>r.kind==="leaf")).toBe(false);
    expect(()=>prepareTenantCatalogAppend({root:w.root,rootSha256:w.current.sha256,legacySha256:archiveDigest(w.legacy),shard:second.files.find(f=>f.kind==="shard")!.content,leaf:foreign.leaf!})).toThrow();
  });
  it("removes one business without copying or changing foreign leaves and serves the foreign encrypted original",async()=>{
    const w=await world(),selected=await businessArchiveFixture(uuid(10),{compactRoot:true,tenantObjects:true}),foreign=await businessArchiveFixture(uuid(11),{compactRoot:true,tenantObjects:true});
    await append(w,selected,"b".repeat(12));const last=await append(w,foreign,"c".repeat(12));
    const parsed=JSON.parse(w.root.toString("utf8")),shards:Buffer[]=[];
    for(const s of parsed.shards)shards.push(await readLocalNativeHistoricalMetadata(w.store,{kind:"shard",...s,maxBytes:bounds.shardBytes}));
    const removal=prepareTenantCatalogBusinessRemoval({root:w.root,rootSha256:w.current.sha256,legacy:w.legacy,shards,businessId:selected.generation.businessId});
    expect(removal.removed.map(r=>r.generation.businessId)).toEqual([selected.generation.businessId]);
    expect(removal.files.some(f=>f.kind==="leaf")).toBe(false);await persistTenantCatalogDelta(w.store,removal,"d".repeat(12));
    const foreignLeaf=last.files.find(f=>f.kind==="leaf")!;
    expect(await readFile(join(w.store,"leaf",foreign.generation.businessId,`${foreignLeaf.sha256}.json`))).toEqual(foreign.leaf);
    await persistLocalNativeArchive(w.base,foreign.bytes,foreign.entry,{layout:foreign.entry.object.layout!});
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED","true");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT","filesystem");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT",w.base);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH",join(w.store,"legacy",`${archiveDigest(w.legacy)}.json`));
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256",archiveDigest(w.legacy));vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED","true");
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT",w.store);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256",removal.root.sha256);
    vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID",foreign.keyId);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX",foreign.key.toString("hex"));
    const template=JSON.parse(await readFile(join(process.cwd(),"scripts/fixtures/native-historical-worker-reference.json"),"utf8"));
    expect(await readNativeHistoricalAdEvidence({...template.request,generation:foreign.generation})).toMatchObject({status:"historical_available",providerAuthority:false,currentDecisionEligible:false});
    expect(await readNativeHistoricalAdEvidence({...template.request,generation:selected.generation})).toMatchObject({status:"unavailable"});
  });
});
