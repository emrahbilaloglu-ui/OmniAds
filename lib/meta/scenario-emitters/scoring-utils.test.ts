import { describe, expect, it } from "vitest";
import { percentileRank, percentileRankInverted } from "@/lib/meta/scenario-emitters/scoring-utils";

const thresholds = { p10: 10, p25: 20, p50: 30, p75: 40, p90: 50, sampleSize: 20 };

describe("scenario scoring utils", () => {
  it("ranks higher-is-better metrics from p10 to p90", () => {
    expect(percentileRank(10, thresholds)).toBeCloseTo(0.1);
    expect(percentileRank(20, thresholds)).toBeCloseTo(0.25);
    expect(percentileRank(30, thresholds)).toBe(0.5);
    expect(percentileRank(40, thresholds)).toBeCloseTo(0.75);
    expect(percentileRank(50, thresholds)).toBeCloseTo(0.9);
    expect(percentileRank(5, thresholds)).toBeCloseTo(0.025);
    expect(percentileRank(55, thresholds)).toBeCloseTo(0.975);
  });

  it("inverts lower-is-better metrics from p10 to p90", () => {
    expect(percentileRankInverted(10, thresholds)).toBeCloseTo(0.9);
    expect(percentileRankInverted(50, thresholds)).toBeCloseTo(0.1);
    expect(percentileRankInverted(30, thresholds)).toBe(0.5);
  });

  it("keeps the median at 0.5 for skewed percentile spacing", () => {
    const skewed = {
      p10: 0,
      p25: 1,
      p50: 2,
      p75: 8,
      p90: 10,
      sampleSize: 20,
    };
    expect(percentileRank(0, skewed)).toBeCloseTo(0.1);
    expect(percentileRank(1, skewed)).toBeCloseTo(0.25);
    expect(percentileRank(2, skewed)).toBeCloseTo(0.5);
    expect(percentileRank(8, skewed)).toBeCloseTo(0.75);
    expect(percentileRank(10, skewed)).toBeCloseTo(0.9);
  });

  it("handles tied calibration anchors without division by zero", () => {
    const tied = {
      p10: 1,
      p25: 1,
      p50: 1,
      p75: 2,
      p90: 3,
      sampleSize: 20,
    };
    expect(percentileRank(1, tied)).toBeCloseTo((0.1 + 0.25 + 0.5) / 3);
    expect(percentileRank(2, tied)).toBeCloseTo(0.75);
  });

  it("returns null for non-finite values", () => {
    expect(percentileRank(Number.NaN, thresholds)).toBeNull();
    expect(percentileRankInverted(Number.POSITIVE_INFINITY, thresholds)).toBeNull();
  });
});
