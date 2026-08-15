import { getCurrencySymbol } from "@/hooks/use-currency";
import type { RangePreset } from "@/components/date-range/DateRangePicker";
import { formatCurrencySmart, formatPercentSmart } from "@/lib/metric-format";
import type { BudgetRec } from "@/components/google-ads/BudgetScalingTab";

export type ActionState = "scale" | "optimize" | "test" | "reduce";
export type TrendLabelMode = "day" | "month";
export type PanelKey =
  | "summary"
  | "insights"
  | "search"
  | "plan"
  | "assetGroupAudience"
  | "products"
  | "assets";

export interface Campaign {
  id: string;
  name: string;
  status: string;
  channel: string;
  impressions?: number;
  clicks?: number;
  ctr?: number;
  cpc?: number;
  conversionRate?: number;
  spend: number;
  revenue: number;
  conversions: number;
  roas: number;
  cpa: number;
  impressionShare: number | null;
  lostIsBudget: number | null;
  spendShare: number;
  revenueShare: number;
  actionState: ActionState;
  roasChange: number | null | undefined;
  spendChange: number | null | undefined;
  revenueChange?: number | null | undefined;
  conversionsChange?: number | null | undefined;
}

export interface CampaignsResponse {
  rows: Campaign[];
  summary: { accountAvgRoas: number };
}

export interface SearchTheme {
  text: string;
  coverage?: "high" | "medium" | "low";
  alignedMessaging?: boolean;
}

export interface AssetGroupRow {
  id: string;
  campaignId?: string | null;
  campaign?: string;
  name: string;
  spend: number;
  revenue: number;
  roas: number;
  conversionRate: number;
  coverageScore: number;
  /** Google-served asset group ad strength (Best / Good / Learning / Low). */
  adStrength?: string | null;
  classification?: string;
  searchThemes: SearchTheme[];
  searchThemeCount: number;
  searchThemeAlignedCount: number;
  messagingMismatchCount?: number;
  missingAssetFields?: string[];
  recommendation?: string;
}

export interface AssetGroupsResponse {
  rows: AssetGroupRow[];
}

export interface AudienceRow {
  criterionId?: string;
  name?: string;
  campaignId?: string | null;
  campaign?: string;
  adGroup?: string;
  type: string;
  spend: number;
  revenue?: number;
  cpa?: number;
  roas: number;
  conversions: number;
}

export interface AudiencesResponse {
  rows: AudienceRow[];
}

export interface AssetRow {
  id: string;
  campaignId?: string | null;
  campaign?: string;
  assetGroup?: string;
  assetGroupName?: string | null;
  assetName?: string | null;
  type: string;
  performanceLabel?: "top" | "average" | "underperforming";
  impressions?: number;
  spend: number;
  conversions: number;
  roas: number;
  interactionRate?: number | null;
  preview?: string | null;
  assetText?: string | null;
  hint?: string;
}

export interface AssetsResponse {
  rows: AssetRow[];
}

export interface ProductRow {
  itemId?: string;
  title?: string;
  impressions?: number;
  clicks?: number;
  spend: number;
  revenue: number;
  roas: number;
  conversions: number;
  statusLabel?: "scale" | "stable" | "test" | "reduce";
  contributionState?: "positive" | "neutral" | "negative";
}

export interface ProductsResponse {
  rows: ProductRow[];
}

export interface SearchIntelligenceRow {
  key?: string;
  campaignId?: string | null;
  campaign?: string;
  searchTerm: string;
  spend: number;
  revenue: number;
  conversions: number;
  roas: number;
  ctr?: number;
  status?: string;
  intent?: string;
  isKeyword?: boolean;
  matchSource?: string;
  source?: string;
  recommendation?: string;
  classification?: string;
  wasteFlag?: boolean;
  keywordOpportunityFlag?: boolean;
  negativeKeywordFlag?: boolean;
  ownershipClass?: "brand" | "non_brand" | "competitor" | "sku_specific" | "weak_commercial";
  ownershipConfidence?: "high" | "medium" | "low";
  ownershipReason?: string;
  ownershipNeedsReview?: boolean;
}

export interface SearchIntelligenceResponse {
  rows: SearchIntelligenceRow[];
  summary?: {
    wastefulSpend?: number;
    keywordOpportunityCount?: number;
    negativeKeywordCount?: number;
    promotionSuggestionCount?: number;
  };
}

export interface GeoRow {
  country: string;
  spend: number;
  revenue: number;
  roas: number;
  conversions: number;
  ctr?: number;
}

export interface GeoResponse {
  rows: GeoRow[];
}

export interface DeviceRow {
  device: string;
  spend: number;
  revenue: number;
  roas: number;
  conversions: number;
  ctr?: number;
}

export interface DevicesResponse {
  rows: DeviceRow[];
}

export interface GoogleAdsTrendCampaignRow {
  id: string;
  name: string;
  status: string;
  channel: string;
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  impressionShare: number | null;
  lostIsBudget: number | null;
}

export interface GoogleAdsTrendsResponse {
  rows: Array<{
    date: string;
    rows: GoogleAdsTrendCampaignRow[];
  }>;
}

export const ACTION_CONFIG: Record<
  ActionState,
  { label: string; dot: string; chip: string; border: string }
