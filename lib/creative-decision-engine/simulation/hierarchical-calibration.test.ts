import { describe, expect, it } from "vitest";
import {
  H1_CANDIDATE_GRID,
  effectiveSampleSize,
  recencyWeight,
  resolveHierarchicalCalibration,
  shrinkBoundedRateLogitSpace,
  shrinkPositiveRatioLogSpace,
  weightedQuantile,
} from "./hierarchical-calibration";

describe("hierarchical calibration simulation primitives", () => {
  it("exposes the bounded H1 candidate grid", () => {
    expect(H1_CANDIDATE_GRID).toEqual({
      recencyHalfLifeDays: [14, 28, 56, 90],
      shrinkageKappa: [8, 16, 32, 64],
      quantiles: [0.1, 0.2, 0.25, 0.3, 0.5, 0.6, 0.7, 0.75, 0.8],
    });
  });

  it("computes exponential recency weights and rejects invalid inputs", () => {
    expect(recencyWeight(0, 14)).toBe(1);
    expect(recencyWeight(14, 14)).toBeCloseTo(0.5, 12);
    expect(recencyWeight(28, 14)).toBeCloseTo(0.25, 12);
    expect(recencyWeight(-1, 14)).toBeNull();
    expect(recencyWeight(1, 0)).toBeNull();
  });

  it("computes Kish effective sample size and fails closed", () => {
    expect(effectiveSampleSize([1, 1, 1, 1])).toBe(4);
    expect(effectiveSampleSize([1, 0.5])).toBeCloseTo(1.8, 12);
    expect(effectiveSampleSize([0, 0])).toBeNull();
    expect(effectiveSampleSize([1, -1])).toBeNull();
    expect(effectiveSampleSize([])).toBeNull();
  });

  it("computes deterministic weighted quantiles", () => {
    const rows = [
      { value: 30, weight: 1 },
      { value: 10, weight: 1 },
      { value: 20, weight: 2 },
    ];
    expect(weightedQuantile(rows, 0)).toBe(10);
    expect(weightedQuantile(rows, 0.5)).toBe(20);
    expect(weightedQuantile(rows, 0.75)).toBe(20);
    expect(weightedQuantile(rows, 1)).toBe(30);
    expect(weightedQuantile(rows, -0.1)).toBeNull();
    expect(weightedQuantile([{ value: 1, weight: 0 }], 0.5)).toBeNull();
  });

  it("shrinks positive ratios in log space", () => {
    const result = shrinkPositiveRatioLogSpace({
      local: 4,
      parent: 1,
      localEffectiveSampleSize: 10,
      kappa: 10,
    });
    expect(result).not.toBeNull();
    expect(result?.value).toBeCloseTo(2, 12);
    expect(result?.localWeight).toBe(0.5);
    expect(result?.parentWeight).toBe(0.5);
    expect(
      shrinkPositiveRatioLogSpace({
        local: 0,
        parent: 1,
        localEffectiveSampleSize: 10,
        kappa: 10,
      }),
    ).toBeNull();
  });

  it("shrinks bounded rates in logit space including boundary rates", () => {
    const result = shrinkBoundedRateLogitSpace({
      local: 0.8,
      parent: 0.2,
      localEffectiveSampleSize: 10,
      kappa: 10,
    });
    expect(result?.value).toBeCloseTo(0.5, 12);
    expect(
      shrinkBoundedRateLogitSpace({
        local: 1,
        parent: 0,
        localEffectiveSampleSize: 10,
        kappa: 10,
      })?.value,
    ).toBeCloseTo(0.5, 10);
    expect(
      shrinkBoundedRateLogitSpace({
        local: 1.1,
        parent: 0.5,
        localEffectiveSampleSize: 10,
        kappa: 10,
      }),
    ).toBeNull();
  });

  it("resolves local-to-parent ratios with explicit provenance", () => {
    const result = resolveHierarchicalCalibration({
      domain: "positive_ratio",
      kappa: 10,
      minimumAnchorEffectiveSampleSize: 20,
      levels: [
        {
          source: "account_goal_country",
          estimate: 4,
          sampleSize: 10,
          effectiveSampleSize: 10,
        },
        {
          source: "account_goal",
          estimate: 1,
          sampleSize: 30,
          effectiveSampleSize: 30,
        },
        {
          source: "portfolio",
          estimate: 1,
          sampleSize: 100,
          effectiveSampleSize: 100,
        },
      ],
    });

    expect(result?.value).toBeCloseTo(2, 12);
    expect(result?.source).toBe("account_goal_country");
    expect(result?.anchorSource).toBe("portfolio");
    expect(result?.sampleSize).toBe(10);
    expect(result?.effectiveSampleSize).toBe(10);
    expect(result?.contributions).toEqual([
      {
        source: "portfolio",
        sampleSize: 100,
        effectiveSampleSize: 100,
        role: "anchor",
        localWeight: 1,
      },
      {
        source: "account_goal",
        sampleSize: 30,
        effectiveSampleSize: 30,
        role: "local",
        localWeight: 0.75,
      },
      {
        source: "account_goal_country",
        sampleSize: 10,
        effectiveSampleSize: 10,
        role: "local",
        localWeight: 0.5,
      },
    ]);
  });

  it("falls back over missing local estimates and rejects unsupported hierarchies", () => {
    const fallback = resolveHierarchicalCalibration({
      domain: "bounded_rate",
      kappa: 8,
      minimumAnchorEffectiveSampleSize: 20,
      levels: [
        {
          source: "local",
          estimate: null,
          sampleSize: 0,
          effectiveSampleSize: 0,
        },
        {
          source: "parent",
          estimate: 0.6,
          sampleSize: 40,
          effectiveSampleSize: 30,
        },
      ],
    });
    expect(fallback).toMatchObject({
      value: 0.6,
      source: "parent",
      anchorSource: "parent",
      sampleSize: 40,
      effectiveSampleSize: 30,
    });

    expect(
      resolveHierarchicalCalibration({
        domain: "positive_ratio",
        kappa: 8,
        minimumAnchorEffectiveSampleSize: 20,
        levels: [
          {
            source: "local",
            estimate: 1.2,
            sampleSize: 10,
            effectiveSampleSize: 10,
          },
        ],
      }),
    ).toBeNull();
    expect(
      resolveHierarchicalCalibration({
        domain: "positive_ratio",
        kappa: 8,
        minimumAnchorEffectiveSampleSize: 1,
        levels: [
          {
            source: "invalid",
            estimate: 1.2,
            sampleSize: 2,
            effectiveSampleSize: 3,
          },
        ],
      }),
    ).toBeNull();
  });
});
