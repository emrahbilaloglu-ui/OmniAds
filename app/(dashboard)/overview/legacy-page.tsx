"use client";

import { useEffect, useMemo, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { FreshnessChip } from "@/components/states/FreshnessChip";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { compareModeForPreset } from "@/lib/comparison-preset-contract";
import { CostModelSheet } from "@/components/overview/CostModelSheet";
import { AiBriefCard } from "@/components/overview/v2/ai-brief-card";
import { AttributionCard } from "@/components/overview/v2/attribution-card";
import {
  HeroMetricCard,
  HeroTile,
  StatTile,
} from "@/components/overview/v2/metric-band";
import { PlatformMiniDashboard } from "@/components/overview/v2/platform-card";
import { ShareSnapshotButton } from "@/components/overview/v2/share-snapshot-button";
import {
  getPresetDatesForReferenceDate,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { usePreferencesHydrated } from "@/hooks/persistent-date-range-support";
import {
  buildOverviewMetricCatalog,
  DEFAULT_PINNED_METRICS,
} from "@/lib/overview-metric-catalog";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { currencySymbolFor } from "@/lib/metric-format";
import { cn } from "@/lib/utils";
import { usePreferencesStore } from "@/store/preferences-store";
import { useAppStore } from "@/store/app-store";
import {
  buildDefaultProviderDomains,
  deriveProviderViewState,
} from "@/store/integrations-support";
import { useIntegrationsStore } from "@/store/integrations-store";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import { getGoogleAdsStatusRefetchInterval } from "@/lib/google-ads/sync-progress-ux";
import { resolveProviderSyncStatusPill } from "@/lib/sync/sync-status-pill";
import {
  getOverviewSummary,
  getOverviewSparklines,
  getLatestAiInsight,
  generateAiInsight,
  upsertBusinessCostModel,
  type SparklineBundle,
} from "@/src/services";
import type {
  BusinessCostModelData,
  OverviewMetricCardData,
  OverviewMetricCatalogEntry,
  OverviewSummaryData,
} from "@/src/types/models";

type CurrencyCode = string;
type CompareMode = "none" | "previous_period";

async function fetchMetaStatus(businessId: string): Promise<MetaStatusResponse> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(`/api/meta/status?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ??
        `Meta status request failed (${response.status})`
    );
  }
  return payload as MetaStatusResponse;
}

async function fetchGoogleAdsStatus(
  businessId: string
): Promise<GoogleAdsStatusResponse> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(`/api/google-ads/status?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ??
        `Google Ads status request failed (${response.status})`
    );
  }
  return payload as GoogleAdsStatusResponse;
}

function getMetaStatusRefetchInterval(status: MetaStatusResponse | undefined) {
  const state = status?.state;
  if (state === "syncing" || state === "partial") return 5_000;
  if (
    state === "paused" ||
    state === "stale" ||
    (status?.jobHealth?.queueDepth ?? 0) > 0 ||
    (status?.jobHealth?.leasedPartitions ?? 0) > 0
  ) {
    return 10_000;
  }
  return false;
}

const PLATFORM_TITLE_META: Record<
  string,
  { label: string; logo: string }
> = {
  ga4: { label: "GA4", logo: "/platform-logos/GA4.svg" },
  meta: { label: "Meta Ads", logo: "/platform-logos/Meta.png" },
  google: { label: "Google Ads", logo: "/platform-logos/googleAds.svg" },
  google_ads: { label: "Google Ads", logo: "/platform-logos/googleAds.svg" },
  tiktok: { label: "TikTok Ads", logo: "/platform-logos/tiktok.svg" },
  tiktok_ads: { label: "TikTok Ads", logo: "/platform-logos/tiktok.svg" },
};

