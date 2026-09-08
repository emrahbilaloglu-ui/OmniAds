/**
 * A PERSISTED ACT FROM SUPERSEDED ARITHMETIC MUST NOT STAY ACTIONABLE.
 *
 * ── ROUND 18, ITEM B8 ───────────────────────────────────────────────────────
 * B1 and A1 changed ARITHMETIC in v1.3.0, not presentation: B1 sized a bid-cap
 * raise with hard-coded /100 and *100 — wrong for every currency whose minor
 * unit is not two decimals — and authorised it from a ratio; A1 divided by the
 * account CPA percentile even under a positive Target ROAS.
 *
 * A row persisted by the old engine carries a number computed the old way.
 * Today's AOV being READY does not retroactively make that number correct, so
 * the read path must refuse to serve it as actionable rather than trusting the
 * stamp it was written under.
 *
 * NARROW ON PURPOSE. A blanket version gate would downgrade every persisted
 * recommendation on deploy, which is a larger outage than the one being fixed.
 */
import { describe, expect, it } from "vitest";

import {
  META_RECOMMENDATION_ENGINE_VERSION,
  META_V130_RECOMPUTE_REQUIRED_TYPES,
  metaRecommendationNeedsRecompute,
} from "@/lib/meta/recommendations";

describe("the recompute guard", () => {
  it.each(META_V130_RECOMPUTE_REQUIRED_TYPES)(
    "requires recompute for a stale %s",
    (type) => {
      expect(
        metaRecommendationNeedsRecompute({
          type,
          engineVersion: "v1.2.0-target-age-advisory",
        }),
      ).toBe(true);
    },
  );

  it("treats an ABSENT or unrecognised stamp as stale", () => {
    // An unstamped row is not evidence that the row is current.
    for (const engineVersion of [null, undefined, "", "  ", "v0.9-unknown"]) {
      expect(
        metaRecommendationNeedsRecompute({
          type: "scenario_b1_capped_winner_bid_raise",
          engineVersion,
        }),
        String(engineVersion),
      ).toBe(true);
    }
  });

  it("clears a row written by the CURRENT engine", () => {
    for (const type of META_V130_RECOMPUTE_REQUIRED_TYPES) {
      expect(
        metaRecommendationNeedsRecompute({
          type,
          engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
        }),
        type,
      ).toBe(false);
    }
  });

  it("leaves every OTHER scenario alone, whatever its stamp", () => {
    /*
      The blast-radius control. Only B1 and A1 changed arithmetic; downgrading
      unrelated scenarios on a version bump would be a self-inflicted outage.
    */
    for (const type of [
      "scenario_c1_controlled_scale",
      "scenario_a2_learning_weak_structural",
      "scenario_a5_post_learning_underperformer",
      "scenario_b4_min_roas_loosen",
      "scenario_h1_dedup_tracking",
    ]) {
      expect(
        metaRecommendationNeedsRecompute({
          type,
          engineVersion: "v1.0.0-ancient",
        }),
        type,
      ).toBe(false);
    }
  });

  it("bumped the engine version away from the pre-fix stamp", () => {
    // The guard is inert unless the version actually moved.
    expect(META_RECOMMENDATION_ENGINE_VERSION).not.toBe(
      "v1.2.0-target-age-advisory",
    );
  });
});

