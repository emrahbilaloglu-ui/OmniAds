import { afterEach,beforeEach,expect,it,vi } from "vitest";
import { createHash } from "node:crypto";
const fixture=vi.hoisted(()=>({files:new Map<string,any>(),root:"current-root",calls:[] as string[]}));
vi.mock("../../lib/business-deletion",()=>({BUSINESS_ERASURE_LOCK_NAMESPACE:1948017000}));
vi.mock("./files",()=>({COLD_COPY_ROOT:"/owned-cold/copies",coldPath:(...p:string[])=>"/owned-cold/"+p.join("/"),
  coldJson:async(p:string)=>structuredClone(fixture.files.get(p)),
  writeColdJson:async(p:string,v:unknown)=>{fixture.files.set(p,structuredClone(v));return "fixture";}}));
vi.mock("./gate",()=>({staticColdGate:async()=>({inventory:"inventory",reviewSha256:"review"}),
  verifyRuntimeObservation:()=>undefined,sourceConnection:async()=>({end:async()=>undefined,query:async(s:string)=>{
    if(s.includes("pg_try_advisory_lock"))return {rows:[{acquired:true}]};
    if(s.includes("FROM businesses"))return {rows:[{}]};return {rows:[]};}}),
  freshColdGate:async()=>({observedAt:new Date().toISOString(),business:{databaseBytes:100,databaseAccounting:{accountedDatabaseBytes:90}},replicaAvailableBytes:100})}));
vi.mock("../../lib/business-archive-configuration",async original=>({...await original<typeof import("../../lib/business-archive-configuration")>(),
  resolveBusinessArchiveConfiguration:async()=>({rootSha256:fixture.root})}));
vi.mock("./hold",()=>({readColdOwnerHold:vi.fn(async()=>null)}));
vi.mock("../native-storage-batch/maintenance",()=>({selectClosedDayCandidates:vi.fn()}));
vi.mock("./private-original",()=>({readColdPrivateConfig:async()=>({config:{generation:{},evaluationRowSha256:{}}})}));
vi.mock("./private-restore",()=>({dropPrivateRestore:async()=>undefined}));
vi.mock("./replica",()=>({readReplicaAck:async()=>({}),removeReplicaRequest:async()=>undefined}));
vi.mock("./child",()=>({runColdChild:vi.fn(async(_state:unknown,op:string)=>{
  fixture.calls.push(op);if(op==="readback")return {exactUnitAbsent:true,retainedRootsFullBytesMatch:true,inputEvidence:{match:true}};
  if(op==="pins")return {selectedPinClosureMatches:false};throw Error("UNEXPECTED_RETIREMENT_REPLAY");})}));
vi.mock("./http",()=>({collectColdHttpProof:vi.fn(async()=>({requests:8,observedAt:new Date().toISOString(),current:[],proofSha256:"proof"})),
  verifyColdHttpProof:async()=>({requests:8,observedAt:new Date().toISOString(),current:[],proofSha256:"proof"})}));
vi.mock("./routing",()=>({ensureTenantRouting:async()=>undefined,publishServedOriginal:vi.fn(async(_c:unknown,_l:unknown,_p:unknown,authorize:(n:number)=>Promise<void>)=>{
  await authorize(1024);return {rootSha256:fixture.root,previousRootSha256:fixture.root,publishedAt:new Date().toISOString(),existing:true};})}));
import { readColdOwnerHold } from "./hold";
import { selectClosedDayCandidates } from "../native-storage-batch/maintenance";
import { runNativeColdLifecycleTick } from "./controller";
import { collectColdHttpProof } from "./http";
import { publishServedOriginal } from "./routing";
const business="00000000-0000-4000-9000-000000000777",job="00000000-0000-4000-9000-000000000001",purpose="a".repeat(12),
  unitPath=`/owned-cold/jobs/${business}/${purpose}/state.json`,globalPath="/owned-cold/state.json";
