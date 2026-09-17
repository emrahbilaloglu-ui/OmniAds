import {
  providerScalarSourcesComparable,
  type OverviewProvider,
} from "@/lib/overview-provider-metrics";
import { getDemoOverview, getDemoSparklines } from "@/lib/demo-business";

interface OverviewPayload {
  dateRange?: {
    startDate: string;
    endDate: string;
  };
  shopifyConnectionState?: "connected" | "disconnected" | "unknown";
  kpis?: {
    spend?: number;
    revenue?: number;
    purchases?: number;
    aov?: number;
    roas?: number;
    cpa?: number;
  };
  kpiSources?: {
    revenue?: { source?: string };
    purchases?: { source?: string };
  };
  providerSources?: {
    meta?: string | null;
    google?: string | null;
  };
  providerScalarRanges?: {
    meta?: { startDate: string; endDate: string } | null;
    google?: { startDate: string; endDate: string } | null;
  };
  platformEfficiency?: Array<{
    platform?: string;
    spend?: number;
    revenue?: number;
    roas?: number;
    purchases?: number;
    cpa?: number;
    impressions?: number;
    clicks?: number;
  }>;
}

interface GoogleOverviewPayload {
  kpis?: {
    spend?: number;
    revenue?: number;
    conversions?: number;
    roas?: number;
    cpa?: number;
    clicks?: number;
    impressions?: number;
    ctr?: number;
  };
}

interface AnalyticsOverviewPayload {
  kpis?: {
    sessions?: number;
    purchaseCvr?: number;
  };
}

export interface OverviewMetricTrendProviderScope {
  activeProviders: OverviewProvider[];
  sources: Record<OverviewProvider, string | null>;
}

export type OverviewMetricTrendConnectionState =
  | "connected"
  | "disconnected"
  | "unknown";

export interface OverviewMetricTrendConnectionScope {
  meta: OverviewMetricTrendConnectionState;
  google: OverviewMetricTrendConnectionState;
  shopify: OverviewMetricTrendConnectionState;
  ga4: OverviewMetricTrendConnectionState;
}

type CommerceSourceFamily = "shopify" | "ga4";

export interface OverviewMetricTrendCommerceScope {
  revenue: CommerceSourceFamily | null;
  purchases: CommerceSourceFamily | null;
}

interface RequestedRange {
  startDate: string;
  endDate: string;
}

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function providerForRow(platform: string | null | undefined): OverviewProvider | null {
  const normalized = platform?.trim().toLowerCase();
  if (normalized === "meta") return "meta";
  if (normalized === "google" || normalized === "google_ads") return "google";
  return null;
}

function rowsForProvider(overview: OverviewPayload, provider: OverviewProvider) {
  return (overview.platformEfficiency ?? []).filter(
    (row) => providerForRow(row.platform) === provider,
  );
}

function sumFiniteRows(
  rows: NonNullable<OverviewPayload["platformEfficiency"]>,
  key: "spend" | "revenue" | "purchases" | "impressions" | "clicks",
) {
  let total = 0;
  for (const row of rows) {
    const value = finiteOrNull(row[key]);
    if (value === null) return null;
    total += value;
  }
  return total;
}

/**
 * Freeze the paid-provider membership and scalar source family for the whole
 * requested window. A row with an unknown source makes the scope unusable;
 * silently dropping it would turn a two-provider ratio into a partial one.
 */
export function getOverviewMetricTrendProviderScope(
  overview: OverviewPayload | null,
  options?: {
    connections?: Pick<OverviewMetricTrendConnectionScope, "meta" | "google">;
    requestedRange?: RequestedRange;
  },
): OverviewMetricTrendProviderScope | null {
  if (!overview) return null;

  const sources: Record<OverviewProvider, string | null> = {
    meta: overview.providerSources?.meta ?? null,
    google: overview.providerSources?.google ?? null,
  };

  const activeProviders: OverviewProvider[] = [];
  for (const provider of ["meta", "google"] as const) {
    const rows = rowsForProvider(overview, provider);
    const source = sources[provider];
    const range = overview.providerScalarRanges?.[provider] ?? null;
    const hasAnyProviderEvidence = rows.length > 0 || source !== null || range !== null;

    if (!hasAnyProviderEvidence) {
      // A successful connection-status snapshot can prove that an absent
      // provider was intentionally out of scope. Connected or unread status
      // cannot distinguish no delivery from a failed provider read.
      if (options?.connections?.[provider] === "disconnected") continue;
      if (options?.connections) return null;
      continue;
    }

    if (
      rows.length === 0 ||
      !providerScalarSourcesComparable(provider, source, source)
    ) {
      return null;
    }

    if (options?.requestedRange) {
      if (
        !range ||
        range.startDate !== options.requestedRange.startDate ||
        range.endDate !== options.requestedRange.endDate
      ) {
        return null;
      }
    }

    // Historical rows remain valid evidence after a provider is disconnected.
    // The connection snapshot only decides whether an entirely absent provider
    // can be excluded; it never erases verified rows from the requested window.
    activeProviders.push(provider);
  }

  // With a successful status snapshot, two confirmed-disconnected providers
  // define an intentionally empty paid scope. Its additive spend is a measured
  // zero; ratios still remain unavailable because their denominator is zero.
  if (activeProviders.length === 0 && !options?.connections) return null;
  return { activeProviders: [...activeProviders], sources };
}

