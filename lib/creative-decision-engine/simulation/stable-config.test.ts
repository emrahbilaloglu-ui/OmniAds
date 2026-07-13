import { describe, expect, it } from "vitest";
import {
  deduplicateStableConfigs,
  stableConfigHash,
  stableConfigStringify,
} from "./stable-config";

describe("stable config canonicalization", () => {
  it("ignores object insertion order recursively", () => {
    const first = {
      fatigue: { halfLife: 28, floor: 0.2 },
      cut: { boundary: "p25", enabled: true },
    };
    const second = {
      cut: { enabled: true, boundary: "p25" },
      fatigue: { floor: 0.2, halfLife: 28 },
    };

    expect(stableConfigStringify(first)).toBe(stableConfigStringify(second));
    expect(stableConfigHash(first)).toBe(stableConfigHash(second));
    expect(stableConfigHash(first)).toMatch(/^[a-f0-9]{64}$/);
  });

  it("preserves array order and normalizes negative zero", () => {
    expect(stableConfigStringify({ value: -0 })).toBe('{"value":0}');
    expect(stableConfigHash({ grid: [1, 2] })).not.toBe(
      stableConfigHash({ grid: [2, 1] }),
    );
  });

  it("rejects ambiguous or effectful values instead of hashing collisions", () => {
    expect(() => stableConfigHash({ value: Number.NaN })).toThrow(
      "stable config numbers must be finite",
    );
    expect(() => stableConfigHash({ value: undefined })).toThrow(
      "unsupported stable config value: undefined",
    );
    expect(() => stableConfigHash(new Date())).toThrow(
      "stable config objects must be plain objects",
    );
    const cyclic: Record<string, unknown> = {};
    cyclic.self = cyclic;
    expect(() => stableConfigHash(cyclic)).toThrow(
      "stable config cannot be cyclic",
    );
    const sparse = Array(2);
    sparse[1] = "value";
    expect(() => stableConfigHash(sparse)).toThrow(
      "stable config arrays cannot be sparse",
    );
  });
});

describe("deduplicateStableConfigs", () => {
  it("keeps the first config and records every semantic duplicate", () => {
    const result = deduplicateStableConfigs(
      [
        { id: "first", params: { halfLife: 28, kappa: 16 } },
        { id: "duplicate", params: { kappa: 16, halfLife: 28 } },
        { id: "different", params: { halfLife: 56, kappa: 16 } },
        { id: "duplicate-again", params: { halfLife: 28, kappa: 16 } },
      ],
      (entry) => entry.params,
    );

    expect(result).toMatchObject({
      inputCount: 4,
      uniqueCount: 2,
      duplicateCount: 2,
    });
    expect(result.unique[0]).toMatchObject({
      config: { id: "first", params: { halfLife: 28, kappa: 16 } },
      firstIndex: 0,
      duplicateIndices: [1, 3],
    });
    expect(result.unique[1]).toMatchObject({
      config: { id: "different", params: { halfLife: 56, kappa: 16 } },
      firstIndex: 2,
      duplicateIndices: [],
    });
  });
});
