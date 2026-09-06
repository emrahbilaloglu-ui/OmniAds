// Server-owned action presentation for Meta recommendations.
//
// Codex cross-review finding: the redesign UI derived decision labels,
// launch modes, and primary CTA labels client-side (including regex over
// English recommendedAction text). The UI may format; it must not decide
// action semantics. This module runs SERVER-side (lane-classify enriches
// every recommendation at read time, so old persisted snapshots get the
// fields too) and is the single source of:
//   - decisionLabel (when the engine did not persist one)
//   - actionKind: what the primary control actually DOES
//   - primaryActionLabel: honest copy - execute verbs only for controls
//     that execute; review framing for controls that open the drill drawer.
import type { MetaLaunchMode } from "@/components/meta/redesign/types";
import { executableBidIntentMinorUnits } from "@/lib/meta/bid-intent-contract";
import { proposedActionForRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaRecommendation,
  MetaRecOperatorApply,
} from "@/lib/meta/recommendations";

export type MetaRecActionKind =
  | "route_launchpad_rebuild"
  | "route_launchpad_duplicate"
  | "review_drill";

const REBUILD_TYPES = new Set<string>([
  "rebuild_with_constraints",
  "campaign_structure",
  "creative_test_structure",
  "scaling_structure_fit",
  "scenario_i4_test_should_use_abo",
  "scenario_k1_mixed_config_rebuild",
]);

const DUPLICATE_TYPES = new Set<string>([
  "geo_cluster_for_signal_density",
  "winner_promotion_flow",
]);

const SCALE_TYPES = new Set<string>([
  "adset_scale_budget",
  "scale_for_volume",
  "scale_for_profitability",
  "winner_promotion_flow",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_c1_controlled_scale",
  "scenario_m1_mid_funnel_efficient_scale",
  "scenario_l1_lead_efficient_scale",
  "scenario_t1_traffic_efficient_scale",
  "scenario_eg1_engagement_efficient_scale",
  "scenario_k2_peak_scale_ceiling",
]);

const CUT_TYPES = new Set<string>([
  "adset_cut_spend",
  "scenario_m3_mid_funnel_inefficient_cut",
  "scenario_l3_lead_inefficient_cut",
  "scenario_t3_traffic_inefficient_cut",
  "scenario_eg3_engagement_inefficient_cut",
]);

const SWITCH_TYPES = new Set<string>([
  "historical_bid_regime_fit",
  "scenario_b5_lowest_cost_volatility_switch",
  "scenario_g1_upper_funnel_event",
  "scenario_g2_downshift_to_purchase",
]);

const TUNE_TYPES = new Set<string>([
  "bid_strategy_fit",
  "bid_value_guidance",
  "bid_band_from_history",
  "scenario_a1_math_floor_unmet",
  "scenario_b1_capped_winner_bid_raise",
  "scenario_b3_bid_cap_underperforming",
  "scenario_b4_min_roas_loosen",
  "scenario_c3_scale_sample_gate",
  "scenario_d4_audience_overlap_consolidate",
  "scenario_i1_abo_winner_budget_shift",
  "scenario_i5_cross_campaign_overlap",
  "scenario_k3_post_peak_taper",
]);

const SWAP_TYPES = new Set<string>([
  "geo_cluster_for_signal_density",
  "scenario_d1_lal_beats_broad_control",
  "scenario_d2_lal_wide_efficiency_loss",
  "scenario_d3_lal_compound_scale",
  "scenario_d5_funnel_mixed_split",
]);

const TEST_TYPES = new Set<string>([
  "creative_test_structure",
  "scenario_g3_ab_test_bottom_funnel_verdict",
]);

const REFRESH_TYPES = new Set<string>([
  "scenario_e1_frequency_fatigue",
  "scenario_e2_ctr_decay_refresh",
  "scenario_e3_frequency_p80_fatigue",
  "scenario_e4_creative_age_refresh",
  "scenario_m4_mid_funnel_refresh",
  "scenario_l4_lead_refresh",
  "scenario_t4_traffic_refresh",
  "scenario_eg4_engagement_refresh",
]);

const KEEP_TYPES = new Set<string>([
  "scenario_b6_profit_first_bid_cap_keep",
  "scenario_j1_stable_winner_protected",
  "scenario_m2_mid_funnel_steady_keep",
  "scenario_l2_lead_steady_keep",
  "scenario_t2_traffic_steady_keep",
  "scenario_eg2_engagement_steady_keep",
  "entity_state",
  "campaign_state",
  "adset_state",
]);

