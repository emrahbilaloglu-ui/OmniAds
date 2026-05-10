import { describe, expect, it } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import { buildMetaEntityStateRows } from "@/lib/meta/engine-v1/state-rows";

function campaign(overrides: Partial<MetaCampaignRow> = {}): MetaCampaignRow {
  return {
    id: "cmp-1",
    accountId: "act-1",
    name: "Campaign 1",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    budgetLevel: "campaign",
    spend: 1000,
    purchases: 10,
    revenue: 3000,
    roas: 3,
    cpa: 100,
    ctr: 1.5,
    cpm: 20,
    cpc: 1,
    cpp: 1,
    impressions: 10000,
    reach: 8000,
    frequency: 1.2,
    clicks: 100,
    uniqueClicks: 90,
    uniqueCtr: 1.4,
    inlineLinkClickCtr: 1.3,
    outboundClicks: 80,
    outboundCtr: 1.2,
    uniqueOutboundClicks: 70,
    uniqueOutboundCtr: 1.1,
    landingPageViews: 60,
    costPerLandingPageView: 5,
    addToCart: 20,
    addToCartValue: 0,
    costPerAddToCart: 50,
    initiateCheckout: 10,
    initiateCheckoutValue: 0,
    costPerCheckoutInitiated: 100,
    leads: 0,
    leadsValue: 0,
    costPerLead: 0,
    registrationsCompleted: 0,
    registrationsCompletedValue: 0,
    costPerRegistrationCompleted: 0,
    searches: 0,
    searchesValue: 0,
    costPerSearch: 0,
    addPaymentInfo: 0,
    addPaymentInfoValue: 0,
    costPerAddPaymentInfo: 0,
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
    optimizationGoal: "OFFSITE_CONVERSIONS",
    customEventType: null,
    bidStrategyType: null,
    bidStrategyLabel: null,
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: null,
    bidValueFormat: null,
    previousBidValue: null,
    previousBidValueFormat: null,
    previousBidValueCapturedAt: null,
    dailyBudget: 100,
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

function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
  return {
    id: "adset-1",
    accountId: "act-1",
    name: "Adset 1",
    campaignId: "cmp-1",
    status: "ACTIVE",
    budgetLevel: "adset",
    dailyBudget: 50,
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
    spend: 100,
    purchases: 0,
    revenue: 0,
    roas: 0,
    cpa: 0,
    ctr: 1,
    cpm: 20,
    impressions: 10000,
    clicks: 100,
    ...overrides,
  };
}

function adsetState(input: {
  campaign?: Partial<MetaCampaignRow>;
  adset?: Partial<MetaAdSetData>;
}) {
  return buildMetaEntityStateRows({
    campaigns: [campaign(input.campaign)],
    adsets: [adset(input.adset)],
  }).find((row) => row.level === "adset");
}

describe("Meta Engine v1 state rows funnel cohort labels", () => {
  it("labels a THRUPLAY adset under an OUTCOME_SALES campaign as non_sales_eligible", () => {
    const row = adsetState({
      adset: { optimizationGoal: "THRUPLAY" },
    });

    expect(row?.decision).toBe("non_sales_eligible");
    expect(row?.decisionLabel).toBe("out_of_scope");
    expect(row?.evidence).toContainEqual({ label: "Cohort", value: "upper_funnel", tone: "neutral" });
  });

  it("labels an ADD_TO_CART custom-event adset as non_sales_eligible", () => {
    const row = adsetState({
      adset: {
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "ADD_TO_CART",
      },
    });

    expect(row?.decision).toBe("non_sales_eligible");
    expect(row?.evidence).toContainEqual({ label: "Cohort", value: "mid_funnel", tone: "neutral" });
  });

  it("keeps OFFSITE_CONVERSIONS with empty event on the purchase-path state", () => {
    const row = adsetState({
      adset: {
        optimizationGoal: "OFFSITE_CONVERSIONS",
        customEventType: "",
      },
    });

    expect(row?.decision).toBe("watch");
    expect(row?.decision).not.toBe("non_sales_eligible");
    expect(row?.evidence).toContainEqual({ label: "Cohort", value: "purchase", tone: "neutral" });
  });

  it("labels a LEAD_GENERATION optimization-goal adset as non_sales_eligible", () => {
    const row = adsetState({
      adset: { optimizationGoal: "LEAD_GENERATION" },
    });

    expect(row?.decision).toBe("non_sales_eligible");
    expect(row?.evidence).toContainEqual({ label: "Cohort", value: "lead", tone: "neutral" });
  });

  it("keeps a sales-campaign adset with unknown goal fields in watch instead of non_sales_eligible", () => {
    const row = adsetState({
      adset: {
        optimizationGoal: null,
        customEventType: null,
      },
    });

    expect(row?.decision).toBe("watch");
    expect(row?.decisionLabel).toBe("diagnose");
    expect(row?.targetValue).toMatchObject({ actionDensityEligible: true });
    expect(row?.evidence).toContainEqual({ label: "Cohort", value: "unknown", tone: "neutral" });
  });

  it("preserves out_of_scope when adset goal fields are null and campaign objective is non-sales", () => {
    const row = adsetState({
      campaign: {
        objective: "OUTCOME_AWARENESS",
        optimizationGoal: null,
      },
      adset: {
        optimizationGoal: null,
        customEventType: null,
      },
    });

    expect(row?.decision).toBe("out_of_scope");
    expect(row?.evidence).toContainEqual({ label: "Cohort", value: "unknown", tone: "neutral" });
  });
});
