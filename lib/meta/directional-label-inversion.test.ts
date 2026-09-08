import { describe, expect, it } from "vitest";
import {
  META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
  applyMetaCampaignLabelGuard,
  type MetaCampaignContextGuardEntry,
} from "@/lib/meta/campaign-label-guard";
import { enforceMetaCommercialActionAuthority } from "@/lib/meta/commercial-action-authority";
import {
  decisionLabelForMetaRec,
  type MetaRecLabelInput,
} from "@/lib/meta/rec-label-mapping";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

/*
  The live inversion, as a fixture.

  Read from production on 2026-09-07 over the read-only tunnel:

    select rec_id, decision_label, recommended_action
      from meta_decision_snapshots_daily
     where rec_type = 'scale_for_profitability' and decision_label = 'scale'

  106 rows, latest snapshot_date 2026-09-07. The newest belongs to Grandmix
  (business 5dbc7147-f051-4681-a4d6-20617170074f), campaign
  "Claude-OtherCountries-DPA": decision_label 'scale' sitting over
  "Reduce spend pressure, tighten the bid or audience, and reallocate budget
  toward stronger campaigns." — the operator was shown SCALE over text telling
  them to REDUCE.

  Everything below is copied verbatim from that row's
  `evidence.recommendation` payload, with the three things the guard itself
  added removed so this is the recommendation as the builder emitted it: the
  appended "Automatic Main/Test/Mixed inference is high confidence…" sentence
  on `why`, the "Campaign context" evidence item, and the review-only
  confidence envelope (`confidence`, `confidenceReason`, `decisionLabel`,
  `campaignContext`, the campaign_context_* signal-quality keys, `priority`
  medium). Each of those is asserted back below, so the fixture is checked
  against the real row rather than merely resembling it.
*/
const GRANDMIX_CAMPAIGN_ID = "120247018751090316";

const GRANDMIX_DEFENSIVE_ACTION =
  "Reduce spend pressure, tighten the bid or audience, and reallocate budget toward stronger campaigns.";

/** The other live text this type emits, on lowest_cost campaigns (82 of the 106 rows). */
const GRANDMIX_COST_CAP_ACTION =
  "Hold or reduce budget 10-15% and test Cost Cap or Target ROAS before scaling again.";

function grandmixProfitabilityRec(
  overrides: Partial<MetaRecommendation> = {},
): MetaRecommendation {
  return {
    id: "profit-120247018751090316",
    level: "campaign",
    campaignId: GRANDMIX_CAMPAIGN_ID,
    campaignName: "Claude-OtherCountries-DPA",
    type: "scale_for_profitability",
    lens: "profitability",
    priority: "high",
    confidence: "medium",
    confidenceScore: 0.62,
    confidenceReason: null,
    decisionState: "watch",
    decision: "Protect profitability before scaling",
    title: "Claude-OtherCountries-DPA: profitability should come before scale",
    why: "This campaign is consuming meaningful spend while trailing the efficiency benchmark of campaigns with the same optimization intent.",
    summary: "Scaling now would likely amplify waste faster than revenue.",
    recommendedAction: GRANDMIX_DEFENSIVE_ACTION,
    expectedImpact: "Lower wasted spend and cleaner budget allocation.",
    evidence: [
      { label: "Spend share", value: "20.44%", tone: "warning" },
      { label: "Core ROAS", value: "0.95x", tone: "warning" },
      { label: "Peer-group ROAS", value: "2.02x", tone: "neutral" },
      { label: "Loss maturity spend", value: "$500.00", tone: "neutral" },
      { label: "Target ROAS", value: "2.20x", tone: "neutral" },
      { label: "Break-even ROAS", value: "1.80x", tone: "neutral" },
    ],
    timeframeContext: {
      coreVerdict:
        "Core verdict says profitability is weaker than the comparable optimization cohort.",
      selectedRangeOverlay:
        "Selected range currently reads 0.92x ROAS on $8,210.70 spend.",
      historicalSupport: "Historical weakness confirmed in 5/5 independent segments.",
      seasonalityFlag: "none",
      note: null,
    },
    campaignRole: "catalog_dpa",
    bidRegime: "lowest_cost",
    cohort: "purchase",
    comparisonCohort: "PURCHASE",
    strategyLayer: "scaling",
    engineVersion: "v1.2.0-target-age-advisory",
    evidenceTrail: {
      age_days: 27,
      roas_history: [
        0, 0.62, 0, 0, 1.15, 1.55, 0, 2.45, 1.32, 3.2, 4.58, 0, 1.29, 2.08, 2.02,
        1.05, 0.94, 0, 0.66, 0.76, 0, 0, 1.43, 0.59, 0, 2.01,
      ],
      recent_changes: [],
      peer_comparison: { p10: 0, p50: 0, p90: 0, this_value: 2.01 },
      regime_stability: 0.8846,
    },
    signalQuality: {
      stability: { suppressed: false, raw_decision_state: "watch" },
    },
    ...overrides,
  };
}

