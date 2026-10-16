import { toSafeByteCount } from "./state-history-effective-size";

export const NATIVE_REUSABLE_HEAP_TABLE = "engine_v3_ad_decision_evaluations";

export interface NativeReusableHeapAccounting {
  metric: "raw" | "raw_minus_proven_native_heap_free";
  rawDatabaseBytes: number;
  accountedDatabaseBytes: number;
  reusableHeapBytes: number;
  relation: typeof NATIVE_REUSABLE_HEAP_TABLE;
  fallbackReason: string | null;
}

/** Count allocated, reusable MAIN-heap space once. Dead tuples, TOAST, indexes
 * and estimated tuple counts are never credited. Every ambiguity stays raw. */
export function deriveNativeReusableHeapAccounting(
  rawDatabaseBytes: number,
  proof: Record<string, unknown> | null,
  fallbackReason = "proof_unavailable",
): NativeReusableHeapAccounting {
  const raw: NativeReusableHeapAccounting = {
    metric: "raw", rawDatabaseBytes, accountedDatabaseBytes: rawDatabaseBytes,
    reusableHeapBytes: 0, relation: NATIVE_REUSABLE_HEAP_TABLE, fallbackReason,
  };
  if (!proof) return raw;
  const total = toSafeByteCount(proof.total_bytes);
  const heap = toSafeByteCount(proof.heap_bytes);
  const length = toSafeByteCount(proof.table_len);
  const free = toSafeByteCount(proof.approx_free_space);
  if (!Number.isSafeInteger(rawDatabaseBytes) || rawDatabaseBytes <= 0 ||
      total === null || heap === null || length === null || free === null ||
      heap === 0 || total < heap || total > rawDatabaseBytes ||
      length !== heap || free > heap) return { ...raw, fallbackReason: "proof_invalid" };
  return { ...raw, metric: "raw_minus_proven_native_heap_free",
    accountedDatabaseBytes: rawDatabaseBytes - free,
    reusableHeapBytes: free, fallbackReason: null };
}
