import { describe, expect, it } from "vitest";
import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import { emitLeadAdsetScenario } from "@/lib/meta/scenario-emitters/lead";

const context: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 8,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      cost_per_lead_28d: { p10: 5, p25: 10, p50: 20, p75: 30, p90: 35, sampleSize: 20 },
      lead_to_purchase_rate_28d: { p10: 0, p25: 10, p50: 20, p75: 30, p90: 40, sampleSize: 20 },
      freq_14d: { p10: 1, p25: 1.3, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
      ctr_28d: { p10: 0.4, p25: 1, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
    },
  },
  scope: { type: "campaign", id: "cmp_1", snapshotDate: "2026-05-14", cohort: "lead" },
  cohort: "lead",
};

function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
  return {
    id: "adset_1",
    accountId: "act_1",
    name: "Lead Adset",
    campaignId: "cmp_1",
    status: "ACTIVE",
    budgetLevel: "adset",
    dailyBudget: 100,
    lifetimeBudget: null,
    optimizationGoal: "LEAD_GENERATION",
    customEventType: "LEAD",
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    spend: 200,
    purchases: 0,
    leads: 10,
    revenue: 0,
    roas: 0,
    cpa: 0,
    ctr: 2,
    cpm: 10,
    impressions: 1000,
    clicks: 100,
    frequency: 1.5,
    ...overrides,
  };
}

function signal(ageDays = 20): MetaEntityDecisionSignal {
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
  };
}

function targetScore(rec: ReturnType<typeof emitLeadAdsetScenario>) {
  return (rec?.targetValue as { score?: number } | undefined)?.score;
}

describe("emitLeadAdsetScenario", () => {
  it("emits L1 scale for an efficient mature lead adset", () => {
    const rec = emitLeadAdsetScenario({
      adset: adset({ spend: 100, leads: 25 }),
      context,
      cohort: "lead",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_l1_lead_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.confidence).toBe("high");
    expect(rec?.cohort).toBe("lead");
  });

  it("emits L3 cut for an inefficient mature lead adset above hard-cut spend", () => {
    const rec = emitLeadAdsetScenario({
      adset: adset({ spend: 1000, leads: 10 }),
      context,
      cohort: "lead",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_l3_lead_inefficient_cut");
    expect(rec?.decisionLabel).toBe("cut");
  });

  it("emits L2 keep for a steady lead score", () => {
    const rec = emitLeadAdsetScenario({
      adset: adset({ spend: 170, leads: 10 }),
      context,
      cohort: "lead",
      signals: signal(20),
    });

    expect(rec?.type).toBe("scenario_l2_lead_steady_keep");
    expect(rec?.decisionLabel).toBe("keep");
  });

  it("emits L4 refresh for a weak lead score with fatigue", () => {
    const rec = emitLeadAdsetScenario({
      adset: adset({ spend: 230, leads: 10, frequency: 4 }),
      context,
      cohort: "lead",
      signals: signal(3),
    });

    expect(rec?.type).toBe("scenario_l4_lead_refresh");
    expect(rec?.decisionLabel).toBe("refresh");
  });

  it("credits pixel purchases as a lead-to-purchase bonus on percent scale", () => {
    const withPurchases = emitLeadAdsetScenario({
      adset: adset({ spend: 200, leads: 10, purchases: 3 }),
      context,
      cohort: "lead",
      signals: signal(20),
    });
    const withoutPurchases = emitLeadAdsetScenario({
      adset: adset({ spend: 200, leads: 10, purchases: 0 }),
      context,
      cohort: "lead",
      signals: signal(20),
    });

    expect(withPurchases?.type).toBe("scenario_l2_lead_steady_keep");
    expect(withoutPurchases?.type).toBe("scenario_l2_lead_steady_keep");
    expect(targetScore(withPurchases)).toBe(0.58);
    expect(targetScore(withoutPurchases)).toBe(0.5);
    expect(targetScore(withPurchases)).toBeGreaterThan(targetScore(withoutPurchases) ?? 0);
  });

  it("short-circuits non-lead cohort adsets", () => {
    const rec = emitLeadAdsetScenario({
      adset: adset({ optimizationGoal: "OFFSITE_CONVERSIONS", customEventType: "" }),
      context,
      cohort: "purchase",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("returns null when lead cost calibration is missing", () => {
    const missingContext: MetaCalibrationContext = {
      ...context,
      thresholds: {
        ...context.thresholds,
        metrics: {
          ...context.thresholds.metrics,
          cost_per_lead_28d: { ...context.thresholds.metrics.cost_per_lead_28d, sampleSize: 0 },
        },
      },
    };
    const rec = emitLeadAdsetScenario({
      adset: adset({ spend: 100, leads: 25 }),
      context: missingContext,
      cohort: "lead",
      signals: signal(20),
    });

    expect(rec).toBeNull();
  });

  it("sets cohort to lead on every emitted recommendation", () => {
    const cases = [
      adset({ spend: 100, leads: 25 }),
      adset({ spend: 170, leads: 10 }),
      adset({ spend: 1000, leads: 10 }),
      adset({ spend: 230, leads: 10, frequency: 4 }),
    ];

    for (const row of cases) {
      const rec = emitLeadAdsetScenario({
        adset: row,
        context,
        cohort: "lead",
        signals: signal(20),
      });
      expect(rec?.cohort).toBe("lead");
    }
  });
});