/*
  The context state that produced the live row, rebuilt from what it persisted:
  signal_quality.campaign_context_status "medium",
  campaign_context_kind "main", campaign_context_source "system_inferred",
  campaign_context_action_authority "resolver_unvalidated", and the evidence
  item "Automatic high · main · resolver validation pending · review-only".
  Only `inferenceConfidenceClass: "high"` with
  `resolverAuthorityValidated: false` produces that combination, and only a
  contextTrust below "high" sends the row down the review-only branch.
*/
const GRANDMIX_CONTEXT: MetaCampaignContextGuardEntry = {
  kind: "main",
  contextTrust: "medium",
  source: "system_inferred",
  inferenceConfidenceClass: "high",
  resolverAuthorityValidated: false,
};

/*
  The RESOLVED Test role, spelled out in full.

  `isContextTrustedForAction` requires `contextTrust: "high"`,
  `inferenceConfidenceClass: "high"` AND `resolverAuthorityValidated: true` all
  present and agreeing; a high trust with the provenance simply omitted is a
  claim the resolver has not backed and no longer unlocks kind semantics. These
  cases are about DIRECTION, so they need the role actually resolved — an entry
  that fails the boundary would send the row down the review-only branch and
  the promotion under test would never be reached for either reason.
*/
const RESOLVED_TEST_ROLE: MetaCampaignContextGuardEntry = {
  kind: "test",
  contextTrust: "high",
  source: "system_inferred",
  inferenceConfidenceClass: "high",
  resolverAuthorityValidated: true,
};

function guard(
  recommendations: MetaRecommendation[],
  context: ReadonlyMap<string, MetaCampaignContextGuardEntry> = new Map([
    [GRANDMIX_CAMPAIGN_ID, GRANDMIX_CONTEXT],
  ]),
) {
  return applyMetaCampaignLabelGuard({
    recommendations,
    campaignLabelsById: null,
    campaignContextById: context,
    automaticContextEnabled: true,
    activeCampaignIds: [GRANDMIX_CAMPAIGN_ID],
  }).recommendations;
}

/**
 * What `recommendationToSnapshotRow` writes into `decision_label`
 * (lib/meta/snapshot.ts) — the same call, on the same guarded recommendation.
 */
function persistedDecisionLabel(rec: MetaRecommendation) {
  return decisionLabelForMetaRec(rec);
}

