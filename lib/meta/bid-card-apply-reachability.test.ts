/**
 * The card's Apply and the queue's Approve must agree about one amount.
 *
 * They did not. `proposedActionForRecommendation` granted an executable action
 * only to an ad-set recommendation whose `type` was `bid_value_guidance`, and
 * the only emitter of that type builds a CAMPAIGN recommendation — so the
 * condition was unsatisfiable for every real row. The bid projection attaches
 * its intent to whichever ad-set recommendation is present, which in practice
 * is a `scenario_*` row. Observed in the mounted product: an ad set serving
 * `targetValue.bidAmountMinor: 1320` from the real projection, and
 * `operatorApply: null` on the same row.
 *
 * The old tests could not catch it because they built the recommendation with
 * the unreachable type themselves. These start from the types real producers
 * emit, and take the target value from the REAL projection rather than
 * restating it.
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
 * The type an ad-set row actually carries when the projection reaches it.
 *
 * `scenario_e1_frequency_fatigue` is one of the real ad-set emitters; the
 * point of the test is that the type is NOT `bid_value_guidance`, because no
 * ad-set producer emits that.
 */
function adsetRec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "scenario_e1_frequency_fatigue-set_1",
    level: "adset", adsetId: "set_1", campaignId: "camp_1",
    type: "scenario_e1_frequency_fatigue", decisionLabel: "tune",
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

/** The real projection, so the target value under test is the one production writes. */
function sizedAdsetRec(recommendation = adsetRec()): MetaRecommendation {
  const result = projectBidIntents({
    recommendations: [recommendation],
    businessId: BUSINESS,
    providerAccountId: "act_1",
    // $10.00 benchmark against a $12.00 cap: q = 0.84 with delivery
    // constrained, which is the policy's 10% raise band. 1200 -> 1320.
    spendUnitMinor: 1000,
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

describe("an ad set carrying a real sized bid offers a real Apply", () => {
  it("reads the amount off the target value the projection actually writes", () => {
    const rec = sizedAdsetRec();
    expect(rec.type).not.toBe("bid_value_guidance");
    expect(executableBidIntentMinorUnits(rec.targetValue)).toBe(1320);
  });

  it("proposes the apply_bid action for a type no producer would have matched", () => {
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
