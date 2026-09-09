/**
 * The card's Apply and the queue's Approve must agree about one amount.
 *
 * A typed amount is necessary but not sufficient. The recommendation type must
 * itself authorise a currency bid change in the same direction; otherwise a
 * Cut, fatigue refresh or structural recommendation can be turned into an
 * unrelated money move merely by attaching a valid payload. B1 is today's only
 * such vocabulary and it means an increase. Its real emitter is campaign-grain,
 * so the ad-set row below is a forward-contract fixture, not a claim that live
 * production currently emits executable bid rows.
 */
import { describe, expect, it } from "vitest";

import {
  META_BID_INTENT_CONTRACT_VERSION,
  executableBidIntentMinorUnits,
} from "@/lib/meta/bid-intent-contract";
import { BID_SIZING_POLICY_VERSION } from "@/lib/meta/bid-sizing-policy";
import {
  projectBidIntents,
  type BidIntentEntityContext,
} from "@/lib/meta/bid-intent-projection";
import {
  proposedActionForRecommendation,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";
import {
  serverLaunchModeForRec,
  serverOperatorApplyForRec,
} from "@/lib/meta/rec-presentation";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

/**
 * A synthetic ad-set B1 row exercises the supported semantic contract.
 */
function adsetRec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "scenario_b1_capped_winner_bid_raise-set_1",
    level: "adset", adsetId: "set_1", campaignId: "camp_1",
    type: "scenario_b1_capped_winner_bid_raise", decisionLabel: "tune",
    lens: "efficiency", priority: "high", confidence: "high",
    decisionState: "act", decision: "", title: "", why: "", summary: "",
    ...overrides,
  } as MetaRecommendation;
}

function context(overrides: Partial<BidIntentEntityContext> = {}): BidIntentEntityContext {
  return {
    bidStrategyType: "cost_cap",
    currentBidMinor: 1200,
    spend28d: 4200,
    purchases28d: 500,
    maturityOk: true,
    deliveryConstrained: true,
    hoursSinceLastChange: 48,
    changesLast7d: 0,
    parentCampaignId: "camp_1",
    ...overrides,
  };
}

/** The real projector, fed the forward-compatible semantic fixture above. */
function sizedAdsetRec(recommendation = adsetRec()): MetaRecommendation {
  const result = projectBidIntents({
    recommendations: [recommendation],
    businessId: BUSINESS,
    providerAccountId: "act_1",
    // $10.00 benchmark against a $12.00 cap: q = 0.84 with delivery
    // constrained, which is the policy's 10% raise band. 1200 -> 1320.
    spendUnitMinor: 1000,
    bidActionAuthority: true,
    accountCurrency: "USD",
    policy: {
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 3,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    },
    contextByAdsetId: new Map([["set_1", context()]]),
    budgetChangedAdsetIds: new Set(),
    originDate: "2026-09-05",
    effectiveAsOf: "2026-09-04",
    knowledgeAsOf: "2026-09-05T03:12:00.000Z",
    evidenceWindow: { from: "2026-08-09", to: "2026-09-05" },
  });
  expect(result.sized).toBe(1);
  return result.recommendations[0]!;
}

describe("an ad set carrying a semantically authorised bid offers Apply", () => {
  it("reads the amount off the target value the projection actually writes", () => {
    const rec = sizedAdsetRec();
    expect(rec.type).toBe("scenario_b1_capped_winner_bid_raise");
    expect(executableBidIntentMinorUnits(rec.targetValue)).toBe(1320);
  });

  it("proposes apply_bid only for the bid-amount semantic type", () => {
    expect(proposedActionForRecommendation(sizedAdsetRec())).toEqual({
      kind: "apply_bid", bidAmountMinor: 1320,
    });
  });

  it("serves an operator apply the ceremony can open", () => {
    const rec = sizedAdsetRec();
    const stamped = {
      ...rec, proposedAction: proposedActionForRecommendation(rec),
    } as MetaRecommendation;
    expect(serverOperatorApplyForRec(stamped)).toEqual({
      action: "bid", grain: "adset", entityId: "set_1", bidAmountMinor: 1320,
    });
    expect(serverLaunchModeForRec(rec)).toBe("apply_bid");
  });
});