describe("directional label: the live Grandmix inversion", () => {
  it("reproduces the production row and stops labelling defensive text Scale", () => {
    const [guarded] = guard([grandmixProfitabilityRec()]);

    // The defect, pinned at both places it surfaced: the chip the Decision
    // Center adapter renders from `decisionLabel`, and the `decision_label`
    // the snapshot writer persists.
    expect(guarded?.decisionLabel).toBe("tune");
    expect(persistedDecisionLabel(guarded!)).toBe("tune");
    expect(guarded?.recommendedAction).toBe(GRANDMIX_DEFENSIVE_ACTION);

    // Same fixture, same guard branch, same output row as production — so the
    // label above is the one that account really got, not a nearby shape.
    expect(guarded).toMatchObject({
      decisionState: "watch",
      confidence: "low",
      confidenceScore: 0.45,
      priority: "medium",
      confidenceReason: META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
      campaignContext: {
        kind: "main",
        source: "system_inferred",
        confidence: "high",
        trustedForAction: false,
      },
      signalQuality: {
        campaign_context_kind: "main",
        campaign_context_source: "system_inferred",
        campaign_context_status: "medium",
        campaign_context_action_authority: "resolver_unvalidated",
      },
      automationReadiness: { tier: "read_only", autoExecuteEligible: false },
    });
    expect(guarded?.evidence).toContainEqual({
      label: "Campaign context",
      value: "Automatic high · main · resolver validation pending · review-only",
      tone: "warning",
    });
    expect(guarded?.why).toContain(
      "this resolver version has not passed the independent authority gate",
    );
  });

  it("stops labelling the lowest_cost variant Scale as well", () => {
    // The 82 remaining live rows: same type, the Cost Cap text.
    const [guarded] = guard([
      grandmixProfitabilityRec({ recommendedAction: GRANDMIX_COST_CAP_ACTION }),
    ]);

    expect(guarded?.decisionLabel).toBe("tune");
    expect(persistedDecisionLabel(guarded!)).toBe("tune");
  });

  it("corrects an already-persisted Scale row on read without rewriting it", () => {
    // `hydrateRecommendation` restores `decisionLabel` from the stored
    // `decision_label` (lib/meta/snapshot.ts), so the 106 rows already on disk
    // come back into the guard carrying 'scale'. History stays as written; the
    // served direction follows the text.
    const [guarded] = guard([grandmixProfitabilityRec({ decisionLabel: "scale" })]);

    expect(guarded?.decisionLabel).toBe("tune");
    expect(persistedDecisionLabel(guarded!)).toBe("tune");
  });

  it("does not turn a defensive verdict into a promote-to-main payload", () => {
    // The second path through the same inference: on an automatically
    // classified Test campaign a "scale" reading is transformed into
    // `promote_test_to_main` ("Promote winning test to Main"), which would
    // have escalated the inversion from a wrong chip to a wrong flow.
    const [guarded] = guard(
      [grandmixProfitabilityRec()],
      new Map([
        [
          GRANDMIX_CAMPAIGN_ID,
          RESOLVED_TEST_ROLE,
        ],
      ]),
    );

    // The load-bearing assertions are the type, the absent transform and the
    // persisted label: the transform did not fire and the direction stayed
    // defensive. `decisionLabel` is asserted POSITIVELY — the fixture carries
    // none, and a `not.toBe("scale")` on an undefined field would have passed
    // with or without the fix and proved nothing.
    expect(guarded?.type).toBe("scale_for_profitability");
    expect(guarded?.labelTransform).toBeUndefined();
    expect(guarded?.decisionLabel).toBeUndefined();
    expect(persistedDecisionLabel(guarded!)).toBe("tune");
    expect(guarded?.recommendedAction).toBe(GRANDMIX_DEFENSIVE_ACTION);
  });
});

