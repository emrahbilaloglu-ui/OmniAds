import type { MetaRecommendation } from "@/lib/meta/recommendations";

export type MetaEngineScenarioId =
  | "A1" | "A2" | "A3" | "A4" | "A5"
  | "B1" | "B2" | "B3" | "B4" | "B5" | "B6"
  | "C1" | "C2" | "C3"
  | "D1" | "D2" | "D3" | "D4" | "D5"
  | "E1" | "E2" | "E3" | "E4"
  | "F1" | "F2" | "F3" | "F4"
  | "G1" | "G2" | "G3"
  | "H1" | "H2" | "H3" | "H4"
  | "I1" | "I2" | "I3" | "I4" | "I5"
  | "J1" | "J2" | "J3"
  | "K1" | "K2" | "K3" | "K4"
  | "M1" | "M2" | "M3" | "M4"
  | "L1" | "L2" | "L3" | "L4"
  | "T1" | "T2" | "T3" | "T4"
  | "EG1" | "EG2" | "EG3" | "EG4";

export type MetaEngineScenarioCohortScope =
  | "purchase_only"
  | "mid_funnel_only"
  | "lead_only"
  | "traffic_only"
  | "engagement_only"
  | "any";

export interface MetaEngineScenarioDefinition {
  id: MetaEngineScenarioId;
  recType: MetaRecommendation["type"];
  cohortScope: MetaEngineScenarioCohortScope;
  requiredSignals: string[];
  missingSignalFallback: "state_watch" | "diagnose_low_confidence" | "unsupported_state";
}

