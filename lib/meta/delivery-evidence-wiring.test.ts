import { describe, expect, it } from "vitest";

import {
  deliveryConstrainedAdsetIdsFrom,
  type MetaAnomaly,
} from "@/lib/meta/anomalies";
import { BID_SIZING_POLICY_VERSION, sizeBidChange } from "@/lib/meta/bid-sizing-policy";

/**
 * The evidence a bid increase needs, and where it comes from.
 *
 * A cap may only be RAISED when delivery is measurably limited — otherwise a
 * higher cap pays more for the same result. The snapshot passed an empty set
 * unconditionally, so no increase could ever be produced however well an ad set
 * qualified: the policy was correct and unreachable.
 *
 * The evidence is a projection of the `delivery_stall` anomaly the product
 * already detects, so the decision card and the bid intent cite ONE fact.
 */
function stall(overrides: Partial<MetaAnomaly> = {}): MetaAnomaly {
  return {
    id: "anom_1",
    type: "delivery_stall",
    scopeType: "adset",
    scopeId: "set_1",
    scopeLabel: "Prospecting",
    severity: "high",
    kind: "anomaly",
    title: "Delivery stall",
    detail: "",
    diagnostics: [],
    detectedAt: "2026-09-05T03:00:00.000Z",
    ...overrides,
  } as MetaAnomaly;
}

describe("the delivery-constraint set is a projection of the detector", () => {
  it("names the ad sets with a material stall", () => {
    const ids = deliveryConstrainedAdsetIdsFrom([
      stall({ scopeId: "set_1", severity: "high" }),
      stall({ id: "anom_2", scopeId: "set_2", severity: "medium" }),
    ]);
    expect([...ids].sort()).toEqual(["set_1", "set_2"]);
  });

  it("ignores a low-severity stall", () => {
    // Visible in the product, and not evidence enough to spend more per result.
    expect(deliveryConstrainedAdsetIdsFrom([stall({ severity: "low" })]).size)
      .toBe(0);
  });

  it("ignores every other anomaly type and grain", () => {
    expect(deliveryConstrainedAdsetIdsFrom([
      stall({ type: "cpm_spike" }),
      stall({ id: "a3", scopeType: "campaign", scopeId: "camp_1" }),
    ]).size).toBe(0);
  });
});

describe("the A2 worked case, through the real policy", () => {
  const base = {
    bidStrategyType: "cost_cap",
    // $12.00 cap.
    currentBidMinor: 1200,
    // $10.00 CPA benchmark.
    spendUnitMinor: 1000,
    // cpa28d = 4200 / 500 = $8.40, so q = 0.84.
    spend28d: 4200,
    purchases28d: 500,
    maturityOk: true,
    budgetChangeProposedSameWindow: false,
    hoursSinceLastChange: 48,
    changesLast7d: 0,
    policy: {
      budgetMinHoursBetweenChanges: 24,
      budgetMaxChangesPer7d: 3,
      bidSizingPolicyVersion: BID_SIZING_POLICY_VERSION,
    },
  };

  it("raises 12.00 to 13.20 when the stall is real", () => {
    const constrained = deliveryConstrainedAdsetIdsFrom([stall({ scopeId: "set_1" })]);

    const outcome = sizeBidChange({
      ...base,
      deliveryConstrained: constrained.has("set_1"),
    });

    expect(outcome.status).toBe("sized");
    if (outcome.status !== "sized") return;
    expect(outcome.direction).toBe("increase");
    // q = 0.84 falls in the 0.75–0.90 band: a 10% rung.
    expect(outcome.percent).toBe(10);
    expect(outcome.proposedBidMinor).toBe(1320);
  });

  it("withholds the same case when no stall was detected", () => {
    /*
      Same ad set, same numbers, no evidence. This is the state the product was
      permanently in — and the state it must return to the moment delivery
      recovers.
    */
    const constrained = deliveryConstrainedAdsetIdsFrom([]);

    const outcome = sizeBidChange({
      ...base,
      deliveryConstrained: constrained.has("set_1"),
    });

    expect(outcome.status).toBe("withheld");
    if (outcome.status !== "withheld") return;
    expect(outcome.code).toBe("no_delivery_constraint");
  });

  it("withholds when the stall is about a DIFFERENT ad set", () => {
    const constrained = deliveryConstrainedAdsetIdsFrom([
      stall({ scopeId: "set_other" }),
    ]);
    const outcome = sizeBidChange({
      ...base,
      deliveryConstrained: constrained.has("set_1"),
    });
    expect(outcome.status).toBe("withheld");
  });
});