describe("directional label: what must not move", () => {
  it("still scales a real scale verdict through the same guard branch", () => {
    const [guarded] = guard([
      grandmixProfitabilityRec({
        id: "scale-volume",
        type: "scale_for_volume",
        lens: "volume",
        recommendedAction: "Increase budget 10-15%.",
      }),
    ]);

    expect(guarded?.decisionLabel).toBe("scale");
    expect(persistedDecisionLabel(guarded!)).toBe("scale");
  });

  it("still promotes a real Test-campaign scale verdict to Main", () => {
    const [guarded] = guard(
      [
        grandmixProfitabilityRec({
          id: "scale-volume",
          type: "scale_for_volume",
          lens: "volume",
          recommendedAction: "Increase budget 10-15%.",
        }),
      ],
      new Map([
        [
          GRANDMIX_CAMPAIGN_ID,
          RESOLVED_TEST_ROLE,
        ],
      ]),
    );

    expect(guarded?.type).toBe("promote_test_to_main");
    expect(guarded?.decisionLabel).toBe("scale");
    expect(guarded?.labelTransform).toMatchObject({
      fromDecisionLabel: "scale",
      toDecisionLabel: "scale",
    });
  });

  it("hands a scale-set type its canonical direction, not the set's name", () => {
    /*
      The one other place the guard's set membership and the canonical mapper
      disagreed: `scenario_d3_lal_compound_scale` is in SCALE_ACTION_TYPES but
      the mapper reads it as an audience `swap`. The guard used to write
      "scale" over that and the snapshot then persisted "scale". It is a
      deliberate consequence of having one mapper, and it is unobserved in
      production — that type has never been emitted (0 rows in
      meta_decision_snapshots_daily as of 2026-09-07).
    */
    const [guarded] = guard([
      grandmixProfitabilityRec({
        id: "d3",
        type: "scenario_d3_lal_compound_scale",
        recommendedAction: "Compound the lookalike winner into its own lane.",
      }),
    ]);

    expect(guarded?.decisionLabel).toBe("swap");
    expect(persistedDecisionLabel(guarded!)).toBe("swap");
  });

  it("keeps a builder's own non-scale label", () => {
    // Only an affirmative Scale claim loses to the text. A real 'cut' stands.
    expect(
      decisionLabelForMetaRec({
        type: "scale_for_profitability",
        decisionState: "act",
        decisionLabel: "cut",
        recommendedAction: GRANDMIX_DEFENSIVE_ACTION,
      }),
    ).toBe("cut");
  });

  it("survives a downstream rewrite of the action text", () => {
    /*
     * THE REWRITE IS REAL AND IT IS ABOUT TO BECOME THE COMMON CASE.
     *
     * This test used to assert the opposite — that a `scale_for_profitability`
     * with no defensive vocabulary keeps a Scale label — on the reasoning that
     * the row's own words should decide. The words are not stable.
     * `enforceMetaCommercialActionAuthority` REPLACES `recommendedAction` when
     * the commercial anchor is missing, `scale_for_profitability` is in its
     * COMMERCIAL_ACTION_TYPES, and it runs before the label is stamped on the
     * fresh path and before the guard on the read path. Its replacement text
     * carries none of the defensive vocabulary, so a text-driven rule handed
     * that row straight back to Scale.
     *
     * "The Meta anchor is missing, so hold" is exactly the state the canonical
     * Meta-AOV rule produces on purpose, which is why this was worth changing:
     * the latent case was the one about to become common.
     *
     * The real function is driven here, not a copy of its string.
     */
    const held = enforceMetaCommercialActionAuthority(
      {
        ...grandmixProfitabilityRec(),
        decisionLabel: "scale",
      } as MetaRecommendation,
      // No break-even ROAS: `scale_for_profitability` is a ROAS_LOSS_TYPE, so
      // this is the anchor it asks for and the blocker it raises.
      { targetRoas: 2.2 } as never,
    );

    expect(held.recommendedAction).toContain("Review the evidence");
    expect(held.recommendedAction).not.toMatch(
      /reduce|tighten|reallocate|hold/i,
    );
    expect(held.signalQuality?.hard_action_authority).toBe("blocked");
    // The verdict is still defensive; only the sentence changed.
    expect(decisionLabelForMetaRec(held)).toBe("tune");
  });

  it("does not serve an escalated defensive verdict as a promotion to Scale", () => {
    /*
     * 67 ROWS ON DISK, AND THEY STILL HYDRATE.
     *
     * `applyTestCampaignSemantics` re-types a scale verdict on a Test campaign
     * into `promote_test_to_main` and rewrites the action text, so after the
     * transform neither the defensive type name nor the defensive wording
     * survives. The fix upstream stops NEW ones being minted, but the persisted
     * rows are not rewritten — history is not rewritten — so they must be
     * corrected on the read or the operator keeps being offered a promotion for
     * a below-benchmark campaign.
     *
     * MEASURED read-only on 2026-09-07 over `meta_decision_snapshots_daily`:
     * 253 `promote_test_to_main` rows, grouped by
     * `labelTransform.fromType` — `adset_scale_budget` 129,
     * `scale_for_profitability` 67, `scale_for_volume` 34,
     * `scenario_c1_controlled_scale` 23. Every one carries
     * `fromDecisionLabel: 'scale'`. Latest 2026-08-26.
     */
    const escalated: MetaRecLabelInput = {
      type: "promote_test_to_main",
      decisionState: "act",
      decisionLabel: "scale",
      recommendedAction:
        "Promote the validated Test setup into a Main campaign or Main ad set lane, then scale from the Main structure under normal guardrails.",
      labelTransform: {
        reason: "test_scale_to_promote_main",
        campaignKind: "test",
        fromType: "scale_for_profitability",
        toType: "promote_test_to_main",
        fromDecisionLabel: "scale",
        toDecisionLabel: "scale",
      },
    };

    expect(decisionLabelForMetaRec(escalated)).toBe("tune");
  });

  it("leaves a promotion minted from a genuine scale verdict alone", () => {
    // The other 186 of the 253. `adset_scale_budget`, `scale_for_volume` and
    // `scenario_c1_controlled_scale` are real scale types, so their promotions
    // are correct and must not be swept up by the correction above.
    for (const fromType of [
      "adset_scale_budget",
      "scale_for_volume",
      "scenario_c1_controlled_scale",
    ] as const) {
      expect(
        decisionLabelForMetaRec({
          type: "promote_test_to_main",
          decisionState: "act",
          decisionLabel: "scale",
          recommendedAction:
            "Promote the validated Test setup into a Main campaign or Main ad set lane, then scale from the Main structure under normal guardrails.",
          labelTransform: {
            reason: "test_scale_to_promote_main",
            campaignKind: "test",
            fromType,
            toType: "promote_test_to_main",
            fromDecisionLabel: "scale",
            toDecisionLabel: "scale",
          },
        }),
        fromType,
      ).toBe("scale");
    }
  });

  it("corrects an inherited Scale when the campaign role IS resolved", () => {
    /*
     * THE BRANCH THE REPAIR WOULD HAVE MISSED, AND WHEN IT WOULD HAVE BITTEN.
     *
     * `restrictAutomaticContextToReview` is the only place the guard used to
     * write `decisionLabel`, and it runs ONLY when the campaign's automatic
     * role is unresolved. All 106 live `scale_for_profitability` rows sit on
     * that branch today (105 `review_only` + 1 `resolver_unvalidated`), so the
     * unresolved case alone made the surface look correct — while those rows
     * are waiting on exactly the resolver authority whose arrival moves them to
     * the resolved branch, where the guard returned the recommendation
     * untouched with its inherited Scale.
     *
     * High confidence + system-inferred + resolver validated is the resolved
     * state, and it is the one nobody would have re-checked.
     */
    const resolved: MetaCampaignContextGuardEntry = {
      kind: "main",
      contextTrust: "high",
      source: "system_inferred",
      inferenceConfidenceClass: "high",
      resolverAuthorityValidated: true,
    };
    const [guarded] = guard(
      [grandmixProfitabilityRec({ decisionLabel: "scale" })],
      new Map([[GRANDMIX_CAMPAIGN_ID, resolved]]),
    );

    // Still the resolved path — the row is NOT downgraded to review-only.
    expect(guarded?.confidenceReason).not.toBe(
      META_AUTOMATIC_CONTEXT_RESOLVER_UNVALIDATED_REASON,
    );
    expect(guarded?.recommendedAction).toBe(GRANDMIX_DEFENSIVE_ACTION);
    // Only the direction moved.
    expect(guarded?.decisionLabel).toBe("tune");
    expect(persistedDecisionLabel(guarded!)).toBe("tune");
  });

  it("does not read a defensive direction into any other type", () => {
    /*
     * The guard against widening the rule. `scale_for_profitability` is
     * defensive by construction — `maybeProfitabilityRecommendation` is its
     * only producer and returns null unless the campaign is BELOW both
     * `weakRoasThreshold` and `cutCeiling` — and that reasoning is about this
     * type and no other. A genuine scale type keeps Scale whatever its text
     * says.
     */
    expect(
      decisionLabelForMetaRec({
        type: "scale_for_volume",
        decisionState: "act",
        recommendedAction: "Increase budget 10-15% and keep the current bid.",
      }),
    ).toBe("scale");
    expect(
      decisionLabelForMetaRec({
        type: "adset_scale_budget",
        decisionState: "act",
        decisionLabel: "scale",
        recommendedAction: "Reduce spend pressure and reallocate budget.",
      }),
    ).toBe("scale");
  });

  it("decides the direction from the type, never from the sentence", () => {
    /*
     * NO PROSE IS AUTHORITY — not even for the degree.
     *
     * The degree used to be read from the words: a `/\b(pause|cut|stop)\b/`
     * test chose Cut over Tune. Measured read-only on 2026-09-07 across every
     * persisted `scale_for_profitability` row in `meta_decision_snapshots_daily`:
     * ZERO contain "pause", "cut" or "stop" in `recommended_action`. The
     * producer writes exactly two sentences and neither carries a stop verb, so
     * that branch had never fired and could not — dead code reading as a live
     * rule, and keyed on a language.
     *
     * Every one of these is the same verdict, so every one is Tune: both
     * production texts, a translation, a rewritten text, and no text at all.
     */
    const sentences = [
      GRANDMIX_DEFENSIVE_ACTION,
      GRANDMIX_COST_CAP_ACTION,
      // Turkish, because a rule keyed on English words is a rule that a
      // translated deployment silently inverts.
      "Harcama baskısını azaltın, teklifi veya kitleyi daraltın.",
      // The downstream commercial-authority rewrite, which carries no
      // defensive vocabulary at all.
      "Review the evidence, complete the missing target provenance or action-specific anchor, and then re-evaluate. Do not change spend from this recommendation yet.",
      // A sentence that would have read as a stop under the old regex.
      "Pause this campaign and stop the spend.",
      "",
    ];
    for (const recommendedAction of sentences) {
      expect(
        decisionLabelForMetaRec({
          type: "scale_for_profitability",
          decisionState: "act",
          decisionLabel: "scale",
          recommendedAction,
        }),
        recommendedAction || "(no text)",
      ).toBe("tune");
    }
    // And with the field absent entirely.
    expect(
      decisionLabelForMetaRec({
        type: "scale_for_profitability",
        decisionState: "act",
        decisionLabel: "scale",
      }),
    ).toBe("tune");
  });

  it("lets a builder's own structured Cut through, which is the only way to a Cut", () => {
    /*
     * A Cut needs an EXPLICIT STRUCTURED INTENT, and the typed path is already
     * open: a builder that means Cut writes `decisionLabel: "cut"`, which is an
     * explicit label and wins. Only an affirmative `scale` claim is ever
     * overruled.
     *
     * The 178 rows carrying the structured `confidenceReason:
     * "severe_loser_bypass"` are deliberately NOT treated as a stop intent —
     * the producer expresses none, and their own `decision` field reads "Watch
     * efficiency before making larger cuts". Reading a stop out of a
     * confidence-bypass flag would invent an authority the engine never
     * claimed.
     */
    expect(
      decisionLabelForMetaRec({
        type: "scale_for_profitability",
        decisionState: "act",
        decisionLabel: "cut",
        recommendedAction: GRANDMIX_DEFENSIVE_ACTION,
      }),
    ).toBe("cut");
    expect(
      decisionLabelForMetaRec({
        type: "scale_for_profitability",
        decisionState: "watch",
        decisionLabel: "keep",
        recommendedAction: GRANDMIX_DEFENSIVE_ACTION,
      }),
    ).toBe("keep");
  });

  it("keeps the Test-role promotion path off a defensive verdict, and on a real one", () => {
    /*
     * The Launchpad/Test-role edge, both ways. On an automatically classified
     * Test campaign the guard turns a scale reading into
     * `promote_test_to_main` — a flow, not just a chip. A defensive verdict
     * must not reach it; a genuine scale verdict must.
     */
    const testRole = new Map([
      [
        GRANDMIX_CAMPAIGN_ID,
        RESOLVED_TEST_ROLE,
      ],
    ]);

    const [defensive] = guard([grandmixProfitabilityRec()], testRole);
    expect(defensive?.type).toBe("scale_for_profitability");
    expect(defensive?.labelTransform).toBeUndefined();

    const [genuine] = guard(
      [
        grandmixProfitabilityRec({
          id: "scale-volume-test-role",
          type: "scale_for_volume",
          recommendedAction: "Increase budget 10-15% while ROAS holds.",
        }),
      ],
      testRole,
    );
    expect(genuine?.type).toBe("promote_test_to_main");
    expect(genuine?.labelTransform?.fromType).toBe("scale_for_volume");
  });
});