function commerceSourceFamily(
  overview: OverviewPayload | null,
  metric: "revenue" | "purchases",
): CommerceSourceFamily | null {
  if (!overview) return null;
  const source = overview.kpiSources?.[metric]?.source;
  if (
    overview.shopifyConnectionState === "connected" &&
    (source === "shopify_ledger" ||
      source === "shopify_warehouse" ||
      source === "shopify_live_fallback")
  ) {
    return "shopify";
  }
  if (
    overview.shopifyConnectionState === "disconnected" &&
    source === "ga4_fallback"
  ) {
    return "ga4";
  }
  return null;
}

/** Freeze the commerce authority selected by the full requested-window read. */
export function getOverviewMetricTrendCommerceScope(
  overview: OverviewPayload | null,
  connections?: Pick<OverviewMetricTrendConnectionScope, "shopify" | "ga4">,
): OverviewMetricTrendCommerceScope | null {
  if (!overview) return null;
  const revenue = commerceSourceFamily(overview, "revenue");
  const purchases = commerceSourceFamily(overview, "purchases");

  if (connections) {
    const familyAllowed = (family: CommerceSourceFamily | null) => {
      if (family === null) return true;
      if (family === "shopify") return connections.shopify === "connected";
      return (
        connections.shopify === "disconnected" &&
        connections.ga4 === "connected"
      );
    };
    if (!familyAllowed(revenue) || !familyAllowed(purchases)) return null;
  }

  return { revenue, purchases };
}

/**
 * Resolve the daily rows for an already-frozen full-window provider scope.
 * The provider set must match exactly and every daily source must be the same
 * known source/grain as the full-window read.
 */
function scopedPaidRows(
  overview: OverviewPayload | null,
  scope: OverviewMetricTrendProviderScope | null,
) {
  if (!overview || !scope) return null;

  const dailyProviders = new Set(
    (overview.platformEfficiency ?? [])
      .map((row) => providerForRow(row.platform))
      .filter((provider): provider is OverviewProvider => provider !== null),
  );
  if (
    dailyProviders.size !== scope.activeProviders.length ||
    scope.activeProviders.some((provider) => !dailyProviders.has(provider))
  ) {
    return null;
  }

  for (const provider of ["meta", "google"] as const) {
    if (
      !scope.activeProviders.includes(provider) &&
      (rowsForProvider(overview, provider).length > 0 ||
        (overview.providerSources?.[provider] ?? null) !== null)
    ) {
      return null;
    }
  }

  const rows = [] as NonNullable<OverviewPayload["platformEfficiency"]>;
  for (const provider of scope.activeProviders) {
    const dailySource = overview.providerSources?.[provider] ?? null;
    if (
      !providerScalarSourcesComparable(
        provider,
        scope.sources[provider],
        dailySource,
      )
    ) {
      return null;
    }
    rows.push(...rowsForProvider(overview, provider));
  }
  return rows;
}

function commerceSourceVerified(
  overview: OverviewPayload | null,
  metric: "revenue" | "purchases",
  scope: OverviewMetricTrendCommerceScope | null | undefined,
) {
  const dailyFamily = commerceSourceFamily(overview, metric);
  if (scope === undefined) return dailyFamily !== null;
  return dailyFamily !== null && dailyFamily === scope?.[metric];
}

