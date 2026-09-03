export type MetaFunnelCohort =
  | "purchase"
  | "mid_funnel"
  | "lead"
  | "traffic"
  | "upper_funnel"
  | "engagement"
  | "unknown";

const EVENT_COHORTS: Record<string, MetaFunnelCohort> = {
  PURCHASE: "purchase",
  VALUE: "purchase",
  ADD_TO_CART: "mid_funnel",
  INITIATE_CHECKOUT: "mid_funnel",
  VIEW_CONTENT: "mid_funnel",
  SEARCH: "mid_funnel",
  ADD_PAYMENT_INFO: "mid_funnel",
  ADD_TO_WISHLIST: "mid_funnel",
  LEAD: "lead",
  COMPLETE_REGISTRATION: "lead",
  SUBMIT_APPLICATION: "lead",
  START_TRIAL: "lead",
  SUBSCRIBE: "lead",
  CONTACT: "lead",
};

const OPTIMIZATION_GOAL_COHORTS: Record<string, MetaFunnelCohort> = {
  PURCHASE: "purchase",
  VALUE: "purchase",
  PRODUCT_CATALOG_SALES: "purchase",
  OFFSITE_CONVERSIONS: "purchase",
  ADD_TO_CART: "mid_funnel",
  INITIATE_CHECKOUT: "mid_funnel",
  LEAD: "lead",
  LEAD_GENERATION: "lead",
  QUALITY_LEAD: "lead",
  LANDING_PAGE_VIEWS: "traffic",
  LINK_CLICKS: "traffic",
  THRUPLAY: "upper_funnel",
  VIDEO_VIEWS: "upper_funnel",
  REACH: "upper_funnel",
  IMPRESSIONS: "upper_funnel",
  AWARENESS: "upper_funnel",
  AD_RECALL_LIFT: "upper_funnel",
  POST_ENGAGEMENT: "engagement",
  PAGE_LIKES: "engagement",
  EVENT_RESPONSES: "engagement",
  REPLIES: "unknown",
  MESSAGING_PURCHASE_CONVERSION: "unknown",
  CONVERSATIONS: "unknown",
  MESSAGES: "unknown",
  DERIVED_EVENTS: "unknown",
};

const OBJECTIVE_COHORTS: Record<string, MetaFunnelCohort> = {
  OUTCOME_SALES: "purchase",
  SALES: "purchase",
  OUTCOME_LEADS: "lead",
  LEADS: "lead",
  LEAD_GENERATION: "lead",
  OUTCOME_TRAFFIC: "traffic",
  TRAFFIC: "traffic",
  OUTCOME_AWARENESS: "upper_funnel",
  BRAND_AWARENESS: "upper_funnel",
  AWARENESS: "upper_funnel",
  REACH: "upper_funnel",
  OUTCOME_ENGAGEMENT: "engagement",
  ENGAGEMENT: "engagement",
};

function normalizeMetaGoal(value: string | null | undefined) {
  return String(value ?? "").trim().replace(/[\s-]+/g, "_").toUpperCase();
}

export function resolveMetaFunnelCohort(input: {
  optimizationGoal?: string | null;
  customEventType?: string | null;
  objective?: string | null;
  purchases?: number | null;
  revenue?: number | null;
}): MetaFunnelCohort {
  const event = normalizeMetaGoal(input.customEventType);
  if (event && EVENT_COHORTS[event]) return EVENT_COHORTS[event];

  const optimizationGoal = normalizeMetaGoal(input.optimizationGoal);
  if (optimizationGoal && OPTIMIZATION_GOAL_COHORTS[optimizationGoal]) {
    return OPTIMIZATION_GOAL_COHORTS[optimizationGoal];
  }

  const objective = normalizeMetaGoal(input.objective);
  if (objective && OBJECTIVE_COHORTS[objective]) {
    return OBJECTIVE_COHORTS[objective];
  }

  if (!event && !optimizationGoal && !objective && ((input.purchases ?? 0) > 0 || (input.revenue ?? 0) > 0)) {
    return "purchase";
  }

  return "unknown";
}

export function isPurchaseCohort(cohort: MetaFunnelCohort): boolean {
  return cohort === "purchase";
}

/**
 * The optimization goals this repository already recognises.
 *
 * Derived from {@link OPTIMIZATION_GOAL_COHORTS} so a goal can never be known
 * to the funnel mapping and unknown to a validator, or vice versa.
 */
export const META_OPTIMIZATION_GOALS: readonly string[] =
  Object.keys(OPTIMIZATION_GOAL_COHORTS);
