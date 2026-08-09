"use client";

import { newestObservation } from "@/lib/tier-zero-as-of";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { buildGoogleAdsDeepLink, describeGoogleAdsDeepLink } from "@/lib/google-ads/deep-link";
import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { MiniTrendAreaChart } from "@/components/overview/MiniTrendAreaChart";
import {
  SyncStatusPill,
  SyncStatusPillSkeleton,
} from "@/components/sync/sync-status-pill";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { GoogleAdvisorPanel } from "@/components/google/google-advisor-panel";
import { MISSING_VALUE } from "@/lib/metric-format";
import { resolveGoogleAccountScope } from "@/lib/google-ads/account-scope";
import {
  buildNegativeKeywordList,
  buildSearchTermCsv,
} from "@/lib/google-ads/search-term-export";
import {
  DateRangePicker,
  getPresetDatesForReferenceDate,
  getTodayIsoForTimeZone,
} from "@/components/date-range/DateRangePicker";
import { usePersistentDateRange } from "@/hooks/use-persistent-date-range";
import {
  ACTION_CONFIG,
  fmtCurrency,
  fmtCurrencyPrecise,
  fmtNumber,
  fmtPct,
  fmtRoas,
  isCampaignActive,
  PANEL_ITEMS,
  resolveTrendTimeline,
  type Campaign,
  type CampaignsResponse,
  type AssetGroupRow,
  type AssetGroupsResponse,
  type AudienceRow,
  type AudiencesResponse,
  type AssetRow,
  type AssetsResponse,
  type ProductRow,
  type ProductsResponse,
  type SearchIntelligenceResponse,
  type GeoResponse,
  type DeviceRow,
  type DevicesResponse,
  type PanelKey,
  type TrendLabelMode,
  type GoogleAdsTrendsResponse,
} from "@/components/google-ads/google-ads-dashboard-support";
import type { GoogleAdvisorResponse, GoogleAdvisorRecommendation } from "@/src/services/google";
import type {
  GoogleAdsPanelSurfaceState,
  GoogleAdsStatusResponse,
} from "@/lib/google-ads/status-types";
import {
  canOpenGoogleAdsAdvisor,
  getGoogleAdsAdvisorButtonLabel,
  getGoogleAdsAdvisorCtaState,
  getGoogleAdsAdvisorHelperText,
  getGoogleAdsAdvisorIdleState,
} from "@/lib/google-ads/advisor-ux";
import { getGoogleAdsStatusRefetchInterval } from "@/lib/google-ads/sync-progress-ux";
import { resolveGoogleAdsSyncStatusPill } from "@/lib/sync/sync-status-pill";
import { shouldSuppressRecoverableGoogleSyncIssue } from "@/lib/sync/user-visible-sync";
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";

function getGoogleAdsSyncEmptyState(
  status: GoogleAdsStatusResponse | undefined,
  areaLabel: string,
  surfaceState?: GoogleAdsPanelSurfaceState | null
) {
  if (surfaceState && surfaceState.state !== "ready") {
    return {
      title:
        surfaceState.state === "extended_backfilling"
          ? `${areaLabel} is backfilling`
          : `${areaLabel} is limited`,
      description: surfaceState.message,
    };
  }
  if (!status) {
    return {
      title: `${areaLabel} is loading`,
      description: "Warehouse status is being checked. This section will fill in as soon as ready data is available.",
    };
  }
  if (!status.connected) {
    return {
      title: "Google Ads is not connected",
      description: `Connect a Google Ads account to load ${areaLabel.toLowerCase()}.`,
    };
  }
  if ((status.assignedAccountIds?.length ?? 0) === 0) {
    return {
      title: "Choose a Google Ads account",
      description: `Assign at least one Google Ads account to prepare ${areaLabel.toLowerCase()}.`,
    };
  }
  if (shouldSuppressRecoverableGoogleSyncIssue(status)) {
    return {
      title: `Using latest available ${areaLabel.toLowerCase()}`,
      description: "The latest persisted Google Ads data stays visible while background refresh continues.",
    };
  }
  if (status.state === "action_required") {
    const blockedScopes = status.actionRequired?.scopes ?? [];
    const scopeText = blockedScopes.length > 0 ? blockedScopes.join(", ") : null;
    return {
      title: "Reconnect Google Ads",
      description:
        scopeText
          ? `Google Ads access is blocking sync for: ${scopeText}. Reconnect the affected account before those surfaces can refresh.`
          : status.actionRequired?.reconnectCta
            ? "Google Ads account access requires reconnect before blocked sync surfaces can refresh."
            : (status.latestSync?.lastError ??
              "Google Ads account access requires operator action before sync can finish cleanly."),
    };
  }
  if (status.state === "paused") {
    return {
      title: `${areaLabel} is refreshing in the background`,
      description:
        status.latestSync?.lastError ??
        "The latest persisted Google Ads data stays visible while background refresh continues.",
    };
  }
  if (
    status.state === "syncing" ||
    status.state === "partial" ||
    status.state === "stale"
  ) {
    const readyThrough = status.latestSync?.readyThroughDate;
    return {
      title: `${areaLabel} is still preparing`,
      description:
        readyThrough
          ? `Historical data is syncing in the background. Ready through ${readyThrough}.`
          : "Historical data is syncing in the background. This section will fill in progressively.",
    };
  }
  return {
    title: `No ${areaLabel.toLowerCase()} found`,
    description: "Try broadening the date range or filters.",
  };
}

function getSurfaceBadgeLabel(surface: GoogleAdsPanelSurfaceState) {
  switch (surface.state) {
    case "extended_backfilling":
      return "Extended backfilling";
    case "extended_limited":
      return "Extended limited";
    case "core_live":
      return "Core live";
    default:
      return "Ready";
  }
}

function getSurfaceBadgeClass(surface: GoogleAdsPanelSurfaceState) {
  switch (surface.state) {
    case "extended_backfilling":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "extended_limited":
      return "border-slate-200 bg-slate-50 text-slate-700";
    case "core_live":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    default:
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
  }
}

