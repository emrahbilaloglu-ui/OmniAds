import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { META_CONFIDENCE_ACT_THRESHOLD } from "@/lib/meta/confidence-thresholds";
import {
  hasMetaHardActionAnchor,
  normalizeMetaCommercialTargets,
  resolveMetaPurchaseValueAuthority,
  type MetaAttributedAovSample,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

const COMMERCIAL_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "adset_cut_spend",
  "budget_allocation",
  "scale_for_volume",
  "scale_for_volume_budget_increase",
  "scale_for_profitability",
  "scenario_a2_learning_weak_structural",
  "scenario_a5_post_learning_underperformer",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_c1_controlled_scale",
  "scenario_k2_peak_scale_ceiling",
  "scenario_m1_mid_funnel_efficient_scale",
  "scenario_m3_mid_funnel_inefficient_cut",
  "scenario_l1_lead_efficient_scale",
  "scenario_l3_lead_inefficient_cut",
  "scenario_t1_traffic_efficient_scale",
  "scenario_t3_traffic_inefficient_cut",
  "scenario_eg1_engagement_efficient_scale",
  "scenario_eg3_engagement_inefficient_cut",
  /*
    ── ROUND 19, ITEM B4 ────────────────────────────────────────────────────
    B1 raises what the account PAYS per purchase and A1 proposes an optimization
    event change sized from what a purchase is worth. Both were outside this
    guard, so a recommendation persisted while the AOV was READY stayed `act`
    after the sample went missing, thin, or mismatched — the generator's own
    refusal only governs NEW rows, and this is the surface that governs served
    ones.
  */
  "scenario_b1_capped_winner_bid_raise",
  "scenario_a1_math_floor_unmet",
]);

const ROAS_GROWTH_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "scale_for_volume",
  "scale_for_volume_budget_increase",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_c1_controlled_scale",
  "scenario_k2_peak_scale_ceiling",
  /*
    ROUND 19: both are sized from the canonical purchase-value unit — READY
    same-account, same-cutoff Meta AOV over the Target ROAS — so they ask the
    same question as every other growth action: does a UNIT exist, not merely a
    ratio.

    A1 appears here only when a Target ROAS governs. Its no-Target-ROAS legacy
    branch uses the account CPA percentile and is not a purchase-value action at
    all; `hasMetaHardActionAnchor` lets that case through above, and
    `resolveMetaPurchaseValueAuthority` is never consulted for it.
  */
  "scenario_b1_capped_winner_bid_raise",
  "scenario_a1_math_floor_unmet",
]);

const ROAS_LOSS_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_cut_spend",
  "scale_for_profitability",
  "scenario_a2_learning_weak_structural",
  "scenario_a5_post_learning_underperformer",
]);

const GENERIC_COMMERCIAL_AUTHORITY_HOLD = {
  decision: "Hold: complete the missing evidence",
  title: "Spend change is on hold",
  why: "The required commercial evidence is incomplete for this account and evidence cutoff.",
  summary: "Performance remains available for review. Keep current spend unchanged until the missing evidence is ready.",
  expectedImpact: "Prevents an unsupported spend change while preserving the candidate for review.",
  stateReason:
    "Commercial action authority is blocked until a valid action-specific business target is available.",
  recommendedAction:
    "Review the evidence, complete the missing target provenance or action-specific anchor, and then re-evaluate. Do not change spend from this recommendation yet.",
};

const BUDGET_ALLOCATION_AUTHORITY_HOLD = {
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

function blockerFor(targets: MetaCommercialTargets | null | undefined) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (normalized.source === "none") return "commercial_target_missing" as const;
  // A valid old timestamp is authoritative and never reaches this branch.
  // If a target pack reaches this guard without hard-action authority, the
  // provenance is missing or invalid rather than merely old.
  return "commercial_target_unknown" as const;
}

