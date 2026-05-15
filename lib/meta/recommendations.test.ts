import { describe, expect, it } from "vitest";
import {
  buildMetaRecommendations,
  calculateMetaStatisticalConfidence,
} from "@/lib/meta/recommendations";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import type { MetaCreativeIntelligenceSummary } from "@/lib/meta/creative-intelligence";

function campaign(overrides: Partial<MetaCampaignRow>): MetaCampaignRow {
  return {
    id: "cmp-1",
    accountId: "act-1",
    name: "Campaign 1",
    status: "ACTIVE",
    budgetLevel: "campaign",
    spend: 1000,
    purchases: 20,
    revenue: 3000,
    roas: 3,
    cpa: 50,
    ctr: 2,
    cpm: 10,
    cpc: 1,
    cpp: 1,
    impressions: 10000,
    reach: 8000,
    frequency: 1.2,
    clicks: 1000,
    uniqueClicks: 800,
    uniqueCtr: 1.8,
    inlineLinkClickCtr: 1.5,
    outboundClicks: 700,
    outboundCtr: 1.2,
    uniqueOutboundClicks: 600,
    uniqueOutboundCtr: 1.1,
    landingPageViews: 500,
    costPerLandingPageView: 2,
    addToCart: 100,
    addToCartValue: 4000,
    costPerAddToCart: 10,
    initiateCheckout: 60,
    initiateCheckoutValue: 2200,
    costPerCheckoutInitiated: 17,
    leads: 10,
    leadsValue: 0,
    costPerLead: 100,
    registrationsCompleted: 0,
    registrationsCompletedValue: 0,
    costPerRegistrationCompleted: 0,
    searches: 0,
    searchesValue: 0,
    costPerSearch: 0,
    addPaymentInfo: 30,
    addPaymentInfoValue: 1200,
    costPerAddPaymentInfo: 33,
    pageLikes: 0,
    costPerPageLike: 0,
    postEngagement: 0,
    costPerEngagement: 0,
    postReactions: 0,
    costPerReaction: 0,
    postComments: 0,
    costPerPostComment: 0,
    postShares: 0,
    costPerPostShare: 0,
    messagingConversationsStarted: 0,
    costPerMessagingConversationStarted: 0,
    appInstalls: 0,
    costPerAppInstall: 0,
    contentViews: 0,
    contentViewsValue: 0,
    costPerContentView: 0,
    videoViews3s: 0,
    videoViews15s: 0,
    videoViews25: 0,
    videoViews50: 0,
    videoViews75: 0,
    videoViews95: 0,
    videoViews100: 0,
    costPerVideoView: 0,
    currency: "USD",
    objective: "OUTCOME_SALES",
    optimizationGoal: "Purchase",
    bidStrategyType: "lowest_cost",
    bidStrategyLabel: "Lowest Cost",
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    previousBidValue: null,
    previousBidValueFormat: null,
    previousBidValueCapturedAt: null,
    dailyBudget: 10000,
    lifetimeBudget: null,
    previousDailyBudget: null,
    previousLifetimeBudget: null,
    previousBudgetCapturedAt: null,
    isBudgetMixed: false,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    ...overrides,
  };
}

const breakdowns: MetaBreakdownsResponse = {
  status: "ok",
  age: [],
  location: [],
  placement: [],
  budget: { campaign: [], adset: [] },
  audience: { available: true },
  products: { available: true },
};