function profitabilityScaleIsDefensive(rec: {
  type?: string | null;
  recommendedAction?: string | null;
}) {
  if (rec.type !== "scale_for_profitability") return false;
  // Server-generated text analyzed server-side: the engine owns both sides.
  const text = String(rec.recommendedAction ?? "").toLowerCase();
  return /\b(reduce|tighten|pause|cap|cut|reallocate|hold|do not scale|don't scale)\b/.test(
    text,
  );
}

export function serverDecisionLabelForRec(
  rec: Pick<
    MetaRecommendation,
    "type" | "kind" | "decisionState" | "decisionLabel" | "recommendedAction"
  >,
): NonNullable<MetaRecommendation["decisionLabel"]> {
  if (rec.decisionLabel) return rec.decisionLabel;
  if (rec.kind === "anomaly") return "diagnose";
  if (rec.kind === "state") return rec.decisionState === "test" ? "test_more" : "keep";
  if (profitabilityScaleIsDefensive(rec)) return "tune";
  const type = String(rec.type ?? "");
  if (CUT_TYPES.has(type)) return "cut";
  if (SCALE_TYPES.has(type)) return "scale";
  if (REBUILD_TYPES.has(type) && type !== "creative_test_structure") return "rebuild";
  if (SWITCH_TYPES.has(type)) return "switch";
  if (SWAP_TYPES.has(type) && type !== "geo_cluster_for_signal_density") return "swap";
  if (type === "geo_cluster_for_signal_density") return "swap";
  if (TEST_TYPES.has(type)) return "test_more";
  if (REFRESH_TYPES.has(type)) return "refresh";
  if (TUNE_TYPES.has(type)) return "tune";
  if (KEEP_TYPES.has(type)) return "keep";
  return rec.decisionState === "test" ? "test_more" : "diagnose";
}

export function serverLaunchModeForRec(
  rec: Pick<MetaRecommendation, "type" | "kind" | "level" | "targetValue">,
): MetaLaunchMode | null {
  if (rec.kind === "anomaly" || rec.kind === "state") return null;
  const type = String(rec.type ?? "");
  if (REBUILD_TYPES.has(type)) return "rebuild";
  if (DUPLICATE_TYPES.has(type)) return "duplicate";
  /*
    The same correction as `proposedActionForRecommendation`.

    This tested `type === "bid_value_guidance"` at ad-set grain, which no
    producer emits, so the served `launchMode` said `null` for every ad set
    that actually carried a validated cap raise. The intent decides, not the
    label: `executableBidIntentMinorUnits` asks the queue's own question.
  */
  if (rec.level === "adset" && executableBidIntentMinorUnits(rec.targetValue) !== null) {
    return "apply_bid";
  }
  return null;
}

export function serverActionKindForRec(
  rec: Pick<
    MetaRecommendation,
    "type" | "kind" | "level" | "proposedAction" | "decisionState" | "targetValue"
  >,
): MetaRecActionKind {
  if (rec.kind === "anomaly" || rec.kind === "state") return "review_drill";
  if (rec.decisionState !== "act") return "review_drill";
  // Campaign/ad-set recommendations do not yet carry the same immutable,
  // decision-origin execution authority contract as canonical Ad decisions.
  // proposedAction is advice, not authority: old persisted pause/resume/bid
  // suggestions must remain review-only until that contract exists.
  const mode = serverLaunchModeForRec(rec);
  if (mode === "rebuild") return "route_launchpad_rebuild";
  if (mode === "duplicate") return "route_launchpad_duplicate";
  return "review_drill";
}

/**
 * Honest primary CTA copy: execute verbs ONLY for controls that execute a
 * write; route verbs for Launchpad handoffs; review framing for everything
 * whose click opens the drill drawer. The pre-review UI showed "Scale
 * budget" / "Hold" / "Act now" on buttons that only opened a drawer.
 */
