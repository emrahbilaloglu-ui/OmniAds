import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getBusinessCostModel } from "@/lib/business-cost-model";
import { getBusinessCommercialTruthSnapshot } from "@/lib/business-commercial";
import { getBusinessTimezone } from "@/lib/account-store";
import { getIntegrationStatusByBusiness } from "@/lib/integration-status";
import { GA4AuthError, getAnalyticsOverviewData } from "@/lib/analytics-overview";
import {
  getOverviewData,
  getShopifyOverviewServingData,
  type OverviewResponse as OverviewAggregateData,
} from "@/lib/overview-service";
import { runWithGoogleRequestAuditContext } from "@/lib/google-request-audit";
import {
  buildBlendedProviderRoasSeries,
  buildPaidProviderSpendSeries,
  providerScalarSourceSetsComparable,
  providerTrendMatchesScalar,
  type OverviewProvider,
} from "@/lib/overview-provider-metrics";
import {
  aggregateOverviewProviderRow,
  aggregateVerifiedOverviewProviderRow,
  buildAttributionRows,
  buildMetricCard,
  buildPlatformSections,
  buildUnavailableMetric,
  type CompareMode,
  getGa4DailyTrendSnapshot,
  getGa4LtvSnapshot,
  getPreviousWindow,
  mapInsights,
  parseIsoDate,
  roundSparklineValue,
  toCostModelData,
  toIsoDate,
  toPercentSparklineSeries,
  toRatioSparklineSeries,
  toSparklineSeries,
} from "@/lib/overview-summary-support";
import { logPerfEvent } from "@/lib/perf";
import { resolveRequestLanguage } from "@/lib/request-language";
import type {
  OverviewMetricCardData,
  OverviewPaidProviderScope,
  OverviewSummaryData,
} from "@/src/types/models";

