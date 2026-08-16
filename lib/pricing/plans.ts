export type PlanId = "starter" | "growth" | "pro" | "scale";

/** Display names for a plan id, shared by the shell and the plan-gate trails. */
export const PLAN_LABELS: Record<PlanId, string> = {
  starter: "Starter",
  growth: "Growth",
  pro: "Pro",
  scale: "Scale",
};

export type ModuleId =
  | "overview"
  | "creatives"
  | "copies"
  | "meta"
  | "google_ads"
  | "analytics"
  | "landing_pages"
  | "geo_intelligence"
  | "seo_intelligence"
  | "tiktok"
  | "pinterest"
  | "snapchat"
  | "klaviyo"
  | "custom_reporting"
  | "team_roles"
  | "agency_mode"
  | "white_label_reports";

export interface PlanLimits {
  adAccounts: number | null;
  analyticsHistoryDays: number | null;
  workspaces: number | null;
  storeConnections: number | null;
}

export interface PricingPlan {
  id: PlanId;
  name: string;
  monthlyPrice: number;
  yearlyPrice: number | null;
  trialDays: number;
  limits: PlanLimits;
  modules: ModuleId[];
}

export const PRICING_PLANS: Record<PlanId, PricingPlan> = {
  starter: {
    id: "starter",
    name: "Starter",
    monthlyPrice: 0,
    yearlyPrice: null,
    trialDays: 0,
    limits: {
      adAccounts: 1,
      analyticsHistoryDays: 365,
      workspaces: 1,
      storeConnections: null,
    },
    modules: ["overview"],
  },
  growth: {
    id: "growth",
    name: "Growth",
    monthlyPrice: 49,
    yearlyPrice: 470,
    trialDays: 0,
    limits: {
      adAccounts: null,
      analyticsHistoryDays: 365,
      workspaces: 3,
      storeConnections: null,
    },
    modules: [
      "overview",
      "creatives",
      "copies",
      "meta",
      "google_ads",
      "analytics",
      "landing_pages",
    ],
  },
  pro: {
    id: "pro",
    name: "Pro",
    monthlyPrice: 99,
    yearlyPrice: 950,
    trialDays: 7,
    limits: {
      adAccounts: null,
      analyticsHistoryDays: null,
      workspaces: 5,
      storeConnections: null,
    },
    modules: [
      "overview",
      "creatives",
      "copies",
      "meta",
      "google_ads",
      "analytics",
      "landing_pages",
      "geo_intelligence",
      "seo_intelligence",
      "klaviyo",
    ],
  },
  scale: {
    id: "scale",
    name: "Scale",
    monthlyPrice: 249,
    yearlyPrice: 2390,
    trialDays: 0,
    limits: {
      adAccounts: null,
      analyticsHistoryDays: null,
      workspaces: null,
      storeConnections: null,
    },
    modules: [
      "overview",
      "creatives",
      "copies",
      "meta",
      "google_ads",
      "analytics",
      "landing_pages",
      "geo_intelligence",
      "seo_intelligence",
      "tiktok",
      "pinterest",
      "snapchat",
      "klaviyo",
      "custom_reporting",
      "team_roles",
      "agency_mode",
    ],
  },
};

export const PLAN_ORDER: PlanId[] = ["starter", "growth", "pro", "scale"];

export function getPlan(plan: PlanId | PricingPlan): PricingPlan {
  return typeof plan === "string" ? PRICING_PLANS[plan] : plan;
}

export function planHasModule(plan: PlanId, module: ModuleId): boolean {
  return PRICING_PLANS[plan].modules.includes(module);
}

export function minPlanForModule(module: ModuleId): PlanId {
  for (const id of PLAN_ORDER) {
    if (PRICING_PLANS[id].modules.includes(module)) return id;
  }
  return "scale";
}