export default function OverviewPage() {
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceOwnerId = useAppStore((state) => state.workspaceOwnerId);
  const businessId = selectedBusinessId ?? "";
  const domains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined
  );
  const activeBusiness = useMemo(
    () => businesses.find((business) => business.id === selectedBusinessId) ?? null,
    [businesses, selectedBusinessId]
  );
  const isDemoBusiness = isDemoBusinessSelected(selectedBusinessId, businesses);
  const ga4View = deriveProviderViewState(
    "ga4",
    domains?.ga4 ?? buildDefaultProviderDomains().ga4
  );
  const ga4Connected = ga4View.isConnected || isDemoBusiness;

  const [dateRange, setDateRange] = usePersistentDateRange();
  // The summary fan-out is expensive, so it waits for the stored range to
  // settle instead of firing once for the default window and again for it.
  const dateRangeReady = usePreferencesHydrated();
  const currency: CurrencyCode = (activeBusiness?.currency as CurrencyCode) ?? "USD";
  const workspaceTimeZone = activeBusiness?.timezone ?? "UTC";
  const workspaceReferenceDate = useMemo(
    () => getTodayIsoForTimeZone(workspaceTimeZone),
    [workspaceTimeZone]
  );
  const [costModelSheetOpen, setCostModelSheetOpen] = useState(false);
  const [aiBriefRegenerating, setAiBriefRegenerating] = useState(false);
  const [aiBriefActionError, setAiBriefActionError] = useState<string | null>(null);

  const ensureBusiness = useIntegrationsStore((state) => state.ensureBusiness);

  useEffect(() => {
    if (!selectedBusinessId) return;
    ensureBusiness(businessId);
  }, [businessId, ensureBusiness, selectedBusinessId]);

  const { start: startDate, end: endDate } =
    dateRange.rangePreset === "custom"
      ? {
          start: dateRange.customStart,
          end: dateRange.customEnd,
        }
      : getPresetDatesForReferenceDate(
          dateRange.rangePreset,
          workspaceReferenceDate,
          dateRange.customStart,
          dateRange.customEnd
        );
  // This route carries exactly two comparisons — `lib/overview-summary-support.ts`
  // types CompareMode as "none" | "previous_period" — so the stored preset is
  // narrowed through the shared contract rather than collapsed. Collapsing every
  // non-"none" choice to previous_period is what put a year-over-year label on a
  // previous-period delta; an unrecognised preset (a saved view, a hand-edited
  // URL) now shows no comparison instead of a confident wrong one.
  const compareMode: CompareMode =
    compareModeForPreset(dateRange.comparisonPreset) === "previous_period"
      ? "previous_period"
      : "none";

  const query = useQuery({
    queryKey: ["overview-summary", businessId, startDate, endDate, compareMode],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    queryFn: () =>
      getOverviewSummary(businessId, {
        startDate,
        endDate,
        compareMode,
      }),
  });

  // Secondary query: fetches daily trend bundles independently so the metric
  // cards above can render as soon as the summary resolves, while sparkline
  // charts skeleton until this slower query settles.
  const sparklineQuery = useQuery({
    queryKey: ["overview-sparklines", businessId, startDate, endDate],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    queryFn: () => getOverviewSparklines(businessId, { startDate, endDate }),
    staleTime: 15 * 60 * 1000,
  });

  // Comparison sparklines — same endpoint, previous period dates.
  // Only runs when comparison mode is active and summary has resolved.
  const compStartDate = query.data?.comparison.startDate ?? null;
  const compEndDate = query.data?.comparison.endDate ?? null;
  const comparisonSparklineQuery = useQuery({
    queryKey: ["overview-comparison-sparklines", businessId, compStartDate, compEndDate],
    enabled:
      dateRangeReady &&
      compareMode !== "none" &&
      Boolean(compStartDate) &&
      Boolean(compEndDate),
    queryFn: () =>
      getOverviewSparklines(businessId, {
        startDate: compStartDate!,
        endDate: compEndDate!,
      }),
    staleTime: 15 * 60 * 1000,
  });

  const aiBriefQuery = useQuery({
    queryKey: ["ai-daily-brief", businessId],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    queryFn: () => getLatestAiInsight(businessId),
    staleTime: 15 * 60 * 1000,
  });

  const metaStatusQuery = useQuery({
    queryKey: ["meta-status", businessId],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getMetaStatusRefetchInterval(query.state.data as MetaStatusResponse | undefined),
    queryFn: () => fetchMetaStatus(businessId),
  });
  const googleAdsStatusQuery = useQuery({
    queryKey: ["google-ads-status", businessId],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getGoogleAdsStatusRefetchInterval(
        query.state.data as GoogleAdsStatusResponse | undefined
      ),
    queryFn: () => fetchGoogleAdsStatus(businessId),
  });
  const platformSyncPills = useMemo(
    () => ({
      meta: resolveProviderSyncStatusPill({
        provider: "meta",
        metaStatus: metaStatusQuery.data,
      }),
      google: resolveProviderSyncStatusPill({
        provider: "google",
        googleAdsStatus: googleAdsStatusQuery.data,
      }),
      google_ads: resolveProviderSyncStatusPill({
        provider: "google_ads",
        googleAdsStatus: googleAdsStatusQuery.data,
      }),
    }),
    [googleAdsStatusQuery.data, metaStatusQuery.data]
  );

  const handleRegenerateAiBrief = async () => {
    if (!businessId || aiBriefRegenerating) return;
    setAiBriefActionError(null);
    setAiBriefRegenerating(true);
    try {
      await generateAiInsight(businessId);
      await aiBriefQuery.refetch();
    } catch (error: unknown) {
      setAiBriefActionError(
        error instanceof Error ? error.message : "Could not regenerate AI brief."
      );
    } finally {
      setAiBriefRegenerating(false);
    }
  };

  // Merge sparklines into the summary once they arrive.
  // Uses the same formula the server-side route used to generate sparklines,
  // so ROAS and MER values are identical.
  const effectiveSummary = useMemo(() => {
    if (!query.data) return undefined;
    const withCurrent = sparklineQuery.data
      ? patchSummarySparklines(query.data, sparklineQuery.data)
      : query.data;
    return comparisonSparklineQuery.data
      ? patchSummaryComparisonSparklines(withCurrent, comparisonSparklineQuery.data)
      : withCurrent;
  }, [query.data, sparklineQuery.data, comparisonSparklineQuery.data]);

  // The data's own timestamp, read once so the chip on screen and the freshness
  // reading filed for this surface can never disagree.
  const dataAsOf = measuredAsOf(effectiveSummary?.shopifyServing?.lastSyncedAt ?? null);

  // One freshness contract across every Tier-0 surface. Derived from the
  // query state this surface already has, so it cannot drift from what is
  // actually on screen. It sits with the other hooks, above the early
  // returns below, so the hook count never changes between renders.
  useTierZeroFreshness({
    surface: "overview",
    isLoading: query.isLoading,
    isFetching: query.isFetching,
    error: query.error,
    // A provider we could not read is a hole in the totals, not a zero.
    // Every read this surface reports on. A failing sparkline used to leave
    // the state at "ready" while the trend charts rendered empty -- an absent
    // series is indistinguishable from a flat one, so a chart with no data
    // read as a real chart showing nothing happening.
    partialReason:
      metaStatusQuery.error || googleAdsStatusQuery.error
        ? "Some provider health could not be read; this view is incomplete"
        : sparklineQuery.error || comparisonSparklineQuery.error
          ? "Trend data could not be read; the charts are incomplete"
          : null,
    // The data's own timestamp. `dataUpdatedAt` is when the *response landed*,
    // which is fresh by construction: it resets on every refetch no matter how
    // far behind the sync is.
    asOf: dataAsOf,
    businessId: businessId || null,
    // Re-runs every read the reading covers. A retry that refetches only the
    // primary query leaves the reported hole exactly where it was, so the
    // button appears to do nothing and the partial state never clears.
    onRetry: () => {
      void query.refetch();
      if (metaStatusQuery.isError) void metaStatusQuery.refetch();
      if (googleAdsStatusQuery.isError) void googleAdsStatusQuery.refetch();
      if (sparklineQuery.isError) void sparklineQuery.refetch();
      if (comparisonSparklineQuery.isError) void comparisonSparklineQuery.refetch();
    },
  });

  // Charts show a pulsing skeleton while sparklines are loading.
  const chartsLoading = sparklineQuery.isLoading && !sparklineQuery.data;

  const symbol = currencySymbolFor(currency);
  // All render data reads from effectiveSummary so sparklines are reflected
  // as soon as the secondary query resolves.
  const metricCatalog = useMemo(
    () => buildOverviewMetricCatalog(effectiveSummary),
    [effectiveSummary]
  );
  const pinContextKey = `${workspaceOwnerId ?? "anonymous"}:${businessId}`;
  const storeMetrics = useMemo(
    () => filterVisibleMetrics(effectiveSummary?.storeMetrics ?? []),
    [effectiveSummary?.storeMetrics]
  );
  const ltvMetrics = useMemo(
    () => filterVisibleMetrics(effectiveSummary?.ltv ?? []),
    [effectiveSummary?.ltv]
  );
  const customMetrics = useMemo(
    () => filterVisibleMetrics(effectiveSummary?.customMetrics ?? []),
    [effectiveSummary?.customMetrics]
  );
  const webAnalyticsMetrics = useMemo(
    () => filterVisibleMetrics(effectiveSummary?.webAnalytics ?? []),
    [effectiveSummary?.webAnalytics]
  );
  const platformSections = useMemo(
    () =>
      (effectiveSummary?.platforms ?? [])
        .map((platform) => ({
          ...platform,
          metrics: filterVisibleMetrics(platform.metrics),
        }))
        .filter((platform) => platform.metrics.length > 0),
    [effectiveSummary?.platforms]
  );

  // Design decision D6: the six-card pin wall becomes one hero KPI plus four
  // supporting tiles. The pin order still decides which metrics appear, so the
  // pin picker keeps driving the band instead of being replaced by it.
  const pinnedByContext = usePreferencesStore((state) => state.overviewPinsByContext);
  const setOverviewPins = usePreferencesStore((state) => state.setOverviewPins);
  const storedPins = pinnedByContext[pinContextKey];

  useEffect(() => {
    if (metricCatalog.length === 0) return;
    const legacyDashboardPins = [
      "revenue",
      "spend",
      "mer",
      "blended_roas",
      "conversion_rate",
      "orders",
    ];
    const isLegacyDefault =
      storedPins?.length === legacyDashboardPins.length &&
      legacyDashboardPins.every((key, index) => storedPins[index] === key);
    if ((storedPins ?? []).length > 0 && !isLegacyDefault) return;
    const defaults = DEFAULT_PINNED_METRICS.filter((key) =>
      metricCatalog.some((entry) => entry.key === key)
    );
    if (defaults.length > 0) setOverviewPins(pinContextKey, defaults);
  }, [metricCatalog, pinContextKey, setOverviewPins, storedPins]);

  const pinnedKeys = useMemo(
    () => (storedPins ?? []).filter((key) => metricCatalog.some((entry) => entry.key === key)),
    [metricCatalog, storedPins]
  );
  const pinnedMetrics = useMemo(
    () =>
      pinnedKeys
        .map((key) => metricCatalog.find((entry) => entry.key === key)?.metric)
        .filter((metric): metric is OverviewMetricCardData => Boolean(metric)),
    [metricCatalog, pinnedKeys]
  );
  const heroMetric = pinnedMetrics[0] ?? null;
  const heroTiles = pinnedMetrics.slice(1, 5);
  const storeAndCustomerMetrics = useMemo(
    () => [...storeMetrics, ...ltvMetrics],
    [ltvMetrics, storeMetrics]
  );
  const windowDayCount = useMemo(() => {
    if (!startDate || !endDate) return null;
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.round((end - start) / 86_400_000) + 1;
  }, [endDate, startDate]);

  // Report definitions only accept 7/30/90; snap the live window to the nearest.
  const snapshotRangePreset: "7" | "30" | "90" =
    windowDayCount === null || windowDayCount <= 14
      ? "7"
      : windowDayCount <= 60
        ? "30"
        : "90";

  // Both guards sit below every hook on purpose. Returning above the useMemo
  // block changes the hook count between renders and React tears the tree down
  // with "Rendered fewer hooks than expected" the moment a business is picked
  // or a request fails.
  if (!selectedBusinessId) return <BusinessEmptyState />;

  if (query.isError) {
    const errorMessage =
      query.error instanceof Error ? query.error.message : "The request failed. Please try again.";
    return <ErrorState description={errorMessage} onRetry={() => query.refetch()} />;
  }

  return (
    <section className="flex flex-col gap-5">
      <div className="adv-page-head">
        <div>
          <p className="adv-eyebrow">Home</p>
          <h1 className="adv-h1">Overview</h1>
          <p className="adv-sub">
            {activeBusiness?.name ?? "Workspace"} · {currency} · All figures for the
            selected {windowDayCount === null ? "" : `${windowDayCount}-day `}window.
          </p>
        </div>
        <div className="flex flex-wrap items-center gap-2">
          {/* Overview gave no cue at all about how old these numbers were, so a
              tab left open since morning looked identical to a fresh load. The
              chip states the age of the data itself and offers a refetch — not
              a page reload, which would throw away every other query on screen. */}
          <FreshnessChip
            asOf={dataAsOf}
            onRefresh={() => void query.refetch()}
            refreshing={query.isFetching}
            surface="overview"
            businessId={businessId || null}
          />
          <button
            type="button"
            className="adv-btn"
            onClick={() => setCostModelSheetOpen(true)}
          >
            {effectiveSummary?.costModel.configured ? "Edit cost model" : "Set cost model"}
          </button>
          {/* Design's primary Overview CTA — always last in the action cluster. */}
          <ShareSnapshotButton
            businessId={businessId}
            businessName={activeBusiness?.name ?? null}
            rangePreset={snapshotRangePreset}
            compareMode={compareMode}
          />
        </div>
      </div>

      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]">
        {query.isLoading ? (
          Array.from({ length: 5 }).map((_, index) => (
            <div
              key={index}
              className={cn(
                "adv-card animate-pulse",
                index === 0 ? "sm:col-span-2" : "",
              )}
              style={{ minHeight: 170 }}
            />
          ))
        ) : heroMetric ? (
          <>
            <HeroMetricCard metric={heroMetric} currencySymbol={symbol} />
            {heroTiles.map((metric, index) => (
              <HeroTile
                key={metric.id}
                metric={metric}
                currencySymbol={symbol}
                index={index}
              />
            ))}
          </>
        ) : (
          <article className="adv-card p-4 sm:col-span-2">
            <p className="adv-label">Headline metrics</p>
            <p className="mt-2 text-[13px] text-[var(--adv-ink-2)]">
              No pinned metric is available for this window yet.
            </p>
          </article>
        )}
      </div>

      {/* Anchor for the "view breakdown" jump; kept out of the grid flow so it
          does not consume a column. */}
      <span id="attribution" className="sr-only" aria-hidden="true" />
      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(380px,1fr))]">
        <AttributionCard
          rows={effectiveSummary?.attribution ?? []}
          currencySymbol={symbol}
          loading={query.isLoading}
        />
        <AiBriefCard
          insight={aiBriefQuery.data}
          loading={aiBriefQuery.isLoading}
          error={
            aiBriefActionError ??
            (aiBriefQuery.error instanceof Error ? aiBriefQuery.error.message : null)
          }
          onRegenerate={handleRegenerateAiBrief}
          regenerating={aiBriefRegenerating}
        />
      </div>

      {platformSections.length > 0 ? (
        <div className="grid items-stretch gap-3 md:grid-cols-2">
          {platformSections.map((platform, index) => (
            <PlatformMiniDashboard
              key={`${platform.id}-${platform.provider}-${index}`}
              provider={platform.provider}
              title={platform.title}
              metrics={platform.metrics}
              currencySymbol={symbol}
              syncPill={
                platformSyncPills[platform.provider as keyof typeof platformSyncPills] ?? null
              }
            />
          ))}
        </div>
      ) : null}

      {/* The design closes Overview on exactly two cards. Cost-model economics
          live on Commercial Truth, not here. */}
      <div className="grid items-start gap-3 [grid-template-columns:repeat(auto-fit,minmax(380px,1fr))]">
        <TileCard
          title="Store &amp; customer value"
          metrics={storeAndCustomerMetrics}
          currencySymbol={symbol}
          emptyNote="No store metrics for this window yet."
        />
        <TileCard
          title="Web analytics · GA4"
          metrics={webAnalyticsMetrics}
          currencySymbol={symbol}
          emptyNote="Connect Google Analytics 4 to fill this card."
        />
      </div>

      <CostModelSheet
        open={costModelSheetOpen}
        onOpenChange={setCostModelSheetOpen}
        initialValue={effectiveSummary?.costModel.values ?? null}
        onSave={async (input) => {
          await upsertBusinessCostModel({
            businessId,
            ...input,
          });
          await query.refetch();
        }}
      />
    </section>
  );
}

