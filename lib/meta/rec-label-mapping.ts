import type { DecisionLabel } from "@/components/common/briefing/types";
import { executableMetaRecommendationBidAmount } from "@/lib/meta/bid-intent-contract";
import type { MetaLaunchMode } from "@/components/meta/redesign/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export interface MetaRecLabelInput {
  kind?: MetaRecommendation["kind"] | "recommendation" | "anomaly" | "state" | null;
  decisionState?: MetaRecommendation["decisionState"] | null;
  type?: MetaRecommendation["type"] | string | null;
  /**
   * Carried for callers that pass a whole recommendation. NOT read: no
   * direction in this mapper is decided from prose. @see decisionLabelForMetaRec
   */
  recommendedAction?: string | null;
  /**
   * The validated bid intent envelope, when the caller has one. Read by
   * `launchModeForMetaRec` so the apply-bid condition is the queue's own
   * question rather than a label that no producer emits.
   */
  targetValue?: MetaRecommendation["targetValue"] | null;
  decisionLabel?: DecisionLabel | MetaRecommendation["decisionLabel"] | null;
  lens?: MetaRecommendation["lens"] | null;
  level?: MetaRecommendation["level"] | null;
  /**
   * The guard's own record of a verdict it re-typed, when it re-typed one.
   *
   * Read here for one reason: `promote_test_to_main` is a type the guard MINTS,
   * and the direction of the verdict it was minted from does not survive into
   * the new type name. @see decisionLabelForMetaRec
   */
  labelTransform?: MetaRecommendation["labelTransform"] | null;
}

/*
  `scale_for_profitability` is the type name of a DEFENSIVE verdict.

  `maybeProfitabilityRecommendation` (lib/meta/recommendations.ts) emits it only
  when a campaign is BELOW the efficiency benchmark — "profitability should come
  before scale" — and both recommended actions it can write are defensive:
  "Hold or reduce budget 10-15% and test Cost Cap or Target ROAS before scaling
  again." and "Reduce spend pressure, tighten the bid or audience, and
  reallocate budget toward stronger campaigns." So the type name points the
  opposite way from the verdict, and any reading that trusts the type name puts
  a Scale chip over text telling the operator to reduce.
*/
/**
 * THE ONE READING OF DIRECTION FOR THIS TYPE. Exported because it had a second
 * one: `serverDecisionLabelForRec` (lib/meta/rec-presentation.ts) carried a
 * byte-identical private copy of the regex above with the OLD explicit-first
 * precedence, and `annotateMetaRecPresentation` writes its answer back into
 * `rec.decisionLabel`. Two copies of a rule is how the inversion returns, so
 * that caller now asks this function instead of re-deriving it.
 */
export function defensiveProfitabilityScaleDirection(
  input: MetaRecLabelInput,
): DecisionLabel | null {
  // State rows and anomalies keep their own vocabulary; this reads only a
  // recommendation.
  if (input.kind === "anomaly" || input.kind === "state") return null;
  if (input.type !== "scale_for_profitability") return null;
  /*
    THE TYPE DECIDES THAT IT IS DEFENSIVE. THE TEXT DECIDES HOW DEFENSIVE.

    Requiring the vocabulary to be PRESENT made the rule depend on a string
    that a later stage is free to rewrite — and one does.
    `enforceMetaCommercialActionAuthority` replaces `recommendedAction` with
    "Review the evidence, complete the missing target provenance or
    action-specific anchor, and then re-evaluate. Do not change spend from this
    recommendation yet." That sentence carries none of the vocabulary below,
    `scale_for_profitability` is in its own COMMERCIAL_ACTION_TYPES, and it runs
    BEFORE the label is stamped on the fresh path and before this guard on the
    read path. So a below-benchmark campaign whose commercial anchor is missing
    came out labelled Scale — and "the Meta anchor is missing, hold" is exactly
    the state the canonical Meta-AOV rule produces, so that latent case was
    about to become the common one.

    The type is defensive BY CONSTRUCTION, not by wording:
    `maybeProfitabilityRecommendation` (lib/meta/recommendations.ts) is its only
    producer and returns null unless `core.roas < weakRoasThreshold` AND
    `core.roas < cutCeiling`. It cannot fire on a campaign that is meeting its
    benchmark. Its summary says so in one line: "Scaling now would likely
    amplify waste faster than revenue."

    WHAT WOULD REOPEN THIS: a second producer of this type that emits it
    affirmatively. There is none today, and the two guards above are what a
    reviewer should check first if one is ever added.
  */
  /*
    NO ENGLISH PROSE DECIDES A DIRECTION HERE. Not even the degree.

    The degree used to be read from the words, with a `/\b(pause|cut|stop)\b/`
    test choosing Cut over Tune. Measured read-only against
    `meta_decision_snapshots_daily` on 2026-09-07: of every persisted
    `scale_for_profitability` row, ZERO contain "pause", "cut" or "stop" in
    `recommended_action` — the producer writes only two sentences and neither
    carries a stop verb — so that branch had never fired and could not. It was
    dead code that read as a live rule, and a rule keyed on English is a rule
    that a rewrite, a translation or a copy edit silently changes.

    A CUT NEEDS AN EXPLICIT STRUCTURED INTENT, and one already exists: a
    builder that means Cut writes `decisionLabel: "cut"`, which is an explicit
    label and wins in `decisionLabelForMetaRec` below — this function only ever
    overrules an affirmative `scale`. So the structured path to Cut is open and
    typed, and nothing has to be inferred from a sentence.

    That leaves exactly one answer for the type itself: Tune. The 178 rows
    carrying the structured `confidenceReason: "severe_loser_bypass"` are NOT
    treated as a stop intent, because the producer does not express one — their
    own `decision` field reads "Watch efficiency before making larger cuts".
    Reading a stop out of a confidence-bypass flag would be inventing an
    authority the engine never claimed, which is the same class of defect as
    the Scale label this whole rule exists to remove.
  */
  return "tune";
}

