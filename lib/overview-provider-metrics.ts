import type { OverviewMetricUnit } from "@/src/types/models";

/**
 * The Overview provider-card KPI contract, shared by the summary route (server)
 * and the Overview body and card (client). It has no runtime dependencies so
 * both sides import the same order, labels, sentiment keys and formulas.
 *
 * Every rate is derived from summed primitives — never averaged from per-row
 * rates and never taken from the blended `totals` — and a missing or zero
 * denominator yields null rather than a fabricated zero.
 */

export type OverviewProvider = "meta" | "google";

export type ProviderMetricSuffix =
  | "spend"
  | "revenue"
  | "roas"
  | "purchases"
  | "cpa"
  | "cpm"
  | "ctr"
  | "cpc"
  | "conversion-rate";

export interface ProviderMetricSpec {
  /** `${provider}-${suffix}` is the stable card id. */
  suffix: ProviderMetricSuffix;
  title: string;
  unit: OverviewMetricUnit;
  /** Unprefixed key for `getMetricDirection`, so change sentiment resolves. */
  metricKey: string;
}

export const OVERVIEW_PROVIDER_METRIC_SPECS: Record<OverviewProvider, readonly ProviderMetricSpec[]> = {
  meta: [
    { suffix: "spend", title: "Spend", unit: "currency", metricKey: "spend" },
    { suffix: "revenue", title: "Revenue", unit: "currency", metricKey: "revenue" },
    { suffix: "roas", title: "ROAS", unit: "ratio", metricKey: "roas" },
    { suffix: "purchases", title: "Purchases", unit: "count", metricKey: "purchases" },
    { suffix: "cpa", title: "CPA", unit: "currency", metricKey: "cpa" },
    { suffix: "cpm", title: "CPM", unit: "currency", metricKey: "cpm" },
    // Meta's `clicks` field is all clicks (clicks_all_v2), not link clicks.
    { suffix: "ctr", title: "All-click CTR", unit: "percent", metricKey: "ctr" },
    { suffix: "cpc", title: "All-click CPC", unit: "currency", metricKey: "cpc" },
  ],
  google: [
    { suffix: "spend", title: "Spend", unit: "currency", metricKey: "spend" },
    // Google conversions are every configured primary conversion action, so
    // they are not called purchases, revenue or CPA.
    { suffix: "revenue", title: "Conversion value", unit: "currency", metricKey: "revenue" },
    { suffix: "roas", title: "ROAS", unit: "ratio", metricKey: "roas" },
    { suffix: "purchases", title: "Conversions", unit: "count", metricKey: "conversions" },
    { suffix: "cpa", title: "Cost / conv.", unit: "currency", metricKey: "cpa" },
    { suffix: "ctr", title: "CTR", unit: "percent", metricKey: "ctr" },
    { suffix: "cpc", title: "CPC", unit: "currency", metricKey: "cpc" },
    { suffix: "conversion-rate", title: "Conversion rate", unit: "percent", metricKey: "conversion_rate" },
  ],
};

export function providerMetricId(provider: OverviewProvider, suffix: ProviderMetricSuffix) {
  return `${provider}-${suffix}`;
}

/**
 * Where a provider card's scalar values and its daily trend were read from.
 *
 * A live scalar (today's live totals, a live historical fallback, Google's
 * current-day overlay) must never be drawn over a warehouse trend: the two
 * cover different data, so the sparkline would contradict the number above it.
 *
 * Meta's published warehouse reads name their grain: the summary and trend
 * both prefer campaign_daily whenever published campaign rows exist, and the
 * grain is part of the source so a campaign-grain total is never paired with
 * (or compared against) an account-grain one.
 */
export type MetaWarehouseSource = "warehouse_published_campaign_daily" | "warehouse_published_account_daily";
export type MetaScalarSource = MetaWarehouseSource | "current_day_live" | "live_historical_fallback";
export type GoogleScalarSource =
  | "warehouse_account_aggregate"
  | "warehouse_campaign_aggregate_fallback"
  | "live_overlay_current_day";
export type MetaTrendSource = MetaWarehouseSource;
export type GoogleTrendSource =
  | "warehouse_account_daily"
  | "warehouse_campaign_daily_fallback"
  | "projection_fallback"
  | "provider_truth_unavailable";

/** The Overview source name for a published Meta warehouse read; null for an unknown grain. */
export function metaWarehouseSource(scope: string | null | undefined): MetaWarehouseSource | null {
  if (scope === "campaign_daily") return "warehouse_published_campaign_daily";
  if (scope === "account_daily") return "warehouse_published_account_daily";
  return null;
}

/** Null means the provider produced no usable scalar (or trend) for the window. */
export interface ProviderScalarSources {
  meta: MetaScalarSource | null;
  google: GoogleScalarSource | null;
}

export interface ProviderTrendSources {
  meta: MetaTrendSource | null;
  google: GoogleTrendSource | null;
}

