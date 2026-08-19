import { getCurrencySymbol } from "@/hooks/use-currency";
import type { RangePreset } from "@/components/date-range/DateRangePicker";
import { MISSING_VALUE, formatCurrencySmart, formatPercentSmart } from "@/lib/metric-format";
import type { BudgetRec } from "@/components/google-ads/BudgetScalingTab";
import type { GoogleAdsReadCompletenessMeta } from "@/lib/google-ads/read-completeness";

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
  meta?: GoogleAdsReadCompletenessMeta;
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
  /**
   * The user list behind this audience criterion, when it targets one.
   * `ad_group_criterion.user_list.user_list` names the list and `user_list`
   * serves its name and the two membership sizes. A non-list audience type —
   * affinity, in-market, life events — carries none of these and every field
   * below stays null; so does a row synced before the list read existed.
   */
  userListId?: string | null;
  listName?: string | null;
  /** `user_list.size_for_display`, exactly as Google served it. */
  listSizeForDisplay?: number | null;
  /** `user_list.size_for_search`, exactly as Google served it. */
  listSizeForSearch?: number | null;
  /**
   * The size the design's single `Size` column prints, resolved from the two
   * above by `resolveGoogleAdsUserListSize` — Display first, Search when
   * Display is not served. Never a sum and never an estimate.
   */
  listSize?: number | null;
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
  /**
   * This product's own verdict, derived from a ROAS / CTR / interaction-rate
   * comparison against the account average. It is a real measurement, and it is
   * not Google's.
   */
  performanceLabel?: "top" | "average" | "underperforming";
  /**
   * Google's own `asset_group_asset.performance_label`
   * (Best | Good | Low | Learning | Pending), or null/absent when the provider
   * served no verdict — including on warehouse rows synced before the field was
   * read. This is the only label the design's "Google-served" caption may sit
   * above.
   */
  servedPerformanceLabel?: string | null;
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
  /**
   * Server-assigned product classification from the shopping report
   * (`analyzeProducts`): scale_product | hidden_winner |
   * underperforming_product | stable_product.
   */
  classification?: string;
  /**
   * Merchant Center item state, present only when a Merchant Center read has
   * landed for this item. An absent key means "no Merchant Center row", which
   * the Feed status column renders as the em dash — it never means "serving".
   */
  feedState?: "serving" | "limited" | "disapproved" | "unknown";
  /** The provider's own words for the chip, or null when it gave none. */
  feedStatusLabel?: string | null;
  feedAvailability?: string | null;
  feedIssues?: Array<{
    code: string | null;
    severity: string | null;
    attribute: string | null;
    description: string | null;
  }>;
  merchantCenterId?: string | null;
}

/**
 * The Merchant Center block the feed-health tiles print.
 *
 * Null means the read did not happen; a number means it did. The two are never
 * collapsed, because "we have not looked" and "there are none" are different
 * sentences and only the second one may be tinted.
 */
export interface ProductFeedSummary {
  totalItemsInFeed: number | null;
  servingItemCount: number | null;
  limitedItemCount: number | null;
  disapprovedItemCount: number | null;
  syncedAt: string | null;
  merchantCenterIds?: string[];
}

export interface ProductsResponse {
  rows: ProductRow[];
  feed?: ProductFeedSummary | null;
}

export interface SearchIntelligenceRow {
  key?: string;
  campaignId?: string | null;
  campaign?: string;
  searchTerm: string;
  spend: number;
  revenue: number;
  conversions: number;
  clicks?: number;
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
    complete: boolean;
  }>;
  meta: {
    complete: boolean;
    incompleteDates: string[];
  };
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
  { key: "assets", label: "Text & image assets" },
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
  const symbol = getCurrencySymbol();
  // INVARIANTS.md: "Missing currency must not silently become USD, $, TRY, or
  // EUR." With no configured currency there is no symbol, so the amount is
  // unavailable rather than silently denominated in dollars.
  if (symbol === null) return MISSING_VALUE;
  return formatCurrencySmart(n, symbol);
}

export function fmtCurrencyPrecise(n: number): string {
  const symbol = getCurrencySymbol();
  if (symbol === null) return MISSING_VALUE;
  return formatCurrencySmart(n, symbol);
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
