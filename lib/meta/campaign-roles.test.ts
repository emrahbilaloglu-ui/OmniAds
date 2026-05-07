import { describe, expect, it } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import { inferBidRegime, inferCampaignRole } from "@/lib/meta/campaign-roles";

function campaign(overrides: Partial<MetaCampaignRow> = {}): MetaCampaignRow {
  return {
    id: "cmp_1",
    accountId: "act_1",
    name: "Purchase Campaign",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    optimizationGoal: "Purchase",
    spend: 1000,
    purchases: 12,
    revenue: 2400,
    roas: 2.4,
    cpa: 83.33,
    ctr: 1.4,
    cpm: 12,
    impressions: 10000,
    clicks: 140,
    budgetLevel: "campaign",
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    currency: "USD",
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    ...overrides,
  } as unknown as MetaCampaignRow;
}

function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
  return {
    id: "adset_1",
    campaignId: "cmp_1",
    name: "Adset 1",
    status: "ACTIVE",
    spend: 400,
    purchases: 8,
    revenue: 1200,
    roas: 3,
    cpa: 50,
    ctr: 1.5,
    cpm: 10,
    impressions: 12000,
    clicks: 180,
    dailyBudget: 100,
    lifetimeBudget: null,
    optimizationGoal: "Purchase",
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    ...overrides,
  } as unknown as MetaAdSetData;
}

describe("Meta campaign role taxonomy", () => {
  it.each([
    ["promo_clearance", campaign({ name: "BFCM Clearance Sale" })],
    ["catalog_dpa", campaign({ name: "Catalog DPA Advantage Shopping" })],
    ["retargeting", campaign({ name: "Warm Retargeting ATC Visitors" })],
    ["existing_customer_ltv", campaign({ name: "CRM Existing Customer LTV" })],
    ["geo_expansion", campaign({ name: "International Geo Expansion" })],
  ] as const)("classifies %s from campaign signals", (expected, row) => {
    expect(inferCampaignRole(row)).toBe(expected);
  });

  it("reuses lane signals for scale and test prospecting roles", () => {
    const scaling = campaign({
      id: "cmp_scale",
      name: "Purchase Core Prospecting",
      purchases: 28,
      roas: 3.8,
      spend: 1800,
    });
    const test = campaign({
      id: "cmp_test",
      name: "Purchase New Angle",
      purchases: 2,
      roas: 0.6,
      spend: 200,
    });
    const campaigns = [scaling, test];

    expect(inferCampaignRole(scaling, { campaigns })).toBe("prospecting_scale");
    expect(inferCampaignRole(test, { campaigns })).toBe("prospecting_test");
  });

  it("falls back to prospecting_validation on ambiguous purchase campaigns", () => {
    expect(inferCampaignRole(campaign({ name: "Purchase Evergreen" }))).toBe(
      "prospecting_validation",
    );
  });
});

describe("Meta bid regime taxonomy", () => {
  it.each([
    ["open", "lowest_cost"],
    ["lowest_cost", "lowest_cost"],
    ["cost_cap", "cost_cap"],
    ["bid_cap", "bid_cap"],
    ["manual_bid", "bid_cap"],
    ["roas_floor", "minimum_roas"],
    ["target_roas", "minimum_roas"],
    ["experimental_strategy", "unknown"],
  ] as const)("normalizes %s to %s", (bidStrategyType, expected) => {
    expect(inferBidRegime(null, campaign({ bidStrategyType, bidStrategyLabel: null }))).toBe(
      expected,
    );
  });

  it("derives bid_cap from adset manual bid amount", () => {
    expect(inferBidRegime(adset({ manualBidAmount: 250 }), null)).toBe(
      "bid_cap",
    );
  });
});
