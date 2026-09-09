import { describe, expect, it } from "vitest";

import { BID_SIZING_POLICY_VERSION } from "@/lib/meta/bid-sizing-policy";
import { META_BID_INTENT_CONTRACT_VERSION } from "@/lib/meta/bid-intent-contract";
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

function project(input: {
  recommendations?: MetaRecommendation[];
  context?: BidIntentEntityContext;
  spendUnitMinor?: number | null;
  budgetChanged?: Set<string>;
}) {
  return projectBidIntents({
    recommendations: input.recommendations ?? [rec()],
    businessId: BUSINESS,
    providerAccountId: "act_1",
    // $10.00 CPA benchmark against a $12.00 cap: q = 0.84, delivery
    // constrained, so the policy's 10% raise band applies.
    spendUnitMinor: input.spendUnitMinor === undefined ? 1000 : input.spendUnitMinor,
    bidActionAuthority: true,
    accountCurrency: "USD",
    policy: {
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 3,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    },
    contextByAdsetId: new Map([["set_1", input.context ?? context()]]),
    budgetChangedAdsetIds: input.budgetChanged ?? new Set(),
    originDate: "2026-09-05",
    effectiveAsOf: "2026-09-04",
    knowledgeAsOf: "2026-09-05T03:12:00.000Z",
    evidenceWindow: { from: "2026-08-09", to: "2026-09-05" },
  });
}

describe("a sized bid becomes an amount the card can apply", () => {
  it("writes the exact minor-unit amount the operator apply path reads", () => {
    const result = project({});
    expect(result.sized).toBe(1);
    const target = result.recommendations[0]!.targetValue as Record<string, unknown>;
    expect(target.contractVersion).toBe(META_BID_INTENT_CONTRACT_VERSION);
    // The worked case: $12.00 cap, 10% up, $13.20.
    expect(target.bidAmountMinor).toBe(1320);
    expect(target.currentMinorUnits).toBe(1200);
    expect(target.bidStrategyType).toBe("cost_cap");
    // `bidAmountMinor` is the field `proposedActionForRecommendation` reads;
    // without it the card offers nothing at all.
    expect(target).toHaveProperty("bidAmountMinor");
  });

  it("writes every key the queue producer selects on", () => {
    /*
      The payload and the query that has to find it, checked against each other.

      `TYPED_BID_CANDIDATE_SQL` filters on `kind`, `authorityStatus`,
      `blockerCodes`, `proposedMinorUnits`, `currency` and `currencyExponent`,
      and the projection wrote none of them, so no snapshot-produced intent
      could ever become a queue row. Naming each predicate here means the day
      one of them stops being written is the day this fails, rather than the day
      an operator notices the queue is empty.
    */
    const result = project({});
    const target = result.recommendations[0]!.targetValue as Record<string, unknown>;
    expect(target.kind).toBe("bid_intent");
    expect(target.authorityStatus).toBe("authorised");
    expect(target.blockerCodes).toEqual([]);
    expect(target.proposedMinorUnits).toBe(1320);
    expect(target.currency).toBe("USD");
    expect(target.currencyExponent).toBe(2);
    // The apply path's field is unchanged and still names the same amount.
    expect(target.bidAmountMinor).toBe(1320);
  });

  it("carries the reason, not just the percentage", () => {
    const result = project({});
    const target = result.recommendations[0]!.targetValue as { rationale?: string[] };
    expect(Array.isArray(target.rationale)).toBe(true);
    expect(target.rationale!.length).toBeGreaterThan(0);
  });
});