const creativeIntelligence: MetaCreativeIntelligenceSummary = {
  totalCreatives: 8,
  winnerCount: 3,
  provenWinnerCount: 2,
  stableScalingCount: 2,
  emergingScalingCount: 1,
  testOnlyCount: 3,
  fatiguedCount: 1,
  blockedCount: 1,
  lowConfidenceCount: 3,
  weakCount: 2,
  topWinnerNames: ["UGC Winner 1", "UGC Winner 2"],
  topStableWinnerNames: ["UGC Winner 1", "UGC Winner 2"],
  topEmergingScalingNames: ["UGC Winner 3"],
  topTestOnlyNames: ["Concept Test 1", "Concept Test 2"],
  topFatiguedNames: ["Aging Angle 1"],
  topBlockedNames: ["Blocked Angle 1"],
  scalingReadyNames: ["UGC Winner 1", "UGC Winner 2", "UGC Winner 3"],
  keepTestingNames: ["Concept Test 1", "Concept Test 2", "Concept Test 3"],
  doNotDeployNames: ["Blocked Angle 1"],
  byCampaignId: {
    "prod-a": {
      campaignId: "prod-a",
      campaignName: "Purchase Winner",
      creativeCount: 3,
      winnerCount: 2,
      provenWinnerCount: 2,
      stableScalingCount: 2,
      emergingScalingCount: 0,
      testOnlyCount: 0,
      fatiguedCount: 0,
      blockedCount: 0,
      lowConfidenceCount: 0,
      weakCount: 0,
      topWinnerNames: ["UGC Winner 1", "UGC Winner 2"],
      topStableWinnerNames: ["UGC Winner 1", "UGC Winner 2"],
      topTestOnlyNames: [],
      topEmergingScalingNames: [],
      topFatiguedNames: [],
      topBlockedNames: [],
      scalingReadyNames: ["UGC Winner 1", "UGC Winner 2"],
      keepTestingNames: [],
      doNotDeployNames: [],
    },
    "test-a": {
      campaignId: "test-a",
      campaignName: "Purchase Exploration 1",
      creativeCount: 3,
      winnerCount: 0,
      provenWinnerCount: 0,
      stableScalingCount: 0,
      emergingScalingCount: 0,
      testOnlyCount: 2,
      fatiguedCount: 0,
      blockedCount: 1,
      lowConfidenceCount: 2,
      weakCount: 1,
      topWinnerNames: [],
      topStableWinnerNames: [],
      topTestOnlyNames: ["Concept Test 1", "Concept Test 2"],
      topEmergingScalingNames: [],
      topFatiguedNames: [],
      topBlockedNames: ["Blocked Angle 1"],
      scalingReadyNames: [],
      keepTestingNames: ["Concept Test 1", "Concept Test 2"],
      doNotDeployNames: ["Blocked Angle 1"],
    },
    "test-b": {
      campaignId: "test-b",
      campaignName: "Purchase Exploration 2",
      creativeCount: 2,
      winnerCount: 0,
      provenWinnerCount: 0,
      stableScalingCount: 0,
      emergingScalingCount: 0,
      testOnlyCount: 1,
      fatiguedCount: 1,
      blockedCount: 0,
      lowConfidenceCount: 1,
      weakCount: 1,
      topWinnerNames: [],
      topStableWinnerNames: [],
      topTestOnlyNames: ["Concept Test 3"],
      topEmergingScalingNames: [],
      topFatiguedNames: ["Aging Angle 1"],
      topBlockedNames: [],
      scalingReadyNames: [],
      keepTestingNames: ["Concept Test 3"],
      doNotDeployNames: [],
    },
  },
  byFamily: {
    purchase_value: {
      familyKey: "purchase_value",
      familyLabel: "purchase/value",
      creativeCount: 8,
      winnerCount: 3,
      provenWinnerCount: 2,
      stableScalingCount: 2,
      emergingScalingCount: 1,
      testOnlyCount: 3,
      fatiguedCount: 1,
      blockedCount: 1,
      lowConfidenceCount: 3,
      weakCount: 2,
      topWinnerNames: ["UGC Winner 1", "UGC Winner 2", "UGC Winner 3"],
      topStableWinnerNames: ["UGC Winner 1", "UGC Winner 2"],
      topTestOnlyNames: ["Concept Test 1", "Concept Test 2", "Concept Test 3"],
      topEmergingScalingNames: ["UGC Winner 3"],
      topFatiguedNames: ["Aging Angle 1"],
      topBlockedNames: ["Blocked Angle 1"],
      scalingReadyNames: ["UGC Winner 1", "UGC Winner 2", "UGC Winner 3"],
      keepTestingNames: ["Concept Test 1", "Concept Test 2", "Concept Test 3"],
      doNotDeployNames: ["Blocked Angle 1"],
    },
  },
};

