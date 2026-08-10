import { describe, expect, it } from "vitest";
import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import { emitTrafficAdsetScenario } from "@/lib/meta/scenario-emitters/traffic";

const context: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 8,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      cost_per_link_click_28d: { p10: 0.2, p25: 0.5, p50: 1, p75: 1.5, p90: 2.2, sampleSize: 20 },
      cost_per_lpv_28d: { p10: 1, p25: 1.5, p50: 2, p75: 3, p90: 5, sampleSize: 20 },
      ctr_28d: { p10: 0.5, p25: 1, p50: 2.5, p75: 4, p90: 5.5, sampleSize: 20 },
      freq_14d: { p10: 1, p25: 1.3, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
    },
  },
  scope: { type: "campaign", id: "cmp_1", snapshotDate: "2026-05-14", cohort: "traffic" },
  cohort: "traffic",
};

function adset(
  overrides: Partial<MetaAdSetData> & { currency?: string | null } = {},
): MetaAdSetData {
  return {
    id: "adset_1",
    accountId: "act_1",
    name: "Traffic Adset",
    campaignId: "cmp_1",
    status: "ACTIVE",
    budgetLevel: "adset",
    dailyBudget: 100,
    lifetimeBudget: null,
    optimizationGoal: "LINK_CLICKS",
    customEventType: null,
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    spend: 100,
    purchases: 0,
    revenue: 0,
    roas: 0,
    cpa: 0,
    ctr: 2.5,
    cpm: 10,
    impressions: 1000,
    clicks: 100,
    linkClicks: 100,
    landingPageViews: 0,
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

function targetValue(rec: ReturnType<typeof emitTrafficAdsetScenario>) {
  return rec?.targetValue as
    | { primary_metric?: string; score?: number; ctr_rank?: number | null }
    | undefined;
}

describe("emitTrafficAdsetScenario", () => {
  it("emits T1 scale for efficient mature link-click traffic", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 20, linkClicks: 200, ctr: 6 }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_t1_traffic_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.confidence).toBe("high");
    expect(rec?.cohort).toBe("traffic");
  });

  it.each([
    ["GBP", "£0.10"],
    [null, "0.1 (Currency unavailable)"],
  ] as const)("formats traffic cost with provider currency %s", (currency, expected) => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 20, linkClicks: 200, ctr: 6, currency }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    const cost = rec?.evidence.find((item) => item.label === "Cost / link click")?.value;
    expect(cost).toBe(expected);
    if (currency === null) expect(cost).not.toContain("$");
  });

  it("keeps an efficient one-event traffic row on watch", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({
        spend: context.thresholds.metrics.cost_per_link_click_28d.p10,
        linkClicks: 1,
        ctr: 6,
      }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_t2_traffic_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
    expect(rec?.decisionState).toBe("watch");
    expect(targetValue(rec)?.score).toBe(0.92);
    expect(rec?.confidence).toBe("low");
    expect(rec?.confidenceScore).toBe(0.5525);
  });

  it("emits T3 cut for inefficient mature traffic above hard-cut spend", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 1000, linkClicks: 100, ctr: 0.5 }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_t3_traffic_inefficient_cut");
    expect(rec?.decisionLabel).toBe("cut");
    expect(rec?.confidence).toBe("high");
    expect(rec?.confidenceScore).toBeGreaterThanOrEqual(0.7);
  });

  it("suppresses link-click traffic recommendations when event data is missing", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 1000, linkClicks: null, ctr: 0.5 }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("suppresses LPV traffic recommendations when LPV data is missing", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({
        optimizationGoal: "LANDING_PAGE_VIEWS",
        spend: 1000,
        landingPageViews: null,
        ctr: 0.5,
      }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("can cut when observed traffic event data is truly zero", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 1000, linkClicks: 0, ctr: 0.5 }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_t3_traffic_inefficient_cut");
    expect(rec?.decisionLabel).toBe("cut");
    expect(rec?.confidence).toBe("high");
    expect(rec?.confidenceScore).toBe(0.97);
  });

  it("uses LPV cost calibration for landing-page-view traffic", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({
        optimizationGoal: "LANDING_PAGE_VIEWS",
        spend: 20,
        linkClicks: 0,
        landingPageViews: 10,
        ctr: 5,
      }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(targetValue(rec)?.primary_metric).toBe("cost_per_lpv_28d");
    expect(rec?.cohort).toBe("traffic");
  });

  it("emits T2 keep for a steady traffic score", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 100, linkClicks: 100, ctr: 3.5 }),
      context,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_t2_traffic_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
    expect(targetValue(rec)?.score).toBe(0.55);
  });

  it("emits T4 refresh for weak traffic with fatigue", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 140, linkClicks: 100, ctr: 2.5, frequency: 4 }),
      context,
      cohort: "traffic",
      signals: signal(3, { ctrDecayPct: -20 }),
    });

    expect(rec?.type).toBe("scenario_t4_traffic_refresh");
    expect(rec?.decisionLabel).toBe("refresh");
  });

  it("does not call high frequency fatigue without temporal decay", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 140, linkClicks: 100, ctr: 2.5, frequency: 4 }),
      context,
      cohort: "traffic",
      signals: signal(20, { ctrDecayPct: null }),
    });

    expect(rec?.type).toBe("scenario_t2_traffic_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
  });

  it("does not call CTR decay fatigue without account-relative exposure pressure", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 140, linkClicks: 100, ctr: 0.5, frequency: 1.2 }),
      context,
      cohort: "traffic",
      signals: signal(20, { ctrDecayPct: -25 }),
    });

    expect(rec?.type).toBe("scenario_t2_traffic_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
  });

  it("returns null when matching link-click calibration is missing", () => {
    const missingContext: MetaCalibrationContext = {
      ...context,
      thresholds: {
        ...context.thresholds,
        metrics: {
          ...context.thresholds.metrics,
          cost_per_link_click_28d: {
            ...context.thresholds.metrics.cost_per_link_click_28d,
            sampleSize: 0,
          },
        },
      },
    };
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 20, linkClicks: 200, ctr: 6 }),
      context: missingContext,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("falls back to pure primary rank when CTR calibration is missing", () => {
    const missingCtrContext: MetaCalibrationContext = {
      ...context,
      thresholds: {
        ...context.thresholds,
        metrics: {
          ...context.thresholds.metrics,
          ctr_28d: { ...context.thresholds.metrics.ctr_28d, sampleSize: 0 },
        },
      },
    };
    const rec = emitTrafficAdsetScenario({
      adset: adset({ spend: 20, linkClicks: 200, ctr: 6 }),
      context: missingCtrContext,
      cohort: "traffic",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_t1_traffic_efficient_scale");
    expect(targetValue(rec)?.ctr_rank).toBeNull();
  });

  it("short-circuits non-traffic cohort adsets", () => {
    const rec = emitTrafficAdsetScenario({
      adset: adset({ optimizationGoal: "OFFSITE_CONVERSIONS" }),
      context,
      cohort: "purchase",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("sets cohort to traffic on every emitted recommendation", () => {
    const cases = [
      adset({ spend: 20, linkClicks: 200, ctr: 6 }),
      adset({ spend: 100, linkClicks: 100, ctr: 3.5 }),
      adset({ spend: 1000, linkClicks: 100, ctr: 0.5 }),
      adset({ spend: 140, linkClicks: 100, ctr: 2.5, frequency: 4 }),
    ];

    for (const row of cases) {
      const rec = emitTrafficAdsetScenario({
        adset: row,
        context,
        cohort: "traffic",
        signals: signal(20),
      });
      expect(rec?.cohort).toBe("traffic");
    }
  });
});