export function serverPrimaryActionLabelForRec(
  rec: Pick<
    MetaRecommendation,
    | "type"
    | "kind"
    | "level"
    | "proposedAction"
    | "decisionState"
    | "lens"
    | "decisionLabel"
    | "recommendedAction"
  >,
): string {
  const actionKind = serverActionKindForRec(rec);
  if (rec.kind === "anomaly") return "Open diagnostics";
  if (actionKind === "route_launchpad_rebuild") {
    if (rec.type === "creative_test_structure") return "Demote in Launchpad";
    if (rec.type === "scaling_structure_fit") return "Rebuild lanes";
    return "Rebuild in Launchpad";
  }
  if (actionKind === "route_launchpad_duplicate") {
    if (rec.type === "winner_promotion_flow") return "Promote in Launchpad";
    return "Duplicate to test";
  }
  // review_drill: the click opens the drawer, so the label says review.
  const label = serverDecisionLabelForRec(rec);
  switch (label) {
    case "scale":
      return "Review scale plan";
    case "cut":
      return "Review cut plan";
    case "refresh":
      return "Review refresh plan";
    case "switch":
      return "Review strategy switch";
    case "swap":
      return "Review audience swap";
    case "tune":
      return "Review tuning";
    case "test_more":
      return "Review test plan";
    case "keep":
      return "Review status";
    default:
      return "Open diagnostics";
  }
}

/**
 * What the OPERATOR may apply from this row, with their own authority.
 *
 * Deliberately separate from `serverActionKindForRec`, which answers a
 * different question: what the ENGINE authorizes. The engine withholds its own
 * authority from campaign and ad-set rows because they do not carry the
 * immutable decision-origin execution contract that canonical Ad decisions do,
 * and that stays true. But a media buyer reading a row that says "reduce budget
 * pressure or pause this ad set" and finding no way to pause it inside the
 * product is being asked to keep a second browser tab open — which is where
 * mistakes come from.
 *
 * So this offers the concrete typed verb the engine already named in
 * `proposedAction`, executed under `manual_operator_v1` with an explicit typed
 * confirmation. It is a capability, not a recommendation: the row still shows
 * the engine's own authority chip beside it, and the server re-checks the
 * capability, rehearsal posture, STOP, account binding and current entity state
 * immediately before the provider POST regardless of what this returns.
 */
export function serverOperatorApplyForRec(
  rec: Pick<
    MetaRecommendation,
    "kind" | "level" | "proposedAction" | "campaignId" | "adsetId" | "targetValue"
  >,
): MetaRecOperatorApply {
  // An anomaly or a state row describes a condition, not a change to make.
  if (rec.kind === "anomaly" || rec.kind === "state") return null;
  /*
    Derived when the stored row does not carry one.

    A recommendation is stamped when it is built and the sizing passes attach
    their intents afterwards, so every row persisted before that ordering was
    corrected carries a validated amount and no `proposedAction`. Re-asking
    here reads the row's OWN target value with the same predicate the stamp
    uses — it invents nothing, and a row that already carries an action keeps
    it, because `proposedActionForRecommendation` returns that first.
  */
  const proposed = proposedActionForRecommendation(rec as MetaRecommendation);
  if (!proposed) return null;

  const grain =
    rec.level === "adset" ? "adset" : rec.level === "campaign" ? "campaign" : null;
  if (!grain) return null;
  const entityId = (grain === "adset" ? rec.adsetId : rec.campaignId)?.trim();
  if (!entityId) return null;

  if (proposed.kind === "pause" || proposed.kind === "resume") {
    return { action: proposed.kind, grain, entityId };
  }
  if (proposed.kind === "apply_bid") {
    // Bid amount lives on an ad set. A campaign-grain bid has no endpoint and
    // must not be offered as though it did.
    if (grain !== "adset") return null;
    if (!Number.isSafeInteger(proposed.bidAmountMinor) || proposed.bidAmountMinor <= 0) {
      return null;
    }
    return {
      action: "bid",
      grain: "adset",
      entityId,
      bidAmountMinor: proposed.bidAmountMinor,
    };
  }
  return null;
}

export interface MetaRecEntityMetricsSource {
  /** Keyed by entity id (campaign or adset id). */
  spend?: number | null;
  roas?: number | null;
  cpa?: number | null;
  ctr?: number | null;
  purchases?: number | null;
  frequency?: number | null;
}

export interface MetaRecRowPresentationSource {
  /** Provider account id from the serving row. Null means the source row did not expose one. */
  accountId?: string | null;
  /** Creative/media preview label from a real media source. Null means no real source was available. */
  thumbLabel?: string | null;
}

