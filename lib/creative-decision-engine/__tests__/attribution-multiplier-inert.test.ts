/**
 * THE ATTRIBUTION AOV MULTIPLIER IS NOT AUTHORITATIVE ARITHMETIC.
 *
 * `attributionAovAdjustmentMultiplier` used to scale Meta's attributed AOV
 * before the division, on BOTH the `meta_derived_aov` rung and the
 * `break_even_aov` stop-loss rung:
 *
 *     spendUnit = (metaAttributedAovMean90d * multiplier) / targetRoas
 *
 * So one account, one Meta sample and one Target ROAS produced a different
 * money-per-purchase unit — and with it a different maturity floor, different
 * thresholds, a different verdict and a different decision identity — purely
 * because an attribution knob had been typed. The canonical rule admits one
 * authoritative unit when a Target ROAS exists, ready Meta platform-attributed
 * AOV over that ratio, and no adjustment factor is part of it.
 *
 * These cases drive the REAL resolver, not a copy of its expression: if the
 * multiplication comes back at either rung, the permutations below diverge.
 */
import { describe, expect, it } from "vitest";

import { resolveSpendUnit } from "@/lib/creative-decision-engine/spend-unit-resolver";

/** The three permutations the review named: below 1, exactly 1, above 1. */
const MULTIPLIERS = [0.8, 1, 1.2] as const;

function ladder(
  over: Partial<Parameters<typeof resolveSpendUnit>[0]> = {},
) {
  return resolveSpendUnit({
    targetCpa: null,
    operatorAovAssumption: null,
    observedShopifyAov: null,
    observedShopifyAovOrderCount: 0,
    observedShopifyAovStatus: null,
    metaAttributedAovMean90d: 58,
    metaAttributedAovPurchaseCount90d: 60,
    metaAttributedRevenue90d: 3480,
    targetRoas: 2.2,
    breakEvenRoas: null,
    accountCpaP50: null,
    accountCpaSampleCount: 0,
    attributionAovAdjustmentMultiplier: 1,
    ...over,
  });
}

describe("the attribution multiplier moves nothing on the Meta-AOV rung", () => {
  it("resolves the same unit, basis, confidence and eligibility at 0.8, 1 and 1.2", () => {
    const results = MULTIPLIERS.map((attributionAovAdjustmentMultiplier) =>
      ladder({ attributionAovAdjustmentMultiplier }),
    );

    for (const resolution of results) {
      // 58.00 / 2.20, the platform AOV UNSCALED.
      expect(resolution.spendUnit).toBeCloseTo(58 / 2.2, 10);
      expect(resolution.source).toBe("meta_derived_aov");
      expect(resolution.confidence).toBe("medium");
      expect(resolution.hardEligibleByDefault).toBe(true);
    }

    // Not "close enough" — byte-identical resolutions, evidence included, so a
    // multiplier cannot reach an identity through a field this asserts loosely.
    const [first] = results;
    for (const resolution of results.slice(1)) {
      expect(resolution).toStrictEqual(first);
    }
  });

  it("would have diverged before the fix, which is what makes this a test", () => {
    /*
      The pre-fix expression, stated once so the case cannot pass vacuously: if
      the multiplication were still applied, 0.8 and 1.2 would land here. These
      are the numbers this test exists to refuse.
    */
    const scaledDown = (58 * 0.8) / 2.2;
    const scaledUp = (58 * 1.2) / 2.2;
    expect(scaledDown).not.toBeCloseTo(58 / 2.2, 6);
    expect(scaledUp).not.toBeCloseTo(58 / 2.2, 6);

    for (const attributionAovAdjustmentMultiplier of MULTIPLIERS) {
      const unit = ladder({ attributionAovAdjustmentMultiplier }).spendUnit!;
      expect(unit).not.toBeCloseTo(scaledDown, 6);
      expect(unit).not.toBeCloseTo(scaledUp, 6);
    }
  });

  it("is inert when the field is omitted entirely", () => {
    const omitted = resolveSpendUnit({
      targetCpa: null,
      operatorAovAssumption: null,
      metaAttributedAovMean90d: 58,
      metaAttributedAovPurchaseCount90d: 60,
      metaAttributedRevenue90d: 3480,
      targetRoas: 2.2,
      breakEvenRoas: null,
      accountCpaP50: null,
      accountCpaSampleCount: 0,
    });
    expect(omitted).toStrictEqual(ladder({ attributionAovAdjustmentMultiplier: 1 }));
  });
});

describe("nor on the commercial stop-loss rung", () => {
  /*
    `break_even_aov` is the stop-loss basis — where loss begins. It is reached
    with a break-even ROAS and no target ROAS, and it carried the same
    multiplication. An attribution knob must not move the loss line either.
  */
  function stopLoss(attributionAovAdjustmentMultiplier: number) {
    return ladder({
      targetRoas: null,
      breakEvenRoas: 1.5,
      metaAttributedAovPurchaseCount90d: 4,
      attributionAovAdjustmentMultiplier,
    });
  }

  it("resolves the same stop-loss unit at 0.8, 1 and 1.2", () => {
    const results = MULTIPLIERS.map(stopLoss);
    for (const resolution of results) {
      expect(resolution.source).toBe("break_even_aov");
      expect(resolution.spendUnit).toBeCloseTo(58 / 1.5, 10);
      // A soft rung: it never grants hard authority by itself.
      expect(resolution.hardEligibleByDefault).toBe(false);
    }
    const [first] = results;
    for (const resolution of results.slice(1)) {
      expect(resolution).toStrictEqual(first);
    }
  });
});

describe("and the no-Target-ROAS compatibility case is untouched", () => {
  it("still takes the configured Target CPA, unscaled, at every multiplier", () => {
    for (const attributionAovAdjustmentMultiplier of MULTIPLIERS) {
      const resolution = ladder({
        targetRoas: null,
        targetCpa: 31,
        attributionAovAdjustmentMultiplier,
      });
      expect(resolution.source).toBe("target_cpa");
      expect(resolution.spendUnit).toBe(31);
      expect(resolution.hardEligibleByDefault).toBe(true);
    }
  });
});
