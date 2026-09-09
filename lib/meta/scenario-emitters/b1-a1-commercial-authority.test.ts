/**
 * B1 AND A1 ARE COMMERCIAL PURCHASE ACTIONS, AND WERE NOT TREATED AS ONE.
 *
 * ── ROUND 17 ────────────────────────────────────────────────────────────────
 * Both emit `decisionState: "act"` on purchase campaigns and both decided what
 * the account should PAY, from evidence the commercial rule says cannot
 * authorise a payment:
 *
 *   B1 raised a bid cap on a RATIO alone — ROAS above the calibrated p50 and
 *   the configured scale floor. A percentile comparison is not a value, so an
 *   account with missing, thin, or wrong-account Meta-attributed AOV could
 *   still be told to raise what it pays per purchase.
 *
 *   A1 asked "can this budget fund 50 conversions a week?" and divided by
 *   `cpa_28d.p50` — the account's OBSERVED cost percentile — even under a
 *   positive Target ROAS. Under that governing target the only admissible unit
 *   is READY same-account, same-cutoff Meta-attributed AOV over the ratio, and
 *   an observed CPA is descriptive rather than authoritative.
 *
 * The rule these restore, in full: with a positive Target ROAS the canonical
 * spend unit is the ONLY authority; Target CPA, operator AOV and Shopify AOV
 * stay inert; a missing or thin sample is a HOLD, never a downgrade to a
 * weaker anchor. Without a positive Target ROAS the legacy CPA compatibility
 * path is preserved exactly.
 */
import { describe, expect, it } from "vitest";

import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import { META_CONFIDENCE_ACT_THRESHOLD } from "@/lib/meta/confidence-thresholds";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import {
  META_RECENT_EDIT_AUTHORITY_KEY,
  metaRecentEditAuthorityRecord,
} from "@/lib/meta/recent-edit-authority";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import {
  maybeA1MathFloor,
  maybeB1CappedBidRaise,
} from "@/lib/meta/scenario-emitters/high-priority";

const AS_OF = "2026-09-05";

/** A trusted, fully attestable recent-edit authority: never the thing under test here. */
const READY_EDIT_AUTHORITY = metaRecentEditAuthorityRecord({
  status: "ready",
  reason: "observed",
  timeZone: "America/Los_Angeles",
});

function signal(over: Partial<MetaEntityDecisionSignal> = {}): MetaEntityDecisionSignal {
  return {
    businessId: "biz_1",
    providerAccountId: "act_1",
    scopeType: "campaign",
    scopeId: "cmp_1",
    asOfDate: AS_OF,
    learningState: "LEARNING",
    daysAtLearningState: 5,
    lastSignificantEditAt: null,
    daysSinceSignificantEdit: 30,
    recentChangeCooldownUntil: null,
    creativeAgeDays: 40,
    creativeAgeDaysMax: 40,
    frequencyP80: null,
    ctrDecayPct: null,
    sourceJson: { [META_RECENT_EDIT_AUTHORITY_KEY]: READY_EDIT_AUTHORITY },
    qualityStatus: "ready",
    ...over,
  };
}