afterEach(()=>vi.unstubAllEnvs());
beforeEach(()=>{fixture.files.clear();fixture.calls=[];fixture.root="current-root";vi.clearAllMocks();
  vi.stubEnv("NATIVE_COLD_LIFECYCLE_ENABLED","true");vi.stubEnv("ADSECUTE_SYNC_GLOBAL_ENABLED","enabled");vi.stubEnv("ADSECUTE_SYNC_LANE_NATIVE_ARCHIVE_ENABLED","enabled");
  fixture.files.set(globalPath,{contract:"native-cold-controller.v1",active:{businessId:business,jobRunId:job,purpose},cursor:null,
    nextEligibleAt:null,archivedOriginals:0,vetoes:[],reads:[],observations:[],lastSuccess:null,lastFailure:null});
  fixture.files.set(unitPath,{contract:"native-cold-unit-state.v1",businessId:business,jobRunId:job,purpose,
    deadlineAt:new Date(Date.now()+30*60_000).toISOString(),phase:"published",evaluations:100,contexts:1,
    capture:{proofSha256:"proof",leafSha256:"leaf",samples:Array.from({length:8},(_,i)=>({evaluationId:String(i)})),archiveBytes:1024,parts:4},
    publication:{rootSha256:fixture.root,publishedAt:new Date().toISOString()},restore:{privateBytes:2048},replicaRequest:{},
    httpBefore:{requests:8,current:[]},measurements:{before:{},after:{}}});
});
it("does not send C3 or HTTP when the full before+after reservation exceeds the caller budget",async()=>{
  fixture.files.get(globalPath).reads=[{businessId:business,observedAt:new Date().toISOString(),requests:40,downloadBytes:0}];
  expect((await runNativeColdLifecycleTick()).outcome).toBe("deferred");
  expect(fixture.calls).toEqual([]);expect(collectColdHttpProof).not.toHaveBeenCalled();expect(fixture.files.get(unitPath).phase).toBe("published");
});
it("never replays a dispatched retirement whose actual COMMIT reply was not durably received",async()=>{
  fixture.files.get(unitPath).phase="retiring";
  expect((await runNativeColdLifecycleTick()).outcome).toBe("owner_attention");expect(fixture.calls).toEqual([]);
  expect(fixture.files.get(unitPath).failure.code).toBe("COLD_DISPATCHED_STATUS_ONLY_NO_REPLAY");
});
it("resumes only readback after an actual journaled COMMIT, without another retirement dispatch",async()=>{
  const u=fixture.files.get(unitPath),preparedJson=JSON.stringify({ownedFixture:"prepared transaction"}),
    preparedSha256=createHash("sha256").update(preparedJson).digest("hex");
  u.phase="retired";u.retirement={committed:true,preparedSha256};
  fixture.files.set(`/owned-cold/jobs/${business}/${purpose}/prepared.json`,{contract:"native-cold-prepared-transaction.v1",proofSha256:"proof",preparedJson,preparedSha256});
  expect((await runNativeColdLifecycleTick()).outcome).toBe("archived_original");expect(fixture.calls).toEqual(["readback"]);
  expect(fixture.files.get(globalPath).archivedOriginals).toBe(1);
});
it("re-proves the same source-intact leaf after a foreign erasure changes the shared root",async()=>{
  const u=fixture.files.get(unitPath);u.publication.rootSha256="prior-root";u.phase="http_verified";
  u.httpBudget={reservedAt:new Date().toISOString(),requests:16,downloadBytes:4096};
  fixture.files.get(globalPath).reads=[{businessId:business,observedAt:new Date().toISOString(),requests:16,downloadBytes:4096}];
  await runNativeColdLifecycleTick();expect(publishServedOriginal).toHaveBeenCalledOnce();
  expect(collectColdHttpProof).toHaveBeenCalledOnce();expect(fixture.calls).toEqual(["pins"]);
  expect(fixture.files.get(globalPath).reads.reduce((n:number,x:any)=>n+x.requests,0)).toBe(32);
});

it("reports a durable source-intact owner hold without recapture, C3, copy overwrite or archive credit",async()=>{
  const global=fixture.files.get(globalPath);global.active=null;
  const generation={businessId:business,jobRunId:job,asOfDate:"2026-09-27",engineVersion:"engine"};
  vi.mocked(selectClosedDayCandidates).mockResolvedValue({candidates:[{generation,metadataVeto:null,evaluations:100,contexts:1}]} as never);
  vi.mocked(readColdOwnerHold).mockResolvedValue("SOURCE_INTACT_OWNER_HOLD");
  expect((await runNativeColdLifecycleTick()).outcome).toBe("no_eligible_original");
  expect(fixture.calls).toEqual([]);expect(collectColdHttpProof).not.toHaveBeenCalled();
  const after=fixture.files.get(globalPath);expect(after.active).toBeNull();expect(after.archivedOriginals).toBe(0);
  expect(after.vetoes).toMatchObject([{generation,reason:"SOURCE_INTACT_OWNER_HOLD"}]);
  expect([...fixture.files.keys()].some(p=>p.includes("/copies/"))).toBe(false);
});
