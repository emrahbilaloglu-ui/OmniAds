export type GoogleOverviewRouteTarget =
  | "products"
  | "search"
  | "advisor"
  | "keywords";

export type GoogleOverviewFreshnessState =
  | "fresh"
  | "stale"
  | "syncing"
  | "unavailable";

export type GoogleOverviewChartValueKind =
  | "currency-0"
  | "currency-2"
  | "decimal-2"
  | "integer"
  | "percent-1"
  | "compact";

export interface GoogleOverviewChartPoint {
  date: string;
  current: number | null;
  previous: number | null;
}

export interface GoogleOverviewChartModel {
  id: string;
  valueKind: GoogleOverviewChartValueKind;
  points: GoogleOverviewChartPoint[];
}

export interface GoogleOverviewMetricModel {
  key: string;
  label: string;
  value: string;
  delta?: string;
  deltaTone?: "positive" | "negative" | "neutral";
  detail?: string;
  chart: GoogleOverviewChartModel;
}

export interface GoogleOverviewLookCardModel {
  id: string;
  severity: string;
  tone: "critical" | "waste" | "opportunity" | "positive" | "neutral";
  title: string;
  description: string;
  evidence: string;
  actionLabel: string;
  target: GoogleOverviewRouteTarget | null;
}

export interface GoogleOverviewCampaignModel {
  id: string;
  name: string;
  type: string;
  typeTone: "info" | "auto" | "neutral";
  dailyBudget: string;
  spend: string;
  spendShare: string;
  spendShareWidth: number;
  revenue: string;
  roas: string;
  roasTone: "positive" | "warning" | "negative" | "neutral";
  conversions: string;
  impressionShare: string;
  lostImpressionShareBudget: string;
  lostImpressionShareTone: "warning" | "neutral";
  pulse: string;
  pulseTone: "positive" | "warning" | "negative" | "neutral";
}

export interface GoogleOverviewBudgetKpiModel {
  key: string;
  label: string;
  value: string;
  detail: string;
}

export interface GoogleOverviewBudgetRecommendationModel {
  id: string;
  campaign: string;
  amount: string;
  direction: "increase" | "decrease" | "neutral";
  reason: string;
}

export type GoogleOverviewFour<T> = readonly [T, T, T, T];
export type GoogleOverviewSix<T> = readonly [T, T, T, T, T, T];
export type GoogleOverviewThree<T> = readonly [T, T, T];

export interface GoogleOverviewExactModel {
  identity: {
    businessId: string;
    providerAccountId: string;
    currencyCode: string;
    windowLabel: string;
    windowDays: number | null;
  };
  freshness: {
    label: string;
    state: GoogleOverviewFreshnessState;
  };
  hero: GoogleOverviewFour<GoogleOverviewMetricModel>;
  secondary: GoogleOverviewSix<GoogleOverviewMetricModel>;
  lookCards: GoogleOverviewFour<GoogleOverviewLookCardModel>;
  campaigns: GoogleOverviewCampaignModel[];
  campaignSummary: string;
  budgetNote: string;
  budgetKpis: GoogleOverviewFour<GoogleOverviewBudgetKpiModel>;
  budgetRecommendations: GoogleOverviewThree<GoogleOverviewBudgetRecommendationModel>;
}
