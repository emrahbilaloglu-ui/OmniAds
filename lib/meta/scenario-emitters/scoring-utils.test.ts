import { describe, expect, it } from "vitest";
import { percentileRank, percentileRankInverted } from "@/lib/meta/scenario-emitters/scoring-utils";

const thresholds = { p10: 10, p25: 20, p50: 30, p75: 40, p90: 50, sampleSize: 20 };

describe("scenario scoring utils", () => {
  it("ranks higher-is-better metrics from p10 to p90", () => {
    expect(percentileRank(5, thresholds)).toBe(0);
    expect(percentileRank(50, thresholds)).toBe(1);
    expect(percentileRank(30, thresholds)).toBe(0.5);
  });

  it("inverts lower-is-better metrics from p10 to p90", () => {
    expect(percentileRankInverted(5, thresholds)).toBe(1);
    expect(percentileRankInverted(50, thresholds)).toBe(0);
    expect(percentileRankInverted(30, thresholds)).toBe(0.5);
  });

  it("returns null for non-finite values", () => {
    expect(percentileRank(Number.NaN, thresholds)).toBeNull();
    expect(percentileRankInverted(Number.POSITIVE_INFINITY, thresholds)).toBeNull();
  });
});
