import { mkdtemp,mkdir,writeFile,readFile,access,rm,realpath } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach,expect,it,vi } from "vitest";
const owned=vi.hoisted(()=>({root:"",dropped:[] as string[]}));
vi.mock("./files",async importOriginal=>{
  const actual=await importOriginal<typeof import("./files")>();
  return {...actual,get COLD_ROOT(){return owned.root;},get COLD_COPY_ROOT(){return join(owned.root,"copies");},
    assertColdWriter:()=>undefined,coldPath:(...parts:string[])=>join(owned.root,...parts),coldDirectory:async(path:string)=>path,
    coldJson:async(path:string)=>JSON.parse(await readFile(path,"utf8")),
    writeColdJson:async(path:string,value:unknown)=>{await mkdir(join(path,".."),{recursive:true,mode:0o700});await writeFile(path,JSON.stringify(value),{mode:0o600});return "";}};
});
vi.mock("./private-restore",()=>({dropPrivateRestore:async(purpose:string)=>{owned.dropped.push(purpose);}}));
import { finishColdBusinessErasure } from "../../lib/native-cold-erasure";
import { archiveCanonical,archiveDigest } from "../../lib/business-archive-configuration";
afterEach(async()=>{vi.unstubAllEnvs();if(owned.root)await rm(owned.root,{recursive:true,force:true});owned.dropped=[];});
it("requires independent absence ACK before purging corrupt/partial owned copies, journals and identifying state; preserves foreign bytes",async()=>{
  owned.root=await realpath(await mkdtemp(join(tmpdir(),"owned-cold-erasure-")));vi.stubEnv("NATIVE_COLD_REPLICA_REQUIRED","true");
  const business="00000000-0000-4000-9000-000000000777",foreign="00000000-0000-4000-9000-000000000778",
    job="00000000-0000-4000-9000-000000000001",attempt="00000000-0000-4000-9000-000000000002",purpose="a".repeat(12);
  const put=async(path:string,value:unknown)=>{await mkdir(join(path,".."),{recursive:true,mode:0o700});
    await writeFile(path,typeof value==="string"?value:JSON.stringify(value),{mode:0o600});};
  const copy=join(owned.root,"copies",business,job),journal=join(owned.root,"jobs",business,purpose);
  await put(join(copy,"intent.json"),{businessId:business,jobRunId:job,purpose});
  const corrupt=join(copy,"primary","b".repeat(64)+".bin");await put(corrupt,"corrupt but tenant-owned redundant data");
  await put(join(copy,"recovery","config.json.gz.pending"),"partial compressed config");
  await put(join(journal,"state.json"),{businessId:business,jobRunId:job,purpose});
  await put(join(journal,"http-before","historical.body.aes"),"encrypted proof fixture");
  const foreignPath=join(owned.root,"copies",foreign,"unchanged.bin");await put(foreignPath,"foreign unchanged bytes");
  await put(join(owned.root,"state.json"),{active:{businessId:business},cursor:{jobRunId:job},lastSuccess:{businessId:business},
    lastFailure:{businessId:business},reads:[{businessId:business},{businessId:foreign}],vetoes:[{generation:{businessId:business}},{generation:{businessId:foreign}}]});
  const client={query:vi.fn(()=>{throw Error("unexpected production SQL");})};
  expect(await finishColdBusinessErasure(business,attempt,Date.now()+60_000,client as never)).toEqual({waiting:true,proof:null});
  expect(await readFile(corrupt,"utf8")).toContain("corrupt");expect(owned.dropped).toEqual([]);
  const erasePurpose=archiveDigest(`business-erasure:${business}:${attempt}`).slice(0,12),outbox=join(owned.root,"replication","outbox",business,erasePurpose);
  const manifest=JSON.parse(await readFile(join(outbox,"manifest.json"),"utf8"));
  const now=new Date().toISOString();await put(join(outbox,"ack.json"),{contract:"native-cold-replica-ack.v1",kind:"erase",
    businessId:business,purpose:erasePurpose,jobRunId:null,manifestSha256:archiveDigest(archiveCanonical(manifest)),files:[],
    observedAt:now,verified:true,sourceDeleted:false,replicaVolume:{observedAt:now,availableBytes:0,minimumFreeBytes:16*1024**3,
      device:"1",host:"87.99.149.56",scope:"db-root"}});
  const result=await finishColdBusinessErasure(business,attempt,Date.now()+60_000,client as never);
  expect(result.waiting).toBe(false);expect(result.proof?.privateRestoreDatabasesAbsent).toBe(true);
  for(const path of [join(owned.root,"copies",business),join(owned.root,"jobs",business),join(owned.root,"replication","outbox",business)])
    await expect(access(path)).rejects.toMatchObject({code:"ENOENT"});
  expect(await readFile(foreignPath,"utf8")).toBe("foreign unchanged bytes");expect(owned.dropped).toEqual([purpose]);
  const global=JSON.parse(await readFile(join(owned.root,"state.json"),"utf8"));
  expect(global.cursor).toBeNull();expect(JSON.stringify(global)).not.toContain(business);expect(global.reads).toEqual([{businessId:foreign}]);
});
