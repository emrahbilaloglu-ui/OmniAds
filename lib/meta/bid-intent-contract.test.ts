import { describe, expect, it } from "vitest";

import {
  META_BID_INTENT_CONTRACT_VERSION,
  bidIntentKey,
  validateBidIntent,
  type BidIntentInput,
} from "@/lib/meta/bid-intent-contract";
import { assertCanonicalDecisionAction } from "@/lib/meta/decisions-os-contract";

const BUSINESS = "11111111-1111-4111-8111-111111111111";
const BINDINGS = [{ businessId: BUSINESS, providerAccountId: "act_1" }];

function input(overrides: Partial<BidIntentInput> = {}): BidIntentInput {
  return {
    contractVersion: META_BID_INTENT_CONTRACT_VERSION,
    scope: {
      businessId: BUSINESS,
      providerAccountId: "act_1",
      entityGrain: "adset",
      entityId: "set_1",
      parentCampaignId: "camp_1",
    },
    bidStrategyType: "cost_cap",
    direction: "increase",
    percent: 10,
    currency: "USD",
    observedBidMinorUnits: 1200,
    originDate: "2026-09-05",
    effectiveAsOf: "2026-09-04",
    knowledgeAsOf: "2026-09-05T03:12:00.000Z",
    evidenceWindow: { from: "2026-08-08", to: "2026-09-04" },
    authorityStatus: "authorised",
    blockerCodes: [],
    ...overrides,
  };
}

describe("a valid bid intent is exact money, not a suggestion", () => {
  it("computes the proposal in minor units and records the rounding", () => {
    const result = validateBidIntent(input(), BINDINGS);
    expect(result.status).toBe("valid");
    if (result.status !== "valid") return;
    // $12.00 cost cap, 10% up: the worked case from the sizing policy.
    expect(result.intent.currentMinorUnits).toBe(1200);
    expect(result.intent.proposedMinorUnits).toBe(1320);
    expect(result.intent.deltaMinorUnits).toBe(120);
    expect(result.intent.rounding.rule).toBe("half_up_away_from_zero");
    expect(result.intent.currencyExponent).toBe(2);
  });

  it("requires the read-back to prove the strategy did not change", () => {
    /*
      Writing a cap onto an ad set whose strategy changed since the decision
      would set a number that now means something else. The read-back says so
      explicitly rather than leaving it to the caller to remember.
    */
    const result = validateBidIntent(input(), BINDINGS);
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.intent.readback).toMatchObject({
      field: "bid_amount",
      expectedMinorUnits: 1320,
      independentRead: true,
    });
    expect(result.intent.readback.alsoAsserts).toContain("bid_strategy_unchanged");
    expect(result.intent.rollback).toMatchObject({
      priorMinorUnits: 1200, field: "bid_amount", operation: "set",
    });
  });

  it("stops at validated_only", () => {
    const result = validateBidIntent(input(), BINDINGS);
    if (result.status !== "valid") throw new Error("expected valid");
    expect(result.intent.executionState).toBe("validated_only");
  });
});

describe("the identity is the operation, not the entity", () => {
  it("gives two different amounts two different keys", () => {
    // A key that collapsed these would let a dispatcher deduplicate one of two
    // materially different money movements away.
    const small = bidIntentKey({
      scope: input().scope, bidStrategyType: "cost_cap", direction: "increase",
      percent: 10, originDate: "2026-09-05",
      currentMinorUnits: 1200, proposedMinorUnits: 1320,
      currency: "USD", currencyExponent: 2,
    });
    const large = bidIntentKey({
      scope: input().scope, bidStrategyType: "cost_cap", direction: "increase",
      percent: 10, originDate: "2026-09-05",
      currentMinorUnits: 9000, proposedMinorUnits: 9900,
      currency: "USD", currencyExponent: 2,
    });
    expect(small).not.toBe(large);
  });

  it("gives the same operation the same key twice", () => {
    const first = validateBidIntent(input(), BINDINGS);
    const second = validateBidIntent(input(), BINDINGS);
    if (first.status !== "valid" || second.status !== "valid") throw new Error("expected valid");
    expect(first.intent.intentKey).toBe(second.intent.intentKey);
    expect(first.intent.idempotencyKey).toBe(first.intent.intentKey);
  });

  it("separates the same amount on a different strategy", () => {
    const capped = validateBidIntent(input({ bidStrategyType: "cost_cap" }), BINDINGS);
    const bidCap = validateBidIntent(input({ bidStrategyType: "bid_cap" }), BINDINGS);
    if (capped.status !== "valid" || bidCap.status !== "valid") throw new Error("expected valid");
    expect(capped.intent.intentKey).not.toBe(bidCap.intent.intentKey);
  });
});

