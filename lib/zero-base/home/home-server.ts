/**
 * Server read for Client Home.
 *
 * Reuses `getOverviewData` — the same aggregate read model `/api/overview` and
 * `/api/overview-summary` use — and adapts it to the Home metric contract. It
 * calls no HTTP route of its own: a server component fetching its own API is
 * an extra hop, a second authorization surface, and (in this repo's own
 * history) a fan-out that made a page slow enough to look broken.
 *
 * Primitive values and source provenance come from the read model. Home
 * re-derives Blended ROAS and MER only from those verified primitives so a
 * store-revenue ratio cannot be relabeled as platform ROAS (or vice versa).
 * It also decides whether a value is available, partial or unavailable and
 * whether its daily series covers the same source scope as its scalar.
 */
import { getOverviewData, type OverviewResponse } from "@/lib/overview-service";
import {
  getIntegrationStatusByBusiness,
  type IntegrationStatusResponse,
} from "@/lib/integration-status";
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
import {
  buildBlendedProviderRoasSeries,
  buildPaidProviderSpendSeries,
  providerScalarSourcesComparable,
  providerTrendMatchesScalar,
  type OverviewProvider,
} from "@/lib/overview-provider-metrics";

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
    title: "Blended ROAS vs target",
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

const PAID_PROVIDERS = ["meta", "google"] as const;

interface PaidProviderSnapshot {
  providers: OverviewProvider[];
  spend: number;
  conversionValue: number;
}

interface PaidProviderResolution {
  snapshot: PaidProviderSnapshot | null;
  reason: string | null;
}

function normalizedPaidProvider(value: string): OverviewProvider | null {
  const normalized = value.trim().toLowerCase();
  if (normalized === "meta") return "meta";
  if (normalized === "google" || normalized === "google_ads") return "google";
  return null;
}

function providerConnectionState(
  integrations: IntegrationStatusResponse | null,
  provider: OverviewProvider,
): "connected" | "disconnected" | "unknown" {
  if (!integrations || typeof integrations[provider] !== "boolean") return "unknown";
  return integrations[provider] ? "connected" : "disconnected";
}

function isoDay(value: string | null | undefined): number | null {
  if (!value || !/^\d{4}-\d{2}-\d{2}$/.test(value)) return null;
  const parsed = Date.parse(`${value}T00:00:00.000Z`);
  if (!Number.isFinite(parsed) || new Date(parsed).toISOString().slice(0, 10) !== value) return null;
  return parsed;
}

/** A provider scalar may be used only when its measured window covers Home's requested window. */
function providerRangeCoversOverviewWindow(
  providerRange: { startDate: string; endDate: string } | null | undefined,
  overviewRange: OverviewResponse["dateRange"],
) {
  const providerStart = isoDay(providerRange?.startDate);
  const providerEnd = isoDay(providerRange?.endDate);
  const requestedStart = isoDay(overviewRange.startDate);
  const requestedEnd = isoDay(overviewRange.endDate);
  return (
    providerStart !== null &&
    providerEnd !== null &&
    requestedStart !== null &&
    requestedEnd !== null &&
    providerStart <= requestedStart &&
    providerEnd >= requestedEnd
  );
}

/**
 * Resolve the exact provider rows Home is allowed to blend.
 *
 * A row without a known scalar source, or a claimed scalar source without a
 * row, makes the paid scope unverified. Silently dropping either case would
 * turn a partial provider set into a believable blended result.
 */
