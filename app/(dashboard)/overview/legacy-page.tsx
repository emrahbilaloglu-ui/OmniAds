"use client";

import { useMemo, useState } from "react";
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
  overviewTrendPoints,
} from "@/lib/zero-base/home/overview-source-health";
import type { EconomicsContextModel } from "@/lib/zero-base/home/economics-context";
import { AttributionCard } from "@/components/overview/v2/attribution-card";
import { HeroMetricCard, HeroTile, StatTile } from "@/components/overview/v2/metric-band";
import { PlatformMiniDashboard } from "@/components/overview/v2/platform-card";
import { ShareSnapshotButton } from "@/components/overview/v2/share-snapshot-button";
import { getPresetDatesForReferenceDate, getTodayIsoForTimeZone } from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import { usePreferencesHydrated } from "@/hooks/persistent-date-range-support";
import { currencySymbolFor } from "@/lib/metric-format";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import { useAppStore } from "@/store/app-store";
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
  OverviewPlatformSection,
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

const HEADLINE_SPECS: FixedMetricSpec[] = [
  {
    id: "pins-revenue",
    title: "Revenue",
    unit: "currency",
    icon: "badge-dollar-sign",
  },
  { id: "pins-spend", title: "Ad Spend", unit: "currency", icon: "receipt" },
  {
    id: "pins-blended-roas",
    title: "Blended ROAS · target —",
    unit: "ratio",
    icon: "target",
  },
  { id: "pins-orders", title: "Orders", unit: "count", icon: "shopping-cart" },
  {
    id: "pins-conversion-rate",
    title: "Conv Rate · GA4",
    unit: "percent",
    icon: "percent",
  },
];