describe("a CURRENT-version persisted act is still governed by live AOV", () => {
  /*
    ── ROUND 19, ITEM B4 ──────────────────────────────────────────────────────
    The recompute guard only downgrades rows stamped with an OLDER engine
    version. A B1/A1 row persisted by the CURRENT engine while the Meta AOV was
    READY stays `act` after that sample goes missing, thin, or mismatched — the
    generator's refusal governs new rows only, and this is the surface that
    governs served ones.

    `enforceMetaCommercialActionAuthority` is that surface, and B1/A1 are now in
    its guarded set.
  */
  const persistedAct = (type: string) =>
    ({
      id: "rec_1",
      type,
      level: "campaign",
      lens: "volume",
      priority: "high",
      confidence: "high",
      decisionState: "act",
      decision: "Raise the bid cap",
      title: "Capped winner",
      why: "…",
      summary: "…",
      recommendedAction: "Increase the bid cap.",
      expectedImpact: "…",
      evidence: [],
      engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
      targetValue: { bid: { current: 5_000, proposed: 5_500 } },
      proposedAction: { kind: "bid", amountMinor: 5_500 },
    }) as never;

  const READY_TARGETS = {
    source: "configured_targets" as const,
    targetRoas: 2.2,
    breakEvenRoas: 1.5,
    targetCpa: 120,
    breakEvenCpa: 160,
    riskPosture: "balanced" as const,
    freshness: "fresh" as const,
    updatedAt: "2026-09-01T00:00:00.000Z",
    metaAttributedAov: { aovMean: 180, purchaseCount: 60 },
  };

  it.each([
    "scenario_b1_capped_winner_bid_raise",
    "scenario_a1_math_floor_unmet",
  ])("keeps %s actionable while the AOV is READY", async (type) => {
    // The control: the guard must not downgrade a healthy account.
    const { enforceMetaCommercialActionAuthority } = await import(
      "@/lib/meta/commercial-action-authority"
    );
    const served = enforceMetaCommercialActionAuthority(
      persistedAct(type),
      READY_TARGETS,
    );
    expect(served.decisionState).toBe("act");
    expect(served.targetValue).toBeTruthy();
  });

  it.each([
    ["a MISSING AOV", { metaAttributedAov: null }],
    ["a THIN AOV sample", { metaAttributedAov: { aovMean: 180, purchaseCount: 4 } }],
    ["a below-threshold sample", { metaAttributedAov: { aovMean: 180, purchaseCount: 19 } }],
    ["a non-positive AOV", { metaAttributedAov: { aovMean: 0, purchaseCount: 60 } }],
    ["a missing Target ROAS", { targetRoas: null }],
  ])("downgrades a CURRENT-version B1 act on %s", async (_label, over) => {
    const { enforceMetaCommercialActionAuthority } = await import(
      "@/lib/meta/commercial-action-authority"
    );
    const served = enforceMetaCommercialActionAuthority(
      persistedAct("scenario_b1_capped_winner_bid_raise"),
      { ...READY_TARGETS, ...over } as never,
    );
    expect(served.decisionState).toBe("watch");
    // No proposal survives: neither the value nor the action.
    expect(served.targetValue ?? null).toBeNull();
    expect((served as { proposedAction?: unknown }).proposedAction ?? null).toBeNull();
    expect(served.signalQuality?.hard_action_authority).toBe("blocked");
  });

  it("downgrades a CURRENT-version ROAS-governed A1 act on a thin AOV", async () => {
    const { enforceMetaCommercialActionAuthority } = await import(
      "@/lib/meta/commercial-action-authority"
    );
    const served = enforceMetaCommercialActionAuthority(
      persistedAct("scenario_a1_math_floor_unmet"),
      { ...READY_TARGETS, metaAttributedAov: { aovMean: 180, purchaseCount: 4 } },
    );
    expect(served.decisionState).toBe("watch");
    expect(served.targetValue ?? null).toBeNull();
  });

  it("leaves a NO-Target-ROAS A1 alone: its legacy branch never used a unit", async () => {
    /*
      Demanding a purchase-value unit on the legacy CPA branch would block a
      path that never used one — a regression dressed as a tightening.
    */
    const { enforceMetaCommercialActionAuthority } = await import(
      "@/lib/meta/commercial-action-authority"
    );
    const served = enforceMetaCommercialActionAuthority(
      persistedAct("scenario_a1_math_floor_unmet"),
      {
        ...READY_TARGETS,
        targetRoas: null,
        breakEvenRoas: null,
        metaAttributedAov: null,
      } as never,
    );
    expect(served.decisionState).toBe("act");
  });
});
