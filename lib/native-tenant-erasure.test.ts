import { mkdtemp,mkdir,readFile,realpath,rm,writeFile,lstat,chmod } from "node:fs/promises";
import { tmpdir } from "node:os";
import { dirname,join } from "node:path";
import type { PoolClient } from "pg";
import { afterEach,describe,expect,it,vi } from "vitest";
import { businessArchiveFixture } from "../scripts/fixtures/business-archive-erasure";
import { activateBusinessArchivePointer,archiveDigest,businessArchiveBaseFingerprint,
  BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT,resolveBusinessArchiveConfiguration } from "./business-archive-configuration";
import { prepareTenantArchiveErasurePlan,applyTenantArchiveErasurePlan,assertNoTenantArchiveRecords } from "./native-tenant-erasure";
import { buildNativeHistoricalCatalogRouting,nativeHistoricalGenerationBucket } from "./creative-decision-engine/native-historical-catalog-routing";
import { prepareTenantCatalogAppend,prepareTenantCatalogMigration } from "./creative-decision-engine/native-tenant-catalog";
import { persistTenantCatalogDelta } from "./creative-decision-engine/native-tenant-catalog-store";
import { persistLocalNativeArchive } from "./creative-decision-engine/native-historical-local-store";
import { readNativeHistoricalAdEvidence } from "./creative-decision-engine/native-historical-archive-reader";
import { assertNoBusinessNativeArchive } from "./business-deletion-files";

const selectedId="00000000-0000-4000-9000-000000000777",foreignId="00000000-0000-4000-9000-000000000778";
const bases:string[]=[];
afterEach(async()=>{vi.unstubAllEnvs();for(const b of bases.splice(0))await rm(b,{recursive:true,force:true});});
const query=vi.fn(async(sql:string)=>sql.startsWith("EXPLAIN")?{rows:[{"QUERY PLAN":[{Plan:{"Node Type":"Index Scan",
  "Relation Name":"engine_v3_ad_decision_input_evidence","Index Cond":"((contract_version = $1) AND (input_hash = $2))"}}]}]}:{rows:[]});