describe("and nothing else does", () => {
  it("offers nothing on an ad set the projection withheld", () => {
    // A lowest-cost ad set owns no writable cap, so no intent is attached.
    const withheld = projectBidIntents({
      recommendations: [adsetRec()],
      businessId: BUSINESS,
      providerAccountId: "act_1",
      spendUnitMinor: 1000,
      bidActionAuthority: true,
      accountCurrency: "USD",
      policy: {
        budgetMinHoursBetweenChanges: 24,
        budgetMaxChangesPer7d: 3,
        bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
      },
      contextByAdsetId: new Map([["set_1", context({ bidStrategyType: "lowest_cost" })]]),
      budgetChangedAdsetIds: new Set(),
      originDate: "2026-09-05",
      effectiveAsOf: "2026-09-04",
      knowledgeAsOf: "2026-09-05T03:12:00.000Z",
      evidenceWindow: { from: "2026-08-09", to: "2026-09-05" },
    }).recommendations[0]!;
    expect(withheld.targetValue).toBeUndefined();
    expect(proposedActionForRecommendation(withheld)).toBeUndefined();
    expect(serverLaunchModeForRec(withheld)).toBeNull();
  });

  it("refuses an intent whose own authority status is not authorised", () => {
    /*
      The same predicate the queue's candidate SQL applies. A withheld or
      blocker-carrying intent is not an amount to offer, and reading only
      `bidAmountMinor` would have offered it.
    */
    const rec = sizedAdsetRec();
    const target = rec.targetValue as Record<string, unknown>;
    expect(executableBidIntentMinorUnits({
      ...target, authorityStatus: "withheld",
    })).toBeNull();
    expect(executableBidIntentMinorUnits({
      ...target, blockerCodes: ["provider_baseline_unknown"],
    })).toBeNull();
  });

  it("refuses a target value carrying two different numbers for one write", () => {
    const target = sizedAdsetRec().targetValue as Record<string, unknown>;
    expect(executableBidIntentMinorUnits({ ...target, bidAmountMinor: 1500 })).toBeNull();
  });

  it("does not let a valid amount replace a Cut or fatigue recommendation's lever", () => {
    const target = sizedAdsetRec().targetValue as Record<string, unknown>;
    // The payload alone is structurally valid; the recommendation semantics are
    // what must refuse these two poisoned historical rows.
    expect(executableBidIntentMinorUnits(target)).toBe(1320);
    for (const type of [
      "adset_cut_spend",
      "scenario_e1_frequency_fatigue",
    ] as const) {
      const poisoned = adsetRec({
        type,
        targetValue: target,
        proposedAction: { kind: "apply_bid", bidAmountMinor: 1320 },
      });
      expect(proposedActionForRecommendation(poisoned)).toBeUndefined();
      expect(serverLaunchModeForRec(poisoned)).toBeNull();
      expect(serverOperatorApplyForRec(poisoned)).toBeNull();
    }
  });

  it("refuses anything that is not a bid intent at all", () => {
    expect(executableBidIntentMinorUnits(null)).toBeNull();
    expect(executableBidIntentMinorUnits({ bidAmountMinor: 1320 })).toBeNull();
    expect(executableBidIntentMinorUnits({
      contractVersion: META_BID_INTENT_CONTRACT_VERSION,
      authorityStatus: "authorised",
      blockerCodes: [],
    })).toBeNull();
  });

  it("still refuses a campaign-grain row, wherever the amount came from", () => {
    const rec = sizedAdsetRec();
    expect(proposedActionForRecommendation({
      ...rec, level: "campaign",
    } as MetaRecommendation)).toBeUndefined();
  });
});
