/**
 * The account's currency scale reaches the sizing policy.
 *
 * `sizeBidChange` compares a MAJOR-unit cost per purchase against a MINOR-unit
 * benchmark, and only the account currency's ISO-4217 exponent makes those one
 * number. The projection is the only place that knows the currency, so a
 * projection that resolved nothing — or resolved it twice, differently from the
 * contract — would put the policy back on an assumed two decimals with no test
 * able to see it.
 */
import { describe, expect, it } from "vitest";

import { BID_SIZING_POLICY_VERSION } from "@/lib/meta/bid-sizing-policy";
import {
  projectBidIntents,
  type BidIntentEntityContext,
} from "@/lib/meta/bid-intent-projection";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const BUSINESS = "11111111-1111-4111-8111-111111111111";

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "r1", level: "adset", adsetId: "set_1", campaignId: "camp_1",
    type: "scenario_b1_capped_winner_bid_raise", decisionLabel: "tune",
    lens: "efficiency", priority: "high", confidence: "high",
    decisionState: "act", decision: "", title: "", why: "", summary: "",
    ...overrides,
  } as MetaRecommendation;
}

function project(input: {
  accountCurrency: string | null;
  spendUnitMinor: number;
  context: Partial<BidIntentEntityContext>;
}) {
  return projectBidIntents({
    recommendations: [rec()],
    businessId: BUSINESS,
    providerAccountId: "act_1",
    spendUnitMinor: input.spendUnitMinor,
    bidActionAuthority: true,
    accountCurrency: input.accountCurrency,
    policy: {
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 3,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    },
    contextByAdsetId: new Map([["set_1", {
      bidStrategyType: "cost_cap",
      currentBidMinor: 500,
      spend28d: 4200,
      purchases28d: 500,
      maturityOk: true,
      deliveryConstrained: true,
      hoursSinceLastChange: 48,
      changesLast7d: 0,
      parentCampaignId: "camp_1",
      ...input.context,
    }]]),
    budgetChangedAdsetIds: new Set(),
    originDate: "2026-09-05",
    effectiveAsOf: "2026-09-04",
    knowledgeAsOf: "2026-09-05T03:12:00.000Z",
    evidenceWindow: { from: "2026-08-09", to: "2026-09-05" },
  });
}

describe("the account currency's exponent reaches the sizing policy", () => {
  it("raises a cheap JPY cap that a hardcoded 100 would have cut", () => {
    // ¥1,500 per purchase against a ¥3,000 benchmark, delivery constrained.
    // JPY is exponent 0, so both are already minor units and the ratio is 0.5.
    const result = project({
      accountCurrency: "JPY",
      spendUnitMinor: 3000,
      context: { spend28d: 150_000, purchases28d: 100, currentBidMinor: 500 },
    });
    expect(result.sized).toBe(1);
    const target = result.recommendations[0]!.targetValue as Record<string, unknown>;
    expect(target.currencyExponent).toBe(0);
    expect(target.direction).toBe("increase");
    // ¥500 + 15%. Under the old arithmetic this ad set was a 15% CUT to ¥425.
    expect(target.bidAmountMinor).toBe(575);
  });

  it("withholds a KWD decrease because B1 authorises only a cap increase", () => {
    // 3.000 KWD per purchase against a 2.000 KWD benchmark would size a 15%
    // decrease. The currency arithmetic is valid, but B1's requested operation
    // is an increase, so projection must not change the recommendation's lever.
    const result = project({
      accountCurrency: "KWD",
      spendUnitMinor: 2000,
      context: { spend28d: 300, purchases28d: 100, currentBidMinor: 4000 },
    });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.bid_direction_semantic_mismatch).toBe(1);
    expect(result.recommendations[0]!.targetValue).toBeUndefined();
  });

  it("still sizes a two-decimal account exactly as before", () => {
    // $8.40 against a $10.00 benchmark: the worked USD case, unchanged.
    const result = project({
      accountCurrency: "USD",
      spendUnitMinor: 1000,
      context: { currentBidMinor: 1200 },
    });
    expect(result.sized).toBe(1);
    const target = result.recommendations[0]!.targetValue as Record<string, unknown>;
    expect(target.currencyExponent).toBe(2);
    expect(target.bidAmountMinor).toBe(1320);
  });

  it("proposes nothing when the registry cannot scale the currency", () => {
    // Refused by the policy before any ratio is computed, not by the contract
    // after an amount has already been chosen on a guessed scale.
    const result = project({
      accountCurrency: "XYZ",
      spendUnitMinor: 1000,
      context: { currentBidMinor: 1200 },
    });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.currency_unresolvable).toBe(1);
  });
});
