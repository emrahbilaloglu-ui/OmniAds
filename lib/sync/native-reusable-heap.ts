import { toSafeByteCount } from "./state-history-effective-size";

export const NATIVE_REUSABLE_HEAP_TABLE = "engine_v3_ad_decision_evaluations";

export interface NativeReusableHeapAccounting {
  metric: "raw" | "raw_minus_proven_native_heap_free";
  rawDatabaseBytes: number;
  accountedDatabaseBytes: number;
  reusableHeapBytes: number;
  relation: typeof NATIVE_REUSABLE_HEAP_TABLE;
  fallbackReason: string | null;
  provenReusableHeapBytes?: number;
  uncreditedReusableHeapBytes?: number;
}

/** Proven free space cannot authorize arbitrary growth in another relation.
 * Credit only as much as the actual volume can reserve for that growth, with
 * the existing floor plus a separate 512MiB maintenance reserve. The normal
 * projected-free-space assessor still checks the full credited headroom. */
export function limitNativeReusableHeapCredit(accounting:NativeReusableHeapAccounting,input:{
  availableBytes:number;minimumFreeBytes:number;databaseBudgetBytes:number;
}):NativeReusableHeapAccounting {
  if(accounting.metric!=="raw_minus_proven_native_heap_free")return accounting;
  const values=[input.availableBytes,input.minimumFreeBytes,input.databaseBudgetBytes];
  if(!values.every(x=>Number.isSafeInteger(x)&&x>=0))return {
    ...accounting,metric:"raw",accountedDatabaseBytes:accounting.rawDatabaseBytes,reusableHeapBytes:0,
    fallbackReason:"physical_credit_bound_invalid"};
  const maximum=Math.max(0,input.availableBytes-input.minimumFreeBytes-512*1024**2+
    accounting.rawDatabaseBytes-input.databaseBudgetBytes);
  const credited=Math.min(accounting.reusableHeapBytes,maximum);
  return {...accounting,accountedDatabaseBytes:accounting.rawDatabaseBytes-credited,reusableHeapBytes:credited,
    provenReusableHeapBytes:accounting.reusableHeapBytes,uncreditedReusableHeapBytes:accounting.reusableHeapBytes-credited};
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
