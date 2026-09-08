import { readdirSync, readFileSync, statSync } from "node:fs";
import { META_BID_INTENT_CONTRACT_VERSION } from "@/lib/meta/bid-intent-contract";
import { launchModeForMetaRec } from "@/lib/meta/rec-label-mapping";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  decisionLabelForMetaRec,
  metaRecTypeDirection,
} from "@/lib/meta/rec-label-mapping";
import {
  annotateMetaRecPresentation,
  serverActionKindForRec,
  serverDecisionLabelForRec,
  serverLaunchModeForRec,
  serverPrimaryActionLabelForRec,
} from "../rec-presentation";
import type { MetaRecommendation, MetaRecommendationType } from "../recommendations";

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec_1",
    level: "adset",
    campaignId: "cmp_1",
    campaignName: "ASC",
    adsetId: "as_1",
    adsetName: "Broad",
    type: "adset_cut_spend",
    lens: "profitability",
    priority: "high",
    confidence: "high",
    decisionState: "act",
    decision: "cut",
    title: "Cut spend",
    why: "Underperforming",
    summary: "Cut it",
    recommendedAction: "Pause this ad set",
    expectedImpact: "Save budget",
    evidence: [],
    timeframeContext: {
      coreVerdict: "",
      selectedRangeOverlay: "",
      historicalSupport: "",
      seasonalityFlag: "none",
      note: null,
    },
    ...overrides,
  } as MetaRecommendation;
}

