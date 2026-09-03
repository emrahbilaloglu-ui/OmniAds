import { describe, expect, it } from "vitest";
import {
  deriveEffectiveStateHistoryBytes,
  toSafeByteCount,
} from "@/lib/sync/state-history-effective-size";

const GIB = 1024 ** 3;

function base(overrides: Partial<Parameters<typeof deriveEffectiveStateHistoryBytes>[0]>) {
  return deriveEffectiveStateHistoryBytes({
    rawBytes: 5 * GIB + 40_960,
    heapBytes: Math.floor(2.5 * GIB),
    approxTableLen: Math.floor(2.5 * GIB),
    approxFreeSpace: 1 * GIB,
    extensionPresent: true,
    measurementError: false,
    budgetBytes: 5 * GIB,
    ...overrides,
  });
}

describe("strict byte parsing", () => {
  it("rejects malformed, unsafe, and negative values instead of coercing to 0", () => {
    expect(toSafeByteCount(null)).toBeNull();
    expect(toSafeByteCount(undefined)).toBeNull();
    expect(toSafeByteCount("")).toBeNull();
    expect(toSafeByteCount("12abc")).toBeNull();
    expect(toSafeByteCount(-1)).toBeNull();
    expect(toSafeByteCount(Number.NaN)).toBeNull();
    expect(toSafeByteCount(2 ** 53)).toBeNull();
    expect(toSafeByteCount("5368709120")).toBe(5368709120);
  });
});

describe("effective-size derivation (D077, fail-closed)", () => {
  it("an invalid raw measurement is an explicit unavailable state that denies", () => {
    for (const rawBytes of [null, undefined, "", "garbage", -5, 0]) {
      const result = base({ rawBytes });
      expect(result.metric).toBe("unavailable");
      expect(result.fallbackReason).toBe("raw_measurement_invalid");
      expect(result.rawBytes).toBeNull();
      expect(result.effectiveBytes).toBeNull();
      // Fail-closed: no number means treated as breached, never as zero.
      expect(result.breachedRaw).toBe(true);
      expect(result.breachedEffective).toBe(true);
    }
  });

  it("an invalid budget denies the same way", () => {
    const result = base({ budgetBytes: 0 });
    expect(result.metric).toBe("unavailable");
    expect(result.breachedEffective).toBe(true);
  });

  it("missing extension falls back to the raw size", () => {
    const result = base({ extensionPresent: false });
    expect(result.metric).toBe("raw_fallback");
    expect(result.fallbackReason).toBe("extension_missing");
    expect(result.effectiveBytes).toBe(result.rawBytes);
    expect(result.breachedEffective).toBe(true);
  });

  it("a measurement error, negative or overlarge free space all fall back to raw", () => {
    expect(base({ measurementError: true }).fallbackReason).toBe(
      "measurement_error",
    );
    expect(base({ approxFreeSpace: -1 }).fallbackReason).toBe(
      "negative_free_space",
    );
    expect(
      base({ approxFreeSpace: Math.floor(2.6 * GIB) }).fallbackReason,
    ).toBe("free_space_exceeds_table");
  });

  it("a table_len that disagrees with pg_table_size falls back to raw", () => {
    expect(
      base({ approxTableLen: Math.floor(2.5 * GIB * 1.05) }).fallbackReason,
    ).toBe("table_len_inconsistent");
    expect(
      base({ approxTableLen: Math.floor(2.5 * GIB * 0.4) }).fallbackReason,
    ).toBe("table_len_inconsistent");
  });

  it("an invalid heap measurement falls back to raw rather than validating against nothing", () => {
    const result = base({ heapBytes: "broken" });
    expect(result.fallbackReason).toBe("heap_measurement_invalid");
    expect(result.effectiveBytes).toBe(result.rawBytes);
  });

  it("subtracts ONLY proven heap free space; index bytes stay fully counted", () => {
    const result = base({});
    expect(result.metric).toBe("effective_reusable_heap");
    expect(result.provenFreeHeapBytes).toBe(1 * GIB);
    expect(result.effectiveBytes).toBe(5 * GIB + 40_960 - 1 * GIB);
    expect(result.breachedRaw).toBe(true);
    expect(result.breachedEffective).toBe(false);
  });

  it("proven free space below the breach margin still reports breached", () => {
    const result = base({ approxFreeSpace: 10_000 });
    expect(result.metric).toBe("effective_reusable_heap");
    expect(result.breachedEffective).toBe(true);
  });
});
