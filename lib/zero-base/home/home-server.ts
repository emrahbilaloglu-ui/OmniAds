/**
 * Server read for Client Home.
 *
 * Reuses `getOverviewData` — the same aggregate read model `/api/overview` and
 * `/api/overview-summary` use — and adapts it to the Home metric contract. It
 * calls no HTTP route of its own: a server component fetching its own API is
 * an extra hop, a second authorization surface, and (in this repo's own
 * history) a fan-out that made a page slow enough to look broken.
 *
 * Nothing is recomputed. The KPI values and their per-KPI source provenance are
 * taken exactly as the read model produced them; this file decides only how a
 * value is *described* — available, partial or unavailable, and with what
 * comparison.
 */
import { getOverviewData } from "@/lib/overview-service";
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { getBusinessCurrency } from "@/lib/account-store";
import { resolveEvidenceFreshness } from "@/lib/workspace/workspace-context";
import type { CurrencyProof } from "@/lib/workspace/workspace-context";
import {
  toHomeMetric,
  type HomeContract,
  type HomeSourceState,
} from "@/lib/zero-base/home/metric-contract";
import type { OverviewMetricCardData, OverviewMetricUnit } from "@/src/types/models";

/** KPI → the card the contract expects, keyed to the direction registry. */
const HOME_KPIS: ReadonlyArray<{
  key: string;
  title: string;
  unit: OverviewMetricUnit;
  read: (kpis: Record<string, number>) => number;
}> = [
  { key: "revenue", title: "Revenue", unit: "currency", read: (k) => k.revenue },
  { key: "spend", title: "Spend", unit: "currency", read: (k) => k.spend },
  { key: "blended_roas", title: "Blended ROAS", unit: "ratio", read: (k) => k.roas },
  { key: "cpa", title: "Blended CPA", unit: "currency", read: (k) => k.cpa },
  { key: "orders", title: "Orders", unit: "count", read: (k) => k.purchases },
  { key: "aov", title: "AOV", unit: "currency", read: (k) => k.aov },
];

/** KPI key → the `kpiSources` field that carries its provenance. */
const KPI_SOURCE_FIELD: Record<string, string> = {
  revenue: "revenue",
  spend: "spend",
  blended_roas: "roas",
  cpa: "cpa",
  orders: "purchases",
  aov: "aov",
};

const PROVIDER_LABEL: Record<string, string> = {
  meta: "Meta",
  google: "Google Ads",
  shopify: "Shopify",
  ga4: "GA4",
  search_console: "Search Console",
};

/**
 * A KPI whose source resolved to `unavailable` is not zero — it is unserved,
 * and the read model says so explicitly rather than leaving us to infer it
 * from a suspicious 0.
 */
function isServed(sourceKey: string | undefined): boolean {
  return Boolean(sourceKey) && sourceKey !== "unavailable";
}

export async function readHomeContract(input: {
  businessId: string;
  startDate?: string | null;
  endDate?: string | null;
  now?: Date;
}): Promise<HomeContract> {
  const now = input.now ?? new Date();

  const [overview, integrations, currency] = await Promise.all([
    getOverviewData({
      businessId: input.businessId,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      includeTrends: true,
    }).catch(() => null),
    getIntegrationStatusByBusiness(input.businessId).catch(() => null),
    getBusinessCurrency(input.businessId).catch(() => null),
  ]);

  // A configured currency is a preference. Home has no observed-currency proof
  // to consult yet, so it says configured-only rather than claiming otherwise.
  const currencyProof: CurrencyProof = currency ? "configured-only" : "unknown";

  const sources: HomeSourceState[] = Object.entries(integrations ?? {}).map(
    ([provider, connected]) => ({
      key: provider,
      label: PROVIDER_LABEL[provider] ?? provider,
      state: connected ? "ok" : "unavailable",
      reason: connected ? null : "Not connected for this business.",
      // No per-source timestamp is available from the status read, so
      // freshness stays unknown rather than being asserted as fresh.
      freshness: "unknown",
      lastUpdatedAt: null,
    }),
  );

  if (!overview) {
    // The whole aggregate failed. Every metric is unavailable with a stated
    // reason; none of them becomes 0.
    return {
      metrics: HOME_KPIS.map((kpi) =>
        toHomeMetric({
          metricKey: kpi.key,
          card: undefined,
          mode: "none",
          currency,
          currencyProof,
          unavailableReason: "The overview read is unavailable for this window.",
        }),
      ),
      sources: [
        {
          key: "overview",
          label: "Overview aggregate",
          state: "unavailable",
          reason: "The read failed for this window.",
          freshness: "unknown",
          lastUpdatedAt: null,
        },
        ...sources,
      ],
      window: { startDate: "", endDate: "" },
      comparisonMode: "none",
    };
  }

  const kpis = overview.kpis as unknown as Record<string, number>;
  const trend = overview.trends["30d"] ?? [];

  const metrics = HOME_KPIS.map((kpi) => {
    const sourceField = KPI_SOURCE_FIELD[kpi.key];
    const provenance = (
      overview.kpiSources as unknown as Record<string, { source: string; label: string } | undefined>
    )[sourceField];
    const served = isServed(provenance?.source);
    const raw = kpi.read(kpis);

    const card: OverviewMetricCardData | undefined = served
      ? {
          id: kpi.key,
          title: kpi.title,
          value: Number.isFinite(raw) ? raw : null,
          changePct: null,
          sparklineData: trend
            .map((point) => {
              const row = point as unknown as Record<string, unknown>;
              return {
                date: String(row.date ?? ""),
                value: Number(row[kpi.key] ?? Number.NaN),
              };
            })
            .filter((point) => Boolean(point.date) && Number.isFinite(point.value)),
          trendDirection: "neutral",
          dataSource: {
            key: provenance?.source ?? "unknown",
            label: provenance?.label ?? "Unknown source",
          },
          status: "available",
          unit: kpi.unit,
        }
      : undefined;

    return toHomeMetric({
      metricKey: kpi.key,
      card,
      // Comparison is genuinely absent from this read model, and the contract
      // says so explicitly rather than rendering 0.0%.
      mode: "none",
      currency,
      currencyProof,
      unavailableReason: provenance?.label
        ? `Not served by ${provenance.label} for this window.`
        : "Not served for this window.",
    });
  });

  const shopifyUpdatedAt =
    (overview.shopifyServing as { lastUpdatedAt?: string | null } | null | undefined)
      ?.lastUpdatedAt ?? null;

  return {
    metrics,
    sources: [
      {
        key: "overview",
        label: "Overview aggregate",
        state: metrics.every((metric) => metric.availability === "available") ? "ok" : "partial",
        reason: metrics.some((metric) => metric.availability !== "available")
          ? "Some metrics are not served for this window."
          : null,
        freshness: resolveEvidenceFreshness({ snapshotAt: shopifyUpdatedAt, now }),
        lastUpdatedAt: shopifyUpdatedAt,
      },
      ...sources,
    ],
    window: overview.dateRange,
    comparisonMode: "none",
  };
}