describe("server-owned rec presentation", () => {
  it("keeps campaign/ad-set mutation suggestions review-only", () => {
    expect(serverPrimaryActionLabelForRec(rec({ type: "adset_cut_spend" }))).toBe(
      "Review cut plan",
    );
    expect(
      serverPrimaryActionLabelForRec(
        rec({
          type: "bid_value_guidance",
          proposedAction: { kind: "apply_bid", bidAmountMinor: 500 },
        }),
      ),
    ).toBe("Review tuning");
    // Scale recs have no execute path on this page - the old UI said
    // "Scale budget" on a button that only opened a drawer.
    const scale = rec({ type: "adset_scale_budget", proposedAction: undefined });
    expect(serverActionKindForRec(scale)).toBe("review_drill");
    expect(serverPrimaryActionLabelForRec(scale)).toBe("Review scale plan");
    const keep = rec({ type: "scenario_m2_mid_funnel_steady_keep", proposedAction: undefined });
    expect(serverPrimaryActionLabelForRec(keep)).toBe("Review status");
  });

  it.each([
    [{ kind: "pause" } as const, "adset_cut_spend"],
    [{ kind: "resume" } as const, "adset_state"],
    [
      { kind: "apply_bid", bidAmountMinor: 500 } as const,
      "bid_value_guidance",
    ],
  ])(
    "does not treat proposedAction %o as provider-write authority",
    (proposedAction, type) => {
      const candidate = rec({
        type: type as MetaRecommendation["type"],
        proposedAction,
      });
      expect(serverActionKindForRec(candidate)).toBe("review_drill");
      expect(serverPrimaryActionLabelForRec(candidate)).toMatch(/^Review /);
    },
  );

  it("never exposes an execute CTA for test or watch decisions", () => {
    const watchCut = rec({
      type: "adset_cut_spend",
      decisionState: "watch",
    });
    expect(serverActionKindForRec(watchCut)).toBe("review_drill");
    expect(serverPrimaryActionLabelForRec(watchCut)).toBe("Review cut plan");

    const testBid = rec({
      type: "bid_value_guidance",
      decisionState: "test",
      proposedAction: { kind: "apply_bid", bidAmountMinor: 500 },
    });
    expect(serverActionKindForRec(testBid)).toBe("review_drill");
    expect(serverPrimaryActionLabelForRec(testBid)).toBe("Review tuning");
  });

  it("routes launchpad handoffs explicitly", () => {
    const rebuild = rec({ type: "rebuild_with_constraints" });
    expect(serverActionKindForRec(rebuild)).toBe("route_launchpad_rebuild");
    expect(serverPrimaryActionLabelForRec(rebuild)).toBe("Rebuild in Launchpad");
    const promote = rec({ type: "winner_promotion_flow" });
    expect(serverActionKindForRec(promote)).toBe("route_launchpad_duplicate");
    expect(serverPrimaryActionLabelForRec(promote)).toBe("Promote in Launchpad");
  });

  it("derives decision labels server-side with engine label precedence", () => {
    expect(serverDecisionLabelForRec(rec({ decisionLabel: "tune" }))).toBe("tune");
    expect(serverDecisionLabelForRec(rec({ type: "adset_cut_spend" }))).toBe("cut");
    expect(
      serverDecisionLabelForRec(
        rec({
          type: "scale_for_profitability",
          recommendedAction: "Reduce budget and tighten the cap",
        }),
      ),
    ).toBe("tune");
    expect(
      serverDecisionLabelForRec(rec({ type: "scenario_e2_ctr_decay_refresh" })),
    ).toBe("refresh");
  });

  it("annotates recommendations with presentation fields and structured metrics", () => {
    const metrics = new Map([
      ["as_1", { spend: 120.5, roas: 1.8, cpa: 22, ctr: 1.1, purchases: 6, frequency: 1.9 }],
    ]);
    const rowPresentation = new Map([
      ["as_1", { accountId: "act_1234567890", thumbLabel: null }],
    ]);
    const [annotated] = annotateMetaRecPresentation([rec()], metrics, rowPresentation);
    expect(annotated.actionKind).toBe("review_drill");
    expect(annotated.primaryActionLabel).toBe("Review cut plan");
    expect(annotated.decisionLabel).toBe("cut");
    expect(annotated.rowPresentation).toMatchObject({
      accountBadge: "act_1234567890",
      thumbLabel: null,
      signal: null,
      autoBadge: false,
    });
    expect(annotated.metrics).toEqual({
      spend: 120.5,
      roas: 1.8,
      cpa: 22,
      ctr: 1.1,
      purchases: 6,
      frequency: 1.9,
    });
    const [noMetrics] = annotateMetaRecPresentation([rec({ adsetId: "unknown" })]);
    expect(noMetrics.metrics).toBeNull();
  });

  it("builds row protection markers from server readiness evidence", () => {
    const [blocked] = annotateMetaRecPresentation([
      rec({
        automationReadiness: {
          contractVersion: "meta-automation-readiness.v1",
          tier: "manual_review",
          autoExecuteEligible: false,
          operatorReviewRequired: true,
          decisionLabel: "cut",
          blockers: ["missing_live_preflight"],
          missingEvidence: ["live_preflight"],
          requiredEvidence: ["commercial_anchor", "live_preflight"],
          reason: "Live preflight is required before execution.",
        },
      }),
    ]);
    expect(blocked.rowPresentation).toMatchObject({
      signal: "blocker",
      blockerLabel: "Missing Live Preflight",
      autoBadge: false,
      warnLine: "Automation blocked · Missing Live Preflight",
    });

    const [auto] = annotateMetaRecPresentation([
      rec({
        automationReadiness: {
          contractVersion: "meta-automation-readiness.v1",
          tier: "auto_execute",
          autoExecuteEligible: true,
          operatorReviewRequired: false,
          decisionLabel: "cut",
          blockers: [],
          missingEvidence: [],
          requiredEvidence: ["commercial_anchor"],
          reason: "All checks passed.",
        },
      }),
    ]);
    expect(auto.rowPresentation).toMatchObject({
      signal: null,
      autoBadge: true,
      warnLine: null,
    });
  });
});

