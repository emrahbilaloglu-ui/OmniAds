import { describe, expect, it } from "vitest";
import {
  classifyMetaAovQuality,
  resolveSpendUnit,
} from "../spend-unit-resolver";

const baseInput = {
  targetCpa: null,
  operatorAovAssumption: null,
  metaAttributedAovMean90d: null,
  metaAttributedAovPurchaseCount90d: 0,
  metaAttributedRevenue90d: 0,
  targetRoas: null,
  breakEvenRoas: null,
  accountCpaP50: null,
  accountCpaSampleCount: 0,
  attributionAovAdjustmentMultiplier: 1,
};

describe("resolveSpendUnit", () => {
  it("uses target_cpa directly with high confidence", () => {
    const result = resolveSpendUnit({ ...baseInput, targetCpa: 42 });

    expect(result).toMatchObject({
      spendUnit: 42,
      source: "target_cpa",
      confidence: "high",
      hardEligibleByDefault: true,
    });
  });

  it("never mints operator_aov: a Target ROAS routes to the platform AOV", () => {
    // RE-PINNED. This asserted `operator_aov` at 120 / 3 = 40 while the
    // operator's assumption outranked the platform AOV. With a Target ROAS the
    // basis is now Meta's own attributed AOV over that ratio, so the operator
    // rung is unreachable: 200 / 3, never 120 / 3.
    const result = resolveSpendUnit({
      ...baseInput,
      operatorAovAssumption: 120,
      targetRoas: 3,
      metaAttributedAovMean90d: 200,
      metaAttributedAovPurchaseCount90d: 25,
      metaAttributedRevenue90d: 5000,
    });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.spendUnit).toBeCloseTo(200 / 3, 10);
    expect(result.spendUnit).not.toBe(40);
  });

  it("holds rather than taking the operator AOV when the platform AOV is gone", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      operatorAovAssumption: 120,
      targetRoas: 3,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
  });

  it("holds rather than taking a Target CPA once a Target ROAS exists", () => {
    // The other half of the same rule, and the reason `target_cpa` above still
    // resolves: that case has no Target ROAS at all.
    const result = resolveSpendUnit({
      ...baseInput,
      targetCpa: 42,
      targetRoas: 3,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).not.toBe(42);
    expect(result.evidence.targetCpa).toBe(42);
  });

  it("uses ready Meta-derived AOV with medium confidence and hard eligibility", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 20,
      metaAttributedRevenue90d: 1000,
      targetRoas: 2,
    });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.spendUnit).toBe(25);
    expect(result.confidence).toBe("medium");
    expect(result.hardEligibleByDefault).toBe(true);
  });

  /*
    ROUND 6 — A TARGET ROAS ADMITS THE READY UNIT OR NOTHING.

    The three cases below expected a thin sample to build a low-confidence
    `meta_derived_aov`, and an unusable Meta AOV to FALL THROUGH to
    `account_history` / `break_even_aov`. Both produced a real spend unit on an
    account whose Target ROAS says only ready Meta AOV may answer, and
    `hardEligibleByDefault: false` closed the action gate while leaving that
    number to size the maturity floor, the thresholds and the canonical hash.
    Each is re-pinned as a hold, with a no-Target-ROAS control beside it so the
    soft rungs stay proven reachable in the compatibility case.
  */
  it("holds a low-sample Meta-derived AOV instead of sizing a unit from it", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 9,
      metaAttributedRevenue90d: 450,
      targetRoas: 2,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.confidence).toBe("insufficient");
    expect(result.hardEligibleByDefault).toBe(false);
    expect(result.evidence.warnings).toContain("meta_aov_low_sample");
  });

  it("holds an unstable Meta-derived AOV instead of sizing a unit from it", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 3,
      metaAttributedRevenue90d: 150,
      targetRoas: 2,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.confidence).toBe("insufficient");
    expect(result.hardEligibleByDefault).toBe(false);
    expect(result.evidence.warnings).toContain("meta_aov_unstable");
  });

  it("holds rather than falling through when the Meta purchase count is unavailable", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 0,
      targetRoas: 2,
      accountCpaP50: 35,
      accountCpaSampleCount: 20,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
  });

  it("holds rather than using account CPA history while a Target ROAS governs", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      accountCpaP50: 35,
      accountCpaSampleCount: 20,
      targetRoas: 2,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("still uses account CPA history when there is no Target ROAS", () => {
    // The compatibility control for the two cases above.
    const result = resolveSpendUnit({
      ...baseInput,
      accountCpaP50: 35,
      accountCpaSampleCount: 20,
      targetRoas: null,
    });

    expect(result.source).toBe("account_history");
    expect(result.spendUnit).toBe(35);
    expect(result.confidence).toBe("low");
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("uses break-even AOV as a low-confidence soft-only floor", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 60,
      metaAttributedAovPurchaseCount90d: 0,
      breakEvenRoas: 1.5,
    });

    expect(result.source).toBe("break_even_aov");
    expect(result.spendUnit).toBe(40);
    expect(result.confidence).toBe("low");
    expect(result.hardEligibleByDefault).toBe(false);
  });

  it("returns insufficient when all tiers are missing", () => {
    const result = resolveSpendUnit(baseInput);

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.confidence).toBe("insufficient");
  });
});

