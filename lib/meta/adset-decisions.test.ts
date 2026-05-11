import { describe, expect, it } from "vitest";
import { buildMetaAdsetRecommendations } from "@/lib/meta/adset-decisions";
import type { MetaAdSetData } from "@/lib/api/meta";

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
});