function explicitDecisionLabel(input: MetaRecLabelInput): DecisionLabel | null {
  return input.decisionLabel ?? null;
}

/**
 * A promotion the guard minted FROM a defensive verdict is still defensive.
 *
 * `applyTestCampaignSemantics` re-types a scale verdict on a Test campaign into
 * `promote_test_to_main` and rewrites its action text to "Promote the validated
 * Test setup into a Main campaign or Main ad set lane, then scale from the Main
 * structure under normal guardrails." Both the defensive type name and the
 * defensive wording are gone after that, so nothing downstream can tell the
 * escalated verdict from a genuine one.
 *
 * MEASURED: `meta_decision_snapshots_daily` holds 253 `promote_test_to_main`
 * rows; grouped by `labelTransform.fromType` they are 129 `adset_scale_budget`,
 * 67 `scale_for_profitability`, 34 `scale_for_volume`, 23
 * `scenario_c1_controlled_scale`. Three of those four are genuine scale types
 * and their promotions are right. The 67 are below-benchmark campaigns being
 * offered a promotion, and they still hydrate and serve today — history is not
 * rewritten, so the correction has to happen on the read.
 *
 * The transform record is the guard's own writing, so this reads evidence
 * rather than re-deriving anything.
 */
function transformedFromDefensiveVerdict(
  input: MetaRecLabelInput,
): DecisionLabel | null {
  const transform = input.labelTransform;
  if (!transform || transform.toType !== "promote_test_to_main") return null;
  return defensiveProfitabilityScaleDirection({
    ...input,
    type: transform.fromType,
  });
}

/**
 * THE ONE TYPE→DIRECTION TABLE IN THIS REPOSITORY.
 *
 * `rec-presentation.ts` carried a second copy of it as ten `Set`s
 * (`SCALE_TYPES`, `CUT_TYPES`, `REBUILD_TYPES`, `SWITCH_TYPES`, `TUNE_TYPES`,
 * `SWAP_TYPES`, `TEST_TYPES`, `REFRESH_TYPES`, `KEEP_TYPES`) consulted in a
 * fixed order, answering the same question this table answers. The two copies
 * had drifted on five types — `scenario_a2_learning_weak_structural`,
 * `scenario_a4_learning_limited_persistent`,
 * `scenario_a5_post_learning_underperformer`, `scenario_i2_abo_to_cbo` and
 * `scenario_i3_cbo_overcrowded` — which this table calls `rebuild` and which
 * belonged to none of those Sets, so the presentation copy fell through to its
 * fallback and called them `diagnose`.
 *
 * MEASURED, read-only against production on 2026-09-07:
 * `meta_decision_snapshots_daily` holds 237 `scenario_a2_learning_weak_structural`
 * rows and every one persists `decision_label = 'rebuild'`, because
 * `recommendationToSnapshotRow` (lib/meta/snapshot.ts) stamps the column from
 * THIS mapper. The a2 emitter (lib/meta/scenario-emitters/high-priority.ts)
 * sets no `decisionLabel` of its own, so the same row served through
 * `annotateMetaRecPresentation` came back labelled `diagnose` — the persisted
 * verdict said "rebuild this structure" and the served chip said "we are still
 * looking into it".
 *
 * Two Sets stayed in `rec-presentation.ts` because they answer a DIFFERENT
 * question — which Launchpad flow the CTA routes to, not which direction the
 * verdict points.
 */
