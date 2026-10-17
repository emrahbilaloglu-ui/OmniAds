import { describe,expect,it,vi } from "vitest";
import { deriveRawPayloadReusableTable,measureRawPayloadReusableSpace,mergeRawPayloadReusableAccounting,RAW_PAYLOAD_MAP_PAGE_LIMIT } from "./raw-payload-reusable-space";
import { deriveNativeReusableHeapAccounting,limitNativeReusableHeapCredit } from "./native-reusable-heap";
const GiB=1024**3, MiB=1024**2;
const row={raw_bytes:22*GiB,database_bytes:164*GiB,heaps:[
  {kind:"main",oid:11,heap_bytes:GiB,visible_free_bytes:100*MiB},
  {kind:"toast",oid:12,heap_bytes:20*GiB,visible_free_bytes:3*GiB},
]};
describe("disjoint raw-payload reusable maps",()=>{
  it("keeps allocation and all index bytes; credits only measured visible pages with a per-heap margin",()=>{
    const p=deriveRawPayloadReusableTable(22*GiB,row);
    expect(p).toMatchObject({rawBytes:22*GiB,reusableBytes:3*GiB+98*MiB,
      effectiveBytes:19*GiB-98*MiB,metric:"visible_map_free",fallbackReason:null});
  });
  it.each([
    null,{...row,heaps:[]},{...row,heaps:[...row.heaps,row.heaps[0]]},
    {...row,database_bytes:GiB},{...row,heaps:[{...row.heaps[0],heap_bytes:1}]},
    {...row,heaps:[{...row.heaps[0],visible_free_bytes:-1}]},
    {...row,heaps:[{...row.heaps[0],visible_free_bytes:2*GiB}]},
    {...row,heaps:[{...row.heaps[0],visible_free_bytes:true}]},
    {...row,heaps:[row.heaps[0],{...row.heaps[1],oid:11}]},
    {...row,heaps:[row.heaps[0],{...row.heaps[1],kind:"main"}]},
    {...row,heaps:[{...row.heaps[1]}]},
    {...row,heaps:[row.heaps[0],{...row.heaps[1],visible_free_bytes:RAW_PAYLOAD_MAP_PAGE_LIMIT*8192+1}]},
  ])("falls back to raw on unavailable or inconsistent physical proof %#",bad=>{
    expect(deriveRawPayloadReusableTable(22*GiB,bad)).toMatchObject({rawBytes:22*GiB,effectiveBytes:22*GiB,reusableBytes:0,metric:"raw_fallback"});
  });
  it("never credits dead tuples, index estimates or unknown free space",()=>{
    const p=deriveRawPayloadReusableTable(22*GiB,{...row,dead_tuple_len:9*GiB,indexFree:4*GiB,
      heaps:row.heaps.map(h=>({...h,visible_free_bytes:0}))});
    expect(p.reusableBytes).toBe(0);
  });
  it("uses the larger fresh allocation and refuses an overlapping heap between owners",async()=>{
    const q=vi.fn(async()=>[row]);
    const p=await measureRawPayloadReusableSpace({query:q},{meta_raw_snapshots:21*GiB,shopify_raw_snapshots:20*GiB});
    expect(q).toHaveBeenCalledTimes(2);
    expect(p.meta_raw_snapshots.metric).toBe("raw_fallback");
    expect(p.shopify_raw_snapshots.fallbackReason).toBe("overlapping_heap_proof");
    expect(deriveRawPayloadReusableTable(21*GiB,row).rawBytes).toBe(22*GiB);
  });
  it("keeps a valid independent owner when the other measurement fails",async()=>{
    const q=vi.fn().mockResolvedValueOnce([row]).mockRejectedValueOnce(Error("timeout"));
    const p=await measureRawPayloadReusableSpace({query:q},{meta_raw_snapshots:22*GiB,shopify_raw_snapshots:16*GiB});
    expect(p.meta_raw_snapshots.reusableBytes).toBeGreaterThan(0);
    expect(p.shopify_raw_snapshots).toMatchObject({reusableBytes:0,effectiveBytes:16*GiB,metric:"raw_fallback"});
  });
  it("combines distinct native/raw heaps once and caps all effective headroom by physical spare",()=>{
    const native=deriveNativeReusableHeapAccounting(164*GiB,{total_bytes:70*GiB,heap_bytes:20*GiB,table_len:20*GiB,approx_free_space:4*GiB});
    const raw={meta_raw_snapshots:deriveRawPayloadReusableTable(22*GiB,row),
      shopify_raw_snapshots:deriveRawPayloadReusableTable(16*GiB,null)};
    const combined=mergeRawPayloadReusableAccounting(native,raw);
    expect(combined.metric).toBe("raw_minus_proven_disjoint_heap_free");
    expect(combined.components?.map(x=>x.relation)).toEqual(["engine_v3_ad_decision_evaluations","meta_raw_snapshots:main","meta_raw_snapshots:toast"]);
    const capped=limitNativeReusableHeapCredit(combined,{availableBytes:44*GiB,minimumFreeBytes:40*GiB,databaseBudgetBytes:163*GiB});
    expect(capped.reusableHeapBytes).toBe(4.5*GiB);
    expect(44*GiB-(163*GiB-capped.accountedDatabaseBytes)).toBe(40.5*GiB);
    expect(capped.rawDatabaseBytes).toBe(164*GiB);
  });
});