const db={query} as unknown as PoolClient;
async function put(path:string,content:Buffer){await mkdir(dirname(path),{recursive:true,mode:0o700});await writeFile(path,content,{mode:0o600});}
async function world(count=1){
  const base=await realpath(await mkdtemp(join(tmpdir(),"tenant-erasure-")));bases.push(base);
  const archive=join(base,"archive"),store=join(archive,"routing-cas-v1"),control=join(base,"control");
  for(const d of [archive,store,control])await mkdir(d,{mode:0o700});
  const legacy=Buffer.from(JSON.stringify({contract:"native-historical-archive-catalog.v1",entries:[]})),legacySha=archiveDigest(legacy);
  const old=buildNativeHistoricalCatalogRouting({legacy:{content:legacy,sha256:legacySha},leaves:[]});
  let delta=prepareTenantCatalogMigration({root:old.files.find(f=>f.kind==="root")!.content,rootSha256:old.root.sha256,legacy,shards:[],leaves:[]});
  await persistTenantCatalogDelta(store,delta,"a".repeat(12));
  const fixtures=[];
  for(let i=0;i<count+1;i++){
    const f=await businessArchiveFixture(i===count?foreignId:selectedId,{compactRoot:true,tenantObjects:true});fixtures.push(f);
    await persistLocalNativeArchive(archive,f.bytes,f.entry,{layout:"tenant.v1"});
    const content=delta.files.find(f=>f.kind==="root")!.content,root=JSON.parse(content.toString("utf8"));
    const ref=root.shards.find((s:{bucket:string})=>s.bucket===nativeHistoricalGenerationBucket(f.generation.jobRunId));
    delta=prepareTenantCatalogAppend({root:content,rootSha256:delta.root.sha256,legacySha256:legacySha,
      shard:ref?await readFile(join(store,"shard",`${ref.sha256}.json`)):null,leaf:f.leaf!});
    await persistTenantCatalogDelta(store,delta,`b${String(i).padStart(11,"0")}`);
  }
  const catalogPath=join(archive,"filtered",`${legacySha}.json`);await put(catalogPath,legacy);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_TRANSPORT","filesystem");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_LOCAL_ROOT",archive);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_PATH",catalogPath);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_SHA256",legacySha);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_CATALOG_ROUTING_ENABLED","true");vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT",store);
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ROUTING_ROOT_SHA256",delta.root.sha256);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ACTIVE_POINTER",join(control,"active.json"));
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_ID",fixtures[0]!.keyId);vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_ENCRYPTION_KEY_HEX",fixtures[0]!.key.toString("hex"));
  vi.stubEnv("ENGINE_V3_NATIVE_ARCHIVE_HISTORICAL_READER_ENABLED","true");
  const before=await resolveBusinessArchiveConfiguration();
  await activateBusinessArchivePointer({contract:BUSINESS_ARCHIVE_TENANT_POINTER_CONTRACT,baseFingerprint:businessArchiveBaseFingerprint(),
    catalog:{path:`filtered/${legacySha}.json`,sha256:legacySha},routing:{directory:"routing-cas-v1",sha256:delta.root.sha256}},before);
  return {archive,store,fixtures,foreign:fixtures.at(-1)!};
}
describe("paged tenant archive offboarding",()=>{
  it("drains more than one finite page, removes inactive identifying metadata, and keeps foreign history readable",async()=>{
    const w=await world(5),foreignPath=join(w.archive,w.foreign.entry.object.key),before=await readFile(foreignPath);
    const first=await prepareTenantArchiveErasurePlan(selectedId,db,Date.now()+60_000);
    expect(first.remove.filter(p=>p.startsWith("routing-cas-v1/leaf/"))).toHaveLength(4);
    expect(await applyTenantArchiveErasurePlan(first,Date.now()+60_000)).toEqual({pageComplete:true,remaining:true});
    await expect(assertNoTenantArchiveRecords(selectedId)).rejects.toThrow();
    const second=await prepareTenantArchiveErasurePlan(selectedId,db,Date.now()+60_000,first.inputKeys);
    expect(await applyTenantArchiveErasurePlan(second,Date.now()+60_000)).toEqual({pageComplete:true,remaining:false});
    await assertNoBusinessNativeArchive(selectedId);expect(await readFile(foreignPath)).toEqual(before);
    const template=JSON.parse(await readFile(join(process.cwd(),"scripts/fixtures/native-historical-worker-reference.json"),"utf8"));
    expect(await readNativeHistoricalAdEvidence({...template.request,generation:w.foreign.generation})).toMatchObject({
      status:"historical_available",providerAuthority:false,currentDecisionEligible:false,reclaimEligible:false});
  },20_000);
  it("resumes the exact persisted page after pointer publication and refuses metadata drift before removal",async()=>{
    const w=await world(),plan=await prepareTenantArchiveErasurePlan(selectedId,db,Date.now()+60_000);
    const foreign=plan.baseline.find(f=>f.path.startsWith("routing-cas-v1/shard/")&&!plan.remove.includes(f.path));
    // A selected or foreign shard is always frozen, independent of whether its
    // bucket will change. Tampering must not turn an unavailable graph to absence.
    const target=foreign??plan.baseline.find(f=>f.path.startsWith("routing-cas-v1/root/"))!;
    const path=join(w.archive,target.path),bytes=await readFile(path);await chmod(path,0o600);await writeFile(path,Buffer.from("{}"));
    await expect(applyTenantArchiveErasurePlan(plan,Date.now()+60_000)).rejects.toThrow();await writeFile(path,bytes);await chmod(path,0o440);
    await expect(applyTenantArchiveErasurePlan(plan,Date.now()+60_000,async phase=>{if(phase==="published")throw Error("owned crash");})).rejects.toThrow("owned crash");
    expect((await lstat(join(w.archive,w.fixtures[0]!.entry.object.key))).isFile()).toBe(true);
    await applyTenantArchiveErasurePlan(plan,Date.now()+60_000);await assertNoBusinessNativeArchive(selectedId);
    expect(await readFile(join(w.archive,w.foreign.entry.object.key))).toEqual(w.foreign.bytes);
  },20_000);
});