> = {
  scale: {
    label: "Scale",
    dot: "bg-[var(--adc-pos-fg)]",
    chip: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]",
    border: "border-[var(--adc-pos-bd)]",
  },
  optimize: {
    label: "Optimize",
    dot: "bg-[var(--adc-info-fg)]",
    chip: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]",
    border: "border-[var(--adc-info-bd)]",
  },
  test: {
    label: "Test",
    dot: "bg-[var(--adc-caution-fg)]",
    chip: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]",
    border: "border-[var(--adc-caution-bd)]",
  },
  reduce: {
    label: "Reduce",
    dot: "bg-[var(--adc-danger-fg)]",
    chip: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]",
    border: "border-[var(--adc-danger-bd)]",
  },
};

/** The three surfaces the design's Assets & Audiences screen switches between. */
export type AssetViewKey = "groups" | "assets" | "audiences";

export const ASSET_VIEWS: Array<{ key: AssetViewKey; label: string }> = [
  { key: "groups", label: "Asset groups" },
  { key: "assets", label: "Assets" },
  { key: "audiences", label: "Audiences" },
];

export const PANEL_ITEMS: Array<{ key: PanelKey; label: string }> = [
  { key: "summary", label: "Summary" },
  { key: "insights", label: "Insights & Reports" },
  { key: "assetGroupAudience", label: "Asset Group & Audience Signals" },
  { key: "products", label: "Product Spend & Performance" },
  { key: "assets", label: "Asset Performance Radar" },
];

export function mapRangePresetToApi(
  value: RangePreset
): "3" | "7" | "14" | "30" | "90" | "custom" {
  if (value === "3d") return "3";
  if (value === "7d") return "7";
  if (value === "14d") return "14";
  if (value === "30d") return "30";
  if (value === "90d") return "90";
  return "custom";
}

export function isCampaignActive(status: string): boolean {
  const lower = status.toLowerCase();
  return lower === "active" || lower === "enabled";
}

export function fmtCurrency(n: number): string {
  return formatCurrencySmart(n, getCurrencySymbol());
}

export function fmtCurrencyPrecise(n: number): string {
  return formatCurrencySmart(n, getCurrencySymbol());
}

export function fmtRoas(n: number): string {
  return `${n.toFixed(2)}x`;
}

export function fmtPct(n: number): string {
  return formatPercentSmart(n);
}

export function fmtNumber(n: number): string {
  if (!Number.isFinite(n)) return "0";
  if (Math.abs(n) >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (Math.abs(n) >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return `${Math.round(n)}`;
}

function toIsoDate(date: Date): string {
  return date.toISOString().slice(0, 10);
}

export function resolveTrendTimeline(start: string, end: string): {
  dates: string[];
  labelMode: TrendLabelMode;
} {
  const startDate = new Date(`${start}T00:00:00Z`);
  const endDate = new Date(`${end}T00:00:00Z`);

  if (
    Number.isNaN(startDate.getTime()) ||
    Number.isNaN(endDate.getTime()) ||
    startDate > endDate
  ) {
    return { dates: [], labelMode: "day" };
  }

  const msPerDay = 24 * 60 * 60 * 1000;
  const daySpan =
    Math.max(
      1,
      Math.floor((endDate.getTime() - startDate.getTime()) / msPerDay) + 1
    );

  if (daySpan > 180) {
    const dates: string[] = [];
    const cursor = new Date(
      Date.UTC(startDate.getUTCFullYear(), startDate.getUTCMonth(), 1)
    );
    const endMonth = new Date(
      Date.UTC(endDate.getUTCFullYear(), endDate.getUTCMonth(), 1)
    );

    while (cursor <= endMonth) {
      dates.push(toIsoDate(cursor));
      cursor.setUTCMonth(cursor.getUTCMonth() + 1);
    }

    return { dates, labelMode: "month" };
  }

  const stepDays = daySpan <= 45 ? 1 : daySpan <= 120 ? 2 : 3;
  const dates: string[] = [];
  const cursor = new Date(startDate);

  while (cursor <= endDate) {
    dates.push(toIsoDate(cursor));
    cursor.setUTCDate(cursor.getUTCDate() + stepDays);
  }

  const last = dates[dates.length - 1];
  if (last !== toIsoDate(endDate)) {
    dates.push(toIsoDate(endDate));
  }

  return { dates, labelMode: "day" };
}

/**
 * The budget endpoint returns its findings as named campaign buckets. The UI
 * contract is a flat recommendation list, so the buckets are mapped here.
 *
 * Google serves no per-campaign budget delta on this report, so the change
 * amount stays null and the card reads direction only.
 */
export interface GoogleBudgetInsights {
  scaleBudgetCandidates?: Array<Record<string, unknown>>;
  budgetWasteCampaigns?: Array<Record<string, unknown>>;
  balancedCampaigns?: Array<Record<string, unknown>>;
}

export function normaliseBudgetRecommendations(
  value: GoogleBudgetInsights | BudgetRec[] | undefined,
): BudgetRec[] {
  if (!value) return [];
  if (Array.isArray(value)) return value;

  const build = (
    rows: Array<Record<string, unknown>> | undefined,
    direction: "increase" | "decrease",
    reason: string,
  ): BudgetRec[] =>
    (rows ?? []).map((row) => ({
      campaign:
        (typeof row.name === "string" && row.name) ||
        (typeof row.campaignName === "string" && row.campaignName) ||
        "Unnamed campaign",
      currentSpend: Number(row.spend) || 0,
      suggestedBudgetChange: null,
      direction,
      reason,
    }));

  return [
    ...build(
      value.scaleBudgetCandidates,
      "increase",
      "Strong return and losing impression share to budget.",
    ),
    ...build(
      value.budgetWasteCampaigns,
      "decrease",
      "Spend is running ahead of the return this campaign produces.",
    ),
  ];
}