describe("invariant: Meta redesign UI does not compute action semantics", () => {
  function sourceFiles(dir: string): string[] {
    return readdirSync(dir).flatMap((entry) => {
      const full = join(dir, entry);
      if (statSync(full).isDirectory()) return sourceFiles(full);
      if (!/\.(ts|tsx)$/.test(entry) || /\.test\./.test(entry)) return [];
      return [full];
    });
  }

  it("keeps rec-label-mapping (client-side semantics) out of the redesign components", () => {
    const offenders = sourceFiles("components/meta/redesign").filter((file) =>
      readFileSync(file, "utf8").includes("rec-label-mapping"),
    );
    expect(offenders).toEqual([]);
  });

  it("keeps regex/string inference over recommendedAction out of the redesign components", () => {
    const offenders = sourceFiles("components/meta/redesign").filter((file) => {
      const source = readFileSync(file, "utf8");
      return /recommendedAction[^;\n]*\.(match|test|includes|search)\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });

  it("keeps evidence display-string parsing out of compare/bulk math", () => {
    const offenders = sourceFiles("components/meta/redesign").filter((file) => {
      const source = readFileSync(file, "utf8");
      return /evidence\.find\([^)]*\)\s*\??\.\s*value\.replace\(/.test(source);
    });
    expect(offenders).toEqual([]);
  });
});

/**
 * ONE DIRECTION MAPPER, ASKED TWO WAYS.
 *
 * `rec-presentation.ts` carried its own ten type Sets — SCALE_TYPES,
 * CUT_TYPES, REBUILD_TYPES, SWITCH_TYPES, TUNE_TYPES, SWAP_TYPES, TEST_TYPES,
 * REFRESH_TYPES, KEEP_TYPES and the launch-routing DUPLICATE_TYPES — consulted
 * in a fixed order to answer the question `decisionLabelForMetaRec` answers
 * from `META_REC_TYPE_DIRECTION`. Two tables for one question is two answers
 * waiting to happen, and five had already happened.
 *
 * The permutation below enumerates the type union out of the source file
 * rather than restating it, so a type added to `MetaRecommendationType`
 * tomorrow is covered without anyone remembering to add it here.
 */
describe("the direction mapper has one table", () => {
  function declaredRecommendationTypes(): MetaRecommendationType[] {
    const source = readFileSync("lib/meta/recommendations.ts", "utf8");
    const union = source.split("export type MetaRecommendationType =")[1]?.split(";")[0];
    expect(union, "MetaRecommendationType union not found").toBeTruthy();
    const types = [...union!.matchAll(/"([a-z0-9_]+)"/g)].map(
      (match) => match[1] as MetaRecommendationType,
    );
    // A parse that silently matched nothing would make every assertion vacuous.
    expect(types.length).toBeGreaterThan(80);
    return types;
  }

  /** A bare recommendation: no explicit label, so the type decides alone. */
  function typedRec(type: MetaRecommendationType): MetaRecommendation {
    return rec({ type, decisionLabel: undefined, recommendedAction: "" });
  }

  it("gives every mapped type exactly one answer on both readers", () => {
    const divergent = declaredRecommendationTypes()
      .filter((type) => metaRecTypeDirection(type) !== null)
      .filter(
        (type) =>
          serverDecisionLabelForRec(typedRec(type)) !==
          decisionLabelForMetaRec(typedRec(type)),
      );
    expect(divergent).toEqual([]);
  });

  it.each([
    "scenario_a2_learning_weak_structural",
    "scenario_a4_learning_limited_persistent",
    "scenario_a5_post_learning_underperformer",
    "scenario_i2_abo_to_cbo",
    "scenario_i3_cbo_overcrowded",
  ] as MetaRecommendationType[])(
    "serves %s as rebuild, which is what its persisted decision_label already says",
    (type) => {
      /*
        The five the two tables disagreed about. Each belonged to no Set in
        `rec-presentation.ts`, so the presentation read fell through to its
        `diagnose` fallback while the canonical table said `rebuild`.

        MEASURED, read-only against production on 2026-09-07:
        `meta_decision_snapshots_daily` holds 237
        `scenario_a2_learning_weak_structural` rows and every one persists
        `decision_label = 'rebuild'`, because `recommendationToSnapshotRow`
        (lib/meta/snapshot.ts:424) stamps that column from
        `decisionLabelForMetaRec`. The a2 emitter
        (lib/meta/scenario-emitters/high-priority.ts) sets no `decisionLabel`
        of its own, so the freshly computed row served through
        `annotateMetaRecPresentation` came back as `diagnose` — the stored
        verdict said "rebuild this structure" and the served chip said "we are
        still looking into it".
      */
      expect(metaRecTypeDirection(type)).toBe("rebuild");
      expect(decisionLabelForMetaRec(typedRec(type))).toBe("rebuild");
      expect(serverDecisionLabelForRec(typedRec(type))).toBe("rebuild");
      const [annotated] = annotateMetaRecPresentation([typedRec(type)]);
      expect(annotated.decisionLabel).toBe("rebuild");
    },
  );

  it.each([
    "scenario_a2_learning_weak_structural",
    "scenario_a4_learning_limited_persistent",
    "scenario_a5_post_learning_underperformer",
    "scenario_i2_abo_to_cbo",
    "scenario_i3_cbo_overcrowded",
  ] as MetaRecommendationType[])(
    "changes no code, no CTA and no authority for %s",
    (type) => {
      /*
        Removing a duplicate table must move the label and nothing else. None
        of these five routes to a Launchpad flow, so the control still opens
        the drill drawer under the same copy: `rebuild` has no case in
        `serverPrimaryActionLabelForRec`'s switch and neither did `diagnose`,
        so both resolve to the same default.
      */
      const [annotated] = annotateMetaRecPresentation([typedRec(type)]);
      expect(annotated.actionKind).toBe("review_drill");
      expect(annotated.primaryActionLabel).toBe("Open diagnostics");
      expect(annotated.operatorApply).toBeNull();
      expect(serverLaunchModeForRec(typedRec(type))).toBeNull();
    },
  );

  it("keeps an explicit builder label, a defensive verdict and a minted promotion identical on both readers", () => {
    /*
      Everything above the table is shared code now, but the two readers used
      to run it in different orders and `serverDecisionLabelForRec` never saw
      `labelTransform` at all — it was not in its parameter type. A
      `promote_test_to_main` row minted FROM `scale_for_profitability` carries
      `decisionLabel: "scale"` written by the guard, so the presentation read
      returned Scale for a below-benchmark campaign while the canonical read
      returned Tune.
    */
    const cases: Array<Partial<MetaRecommendation>> = [
      { type: "adset_scale_budget", decisionLabel: "cut" },
      { type: "scale_for_profitability", decisionLabel: undefined },
      { type: "scale_for_profitability", decisionLabel: "scale" },
      { type: "scale_for_profitability", decisionLabel: "cut" },
      {
        type: "promote_test_to_main",
        decisionLabel: "scale",
        labelTransform: {
          reason: "test_scale_to_promote_main",
          campaignKind: "test",
          fromType: "scale_for_profitability",
          toType: "promote_test_to_main",
          fromDecisionLabel: null,
          toDecisionLabel: "scale",
        },
      },
      { kind: "anomaly", type: "adset_cut_spend" },
      { kind: "state", type: "campaign_state", decisionState: "watch" },
      { kind: "state", type: "campaign_state", decisionState: "test" },
    ];
    for (const overrides of cases) {
      const candidate = rec({ recommendedAction: "", ...overrides });
      expect(
        serverDecisionLabelForRec(candidate),
        JSON.stringify(overrides),
      ).toBe(decisionLabelForMetaRec(candidate));
    }
    // And the promotion minted from a defensive verdict is Tune on both.
    expect(
      serverDecisionLabelForRec(rec({
        type: "promote_test_to_main",
        decisionLabel: "scale",
        recommendedAction: "",
        labelTransform: {
          reason: "test_scale_to_promote_main",
          campaignKind: "test",
          fromType: "scale_for_profitability",
          toType: "promote_test_to_main",
          fromDecisionLabel: null,
          toDecisionLabel: "scale",
        },
      })),
    ).toBe("tune");
  });

  it.each([
    ["budget_allocation", "keep", "diagnose"],
    ["promote_test_to_main", "keep", "diagnose"],
  ] as Array<[MetaRecommendationType, string, string]>)(
    "keeps each reader's documented fallback for the unmapped type %s",
    (type, engineFallback, presentationFallback) => {
      /*
        THE ONE THING THE TWO READERS ANSWER DIFFERENTLY, AND WHY.

        Neither type has an entry in the shared table — asserted here, so this
        cannot quietly become a third mapping — and each caller supplies its own
        fallback for that case:

          - the engine reader passes `keep`, and that is what is already stored:
            114 persisted `budget_allocation` rows carry `keep`, `diagnose` and
            `test_more` in `decision_label` (production, read-only, 2026-09-07).
          - the presentation reader passes `diagnose`, because `keep` is an
            AFFIRMATIVE soft label and `budget_allocation` is a member of the
            guard's HARD_ACTION_TYPES. A held budget reallocation labelled
            "Keep" in the blocked lane is exactly what `heldVerdictLabel`
            (lib/meta/campaign-label-guard.ts) already refuses to write, and the
            contract forbids ("a non-null blocked_action_type means blocked and
            never an affirmative soft label").
      */
      expect(metaRecTypeDirection(type)).toBeNull();
      expect(decisionLabelForMetaRec(typedRec(type))).toBe(engineFallback);
      expect(serverDecisionLabelForRec(typedRec(type))).toBe(presentationFallback);
    },
  );

  it("keeps the launch-routing Sets answering their own question", () => {
    /*
      `REBUILD_TYPES` and `DUPLICATE_TYPES` survived the removal because they
      answer where the CTA hands off, not which way the verdict points, and
      `creative_test_structure` is the proof that those are different
      questions: it routes to the rebuild flow as a demotion while its
      direction is `test_more`. Folding it into the direction table would have
      relabelled it.
    */
    const demote = rec({ type: "creative_test_structure", decisionLabel: undefined });
    expect(serverLaunchModeForRec(demote)).toBe("rebuild");
    expect(serverDecisionLabelForRec(demote)).toBe("test_more");
    expect(decisionLabelForMetaRec(demote)).toBe("test_more");
    expect(serverPrimaryActionLabelForRec(demote)).toBe("Demote in Launchpad");

    const promote = rec({ type: "winner_promotion_flow", decisionLabel: undefined });
    expect(serverLaunchModeForRec(promote)).toBe("duplicate");
    expect(serverDecisionLabelForRec(promote)).toBe("scale");
    expect(serverPrimaryActionLabelForRec(promote)).toBe("Promote in Launchpad");
  });
});

/*
  CODEX C23 — one launch-mode mapper, one bid condition.

  `serverLaunchModeForRec` and `launchModeForMetaRec` were both live and
  DIVERGED on the bid case: the server one asked the validated bid intent, the
  label one asked for a `bid_value_guidance` type that no producer emits at
  ad-set grain. Two answers to "may this row apply a bid" is the same
  duplicate-table defect the direction mapper already had.
*/
describe("the launch-mode mappers cannot disagree", () => {
  const withIntent = {
    kind: "recommendation" as const,
    type: "bid_value_guidance" as const,
    level: "adset" as const,
    // A genuinely executable envelope, as `executableBidIntentMinorUnits`
    // defines one: authorised, unblocked, and with the proposed amount and the
    // bid amount agreeing.
    targetValue: {
      kind: "bid_intent",
      contractVersion: META_BID_INTENT_CONTRACT_VERSION,
      authorityStatus: "authorised",
      blockerCodes: [],
      proposedMinorUnits: 1320,
      bidAmountMinor: 1320,
    } as never,
  };

  it("answers apply_bid from the validated intent, not from a label", () => {
    expect(serverLaunchModeForRec(withIntent)).toBe("apply_bid");
    expect(launchModeForMetaRec(withIntent)).toBe("apply_bid");
  });

  it("agrees on every shape, including the retired label", () => {
    const shapes = [
      withIntent,
      { ...withIntent, targetValue: null },
      { ...withIntent, type: "bid_value_guidance" as const, targetValue: null },
      { ...withIntent, level: "campaign" as const },
      { kind: "anomaly" as const, type: "scale_for_volume" as const, level: "adset" as const, targetValue: null },
      { kind: "recommendation" as const, type: "rebuild_with_constraints" as const, level: "campaign" as const, targetValue: null },
      { kind: "recommendation" as const, type: "winner_promotion_flow" as const, level: "campaign" as const, targetValue: null },
    ];
    for (const shape of shapes) {
      expect(
        serverLaunchModeForRec(shape as never),
        JSON.stringify({ type: shape.type, level: shape.level }),
      ).toBe(launchModeForMetaRec(shape as never));
    }
  });

  it("still answers null for an ad set with neither an intent nor the label", () => {
    // The control: the shared condition is not simply "adset means apply_bid".
    expect(
      serverLaunchModeForRec({
        ...withIntent,
        type: "scale_for_volume" as const,
        targetValue: null,
      }),
    ).toBeNull();
  });
});
