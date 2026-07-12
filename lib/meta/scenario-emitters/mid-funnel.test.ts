import { describe, expect, it } from "vitest";
import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import { emitMidFunnelAdsetScenario } from "@/lib/meta/scenario-emitters/mid-funnel";

const context: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 8,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      cost_per_atc_28d: { p10: 5, p25: 8, p50: 12, p75: 16, p90: 25, sampleSize: 20 },
      cost_per_ic_28d: { p10: 7, p25: 10, p50: 14, p75: 18, p90: 28, sampleSize: 20 },
      cost_per_vc_28d: { p10: 2, p25: 3, p50: 5, p75: 8, p90: 12, sampleSize: 20 },
      atc_rate_28d: { p10: 1, p25: 2, p50: 3, p75: 4, p90: 5, sampleSize: 20 },
      atc_to_purchase_rate_28d: { p10: 1, p25: 3, p50: 6, p75: 8, p90: 11, sampleSize: 20 },
      freq_14d: { p10: 1, p25: 1.3, p50: 1.8, p75: 2.5, p90: 3.5, sampleSize: 20 },
      ctr_28d: { p10: 0.4, p25: 1, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
    },
  },
  scope: { type: "campaign", id: "cmp_1", snapshotDate: "2026-05-14", cohort: "mid_funnel" },
  cohort: "mid_funnel",
};

function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
  return {
    id: "adset_1",
    accountId: "act_1",
    name: "ATC Adset",
    campaignId: "cmp_1",
    status: "ACTIVE",
    budgetLevel: "adset",
    dailyBudget: 100,
    lifetimeBudget: null,
    optimizationGoal: "OFFSITE_CONVERSIONS",
    customEventType: "ADD_TO_CART",
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    spend: 400,
    purchases: 0,
    revenue: 0,
    roas: 0,
    cpa: 0,
    ctr: 2,
    cpm: 10,
    impressions: 1000,
    clicks: 100,
    addToCart: 20,
    initiateCheckout: 0,
    viewContent: 0,
    frequency: 1.5,
    ...overrides,
  };
}

function signal(
  ageDays = 20,
  overrides: Partial<MetaEntityDecisionSignal> = {},
): MetaEntityDecisionSignal {
  return {
    businessId: "biz_1",
    providerAccountId: "act_1",
    scopeType: "adset",
    scopeId: "adset_1",
    asOfDate: "2026-05-14",
    learningState: "OPTIMAL_LEARNING_DONE",
    daysAtLearningState: null,
    lastSignificantEditAt: null,
    daysSinceSignificantEdit: null,
    recentChangeCooldownUntil: null,
    creativeAgeDays: 20,
    creativeAgeDaysMax: 20,
    frequencyP80: null,
    ctrDecayPct: null,
    sourceJson: { age_days: ageDays },
    qualityStatus: "ready",
    ...overrides,
  };
}

describe("emitMidFunnelAdsetScenario", () => {
  it("emits M1 scale for an efficient mature mid_funnel adset", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ spend: 400, addToCart: 100, purchases: 20, impressions: 1000 }),
      context,
      cohort: "mid_funnel",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_m1_mid_funnel_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.cohort).toBe("mid_funnel");
  });

  it("keeps an efficient one-event mid_funnel row on watch", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({
        spend: context.thresholds.metrics.cost_per_atc_28d.p10,
        addToCart: 1,
        purchases: 1,
        impressions: 10,
      }),
      context,
      cohort: "mid_funnel",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_m2_mid_funnel_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
    expect(rec?.decisionState).toBe("watch");
    expect((rec?.targetValue as { score?: number } | undefined)?.score).toBe(0.95);
    expect(rec?.confidence).toBe("low");
    expect(rec?.confidenceScore).toBe(0.55625);
  });

  it("emits M3 cut for an inefficient mature mid_funnel adset above hard-cut spend", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ spend: 1000, addToCart: 25, purchases: 0, impressions: 10000, ctr: 2 }),
      context,
      cohort: "mid_funnel",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_m3_mid_funnel_inefficient_cut");
    expect(rec?.decisionLabel).toBe("cut");
    expect(rec?.confidence).toBe("high");
    expect(rec?.confidenceScore).toBeGreaterThanOrEqual(0.7);
  });

  it("suppresses mid_funnel recommendations when event data is missing", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ spend: 1000, addToCart: null, purchases: 0, impressions: 10000 }),
      context,
      cohort: "mid_funnel",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("can cut when observed mid_funnel event data is truly zero", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ spend: 1000, addToCart: 0, purchases: 0, impressions: 10000 }),
      context,
      cohort: "mid_funnel",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_m3_mid_funnel_inefficient_cut");
    expect(rec?.decisionLabel).toBe("cut");
    expect(rec?.decisionState).toBe("act");
    expect(rec?.confidence).toBe("high");
    expect(rec?.confidenceScore).toBe(0.99);
  });

  it("emits M2 keep for a steady mid_funnel score", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ spend: 390, addToCart: 30, purchases: 2, impressions: 1000 }),
      context,
      cohort: "mid_funnel",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_m2_mid_funnel_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
  });

  it("emits M4 refresh for a weak mid_funnel score with fatigue", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ spend: 400, addToCart: 20, purchases: 0, impressions: 1000, frequency: 4, ctr: 0.5 }),
      context,
      cohort: "mid_funnel",
      signals: signal(3, { ctrDecayPct: -20 }),
    });

    expect(rec?.type).toBe("scenario_m4_mid_funnel_refresh");
    expect(rec?.decisionLabel).toBe("refresh");
  });

  it("short-circuits purchase cohort adsets", () => {
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ customEventType: "" }),
      context,
      cohort: "purchase",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("returns null when required mid_funnel calibration rows are missing", () => {
    const missingContext: MetaCalibrationContext = {
      ...context,
      thresholds: {
        ...context.thresholds,
        metrics: {
          ...context.thresholds.metrics,
          cost_per_atc_28d: { ...context.thresholds.metrics.cost_per_atc_28d, sampleSize: 0 },
        },
      },
    };
    const rec = emitMidFunnelAdsetScenario({
      adset: adset({ spend: 400, addToCart: 100, purchases: 20, impressions: 1000 }),
      context: missingContext,
      cohort: "mid_funnel",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("sets cohort to mid_funnel on every emitted recommendation", () => {
    const cases = [
      adset({ spend: 400, addToCart: 100, purchases: 20, impressions: 1000 }),
      adset({ spend: 390, addToCart: 30, purchases: 2, impressions: 1000 }),
      adset({ spend: 400, addToCart: 20, purchases: 0, impressions: 1000, frequency: 4, ctr: 0.5 }),
    ];

    for (const row of cases) {
      const rec = emitMidFunnelAdsetScenario({
        adset: row,
        context,
        cohort: "mid_funnel",
        signals: signal(20),
      });
      expect(rec?.cohort).toBe("mid_funnel");
    }
  });
});
