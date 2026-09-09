/**
 * WHILE A TARGET ROAS EXISTS, IT IS THE RELATIVE BOUNDARY.
 *
 * Round 8, item 5. `metaRelativeCutRoasCeiling` returned
 * `breakEvenRoas ?? targetRoas`. That reads as a courtesy — "prefer the
 * stricter line the operator typed" — and is a silent replacement of the
 * boundary the product actually asks for:
 *
 *   - two accounts with the SAME Target ROAS made different relative Cut and
 *     profitability decisions because one of them had also typed a break-even;
 *   - an operator editing only their break-even moved a relative boundary they
 *     never intended to touch, on a decision that is not about economic loss;
 *   - and because break-even was consulted first, the configured operating
 *     target was not what the relative path compared against at all.
 *
 * The canonical rule says Target ROAS is sufficient as the configured target
 * and break-even is not a second required one. This file pins both halves of
 * that: with a positive Target ROAS the break-even is INERT for relative
 * decisions, and without one it is still the compatibility boundary — because
 * then it is the only commercial ratio the account has.
 *
 * The economic stop-loss path is a DIFFERENT question with its own anchor and
 * its own consumers (`metaCutRoasCeiling` / `metaCutRoasReviewCeiling`), and it
 * is asserted here to still read break-even alone — that is what makes this a
 * separation rather than a deletion.
 */
import { describe, expect, it } from "vitest";