export const EMPTY_PROVIDER_SCALAR_SOURCES: ProviderScalarSources = { meta: null, google: null };
export const EMPTY_PROVIDER_TREND_SOURCES: ProviderTrendSources = { meta: null, google: null };

/** Scalar source → the only trend source that measures the same rows. */
const COMPATIBLE_TREND_SOURCE: Record<OverviewProvider, Readonly<Record<string, string>>> = {
  meta: {
    warehouse_published_campaign_daily: "warehouse_published_campaign_daily",
    warehouse_published_account_daily: "warehouse_published_account_daily",
  },
  google: {
    warehouse_account_aggregate: "warehouse_account_daily",
    warehouse_campaign_aggregate_fallback: "warehouse_campaign_daily_fallback",
  },
};

/** Every scalar source a provider can legitimately report. */
const KNOWN_SCALAR_SOURCES: Record<OverviewProvider, ReadonlySet<string>> = {
  meta: new Set<MetaScalarSource>([
    "warehouse_published_campaign_daily",
    "warehouse_published_account_daily",
    "current_day_live",
    "live_historical_fallback",
  ]),
  google: new Set<GoogleScalarSource>([
    "warehouse_account_aggregate",
    "warehouse_campaign_aggregate_fallback",
    "live_overlay_current_day",
  ]),
};

/**
 * Whether a provider trend may be drawn under that provider's scalar cards.
 * Unknown or absent sources on either side fail closed: no sparkline.
 */
export function providerTrendMatchesScalar(
  provider: OverviewProvider,
  scalarSource: string | null | undefined,
  trendSource: string | null | undefined,
): boolean {
  if (!scalarSource || !trendSource) return false;
  const expected = COMPATIBLE_TREND_SOURCE[provider][scalarSource];
  return expected !== undefined && expected === trendSource;
}

/**
 * Whether two windows' provider scalars may be compared (previous-period
 * value, change badge, comparison sparkline). Only an identical, known source
 * and grain compares: Google account aggregate with account aggregate, campaign
 * fallback with campaign fallback; Meta the same published grain or the same
 * live read. Anything else — including an unknown or absent source — fails
 * closed.
 */
export function providerScalarSourcesComparable(
  provider: OverviewProvider,
  currentSource: string | null | undefined,
  previousSource: string | null | undefined,
): boolean {
  if (!currentSource || currentSource !== previousSource) return false;
  return KNOWN_SCALAR_SOURCES[provider].has(currentSource);
}

/**
 * Blended ROAS compares the same paid-provider set across two windows. If one
 * window drops a provider or switches that provider's source/grain, the delta
 * is unavailable rather than comparing a different media mix.
 */
export function providerScalarSourceSetsComparable(
  current: Partial<Record<OverviewProvider, string | null>> | null | undefined,
  previous: Partial<Record<OverviewProvider, string | null>> | null | undefined,
): boolean {
  let comparedProviders = 0;
  for (const provider of ["meta", "google"] as const) {
    const currentSource = current?.[provider] ?? null;
    const previousSource = previous?.[provider] ?? null;
    if (Boolean(currentSource) !== Boolean(previousSource)) return false;
    if (!currentSource) continue;
    comparedProviders += 1;
    if (!providerScalarSourcesComparable(provider, currentSource, previousSource)) return false;
  }
  return comparedProviders > 0;
}

/** `meta-cpm` → `meta`; anything that is not a provider card id → null. */
export function providerForMetricId(id: string): OverviewProvider | null {
  if (id.startsWith("meta-")) return "meta";
  if (id.startsWith("google-")) return "google";
  return null;
}

/** Provider-grain sums. Null means the provider did not report the primitive. */
export interface ProviderPrimitives {
  spend: number | null;
  revenue: number | null;
  purchases: number | null;
  impressions: number | null;
  clicks: number | null;
}