describe("nothing is proposed without a reason to propose it", () => {
  it("refuses to type an act row without bid action authority", () => {
    const original = rec();
    const result = projectBidIntents({
      recommendations: [original],
      businessId: BUSINESS,
      providerAccountId: "act_1",
      spendUnitMinor: 1000,
      bidActionAuthority: false,
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

    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(original);
    expect(result.recommendations[0]?.targetValue).toBeUndefined();
    expect(result.withheldByCode).toEqual({ commercial_target_unknown: 1 });
  });

  it("withholds on a lowest-cost ad set, which owns no writable cap", () => {
    const result = project({ context: context({ bidStrategyType: "lowest_cost" }) });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.bid_strategy_not_writable).toBe(1);
  });

  it("withholds a raise when delivery is not constrained", () => {
    // Raising a cap that is not limiting delivery only pays more for the same
    // result.
    const result = project({ context: context({ deliveryConstrained: false }) });
    expect(result.sized).toBe(0);
    expect(Object.keys(result.withheldByCode).length).toBeGreaterThan(0);
  });

  it("withholds when the same ad set already has a budget change proposed", () => {
    // Two levers at once make the outcome unattributable.
    const result = project({ budgetChanged: new Set(["set_1"]) });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.sibling_change_same_window).toBe(1);
  });

  it("withholds with no CPA benchmark", () => {
    const result = project({ spendUnitMinor: null });
    expect(result.sized).toBe(0);
  });

  it("leaves campaign rows and anomalies untouched", () => {
    const rows = [
      rec({ id: "c1", level: "campaign", adsetId: undefined }),
      rec({ id: "a1", kind: "anomaly" }),
    ];
    const result = project({ recommendations: rows });
    expect(result.sized).toBe(0);
    expect(result.recommendations).toEqual(rows);
  });

  it("never gives watch, test, or missing-state rows a typed bid intent", () => {
    const rows = [
      rec({ id: "watch", decisionState: "watch" }),
      rec({ id: "test", decisionState: "test" }),
      rec({ id: "legacy", decisionState: undefined } as never),
    ];
    const result = project({ recommendations: rows });

    expect(result.sized).toBe(0);
    expect(result.withheldByCode).toEqual({});
    expect(result.recommendations).toHaveLength(rows.length);
    result.recommendations.forEach((row, index) => {
      expect(row).toBe(rows[index]);
      expect(row.targetValue).toBeUndefined();
    });
  });

  it("does not turn unrelated actionable recommendations into bid changes", () => {
    const rows = [
      rec({ id: "cut", type: "adset_cut_spend" }),
      rec({ id: "fatigue", type: "scenario_e1_frequency_fatigue" }),
      rec({ id: "ratio", type: "bid_value_guidance" }),
      rec({ id: "structure", type: "scenario_k1_mixed_config_rebuild" }),
    ];
    const result = project({ recommendations: rows });

    expect(result.sized).toBe(0);
    expect(result.withheldByCode).toEqual({ bid_action_semantic_missing: 4 });
    result.recommendations.forEach((row, index) => {
      expect(row).toBe(rows[index]);
      expect(row.targetValue).toBeUndefined();
    });
  });

  it("withholds when the sizing policy version is not bound", () => {
    // An unstamped business proposes nothing: a build that changed the bands
    // must not silently start proposing different amounts.
    const result = projectBidIntents({
      recommendations: [rec()],
      businessId: BUSINESS,
      providerAccountId: "act_1",
      spendUnitMinor: 1000,
      bidActionAuthority: true,
      accountCurrency: "USD",
      policy: {
        budgetMinHoursBetweenChanges: 24,
        budgetMaxChangesPer7d: 3,
        bidSizingPolicyVersion: null,
      },
      contextByAdsetId: new Map([["set_1", context()]]),
      budgetChangedAdsetIds: new Set(),
      originDate: "2026-09-05",
      effectiveAsOf: "2026-09-04",
      knowledgeAsOf: "2026-09-05T03:12:00.000Z",
      evidenceWindow: { from: "2026-08-09", to: "2026-09-05" },
    });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.sizing_policy_version_unbound).toBe(1);
  });

  it("withholds when the account currency has no known scale", () => {
    // A number whose scale is unknown is not a number.
    const result = projectBidIntents({
      recommendations: [rec()],
      businessId: BUSINESS,
      providerAccountId: "act_1",
      spendUnitMinor: 1000,
      bidActionAuthority: true,
      accountCurrency: null,
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
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.currency_unresolvable).toBe(1);
  });
});
