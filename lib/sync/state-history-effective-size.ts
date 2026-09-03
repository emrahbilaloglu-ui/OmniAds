// D077 — effective-size measurement for meta_entity_state_history.
//
// Shared by the growth fence (admission) and the compaction planner
// (projection). The metric subtracts ONLY conservatively proven, currently
// reusable heap free space — pgstattuple_approx's approx_free_space after
// routine maintenance — from the raw pg_total_relation_size. Index bytes are
// ALWAYS fully counted: no index-reuse proof exists. Every uncertainty falls
// back to the raw size, and an invalid RAW measurement is its own explicit
// unavailable state that admission must treat as a refusal, never as zero
// bytes.

export const STATE_HISTORY_TABLE = "meta_entity_state_history";

export type StateHistoryFallbackReason =
  | "raw_measurement_invalid"
  | "heap_measurement_invalid"
  | "extension_missing"
  | "measurement_error"
  | "negative_free_space"
  | "free_space_exceeds_table"
  | "table_len_inconsistent";

export interface StateHistoryFenceMeasurement {
  /** Null when the raw measurement itself was invalid — admission must
   * refuse; there is no number to compare. */
  rawBytes: number | null;
  heapBytes: number | null;
  provenFreeHeapBytes: number | null;
  /** Equals rawBytes under every fallback; null exactly when rawBytes is. */
  effectiveBytes: number | null;
  metric: "effective_reusable_heap" | "raw_fallback" | "unavailable";
  fallbackReason: StateHistoryFallbackReason | null;
  budgetBytes: number;
  /** True (breached) whenever the measurement cannot prove otherwise. */
  breachedRaw: boolean;
  breachedEffective: boolean;
}

/** Strict byte parser: finite, safe, non-negative integer or null. */
export function toSafeByteCount(value: unknown): number | null {
  if (value == null || typeof value === "boolean") return null;
  if (typeof value !== "number" && typeof value !== "string") return null;
  if (typeof value === "string" && value.trim() === "") return null;
  const parsed = Number(value);
  if (!Number.isFinite(parsed) || !Number.isSafeInteger(parsed)) return null;
  if (parsed < 0) return null;
  return parsed;
}

/** Pure derivation so every fail-closed rule is unit-testable without a DB. */
export function deriveEffectiveStateHistoryBytes(input: {
  rawBytes: unknown;
  heapBytes: unknown;
  approxTableLen: number | null;
  approxFreeSpace: number | null;
  extensionPresent: boolean;
  measurementError: boolean;
  budgetBytes: number;
}): StateHistoryFenceMeasurement {
  const budgetBytes = input.budgetBytes;
  const raw = toSafeByteCount(input.rawBytes);
  const heap = toSafeByteCount(input.heapBytes);
  if (
    raw === null ||
    raw === 0 ||
    !Number.isSafeInteger(budgetBytes) ||
    budgetBytes <= 0
  ) {
    // No usable raw number: the fence must refuse, not admit at zero.
    return {
      rawBytes: null,
      heapBytes: heap,
      provenFreeHeapBytes: null,
      effectiveBytes: null,
      metric: "unavailable",
      fallbackReason: "raw_measurement_invalid",
      budgetBytes,
      breachedRaw: true,
      breachedEffective: true,
    };
  }
  const fallback = (
    reason: Exclude<StateHistoryFallbackReason, "raw_measurement_invalid">,
  ): StateHistoryFenceMeasurement => ({
    rawBytes: raw,
    heapBytes: heap,
    provenFreeHeapBytes: null,
    effectiveBytes: raw,
    metric: "raw_fallback",
    fallbackReason: reason,
    budgetBytes,
    breachedRaw: raw >= budgetBytes,
    breachedEffective: raw >= budgetBytes,
  });
  if (heap === null || heap === 0) return fallback("heap_measurement_invalid");
  if (!input.extensionPresent) return fallback("extension_missing");
  if (input.measurementError) return fallback("measurement_error");
  if (input.approxFreeSpace === null || input.approxTableLen === null) {
    return fallback("measurement_error");
  }
  if (
    !Number.isFinite(input.approxFreeSpace) ||
    !Number.isFinite(input.approxTableLen)
  ) {
    return fallback("measurement_error");
  }
  if (input.approxFreeSpace < 0) return fallback("negative_free_space");
  if (input.approxFreeSpace > input.approxTableLen) {
    return fallback("free_space_exceeds_table");
  }
  // table_len must describe the heap pg_table_size describes (2% tolerance
  // upward for accounting differences); a larger disagreement means the two
  // measurements do not describe the same relation state.
  if (input.approxTableLen > heap * 1.02 || input.approxTableLen < heap * 0.5) {
    return fallback("table_len_inconsistent");
  }
  const effective = Math.max(0, raw - Math.floor(input.approxFreeSpace));
  return {
    rawBytes: raw,
    heapBytes: heap,
    provenFreeHeapBytes: Math.floor(input.approxFreeSpace),
    effectiveBytes: effective,
    metric: "effective_reusable_heap",
    fallbackReason: null,
    budgetBytes,
    breachedRaw: raw >= budgetBytes,
    breachedEffective: effective >= budgetBytes,
  };
}

type SqlClient = {
  query<T extends Record<string, unknown> = Record<string, unknown>>(
    text: string,
    params?: unknown[],
  ): Promise<T[]>;
};

export async function measureStateHistoryFence(
  sql: SqlClient,
  options: { budgetBytes: number },
): Promise<StateHistoryFenceMeasurement> {
  let rawBytes: unknown = null;
  let heapBytes: unknown = null;
  let extensionPresent = false;
  let approxTableLen: number | null = null;
  let approxFreeSpace: number | null = null;
  let measurementError = false;
  try {
    const sizeRows = await sql.query<{
      raw: unknown;
      heap: unknown;
      ext: unknown;
    }>(
      `SELECT pg_total_relation_size($1)::bigint AS raw,
              pg_table_size($1)::bigint AS heap,
              (SELECT COUNT(*)::int FROM pg_extension WHERE extname = 'pgstattuple') AS ext`,
      [STATE_HISTORY_TABLE],
    );
    rawBytes = sizeRows[0]?.raw;
    heapBytes = sizeRows[0]?.heap;
    extensionPresent = Number(sizeRows[0]?.ext ?? 0) > 0;
  } catch {
    // rawBytes stays null → explicit unavailable/refusal state below.
  }
  if (extensionPresent) {
    try {
      const statRows = await sql.query<{
        table_len: unknown;
        approx_free_space: unknown;
      }>(
        `SELECT table_len, approx_free_space
         FROM pgstattuple_approx($1::regclass)`,
        [STATE_HISTORY_TABLE],
      );
      approxTableLen = toSafeByteCount(statRows[0]?.table_len);
      approxFreeSpace = toSafeByteCount(statRows[0]?.approx_free_space);
      if (approxTableLen === null || approxFreeSpace === null) {
        measurementError = true;
      }
    } catch {
      measurementError = true;
    }
  }
  return deriveEffectiveStateHistoryBytes({
    rawBytes,
    heapBytes,
    approxTableLen,
    approxFreeSpace,
    extensionPresent,
    measurementError,
    budgetBytes: options.budgetBytes,
  });
}
