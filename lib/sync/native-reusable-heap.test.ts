import { describe, expect, it } from "vitest";
import { deriveNativeReusableHeapAccounting } from "./native-reusable-heap";

const proof = { total_bytes: 7000, heap_bytes: 2000, table_len: 2000, approx_free_space: 500 };
describe("native MAIN-heap capacity accounting", () => {
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