import { buildMetaAdsetRecommendations } from "@/lib/meta/adset-decisions";
import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import type { MetaCalibrationContext } from "@/lib/meta/recommendations";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import {
  META_RECENT_EDIT_AUTHORITY_KEY,
  metaRecentEditAuthorityRecord,
} from "@/lib/meta/recent-edit-authority";
import {
  metaCutRoasCeiling,
  metaCutRoasReviewCeiling,
  metaRelativeCutRoasCeiling,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

function targets(
  over: Partial<MetaCommercialTargets> = {},
): MetaCommercialTargets {
  return {
    source: "configured_targets",
    targetRoas: 2.2,
    breakEvenRoas: 1.5,
    targetCpa: null,
    breakEvenCpa: null,
    riskPosture: "balanced",
    freshness: "fresh",
    updatedAt: "2026-05-14T00:00:00.000Z",
    // READY, so the maturity floor resolves and the relative path is reachable
    // at all. Item 5 is about WHICH ratio bounds it, not about whether a unit
    // exists.
    metaAttributedAov: { aovMean: 180, purchaseCount: 60 },
    ...over,
  };
}

describe("the relative boundary itself", () => {
  it("is the Target ROAS, whatever break-even is typed beside it", () => {
    /*
      The permutation that matters. Four packs with the same Target ROAS and
      four different break-evens — including one ABOVE the target and one below
      — must all produce the same relative boundary.
    */
    const permutations = [
      { breakEvenRoas: null },
      { breakEvenRoas: 1.5 },
      { breakEvenRoas: 0.9 },
      { breakEvenRoas: 3.4 },
    ];
    const ceilings = permutations.map((over) =>
      metaRelativeCutRoasCeiling(targets(over)),
    );
    expect(new Set(ceilings)).toEqual(new Set([2.2]));
  });

  it("refuses the pre-fix answer, which is what makes this discriminating", () => {
    // What `breakEvenRoas ?? targetRoas` would have produced for the same pack.
    expect(metaRelativeCutRoasCeiling(targets({ breakEvenRoas: 1.5 }))).not.toBe(
      1.5,
    );
  });

  it("falls to break-even only when there is no Target ROAS at all", () => {
    /*
      The compatibility half. With no operating ratio the configured break-even
      is the only commercial line the account has, so the relative path uses it
      rather than refusing to bound anything.
    */
    expect(
      metaRelativeCutRoasCeiling(
        targets({ targetRoas: null, breakEvenRoas: 1.5 }),
      ),
    ).toBe(1.5);
  });

  it("answers null when the account has no commercial ratio of any kind", () => {
    expect(
      metaRelativeCutRoasCeiling(
        targets({ targetRoas: null, breakEvenRoas: null }),
      ),
    ).toBeNull();
  });

  it("leaves the economic stop-loss anchor reading break-even alone", () => {
    /*
      THE SEPARATION, not a deletion. "Is this below the operating target" and
      "is this spend loss-making" are different questions; break-even answers
      the second and keeps its own consumers. It is never mandatory — both of
      these answer null without one, and their callers simply do not fire.
    */
    const pack = targets({ breakEvenRoas: 1.5 });
    expect(metaCutRoasCeiling(pack)).toBe(1.5);
    expect(metaCutRoasReviewCeiling(pack)).toBe(1.5);
    const noBreakEven = targets({ breakEvenRoas: null });
    expect(metaCutRoasCeiling(noBreakEven)).toBeNull();
    expect(metaCutRoasReviewCeiling(noBreakEven)).toBeNull();
    // And the relative path is unaffected by that absence.
    expect(metaRelativeCutRoasCeiling(noBreakEven)).toBe(2.2);
  });
});

/*
  ── THE SAME RULE THROUGH A REAL CONSUMER ───────────────────────────────────
  A pure-function assertion proves the boundary; it does not prove that the
  ad-set relative Cut path reads it. These cases drive the real
  `buildMetaAdsetRecommendations` and require the SERVED recommendation to be
  identical across break-even permutations.
*/
describe("the ad-set relative Cut path", () => {
  function adset(overrides: Partial<MetaAdSetData> = {}): MetaAdSetData {
    return {
      id: "adset-1",
      accountId: "act-1",
      name: "Adset 1",
      campaignId: "cmp-1",
      status: "ACTIVE",
      budgetLevel: "adset",
      dailyBudget: 100,
      lifetimeBudget: null,
      optimizationGoal: "OFFSITE_CONVERSIONS",
      customEventType: null,
      bidStrategyType: null,
      bidStrategyLabel: null,
      manualBidAmount: null,
      bidValue: null,
      bidValueFormat: null,
      isBudgetMixed: false,
      isConfigMixed: false,
      // A relative loser: ROAS 0.9 sits under the p25 of 1.2 and under the
      // Target ROAS of 2.2, on enough spend to clear the maturity floor.
      spend: 900,
      purchases: 5,
      revenue: 810,
      roas: 0.9,
      cpa: 180,
      ctr: 1,
      cpm: 10,
      impressions: 10000,
      clicks: 100,
      ...overrides,
    } as MetaAdSetData;
  }

  const signal: MetaEntityDecisionSignal = {
    businessId: "biz_1",
    providerAccountId: "act_1",
    scopeType: "adset",
    scopeId: "adset-1",
    asOfDate: "2026-05-14",
    learningState: "OPTIMAL_LEARNING_DONE",
    daysAtLearningState: 14,
    lastSignificantEditAt: null,
    daysSinceSignificantEdit: 14,
    recentChangeCooldownUntil: null,
    creativeAgeDays: 20,
    creativeAgeDaysMax: 20,
    frequencyP80: null,
    ctrDecayPct: null,
    /*
      ROUND 12. An ordinary account: a trusted IANA zone and a config-history
      read that succeeded. Built through the production constructor so this
      fixture cannot drift from what the backfill writes. Without it the ad set
      carries an unrecorded recent-edit authority, and a purchase-budget hard
      action is held before the Target-ROAS precedence under test is ever
      reached. @see lib/meta/recent-edit-authority.ts
    */
    sourceJson: {
      age_days: 20,
      [META_RECENT_EDIT_AUTHORITY_KEY]: metaRecentEditAuthorityRecord({
        status: "ready",
        reason: "observed",
        timeZone: "America/Los_Angeles",
      }),
    },
    qualityStatus: "ready",
  };

  const context: MetaCalibrationContext = {
    thresholds: {
      source: "calibrated",
      hardCutSpend: 200,
      minRequiredSample: 8,
      metrics: {
        ...LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
        roas_28d: { p10: 0.5, p25: 1.2, p50: 2, p75: 3, p90: 4, sampleSize: 20 },
        cpa_28d: { p10: 40, p25: 60, p50: 90, p75: 120, p90: 180, sampleSize: 20 },
      },
    },
    scope: {
      type: "campaign",
      id: "cmp-1",
      snapshotDate: "2026-05-14",
      cohort: "purchase",
    },
    cohort: "purchase",
  };

  const serve = (over: Partial<MetaCommercialTargets>) =>
    buildMetaAdsetRecommendations({
      adsets: [adset()],
      calibrationContext: context,
      commercialTargets: targets(over),
      entitySignalsByAdsetId: { "adset-1": signal },
    } as never);

  /** Everything the operator acts on, with the informational rows separated. */
  function actionable(recommendations: ReturnType<typeof serve>) {
    return recommendations.map((rec) => {
      const { evidence, ...rest } = rec as unknown as {
        evidence?: Array<{ label: string; value: string; tone: string }>;
      } & Record<string, unknown>;
      return {
        ...rest,
        /*
          The "Break-even ROAS" row is DISPLAY, not boundary: the surface shows
          the operator what they typed, beside the Target ROAS the decision
          actually used. It is excluded here and asserted separately below, so
          this comparison is about what governs rather than about what is
          shown.
        */
        evidence: (evidence ?? []).filter(
          (row) => row.label !== "Break-even ROAS",
        ),
      };
    });
  }

  it("serves the SAME relative decision whatever break-even is typed", () => {
    /*
      Four break-evens, including one placed ABOVE the ad-set's ROAS (3.4) and
      one below it (0.5). Under `breakEvenRoas ?? targetRoas` those two straddle
      the boundary the relative path compares against, so they produced
      different verdicts for one unchanged account.

      Compared whole rather than spot-checked on the label: a break-even
      leaking into the reason text, the threshold evidence or the expected
      impact would be a leak into what the operator reads, even where the
      verdict happened to match.
    */
    const served = [
      { breakEvenRoas: null },
      { breakEvenRoas: 1.5 },
      { breakEvenRoas: 0.5 },
      { breakEvenRoas: 3.4 },
    ].map((over) => JSON.stringify(actionable(serve(over))));
    expect(new Set(served).size).toBe(1);
  });

  it("still SHOWS the configured break-even, which is the part that may differ", () => {
    /*
      The complement of the case above, so "inert" is not read as "erased". The
      operator typed a break-even; the surface says so. What it does not do is
      decide anything with it here.
    */
    const withBreakEven = serve({ breakEvenRoas: 1.5 })[0]!;
    const withoutBreakEven = serve({ breakEvenRoas: null })[0]!;
    const labels = (rec: typeof withBreakEven) =>
      (rec.evidence ?? []).map((row) => row.label);
    expect(labels(withBreakEven)).toContain("Break-even ROAS");
    expect(labels(withoutBreakEven)).not.toContain("Break-even ROAS");
    // And the row that carries the BOUNDARY is present either way.
    expect(labels(withoutBreakEven)).toContain("Target ROAS");
  });

  it("still produces a relative Cut, so the invariance above is not vacuous", () => {
    /*
      Four identical EMPTY results would satisfy the assertion above while
      proving nothing. This requires the path to actually fire.
    */
    const recommendations = serve({ breakEvenRoas: 1.5 });
    expect(recommendations.length).toBeGreaterThan(0);
    expect(
      recommendations.some((rec) => rec.type === "adset_cut_spend"),
      JSON.stringify(recommendations.map((rec) => rec.type)),
    ).toBe(true);
    // And it is the RELATIVE boundary that produced it — the p25 efficiency
    // line — not the economic loss line.
    expect(recommendations[0]!.title).toContain(
      "below the calibrated efficiency line",
    );
  });
});