function finiteOrNull(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function round(value: number, digits: number) {
  return Number(value.toFixed(digits));
}

function rate(numerator: number | null, denominator: number | null, scale = 1) {
  if (numerator === null || denominator === null || !(denominator > 0)) return null;
  return round((numerator / denominator) * scale, 4);
}

/** Why a derived card is unavailable while the provider row itself exists. */
export function providerMetricUnavailableReason(
  provider: OverviewProvider,
  suffix: ProviderMetricSuffix,
  primitives: ProviderPrimitives,
): string | null {
  const denominator = (value: number | null, unreported: string, zero: string) =>
    value === null ? unreported : value > 0 ? null : zero;
  switch (suffix) {
    case "spend":
    case "revenue":
    case "purchases":
      return primitives[suffix] === null ? "Not reported for this window" : null;
    case "roas":
      return denominator(primitives.spend, "Spend was not reported for this window", "No spend in this window");
    case "cpa":
      return provider === "google"
        ? denominator(
            primitives.purchases,
            "Conversions were not reported for this window",
            "No conversions in this window",
          )
        : denominator(primitives.purchases, "Purchases were not reported for this window", "No purchases in this window");
    case "cpm":
    case "ctr":
      return denominator(
        primitives.impressions,
        "Impressions were not reported for this window",
        "No impressions in this window",
      );
    case "cpc":
    case "conversion-rate":
      return denominator(primitives.clicks, "Clicks were not reported for this window", "No clicks in this window");
  }
}

/**
 * CPM = spend / impressions × 1000 · CTR = clicks / impressions × 100 ·
 * CPC = spend / clicks · Conv. rate = conversions / clicks × 100.
 */
export function deriveProviderMetric(suffix: ProviderMetricSuffix, primitives: ProviderPrimitives): number | null {
  const spend = finiteOrNull(primitives.spend);
  const revenue = finiteOrNull(primitives.revenue);
  const purchases = finiteOrNull(primitives.purchases);
  const impressions = finiteOrNull(primitives.impressions);
  const clicks = finiteOrNull(primitives.clicks);
  switch (suffix) {
    case "spend":
      return spend;
    case "revenue":
      return revenue;
    case "purchases":
      // Google conversions are fractional; keep up to two decimals.
      return purchases === null ? null : round(purchases, 2);
    case "roas":
      return rate(revenue, spend);
    case "cpa":
      return rate(spend, purchases);
    case "cpm":
      return rate(spend, impressions, 1000);
    case "ctr":
      return rate(clicks, impressions, 100);
    case "cpc":
      return rate(spend, clicks);
    case "conversion-rate":
      return rate(purchases, clicks, 100);
  }
}

export interface ProviderTrendPointInput {
  date: string;
  spend: number;
  revenue: number;
  purchases: number;
  impressions?: number | null;
  clicks?: number | null;
}

/**
 * The daily series for one provider metric. A day whose metric is undefined —
 * a zero or unreported denominator — is omitted instead of plotted as zero.
 */
export function buildProviderMetricSeries(
  suffix: ProviderMetricSuffix,
  points: readonly ProviderTrendPointInput[] | undefined,
): Array<{ date: string; value: number }> {
  if (!points || points.length === 0) return [];
  const series: Array<{ date: string; value: number }> = [];
  for (const point of points) {
    const value = deriveProviderMetric(suffix, {
      spend: point.spend,
      revenue: point.revenue,
      purchases: point.purchases,
      impressions: point.impressions ?? null,
      clicks: point.clicks ?? null,
    });
    if (value === null) continue;
    series.push({ date: point.date, value: round(value, 4) });
  }
  return series;
}

/**
 * Weighted daily ROAS across the supplied paid providers:
 * sum(provider conversion value) / sum(provider spend).
 *
 * Callers are responsible for source-gating the provider series before they
 * reach this helper. When more than one provider is active, a date is emitted
 * only when every active provider reported that date; absence is unknown, not
 * measured zero. A zero combined denominator is omitted.
 */
export function buildBlendedProviderRoasSeries(
  providerTrends: Partial<Record<OverviewProvider, readonly ProviderTrendPointInput[]>>,
): Array<{ date: string; value: number }> {
  const activeProviders = (["meta", "google"] as const).filter(
    (provider) => providerTrends[provider] !== undefined,
  );
  const byDate = new Map<string, { spend: number; revenue: number; providers: Set<OverviewProvider> }>();
  for (const provider of activeProviders) {
    for (const point of providerTrends[provider] ?? []) {
      if (!Number.isFinite(point.spend) || !Number.isFinite(point.revenue)) continue;
      const totals = byDate.get(point.date) ?? { spend: 0, revenue: 0, providers: new Set() };
      totals.spend += point.spend;
      totals.revenue += point.revenue;
      totals.providers.add(provider);
      byDate.set(point.date, totals);
    }
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([date, totals]) =>
      totals.providers.size === activeProviders.length && totals.spend > 0
        ? [{ date, value: round(totals.revenue / totals.spend, 4) }]
        : [],
    );
}

/** Daily paid spend across the supplied, already source-gated providers. */
export function buildPaidProviderSpendSeries(
  providerTrends: Partial<Record<OverviewProvider, readonly ProviderTrendPointInput[]>>,
): Array<{ date: string; value: number }> {
  const activeProviders = (["meta", "google"] as const).filter(
    (provider) => providerTrends[provider] !== undefined,
  );
  const byDate = new Map<string, { value: number; providers: Set<OverviewProvider> }>();
  for (const provider of activeProviders) {
    for (const point of providerTrends[provider] ?? []) {
      if (!Number.isFinite(point.spend)) continue;
      const totals = byDate.get(point.date) ?? { value: 0, providers: new Set() };
      totals.value += point.spend;
      totals.providers.add(provider);
      byDate.set(point.date, totals);
    }
  }
  return [...byDate.entries()]
    .sort(([left], [right]) => left.localeCompare(right))
    .flatMap(([date, totals]) =>
      totals.providers.size === activeProviders.length
        ? [{ date, value: round(totals.value, 4) }]
        : [],
    );
}
