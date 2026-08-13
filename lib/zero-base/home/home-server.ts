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
import { getOverviewData, type OverviewResponse } from "@/lib/overview-service";
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { getBusinessCurrency } from "@/lib/account-store";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import { resolveEvidenceFreshness } from "@/lib/workspace/workspace-context";
import type { CurrencyProof } from "@/lib/workspace/workspace-context";
import {
  toHomeMetric,
  type HomeContract,
  type HomeSourceState,
} from "@/lib/zero-base/home/metric-contract";
import type { OverviewMetricCardData, OverviewMetricUnit } from "@/src/types/models";
import type { EconomicsContextModel } from "@/lib/zero-base/home/economics-context";
import type { TrendPoint as HomeTrendPoint } from "@/components/zero-base/home/trend-panel";

/** KPI → the card the contract expects, keyed to the direction registry. */
const HOME_KPIS: ReadonlyArray<{
  key: string;
  title: string;
  unit: OverviewMetricUnit;
  read: (overview: OverviewResponse) => number;
  sourceField?: keyof OverviewResponse["kpis"];
  source?: { source: string; label: string };
  sourceMustBeShopify?: boolean;
}> = [
  {
    key: "revenue",
    title: "Total sales",
    unit: "currency",
    read: (o) => o.kpis.revenue,
    sourceField: "revenue",
    sourceMustBeShopify: true,
  },
  { key: "spend", title: "Spend", unit: "currency", read: (o) => o.kpis.spend, sourceField: "spend" },
  { key: "orders", title: "Purchases", unit: "count", read: (o) => o.kpis.purchases, sourceField: "purchases" },
  {
    key: "blended_roas",
    title: "ROAS vs target",
    unit: "ratio",
    read: (o) => o.totals.roas,
    source: { source: "ad_platforms", label: "Connected ad platforms" },
  },
  { key: "mer", title: "MER", unit: "ratio", read: (o) => o.kpis.roas, sourceField: "roas" },
];

/** KPI key → the `kpiSources` field that carries its provenance. */
const KPI_SOURCE_FIELD: Record<string, string> = {
  spend: "spend",
  revenue: "revenue",
  blended_roas: "roas",
  orders: "purchases",
  mer: "roas",
};

const HOME_PROVIDER_KEYS = new Set(["meta", "google", "shopify", "ga4"]);

export interface HomePageModel {
  contract: HomeContract;
  trend: { points: readonly HomeTrendPoint[]; currency: string | null } | null;
  economics: EconomicsContextModel | null;
}

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

export async function readHomePageModel(input: {
  businessId: string;
  startDate?: string | null;
  endDate?: string | null;
  now?: Date;
}): Promise<HomePageModel> {
  const now = input.now ?? new Date();

  const [overview, integrations, currency, commercial] = await Promise.all([
    getOverviewData({
      businessId: input.businessId,
      startDate: input.startDate ?? null,
      endDate: input.endDate ?? null,
      includeTrends: true,
    }).catch(() => null),
    getIntegrationStatusByBusiness(input.businessId).catch(() => null),
    getBusinessCurrency(input.businessId).catch(() => null),
    getBusinessCommercialTruthSnapshot(input.businessId).catch(() => null),
  ]);

  // A configured currency is a preference. Home has no observed-currency proof
  // to consult yet, so it says configured-only rather than claiming otherwise.
  const currencyProof: CurrencyProof = currency ? "configured-only" : "unknown";

  const sources: HomeSourceState[] = Object.entries(integrations ?? {})
    .filter(([provider]) => HOME_PROVIDER_KEYS.has(provider))
    .map(
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

  const economics: EconomicsContextModel | null = commercial
    ? {
        breakEvenRoas: commercial.targetPack?.breakEvenRoas ?? null,
        targetRoas: commercial.targetPack?.targetRoas ?? null,
        sources: [
          {
            key: "target-pack",
            label: "Commercial Truth target pack",
            consumers: ["Meta decisions"],
          },
          {
            key: "cost-model",
            label: "Overview cost model",
            consumers: ["Overview", "Google Ads"],
          },
        ],
        diverges: false,
      }
    : null;

  if (!overview) {
    // The whole aggregate failed. Every metric is unavailable with a stated
    // reason; none of them becomes 0.
    return {
      contract: {
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
      },
      trend: null,
      economics,
    };
  }

  const kpis = overview.kpis as unknown as Record<string, number>;
  const trend = overview.trends["30d"] ?? [];

  const metrics = HOME_KPIS.map((kpi) => {
    const sourceField = kpi.sourceField ?? KPI_SOURCE_FIELD[kpi.key];
    const provenance = kpi.source ?? (
      overview.kpiSources as unknown as Record<string, { source: string; label: string } | undefined>
    )[sourceField];
    const served =
      isServed(provenance?.source) &&
      (!kpi.sourceMustBeShopify || Boolean(provenance?.source.startsWith("shopify_")));
    const raw = kpi.read(overview);

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
                value:
                  kpi.key === "spend"
                    ? Number(row.spend ?? Number.NaN)
                    : kpi.key === "revenue"
                      ? Number(row.revenue ?? Number.NaN)
                    : kpi.key === "orders"
                      ? Number(row.purchases ?? Number.NaN)
                      : Number(row.spend) > 0
                        ? Number(row.revenue) / Number(row.spend)
                        : Number.NaN,
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

  const contract: HomeContract = {
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

  const trendPoints: HomeTrendPoint[] = trend.map((point) => {
    const row = point as unknown as { date?: string; label?: string; spend?: number; revenue?: number };
    const spend = Number(row.spend);
    const revenue = Number(row.revenue);
    return {
      date: String(row.date ?? row.label ?? ""),
      spend: Number.isFinite(spend) ? spend : null,
      roas: Number.isFinite(spend) && spend > 0 && Number.isFinite(revenue) ? revenue / spend : null,
    };
  }).filter((point) => Boolean(point.date));

  return {
    contract,
    trend: trendPoints.length > 0 ? { points: trendPoints, currency } : null,
    economics,
  };
}

/** Compatibility read for callers that only need the metric contract. */
export async function readHomeContract(input: Parameters<typeof readHomePageModel>[0]): Promise<HomeContract> {
  return (await readHomePageModel(input)).contract;
}
