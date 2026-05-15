import { describe, expect, it } from "vitest";
import { defaultBusinessConfig } from "../../config";
import { applyPostProcess, type GateContext } from "../../gates/types";
import type {
  AccountCalibration,
  BusinessConfig,
  CreativeInput,
  DataHealth,
  DecisionLabel,
} from "../../types";
import {
  makeAccountCalibration,
  makeCreativeInput,
  makeDataHealth,
  makeDataLayerHealth,
  makeGateContext,
} from "../helpers";

function runPostProcess(
  label: DecisionLabel,
  overrides: {
    input?: Partial<CreativeInput>;
    businessConfig?: Partial<BusinessConfig>;
    calibration?: Partial<AccountCalibration>;
    dataHealth?: DataHealth;
    gate?: Partial<
      Omit<GateContext, "input" | "businessConfig" | "calibration">
    >;
  } = {},
) {
  const businessConfig = {
    ...defaultBusinessConfig("biz-1"),
    ...overrides.businessConfig,
  };

  return applyPostProcess(
    makeGateContext({
      input: makeCreativeInput(overrides.input),
      businessConfig,
      calibration: makeAccountCalibration(overrides.calibration),
      dataHealth: overrides.dataHealth,
      gate: overrides.gate,
    }),
    label,
  );
}

function badgeTypes(result: ReturnType<typeof runPostProcess>) {
  return result.badges.map((badge) => badge.type);
}

