import { IntegrationStatus, Platform } from "@/src/types/platform";

export interface MetricsRow {
  impressions: number;
  clicks: number;
  purchases: number;
  spend: number;
  conversions: number;
  revenue: number;
  ctr: number;
  cpm: number;
  cpc: number;
  cpa: number;
  roas: number;
}

export interface Account {
  id: string;
  businessId: string;
  platform: Platform;
  name: string;
  currency: string;
  status: "active" | "paused";
}

export interface Campaign {
  id: string;
  accountId: string;
  platform: Platform;
  name: string;
  objective: string;
  status: "active" | "paused";
}

export interface AdSet {
  id: string;
  campaignId: string;
  platform: Platform;
  name: string;
  audience: string;
  status: "active" | "paused";
}

export interface Ad {
  id: string;
  adSetId: string;
  platform: Platform;
  name: string;
  format: string;
  status: "active" | "paused";
}

export interface Creative {
  id: string;
  businessId: string;
  platform: Platform;
  name: string;
  format: "image" | "video";
  status: "active" | "archived";
  primaryText: string;
  headline: string;
  cta: string;
  landingPageUrl: string;
  thumbnailUrl: string;
  createdAt: string;
  metrics: {
    spend: number;
    purchases: number;
    revenue: number;
    ctr: number;
    roas: number;
  };
  seenIn: {
    campaigns: string[];
    adSets: string[];
    ads: string[];
  };
}

export interface LandingPage {
  id: string;
  businessId: string;
  name: string;
  platform: Platform;
  url: string;
  utmPlaceholder: string;
  status: "active" | "draft";
  clicks: number;
  sessions: number;
  purchases: number;
  revenue: number;
  roas: number;
  conversionRate: number;
  updatedAt: string;
  topCreatives: string[];
  topCopies: string[];
}

export interface Copy {
  id: string;
  businessId: string;
  platform: Platform;
  objective: "awareness" | "traffic" | "conversions";
  headline: string;
  snippet: string;
  body: string;
  fullText: string;
  status: "approved" | "draft";
  language: string;
  usageCount: number;
  spend: number;
  roas: number;
  ctr: number;
  usedIn: {
    campaigns: string[];
    ads: string[];
  };
  similarCopies: string[];
  updatedAt: string;
}

export interface PlatformTableRow {
  id: string;
  name: string;
  level: "account" | "campaign" | "adSet" | "ad" | "creative";
  status: "active" | "paused";
  platform: Platform;
  accountId: string;
  metrics: Partial<MetricsRow>;
}

export interface IntegrationConnection {
  id: string;
  businessId: string;
  platform: Platform;
  status: IntegrationStatus;
  lastSyncAt: string | null;
  message?: string;
}

export interface OverviewData {
  businessId: string;
  dateRange: { startDate: string; endDate: string };
  totals: MetricsRow;
  kpis: {
    spend: number;
    revenue: number;
    roas: number;
    purchases: number;
    cpa: number;
    aov: number;
  };
  kpiSources?: Partial<
    Record<
      keyof OverviewData["kpis"],
      {
        source:
          | "shopify_ledger"
          | "shopify_warehouse"
          | "shopify_live_fallback"
          | "ga4_fallback"
          | "ad_platforms"
          | "unavailable";
        label: string;
      }
    >
  >;
  platformEfficiency: Array<{
    platform: Platform;
    spend: number;
    revenue: number;
    roas: number;
    purchases: number;
    cpa: number;
  }>;
  trends: {
    "7d": Array<{
      label: string;
      spend: number;
      revenue: number;
      purchases: number;
    }>;
    "30d": Array<{
      label: string;
      spend: number;
      revenue: number;
      purchases: number;
    }>;
    custom: Array<{
      label: string;
      spend: number;
      revenue: number;
      purchases: number;
    }>;
  };
  platformBreakdown: Array<{
    platform: Platform;
    spend: number;
    revenue: number;
    roas: number;
  }>;
  shopifyServing?: {
    source: "ledger" | "warehouse" | "live" | "none";
    provider: "shopify";
    trustState: "trusted" | "live_fallback" | "pending_repair" | "disabled" | "no_data";
    fallbackReason: string | null;
    lastSyncedAt: string | null;
    coverageStatus: "recent_ready" | "recent_only" | "historical_incomplete" | "unknown";
    productionMode: "disabled" | "auto" | "force_live" | "force_warehouse";
    pendingRepair: boolean;
    pendingRepairStartedAt: string | null;
    pendingRepairLastTopic: string | null;
    pendingRepairLastReceivedAt: string | null;
    selectedRevenueTruthBasis: string | null;
    basisSelectionReason: string | null;
    transactionCoverageOrderRate: number | null;
    transactionCoverageAmountRate: number | null;
    explainedAdjustmentRevenue: number | null;
    unexplainedAdjustmentRevenue: number | null;
  } | null;
}

