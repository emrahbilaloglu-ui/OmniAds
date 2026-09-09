/**
 * WITH A TARGET ROAS, A TYPED CPA GOVERNS NOTHING.
 *
 * Two gates decided what a purchase is worth from the operator's CPA even when
 * the account carried a Target ROAS and a ready Meta-attributed AOV:
 *
 *   1. `metaLossBudgetMaturity` chose `breakEvenCpa ?? targetCpa ?? accountCpa`
 *      as its baseline, so the maturity FLOOR was sized from a CPA while the
 *      spend UNIT the floor admits was sized from Meta's AOV over the ratio.
 *      One account, one run, two answers to "what is a purchase worth".
 *   2. `maybeVolumeScaleRecommendation` vetoed a Scale on
 *      `breakEvenCpa ?? targetCpa * 1.1`, so a typed CPA could suppress a
 *      recommendation the ROAS basis had just authorized.
 *
 * The canonical rule admits one authoritative unit while a Target ROAS exists:
 * ready Meta platform-attributed AOV over that ratio. These cases drive the
 * real `metaLossBudgetMaturity` and the real `metaCanonicalSpendUnit` the veto
 * now reads, across mixed ROAS+CPA permutations, and pin the no-Target-ROAS
 * compatibility fallback that must survive.
 */
import { describe, expect, it } from "vitest";

