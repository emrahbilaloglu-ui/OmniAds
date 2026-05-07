export {
  BUSINESS_DECISION_OBJECTIVE_FAMILIES as META_OBJECTIVE_FAMILIES,
  type BusinessDecisionObjectiveFamily as MetaObjectiveFamily,
} from "@/src/types/business-commercial";

export const META_CAMPAIGN_ROLES = [
  "promo_clearance",
  "catalog_dpa",
  "retargeting",
  "existing_customer_ltv",
  "geo_expansion",
  "prospecting_scale",
  "prospecting_validation",
  "prospecting_test",
] as const;
export type MetaCampaignRole = (typeof META_CAMPAIGN_ROLES)[number];

export const META_BID_REGIMES = [
  "lowest_cost",
  "cost_cap",
  "bid_cap",
  "minimum_roas",
  "unknown",
] as const;
export type MetaBidRegime = (typeof META_BID_REGIMES)[number];

export const META_AD_SET_ACTION_TYPES = [
  "pause",
  "recover",
  "rebuild",
  "scale_budget",
  "reduce_budget",
  "hold",
  "duplicate_to_new_geo_cluster",
  "merge_into_pooled_geo",
  "switch_optimization",
  "tighten_bid",
  "broaden",
  "monitor_only",
] as const;
export type MetaAdSetActionType = (typeof META_AD_SET_ACTION_TYPES)[number];

export const META_CAMPAIGN_ROLE_LABELS: Record<MetaCampaignRole, string> = {
  promo_clearance: "Promo / Clearance",
  catalog_dpa: "Catalog / DPA",
  retargeting: "Retargeting",
  existing_customer_ltv: "Existing Customer / LTV",
  geo_expansion: "Geo Expansion",
  prospecting_scale: "Prospecting Scale",
  prospecting_validation: "Prospecting Validation",
  prospecting_test: "Prospecting Test",
};

export const META_BID_REGIME_LABELS: Record<MetaBidRegime, string> = {
  lowest_cost: "Lowest Cost",
  cost_cap: "Cost Cap",
  bid_cap: "Bid Cap",
  minimum_roas: "Minimum ROAS",
  unknown: "Unknown",
};