const META_REC_TYPE_DIRECTION = new Map<string, DecisionLabel>([
  ["adset_cut_spend", "cut"],
  ["adset_scale_budget", "scale"],
  ["scale_for_volume", "scale"],
  ["scale_for_volume_budget_increase", "scale"],
  ["scale_for_profitability", "scale"],
  ["winner_promotion_flow", "scale"],
  ["scenario_b2_lowest_cost_budget_scale", "scale"],
  ["scenario_c1_controlled_scale", "scale"],
  ["scenario_m1_mid_funnel_efficient_scale", "scale"],
  ["scenario_l1_lead_efficient_scale", "scale"],
  ["scenario_t1_traffic_efficient_scale", "scale"],
  ["scenario_eg1_engagement_efficient_scale", "scale"],
  ["scenario_m3_mid_funnel_inefficient_cut", "cut"],
  ["scenario_l3_lead_inefficient_cut", "cut"],
  ["scenario_t3_traffic_inefficient_cut", "cut"],
  ["scenario_eg3_engagement_inefficient_cut", "cut"],
  ["rebuild_with_constraints", "rebuild"],
  ["campaign_structure", "rebuild"],
  ["scaling_structure_fit", "rebuild"],
  ["scenario_a2_learning_weak_structural", "rebuild"],
  ["scenario_a4_learning_limited_persistent", "rebuild"],
  ["scenario_a5_post_learning_underperformer", "rebuild"],
  ["scenario_i2_abo_to_cbo", "rebuild"],
  ["scenario_i3_cbo_overcrowded", "rebuild"],
  ["scenario_i4_test_should_use_abo", "rebuild"],
  ["scenario_k1_mixed_config_rebuild", "rebuild"],
  ["historical_bid_regime_fit", "switch"],
  ["scenario_b5_lowest_cost_volatility_switch", "switch"],
  ["scenario_g1_upper_funnel_event", "switch"],
  ["scenario_g2_downshift_to_purchase", "switch"],
  ["bid_strategy_fit", "tune"],
  ["bid_value_guidance", "tune"],
  ["bid_band_from_history", "tune"],
  ["scenario_a1_math_floor_unmet", "tune"],
  ["scenario_b1_capped_winner_bid_raise", "tune"],
  ["scenario_b3_bid_cap_underperforming", "tune"],
  ["scenario_b4_min_roas_loosen", "tune"],
  ["scenario_c3_scale_sample_gate", "tune"],
  ["geo_cluster_for_signal_density", "swap"],
  ["scenario_d1_lal_beats_broad_control", "swap"],
  ["scenario_d2_lal_wide_efficiency_loss", "swap"],
  ["scenario_d3_lal_compound_scale", "swap"],
  ["scenario_d5_funnel_mixed_split", "swap"],
  ["creative_test_structure", "test_more"],
  ["scenario_g3_ab_test_bottom_funnel_verdict", "test_more"],
  ["adset_watch_learning", "diagnose"],
  ["seasonal_regime_shift", "diagnose"],
  ["optimization_fit", "diagnose"],
  ["scenario_a3_learning_on_pace_wait", "diagnose"],
  ["scenario_c2_recent_edit_cooldown", "diagnose"],
  ["scenario_f1_roas_drop_diagnostic", "diagnose"],
  ["scenario_f2_recent_data_confidence_cap", "diagnose"],
  ["scenario_f3_budget_change_cooldown", "diagnose"],
  ["scenario_f4_stable_winner_drop_context", "diagnose"],
  ["scenario_h1_dedup_tracking", "diagnose"],
  ["scenario_h2_meta_crm_ratio", "diagnose"],
  ["scenario_h3_ios_tracking_degradation", "diagnose"],
  ["scenario_h4_event_quota", "diagnose"],
  ["scenario_j2_fade_risk_diagnose", "diagnose"],
  ["scenario_j3_aggressive_scale_guard", "diagnose"],
  ["scenario_k4_catalog_feed_first", "diagnose"],
  ["scenario_e1_frequency_fatigue", "refresh"],
  ["scenario_e2_ctr_decay_refresh", "refresh"],
  ["scenario_e3_frequency_p80_fatigue", "refresh"],
  ["scenario_e4_creative_age_refresh", "refresh"],
  ["scenario_m4_mid_funnel_refresh", "refresh"],
  ["scenario_l4_lead_refresh", "refresh"],
  ["scenario_t4_traffic_refresh", "refresh"],
  ["scenario_eg4_engagement_refresh", "refresh"],
  ["scenario_d4_audience_overlap_consolidate", "tune"],
  ["scenario_i1_abo_winner_budget_shift", "tune"],
  ["scenario_i5_cross_campaign_overlap", "tune"],
  ["scenario_b6_profit_first_bid_cap_keep", "keep"],
  ["scenario_j1_stable_winner_protected", "keep"],
  ["scenario_m2_mid_funnel_steady_keep", "keep"],
  ["scenario_l2_lead_steady_keep", "keep"],
  ["scenario_t2_traffic_steady_keep", "keep"],
  ["scenario_eg2_engagement_steady_keep", "keep"],
  ["entity_state", "keep"],
  ["campaign_state", "keep"],
  ["adset_state", "keep"],
  ["scenario_k2_peak_scale_ceiling", "scale"],
  ["scenario_k3_post_peak_taper", "tune"],
]);

