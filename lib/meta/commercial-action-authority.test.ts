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
    });

    expect(guarded).toBe(rec);
  });

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
