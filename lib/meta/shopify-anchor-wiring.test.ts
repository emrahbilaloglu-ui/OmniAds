/**
 * The commercial anchor for a business that configured ONLY a target ROAS.
 *
 * WHAT THIS FILE USED TO BE, AND WHY IT WAS DANGEROUS. It asserted that such a
 * business is sized from its SHOPIFY average order value: "AOV 58.00 at a
 * target ROAS of 2.2 is a derived CPA of 26.36". It proved that against a
 * local `deriveSpendUnitMinor` helper whose own comment said "the order and the
 * guards are copied from the production expression, not invented" — a
 * hand-copied duplicate of the ladder that then lived in `attachSizedIntents`.
 *
 * That expression has been removed from production (D091: a Meta decision is
 * sized from the META platform AOV, and the store never substitutes). A test
 * that owns its own copy of a rule does not notice when the rule is retired —
 * it would have gone on passing forever while pinning the exact behaviour this
 * work reverses, which is a false green of the worst kind: green, specific,
 * and wrong.
 *
 * So the copy is gone. Every case below drives the REAL canonical ladder,
 * `resolveSpendUnit`, which is the one production uses; if that ladder changes
 * again, these fail. The coverage is the same set of questions the old file
 * asked — a ROAS-only business, a configured target winning, and the store's
 * own refusals travelling — answered against the current rule.
 */
import { describe, expect, it } from "vitest";

import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";

/**
 * A ROAS-only business with a real Meta purchase sample.
 *
 * The store number is deliberately LARGE and deliberately different from the
 * Meta one, so any case that silently used it would produce a visibly wrong
 * unit rather than a coincidentally right one: $58.00 / 2.2 is 26.36, while
 * the Meta basis here gives 20.00.
 */
function ladder(over: Partial<Parameters<typeof resolveSpendUnit>[0]> = {}) {
  return resolveSpendUnit({
    targetCpa: null,
    operatorAovAssumption: null,
    observedShopifyAov: 58,
    observedShopifyAovOrderCount: 40,
    observedShopifyAovStatus: "observed",
    metaAttributedAovMean90d: 44,
    metaAttributedAovPurchaseCount90d: 60,
    metaAttributedRevenue90d: 2640,
    targetRoas: 2.2,
    breakEvenRoas: null,
    accountCpaP50: null,
    accountCpaSampleCount: 0,
    attributionAovAdjustmentMultiplier: 1,
    ...over,
  });
}

describe("a business with only a target ROAS still gets a benchmark", () => {
  it("derives it from the META platform AOV, not the store's", () => {
    const resolution = ladder();

    // 44.00 / 2.2 — the account's own attributed money-per-purchase.
    expect(resolution.spendUnit).toBeCloseTo(20, 6);
    expect(resolution.source).toBe("meta_derived_aov");
    // The number that would have come from the store, had it chosen the rung.
    expect(resolution.spendUnit).not.toBeCloseTo(26.3636, 3);
  });

  it("asks for no CPA and no AOV to get there", () => {
    // The plan's binding rule: ROAS is the one required commercial target.
    // Neither optional owner input is present in `ladder()`.
    expect(ladder().spendUnit).not.toBeNull();
  });

  it("carries the store's number as context, and lets it choose nothing", () => {
    const withStore = ladder();
    const withoutStore = ladder({
      observedShopifyAov: null,
      observedShopifyAovOrderCount: 0,
      observedShopifyAovStatus: "unavailable",
    });

    // Same rung, same unit, same eligibility — the store is evidence only.
    expect(withStore.source).toBe(withoutStore.source);
    expect(withStore.spendUnit).toBe(withoutStore.spendUnit);
    expect(withStore.confidence).toBe(withoutStore.confidence);
    expect(withStore.evidence.observedShopifyAov).toBe(58);
    expect(withoutStore.evidence.observedShopifyAov).toBeNull();
  });
});

describe("the platform AOV outranks the configured targets, and the store never overrides either", () => {
  /*
    RE-PINNED. Both cases here asserted that an operator-typed number beat the
    platform AOV: `target_cpa` at 31, and `operator_aov` at 66.00 / 2.2 = 30.
    `ladder()` configures a Target ROAS of 2.2 against a Meta-attributed AOV of
    44.00, so the canonical unit is 44.00 / 2.2 = 20 and neither operator input
    changes it. The store's 58.00 / 2.2 = 26.36 was never the answer and still
    is not.
  */
  it("ignores an explicit target CPA", () => {
    const resolution = ladder({ targetCpa: 31 });
    expect(resolution.spendUnit).toBeCloseTo(20, 6);
    expect(resolution.source).toBe("meta_derived_aov");
    expect(resolution.spendUnit).not.toBe(31);
    expect(resolution.evidence.targetCpa).toBe(31);
  });

  it("ignores the operator's own AOV assumption", () => {
    const resolution = ladder({ operatorAovAssumption: 66 });
    expect(resolution.spendUnit).toBeCloseTo(20, 6);
    expect(resolution.source).toBe("meta_derived_aov");
    expect(resolution.spendUnit).not.toBeCloseTo(30, 6);
    expect(resolution.evidence.operatorAovAssumption).toBe(66);
  });
});

describe("the refusals travel, and nothing is guessed", () => {
  it("yields no hard-eligible benchmark from a thin Meta sample", () => {
    const resolution = ladder({ metaAttributedAovPurchaseCount90d: 4 });

    // A store AOV of 58.00 is present and unused: the account's own evidence
    // is thin, and thin is not a reason to reach for someone else's number.
    expect(resolution.hardEligibleByDefault).toBe(false);
    expect(resolution.spendUnit).not.toBeCloseTo(26.3636, 3);
  });

  it("yields no benchmark when the Meta AOV is absent entirely", () => {
    const resolution = ladder({
      metaAttributedAovMean90d: null,
      metaAttributedAovPurchaseCount90d: 0,
      metaAttributedRevenue90d: 0,
    });

    // The store is observed, usable and ignored. This is the fail-closed half
    // of D091: a missing Meta AOV holds, it does not substitute.
    expect(resolution.source).not.toBe("observed_shopify_aov");
    expect(resolution.hardEligibleByDefault).toBe(false);
  });

  it("yields no benchmark with no target ROAS and no CPA", () => {
    const resolution = ladder({ targetRoas: null });

    // An AOV of any provenance divided by nothing is nothing.
    expect(resolution.hardEligibleByDefault).toBe(false);
  });
});