function getTodayIsoForTimeZone(timeZone?: string | null): string {
  if (!timeZone) return new Date().toISOString().slice(0, 10);
  const parts = new Intl.DateTimeFormat("en-CA", {
    timeZone,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(new Date());
  const year = parts.find((part) => part.type === "year")?.value ?? "1970";
  const month = parts.find((part) => part.type === "month")?.value ?? "01";
  const day = parts.find((part) => part.type === "day")?.value ?? "01";
  return `${year}-${month}-${day}`;
}

function shiftIsoDate(date: string, dayDelta: number): string {
  const value = new Date(`${date}T00:00:00.000Z`);
  value.setUTCDate(value.getUTCDate() + dayDelta);
  return value.toISOString().slice(0, 10);
}

type PaidProviderConnectionState = "connected" | "disconnected" | "unknown";

type PaidProviderConnectionStates = Record<OverviewProvider, PaidProviderConnectionState>;

interface ResolvedPaidProviderScope extends OverviewPaidProviderScope {
  rows: Array<{
    provider: OverviewProvider;
    aggregate: NonNullable<ReturnType<typeof aggregateVerifiedOverviewProviderRow>>;
  }>;
}

function providerRangeMatchesRequestedWindow(
  overview: OverviewAggregateData,
  provider: OverviewProvider,
  requested: { startDate: string; endDate: string },
) {
  const range = overview.providerScalarRanges?.[provider];
  return range?.startDate === requested.startDate && range.endDate === requested.endDate;
}

/**
 * Resolve one complete denominator scope for every paid aggregate. Historical
 * rows remain valid after disconnect. An absent provider is ignorable only
 * when the integrations read explicitly confirms it is disconnected.
 */
function resolvePaidProviderScope(
  overview: OverviewAggregateData | null,
  connectionStates: PaidProviderConnectionStates,
  requested: { startDate: string; endDate: string } | null,
): ResolvedPaidProviderScope {
  if (!overview || !requested) return { providers: [], complete: false, rows: [] };

  const rows: ResolvedPaidProviderScope["rows"] = [];
  let complete = true;
  for (const provider of ["meta", "google"] as const) {
    const source = overview.providerSources?.[provider] ?? null;
    const rawRow = aggregateOverviewProviderRow(overview, provider);
    const range = overview.providerScalarRanges?.[provider] ?? null;
    const hasAnyReadEvidence = source !== null || rawRow !== null || range !== null;

    if (!hasAnyReadEvidence) {
      if (connectionStates[provider] !== "disconnected") complete = false;
      continue;
    }

    const aggregate = aggregateVerifiedOverviewProviderRow(overview, provider);
    if (!source || !rawRow || !aggregate || !providerRangeMatchesRequestedWindow(overview, provider, requested)) {
      complete = false;
      continue;
    }
    rows.push({ provider, aggregate });
  }

  return { providers: rows.map((row) => row.provider), complete, rows };
}

function providerSourcesForScope(
  overview: OverviewAggregateData | null,
  scope: ResolvedPaidProviderScope,
) {
  const included = new Set(scope.providers);
  return {
    meta: included.has("meta") ? (overview?.providerSources?.meta ?? null) : null,
    google: included.has("google") ? (overview?.providerSources?.google ?? null) : null,
  };
}

interface PaidPlatformSnapshot {
  providers: OverviewProvider[];
  spend: number;
  conversionValue: number;
  roas: number | null;
}

/** Platform-owned numerator and denominator for the Overview Blended ROAS. */
function paidPlatformSnapshot(scope: ResolvedPaidProviderScope): PaidPlatformSnapshot | null {
  if (!scope.complete || scope.rows.length === 0) return null;
  const spend = scope.rows.reduce((sum, row) => sum + row.aggregate.spend, 0);
  const conversionValue = scope.rows.reduce((sum, row) => sum + row.aggregate.revenue, 0);
  return {
    providers: scope.providers,
    spend,
    conversionValue,
    roas: spend > 0 ? conversionValue / spend : null,
  };
}

function samePaidProviderSet(current: PaidPlatformSnapshot | null, previous: PaidPlatformSnapshot | null) {
  if (!current || !previous || current.providers.length !== previous.providers.length) return false;
  return current.providers.every((provider, index) => provider === previous.providers[index]);
}

function sourceSafeProviderTrends(
  overview: OverviewAggregateData,
  snapshot: PaidPlatformSnapshot | null,
) {
  if (!snapshot) return null;
  const compatibleTrends: Partial<
    Record<OverviewProvider, NonNullable<OverviewAggregateData["providerTrends"]>[OverviewProvider]>
  > = {};
  for (const provider of snapshot.providers) {
    if (
      !providerTrendMatchesScalar(
        provider,
        overview.providerSources?.[provider],
        overview.providerTrendSources?.[provider],
      )
    ) {
      return null;
    }
    compatibleTrends[provider] = overview.providerTrends?.[provider];
  }
  return compatibleTrends;
}

function sourceSafeBlendedRoasSeries(
  overview: OverviewAggregateData,
  snapshot: PaidPlatformSnapshot | null,
) {
  const compatibleTrends = sourceSafeProviderTrends(overview, snapshot);
  return compatibleTrends ? buildBlendedProviderRoasSeries(compatibleTrends) : [];
}

function resolveShopifyMetricSource(
  source: "ledger" | "warehouse" | "live" | "none" | undefined,
  tr: (english: string, turkish: string) => string
) {
  if (source === "ledger") {
    return {
      key: "shopify_ledger",
      label: tr("Shopify Ledger", "Shopify Ledger"),
    };
  }
  if (source === "warehouse") {
    return {
      key: "shopify_warehouse",
      label: tr("Shopify Warehouse", "Shopify Warehouse"),
    };
  }
  if (source === "live") {
    return {
      key: "shopify_live_fallback",
      label: tr("Shopify Live Fallback", "Shopify Live Fallback"),
    };
  }
  return {
    key: "unavailable",
    label: tr("Unavailable", "Kullanılamıyor"),
  };
}

export async function GET(request: NextRequest) {
  const requestStartedAt = Date.now();
  const language = await resolveRequestLanguage(request);
  const businessId = request.nextUrl.searchParams.get("businessId");
  const startDate = request.nextUrl.searchParams.get("startDate");
  const endDate = request.nextUrl.searchParams.get("endDate");
  const compareMode = (request.nextUrl.searchParams.get("compareMode") as CompareMode | null) ?? "previous_period";

  if (!businessId) {
    return NextResponse.json(
      {
        error: "missing_business_id",
        message: "businessId query parameter is required.",
      },
      { status: 400 }
    );
  }

  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;

  const businessTimeZone = await getBusinessTimezone(businessId);
  const fallbackEndDate = getTodayIsoForTimeZone(businessTimeZone);
  const fallbackStartDate = shiftIsoDate(fallbackEndDate, -29);
  const resolvedStart = startDate
    ? toIsoDate(parseIsoDate(startDate, new Date(`${fallbackStartDate}T00:00:00.000Z`)))
    : fallbackStartDate;
  const resolvedEnd = endDate
    ? toIsoDate(parseIsoDate(endDate, new Date(`${fallbackEndDate}T00:00:00.000Z`)))
    : fallbackEndDate;
  const previousWindow =
    compareMode === "previous_period"
      ? getPreviousWindow(resolvedStart, resolvedEnd)
      : { startDate: null, endDate: null };
  const dateSpanDays = Math.max(
    1,
    Math.floor(
      (new Date(`${resolvedEnd}T00:00:00.000Z`).getTime() - new Date(`${resolvedStart}T00:00:00.000Z`).getTime()) /
        86_400_000
    ) + 1
  );

  const analyticsAccess = await requireBusinessAccess({
    request,
    businessId,
    minRole: "collaborator",
  });
  const canReadAnalytics = !("error" in analyticsAccess);

  const [
    currentOverviewResult,
    previousOverviewResult,
    currentAnalyticsResult,
    previousAnalyticsResult,
    currentShopifyResult,
    previousShopifyResult,
    costModelResult,
    commercialTruthResult,
    integrationStatusResult,
  ] = await Promise.allSettled([
    getOverviewData({
      businessId,
      startDate: resolvedStart,
      endDate: resolvedEnd,
      includeTrends: false,
    }),
    compareMode === "previous_period" && previousWindow.startDate && previousWindow.endDate
      ? getOverviewData({
          businessId,
          startDate: previousWindow.startDate,
          endDate: previousWindow.endDate,
          includeTrends: false,
        })
      : Promise.resolve(null),
    canReadAnalytics
      ? runWithGoogleRequestAuditContext(
          {
            provider: "ga4",
            businessId,
            requestSource: "live_report",
            requestPath: "/api/overview-summary",
            requestType: "ga4_overview_summary_current",
          },
          () =>
            getAnalyticsOverviewData({
              businessId,
              startDate: resolvedStart,
              endDate: resolvedEnd,
            })
        )
      : Promise.resolve(null),
    canReadAnalytics && previousWindow.startDate && previousWindow.endDate
      ? runWithGoogleRequestAuditContext(
          {
            provider: "ga4",
            businessId,
            requestSource: "live_report",
            requestPath: "/api/overview-summary",
            requestType: "ga4_overview_summary_previous",
          },
          () =>
            getAnalyticsOverviewData({
              businessId,
              startDate: previousWindow.startDate,
              endDate: previousWindow.endDate,
            })
        )
      : Promise.resolve(null),
    getShopifyOverviewServingData({
      businessId,
      startDate: resolvedStart,
      endDate: resolvedEnd,
      timeZone: businessTimeZone,
    }),
    compareMode === "previous_period" && previousWindow.startDate && previousWindow.endDate
      ? getShopifyOverviewServingData({
          businessId,
          startDate: previousWindow.startDate,
          endDate: previousWindow.endDate,
          timeZone: businessTimeZone,
        })
      : Promise.resolve(null),
    getBusinessCostModel(businessId),
    getBusinessCommercialTruthSnapshot(businessId),
    getIntegrationStatusByBusiness(businessId),
  ]);

  if (currentOverviewResult.status === "rejected") {
    return NextResponse.json(
      {
        error: "overview_summary_upstream_failed",
        message: "Unable to load overview summary.",
        details:
          currentOverviewResult.reason instanceof Error
            ? currentOverviewResult.reason.message
            : String(currentOverviewResult.reason),
      },
      { status: 500 }
    );
  }

  const currentOverview = currentOverviewResult.value;
  const previousOverview = previousOverviewResult.status === "fulfilled" ? previousOverviewResult.value : null;
  const paidProviderConnectionStates: PaidProviderConnectionStates =
    integrationStatusResult.status === "fulfilled"
      ? {
          meta: integrationStatusResult.value.meta ? "connected" : "disconnected",
          google: integrationStatusResult.value.google ? "connected" : "disconnected",
        }
      : { meta: "unknown", google: "unknown" };
  const currentPaidProviderScope = resolvePaidProviderScope(
    currentOverview,
    paidProviderConnectionStates,
    { startDate: resolvedStart, endDate: resolvedEnd },
  );
  const previousPaidProviderScope =
    compareMode === "previous_period" && previousOverview && previousWindow.startDate && previousWindow.endDate
      ? resolvePaidProviderScope(previousOverview, paidProviderConnectionStates, {
          startDate: previousWindow.startDate,
          endDate: previousWindow.endDate,
        })
      : null;
  const currentProviderSources = providerSourcesForScope(currentOverview, currentPaidProviderScope);
  const comparablePreviousProviderSources = previousPaidProviderScope
    ? providerSourcesForScope(previousOverview, previousPaidProviderScope)
    : null;
  const currentOverviewForProviderScope = {
    ...currentOverview,
    providerSources: currentProviderSources,
  };
  const previousOverviewForProviderComparison =
    previousOverview && comparablePreviousProviderSources
      ? { ...previousOverview, providerSources: comparablePreviousProviderSources }
      : previousOverview;
  const currentBlendedRoas = paidPlatformSnapshot(currentPaidProviderScope);
  const previousBlendedRoas = previousPaidProviderScope
    ? paidPlatformSnapshot(previousPaidProviderScope)
    : null;
  const currentMerSpend = currentBlendedRoas?.spend ?? null;
  const previousMerSpend = previousBlendedRoas?.spend ?? null;
  const blendedProviderSourceLabel = currentBlendedRoas
    ? currentBlendedRoas.providers
        .map((provider) => (provider === "meta" ? "Meta Ads" : "Google Ads"))
        .join(" + ")
    : null;
  const paidSpendComparisonComparable =
    compareMode === "previous_period" &&
    samePaidProviderSet(currentBlendedRoas, previousBlendedRoas) &&
    providerScalarSourceSetsComparable(
      currentProviderSources,
      previousOverviewForProviderComparison?.providerSources,
    );
  const blendedRoasComparable = paidSpendComparisonComparable;
  const currentAnalytics =
    currentAnalyticsResult.status === "fulfilled"
      ? currentAnalyticsResult.value
      : currentAnalyticsResult.reason instanceof GA4AuthError
        ? null
        : null;
  const previousAnalytics =
    previousAnalyticsResult.status === "fulfilled"
      ? previousAnalyticsResult.value
      : previousAnalyticsResult.reason instanceof GA4AuthError
        ? null
        : null;
  const shopifyConnectionState = currentOverview.shopifyConnectionState ?? "unknown";
  const currentShopify =
    shopifyConnectionState === "connected" && currentShopifyResult.status === "fulfilled"
      ? (currentShopifyResult.value?.aggregate ?? null)
      : null;
  const previousShopify =
    shopifyConnectionState === "connected" && previousShopifyResult.status === "fulfilled"
      ? (previousShopifyResult.value?.aggregate ?? null)
      : null;
  const costModel = costModelResult.status === "fulfilled" ? costModelResult.value : null;
  const targetRoas =
    commercialTruthResult.status === "fulfilled" ? (commercialTruthResult.value.targetPack?.targetRoas ?? null) : null;
  const analyticsConnected = Boolean(currentAnalytics?.kpis);
  const tr = (english: string, turkish: string) => (language === "tr" ? turkish : english);

  // GA4 daily trends are deferred to the /api/overview-sparklines endpoint.
  // The summary endpoint only needs aggregate KPI values (handled above).
  const ga4DailyTrends: Awaited<ReturnType<typeof getGa4DailyTrendSnapshot>> = [];

  const rawRevenueSource = currentOverview.kpiSources?.revenue;
  const rawPurchasesSource = currentOverview.kpiSources?.purchases;
  const isShopifySource = (source: { source?: string | null } | null | undefined) =>
    source?.source === "shopify_ledger" ||
    source?.source === "shopify_warehouse" ||
    source?.source === "shopify_live_fallback";
  const rawAovSource = currentOverview.kpiSources?.aov;
  const shopifyPrimary = shopifyConnectionState === "connected";
  const ga4CommerceFallbackAllowed = shopifyConnectionState === "disconnected";
  const normalizeCommerceSource = (
    source: { source?: string | null; label?: string | null } | null | undefined,
  ) => {
    if (shopifyPrimary) {
      return isShopifySource(source)
        ? source
        : { source: "shopify_unavailable", label: "Shopify" };
    }
    if (ga4CommerceFallbackAllowed && source?.source === "ga4_fallback") return source;
    return { source: "unavailable", label: tr("Unavailable", "Kullanılamıyor") };
  };
  // A reconnect can happen between the parallel integration and aggregate
  // reads. Once Shopify is observed as connected, discard any concurrent GA4
  // result rather than presenting it as current commerce truth.
  const revenueSource = normalizeCommerceSource(rawRevenueSource);
  const purchasesSource = normalizeCommerceSource(rawPurchasesSource);
  const aovSource = normalizeCommerceSource(rawAovSource);
  const sourceHasVerifiedValue = (source: { source?: string | null } | null | undefined) =>
    isShopifySource(source) || source?.source === "ga4_fallback";
  const commerceSourceFamily = (source: { source?: string | null } | null | undefined) => {
    if (isShopifySource(source)) return "shopify";
    if (source?.source === "ga4_fallback") return "ga4";
    return null;
  };
  const sameCommerceSourceFamily = (
    current: { source?: string | null } | null | undefined,
    previous: { source?: string | null } | null | undefined,
  ) => {
    const currentFamily = commerceSourceFamily(current);
    return currentFamily !== null && currentFamily === commerceSourceFamily(previous);
  };
  const verifiedRevenueCurrent = sourceHasVerifiedValue(revenueSource) ? currentOverview.kpis.revenue : null;
  const verifiedRevenuePrevious =
    previousOverview && sameCommerceSourceFamily(revenueSource, previousOverview.kpiSources?.revenue)
      ? previousOverview.kpis.revenue
      : null;
  const verifiedRevenuePreviousForMer = paidSpendComparisonComparable
    ? verifiedRevenuePrevious
    : null;
  const verifiedPurchasesCurrent = sourceHasVerifiedValue(purchasesSource)
    ? currentOverview.kpis.purchases
    : null;
  const verifiedPurchasesPrevious =
    previousOverview && sameCommerceSourceFamily(purchasesSource, previousOverview.kpiSources?.purchases)
      ? previousOverview.kpis.purchases
      : null;
  const verifiedAovCurrent = sourceHasVerifiedValue(aovSource) ? currentOverview.kpis.aov : null;
  const verifiedAovPrevious =
    previousOverview && sameCommerceSourceFamily(aovSource, previousOverview.kpiSources?.aov)
      ? previousOverview.kpis.aov
      : null;
  const paidProviderScopeLabel = blendedProviderSourceLabel ?? tr(
    "verified paid platforms",
    "doğrulanmış reklam platformları",
  );
  const paidSpendDefinition = currentBlendedRoas?.providers.length === 1
    ? tr(`${paidProviderScopeLabel} spend`, `${paidProviderScopeLabel} harcaması`)
    : tr(
        `combined spend (${paidProviderScopeLabel})`,
        `toplam harcama (${paidProviderScopeLabel})`,
      );
  const revenueCompositeSourceLabel = isShopifySource(revenueSource)
    ? tr(
        `${revenueSource?.label ?? "Shopify"} + ad platforms`,
        `${revenueSource?.label ?? "Shopify"} + reklam platformlari`
      )
    : revenueSource?.source === "ga4_fallback"
      ? tr("GA4 + ad platforms", "GA4 + reklam platformlari")
      : tr("Revenue + ad platforms", "Gelir + reklam platformlari");
  const merDefinition = isShopifySource(revenueSource)
    ? tr(
        `Shopify revenue / ${paidSpendDefinition}`,
        `Shopify geliri / ${paidSpendDefinition}`,
      )
    : revenueSource?.source === "ga4_fallback"
      ? tr(
          `GA4 ecommerce revenue fallback / ${paidSpendDefinition}`,
          `GA4 e-ticaret gelir yedeği / ${paidSpendDefinition}`,
        )
      : tr(
          `Commerce revenue / ${paidSpendDefinition}`,
          `E-ticaret geliri / ${paidSpendDefinition}`,
        );
  const commerceUnavailableHelper = shopifyPrimary
    ? tr("Finish Shopify store sync", "Shopify mağaza senkronunu tamamlayın")
    : tr("Connect Shopify or GA4", "Shopify veya GA4 bağlayın");
  const compatiblePaidProviderTrends = sourceSafeProviderTrends(
    currentOverviewForProviderScope,
    currentBlendedRoas,
  );
  const spendSeries = compatiblePaidProviderTrends
    ? buildPaidProviderSpendSeries(compatiblePaidProviderTrends)
    : [];
  const revenueSeries = toSparklineSeries(currentOverview.trends.custom, (point) => point.revenue);
  const purchaseSeries = toSparklineSeries(currentOverview.trends.custom, (point) => point.purchases);
  const verifiedPaidSpendByDate = new Map(
    buildPaidProviderSpendSeries(
      compatiblePaidProviderTrends ?? {},
    ).map((point) => [point.date, point.value]),
  );
  const merSeries =
    currentMerSpend !== null
      ? toRatioSparklineSeries(
          currentOverview.trends.custom.flatMap((point) => {
            const spend = verifiedPaidSpendByDate.get(point.date);
            return spend === undefined ? [] : [{ ...point, spend }];
          }),
          (point) => point.revenue,
          (point) => point.spend,
        )
      : [];
  const blendedRoasSeries = sourceSafeBlendedRoasSeries(
    currentOverviewForProviderScope,
    currentBlendedRoas,
  );
  const blendedCpaSeries = toRatioSparklineSeries(
    currentOverview.trends.custom,
    (point) => point.spend,
    (point) => point.purchases
  );
  const ga4RevenueSeries = toSparklineSeries(ga4DailyTrends, (point) => point.revenue);
  const ga4PurchaseSeries = toSparklineSeries(ga4DailyTrends, (point) => point.purchases);
  const shopifyGrossSalesSeries = toSparklineSeries(
    currentShopify?.dailyTrends ?? [],
    (point) => point.grossRevenue ?? 0
  );
  const shopifyRefundedRevenueSeries = toSparklineSeries(
    currentShopify?.dailyTrends ?? [],
    (point) => point.refundedRevenue ?? 0
  );
  const shopifyRefundRateSeries = toPercentSparklineSeries(
    currentShopify?.dailyTrends ?? [],
    (point) => point.refundedRevenue ?? 0,
    (point) => point.grossRevenue ?? 0
  );
  const shopifyReturnEventsSeries = toSparklineSeries(
    currentShopify?.dailyTrends ?? [],
    (point) => point.returnEvents ?? 0
  );
  const shopifyReturnRateSeries = toPercentSparklineSeries(
    currentShopify?.dailyTrends ?? [],
    (point) => point.returnEvents ?? 0,
    (point) => point.purchases ?? 0
  );
  const shopifyAovSeries = toRatioSparklineSeries(
    currentShopify?.dailyTrends ?? [],
    (point) => point.grossRevenue ?? point.revenue,
    (point) => point.purchases
  );
  const shopifyConversionRateSeries = (currentShopify?.dailyTrends ?? []).flatMap((point) =>
    point.conversionRate === null || point.conversionRate === undefined
      ? []
      : [{ date: point.date, value: roundSparklineValue(point.conversionRate) }]
  );
  const ga4ConversionRateSeries = toPercentSparklineSeries(
    ga4DailyTrends,
    (point) => point.purchases,
    (point) => point.sessions
  );
  const ga4SessionsSeries = toSparklineSeries(ga4DailyTrends, (point) => point.sessions);
  const ga4EngagementRateSeries = toSparklineSeries(ga4DailyTrends, (point) => point.engagementRate * 100);
  const ga4AvgSessionDurationSeries = toSparklineSeries(ga4DailyTrends, (point) => point.avgSessionDuration);
  const ga4RevenuePerCustomerSeries = toRatioSparklineSeries(
    ga4DailyTrends,
    (point) => point.revenue,
    (point) => point.totalPurchasers
  );
  const ga4RepeatPurchaseRateSeries = toPercentSparklineSeries(
    ga4DailyTrends,
    (point) => Math.max(point.totalPurchasers - point.firstTimePurchasers, 0),
    (point) => point.totalPurchasers
  );
  const sessionsCurrent = currentAnalytics?.kpis?.sessions ?? null;
  const sessionsPrevious = previousAnalytics?.kpis?.sessions ?? null;
  const engagementRateCurrent = currentAnalytics?.kpis?.engagementRate ?? null;
  const engagementRatePrevious = previousAnalytics?.kpis?.engagementRate ?? null;
  const avgSessionDurationCurrent = currentAnalytics?.kpis?.avgSessionDuration ?? null;
  const avgSessionDurationPrevious = previousAnalytics?.kpis?.avgSessionDuration ?? null;
  const ga4ConversionRateCurrent = currentAnalytics?.kpis?.purchaseCvr ?? null;
  const ga4ConversionRatePrevious = previousAnalytics?.kpis?.purchaseCvr ?? null;
  const shopifyStoreMetricSource = resolveShopifyMetricSource(currentOverview.shopifyServing?.source, tr);
  const selectedShopifyMetricSource =
    shopifyStoreMetricSource.key !== "unavailable"
      ? shopifyStoreMetricSource
      : shopifyPrimary
        ? { key: "shopify_unavailable", label: "Shopify" }
        : shopifyStoreMetricSource;
  const ga4FallbackSource =
    ga4CommerceFallbackAllowed && analyticsConnected
      ? { key: "ga4_fallback", label: tr("GA4 fallback", "GA4 yedeği") }
      : { key: "unavailable", label: tr("Unavailable", "Kullanılamıyor") };
  const storeConversionSource = shopifyPrimary
    ? currentShopify?.conversionRate !== null && currentShopify?.conversionRate !== undefined
      ? { key: "shopify_customer_events", label: "Shopify" }
      : { key: "shopify_unavailable", label: "Shopify" }
    : ga4FallbackSource;
  const storeCustomerSource = shopifyPrimary
    ? currentShopify?.newCustomers !== null && currentShopify?.newCustomers !== undefined
      ? { key: "shopify", label: "Shopify" }
      : { key: "shopify_unavailable", label: "Shopify" }
    : ga4FallbackSource;
  const conversionRateCurrent = shopifyPrimary
    ? currentShopify?.conversionRate ?? null
    : ga4CommerceFallbackAllowed && ga4ConversionRateCurrent !== null
      ? ga4ConversionRateCurrent * 100
      : null;
  const conversionRatePrevious = shopifyPrimary
    ? previousShopify?.conversionRate ?? null
    : ga4CommerceFallbackAllowed && ga4ConversionRatePrevious !== null
      ? ga4ConversionRatePrevious * 100
      : null;
  const newCustomersCurrent = shopifyPrimary
    ? currentShopify?.newCustomers ?? null
    : ga4CommerceFallbackAllowed
      ? currentAnalytics?.kpis?.firstTimePurchasers ?? null
      : null;
  const newCustomersPrevious = shopifyPrimary
    ? previousShopify?.newCustomers ?? null
    : ga4CommerceFallbackAllowed
      ? previousAnalytics?.kpis?.firstTimePurchasers ?? null
      : null;
  const shopifyStoreMetricHelper =
    shopifyStoreMetricSource.key === "unavailable"
      ? shopifyPrimary
        ? tr("Finish Shopify store sync", "Shopify mağaza senkronunu tamamlayın")
        : tr("Connect Shopify", "Shopify bağlayın")
      : undefined;
  const grossSalesCurrent = currentShopify?.grossRevenue ?? null;
  const grossSalesPrevious = previousShopify?.grossRevenue ?? null;
  const refundedRevenueCurrent = currentShopify?.refundedRevenue ?? null;
  const refundedRevenuePrevious = previousShopify?.refundedRevenue ?? null;
  const refundRateCurrent =
    grossSalesCurrent !== null && grossSalesCurrent > 0 && refundedRevenueCurrent !== null
      ? (refundedRevenueCurrent / grossSalesCurrent) * 100
      : null;
  const refundRatePrevious =
    grossSalesPrevious !== null && grossSalesPrevious > 0 && refundedRevenuePrevious !== null
      ? (refundedRevenuePrevious / grossSalesPrevious) * 100
      : null;
  const returnEventsCurrent = currentShopify?.returnEvents ?? null;
  const returnEventsPrevious = previousShopify?.returnEvents ?? null;
  const returnRateCurrent =
    currentShopify?.purchases !== null &&
    currentShopify?.purchases !== undefined &&
    currentShopify.purchases > 0 &&
    returnEventsCurrent !== null
      ? (returnEventsCurrent / currentShopify.purchases) * 100
      : null;
  const returnRatePrevious =
    previousShopify?.purchases !== null &&
    previousShopify?.purchases !== undefined &&
    previousShopify.purchases > 0 &&
    returnEventsPrevious !== null
      ? (returnEventsPrevious / previousShopify.purchases) * 100
      : null;
  const [currentGa4Ltv, previousGa4Ltv] = await Promise.all([
    analyticsConnected && ga4CommerceFallbackAllowed
      ? getGa4LtvSnapshot({
          businessId,
          startDate: resolvedStart,
          endDate: resolvedEnd,
          spend: currentOverview.kpis.spend ?? 0,
        })
      : Promise.resolve(null),
    analyticsConnected && ga4CommerceFallbackAllowed && previousWindow.startDate && previousWindow.endDate
      ? getGa4LtvSnapshot({
          businessId,
          startDate: previousWindow.startDate,
          endDate: previousWindow.endDate,
          spend: previousOverview?.kpis.spend ?? 0,
        })
      : Promise.resolve(null),
  ]);
  const pins: OverviewMetricCardData[] = [
    buildMetricCard({
      id: "pins-revenue",
      title: "Revenue",
      subtitle: tr("Primary ecommerce outcome", "Ana ecommerce sonucu"),
      value: verifiedRevenueCurrent,
      previousValue: verifiedRevenuePrevious,
      unit: "currency",
      sourceKey: revenueSource?.source ?? "unavailable",
      sourceLabel: revenueSource?.label ?? tr("Unavailable", "Kullanılamıyor"),
      helperText:
        !sourceHasVerifiedValue(revenueSource) ? commerceUnavailableHelper : undefined,
      sparklineData: revenueSeries,
      compareMode,
      icon: "badge-dollar-sign",
    }),
    buildMetricCard({
      id: "pins-spend",
      title: "Ad Spend",
      subtitle: tr("Paid media investment", "Paid media harcamasi"),
      value: currentBlendedRoas?.spend ?? null,
      previousValue: paidSpendComparisonComparable ? (previousBlendedRoas?.spend ?? null) : null,
      unit: "currency",
      sourceKey: currentBlendedRoas ? "ad_platforms" : "unavailable",
      sourceLabel: blendedProviderSourceLabel ?? tr("Unavailable", "Kullanılamıyor"),
      helperText: currentBlendedRoas
        ? undefined
        : tr("Paid-media coverage is incomplete for this window", "Bu dönem için reklam verisi kapsamı eksik"),
      sparklineData: spendSeries,
      compareMode,
      icon: "wallet",
    }),
    buildMetricCard({
      id: "pins-mer",
      title: "MER",
      subtitle: merDefinition,
      value:
        verifiedRevenueCurrent !== null && currentMerSpend !== null && currentMerSpend > 0
          ? verifiedRevenueCurrent / currentMerSpend
          : null,
      previousValue:
        verifiedRevenuePreviousForMer !== null && previousMerSpend !== null && previousMerSpend > 0
          ? verifiedRevenuePreviousForMer / previousMerSpend
          : null,
      unit: "ratio",
      sourceKey: revenueSource?.source ?? "unavailable",
      sourceLabel: revenueCompositeSourceLabel,
      helperText:
        !sourceHasVerifiedValue(revenueSource)
          ? commerceUnavailableHelper
          : currentMerSpend === null
            ? tr("Paid-media coverage is incomplete for this window", "Bu dönem için reklam verisi kapsamı eksik")
            : undefined,
      sparklineData: merSeries,
      compareMode,
      icon: "line-chart",
    }),
    buildMetricCard({
      id: "pins-blended-roas",
      title: `Blended ROAS · target ${targetRoas == null ? "—" : targetRoas.toFixed(2)}`,
      subtitle: blendedProviderSourceLabel
        ? tr(
            `Attributed conversion value (${blendedProviderSourceLabel}) / ${paidSpendDefinition}`,
            `Atfedilen dönüşüm değeri (${blendedProviderSourceLabel}) / ${paidSpendDefinition}`,
          )
        : tr(
            "Platform-attributed conversion value / ad spend",
            "Platform dönüşüm değeri / reklam harcaması",
          ),
      value: currentBlendedRoas?.roas ?? null,
      previousValue: blendedRoasComparable ? (previousBlendedRoas?.roas ?? null) : null,
      unit: "ratio",
      sourceKey: currentBlendedRoas ? "ad_platforms" : "unavailable",
      sourceLabel: blendedProviderSourceLabel ?? tr("Unavailable", "Kullanılamıyor"),
      helperText:
        currentBlendedRoas?.roas === null || currentBlendedRoas === null
          ? tr(
              "No verified platform-attributed conversion value for this window",
              "Bu dönem için doğrulanmış platform dönüşüm değeri yok",
            )
          : undefined,
      sparklineData: blendedRoasSeries,
      compareMode,
      icon: "chart-line",
      metricKey: "roas",
    }),
    buildMetricCard({
      id: "pins-conversion-rate",
      title: tr("Conversion Rate", "Dönüşüm Oranı"),
      subtitle: tr("Store purchase conversion", "Magaza satın alma dönüşum orani"),
      value: conversionRateCurrent,
      previousValue: conversionRatePrevious,
      unit: "percent",
      sourceKey: storeConversionSource.key,
      sourceLabel: storeConversionSource.label,
      helperText:
        storeConversionSource.key === "unavailable" || storeConversionSource.key === "shopify_unavailable"
          ? shopifyPrimary
            ? tr(
                "Shopify session tracking is unavailable for this period",
                "Bu dönem için Shopify oturum takibi kullanılamıyor",
              )
            : tr("Connect Shopify or GA4", "Shopify veya GA4 bağlayın")
          : undefined,
      sparklineData: shopifyPrimary ? shopifyConversionRateSeries : ga4ConversionRateSeries,
      compareMode,
      icon: "target",
    }),
    buildMetricCard({
      id: "pins-orders",
      title: tr("Orders", "Siparisler"),
      subtitle: tr("Completed purchases", "Tamamlanan satın almalar"),
      value: verifiedPurchasesCurrent,
      previousValue: verifiedPurchasesPrevious,
      unit: "count",
      sourceKey: purchasesSource?.source ?? "unavailable",
      sourceLabel: purchasesSource?.label ?? tr("Unavailable", "Kullanılamıyor"),
      helperText:
        !sourceHasVerifiedValue(purchasesSource)
          ? commerceUnavailableHelper
          : undefined,
      sparklineData: purchaseSeries,
      compareMode,
      icon: "shopping-cart",
    }),
  ];

  const storeMetrics: OverviewMetricCardData[] = [
    buildMetricCard({
      id: "store-aov",
      title: "AOV",
      subtitle: tr("Average order value", "Ortalama siparis degeri"),
      value: verifiedAovCurrent,
      previousValue: verifiedAovPrevious,
      unit: "currency",
      sourceKey: aovSource?.source ?? "unavailable",
      sourceLabel: aovSource?.label ?? tr("Unavailable", "Kullanılamıyor"),
      helperText:
        !sourceHasVerifiedValue(aovSource)
          ? shopifyPrimary
            ? tr("Finish Shopify store sync", "Shopify mağaza senkronunu tamamlayın")
            : tr("Connect Shopify or GA4", "Shopify veya GA4 bağlayın")
          : undefined,
      sparklineData: isShopifySource(aovSource) ? shopifyAovSeries : ga4RevenueSeries.map((point, index) => ({
        date: point.date,
        value:
          ga4PurchaseSeries[index] && ga4PurchaseSeries[index].value > 0
            ? roundSparklineValue(point.value / ga4PurchaseSeries[index].value)
            : 0,
      })),
      compareMode,
      icon: "receipt",
    }),
    buildMetricCard({
      id: "store-new-customers",
      title: "New customers",
      value: newCustomersCurrent,
      previousValue: newCustomersPrevious,
      unit: "count",
      sourceKey: storeCustomerSource.key,
      sourceLabel: storeCustomerSource.label,
      helperText:
        storeCustomerSource.key === "unavailable" || storeCustomerSource.key === "shopify_unavailable"
          ? shopifyPrimary
            ? tr("Shopify customer lifecycle data is unavailable", "Shopify müşteri yaşam döngüsü verisi kullanılamıyor")
            : tr("Connect GA4", "GA4 bağlayın")
          : undefined,
      sparklineData: [],
      compareMode,
    }),
    buildMetricCard({
      id: "store-gross-sales",
      title: tr("Gross Sales", "Brüt Satış"),
      subtitle: tr("Pre-refund order revenue", "İadeler öncesi sipariş geliri"),
      value: grossSalesCurrent,
      previousValue: grossSalesPrevious,
      unit: "currency",
      sourceKey: selectedShopifyMetricSource.key,
      sourceLabel: selectedShopifyMetricSource.label,
      helperText: shopifyStoreMetricHelper,
      sparklineData: shopifyGrossSalesSeries,
      compareMode,
      icon: "badge-dollar-sign",
    }),
    buildMetricCard({
      id: "store-refunded-revenue",
      title: tr("Refunded Revenue", "İade Edilen Gelir"),
      subtitle: tr("Refunded sales value", "Müşterilere iade edilen tutar"),
      value: refundedRevenueCurrent,
      previousValue: refundedRevenuePrevious,
      unit: "currency",
      sourceKey: selectedShopifyMetricSource.key,
      sourceLabel: selectedShopifyMetricSource.label,
      helperText: shopifyStoreMetricHelper,
      sparklineData: shopifyRefundedRevenueSeries,
      compareMode,
      icon: "wallet",
    }),
    buildMetricCard({
      id: "store-refund-rate",
      title: tr("Refund Rate", "İade Oranı"),
      subtitle: tr("Refunded revenue / gross sales", "İade edilen gelir / brüt satış"),
      value: refundRateCurrent,
      previousValue: refundRatePrevious,
      unit: "percent",
      sourceKey: selectedShopifyMetricSource.key,
      sourceLabel: selectedShopifyMetricSource.label,
      helperText: shopifyStoreMetricHelper,
      sparklineData: shopifyRefundRateSeries,
      compareMode,
      icon: "percent",
    }),
    buildMetricCard({
      id: "store-return-events",
      title: tr("Return Events", "İade Olayları"),
      subtitle: tr("Store return activity", "Mağaza iade hareketi"),
      value: returnEventsCurrent,
      previousValue: returnEventsPrevious,
      unit: "count",
      sourceKey: selectedShopifyMetricSource.key,
      sourceLabel: selectedShopifyMetricSource.label,
      helperText: shopifyStoreMetricHelper,
      sparklineData: shopifyReturnEventsSeries,
      compareMode,
      icon: "activity",
    }),
    buildMetricCard({
      id: "store-return-rate",
      title: tr("Return Rate", "İade Oranı"),
      subtitle: tr("Returns / orders", "İadeler / siparişler"),
      value: returnRateCurrent,
      previousValue: returnRatePrevious,
      unit: "percent",
      sourceKey: selectedShopifyMetricSource.key,
      sourceLabel: selectedShopifyMetricSource.label,
      helperText: shopifyStoreMetricHelper,
      sparklineData: shopifyReturnRateSeries,
      compareMode,
      icon: "target",
    }),
  ];

  const ltvSourceLabel = tr("GA4 fallback", "GA4 yedegi");
  const ltvEstimatedHelper = tr("Estimated from GA4", "GA4 üzerinden tahmin edildi");
  const ltv: OverviewMetricCardData[] = [
    currentGa4Ltv?.averageCustomerLtv !== null && currentGa4Ltv?.averageCustomerLtv !== undefined
      ? buildMetricCard({
          id: "ltv-average",
          title: tr("Average Customer LTV", "Ortalama Müşteri LTV"),
          helperText: ltvEstimatedHelper,
          value: currentGa4Ltv.averageCustomerLtv,
          previousValue: previousGa4Ltv?.averageCustomerLtv ?? null,
          unit: "currency",
          sourceKey: "ga4_fallback",
          sourceLabel: ltvSourceLabel,
          sparklineData: ga4RevenuePerCustomerSeries,
          compareMode,
        })
      : null,
    currentGa4Ltv?.ltvToCac !== null && currentGa4Ltv?.ltvToCac !== undefined
      ? buildMetricCard({
          id: "ltv-cac",
          title: "LTV : CAC",
          helperText: ltvEstimatedHelper,
          value: currentGa4Ltv.ltvToCac,
          previousValue: previousGa4Ltv?.ltvToCac ?? null,
          unit: "ratio",
          sourceKey: "ga4_fallback",
          sourceLabel: ltvSourceLabel,
          sparklineData:
            currentOverview.kpis.spend > 0
              ? toRatioSparklineSeries(
                  ga4RevenuePerCustomerSeries,
                  (point) => point.value,
                  () => {
                    return 1;
                  }
                ).map((point, index) => ({
                  date: point.date,
                  value:
                    blendedCpaSeries[index] && blendedCpaSeries[index].value > 0
                      ? roundSparklineValue(point.value / blendedCpaSeries[index].value)
                      : 0,
                }))
              : [],
          compareMode,
        })
      : null,
    currentGa4Ltv?.repeatPurchaseRate !== null && currentGa4Ltv?.repeatPurchaseRate !== undefined
      ? buildMetricCard({
          id: "ltv-repeat-rate",
          title: "Repeat rate",
          helperText: ltvEstimatedHelper,
          value: currentGa4Ltv.repeatPurchaseRate,
          previousValue: previousGa4Ltv?.repeatPurchaseRate ?? null,
          unit: "percent",
          sourceKey: "ga4_fallback",
          sourceLabel: ltvSourceLabel,
          sparklineData: ga4RepeatPurchaseRateSeries,
          compareMode,
        })
      : null,
    currentGa4Ltv?.revenuePerCustomer !== null && currentGa4Ltv?.revenuePerCustomer !== undefined
      ? buildMetricCard({
          id: "ltv-revenue-per-customer",
          title: tr("Revenue per Customer", "Müşteri Basina Gelir"),
          helperText: ltvEstimatedHelper,
          value: currentGa4Ltv.revenuePerCustomer,
          previousValue: previousGa4Ltv?.revenuePerCustomer ?? null,
          unit: "currency",
          sourceKey: "ga4_fallback",
          sourceLabel: ltvSourceLabel,
          sparklineData: ga4RevenuePerCustomerSeries,
          compareMode,
        })
      : null,
  ].filter((metric): metric is OverviewMetricCardData => Boolean(metric));

  const costModelData = toCostModelData(costModel);
  const cogsValue =
    costModelData && verifiedRevenueCurrent !== null
      ? Number((verifiedRevenueCurrent * costModelData.cogsPercent).toFixed(2))
      : null;
  const shippingValue =
    costModelData && verifiedRevenueCurrent !== null
      ? Number((verifiedRevenueCurrent * costModelData.shippingPercent).toFixed(2))
      : null;
  const feeValue =
    costModelData && verifiedRevenueCurrent !== null
      ? Number((verifiedRevenueCurrent * costModelData.feePercent).toFixed(2))
      : null;
  const variableCosts =
    cogsValue !== null && shippingValue !== null && feeValue !== null && currentMerSpend !== null
      ? Number((currentMerSpend + cogsValue + shippingValue + feeValue).toFixed(2))
      : null;
  const totalExpensesValue =
    variableCosts !== null && costModelData ? Number((variableCosts + costModelData.fixedCost).toFixed(2)) : null;
  const netProfitValue =
    totalExpensesValue !== null && verifiedRevenueCurrent !== null
      ? Number((verifiedRevenueCurrent - totalExpensesValue).toFixed(2))
      : null;
  const contributionMarginValue =
    variableCosts !== null && verifiedRevenueCurrent !== null && verifiedRevenueCurrent > 0
      ? Number((((verifiedRevenueCurrent - variableCosts) / verifiedRevenueCurrent) * 100).toFixed(1))
      : null;
  const costModelMissingHelper = tr("Set cost model", "Maliyet modelini ayarla");
  const expenses: OverviewMetricCardData[] = [
    buildMetricCard({
      id: "expenses-ad-spend",
      title: tr("Ad Spend", "Reklam Spend'i"),
      value: currentBlendedRoas?.spend ?? null,
      previousValue: paidSpendComparisonComparable ? (previousBlendedRoas?.spend ?? null) : null,
      unit: "currency",
      sourceKey: currentBlendedRoas ? "ad_platforms" : "unavailable",
      sourceLabel: blendedProviderSourceLabel ?? tr("Unavailable", "Kullanılamıyor"),
      helperText: currentBlendedRoas
        ? undefined
        : tr("Paid-media coverage is incomplete for this window", "Bu dönem için reklam verisi kapsamı eksik"),
      sparklineData: spendSeries,
      compareMode,
      icon: "wallet",
    }),
    costModelData
      ? buildMetricCard({
          id: "expenses-cogs",
          title: "COGS",
          subtitle: `${Math.round(costModelData.cogsPercent * 100)}% of revenue`,
          value: cogsValue,
          unit: "currency",
          sourceKey: "manual_cost_model",
          sourceLabel: tr("Manual cost model", "Manuel maliyet modeli"),
          compareMode,
        })
      : buildUnavailableMetric({
          id: "expenses-cogs",
          title: "COGS",
          helperText: costModelMissingHelper,
          unit: "currency",
        }),
    costModelData
      ? buildMetricCard({
          id: "expenses-shipping",
          title: "Shipping",
          subtitle: `${Math.round(costModelData.shippingPercent * 100)}% of revenue`,
          value: shippingValue,
          unit: "currency",
          sourceKey: "manual_cost_model",
          sourceLabel: tr("Manual cost model", "Manuel maliyet modeli"),
          compareMode,
        })
      : buildUnavailableMetric({
          id: "expenses-shipping",
          title: "Shipping",
          helperText: costModelMissingHelper,
          unit: "currency",
        }),
    costModelData
      ? buildMetricCard({
          id: "expenses-fees",
          title: "Fees",
          subtitle: `${Math.round(costModelData.feePercent * 100)}% of revenue`,
          value: feeValue,
          unit: "currency",
          sourceKey: "manual_cost_model",
          sourceLabel: tr("Manual cost model", "Manuel maliyet modeli"),
          compareMode,
        })
      : buildUnavailableMetric({
          id: "expenses-fees",
          title: "Fees",
          helperText: costModelMissingHelper,
          unit: "currency",
        }),
    costModelData
      ? buildMetricCard({
          id: "expenses-total-tracked",
          title: tr("Total Expenses", "Toplam Giderler"),
          subtitle: tr("Ad spend + modeled costs", "Reklam spend'i + modellenmis maliyetler"),
          value: totalExpensesValue,
          unit: "currency",
          sourceKey: "manual_cost_model",
          sourceLabel: tr("Ad platforms + manual cost model", "Reklam platformlari + manuel maliyet modeli"),
          sparklineData: revenueSeries.map((point, index) => ({
            date: point.date,
            value: roundSparklineValue(
              (spendSeries[index]?.value ?? 0) +
                point.value * (costModelData.cogsPercent + costModelData.shippingPercent + costModelData.feePercent) +
                costModelData.fixedCost
            ),
          })),
          compareMode,
          icon: "badge-dollar-sign",
        })
      : buildMetricCard({
          id: "expenses-total-tracked",
          title: tr("Total Expenses", "Toplam Giderler"),
          subtitle: tr("Tracked expenses", "Izlenen giderler"),
          value: currentBlendedRoas?.spend ?? null,
          previousValue: paidSpendComparisonComparable ? (previousBlendedRoas?.spend ?? null) : null,
          unit: "currency",
          sourceKey: currentBlendedRoas ? "ad_platforms" : "unavailable",
          sourceLabel: currentBlendedRoas
            ? tr("Ad spend only", "Yalnizca reklam spend'i")
            : tr("Unavailable", "Kullanılamıyor"),
          helperText: currentBlendedRoas
            ? tr(
                "Set cost model to include COGS, shipping, fees, and fixed cost",
                "COGS, kargo, fee ve sabit giderleri dahil etmek için maliyet modeli ayarlayin"
              )
            : tr("Paid-media coverage is incomplete for this window", "Bu dönem için reklam verisi kapsamı eksik"),
          sparklineData: spendSeries,
          compareMode,
          icon: "badge-dollar-sign",
        }),
    costModelData
      ? buildMetricCard({
          id: "expenses-net-profit",
          title: tr("Net Profit", "Net Kar"),
          value: netProfitValue,
          unit: "currency",
          sourceKey: "manual_cost_model",
          sourceLabel: tr("Revenue + ad spend + manual cost model", "Gelir + reklam spend'i + manuel maliyet modeli"),
          sparklineData: revenueSeries.map((point, index) => ({
            date: point.date,
            value: roundSparklineValue(
              point.value -
                ((spendSeries[index]?.value ?? 0) +
                  point.value * (costModelData.cogsPercent + costModelData.shippingPercent + costModelData.feePercent) +
                  costModelData.fixedCost)
            ),
          })),
          compareMode,
        })
      : buildUnavailableMetric({
          id: "expenses-net-profit",
          title: tr("Net Profit", "Net Kar"),
          helperText: costModelMissingHelper,
          unit: "currency",
        }),
    costModelData
      ? buildMetricCard({
          id: "expenses-contribution-margin",
          title: tr("Contribution Margin", "Katki Marji"),
          value: contributionMarginValue,
          unit: "percent",
          sourceKey: "manual_cost_model",
          sourceLabel: tr("Revenue + variable costs", "Gelir + değişken maliyetler"),
          sparklineData: revenueSeries.map((point, index) => {
            const spendValue = spendSeries[index]?.value ?? 0;
            const variableCost =
              spendValue +
              point.value * (costModelData.cogsPercent + costModelData.shippingPercent + costModelData.feePercent);
            return {
              date: point.date,
              value: point.value > 0 ? roundSparklineValue(((point.value - variableCost) / point.value) * 100) : 0,
            };
          }),
          compareMode,
        })
      : buildUnavailableMetric({
          id: "expenses-contribution-margin",
          title: tr("Contribution Margin", "Katki Marji"),
          helperText: costModelMissingHelper,
          unit: "percent",
        }),
    buildMetricCard({
      id: "expenses-mer",
      title: "MER",
      value:
        verifiedRevenueCurrent !== null && currentMerSpend !== null && currentMerSpend > 0
          ? verifiedRevenueCurrent / currentMerSpend
          : null,
      previousValue:
        verifiedRevenuePreviousForMer !== null && previousMerSpend !== null && previousMerSpend > 0
          ? verifiedRevenuePreviousForMer / previousMerSpend
          : null,
      unit: "ratio",
      sourceKey: revenueSource?.source ?? "unavailable",
      sourceLabel: isShopifySource(revenueSource)
        ? `${revenueSource?.label ?? "Shopify"} + ad platforms`
        : revenueSource?.source === "ga4_fallback"
          ? "GA4 + ad platforms"
          : "Revenue + ad platforms",
      helperText: !sourceHasVerifiedValue(revenueSource) ? commerceUnavailableHelper : undefined,
      sparklineData: merSeries,
      compareMode,
      icon: "chart-line",
    }),
  ];

  const customMetrics: OverviewMetricCardData[] = [
    buildMetricCard({
      id: "custom-mer",
      title: "MER",
      value:
        verifiedRevenueCurrent !== null && currentMerSpend !== null && currentMerSpend > 0
          ? verifiedRevenueCurrent / currentMerSpend
          : null,
      previousValue:
        verifiedRevenuePreviousForMer !== null && previousMerSpend !== null && previousMerSpend > 0
          ? verifiedRevenuePreviousForMer / previousMerSpend
          : null,
      unit: "ratio",
      sourceKey: revenueSource?.source ?? "unavailable",
      sourceLabel: tr("Derived", "Türetilmiş"),
      helperText:
        !sourceHasVerifiedValue(revenueSource) ? commerceUnavailableHelper : undefined,
      sparklineData: merSeries,
      compareMode,
    }),
    buildMetricCard({
      id: "custom-blended-cpa",
      title: "Blended CPA",
      value: currentOverview.kpis.cpa ?? null,
      previousValue: previousOverview?.kpis.cpa ?? null,
      unit: "currency",
      sourceKey: "ad_platforms",
      sourceLabel: tr("Ad platforms", "Reklam platformlari"),
      sparklineData: blendedCpaSeries,
      compareMode,
    }),
  ];

  const webAnalytics: OverviewMetricCardData[] = [
    buildMetricCard({
      id: "web-sessions",
      title: tr("Sessions", "Oturumlar"),
      value: sessionsCurrent,
      previousValue: sessionsPrevious,
      unit: "count",
      sourceKey: analyticsConnected ? "ga4" : "unavailable",
      sourceLabel: analyticsConnected ? "GA4" : tr("Unavailable", "Kullanılamıyor"),
      helperText: analyticsConnected ? undefined : tr("Connect GA4", "GA4 bağlayın"),
      sparklineData: ga4SessionsSeries,
      compareMode,
      icon: "activity",
    }),
    buildMetricCard({
      id: "web-engagement-rate",
      title: "Engagement",
      value: engagementRateCurrent !== null ? engagementRateCurrent * 100 : null,
      previousValue: engagementRatePrevious !== null ? engagementRatePrevious * 100 : null,
      unit: "percent",
      sourceKey: analyticsConnected ? "ga4" : "unavailable",
      sourceLabel: analyticsConnected ? "GA4" : tr("Unavailable", "Kullanılamıyor"),
      helperText: analyticsConnected ? undefined : tr("Connect GA4", "GA4 bağlayın"),
      sparklineData: ga4EngagementRateSeries,
      compareMode,
      icon: "gauge",
    }),
    buildMetricCard({
      id: "web-session-duration",
      title: "Avg session",
      value: avgSessionDurationCurrent,
      previousValue: avgSessionDurationPrevious,
      unit: "duration_seconds",
      sourceKey: analyticsConnected ? "ga4" : "unavailable",
      sourceLabel: analyticsConnected ? "GA4" : tr("Unavailable", "Kullanılamıyor"),
      helperText: analyticsConnected ? undefined : tr("Connect GA4", "GA4 bağlayın"),
      sparklineData: ga4AvgSessionDurationSeries,
      compareMode,
      icon: "clock-3",
    }),
    buildMetricCard({
      id: "web-conversion-rate",
      title: "Conv rate",
      value: ga4ConversionRateCurrent === null ? null : ga4ConversionRateCurrent * 100,
      previousValue: ga4ConversionRatePrevious === null ? null : ga4ConversionRatePrevious * 100,
      unit: "percent",
      sourceKey: analyticsConnected ? "ga4" : "unavailable",
      sourceLabel: analyticsConnected ? "GA4" : tr("Unavailable", "Kullanılamıyor"),
      helperText: analyticsConnected ? undefined : tr("Connect GA4", "GA4 bağlayın"),
      sparklineData: ga4ConversionRateSeries,
      compareMode,
      icon: "target",
    }),
  ];
  const platforms = buildPlatformSections(
    currentOverview,
    previousOverviewForProviderComparison,
    compareMode,
    { startDate: resolvedStart, endDate: resolvedEnd },
  );

  const summary: OverviewSummaryData = {
    businessId,
    dateRange: {
      startDate: resolvedStart,
      endDate: resolvedEnd,
    },
    shopifyConnectionState,
    comparison: {
      mode: compareMode,
      startDate: previousWindow.startDate,
      endDate: previousWindow.endDate,
    },
    providerSources: {
      current: currentProviderSources,
      previous: comparablePreviousProviderSources,
    },
    paidProviderScope: {
      current: {
        providers: currentPaidProviderScope.providers,
        complete: currentPaidProviderScope.complete,
      },
      previous: previousPaidProviderScope
        ? {
            providers: previousPaidProviderScope.providers,
            complete: previousPaidProviderScope.complete,
          }
        : null,
    },
    pins,
    storeMetrics,
    attribution: buildAttributionRows(currentOverviewForProviderScope, {
      // The current aggregate contract has no organic-only revenue/conversion
      // split. Rendering total GA4 values as Organic would be false, so the
      // required row remains honest until that producer field exists.
      revenue: null,
      conversions: null,
    }),
    ltv,
    platforms,
    expenses,
    costModel: {
      configured: Boolean(costModelData),
      values: costModelData,
    },
    customMetrics,
    webAnalytics,
    insights: mapInsights(currentOverview, analyticsConnected),
    shopifyServing: currentOverview.shopifyServing ?? null,
  };

  logPerfEvent("overview_summary_route", {
    businessId,
    startDate: resolvedStart,
    endDate: resolvedEnd,
    dateSpanDays,
    includeTrends: false,
    compareMode,
    platformCount: platforms.length,
    analyticsConnected,
    shopifyReadSource: currentOverview.shopifyServing?.source ?? "none",
    durationMs: Date.now() - requestStartedAt,
  });

  return NextResponse.json({
    summary,
  });
}
