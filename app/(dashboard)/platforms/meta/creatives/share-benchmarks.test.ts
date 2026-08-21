import { describe, expect, it } from "vitest";
import { computeCreativeShareBenchmarks } from "./page-support";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

function row(overrides: Partial<MetaCreativeRow>): MetaCreativeRow {
  return { thumbstop: 0, video50: 0, ctrAll: 0, linkCtr: 0, ...overrides } as MetaCreativeRow;
}

describe("computeCreativeShareBenchmarks", () => {
  it("computes the real median across the account's own rows", () => {
    const rows = [row({ thumbstop: 10 }), row({ thumbstop: 20 }), row({ thumbstop: 30 })];
    expect(computeCreativeShareBenchmarks(rows).thumbstop).toBe(20);
  });

  it("averages the two middle values on an even count", () => {
    const rows = [
      row({ ctrAll: 1 }),
      row({ ctrAll: 2 }),
      row({ ctrAll: 3 }),
      row({ ctrAll: 4 }),
    ];
    expect(computeCreativeShareBenchmarks(rows).ctrAll).toBe(2.5);
  });

  it("refuses to call fewer than 3 comparable rows a typical anything", () => {
    const rows = [row({ thumbstop: 10 }), row({ thumbstop: 90 })];
    expect(computeCreativeShareBenchmarks(rows).thumbstop).toBeNull();
  });

  it("returns null with zero rows, not a fabricated zero", () => {
    const benchmarks = computeCreativeShareBenchmarks([]);
    expect(benchmarks).toEqual({
      thumbstop: null,
      videoCompletion50: null,
      ctrAll: null,
      linkCtr: null,
    });
  });

  it("keeps each metric independent — one metric's sample size does not gate another's", () => {
    // Only ctrAll has 3 real values; the others stay at the default 0 from
    // every row, which IS three real (measured) zeros, not an absence.
    const rows = [row({ ctrAll: 1 }), row({ ctrAll: 2 }), row({ ctrAll: 3 })];
    const benchmarks = computeCreativeShareBenchmarks(rows);
    expect(benchmarks.ctrAll).toBe(2);
    expect(benchmarks.thumbstop).toBe(0);
    expect(benchmarks.videoCompletion50).toBe(0);
  });

  it("keeps a measured zero as data — three real zeros compute a real zero median, not null", () => {
    const rows = [row({ thumbstop: 0 }), row({ thumbstop: 0 }), row({ thumbstop: 0 })];
    expect(computeCreativeShareBenchmarks(rows).thumbstop).toBe(0);
  });

  it("computes all four metrics independently for a mixed set", () => {
    const rows = [
      row({ thumbstop: 20, video50: 40, ctrAll: 1.0, linkCtr: 0.8 }),
      row({ thumbstop: 30, video50: 50, ctrAll: 1.5, linkCtr: 1.2 }),
      row({ thumbstop: 40, video50: 60, ctrAll: 2.0, linkCtr: 1.6 }),
    ];
    expect(computeCreativeShareBenchmarks(rows)).toEqual({
      thumbstop: 30,
      videoCompletion50: 50,
      ctrAll: 1.5,
      linkCtr: 1.2,
    });
  });
});
