import { describe, expect, it } from "vitest";

import { decideCreative } from "../../engine";
import { zeroConversionSpendFloor } from "../../gates/cut-policy";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

/*
  ADR D107 — a zero-purchase Cut waits for the zero-conversion spend floor on
  EVERY path.

  With no purchase, ROAS is 0 and so is the ratio, so a zero-purchase row
  always lands in the ratio branch's Cut zone. Its loss-budget predicate fired
  at commercial maturity (2 spend units on the balanced preset) while the
  dedicated zero-conversion rule — the one that exists to judge exactly this
  row — waited for its own floor (3 units). The same evidence therefore produced
  a Cut or not depending on which gate read it first.
*/

/** Balanced geometry with a 100 spend unit: maturity 200, zero-conv floor 300. */
const profile = makeAccountDecisionProfile({
  thresholds: {
    commercialMaturitySpend: 200,
    zeroConvBurnerSpend: 300,
    cutCandidateSpend: 400,
    sustainedLoserSpend: 300,
    hardCutSpend: 500,
  },
});

/** No funnel or click evidence either, so the row is coherent, not diagnosable. */
const NO_FUNNEL = {
  ctr: null,
  impressions: null,
  linkClicks: null,
  outboundClicks: null,
  landingPageViews: null,
  addToCart: null,
  initiateCheckout: null,
  thumbstop: null,
} as const;

function zeroPurchaseInput(
  overrides: Parameters<typeof makeCreativeInput>[0] = {},
) {
  return makeCreativeInput({
    ...NO_FUNNEL,
    purchases: 0,
    purchaseValue: 0,
    roas: 0,
    cpa: null,
    recent7dSpend: 80,
    recent7dPurchases: 0,
    recent7dRoas: 0,
    ageDays: 21,
    ...overrides,
  });
}

describe("zero-purchase Cut floor (ADR D107)", () => {
  it("is the zero-conversion floor, never below loss-budget maturity", () => {
    const ctx = makeGateContext({ input: zeroPurchaseInput(), profile });
    expect(zeroConversionSpendFloor(ctx, profile.thresholds)).toBe(300);
    const inverted = makeAccountDecisionProfile({
      thresholds: { commercialMaturitySpend: 350, zeroConvBurnerSpend: 300 },
    });
    expect(
      zeroConversionSpendFloor(
        makeGateContext({ input: zeroPurchaseInput(), profile: inverted }),
        inverted.thresholds,
      ),
    ).toBe(350);
  });

  it("does not Cut through the ratio branch between maturity and the zero-conversion floor", () => {
    const decision = decideCreative(zeroPurchaseInput({ spend: 250 }), profile);
    expect(decision.label).not.toBe("cut");
    expect(decision.preAuthorityLabel).not.toBe("cut");
    expect(decision.label).toBe("test_more");
    expect(decision.reason).toContain(
      "underperforming but spend not yet mature for hard cut",
    );
  });

  it("Cuts once the zero-conversion floor is reached", () => {
    const decision = decideCreative(zeroPurchaseInput({ spend: 310 }), profile);
    expect(decision.label).toBe("cut");
    expect(decision.reason).toBe(
      "0 purchases on 310 spend (28d cumulative, age 21d) — sustained zero-conversion burn past CPA-anchored maturity threshold 300.",
    );
  });

  it("holds a paused or unknown-status zero-purchase row below the floor too", () => {
    for (const effectiveStatus of ["PAUSED", null] as const) {
      const decision = decideCreative(
        zeroPurchaseInput({ spend: 250, effectiveStatus }),
        profile,
      );
      expect(decision.label).not.toBe("cut");
      expect(decision.preAuthorityLabel).not.toBe("cut");
    }
  });

  it("does not reach through the floor as a fatigued Refresh turned Cut on a Test campaign", () => {
    // The cut-zone fallback used to publish Refresh for a fatigued row, and a
    // Test campaign turns Refresh into Cut (test_cohort refresh->cut).
    for (const campaignKind of ["test", "main", null] as const) {
      const decision = decideCreative(
        zeroPurchaseInput({
          spend: 250,
          fatigueStatus: "fatigued",
          campaignKind,
          dataFreshnessHours: 1,
        }),
        profile,
      );
      expect(decision.label).not.toBe("cut");
      expect(decision.preAuthorityLabel).not.toBe("cut");
      expect(decision.label).toBe("test_more");
    }
  });

  it("leaves a converting loser's loss-budget Cut unchanged", () => {
    // One purchase: the floor is a zero-purchase rule and does not apply.
    const decision = decideCreative(
      makeCreativeInput({
        ...NO_FUNNEL,
        spend: 250,
        purchases: 1,
        purchaseValue: 50,
        roas: 0.2,
        cpa: 250,
        recent7dSpend: 80,
        recent7dPurchases: 0,
        recent7dRoas: 0,
        ageDays: 21,
      }),
      profile,
    );
    expect(decision.label).toBe("cut");
    expect(decision.reason).toContain("loss-budget maturity reached at 200");
  });
});