function resolvePaidProviderSnapshot(
  overview: OverviewResponse,
  integrations: IntegrationStatusResponse | null,
): PaidProviderResolution {
  const rowsByProvider = new Map<OverviewProvider, OverviewResponse["platformEfficiency"]>();
  for (const provider of PAID_PROVIDERS) rowsByProvider.set(provider, []);

  for (const row of overview.platformEfficiency) {
    const provider = normalizedPaidProvider(String(row.platform));
    if (!provider) continue;
    rowsByProvider.get(provider)?.push(row);
  }

  const providers: OverviewProvider[] = [];
  let spend = 0;
  let conversionValue = 0;
  for (const provider of PAID_PROVIDERS) {
    const rows = rowsByProvider.get(provider) ?? [];
    const scalarSource = overview.providerSources?.[provider];
    const scalarRange = overview.providerScalarRanges?.[provider];
    const sourceVerified = providerScalarSourcesComparable(
      provider,
      scalarSource,
      scalarSource,
    );
    const hasAnyReadEvidence = rows.length > 0 || scalarSource != null || scalarRange != null;

    if (!hasAnyReadEvidence) {
      // A successful integration-status read is the only authority that lets
      // Home treat an absent provider as legitimately out of scope. A
      // connected provider, or a failed status read, leaves the denominator
      // unknown and therefore fails every paid-scope metric closed.
      if (providerConnectionState(integrations, provider) === "disconnected") continue;
      return {
        snapshot: null,
        reason: "Paid-provider scope is missing a connected or unverified provider.",
      };
    }

    // Once any read evidence exists, both a supported source and at least one
    // provider row are mandatory. A stray range or unsupported source is a
    // mismatch, not a measured zero.
    if (!sourceVerified || rows.length === 0) {
      return {
        snapshot: null,
        reason: "Paid-provider scope contains an unverified or incomplete source.",
      };
    }
    if (!providerRangeCoversOverviewWindow(scalarRange, overview.dateRange)) {
      return {
        snapshot: null,
        reason: "Paid-provider scalar coverage does not cover the requested window.",
      };
    }
    if (
      rows.some(
        (row) =>
          typeof row.spend !== "number" ||
          !Number.isFinite(row.spend) ||
          typeof row.revenue !== "number" ||
          !Number.isFinite(row.revenue),
      )
    ) {
      return {
        snapshot: null,
        reason: "Paid-provider spend or attributed conversion value is invalid for this window.",
      };
    }

    providers.push(provider);
    spend += rows.reduce((sum, row) => sum + Number(row.spend), 0);
    conversionValue += rows.reduce((sum, row) => sum + Number(row.revenue), 0);
  }

  if (providers.length === 0) {
    return {
      snapshot: null,
      reason: "No verified paid-provider data is available for this window.",
    };
  }

  return { snapshot: { providers, spend, conversionValue }, reason: null };
}

function paidProviderLabel(providers: readonly OverviewProvider[]) {
  return providers.map((provider) => (provider === "meta" ? "Meta Ads" : "Google Ads")).join(" + ");
}

function sourceSafeProviderTrends(
  overview: OverviewResponse,
  snapshot: PaidProviderSnapshot | null,
) {
  if (!snapshot) return null;
  const trends: Partial<
    Record<OverviewProvider, NonNullable<OverviewResponse["providerTrends"]>[OverviewProvider]>
  > = {};
  for (const provider of snapshot.providers) {
    const providerPoints = overview.providerTrends?.[provider];
    if (
      providerPoints === undefined ||
      !providerTrendMatchesScalar(
        provider,
        overview.providerSources?.[provider],
        overview.providerTrendSources?.[provider],
      )
    ) {
      return null;
    }
    trends[provider] = providerPoints;
  }
  return trends;
}

type CommerceResolution = {
  source: string;
  formulaLabel: string;
  revenue: number;
};

