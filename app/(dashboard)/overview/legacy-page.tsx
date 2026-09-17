"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { usePathname, useRouter } from "next/navigation";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { ErrorState } from "@/components/states/error-state";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { compareModeForPreset } from "@/lib/comparison-preset-contract";
import { AiBriefCard } from "@/components/overview/v2/ai-brief-card";
import { MetaMorningCard } from "@/components/overview/v2/meta-morning-card";
import type { MetaDailyBrief } from "@/lib/meta/daily-brief";
import { SourceHealthPanel } from "@/components/zero-base/home/source-health";
import { TrendPanel } from "@/components/zero-base/home/trend-panel";
import { EconomicsContext } from "@/components/zero-base/home/economics-context";
import {
  buildOverviewSourceHealth,
} from "@/lib/zero-base/home/overview-source-health";
import type { EconomicsContextModel } from "@/lib/zero-base/home/economics-context";
import { AttributionCard } from "@/components/overview/v2/attribution-card";
import { StatTile } from "@/components/overview/v2/metric-band";
import { CustomizableKpiBand } from "@/components/overview/v2/customizable-kpi-band";
import { PlatformMiniDashboard } from "@/components/overview/v2/platform-card";
import {
  OVERVIEW_PROVIDER_METRIC_SPECS,
  buildBlendedProviderRoasSeries,
  buildPaidProviderSpendSeries,
  buildProviderMetricSeries,
  providerForMetricId,
  providerMetricId,
  providerScalarSourceSetsComparable,
  providerScalarSourcesComparable,
  providerTrendMatchesScalar,
} from "@/lib/overview-provider-metrics";
import { ShareSnapshotButton } from "@/components/overview/v2/share-snapshot-button";
import { OverviewCustomizeBar } from "@/components/overview/v2/overview-customize-bar";
import { useOverviewCustomization } from "@/components/overview/v2/use-overview-customization";
import {
  OverviewLayout,
  useOverviewLayoutPreference,
  type OverviewLayoutContent,
} from "@/components/overview/v2/overview-layout";
import overviewStyles from "@/components/overview/v2/overview-layout.module.css";
import { getPresetDatesForReferenceDate, getTodayIsoForTimeZone } from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { usePreferencesHydrated } from "@/hooks/persistent-date-range-support";
import { currencySymbolFor } from "@/lib/metric-format";
import {
  buildOverviewMetricCatalog,
  DEFAULT_PINNED_METRICS,
} from "@/lib/overview-metric-catalog";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import { useAppStore } from "@/store/app-store";
import { usePreferencesStore } from "@/store/preferences-store";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import { getGoogleAdsStatusRefetchInterval } from "@/lib/google-ads/sync-progress-ux";
import {
  getOverviewSummary,
  getOverviewSparklines,
  getLatestAiInsight,
  generateAiInsight,
  type SparklineBundle,
} from "@/src/services";
import type {
  BusinessCostModelData,
  OverviewAttributionRow,
  OverviewMetricCardData,
  OverviewMetricUnit,
  OverviewPaidProviderScope,
  OverviewPlatformSection,
  OverviewProviderSourceMap,
  OverviewSummaryData,
} from "@/src/types/models";

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
      (payload as { message?: string } | null)?.message ?? `Meta status request failed (${response.status})`
    );
  }
  return payload as MetaStatusResponse;
}

/**
 * Which sources this business has connected.
 *
 * The same read `/api/integrations/status` has always served; this page simply
 * never asked. Without it the readiness panel would have to infer connectedness
 * from whether a metric happened to be non-zero, which is the inference the
 * whole panel exists to remove.
 */
