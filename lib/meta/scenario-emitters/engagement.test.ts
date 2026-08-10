import { describe, expect, it } from "vitest";
import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import { emitEngagementAdsetScenario } from "@/lib/meta/scenario-emitters/engagement";

const context: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 8,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      cost_per_engagement_28d: { p10: 0.2, p25: 0.6, p50: 1.2, p75: 1.6, p90: 2.2, sampleSize: 20 },
      engagement_rate_28d: { p10: 0.5, p25: 1, p50: 3, p75: 4, p90: 5.5, sampleSize: 20 },
      freq_14d: { p10: 1, p25: 1.3, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
    },
  },
  scope: { type: "campaign", id: "cmp_1", snapshotDate: "2026-05-14", cohort: "engagement" },
  cohort: "engagement",
};

function adset(
  overrides: Partial<MetaAdSetData> & { currency?: string | null } = {},
): MetaAdSetData {
  return {
    id: "adset_1",
    accountId: "act_1",
    name: "Engagement Adset",
    campaignId: "cmp_1",
    status: "ACTIVE",
    budgetLevel: "adset",
    dailyBudget: 100,
    lifetimeBudget: null,
    optimizationGoal: "POST_ENGAGEMENT",
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
    impressions: 2000,
    clicks: 100,
    linkClicks: 100,
    landingPageViews: 0,
    postEngagement: 70,
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

function targetValue(rec: ReturnType<typeof emitEngagementAdsetScenario>) {
  return rec?.targetValue as
    | { score?: number; quality_rank?: number | null }
    | undefined;
}

describe("emitEngagementAdsetScenario", () => {
  it("emits EG1 scale for efficient mature engagement", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 20, postEngagement: 200, impressions: 3000 }),
      context,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_eg1_engagement_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.confidence).toBe("high");
    expect(rec?.cohort).toBe("engagement");
  });

  it.each([
    ["GBP", "£0.10"],
    [null, "0.1 (Currency unavailable)"],
  ] as const)("formats engagement cost with provider currency %s", (currency, expected) => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({
        spend: 20,
        postEngagement: 200,
        impressions: 3000,
        currency,
      }),
      context,
      cohort: "engagement",
      signals: signal(20),
    });

    const cost = rec?.evidence.find((item) => item.label === "Cost / engagement")?.value;
    expect(cost).toBe(expected);
    if (currency === null) expect(cost).not.toContain("$");
  });

  it("keeps an efficient one-event engagement row on watch", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({
        spend: context.thresholds.metrics.cost_per_engagement_28d.p10,
        postEngagement: 1,
        impressions: 10,
      }),
      context,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_eg2_engagement_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
    expect(rec?.decisionState).toBe("watch");
    expect(targetValue(rec)?.score).toBe(0.94);
    expect(rec?.confidence).toBe("low");
    expect(rec?.confidenceScore).toBeCloseTo(0.555);
  });

  it("emits EG3 cut for inefficient mature engagement above hard-cut spend", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 1000, postEngagement: 100, impressions: 20000 }),
      context,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_eg3_engagement_inefficient_cut");
    expect(rec?.decisionLabel).toBe("cut");
    expect(rec?.confidence).toBe("high");
    expect(rec?.confidenceScore).toBeGreaterThanOrEqual(0.7);
  });

  it("suppresses engagement recommendations when engagement event data is missing", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 1000, postEngagement: null, impressions: 20000 }),
      context,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("can cut when observed engagement event data is truly zero", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 1000, postEngagement: 0, impressions: 20000 }),
      context,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_eg3_engagement_inefficient_cut");
    expect(rec?.decisionLabel).toBe("cut");
    expect(rec?.confidence).toBe("high");
    expect(rec?.confidenceScore).toBe(1);
  });

  it("emits EG2 keep for a steady engagement score", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 70, postEngagement: 70, impressions: 2000 }),
      context,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_eg2_engagement_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
    expect(targetValue(rec)?.score).toBe(0.6);
  });

  it("emits EG4 refresh for weak engagement with fatigue", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 98, postEngagement: 70, impressions: 2800, frequency: 4 }),
      context,
      cohort: "engagement",
      signals: signal(3, { ctrDecayPct: -20 }),
    });

    expect(rec?.type).toBe("scenario_eg4_engagement_refresh");
    expect(rec?.decisionLabel).toBe("refresh");
  });

  it("returns null when cost-per-engagement calibration is missing", () => {
    const missingContext: MetaCalibrationContext = {
      ...context,
      thresholds: {
        ...context.thresholds,
        metrics: {
          ...context.thresholds.metrics,
          cost_per_engagement_28d: {
            ...context.thresholds.metrics.cost_per_engagement_28d,
            sampleSize: 0,
          },
        },
      },
    };
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 20, postEngagement: 200, impressions: 3000 }),
      context: missingContext,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("falls back to low-confidence watch when engagement-rate calibration is missing", () => {
    const missingRateContext: MetaCalibrationContext = {
      ...context,
      thresholds: {
        ...context.thresholds,
        metrics: {
          ...context.thresholds.metrics,
          engagement_rate_28d: { ...context.thresholds.metrics.engagement_rate_28d, sampleSize: 0 },
        },
      },
    };
    const rec = emitEngagementAdsetScenario({
      adset: adset({ spend: 20, postEngagement: 200, impressions: 3000 }),
      context: missingRateContext,
      cohort: "engagement",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_eg2_engagement_steady_keep");
    expect(rec?.decisionState).toBe("watch");
    expect(rec?.confidence).toBe("low");
    expect(rec?.confidenceScore).toBe(0.5);
    expect(targetValue(rec)?.quality_rank).toBeNull();
  });

  it("short-circuits non-engagement cohort adsets", () => {
    const rec = emitEngagementAdsetScenario({
      adset: adset({ optimizationGoal: "OFFSITE_CONVERSIONS" }),
      context,
      cohort: "purchase",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("sets cohort to engagement on every emitted recommendation", () => {
    const cases = [
      adset({ spend: 20, postEngagement: 200, impressions: 3000 }),
      adset({ spend: 70, postEngagement: 70, impressions: 2000 }),
      adset({ spend: 1000, postEngagement: 100, impressions: 20000 }),
      adset({ spend: 98, postEngagement: 70, impressions: 2800, frequency: 4 }),
    ];

    for (const row of cases) {
      const rec = emitEngagementAdsetScenario({
        adset: row,
        context,
        cohort: "engagement",
        signals: signal(20),
      });
      expect(rec?.cohort).toBe("engagement");
    }
  });
});
