import { describe, expect, it } from "vitest";

import {
  BID_SIZING_POLICY_VERSION,
  isBidCapStrategy,
  sizeBidChange,
  type BidSizingInput,
} from "@/lib/meta/bid-sizing-policy";

function eligible(overrides: Partial<BidSizingInput> = {}): BidSizingInput {
  return {
    bidStrategyType: "cost_cap",
    currentBidMinor: 1200,
    spendUnitMinor: 1000,
    currencyExponent: 2,
    spend28d: 840,
    purchases28d: 100,
    maturityOk: true,
    deliveryConstrained: true,
    budgetChangeProposedSameWindow: false,
    hoursSinceLastChange: 96,
    changesLast7d: 0,
    policy: {
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 2,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    },
    ...overrides,
  };
}

describe("bid cap sizing", () => {
  it("raises a constrained cap that is under the benchmark", () => {
    // cpa $8.40 against a $10.00 benchmark is 0.84x → the 0.75..0.90 band.
    const outcome = sizeBidChange(eligible());
    expect(outcome).toMatchObject({
      status: "sized",
      direction: "increase",
      percent: 10,
      proposedBidMinor: 1320,
    });
  });

  it("will not raise a cap that is not holding delivery back", () => {
    const outcome = sizeBidChange(eligible({ deliveryConstrained: false }));
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "no_delivery_constraint",
    });
  });

  it("lowers a cap that is running above the benchmark", () => {
    const outcome = sizeBidChange(
      eligible({ spend28d: 1500, purchases28d: 100, deliveryConstrained: false }),
    );
    // 15.00 / 10.00 = 1.5x → the ≥1.4 band.
    expect(outcome).toMatchObject({
      status: "sized",
      direction: "decrease",
      percent: 15,
      proposedBidMinor: 1020,
    });
  });

  it("proposes nothing while the cap is where it should be", () => {
    const outcome = sizeBidChange(eligible({ spend28d: 1000, purchases28d: 100 }));
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "within_cpa_dead_band",
    });
  });

  it("produces no intent for a strategy with no writable bid amount", () => {
    for (const bidStrategyType of ["lowest_cost", "LOWEST_COST_WITHOUT_CAP", null]) {
      expect(sizeBidChange(eligible({ bidStrategyType }))).toMatchObject({
        status: "withheld",
        code: "bid_strategy_not_writable",
      });
    }
  });

  it("does not assume manual_bid is a provider strategy", () => {
    // Two accounts carry it in retained rows. Whether it owns a writable bid
    // amount is settled by the provider read at write time, not by this list.
    expect(isBidCapStrategy("manual_bid")).toBe(false);
    expect(sizeBidChange(eligible({ bidStrategyType: "manual_bid" }))).toMatchObject({
      status: "withheld",
      code: "bid_strategy_not_writable",
    });
  });

  it("recognises the cap family case-insensitively", () => {
    expect(isBidCapStrategy("COST_CAP")).toBe(true);
    expect(isBidCapStrategy(" bid_cap ")).toBe(true);
  });

  it("changes one lever at a time", () => {
    const outcome = sizeBidChange(
      eligible({ budgetChangeProposedSameWindow: true }),
    );
    expect(outcome).toMatchObject({
      status: "withheld",
      code: "sibling_change_same_window",
    });
  });

  it("shares the budget cooldown rather than inventing a second clock", () => {
    const outcome = sizeBidChange(eligible({ hoursSinceLastChange: 9 }));
    expect(outcome).toMatchObject({ status: "withheld", code: "policy_cooldown_active" });
    expect(outcome.status === "withheld" && outcome.detail).toContain("15 hours");
  });

  it("refuses without a benchmark to judge the cap against", () => {
    expect(sizeBidChange(eligible({ spendUnitMinor: null }))).toMatchObject({
      status: "withheld",
      code: "spend_unit_unavailable",
    });
  });

  it("reads a JPY account at its own scale rather than assuming two decimals", () => {
    /*
      ¥1,500 cost per purchase against a ¥3,000 benchmark: half of it, and
      delivery is constrained, so the cap goes up.

      JPY has exponent 0, so both numbers are already minor units. Scaling the
      CPA by a hardcoded 100 made it ¥150,000 — fifty times the benchmark —
      and the policy cut a cap it should have raised, on an account where the
      executor would have written that amount.
    */
    const outcome = sizeBidChange(eligible({
      currencyExponent: 0,
      spendUnitMinor: 3000,
      spend28d: 150_000,
      purchases28d: 100,
      currentBidMinor: 500,
    }));
    expect(outcome).toMatchObject({
      status: "sized",
      direction: "increase",
      percent: 15,
      proposedBidMinor: 575,
    });
  });

  it("reads a KWD account at its own scale rather than assuming two decimals", () => {
    /*
      The same error in the other direction. KWD has exponent 3: 3.000 KWD per
      purchase against a 2.000 KWD benchmark is 1.5x and the cap comes down.
      A hardcoded 100 understated the CPA tenfold to 0.15x, which reads as a
      constrained ad set running cheap — a 15% RAISE.
    */
    const outcome = sizeBidChange(eligible({
      currencyExponent: 3,
      spendUnitMinor: 2000,
      spend28d: 300,
      purchases28d: 100,
      currentBidMinor: 4000,
    }));
    expect(outcome).toMatchObject({
      status: "sized",
      direction: "decrease",
      percent: 15,
      proposedBidMinor: 3400,
    });
  });

  it("refuses when the account currency has no known scale", () => {
    // The ISO registry fails closed on codes it has not transcribed; so does
    // this, rather than comparing two numbers at different scales.
    expect(sizeBidChange(eligible({ currencyExponent: null }))).toMatchObject({
      status: "withheld",
      code: "currency_unresolvable",
    });
  });

  it("refuses without a policy version bound to this business", () => {
    expect(
      sizeBidChange(
        eligible({
          policy: { ...eligible().policy, bidSizingPolicyVersion: null },
        }),
      ),
    ).toMatchObject({ status: "withheld", code: "sizing_policy_version_unbound" });
  });
});
