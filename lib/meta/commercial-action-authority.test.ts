import { describe, expect, it } from "vitest";

import { enforceMetaCommercialActionAuthority } from "@/lib/meta/commercial-action-authority";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

function recommendation(
  overrides: Partial<MetaRecommendation> = {},
): MetaRecommendation {
  return {
    id: "rec-1",
    level: "adset",
    type: "adset_cut_spend",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    confidenceScore: 0.9,
    decisionState: "act",
    decision: "Cut spend",
    title: "Loss candidate",
    why: "Below break-even",
    summary: "Mature loss",
    recommendedAction: "Pause the ad set",
    expectedImpact: "Avoid loss",
    evidence: [],
    timeframeContext: {
      coreVerdict: "loss",
      selectedRangeOverlay: "loss",
      historicalSupport: "loss",
      seasonalityFlag: "none",
      note: null,
    },
    proposedAction: { kind: "pause" },
    targetValue: { budget: 0 },
    ...overrides,
  };
}

/*
  ── ROUND 9 ITEM 10: THIS SUITE WAS LEFT FAILING BY ROUND 8 ─────────────────

  Round 8 routed `ROAS_LOSS_TYPES` — which includes this fixture's
  `adset_cut_spend` — through `resolveMetaPurchaseValueAuthority`, so a positive
  Target ROAS now demands a READY same-account, same-cutoff Meta-attributed AOV
  before a purchase-budget loss action may be preserved. These fixtures carried
  no `metaAttributedAov` at all, so the guard correctly began blocking them and
  the suite has been red since; it was not in Round 8's targeted set and was
  never run.

  The fixtures now carry the READY sample, which is what makes them test the
  thing they were written for — that an OLD-but-valid target and a FRESH one
  both preserve the action. The missing-sample case is asserted directly below
  rather than being tested by accident.
*/
const READY_META_AOV = { aovMean: 180, purchaseCount: 60 } as const;

const ROAS_TARGETS = {
  source: "configured_targets" as const,
  targetRoas: 2.2,
  breakEvenRoas: 1.5,
  targetCpa: 120,
  breakEvenCpa: 160,
  riskPosture: "balanced" as const,
  freshness: "fresh" as const,
  updatedAt: "2026-05-01T00:00:00.000Z",
  metaAttributedAov: READY_META_AOV,
};

const HELD_BUDGET_PRESENTATION = {
  decision: "Review only: commercial action authority is blocked",
  title: "Budget allocation remains review-only",
  why: "The required commercial action authority is incomplete for this account and evidence cutoff.",
  summary:
    "Performance evidence remains available for diagnosis, but it does not authorize a budget change.",
  recommendedAction:
    "Review the evidence and restore the missing commercial authority before re-evaluating. Keep current spend unchanged.",
  expectedImpact:
    "Prevents an unsupported spend change while preserving the evidence for review.",
  stateReason:
    "Budget allocation is review-only because the required commercial action authority is blocked.",
};

function presentationText(recommendation: MetaRecommendation) {
  return [
    recommendation.decision,
    recommendation.title,
    recommendation.why,
    recommendation.summary,
    recommendation.recommendedAction,
    recommendation.expectedImpact,
    recommendation.stateReason,
  ].join(" ");
}

function budgetAllocation(
  lens: MetaRecommendation["lens"],
): MetaRecommendation {
  return recommendation({
    id: `budget-${lens}`,
    level: "account",
    type: "budget_allocation",
    lens,
    decision: "Reallocate budget toward Scale Winner",
    title: "Move budget from Weak Prospecting into Scale Winner",
    why: "Weak Prospecting trails Scale Winner inside the purchase cohort.",
    summary: "Scale Winner can absorb budget currently assigned to Weak Prospecting.",
    recommendedAction:
      "Shift 10-15% budget from Weak Prospecting into Scale Winner.",
    expectedImpact: "Move more spend into Scale Winner to improve blended ROAS.",
    proposedAction: { kind: "pause" },
    targetValue: { budgetShiftPct: 15 },
  });
}

