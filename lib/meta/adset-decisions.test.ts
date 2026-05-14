import { describe, expect, it } from "vitest";
import { buildMetaAdsetRecommendations } from "@/lib/meta/adset-decisions";
import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";

function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
  return {
    id: "adset-1",
    accountId: "act-1",
    name: "Adset 1",
    campaignId: "cmp-1",
    status: "ACTIVE",
    budgetLevel: "adset",
    dailyBudget: 100,
    lifetimeBudget: null,
    optimizationGoal: "OFFSITE_CONVERSIONS",
    customEventType: null,
    bidStrategyType: null,
    bidStrategyLabel: null,
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    spend: 600,
    purchases: 0,
    revenue: 0,
    roas: 0,
    cpa: 0,
    ctr: 1,
    cpm: 10,
    impressions: 10000,
    clicks: 100,
    ...overrides,
  };
}

const midFunnelContext: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 8,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      cost_per_atc_28d: { p10: 5, p25: 8, p50: 12, p75: 16, p90: 25, sampleSize: 20 },
      atc_rate_28d: { p10: 1, p25: 2, p50: 3, p75: 4, p90: 5, sampleSize: 20 },
      atc_to_purchase_rate_28d: { p10: 1, p25: 3, p50: 6, p75: 8, p90: 11, sampleSize: 20 },
      freq_14d: { p10: 1, p25: 1.3, p50: 1.8, p75: 2.5, p90: 3.5, sampleSize: 20 },
      ctr_28d: { p10: 0.4, p25: 1, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
    },
  },
  scope: { type: "campaign", id: "cmp-1", snapshotDate: "2026-05-14", cohort: "mid_funnel" },
  cohort: "mid_funnel",
};

const leadContext: MetaCalibrationContext = {
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
  scope: { type: "campaign", id: "cmp-1", snapshotDate: "2026-05-14", cohort: "lead" },
  cohort: "lead",
};