function actionAnchorBlocker(
  recommendation: MetaRecommendation,
  targets: MetaCommercialTargets | null | undefined,
  sample?: MetaAttributedAovSample | null,
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (!hasMetaHardActionAnchor(normalized)) return blockerFor(normalized);
  /*
    ── ROUND 19 ─────────────────────────────────────────────────────────────
    A1 is a purchase-VALUE action only while a positive Target ROAS governs it.
    Without one it runs its legacy branch on the account CPA percentile and is
    not sized from the canonical unit at all, so demanding a unit there would
    block a path that never used one — a regression dressed as a tightening.
  */
  const targetRoas = Number(normalized.targetRoas);
  const roasGoverned = Number.isFinite(targetRoas) && targetRoas > 0;
  if (recommendation.type === "scenario_a1_math_floor_unmet" && !roasGoverned) {
    return null;
  }
  /*
    An account budget shift is a hard spend action even though it does not name
    one campaign in its type. Its lens carries the missing direction:

      - volume moves money into a Scale candidate and therefore needs the
        growth unit;
      - profitability moves money away from a weak campaign and follows the
        same loss-anchor compatibility rule as the campaign-level loss types.

    Under a positive Target ROAS both directions still need the READY,
    same-account, same-cutoff Meta AOV. A persisted account recommendation must
    not remain actionable after that sample disappears merely because its type
    sat outside the campaign action allowlists.
  */
  if (recommendation.type === "budget_allocation") {
    if (roasGoverned) {
      return resolveMetaPurchaseValueAuthority(normalized, sample).blocker;
    }
    if (recommendation.lens === "profitability") {
      return normalized.breakEvenRoas
        ? null
        : ("commercial_loss_anchor_missing" as const);
    }
    return recommendation.lens === "volume"
      ? ("commercial_growth_anchor_missing" as const)
      : ("commercial_objective_anchor_missing" as const);
  }
  if (ROAS_GROWTH_TYPES.has(recommendation.type)) {
    /*
      A RATIO IS HALF A UNIT.

      This asked only whether a Target ROAS existed, so every purchase-VALUE
      budget increase in the set above could be authorized on an account whose
      Meta-attributed purchase sample was absent or too thin to divide — the
      exact state the canonical rule answers with a HOLD. The ratio and the
      READY average order value are now asked for together, by the one
      predicate every purchase-budget surface reads, and a missing or thin
      sample is named rather than substituted.
    */
    return resolveMetaPurchaseValueAuthority(normalized, sample).blocker;
  }
  if (ROAS_LOSS_TYPES.has(recommendation.type)) {
    /*
      A TARGET ROAS IS SUFFICIENT AS THE TARGET, AND NOT SUFFICIENT ON ITS OWN.

      Two corrections live here and they pull in opposite directions, so both
      are stated.

      1. Break-even is NOT a second mandatory user target. This required
         `breakEvenRoas` specifically, so an account carrying the one target
         the product asks for could not act on a loss verdict at all.
      2. A ratio is still only half a unit. The first correction then let a
         Target ROAS pass ALONE — and every type in this set is a
         purchase-budget action (cut spend, shift budget for profitability),
         so it was authorized on an account whose Meta-attributed purchase
         sample was absent or too thin to divide. Under a positive Target ROAS
         the same READY-sample authority the growth types ask for is required
         here too.

      Without a positive Target ROAS the legacy compatibility case stands:
      either configured ratio anchors the action and no Meta sample is needed,
      because nothing is being divided.
    */
    if (normalized.targetRoas) {
      return resolveMetaPurchaseValueAuthority(normalized, sample).blocker;
    }
    return normalized.breakEvenRoas
      ? null
      : ("commercial_loss_anchor_missing" as const);
  }
  // Current target packs do not distinguish CPL, cost-per-ATC, CPC, or
  // engagement economics. Relative cohort rank may identify a candidate, but
  // it cannot authorize a spend change until that goal-specific target exists.
  return "commercial_objective_anchor_missing" as const;
}

export function enforceMetaCommercialActionAuthority(
  recommendation: MetaRecommendation,
  targets: MetaCommercialTargets | null | undefined,
  /**
   * The account/cutoff-scoped Meta-attributed purchase sample.
   *
   * Optional because `targets.metaAttributedAov` already carries it on every
   * caller that resolves one; passing it explicitly is for callers that hold a
   * sample the pack was not built with. Absent BOTH ways is a hold, never a
   * fallback.
   */
  sample?: MetaAttributedAovSample | null,
): MetaRecommendation {
  if (!COMMERCIAL_ACTION_TYPES.has(recommendation.type)) return recommendation;
  const blocker = actionAnchorBlocker(recommendation, targets, sample);
  if (!blocker) return recommendation;

  const { proposedAction: _proposedAction, targetValue: _targetValue, ...reviewOnly } =
    recommendation;
  const confidenceScore =
    typeof recommendation.confidenceScore === "number" &&
      Number.isFinite(recommendation.confidenceScore)
      ? Math.min(
        recommendation.confidenceScore,
        META_CONFIDENCE_ACT_THRESHOLD - 0.01,
      )
      : recommendation.confidenceScore;
  const holdPresentation =
    recommendation.type === "budget_allocation"
      ? BUDGET_ALLOCATION_AUTHORITY_HOLD
      : GENERIC_COMMERCIAL_AUTHORITY_HOLD;
  const sampleHoldReason = blocker === "commercial_anchor_missing"
    ? "Meta-attributed purchase value is missing for this account and evidence cutoff."
    : blocker === "commercial_anchor_sample_insufficient"
      ? "The Meta-attributed purchase sample is too small to support a spend change."
      : null;
  return {
    ...reviewOnly,
    decisionState: "watch",
    confidence:
      recommendation.confidence === "high"
        ? "medium"
        : recommendation.confidence,
    confidenceScore,
    ...holdPresentation,
    ...(sampleHoldReason ? { why: sampleHoldReason, stateReason: sampleHoldReason } : {}),
    signalQuality: {
      ...(recommendation.signalQuality ?? {}),
      hard_action_authority: "blocked",
      hard_action_blocker: blocker,
      commercial_target_freshness:
        normalizeMetaCommercialTargets(targets).freshness,
    },
  };
}
