import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  hasMetaHardActionAnchor,
  normalizeMetaCommercialTargets,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";

const COMMERCIAL_ACTION_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "adset_cut_spend",
  "scale_for_volume",
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
]);

const ROAS_GROWTH_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "scale_for_volume",
  "scenario_b2_lowest_cost_budget_scale",
  "scenario_c1_controlled_scale",
  "scenario_k2_peak_scale_ceiling",
]);

const ROAS_LOSS_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_cut_spend",
  "scale_for_profitability",
  "scenario_a2_learning_weak_structural",
  "scenario_a5_post_learning_underperformer",
]);

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
) {
  const normalized = normalizeMetaCommercialTargets(targets);
  if (!hasMetaHardActionAnchor(normalized)) return blockerFor(normalized);
  if (ROAS_GROWTH_TYPES.has(recommendation.type)) {
    return normalized.targetRoas
      ? null
      : ("commercial_growth_anchor_missing" as const);
  }
  if (ROAS_LOSS_TYPES.has(recommendation.type)) {
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
): MetaRecommendation {
  if (!COMMERCIAL_ACTION_TYPES.has(recommendation.type)) return recommendation;
  const blocker = actionAnchorBlocker(recommendation, targets);
  if (!blocker) return recommendation;

  const { proposedAction: _proposedAction, targetValue: _targetValue, ...reviewOnly } =
    recommendation;
  return {
    ...reviewOnly,
    decisionState: "watch",
    stateReason:
      "Commercial action authority is blocked until a valid action-specific business target is available.",
    recommendedAction:
      "Review the evidence, complete the missing target provenance or action-specific anchor, and then re-evaluate. Do not change spend from this recommendation yet.",
    signalQuality: {
      ...(recommendation.signalQuality ?? {}),
      hard_action_authority: "blocked",
      hard_action_blocker: blocker,
      commercial_target_freshness:
        normalizeMetaCommercialTargets(targets).freshness,
    },
  };
}
