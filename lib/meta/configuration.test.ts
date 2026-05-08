import { describe, expect, it } from "vitest";
import {
  buildConfigSnapshotPayload,
  normalizeBidStrategy,
  normalizeOptimizationGoal,
  stripIncompleteConstrainedBidFields,
  summarizeCampaignConfig,
} from "@/lib/meta/configuration";

describe("meta configuration helpers", () => {
  it("normalizes optimization goals into readable labels", () => {
    expect(normalizeOptimizationGoal("omni_purchase")).toBe("Purchase");
    expect(normalizeOptimizationGoal("LEAD_GENERATION")).toBe("Lead");
  });

  it("normalizes bid strategies into supported labels", () => {
    expect(normalizeBidStrategy("LOWEST_COST_WITH_BID_CAP", null)).toEqual({
      type: "bid_cap",
      label: "Bid Cap",
    });
    expect(normalizeBidStrategy(null, 2500)).toEqual({
      type: "manual_bid",
      label: "Manual Bid",
    });
  });

  it("strips incomplete constrained bid fields before durable storage", () => {
    expect(
      stripIncompleteConstrainedBidFields({
        bidStrategyType: "cost_cap",
        bidValue: null,
        bidValueFormat: "currency",
        isBidValueMixed: true,
      }),
    ).toEqual({
      bidStrategyType: null,
      bidValue: null,
      bidValueFormat: null,
      isBidValueMixed: false,
    });

    expect(
      stripIncompleteConstrainedBidFields({
        bidStrategyType: "lowest_cost",
        bidValue: null,
        bidValueFormat: null,
      }),
    ).toEqual({
      bidStrategyType: "lowest_cost",
      bidValue: null,
      bidValueFormat: null,
    });
  });

  it("builds a single-value campaign summary from matching ad sets", () => {
    const adsets = [
      buildConfigSnapshotPayload({
        campaignId: "cmp_1",
        optimizationGoal: "omni_purchase",
        bidStrategy: "LOWEST_COST_WITH_BID_CAP",
        manualBidAmount: 2400,
        dailyBudget: 5000,
      }),
      buildConfigSnapshotPayload({
        campaignId: "cmp_1",
        optimizationGoal: "omni_purchase",
        bidStrategy: "LOWEST_COST_WITH_BID_CAP",
        manualBidAmount: 2400,
        dailyBudget: 5000,
      }),
    ];

    const summary = summarizeCampaignConfig({
      campaignId: "cmp_1",
      adsets,
      previousAdsets: [{ campaignId: "cmp_1", manualBidAmount: 2000 }],
    });

    expect(summary.optimizationGoal).toBe("Purchase");
    expect(summary.bidStrategyLabel).toBe("Bid Cap");
    expect(summary.manualBidAmount).toBe(2400);
    expect(summary.bidValue).toBe(2400);
    expect(summary.bidValueFormat).toBe("currency");
    expect(summary.previousManualBidAmount).toBe(2000);
    expect(summary.previousBidValue).toBe(2000);
    expect(summary.isConfigMixed).toBe(false);
  });

  it("marks mixed config when ad sets disagree", () => {
    const summary = summarizeCampaignConfig({
      campaignId: "cmp_2",
      adsets: [
        buildConfigSnapshotPayload({
          campaignId: "cmp_2",
          optimizationGoal: "omni_purchase",
          bidStrategy: "LOWEST_COST_WITH_BID_CAP",
          manualBidAmount: 3000,
          dailyBudget: 4000,
        }),
        buildConfigSnapshotPayload({
          campaignId: "cmp_2",
          optimizationGoal: "lead_generation",
          bidStrategy: "COST_CAP",
          manualBidAmount: null,
          dailyBudget: 7000,
        }),
      ],
    });

    expect(summary.optimizationGoal).toBeNull();
    expect(summary.manualBidAmount).toBeNull();
    expect(summary.bidValue).toBe(3000);
    expect(summary.isConfigMixed).toBe(true);
    expect(summary.isBudgetMixed).toBe(true);
  });

  it("rolls up ad set custom events and flags mixed campaigns", () => {
    const purchaseSummary = summarizeCampaignConfig({
      campaignId: "cmp_events",
      adsets: [
        buildConfigSnapshotPayload({
          campaignId: "cmp_events",
          optimizationGoal: "offsite_conversions",
          customEventType: "purchase",
          pixelId: "px_1",
          promotedObject: { pixel_id: "px_1", custom_event_type: "PURCHASE" },
        }),
        buildConfigSnapshotPayload({
          campaignId: "cmp_events",
          optimizationGoal: "offsite_conversions",
          customEventType: "PURCHASE",
          pixelId: "px_1",
          promotedObject: { pixel_id: "px_1", custom_event_type: "PURCHASE" },
        }),
      ],
    });

    expect(purchaseSummary.customEventType).toBe("PURCHASE");
    expect(purchaseSummary.isCustomEventTypeMixed).toBe(false);

    const mixedSummary = summarizeCampaignConfig({
      campaignId: "cmp_mixed_events",
      adsets: [
        buildConfigSnapshotPayload({
          campaignId: "cmp_mixed_events",
          customEventType: "PURCHASE",
        }),
        buildConfigSnapshotPayload({
          campaignId: "cmp_mixed_events",
          customEventType: "ADD_TO_CART",
        }),
      ],
    });

    expect(mixedSummary.customEventType).toBeNull();
    expect(mixedSummary.isCustomEventTypeMixed).toBe(true);
    expect(mixedSummary.isConfigMixed).toBe(true);
  });

  it("uses target roas constraints as bid value", () => {
    const adset = buildConfigSnapshotPayload({
      campaignId: "cmp_3",
      bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
      targetRoas: 3.4,
    });

    expect(adset.bidStrategyLabel).toBe("Target ROAS");
    expect(adset.bidValue).toBe(3.4);
    expect(adset.bidValueFormat).toBe("roas");
    expect(adset.manualBidAmount).toBeNull();
  });

  it("normalizes target roas values returned in scaled units", () => {
    const adset = buildConfigSnapshotPayload({
      campaignId: "cmp_4",
      bidStrategy: "LOWEST_COST_WITH_MIN_ROAS",
      targetRoas: 25000,
    });

    expect(adset.bidStrategyLabel).toBe("Target ROAS");
    expect(adset.bidValue).toBe(2.5);
    expect(adset.bidValueFormat).toBe("roas");
  });
});
