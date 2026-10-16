import { describe, expect, it } from "vitest";
import { deriveNativeReusableHeapAccounting, limitNativeReusableHeapCredit } from "./native-reusable-heap";

const proof = { total_bytes: 7000, heap_bytes: 2000, table_len: 2000, approx_free_space: 500 };
describe("native MAIN-heap capacity accounting", () => {
  it("limits proven free credit to actual physical spare while retaining the full proof",()=>{
    const GiB=1024**3;
    const raw=164*GiB,free=12*GiB;
    const accounting=deriveNativeReusableHeapAccounting(raw,{total_bytes:70*GiB,heap_bytes:20*GiB,table_len:20*GiB,approx_free_space:free});
    const result=limitNativeReusableHeapCredit(accounting,{availableBytes:44*GiB,minimumFreeBytes:40*GiB,databaseBudgetBytes:163*GiB});
    expect(result).toMatchObject({reusableHeapBytes:4.5*GiB,provenReusableHeapBytes:free,uncreditedReusableHeapBytes:7.5*GiB,
      accountedDatabaseBytes:159.5*GiB});
    expect(44*GiB-(163*GiB-result.accountedDatabaseBytes)).toBe(40.5*GiB);
  });
  it("cannot manufacture headroom when the physical reserve is exhausted",()=>{
    const a=deriveNativeReusableHeapAccounting(10000,proof);
    expect(limitNativeReusableHeapCredit(a,{availableBytes:10000,minimumFreeBytes:10000,databaseBudgetBytes:9500})).toMatchObject({
      reusableHeapBytes:0,accountedDatabaseBytes:10000,provenReusableHeapBytes:500,uncreditedReusableHeapBytes:500});
    expect(limitNativeReusableHeapCredit(a,{availableBytes:NaN,minimumFreeBytes:0,databaseBudgetBytes:9500})).toMatchObject({
      reusableHeapBytes:0,accountedDatabaseBytes:10000,metric:"raw"});
  });
  it("credits only reusable main heap and keeps raw allocation explicit", () => {
    expect(deriveNativeReusableHeapAccounting(10000, proof)).toMatchObject({
      rawDatabaseBytes: 10000, accountedDatabaseBytes: 9500, reusableHeapBytes: 500,
      metric: "raw_minus_proven_native_heap_free", fallbackReason: null,
    });
  });
  it.each([
    null, { ...proof, table_len: 1999 }, { ...proof, approx_free_space: -1 },
    { ...proof, approx_free_space: 2001 }, { ...proof, heap_bytes: null },
    { ...proof, heap_bytes: 0 }, { ...proof, total_bytes: 1999 },
    { ...proof, total_bytes: 10001 }, { ...proof, approx_free_space: true },
    { ...proof, approx_free_space: "" }, { ...proof, approx_free_space: 0.5 },
  ])("uses raw allocation for invalid or unavailable proof %#", (bad) => {
    expect(deriveNativeReusableHeapAccounting(10000, bad)).toMatchObject({
      accountedDatabaseBytes: 10000, reusableHeapBytes: 0, metric: "raw",
    });
  });
  it("does not credit dead tuples, TOAST or index estimates", () => {
    expect(deriveNativeReusableHeapAccounting(10000, { ...proof, approx_free_space: 0,
      dead_tuple_len: 500, toastFree: 2000, indexFree: 3000 }).reusableHeapBytes).toBe(0);
  });
});
