import { describe, expect, it } from "vitest";
import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import {
  maybeAdsetAudienceExpansion,
  maybeAdsetAudienceSwap,
  maybeAdsetBidCapAdjust,
  maybeAdsetBudgetShiftWithinCampaign,
  maybeAdsetOptimizationEventSwitch,
  maybeAdsetPauseUnderperformer,
  type MetaAdsetDecisionAccountContext,
} from "@/lib/meta/adset-decisions";

function campaign(overrides: Partial<MetaCampaignRow> = {}): MetaCampaignRow {
  return {
    id: "cmp-1",
    accountId: "act-1",
    name: "Campaign 1",
    status: "ACTIVE",
    budgetLevel: "adset",
    spend: 1000,
    purchases: 40,
    revenue: 3200,
    roas: 3.2,
    cpa: 25,
    ctr: 2,
    cpm: 12,
    cpc: 1,
    cpp: 1,
    impressions: 80000,
    reach: 60000,
    frequency: 1.3,
    clicks: 1600,
    uniqueClicks: 1200,
    uniqueCtr: 1.8,
    inlineLinkClickCtr: 1.5,
    outboundClicks: 1000,
    outboundCtr: 1.2,
    uniqueOutboundClicks: 800,
    uniqueOutboundCtr: 1.1,
    landingPageViews: 700,
    costPerLandingPageView: 2,
    addToCart: 100,
    addToCartValue: 4000,
    costPerAddToCart: 10,
    initiateCheckout: 60,
    initiateCheckoutValue: 2000,
    costPerCheckoutInitiated: 15,
    leads: 0,
    leadsValue: 0,
    costPerLead: 0,
    registrationsCompleted: 0,
    registrationsCompletedValue: 0,
    costPerRegistrationCompleted: 0,
    searches: 0,
    searchesValue: 0,
    costPerSearch: 0,
    addPaymentInfo: 20,
    addPaymentInfoValue: 500,
    costPerAddPaymentInfo: 25,
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
    bidStrategyType: "cost_cap",
    bidStrategyLabel: "Cost Cap",
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: 2200,
    bidValueFormat: "currency",
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

function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
  return {
    id: "as-1",
    accountId: "act-1",
    name: "Broad Test",
    campaignId: "cmp-1",
    status: "ACTIVE",
    budgetLevel: "adset",
    currency: "USD",
    dailyBudget: 10000,
    lifetimeBudget: null,
    optimizationGoal: "Purchase",
    bidStrategyType: "cost_cap",
    bidStrategyLabel: "Cost Cap",
    manualBidAmount: null,
    previousManualBidAmount: null,
    bidValue: 2200,
    bidValueFormat: "currency",
    previousBidValue: null,
    previousBidValueFormat: null,
    previousBidValueCapturedAt: null,
    isBudgetMixed: false,
    previousDailyBudget: null,
    previousLifetimeBudget: null,
    previousBudgetCapturedAt: null,
    isConfigMixed: false,
    isOptimizationGoalMixed: false,
    isBidStrategyMixed: false,
    isBidValueMixed: false,
    spend: 1000,
    purchases: 35,
    revenue: 3200,
    roas: 3.2,
    cpa: 28.57,
    ctr: 2,
    cpm: 20,
    impressions: 30000,
    clicks: 600,
    inlineLinkClickCtr: 1.5,
    frequency: 2,
    ageDays: 30,
    audienceLabel: "broad",
    ...overrides,
  };
}

const parent = campaign();
const context: MetaAdsetDecisionAccountContext = {
  accountMedianRoas: 2.5,
  accountP10Roas: 1,
  accountP75Cpa: 80,
  accountMedianCpm: 20,
  selectedRangeDays: 14,
  currency: "USD",
  historicalBidBand: { low: 1800, mid: 2200, high: 3000 },
  audienceRoasByLabel: {
    broad: 2,
    lookalike_1: 3,
    lookalike_3: 2.6,
  },
};

describe("adset heuristic decisions", () => {
  describe("maybeAdsetBidCapAdjust", () => {
    it("triggers when low win-rate still has account-median ROAS", () => {
      const rec = maybeAdsetBidCapAdjust(
        { adset: adset({ winRate: 0.42, roas: 3.1 }), parentCampaign: parent },
        context,
      );

      expect(rec).toMatchObject({
        level: "adset",
        type: "adset_bid_cap_adjust",
        adsetId: "as-1",
        parentCampaignId: "cmp-1",
        currentBidValue: 2200,
        bidCurrency: "USD",
      });
      expect(rec?.proposedBidValue).toBeGreaterThan(2200);
      expect(rec?.acceptableRange).toEqual({ low: 1800, mid: 2200, high: 3000 });
    });

    it("does not trigger when win-rate is inside the neutral band", () => {
      const rec = maybeAdsetBidCapAdjust(
        { adset: adset({ winRate: 0.6, roas: 3.1 }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });

    it("does not trigger when the current bid value is missing", () => {
      const rec = maybeAdsetBidCapAdjust(
        { adset: adset({ winRate: 0.4, bidValue: null, manualBidAmount: null }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });
  });

  describe("maybeAdsetAudienceSwap", () => {
    it("triggers on high frequency plus CTR decay", () => {
      const rec = maybeAdsetAudienceSwap(
        { adset: adset({ frequency: 4.6, ctrDecay14d: -0.32, name: "Broad Prospecting" }), parentCampaign: parent },
        context,
      );

      expect(rec).toMatchObject({
        type: "adset_audience_swap",
        currentAudienceLabel: "Broad",
        proposedAudienceLabel: "LAL 1%",
      });
    });

    it("does not trigger below the frequency threshold", () => {
      const rec = maybeAdsetAudienceSwap(
        { adset: adset({ frequency: 3.9, ctrDecay14d: -0.4 }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });

    it("does not trigger when CTR decay is missing", () => {
      const rec = maybeAdsetAudienceSwap(
        { adset: adset({ frequency: 4.6, ctrDecay14d: null }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });
  });

  describe("maybeAdsetPauseUnderperformer", () => {
    it("triggers for mature spend below the account p10 ROAS floor", () => {
      const rec = maybeAdsetPauseUnderperformer(
        { adset: adset({ roas: 0.6, spend: 350, ageDays: 21, purchases: 35 }), parentCampaign: parent },
        context,
      );

      expect(rec).toMatchObject({
        type: "adset_pause_underperformer",
        priority: "high",
        confidence: "high",
      });
    });

    it("does not trigger for a young adset", () => {
      const rec = maybeAdsetPauseUnderperformer(
        { adset: adset({ roas: 0.6, spend: 350, ageDays: 7 }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });

    it("does not trigger for a learning-phase adset", () => {
      const rec = maybeAdsetPauseUnderperformer(
        { adset: adset({ status: "LEARNING", roas: 0.6, spend: 350, ageDays: 21 }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });
  });

  describe("maybeAdsetBudgetShiftWithinCampaign", () => {
    it("proposes moving 25 percent of weak sibling budget to the strong adset", () => {
      const high = adset({ id: "as-high", name: "Winner", roas: 4, dailyBudget: 10000, purchases: 25 });
      const mid = adset({ id: "as-mid", name: "Middle", roas: 2, dailyBudget: 8000, purchases: 10 });
      const low = adset({ id: "as-low", name: "Weak", roas: 1, dailyBudget: 4000, purchases: 8 });

      const rec = maybeAdsetBudgetShiftWithinCampaign({
        campaign: parent,
        adsets: [high, mid, low],
        accountContext: context,
      });

      expect(rec).toMatchObject({
        type: "adset_budget_shift_within_campaign",
        adsetId: "as-high",
        currentDailyBudget: 10000,
        proposedDailyBudget: 11000,
        sourceAdsetIds: ["as-low"],
      });
    });

    it("does not trigger in a CBO family", () => {
      const rec = maybeAdsetBudgetShiftWithinCampaign({
        campaign: campaign({ budgetLevel: "campaign" }),
        adsets: [
          adset({ id: "as-high", roas: 4, budgetLevel: "campaign" }),
          adset({ id: "as-low", roas: 1, budgetLevel: "campaign" }),
        ],
        accountContext: context,
      });

      expect(rec).toBeNull();
    });

    it("does not trigger when campaign context is missing", () => {
      const rec = maybeAdsetBudgetShiftWithinCampaign({
        campaign: null,
        adsets: [adset({ id: "as-high", roas: 4 }), adset({ id: "as-low", roas: 1 })],
        accountContext: context,
      });

      expect(rec).toBeNull();
    });
  });

  describe("maybeAdsetOptimizationEventSwitch", () => {
    it("triggers when purchase signal is sparse and CPA is above p75", () => {
      const rec = maybeAdsetOptimizationEventSwitch(
        { adset: adset({ purchases: 40, cpa: 110, optimizationGoal: "Purchase" }), parentCampaign: parent },
        context,
      );

      expect(rec).toMatchObject({
        type: "adset_optimization_event_switch",
        currentEvent: "Purchase",
        proposedEvent: "Add To Cart",
      });
    });

    it("does not trigger after the conversion floor is met", () => {
      const rec = maybeAdsetOptimizationEventSwitch(
        { adset: adset({ purchases: 60, cpa: 110, optimizationGoal: "Purchase" }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });

    it("does not trigger when the current event is not lower-funnel purchase", () => {
      const rec = maybeAdsetOptimizationEventSwitch(
        { adset: adset({ purchases: 20, cpa: 110, optimizationGoal: "Lead" }), parentCampaign: parent },
        context,
      );

      expect(rec).toBeNull();
    });
  });

  describe("maybeAdsetAudienceExpansion", () => {
    it("triggers when impressions are below target and CPM is cheap", () => {
      const rec = maybeAdsetAudienceExpansion(
        {
          adset: adset({
            name: "LAL 3% Prospecting",
            audienceLabel: "lookalike_3",
            impressions: 60000,
            dailyTargetImpressions: 100000,
            cpm: 10,
          }),
          parentCampaign: parent,
        },
        context,
      );

      expect(rec).toMatchObject({
        type: "adset_audience_expansion",
        adsetId: "as-1",
      });
      expect(rec).not.toHaveProperty("currentDailyBudget");
      expect(rec).not.toHaveProperty("proposedDailyBudget");
    });

    it("does not trigger when CPM is above the account median", () => {
      const rec = maybeAdsetAudienceExpansion(
        {
          adset: adset({
            impressions: 60000,
            dailyTargetImpressions: 100000,
            cpm: 24,
          }),
          parentCampaign: parent,
        },
        context,
      );

      expect(rec).toBeNull();
    });

    it("does not trigger when the impression target cannot be derived", () => {
      const rec = maybeAdsetAudienceExpansion(
        {
          adset: adset({
            dailyTargetImpressions: null,
            dailyBudget: null,
            cpm: 10,
          }),
          parentCampaign: parent,
        },
        context,
      );

      expect(rec).toBeNull();
    });
  });
});