export const META_ENGINE_V1_SCENARIOS: MetaEngineScenarioDefinition[] = [
  { id: "A1", recType: "scenario_a1_math_floor_unmet", cohortScope: "purchase_only", requiredSignals: ["weekly_budget", "account_cpa_p50", "purchases_7d"], missingSignalFallback: "state_watch" },
  { id: "A2", recType: "scenario_a2_learning_weak_structural", cohortScope: "purchase_only", requiredSignals: ["age_days", "roas_p25", "spend", "cpa"], missingSignalFallback: "state_watch" },
  { id: "A3", recType: "scenario_a3_learning_on_pace_wait", cohortScope: "purchase_only", requiredSignals: ["learning_state", "conversion_pace", "roas_p25", "roas_p75"], missingSignalFallback: "state_watch" },
  { id: "A4", recType: "scenario_a4_learning_limited_persistent", cohortScope: "purchase_only", requiredSignals: ["learning_state", "days_at_learning_state", "audience_size", "adset_count", "overlap_pct", "budget"], missingSignalFallback: "diagnose_low_confidence" },
  { id: "A5", recType: "scenario_a5_post_learning_underperformer", cohortScope: "purchase_only", requiredSignals: ["learning_state", "learning_exit_at", "roas_p50"], missingSignalFallback: "state_watch" },
  { id: "B1", recType: "scenario_b1_capped_winner_bid_raise", cohortScope: "purchase_only", requiredSignals: ["bid_strategy", "budget_utilization", "roas_p50", "bid_amount"], missingSignalFallback: "state_watch" },
  { id: "B2", recType: "scenario_b2_lowest_cost_budget_scale", cohortScope: "purchase_only", requiredSignals: ["bid_strategy", "budget_utilization", "roas_p50", "daily_roas_volatility"], missingSignalFallback: "state_watch" },
  { id: "B3", recType: "scenario_b3_bid_cap_underperforming", cohortScope: "purchase_only", requiredSignals: ["bid_cap", "auction_loss_to_bid_ratio", "roas_target"], missingSignalFallback: "state_watch" },
  { id: "B4", recType: "scenario_b4_min_roas_loosen", cohortScope: "purchase_only", requiredSignals: ["minimum_roas", "delivery_starvation", "roas_target"], missingSignalFallback: "state_watch" },
  { id: "B5", recType: "scenario_b5_lowest_cost_volatility_switch", cohortScope: "purchase_only", requiredSignals: ["daily_roas_volatility", "bid_strategy"], missingSignalFallback: "state_watch" },
  { id: "B6", recType: "scenario_b6_profit_first_bid_cap_keep", cohortScope: "purchase_only", requiredSignals: ["operating_mode", "bid_cap", "profit_stability", "volume_volatility"], missingSignalFallback: "state_watch" },
  { id: "C1", recType: "scenario_c1_controlled_scale", cohortScope: "purchase_only", requiredSignals: ["roas_p75", "age_days", "last_significant_edit_at"], missingSignalFallback: "state_watch" },
  { id: "C2", recType: "scenario_c2_recent_edit_cooldown", cohortScope: "any", requiredSignals: ["last_significant_edit_at", "learning_state"], missingSignalFallback: "state_watch" },
  { id: "C3", recType: "scenario_c3_scale_sample_gate", cohortScope: "purchase_only", requiredSignals: ["purchases", "days_at_target", "roas_windows"], missingSignalFallback: "state_watch" },
  { id: "D1", recType: "scenario_d1_lal_beats_broad_control", cohortScope: "any", requiredSignals: ["audience_label", "roas", "maturity"], missingSignalFallback: "unsupported_state" },
  { id: "D2", recType: "scenario_d2_lal_wide_efficiency_loss", cohortScope: "any", requiredSignals: ["lookalike_pct", "roas_trend", "cpm_trend"], missingSignalFallback: "unsupported_state" },
  { id: "D3", recType: "scenario_d3_lal_compound_scale", cohortScope: "any", requiredSignals: ["lookalike_pct", "winner_state", "expansion_need"], missingSignalFallback: "unsupported_state" },
  { id: "D4", recType: "scenario_d4_audience_overlap_consolidate", cohortScope: "any", requiredSignals: ["audience_overlap_pct"], missingSignalFallback: "unsupported_state" },
  { id: "D5", recType: "scenario_d5_funnel_mixed_split", cohortScope: "any", requiredSignals: ["audience_stage"], missingSignalFallback: "unsupported_state" },
  { id: "E1", recType: "scenario_e1_frequency_fatigue", cohortScope: "any", requiredSignals: ["frequency_p75", "frequency_p90", "vertical"], missingSignalFallback: "state_watch" },
  { id: "E2", recType: "scenario_e2_ctr_decay_refresh", cohortScope: "any", requiredSignals: ["ctr_decay_pct", "stable_spend"], missingSignalFallback: "state_watch" },
  { id: "E3", recType: "scenario_e3_frequency_p80_fatigue", cohortScope: "any", requiredSignals: ["frequency_p80", "mean_frequency"], missingSignalFallback: "state_watch" },
  { id: "E4", recType: "scenario_e4_creative_age_refresh", cohortScope: "any", requiredSignals: ["creative_age_days", "ctr_decay_pct"], missingSignalFallback: "state_watch" },
  { id: "F1", recType: "scenario_f1_roas_drop_diagnostic", cohortScope: "purchase_only", requiredSignals: ["roas_drop", "tracking_context", "fatigue_context", "edit_context", "auction_context", "seasonality_context"], missingSignalFallback: "diagnose_low_confidence" },
  { id: "F2", recType: "scenario_f2_recent_data_confidence_cap", cohortScope: "any", requiredSignals: ["data_freshness", "window_age"], missingSignalFallback: "state_watch" },
  { id: "F3", recType: "scenario_f3_budget_change_cooldown", cohortScope: "any", requiredSignals: ["budget_edit_pct", "last_significant_edit_at", "performance_drop"], missingSignalFallback: "state_watch" },
  { id: "F4", recType: "scenario_f4_stable_winner_drop_context", cohortScope: "purchase_only", requiredSignals: ["stable_winner", "roas_drop", "cpm_trend", "seasonality_context"], missingSignalFallback: "diagnose_low_confidence" },
  // G1 is upper-funnel event-fit context, not a purchase scale/cut verdict.
  { id: "G1", recType: "scenario_g1_upper_funnel_event", cohortScope: "any", requiredSignals: ["purchases_7d", "optimization_event", "age_days"], missingSignalFallback: "state_watch" },
  // G2 starts from a pre-purchase optimization event and tests purchase; the
  // source cohort can be mid/upper/traffic even when the target event is purchase.
  { id: "G2", recType: "scenario_g2_downshift_to_purchase", cohortScope: "any", requiredSignals: ["optimization_event", "purchases_7d", "roas_p50"], missingSignalFallback: "state_watch" },
  // G3 is test/tracking context; purchase ROAS is evidence, not the cohort gate.
  { id: "G3", recType: "scenario_g3_ab_test_bottom_funnel_verdict", cohortScope: "any", requiredSignals: ["test_pairing", "purchase_roas"], missingSignalFallback: "state_watch" },
  { id: "H1", recType: "scenario_h1_dedup_tracking", cohortScope: "any", requiredSignals: ["dedup_rate_pct"], missingSignalFallback: "unsupported_state" },
  { id: "H2", recType: "scenario_h2_meta_crm_ratio", cohortScope: "any", requiredSignals: ["meta_to_crm_ratio"], missingSignalFallback: "unsupported_state" },
  { id: "H3", recType: "scenario_h3_ios_tracking_degradation", cohortScope: "any", requiredSignals: ["ios_share", "tracking_quality_status"], missingSignalFallback: "unsupported_state" },
  { id: "H4", recType: "scenario_h4_event_quota", cohortScope: "any", requiredSignals: ["event_priority_list"], missingSignalFallback: "unsupported_state" },
  { id: "I1", recType: "scenario_i1_abo_winner_budget_shift", cohortScope: "any", requiredSignals: ["adset_family_roas", "budget_mode"], missingSignalFallback: "state_watch" },
  { id: "I2", recType: "scenario_i2_abo_to_cbo", cohortScope: "any", requiredSignals: ["adset_count", "winner_count", "budget_adequacy"], missingSignalFallback: "state_watch" },
  { id: "I3", recType: "scenario_i3_cbo_overcrowded", cohortScope: "any", requiredSignals: ["budget_mode", "adset_count", "per_adset_spend"], missingSignalFallback: "state_watch" },
  { id: "I4", recType: "scenario_i4_test_should_use_abo", cohortScope: "any", requiredSignals: ["campaign_role", "budget_mode"], missingSignalFallback: "state_watch" },
  { id: "I5", recType: "scenario_i5_cross_campaign_overlap", cohortScope: "any", requiredSignals: ["audience_overlap_pct"], missingSignalFallback: "unsupported_state" },
  { id: "J1", recType: "scenario_j1_stable_winner_protected", cohortScope: "purchase_only", requiredSignals: ["mature_winner", "last_significant_edit_at"], missingSignalFallback: "state_watch" },
  { id: "J2", recType: "scenario_j2_fade_risk_diagnose", cohortScope: "purchase_only", requiredSignals: ["roas_decline", "ctr_decline"], missingSignalFallback: "diagnose_low_confidence" },
  { id: "J3", recType: "scenario_j3_aggressive_scale_guard", cohortScope: "purchase_only", requiredSignals: ["proposed_scale_pct", "winner_state"], missingSignalFallback: "state_watch" },
  { id: "K1", recType: "scenario_k1_mixed_config_rebuild", cohortScope: "any", requiredSignals: ["mixed_config_flags"], missingSignalFallback: "state_watch" },
  { id: "K2", recType: "scenario_k2_peak_scale_ceiling", cohortScope: "any", requiredSignals: ["seasonal_regime", "winner_state"], missingSignalFallback: "state_watch" },
  { id: "K3", recType: "scenario_k3_post_peak_taper", cohortScope: "any", requiredSignals: ["seasonal_regime", "cpm_trend", "frequency_trend"], missingSignalFallback: "state_watch" },
  { id: "K4", recType: "scenario_k4_catalog_feed_first", cohortScope: "any", requiredSignals: ["catalog_role", "feed_disapproval_count", "feed_status"], missingSignalFallback: "unsupported_state" },
  { id: "M1", recType: "scenario_m1_mid_funnel_efficient_scale", cohortScope: "mid_funnel_only", requiredSignals: ["cost_per_atc", "atc_rate", "atc_to_purchase_rate", "age_days", "spend"], missingSignalFallback: "state_watch" },
  { id: "M2", recType: "scenario_m2_mid_funnel_steady_keep", cohortScope: "mid_funnel_only", requiredSignals: ["cost_per_atc", "atc_rate", "atc_to_purchase_rate"], missingSignalFallback: "state_watch" },
  { id: "M3", recType: "scenario_m3_mid_funnel_inefficient_cut", cohortScope: "mid_funnel_only", requiredSignals: ["cost_per_atc", "atc_rate", "atc_to_purchase_rate", "spend"], missingSignalFallback: "state_watch" },
  { id: "M4", recType: "scenario_m4_mid_funnel_refresh", cohortScope: "mid_funnel_only", requiredSignals: ["cost_per_atc", "frequency", "ctr"], missingSignalFallback: "state_watch" },
  { id: "L1", recType: "scenario_l1_lead_efficient_scale", cohortScope: "lead_only", requiredSignals: ["cost_per_lead", "leads", "age_days", "spend"], missingSignalFallback: "state_watch" },
  { id: "L2", recType: "scenario_l2_lead_steady_keep", cohortScope: "lead_only", requiredSignals: ["cost_per_lead", "leads"], missingSignalFallback: "state_watch" },
  { id: "L3", recType: "scenario_l3_lead_inefficient_cut", cohortScope: "lead_only", requiredSignals: ["cost_per_lead", "leads", "spend"], missingSignalFallback: "state_watch" },
  { id: "L4", recType: "scenario_l4_lead_refresh", cohortScope: "lead_only", requiredSignals: ["cost_per_lead", "frequency", "ctr"], missingSignalFallback: "state_watch" },
  { id: "T1", recType: "scenario_t1_traffic_efficient_scale", cohortScope: "traffic_only", requiredSignals: ["cost_per_link_click_or_lpv", "ctr", "age_days", "spend"], missingSignalFallback: "state_watch" },
  { id: "T2", recType: "scenario_t2_traffic_steady_keep", cohortScope: "traffic_only", requiredSignals: ["cost_per_link_click_or_lpv", "ctr"], missingSignalFallback: "state_watch" },
  { id: "T3", recType: "scenario_t3_traffic_inefficient_cut", cohortScope: "traffic_only", requiredSignals: ["cost_per_link_click_or_lpv", "ctr", "spend"], missingSignalFallback: "state_watch" },
  { id: "T4", recType: "scenario_t4_traffic_refresh", cohortScope: "traffic_only", requiredSignals: ["cost_per_link_click_or_lpv", "frequency", "ctr"], missingSignalFallback: "state_watch" },
  // Use EG ids to avoid colliding with existing G1-G3 upper-funnel scenario ids.
  { id: "EG1", recType: "scenario_eg1_engagement_efficient_scale", cohortScope: "engagement_only", requiredSignals: ["cost_per_engagement", "engagement_rate", "age_days", "spend"], missingSignalFallback: "state_watch" },
  { id: "EG2", recType: "scenario_eg2_engagement_steady_keep", cohortScope: "engagement_only", requiredSignals: ["cost_per_engagement", "engagement_rate"], missingSignalFallback: "state_watch" },
  { id: "EG3", recType: "scenario_eg3_engagement_inefficient_cut", cohortScope: "engagement_only", requiredSignals: ["cost_per_engagement", "engagement_rate", "spend"], missingSignalFallback: "state_watch" },
  { id: "EG4", recType: "scenario_eg4_engagement_refresh", cohortScope: "engagement_only", requiredSignals: ["cost_per_engagement", "frequency"], missingSignalFallback: "state_watch" },
];

export function scenarioDefinitionById(id: MetaEngineScenarioId) {
  return META_ENGINE_V1_SCENARIOS.find((scenario) => scenario.id === id) ?? null;
}