/** Resolve one daily metric without conflating store revenue with provider attribution. */
export function getOverviewMetricTrendValue(metric: string, input: {
  overview: OverviewPayload | null;
  google: GoogleOverviewPayload | null;
  analytics: AnalyticsOverviewPayload | null;
  /** Full requested-window paid scope for Spend, CPA, MER and Blended ROAS. */
  providerScope?: OverviewMetricTrendProviderScope | null;
  /** Full requested-window commerce authority/source family. */
  commerceScope?: OverviewMetricTrendCommerceScope | null;
}) {
  const overview = input.overview?.kpis;
  const google = input.google?.kpis;
  const analytics = input.analytics?.kpis;
  const revenue = finiteOrNull(overview?.revenue);
  const purchases = finiteOrNull(overview?.purchases);
  const effectiveProviderScope =
    input.providerScope === undefined
      ? getOverviewMetricTrendProviderScope(input.overview)
      : input.providerScope;
  const paidPlatformRows = scopedPaidRows(input.overview, effectiveProviderScope);
  const attributedSpend = paidPlatformRows
    ? sumFiniteRows(paidPlatformRows, "spend")
    : null;
  const attributedConversionValue = paidPlatformRows
    ? sumFiniteRows(paidPlatformRows, "revenue")
    : null;

  if (metric === "revenue") {
    return commerceSourceVerified(input.overview, "revenue", input.commerceScope)
      ? revenue
      : null;
  }
  if (metric === "spend") return attributedSpend;
  if (metric === "mer") {
    return commerceSourceVerified(input.overview, "revenue", input.commerceScope) &&
      revenue !== null &&
      attributedSpend !== null &&
      attributedSpend > 0
      ? revenue / attributedSpend
      : null;
  }
  if (metric === "blended_roas") {
    return attributedSpend !== null &&
      attributedConversionValue !== null &&
      attributedSpend > 0
      ? attributedConversionValue / attributedSpend
      : null;
  }
  if (metric === "orders" || metric === "purchases") {
    return commerceSourceVerified(input.overview, "purchases", input.commerceScope)
      ? purchases
      : null;
  }
  if (metric === "conversion_rate") {
    const sessions = finiteOrNull(analytics?.sessions);
    const purchaseCvr = finiteOrNull(analytics?.purchaseCvr);
    return sessions !== null && sessions > 0 && purchaseCvr !== null
      ? purchaseCvr * 100
      : null;
  }
  if (metric === "aov") {
    return commerceSourceVerified(input.overview, "revenue", input.commerceScope) &&
      commerceSourceVerified(input.overview, "purchases", input.commerceScope) &&
      revenue !== null &&
      purchases !== null &&
      purchases > 0
      ? revenue / purchases
      : null;
  }
  if (metric === "cpa" || metric === "cost_per_purchase") {
    return attributedSpend !== null &&
      commerceSourceVerified(input.overview, "purchases", input.commerceScope) &&
      purchases !== null &&
      purchases > 0
      ? attributedSpend / purchases
      : null;
  }
  if (metric === "clicks") return finiteOrNull(google?.clicks);
  if (metric === "impressions") return finiteOrNull(google?.impressions);
  if (metric === "ctr") {
    const impressions = finiteOrNull(google?.impressions);
    const ctr = finiteOrNull(google?.ctr);
    return impressions !== null && impressions > 0 ? ctr : null;
  }

  if (metric.startsWith("meta-")) {
    const key = metric.replace("meta-", "");
    const rows = input.overview ? rowsForProvider(input.overview, "meta") : [];
    const source = input.overview?.providerSources?.meta ?? null;
    if (rows.length === 0 || !providerScalarSourcesComparable("meta", source, source)) {
      return null;
    }
    const spend = sumFiniteRows(rows, "spend");
    const rowRevenue = sumFiniteRows(rows, "revenue");
    const rowPurchases = sumFiniteRows(rows, "purchases");
    const impressions = sumFiniteRows(rows, "impressions");
    const clicks = sumFiniteRows(rows, "clicks");
    if (key === "spend") return spend;
    if (key === "revenue") return rowRevenue;
    if (key === "purchases") return rowPurchases;
    if (key === "roas") {
      return spend !== null && rowRevenue !== null && spend > 0 ? rowRevenue / spend : null;
    }
    if (key === "cpa") {
      return spend !== null && rowPurchases !== null && rowPurchases > 0
        ? spend / rowPurchases
        : null;
    }
    if (key === "cpm") {
      return spend !== null && impressions !== null && impressions > 0
        ? (spend / impressions) * 1_000
        : null;
    }
    if (key === "ctr") {
      return clicks !== null && impressions !== null && impressions > 0
        ? (clicks / impressions) * 100
        : null;
    }
    if (key === "cpc") {
      return spend !== null && clicks !== null && clicks > 0 ? spend / clicks : null;
    }
  }

  if (metric.startsWith("google-")) {
    const key = metric.replace("google-", "");
    const rows = input.overview ? rowsForProvider(input.overview, "google") : [];
    const source = input.overview?.providerSources?.google ?? null;
    if (rows.length === 0 || !providerScalarSourcesComparable("google", source, source)) {
      return null;
    }
    const spend = sumFiniteRows(rows, "spend");
    const rowRevenue = sumFiniteRows(rows, "revenue");
    const rowPurchases = sumFiniteRows(rows, "purchases");
    if (key === "spend") return spend;
    if (key === "revenue") return rowRevenue;
    if (key === "purchases") return rowPurchases;
    if (key === "roas") {
      return spend !== null && rowRevenue !== null && spend > 0 ? rowRevenue / spend : null;
    }
    if (key === "cpa") {
      return spend !== null && rowPurchases !== null && rowPurchases > 0
        ? spend / rowPurchases
        : null;
    }
    if (key === "clicks") return finiteOrNull(google?.clicks);
    if (key === "impressions") return finiteOrNull(google?.impressions);
    if (key === "ctr") {
      const impressions = finiteOrNull(google?.impressions);
      const ctr = finiteOrNull(google?.ctr);
      return impressions !== null && impressions > 0 ? ctr : null;
    }
    if (key === "cpc") {
      const clicks = finiteOrNull(google?.clicks);
      return spend !== null && clicks !== null && clicks > 0 ? spend / clicks : null;
    }
    if (key === "conversion-rate") {
      const clicks = finiteOrNull(google?.clicks);
      return rowPurchases !== null && clicks !== null && clicks > 0
        ? (rowPurchases / clicks) * 100
        : null;
    }
  }

  return null;
}