describe("buildMetaRecommendations", () => {
  it("calculates statistical confidence from sample and magnitude factors", () => {
    expect(
      calculateMetaStatisticalConfidence({
        level: "campaign",
        metricValue: 3,
        threshold: 2,
        sampleSize: 4,
        minRequiredSample: 8,
      }),
    ).toEqual({
      score: 0.7,
      label: "high",
    });
  });

  it("caps immature campaign confidence with a thin-data watch reason", () => {
    expect(
      calculateMetaStatisticalConfidence({
        level: "campaign",
        metricValue: 3,
        threshold: 2,
        sampleSize: 8,
        minRequiredSample: 8,
        ageDays: 3,
      }),
    ).toEqual({
      score: 0.4,
      label: "low",
      reason: "thin_data_watching",
    });
  });

  it("floors severe loser confidence so high-spend losers surface", () => {
    expect(
      calculateMetaStatisticalConfidence({
        level: "campaign",
        metricValue: 0.5,
        threshold: 1.5,
        sampleSize: 1,
        minRequiredSample: 8,
        severeLoser: true,
      }),
    ).toEqual({
      score: 0.7,
      label: "high",
      reason: "severe_loser_bypass",
    });
  });

  it("returns test instead of act when selected signal is strong but historical support is weak", () => {
    const selected = campaign({ roas: 3.2, purchases: 24, spend: 1200 });
    const weak30 = campaign({ roas: 2.95, purchases: 18, spend: 1180 });
    const weak90 = campaign({ roas: 1.4, purchases: 9, spend: 1000 });

    const result = buildMetaRecommendations({
      windows: {
        selected: [selected],
        previousSelected: [],
        last3: [selected],
        last7: [selected],
        last14: [weak30],
        last30: [weak30],
        last90: [weak90],
        allHistory: [weak90],
      },
      breakdowns,
    });

    const rec = result.recommendations.find((item) => item.type === "scale_for_volume");
    expect(rec?.decisionState).toBe("test");
  });

  it("returns act for scale when selected and historical windows all support it", () => {
    const strong = campaign({ roas: 3.6, purchases: 32, spend: 1800 });

    const result = buildMetaRecommendations({
      windows: {
        selected: [strong],
        previousSelected: [],
        last3: [strong],
        last7: [strong],
        last14: [campaign({ roas: 3.35, purchases: 29, spend: 1720 })],
        last30: [campaign({ roas: 3.3, purchases: 28, spend: 1700 })],
        last90: [campaign({ roas: 3.1, purchases: 26, spend: 1650 })],
        allHistory: [campaign({ roas: 3.05, purchases: 25, spend: 1600 })],
      },
      breakdowns,
    });

    const rec = result.recommendations.find((item) => item.type === "scale_for_volume");
    expect(rec?.decisionState).toBe("act");
  });

  it("produces profitability recommendation for weak high-spend campaign", () => {
    const weak = campaign({ roas: 1.2, purchases: 18, spend: 3000, revenue: 3600, cpa: 166.67 });
    const strongPeer = campaign({ id: "cmp-2", name: "Campaign 2", roas: 3.4, purchases: 35, spend: 2000, revenue: 6800, cpa: 57.14 });

    const result = buildMetaRecommendations({
      windows: {
        selected: [weak, strongPeer],
        previousSelected: [],
        last3: [weak, strongPeer],
        last7: [weak, strongPeer],
        last14: [campaign({ roas: 1.28, purchases: 19, spend: 2925, revenue: 3740, cpa: 154 }), strongPeer],
        last30: [campaign({ roas: 1.3, purchases: 20, spend: 2900, revenue: 3770, cpa: 145 }), strongPeer],
        last90: [campaign({ roas: 1.35, purchases: 19, spend: 2800, revenue: 3780, cpa: 147 }), strongPeer],
        allHistory: [campaign({ roas: 1.4, purchases: 21, spend: 2750, revenue: 3850, cpa: 131 }), strongPeer],
      },
      breakdowns,
    });

    expect(result.recommendations.some((item) => item.type === "scale_for_profitability")).toBe(true);
  });

  it("does not produce insights for add to cart campaigns because recommendations are purchase-only", () => {
    const row = campaign({ optimizationGoal: "Add To Cart", purchases: 28, roas: 2.9 });
    const result = buildMetaRecommendations({
      windows: {
        selected: [row],
        previousSelected: [],
        last3: [row],
        last7: [row],
        last14: [campaign({ optimizationGoal: "Add To Cart", purchases: 25, roas: 2.6 })],
        last30: [campaign({ optimizationGoal: "Add To Cart", purchases: 26, roas: 2.7 })],
        last90: [campaign({ optimizationGoal: "Add To Cart", purchases: 24, roas: 2.5 })],
        allHistory: [campaign({ optimizationGoal: "Add To Cart", purchases: 23, roas: 2.4 })],
      },
      breakdowns,
    });

    expect(result.recommendations).toHaveLength(0);
    expect(result.summary.title).toContain("No purchase-focused");
  });

  it("treats revenue-bearing campaigns as eligible when objective metadata is missing", () => {
    const row = campaign({
      objective: null,
      optimizationGoal: null,
      purchases: 12,
      revenue: 1800,
      roas: 2.4,
    });
    const result = buildMetaRecommendations({
      windows: {
        selected: [row],
        previousSelected: [campaign({ objective: null, optimizationGoal: null, purchases: 10, revenue: 1200, roas: 2.1 })],
        last3: [row],
        last7: [row],
        last14: [campaign({ objective: null, optimizationGoal: null, purchases: 10, revenue: 1500, roas: 2.2 })],
        last30: [campaign({ objective: null, optimizationGoal: null, purchases: 9, revenue: 1400, roas: 2.0 })],
        last90: [campaign({ objective: null, optimizationGoal: null, purchases: 8, revenue: 1300, roas: 1.9 })],
        allHistory: [campaign({ objective: null, optimizationGoal: null, purchases: 11, revenue: 1600, roas: 2.1 })],
      },
      breakdowns,
    });

    expect(result.summary.recommendationCount).toBeGreaterThan(0);
    expect(result.recommendations.length).toBeGreaterThan(0);
  });

  it("flags seasonality when selected period diverges sharply from history", () => {
    const selected = campaign({ roas: 5.5, purchases: 40, spend: 3500, revenue: 19250 });
    const baseline = campaign({ roas: 2, purchases: 20, spend: 1400, revenue: 2800 });

    const result = buildMetaRecommendations({
      windows: {
        selected: [selected],
        previousSelected: [],
        last3: [selected],
        last7: [selected],
        last14: [baseline],
        last30: [baseline],
        last90: [baseline],
        allHistory: [baseline],
      },
      breakdowns,
    });

    expect(result.recommendations[0]?.timeframeContext.seasonalityFlag).not.toBe("none");
  });

  it("includes a suggested bid range for manual bid recommendations using historical AOV and ROAS", () => {
    const row = campaign({
      bidStrategyType: "manual_bid",
      bidStrategyLabel: "Manual Bid",
      bidValue: 1800,
      bidValueFormat: "currency",
      roas: 3.4,
      revenue: 6800,
      purchases: 40,
      spend: 2000,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [row],
        previousSelected: [],
        last3: [row],
        last7: [row],
        last14: [campaign({ revenue: 7800, purchases: 52, roas: 3.1, spend: 2516 })],
        last30: [campaign({ revenue: 7500, purchases: 50, roas: 3, spend: 2500 })],
        last90: [campaign({ revenue: 8400, purchases: 56, roas: 3.2, spend: 2625 })],
        allHistory: [campaign({ revenue: 9000, purchases: 60, roas: 3, spend: 3000 })],
      },
      breakdowns,
    });

    const rec = result.recommendations.find((item) => item.type === "bid_strategy_fit");
    expect(rec?.recommendedAction).toContain("reference bid range");
    expect(rec?.evidence.some((item) => item.label === "Suggested bid range")).toBe(true);
  });

  it("still produces target roas guidance when current target value is missing", () => {
    const row = campaign({
      bidStrategyType: "target_roas",
      bidStrategyLabel: "Target ROAS",
      bidValue: null,
      bidValueFormat: null,
      roas: 2.4,
      revenue: 4800,
      purchases: 30,
      spend: 2000,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [row],
        previousSelected: [],
        last3: [row],
        last7: [campaign({ roas: 2.2, revenue: 4400, purchases: 28, spend: 2000 })],
        last14: [campaign({ roas: 2.3, revenue: 4600, purchases: 29, spend: 2000 })],
        last30: [campaign({ roas: 2.5, revenue: 5000, purchases: 31, spend: 2000 })],
        last90: [campaign({ roas: 2.6, revenue: 5200, purchases: 32, spend: 2000 })],
        allHistory: [campaign({ roas: 2.45, revenue: 4900, purchases: 30, spend: 2000 })],
      },
      breakdowns,
    });

    const rec = result.recommendations.find((item) => item.type === "bid_value_guidance");
    expect(rec?.evidence.some((item) => item.label === "Suggested target range")).toBe(true);
  });

  it("does not suggest budget reallocation across incompatible optimization groups", () => {
    const thruplay = campaign({
      id: "cmp-thru",
      name: "ThruPlay Campaign",
      objective: "OUTCOME_AWARENESS",
      optimizationGoal: "ThruPlay",
      roas: 0.2,
      purchases: 0,
      revenue: 0,
      spend: 1200,
      cpa: 0,
    });
    const addToCart = campaign({
      id: "cmp-atc",
      name: "ATC Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "Add To Cart",
      roas: 1.8,
      purchases: 8,
      revenue: 1800,
      spend: 1000,
      cpa: 125,
    });
    const purchase = campaign({
      id: "cmp-purchase",
      name: "Purchase Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "Purchase",
      roas: 3.2,
      purchases: 22,
      revenue: 6400,
      spend: 2000,
      cpa: 90.91,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [thruplay, addToCart, purchase],
        previousSelected: [],
        last3: [thruplay, addToCart, purchase],
        last7: [thruplay, addToCart, purchase],
        last14: [thruplay, addToCart, purchase],
        last30: [thruplay, addToCart, purchase],
        last90: [thruplay, addToCart, purchase],
        allHistory: [thruplay, addToCart, purchase],
      },
      breakdowns,
    });

    expect(result.recommendations.some((item) => item.type === "budget_allocation")).toBe(false);
  });

  it("does not merge add to cart and purchase campaigns into the same comparison cohort even if objective matches", () => {
    const addToCart = campaign({
      id: "cmp-atc-2",
      name: "ATC Sales Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "Add To Cart",
      roas: 0.9,
      purchases: 4,
      revenue: 900,
      spend: 1000,
      cpa: 250,
    });
    const purchase = campaign({
      id: "cmp-purchase-2",
      name: "Purchase Sales Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "Purchase",
      roas: 2.8,
      purchases: 18,
      revenue: 5600,
      spend: 2000,
      cpa: 111.11,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [addToCart, purchase],
        previousSelected: [],
        last3: [addToCart, purchase],
        last7: [addToCart, purchase],
        last14: [addToCart, purchase],
        last30: [addToCart, purchase],
        last90: [addToCart, purchase],
        allHistory: [addToCart, purchase],
      },
      breakdowns,
    });

    expect(result.recommendations.some((item) => item.type === "budget_allocation")).toBe(false);
  });

  it("keeps offsite conversions with purchase event in the purchase recommendation window", () => {
    const offsitePurchase = campaign({
      id: "cmp-offsite-purchase",
      name: "Offsite Purchase Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: "PURCHASE",
      roas: 2.4,
      purchases: 12,
      revenue: 2400,
      spend: 1000,
      cpa: 83.33,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [offsitePurchase],
        previousSelected: [],
        last3: [offsitePurchase],
        last7: [offsitePurchase],
        last14: [offsitePurchase],
        last30: [offsitePurchase],
        last90: [offsitePurchase],
        allHistory: [offsitePurchase],
      },
      breakdowns,
    });

    expect(result.summary.title).not.toBe("No purchase-focused Meta insight");
  });

  it("keeps product catalog sales in the purchase recommendation window", () => {
    const catalogSales = campaign({
      id: "cmp-catalog-sales",
      name: "Catalog Sales Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "PRODUCT_CATALOG_SALES",
      customEventType: null,
      roas: 3.1,
      purchases: 16,
      revenue: 3100,
      spend: 1000,
      cpa: 62.5,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [catalogSales],
        previousSelected: [],
        last3: [catalogSales],
        last7: [catalogSales],
        last14: [catalogSales],
        last30: [catalogSales],
        last90: [catalogSales],
        allHistory: [catalogSales],
      },
      breakdowns,
    });

    expect(result.summary.title).not.toBe("No purchase-focused Meta insight");
  });

  it("keeps landing-page-view campaigns out of the purchase recommendation window even with sales metrics", () => {
    const traffic = campaign({
      id: "cmp-lpv",
      name: "LPV Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "LANDING_PAGE_VIEWS",
      customEventType: null,
      roas: 2.1,
      purchases: 8,
      revenue: 2100,
      spend: 1000,
      cpa: 125,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [traffic],
        previousSelected: [],
        last3: [traffic],
        last7: [traffic],
        last14: [traffic],
        last30: [traffic],
        last90: [traffic],
        allHistory: [traffic],
      },
      breakdowns,
    });

    expect(result.summary.title).toBe("No purchase-focused Meta insight");
  });

  it("produces historical bid regime and rebuild recommendations when current open bidding conflicts with constrained history", () => {
    const row = campaign({
      id: "cmp-rebuild",
      name: "Ramadan Sales Campaign",
      objective: "OUTCOME_SALES",
      optimizationGoal: "Purchase",
      bidStrategyType: "lowest_cost",
      bidStrategyLabel: "Lowest Cost",
      roas: 1.35,
      revenue: 4050,
      purchases: 24,
      spend: 3000,
      cpa: 125,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [row],
        previousSelected: [],
        last3: [campaign({ id: "cmp-rebuild", roas: 1.3, revenue: 3900, purchases: 23, spend: 3000 })],
        last7: [campaign({ id: "cmp-rebuild", roas: 1.4, revenue: 4200, purchases: 25, spend: 3000 })],
        last14: [campaign({ id: "cmp-rebuild", roas: 1.55, revenue: 4650, purchases: 27, spend: 3000 })],
        last30: [campaign({ id: "cmp-rebuild", roas: 1.8, revenue: 5400, purchases: 31, spend: 3000 })],
        last90: [campaign({ id: "cmp-rebuild", roas: 2.1, revenue: 6300, purchases: 36, spend: 3000 })],
        allHistory: [campaign({ id: "cmp-rebuild", roas: 2.2, revenue: 6600, purchases: 38, spend: 3000 })],
      },
      breakdowns,
      historicalBidRegimes: {
        "cmp-rebuild": {
          dominantBidStrategyType: "bid_cap",
          dominantBidStrategyLabel: "Bid Cap",
          observationCount: 8,
          constrainedShare: 0.88,
          openShare: 0.12,
        },
      },
    });

    expect(result.recommendations.some((item) => item.type === "historical_bid_regime_fit")).toBe(true);
    expect(result.recommendations.some((item) => item.type === "rebuild_with_constraints")).toBe(true);
    const rebuild = result.recommendations.find((item) => item.type === "rebuild_with_constraints");
    expect(rebuild?.title).toContain("Bid Cap");
    expect(rebuild?.rebuildReason).toContain("Bid Cap");
    expect(result.summary.operatingMode).toContain("reset");
    expect(result.summary.recommendedMode).toContain("Bid Cap");
  });

  it("produces bid band recommendation from historical windows", () => {
    const row = campaign({
      id: "cmp-band",
      objective: "OUTCOME_SALES",
      optimizationGoal: "Purchase",
      roas: 2.4,
      revenue: 4800,
      purchases: 30,
      spend: 2000,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [row],
        previousSelected: [],
        last3: [row],
        last7: [campaign({ id: "cmp-band", revenue: 4200, purchases: 28, roas: 2.1, spend: 2000 })],
        last14: [campaign({ id: "cmp-band", revenue: 5200, purchases: 34, roas: 2.6, spend: 2000 })],
        last30: [campaign({ id: "cmp-band", revenue: 5000, purchases: 32, roas: 2.5, spend: 2000 })],
        last90: [campaign({ id: "cmp-band", revenue: 5400, purchases: 35, roas: 2.7, spend: 2000 })],
        allHistory: [campaign({ id: "cmp-band", revenue: 5600, purchases: 36, roas: 2.8, spend: 2000 })],
      },
      breakdowns,
    });

    const rec = result.recommendations.find((item) => item.type === "bid_band_from_history");
    expect(rec?.defensiveBidBand).toBeTruthy();
    expect(rec?.scaleBidBand).toBeTruthy();
  });

  it("produces geo clustering recommendation when secondary markets have thin signal", () => {
    const localBreakdowns: MetaBreakdownsResponse = {
      ...breakdowns,
      location: [
        { key: "sa", label: "Saudi Arabia", spend: 4000, purchases: 24, revenue: 9200, clicks: 0, impressions: 0 },
        { key: "ae", label: "United Arab Emirates", spend: 2600, purchases: 13, revenue: 5200, clicks: 0, impressions: 0 },
        { key: "de", label: "Germany", spend: 800, purchases: 1, revenue: 260, clicks: 0, impressions: 0 },
        { key: "fr", label: "France", spend: 700, purchases: 1, revenue: 210, clicks: 0, impressions: 0 },
        { key: "nl", label: "Netherlands", spend: 600, purchases: 0, revenue: 0, clicks: 0, impressions: 0 },
        { key: "be", label: "Belgium", spend: 500, purchases: 1, revenue: 180, clicks: 0, impressions: 0 },
      ],
    };

    const result = buildMetaRecommendations({
      windows: {
        selected: [
          campaign({ id: "prod-1", name: "Purchase Prod 1", purchases: 24, roas: 2.8, spend: 2500 }),
          campaign({ id: "prod-2", name: "Purchase Prod 2", purchases: 7, roas: 1.6, spend: 900 }),
          campaign({ id: "prod-3", name: "Purchase Prod 3", purchases: 5, roas: 1.4, spend: 700 }),
        ],
        previousSelected: [],
        last3: [],
        last7: [],
        last14: [],
        last30: [],
        last90: [],
        allHistory: [],
      },
      breakdowns: localBreakdowns,
      creativeIntelligence,
    });

    const geo = result.recommendations.find((item) => item.type === "geo_cluster_for_signal_density");
    expect(geo).toBeTruthy();
    expect(geo?.scalingGeoCluster).toContain("Saudi Arabia");
    expect(geo?.testingGeoCluster).toContain("Germany");
    expect(geo?.matureGeoSplit).toContain("Saudi Arabia");
    expect(geo?.keepTestingCreatives).toContain("Concept Test 1");
  });

  it("produces scaling-vs-test structure guidance when strong and low-signal campaigns coexist", () => {
    const selectedRows = [
      campaign({ id: "prod-a", name: "Purchase Winner", purchases: 24, roas: 3.1, spend: 2200 }),
      campaign({ id: "prod-b", name: "Purchase Stable", purchases: 18, roas: 2.7, spend: 1800 }),
      campaign({ id: "test-a", name: "Purchase Exploration 1", purchases: 4, roas: 1.3, spend: 700 }),
      campaign({ id: "test-b", name: "Purchase Exploration 2", purchases: 3, roas: 1.1, spend: 650 }),
    ];

    const result = buildMetaRecommendations({
      windows: {
        selected: selectedRows,
        previousSelected: [],
        last3: selectedRows,
        last7: selectedRows,
        last14: selectedRows,
        last30: selectedRows,
        last90: selectedRows,
        allHistory: selectedRows,
      },
      breakdowns,
      creativeIntelligence,
    });

    expect(result.recommendations.some((item) => item.type === "scaling_structure_fit")).toBe(true);
    expect(result.recommendations.some((item) => item.type === "creative_test_structure")).toBe(true);
    expect(result.recommendations.some((item) => item.type === "winner_promotion_flow")).toBe(true);
    expect(result.recommendations.find((item) => item.type === "winner_promotion_flow")?.recommendedAction).toContain("UGC Winner 1");
    expect(result.recommendations.find((item) => item.type === "scaling_structure_fit")?.recommendedAction).toContain("UGC Winner 1");
    expect(result.recommendations.find((item) => item.type === "winner_promotion_flow")?.promoteCreatives).toContain("UGC Winner 1");
    expect(result.recommendations.find((item) => item.type === "creative_test_structure")?.keepTestingCreatives).toContain("Concept Test 1");
    expect(result.recommendations.find((item) => item.type === "creative_test_structure")?.doNotDeployCreatives).toContain("Blocked Angle 1");
  });

  it("excludes test lanes from budget transfer recommendations", () => {
    const selectedRows = [
      campaign({ id: "winner-a", name: "Purchase Winner", purchases: 28, roas: 3.2, spend: 2400 }),
      campaign({ id: "stable-a", name: "Purchase Stable", purchases: 18, roas: 2.6, spend: 1800 }),
      campaign({ id: "validation-a", name: "Purchase Validation", purchases: 9, roas: 2.05, spend: 1500 }),
      campaign({ id: "test-a", name: "Purchase Exploration", purchases: 3, roas: 0.9, spend: 600 }),
    ];

    const result = buildMetaRecommendations({
      windows: {
        selected: selectedRows,
        previousSelected: [],
        last3: selectedRows,
        last7: selectedRows,
        last14: selectedRows,
        last30: selectedRows,
        last90: selectedRows,
        allHistory: selectedRows,
      },
      breakdowns,
      creativeIntelligence,
    });

    const budgetShift = result.recommendations.find((item) => item.type === "budget_allocation");
    expect(budgetShift).toBeTruthy();
    expect(budgetShift?.recommendedAction).not.toContain("Purchase Exploration");
    expect(budgetShift?.evidence.some((item) => item.label === "Lane filter" && item.value === "Scaling + validation only")).toBe(true);
  });

  it("moves budget from validation lanes into scaling lanes", () => {
    const selectedRows = [
      campaign({ id: "scale-a", name: "Purchase Scale A", purchases: 30, roas: 3.9, spend: 2400, revenue: 9360 }),
      campaign({ id: "scale-b", name: "Purchase Scale B", purchases: 21, roas: 3.05, spend: 1900, revenue: 5795 }),
      campaign({ id: "validation-a", name: "Purchase Validation", purchases: 11, roas: 2.3, spend: 2100, revenue: 4830, cpa: 190.91 }),
      campaign({ id: "test-a", name: "Purchase Test", purchases: 2, roas: 0.8, spend: 500, revenue: 400 }),
    ];

    const result = buildMetaRecommendations({
      windows: {
        selected: selectedRows,
        previousSelected: [],
        last3: selectedRows,
        last7: selectedRows,
        last14: selectedRows,
        last30: selectedRows,
        last90: selectedRows,
        allHistory: selectedRows,
      },
      breakdowns,
      creativeIntelligence,
    });

    const budgetShift = result.recommendations.find((item) => item.type === "budget_allocation");
    expect(budgetShift).toBeTruthy();
    expect(budgetShift?.recommendedAction).toContain("Purchase Validation");
    expect(budgetShift?.recommendedAction).toContain("Purchase Scale A");
    expect(budgetShift?.evidence.some((item) => item.label === "Lane mix")).toBe(true);
  });

  it("still produces creative deployment recommendations when there is only one clear scaling lane", () => {
    const selectedRows = [
      campaign({ id: "solo-scale", name: "Solo Purchase Scale", purchases: 18, roas: 2.9, spend: 1800, revenue: 5220 }),
      campaign({
        id: "awareness-side",
        name: "Awareness Side Campaign",
        objective: "OUTCOME_AWARENESS",
        optimizationGoal: "Reach",
        purchases: 0,
        roas: 0,
        spend: 400,
        revenue: 0,
        cpa: 0,
      }),
    ];

    const result = buildMetaRecommendations({
      windows: {
        selected: selectedRows,
        previousSelected: [],
        last3: selectedRows,
        last7: selectedRows,
        last14: selectedRows,
        last30: selectedRows,
        last90: selectedRows,
        allHistory: selectedRows,
      },
      breakdowns,
      creativeIntelligence,
    });

    const winnerPromotion = result.recommendations.find((item) => item.type === "winner_promotion_flow");
    const testStructure = result.recommendations.find((item) => item.type === "creative_test_structure");
    expect(winnerPromotion?.promoteCreatives).toContain("UGC Winner 1");
    expect(winnerPromotion?.targetScalingLane).toBe("Solo Purchase Scale");
    expect(testStructure?.keepTestingCreatives).toContain("Concept Test 1");
    expect(testStructure?.doNotDeployCreatives).toContain("Blocked Angle 1");
  });

  it("returns no insights when there are no purchase/value campaigns", () => {
    const rows = [
      campaign({
        id: "reach-only",
        name: "Reach Only",
        objective: "OUTCOME_AWARENESS",
        optimizationGoal: "Reach",
        purchases: 0,
        roas: 0,
        spend: 500,
        revenue: 0,
        cpa: 0,
      }),
      campaign({
        id: "thruplay-only",
        name: "ThruPlay Only",
        objective: "OUTCOME_AWARENESS",
        optimizationGoal: "ThruPlay",
        purchases: 0,
        roas: 0,
        spend: 700,
        revenue: 0,
        cpa: 0,
      }),
    ];

    const result = buildMetaRecommendations({
      windows: {
        selected: rows,
        previousSelected: [],
        last3: rows,
        last7: rows,
        last14: rows,
        last30: rows,
        last90: rows,
        allHistory: rows,
      },
      breakdowns,
      creativeIntelligence,
    });

    expect(result.recommendations).toHaveLength(0);
    expect(result.summary.title).toContain("No purchase-focused");
  });

  it("ignores non-purchase campaigns when purchase campaigns are present", () => {
    const purchase = campaign({
      id: "purchase-core",
      name: "Purchase Core",
      objective: "OUTCOME_SALES",
      optimizationGoal: "Purchase",
      purchases: 18,
      roas: 2.9,
      spend: 1800,
      revenue: 5220,
    });
    const reach = campaign({
      id: "reach-side",
      name: "Reach Side",
      objective: "OUTCOME_AWARENESS",
      optimizationGoal: "Reach",
      purchases: 0,
      roas: 0,
      spend: 900,
      revenue: 0,
      cpa: 0,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [purchase, reach],
        previousSelected: [],
        last3: [purchase, reach],
        last7: [purchase, reach],
        last14: [purchase, reach],
        last30: [purchase, reach],
        last90: [purchase, reach],
        allHistory: [purchase, reach],
      },
      breakdowns,
      creativeIntelligence,
    });

    expect(result.recommendations.every((item) => item.comparisonCohort !== "Reach")).toBe(true);
    expect(result.summary.title).not.toContain("No purchase-focused");
  });

  it("populates campaign role and bid regime taxonomy fields on campaign recommendations", () => {
    const row = campaign({
      id: "promo-target-roas",
      name: "Promo Clearance Sale",
      bidStrategyType: "target_roas",
      bidStrategyLabel: "Target ROAS",
      bidValue: null,
      bidValueFormat: null,
      roas: 2.6,
      revenue: 5200,
      purchases: 32,
      spend: 2000,
    });

    const result = buildMetaRecommendations({
      windows: {
        selected: [row],
        previousSelected: [],
        last3: [row],
        last7: [row],
        last14: [campaign({ id: "promo-14", name: row.name, roas: 2.5, revenue: 5000, purchases: 31, spend: 2000 })],
        last30: [campaign({ id: "promo-30", name: row.name, roas: 2.4, revenue: 4800, purchases: 30, spend: 2000 })],
        last90: [campaign({ id: "promo-90", name: row.name, roas: 2.7, revenue: 5400, purchases: 33, spend: 2000 })],
        allHistory: [campaign({ id: "promo-history", name: row.name, roas: 2.55, revenue: 5100, purchases: 32, spend: 2000 })],
      },
      breakdowns,
    });

    const rec = result.recommendations.find(
      (item) => item.type === "bid_value_guidance",
    );
    expect(rec?.campaignRole).toBe("promo_clearance");
    expect(rec?.bidRegime).toBe("minimum_roas");
  });
});
