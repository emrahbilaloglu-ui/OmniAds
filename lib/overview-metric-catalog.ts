import type {
  OverviewMetricCatalogEntry,
  OverviewMetricCardData,
  OverviewSummaryData,
} from "@/src/types/models";

export function buildOverviewMetricCatalog(
  summary: OverviewSummaryData | undefined,
  options: { includeUnavailable?: boolean } = {},
): OverviewMetricCatalogEntry[] {
  if (!summary && !options.includeUnavailable) return [];

  const pins = summary?.pins ?? [];
  const storeMetrics = summary?.storeMetrics ?? [];
  const ltv = summary?.ltv ?? [];
  const expenses = summary?.expenses ?? [];
  const customMetrics = summary?.customMetrics ?? [];
  const webAnalytics = summary?.webAnalytics ?? [];
  const platforms = summary?.platforms ?? [];

  const entries: OverviewMetricCatalogEntry[] = [];
  const registeredKeys = new Set<string>();
  const registeredMetricIds = new Set<string>();
  const duplicateDerivedMetricIds = new Set([
    "expenses-ad-spend",
    "expenses-mer",
    "custom-mer",
  ]);

  const register = (key: string, section: string, metric: OverviewMetricCardData | undefined) => {
    if (
      !metric ||
      registeredKeys.has(key) ||
      registeredMetricIds.has(metric.id) ||
      (!options.includeUnavailable && metric.status === "unavailable")
    ) {
      return;
    }
    entries.push({
      key,
      title: metric.title,
      section,
      metric: { ...metric },
    });
    registeredKeys.add(key);
    registeredMetricIds.add(metric.id);
  };

  const knownMetric = (
    key: string,
    section: string,
    metric: OverviewMetricCardData | undefined,
    fallback: Pick<OverviewMetricCardData, "id" | "title" | "unit"> &
      Partial<Pick<OverviewMetricCardData, "subtitle">>,
  ) => {
    register(
      key,
      section,
      metric ??
        (options.includeUnavailable
          ? {
              ...fallback,
              value: null,
              previousValue: null,
              changePct: null,
              sparklineData: [],
              previousSparklineData: [],
              trendDirection: "neutral",
              trendSentiment: "neutral",
              dataSource: { key: "unavailable", label: "Unavailable" },
              status: "unavailable",
              helperText: "No verified data for this window",
            }
          : undefined),
    );
  };

  knownMetric("revenue", "pins", pins.find((metric) => metric.id === "pins-revenue"), {
    id: "pins-revenue",
    title: "Revenue",
    unit: "currency",
  });
  knownMetric("spend", "pins", pins.find((metric) => metric.id === "pins-spend"), {
    id: "pins-spend",
    title: "Ad Spend",
    unit: "currency",
  });
  knownMetric("mer", "pins", pins.find((metric) => metric.id === "pins-mer"), {
    id: "pins-mer",
    title: "MER",
    subtitle: "Store revenue ÷ total ad spend",
    unit: "ratio",
  });
  knownMetric(
    "blended_roas",
    "pins",
    pins.find((metric) => metric.id === "pins-blended-roas"),
    {
      id: "pins-blended-roas",
      title: "Blended ROAS",
      subtitle: "Platform-attributed conversion value ÷ paid spend",
      unit: "ratio",
    },
  );
  knownMetric("orders", "pins", pins.find((metric) => metric.id === "pins-orders"), {
    id: "pins-orders",
    title: "Orders",
    unit: "count",
  });
  knownMetric(
    "conversion_rate",
    "pins",
    pins.find((metric) => metric.id === "pins-conversion-rate"),
    { id: "pins-conversion-rate", title: "Conversion Rate", unit: "percent" },
  );
  knownMetric("aov", "storeMetrics", storeMetrics.find((metric) => metric.id === "store-aov"), {
    id: "store-aov",
    title: "Average Order Value",
    unit: "currency",
  });
  knownMetric(
    "cpa",
    "customMetrics",
    customMetrics.find((metric) => metric.id === "custom-blended-cpa"),
    { id: "custom-blended-cpa", title: "Blended CPA", unit: "currency" },
  );
  knownMetric("sessions", "webAnalytics", webAnalytics.find((metric) => metric.id === "web-sessions"), {
    id: "web-sessions",
    title: "Sessions",
    unit: "count",
  });
  knownMetric(
    "engagement_rate",
    "webAnalytics",
    webAnalytics.find((metric) => metric.id === "web-engagement-rate"),
    { id: "web-engagement-rate", title: "Engagement Rate", unit: "percent" },
  );

  // Keep the legacy aliases above stable for persisted preferences, then make
  // every remaining metric available to the redesigned KPI picker. The old
  // catalog silently omitted useful Shopify, LTV, cost and web metrics.
  for (const metric of storeMetrics) {
    register(metric.id, "storeMetrics", metric);
  }
  for (const metric of ltv) {
    register(metric.id, "ltv", metric);
  }
  for (const metric of expenses) {
    if (duplicateDerivedMetricIds.has(metric.id)) continue;
    register(metric.id, "expenses", metric);
  }
  for (const metric of customMetrics) {
    if (duplicateDerivedMetricIds.has(metric.id)) continue;
    register(metric.id, "customMetrics", metric);
  }
  for (const metric of webAnalytics) {
    register(metric.id, "webAnalytics", metric);
  }

  for (const platform of platforms) {
    for (const metric of platform.metrics) {
      register(metric.id, `platform:${platform.provider}`, metric);
    }
  }

  return entries;
}

/**
 * A saved KPI key the current catalog cannot serve (a retired metric, or one
 * whose source is not connected). It stays visible — and removable — as an
 * honest unavailable card instead of silently disappearing from the band.
 */
export function unavailableCatalogEntry(key: string): OverviewMetricCatalogEntry {
  const title = key
    .replace(/^(pins|store|web|expenses|custom|ltv)-/, "")
    .replaceAll("_", " ")
    .replaceAll("-", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());

  return {
    key,
    title,
    section: "unavailable",
    metric: {
      id: `missing-${key}`,
      title,
      value: null,
      previousValue: null,
      changePct: null,
      sparklineData: [],
      previousSparklineData: [],
      trendDirection: "neutral",
      trendSentiment: "neutral",
      dataSource: { key: "unavailable", label: "Unavailable" },
      status: "unavailable",
      helperText: "This saved metric is not available from the current data source.",
      unit: "count",
    },
  };
}

export const DEFAULT_PINNED_METRICS = [
  "revenue",
  "spend",
  "blended_roas",
  "orders",
  "conversion_rate",
];