const STORE_SPECS: FixedMetricSpec[] = [
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

const PLATFORM_SPECS = [
  { provider: "meta", title: "Meta Ads" },
  { provider: "google", title: "Google Ads" },
] as const;

const PLATFORM_METRIC_SPECS: Array<Omit<FixedMetricSpec, "id"> & { suffix: string }> = [
  { suffix: "spend", title: "Spend", unit: "currency" },
  { suffix: "revenue", title: "Revenue", unit: "currency" },
  { suffix: "roas", title: "ROAS", unit: "ratio" },
  { suffix: "purchases", title: "Purchases", unit: "count" },
  { suffix: "cpa", title: "CPA", unit: "currency" },
];

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
    const metrics = PLATFORM_METRIC_SPECS.map((spec) => {
      const id = `${provider}-${spec.suffix}`;
      const metric = source?.metrics.find(
        (candidate) =>
          candidate.id === id ||
          candidate.id.endsWith(`-${spec.suffix}`) ||
          candidate.title.toLowerCase() === spec.title.toLowerCase()
      );
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
  // Uses the same formula the server-side route used to generate sparklines,
  // so ROAS and MER values are identical.
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
  const headlineMetrics = useMemo(() => fixedMetrics(effectiveSummary?.pins, HEADLINE_SPECS), [effectiveSummary?.pins]);
  const storeAndCustomerMetrics = useMemo(
    () => fixedMetrics([...(effectiveSummary?.storeMetrics ?? []), ...(effectiveSummary?.ltv ?? [])], STORE_SPECS),
    [effectiveSummary?.ltv, effectiveSummary?.storeMetrics]
  );
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
  const heroMetric = headlineMetrics[0]!;
  const heroTiles = headlineMetrics.slice(1);
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
    () => overviewTrendPoints(sparklineQuery.data?.combined ?? []),
    [sparklineQuery.data],
  );
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

  return (
    <section data-screen-label="Overview" className="flex flex-col gap-5">
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
        <div className="flex gap-2">
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

      <div
        data-el="home-kpis"
        data-overview-section="headline"
        className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(220px,1fr))]"
      >
        <HeroMetricCard metric={heroMetric} currencySymbol={symbol} />
        {heroTiles.map((metric, index) => (
          <HeroTile key={metric.id} metric={metric} currencySymbol={symbol} index={index} />
        ))}
      </div>

      {/*
        Where these numbers come from, and how current they are.

        Above the attribution and the brief on purpose: an operator who is about
        to read a conclusion needs to know first whether the sources behind it
        are serving. The panel renders whatever the reads returned — including
        a read that failed, which says so rather than reporting "not connected".
      */}
      <div data-overview-section="source-readiness" data-el="source-readiness">
        <SourceHealthPanel
          compact
          connectHref={integrationsHref}
          sources={sourceHealth}
        />
      </div>

      {/*
        The trend, with the table the contract requires.

        `live:chart-table-toggle` is specific: the toggle swaps the chart for
        REAL table markup in place, announces the mode, and persists the choice
        per surface. `TrendPanel` is the component that already does exactly
        that; this page had a chart and no way to read the numbers behind it.
      */}
      <div data-overview-section="trend">
        <TrendPanel
          currency={currency ?? null}
          points={trendPoints}
          surface="overview"
          targetRoas={economics?.targetRoas ?? null}
          title="Spend & ROAS"
        />
      </div>

      {economics ? (
        <div data-overview-section="economics">
          <EconomicsContext businessId={businessId} model={economics} />
        </div>
      ) : null}

      {/*
        The narrow-width way into the day's work.

        `live:MOBILE-01` opens Meta Decisions in Tier-0 triage order. Rendered
        only below the tablet breakpoint: at desktop the rail already carries
        the same destination, and two routes to one place on one screen is the
        duplication this product removes elsewhere.
      */}
      <a
        className="adv-btn md:hidden"
        data-ctl="live:MOBILE-01"
        data-overview-section="mobile-triage"
        /*
          `/platforms/meta/decisions` has no page. The decisions surface is
          `/platforms/meta` itself, so the one route this card offered on
          mobile — the only triage entry point below the tablet breakpoint —
          answered 404 every time it was pressed.
        */
        href={`${dashboardHrefForRouteFamily("/platforms/meta", pathname)}?order=tier0`}
        style={{ minHeight: 44, display: "inline-flex", alignItems: "center" }}
      >
        Start Meta triage
      </a>

      <div
        data-overview-section="attribution-and-brief"
        className="grid grid-cols-1 items-start gap-3 lg:[grid-template-columns:repeat(auto-fit,minmax(380px,1fr))]"
      >
        <AttributionCard rows={attributionRows} currencySymbol={symbol} />
        <MetaMorningCard
          brief={metaBriefQuery.data}
          loading={metaBriefQuery.isLoading}
          error={
            metaBriefQuery.error instanceof Error
              ? metaBriefQuery.error.message
              : null
          }
        />
        <AiBriefCard
          insight={aiBriefQuery.data}
          loading={aiBriefQuery.isLoading}
          error={aiBriefActionError ?? (aiBriefQuery.error instanceof Error ? aiBriefQuery.error.message : null)}
          onRegenerate={handleRegenerateAiBrief}
          regenerating={aiBriefRegenerating}
        />
      </div>

      <div data-overview-section="platforms" className="grid grid-cols-1 items-stretch gap-3 md:grid-cols-2">
        {platformSections.map((platform) => (
          <PlatformMiniDashboard
            key={platform.provider}
            provider={platform.provider}
            title={platform.title}
            metrics={platform.metrics}
            currencySymbol={symbol}
            latestSync={
              platform.provider === "meta" ? metaStatusQuery.data?.latestSync : googleAdsStatusQuery.data?.latestSync
            }
          />
        ))}
      </div>

      <div
        data-overview-section="store-and-web"
        className="grid grid-cols-1 items-start gap-3 lg:[grid-template-columns:repeat(auto-fit,minmax(380px,1fr))]"
      >
        <TileCard
          title="Store &amp; customer value"
          metrics={storeAndCustomerMetrics}
          currencySymbol={symbol}
          line="#0b7954"
          fill="rgba(14,159,110,0.08)"
        />
        <TileCard
          title="Web analytics · GA4"
          metrics={webAnalyticsMetrics}
          currencySymbol={symbol}
          line="#B45309"
          fill="rgba(180,83,9,0.07)"
        />
      </div>
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
    <article className="adv-card p-4" data-overview-tile-group={title}>
      <h2 className="adv-card-title mb-3">{title}</h2>
      <div className="grid gap-2 [grid-template-columns:repeat(auto-fit,minmax(130px,1fr))]">
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

function rv(value: number, digits = 4): number {
  if (!Number.isFinite(value)) return 0;
  return Number(value.toFixed(digits));
}

function buildSparklineMap(
  bundle: SparklineBundle,
  costModel: BusinessCostModelData | null
): Record<string, SparklinePoint[]> {
  const { combined, providerTrends, ga4Daily } = bundle;

  const spendSeries = combined.map((p) => ({
    date: p.date,
    value: rv(p.spend),
  }));
  const revenueSeries = combined.map((p) => ({
    date: p.date,
    value: rv(p.revenue),
  }));
  const purchaseSeries = combined.map((p) => ({
    date: p.date,
    value: rv(p.purchases),
  }));
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
  const ga4NewCustomersSeries = ga4Daily.map((p) => ({
    date: p.date,
    value: rv(p.firstTimePurchasers),
  }));
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

  const aovSeries =
    ga4AovSeries.length > 0
      ? ga4AovSeries
      : combined.map((p) => ({
          date: p.date,
          value: p.purchases > 0 ? rv(p.revenue / p.purchases) : 0,
        }));

  const ltvCacSeries = ga4RevenuePerCustomerSeries.map((point, i) => ({
    date: point.date,
    value: blendedCpaSeries[i] && blendedCpaSeries[i].value > 0 ? rv(point.value / blendedCpaSeries[i].value) : 0,
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
        const varCost = spendVal + point.value * (cm.cogsPercent + cm.shippingPercent + cm.feePercent);
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
    providerSparklines[`${provider}-spend`] = trends.map((p) => ({
      date: p.date,
      value: rv(p.spend),
    }));
    providerSparklines[`${provider}-revenue`] = trends.map((p) => ({
      date: p.date,
      value: rv(p.revenue),
    }));
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
    "web-conversion-rate": ga4ConvRateSeries,
    ...providerSparklines,
  };
}

function patchCard(card: OverviewMetricCardData, sparkMap: Record<string, SparklinePoint[]>): OverviewMetricCardData {
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

function patchSummarySparklines(summary: OverviewSummaryData, bundle: SparklineBundle): OverviewSummaryData {
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

function patchSummaryComparisonSparklines(summary: OverviewSummaryData, bundle: SparklineBundle): OverviewSummaryData {
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