describe("applyPostProcess - data health", () => {
  it("adds stale_calibration without confidence penalty for warning freshness", () => {
    const result = runPostProcess("keep", {
      dataHealth: makeDataHealth({
        calibration: makeDataLayerHealth({ staleTier: "warning" }),
      }),
    });

    expect(result.badges).toContainEqual({
      type: "stale_calibration",
      label: "Calibration data stale",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("adds stale_calibration and -10 confidence for disabled freshness", () => {
    const result = runPostProcess("keep", {
      dataHealth: makeDataHealth({
        calibration: makeDataLayerHealth({ staleTier: "disabled" }),
      }),
    });

    expect(result.badges).toContainEqual({
      type: "stale_calibration",
      label: "Calibration data too stale",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toEqual([-10]);
  });

  it("adds stale_lifecycle and -15 confidence for disabled freshness", () => {
    const result = runPostProcess("keep", {
      dataHealth: makeDataHealth({
        lifecycle: makeDataLayerHealth({ staleTier: "disabled" }),
      }),
    });

    expect(result.badges).toContainEqual({
      type: "stale_lifecycle",
      label: "Lifecycle data too stale",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toEqual([-15]);
  });

  it("adds stale_decision_context as informational without confidence penalty", () => {
    const result = runPostProcess("keep", {
      dataHealth: makeDataHealth({
        decisions: makeDataLayerHealth({ staleTier: "warning" }),
      }),
    });

    expect(result.badges).toContainEqual({
      type: "stale_decision_context",
      label: "Decision context stale",
      severity: "info",
    });
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("adds stale_decision_context and confidence penalty when decision freshness is disabled", () => {
    const result = runPostProcess("scale", {
      dataHealth: makeDataHealth({
        decisions: makeDataLayerHealth({ staleTier: "disabled" }),
      }),
    });

    expect(result.badges).toContainEqual({
      type: "stale_decision_context",
      label: "Decision context too stale",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toContain(-25);
  });

  it("emits separate stale badges and stacks disabled-layer penalties", () => {
    const result = runPostProcess("keep", {
      dataHealth: makeDataHealth({
        calibration: makeDataLayerHealth({ staleTier: "disabled" }),
        lifecycle: makeDataLayerHealth({ staleTier: "disabled" }),
        decisions: makeDataLayerHealth({ staleTier: "warning" }),
      }),
    });

    expect(badgeTypes(result)).toEqual([
      "stale_calibration",
      "stale_lifecycle",
      "stale_decision_context",
    ]);
    expect(result.confidenceDeltas).toEqual([-10, -15]);
  });
});

describe("applyPostProcess - low CTR", () => {
  it("adds a low_ctr badge for keep without a confidence penalty", () => {
    const result = runPostProcess("keep", {
      input: { ctr: 0.5 },
      calibration: { lowCtrP10: 1.0 },
    });

    expect(result.badges).toContainEqual({
      type: "low_ctr",
      label: "Low CTR (0.50% vs account P10 1.00%)",
      severity: "info",
    });
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("adds a low_ctr badge and confidence penalty for cut", () => {
    const result = runPostProcess("cut", {
      input: { ctr: 0.5 },
      calibration: { lowCtrP10: 1.0 },
    });

    expect(badgeTypes(result)).toContain("low_ctr");
    expect(result.confidenceDeltas).toEqual([-10]);
  });

  it("adds a low_ctr badge and confidence penalty for refresh", () => {
    const result = runPostProcess("refresh", {
      input: { ctr: 0.5 },
      calibration: { lowCtrP10: 1.0 },
    });

    expect(badgeTypes(result)).toContain("low_ctr");
    expect(result.confidenceDeltas).toEqual([-10]);
  });

  it("does not add a low_ctr badge when CTR is above threshold", () => {
    const result = runPostProcess("keep", {
      input: { ctr: 1.5 },
      calibration: { lowCtrP10: 1.0 },
    });

    expect(result.badges).toEqual([]);
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("does not add a low_ctr badge when CTR is null", () => {
    const result = runPostProcess("keep", {
      input: { ctr: null },
      calibration: { lowCtrP10: 1.0 },
    });

    expect(result.badges).toEqual([]);
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("uses the business fallback threshold when account P10 is null", () => {
    const result = runPostProcess("keep", {
      input: { ctr: 0.5 },
      businessConfig: { lowCtrThresholdFallback: 1.0 },
      calibration: { lowCtrP10: null },
    });

    expect(result.badges).toContainEqual({
      type: "low_ctr",
      label: "Low CTR (0.50% vs account P10 1.00%)",
      severity: "info",
    });
    expect(result.confidenceDeltas).toEqual([]);
  });
});

describe("applyPostProcess - funnel badges", () => {
  it("adds creative_quality_weak for cut when upper funnel is weak", () => {
    const result = runPostProcess("cut", {
      input: {
        ctr: 0.5,
        thumbstop: 10,
      },
    });

    expect(badgeTypes(result)).toContain("creative_quality_weak");
  });
});

describe("applyPostProcess - missing recent data", () => {
  it("adds a missing_recent_data badge and confidence penalty for scale when recent ROAS is null", () => {
    const result = runPostProcess("scale", {
      input: { recent7dRoas: null },
    });

    expect(result.badges).toContainEqual({
      type: "missing_recent_data",
      label: "Recent 7d data missing",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toEqual([-10]);
  });

  it("adds a missing_recent_data badge and confidence penalty for keep when recent spend is null", () => {
    const result = runPostProcess("keep", {
      input: { recent7dSpend: null },
    });

    expect(badgeTypes(result)).toContain("missing_recent_data");
    expect(result.confidenceDeltas).toEqual([-10]);
  });

  it("does not add a missing_recent_data badge for test_more", () => {
    const result = runPostProcess("test_more", {
      input: { recent7dRoas: null },
    });

    expect(result.badges).toEqual([]);
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("does not add a missing_recent_data badge for diagnose", () => {
    const result = runPostProcess("diagnose", {
      input: { recent7dRoas: null },
    });

    expect(result.badges).toEqual([]);
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("does not add a missing_recent_data badge for out_of_scope", () => {
    const result = runPostProcess("out_of_scope", {
      input: { recent7dRoas: null },
    });

    expect(result.badges).toEqual([]);
    expect(result.confidenceDeltas).toEqual([]);
  });
});

describe("applyPostProcess - cut candidate", () => {
  it("adds cut_candidate for low-ratio test_more decisions with enough spend", () => {
    const result = runPostProcess("test_more", {
      input: { spend: 300 },
      gate: { ratioToTarget: 0.5 },
    });

    expect(result.badges).toContainEqual({
      type: "cut_candidate",
      label:
        "Cut candidate — ROAS 50% of target on $300 spend; consider manual cut or wait for hard threshold",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("adds cut_candidate for low-ratio keep decisions with enough spend", () => {
    const result = runPostProcess("keep", {
      input: { spend: 450 },
      gate: { ratioToTarget: 0.59 },
    });

    expect(badgeTypes(result)).toContain("cut_candidate");
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("does not duplicate an existing cut_candidate badge", () => {
    const result = runPostProcess("test_more", {
      input: { spend: 300 },
      gate: {
        ratioToTarget: 0.5,
        badges: [
          {
            type: "cut_candidate",
            label: "Soft-cut candidate",
            severity: "warning",
          },
        ],
      },
    });

    expect(
      result.badges.filter((badge) => badge.type === "cut_candidate"),
    ).toHaveLength(1);
  });

  it("does not add cut_candidate below the spend floor", () => {
    const result = runPostProcess("test_more", {
      input: { spend: 299 },
      gate: { ratioToTarget: 0.5 },
    });

    expect(badgeTypes(result)).not.toContain("cut_candidate");
  });

  it("does not add cut_candidate to hard cut decisions", () => {
    const result = runPostProcess("cut", {
      input: { spend: 500 },
      gate: { ratioToTarget: 0.5 },
    });

    expect(badgeTypes(result)).not.toContain("cut_candidate");
  });
});

describe("applyPostProcess - lifecycle awareness", () => {
  it("adds opportunity_window_open and +5 confidence for rising scale decisions", () => {
    const result = runPostProcess("scale", {
      input: { lifecyclePosition: "rising", daysSincePeak: 1 },
    });

    expect(result.badges).toContainEqual({
      type: "opportunity_window_open",
      label: "Opportunity window — peak now (peak 1d ago)",
      severity: "info",
    });
    expect(result.confidenceDeltas).toEqual([5]);
  });

  it("adds opportunity_window_open and +3 confidence for rising keep decisions", () => {
    const result = runPostProcess("keep", {
      input: { lifecyclePosition: "rising" },
    });

    expect(badgeTypes(result)).toContain("opportunity_window_open");
    expect(result.confidenceDeltas).toEqual([3]);
  });

  it("adds opportunity_window_open and +2 confidence for plateau scale decisions", () => {
    const result = runPostProcess("scale", {
      input: { lifecyclePosition: "plateau", daysSincePeak: 5 },
    });

    expect(result.badges).toContainEqual({
      type: "opportunity_window_open",
      label: "Plateau — window still open (peak 5d ago)",
      severity: "info",
    });
    expect(result.confidenceDeltas).toEqual([2]);
  });

  it("adds opportunity_window_closing without confidence delta for closing keep decisions", () => {
    const result = runPostProcess("keep", {
      input: { lifecyclePosition: "closing" },
    });

    expect(result.badges).toContainEqual({
      type: "opportunity_window_closing",
      label: "Opportunity window closing",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("adds past_peak_unclear_signal and -3 confidence for unclear refresh decisions", () => {
    const result = runPostProcess("refresh", {
      input: { lifecyclePosition: "past_peak_unclear" },
    });

    expect(badgeTypes(result)).toContain("past_peak_unclear_signal");
    expect(result.confidenceDeltas).toEqual([-3]);
  });

  it("adds past_peak_unclear_signal without confidence delta for unclear keep decisions", () => {
    const result = runPostProcess("keep", {
      input: { lifecyclePosition: "past_peak_unclear" },
    });

    expect(badgeTypes(result)).toContain("past_peak_unclear_signal");
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("adds volatile_trend and -5 confidence for volatile decisions", () => {
    const result = runPostProcess("test_more", {
      input: { lifecyclePosition: "volatile" },
    });

    expect(result.badges).toContainEqual({
      type: "volatile_trend",
      label: "Volatile spend/ROAS trend — signal noisy",
      severity: "warning",
    });
    expect(result.confidenceDeltas).toEqual([-5]);
  });

  it("adds lifecycle_unavailable without confidence delta for null lifecycle scale decisions", () => {
    const result = runPostProcess("scale", {
      input: { lifecyclePosition: null },
    });

    expect(result.badges).toContainEqual({
      type: "lifecycle_unavailable",
      label: "Lifecycle data unavailable",
      severity: "info",
    });
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("does not add lifecycle_unavailable for insufficient-history test_more decisions", () => {
    const result = runPostProcess("test_more", {
      input: { lifecyclePosition: "insufficient_history" },
    });

    expect(result.badges).toEqual([]);
    expect(result.confidenceDeltas).toEqual([]);
  });

  it("does not add badges or deltas for natural post-peak decisions", () => {
    const result = runPostProcess("scale", {
      input: { lifecyclePosition: "past_peak_natural" },
    });

    expect(result.badges).toEqual([]);
    expect(result.confidenceDeltas).toEqual([]);
  });
});