/** Shopify is primary. GA4 is commerce truth only as an explicit disconnect fallback. */
function resolveCommerceRevenue(overview: OverviewResponse): CommerceResolution | null {
  const provenance = overview.kpiSources.revenue;
  const source = provenance?.source;
  const shopifySource =
    source === "shopify_ledger" ||
    source === "shopify_warehouse" ||
    source === "shopify_live_fallback";
  const revenue = Number(overview.kpis.revenue);
  if (!Number.isFinite(revenue)) return null;

  if (overview.shopifyConnectionState === "connected" && shopifySource) {
    return {
      source,
      formulaLabel: "Shopify revenue",
      revenue,
    };
  }
  if (overview.shopifyConnectionState === "disconnected" && source === "ga4_fallback") {
    return {
      source,
      formulaLabel: "GA4 ecommerce revenue fallback",
      revenue,
    };
  }
  return null;
}

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

  // `custom` is the exact requested Overview window. Fixed 30-day slices
  // silently truncate commerce sparklines for longer custom windows.
  const trend = overview.trends.custom ?? [];
  const paidProviderResolution = resolvePaidProviderSnapshot(overview, integrations);
  const paidProviderSnapshot = paidProviderResolution.snapshot;
  const compatibleProviderTrends = sourceSafeProviderTrends(overview, paidProviderSnapshot);
  const paidSpendSeries = compatibleProviderTrends
    ? buildPaidProviderSpendSeries(compatibleProviderTrends)
    : [];
  const blendedRoasSeries = compatibleProviderTrends
    ? buildBlendedProviderRoasSeries(compatibleProviderTrends)
    : [];
  const commerce = resolveCommerceRevenue(overview);
  const paidScopeLabel = paidProviderSnapshot
    ? paidProviderLabel(paidProviderSnapshot.providers)
    : "paid providers";
  const blendedFormulaLabel = `${paidScopeLabel} attributed conversion value / verified ${paidScopeLabel} spend`;
  const merFormulaLabel = commerce
    ? `${commerce.formulaLabel} / verified ${paidScopeLabel} spend`
    : "Verified commerce revenue / verified paid-provider spend";
  const commerceRevenueByDate = new Map(
    trend.flatMap((point) => {
      const date = String(point.date ?? "");
      const revenue = Number(point.revenue);
      return date && Number.isFinite(revenue) ? [[date, revenue] as const] : [];
    }),
  );
  const merSeries = commerce
    ? paidSpendSeries.flatMap((point) => {
        const revenue = commerceRevenueByDate.get(point.date);
        return revenue !== undefined && point.value > 0
          ? [{ date: point.date, value: revenue / point.value }]
          : [];
      })
    : [];

  const metrics = HOME_KPIS.map((kpi) => {
    const sourceField = kpi.sourceField ?? KPI_SOURCE_FIELD[kpi.key];
    let provenance = kpi.source ?? (
      overview.kpiSources as unknown as Record<string, { source: string; label: string } | undefined>
    )[sourceField];
    let served =
      isServed(provenance?.source) &&
      (!kpi.sourceMustBeShopify || Boolean(provenance?.source.startsWith("shopify_")));
    let raw = kpi.read(overview);
    let unavailableReason = provenance?.label
      ? `Not served by ${provenance.label} for this window.`
      : "Not served for this window.";

    if (kpi.key === "spend") {
      provenance = {
        source: paidProviderSnapshot ? "ad_platforms" : "unavailable",
        label: paidProviderSnapshot ? `Verified ${paidScopeLabel} spend` : "Verified paid-provider spend",
      };
      // Zero is a valid measured spend. Only scope/source/range failures make
      // the scalar unavailable.
      served = Boolean(paidProviderSnapshot);
      raw = paidProviderSnapshot?.spend ?? Number.NaN;
      unavailableReason = paidProviderResolution.reason ?? "Verified paid-provider spend is unavailable for this window.";
    } else if (kpi.key === "blended_roas") {
      provenance = {
        source: paidProviderSnapshot ? "ad_platforms" : "unavailable",
        label: blendedFormulaLabel,
      };
      served = Boolean(paidProviderSnapshot && paidProviderSnapshot.spend > 0);
      raw = served && paidProviderSnapshot
        ? paidProviderSnapshot.conversionValue / paidProviderSnapshot.spend
        : Number.NaN;
      unavailableReason = paidProviderResolution.reason ?? "Verified paid-provider spend is zero for this window.";
    } else if (kpi.key === "mer") {
      provenance = {
        source: commerce?.source ?? "unavailable",
        label: merFormulaLabel,
      };
      served = Boolean(commerce && paidProviderSnapshot && paidProviderSnapshot.spend > 0);
      raw = served && commerce && paidProviderSnapshot
        ? commerce.revenue / paidProviderSnapshot.spend
        : Number.NaN;
      unavailableReason = !commerce
        ? "Shopify revenue or the explicit GA4 fallback is unavailable for this window."
        : (paidProviderResolution.reason ?? "Verified paid-provider spend is zero for this window.");
    }

    const specialFormulaMetric = kpi.key === "spend" || kpi.key === "blended_roas" || kpi.key === "mer";
    const valueAvailable = served && Number.isFinite(raw);

    const card: OverviewMetricCardData | undefined = valueAvailable || specialFormulaMetric
      ? {
          id: kpi.key,
          title: kpi.title,
          value: valueAvailable ? raw : null,
          changePct: null,
          sparklineData:
            kpi.key === "blended_roas"
              ? blendedRoasSeries
              : kpi.key === "mer"
                ? merSeries
                : kpi.key === "spend"
                  ? paidSpendSeries
              : trend
                  .map((point) => {
                    const row = point as unknown as Record<string, unknown>;
                    return {
                      date: String(row.date ?? ""),
                      value:
                        kpi.key === "revenue"
                            ? Number(row.revenue ?? Number.NaN)
                            : kpi.key === "orders"
                              ? Number(row.purchases ?? Number.NaN)
                              : Number.NaN,
                    };
                  })
                  .filter((point) => Boolean(point.date) && Number.isFinite(point.value)),
          trendDirection: "neutral",
          dataSource: {
            key: provenance?.source ?? "unknown",
            label: provenance?.label ?? "Unknown source",
          },
          status: valueAvailable ? "available" : "unavailable",
          helperText: valueAvailable ? undefined : unavailableReason,
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
      unavailableReason,
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

  const blendedRoasByDate = new Map(blendedRoasSeries.map((point) => [point.date, point.value]));
  const trendPoints: HomeTrendPoint[] = paidSpendSeries.map((point) => ({
    date: point.date,
    // Zero is a measured value when every active provider reported the day.
    spend: point.value,
    roas: blendedRoasByDate.get(point.date) ?? null,
  }));

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
