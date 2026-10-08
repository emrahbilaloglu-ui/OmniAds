import { describe, expect, it } from "vitest";
import { metadataBusinessIds } from "./business-reference-metadata";

const a="75f65b18-97e5-426c-a791-a8f693d34c84",b="59dac76f-eb5e-409b-958c-bba440d1036b";
describe("shared control metadata business identity",()=>{
  it("recognises nested current, last-consumed, batch, canonical and canary fields",()=>{
    expect(metadataBusinessIds({lastBusinessId:a,meta:{currentBusinessId:b,lastConsumedBusinessId:a,
      batchBusinessIds:[b,a],canonical:{business_ref_id:a},config:{releaseCanaryBusinesses:[b]}}})).toEqual([b,a].sort());
  });
  it("does not invent a business from unrelated UUID fields or metrics",()=>{
    expect(metadataBusinessIds({jobRunId:a,partitionId:b,instanceId:a,businessAdmitted:false,body:{id:a},businessName:"retained label"})).toEqual([]);
  });
  it("handles collections of business objects and normalises UUID spelling",()=>{
    expect(metadataBusinessIds({businesses:[{businessId:a.toUpperCase()},{businessId:b}]})).toEqual([a,b].sort());
  });
  it("refuses malformed identity fields instead of silently retaining them",()=>{
    expect(()=>metadataBusinessIds({businessId:"deleted-business"})).toThrow("business_metadata_identity_invalid");
  });
  it("accepts null optional business identity",()=>expect(metadataBusinessIds({lastBusinessId:null})).toEqual([]));
  it("refuses cyclic control metadata within the traversal bound",()=>{
    const object:{child?:unknown}={};object.child=object;expect(()=>metadataBusinessIds(object)).toThrow("business_metadata_limit");
  });
});