/** Card of compact stat tiles — the Store / Web-analytics pattern. */
function TileCard({
  title,
  metrics,
  currencySymbol,
  emptyNote,
}: {
  title: string;
  metrics: OverviewMetricCardData[];
  currencySymbol: string;
  emptyNote: string;
}) {
  return (
    <article className="adv-card p-4">
      <h2 className="adv-card-title mb-3">{title}</h2>
      {metrics.length === 0 ? (
        <p className="m-0 text-[12.5px] leading-[1.55] text-[var(--adv-ink-3)]">{emptyNote}</p>
      ) : (
        <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))]">
          {metrics.map((metric) => (
            <StatTile key={metric.id} metric={metric} currencySymbol={currencySymbol} />
          ))}
        </div>
      )}
    </article>
  );
}

function filterVisibleMetrics(metrics: OverviewMetricCardData[]) {
  return metrics.filter((metric) => metric.status !== "unavailable");
}



// ---------------------------------------------------------------------------
// Sparkline patching — runs client-side once the secondary query resolves.
// Formulas mirror the server-side overview-summary route exactly so ROAS/MER
// values are always consistent.
// ---------------------------------------------------------------------------

type SparklinePoint = { date: string; value: number };

function rv(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function buildSparklineMap(
  bundle: SparklineBundle,
  costModel: BusinessCostModelData | null
): Record<string, SparklinePoint[]> {
  const { combined, providerTrends, ga4Daily } = bundle;

  const spendSeries = combined.map((p) => ({ date: p.date, value: rv(p.spend) }));
  const revenueSeries = combined.map((p) => ({ date: p.date, value: rv(p.revenue) }));
  const purchaseSeries = combined.map((p) => ({ date: p.date, value: rv(p.purchases) }));
  const merSeries = combined.map((p) => ({
    date: p.date,
    value: p.spend > 0 ? rv(p.revenue / p.spend) : 0,
  }));
  const blendedCpaSeries = combined.map((p) => ({
    date: p.date,
    value: p.purchases > 0 ? rv(p.spend / p.purchases) : 0,
  }));

  // GA4 daily derived series
  const ga4AovSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: p.purchases > 0 ? rv(p.revenue / p.purchases) : 0,
  }));
  const ga4ConvRateSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: p.sessions > 0 ? rv((p.purchases / p.sessions) * 100, 4) : 0,
  }));
  const ga4NewCustomersSeries = ga4Daily.map((p) => ({ date: p.date, value: rv(p.firstTimePurchasers) }));
  const ga4ReturningCustomersSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: rv(Math.max(p.totalPurchasers - p.firstTimePurchasers, 0)),
  }));
  const ga4RevenuePerCustomerSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: p.totalPurchasers > 0 ? rv(p.revenue / p.totalPurchasers) : 0,
  }));
  const ga4RepeatRateSeries = ga4Daily.map((p) => ({
    date: p.date,
    value:
      p.totalPurchasers > 0
        ? rv((Math.max(p.totalPurchasers - p.firstTimePurchasers, 0) / p.totalPurchasers) * 100, 4)
        : 0,
  }));
  const ga4SessionsSeries = ga4Daily.map((p) => ({ date: p.date, value: rv(p.sessions) }));
  const ga4EngagementSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: rv(p.engagementRate * 100, 4),
  }));
  const ga4SessionDurationSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: rv(p.avgSessionDuration),
  }));

  const aovSeries = ga4AovSeries.length > 0
    ? ga4AovSeries
    : combined.map((p) => ({
        date: p.date,
        value: p.purchases > 0 ? rv(p.revenue / p.purchases) : 0,
      }));

  const ltvCacSeries = ga4RevenuePerCustomerSeries.map((point, i) => ({
    date: point.date,
    value: blendedCpaSeries[i] && blendedCpaSeries[i].value > 0
      ? rv(point.value / blendedCpaSeries[i].value)
      : 0,
  }));

  // Cost-model dependent sparklines
  const cm = costModel;
  const totalExpensesSeries: SparklinePoint[] = cm
    ? revenueSeries.map((point, i) => ({
        date: point.date,
        value: rv(
          (spendSeries[i]?.value ?? 0) +
            point.value * (cm.cogsPercent + cm.shippingPercent + cm.feePercent) +
            cm.fixedCost
        ),
      }))
    : spendSeries;

  const netProfitSeries: SparklinePoint[] = cm
    ? revenueSeries.map((point, i) => ({
        date: point.date,
        value: rv(
          point.value -
            ((spendSeries[i]?.value ?? 0) +
              point.value * (cm.cogsPercent + cm.shippingPercent + cm.feePercent) +
              cm.fixedCost)
        ),
      }))
    : [];

  const contributionMarginSeries: SparklinePoint[] = cm
    ? revenueSeries.map((point, i) => {
        const spendVal = spendSeries[i]?.value ?? 0;
        const varCost =
          spendVal + point.value * (cm.cogsPercent + cm.shippingPercent + cm.feePercent);
        return {
          date: point.date,
          value: point.value > 0 ? rv(((point.value - varCost) / point.value) * 100) : 0,
        };
      })
    : [];

  // Per-provider sparklines (meta, google)
  const providerSparklines: Record<string, SparklinePoint[]> = {};
  for (const [provider, trends] of Object.entries(providerTrends)) {
    if (!trends) continue;
    providerSparklines[`${provider}-spend`] = trends.map((p) => ({ date: p.date, value: rv(p.spend) }));
    providerSparklines[`${provider}-revenue`] = trends.map((p) => ({ date: p.date, value: rv(p.revenue) }));
    providerSparklines[`${provider}-roas`] = trends.map((p) => ({
      date: p.date,
      value: p.spend > 0 ? rv(p.revenue / p.spend) : 0,
    }));
    providerSparklines[`${provider}-purchases`] = trends.map((p) => ({
      date: p.date,
      value: rv(p.purchases),
    }));
    providerSparklines[`${provider}-cpa`] = trends.map((p) => ({
      date: p.date,
      value: p.purchases > 0 ? rv(p.spend / p.purchases) : 0,
    }));
  }

  return {
    "pins-revenue": revenueSeries,
    "pins-spend": spendSeries,
    "pins-mer": merSeries,
    "pins-blended-roas": merSeries,
    "pins-conversion-rate": ga4ConvRateSeries,
    "pins-orders": purchaseSeries,
    "store-aov": aovSeries,
    "store-conversion-rate": ga4ConvRateSeries,
    "store-new-customers": ga4NewCustomersSeries,
    "store-returning-customers": ga4ReturningCustomersSeries,
    "ltv-average": ga4RevenuePerCustomerSeries,
    "ltv-cac": ltvCacSeries,
    "ltv-repeat-rate": ga4RepeatRateSeries,
    "ltv-revenue-per-customer": ga4RevenuePerCustomerSeries,
    "expenses-ad-spend": spendSeries,
    "expenses-total-tracked": totalExpensesSeries,
    "expenses-net-profit": netProfitSeries,
    "expenses-contribution-margin": contributionMarginSeries,
    "expenses-mer": merSeries,
    "custom-mer": merSeries,
    "custom-blended-cpa": blendedCpaSeries,
    "web-sessions": ga4SessionsSeries,
    "web-session-duration": ga4SessionDurationSeries,
    "web-engagement-rate": ga4EngagementSeries,
    ...providerSparklines,
  };
}