/** Build real per-day demo values instead of repeating the 30-day demo aggregate. */
export function getDemoOverviewMetricTrendData(metric: string, dates: string[]) {
  const demoOverview = getDemoOverview();
  const providerScope = getOverviewMetricTrendProviderScope(demoOverview);
  const demoSparklines = getDemoSparklines();
  const combinedByDate = new Map(demoSparklines.combined.map((point) => [point.date, point]));
  const metaByDate = new Map(demoSparklines.providerTrends.meta.map((point) => [point.date, point]));
  const googleByDate = new Map(demoSparklines.providerTrends.google.map((point) => [point.date, point]));
  const ga4ByDate = new Map(demoSparklines.ga4Daily.map((point) => [point.date, point]));

  return dates.flatMap((date) => {
    const combined = combinedByDate.get(date);
    const meta = metaByDate.get(date);
    const google = googleByDate.get(date);
    if (!combined || !meta || !google) return [];

    const providerRow = (
      platform: "meta" | "google",
      point: typeof meta,
    ) => ({
      platform,
      spend: point.spend,
      revenue: point.revenue,
      purchases: point.purchases,
      impressions: point.impressions,
      clicks: point.clicks,
      roas: point.spend > 0 ? point.revenue / point.spend : 0,
      cpa: point.purchases > 0 ? point.spend / point.purchases : 0,
    });
    const ga4 = ga4ByDate.get(date);
    const value = getOverviewMetricTrendValue(metric, {
      overview: {
        shopifyConnectionState: demoOverview.shopifyConnectionState,
        kpis: {
          spend: combined.spend,
          revenue: combined.revenue,
          purchases: combined.purchases,
        },
        kpiSources: {
          revenue: demoOverview.kpiSources.revenue,
          purchases: demoOverview.kpiSources.purchases,
        },
        providerSources: demoOverview.providerSources,
        platformEfficiency: [providerRow("meta", meta), providerRow("google", google)],
      },
      google: {
        kpis: {
          spend: google.spend,
          revenue: google.revenue,
          conversions: google.purchases,
          roas: google.spend > 0 ? google.revenue / google.spend : 0,
          cpa: google.purchases > 0 ? google.spend / google.purchases : 0,
          clicks: google.clicks,
          impressions: google.impressions,
          ctr: google.impressions > 0 ? (google.clicks / google.impressions) * 100 : 0,
        },
      },
      analytics: {
        kpis: {
          sessions: ga4?.sessions,
          purchaseCvr:
            ga4 && ga4.sessions > 0 ? ga4.purchases / ga4.sessions : undefined,
        },
      },
      providerScope,
    });
    return typeof value === "number" && Number.isFinite(value) ? [{ date, value }] : [];
  });
}