const trafficContext: MetaCalibrationContext = {
  thresholds: {
    source: "calibrated",
    hardCutSpend: 200,
    minRequiredSample: 8,
    metrics: {
      ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
      cost_per_link_click_28d: { p10: 0.2, p25: 0.6, p50: 1.2, p75: 1.6, p90: 2.2, sampleSize: 20 },
      cost_per_lpv_28d: { p10: 1, p25: 1.5, p50: 2, p75: 3, p90: 5, sampleSize: 20 },
      ctr_28d: { p10: 0.5, p25: 1, p50: 3, p75: 4, p90: 5.5, sampleSize: 20 },
      freq_14d: { p10: 1, p25: 1.3, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
    },
  },
  scope: { type: "campaign", id: "cmp-1", snapshotDate: "2026-05-14", cohort: "traffic" },
  cohort: "traffic",
};

const engagementContext: MetaCalibrationContext = {
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
  scope: { type: "campaign", id: "cmp-1", snapshotDate: "2026-05-14", cohort: "engagement" },
  cohort: "engagement",
};

describe("buildMetaAdsetRecommendations funnel cohort gating", () => {
  it("does not cut a THRUPLAY adset with high spend and zero purchases", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "THRUPLAY",
          spend: 1000,
          purchases: 0,
          roas: 0,
        }),
      ],
    });

    expect(recs.some((rec) => rec.type === "adset_cut_spend")).toBe(false);
  });

  it("does not cut an ADD_TO_CART adset with high spend and zero purchases", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "ADD_TO_CART",
          spend: 1000,
          purchases: 0,
          roas: 0,
        }),
      ],
    });

    expect(recs.some((rec) => rec.type === "adset_cut_spend")).toBe(false);
  });

  it("still emits the existing fatigue recommendation for an ADD_TO_CART adset", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "ADD_TO_CART",
          spend: 1000,
          purchases: 0,
          roas: 0,
          ctr: 0.5,
          cpm: 25,
          frequency: 4,
        }),
      ],
    });

    expect(recs.some((rec) => rec.type === "adset_cut_spend")).toBe(false);
    expect(recs.some((rec) => rec.type === "adset_watch_learning")).toBe(true);
  });

  it("still scales an OFFSITE_CONVERSIONS purchase adset under existing scale criteria", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "",
          spend: 1000,
          purchases: 12,
          revenue: 4500,
          roas: 4.5,
          cpa: 83,
          ctr: 2,
          cpm: 10,
        }),
      ],
    });

    const scaleRec = recs.find((rec) => rec.type === "adset_scale_budget");
    expect(scaleRec).toBeTruthy();
    expect(scaleRec?.cohort).toBe("purchase");
  });

  it("does not scale a purchase adset when the selected range has mixed goal config", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "",
          isOptimizationGoalMixed: true,
          spend: 1000,
          purchases: 12,
          revenue: 4500,
          roas: 4.5,
          cpa: 83,
        }),
      ],
    });

    expect(recs.some((rec) => rec.type === "adset_scale_budget")).toBe(false);
    expect(recs.some((rec) => rec.type === "adset_cut_spend")).toBe(false);
  });

  it("emits the mid-funnel weighted score recommendation after high-priority checks miss", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "OFFSITE_CONVERSIONS",
          customEventType: "ADD_TO_CART",
          spend: 400,
          addToCart: 100,
          purchases: 20,
          impressions: 1000,
          ctr: 3,
          frequency: 1.5,
        }),
      ],
      calibrationContextByAdsetId: {
        "adset-1": midFunnelContext,
      },
      entitySignalsByAdsetId: {
        "adset-1": {
          businessId: "biz_1",
          providerAccountId: "act_1",
          scopeType: "adset",
          scopeId: "adset-1",
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
          sourceJson: { age_days: 20 },
          qualityStatus: "ready",
        },
      },
    });

    const rec = recs.find((candidate) => candidate.type === "scenario_m1_mid_funnel_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.cohort).toBe("mid_funnel");
  });

  it("emits the lead weighted score recommendation after mid-funnel checks miss", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "LEAD_GENERATION",
          customEventType: "LEAD",
          spend: 100,
          leads: 25,
          purchases: 0,
          ctr: 3,
          frequency: 1.5,
        }),
      ],
      calibrationContextByAdsetId: {
        "adset-1": leadContext,
      },
      entitySignalsByAdsetId: {
        "adset-1": {
          businessId: "biz_1",
          providerAccountId: "act_1",
          scopeType: "adset",
          scopeId: "adset-1",
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
          sourceJson: { age_days: 20 },
          qualityStatus: "ready",
        },
      },
    });

    const rec = recs.find((candidate) => candidate.type === "scenario_l1_lead_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.cohort).toBe("lead");
  });

  it("emits the traffic weighted score recommendation after lead checks miss", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "LINK_CLICKS",
          customEventType: null,
          spend: 20,
          linkClicks: 200,
          landingPageViews: 0,
          purchases: 0,
          revenue: 0,
          roas: 0,
          ctr: 5.5,
          frequency: 1.5,
        }),
      ],
      calibrationContextByAdsetId: {
        "adset-1": trafficContext,
      },
      entitySignalsByAdsetId: {
        "adset-1": {
          businessId: "biz_1",
          providerAccountId: "act_1",
          scopeType: "adset",
          scopeId: "adset-1",
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
          sourceJson: { age_days: 20 },
          qualityStatus: "ready",
        },
      },
    });

    const rec = recs.find((candidate) => candidate.type === "scenario_t1_traffic_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.cohort).toBe("traffic");
  });

  it("emits the engagement weighted score recommendation after traffic checks miss", () => {
    const recs = buildMetaAdsetRecommendations({
      adsets: [
        adset({
          optimizationGoal: "POST_ENGAGEMENT",
          customEventType: null,
          spend: 20,
          postEngagement: 200,
          purchases: 0,
          revenue: 0,
          roas: 0,
          ctr: 2,
          impressions: 3000,
          frequency: 1.5,
        }),
      ],
      calibrationContextByAdsetId: {
        "adset-1": engagementContext,
      },
      entitySignalsByAdsetId: {
        "adset-1": {
          businessId: "biz_1",
          providerAccountId: "act_1",
          scopeType: "adset",
          scopeId: "adset-1",
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
          sourceJson: { age_days: 20 },
          qualityStatus: "ready",
        },
      },
    });

    const rec = recs.find((candidate) => candidate.type === "scenario_eg1_engagement_efficient_scale");
    expect(rec?.decisionLabel).toBe("scale");
    expect(rec?.cohort).toBe("engagement");
  });
});