function patchCard(
  card: OverviewMetricCardData,
  sparkMap: Record<string, SparklinePoint[]>
): OverviewMetricCardData {
  const patches = sparkMap[card.id];
  if (!patches || patches.length === 0) return card;
  return { ...card, sparklineData: patches };
}

function patchCardComparison(
  card: OverviewMetricCardData,
  sparkMap: Record<string, SparklinePoint[]>
): OverviewMetricCardData {
  const patches = sparkMap[card.id];
  if (!patches || patches.length === 0) return card;
  return { ...card, previousSparklineData: patches };
}

function patchSummarySparklines(
  summary: OverviewSummaryData,
  bundle: SparklineBundle
): OverviewSummaryData {
  const sparkMap = buildSparklineMap(bundle, summary.costModel.values);
  return {
    ...summary,
    pins: summary.pins.map((m) => patchCard(m, sparkMap)),
    storeMetrics: summary.storeMetrics.map((m) => patchCard(m, sparkMap)),
    ltv: summary.ltv.map((m) => patchCard(m, sparkMap)),
    expenses: summary.expenses.map((m) => patchCard(m, sparkMap)),
    customMetrics: summary.customMetrics.map((m) => patchCard(m, sparkMap)),
    webAnalytics: summary.webAnalytics.map((m) => patchCard(m, sparkMap)),
    platforms: summary.platforms.map((platform) => ({
      ...platform,
      metrics: platform.metrics.map((m) => patchCard(m, sparkMap)),
    })),
  };
}

function patchSummaryComparisonSparklines(
  summary: OverviewSummaryData,
  bundle: SparklineBundle
): OverviewSummaryData {
  const sparkMap = buildSparklineMap(bundle, summary.costModel.values);
  return {
    ...summary,
    pins: summary.pins.map((m) => patchCardComparison(m, sparkMap)),
    storeMetrics: summary.storeMetrics.map((m) => patchCardComparison(m, sparkMap)),
    ltv: summary.ltv.map((m) => patchCardComparison(m, sparkMap)),
    expenses: summary.expenses.map((m) => patchCardComparison(m, sparkMap)),
    customMetrics: summary.customMetrics.map((m) => patchCardComparison(m, sparkMap)),
    webAnalytics: summary.webAnalytics.map((m) => patchCardComparison(m, sparkMap)),
    platforms: summary.platforms.map((platform) => ({
      ...platform,
      metrics: platform.metrics.map((m) => patchCardComparison(m, sparkMap)),
    })),
  };
}
