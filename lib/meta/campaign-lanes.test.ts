import { describe, expect, it } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import {
  buildMetaCampaignLaneSignals,
  buildMetaCampaignLaneSummary,
  comparableMetaIntentKey,
  metaCampaignLaneGroupKey,
  resolveMetaCampaignFamily,
} from "@/lib/meta/campaign-lanes";

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

describe("campaign lanes", () => {
  it("uses the shared funnel cohort resolver for campaign family classification", () => {
    expect(resolveMetaCampaignFamily(campaign({
      id: "lpv",
      objective: "OUTCOME_SALES",
      optimizationGoal: "LANDING_PAGE_VIEWS",
      purchases: 8,
      revenue: 1600,
    }))).toBe("awareness");

    expect(resolveMetaCampaignFamily(campaign({
      id: "catalog",
      optimizationGoal: "PRODUCT_CATALOG_SALES",
      customEventType: null,
    }))).toBe("purchase_value");

    expect(resolveMetaCampaignFamily(campaign({
      id: "metadata-missing",
      objective: null,
      optimizationGoal: null,
      customEventType: null,
      purchases: 2,
      revenue: 300,
    }))).toBe("purchase_value");
  });

  it("does not assign lanes to homogeneous mature families", () => {
    const rows = [
      campaign({ id: "a", name: "A", roas: 3.1, purchases: 22, spend: 1800 }),
      campaign({ id: "b", name: "B", roas: 3.2, purchases: 21, spend: 1750 }),
      campaign({ id: "c", name: "C", roas: 3.05, purchases: 20, spend: 1700 }),
    ];

    const signals = buildMetaCampaignLaneSignals(rows);
    expect(signals.size).toBe(0);
  });

  it("assigns scaling, validation, and test lanes when there is clear separation", () => {
    const rows = [
      campaign({ id: "scale", name: "Scale", roas: 4, purchases: 28, spend: 2400 }),
      campaign({ id: "validation", name: "Validation", roas: 2.2, purchases: 10, spend: 1700, revenue: 3740 }),
      campaign({ id: "test-a", name: "Test A", roas: 0.9, purchases: 3, spend: 600, revenue: 540 }),
      campaign({ id: "test-b", name: "Test B", roas: 1.1, purchases: 4, spend: 700, revenue: 770 }),
    ];

    const signals = buildMetaCampaignLaneSignals(rows);
    const summary = buildMetaCampaignLaneSummary(rows).get(
      metaCampaignLaneGroupKey(rows[0]),
    );

    expect(signals.get("scale")?.lane).toBe("Scaling");
    expect(signals.get("validation")?.lane).toBe("Validation");
    expect(signals.get("test-a")?.lane).toBe("Test");
    expect(summary?.eligibleForBudgetShift).toBe(true);
    expect(summary?.scalingCount).toBe(1);
    expect(summary?.validationCount).toBe(1);
    expect(summary?.testCount).toBe(2);
  });

  it("never creates lane separation across provider accounts", () => {
    const rows = [
      campaign({
        id: "account-a-winner",
        accountId: "act-a",
        roas: 5,
        purchases: 30,
        spend: 2500,
      }),
      campaign({
        id: "account-b-loser",
        accountId: "act-b",
        roas: 0.5,
        purchases: 1,
        spend: 500,
      }),
    ];

    expect(buildMetaCampaignLaneSignals(rows).size).toBe(0);
    expect(comparableMetaIntentKey(rows[0])).not.toBe(
      comparableMetaIntentKey(rows[1]),
    );
  });

  it("keeps currency and optimization cohort in the comparison key", () => {
    const base = campaign({ id: "base", accountId: "act-a" });
    expect(comparableMetaIntentKey(base)).not.toBe(
      comparableMetaIntentKey({ ...base, currency: "TRY" }),
    );
    expect(comparableMetaIntentKey(base)).not.toBe(
      comparableMetaIntentKey({
        ...base,
        optimizationGoal: "OFFSITE_CONVERSIONS",
      }),
    );
    expect(metaCampaignLaneGroupKey(base)).not.toBe(
      metaCampaignLaneGroupKey({
        ...base,
        optimizationGoal: "OFFSITE_CONVERSIONS",
      }),
    );
  });
});