/**
 * The direction the canonical table assigns to a recommendation type.
 *
 * Null means the table has NO entry for it, which is a different fact from
 * "the table says keep". Every caller has to decide what to publish for a type
 * nobody mapped, and the two callers answer that differently on purpose —
 * @see resolveMetaRecDirection.
 */
export function metaRecTypeDirection(
  type: MetaRecLabelInput["type"],
): DecisionLabel | null {
  if (typeof type !== "string") return null;
  return META_REC_TYPE_DIRECTION.get(type) ?? null;
}

/**
 * The canonical read of a recommendation's direction.
 *
 * `unmappedFallback` is the ONE thing the engine reader and the presentation
 * reader legitimately answer differently, and it is a parameter rather than a
 * second table so that the difference is one word instead of ten Sets:
 *
 *   - `decisionLabelForMetaRec` passes `keep`. It is what
 *     `recommendationToSnapshotRow` persists into `decision_label`, and `keep`
 *     is the value already stored for the unmapped types (114 persisted
 *     `budget_allocation` rows carry `keep`, `diagnose` and `test_more`).
 *   - `serverDecisionLabelForRec` passes `diagnose`, because it publishes to
 *     the operator and `keep` is an AFFIRMATIVE soft label. `budget_allocation`
 *     is both unmapped and a member of the guard's HARD_ACTION_TYPES, so a held
 *     budget reallocation would come back to a blocked lane reading "Keep" —
 *     the exact failure `heldVerdictLabel` (lib/meta/campaign-label-guard.ts)
 *     already refuses to commit.
 *
 * Everything above the table is shared, in one order, so an explicit label, a
 * defensive verdict and a minted promotion resolve identically for both.
 */
export function resolveMetaRecDirection(
  input: MetaRecLabelInput,
  unmappedFallback: DecisionLabel,
): DecisionLabel {
  const escalated = transformedFromDefensiveVerdict(input);
  if (escalated) return escalated;
  const explicit = explicitDecisionLabel(input);
  /*
    A Scale claim loses to defensive text, whoever wrote the claim.

    Live inversion (Grandmix "Claude-OtherCountries-DPA", snapshot 2026-09-06,
    rec `profit-120247018751090316`): the persisted row carried
    decision_label 'scale' over "Reduce spend pressure, tighten the bid or
    audience, and reallocate budget toward stronger campaigns." That 'scale'
    never came from a builder — `campaign-label-guard` inferred it from the
    type name and wrote it into `decisionLabel`, after which it arrived here as
    an explicit label and explicit precedence ended the read before the
    vocabulary was ever consulted. Only an affirmative Scale claim is
    overruled; a real 'cut', 'tune' or 'keep' from a builder still wins below.
  */
  const defensive = defensiveProfitabilityScaleDirection(input);
  if (defensive && (!explicit || explicit === "scale")) return defensive;
  if (explicit) return explicit;
  if (input.kind === "anomaly") return "diagnose";
  if (input.kind === "state") return input.decisionState === "test" ? "test_more" : "keep";

  const mapped = metaRecTypeDirection(input.type);
  if (mapped) return mapped;
  return input.decisionState === "test" ? "test_more" : unmappedFallback;
}

/**
 * The engine-side read: what gets persisted as `decision_label`.
 *
 * @see resolveMetaRecDirection for the one difference between this and the
 * presentation read.
 */
export function decisionLabelForMetaRec(input: MetaRecLabelInput): DecisionLabel {
  return resolveMetaRecDirection(input, "keep");
}

