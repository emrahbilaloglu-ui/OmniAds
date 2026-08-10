import { deltaSentiment, getMetricDirection } from "@/lib/metric-semantics";
import { getBusinessCostModel } from "@/lib/business-cost-model";
import { resolveGa4AnalyticsContext, runGA4Report } from "@/lib/google-analytics-reporting";
import { type IntegrationStatusResponse } from "@/lib/integration-status";
import { buildOverviewOpportunities } from "@/lib/overviewInsights";
import { type OverviewResponse as OverviewAggregateData } from "@/lib/overview-service";
import type {
  OverviewAttributionRow,
  BusinessCostModelData,
  OverviewInsightCard,
  OverviewMetricCardData,
  OverviewMetricStatus,
  OverviewMetricUnit,
  OverviewPlatformSection,
} from "@/src/types/models";

export type CompareMode = "none" | "previous_period";

interface SparklinePoint {
  date: string;
  value: number;
}

interface Ga4DailyTrendPoint {
  date: string;
  sessions: number;
  purchases: number;
  revenue: number;
  engagementRate: number;
  avgSessionDuration: number;
  totalPurchasers: number;
  firstTimePurchasers: number;
}

export interface Ga4LtvSnapshot {
  revenuePerCustomer: number | null;
  repeatPurchaseRate: number | null;
  averageCustomerLtv: number | null;
  ltvToCac: number | null;
  customerLifespan: number | null;
}

const ATTRIBUTION_PROVIDER_LABELS: Record<string, string> = {
  meta: "Meta Ads",
  google: "Google Ads",
  tiktok: "TikTok Ads",
  pinterest: "Pinterest",
  snapchat: "Snapchat",
  klaviyo: "Klaviyo",
};

const ATTRIBUTION_PROVIDER_ORDER = [
  "meta",
  "google",
  "tiktok",
  "pinterest",
  "snapchat",
  "klaviyo",
] as const;

export function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function parseIsoDate(value: string | null | undefined, fallback: Date) {
  if (!value) return new Date(fallback);
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? new Date(fallback) : parsed;
}

export function getPreviousWindow(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  const diffDays = Math.max(1, Math.round((end.getTime() - start.getTime()) / 86_400_000) + 1);
  const previousEnd = new Date(start);
  previousEnd.setUTCDate(previousEnd.getUTCDate() - 1);
  const previousStart = new Date(previousEnd);
  previousStart.setUTCDate(previousStart.getUTCDate() - (diffDays - 1));
  return {
    startDate: toIsoDate(previousStart),
    endDate: toIsoDate(previousEnd),
  };
}

function computeChangePct(current: number | null, previous: number | null, compareMode: CompareMode) {
  if (compareMode === "none") return null;
  if (current === null || previous === null || previous === 0) return null;
  return Number((((current - previous) / Math.abs(previous)) * 100).toFixed(1));
}

function trendDirection(changePct: number | null): "up" | "down" | "neutral" {
  if (changePct === null || changePct === 0) return "neutral";
  return changePct > 0 ? "up" : "down";
}

function inferMetricStatus(value: number | null, helperText?: string): OverviewMetricStatus {
  if (value === null) return "unavailable";
  return helperText ? "partial" : "available";
}

export function buildMetricCard(params: {
  id: string;
  title: string;
  subtitle?: string;
  value: number | null;
  previousValue?: number | null;
  unit: OverviewMetricUnit;
  sourceKey: string;
  sourceLabel: string;
  helperText?: string;
  sparklineData?: Array<{ date: string; value: number }>;
  icon?: string;
  compareMode: CompareMode;
  /**
   * The metric this card shows, used to decide what a change means.
   *
   * Defaults to the card id, which is already the metric name on every caller.
   * An unrecognised key resolves to neutral, so a metric nobody classified is
   * never coloured by the sign of its change.
   */
  metricKey?: string;
}): OverviewMetricCardData {
  const changePct = computeChangePct(params.value, params.previousValue ?? null, params.compareMode);
  return {
    id: params.id,
    title: params.title,
    subtitle: params.subtitle,
    value: params.value,
    previousValue: params.previousValue ?? null,
    changePct,
    sparklineData: params.sparklineData ?? [],
    trendDirection: trendDirection(changePct),
    // The arrow says which way it moved; this says whether that is good. They
    // disagree for every cost-like metric, and deriving the colour from the
    // arrow gave a rising CPA the same treatment as rising revenue.
    trendSentiment: deltaSentiment(
      getMetricDirection(params.metricKey ?? params.id),
      changePct ?? 0,
    ),
    dataSource: {
      key: params.sourceKey,
      label: params.sourceLabel,
    },
    status: inferMetricStatus(params.value, params.helperText),
    helperText: params.helperText,
    unit: params.unit,
    icon: params.icon,
  };
}

