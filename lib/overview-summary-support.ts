import { deltaSentiment, getMetricDirection } from "@/lib/metric-semantics";
import { getBusinessCostModel } from "@/lib/business-cost-model";
import { resolveGa4AnalyticsContext, runGA4Report } from "@/lib/google-analytics-reporting";
import { buildOverviewOpportunities } from "@/lib/overviewInsights";
import { type OverviewResponse as OverviewAggregateData } from "@/lib/overview-service";
import {
  OVERVIEW_PROVIDER_METRIC_SPECS,
  buildProviderMetricSeries,
  deriveProviderMetric,
  providerMetricId,
  providerMetricUnavailableReason,
  providerScalarSourcesComparable,
  providerTrendMatchesScalar,
  type ProviderPrimitives,
} from "@/lib/overview-provider-metrics";
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

const OVERVIEW_PAID_PROVIDER_SPECS = [
  { provider: "meta", label: "Meta Ads" },
  { provider: "google", label: "Google Ads" },
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
    trendSentiment: deltaSentiment(getMetricDirection(params.metricKey ?? params.id), changePct ?? 0),
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

function normalizedProvider(value: string) {
  const provider = value.trim().toLowerCase();
  return provider === "google_ads" ? "google" : provider;
}

export interface OverviewProviderAggregate {
  platform: "meta" | "google";
  spend: number;
  revenue: number;
  purchases: number;
  /** Attribution-table contract: 0 when the denominator is 0. Cards derive their own. */
  roas: number;
  cpa: number;
  /** Null when any contributing row did not report the primitive. */
  impressions: number | null;
  clicks: number | null;
}

function sumReported(rows: OverviewAggregateData["platformEfficiency"], key: "impressions" | "clicks") {
  let total = 0;
  for (const row of rows) {
    const value = row[key];
    if (typeof value !== "number" || !Number.isFinite(value)) return null;
    total += value;
  }
  return total;
}

/** Collapse account-grain rows into the provider-grain contract Overview draws. */
export function aggregateOverviewProviderRow(
  data: OverviewAggregateData | null,
  provider: "meta" | "google"
): OverviewProviderAggregate | null {
  const rows = data?.platformEfficiency.filter((row) => normalizedProvider(row.platform) === provider) ?? [];
  if (rows.length === 0) return null;

  const spend = rows.reduce((sum, row) => sum + row.spend, 0);
  const revenue = rows.reduce((sum, row) => sum + row.revenue, 0);
  const purchases = rows.reduce((sum, row) => sum + row.purchases, 0);
  return {
    platform: provider,
    spend,
    revenue,
    purchases,
    roas: spend > 0 ? revenue / spend : 0,
    cpa: purchases > 0 ? spend / purchases : 0,
    impressions: sumReported(rows, "impressions"),
    clicks: sumReported(rows, "clicks"),
  };
}

/** Provider aggregate only when its scalar read has a known, supported source. */
export function aggregateVerifiedOverviewProviderRow(
  data: OverviewAggregateData | null,
  provider: "meta" | "google",
): OverviewProviderAggregate | null {
  const source = data?.providerSources?.[provider];
  return providerScalarSourcesComparable(provider, source, source)
    ? aggregateOverviewProviderRow(data, provider)
    : null;
}

function providerPrimitives(row: OverviewProviderAggregate | null): ProviderPrimitives | null {
  if (!row) return null;
  return {
    spend: row.spend,
    revenue: row.revenue,
    purchases: row.purchases,
    impressions: row.impressions,
    clicks: row.clicks,
  };
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
  organic: { revenue: number | null; conversions: number | null }
): OverviewAttributionRow[] {
  const paidRows = OVERVIEW_PAID_PROVIDER_SPECS.map(({ provider, label }) => ({
    provider,
    label,
    metrics: aggregateVerifiedOverviewProviderRow(overview, provider),
  }));
  const knownPaidSpend = paidRows.reduce((sum, row) => sum + (row.metrics?.spend ?? 0), 0);

  const rows: OverviewAttributionRow[] = paidRows.map(({ label, metrics }) => {
    const spend = metrics?.spend ?? null;
    const revenue = metrics?.revenue ?? null;
    const conversions = metrics?.purchases ?? null;
    return {
      channel: label,
      spend,
      spendShare: spend !== null && knownPaidSpend > 0 ? Number(((spend / knownPaidSpend) * 100).toFixed(1)) : null,
      revenue,
      roas: metrics?.roas ?? null,
      conversions,
      clicks: null,
      ctr: null,
      cpa: metrics?.cpa ?? null,
      aov:
        revenue !== null && conversions !== null && conversions > 0 ? Number((revenue / conversions).toFixed(2)) : null,
      source: metrics ? "Overview provider aggregation" : "No synced provider attribution data",
    };
  });

  rows.push(
    {
      channel: "Klaviyo",
      spend: null,
      spendShare: null,
      revenue: null,
      roas: null,
      conversions: null,
      clicks: null,
      ctr: null,
      cpa: null,
      aov: null,
      source: "No verified Klaviyo attribution contract",
    },
    {
      channel: "Organic · GA4",
      spend: null,
      spendShare: null,
      revenue: organic.revenue,
      roas: null,
      conversions: organic.conversions,
      clicks: null,
      ctr: null,
      cpa: null,
      aov:
        organic.revenue !== null && organic.conversions !== null && organic.conversions > 0
          ? Number((organic.revenue / organic.conversions).toFixed(2))
          : null,
      source: "GA4",
    }
  );
  return rows;
}

const PROVIDER_METRIC_ICONS: Record<string, string> = {
  spend: "wallet",
  revenue: "badge-dollar-sign",
  roas: "chart-line",
  purchases: "shopping-cart",
  cpa: "target",
  cpm: "eye",
  ctr: "mouse-pointer-click",
  cpc: "coins",
  "conversion-rate": "percent",
};

/**
 * Eight provider-specific cards per platform, in the order fixed by
 * `OVERVIEW_PROVIDER_METRIC_SPECS`. Every value — current and previous — is
 * derived from that window's summed provider primitives, so a CTR is total
 * clicks over total impressions rather than an average of account CTRs, and
 * nothing here reads the blended `totals`.
 */
export function buildPlatformSections(
  current: OverviewAggregateData,
  previous: OverviewAggregateData | null,
  compareMode: CompareMode,
  requestedWindow?: { startDate: string; endDate: string },
): OverviewPlatformSection[] {
  return OVERVIEW_PAID_PROVIDER_SPECS.map(({ provider, label }) => {
    const coverage = current.providerScalarRanges?.[provider];
    const coverageWithinWindow = !requestedWindow || !coverage || (
      coverage.startDate >= requestedWindow.startDate &&
      coverage.endDate <= requestedWindow.endDate &&
      coverage.startDate <= coverage.endDate
    );
    const partialCoverage = Boolean(requestedWindow && coverage && coverageWithinWindow && (
      coverage.startDate !== requestedWindow.startDate || coverage.endDate !== requestedWindow.endDate
    ));
    const primitives = coverageWithinWindow
      ? providerPrimitives(aggregateVerifiedOverviewProviderRow(current, provider))
      : null;
    // A previous value is only meaningful when both windows were read from the
    // same source and grain; otherwise the change would compare different rows.
    const previousPrimitives = !partialCoverage && providerScalarSourcesComparable(
      provider,
      current.providerSources?.[provider],
      previous?.providerSources?.[provider],
    )
      ? providerPrimitives(aggregateVerifiedOverviewProviderRow(previous, provider))
      : null;
    // A trend from a different read than the scalar (e.g. a warehouse trend
    // under a live total) would contradict the card, so it is not attached.
    const providerTrendSeries = providerTrendMatchesScalar(
      provider,
      current.providerSources?.[provider],
      current.providerTrendSources?.[provider],
    )
      ? (current.providerTrends?.[provider] ?? [])
      : [];
    return {
      id: provider,
      title: label,
      provider,
      coverageNote: partialCoverage && primitives && coverage && requestedWindow
        ? `Available source range: ${coverage.startDate}–${coverage.endDate}; selected range: ${requestedWindow.startDate}–${requestedWindow.endDate}. Totals do not cover the full selection.`
        : null,
      metrics: OVERVIEW_PROVIDER_METRIC_SPECS[provider].map((spec) => {
        const id = providerMetricId(provider, spec.suffix);
        const icon = PROVIDER_METRIC_ICONS[spec.suffix];
        if (!primitives) {
          return buildUnavailableMetric({
            id,
            title: spec.title,
            unit: spec.unit,
            sourceKey: provider,
            sourceLabel: label,
            helperText: "No synced provider data for this window",
            icon,
          });
        }
        return buildMetricCard({
          id,
          title: spec.title,
          value: deriveProviderMetric(spec.suffix, primitives),
          previousValue: previousPrimitives ? deriveProviderMetric(spec.suffix, previousPrimitives) : null,
          unit: spec.unit,
          sourceKey: provider,
          sourceLabel: label,
          helperText: providerMetricUnavailableReason(provider, spec.suffix, primitives) ?? undefined,
          sparklineData: buildProviderMetricSeries(spec.suffix, providerTrendSeries),
          compareMode,
          icon,
          metricKey: spec.metricKey,
        });
      }),
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
    const context = await resolveGa4AnalyticsContext(params.businessId, {
      requireProperty: true,
    });
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

    const revenuePerCustomer = totalPurchasers > 0 ? Number((purchaseRevenue / totalPurchasers).toFixed(2)) : null;
    const repeatPurchaseRate =
      totalPurchasers > 0
        ? Number(((Math.max(totalPurchasers - firstTimePurchasers, 0) / totalPurchasers) * 100).toFixed(1))
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
    const context = await resolveGa4AnalyticsContext(params.businessId, {
      requireProperty: true,
    });
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