function SurfaceRecoveryNotice({
  surface,
  rangeCompletion,
}: {
  surface: GoogleAdsPanelSurfaceState | null | undefined;
  rangeCompletion?:
    | {
        selectedRange: {
          completedDays: number;
          totalDays: number;
          readyThroughDate: string | null;
          ready: boolean;
        };
        historical: {
          completedDays: number;
          totalDays: number;
          readyThroughDate: string | null;
          ready: boolean;
        };
      }
    | null
    | undefined;
}) {
  if (!surface || surface.state === "ready") return null;
  return (
    <div className="rounded-lg border border-dashed border-border/70 bg-muted/20 p-3">
      <div className="flex flex-wrap items-center gap-2">
        <span
          className={cn(
            "rounded-full border px-2 py-0.5 text-[12px] font-medium",
            getSurfaceBadgeClass(surface)
          )}
        >
          {getSurfaceBadgeLabel(surface)}
        </span>
        <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[12px] text-muted-foreground">
          Coverage {surface.completedDays}/{surface.totalDays} days
        </span>
        {surface.readyThroughDate ? (
          <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[12px] text-muted-foreground">
            Ready through {surface.readyThroughDate}
          </span>
        ) : null}
        {rangeCompletion ? (
          <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[12px] text-muted-foreground">
            Visible coverage {rangeCompletion.selectedRange.completedDays}/{rangeCompletion.selectedRange.totalDays} {rangeCompletion.selectedRange.ready ? "ready" : "backfilling"}
          </span>
        ) : null}
        {rangeCompletion ? (
          <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[12px] text-muted-foreground">
            Historical {rangeCompletion.historical.completedDays}/{rangeCompletion.historical.totalDays} {rangeCompletion.historical.ready ? "ready" : "backfilling"}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{surface.message}</p>
      {surface.latestBackgroundActivityAt ? (
        <p className="mt-1 text-[12px] text-muted-foreground">
          Latest background activity {surface.latestBackgroundActivityAt}
        </p>
      ) : null}
    </div>
  );
}

function getDomainBadgeClass(
  state: NonNullable<GoogleAdsStatusResponse["domains"]>["core"]["state"]
) {
  switch (state) {
    case "ready":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "partial":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "advisor_not_ready":
      return "border-sky-200 bg-sky-50 text-sky-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function StatusDomainRow({
  label,
  summary,
}: {
  label: string;
  summary: NonNullable<GoogleAdsStatusResponse["domains"]>["core"] | null | undefined;
}) {
  if (!summary) return null;
  return (
    <div className="flex flex-wrap items-center gap-2 text-[11px]">
      <span className="text-muted-foreground">{label}</span>
      <span
        className={cn(
          "rounded-full border px-2 py-0.5 font-medium",
          getDomainBadgeClass(summary.state)
        )}
      >
        {summary.label}
      </span>
      <span className="text-muted-foreground">{summary.detail}</span>
    </div>
  );
}

function filterAdvisorByTypes(
  advisor: GoogleAdvisorResponse | undefined,
  allowedTypes: string[]
): GoogleAdvisorResponse | null {
  if (!advisor) return null;
  const allowed = new Set(allowedTypes);
  const sections = advisor.sections
    .map((section) => ({
      ...section,
      recommendations: section.recommendations.filter((recommendation) =>
        allowed.has(recommendation.type)
      ),
    }))
    .filter((section) => section.recommendations.length > 0);

  if (sections.length === 0) return null;

  return {
    ...advisor,
    sections,
    recommendations: sections.flatMap((section) => section.recommendations),
  };
}

function buildAdvisorQueryParams(input: {
  businessId: string;
  startDate?: string;
  endDate?: string;
  refresh?: boolean;
}) {
  const params = new URLSearchParams({ businessId: input.businessId });
  if (input.startDate && input.endDate) {
    params.set("dateRange", "custom");
    params.set("customStart", input.startDate);
    params.set("customEnd", input.endDate);
  }
  if (input.refresh) params.set("refresh", "1");
  return params;
}

function buildGoogleAdsDataQueryParams(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  compareMode?: string;
}) {
  const params = new URLSearchParams({
    businessId: input.businessId,
    dateRange: "custom",
    customStart: input.startDate,
    customEnd: input.endDate,
  });
  if (input.compareMode) params.set("compareMode", input.compareMode);
  return params;
}

/** Save a CSV the operator can open directly, without a server round trip. */
function downloadSearchTermCsv(csv: string, filename: string) {
  if (typeof document === "undefined") return;
  const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
  const url = URL.createObjectURL(blob);
  const link = document.createElement("a");
  link.href = url;
  link.download = `${filename}.csv`;
  document.body.appendChild(link);
  link.click();
  link.remove();
  URL.revokeObjectURL(url);
}

/**
 * Run a zero-risk escape hatch and report what actually happened.
 *
 * These events answer "does the escape hatch work" -- the whole point of a
 * copy or CSV button is that an operator can take the work out of the product
 * when the product cannot help. Hardcoding `outcome: "ok"` made the metric
 * answer "was the button clicked" instead, so the hatch would have looked
 * healthiest in exactly the browsers where it silently does nothing.
 */
async function reportGoogleEscapeHatch(input: {
  eventName: "google_copy_used" | "google_csv_used";
  businessId: string;
  itemCount: number;
  run: () => Promise<unknown>;
}) {
  try {
    await input.run();
    emitProductInstrumentation({
      eventName: input.eventName,
      surface: "google_ads",
      outcome: "ok",
      scope: "business",
      businessId: input.businessId,
      provider: "google",
      itemCount: input.itemCount,
    });
  } catch {
    // Failed, not withheld: withheld means we chose not to, and we tried.
    emitProductInstrumentation({
      eventName: input.eventName,
      surface: "google_ads",
      outcome: "failed",
      scope: "business",
      businessId: input.businessId,
      provider: "google",
      itemCount: input.itemCount,
    });
  }
}

export function GoogleAdsIntelligenceDashboard({ businessId }: { businessId: string }) {

  const [selectedGoogleAccountId, setSelectedGoogleAccountId] = useState<string | null>(null);
  const [dateRange, setDateRange] = usePersistentDateRange();
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [selectedCampaignNames, setSelectedCampaignNames] = useState<string[]>([]);
  const [includeSpentInactive, setIncludeSpentInactive] = useState(false);
  const [activePanel, setActivePanel] = useState<PanelKey>("summary");
  const [focusedSearchTerms, setFocusedSearchTerms] = useState<string[]>([]);
  const [focusedProducts, setFocusedProducts] = useState<string[]>([]);
  const [focusedAssets, setFocusedAssets] = useState<string[]>([]);
  const [focusedAssetGroups, setFocusedAssetGroups] = useState<string[]>([]);
  const [resolvedGoogleReferenceDate, setResolvedGoogleReferenceDate] = useState<string | null>(null);
  const [resolvedGoogleTimeZoneLabel, setResolvedGoogleTimeZoneLabel] = useState<string | null>(null);

  const baseStatusQuery = useQuery<GoogleAdsStatusResponse>({
    queryKey: ["gads-status-base", businessId],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId });
      const res = await fetch(`/api/google-ads/status?${params}`);
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(payload?.message ?? payload?.error ?? "status fetch failed");
      }
      return res.json();
    },
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getGoogleAdsStatusRefetchInterval(query.state.data),
    enabled: Boolean(businessId),
  });
  const googleReferenceDate = baseStatusQuery.data?.currentDateInTimezone ?? undefined;
  const googleTimeZoneLabel = baseStatusQuery.data?.primaryAccountTimezone ?? undefined;

  useEffect(() => {
    if (googleReferenceDate) setResolvedGoogleReferenceDate(googleReferenceDate);
  }, [googleReferenceDate]);

  useEffect(() => {
    if (googleTimeZoneLabel) setResolvedGoogleTimeZoneLabel(googleTimeZoneLabel);
  }, [googleTimeZoneLabel]);

  const effectiveGoogleTimeZoneLabel =
    googleTimeZoneLabel ?? resolvedGoogleTimeZoneLabel ?? "UTC";
  const effectiveGoogleReferenceDate =
    googleReferenceDate ??
    resolvedGoogleReferenceDate ??
    getTodayIsoForTimeZone(effectiveGoogleTimeZoneLabel);

  const { start: startDate, end: endDate } =
    dateRange.rangePreset === "custom"
      ? {
          start: dateRange.customStart,
          end: dateRange.customEnd,
        }
      : getPresetDatesForReferenceDate(
          dateRange.rangePreset,
          effectiveGoogleReferenceDate,
          dateRange.customStart,
          dateRange.customEnd
        );
  const compareMode = dateRange.comparisonPreset === "none" ? "none" : "previous_period";
  const { labelMode: trendLabelMode } = useMemo(
    () => resolveTrendTimeline(startDate, endDate),
    [startDate, endDate]
  );
  const needsAdvisorData =
    activePanel === "summary" ||
    activePanel === "insights" ||
    activePanel === "assetGroupAudience" ||
    activePanel === "products" ||
    activePanel === "assets";
  const needsTrendData = activePanel === "summary";
  const needsAssetGroupAudienceData = activePanel === "assetGroupAudience";
  const needsProductsData = activePanel === "products";
  const needsAssetsData = activePanel === "assets";
  const needsInsightsData = activePanel === "insights";
  const currentAdvisorKey = businessId;

  const { data, isLoading, isError } = useQuery<CampaignsResponse>({
    queryKey: ["gads-campaigns", businessId, startDate, endDate, compareMode],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate, compareMode });
      const res = await fetch(`/api/google-ads/campaigns?${params}`);
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(businessId),
  });

  const [advisorData, setAdvisorData] = useState<GoogleAdvisorResponse | undefined>(undefined);
  const [advisorAnalysisKey, setAdvisorAnalysisKey] = useState<string | null>(null);
  const [lastAnalyzedLabel, setLastAnalyzedLabel] = useState<string | null>(null);
  const {
    mutate: runAdvisorAnalysis,
    isPending: isAdvisorLoading,
    isError: isAdvisorError,
  } = useMutation<GoogleAdvisorResponse, Error, { refresh: boolean }>({
    mutationFn: async ({ refresh }) => {
      const params = buildAdvisorQueryParams({
        businessId,
        startDate,
        endDate,
        refresh,
      });
      const res = await fetch(`/api/google-ads/advisor?${params}`);
      if (!res.ok) throw new Error("advisor fetch failed");
      return res.json();
    },
    onSuccess: (payload) => {
      setAdvisorData(payload);
      setAdvisorAnalysisKey(currentAdvisorKey);
      setLastAnalyzedLabel(payload.metadata?.asOfDate ?? new Date().toISOString().slice(0, 10));
    },
  });
  const refreshAdvisorView = () => {
    runAdvisorAnalysis({ refresh: false });
  };

  const { data: assetGroupData, isLoading: isAssetGroupsLoading } = useQuery<AssetGroupsResponse>({
    queryKey: ["gads-asset-groups", businessId, startDate, endDate],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/asset-groups?${params}`);
      if (!res.ok) throw new Error("asset groups fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsAssetGroupAudienceData,
  });

  const { data: audiencesData, isLoading: isAudiencesLoading } = useQuery<AudiencesResponse>({
    queryKey: ["gads-audiences", businessId, startDate, endDate],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/audiences?${params}`);
      if (!res.ok) throw new Error("audiences fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsAssetGroupAudienceData,
  });

  const { data: assetsData, isLoading: isAssetsLoading } = useQuery<AssetsResponse>({
    queryKey: ["gads-assets", businessId, startDate, endDate],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/assets?${params}`);
      if (!res.ok) throw new Error("assets fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsAssetsData,
  });

  const { data: productsData, isLoading: isProductsLoading } = useQuery<ProductsResponse>({
    queryKey: ["gads-products", businessId, startDate, endDate],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/products?${params}`);
      if (!res.ok) throw new Error("products fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsProductsData,
  });

  const { data: searchTermsData, isLoading: isSearchTermsLoading } = useQuery<SearchIntelligenceResponse>({
    queryKey: ["gads-search-intelligence", businessId, startDate, endDate],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/search-intelligence?${params}`);
      if (!res.ok) throw new Error("search intelligence fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsInsightsData,
  });

  const { data: geoData, isLoading: isGeoLoading } = useQuery<GeoResponse>({
    queryKey: ["gads-geo", businessId, startDate, endDate],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/geo?${params}`);
      if (!res.ok) throw new Error("geo fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsInsightsData,
  });

  const { data: devicesData, isLoading: isDevicesLoading } = useQuery<DevicesResponse>({
    queryKey: ["gads-devices", businessId, startDate, endDate],
    queryFn: async () => {
      const params = buildGoogleAdsDataQueryParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/devices?${params}`);
      if (!res.ok) throw new Error("devices fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsInsightsData,
  });

  const { data: trendsData } = useQuery<GoogleAdsTrendsResponse>({
    queryKey: ["gads-trends", businessId, startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({
        businessId,
        dateRange: "custom",
        customStart: startDate,
        customEnd: endDate,
        compareMode: "none",
      });
      const res = await fetch(`/api/google-ads/trends?${params}`);
      if (!res.ok) throw new Error("trends fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsTrendData,
  });

  const {
    data: syncStatus,
    isLoading: isSyncStatusLoading,
    isError: isSyncStatusError,
  } = useQuery<GoogleAdsStatusResponse>({
    queryKey: ["gads-status", businessId, startDate, endDate],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId, startDate, endDate });
      const res = await fetch(`/api/google-ads/status?${params}`);
      if (!res.ok) {
        const payload = (await res.json().catch(() => null)) as
          | { message?: string; error?: string }
          | null;
        throw new Error(payload?.message ?? payload?.error ?? "status fetch failed");
      }
      return res.json();
    },
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getGoogleAdsStatusRefetchInterval(query.state.data),
  });

  // One freshness contract across every Tier-0 surface. Derived from the
  // query state this surface already has, so it cannot drift from what is
  // actually on screen.
  useTierZeroFreshness({
    surface: "google_ads",
    isLoading,
    // The newest real observation across scopes. The reference date is what
    // day it is in the account's timezone -- a range label, not a read time --
    // and using it made the reading drift with the hour and never say "stale".
    asOf: newestObservation(
      (syncStatus?.freshness?.scopes ?? []).map(
        (scope) => scope.latestObservationAt,
      ),
    ),
    // Evidence we could not read is not evidence of freshness.
    partialReason:
      syncStatus?.freshness && syncStatus.freshness.evidenceAvailable === false
        ? (syncStatus.freshness.unavailableReason ??
          "Google freshness evidence could not be read; the age shown is unknown")
        : null,
    error: isError ? "google_ads_unreadable" : null,
    businessId,
  });
  const advisorReady = Boolean(syncStatus?.advisor?.ready);
  const advisorCanOpen = canOpenGoogleAdsAdvisor({
    connected: Boolean(syncStatus?.connected),
    assignedAccountCount: syncStatus?.assignedAccountIds?.length ?? 0,
    advisorSnapshotReady: syncStatus?.operations?.advisorSnapshotReady === true,
    advisorSnapshotBlockedReason: syncStatus?.operations?.advisorSnapshotBlockedReason ?? null,
    fullSyncPriorityRequired: syncStatus?.operations?.fullSyncPriorityRequired === true,
    advisorMissingSurfaces: syncStatus?.advisor?.missingSurfaces ?? [],
  });
  // Blending several accounts is allowed, but it is now a stated mode with a
  // chooser, rather than an unlabelled sum that also silently removed deep links.
  const accountScope = resolveGoogleAccountScope({
    assignedAccountIds: syncStatus?.assignedAccountIds ?? [],
    selectedAccountId: selectedGoogleAccountId,
  });
  const advisorExecutionAccountId = accountScope.accountId;
  const advisorCurrent = advisorAnalysisKey === currentAdvisorKey ? advisorData : undefined;
  const advisorIsStale = advisorAnalysisKey != null && advisorAnalysisKey !== currentAdvisorKey;
  const advisorCtaState = getGoogleAdsAdvisorCtaState({
    status: syncStatus,
    canOpen: advisorCanOpen,
    hasCurrentAnalysis: Boolean(advisorCurrent),
    snapshotReady: syncStatus?.operations?.advisorSnapshotReady === true,
  });
  const advisorIdleState = getGoogleAdsAdvisorIdleState(syncStatus, {
    isStatusLoading: isSyncStatusLoading,
    isStatusError: isSyncStatusError,
  });
  const syncStatusPill = resolveGoogleAdsSyncStatusPill(syncStatus);
  const shouldShowSyncStatusPill =
    (syncStatusPill?.state ?? "active") !== "active";
  useEffect(() => {
    if (!advisorReady && !advisorCanOpen && advisorAnalysisKey === currentAdvisorKey) {
      setAdvisorData(undefined);
      setAdvisorAnalysisKey(null);
      setLastAnalyzedLabel(null);
    }
  }, [advisorReady, advisorCanOpen, advisorAnalysisKey, currentAdvisorKey]);

  const rows = data?.rows ?? [];
  const scopedRows = rows.filter((r) => isCampaignActive(r.status) || (includeSpentInactive && r.spend > 0));
  const channels = Array.from(new Set(scopedRows.map((r) => r.channel))).filter(Boolean).sort();
  const channelRows = channelFilter === "all" ? scopedRows : scopedRows.filter((r) => r.channel === channelFilter);
  const campaignNameOptions = useMemo(
    () => Array.from(new Set(channelRows.map((r) => r.name))).filter(Boolean).sort((a, b) => a.localeCompare(b)),
    [channelRows]
  );
  const selectedInScope = selectedCampaignNames.filter((name) => campaignNameOptions.includes(name));
  const filtered = selectedInScope.length === 0 ? channelRows : channelRows.filter((r) => selectedInScope.includes(r.name));
  const sortedRows = [...filtered].sort((a, b) => b.spend - a.spend);

  const totalSpend = sortedRows.reduce((s, r) => s + r.spend, 0);
  const totalRevenue = sortedRows.reduce((s, r) => s + r.revenue, 0);
  const totalConv = sortedRows.reduce((s, r) => s + r.conversions, 0);
  const blendedRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;
  const blendedCpa = totalConv > 0 ? totalSpend / totalConv : 0;
  const totalImpressions = sortedRows.reduce((s, r) => s + Number(r.impressions ?? 0), 0);
  const totalClicks = sortedRows.reduce((s, r) => s + Number(r.clicks ?? 0), 0);
  const blendedCtr = totalImpressions > 0 ? (totalClicks / totalImpressions) * 100 : 0;
  const blendedCpc = totalClicks > 0 ? totalSpend / totalClicks : 0;
  const blendedCvR = totalClicks > 0 ? (totalConv / totalClicks) * 100 : 0;
  const avgImpressionShare =
    sortedRows.filter((r) => typeof r.impressionShare === "number").length > 0
      ? (sortedRows
          .filter((r) => typeof r.impressionShare === "number")
          .reduce((s, r) => s + Number(r.impressionShare ?? 0), 0) /
          sortedRows.filter((r) => typeof r.impressionShare === "number").length) *
        100
      : 0;
  const avgLostIsBudget =
    sortedRows.filter((r) => typeof r.lostIsBudget === "number").length > 0
      ? (sortedRows
          .filter((r) => typeof r.lostIsBudget === "number")
          .reduce((s, r) => s + Number(r.lostIsBudget ?? 0), 0) /
          sortedRows.filter((r) => typeof r.lostIsBudget === "number").length) *
        100
      : 0;

  const summaryTrendSeries = useMemo(() => {
    const rows = trendsData?.rows ?? [];
    if (rows.length === 0) {
      return {
        spend: [],
        roas: [],
        revenue: [],
        conversions: [],
        cpa: [],
        impressions: [],
        clicks: [],
        ctr: [],
        cpc: [],
        conversionRate: [],
        impressionShare: [],
        lostIsBudget: [],
      } as Record<string, Array<{ date: string; value: number }>>;
    }

    const selectedNames = new Set(selectedInScope);

    const matchesFilters = (row: { name: string; status: string; channel: string; spend: number }) => {
      const activeMatch = isCampaignActive(row.status) || (includeSpentInactive && row.spend > 0);
      const channelMatch = channelFilter === "all" || row.channel === channelFilter;
      const campaignMatch = selectedNames.size === 0 || selectedNames.has(row.name);
      return activeMatch && channelMatch && campaignMatch;
    };

    return {
      spend: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        return { date: point.date, value: scoped.reduce((sum, row) => sum + row.spend, 0) };
      }),
      revenue: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        return { date: point.date, value: scoped.reduce((sum, row) => sum + row.revenue, 0) };
      }),
      conversions: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        return { date: point.date, value: scoped.reduce((sum, row) => sum + row.conversions, 0) };
      }),
      impressions: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        return { date: point.date, value: scoped.reduce((sum, row) => sum + row.impressions, 0) };
      }),
      clicks: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        return { date: point.date, value: scoped.reduce((sum, row) => sum + row.clicks, 0) };
      }),
      roas: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        const spend = scoped.reduce((sum, row) => sum + row.spend, 0);
        const revenue = scoped.reduce((sum, row) => sum + row.revenue, 0);
        return { date: point.date, value: spend > 0 ? revenue / spend : 0 };
      }),
      cpa: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        const spend = scoped.reduce((sum, row) => sum + row.spend, 0);
        const conversions = scoped.reduce((sum, row) => sum + row.conversions, 0);
        return { date: point.date, value: conversions > 0 ? spend / conversions : 0 };
      }),
      ctr: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        const impressions = scoped.reduce((sum, row) => sum + row.impressions, 0);
        const clicks = scoped.reduce((sum, row) => sum + row.clicks, 0);
        return { date: point.date, value: impressions > 0 ? (clicks / impressions) * 100 : 0 };
      }),
      cpc: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        const spend = scoped.reduce((sum, row) => sum + row.spend, 0);
        const clicks = scoped.reduce((sum, row) => sum + row.clicks, 0);
        return { date: point.date, value: clicks > 0 ? spend / clicks : 0 };
      }),
      conversionRate: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters);
        const conversions = scoped.reduce((sum, row) => sum + row.conversions, 0);
        const clicks = scoped.reduce((sum, row) => sum + row.clicks, 0);
        return { date: point.date, value: clicks > 0 ? (conversions / clicks) * 100 : 0 };
      }),
      impressionShare: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters).filter((row) => typeof row.impressionShare === "number");
        const avg =
          scoped.length > 0
            ? (scoped.reduce((sum, row) => sum + Number(row.impressionShare ?? 0), 0) / scoped.length) * 100
            : 0;
        return { date: point.date, value: avg };
      }),
      lostIsBudget: rows.map((point) => {
        const scoped = point.rows.filter(matchesFilters).filter((row) => typeof row.lostIsBudget === "number");
        const avg =
          scoped.length > 0
            ? (scoped.reduce((sum, row) => sum + Number(row.lostIsBudget ?? 0), 0) / scoped.length) * 100
            : 0;
        return { date: point.date, value: avg };
      }),
    };
  }, [trendsData?.rows, selectedInScope, includeSpentInactive, channelFilter]);

  const assetGroupsByCampaignKey = useMemo(() => {
    const map = new Map<string, AssetGroupRow[]>();
    const rows = assetGroupData?.rows ?? [];
    for (const row of rows) {
      const key = row.campaignId ?? row.campaign ?? "";
      if (!key) continue;
      const current = map.get(key) ?? [];
      current.push(row);
      map.set(key, current);
    }
    return map;
  }, [assetGroupData?.rows]);

  const audiencesByCampaignKey = useMemo(() => {
    const map = new Map<string, AudienceRow[]>();
    const rows = audiencesData?.rows ?? [];
    for (const row of rows) {
      const key = row.campaignId ?? row.campaign ?? "";
      if (!key) continue;
      const current = map.get(key) ?? [];
      current.push(row);
      map.set(key, current);
    }
    return map;
  }, [audiencesData?.rows]);

  const campaignSignalCards = useMemo(() => {
    return sortedRows
      .map((campaign) => {
        const groups =
          assetGroupsByCampaignKey.get(campaign.id) ??
          assetGroupsByCampaignKey.get(campaign.name) ??
          [];
        const audienceRows =
          audiencesByCampaignKey.get(campaign.id) ??
          audiencesByCampaignKey.get(campaign.name) ??
          [];

        const totalThemes = groups.reduce((sum, g) => sum + (g.searchThemeCount ?? 0), 0);
        const alignedThemes = groups.reduce((sum, g) => sum + (g.searchThemeAlignedCount ?? 0), 0);
        const themeAlignment = totalThemes > 0 ? (alignedThemes / totalThemes) * 100 : 0;
        const weakAudienceSegments = audienceRows.filter((a) => a.spend > 50 && a.roas < 1.8);

        return {
          campaign,
          groups: [...groups].sort((a, b) => b.spend - a.spend),
          audienceRows,
          totalThemes,
          alignedThemes,
          themeAlignment,
          weakAudienceSegments,
        };
      })
      .filter((entry) => entry.groups.length > 0)
      .slice(0, 8);
  }, [sortedRows, assetGroupsByCampaignKey, audiencesByCampaignKey]);

  const scopedAssets = useMemo(() => {
    const rows = assetsData?.rows ?? [];
    if (sortedRows.length === 0) return rows;
    const campaignIds = new Set(sortedRows.map((r) => r.id));
    const campaignNames = new Set(sortedRows.map((r) => r.name));
    return rows.filter((row) => {
      const idMatch = row.campaignId ? campaignIds.has(row.campaignId) : false;
      const nameMatch = row.campaign ? campaignNames.has(row.campaign) : false;
      return idMatch || nameMatch;
    });
  }, [assetsData?.rows, sortedRows]);

  const underperformingAssets = useMemo(
    () => scopedAssets.filter((a) => a.performanceLabel === "underperforming"),
    [scopedAssets]
  );

  const topAssets = useMemo(
    () => scopedAssets.filter((a) => a.performanceLabel === "top").sort((a, b) => b.roas - a.roas).slice(0, 6),
    [scopedAssets]
  );

  const weakAssetsByType = useMemo(() => {
    const targets = ["Headline", "Description", "Image", "Video"] as const;
    const grouped = new Map<string, AssetRow[]>();
    for (const target of targets) {
      grouped.set(
        target,
        underperformingAssets
          .filter((asset) => asset.type === target)
          .sort((a, b) => b.spend - a.spend)
          .slice(0, 4)
      );
    }
    return grouped;
  }, [underperformingAssets]);

  const getAssetDisplayLabel = (asset: AssetRow) =>
    asset.assetName ??
    asset.preview ??
    asset.assetText ??
    asset.assetGroupName ??
    "Unnamed asset";

  const productRows = useMemo(
    () => [...(productsData?.rows ?? [])].sort((a, b) => b.spend - a.spend),
    [productsData?.rows]
  );

  const totalProductSpend = productRows.reduce((sum, row) => sum + Number(row.spend ?? 0), 0);
  const totalProductRevenue = productRows.reduce((sum, row) => sum + Number(row.revenue ?? 0), 0);
  const avgProductRoas = totalProductSpend > 0 ? totalProductRevenue / totalProductSpend : 0;
  const weakProducts = productRows.filter((row) => row.spend > 20 && row.roas < Math.max(avgProductRoas * 0.8, 1.5));

  const scopedSearchTerms = useMemo(() => {
    const rows = searchTermsData?.rows ?? [];
    if (sortedRows.length === 0) return rows;
    const campaignIds = new Set(sortedRows.map((r) => r.id));
    const campaignNames = new Set(sortedRows.map((r) => r.name));
    return rows.filter((row) => {
      const idMatch = row.campaignId ? campaignIds.has(row.campaignId) : false;
      const nameMatch = row.campaign ? campaignNames.has(row.campaign) : false;
      return idMatch || nameMatch;
    });
  }, [searchTermsData?.rows, sortedRows]);

  // The full candidate set, before the display cap. The panel shows the top
  // rows, but copy and CSV export the whole list — the long tail is exactly
  // what a weekly negative-keyword sweep is for.
  const searchTermNegativeCandidates = useMemo(
    () =>
      scopedSearchTerms
        .filter(
          (row) =>
            row.negativeKeywordFlag === true ||
            row.wasteFlag === true ||
            (row.spend > 20 && row.conversions === 0) ||
            (row.spend > 20 && row.roas < 1.3)
        )
        .sort((a, b) => b.spend - a.spend),
    [scopedSearchTerms]
  );

  const searchTermNegativeRows = useMemo(
    () => searchTermNegativeCandidates.slice(0, 8),
    [searchTermNegativeCandidates]
  );

  const searchTermPositiveRows = useMemo(
    () =>
      scopedSearchTerms
        .filter(
          (row) =>
            row.recommendation === "Add as exact keyword" ||
            row.recommendation === "Promote in headlines" ||
            row.keywordOpportunityFlag === true ||
            (row.conversions > 0 && row.roas >= Math.max(blendedRoas, 2))
        )
        .sort((a, b) => b.conversions - a.conversions)
        .slice(0, 8),
    [scopedSearchTerms, blendedRoas]
  );

  const negativeSpendTotal = searchTermNegativeRows.reduce((sum, row) => sum + row.spend, 0);
  const positiveSpendTotal = searchTermPositiveRows.reduce((sum, row) => sum + row.spend, 0);

  const topGeoRows = useMemo(
    () => [...(geoData?.rows ?? [])].sort((a, b) => b.spend - a.spend).slice(0, 4),
    [geoData?.rows]
  );
  const topDeviceRows = useMemo(
    () => [...(devicesData?.rows ?? [])].sort((a, b) => b.spend - a.spend).slice(0, 4),
    [devicesData?.rows]
  );

  const campaignAdvisorMap = useMemo(() => {
    const rows = advisorCurrent?.summary.campaignRoles ?? [];
    return new Map(rows.map((row) => [row.campaignId, row]));
  }, [advisorCurrent?.summary.campaignRoles]);

  const searchSourceCounts = useMemo(() => {
    let pmax = 0;
    let search = 0;
    for (const row of scopedSearchTerms) {
      const source = (row.matchSource ?? row.source ?? "").toString().toUpperCase();
      if (source.includes("PERFORMANCE_MAX") || source.includes("CAMPAIGN_SEARCH_TERM_VIEW")) {
        pmax += 1;
      } else {
        search += 1;
      }
    }
    return { pmax, search };
  }, [scopedSearchTerms]);

  if (isError) {
    return <div className="py-10 text-sm text-muted-foreground">Campaign data could not be loaded.</div>;
  }

  const panelSurfaceLookup = new Map(
    (syncStatus?.panel?.surfaceStates ?? []).map((surface) => [surface.scope, surface])
  );
  const searchSurfaceState = panelSurfaceLookup.get("search_term_daily") ?? null;
  const productSurfaceState = panelSurfaceLookup.get("product_daily") ?? null;
  const assetSurfaceState = panelSurfaceLookup.get("asset_daily") ?? null;
  const assetGroupSurfaceState = panelSurfaceLookup.get("asset_group_daily") ?? null;
  const audienceSurfaceState = panelSurfaceLookup.get("audience_daily") ?? null;
  const geoSurfaceState = panelSurfaceLookup.get("geo_daily") ?? null;
  const deviceSurfaceState = panelSurfaceLookup.get("device_daily") ?? null;
  const searchRangeCompletion = syncStatus?.rangeCompletionBySurface?.search_term_daily ?? null;
  const productRangeCompletion = syncStatus?.rangeCompletionBySurface?.product_daily ?? null;
  const assetRangeCompletion = syncStatus?.rangeCompletionBySurface?.asset_daily ?? null;
  const assetGroupRangeCompletion =
    syncStatus?.rangeCompletionBySurface?.asset_group_daily ?? null;
  const audienceRangeCompletion =
    syncStatus?.rangeCompletionBySurface?.audience_daily ?? null;
  const geoRangeCompletion = syncStatus?.rangeCompletionBySurface?.geo_daily ?? null;
  const deviceRangeCompletion = syncStatus?.rangeCompletionBySurface?.device_daily ?? null;

  const summaryEmptyState = getGoogleAdsSyncEmptyState(syncStatus, "Campaign data");
  const insightsEmptyState = getGoogleAdsSyncEmptyState(syncStatus, "Search insights", searchSurfaceState);
  const assetGroupEmptyState = getGoogleAdsSyncEmptyState(
    syncStatus,
    "Asset groups",
    assetGroupSurfaceState
  );
  const audienceEmptyState = getGoogleAdsSyncEmptyState(
    syncStatus,
    "Audience performance",
    audienceSurfaceState
  );
  const geoEmptyState = getGoogleAdsSyncEmptyState(syncStatus, "Geo performance", geoSurfaceState);
  const deviceEmptyState = getGoogleAdsSyncEmptyState(
    syncStatus,
    "Device performance",
    deviceSurfaceState
  );
  const productsEmptyState = getGoogleAdsSyncEmptyState(syncStatus, "Product performance", productSurfaceState);
  const assetsEmptyState = getGoogleAdsSyncEmptyState(syncStatus, "Asset performance", assetSurfaceState);
  const campaignScopeLabel = isLoading
    ? "Loading campaign data..."
    : scopedRows.length > 0
      ? `${scopedRows.length} campaigns · Google Ads`
      : summaryEmptyState.description;
  const advisorHelperText = getGoogleAdsAdvisorHelperText({
    status: syncStatus,
    ctaState: advisorCtaState,
    advisorIsStale,
    lastAnalyzedLabel,
    isStatusLoading: isSyncStatusLoading,
    isStatusError: isSyncStatusError,
  });
  const actionRequiredScopes =
    syncStatus?.actionRequired?.blockingScopes?.length
      ? syncStatus.actionRequired.blockingScopes
      : syncStatus?.actionRequired?.scopes ?? [];
  const actionRequiredScopeText =
    actionRequiredScopes.length > 0 ? actionRequiredScopes.join(", ") : null;
  const shouldShowActionRequiredBanner =
    syncStatus?.actionRequired?.reconnectCta === true;

  const summaryAdvisor = filterAdvisorByTypes(advisorCurrent, [
    "operating_model_gap",
    "brand_capture_control",
    "pmax_scaling_fit",
    "budget_reallocation",
  ]);

  const insightsAdvisor = filterAdvisorByTypes(advisorCurrent, [
    "non_brand_expansion",
    "query_governance",
    "keyword_buildout",
    "geo_device_adjustment",
    "diagnostic_guardrail",
  ]);

  const assetGroupAdvisor = filterAdvisorByTypes(advisorCurrent, [
    "asset_group_structure",
    "pmax_scaling_fit",
    "geo_device_adjustment",
  ]);

  const productsAdvisor = filterAdvisorByTypes(advisorCurrent, [
    "shopping_launch_or_split",
    "product_allocation",
    "budget_reallocation",
  ]);

  const assetsAdvisor = filterAdvisorByTypes(advisorCurrent, [
    "creative_asset_deployment",
  ]);

  const focusAdvisorEntity = (recommendation: GoogleAdvisorRecommendation) => {
    const searchFocus = [
      ...(recommendation.negativeQueries ?? []),
      ...(recommendation.promoteToExact ?? []),
      ...(recommendation.promoteToPhrase ?? []),
    ];
    const productFocus = [
      ...(recommendation.startingSkuClusters ?? []),
      ...(recommendation.scaleSkuClusters ?? []),
      ...(recommendation.reduceSkuClusters ?? []),
      ...(recommendation.hiddenWinnerSkuClusters ?? []),
      ...(recommendation.heroSkuClusters ?? []),
    ];
    const assetFocus = [
      ...(recommendation.scaleReadyAssets ?? []),
      ...(recommendation.testOnlyAssets ?? []),
      ...(recommendation.replaceAssets ?? []),
    ];
    const assetGroupFocus = [
      ...(recommendation.weakAssetGroups ?? []),
      ...(recommendation.keepSeparateAssetGroups ?? []),
    ];

    setFocusedSearchTerms(searchFocus);
    setFocusedProducts(productFocus);
    setFocusedAssets(assetFocus);
    setFocusedAssetGroups(assetGroupFocus);

    if (searchFocus.length > 0) {
      setActivePanel("insights");
      return;
    }
    if (productFocus.length > 0) {
      setActivePanel("products");
      return;
    }
    if (assetFocus.length > 0) {
      setActivePanel("assets");
      return;
    }
    if (assetGroupFocus.length > 0) {
      setActivePanel("assetGroupAudience");
      return;
    }

    if (activePanel !== "summary") {
      setActivePanel("summary");
    }
    const entityKey = recommendation.entityName?.toLowerCase().trim();
    if (!entityKey) return;
    const exactMatch = campaignNameOptions.find((name) => name.toLowerCase().trim() === entityKey);
    if (exactMatch) {
      setSelectedCampaignNames([exactMatch]);
    }
  };

  return (
    <div className="space-y-5">
      <div className="flex justify-center border-b border-border -mx-6 px-6 -mt-3">
        {PANEL_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setActivePanel(item.key)}
            className={cn(
              "whitespace-nowrap px-5 pb-2.5 pt-0 text-sm font-semibold transition-all border-b-2 -mb-px",
              activePanel === item.key
                ? "border-foreground text-foreground"
                : "border-transparent text-muted-foreground hover:text-foreground hover:border-border"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>

      <div className="flex flex-wrap items-center justify-between gap-3">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-base font-semibold tracking-tight">Campaigns</h1>
            <div className="flex flex-wrap items-center gap-1.5">
              <button
                type="button"
                onClick={() => setIncludeSpentInactive((p) => !p)}
                className={cn(
                  "inline-flex items-center rounded-md border px-2.5 py-1 text-[11px] font-medium",
                  includeSpentInactive ? "border-amber-200 bg-amber-50 text-amber-800" : "border-border bg-background text-muted-foreground"
                )}
              >
                Include inactive with spend &gt; 0
              </button>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="inline-flex items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-[11px] font-medium">
                    Type: {channelFilter === "all" ? "All" : channelFilter}
                    <ChevronDown className="h-3.5 w-3.5 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[180px]">
                  <DropdownMenuItem onClick={() => setChannelFilter("all")}>All types</DropdownMenuItem>
                  {channels.map((ch) => (
                    <DropdownMenuItem key={ch} onClick={() => setChannelFilter(ch)}>{ch}</DropdownMenuItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <DropdownMenu>
                <DropdownMenuTrigger asChild>
                  <button type="button" className="inline-flex max-w-[260px] items-center gap-1 rounded-md border bg-background px-2.5 py-1 text-[11px] font-medium">
                    <span className="truncate">
                      {selectedInScope.length === 0 ? "Campaigns: All" : selectedInScope.length === 1 ? `Campaign: ${selectedInScope[0]}` : `${selectedInScope.length} campaigns selected`}
                    </span>
                    <ChevronDown className="h-3.5 w-3.5 shrink-0 text-muted-foreground" />
                  </button>
                </DropdownMenuTrigger>
                <DropdownMenuContent align="start" className="min-w-[300px]">
                  <DropdownMenuLabel>Campaign names</DropdownMenuLabel>
                  <DropdownMenuCheckboxItem checked={selectedInScope.length === 0} onSelect={(e) => e.preventDefault()} onCheckedChange={() => setSelectedCampaignNames([])}>
                    All campaigns
                  </DropdownMenuCheckboxItem>
                  <DropdownMenuSeparator />
                  {campaignNameOptions.map((name) => (
                    <DropdownMenuCheckboxItem
                      key={name}
                      checked={selectedInScope.includes(name)}
                      onSelect={(e) => e.preventDefault()}
                      onCheckedChange={() => setSelectedCampaignNames((prev) => prev.includes(name) ? prev.filter((n) => n !== name) : [...prev, name])}
                    >
                      <span className="truncate">{name}</span>
                    </DropdownMenuCheckboxItem>
                  ))}
                </DropdownMenuContent>
              </DropdownMenu>

              <div className="ml-1 flex flex-wrap items-center gap-2 lg:flex-nowrap">
                <DateRangePicker
                  value={dateRange}
                  onChange={setDateRange}
                  referenceDate={effectiveGoogleReferenceDate}
                  timeZoneLabel={effectiveGoogleTimeZoneLabel}
                />
                <p className="text-xs text-muted-foreground whitespace-nowrap">
                  {campaignScopeLabel}
                </p>
                <div className="ml-auto flex min-w-0 items-center gap-2">
                  {(() => {
                    const advisorButtonLabel = getGoogleAdsAdvisorButtonLabel({
                      isLoading: isAdvisorLoading,
                      ctaState: advisorCtaState,
                    });

	                  return (
	                      <button
	                        type="button"
	                        onClick={() =>
	                          runAdvisorAnalysis({
	                            refresh:
	                              advisorCtaState === "prepare" ||
	                              advisorCtaState === "refreshable",
	                          })
	                        }
	                        disabled={!advisorCanOpen || isAdvisorLoading}
                        title={advisorHelperText}
                        aria-label={`${advisorButtonLabel}. ${advisorHelperText}`}
                        className={cn(
                          "inline-flex h-8 shrink-0 items-center rounded-md border px-2.5 text-[11px] font-semibold transition-colors",
                          !advisorCanOpen || isAdvisorLoading
                            ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
                            : advisorCurrent
                              ? "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100"
                              : "border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100"
                        )}
                      >
                        {advisorButtonLabel}
                      </button>
                    );
                  })()}
                  {isSyncStatusLoading ? (
                    <SyncStatusPillSkeleton className="w-28 shrink-0" />
                  ) : shouldShowSyncStatusPill ? (
                    <SyncStatusPill pill={syncStatusPill} />
                  ) : null}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      {/* Scope receipt. An operator must be able to see which account these
          numbers cover, and change it, before trusting any of them. */}
      {accountScope.mode !== "none" && (syncStatus?.assignedAccountIds?.length ?? 0) > 1 ? (
        <div
          role="status"
          className={`flex flex-wrap items-center gap-2 rounded-xl border px-4 py-2.5 text-[12px] ${
            accountScope.mixedCurrency
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-border/70 bg-card/70 text-muted-foreground"
          }`}
        >
          <span className="font-medium">
            {accountScope.mode === "blended" ? "Blended view" : "Scoped to one account"}
          </span>
          {accountScope.notice ? <span>{accountScope.notice}</span> : null}
          <label className="ml-auto flex items-center gap-1.5">
            <span className="sr-only">Google account</span>
            <select
              value={selectedGoogleAccountId ?? ""}
              onChange={(event) =>
                setSelectedGoogleAccountId(event.target.value || null)
              }
              className="rounded-md border border-border/70 bg-background px-2 py-1 text-[12px]"
            >
              <option value="">All assigned accounts (blended)</option>
              {(syncStatus?.assignedAccountIds ?? []).map((id) => (
                <option key={id} value={id}>
                  {id}
                </option>
              ))}
            </select>
          </label>
        </div>
      ) : null}

      {shouldShowActionRequiredBanner ? (
        <div
          role="status"
          className="rounded-xl border border-amber-200 bg-amber-50 px-4 py-3 text-sm text-amber-900"
        >
          <p className="font-semibold">Reconnect Google Ads</p>
          <p className="mt-1">
            {actionRequiredScopeText
              ? `Google Ads access is blocking sync for: ${actionRequiredScopeText}. Reconnect the affected account before those surfaces can refresh.`
              : "Google Ads account access requires reconnect before blocked sync surfaces can refresh."}
          </p>
        </div>
      ) : null}
      <div className="rounded-xl border border-border/70 bg-card/70 p-3">
        <div className="space-y-1.5">
          <StatusDomainRow label="Core" summary={syncStatus?.domains?.core} />
          <StatusDomainRow label="Visible coverage" summary={syncStatus?.domains?.selectedRange} />
          <StatusDomainRow label="Advisor" summary={syncStatus?.domains?.advisor} />
        </div>
      </div>

      {activePanel === "summary" && <section className="mb-6">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
            {isLoading ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />) : (
              <>
                <Kpi label="Spend" value={fmtCurrency(totalSpend)} series={summaryTrendSeries.spend} formatter={fmtCurrency} dateLabelMode={trendLabelMode} />
                <Kpi label="ROAS" value={fmtRoas(blendedRoas)} series={summaryTrendSeries.roas} formatter={fmtRoas} dateLabelMode={trendLabelMode} highlight={blendedRoas >= 3} />
                <Kpi label="Revenue" value={fmtCurrency(totalRevenue)} series={summaryTrendSeries.revenue} formatter={fmtCurrency} dateLabelMode={trendLabelMode} />
                <Kpi label="Conv" value={totalConv.toFixed(0)} series={summaryTrendSeries.conversions} formatter={(v) => v.toFixed(0)} dateLabelMode={trendLabelMode} />
                <Kpi label="CPA" value={totalConv > 0 ? fmtCurrency(blendedCpa) : "-"} series={summaryTrendSeries.cpa} formatter={fmtCurrency} dateLabelMode={trendLabelMode} />
              </>
            )}
        </div>
        <div className="mt-4 grid grid-cols-2 gap-2 md:grid-cols-4 xl:grid-cols-7">
            <OverviewMetric
              label="Impressions"
              value={fmtNumber(totalImpressions)}
              accent="sky"
              series={summaryTrendSeries.impressions}
              formatter={fmtNumber}
              dateLabelMode={trendLabelMode}
            />
            <OverviewMetric
              label="Clicks"
              value={fmtNumber(totalClicks)}
              accent="emerald"
              series={summaryTrendSeries.clicks}
              formatter={fmtNumber}
              dateLabelMode={trendLabelMode}
            />
            <OverviewMetric
              label="CTR"
              value={fmtPct(blendedCtr)}
              accent="indigo"
              series={summaryTrendSeries.ctr}
              formatter={fmtPct}
              dateLabelMode={trendLabelMode}
            />
            <OverviewMetric
              label="Average CPC"
              value={totalClicks > 0 ? fmtCurrencyPrecise(blendedCpc) : "-"}
              accent="amber"
              series={summaryTrendSeries.cpc}
              formatter={fmtCurrencyPrecise}
              dateLabelMode={trendLabelMode}
            />
            <OverviewMetric
              label="Conversion Rate"
              value={totalClicks > 0 ? fmtPct(blendedCvR) : "-"}
              accent="teal"
              series={summaryTrendSeries.conversionRate}
              formatter={fmtPct}
              dateLabelMode={trendLabelMode}
            />
            <OverviewMetric
              label="Impression Share"
              value={avgImpressionShare > 0 ? fmtPct(avgImpressionShare) : "-"}
              accent="violet"
              series={summaryTrendSeries.impressionShare}
              formatter={fmtPct}
              dateLabelMode={trendLabelMode}
            />
            <OverviewMetric
              label="Lost IS (Budget)"
              value={avgLostIsBudget > 0 ? fmtPct(avgLostIsBudget) : "-"}
              accent="rose"
              series={summaryTrendSeries.lostIsBudget}
              formatter={fmtPct}
              dateLabelMode={trendLabelMode}
            />
        </div>
      </section>}

      {activePanel === "summary" && (isLoading ? (
        <div className="space-y-2.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
      ) : sortedRows.length === 0 ? (
        <EmptyState title={summaryEmptyState.title} description={summaryEmptyState.description} />
      ) : (
        <div className="grid gap-2 md:grid-cols-3 xl:grid-cols-5 2xl:grid-cols-6">
          {sortedRows.map((c) => (
            <CampaignCard
              key={c.id}
              campaign={c}
              accountAvgRoas={data?.summary.accountAvgRoas ?? blendedRoas}
              advisorRow={
                campaignAdvisorMap.get(String(c.id)) ??
                Array.from(campaignAdvisorMap.values()).find((row) => row.campaignName === c.name)
              }
            />
          ))}
        </div>
      ))}

      {activePanel === "summary" && summaryAdvisor?.sections.length ? (
        <section className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Account-level growth decisions and lane orchestration</p>
          <GoogleAdvisorPanel
            advisor={summaryAdvisor}
            onFocusEntity={focusAdvisorEntity}
            businessId={businessId}
            accountId={advisorExecutionAccountId}
            onRefreshAdvisor={refreshAdvisorView}
          />
        </section>
      ) : activePanel === "summary" ? (
        <section className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          {isAdvisorLoading ? (
            <Skeleton className="h-32 w-full rounded-xl" />
          ) : isAdvisorError ? (
            <ErrorState />
          ) : (
            <EmptyState title={advisorIdleState.title} description={advisorIdleState.description} />
          )}
        </section>
      ) : null}

      {activePanel === "insights" ? (
        <section className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          {isAdvisorLoading ? (
            <Skeleton className="h-40 w-full rounded-xl" />
          ) : isAdvisorError ? (
            <ErrorState />
          ) : insightsAdvisor?.summary ? (
            <GoogleAdvisorPanel
              advisor={insightsAdvisor}
              onFocusEntity={focusAdvisorEntity}
              businessId={businessId}
              accountId={advisorExecutionAccountId}
              onRefreshAdvisor={refreshAdvisorView}
            />
          ) : (
            <EmptyState
              title={advisorIdleState.title}
              description={advisorIdleState.description}
            />
          )}

          <p className="text-xs text-muted-foreground">Search terms and when/where ads appeared metrics</p>
          <div className="space-y-2">
            <SurfaceRecoveryNotice surface={searchSurfaceState} rangeCompletion={searchRangeCompletion} />
            <SurfaceRecoveryNotice surface={geoSurfaceState} rangeCompletion={geoRangeCompletion} />
            <SurfaceRecoveryNotice surface={deviceSurfaceState} rangeCompletion={deviceRangeCompletion} />
          </div>
          {isSearchTermsLoading || isGeoLoading || isDevicesLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-xl" />)}</div>
          ) : scopedSearchTerms.length === 0 && topGeoRows.length === 0 && topDeviceRows.length === 0 ? (
            <EmptyState title={insightsEmptyState.title} description={insightsEmptyState.description} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-muted-foreground">Search terms {scopedSearchTerms.length}</span>
                <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-foreground/80">PMax {searchSourceCounts.pmax}</span>
                <span className="rounded-full border border-border/70 bg-muted/40 px-2 py-0.5 text-foreground/80">Search {searchSourceCounts.search}</span>
                <span className="rounded-full border border-border/70 bg-rose-50/40 px-2 py-0.5 text-rose-700">Negative {searchTermNegativeRows.length}</span>
                <span className="rounded-full border border-border/70 bg-emerald-50/40 px-2 py-0.5 text-emerald-700">Positive {searchTermPositiveRows.length}</span>
              </div>

              <div className="grid gap-2 xl:grid-cols-2">
                <div className="rounded-lg border border-border/70 bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <p className="text-xs font-semibold tracking-tight">Search terms - Negative / waste</p>
                    {searchTermNegativeCandidates.length > 0 ? (
                      <div className="flex items-center gap-1.5">
                        <button
                          type="button"
                          className="rounded border border-border/70 px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-muted/60"
                          onClick={() => {
                            // Section 9: the zero-risk escape hatch was used.
                            // Only that it happened and how many rows -- never
                            // the keywords themselves.
                            //
                            // Reported from the clipboard's own result. The
                            // write was fire-and-forget behind an optional
                            // chain and the event hardcoded "ok", so a browser
                            // with no Clipboard API (any non-secure context) or
                            // a denied permission produced a clean success for
                            // a copy that never happened -- the escape hatch
                            // would have looked healthiest exactly where it was
                            // broken.
                            void reportGoogleEscapeHatch({
                              eventName: "google_copy_used",
                              businessId,
                              itemCount: searchTermNegativeCandidates.length,
                              run: () => {
                                if (!navigator.clipboard?.writeText) {
                                  return Promise.reject(
                                    new Error("clipboard_unavailable"),
                                  );
                                }
                                return navigator.clipboard.writeText(
                                  buildNegativeKeywordList(
                                    searchTermNegativeCandidates,
                                    "phrase",
                                  ),
                                );
                              },
                            });
                          }}
                          title="Copy every candidate as a phrase-match negative list for the Google Ads bulk editor"
                        >
                          Copy negatives
                        </button>
                        {/*
                          Scoped deep link into Google Ads. Refused rather than
                          guessed when the account cannot be named -- landing on
                          the wrong account is worse than no link, because the
                          operator then acts on someone else's data.
                        */}
                        {buildGoogleAdsDeepLink({
                          accountId: advisorExecutionAccountId,
                          target: { kind: "search_terms" },
                        }) ? (
                          <a
                            href={
                              buildGoogleAdsDeepLink({
                                accountId: advisorExecutionAccountId,
                                target: { kind: "search_terms" },
                              }) ?? undefined
                            }
                            target="_blank"
                            rel="noopener noreferrer"
                            className="rounded border border-border/70 px-2 py-0.5 text-[12px] text-foreground/80 hover:bg-muted/60"
                            onClick={() =>
                              emitProductInstrumentation({
                                eventName: "google_deep_link_used",
                                surface: "google_ads",
                                outcome: "ok",
                                scope: "business",
                                businessId,
                                provider: "google",
                              })
                            }
                          >
                            {describeGoogleAdsDeepLink({ kind: "search_terms" })}
                          </a>
                        ) : null}
                        <button
                          type="button"
                          className="rounded border border-border/70 px-2 py-0.5 text-[11px] text-foreground/80 hover:bg-muted/60"
                          onClick={() => {
                            // Emitted after the download is handed off, not
                            // before it: an event fired ahead of the action it
                            // names counts intentions rather than downloads.
                            void reportGoogleEscapeHatch({
                              eventName: "google_csv_used",
                              businessId,
                              itemCount: searchTermNegativeCandidates.length,
                              run: async () => {
                                downloadSearchTermCsv(
                                  buildSearchTermCsv(
                                    searchTermNegativeCandidates,
                                    {
                                      accountLabel:
                                        advisorExecutionAccountId ?? null,
                                      currency: null,
                                      windowStart: startDate,
                                      windowEnd: endDate,
                                    },
                                    "phrase",
                                  ),
                                  "search-terms-negative",
                                );
                              },
                            });
                          }}
                          title="Download every candidate with raw values, reasons, and window"
                        >
                          CSV
                        </button>
                      </div>
                    ) : null}
                  </div>
                  {searchTermNegativeCandidates.length > searchTermNegativeRows.length ? (
                    <p className="mt-1 text-[11px] text-muted-foreground">
                      Showing top {searchTermNegativeRows.length} of{" "}
                      {searchTermNegativeCandidates.length} candidates by spend. Copy and CSV
                      include all {searchTermNegativeCandidates.length}.
                    </p>
                  ) : null}
                  {searchTermNegativeRows.length === 0 ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">No high-risk search term in this filter.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {searchTermNegativeRows.map((row, index) => (
                        <div
                          key={`${row.key ?? `${row.searchTerm}-${row.campaign ?? ""}`}-${index}`}
                          className={cn(
                            "rounded-md border border-border/70 bg-muted/20 p-2",
                            focusedSearchTerms.some(
                              (term) =>
                                term.toLowerCase().trim() === row.searchTerm.toLowerCase().trim()
                            ) && "border-rose-300 bg-rose-50/40"
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="line-clamp-1 text-[11px] font-medium">{row.searchTerm}</p>
                            <div className="flex items-center gap-1">
                              <span className="rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[12px] text-foreground/80">{row.campaign ?? "Campaign"}</span>
                              <span className="rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[12px] text-muted-foreground">{(row.matchSource ?? row.source ?? "SEARCH").toString().replaceAll("_", " ")}</span>
                            </div>
                          </div>
                          <p className="mt-0.5 text-[12px] text-muted-foreground">Spend {fmtCurrency(row.spend)} · ROAS {fmtRoas(row.roas)} · Conv {row.conversions.toFixed(0)}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className="rounded-full border border-border/70 bg-rose-50/40 px-1.5 py-0.5 text-[12px] text-rose-700">Add negative</span>
                            {focusedSearchTerms.some(
                              (term) =>
                                term.toLowerCase().trim() === row.searchTerm.toLowerCase().trim()
                            ) ? (
                              <span className="rounded-full border border-border/70 bg-amber-50/40 px-1.5 py-0.5 text-[12px] text-amber-700">
                                Advisor focus
                              </span>
                            ) : null}
                            {row.recommendation ? <span className="rounded-full border border-border/70 bg-amber-50/40 px-1.5 py-0.5 text-[12px] text-amber-700">{row.recommendation}</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>

                <div className="rounded-lg border border-border/70 bg-card p-3">
                  <p className="text-xs font-semibold tracking-tight">Search terms - Positive / opportunity</p>
                  {searchTermPositiveRows.length === 0 ? (
                    <p className="mt-2 text-[11px] text-muted-foreground">No strong search term opportunity in this filter.</p>
                  ) : (
                    <div className="mt-2 space-y-1.5">
                      {searchTermPositiveRows.map((row, index) => (
                        <div
                          key={`${row.key ?? `${row.searchTerm}-${row.campaign ?? ""}`}-${index}`}
                          className={cn(
                            "rounded-md border border-border/70 bg-muted/20 p-2",
                            focusedSearchTerms.some(
                              (term) =>
                                term.toLowerCase().trim() === row.searchTerm.toLowerCase().trim()
                            ) && "border-emerald-300 bg-emerald-50/40"
                          )}
                        >
                          <div className="flex items-start justify-between gap-2">
                            <p className="line-clamp-1 text-[11px] font-medium">{row.searchTerm}</p>
                            <div className="flex items-center gap-1">
                              <span className="rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[12px] text-foreground/80">{row.campaign ?? "Campaign"}</span>
                              <span className="rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[12px] text-muted-foreground">{(row.matchSource ?? row.source ?? "SEARCH").toString().replaceAll("_", " ")}</span>
                            </div>
                          </div>
                          <p className="mt-0.5 text-[12px] text-muted-foreground">Spend {fmtCurrency(row.spend)} · ROAS {fmtRoas(row.roas)} · Conv {row.conversions.toFixed(0)}</p>
                          <div className="mt-1 flex flex-wrap gap-1">
                            <span className="rounded-full border border-border/70 bg-emerald-50/40 px-1.5 py-0.5 text-[12px] text-emerald-700">{row.recommendation === "Promote in headlines" ? "Promote headline" : "Add exact"}</span>
                            {focusedSearchTerms.some(
                              (term) =>
                                term.toLowerCase().trim() === row.searchTerm.toLowerCase().trim()
                            ) ? (
                              <span className="rounded-full border border-border/70 bg-sky-50/40 px-1.5 py-0.5 text-[12px] text-sky-700">
                                Advisor focus
                              </span>
                            ) : null}
                            {row.recommendation ? <span className="rounded-full border border-border/70 bg-sky-50/40 px-1.5 py-0.5 text-[12px] text-sky-700">{row.recommendation}</span> : null}
                          </div>
                        </div>
                      ))}
                    </div>
                  )}
                </div>
              </div>

              <div className="grid gap-2 xl:grid-cols-2">
                <div className="rounded-lg border border-border/70 bg-card p-3">
                  <p className="text-xs font-semibold tracking-tight">When and where ads showed - Locations</p>
                  <div className="mt-2 space-y-1.5">
                    {topGeoRows.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        {geoSurfaceState && geoSurfaceState.state !== "ready"
                          ? geoSurfaceState.message
                          : geoEmptyState.description}
                      </p>
                    ) : (
                      topGeoRows.map((row, index) => (
                        <div
                          key={`${row.country}-${row.spend}-${row.roas}-${index}`}
                          className="flex items-center justify-between rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-[11px]"
                        >
                          <span className="truncate font-medium">{row.country}</span>
                          <span className="text-muted-foreground">Spend {fmtCurrency(row.spend)} · ROAS {fmtRoas(row.roas)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>

                <div className="rounded-lg border border-border/70 bg-card p-3">
                  <p className="text-xs font-semibold tracking-tight">When and where ads showed - Devices</p>
                  <div className="mt-2 space-y-1.5">
                    {topDeviceRows.length === 0 ? (
                      <p className="text-[11px] text-muted-foreground">
                        {deviceSurfaceState && deviceSurfaceState.state !== "ready"
                          ? deviceSurfaceState.message
                          : deviceEmptyState.description}
                      </p>
                    ) : (
                      topDeviceRows.map((row, index) => (
                        <div
                          key={`${row.device}-${row.spend}-${row.roas}-${index}`}
                          className="flex items-center justify-between rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-[11px]"
                        >
                          <span className="truncate font-medium">{row.device}</span>
                          <span className="text-muted-foreground">Spend {fmtCurrency(row.spend)} · ROAS {fmtRoas(row.roas)}</span>
                        </div>
                      ))
                    )}
                  </div>
                </div>
              </div>
            </>
          )}
        </section>
      ) : null}

      {activePanel === "assetGroupAudience" ? (
        <section className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Asset group performance, search theme alignment, and audience risks by campaign</p>
          <div className="space-y-2">
            <SurfaceRecoveryNotice
              surface={assetGroupSurfaceState}
              rangeCompletion={assetGroupRangeCompletion}
            />
            <SurfaceRecoveryNotice
              surface={audienceSurfaceState}
              rangeCompletion={audienceRangeCompletion}
            />
          </div>
          {isAssetGroupsLoading || isAudiencesLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
          ) : (
            <div className="space-y-3">
              {campaignSignalCards.length === 0 ? (
                <EmptyState
                  title={assetGroupEmptyState.title}
                  description={assetGroupEmptyState.description}
                />
              ) : (
                <div className="max-h-[420px] space-y-2.5 overflow-auto pr-1">
                  {campaignSignalCards.map(({ campaign, groups, totalThemes, alignedThemes, themeAlignment, weakAudienceSegments, audienceRows }) => (
                    <div key={campaign.id} className="rounded-lg border border-border/70 bg-card p-3">
                  <div className="flex flex-wrap items-center justify-between gap-2">
                    <div>
                      <p className="text-sm font-semibold">{campaign.name}</p>
                      <p className="text-[11px] text-muted-foreground">{groups.length} asset group · {totalThemes} search theme · {audienceRows.length} audience signal</p>
                    </div>
                    <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                      <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-foreground/80">Theme match {fmtPct(themeAlignment)} ({alignedThemes}/{totalThemes})</span>
                      <span className={cn("rounded-full border border-border/70 px-2 py-0.5", weakAudienceSegments.length === 0 ? "bg-emerald-50/40 text-emerald-700" : "bg-rose-50/40 text-rose-700")}>Audience risk {weakAudienceSegments.length}</span>
                    </div>
                  </div>

                  <div className="mt-2 grid gap-2 md:grid-cols-2 xl:grid-cols-3">
                    {groups.map((group) => {
                      const groupThemeCount = group.searchThemeCount ?? group.searchThemes?.length ?? 0;
                      const groupAlignedCount = group.searchThemeAlignedCount ?? 0;
                      const groupThemeAlignment = groupThemeCount > 0 ? (groupAlignedCount / groupThemeCount) * 100 : 0;

                      return (
                        <div key={group.id} className="rounded-lg border border-border/70 bg-muted/20 p-2.5">
                          <div className="mb-2 flex flex-wrap gap-1">
                            {focusedAssetGroups.some(
                              (name) => name.toLowerCase().trim() === group.name.toLowerCase().trim()
                            ) ? (
                              <span className="rounded-full border border-border/70 bg-sky-50/40 px-1.5 py-0.5 text-[12px] text-sky-700">
                                Advisor focus
                              </span>
                            ) : null}
                            {(group.coverageScore ?? 0) < 50 || group.messagingMismatchCount ? (
                              <span className="rounded-full border border-border/70 bg-rose-50/40 px-1.5 py-0.5 text-[12px] text-rose-700">
                                Weak structure
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold">{group.name}</p>
                              <p className="text-[12px] text-muted-foreground">Spend {fmtCurrency(group.spend)} · ROAS {fmtRoas(group.roas)}</p>
                            </div>
                            <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold", group.roas >= blendedRoas ? "bg-emerald-50/50 text-emerald-700" : "bg-rose-50/50 text-rose-700")}>{group.roas >= blendedRoas ? "Above avg" : "Below avg"}</span>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1">
                            <span className="rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[12px] text-foreground/80">Theme fit {fmtPct(groupThemeAlignment)}</span>
                            <span className="rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[12px] text-foreground/80">Coverage {fmtPct(group.coverageScore ?? 0)}</span>
                            {group.messagingMismatchCount ? <span className="rounded-full border border-border/70 bg-rose-50/40 px-1.5 py-0.5 text-[12px] text-rose-700">{group.messagingMismatchCount} mismatch</span> : null}
                          </div>
                        </div>
                      );
                    })}
                  </div>
                    </div>
                  ))}
                </div>
              )}

              <div className="rounded-lg border border-border/70 bg-card p-3">
                <p className="text-xs font-semibold tracking-tight">Audience signals</p>
                {(() => {
                  const rows = [...(audiencesData?.rows ?? [])]
                    .sort((a, b) => b.spend - a.spend)
                    .slice(0, 8);
                  if (rows.length === 0) {
                    return (
                      <p className="mt-2 text-[11px] text-muted-foreground">
                        {audienceSurfaceState && audienceSurfaceState.state !== "ready"
                          ? audienceSurfaceState.message
                          : audienceEmptyState.description}
                      </p>
                    );
                  }
                  return (
                    <div className="mt-2 space-y-1.5">
                      {rows.map((row, index) => (
                        <div
                          key={`${row.campaign ?? "audience"}-${row.type}-${index}`}
                          className="flex items-center justify-between rounded-md border border-border/70 bg-muted/20 px-2 py-1.5 text-[11px]"
                        >
                          <div className="min-w-0">
                            <p className="truncate font-medium">{row.type}</p>
                            <p className="truncate text-[12px] text-muted-foreground">
                              {row.campaign ?? "Campaign signal"}
                            </p>
                          </div>
                          <span className="text-muted-foreground">
                            Spend {fmtCurrency(row.spend)} · ROAS {fmtRoas(row.roas)}
                          </span>
                        </div>
                      ))}
                    </div>
                  );
                })()}
              </div>
            </div>
          )}
          {assetGroupAdvisor?.sections.length ? (
            <GoogleAdvisorPanel
              advisor={assetGroupAdvisor}
              onFocusEntity={focusAdvisorEntity}
              businessId={businessId}
              accountId={advisorExecutionAccountId}
              onRefreshAdvisor={refreshAdvisorView}
            />
          ) : (
            <EmptyState title={advisorIdleState.title} description={advisorIdleState.description} />
          )}
        </section>
      ) : null}

      {activePanel === "products" ? (
        <section className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Product-level spend, revenue, ROAS, and contribution status from product truth</p>
          <SurfaceRecoveryNotice surface={productSurfaceState} rangeCompletion={productRangeCompletion} />
          {isProductsLoading ? (
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-20 w-full rounded-xl" />)}</div>
          ) : productRows.length === 0 ? (
            <EmptyState title={productsEmptyState.title} description={productsEmptyState.description} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-muted-foreground">Products {productRows.length}</span>
                <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-foreground/80">Total spend {fmtCurrency(totalProductSpend)}</span>
                <span className="rounded-full border border-border/70 bg-muted/30 px-2 py-0.5 text-foreground/80">Avg ROAS {fmtRoas(avgProductRoas)}</span>
                <span className={cn("rounded-full border border-border/70 px-2 py-0.5", weakProducts.length === 0 ? "bg-emerald-50/40 text-emerald-700" : "bg-rose-50/40 text-rose-700")}>Low performers {weakProducts.length}</span>
              </div>

              <div className="max-h-[360px] space-y-1 overflow-auto pr-1">
                {productRows.slice(0, 20).map((product, index) => {
                  const spendShare = totalProductSpend > 0 ? (product.spend / totalProductSpend) * 100 : 0;
                  const isWeak = product.spend > 20 && product.roas < Math.max(avgProductRoas * 0.8, 1.5);
                  return (
                    <div key={product.itemId ?? `${product.title ?? "product"}-${index}`} className="rounded-lg border border-border/70 bg-card px-2.5 py-2">
                      <div className="mb-1 flex flex-wrap gap-1">
                        {focusedProducts.some(
                          (name) => name.toLowerCase().trim() === (product.title ?? "").toLowerCase().trim()
                        ) ? (
                          <span className="rounded-full border border-border/70 bg-sky-50/40 px-1.5 py-0.5 text-[12px] text-sky-700">
                            Advisor focus
                          </span>
                        ) : null}
                        {product.title && productRows.some((row) => row.title === product.title && row.roas >= Math.max(avgProductRoas, 2.5)) ? (
                          <span className="rounded-full border border-border/70 bg-emerald-50/40 px-1.5 py-0.5 text-[12px] text-emerald-700">
                            Scale candidate
                          </span>
                        ) : null}
                        {isWeak ? (
                          <span className="rounded-full border border-border/70 bg-rose-50/40 px-1.5 py-0.5 text-[12px] text-rose-700">
                            Reduce
                          </span>
                        ) : null}
                      </div>
                      <div className="flex items-center justify-between gap-2">
                        <div className="min-w-0">
                          <p className="truncate text-[12px] font-medium">{product.title ?? product.itemId ?? "Unnamed product"}</p>
                          <p className="truncate text-[12px] text-muted-foreground">{product.itemId ?? "No item id"}</p>
                        </div>
                        <div className="flex flex-wrap items-center justify-end gap-1 text-[12px]">
                          <span className="rounded-full border border-border/70 px-1.5 py-0.5">S {fmtCurrency(product.spend)}</span>
                          <span className="rounded-full border border-border/70 px-1.5 py-0.5">R {fmtCurrency(product.revenue)}</span>
                          <span className="rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5">ROAS {fmtRoas(product.roas)}</span>
                          <span className="rounded-full border border-border/70 bg-muted/20 px-1.5 py-0.5">Conv {product.conversions.toFixed(0)}</span>
                          <span className="rounded-full border border-border/70 bg-muted/20 px-1.5 py-0.5">Share {fmtPct(spendShare)}</span>
                          <span className={cn("rounded-full border border-border/70 px-1.5 py-0.5", isWeak ? "bg-rose-50/40 text-rose-700" : "bg-emerald-50/40 text-emerald-700")}>{isWeak ? "Needs action" : "Healthy"}</span>
                        </div>
                      </div>
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {productsAdvisor?.sections.length ? (
            <GoogleAdvisorPanel
              advisor={productsAdvisor}
              onFocusEntity={focusAdvisorEntity}
              businessId={businessId}
              accountId={advisorExecutionAccountId}
              onRefreshAdvisor={refreshAdvisorView}
            />
          ) : (
            <EmptyState title={advisorIdleState.title} description={advisorIdleState.description} />
          )}
        </section>
      ) : null}

      {activePanel === "assets" ? (
        <section className="space-y-3 rounded-xl border border-border/70 bg-card p-3">
          <p className="text-xs text-muted-foreground">Instantly highlights weak headline, description, image, and video assets</p>
          <SurfaceRecoveryNotice surface={assetSurfaceState} rangeCompletion={assetRangeCompletion} />
          {isAssetsLoading ? (
            <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-xl" />)}</div>
          ) : scopedAssets.length === 0 ? (
            <EmptyState title={assetsEmptyState.title} description={assetsEmptyState.description} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-full border border-border/70 bg-rose-50/40 px-2 py-0.5 text-rose-700">Underperforming {underperformingAssets.length}</span>
                <span className="rounded-full border border-border/70 bg-emerald-50/40 px-2 py-0.5 text-emerald-700">Top assets {topAssets.length}</span>
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-muted-foreground">Total assets {scopedAssets.length}</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                {["Headline", "Description", "Image", "Video"].map((type) => {
                  const list = weakAssetsByType.get(type) ?? [];
                  return (
                    <div key={type} className="rounded-lg border border-border/70 bg-card p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold">{type}</p>
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold", list.length === 0 ? "bg-emerald-50/50 text-emerald-700" : "bg-rose-50/50 text-rose-700")}>{list.length === 0 ? "Healthy" : `${list.length} issue`}</span>
                      </div>
                      {list.length === 0 ? (
                        <p className="text-[11px] text-muted-foreground">No critical issue detected for this asset type.</p>
                      ) : (
                        <div className="space-y-1.5">
                          {list.map((asset) => (
                            <div
                              key={asset.id}
                              className={cn(
                                "rounded-md border border-border/70 bg-muted/20 p-2",
                                focusedAssets.some(
                                  (name) =>
                                    name.toLowerCase().trim() ===
                                    getAssetDisplayLabel(asset)
                                      .toLowerCase()
                                      .trim()
                                ) && "border-rose-300 bg-rose-50/40"
                              )}
                            >
                              <p className="line-clamp-1 text-[11px] font-medium">{getAssetDisplayLabel(asset)}</p>
                              <p className="mt-0.5 text-[12px] text-muted-foreground">Spend {fmtCurrency(asset.spend)} · ROAS {fmtRoas(asset.roas)} · Conv {asset.conversions.toFixed(0)}</p>
                              {focusedAssets.some(
                                (name) =>
                                  name.toLowerCase().trim() ===
                                  getAssetDisplayLabel(asset)
                                    .toLowerCase()
                                    .trim()
                              ) ? (
                                <div className="mt-1">
                                  <span className="rounded-full border border-border/70 bg-amber-50/40 px-1.5 py-0.5 text-[12px] text-amber-700">
                                    Advisor replace focus
                                  </span>
                                </div>
                              ) : null}
                            </div>
                          ))}
                        </div>
                      )}
                    </div>
                  );
                })}
              </div>
            </>
          )}
          {assetsAdvisor?.sections.length ? (
            <GoogleAdvisorPanel
              advisor={assetsAdvisor}
              onFocusEntity={focusAdvisorEntity}
              businessId={businessId}
              accountId={advisorExecutionAccountId}
              onRefreshAdvisor={refreshAdvisorView}
            />
          ) : (
            <EmptyState title={advisorIdleState.title} description={advisorIdleState.description} />
          )}
        </section>
      ) : null}
    </div>
  );
}

function Kpi({ label, value, series, formatter, dateLabelMode, highlight }: { label: string; value: string; series: Array<{ date: string; value: number }>; formatter: (value: number) => string; dateLabelMode: TrendLabelMode; highlight?: boolean; }) {
  return (
    <div className={cn("rounded-xl border bg-card p-3", highlight && "border-emerald-200 bg-emerald-50/50")}>
      <p className="text-[12px] font-semibold uppercase tracking-[0.1em] text-muted-foreground">{label}</p>
      <p className={cn("mt-1.5 text-[22px] font-semibold tracking-tight", highlight && "text-emerald-700")}>{value}</p>
      <div className="mt-1">
        <MiniTrendAreaChart data={series} tone="neutral" valueFormatter={formatter} dateLabelMode={dateLabelMode} className="h-10 w-full" />
      </div>
    </div>
  );
}

function CampaignCard({
  campaign,
  accountAvgRoas,
  advisorRow,
}: {
  campaign: Campaign;
  accountAvgRoas: number;
  advisorRow?: {
    familyLabel: string;
    roleLabel: string;
    recommendationCount: number;
    topActionHint: string | null;
  };
}) {
  const cfg = ACTION_CONFIG[campaign.actionState];
  // A campaign with no ROAS is not a campaign performing badly. Comparing an
  // absent value against the account average made it fail the test and render
  // in the loss colour, so "we have no data" read as "this is losing money".
  const hasRoas = Number.isFinite(campaign.roas) && campaign.roas > 0;
  const roasColor = !hasRoas
    ? undefined
    : campaign.roas >= accountAvgRoas
      ? "text-emerald-700"
      : "text-rose-600";
  return (
    <div className="h-full rounded-xl border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 rounded-full", isCampaignActive(campaign.status) ? "bg-emerald-500" : "bg-slate-300")} />
        <p className="truncate text-[13px] font-medium">{campaign.name}</p>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[12px] font-medium text-slate-600">{campaign.channel}</span>
        <span className={cn("rounded-full border px-1.5 py-0.5 text-[12px] font-semibold", cfg.border, cfg.chip)}>
          <span className={cn("mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle", cfg.dot)} />{cfg.label}
        </span>
        {advisorRow ? (
          <>
            <span className="rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[12px] text-foreground/80">
              {advisorRow.familyLabel}
            </span>
            <span className="rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[12px] text-muted-foreground">
              {advisorRow.roleLabel}
            </span>
          </>
        ) : null}
      </div>
      <div className="mt-2 grid grid-cols-2 gap-1 text-right">
        <Metric label="Spend" value={fmtCurrency(campaign.spend)} />
        <Metric label="ROAS" value={hasRoas ? fmtRoas(campaign.roas) : MISSING_VALUE} valueColor={roasColor} />
        <Metric label="Revenue" value={fmtCurrency(campaign.revenue)} />
        <Metric label="Conv." value={campaign.conversions.toFixed(0)} />
      </div>
      {advisorRow?.topActionHint ? (
        <div className="mt-3 border-t border-border/70 pt-2">
          <div className="flex items-start justify-between gap-2">
            <div className="min-w-0">
              <p className="text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                Advisor
              </p>
              <p className="mt-1 line-clamp-2 text-[12px] text-foreground/80">
                {advisorRow.topActionHint}
              </p>
            </div>
            {advisorRow.recommendationCount > 0 ? (
              <span className="shrink-0 rounded-full border border-border/70 bg-muted/20 px-1.5 py-0.5 text-[12px] font-medium text-muted-foreground">
                {advisorRow.recommendationCount}
              </span>
            ) : null}
          </div>
        </div>
      ) : null}
    </div>
  );
}

function Metric({ label, value, valueColor }: { label: string; value: string; valueColor?: string }) {
  return (
    <div>
      <p className="text-[12px] font-medium text-muted-foreground">{label}</p>
      <p className={cn("text-[13px] font-semibold", valueColor)}>{value}</p>
    </div>
  );
}

function OverviewMetric({
  label,
  value,
  accent,
  series,
  formatter,
  dateLabelMode,
}: {
  label: string;
  value: string;
  accent: "sky" | "emerald" | "indigo" | "amber" | "teal" | "violet" | "rose";
  series: Array<{ date: string; value: number }>;
  formatter: (value: number) => string;
  dateLabelMode: TrendLabelMode;
}) {
  const accentClasses: Record<typeof accent, string> = {
    sky: "from-sky-200/80 to-sky-400/80",
    emerald: "from-emerald-200/80 to-emerald-400/80",
    indigo: "from-indigo-200/80 to-indigo-400/80",
    amber: "from-amber-200/80 to-amber-400/80",
    teal: "from-teal-200/80 to-teal-400/80",
    violet: "from-violet-200/80 to-violet-400/80",
    rose: "from-rose-200/80 to-rose-400/80",
  };

  return (
    <div className="rounded-xl border border-border/70 bg-card/90 p-2.5 shadow-sm transition-colors hover:bg-card">
      <div className={cn("h-1 w-10 rounded-full bg-gradient-to-r", accentClasses[accent])} />
      <p className="mt-2 text-[12px] font-medium tracking-wide text-muted-foreground">{label}</p>
      <p className="mt-1 text-[18px] font-semibold leading-none tracking-tight text-foreground">{value}</p>
      <div className="mt-1.5">
        <MiniTrendAreaChart data={series} tone="neutral" valueFormatter={formatter} dateLabelMode={dateLabelMode} className="h-8 w-full" />
      </div>
    </div>
  );
}
