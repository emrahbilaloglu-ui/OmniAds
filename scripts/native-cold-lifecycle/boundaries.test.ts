import { afterEach,describe,expect,it,vi } from "vitest";
import { randomBytes } from "node:crypto";
import { configuredBusinessArchive,archiveDigest } from "../../lib/business-archive-configuration";
import { reserveColdReads } from "./controller";
import { verifyRuntimeObservation } from "./gate";
import { openHttpBody,sealHttpBody,verifyHistoricalBody } from "./http";
import type { ColdControllerState } from "./types";
import type { UnitConfig } from "../native-storage-batch/capture";
import type { Sample } from "../native-storage-batch/http-proof";
afterEach(()=>vi.unstubAllEnvs());
describe("cold lifecycle authority boundaries",()=>{
  it("preserves human request/download capacity across a rolling window and business scope",()=>{
    const s={reads:[]} as unknown as ColdControllerState,n=Date.now();
    reserveColdReads(s,"one",24,12*1024**2,n);reserveColdReads(s,"one",24,12*1024**2,n);
    expect(()=>reserveColdReads(s,"one",1,1,n)).toThrow("COLD_HTTP_BUDGET_DEFERRED");
    reserveColdReads(s,"other",16,1,n);
    reserveColdReads(s,"one",16,1,n+900_001);expect(s.reads).toHaveLength(1);
    expect(()=>reserveColdReads(s,"one",1,25*1024**2,n+900_001)).toThrow();
  });
  it("refuses stale, relabeled, differently mounted or worker-accessible runtime roles",()=>{
    const build="a".repeat(40),key="b".repeat(64),now=Date.now();vi.stubEnv("APP_BUILD_ID",build);vi.stubEnv("NATIVE_COLD_KEY_SHA256",key);
    const role=(name:string)=>({running:true,buildId:build,immutableBuildId:build,ociRevision:build,
      imageId:`sha256:${"c".repeat(64)}`,imageRole:name==="web"?"web-runner":"worker-runner",
      archive:{base:configuredBusinessArchive(),activePointer:"/run/adsecute-business-erasure/active.json",keySha256:key,replicaRequired:true,coldEnabled:true},
      mounts:name==="worker"?[]:[["native-archive","adsecute-native-archive"],["business-erasure-control","adsecute-business-erasure"]].map(([source,destination])=>
        ({source:`/var/www/adsecute/${source}`,destination:`/run/${destination}`,writable:name==="archive-erasure",type:"bind"}))});
    const r={contract:"native-cold-runtime-observation.v1",valid:true,observedAt:new Date(now).toISOString(),
      roles:{web:role("web"),worker:role("worker"),"archive-erasure":role("archive-erasure")}};
    expect(()=>verifyRuntimeObservation(r,now)).not.toThrow();
    for(const mutate of [(x:typeof r)=>{x.roles.web.immutableBuildId="d".repeat(40);},
      (x:typeof r)=>{x.roles.web.mounts[0]!.writable=true;},(x:typeof r)=>{x.roles.worker.mounts=x.roles.web.mounts;},
      (x:typeof r)=>{x.observedAt=new Date(now-60_001).toISOString();}]){
      const x=structuredClone(r);mutate(x);expect(()=>verifyRuntimeObservation(x,now)).toThrow();
    }
  });
  it("encrypts complete HTTP proofs and binds their tenant/root/phase associated data",()=>{
    const key=randomBytes(32),body=Buffer.from('{"actual":"historical original"}'),aad=Buffer.from("business/root/before");
    const cipher=sealHttpBody(body,key,aad);expect(cipher.includes(body)).toBe(false);
    expect(openHttpBody(cipher,key,aad)).toEqual(body);
    expect(()=>openHttpBody(cipher,key,Buffer.from("another/root/after"))).toThrow();
    const corrupt=Buffer.from(cipher);corrupt[corrupt.length-1]^=1;expect(()=>openHttpBody(corrupt,key,aad)).toThrow();
  });
  it("requires exact source row bytes and historical-only authority in the actual response body",()=>{
    const generation={businessId:"biz",jobRunId:"job",engineVersion:"engine",asOfDate:"2026-10-07"},row='{"id":"eval","spend":4}';
    const sample={evaluationId:"eval",providerAccountId:"account",adId:"ad"} as Sample;
    const config={generation,evaluationRowSha256:{eval:archiveDigest(row)}} as unknown as UnitConfig;
    const body={status:"historical_available",authority:"historical_read_only",providerAuthority:false,currentDecisionEligible:false,
      reclaimEligible:false,generation,identity:sample,rowJson:{evaluation:row}};
    expect(()=>verifyHistoricalBody(Buffer.from(JSON.stringify(body)),config,sample)).not.toThrow();
    for(const change of [{providerAuthority:true},{currentDecisionEligible:true},{generation:{...generation,jobRunId:"foreign"}},
      {rowJson:{evaluation:'{"id":"eval","spend":5}'}}])expect(()=>verifyHistoricalBody(Buffer.from(JSON.stringify({...body,...change})),config,sample)).toThrow();
  });
});