import {
  metaCanonicalSpendUnit,
  metaLossBudgetMaturity,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

const FRESH = "2026-09-06T00:00:00.000Z";

/** A ready Meta sample: 60 purchases clears `classifyMetaAovQuality`'s bar of 20. */
const READY = { aovMean: 58, purchaseCount: 60 } as const;
/** Below the bar, so the canonical unit must NOT be claimed. */
const LOW_SAMPLE = { aovMean: 58, purchaseCount: 4 } as const;

function targets(
  over: Partial<MetaCommercialTargets> = {},
): MetaCommercialTargets {
  return {
    source: "configured_targets",
    targetRoas: 2.2,
    breakEvenRoas: 1.5,
    targetCpa: null,
    breakEvenCpa: null,
    aovAssumption: null,
    riskPosture: "balanced",
    freshness: "fresh",
    updatedAt: FRESH,
    metaAttributedAov: READY,
    ...over,
  };
}

// balanced posture multiplier is 2, so the floor is unit * 2.
const CANONICAL_UNIT = 58 / 2.2;
const CANONICAL_FLOOR = CANONICAL_UNIT * 2;

describe("the maturity floor is sized from the canonical unit", () => {
  /*
    THE PERMUTATION THAT MATTERS. Each row carries a Target ROAS and a ready
    Meta AOV, and adds a CPA that would have won before. All four must produce
    the SAME floor, because none of those CPAs is authoritative here.
  */
  const cpaPermutations = [
    { name: "no CPA at all", over: {} },
    { name: "a legacy target CPA", over: { targetCpa: 31 } },
    { name: "a break-even CPA", over: { breakEvenCpa: 44 } },
    { name: "both CPAs", over: { targetCpa: 31, breakEvenCpa: 44 } },
  ] as const;

  it.each(cpaPermutations.map((p) => [p.name, p.over] as const))(
    "ignores %s",
    (_name, over) => {
      const maturity = metaLossBudgetMaturity({
        targets: targets(over as Partial<MetaCommercialTargets>),
      });
      expect(maturity).not.toBeNull();
      expect(maturity!.source).toBe("meta_derived_aov");
      expect(maturity!.cpaBaseline).toBeCloseTo(CANONICAL_UNIT, 10);
      expect(maturity!.spendThreshold).toBeCloseTo(CANONICAL_FLOOR, 10);
    },
  );

  it("produces one floor no matter which CPAs are typed", () => {
    const floors = cpaPermutations.map(
      (p) =>
        metaLossBudgetMaturity({
          targets: targets(p.over as Partial<MetaCommercialTargets>),
        })!.spendThreshold,
    );
    expect(new Set(floors.map((f) => f.toFixed(10))).size).toBe(1);
  });

  it("refuses the pre-fix answers, which is what makes this discriminating", () => {
    // What the CPA ladder would have produced for the same rows.
    const breakEvenFloor = 44 * 2;
    const targetCpaFloor = 31 * 2;
    const maturity = metaLossBudgetMaturity({
      targets: targets({ targetCpa: 31, breakEvenCpa: 44 }),
    })!;
    expect(maturity.spendThreshold).not.toBeCloseTo(breakEvenFloor, 6);
    expect(maturity.spendThreshold).not.toBeCloseTo(targetCpaFloor, 6);
  });

  it("takes explicit sample arguments over the pair carried on the targets", () => {
    // `snapshot.ts` passes the pair directly; it must win over a stale one.
    const maturity = metaLossBudgetMaturity({
      targets: targets({ metaAttributedAov: { aovMean: 999, purchaseCount: 60 } }),
      metaAttributedAovMean90d: 58,
      metaAttributedAovPurchaseCount90d: 60,
    })!;
    expect(maturity.cpaBaseline).toBeCloseTo(CANONICAL_UNIT, 10);
  });
});

describe("and falls back exactly as before when there is no canonical unit", () => {
  /*
    RE-PINNED. This asserted that a Target ROAS with a THIN Meta sample falls to
    the break-even CPA. That pinned the substitution the rule forbids: with a
    positive Target ROAS the only authoritative unit is the ready Meta AOV over
    that ratio, and its absence is an ABSENCE — not a licence to size the floor
    from a typed CPA the account also happens to carry.
  */
  it("HOLDS when the Meta sample is thin, even with a break-even CPA typed", () => {
    expect(
      metaLossBudgetMaturity({
        targets: targets({ breakEvenCpa: 44, metaAttributedAov: LOW_SAMPLE }),
      }),
    ).toBeNull();
  });

  it("HOLDS when the Meta AOV is missing entirely", () => {
    expect(
      metaLossBudgetMaturity({
        targets: targets({ targetCpa: 31, breakEvenCpa: 44, metaAttributedAov: null }),
      }),
    ).toBeNull();
  });

  it("HOLDS rather than reaching for the account CPA baseline", () => {
    // `accountCpaBaseline` is the last rung of the legacy ladder and is just as
    // unauthoritative here as the typed ones.
    expect(
      metaLossBudgetMaturity({
        targets: targets({ metaAttributedAov: LOW_SAMPLE }),
        accountCpaBaseline: 27,
      }),
    ).toBeNull();
  });

  it("still resolves when the Meta sample IS ready", () => {
    // The control: the hold is caused by the missing unit, not by the presence
    // of a Target ROAS.
    const maturity = metaLossBudgetMaturity({
      targets: targets({ breakEvenCpa: 44 }),
    })!;
    expect(maturity.source).toBe("meta_derived_aov");
    expect(maturity.cpaBaseline).toBeCloseTo(CANONICAL_UNIT, 10);
  });

  it("uses target CPA when there is no Target ROAS at all", () => {
    const maturity = metaLossBudgetMaturity({
      targets: targets({ targetRoas: null, targetCpa: 31 }),
    })!;
    expect(maturity.source).toBe("target_cpa");
    expect(maturity.cpaBaseline).toBe(31);
  });

  it("uses the account baseline when nothing is configured", () => {
    const maturity = metaLossBudgetMaturity({
      targets: targets({ targetRoas: null, metaAttributedAov: null }),
      accountCpaBaseline: 27,
    })!;
    expect(maturity.source).toBe("account_cpa");
    expect(maturity.cpaBaseline).toBe(27);
  });

  it("still answers null when there is no baseline of any kind", () => {
    expect(
      metaLossBudgetMaturity({
        targets: targets({ targetRoas: null, metaAttributedAov: null }),
      }),
    ).toBeNull();
  });
});

describe("the Scale veto reads the same canonical unit", () => {
  /*
    `maybeVolumeScaleRecommendation` is not exported, so the veto is pinned at
    the value it now derives from — `metaCanonicalSpendUnit` — which is the
    single definition both gates share. A CPA typed beside a Target ROAS must
    not move it.
  */
  it("returns the canonical unit regardless of any typed CPA", () => {
    for (const over of [
      {},
      { targetCpa: 31 },
      { breakEvenCpa: 44 },
      { targetCpa: 31, breakEvenCpa: 44 },
    ]) {
      expect(
        metaCanonicalSpendUnit(targets(over as Partial<MetaCommercialTargets>)),
      ).toBeCloseTo(CANONICAL_UNIT, 10);
    }
  });

  it("is null without a Target ROAS, so the legacy CPA ceiling still governs", () => {
    expect(
      metaCanonicalSpendUnit(targets({ targetRoas: null, targetCpa: 31 })),
    ).toBeNull();
  });

  it("is null on a thin Meta sample, so a thin account is not handed a unit", () => {
    expect(
      metaCanonicalSpendUnit(targets({ metaAttributedAov: LOW_SAMPLE })),
    ).toBeNull();
  });
});