export function launchModeForMetaRec(input: MetaRecLabelInput): MetaLaunchMode | null {
  if (input.kind === "anomaly" || input.kind === "state") return null;
  if (
    input.type === "rebuild_with_constraints" ||
    input.type === "campaign_structure" ||
    input.type === "creative_test_structure" ||
    input.type === "scaling_structure_fit" ||
    input.type === "scenario_i4_test_should_use_abo" ||
    input.type === "scenario_k1_mixed_config_rebuild"
  ) {
    return "rebuild";
  }
  if (input.type === "geo_cluster_for_signal_density" || input.type === "winner_promotion_flow") {
    return "duplicate";
  }
  /*
    THE BID CONDITION, IN ONE PLACE (Codex C23).

    This tested `type === "bid_value_guidance"` at ad-set grain while
    `serverLaunchModeForRec` (lib/meta/rec-presentation.ts) tested the validated
    bid INTENT — two live mappers answering the same question differently. The
    label test is the wrong one and was already corrected there: no producer
    emits `bid_value_guidance` at ad-set grain, so it returned `null` for every
    ad set that actually carried a validated cap raise.

    The corrected condition lives here now, in the module that has no edge back
    to the presentation layer, and `serverLaunchModeForRec` delegates to it. The
    retired label test is kept as a compatibility arm for payloads persisted
    while it was the rule.
  */
  if (input.level === "adset") {
    if (executableMetaRecommendationBidAmount({
      recommendationType: input.type,
      targetValue: input.targetValue,
    }) !== null) {
      return "apply_bid";
    }
  }
  return null;
}

export function primaryLabelForMetaRec(input: MetaRecLabelInput) {
  const mode = launchModeForMetaRec(input);
  if (input.kind === "anomaly") return "Open diagnostics";
  if (input.kind === "state") return "Open drilldown";
  if (input.type === "winner_promotion_flow") return "Promote to main";
  if (input.type === "creative_test_structure") return "Demote to test";
  if (input.type === "scaling_structure_fit") return "Rebuild lanes";
  if (input.type === "geo_cluster_for_signal_density") return "Swap audience";
  if (mode === "rebuild") return "Rebuild in Launchpad";
  if (mode === "duplicate") return "Duplicate to test";
  if (mode === "apply_bid") return "Apply bid cap";
  if (input.type === "adset_cut_spend") return "Pause adset";
  if (
    input.type === "adset_scale_budget"
    || input.type === "scale_for_volume_budget_increase"
  ) return "Scale budget";
  if (input.type === "scenario_m1_mid_funnel_efficient_scale") return "Scale budget";
  if (input.type === "scenario_m2_mid_funnel_steady_keep") return "Hold";
  if (input.type === "scenario_m3_mid_funnel_inefficient_cut") return "Pause adset";
  if (input.type === "scenario_m4_mid_funnel_refresh") return "Refresh creative";
  if (input.type === "scenario_l1_lead_efficient_scale") return "Scale budget";
  if (input.type === "scenario_l2_lead_steady_keep") return "Hold";
  if (input.type === "scenario_l3_lead_inefficient_cut") return "Pause adset";
  if (input.type === "scenario_l4_lead_refresh") return "Refresh creative";
  if (input.type === "scenario_t1_traffic_efficient_scale") return "Scale budget";
  if (input.type === "scenario_t2_traffic_steady_keep") return "Hold";
  if (input.type === "scenario_t3_traffic_inefficient_cut") return "Pause adset";
  if (input.type === "scenario_t4_traffic_refresh") return "Refresh creative";
  if (input.type === "scenario_eg1_engagement_efficient_scale") return "Scale budget";
  if (input.type === "scenario_eg2_engagement_steady_keep") return "Hold";
  if (input.type === "scenario_eg3_engagement_inefficient_cut") return "Pause adset";
  if (input.type === "scenario_eg4_engagement_refresh") return "Refresh creative";
  if (input.type === "bid_strategy_fit") return input.lens === "profitability" ? "Test Cost Cap" : "Review bid strategy";
  if (input.type === "historical_bid_regime_fit") return "Switch strategy";
  if (input.type === "scenario_g1_upper_funnel_event") return "Switch optimization";
  if (input.type === "scenario_g2_downshift_to_purchase") return "Switch to purchase";
  if (input.type === "scenario_k4_catalog_feed_first") return "Open diagnostics";
  if (input.type === "bid_band_from_history") return "Apply bid band";
  return input.decisionState === "act" ? "Act now" : "Open drilldown";
}
