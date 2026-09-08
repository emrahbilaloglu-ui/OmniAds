/**
 * A POSITIVE TARGET ROAS NEEDS BOTH HALVES OF THE UNIT BEFORE ANY PURCHASE-VALUE
 * BUDGET ACTION MAY ACT.
 *
 * Codex Round 6, item 1. Three surfaces each asked a DIFFERENT question before
 * granting a Scale, and each answer could grant a budget increase the canonical
 * rule forbids:
 *
 *   - `commercial-action-authority.ts` asked only "is there a Target ROAS?",
 *     so a ratio with no attributed purchases behind it authorized.
 *   - `maybeC1ControlledScale` returned `decisionState: "act"` with a concrete
 *     budget band straight from a calibrated ROAS threshold.
 *   - `buildMetaAdsetRecommendations` gated Scale on `adset.cpa <= cpa.p75` —
 *     the account's own measured cost-per-purchase distribution deciding a
 *     purchase-value budget increase.
 *
 * The rule: with a positive Target ROAS the only authoritative money-per-
 * purchase unit is READY, same-account, same-cutoff Meta platform-attributed
 * AOV over that ratio. Missing or thin is a HOLD, and the hold is never
 * answered by a Target CPA, a break-even CPA, an account CPA, an operator AOV
 * assumption or a store AOV.
 *
 * The Cut half is the opposite correction: a Target ROAS is SUFFICIENT for the
 * relative path. Break-even stays the anchor of the explicitly economic-loss
 * strip and is not a second mandatory user target.
 */
import { describe, expect, it } from "vitest";