export function buildUnavailableMetric(params: {
  id: string;
  title: string;
  subtitle?: string;
  helperText: string;
  sourceLabel?: string;
  sourceKey?: string;
  unit?: OverviewMetricUnit;
  icon?: string;
}): OverviewMetricCardData {
  return {
    id: params.id,
    title: params.title,
    subtitle: params.subtitle,
    value: null,
    previousValue: null,
    changePct: null,
    sparklineData: [],
    trendDirection: "neutral",
    dataSource: {
      key: params.sourceKey ?? "unavailable",
      label: params.sourceLabel ?? "Unavailable",
    },
    status: "unavailable",
    helperText: params.helperText,
    unit: params.unit ?? "count",
    icon: params.icon,
  };
}

export function roundSparklineValue(value: number, digits = 4) {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

export function toSparklineSeries<T>(
  points: T[] | undefined,
  mapper: (point: T) => number | null | undefined
): SparklinePoint[] {
  if (!points || points.length === 0) return [];
  return points.map((point) => ({
    date: (point as { date: string }).date,
    value: roundSparklineValue(mapper(point) ?? 0),
  }));
}

export function toRatioSparklineSeries<T>(
  points: T[] | undefined,
  numerator: (point: T) => number | null | undefined,
  denominator: (point: T) => number | null | undefined
): SparklinePoint[] {
  if (!points || points.length === 0) return [];
  return points.map((point) => {
    const top = numerator(point) ?? 0;
    const bottom = denominator(point) ?? 0;
    return {
      date: (point as { date: string }).date,
      value: bottom > 0 ? roundSparklineValue(top / bottom, 4) : 0,
    };
  });
}

export function toPercentSparklineSeries<T>(
  points: T[] | undefined,
  numerator: (point: T) => number | null | undefined,
  denominator: (point: T) => number | null | undefined
): SparklinePoint[] {
  if (!points || points.length === 0) return [];
  return points.map((point) => {
    const top = numerator(point) ?? 0;
    const bottom = denominator(point) ?? 0;
    return {
      date: (point as { date: string }).date,
      value: bottom > 0 ? roundSparklineValue((top / bottom) * 100, 4) : 0,
    };
  });
}

function findPlatformRow(data: OverviewAggregateData | null, platform: string) {
  return data?.platformEfficiency.find((row) => row.platform.toLowerCase() === platform.toLowerCase()) ?? null;
}

export function mapInsights(data: OverviewAggregateData, ga4Connected: boolean): OverviewInsightCard[] {
  return buildOverviewOpportunities({ data, ga4Connected }).map((item) => ({
    id: item.id,
    title: item.title,
    description: item.disabled && item.emptyMessage ? item.emptyMessage : item.description,
    severity: item.impact === "High" ? "high" : item.impact === "Med" ? "medium" : "low",
    status: item.disabled ? "informational" : "active",
  }));
}

export function buildAttributionRows(
  overview: OverviewAggregateData,
  integrationsStatus: IntegrationStatusResponse | null
): OverviewAttributionRow[] {
  const connectedProviders = ATTRIBUTION_PROVIDER_ORDER.filter((provider) => integrationsStatus?.[provider]);
  const metricsByProvider = new Map(overview.platformEfficiency.map((row) => [row.platform.toLowerCase(), row]));

  return connectedProviders.map((provider) => {
    const metrics = metricsByProvider.get(provider) ?? null;
    const spend = metrics?.spend ?? 0;
    const revenue = metrics?.revenue ?? 0;
    const conversions = metrics?.purchases ?? 0;
    return {
      channel: ATTRIBUTION_PROVIDER_LABELS[provider],
      spend,
      revenue,
      roas: metrics?.roas ?? 0,
      conversions,
      clicks: 0,
      ctr: 0,
      cpa: metrics?.cpa ?? 0,
      aov: conversions > 0 ? Number((revenue / conversions).toFixed(2)) : 0,
      source: metrics ? "Overview aggregation" : "Connected platform with no synced attribution data",
    };
  });
}

export function buildPlatformSections(
  current: OverviewAggregateData,
  previous: OverviewAggregateData | null,
  compareMode: CompareMode
): OverviewPlatformSection[] {
  return current.platformEfficiency.map((row) => {
    const previousRow = findPlatformRow(previous, row.platform);
    const provider = row.platform.toLowerCase();
    const providerTrendSeries = current.providerTrends?.[provider as "meta" | "google"] ?? [];
    return {
      id: provider,
      title: row.platform,
      provider,
      metrics: [
        buildMetricCard({
          id: `${provider}-spend`,
          title: "Spend",
          value: row.spend,
          previousValue: previousRow?.spend ?? null,
          unit: "currency",
          sourceKey: provider,
          sourceLabel: row.platform,
          sparklineData: toSparklineSeries(providerTrendSeries, (point) => point.spend),
          compareMode,
          icon: "wallet",
        }),
        buildMetricCard({
          id: `${provider}-revenue`,
          title: "Revenue",
          value: row.revenue,
          previousValue: previousRow?.revenue ?? null,
          unit: "currency",
          sourceKey: provider,
          sourceLabel: row.platform,
          sparklineData: toSparklineSeries(providerTrendSeries, (point) => point.revenue),
          compareMode,
          icon: "badge-dollar-sign",
        }),
        buildMetricCard({
          id: `${provider}-roas`,
          title: "ROAS",
          value: row.roas,
          previousValue: previousRow?.roas ?? null,
          unit: "ratio",
          sourceKey: provider,
          sourceLabel: row.platform,
          sparklineData: toRatioSparklineSeries(providerTrendSeries, (point) => point.revenue, (point) => point.spend),
          compareMode,
          icon: "chart-line",
        }),
        buildMetricCard({
          id: `${provider}-purchases`,
          title: "Conversions",
          value: row.purchases,
          previousValue: previousRow?.purchases ?? null,
          unit: "count",
          sourceKey: provider,
          sourceLabel: row.platform,
          sparklineData: toSparklineSeries(providerTrendSeries, (point) => point.purchases),
          compareMode,
          icon: "shopping-cart",
        }),
        buildMetricCard({
          id: `${provider}-cpa`,
          title: "CPA",
          value: row.cpa,
          previousValue: previousRow?.cpa ?? null,
          unit: "currency",
          sourceKey: provider,
          sourceLabel: row.platform,
          sparklineData: toRatioSparklineSeries(providerTrendSeries, (point) => point.spend, (point) => point.purchases),
          compareMode,
          icon: "target",
        }),
      ],
    };
  });
}

export function toCostModelData(
  costModel: Awaited<ReturnType<typeof getBusinessCostModel>>
): BusinessCostModelData | null {
  if (!costModel) return null;
  return {
    cogsPercent: costModel.cogsPercent,
    shippingPercent: costModel.shippingPercent,
    feePercent: costModel.feePercent,
    fixedCost: costModel.fixedCost,
    updatedAt: costModel.updatedAt,
  };
}

export async function getGa4LtvSnapshot(params: {
  businessId: string;
  startDate: string;
  endDate: string;
  spend: number;
}): Promise<Ga4LtvSnapshot | null> {
  try {
    const context = await resolveGa4AnalyticsContext(params.businessId, { requireProperty: true });
    if (!context.propertyId) return null;

    const report = await runGA4Report({
      propertyId: context.propertyId,
      accessToken: context.accessToken,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      metrics: [
        { name: "purchaseRevenue" },
        { name: "totalPurchasers" },
        { name: "firstTimePurchasers" },
        { name: "transactionsPerPurchaser" },
        { name: "averagePurchaseRevenuePerPayingUser" },
      ],
    });

    const totalsRow = report.totals?.[0] ?? report.rows[0];
    if (!totalsRow) return null;

    const purchaseRevenue = parseFloat(totalsRow.metrics[0] ?? "0") || 0;
    const totalPurchasers = parseFloat(totalsRow.metrics[1] ?? "0") || 0;
    const firstTimePurchasers = parseFloat(totalsRow.metrics[2] ?? "0") || 0;
    const averageRevenuePerPayingUser = parseFloat(totalsRow.metrics[4] ?? "0") || 0;

    const revenuePerCustomer =
      totalPurchasers > 0 ? Number((purchaseRevenue / totalPurchasers).toFixed(2)) : null;
    const repeatPurchaseRate =
      totalPurchasers > 0
        ? Number((((Math.max(totalPurchasers - firstTimePurchasers, 0) / totalPurchasers) * 100)).toFixed(1))
        : null;
    const averageCustomerLtv =
      averageRevenuePerPayingUser > 0 ? Number(averageRevenuePerPayingUser.toFixed(2)) : revenuePerCustomer;
    const cac =
      params.spend > 0 && firstTimePurchasers > 0 ? Number((params.spend / firstTimePurchasers).toFixed(2)) : null;
    const ltvToCac =
      averageCustomerLtv !== null && cac !== null && cac > 0 ? Number((averageCustomerLtv / cac).toFixed(2)) : null;

    return {
      revenuePerCustomer,
      repeatPurchaseRate,
      averageCustomerLtv,
      ltvToCac,
      customerLifespan: null,
    };
  } catch (error) {
    console.warn("[overview-summary] ga4_ltv_snapshot_unavailable", {
      businessId: params.businessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return null;
  }
}

export async function getGa4DailyTrendSnapshot(params: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<Ga4DailyTrendPoint[]> {
  try {
    const context = await resolveGa4AnalyticsContext(params.businessId, { requireProperty: true });
    if (!context.propertyId) return [];

    const report = await runGA4Report({
      propertyId: context.propertyId,
      accessToken: context.accessToken,
      dateRanges: [{ startDate: params.startDate, endDate: params.endDate }],
      dimensions: [{ name: "date" }],
      metrics: [
        { name: "sessions" },
        { name: "ecommercePurchases" },
        { name: "purchaseRevenue" },
        { name: "engagementRate" },
        { name: "averageSessionDuration" },
        { name: "totalPurchasers" },
        { name: "firstTimePurchasers" },
      ],
      orderBys: [{ dimension: { dimensionName: "date" } }],
      limit: 400,
    });

    return report.rows.map((row) => ({
      date: normalizeGa4Date(row.dimensions[0] ?? ""),
      sessions: parseFloat(row.metrics[0] ?? "0") || 0,
      purchases: parseFloat(row.metrics[1] ?? "0") || 0,
      revenue: parseFloat(row.metrics[2] ?? "0") || 0,
      engagementRate: parseFloat(row.metrics[3] ?? "0") || 0,
      avgSessionDuration: parseFloat(row.metrics[4] ?? "0") || 0,
      totalPurchasers: parseFloat(row.metrics[5] ?? "0") || 0,
      firstTimePurchasers: parseFloat(row.metrics[6] ?? "0") || 0,
    }));
  } catch (error) {
    console.warn("[overview-summary] ga4_daily_trends_unavailable", {
      businessId: params.businessId,
      message: error instanceof Error ? error.message : String(error),
    });
    return [];
  }
}

function normalizeGa4Date(value: string) {
  if (/^\d{8}$/.test(value)) {
    return `${value.slice(0, 4)}-${value.slice(4, 6)}-${value.slice(6, 8)}`;
  }
  return value;
}