/** `cpaP50` is varied on its own so the permutation tests can isolate it. */
function context(cpaP50 = 90): MetaCalibrationContext {
  return {
    thresholds: {
      source: "calibrated",
      hardCutSpend: 200,
      minRequiredSample: 8,
      metrics: {
        ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
        roas_28d: { p10: 0.5, p25: 1.2, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
        cpa_28d: {
          p10: cpaP50 / 2,
          p25: cpaP50 * 0.8,
          p50: cpaP50,
          p75: cpaP50 * 1.3,
          p90: cpaP50 * 2,
          sampleSize: 20,
        },
      },
    },
    scope: { type: "campaign", id: "cmp_1", snapshotDate: AS_OF, cohort: "purchase" },
    cohort: "purchase",
  };
}

/**
 * Target ROAS 2.2 with a READY 60-purchase Meta AOV of 180.
 * Canonical unit = 180 / 2.2 = 81.8181…, i.e. 8182 minor units.
 */
const READY_TARGETS = {
  source: "configured_targets" as const,
  targetRoas: 2.2,
  breakEvenRoas: 1.5,
  // Present and must stay INERT under a positive Target ROAS.
  targetCpa: 120,
  breakEvenCpa: 160,
  riskPosture: "balanced" as const,
  freshness: "fresh" as const,
  updatedAt: "2026-09-01T00:00:00.000Z",
  metaAttributedAov: { aovMean: 180, purchaseCount: 60 },
};
const CANONICAL_UNIT_MINOR = Math.round((180 / 2.2) * 100);

function campaignRow(over: Record<string, unknown> = {}) {
  return {
    id: "cmp_1",
    name: "Capped winner",
    status: "ACTIVE",
    objective: "OUTCOME_SALES",
    currency: "USD",
    bidStrategyType: "cost_cap",
    bidValue: 5_000,
    bidValueFormat: "currency",
    manualBidAmount: null,
    dailyBudget: 50_000,
    lifetimeBudget: null,
    isBudgetMixed: false,
    spend: 1_000,
    purchases: 20,
    revenue: 6_800,
    roas: 3.4,
    cpa: 100,
    ctr: 2,
    cpm: 30,
    impressions: 60_000,
    clicks: 1_200,
    frequency: 1.4,
    ageDays: 40,
    activeDayCount: 40,
    firstDeliveryDate: "2026-07-27",
    asOfDate: AS_OF,
    ...over,
  };
}

const windowFor = (over: Record<string, unknown> = {}) =>
  ({
    selected: campaignRow(over),
    last30: campaignRow({ spend: 1_000, ...over }),
    last90: campaignRow(over),
    last7: campaignRow(over),
  }) as never;

/**
 * ── ROUND 18, ITEM B5 ───────────────────────────────────────────────────────
 * Canonical units per currency, computed from the ISO 4217 exponent rather than
 * a hard-coded 100. Target ROAS 2.2 with a READY Meta AOV of 180 in the
 * account's own major units:
 *
 *   USD (exponent 2): 81.8181... -> 8182 minor
 *   JPY (exponent 0): 81.8181... ->   82 minor
 *   KWD (exponent 3): 81.8181... -> 81818 minor
 */
const unitMinorFor = (exponent: number) =>
  Math.round((180 / 2.2) * 10 ** exponent);

const b1 = (targets: unknown, over: Record<string, unknown> = {}, cpaP50 = 90) =>
  maybeB1CappedBidRaise({
    window: windowFor(over),
    context: context(cpaP50),
    cohort: "purchase",
    commercialTargets: targets,
    signals: signal(),
  } as never);

const a1 = (targets: unknown, cpaP50 = 90, over: Record<string, unknown> = {}) =>
  maybeA1MathFloor({
    window: windowFor(over),
    context: context(cpaP50),
    cohort: "purchase",
    commercialTargets: targets,
    signals: signal(),
  } as never);

describe("B1 bid-cap raise is authorised by a value, not by a ratio", () => {
  it("ACTS on READY same-account AOV, and constrains the proposal to the unit", () => {
    // The positive control. Bid 5000, +10% = 5500, which is under the canonical
    // 8182, so the ordinary band survives untouched.
    const rec = b1(READY_TARGETS);
    expect(rec?.type).toBe("scenario_b1_capped_winner_bid_raise");
    expect(rec?.decisionState).toBe("act");
    expect((rec?.targetValue as { bid: { proposed: number } }).bid.proposed).toBe(5_500);
  });

  it("CLIPS a proposal that would exceed what one purchase may cost", () => {
    /*
      Bid 8000, +10% = 8800 — above the canonical 8182. A ratio alone would
      happily authorise it; the unit is what one purchase may cost at the
      configured Target ROAS, so the proposal is clipped rather than granted.
    */
    const rec = b1(READY_TARGETS, { bidValue: 8_000 });
    expect((rec?.targetValue as { bid: { proposed: number; range: { high: number } } }).bid.proposed).toBe(
      CANONICAL_UNIT_MINOR,
    );
    expect((rec?.targetValue as { bid: { range: { high: number } } }).bid.range.high).toBeLessThanOrEqual(
      CANONICAL_UNIT_MINOR,
    );
  });

  it("HOLDS when the cap already has no headroom under the unit", () => {
    // Bid already at/above the canonical unit: raising it is an instruction to
    // overpay, so there is nothing to propose.
    expect(b1(READY_TARGETS, { bidValue: 8_200 })).toBeNull();
  });

  it.each([
    ["a MISSING Meta AOV", { metaAttributedAov: null }],
    ["a THIN Meta AOV sample", { metaAttributedAov: { aovMean: 180, purchaseCount: 4 } }],
    ["a below-threshold sample", { metaAttributedAov: { aovMean: 180, purchaseCount: 19 } }],
    ["a non-positive AOV", { metaAttributedAov: { aovMean: 0, purchaseCount: 60 } }],
  ])("HOLDS VISIBLY with no proposal on %s", (_label, over) => {
    /*
      ── ROUND 19, ITEM B4 ──────────────────────────────────────────────────
      A silent `null` removed the entity from the queue: an account whose Meta
      AOV went thin looked identical to one with no finding at all. A refusal is
      a decision, so it is emitted as a visible watch — and carries NO
      `targetValue` and NO proposed action, so nothing can execute it.
    */
    const rec = b1({ ...READY_TARGETS, ...over });
    expect(rec).not.toBeNull();
    expect(rec?.type).toBe("scenario_b1_capped_winner_bid_raise");
    expect(rec?.decisionState).toBe("watch");
    expect(rec?.targetValue ?? null).toBeNull();
    expect((rec as { proposedAction?: unknown }).proposedAction ?? null).toBeNull();
    expect(rec?.signalQuality?.hard_action_authority).toBe("blocked");
    expect(rec?.confidence).not.toBe("high");
    expect(rec?.confidenceScore).toBeLessThan(META_CONFIDENCE_ACT_THRESHOLD);
  });

  it("does NOT accept Target CPA as a substitute when the AOV is missing", () => {
    /*
      The inertness control. `targetCpa` and `breakEvenCpa` are present and
      positive in every fixture here; under a positive Target ROAS they must
      authorise nothing — the result is a HOLD, not a CPA-sized proposal.
    */
    const rec = b1({
      ...READY_TARGETS,
      metaAttributedAov: null,
      targetCpa: 40,
      breakEvenCpa: 50,
    });
    expect(rec?.decisionState).toBe("watch");
    expect(rec?.targetValue ?? null).toBeNull();
  });

  it("is INVARIANT to the observed CPA percentile", () => {
    // Same targets, same AOV, wildly different account CPA percentiles.
    const verdicts = [10, 90, 400].map((cpaP50) => {
      const rec = b1(READY_TARGETS, {}, cpaP50);
      return {
        type: rec?.type ?? null,
        proposed: (rec?.targetValue as { bid?: { proposed: number } })?.bid?.proposed ?? null,
      };
    });
    expect(verdicts[1]).toEqual(verdicts[0]);
    expect(verdicts[2]).toEqual(verdicts[0]);
  });
});

describe("A1 learning floor is sized from the canonical unit", () => {
  it("EMITS under a positive Target ROAS with READY AOV", () => {
    // budget 500/day * 7 = 3500 weekly, over a unit of 81.82 = 42.8 < 50.
    const rec = a1(READY_TARGETS);
    expect(rec?.type).toBe("scenario_a1_math_floor_unmet");
    expect(rec?.decisionState).toBe("act");
  });

  it("is INVARIANT to cpa_28d.p50 while a Target ROAS governs", () => {
    /*
      THE DISCRIMINATING CASE. At a CPA p50 of 10 the old arithmetic computes
      3500 / 10 = 350 weekly conversions — far above the 50 floor — and emits
      NOTHING. The canonical unit does not move, so neither does the verdict.
    */
    const cheap = a1(READY_TARGETS, 10);
    const dear = a1(READY_TARGETS, 400);
    const middle = a1(READY_TARGETS, 90);
    expect(cheap?.type).toBe("scenario_a1_math_floor_unmet");
    expect(dear?.type).toBe(cheap?.type);
    expect(middle?.type).toBe(cheap?.type);
    // And the published proposal is identical too, not merely the verdict.
    expect(JSON.stringify(dear?.targetValue)).toBe(JSON.stringify(cheap?.targetValue));
    expect(JSON.stringify(middle?.targetValue)).toBe(JSON.stringify(cheap?.targetValue));
  });

  it.each([
    ["a MISSING Meta AOV", { metaAttributedAov: null }],
    ["a THIN Meta AOV sample", { metaAttributedAov: { aovMean: 180, purchaseCount: 4 } }],
  ])("HOLDS VISIBLY on %s rather than falling back to the CPA percentile", (_label, over) => {
    // A CPA p50 that WOULD have emitted is present, so this fails if the
    // Target ROAS path can drop into the legacy ladder.
    const rec = a1({ ...READY_TARGETS, ...over }, 90);
    expect(rec?.type).toBe("scenario_a1_math_floor_unmet");
    expect(rec?.decisionState).toBe("watch");
    expect(rec?.targetValue ?? null).toBeNull();
    expect(rec?.signalQuality?.hard_action_authority).toBe("blocked");
    expect(rec?.confidence).not.toBe("high");
    expect(rec?.confidenceScore).toBeLessThan(META_CONFIDENCE_ACT_THRESHOLD);
  });

  it("PRESERVES the legacy CPA path when no Target ROAS governs", () => {
    /*
      Backwards compatibility is the other half of the rule. With no positive
      Target ROAS the account has not told us how it measures value, and the
      observed CPA percentile remains the anchor exactly as before.
    */
    const legacy = {
      ...READY_TARGETS,
      targetRoas: null,
      breakEvenRoas: null,
      metaAttributedAov: null,
    };
    expect(a1(legacy, 90)?.type).toBe("scenario_a1_math_floor_unmet");
    // And it is genuinely CPA-sensitive there, which is what makes the
    // invariance assertions above mean something.
    expect(a1(legacy, 5)).toBeNull();
  });
});


describe("B1 minor-unit arithmetic is currency-correct", () => {
  it.each([
    ["USD", 2, 5_000, 5_500],
    // JPY has NO minor unit. The old /100 read a 1000-yen cap as 10.00 and
    // compared it against a unit scaled by 100 — wrong by two orders.
    ["JPY", 0, 50, 55],
    // KWD has THREE. The old code was wrong by a factor of ten the other way.
    ["KWD", 3, 50_000, 55_000],
  ])("raises a %s cap by 10%% in real minor units", (currency, exponent, bid, expected) => {
    const rec = b1(READY_TARGETS, { currency, bidValue: bid });
    const proposal = rec?.targetValue as
      | { bid: { current: number; proposed: number; minorUnitExponent: number } }
      | undefined;
    expect(proposal?.bid.current).toBe(bid);
    expect(proposal?.bid.proposed).toBe(Math.min(expected, unitMinorFor(exponent)));
    expect(proposal?.bid.minorUnitExponent).toBe(exponent);
  });

  it("clips to the canonical unit in the account's own exponent", () => {
    // JPY unit is 82 minor. A cap of 80 raised 10% would be 88 — above it.
    const rec = b1(READY_TARGETS, { currency: "JPY", bidValue: 80 });
    const proposal = rec?.targetValue as { bid: { proposed: number } } | undefined;
    expect(proposal?.bid.proposed).toBe(unitMinorFor(0));
  });

  it("rounds an odd integer minor amount half-up, once", () => {
    // 4999 + 10% = 5498.9 -> 5499, not 5498 and not a float.
    const rec = b1(READY_TARGETS, { bidValue: 4_999 });
    const proposal = rec?.targetValue as { bid: { proposed: number } } | undefined;
    expect(proposal?.bid.proposed).toBe(5_499);
    expect(Number.isSafeInteger(proposal?.bid.proposed)).toBe(true);
  });

  it.each([
    ["an unknown code", "XYZ"],
    ["a retired code", "TRL"],
    ["an absent currency", null],
    ["a non-code string", "dollars"],
  ])("FAILS CLOSED on %s", (_label, currency) => {
    /*
      Without a resolved exponent the minor amount cannot be scaled at all, and
      a bid cap published at the wrong magnitude is an executable instruction.
      The registry refuses rather than assuming two decimals.
    */
    expect(b1(READY_TARGETS, { currency })).toBeNull();
  });

  it("rejects a non-integer or non-positive bid", () => {
    for (const bidValue of [0, -5_000, 12.5, Number.MAX_SAFE_INTEGER + 2]) {
      expect(b1(READY_TARGETS, { bidValue }), String(bidValue)).toBeNull();
    }
  });
});

describe("B1 accepts only real currency bid strategies", () => {
  it.each(["cost_cap", "bid_cap", "manual_bid"])("accepts %s", (bidStrategyType) => {
    const rec = b1(READY_TARGETS, {
      bidStrategyType,
      // `manual_bid` carries the amount on the same field in this fixture shape.
      bidValue: 5_000,
    });
    expect(rec?.type).toBe("scenario_b1_capped_winner_bid_raise");
  });

  it.each(["target_roas", "minimum_roas"])("REJECTS %s, whose value is a ratio", (bidStrategyType) => {
    /*
      `bidValue` on these strategies is a ROAS target, not money. Accepting them
      read 2.5 as a minor-unit amount and published a bid cap of 2.75 units —
      a nonsense instruction the operator could execute.
    */
    expect(b1(READY_TARGETS, { bidStrategyType, bidValue: 2.5 })).toBeNull();
    // And not merely because the value is fractional: an integer ratio is
    // refused on the strategy alone.
    expect(b1(READY_TARGETS, { bidStrategyType, bidValue: 3 })).toBeNull();
  });

  it("REJECTS a roas-format value even on a cap strategy", () => {
    expect(
      b1(READY_TARGETS, { bidStrategyType: "cost_cap", bidValueFormat: "roas" }),
    ).toBeNull();
  });
});

describe("A1 does not require a CPA under a positive Target ROAS", () => {
  it("EMITS with no cpa_28d metric at all when the AOV is READY", async () => {
    /*
      ── ROUND 18, ITEM B7 ──────────────────────────────────────────────────
      The `cpa_28d` lookup used to gate the whole scenario, so an account
      governed by a Target ROAS was silently skipped whenever its CPA
      percentile was absent — a value it is not permitted to use anyway.
    */
    const { LEGACY_META_CALIBRATION_THRESHOLDS: legacy } = await import(
      "@/lib/meta/calibration"
    );
    const withoutCpa = {
      thresholds: {
        source: "calibrated" as const,
        hardCutSpend: 200,
        minRequiredSample: 8,
        metrics: {
          ...legacy.metrics,
          roas_28d: { p10: 0.5, p25: 1.2, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
          cpa_28d: undefined as never,
        },
      },
      scope: { type: "campaign" as const, id: "cmp_1", snapshotDate: AS_OF, cohort: "purchase" as const },
      cohort: "purchase" as const,
    };
    const rec = maybeA1MathFloor({
      window: windowFor(),
      context: withoutCpa,
      cohort: "purchase",
      commercialTargets: READY_TARGETS,
      signals: signal(),
    } as never);
    expect(rec?.type).toBe("scenario_a1_math_floor_unmet");
    // And the explanation names the unit that actually produced the verdict.
    const label = rec?.evidence.find((item) =>
      String(item.label).includes("Purchase value unit"),
    );
    expect(label).toBeTruthy();
  });

  it("still REQUIRES a CPA on the no-Target-ROAS legacy branch", async () => {
    const { LEGACY_META_CALIBRATION_THRESHOLDS: legacy } = await import(
      "@/lib/meta/calibration"
    );
    const withoutCpa = {
      thresholds: {
        source: "calibrated" as const,
        hardCutSpend: 200,
        minRequiredSample: 8,
        metrics: { ...legacy.metrics, cpa_28d: undefined as never },
      },
      scope: { type: "campaign" as const, id: "cmp_1", snapshotDate: AS_OF, cohort: "purchase" as const },
      cohort: "purchase" as const,
    };
    const rec = maybeA1MathFloor({
      window: windowFor(),
      context: withoutCpa,
      cohort: "purchase",
      commercialTargets: {
        ...READY_TARGETS,
        targetRoas: null,
        breakEvenRoas: null,
        metaAttributedAov: null,
      },
      signals: signal(),
    } as never);
    expect(rec).toBeNull();
  });
});

describe("budget major-unit conversion is currency-correct", () => {
  /*
    ── ROUND 19, ITEM B3 ──────────────────────────────────────────────────────
    `budgetAmount` divided EVERY provider budget by 100 while `spend` arrives in
    major units, so `budgetUtilization` and A1's weekly-conversion floor were
    wrong by 10x or 100x outside two-decimal currencies:

      JPY (exponent 0): a 50,000-yen budget read as 500 -> utilization 100x too
      HIGH, so B1's `< 0.95` gate refused every Japanese account;
      KWD (exponent 3): a 50.000-dinar budget read as 500 instead of 50 ->
      utilization 10x too LOW and A1's floor overstated by the same factor.

    Each case below sits on the far side of a threshold under the old
    arithmetic and on the near side under the new one, so it discriminates.
  */
  it("JPY: B1 sees real utilization instead of a 100x overstatement", () => {
    /*
      Daily budget 50,000 JPY (exponent 0 -> 50,000 major). 30-day spend
      750,000 -> 25,000/day -> utilization 0.5, which is under the 0.95 gate.
      Under /100 the budget read as 500, utilization 50.0, and B1 refused.
    */
    const rec = b1(READY_TARGETS, {
      currency: "JPY",
      bidValue: 50,
      dailyBudget: 50_000,
      spend: 750_000,
    });
    expect(rec?.type).toBe("scenario_b1_capped_winner_bid_raise");
    expect(rec?.decisionState).toBe("act");
    const utilization = rec?.evidence.find(
      (item) => item.label === "Budget utilization",
    )?.value;
    expect(utilization).toBe("50%");
  });

  it("KWD: B1 sees real utilization instead of a 10x understatement", () => {
    /*
      Daily budget 50,000 fils (exponent 3 -> 50.000 KWD). 30-day spend 1,500
      -> 50/day -> utilization 1.0, which is AT the 0.95 ceiling and must be
      refused. Under /100 the budget read as 500 and utilization 0.1 passed.
    */
    const rec = b1(READY_TARGETS, {
      currency: "KWD",
      bidValue: 50_000,
      dailyBudget: 50_000,
      spend: 1_500,
    });
    expect(rec).toBeNull();
  });

  it.each([
    ["an unknown code", "XYZ"],
    ["a retired code", "TRL"],
  ])("fails closed on %s rather than assuming two decimals", (_label, currency) => {
    // No exponent means no major-unit budget, and every caller treats a null
    // budget as "no budget".
    expect(b1(READY_TARGETS, { currency, dailyBudget: 50_000 })).toBeNull();
  });

  it("JPY: A1's 50-conversion floor is decided on the real budget", () => {
    /*
      Unit = 180 / 2.2 = 81.82 (major units, whatever the currency). A daily
      budget of 500 JPY funds 500*7/81.82 = 42.8 weekly conversions -> under
      the 50 floor, so A1 EMITS.

      Under /100 the budget read as 5, giving 0.43 — still under 50, so the
      verdict happened to agree. The discriminating case is the one below.
    */
    const rec = a1(READY_TARGETS, 90, { currency: "JPY", dailyBudget: 500 });
    expect(rec?.type).toBe("scenario_a1_math_floor_unmet");
  });

  it("JPY: a budget that DOES clear the floor no longer looks like one that does not", () => {
    /*
      THE DISCRIMINATOR. 1,000 JPY/day funds 1000*7/81.82 = 85.6 weekly
      conversions — above the 50 floor — so A1 must emit NOTHING. Under /100 the
      budget read as 10, giving 0.86, and A1 wrongly reported the learning floor
      as unreachable on an account that clears it.
    */
    const rec = a1(READY_TARGETS, 90, { currency: "JPY", dailyBudget: 1_000 });
    expect(rec).toBeNull();
  });

  it("KWD: the same floor is decided three decimal places over", () => {
    // 1,000,000 fils = 1000.000 KWD/day -> 1000*7/81.82 = 85.6 -> above the
    // floor, so nothing is emitted. Under /100 it read as 10,000 and also
    // cleared; the failing direction is a SMALL budget read as large.
    expect(
      a1(READY_TARGETS, 90, { currency: "KWD", dailyBudget: 1_000_000 }),
    ).toBeNull();
    // 100,000 fils = 100.000 KWD/day -> 8.56 weekly -> under the floor, emits.
    // Under /100 it read as 1000 -> 85.6 -> cleared, and A1 stayed silent on an
    // account that genuinely cannot reach the floor.
    expect(
      a1(READY_TARGETS, 90, { currency: "KWD", dailyBudget: 100_000 })?.type,
    ).toBe("scenario_a1_math_floor_unmet");
  });
});
describe("B1 checks its OWN eligibility before it checks AOV authority", () => {
  /*
    ── ROUND 20, ITEM 2 ───────────────────────────────────────────────────────

    The AOV authority used to be consulted first. On an account with a missing
    or thin Meta AOV that turned every campaign this emitter merely looked at
    into a B1 "bid headroom cannot be sized" watch -- campaigns with no bid, no
    budget, ROAS under the threshold, no delivery evidence, or a cap already
    fully utilised. None of them are B1 candidates, so the watch was false, and
    it consumed the slot the precedence chain would have given to C1, A1 or J1.

    Each case below is asserted under BOTH a thin AOV and a READY one. The thin
    leg is the regression: before the reorder it returned a watch. The READY leg
    proves the gate itself is real and the case is not passing merely because
    the authority moved -- an eligible campaign with a READY AOV does act, and
    the positive control at the end of this block shows it.
  */
  const THIN_TARGETS = {
    ...READY_TARGETS,
    metaAttributedAov: { aovMean: 180, purchaseCount: 4 },
  };

  it.each([
    // threshold = max(roas_28d.p50 = 2, scale floor = targetRoas 2.2) = 2.2
    ["ROAS below the scale threshold", { roas: 1.9 }],
    ["no budget of any kind", { dailyBudget: null, lifetimeBudget: null }],
    ["no bid on a cap strategy", { bidValue: null, manualBidAmount: null }],
    // 15000 / 30 days / 500 major = 1.0 utilization
    ["a budget already fully utilised", { spend: 15_000 }],
  ])("returns NULL for %s, under a thin AOV and a ready one", (_label, over) => {
    expect(b1(THIN_TARGETS, over)).toBeNull();
    expect(b1(READY_TARGETS, over)).toBeNull();
  });

  it("returns NULL with no delivery window, under a thin AOV and a ready one", () => {
    /*
      `windowFor` always supplies `last30`, so the absent-delivery case has to
      be built directly. Everything else about the row is the eligible fixture.
    */
    const noDelivery = (targets: unknown) =>
      maybeB1CappedBidRaise({
        window: {
          selected: campaignRow(),
          last30: undefined,
          last90: campaignRow(),
          last7: campaignRow(),
        },
        context: context(),
        cohort: "purchase",
        commercialTargets: targets,
        signals: signal(),
      } as never);
    expect(noDelivery(THIN_TARGETS)).toBeNull();
    expect(noDelivery(READY_TARGETS)).toBeNull();
  });

  it("STILL holds visibly for an otherwise-valid candidate whose AOV is thin", () => {
    /*
      The non-vacuity control for the whole block. The four negative cases above
      would also pass if B1 had simply been broken; this one proves the emitter
      still reaches its authority check, and that a real candidate's refusal is
      a visible watch carrying nothing executable.
    */
    const rec = b1(THIN_TARGETS);
    expect(rec).not.toBeNull();
    expect(rec?.type).toBe("scenario_b1_capped_winner_bid_raise");
    expect(rec?.decisionState).toBe("watch");
    expect(rec?.targetValue ?? null).toBeNull();
    expect((rec as { proposedAction?: unknown }).proposedAction ?? null).toBeNull();
  });

  it("and ACTS on that same candidate once the AOV is READY", () => {
    // The other half of the discriminator: the fixture used by every negative
    // case is genuinely eligible, so the nulls above come from the named gate.
    const rec = b1(READY_TARGETS);
    expect(rec?.decisionState).toBe("act");
    expect(
      (rec?.targetValue as { bid?: { proposed: number } })?.bid?.proposed,
    ).toBeGreaterThan(5_000);
  });
});