async function fetchIntegrationStatus(
  businessId: string,
): Promise<Record<string, boolean>> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(`/api/integrations/status?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { error?: string } | null)?.error ??
        `Integration status request failed (${response.status})`,
    );
  }
  return (payload ?? {}) as Record<string, boolean>;
}

/**
 * The Commercial Truth target pack, for the economics context.
 *
 * Break-even and target ROAS are READ, never derived. They could be computed
 * from the cost model this page already holds — break-even is a function of
 * COGS, shipping and fees — and computing them here would put a second
 * economic boundary in the product beside the one the decision engine
 * consumes. INVARIANTS is explicit that a break-even must be the explicit one.
 */
async function fetchCommercialSnapshot(businessId: string): Promise<{
  targetPack?: { breakEvenRoas?: number | null; targetRoas?: number | null } | null;
} | null> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(
    `/api/business-commercial-settings?${params.toString()}`,
    { cache: "no-store", headers: { Accept: "application/json" } },
  );
  if (!response.ok) return null;
  const payload = (await response.json().catch(() => null)) as {
    snapshot?: {
      targetPack?: { breakEvenRoas?: number | null; targetRoas?: number | null } | null;
    } | null;
  } | null;
  return payload?.snapshot ?? null;
}

async function fetchGoogleAdsStatus(businessId: string): Promise<GoogleAdsStatusResponse> {
  const params = new URLSearchParams({ businessId });
  const response = await fetch(`/api/google-ads/status?${params.toString()}`, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ?? `Google Ads status request failed (${response.status})`
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

type FixedMetricSpec = {
  id: string;
  title: string;
  unit: OverviewMetricUnit;
  icon?: string;
};

const SHOPIFY_STORE_SPECS: FixedMetricSpec[] = [
  { id: "store-aov", title: "AOV", unit: "currency" },
  { id: "store-gross-sales", title: "Gross Sales", unit: "currency" },
  { id: "store-refunded-revenue", title: "Refunded Revenue", unit: "currency" },
  { id: "store-refund-rate", title: "Refund Rate", unit: "percent" },
];

const GA4_FALLBACK_STORE_SPECS: FixedMetricSpec[] = [
  { id: "store-aov", title: "AOV", unit: "currency" },
  { id: "store-new-customers", title: "New customers", unit: "count" },
  { id: "ltv-repeat-rate", title: "Repeat rate", unit: "percent" },
  { id: "ltv-cac", title: "LTV : CAC", unit: "ratio" },
];

const WEB_SPECS: FixedMetricSpec[] = [
  { id: "web-sessions", title: "Sessions", unit: "count" },
  { id: "web-engagement-rate", title: "Engagement", unit: "percent" },
  {
    id: "web-session-duration",
    title: "Avg session",
    unit: "duration_seconds",
  },
  { id: "web-conversion-rate", title: "Conv rate", unit: "percent" },
];

const DEFAULT_KPI_CANDIDATES = [
  ...DEFAULT_PINNED_METRICS,
  "aov",
  "mer",
  "sessions",
];

const PLATFORM_SPECS = [
  { provider: "meta", title: "Meta Ads" },
  { provider: "google", title: "Google Ads" },
] as const;


function unavailableMetric(spec: FixedMetricSpec): OverviewMetricCardData {
  return {
    id: spec.id,
    title: spec.title,
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
    unit: spec.unit,
    icon: spec.icon,
  };
}

function fixedMetrics(sources: OverviewMetricCardData[] | undefined, specs: FixedMetricSpec[]) {
  return specs.map((spec) => {
    const metric = sources?.find((candidate) => candidate.id === spec.id);
    if (!metric) return unavailableMetric(spec);
    return {
      ...metric,
      title: spec.id === "pins-blended-roas" && metric.title.startsWith("Blended ROAS") ? metric.title : spec.title,
      unit: spec.unit,
      icon: spec.icon ?? metric.icon,
    };
  });
}

function emptyAttributionRow(channel: string, source: string): OverviewAttributionRow {
  return {
    channel,
    spend: null,
    spendShare: null,
    revenue: null,
    roas: null,
    conversions: null,
    clicks: null,
    ctr: null,
    cpa: null,
    aov: null,
    source,
  };
}

function fixedAttributionRows(rows: OverviewAttributionRow[] | undefined) {
  const find = (pattern: RegExp) => rows?.find((row) => pattern.test(row.channel));
  return [
    find(/meta/i) ?? emptyAttributionRow("Meta Ads", "No synced provider attribution data"),
    find(/google/i) ?? emptyAttributionRow("Google Ads", "No synced provider attribution data"),
    find(/klaviyo/i) ?? emptyAttributionRow("Klaviyo", "No verified Klaviyo attribution contract"),
    find(/organic|ga4/i) ?? emptyAttributionRow("Organic · GA4", "GA4"),
  ];
}

function fixedPlatformSections(sections: OverviewPlatformSection[] | undefined) {
  return PLATFORM_SPECS.map(({ provider, title }) => {
    const source = sections?.find((section) => {
      const normalized = section.provider === "google_ads" ? "google" : section.provider;
      return normalized === provider;
    });
    // Exact ids only: suffix or title matching would let `google-conversion-rate`
    // or a relabelled "Conversions" card fill the wrong provider slot.
    const metrics = OVERVIEW_PROVIDER_METRIC_SPECS[provider].map((spec) => {
      const id = providerMetricId(provider, spec.suffix);
      const metric = source?.metrics.find((candidate) => candidate.id === id);
      return metric
        ? { ...metric, id, title: spec.title, unit: spec.unit }
        : unavailableMetric({ id, title: spec.title, unit: spec.unit });
    });
    return {
      id: provider,
      provider,
      title,
      metrics,
    } satisfies OverviewPlatformSection;
  });
}

export default function OverviewPage() {
  const pathname = usePathname();
  const router = useRouter();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const workspaceOwnerId = useAppStore((state) => state.workspaceOwnerId);
  const businessId = selectedBusinessId ?? "";
  const activeBusiness = useMemo(
    () => businesses.find((business) => business.id === selectedBusinessId) ?? null,
    [businesses, selectedBusinessId]
  );

  const [dateRange] = usePersistentDateRange();
  // The summary fan-out is expensive, so it waits for the stored range to
  // settle instead of firing once for the default window and again for it.
  const dateRangeReady = usePreferencesHydrated();
  const currency = activeBusiness?.currency?.trim() || null;
  const workspaceTimeZone = activeBusiness?.timezone ?? "UTC";
  const workspaceReferenceDate = useMemo(() => getTodayIsoForTimeZone(workspaceTimeZone), [workspaceTimeZone]);
  const [aiBriefRegenerating, setAiBriefRegenerating] = useState(false);
  const [aiBriefActionError, setAiBriefActionError] = useState<string | null>(null);

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
    compareModeForPreset(dateRange.comparisonPreset) === "previous_period" ? "previous_period" : "none";

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
    enabled: dateRangeReady && compareMode !== "none" && Boolean(compStartDate) && Boolean(compEndDate),
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

  /*
    The Meta morning read.

    It is a plain read of what the producers already wrote, so it needs no
    mutation and no refresh button: what it reports is decided by the overnight
    jobs, not by this page.
  */
  const metaBriefQuery = useQuery({
    queryKey: ["meta-daily-brief", businessId],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const response = await fetch(
        `/api/meta/daily-brief?businessId=${encodeURIComponent(businessId)}`,
      );
      const payload = (await response.json().catch(() => null)) as
        { ok?: boolean; brief?: MetaDailyBrief; error?: { code?: string } } | null;
      if (!response.ok || !payload?.ok || !payload.brief) {
        throw new Error(payload?.error?.code ?? "meta_brief_unavailable");
      }
      return payload.brief;
    },
  });

  const metaStatusQuery = useQuery({
    queryKey: ["meta-status", businessId],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    staleTime: 30 * 1000,
    refetchInterval: (query) => getMetaStatusRefetchInterval(query.state.data as MetaStatusResponse | undefined),
    queryFn: () => fetchMetaStatus(businessId),
  });
  /*
   * The two reads the readiness panel and the economics context need.
   *
   * Both are cheap, both are already-authorized routes, and both are cached
   * long enough that they cost one request per page rather than one per render.
   * Neither blocks the queue: an integrations read that fails leaves the panel
   * saying the READ failed, which is a different sentence from "not connected".
   */
  const integrationStatusQuery = useQuery({
    queryKey: ["overview-integration-status", businessId],
    enabled: Boolean(selectedBusinessId),
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchIntegrationStatus(businessId),
  });
  const commercialSnapshotQuery = useQuery({
    queryKey: ["overview-commercial-snapshot", businessId],
    enabled: Boolean(selectedBusinessId),
    staleTime: 5 * 60 * 1000,
    queryFn: () => fetchCommercialSnapshot(businessId),
  });
  const googleAdsStatusQuery = useQuery({
    queryKey: ["google-ads-status", businessId],
    enabled: Boolean(selectedBusinessId) && dateRangeReady,
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getGoogleAdsStatusRefetchInterval(query.state.data as GoogleAdsStatusResponse | undefined),
    queryFn: () => fetchGoogleAdsStatus(businessId),
  });
  const handleRegenerateAiBrief = async () => {
    if (!businessId || aiBriefRegenerating) return;
    setAiBriefActionError(null);
    setAiBriefRegenerating(true);
    try {
      await generateAiInsight(businessId);
      await aiBriefQuery.refetch();
    } catch (error: unknown) {
      setAiBriefActionError(error instanceof Error ? error.message : "Could not regenerate AI brief.");
    } finally {
      setAiBriefRegenerating(false);
    }
  };

  // Merge sparklines into the summary once they arrive.
  // Uses the same source-specific formulas as the server-side route: MER is
  // store revenue / ad spend, while Blended ROAS is provider-attributed
  // conversion value / the matching provider spend.
  const effectiveSummary = useMemo(() => {
    if (!query.data) return undefined;
    const withCurrent = sparklineQuery.data ? patchSummarySparklines(query.data, sparklineQuery.data) : query.data;
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

  const symbol = currencySymbolFor(currency);
  const metricCatalog = useMemo(
    () => buildOverviewMetricCatalog(effectiveSummary, { includeUnavailable: true }),
    [effectiveSummary],
  );
  const pinContextKey = workspaceOwnerId && businessId ? `${workspaceOwnerId}:${businessId}` : null;
  const overviewPinsByContext = usePreferencesStore((state) => state.overviewPinsByContext);
  const setOverviewPins = usePreferencesStore((state) => state.setOverviewPins);
  const clearOverviewPins = usePreferencesStore((state) => state.clearOverviewPins);
  const hasStoredPins = Boolean(
    pinContextKey && Object.prototype.hasOwnProperty.call(overviewPinsByContext, pinContextKey),
  );
  const storedPins = pinContextKey && hasStoredPins
    ? overviewPinsByContext[pinContextKey] ?? []
    : undefined;
  const defaultPinKeys = useMemo(() => {
    const catalogKeys = new Set(metricCatalog.map((entry) => entry.key));
    // Keep the stable headline surfaces even when a source read fails. The
    // card must explain missing data; silently dropping it makes the band look
    // complete and prevents the owner from customizing that slot.
    return DEFAULT_KPI_CANDIDATES.filter((key) => catalogKeys.has(key)).slice(0, 5);
  }, [metricCatalog]);

  // Defaults are never written on first view: an unsaved context keeps
  // following the current defaults until the owner saves a choice.
  const selectedPinKeys = storedPins ?? defaultPinKeys;
  const { layout: savedOverviewLayout, saveLayout } = useOverviewLayoutPreference(businessId);
  const customization = useOverviewCustomization({
    context: `${pinContextKey ?? "anonymous"}|${businessId}`,
    savedKpiKeys: selectedPinKeys,
    defaultKpiKeys: defaultPinKeys,
    savedLayout: savedOverviewLayout,
    onSaveKpis: (keys) => {
      if (pinContextKey) setOverviewPins(pinContextKey, keys);
    },
    onRestoreKpiDefaults: () => {
      if (pinContextKey) clearOverviewPins(pinContextKey);
    },
    onSaveLayout: saveLayout,
  });
  const customizationReady = Boolean(dateRangeReady && pinContextKey && metricCatalog.length);
  const customizing = customization.editing;
  // Customize is the single entry point; focus returns to it when a session ends.
  const customizeButtonRef = useRef<HTMLButtonElement>(null);
  const returnFocusAfterCustomize = useRef(false);
  useEffect(() => {
    if (customizing || !returnFocusAfterCustomize.current) return;
    returnFocusAfterCustomize.current = false;
    customizeButtonRef.current?.focus();
  }, [customizing]);
  const startCustomize = () => {
    if (!customizationReady) return;
    returnFocusAfterCustomize.current = true;
    customization.start();
  };
  const storeAovSourceKey = effectiveSummary?.storeMetrics.find((metric) => metric.id === "store-aov")?.dataSource.key;
  const shopifyStorePrimary = storeAovSourceKey?.startsWith("shopify") ?? false;
  const ga4StoreFallback = storeAovSourceKey === "ga4_fallback";
  const storeAndCustomerMetrics = useMemo(() => {
    const metrics = [...(effectiveSummary?.storeMetrics ?? []), ...(effectiveSummary?.ltv ?? [])];
    return fixedMetrics(metrics, ga4StoreFallback ? GA4_FALLBACK_STORE_SPECS : SHOPIFY_STORE_SPECS);
  }, [effectiveSummary?.ltv, effectiveSummary?.storeMetrics, ga4StoreFallback]);
  const webAnalyticsMetrics = useMemo(
    () => fixedMetrics(effectiveSummary?.webAnalytics, WEB_SPECS),
    [effectiveSummary?.webAnalytics]
  );
  const attributionRows = useMemo(
    () => fixedAttributionRows(effectiveSummary?.attribution),
    [effectiveSummary?.attribution]
  );
  const platformSections = useMemo(
    () => fixedPlatformSections(effectiveSummary?.platforms),
    [effectiveSummary?.platforms]
  );
  const providerDateDomain = effectiveSummary?.dateRange;
  const providerPreviousDateDomain =
    effectiveSummary?.comparison.startDate && effectiveSummary.comparison.endDate
      ? {
          startDate: effectiveSummary.comparison.startDate,
          endDate: effectiveSummary.comparison.endDate,
        }
      : undefined;
  const windowDayCount = useMemo(() => {
    if (!startDate || !endDate) return null;
    const start = Date.parse(`${startDate}T00:00:00Z`);
    const end = Date.parse(`${endDate}T00:00:00Z`);
    if (!Number.isFinite(start) || !Number.isFinite(end)) return null;
    return Math.round((end - start) / 86_400_000) + 1;
  }, [endDate, startDate]);

  // Report definitions only accept 7/30/90; snap the live window to the nearest.
  const snapshotRangePreset: "7" | "30" | "90" =
    windowDayCount === null || windowDayCount <= 14 ? "7" : windowDayCount <= 60 ? "30" : "90";

  /*
   * Source readiness, the trend series and the economics context.
   *
   * All three are built from reads this page performs; none is derived from a
   * metric's value. `useMemo` because the panel re-renders on every query tick
   * and rebuilding five source rows per tick would churn the list for nothing.
   */
  const sourceHealth = useMemo(
    () =>
      buildOverviewSourceHealth({
        integrations: integrationStatusQuery.data ?? null,
        latestSync: {
          meta: metaStatusQuery.data?.latestSync?.finishedAt ?? null,
          google: googleAdsStatusQuery.data?.latestSync?.finishedAt ?? null,
        },
        now: Date.now(),
      }),
    [
      integrationStatusQuery.data,
      metaStatusQuery.data?.latestSync?.finishedAt,
      googleAdsStatusQuery.data?.latestSync?.finishedAt,
    ],
  );
  const trendPoints = useMemo(
    () => sourceSafeOverviewTrendPoints(sparklineQuery.data, effectiveSummary),
    [effectiveSummary, sparklineQuery.data],
  );
  const sourceAttentionCount = sourceHealth.filter((source) => source.state !== "ok").length;
  /*
   * Null when the target pack was not read.
   *
   * An unread pack is not "break-even 0" and not "no economics" — the panel is
   * simply absent rather than stating a boundary nobody served. `diverges` is
   * false because this page has no comparison to make: it reads the pack and
   * the cost model separately and states both, which is what the panel is for.
   */
  const economics: EconomicsContextModel | null = commercialSnapshotQuery.data
    ? {
        breakEvenRoas:
          commercialSnapshotQuery.data.targetPack?.breakEvenRoas ?? null,
        targetRoas: commercialSnapshotQuery.data.targetPack?.targetRoas ?? null,
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
  const integrationsHref = dashboardHrefForRouteFamily(
    "/manage/integrations",
    pathname,
  );


  if (!selectedBusinessId) return <BusinessEmptyState />;

  if (query.isError) {
    const errorMessage = query.error instanceof Error ? query.error.message : "The request failed. Please try again.";
    return <ErrorState description={errorMessage} onRetry={() => query.refetch()} />;
  }

  const overviewLayoutItems: OverviewLayoutContent[] = [
    {
      id: "trend",
      content: (
        <TrendPanel
          currency={currency ?? null}
          points={trendPoints}
          surface="overview"
          targetRoas={economics?.targetRoas ?? null}
          title={overviewTrendTitle(effectiveSummary)}
        />
      ),
    },
    ...(economics
      ? [
          {
            id: "economics" as const,
            content: <EconomicsContext businessId={businessId} model={economics} />,
          },
        ]
      : []),
    {
      id: "attribution",
      content: <AttributionCard rows={attributionRows} currencySymbol={symbol} />,
    },
    {
      id: "meta-morning",
      content: (
        <MetaMorningCard
          brief={metaBriefQuery.data}
          loading={metaBriefQuery.isLoading}
          error={
            metaBriefQuery.error instanceof Error
              ? metaBriefQuery.error.message
              : null
          }
        />
      ),
    },
    {
      id: "ai-brief",
      content: (
        <AiBriefCard
          insight={aiBriefQuery.data}
          loading={aiBriefQuery.isLoading}
          error={aiBriefActionError ?? (aiBriefQuery.error instanceof Error ? aiBriefQuery.error.message : null)}
          onRegenerate={handleRegenerateAiBrief}
          regenerating={aiBriefRegenerating}
        />
      ),
    },
    ...platformSections.map((platform) => ({
      id: (platform.provider === "meta" ? "meta-platform" : "google-platform") as
        | "meta-platform"
        | "google-platform",
      content: (
        <PlatformMiniDashboard
          key={platform.provider}
          provider={platform.provider}
          title={platform.title}
          metrics={platform.metrics}
          currencySymbol={symbol}
          dateDomain={providerDateDomain}
          previousDateDomain={providerPreviousDateDomain}
          latestSync={
            platform.provider === "meta" ? metaStatusQuery.data?.latestSync : googleAdsStatusQuery.data?.latestSync
          }
        />
      ),
    })),
    {
      id: "store-value",
      content: (
        <TileCard
          title={
            shopifyStorePrimary
              ? "Store performance · Shopify"
              : ga4StoreFallback
                ? "Store & customer value · GA4 fallback"
                : "Store & customer value"
          }
          metrics={storeAndCustomerMetrics}
          currencySymbol={symbol}
          line="#0b7954"
          fill="rgba(14,159,110,0.08)"
        />
      ),
    },
    {
      id: "web-analytics",
      content: (
        <TileCard
          title="Web analytics · GA4"
          metrics={webAnalyticsMetrics}
          currencySymbol={symbol}
          line="#B45309"
          fill="rgba(180,83,9,0.07)"
        />
      ),
    },
  ];

  return (
    <section data-screen-label="Overview" className={`${overviewStyles.page} flex flex-col`}>
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div>
          <p className="adv-eyebrow" style={{ fontSize: 11 }}>
            Home
          </p>
          <h1 className="adv-h1">Overview</h1>
          <p className="adv-sub">
            {activeBusiness?.name?.trim() || "—"} · {currency ?? "—"} · All figures for the selected{" "}
            {windowDayCount === null ? "" : `${windowDayCount}-day `}window.
          </p>
        </div>
        <div className={`${overviewStyles.headerActions} flex gap-2`}>
          {customizing ? null : (
            <button
              type="button"
              className={`${overviewStyles.layoutEditButton} adv-btn`}
              style={{ padding: "0 14px" }}
              ref={customizeButtonRef}
              disabled={!customizationReady}
              onClick={startCustomize}
            >
              Customize
            </button>
          )}
          <button
            type="button"
            className="adv-btn"
            style={{ padding: "0 14px" }}
            onClick={() => router.push(dashboardHrefForRouteFamily("/commercial-truth", pathname))}
          >
            Edit cost model
          </button>
          <ShareSnapshotButton
            businessId={businessId}
            businessName={activeBusiness?.name ?? null}
            rangePreset={snapshotRangePreset}
            compareMode={compareMode}
          />
        </div>
      </div>

      {customizing ? (
        <OverviewCustomizeBar
          dirty={customization.dirty}
          onCancel={customization.cancel}
          onSave={customization.save}
        />
      ) : null}

      <CustomizableKpiBand
        catalog={metricCatalog}
        keys={customization.kpiKeys}
        defaultKeys={defaultPinKeys}
        currencySymbol={symbol}
        loading={query.isLoading}
        editing={customizing}
        onKeysChange={customization.setKpiKeys}
        onRestoreDefaults={customization.restoreKpiDefaults}
      />

      <a
        className={`${overviewStyles.mobileTriage} adv-btn`}
        data-ctl="live:MOBILE-01"
        data-overview-section="mobile-triage"
        href={`${dashboardHrefForRouteFamily("/platforms/meta", pathname)}?order=tier0`}
      >
        Start Meta triage
      </a>

      <OverviewLayout
        layout={customization.layout}
        editing={customizing}
        items={overviewLayoutItems}
        onLayoutChange={customization.setLayout}
      />

      <details
        className={overviewStyles.sourceFootnote}
        data-overview-section="source-readiness"
        data-el="source-readiness"
      >
        <summary className={overviewStyles.sourceFootnoteSummary}>
          <span>Data sources</span>
          <span className={overviewStyles.sourceFootnoteStatus}>
            {sourceAttentionCount === 0 ? "All serving" : `${sourceAttentionCount} need attention`}
          </span>
        </summary>
        <div className={overviewStyles.sourceFootnoteBody}>
          <SourceHealthPanel compact connectHref={integrationsHref} sources={sourceHealth} />
        </div>
      </details>
    </section>
  );
}

/** Card of compact stat tiles — the Store / Web-analytics pattern. */
function TileCard({
  title,
  metrics,
  currencySymbol,
  line,
  fill,
}: {
  title: string;
  metrics: OverviewMetricCardData[];
  currencySymbol: string;
  line: string;
  fill: string;
}) {
  return (
    <article className={`${overviewStyles.tileCard} adv-card p-4`} data-overview-tile-group={title}>
      <h2 className="adv-card-title mb-3">{title}</h2>
      <div className={overviewStyles.tileGrid}>
        {metrics.map((metric) => (
          <StatTile key={metric.id} metric={metric} currencySymbol={currencySymbol} line={line} fill={fill} />
        ))}
      </div>
    </article>
  );
}

// ---------------------------------------------------------------------------
// Sparkline patching — runs client-side once the secondary query resolves.
// Formulas mirror the server-side overview-summary route exactly so ROAS/MER
// values are always consistent.
// ---------------------------------------------------------------------------

type SparklinePoint = { date: string; value: number };

type CommerceSourceFamily = "shopify" | "ga4" | null;
const COMMERCE_SOURCE_CONFLICT_HELPER = "Refresh to confirm the current commerce source";

function commerceSourceFamily(summary: OverviewSummaryData): CommerceSourceFamily {
  const sourceKey = summary.pins.find((metric) => metric.id === "pins-revenue")?.dataSource.key;
  if (
    sourceKey === "shopify_ledger" ||
    sourceKey === "shopify_warehouse" ||
    sourceKey === "shopify_live_fallback"
  ) {
    return "shopify";
  }
  return sourceKey === "ga4_fallback" ? "ga4" : null;
}

function commerceAuthorityMatches(
  summary: OverviewSummaryData,
  bundle: SparklineBundle,
  family = commerceSourceFamily(summary),
) {
  if (family === null) return true;
  const summaryState = summary.shopifyConnectionState ?? "unknown";
  const bundleState = bundle.shopifyConnectionState ?? "unknown";
  if (family === "shopify") {
    return (
      summaryState === "connected" &&
      bundleState === "connected" &&
      bundle.shopifyCommerceAvailable === true
    );
  }
  return (
    summaryState === "disconnected" &&
    bundleState === "disconnected" &&
    bundle.shopifyCommerceAvailable !== true
  );
}

function unavailableCommerceCard(card: OverviewMetricCardData): OverviewMetricCardData {
  return {
    ...card,
    value: null,
    previousValue: null,
    changePct: null,
    sparklineData: [],
    previousSparklineData: [],
    trendDirection: "neutral",
    trendSentiment: "neutral",
    dataSource: { key: "unavailable", label: "Unavailable" },
    status: "unavailable",
    helperText: COMMERCE_SOURCE_CONFLICT_HELPER,
  };
}

/**
 * The summary and sparkline endpoints are separate reads. If a Shopify
 * connect/disconnect lands between them, hide commerce values instead of
 * combining two contradictory source snapshots. Provider and GA4 web data
 * remain independently usable.
 */
export function reconcileOverviewCommerceSource(
  summary: OverviewSummaryData,
  bundle: SparklineBundle,
): OverviewSummaryData {
  if (commerceAuthorityMatches(summary, bundle)) return summary;
  return {
    ...summary,
    pins: summary.pins.map((metric) =>
      metric.id === "pins-spend" || metric.id === "pins-blended-roas"
        ? metric
        : unavailableCommerceCard(metric),
    ),
    storeMetrics: summary.storeMetrics.map(unavailableCommerceCard),
    ltv: summary.ltv.map(unavailableCommerceCard),
    expenses: summary.expenses.map((metric) =>
      metric.id === "expenses-ad-spend" ? metric : unavailableCommerceCard(metric),
    ),
    customMetrics: summary.customMetrics.map(unavailableCommerceCard),
  };
}

function rv(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function sourceSafeProviderTrends(
  bundle: SparklineBundle,
  providerScalarSources: OverviewProviderSourceMap | null | undefined,
  providerScope?: OverviewPaidProviderScope | null,
) {
  if (providerScope && !providerScope.complete) return null;
  const activeProviders = providerScope
    ? providerScope.providers.filter((provider) => providerScalarSources?.[provider])
    : (["meta", "google"] as const).filter((provider) => providerScalarSources?.[provider]);
  if (providerScope && activeProviders.length !== providerScope.providers.length) return null;
  if (activeProviders.length === 0) return null;

  const compatibleTrends: Partial<
    Record<"meta" | "google", SparklineBundle["providerTrends"]["meta"]>
  > = {};
  for (const provider of activeProviders) {
    const trends = bundle.providerTrends[provider];
    if (
      trends === undefined ||
      !providerTrendMatchesScalar(
        provider,
        providerScalarSources?.[provider],
        bundle.providerTrendSources?.[provider],
      )
    ) {
      return null;
    }
    compatibleTrends[provider] = trends;
  }
  return compatibleTrends;
}

function sourceSafeBlendedRoasSeries(
  bundle: SparklineBundle,
  providerScalarSources: OverviewProviderSourceMap | null | undefined,
  providerScope?: OverviewPaidProviderScope | null,
): SparklinePoint[] {
  const compatibleTrends = sourceSafeProviderTrends(bundle, providerScalarSources, providerScope);
  return compatibleTrends ? buildBlendedProviderRoasSeries(compatibleTrends) : [];
}

function sourceSafePaidSpendSeries(
  bundle: SparklineBundle,
  providerScalarSources: OverviewProviderSourceMap | null | undefined,
  providerScope?: OverviewPaidProviderScope | null,
): SparklinePoint[] {
  const compatibleTrends = sourceSafeProviderTrends(bundle, providerScalarSources, providerScope);
  return compatibleTrends ? buildPaidProviderSpendSeries(compatibleTrends) : [];
}

export function buildSparklineMap(
  bundle: SparklineBundle,
  costModel: BusinessCostModelData | null,
  summary: OverviewSummaryData,
  providerScalarSources: OverviewProviderSourceMap | null | undefined = summary.providerSources?.current,
  providerScope: OverviewPaidProviderScope | null | undefined = summary.paidProviderScope?.current,
): Record<string, SparklinePoint[]> {
  const {
    providerTrends,
    ga4Daily,
    shopifyDaily = [],
    shopifyCommerceAvailable = false,
  } = bundle;
  const summaryConnectionState = summary.shopifyConnectionState ?? "unknown";
  const bundleConnectionState = bundle.shopifyConnectionState ?? "unknown";
  const canUseShopifyCommerce =
    summaryConnectionState === "connected" &&
    bundleConnectionState === "connected" &&
    shopifyCommerceAvailable;
  const canUseGa4Commerce =
    summaryConnectionState === "disconnected" &&
    bundleConnectionState === "disconnected" &&
    !shopifyCommerceAvailable;
  const trustedShopifyDaily = canUseShopifyCommerce ? shopifyDaily : [];
  const commerceGa4Daily = canUseGa4Commerce ? ga4Daily : [];

  // Spend is usable only for dates reported by every provider in the scalar
  // scope. `combined` intentionally contains every calendar date and fills an
  // absent provider with zero, so using it here would turn missing data into a
  // measured zero (or a partial Meta/Google denominator).
  const spendSeries = sourceSafePaidSpendSeries(bundle, providerScalarSources, providerScope);
  const shopifyRevenueSeries = canUseShopifyCommerce
    ? trustedShopifyDaily.map((point) => ({
        date: point.date,
        value: rv(point.revenue),
      }))
    : [];
  const shopifyPurchaseSeries = canUseShopifyCommerce
    ? trustedShopifyDaily.map((point) => ({
        date: point.date,
        value: rv(point.purchases),
      }))
    : [];
  const ga4RevenueSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value: rv(p.revenue),
  }));
  const ga4PurchaseSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value: rv(p.purchases),
  }));
  const shopifyAovSeries = trustedShopifyDaily.flatMap((point) => {
    const revenue = point.grossRevenue ?? point.revenue;
    return point.purchases > 0
      ? [{ date: point.date, value: rv(revenue / point.purchases) }]
      : [];
  });
  const shopifyConversionSeries = trustedShopifyDaily.flatMap((point) =>
    point.conversionRate == null
      ? []
      : [{ date: point.date, value: rv(point.conversionRate) }],
  );
  const sourceKeyFor = (metrics: OverviewMetricCardData[], id: string) =>
    metrics.find((metric) => metric.id === id)?.dataSource.key;
  const isShopifyCommerceSource = (sourceKey: string | undefined) =>
    sourceKey === "shopify_ledger" ||
    sourceKey === "shopify_warehouse" ||
    sourceKey === "shopify_live_fallback";
  const revenueSourceKey = sourceKeyFor(summary.pins, "pins-revenue");
  const purchaseSourceKey = sourceKeyFor(summary.pins, "pins-orders");
  const conversionSourceKey = sourceKeyFor(summary.pins, "pins-conversion-rate");
  const aovSourceKey = sourceKeyFor(summary.storeMetrics, "store-aov");
  const revenueSeries = isShopifyCommerceSource(revenueSourceKey)
    ? shopifyRevenueSeries
    : revenueSourceKey === "ga4_fallback"
      ? ga4RevenueSeries
      : [];
  const purchaseSeries = isShopifyCommerceSource(purchaseSourceKey)
    ? shopifyPurchaseSeries
    : purchaseSourceKey === "ga4_fallback"
      ? ga4PurchaseSeries
      : [];
  const spendByDate = new Map(spendSeries.map((point) => [point.date, point.value]));
  const verifiedSpendByDate = new Map(
    sourceSafePaidSpendSeries(bundle, providerScalarSources, providerScope).map((point) => [point.date, point.value]),
  );
  const purchasesByDate = new Map(purchaseSeries.map((point) => [point.date, point.value]));
  const merCard = summary.pins.find((metric) => metric.id === "pins-mer");
  const merSeries =
    merCard?.value == null || merCard.status === "unavailable"
      ? []
      : revenueSeries
          .map((point) => {
            const spend = verifiedSpendByDate.get(point.date);
            return spend !== undefined && spend > 0
              ? { date: point.date, value: rv(point.value / spend) }
              : null;
          })
          .filter((point): point is SparklinePoint => point !== null);
  const blendedCpaSeries = purchaseSeries.map((point) => {
    const spend = spendByDate.get(point.date) ?? 0;
    return { date: point.date, value: point.value > 0 ? rv(spend / point.value) : 0 };
  });
  const blendedRoasSeries = sourceSafeBlendedRoasSeries(bundle, providerScalarSources, providerScope);

  // GA4 daily derived series
  const ga4AovSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value: p.purchases > 0 ? rv(p.revenue / p.purchases) : 0,
  }));
  const ga4CommerceConvRateSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value: p.sessions > 0 ? rv((p.purchases / p.sessions) * 100, 4) : 0,
  }));
  const ga4WebConversionRateSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: p.sessions > 0 ? rv((p.purchases / p.sessions) * 100, 4) : 0,
  }));
  const ga4NewCustomersSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value: rv(p.firstTimePurchasers),
  }));
  const ga4ReturningCustomersSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value: rv(Math.max(p.totalPurchasers - p.firstTimePurchasers, 0)),
  }));
  const ga4RevenuePerCustomerSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value: p.totalPurchasers > 0 ? rv(p.revenue / p.totalPurchasers) : 0,
  }));
  const ga4RepeatRateSeries = commerceGa4Daily.map((p) => ({
    date: p.date,
    value:
      p.totalPurchasers > 0
        ? rv((Math.max(p.totalPurchasers - p.firstTimePurchasers, 0) / p.totalPurchasers) * 100, 4)
        : 0,
  }));
  const ga4SessionsSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: rv(p.sessions),
  }));
  const ga4EngagementSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: rv(p.engagementRate * 100, 4),
  }));
  const ga4SessionDurationSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: rv(p.avgSessionDuration),
  }));

  const aovSeries = isShopifyCommerceSource(aovSourceKey)
    ? shopifyAovSeries
    : aovSourceKey === "ga4_fallback"
      ? ga4AovSeries
      : [];
  const commerceConversionSeries = conversionSourceKey === "shopify_customer_events"
    ? shopifyConversionSeries
    : conversionSourceKey === "ga4_fallback"
      ? ga4CommerceConvRateSeries
      : [];
  const customerSourceKey = sourceKeyFor(summary.storeMetrics, "store-new-customers");
  const customerSeries = customerSourceKey === "ga4_fallback" ? ga4NewCustomersSeries : [];

  const ltvCacSeries = ga4RevenuePerCustomerSeries.flatMap((point) => {
    const purchases = purchasesByDate.get(point.date);
    const spend = spendByDate.get(point.date);
    return purchases !== undefined && purchases > 0 && spend !== undefined && spend > 0
      ? [{ date: point.date, value: rv(point.value / (spend / purchases)) }]
      : [];
  });

  // Cost-model dependent sparklines
  const cm = costModel;
  const totalExpensesSeries: SparklinePoint[] = cm
    ? revenueSeries.flatMap((point) => {
        const spend = spendByDate.get(point.date);
        return spend === undefined
          ? []
          : [{
              date: point.date,
              value: rv(
                spend +
                  point.value * (cm.cogsPercent + cm.shippingPercent + cm.feePercent) +
                  cm.fixedCost
              ),
            }];
      })
    : spendSeries;

  const netProfitSeries: SparklinePoint[] = cm
    ? revenueSeries.flatMap((point) => {
        const spend = spendByDate.get(point.date);
        return spend === undefined
          ? []
          : [{
              date: point.date,
              value: rv(
                point.value -
                  (spend +
                    point.value * (cm.cogsPercent + cm.shippingPercent + cm.feePercent) +
                    cm.fixedCost)
              ),
            }];
      })
    : [];

  const contributionMarginSeries: SparklinePoint[] = cm
    ? revenueSeries.flatMap((point) => {
        const spendVal = spendByDate.get(point.date);
        if (spendVal === undefined) return [];
        const varCost = spendVal + point.value * (cm.cogsPercent + cm.shippingPercent + cm.feePercent);
        return [{
          date: point.date,
          value: point.value > 0 ? rv(((point.value - varCost) / point.value) * 100) : 0,
        }];
      })
    : [];

  // Per-provider sparklines. Same specs and formulas as the summary route; a
  // day with a zero or unreported denominator is omitted, never drawn as 0.
  const providerSparklines: Record<string, SparklinePoint[]> = {};
  for (const provider of ["meta", "google"] as const) {
    const trends = providerTrends[provider];
    if (!trends) continue;
    for (const spec of OVERVIEW_PROVIDER_METRIC_SPECS[provider]) {
      providerSparklines[providerMetricId(provider, spec.suffix)] = buildProviderMetricSeries(spec.suffix, trends);
    }
  }

  return {
    "pins-revenue": revenueSeries,
    "pins-spend": spendSeries,
    "pins-mer": merSeries,
    "pins-blended-roas": blendedRoasSeries,
    "pins-conversion-rate": commerceConversionSeries,
    "pins-orders": purchaseSeries,
    "store-aov": aovSeries,
    "store-conversion-rate": commerceConversionSeries,
    "store-new-customers": customerSeries,
    "store-returning-customers": customerSourceKey === "ga4_fallback" ? ga4ReturningCustomersSeries : [],
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
    "web-conversion-rate": ga4WebConversionRateSeries,
    ...providerSparklines,
  };
}

function patchCard(card: OverviewMetricCardData, sparkMap: Record<string, SparklinePoint[]>): OverviewMetricCardData {
  if (card.helperText === COMMERCE_SOURCE_CONFLICT_HELPER) return card;
  const patches = sparkMap[card.id];
  if (!patches || patches.length === 0) return card;
  return { ...card, sparklineData: patches };
}

function patchCardComparison(
  card: OverviewMetricCardData,
  sparkMap: Record<string, SparklinePoint[]>
): OverviewMetricCardData {
  if (card.helperText === COMMERCE_SOURCE_CONFLICT_HELPER) return card;
  const patches = sparkMap[card.id];
  if (!patches || patches.length === 0) return card;
  return { ...card, previousSparklineData: patches };
}

/**
 * Provider sparklines are drawn only when the trend was read from the same
 * source family as that window's platform scalars. A live scalar (Meta today or
 * live historical fallback, Google's current-day overlay) never receives a
 * warehouse trend, and a missing or unknown source on either side fails closed.
 */
function gateProviderSparklines(
  sparkMap: Record<string, SparklinePoint[]>,
  scalarSources: OverviewProviderSourceMap | null | undefined,
  bundle: SparklineBundle,
  /**
   * For comparison series only: the current window's scalar sources. The
   * dashed previous line is drawn only when the two windows are comparable.
   */
  currentScalarSources?: OverviewProviderSourceMap | null,
) {
  const allowed = (provider: "meta" | "google") =>
    providerTrendMatchesScalar(provider, scalarSources?.[provider], bundle.providerTrendSources?.[provider]) &&
    (currentScalarSources === undefined ||
      providerScalarSourcesComparable(provider, currentScalarSources?.[provider], scalarSources?.[provider]));
  const compatible: Record<"meta" | "google", boolean> = {
    meta: allowed("meta"),
    google: allowed("google"),
  };
  const gatedMap = Object.fromEntries(
    Object.entries(sparkMap).filter(([id]) => {
      const provider = providerForMetricId(id);
      return provider === null || compatible[provider];
    }),
  );
  return { gatedMap, compatible };
}

export function patchSummarySparklines(summary: OverviewSummaryData, bundle: SparklineBundle): OverviewSummaryData {
  const reconciledSummary = reconcileOverviewCommerceSource(summary, bundle);
  const sparkMap = buildSparklineMap(bundle, reconciledSummary.costModel.values, reconciledSummary);
  const { gatedMap, compatible } = gateProviderSparklines(
    sparkMap,
    reconciledSummary.providerSources?.current,
    bundle,
  );
  return {
    ...reconciledSummary,
    pins: reconciledSummary.pins.map((m) =>
      m.id === "pins-blended-roas" && !gatedMap[m.id]
        ? { ...m, sparklineData: [] }
        : patchCard(m, gatedMap),
    ),
    storeMetrics: reconciledSummary.storeMetrics.map((m) => patchCard(m, gatedMap)),
    ltv: reconciledSummary.ltv.map((m) => patchCard(m, gatedMap)),
    expenses: reconciledSummary.expenses.map((m) => patchCard(m, gatedMap)),
    customMetrics: reconciledSummary.customMetrics.map((m) => patchCard(m, gatedMap)),
    webAnalytics: reconciledSummary.webAnalytics.map((m) => patchCard(m, gatedMap)),
    platforms: reconciledSummary.platforms.map((platform) => ({
      ...platform,
      metrics: platform.metrics.map((m) => {
        const provider = providerForMetricId(m.id);
        // Clear rather than keep: an incompatible card must not show any
        // trend, including one that arrived with the summary itself.
        if (provider && !compatible[provider]) return { ...m, sparklineData: [] };
        return patchCard(m, gatedMap);
      }),
    })),
  };
}

export function patchSummaryComparisonSparklines(
  summary: OverviewSummaryData,
  bundle: SparklineBundle,
): OverviewSummaryData {
  const previousProviderSources = summary.providerSources?.previous;
  const currentProviderScope = summary.paidProviderScope?.current;
  const previousProviderScope = summary.paidProviderScope?.previous;
  const blendedComparisonComparable =
    (currentProviderScope?.complete ?? true) &&
    (previousProviderScope?.complete ?? true) &&
    providerScalarSourceSetsComparable(summary.providerSources?.current, previousProviderSources);
  const sparkMap = buildSparklineMap(
    bundle,
    summary.costModel.values,
    summary,
    previousProviderSources,
    previousProviderScope,
  );
  // The summary contract carries source-gated scalar comparisons but no
  // previous-period commerce source metadata. Preserve only provider-owned
  // comparison series; otherwise a changed Shopify/GA4 source could be drawn
  // as if both periods shared one commerce truth.
  const safeComparisonMap = Object.fromEntries(
    Object.entries(sparkMap).filter(([id]) =>
      id === "pins-spend" ||
      (id === "pins-blended-roas" && blendedComparisonComparable) ||
      id === "expenses-ad-spend" ||
      id.startsWith("web-") ||
      id.startsWith("meta-") ||
      id.startsWith("google-"),
    ),
  );
  // Provider comparison series are gated against the PREVIOUS window's scalar
  // sources, and drawn only when those match the current window's source.
  const { gatedMap, compatible } = gateProviderSparklines(
    safeComparisonMap,
    summary.providerSources?.previous,
    bundle,
    summary.providerSources?.current ?? null,
  );
  return {
    ...summary,
    pins: summary.pins.map((m) =>
      m.id === "pins-blended-roas" && !gatedMap[m.id]
        ? { ...m, previousSparklineData: [] }
        : patchCardComparison(m, gatedMap),
    ),
    storeMetrics: summary.storeMetrics.map((m) => patchCardComparison(m, gatedMap)),
    ltv: summary.ltv.map((m) => patchCardComparison(m, gatedMap)),
    expenses: summary.expenses.map((m) => patchCardComparison(m, gatedMap)),
    customMetrics: summary.customMetrics.map((m) => patchCardComparison(m, gatedMap)),
    webAnalytics: summary.webAnalytics.map((m) => patchCardComparison(m, gatedMap)),
    platforms: summary.platforms.map((platform) => ({
      ...platform,
      metrics: platform.metrics.map((m) => {
        const provider = providerForMetricId(m.id);
        if (provider && !compatible[provider]) return { ...m, previousSparklineData: [] };
        return patchCardComparison(m, gatedMap);
      }),
    })),
  };
}

export function sourceSafeOverviewTrendPoints(
  bundle: SparklineBundle | undefined,
  summary: OverviewSummaryData | undefined,
) {
  if (!bundle || !summary) return [];
  const spendSeries = sourceSafePaidSpendSeries(
    bundle,
    summary.providerSources?.current,
    summary.paidProviderScope?.current,
  );
  const blendedByDate = new Map(
    sourceSafeBlendedRoasSeries(
      bundle,
      summary.providerSources?.current,
      summary.paidProviderScope?.current,
    ).map((point) => [point.date, point.value]),
  );
  return spendSeries.map((point) => ({
    date: point.date,
    spend: point.value,
    roas: blendedByDate.get(point.date) ?? null,
  }));
}

export function overviewTrendTitle(summary: OverviewSummaryData | undefined) {
  const scope = summary?.paidProviderScope?.current;
  const activeProviders = scope
    ? scope.complete
      ? scope.providers
      : []
    : (["meta", "google"] as const).filter((provider) => summary?.providerSources?.current?.[provider]);
  if (activeProviders.length === 1) {
    return `${activeProviders[0] === "meta" ? "Meta Ads" : "Google Ads"} Spend & ROAS`;
  }
  return "Spend & Blended ROAS";
}