describe("Meta commercial action authority", () => {
  it("preserves an old valid loss anchor and its executable target", () => {
    const rec = recommendation();
    const guarded = enforceMetaCommercialActionAuthority(rec, {
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "stale",
      updatedAt: "2026-05-01T00:00:00.000Z",
      metaAttributedAov: READY_META_AOV,
    });

    expect(guarded).toBe(rec);
  });

  it("preserves a commercial action when the configured target is fresh", () => {
    const rec = recommendation();
    const guarded = enforceMetaCommercialActionAuthority(rec, {
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-07-12T00:00:00.000Z",
      metaAttributedAov: READY_META_AOV,
    });

    expect(guarded).toBe(rec);
  });

  it("BLOCKS the same loss action when the Meta sample is missing", () => {
    /*
      The half the two cases above were silently exercising. A positive Target
      ROAS admits one money-per-purchase unit; without a READY sample there is
      no unit, and a spend action sized from nothing is the substitution the
      canonical rule forbids. Asserted on its own so the fixtures above test
      freshness rather than the sample.
    */
    const rec = recommendation();
    const guarded = enforceMetaCommercialActionAuthority(rec, {
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-07-12T00:00:00.000Z",
      metaAttributedAov: null,
    });

    expect(guarded).not.toBe(rec);
  });

  it.each([
    ["high", 0.9, "medium", 0.69],
    ["medium", 0.62, "medium", 0.62],
    ["low", 0.42, "low", 0.42],
  ] as const)(
    "caps a blocked %s-confidence action without raising lower confidence",
    (confidence, confidenceScore, expectedConfidence, expectedScore) => {
      const guarded = enforceMetaCommercialActionAuthority(
        recommendation({ confidence, confidenceScore }),
        {
          source: "configured_targets",
          targetRoas: 2.2,
          breakEvenRoas: 1.5,
          targetCpa: null,
          breakEvenCpa: null,
          riskPosture: "balanced",
          freshness: "fresh",
          updatedAt: "2026-07-12T00:00:00.000Z",
          metaAttributedAov: null,
        },
      );

      expect(guarded).toMatchObject({
        decisionState: "watch",
        confidence: expectedConfidence,
        confidenceScore: expectedScore,
        signalQuality: {
          hard_action_blocker: "commercial_anchor_missing",
        },
      });
      expect(guarded).not.toHaveProperty("proposedAction");
      expect(guarded).not.toHaveProperty("targetValue");
    },
  );

  it("BLOCKS the same loss action when the Meta sample is thin", () => {
    const rec = recommendation();
    const guarded = enforceMetaCommercialActionAuthority(rec, {
      source: "configured_targets",
      targetRoas: 2.2,
      breakEvenRoas: 1.5,
      targetCpa: null,
      breakEvenCpa: null,
      riskPosture: "balanced",
      freshness: "fresh",
      updatedAt: "2026-07-12T00:00:00.000Z",
      // Below `classifyMetaAovQuality`'s bar of 20 purchases.
      metaAttributedAov: { aovMean: 180, purchaseCount: 9 },
    });

    expect(guarded).not.toBe(rec);
  });

  it.each([
    ["volume", "missing", null, "commercial_anchor_missing"],
    [
      "volume",
      "thin",
      { aovMean: 180, purchaseCount: 9 },
      "commercial_anchor_sample_insufficient",
    ],
    ["profitability", "missing", null, "commercial_anchor_missing"],
    [
      "profitability",
      "thin",
      { aovMean: 180, purchaseCount: 9 },
      "commercial_anchor_sample_insufficient",
    ],
  ] as const)(
    "HOLDS a %s budget allocation on a %s Meta sample",
    (lens, _sampleState, sample, blocker) => {
      const guarded = enforceMetaCommercialActionAuthority(
        budgetAllocation(lens),
        { ...ROAS_TARGETS, metaAttributedAov: sample },
      );

      const reason = sample
        ? "The Meta-attributed purchase sample is too small to support a spend change."
        : "Meta-attributed purchase value is missing for this account and evidence cutoff.";
      expect(guarded).toMatchObject({
        decisionState: "watch",
        confidence: "medium",
        confidenceScore: 0.69,
        ...HELD_BUDGET_PRESENTATION,
        why: reason,
        stateReason: reason,
        signalQuality: {
          hard_action_authority: "blocked",
          hard_action_blocker: blocker,
        },
      });
      expect(guarded).not.toHaveProperty("proposedAction");
      expect(guarded).not.toHaveProperty("targetValue");
      expect(presentationText(guarded)).not.toMatch(
        /Scale Winner|Weak Prospecting|10[-–]15%|\b(?:shift|reallocate|move|transfer|redirect)\b/i,
      );
    },
  );

  it.each(["volume", "profitability"] as const)(
    "preserves a %s budget allocation with Target ROAS and READY Meta AOV",
    (lens) => {
      const rec = budgetAllocation(lens);
      expect(enforceMetaCommercialActionAuthority(rec, ROAS_TARGETS)).toBe(rec);
    },
  );

  it("preserves the no-Target-ROAS profitability compatibility path when break-even ROAS is configured", () => {
    const rec = budgetAllocation("profitability");
    expect(
      enforceMetaCommercialActionAuthority(rec, {
        ...ROAS_TARGETS,
        targetRoas: null,
        metaAttributedAov: null,
      }),
    ).toBe(rec);
  });

  it.each([
    ["volume", "commercial_growth_anchor_missing"],
    ["structure", "commercial_objective_anchor_missing"],
  ] as const)(
    "does not let break-even ROAS authorize a no-Target-ROAS %s budget allocation",
    (lens, blocker) => {
      const guarded = enforceMetaCommercialActionAuthority(
        budgetAllocation(lens),
        {
          ...ROAS_TARGETS,
          targetRoas: null,
          metaAttributedAov: null,
        },
      );

      expect(guarded).toMatchObject({
        decisionState: "watch",
        ...HELD_BUDGET_PRESENTATION,
        signalQuality: { hard_action_blocker: blocker },
      });
      expect(guarded).not.toHaveProperty("proposedAction");
      expect(guarded).not.toHaveProperty("targetValue");
      expect(presentationText(guarded)).not.toMatch(
        /Scale Winner|Weak Prospecting|10[-–]15%|\b(?:shift|reallocate|move|transfer|redirect)\b/i,
      );
    },
  );

  it("does not use a fresh break-even-only target as growth authority", () => {
    const guarded = enforceMetaCommercialActionAuthority(
      recommendation({ type: "adset_scale_budget" }),
      {
        source: "configured_targets",
        targetRoas: null,
        breakEvenRoas: 1.5,
        targetCpa: null,
        breakEvenCpa: null,
        riskPosture: "balanced",
        freshness: "fresh",
        updatedAt: "2026-07-12T00:00:00.000Z",
      },
    );

    expect(guarded).toMatchObject({
      decisionState: "watch",
      signalQuality: {
        hard_action_blocker: "commercial_growth_anchor_missing",
      },
    });
  });

  it("keeps non-purchase spend changes review-only until goal-specific economics exist", () => {
    const guarded = enforceMetaCommercialActionAuthority(
      recommendation({
        type: "scenario_t1_traffic_efficient_scale",
        cohort: "traffic",
      }),
      {
        source: "configured_targets",
        targetRoas: 2.2,
        breakEvenRoas: 1.5,
        targetCpa: 40,
        breakEvenCpa: 55,
        riskPosture: "balanced",
        freshness: "fresh",
        updatedAt: "2026-07-12T00:00:00.000Z",
      },
    );

    expect(guarded).toMatchObject({
      decisionState: "watch",
      signalQuality: {
        hard_action_blocker: "commercial_objective_anchor_missing",
      },
    });
  });

  it("does not apply the commercial guard to a diagnostic recommendation", () => {
    const rec = recommendation({
      type: "scenario_h1_dedup_tracking",
      decisionState: "watch",
    });
    expect(enforceMetaCommercialActionAuthority(rec, null)).toBe(rec);
  });
});
