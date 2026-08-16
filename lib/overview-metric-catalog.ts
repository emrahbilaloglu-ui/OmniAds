import type {
  OverviewMetricCatalogEntry,
  OverviewMetricCardData,
  OverviewSummaryData,
} from "@/src/types/models";

export function buildOverviewMetricCatalog(
  summary: OverviewSummaryData | undefined
): OverviewMetricCatalogEntry[] {
  if (!summary) return [];

  const entries: OverviewMetricCatalogEntry[] = [];

  const register = (key: string, section: string, metric: OverviewMetricCardData | undefined) => {
    if (!metric || metric.status === "unavailable") return;
    entries.push({
      key,
      title: metric.title,
      section,
      metric: {
        ...metric,
        id: key,
      },
    });
  };

  register("revenue", "pins", summary.pins.find((metric) => metric.id === "pins-revenue"));
  register("spend", "pins", summary.pins.find((metric) => metric.id === "pins-spend"));
  register("mer", "pins", summary.pins.find((metric) => metric.id === "pins-mer"));
  register(
    "blended_roas",
    "pins",
    summary.pins.find((metric) => metric.id === "pins-blended-roas")
  );
  register("orders", "pins", summary.pins.find((metric) => metric.id === "pins-orders"));
  register(
    "conversion_rate",
    "pins",
    summary.pins.find((metric) => metric.id === "pins-conversion-rate")
  );
  register("aov", "storeMetrics", summary.storeMetrics.find((metric) => metric.id === "store-aov"));
  register(
    "cpa",
    "customMetrics",
    summary.customMetrics.find((metric) => metric.id === "custom-blended-cpa")
  );
  register("sessions", "webAnalytics", summary.webAnalytics.find((metric) => metric.id === "web-sessions"));
  register(
    "engagement_rate",
    "webAnalytics",
    summary.webAnalytics.find((metric) => metric.id === "web-engagement-rate")
  );

  for (const platform of summary.platforms) {
    for (const metric of platform.metrics) {
      register(metric.id, `platform:${platform.provider}`, metric);
    }
  }

  return entries;
}

export const DEFAULT_PINNED_METRICS = [
  "revenue",
  "spend",
  "blended_roas",
  "orders",
  "conversion_rate",
];