describe("every ambiguity is a named refusal", () => {
  it("refuses a strategy that owns no writable bid", () => {
    const result = validateBidIntent(input({ bidStrategyType: "lowest_cost" }), BINDINGS);
    expect(result).toMatchObject({ status: "rejected" });
    if (result.status !== "rejected") return;
    expect(result.rejections).toContain("bid_strategy_not_writable");
  });

  it("refuses a campaign-grain bid, which has no endpoint", () => {
    const result = validateBidIntent(
      input({ scope: { ...input().scope, entityGrain: "campaign" as never } }),
      BINDINGS,
    );
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.rejections).toContain("grain_unsupported");
  });

  it("refuses a business/account pair that is not bound", () => {
    // Each half being separately valid proves nothing about the pair.
    const result = validateBidIntent(input(), [
      { businessId: BUSINESS, providerAccountId: "act_other" },
      { businessId: "other", providerAccountId: "act_1" },
    ]);
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.rejections).toContain("scope_identity_cross_paired");
  });

  it("refuses a magnitude that is not on the ladder", () => {
    const result = validateBidIntent(input({ percent: 12 }), BINDINGS);
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.rejections).toContain("percent_unsupported");
  });

  it("refuses evidence from after the decision was made", () => {
    const result = validateBidIntent(input({
      evidenceWindow: { from: "2026-08-08", to: "2026-09-06" },
    }), BINDINGS);
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.rejections).toContain("clock_invalid");
  });

  it("refuses a decrease that rounds to no change", () => {
    // A "decrease" that decreased nothing is a false statement in a journal.
    const result = validateBidIntent(input({
      direction: "decrease", percent: 5, observedBidMinorUnits: 1,
    }), BINDINGS);
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.rejections.some((code) =>
      code === "percent_math_inconsistent" || code === "proposal_not_positive")).toBe(true);
  });

  it("refuses an unresolvable currency", () => {
    const result = validateBidIntent(input({ currency: "ZZZ" }), BINDINGS);
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.rejections).toContain("currency_unresolvable");
  });

  it("returns a verdict for null rather than throwing", () => {
    // A thrown error is the absence of a verdict, and the caller then has to
    // guess which it was.
    expect(validateBidIntent(null, BINDINGS)).toMatchObject({
      status: "rejected", rejections: ["identity_unstable"],
    });
    expect(validateBidIntent(input(), null)).toMatchObject({ status: "rejected" });
  });

  it("reports every rejection, not the first", () => {
    const result = validateBidIntent(input({
      bidStrategyType: "lowest_cost", percent: 12, currency: "ZZZ",
    }), BINDINGS);
    if (result.status !== "rejected") throw new Error("expected rejection");
    expect(result.rejections.length).toBeGreaterThanOrEqual(3);
  });
});

describe("the canonical action refuses a bid payload in the wrong shape", () => {
  function action(overrides: Record<string, unknown> = {}) {
    const validated = validateBidIntent(input(), BINDINGS);
    if (validated.status !== "valid") throw new Error("expected valid");
    return {
      code: "tune",
      label: "Review ad set bid",
      intent: "review",
      targetLevel: "adset",
      providerMutation: null,
      scopeNote: "",
      bidIntent: validated.intent,
      ...overrides,
    } as never;
  }

  it("accepts the review shape", () => {
    expect(() => assertCanonicalDecisionAction(action())).not.toThrow();
  });

  it("refuses a bid action that claims to execute", () => {
    expect(() => assertCanonicalDecisionAction(action({ intent: "execute" })))
      .toThrow(/served for review/);
  });

  it("refuses a bid action carrying a provider mutation", () => {
    expect(() => assertCanonicalDecisionAction(action({ providerMutation: "apply_bid" })))
      .toThrow(/no provider mutation/);
  });

  it("refuses a campaign-grain bid action", () => {
    expect(() => assertCanonicalDecisionAction(action({ targetLevel: "campaign" })))
      .toThrow(/lives on an ad set/);
  });

  it("refuses an action carrying two typed payloads", () => {
    // Two payloads make "what is being proposed" a question with two answers,
    // and the queue would project a row for each.
    expect(() => assertCanonicalDecisionAction(action({
      budgetIntent: { kind: "budget_intent" },
    }))).toThrow(/both a budget and a bid payload/);
  });
});