function compactTitle(value: string) {
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactAccountBadge(accountId: string | null | undefined) {
  const value = accountId?.trim();
  if (!value) return null;
  if (value.length <= 14) return value;
  if (value.startsWith("act_")) return `act_${value.slice(-5)}`;
  return `${value.slice(0, 4)}…${value.slice(-5)}`;
}

/**
 * Blockers that belong in diagnostics, not on the row.
 *
 * These are conditions of the automation research programme — a controlled
 * causal estimate, a randomized assignment, a treatment receipt. They are real
 * and they are checked, but they are also true of essentially every row, and
 * they are the FIRST thing pushed onto the blocker list. The result was that
 * an operator scanning their decisions read "Automation blocked · Controlled
 * causal evidence is missing" on line after line — a sentence about our
 * methodology where they expected a sentence about their ads.
 *
 * Nothing is hidden: the full list still travels in `automationReadiness` and
 * still renders in the inspector. What changes is which one gets the row's one
 * line. An operational blocker — an unresolved campaign role, a missing
 * commercial target, no executor — is something they can act on today, so it
 * wins. When only these remain, the row says so in one honest sentence
 * instead of naming one of them at random.
 */
const PROGRAMMATIC_BLOCKERS = new Set([
  "no_empirical_outcome_model",
  "missing_controlled_causal_evidence",
  "missing_valid_treatment_receipt",
  "missing_valid_random_assignment",
  "missing_valid_control_estimate",
  "insufficient_empirical_sample",
  "empirical_precision_below_floor",
  "missing_holdout_plan",
  "missing_post_action_monitor",
]);

function serverRowPresentationForRec(
  rec: MetaRecommendation,
  source?: MetaRecRowPresentationSource | null,
): NonNullable<MetaRecommendation["rowPresentation"]> {
  const readiness = rec.automationReadiness;
  const present = readiness?.blockers?.filter((blocker) => blocker.trim().length > 0)
    ?? [];
  const operational = present.find((blocker) => !PROGRAMMATIC_BLOCKERS.has(blocker));
  const firstBlocker = operational ?? (present.length > 0
    // One sentence for the whole family, because naming one member of it tells
    // the operator nothing the others would not have.
    ? "automation_evidence_incomplete"
    : null);
  const hasBlocker = Boolean(firstBlocker);
  const hasShield = !hasBlocker && readiness?.operatorReviewRequired === true;
  const signal = hasBlocker ? "blocker" : hasShield ? "shield" : null;
  /*
    The synthetic family code carries its own sentence.

    Everything else is title-cased from a code, which reads acceptably for an
    operational blocker ("Campaign Context Unresolved"). Doing that here would
    produce "Automation Evidence Incomplete" — a phrase that still says nothing
    the operator can do about it, which is the whole thing this replaced.
  */
  const blockerLabel = firstBlocker === "automation_evidence_incomplete"
    ? "Gathering evidence — apply it yourself"
    : firstBlocker
      ? compactTitle(firstBlocker)
      : null;
  const shieldLabel = hasShield ? "Operator protection active" : null;
  const autoBadge = readiness?.tier === "auto_execute" && readiness.autoExecuteEligible === true;
  const warnLine = hasBlocker
    ? `Automation blocked · ${blockerLabel}`
    : hasShield && readiness?.reason
      ? `Operator protection active · ${readiness.reason}`
      : null;
  return {
    accountBadge: compactAccountBadge(source?.accountId),
    thumbLabel: source?.thumbLabel?.trim() || null,
    signal,
    blockerLabel,
    shieldLabel,
    autoBadge,
    warnLine,
  };
}

/**
 * Enrich recommendations with server-owned presentation fields and, when a
 * metrics source is provided, structured numeric metrics (compare/bulk math
 * must never parse formatted display strings).
 */
export function annotateMetaRecPresentation(
  recs: MetaRecommendation[],
  metricsByEntityId?: Map<string, MetaRecEntityMetricsSource>,
  rowPresentationByEntityId?: Map<string, MetaRecRowPresentationSource>,
): MetaRecommendation[] {
  return recs.map((rec) => {
    const entityId = rec.level === "adset" ? rec.adsetId : rec.campaignId;
    const metrics =
      metricsByEntityId && entityId ? metricsByEntityId.get(entityId) ?? null : null;
    const rowPresentationSource =
      rowPresentationByEntityId && entityId ? rowPresentationByEntityId.get(entityId) ?? null : null;
    return {
      ...rec,
      decisionLabel: serverDecisionLabelForRec(rec),
      actionKind: serverActionKindForRec(rec),
      // The engine's authority and the operator's capability, side by side and
      // never conflated. `actionKind` says what the engine authorizes;
      // `operatorApply` says what the operator may do with their own.
      operatorApply: serverOperatorApplyForRec(rec),
      primaryActionLabel: serverPrimaryActionLabelForRec(rec),
      rowPresentation: serverRowPresentationForRec(rec, rowPresentationSource),
      metrics: rec.metrics ?? metrics ?? null,
    };
  });
}