export type OverviewMetricUnit =
  | "currency"
  | "count"
  | "ratio"
  | "percent"
  | "duration_seconds";

export type OverviewMetricStatus = "available" | "partial" | "unavailable";

export interface OverviewMetricCardData {
  id: string;
  title: string;
  subtitle?: string;
  value: number | null;
  previousValue?: number | null;
  changePct: number | null;
  sparklineData: Array<{ date: string; value: number }>;
  previousSparklineData?: Array<{ date: string; value: number }>;
  /** Which way the number moved. Drives the arrow glyph only. */
  trendDirection: "up" | "down" | "neutral";
  /**
   * What the move means for this metric. Drives the colour.
   *
   * Separate from `trendDirection` because they disagree for cost-like
   * metrics: a rising CPA is an up arrow and a negative outcome. Colouring
   * from the arrow gave a rising CPA the same emerald treatment as rising
   * revenue.
   */
  trendSentiment?: "positive" | "negative" | "neutral";
  dataSource: {
    key: string;
    label: string;
  };
  status: OverviewMetricStatus;
  helperText?: string;
  unit: OverviewMetricUnit;
  icon?: string;
}

export interface OverviewMetricCatalogEntry {
  key: string;
  title: string;
  metric: OverviewMetricCardData;
  section: string;
}

export interface OverviewAttributionRow {
  channel: string;
  spend: number | null;
  revenue: number | null;
  roas: number | null;
  conversions: number | null;
  clicks: number | null;
  ctr: number | null;
  cpa: number | null;
  aov: number | null;
  source: string;
}

export interface OverviewPlatformSection {
  id: string;
  title: string;
  provider: string;
  metrics: OverviewMetricCardData[];
}

export interface OverviewInsightCard {
  id: string;
  title: string;
  description: string;
  severity: "high" | "medium" | "low";
  status: "active" | "informational";
}

export interface AiDailyInsightSnapshot {
  insightDate: string;
  summary: string;
  risks: string[];
  opportunities: string[];
  recommendations: string[];
  createdAt: string;
}

export interface BusinessCostModelData {
  cogsPercent: number;
  shippingPercent: number;
  feePercent: number;
  fixedCost: number;
  updatedAt: string | null;
}

export interface OverviewSummaryData {
  businessId: string;
  dateRange: { startDate: string; endDate: string };
  comparison: {
    mode: "none" | "previous_period";
    startDate: string | null;
    endDate: string | null;
  };
  pins: OverviewMetricCardData[];
  storeMetrics: OverviewMetricCardData[];
  attribution: OverviewAttributionRow[];
  ltv: OverviewMetricCardData[];
  platforms: OverviewPlatformSection[];
  expenses: OverviewMetricCardData[];
  costModel: {
    configured: boolean;
    values: BusinessCostModelData | null;
  };
  customMetrics: OverviewMetricCardData[];
  webAnalytics: OverviewMetricCardData[];
  insights: OverviewInsightCard[];
  shopifyServing: NonNullable<OverviewData["shopifyServing"]> | null;
}