import { enforceMetaCommercialActionAuthority } from "@/lib/meta/commercial-action-authority";
import {
  resolveMetaPurchaseValueAuthority,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

const FRESH = "2026-09-06T00:00:00.000Z";
/** 60 purchases clears `classifyMetaAovQuality`'s ready bar of 20. */
const READY = { aovMean: 180, purchaseCount: 60 } as const;
/** Above zero, below the bar. */
const THIN = { aovMean: 180, purchaseCount: 9 } as const;

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

describe("the shared purchase-value authority", () => {
  it("grants only on a positive Target ROAS with a READY sample", () => {
    const granted = resolveMetaPurchaseValueAuthority(targets());
    expect(granted).toMatchObject({ authorized: true, blocker: null });
    expect(granted.unit).toBeCloseTo(180 / 2.2, 10);
  });

  it.each([
    ["a missing sample", { metaAttributedAov: null }, "commercial_anchor_missing"],
    ["a thin sample", { metaAttributedAov: THIN }, "commercial_anchor_sample_insufficient"],
    [
      "a sample with no mean",
      { metaAttributedAov: { aovMean: null, purchaseCount: 60 } },
      "commercial_anchor_missing",
    ],
    ["no Target ROAS", { targetRoas: null }, "commercial_growth_anchor_missing"],
    [
      "no target pack at all",
      {
        targetRoas: null,
        breakEvenRoas: null,
        targetCpa: null,
        breakEvenCpa: null,
        aovAssumption: null,
        updatedAt: null,
      },
      "commercial_target_missing",
    ],
    [
      "unverifiable provenance",
      { updatedAt: null, freshness: "unknown" as const },
      "commercial_target_unknown",
    ],
  ])("refuses %s by name", (_case, over, blocker) => {
    const refused = resolveMetaPurchaseValueAuthority(
      targets(over as Partial<MetaCommercialTargets>),
    );
    expect(refused).toMatchObject({ authorized: false, blocker, unit: null });
  });

  it("is invariant to every CPA and AOV the rule calls unauthoritative", () => {
    /*
      THE CONFLICTING-CPA CASE. Each of these would have sized a very different
      allowance, and none of them may change the answer while a Target ROAS
      governs — neither by granting where the sample is thin nor by moving the
      unit where it is ready.
    */
    const conflicting: Partial<MetaCommercialTargets>[] = [
      {},
      { targetCpa: 31 },
      { breakEvenCpa: 44 },
      { aovAssumption: 900 },
      { targetCpa: 31, breakEvenCpa: 44, aovAssumption: 900 },
    ];
    const readyUnits = conflicting.map(
      (over) => resolveMetaPurchaseValueAuthority(targets(over)).unit,
    );
    expect(new Set(readyUnits.map((unit) => unit!.toFixed(10))).size).toBe(1);

    const thinBlockers = conflicting.map(
      (over) =>
        resolveMetaPurchaseValueAuthority(
          targets({ ...over, metaAttributedAov: THIN }),
        ).blocker,
    );
    expect(new Set(thinBlockers)).toEqual(
      new Set(["commercial_anchor_sample_insufficient"]),
    );
  });
});

function scaleRec(): MetaRecommendation {
  return {
    id: "rec-scale",
    level: "campaign",
    campaignId: "cmp-1",
    campaignName: "Winner",
    type: "scale_for_volume",
    lens: "volume",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.9,
    confidenceReason: null,
    decisionState: "act",
    decision: "Scale",
    title: "Scale Winner",
    why: "Above the calibrated line.",
    summary: "Strong.",
    recommendedAction: "Increase budget 10-15%.",
    expectedImpact: "More volume.",
    evidence: [],
    proposedAction: { kind: "budget_increase" },
    targetValue: { budget: { current: 100, proposed: 115 } },
  } as unknown as MetaRecommendation;
}

function cutRec(): MetaRecommendation {
  return { ...scaleRec(), id: "rec-cut", type: "adset_cut_spend", level: "adset" };
}

describe("the action-authority boundary", () => {
  it("passes a Scale through on a ready sample", () => {
    const guarded = enforceMetaCommercialActionAuthority(scaleRec(), targets());
    expect(guarded.decisionState).toBe("act");
    expect(guarded).toHaveProperty("targetValue");
  });

  it.each([
    ["missing", null, "commercial_anchor_missing"],
    ["thin", THIN, "commercial_anchor_sample_insufficient"],
  ])("HOLDS a Scale on a %s sample and names why", (_case, sample, blocker) => {
    const guarded = enforceMetaCommercialActionAuthority(
      scaleRec(),
      targets({ metaAttributedAov: sample }),
    );
    expect(guarded.decisionState).toBe("watch");
    expect(guarded.signalQuality).toMatchObject({
      hard_action_authority: "blocked",
      hard_action_blocker: blocker,
    });
    // The evidence stays; the authority does not.
    expect(guarded).not.toHaveProperty("proposedAction");
    expect(guarded).not.toHaveProperty("targetValue");
  });

  it("never answers a missing sample with a CPA the account also carries", () => {
    const guarded = enforceMetaCommercialActionAuthority(
      scaleRec(),
      targets({
        metaAttributedAov: null,
        targetCpa: 31,
        breakEvenCpa: 44,
        aovAssumption: 900,
      }),
    );
    expect(guarded.decisionState).toBe("watch");
    expect(guarded.signalQuality?.hard_action_blocker).toBe(
      "commercial_anchor_missing",
    );
  });

  it("authorizes the loss action on a Target ROAS alone WITH a ready sample", () => {
    /*
      Break-even is NOT a second mandatory user target: an account carrying the
      one target the product asks for can act on a loss verdict. What it still
      needs is the other half of the unit, because every type in this set is a
      purchase-BUDGET action.
    */
    const guarded = enforceMetaCommercialActionAuthority(
      cutRec(),
      targets({ breakEvenRoas: null }),
    );
    expect(guarded.decisionState).toBe("act");
    expect(guarded.signalQuality?.hard_action_blocker).toBeUndefined();
  });

  it.each([
    ["missing", null, "commercial_anchor_missing"],
    ["thin", THIN, "commercial_anchor_sample_insufficient"],
  ])("HOLDS the loss action on a %s sample even with break-even typed", (_case, sample, blocker) => {
    // Round 6 audit: a Target ROAS alone used to pass this set, so a
    // purchase-budget cut was authorized with no attributed purchases behind
    // it. Break-even's presence does not answer for the missing sample.
    const guarded = enforceMetaCommercialActionAuthority(
      cutRec(),
      targets({ metaAttributedAov: sample, breakEvenRoas: 1.5 }),
    );
    expect(guarded.decisionState).toBe("watch");
    expect(guarded.signalQuality?.hard_action_blocker).toBe(blocker);
  });

  it("keeps the legacy break-even loss path when no Target ROAS governs", () => {
    // No ratio to divide, so no Meta sample is needed and the configured
    // break-even is the anchor: the compatibility case, unchanged.
    const guarded = enforceMetaCommercialActionAuthority(
      cutRec(),
      targets({ targetRoas: null, breakEvenRoas: 1.5, metaAttributedAov: null }),
    );
    expect(guarded.decisionState).toBe("act");
  });

  it("still refuses a Cut when neither ratio is configured", () => {
    // A pack that EXISTS — a legacy Target CPA is typed — but carries no ratio
    // of either kind, so the refusal is about the anchor and not about the
    // pack being absent.
    const guarded = enforceMetaCommercialActionAuthority(
      cutRec(),
      targets({ targetRoas: null, breakEvenRoas: null, targetCpa: 31 }),
    );
    expect(guarded.decisionState).toBe("watch");
    expect(guarded.signalQuality?.hard_action_blocker).toBe(
      "commercial_loss_anchor_missing",
    );
  });
});
