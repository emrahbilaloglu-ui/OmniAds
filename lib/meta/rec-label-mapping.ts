import type { DecisionLabel } from "@/components/common/briefing/types";
import type { MetaLaunchMode } from "@/components/meta/redesign/types";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

export interface MetaRecLabelInput {
  kind?: MetaRecommendation["kind"] | "recommendation" | "anomaly" | "state" | null;
  decisionState?: MetaRecommendation["decisionState"] | null;
  type?: MetaRecommendation["type"] | string | null;
  recommendedAction?: string | null;
  decisionLabel?: DecisionLabel | MetaRecommendation["decisionLabel"] | null;
  lens?: MetaRecommendation["lens"] | null;
  level?: MetaRecommendation["level"] | null;
}

function actionText(input: MetaRecLabelInput) {
  return String(input.recommendedAction ?? "").toLowerCase();
}

function profitabilityScaleIsDefensive(input: MetaRecLabelInput) {
  if (input.type !== "scale_for_profitability") return false;
  const text = actionText(input);
  return /\b(reduce|tighten|pause|cap|cut|reallocate|hold|do not scale|don't scale)\b/.test(text);
}

function explicitDecisionLabel(input: MetaRecLabelInput): DecisionLabel | null {
  return input.decisionLabel ?? null;
}

export function decisionLabelForMetaRec(input: MetaRecLabelInput): DecisionLabel {
  const explicit = explicitDecisionLabel(input);
  if (explicit) return explicit;
  if (input.kind === "anomaly") return "diagnose";
  if (input.kind === "state") return input.decisionState === "test" ? "test_more" : "keep";
  if (profitabilityScaleIsDefensive(input)) return "tune";

  switch (input.type) {
    case "adset_cut_spend":
      return "cut";
    case "adset_scale_budget":
    case "scale_for_volume":
    case "scale_for_profitability":
    case "winner_promotion_flow":
    case "scenario_b2_lowest_cost_budget_scale":
    case "scenario_c1_controlled_scale":
      return "scale";
    case "rebuild_with_constraints":
    case "campaign_structure":
    case "scaling_structure_fit":
    case "scenario_a2_learning_weak_structural":
    case "scenario_a4_learning_limited_persistent":
    case "scenario_a5_post_learning_underperformer":
    case "scenario_i2_abo_to_cbo":
    case "scenario_i3_cbo_overcrowded":
    case "scenario_i4_test_should_use_abo":
    case "scenario_k1_mixed_config_rebuild":
      return "rebuild";
    case "historical_bid_regime_fit":
    case "scenario_b5_lowest_cost_volatility_switch":
    case "scenario_g1_upper_funnel_event":
    case "scenario_g2_downshift_to_purchase":
      return "switch";
    case "bid_strategy_fit":
    case "bid_value_guidance":
    case "bid_band_from_history":
    case "scenario_a1_math_floor_unmet":
    case "scenario_b1_capped_winner_bid_raise":
    case "scenario_b3_bid_cap_underperforming":
    case "scenario_b4_min_roas_loosen":
    case "scenario_c3_scale_sample_gate":
      return "tune";
    case "geo_cluster_for_signal_density":
    case "scenario_d1_lal_beats_broad_control":
    case "scenario_d2_lal_wide_efficiency_loss":
    case "scenario_d3_lal_compound_scale":
    case "scenario_d5_funnel_mixed_split":
      return "swap";
    case "creative_test_structure":
    case "scenario_g3_ab_test_bottom_funnel_verdict":
      return "test_more";
    case "adset_watch_learning":
    case "seasonal_regime_shift":
    case "optimization_fit":
    case "scenario_a3_learning_on_pace_wait":
    case "scenario_c2_recent_edit_cooldown":
    case "scenario_f1_roas_drop_diagnostic":
    case "scenario_f2_recent_data_confidence_cap":
    case "scenario_f3_budget_change_cooldown":
    case "scenario_f4_stable_winner_drop_context":
    case "scenario_h1_dedup_tracking":
    case "scenario_h2_meta_crm_ratio":
    case "scenario_h3_ios_tracking_degradation":
    case "scenario_h4_event_quota":
    case "scenario_j2_fade_risk_diagnose":
    case "scenario_j3_aggressive_scale_guard":
    case "scenario_k4_catalog_feed_first":
      return "diagnose";
    case "scenario_e1_frequency_fatigue":
    case "scenario_e2_ctr_decay_refresh":
    case "scenario_e3_frequency_p80_fatigue":
    case "scenario_e4_creative_age_refresh":
      return "refresh";
    case "scenario_d4_audience_overlap_consolidate":
    case "scenario_i1_abo_winner_budget_shift":
    case "scenario_i5_cross_campaign_overlap":
      return "tune";
    case "scenario_b6_profit_first_bid_cap_keep":
    case "scenario_j1_stable_winner_protected":
    case "entity_state":
    case "campaign_state":
    case "adset_state":
      return "keep";
    case "scenario_k2_peak_scale_ceiling":
      return "scale";
    case "scenario_k3_post_peak_taper":
      return "tune";
    default:
      return input.decisionState === "test" ? "test_more" : "keep";
  }
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
  if (input.level === "adset" && input.type === "bid_value_guidance") return "apply_bid";
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
  if (input.type === "adset_scale_budget") return "Scale budget";
  if (input.type === "bid_strategy_fit") return input.lens === "profitability" ? "Test Cost Cap" : "Review bid strategy";
  if (input.type === "historical_bid_regime_fit") return "Switch strategy";
  if (input.type === "bid_band_from_history") return "Apply bid band";
  return input.decisionState === "act" ? "Act now" : "Open drilldown";
}