/**
 * The store's own average order value is contextual evidence, not a rung.
 *
 * A Meta decision's money-per-purchase unit is Meta's own attributed AOV. The
 * store answers the same question from a different book — settled orders net of
 * refunds rather than what Meta claims it caused — and while it sat in this
 * ladder above `meta_derived_aov` (high confidence, hard-eligible by default)
 * the served surface and the native hard-decision path sized the same account's
 * purchases from two different numbers. These cases pin all three halves of the
 * rule: Meta wins when both exist, the store never substitutes when Meta is
 * missing, and the store's number is still carried as evidence either way.
 */
describe("resolveSpendUnit and the store's own AOV", () => {
  const provenStore = {
    observedShopifyAov: 58,
    observedShopifyAovOrderCount: 41,
    observedShopifyAovStatus: "observed",
  };

  it("sizes from Meta's attributed AOV even when the store supplies a usable one", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      ...provenStore,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      targetRoas: 2.2,
    });

    // 50 / 2.2 = 22.73, the Meta basis — NOT 58 / 2.2 = 26.36, the store's.
    expect(result.source).toBe("meta_derived_aov");
    expect(result.spendUnit).toBeCloseTo(22.7273, 4);
    expect(result.hardEligibleByDefault).toBe(true);
    // Carried beside the unit, so a panel can still show both books.
    expect(result.evidence.observedShopifyAov).toBe(58);
    expect(result.evidence.observedShopifyAovOrderCount).toBe(41);
    expect(result.evidence.observedShopifyAovStatus).toBe("observed");
  });

  it("holds explicitly when Meta has no AOV, instead of substituting the store's", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      ...provenStore,
      targetRoas: 2.2,
    });

    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);
    // The hold is named: nothing owner-supplied and nothing Meta-attributed.
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
    expect(result.evidence.warnings).toContain("operator_aov_missing");
    // Still reported, so the absence is legible next to what the store said.
    expect(result.evidence.observedShopifyAov).toBe(58);
  });

  it("does not let the store outrank a soft rung into hard eligibility", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      ...provenStore,
      targetRoas: 2.2,
      accountCpaP50: 35,
      accountCpaSampleCount: 24,
    });

    /*
      ROUND 6: with a Target ROAS the ladder holds outright, so neither the
      store's AOV nor the account's own CPA history produces a unit. The claim
      this case makes is unchanged and stronger — no hard action, and now no
      number either.
    */
    expect(result.source).toBe("insufficient");
    expect(result.spendUnit).toBeNull();
    expect(result.hardEligibleByDefault).toBe(false);

    // Without a Target ROAS the account rung answers and the store still does
    // not: that is what makes this about the store rather than about the hold.
    const legacy = resolveSpendUnit({
      ...baseInput,
      ...provenStore,
      targetRoas: null,
      accountCpaP50: 35,
      accountCpaSampleCount: 24,
    });
    expect(legacy.source).toBe("account_history");
    expect(legacy.spendUnit).toBe(35);
    expect(legacy.hardEligibleByDefault).toBe(false);
  });

  it("keeps naming the store-side absence without demanding an operator AOV", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      observedShopifyAov: null,
      observedShopifyAovStatus: "unavailable",
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      targetRoas: 2.2,
    });

    expect(result.source).toBe("meta_derived_aov");
    expect(result.evidence.warnings).toContain(
      "observed_shopify_aov_unavailable",
    );
    // Meta supplies the unit, so no operator number is missing.
    expect(result.evidence.warnings).not.toContain("operator_aov_missing");
  });
});

/**
 * `operator_aov_missing` names the operator's number only when the operator's
 * number is what is actually missing.
 *
 * The guard that suppresses it (`metaAovCanSupplyUnit` in
 * `spend-unit-resolver.ts`) tests the Meta AOV alone and deliberately does not
 * test the Target ROAS, even though the `meta_derived_aov` rung needs both. The
 * pair below is what makes that deliberate rather than an oversight: with no
 * Target ROAS the ladder builds nothing either way, and the accurate finding is
 * the missing ratio — an operator AOV assumption would not have helped, because
 * the `operator_aov` rung divides by the same ratio.
 */
describe("resolveSpendUnit warnings without a target ROAS", () => {
  it("reports the missing ratio, not a missing operator AOV, when Meta is sampled", () => {
    const result = resolveSpendUnit({
      ...baseInput,
      metaAttributedAovMean90d: 50,
      metaAttributedAovPurchaseCount90d: 42,
      metaAttributedRevenue90d: 2100,
      targetRoas: null,
    });

    expect(result.source).toBe("insufficient");
    expect(result.evidence.warnings).toContain("target_roas_missing");
    expect(result.evidence.warnings).not.toContain("operator_aov_missing");
  });

  it("still names the operator AOV when Meta cannot supply one either", () => {
    const result = resolveSpendUnit({ ...baseInput, targetRoas: null });

    expect(result.source).toBe("insufficient");
    expect(result.evidence.warnings).toContain("target_roas_missing");
    expect(result.evidence.warnings).toContain("meta_aov_unavailable");
    expect(result.evidence.warnings).toContain("operator_aov_missing");
  });
});

/**
 * The cases above sample the ladder. The full cross product of target ROAS,
 * Meta AOV tier, legacy target CPA, operator AOV assumption and every Shopify
 * status lives in `canonical-meta-aov-permutations.test.ts`, together with the
 * profile-level gates and the canonical-hash evidence for the D091 rule.
 */

describe("classifyMetaAovQuality", () => {
  it("classifies purchase-count tiers", () => {
    expect(classifyMetaAovQuality(0)).toBe("unavailable");
    expect(classifyMetaAovQuality(1)).toBe("unstable");
    expect(classifyMetaAovQuality(5)).toBe("low_sample");
    expect(classifyMetaAovQuality(20)).toBe("ready");
  });
});
