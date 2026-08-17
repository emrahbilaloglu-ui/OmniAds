"use client";

import { useEffect, useMemo, useState } from "react";
import { useMutation, useQuery, useQueryClient } from "@tanstack/react-query";
import { ChevronDown } from "lucide-react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { MiniTrendAreaChart } from "@/components/overview/MiniTrendAreaChart";
import {
  SyncStatusPill,
  SyncStatusPillSkeleton,
} from "@/components/sync/sync-status-pill";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import {
  BudgetScalingTab,
  type BudgetCampaign,
  type BudgetRec,
} from "@/components/google-ads/BudgetScalingTab";
import { GoogleCampaignsTable } from "@/components/google-ads/GoogleCampaignsTable";
import { GoogleWhereToLookFirst } from "@/components/google-ads/GoogleWhereToLookFirst";
import { GoogleSearchExact } from "@/components/google-ads/GoogleSearchExact";
import { GoogleProductsExact } from "@/components/google-ads/GoogleProductsExact";
import {
  buildGoogleSearchExactViewModel,
  type GoogleSearchExactKeywordSource,
  type GoogleSearchExactTab,
  type GoogleSearchTermFilterKey,
} from "@/components/google-ads/google-search-exact-adapter";
import { buildGoogleProductsExactViewModel } from "@/components/google-ads/google-products-exact-adapter";
import type { GoogleAdsKeywordInsightCounts } from "@/lib/google-ads/keyword-insights";
import { GoogleAdvisorTiles } from "@/components/google-ads/GoogleAdvisorTiles";
import { GoogleActivityTable } from "@/components/google-ads/GoogleActivityTable";
import type { GoogleAdsActivityEntry } from "@/lib/google-ads/advisor-memory";
import {
  GoogleAssetGroupsTable,
  GoogleAssetPair,
  GoogleAudiencesTable,
} from "@/components/google-ads/GoogleAssetSurfaces";
import { GoogleBudgetScalingCard } from "@/components/google-ads/GoogleBudgetScalingCard";
import { GoogleAllocationRead } from "@/components/google-ads/GoogleAllocationRead";
import { GoogleExecutionQueue } from "@/components/google-ads/GoogleExecutionQueue";
import { GoogleOverviewExact } from "@/components/google-ads/GoogleOverviewExact";
import { buildGoogleOverviewExactModel } from "@/components/google-ads/google-overview-exact-adapter";
import type { GoogleOverviewRouteTarget } from "@/components/google-ads/google-overview-exact-model";
import {
  GoogleAdvisorExact,
  type GoogleAdvisorDismissAuthority,
  type GoogleAdvisorSyncTone,
} from "@/components/google-ads/GoogleAdvisorExact";
import type { GoogleAuthorizedScope } from "@/components/google-ads/google-authorized-scope";
import { GoogleAdvisorPanel } from "@/components/google/google-advisor-panel";
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
  ASSET_VIEWS,
  normaliseBudgetRecommendations,
  PANEL_ITEMS,
  resolveTrendTimeline,
  type AssetViewKey,
  type GoogleBudgetInsights,
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
import { newestObservation } from "@/lib/tier-zero-as-of";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { emitProductInstrumentation } from "@/lib/product-instrumentation-client";
import { MISSING_VALUE } from "@/lib/metric-format";
import { resolveGoogleAccountScope } from "@/lib/google-ads/account-scope";
import {
  compareModeForPreset,
  customComparisonIsComplete,
} from "@/lib/comparison-preset-contract";
import { getComparisonWindow } from "@/lib/google-ads/reporting-support";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import type { GoogleAdsCanonicalOverviewSummaryResult } from "@/lib/google-ads/serving";
import {
  isGoogleAdsReadComplete,
  type GoogleAdsReadCompletenessMeta,
} from "@/lib/google-ads/read-completeness";
import { normalizeGoogleCustomerId } from "@/lib/google-ads/account-id";
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
      return "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]";
    case "extended_limited":
      return "border-slate-200 bg-slate-50 text-slate-700";
    case "core_live":
      return "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]";
    default:
      return "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]";
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
            "rounded-full border px-2 py-0.5 text-[10px] font-medium",
            getSurfaceBadgeClass(surface)
          )}
        >
          {getSurfaceBadgeLabel(surface)}
        </span>
        <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
          Coverage {surface.completedDays}/{surface.totalDays} days
        </span>
        {surface.readyThroughDate ? (
          <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
            Ready through {surface.readyThroughDate}
          </span>
        ) : null}
        {rangeCompletion ? (
          <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
            Visible coverage {rangeCompletion.selectedRange.completedDays}/{rangeCompletion.selectedRange.totalDays} {rangeCompletion.selectedRange.ready ? "ready" : "backfilling"}
          </span>
        ) : null}
        {rangeCompletion ? (
          <span className="rounded-full border border-border/70 bg-background px-2 py-0.5 text-[10px] text-muted-foreground">
            Historical {rangeCompletion.historical.completedDays}/{rangeCompletion.historical.totalDays} {rangeCompletion.historical.ready ? "ready" : "backfilling"}
          </span>
        ) : null}
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">{surface.message}</p>
      {surface.latestBackgroundActivityAt ? (
        <p className="mt-1 text-[10px] text-muted-foreground">
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
      return "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]";
    case "partial":
      return "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]";
    case "advisor_not_ready":
      return "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]";
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
  accountId?: string | null;
  startDate?: string;
  endDate?: string;
  refresh?: boolean;
}) {
  const params = new URLSearchParams({ businessId: input.businessId });
  if (input.accountId) params.set("accountId", input.accountId);
  if (input.startDate && input.endDate) {
    params.set("dateRange", "custom");
    params.set("customStart", input.startDate);
    params.set("customEnd", input.endDate);
  }
  if (input.refresh) params.set("refresh", "1");
  return params;
}

function isGoogleAdvisorResponse(value: unknown): value is GoogleAdvisorResponse {
  if (!value || typeof value !== "object") return false;
  const candidate = value as Partial<GoogleAdvisorResponse>;
  return (
    Boolean(candidate.summary && typeof candidate.summary === "object") &&
    Array.isArray(candidate.recommendations) &&
    Array.isArray(candidate.sections) &&
    Array.isArray(candidate.clusters)
  );
}

function buildGoogleAdsDataQueryParams(input: {
  businessId: string;
  accountId?: string | null;
  startDate: string;
  endDate: string;
  compareMode?: string;
  compareStart?: string | null;
  compareEnd?: string | null;
}) {
  const params = new URLSearchParams({
    businessId: input.businessId,
    dateRange: "custom",
    customStart: input.startDate,
    customEnd: input.endDate,
  });
  if (input.accountId) params.set("accountId", input.accountId);
  if (input.compareMode) params.set("compareMode", input.compareMode);
  if (input.compareStart) params.set("compareStart", input.compareStart);
  if (input.compareEnd) params.set("compareEnd", input.compareEnd);
  return params;
}

interface GoogleAccountScopePayload {
  accounts: Array<{
    id: string;
    name: string | null;
    currency: string | null;
    timezone: string | null;
  }>;
  assignedCount: number;
}

type GoogleOverviewSummaryPayload = Pick<
  GoogleAdsCanonicalOverviewSummaryResult,
  "kpis" | "kpiDeltas"
> & {
  summary?: GoogleAdsCanonicalOverviewSummaryResult["summary"];
  meta?: Partial<GoogleAdsCanonicalOverviewSummaryResult["meta"]>;
};

function inclusiveDayCount(startDate: string, endDate: string): number | null {
  const start = Date.parse(`${startDate}T00:00:00.000Z`);
  const end = Date.parse(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start) || !Number.isFinite(end) || end < start) return null;
  return Math.floor((end - start) / 86_400_000) + 1;
}

export function aggregateExactOverviewTrends(payload: GoogleAdsTrendsResponse | undefined) {
  if (
    !payload ||
    payload.meta?.complete !== true ||
    payload.rows.some((point) => point.complete !== true)
  ) {
    return null;
  }
  return {
    points: payload.rows.map((point) => {
      const spend = point.rows.reduce((sum, row) => sum + row.spend, 0);
      const revenue = point.rows.reduce((sum, row) => sum + row.revenue, 0);
      const conversions = point.rows.reduce((sum, row) => sum + row.conversions, 0);
      const impressions = point.rows.reduce((sum, row) => sum + row.impressions, 0);
      const clicks = point.rows.reduce((sum, row) => sum + row.clicks, 0);
      return {
        date: point.date,
        spend,
        revenue,
        conversions,
        roas: spend > 0 ? revenue / spend : 0,
        cpa: conversions > 0 ? spend / conversions : null,
        ctr: impressions > 0 ? (clicks / impressions) * 100 : null,
        cpc: clicks > 0 ? spend / clicks : null,
        impressions,
        clicks,
      };
    }),
  };
}

function resolveExactGoogleFreshness(status: GoogleAdsStatusResponse | undefined): {
  label: string;
  overviewState: "fresh" | "stale" | "syncing" | "unavailable";
  advisorTone: GoogleAdvisorSyncTone;
} {
  if (!status) {
    return { label: "Synced —", overviewState: "unavailable", advisorTone: "neutral" };
  }
  if (status.state === "syncing") {
    return { label: "Syncing now", overviewState: "syncing", advisorTone: "warning" };
  }
  if (status.state === "action_required") {
    return { label: "Reconnect required", overviewState: "stale", advisorTone: "negative" };
  }
  if (status.freshness?.evidenceAvailable === false) {
    return { label: "Synced —", overviewState: "unavailable", advisorTone: "neutral" };
  }

  const observedAt = newestObservation(
    (status.freshness?.scopes ?? []).map((scope) => scope.latestObservationAt),
  );
  const timestamp = observedAt ? Date.parse(observedAt) : Number.NaN;
  if (!Number.isFinite(timestamp)) {
    return { label: "Synced —", overviewState: "unavailable", advisorTone: "neutral" };
  }

  const minutes = Math.max(0, Math.round((Date.now() - timestamp) / 60_000));
  const label =
    minutes < 1
      ? "Synced just now"
      : minutes < 60
        ? `Synced ${minutes}m ago`
        : minutes < 1_440
          ? `Synced ${Math.round(minutes / 60)}h ago`
          : `Synced ${Math.round(minutes / 1_440)}d ago`;
  const stale = status.state === "stale" || status.state === "partial" || minutes >= 1_440;
  return stale
    ? { label, overviewState: "stale", advisorTone: "warning" }
    : { label, overviewState: "fresh", advisorTone: "positive" };
}

function googleOverviewLegacyHref(target: GoogleOverviewRouteTarget): string {
  switch (target) {
    case "products":
      return "/platforms/google/products";
    case "search":
      return "/platforms/google/search";
    case "keywords":
      // The compatibility keywords shim redirects without preserving the query
      // string. Route directly to Search so the authorized account receipt is
      // not dropped in transit.
      return "/platforms/google/search";
    default:
      return "/platforms/google/advisor";
  }
}

function withGoogleAccount(href: string, providerAccountId: string | null): string {
  if (!providerAccountId) return href;
  const separator = href.includes("?") ? "&" : "?";
  return `${href}${separator}providerAccountId=${encodeURIComponent(providerAccountId)}`;
}


export function GoogleAdsIntelligenceDashboard({
  businessId: requestedBusinessId,
  panel,
  screenTitle,
  authorizedScope,
}: {
  businessId: string;
  /**
   * When set, the workspace renders exactly this surface and hides its internal
   * tab row — v2 gives each Google surface its own route and rail entry.
   */
  panel?: PanelKey;
  /** Page title for the routed screen; the design names each surface. */
  screenTitle?: string;
  /**
   * Server-authorized route scope. Its presence prevents browser stores and the
   * legacy account picker from replacing either the business or account.
   */
  authorizedScope?: GoogleAuthorizedScope;
}) {
  const businessId = authorizedScope?.businessId ?? requestedBusinessId;
  const queryClient = useQueryClient();
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const [selectedGoogleAccountId, setSelectedGoogleAccountId] = useState<string | null>(null);
  const [dateRange, setDateRange] = usePersistentDateRange();
  const [channelFilter, setChannelFilter] = useState<string>("all");
  const [selectedCampaignNames, setSelectedCampaignNames] = useState<string[]>([]);
  const [includeSpentInactive, setIncludeSpentInactive] = useState(false);
  const [selectedPanel, setSelectedPanel] = useState<PanelKey>(panel ?? "summary");
  const activePanel = panel ?? selectedPanel;
  const setActivePanel = setSelectedPanel;
  const [searchTab, setSearchTab] = useState<GoogleSearchExactTab>("terms");
  const [searchTermFilter, setSearchTermFilter] =
    useState<GoogleSearchTermFilterKey>("all");
  const [assetView, setAssetView] = useState<AssetViewKey>("groups");
  const [focusedAssets, setFocusedAssets] = useState<string[]>([]);
  const [focusedAssetGroups, setFocusedAssetGroups] = useState<string[]>([]);
  const [resolvedGoogleReferenceDate, setResolvedGoogleReferenceDate] = useState<string | null>(null);
  const [resolvedGoogleTimeZoneLabel, setResolvedGoogleTimeZoneLabel] = useState<string | null>(null);
  const [advisorDismissPendingId, setAdvisorDismissPendingId] = useState<string | null>(null);
  const [advisorDismissStatus, setAdvisorDismissStatus] = useState<string | null>(null);

  const legacyScopeQuery = useQuery<GoogleAccountScopePayload>({
    queryKey: ["google-account-scope", businessId],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId });
      const response = await fetch(`/api/zero-base/google/scope?${params.toString()}`, {
        cache: "no-store",
      });
      if (!response.ok) throw new Error("Google account scope could not be read.");
      return response.json();
    },
    enabled: !authorizedScope && Boolean(businessId),
    staleTime: 60 * 1000,
  });

  const exactRouteSurface =
    activePanel === "summary" ||
    activePanel === "insights" ||
    activePanel === "search" ||
    activePanel === "products";
  const legacyRequestedAccountId = authorizedScope
    ? null
    : searchParams.get("providerAccountId")?.trim() || null;
  const assignedAccountIds =
    legacyScopeQuery.data?.accounts.map((account) => account.id) ?? [];
  const normalizedLegacyRequestedAccountId = normalizeGoogleCustomerId(
    legacyRequestedAccountId,
  );
  const legacyUrlAccountId = legacyRequestedAccountId
    ? assignedAccountIds.find(
        (accountId) =>
          normalizeGoogleCustomerId(accountId) === normalizedLegacyRequestedAccountId,
      ) ?? null
    : null;
  const legacySelectedAccountId = legacyRequestedAccountId
    ? legacyUrlAccountId
    : assignedAccountIds.length === 1
      ? assignedAccountIds[0]!
      : !exactRouteSurface &&
          selectedGoogleAccountId &&
          assignedAccountIds.includes(selectedGoogleAccountId)
        ? selectedGoogleAccountId
        : null;
  // `authorizedScope` presence is the authority bit. In particular, an
  // explicit null remains null for multi-account routes and never falls through
  // to URL or browser picker state. On the compatibility routes an explicit URL
  // account is likewise authoritative: an unassigned id fails closed instead
  // of silently falling back to the only assigned account.
  const resolvedProviderAccountId = authorizedScope
    ? authorizedScope.providerAccountId
    : legacySelectedAccountId;
  const hasResolvedReadScope = Boolean(resolvedProviderAccountId);
  const resolvedAccountMetadata = authorizedScope
    ? {
        id: authorizedScope.providerAccountId,
        name: authorizedScope.accountLabel,
        currency: authorizedScope.currency,
        timezone: authorizedScope.timezone,
      }
    : legacyScopeQuery.data?.accounts.find(
        (account) => account.id === resolvedProviderAccountId,
      ) ?? null;

  const baseStatusQuery = useQuery<GoogleAdsStatusResponse>({
    queryKey: ["gads-status-base", businessId, resolvedProviderAccountId],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId });
      if (resolvedProviderAccountId) {
        params.set("accountId", resolvedProviderAccountId);
      }
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
    enabled:
      Boolean(businessId) &&
      (exactRouteSurface ? hasResolvedReadScope : true),
  });
  // Route-authorized metadata is immutable for `/c` and `/app`. The exact
  // status request is scoped to the same account as every report read.
  const googleReferenceDate = authorizedScope
    ? undefined
    : baseStatusQuery.data?.currentDateInTimezone ?? undefined;
  const googleTimeZoneLabel = authorizedScope
    ? authorizedScope.timezone?.trim() || undefined
    : baseStatusQuery.data?.primaryAccountTimezone ?? undefined;

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

  const syncPill = useMemo<{ tone: "pos" | "warn" | "neg" | "neutral"; label: string }>(() => {
    const status = baseStatusQuery.data;
    if (!status) return { tone: "neutral", label: "Synced —" };
    if (status.state === "syncing") return { tone: "warn", label: "Syncing now" };
    if (status.state === "action_required") {
      return { tone: "neg", label: "Reconnect required" };
    }
    const finishedAt = status.latestSync?.finishedAt;
    const at = finishedAt ? Date.parse(finishedAt) : Number.NaN;
    if (!Number.isFinite(at)) return { tone: "neutral", label: "Synced —" };
    const minutes = Math.max(0, Math.round((Date.now() - at) / 60_000));
    if (minutes < 1) return { tone: "pos", label: "Synced just now" };
    if (minutes < 60) return { tone: "pos", label: `Synced ${minutes}m ago` };
    const hours = Math.round(minutes / 60);
    if (hours < 24) return { tone: "pos", label: `Synced ${hours}h ago` };
    return { tone: "warn", label: `Synced ${Math.round(hours / 24)}d ago` };
  }, [baseStatusQuery.data]);

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
  // The comparison the operator actually picked. This used to turn every
  // non-"none" choice into `previous_period`, so "Previous year" produced a
  // previous-period delta wearing a year-over-year label.
  const compareMode = compareModeForPreset(dateRange.comparisonPreset);
  // A custom comparison without both ends has no baseline; showing a delta
  // against a guessed window would be the same substitution in a new place.
  const comparisonWindowReady =
    compareMode !== "custom" ||
    customComparisonIsComplete({
      comparisonStart: dateRange.comparisonStart,
      comparisonEnd: dateRange.comparisonEnd,
    });
  const effectiveCompareMode = comparisonWindowReady ? compareMode : "none";
  const exactComparisonWindow = useMemo(
    () =>
      getComparisonWindow({
        compareMode: effectiveCompareMode,
        startDate,
        endDate,
        compareStart: dateRange.comparisonStart,
        compareEnd: dateRange.comparisonEnd,
      }),
    [
      dateRange.comparisonEnd,
      dateRange.comparisonStart,
      effectiveCompareMode,
      endDate,
      startDate,
    ],
  );
  const { labelMode: trendLabelMode } = useMemo(
    () => resolveTrendTimeline(startDate, endDate),
    [startDate, endDate]
  );

  // Page-head identity, read off the status payload. The canonical eyebrow is
  // four segments — platform, bare account id, currency, window — and anything
  // the server has not reported stays an em dash rather than a guessed value.
  // The account timezone was never one of them.
  const workspaceEyebrow = useMemo(() => {
    const status = baseStatusQuery.data;
    const accountId = authorizedScope
      ? authorizedScope.providerAccountId
      : status?.platformDateBoundary?.primaryAccountId ??
        status?.assignedAccountIds?.[0] ??
        null;
    const days = inclusiveDayCount(startDate, endDate);
    return `Google Ads · ${accountId ?? MISSING_VALUE} · ${
      resolvedAccountMetadata?.currency?.trim() || MISSING_VALUE
    } · ${days === null ? MISSING_VALUE : `${days}d`} window`;
  }, [
    authorizedScope,
    baseStatusQuery.data,
    endDate,
    resolvedAccountMetadata?.currency,
    startDate,
  ]);
  const needsAdvisorData =
    activePanel === "summary" ||
    activePanel === "insights" ||
    activePanel === "search" ||
    activePanel === "plan" ||
    activePanel === "assetGroupAudience" ||
    activePanel === "products" ||
    activePanel === "assets";
  const needsTrendData = activePanel === "summary";
  // The design's Assets & Audiences screen carries the asset groups and the
  // audiences alongside the assets, so both load on that panel too.
  const needsAssetGroupAudienceData =
    activePanel === "assetGroupAudience" || activePanel === "assets";
  const needsProductsData = activePanel === "products";
  const needsAssetsData = activePanel === "assets";
  const needsInsightsData = activePanel === "insights";
  const needsSearchData = activePanel === "search";
  const needsPlanData = activePanel === "plan";
  // Overview's campaign table shows the design's Daily budget column, which only
  // the budget report carries, so it loads there as well.
  const needsBudgetData = activePanel === "plan" || activePanel === "summary";
  const currentAdvisorKey = [
    businessId,
    resolvedProviderAccountId ?? "unresolved",
    startDate,
    endDate,
  ].join(":");

  const overviewSummaryQuery = useQuery<GoogleOverviewSummaryPayload>({
    queryKey: [
      "gads-overview-exact",
      businessId,
      resolvedProviderAccountId,
      startDate,
      endDate,
      effectiveCompareMode,
      dateRange.comparisonStart,
      dateRange.comparisonEnd,
    ],
    queryFn: async () => {
      if (!resolvedProviderAccountId) throw new Error("Google account scope is unresolved.");
      const params = buildGoogleAdsDataQueryParams({
        businessId,
        accountId: resolvedProviderAccountId,
        startDate,
        endDate,
        compareMode: effectiveCompareMode,
        compareStart: dateRange.comparisonStart,
        compareEnd: dateRange.comparisonEnd,
      });
      const response = await fetch(`/api/google-ads/overview?${params.toString()}`);
      if (!response.ok) throw new Error("Google overview could not be read.");
      return response.json();
    },
    enabled: activePanel === "summary" && hasResolvedReadScope,
    staleTime: 5 * 60 * 1000,
  });

  const {
    data,
    isLoading,
    isError,
    refetch: refetchCampaigns,
  } = useQuery<CampaignsResponse>({
    queryKey: [
      "gads-campaigns",
      businessId,
      resolvedProviderAccountId,
      startDate,
      endDate,
      effectiveCompareMode,
    ],
    queryFn: async () => {
      if (!resolvedProviderAccountId) throw new Error("Google account scope is unresolved.");
      const params = buildGoogleAdsDataQueryParams({
        businessId,
        accountId: resolvedProviderAccountId,
        startDate,
        endDate,
        compareMode: effectiveCompareMode,
      });
      const res = await fetch(`/api/google-ads/campaigns?${params}`);
      if (!res.ok) throw new Error("fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: Boolean(businessId) && hasResolvedReadScope,
  });

  const [advisorData, setAdvisorData] = useState<GoogleAdvisorResponse | undefined>(undefined);
  const [advisorAnalysisKey, setAdvisorAnalysisKey] = useState<string | null>(null);
  const [autoRequestedAdvisorKey, setAutoRequestedAdvisorKey] = useState<string | null>(null);
  const [lastAnalyzedLabel, setLastAnalyzedLabel] = useState<string | null>(null);
  const {
    mutate: runAdvisorAnalysis,
    mutateAsync: readAdvisorAnalysis,
    isPending: isAdvisorLoading,
    isError: isAdvisorError,
  } = useMutation<GoogleAdvisorResponse, Error, { refresh: boolean }>({
    mutationFn: async ({ refresh }) => {
      const params = buildAdvisorQueryParams({
        businessId,
        accountId: resolvedProviderAccountId,
        startDate,
        endDate,
        refresh,
      });
      const res = await fetch(`/api/google-ads/advisor?${params}`);
      if (!res.ok) throw new Error("advisor fetch failed");
      const payload = (await res.json().catch(() => null)) as unknown;
      if (!isGoogleAdvisorResponse(payload)) {
        throw new Error("advisor response invalid");
      }
      return payload;
    },
    onSuccess: (payload) => {
      queryClient.setQueryData(["google-advisor", businessId], payload);
      setAdvisorData(payload);
      setAdvisorAnalysisKey(currentAdvisorKey);
      setLastAnalyzedLabel(payload.metadata?.asOfDate ?? new Date().toISOString().slice(0, 10));
    },
  });
  const refreshAdvisorView = () => {
    if (!resolvedProviderAccountId) return;
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

  const { data: productsData } = useQuery<ProductsResponse>({
    queryKey: ["gads-products", businessId, resolvedProviderAccountId, startDate, endDate],
    queryFn: async () => {
      if (!resolvedProviderAccountId) throw new Error("Google account scope is unresolved.");
      const params = buildGoogleAdsDataQueryParams({
        businessId,
        accountId: resolvedProviderAccountId,
        startDate,
        endDate,
      });
      const res = await fetch(`/api/google-ads/products?${params}`);
      if (!res.ok) throw new Error("products fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsProductsData && hasResolvedReadScope,
  });

  // The budget endpoint returns its findings as named campaign buckets, not as
  // a flat recommendation list, so they are normalised at the read boundary.
  const { data: budgetData, isLoading: isBudgetLoading } = useQuery<{
    rows?: BudgetCampaign[];
    recommendations?: GoogleBudgetInsights | BudgetRec[];
    totalSpend?: number;
    accountAvgRoas?: number;
    meta?: GoogleAdsReadCompletenessMeta;
  }>({
    queryKey: ["gads-budget", businessId, resolvedProviderAccountId, startDate, endDate],
    queryFn: async () => {
      if (!resolvedProviderAccountId) throw new Error("Google account scope is unresolved.");
      const params = new URLSearchParams({
        businessId,
        accountId: resolvedProviderAccountId,
        dateRange: "custom",
        customStart: startDate,
        customEnd: endDate,
      });
      const res = await fetch(`/api/google-ads/budget?${params}`);
      if (!res.ok) throw new Error("budget fetch failed");
      return res.json();
    },
    enabled: needsBudgetData && Boolean(businessId) && hasResolvedReadScope,
    staleTime: 60 * 1000,
  });

  const budgetRecommendations = useMemo(
    () => normaliseBudgetRecommendations(budgetData?.recommendations),
    [budgetData?.recommendations],
  );

  const { data: searchTermsData } = useQuery<SearchIntelligenceResponse>({
    queryKey: ["gads-search-intelligence", businessId, resolvedProviderAccountId, startDate, endDate],
    queryFn: async () => {
      if (!resolvedProviderAccountId) throw new Error("Google account scope is unresolved.");
      const params = buildGoogleAdsDataQueryParams({
        businessId,
        accountId: resolvedProviderAccountId,
        startDate,
        endDate,
      });
      const res = await fetch(`/api/google-ads/search-intelligence?${params}`);
      if (!res.ok) throw new Error("search intelligence fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsSearchData && hasResolvedReadScope,
  });

  const { data: keywordsData } = useQuery<{
    rows?: GoogleSearchExactKeywordSource[];
    summary?: Partial<GoogleAdsKeywordInsightCounts>;
  }>({
    queryKey: ["gads-keywords", businessId, resolvedProviderAccountId, startDate, endDate],
    queryFn: async () => {
      if (!resolvedProviderAccountId) throw new Error("Google account scope is unresolved.");
      const params = buildGoogleAdsDataQueryParams({
        businessId,
        accountId: resolvedProviderAccountId,
        startDate,
        endDate,
      });
      const res = await fetch(`/api/google-ads/keywords?${params}`);
      if (!res.ok) throw new Error("keywords fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsSearchData && hasResolvedReadScope,
  });

  // The operator's own commercial targets. A ROAS tint is a verdict against a
  // target, so the Search and Products screens read the target pack rather than
  // tinting every positive row the same colour with no bar to clear.
  const { data: commercialSettings } = useQuery<{
    snapshot?: { targetPack?: { targetRoas?: number | null; breakEvenRoas?: number | null } | null };
  }>({
    queryKey: ["business-commercial-targets", businessId],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId });
      const res = await fetch(`/api/business-commercial-settings?${params}`);
      if (!res.ok) throw new Error("commercial settings fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: (needsSearchData || needsProductsData || needsBudgetData) && Boolean(businessId),
  });

  const { data: trendsData } = useQuery<GoogleAdsTrendsResponse>({
    queryKey: ["gads-trends", businessId, resolvedProviderAccountId, startDate, endDate],
    queryFn: async () => {
      if (!resolvedProviderAccountId) throw new Error("Google account scope is unresolved.");
      const params = new URLSearchParams({
        businessId,
        accountId: resolvedProviderAccountId,
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
    enabled: needsTrendData && hasResolvedReadScope,
  });

  const { data: previousTrendsData } = useQuery<GoogleAdsTrendsResponse>({
    queryKey: [
      "gads-trends-previous",
      businessId,
      resolvedProviderAccountId,
      exactComparisonWindow?.startDate,
      exactComparisonWindow?.endDate,
    ],
    queryFn: async () => {
      if (!resolvedProviderAccountId || !exactComparisonWindow) {
        throw new Error("Google comparison scope is unresolved.");
      }
      const params = new URLSearchParams({
        businessId,
        accountId: resolvedProviderAccountId,
        dateRange: "custom",
        customStart: exactComparisonWindow.startDate,
        customEnd: exactComparisonWindow.endDate,
        compareMode: "none",
      });
      const response = await fetch(`/api/google-ads/trends?${params.toString()}`);
      if (!response.ok) throw new Error("Google comparison trends could not be read.");
      return response.json();
    },
    staleTime: 5 * 60 * 1000,
    enabled: needsTrendData && hasResolvedReadScope && Boolean(exactComparisonWindow),
  });

  const {
    data: syncStatus,
    isLoading: isSyncStatusLoading,
    isError: isSyncStatusError,
    refetch: refetchSyncStatus,
  } = useQuery<GoogleAdsStatusResponse>({
    queryKey: [
      "gads-status",
      businessId,
      resolvedProviderAccountId,
      startDate,
      endDate,
    ],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId, startDate, endDate });
      if (resolvedProviderAccountId) {
        params.set("accountId", resolvedProviderAccountId);
      }
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
    enabled: exactRouteSurface ? hasResolvedReadScope : Boolean(businessId),
  });

  // One freshness contract across every Tier-0 surface. Derived from the query
  // state this surface already has, so it cannot drift from what is on screen.
  useTierZeroFreshness({
    surface: "google_ads",
    // The status read is included because it supplies both the as-of and the
    // partial reason. Leaving it out let the surface settle on "ready, age
    // unknown" while that read was in flight, then flip to "partial" a moment
    // later -- one reading meaning two things depending on when you looked.
    isLoading: isLoading || isSyncStatusLoading,
    // The newest real observation across scopes. The account's calendar date is
    // a range label, not a read time; dating the surface from it made the age
    // drift with the hour and never say "stale".
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
    error: isError || isSyncStatusError ? "google_ads_unreadable" : null,
    businessId,
    onRetry: () => {
      void refetchCampaigns();
      void refetchSyncStatus();
    },
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
  // The server-authorized account wins on `/c` and `/app`. Legacy routes retain
  // their local picker, but a multi-account portfolio without a selection is an
  // unresolved read scope, not an implicit blend.
  const accountScope = resolveGoogleAccountScope({
    assignedAccountIds: syncStatus?.assignedAccountIds ?? [],
    selectedAccountId: resolvedProviderAccountId,
  });
  const advisorExecutionAccountId = resolvedProviderAccountId;
  useEffect(() => {
    if (
      !needsAdvisorData ||
      !hasResolvedReadScope ||
      !advisorCanOpen ||
      isAdvisorLoading ||
      advisorAnalysisKey === currentAdvisorKey ||
      autoRequestedAdvisorKey === currentAdvisorKey
    ) {
      return;
    }

    // Opening an Advisor-backed surface should read the persisted snapshot.
    // `refresh: false` never starts a provider refresh; the explicit refresh
    // control remains the only path that can request a new snapshot.
    setAutoRequestedAdvisorKey(currentAdvisorKey);
    runAdvisorAnalysis({ refresh: false });
  }, [
    advisorAnalysisKey,
    advisorCanOpen,
    autoRequestedAdvisorKey,
    currentAdvisorKey,
    hasResolvedReadScope,
    isAdvisorLoading,
    needsAdvisorData,
    runAdvisorAnalysis,
  ]);
  // The design's Activity card on Plan reads the guarded-write execution log.
  const { data: activityData, isLoading: isActivityLoading } = useQuery<{
    rows?: GoogleAdsActivityEntry[];
  }>({
    queryKey: ["gads-activity", businessId, advisorExecutionAccountId],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId });
      if (advisorExecutionAccountId) params.set("accountId", advisorExecutionAccountId);
      const res = await fetch(`/api/google-ads/activity?${params.toString()}`);
      if (!res.ok) throw new Error("activity fetch failed");
      return res.json();
    },
    staleTime: 60 * 1000,
    enabled: needsPlanData && hasResolvedReadScope,
  });

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

  // Account deltas for the design's KPI row, reconstructed from the per-row
  // change the campaigns endpoint serves. Withheld entirely when comparison is
  // off so the row shows a value with no delta rather than a fabricated 0%.
  // Daily budget lives on the budget report, not the performance row; join by id
  // and fall back to the campaign name when the report keys differ.
  const dailyBudgetById = useMemo(() => {
    const map = new Map<string, number>();
    for (const row of budgetData?.rows ?? []) {
      if (typeof row.dailyBudget !== "number" || !Number.isFinite(row.dailyBudget)) continue;
      if (row.id) map.set(String(row.id), row.dailyBudget);
      if (row.name) map.set(row.name.toLowerCase().trim(), row.dailyBudget);
    }
    return map;
  }, [budgetData?.rows]);

  const comparisonOn = effectiveCompareMode !== "none";
  const prevSpend = comparisonOn
    ? previousTotalFrom(sortedRows, (row) => row.spend, (row) => row.spendChange)
    : null;
  const prevRevenue = comparisonOn
    ? previousTotalFrom(sortedRows, (row) => row.revenue, (row) => row.revenueChange)
    : null;
  const spendDelta = deltaOf(totalSpend, prevSpend);
  const revenueDelta = deltaOf(totalRevenue, prevRevenue);
  const roasDelta = deltaOf(
    blendedRoas,
    prevSpend && prevSpend > 0 && prevRevenue !== null ? prevRevenue / prevSpend : null,
  );
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

  const campaignAdvisorMap = useMemo(() => {
    const rows = advisorCurrent?.summary.campaignRoles ?? [];
    return new Map(rows.map((row) => [row.campaignId, row]));
  }, [advisorCurrent?.summary.campaignRoles]);

  const exactWindowDays = inclusiveDayCount(startDate, endDate);
  const exactWindowLabel = exactWindowDays === null ? null : `${exactWindowDays}d`;
  const commercialTargetRoas =
    typeof commercialSettings?.snapshot?.targetPack?.targetRoas === "number" &&
    Number.isFinite(commercialSettings.snapshot.targetPack.targetRoas)
      ? commercialSettings.snapshot.targetPack.targetRoas
      : null;
  const commercialBreakEvenRoas =
    typeof commercialSettings?.snapshot?.targetPack?.breakEvenRoas === "number" &&
    Number.isFinite(commercialSettings.snapshot.targetPack.breakEvenRoas)
      ? commercialSettings.snapshot.targetPack.breakEvenRoas
      : null;
  // The three keyword tallies the design's pills carry. They are server-side
  // counts; an unread summary keeps the pill shells and prints `—` rather than
  // substituting a row count.
  const keywordInsightCounts: GoogleAdsKeywordInsightCounts | null =
    typeof keywordsData?.summary?.highCtrLowConvCount === "number" &&
    typeof keywordsData.summary.highConvLowBudgetCount === "number" &&
    typeof keywordsData.summary.deserveOwnAdGroupCount === "number"
      ? {
          highCtrLowConvCount: keywordsData.summary.highCtrLowConvCount,
          highConvLowBudgetCount: keywordsData.summary.highConvLowBudgetCount,
          deserveOwnAdGroupCount: keywordsData.summary.deserveOwnAdGroupCount,
        }
      : null;
  const exactFreshness = resolveExactGoogleFreshness(
    syncStatus ?? baseStatusQuery.data,
  );
  const campaignsReadComplete =
    authorizedScope?.demo === true || isGoogleAdsReadComplete(data?.meta);
  const budgetReadComplete =
    authorizedScope?.demo === true || isGoogleAdsReadComplete(budgetData?.meta);
  const exactOverviewModel = buildGoogleOverviewExactModel({
    identity: {
      businessId,
      providerAccountId: resolvedProviderAccountId,
    },
    currencyCode: resolvedAccountMetadata?.currency ?? null,
    window: {
      label: exactWindowLabel,
      days: exactWindowDays,
    },
    freshness: {
      label: exactFreshness.label,
      state: exactFreshness.overviewState,
    },
    summary: overviewSummaryQuery.data ?? null,
    currentTrends: aggregateExactOverviewTrends(trendsData),
    previousTrends: aggregateExactOverviewTrends(previousTrendsData),
    campaigns: campaignsReadComplete ? data?.rows ?? [] : null,
    advisorRecommendations: advisorCurrent?.recommendations ?? null,
    budgetCampaigns: budgetReadComplete ? budgetData?.rows ?? [] : null,
    targets: { roas: commercialTargetRoas, breakevenRoas: commercialBreakEvenRoas },
  });

  const exactSearchModel = buildGoogleSearchExactViewModel({
    identity: {
      accountId: resolvedProviderAccountId,
      currencyCode: resolvedAccountMetadata?.currency ?? null,
      windowLabel: exactWindowLabel,
      syncLabel: exactFreshness.label,
    },
    tab: searchTab,
    termFilter: searchTermFilter,
    terms: searchTermsData?.rows ?? null,
    keywords: keywordsData?.rows ?? null,
    keywordInsights: keywordInsightCounts,
    roasTarget: commercialTargetRoas,
    roasBreakEven: commercialBreakEvenRoas,
  });

  const exactProductsModel = buildGoogleProductsExactViewModel({
    identity: {
      accountId: resolvedProviderAccountId,
      currencyCode: resolvedAccountMetadata?.currency ?? null,
      windowLabel: exactWindowLabel,
      syncLabel: exactFreshness.label,
    },
    products: productsData?.rows ? productRows : null,
    roasTarget: commercialTargetRoas,
    roasBreakEven: commercialBreakEvenRoas,
    // Merchant Center item state has no reader in this product; the tiles keep
    // their shells and print the em dash rather than answering with a
    // performance verdict.
    feed: null,
  });

  const exactPlanHref = dashboardHrefForRouteFamily(
    withGoogleAccount("/platforms/google/plan", resolvedProviderAccountId),
    pathname,
  );
  const exactProductsHref = dashboardHrefForRouteFamily(
    withGoogleAccount("/platforms/google/products", resolvedProviderAccountId),
    pathname,
  );
  const exactDismissAuthority: GoogleAdvisorDismissAuthority =
    !authorizedScope
      ? "unknown"
      : authorizedScope.viewerReadOnly ||
          authorizedScope.demo ||
          !resolvedProviderAccountId ||
          isAdvisorLoading ||
          advisorDismissPendingId !== null
        ? "denied"
        : "allowed";
  const exactAdvisorState = advisorCurrent
    ? "ready"
    : isAdvisorError
      ? "error"
      : isAdvisorLoading
        ? "loading"
        : "unavailable";

  const dismissExactAdvisorRecommendation = async (
    recommendation: GoogleAdvisorRecommendation,
  ) => {
    if (
      exactDismissAuthority !== "allowed" ||
      !resolvedProviderAccountId ||
      !recommendation.recommendationFingerprint
    ) {
      return;
    }
    setAdvisorDismissPendingId(recommendation.id);
    setAdvisorDismissStatus("Dismissing recommendation…");
    try {
      const response = await fetch("/api/google-ads/advisor-memory", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          businessId,
          accountId: resolvedProviderAccountId,
          recommendationFingerprint: recommendation.recommendationFingerprint,
          action: "dismissed",
        }),
      });
      const payload = (await response.json().catch(() => null)) as
        | {
            ok?: boolean;
            error?: string;
            message?: string;
            action?: string;
            accountId?: string;
            recommendationFingerprint?: string;
            currentStatus?: string | null;
          }
        | null;
      if (!response.ok) {
        throw new Error(payload?.error ?? payload?.message ?? "Dismiss failed.");
      }
      if (
        payload?.ok !== true ||
        payload.action !== "dismissed" ||
        payload.accountId !== resolvedProviderAccountId ||
        payload.recommendationFingerprint !== recommendation.recommendationFingerprint ||
        payload.currentStatus !== "suppressed"
      ) {
        throw new Error("Dismiss receipt could not be verified.");
      }

      const readback = await readAdvisorAnalysis({ refresh: false });
      if (!readback || !Array.isArray(readback.recommendations)) {
        throw new Error("Dismiss readback could not be verified.");
      }
      const matchingRecommendations = readback.recommendations.filter(
        (candidate) =>
          candidate.recommendationFingerprint === recommendation.recommendationFingerprint,
      );
      if (matchingRecommendations.length > 0) {
        throw new Error("Dismiss readback could not be verified.");
      }
      setAdvisorDismissStatus("Recommendation dismissed.");
    } catch (error) {
      setAdvisorDismissStatus(
        error instanceof Error ? error.message : "Dismiss failed.",
      );
    } finally {
      setAdvisorDismissPendingId(null);
    }
  };

  const exactSurface =
    activePanel === "summary" ? (
      <GoogleOverviewExact
        model={exactOverviewModel}
        onNavigate={(target) => {
          const href = dashboardHrefForRouteFamily(
            withGoogleAccount(
              googleOverviewLegacyHref(target),
              resolvedProviderAccountId,
            ),
            pathname,
          );
          router.push(href);
        }}
      />
    ) : activePanel === "insights" ? (
      <>
        <GoogleAdvisorExact
          advisor={advisorCurrent ?? null}
          advisorState={exactAdvisorState}
          accountId={resolvedProviderAccountId}
          currencyCode={resolvedAccountMetadata?.currency ?? null}
          windowLabel={exactWindowLabel}
          syncLabel={exactFreshness.label}
          syncTone={exactFreshness.advisorTone}
          planHref={exactPlanHref}
          productsHref={exactProductsHref}
          onNavigate={(href) => router.push(href)}
          onDismiss={dismissExactAdvisorRecommendation}
          dismissAuthority={exactDismissAuthority}
          readOnly={
            !authorizedScope ||
            authorizedScope.viewerReadOnly ||
            authorizedScope.demo ||
            !resolvedProviderAccountId
          }
        />
        <span className="sr-only" role="status" aria-live="polite">
          {advisorDismissStatus}
        </span>
        <span className="sr-only" role="status" aria-live="polite">
          {exactAdvisorState === "loading"
            ? "Advisor recommendations are loading."
            : exactAdvisorState === "error"
              ? "Advisor recommendations could not be read."
              : exactAdvisorState === "unavailable"
                ? "Advisor recommendations are unavailable."
                : null}
        </span>
      </>
    ) : activePanel === "search" ? (
      <GoogleSearchExact
        model={exactSearchModel}
        syncTone={exactFreshness.advisorTone}
        onTabChange={setSearchTab}
        onFilterChange={setSearchTermFilter}
      />
    ) : activePanel === "products" ? (
      <GoogleProductsExact
        model={exactProductsModel}
        syncTone={exactFreshness.advisorTone}
      />
    ) : null;

  if (exactSurface) return exactSurface;

  if (isError) {
    return <div className="py-10 text-sm text-muted-foreground">Campaign data could not be loaded.</div>;
  }

  const panelSurfaceLookup = new Map(
    (syncStatus?.panel?.surfaceStates ?? []).map((surface) => [surface.scope, surface])
  );
  const assetSurfaceState = panelSurfaceLookup.get("asset_daily") ?? null;
  const assetGroupSurfaceState = panelSurfaceLookup.get("asset_group_daily") ?? null;
  const audienceSurfaceState = panelSurfaceLookup.get("audience_daily") ?? null;
  const assetRangeCompletion = syncStatus?.rangeCompletionBySurface?.asset_daily ?? null;
  const assetGroupRangeCompletion =
    syncStatus?.rangeCompletionBySurface?.asset_group_daily ?? null;
  const audienceRangeCompletion =
    syncStatus?.rangeCompletionBySurface?.audience_daily ?? null;

  const summaryEmptyState = getGoogleAdsSyncEmptyState(syncStatus, "Campaign data");
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

  const assetsAdvisor = filterAdvisorByTypes(advisorCurrent, [
    "creative_asset_deployment",
  ]);

  // The design closes the asset group table on the restructures the advisor
  // already has queued, naming them; with none queued it says nothing.
  const queuedRestructures = (advisorCurrent?.recommendations ?? []).filter(
    (item) => item.type === "asset_group_structure",
  );
  const restructureTargets = queuedRestructures
    .flatMap((item) => item.weakAssetGroups ?? [])
    .filter(Boolean)
    .slice(0, 2);
  const assetGroupQueueNote =
    queuedRestructures.length === 0
      ? null
      : `The advisor has ${queuedRestructures.length} restructure${
          queuedRestructures.length === 1 ? "" : "s"
        } queued${
          restructureTargets.length > 0
            ? ` for ${restructureTargets.map((name) => `“${name}”`).join(" and ")}`
            : ""
        } — see Advisor · Do next.`;

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
    // The design lays every Google screen out as a 16px flex column.
    <div className="flex flex-col gap-4">
      {/* v2 page head — identity in a mono eyebrow, workspace name in display type. */}
      <div className="flex flex-wrap items-end justify-between gap-4">
        <div className="min-w-0">
          <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] uppercase tracking-[0.12em] text-[var(--adv-ink-3)]">
            {workspaceEyebrow}
          </p>
          <h1 className="m-0 mt-1 font-[family-name:var(--adv-font-display)] text-[26px] font-bold leading-[1.1] tracking-[-0.02em] text-[var(--adv-ink)]">
            {screenTitle ?? "Intelligence Workspace"}
          </h1>
        </div>
        <div className="flex flex-wrap items-center gap-2.5">
          <span className="adv-mono text-[10.5px] text-[var(--adv-ink-4)]">
            writes guarded · receipt on every change
          </span>
          <span className="adv-pill" data-tone={syncPill.tone}>
            <span className="adv-pill-dot" aria-hidden="true" />
            {syncPill.label}
          </span>
        </div>
      </div>

      {/* The browser-owned picker exists only on the preserved legacy entry.
          Canonical routes receive immutable account scope from the server. */}
      {!authorizedScope && accountScope.mode !== "none" && (syncStatus?.assignedAccountIds?.length ?? 0) > 1 ? (
        <div
          role="status"
          className={cn(
            "flex flex-wrap items-center gap-2 rounded-[14px] border px-3 py-2 text-[11px]",
            accountScope.mixedCurrency
              ? "border-amber-200 bg-amber-50 text-amber-900"
              : "border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-3)]"
          )}
        >
          <span className="font-[family-name:var(--adv-font-mono)] text-[10px] uppercase tracking-[0.1em]">
            {accountScope.mode === "blended" ? "Blended view" : "Scoped to one account"}
          </span>
          {accountScope.notice ? <span>{accountScope.notice}</span> : null}
          <label className="ml-auto flex items-center gap-1.5">
            <span className="sr-only">Google account</span>
            <select
              value={selectedGoogleAccountId ?? ""}
              onChange={(event) => setSelectedGoogleAccountId(event.target.value || null)}
              className="rounded-md border border-[var(--adv-border)] bg-[var(--adv-surface)] px-2 py-1 text-[11px] text-[var(--adv-ink-2)]"
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

      {panel ? null : (
      <div className="flex flex-wrap gap-2">
        {PANEL_ITEMS.map((item) => (
          <button
            key={item.key}
            type="button"
            onClick={() => setActivePanel(item.key)}
            className={cn(
              "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-[13px] text-[12.5px] font-semibold transition-colors",
              activePanel === item.key
                ? "border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]"
                : "border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]"
            )}
          >
            {item.label}
          </button>
        ))}
      </div>
      )}

      {/* The campaign filter bar and the sync-domain rows belong to the
          design's Google Overview; the other five screens open on their
          own blocks. */}
      {activePanel === "summary" ? (
      <>
        <div className="flex flex-wrap items-center justify-between gap-3">
          <div>
            <div className="flex flex-wrap items-center gap-2">
              {/* The campaigns table carries the design's heading; this bar is
                  the filter row above it and must not repeat the label. */}
              <span className="font-[family-name:var(--adv-font-mono)] text-[10px] uppercase tracking-[0.1em] text-[var(--adv-ink-3)]">
                Filters
              </span>
              <div className="flex flex-wrap items-center gap-1.5">
                <button
                  type="button"
                  onClick={() => setIncludeSpentInactive((p) => !p)}
                  className={cn(
                    "inline-flex items-center rounded-md border px-2.5 py-1 text-[11px] font-medium",
                    includeSpentInactive ? "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]" : "border-border bg-background text-muted-foreground"
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
                        onClick={() => {
                          if (!resolvedProviderAccountId) return;
                          runAdvisorAnalysis({
                            refresh:
                              advisorCtaState === "prepare" ||
                              advisorCtaState === "refreshable",
                          });
                        }}
                        disabled={!advisorCanOpen || !hasResolvedReadScope || isAdvisorLoading}
                          title={advisorHelperText}
                          aria-label={`${advisorButtonLabel}. ${advisorHelperText}`}
                          className={cn(
                            "inline-flex h-8 shrink-0 items-center rounded-md border px-2.5 text-[11px] font-semibold transition-colors",
                            !advisorCanOpen || !hasResolvedReadScope || isAdvisorLoading
                              ? "cursor-not-allowed border-border bg-muted text-muted-foreground"
                              : advisorCurrent
                                ? "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] hover:bg-[var(--adc-pos-bg)]"
                                : "border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] hover:bg-[var(--adc-info-bg)]"
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

        {shouldShowActionRequiredBanner ? (
          <div
            role="status"
            className="rounded-[14px] border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] px-4 py-3 text-sm text-[var(--adc-caution-fg)]"
          >
            <p className="font-semibold">Reconnect Google Ads</p>
            <p className="mt-1">
              {actionRequiredScopeText
                ? `Google Ads access is blocking sync for: ${actionRequiredScopeText}. Reconnect the affected account before those surfaces can refresh.`
                : "Google Ads account access requires reconnect before blocked sync surfaces can refresh."}
            </p>
          </div>
        ) : null}
        <div className="rounded-[14px] border border-border/70 bg-card/70 p-3">
          <div className="space-y-1.5">
            <StatusDomainRow label="Core" summary={syncStatus?.domains?.core} />
            <StatusDomainRow label="Visible coverage" summary={syncStatus?.domains?.selectedRange} />
            <StatusDomainRow label="Advisor" summary={syncStatus?.domains?.advisor} />
          </div>
        </div>
      </>
      ) : null}

      {activePanel === "summary" && <section className="mb-6">
        <div className="grid grid-cols-2 gap-2 md:grid-cols-3 xl:grid-cols-5">
            {isLoading ? Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-[14px]" />) : (
              <>
                <Kpi label="Spend" value={fmtCurrency(totalSpend)} series={summaryTrendSeries.spend} formatter={fmtCurrency} dateLabelMode={trendLabelMode} delta={spendDelta.delta} deltaTone={spendDelta.tone} sub={`${sortedRows.length} campaigns`} />
                <Kpi label="ROAS" value={fmtRoas(blendedRoas)} series={summaryTrendSeries.roas} formatter={fmtRoas} dateLabelMode={trendLabelMode} highlight={blendedRoas >= 3} delta={roasDelta.delta} deltaTone={roasDelta.tone} sub="blended" />
                <Kpi label="Revenue" value={fmtCurrency(totalRevenue)} series={summaryTrendSeries.revenue} formatter={fmtCurrency} dateLabelMode={trendLabelMode} delta={revenueDelta.delta} deltaTone={revenueDelta.tone} sub="conv. value" />
                <Kpi label="Conv" value={totalConv.toFixed(0)} series={summaryTrendSeries.conversions} formatter={(v) => v.toFixed(0)} dateLabelMode={trendLabelMode} sub={totalConv > 0 ? `${fmtCurrency(blendedCpa)} CPA` : null} />
                <Kpi label="CPA" value={totalConv > 0 ? fmtCurrency(blendedCpa) : "—"} series={summaryTrendSeries.cpa} formatter={fmtCurrency} dateLabelMode={trendLabelMode} sub={totalClicks > 0 ? `${fmtCurrency(blendedCpc)} CPC` : null} />
              </>
            )}
        </div>
        <div className="mt-4 grid overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] [grid-template-columns:repeat(auto-fit,minmax(110px,1fr))]">
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

      {activePanel === "summary" && summaryAdvisor?.recommendations?.length ? (
        <GoogleWhereToLookFirst
          recommendations={summaryAdvisor.recommendations}
          onFocus={focusAdvisorEntity}
        />
      ) : null}

      {activePanel === "summary" && (isLoading ? (
        <div className="space-y-2.5">{Array.from({ length: 5 }).map((_, i) => <Skeleton key={i} className="h-24 w-full rounded-[14px]" />)}</div>
      ) : sortedRows.length === 0 ? (
        <EmptyState title={summaryEmptyState.title} description={summaryEmptyState.description} />
      ) : (
        <GoogleCampaignsTable
          rows={sortedRows}
          accountAvgRoas={data?.summary.accountAvgRoas ?? blendedRoas}
          currencyFormatter={fmtCurrency}
          dailyBudgetById={dailyBudgetById}
        />
      ))}

      {activePanel === "summary" && (budgetData?.rows?.length || budgetRecommendations.length) ? (
        <GoogleBudgetScalingCard
          campaigns={budgetData?.rows ?? []}
          recommendations={budgetRecommendations}
          currencyFormatter={fmtCurrency}
        />
      ) : null}

      {activePanel === "summary" && summaryAdvisor?.sections.length ? (
        <section className="space-y-3 rounded-[14px] border border-border/70 bg-card p-3">
          {summaryAdvisor?.recommendations?.length ? (
            <GoogleAdvisorTiles
              recommendations={summaryAdvisor.recommendations}
              currencyFormatter={fmtCurrency}
            />
          ) : null}
          <p className="text-xs text-muted-foreground">Account-level growth decisions and lane orchestration</p>
          <GoogleAdvisorPanel
            advisor={summaryAdvisor}
            onFocusEntity={focusAdvisorEntity}
            businessId={businessId}
            accountId={advisorExecutionAccountId}
            onRefreshAdvisor={refreshAdvisorView}
          />
          <p className="m-0 text-[11px] leading-[1.5] text-[var(--adv-ink-4)]">
            Apply executes through the guarded write boundary — approval,
            guardrails and quiet hours apply, every change returns a Google
            receipt, and rollback is one click while the receipt is live.
          </p>
        </section>
      ) : activePanel === "summary" ? (
        <section className="space-y-3 rounded-[14px] border border-border/70 bg-card p-3">
          {isAdvisorLoading ? (
            <Skeleton className="h-32 w-full rounded-[14px]" />
          ) : isAdvisorError ? (
            <ErrorState />
          ) : (
            <EmptyState title={advisorIdleState.title} description={advisorIdleState.description} />
          )}
        </section>
      ) : null}

      {activePanel === "insights" ? (
        <section className="space-y-3 rounded-[14px] border border-border/70 bg-card p-3">
          {isAdvisorLoading ? (
            <Skeleton className="h-40 w-full rounded-[14px]" />
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

        </section>
      ) : null}

      {activePanel === "plan" ? (
        /* Design's Plan & activity surface: the execution queue over the advisor's
           ranked findings, then budget headroom and scaling moves. */
        <section className="flex flex-col gap-4">
          <div className="grid items-start gap-3 [grid-template-columns:minmax(0,1.5fr)_minmax(300px,1fr)] max-[1100px]:[grid-template-columns:minmax(0,1fr)]">
            <div className="flex flex-col gap-3">
              <GoogleExecutionQueue
                recommendations={summaryAdvisor?.recommendations ?? []}
                accountLabel={advisorExecutionAccountId ?? null}
                businessId={businessId}
                accountId={advisorExecutionAccountId}
                onApplied={refreshAdvisorView}
              />
              {/* The design states the batch contract next to the queue. */}
              <article className="rounded-[14px] border border-dashed border-[var(--adv-scroll-thumb)] px-4 py-3.5">
                <p className="m-0 text-[12.5px] font-semibold text-[var(--adv-ink-2)]">
                  Batch apply — guarded
                </p>
                <p className="m-0 mt-1 text-[12px] leading-[1.5] text-[var(--adv-ink-3)]">
                  One execution target type per run, up to 250 items, one receipt
                  chain. Batches run inside the same approval, guardrail and quiet
                  hour boundary as a single change.
                </p>
              </article>
            </div>
            <GoogleActivityTable rows={activityData?.rows ?? []} isLoading={isActivityLoading} />
          </div>

          <div className="space-y-3 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-3">
          <p className="text-xs text-muted-foreground">
            Budget headroom and scaling candidates · suggested shifts are advisor previews, applied manually in Google Ads
          </p>
          <BudgetScalingTab
            campaigns={budgetData?.rows}
            recommendations={budgetRecommendations}
            totalSpend={budgetData?.totalSpend}
            accountAvgRoas={budgetData?.accountAvgRoas}
            isLoading={isBudgetLoading}
          />
          </div>

          <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[11px] text-[var(--adv-ink-4)]">
            Writes execute only through the guarded boundary — approval,
            guardrails, quiet hours. Anything outside it stays a read.
          </p>
        </section>
      ) : null}


      {activePanel === "assetGroupAudience" ? (
        <section className="space-y-3 rounded-[14px] border border-border/70 bg-card p-3">
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
            <div className="space-y-2">{Array.from({ length: 3 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-[14px]" />)}</div>
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
                      <span className={cn("rounded-full border border-border/70 px-2 py-0.5", weakAudienceSegments.length === 0 ? "bg-[var(--adc-pos-bg)]/40 text-[var(--adc-pos-fg)]" : "bg-[var(--adc-danger-bg)]/40 text-[var(--adc-danger-fg)]")}>Audience risk {weakAudienceSegments.length}</span>
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
                              <span className="rounded-full border border-border/70 bg-[var(--adc-info-bg)]/40 px-1.5 py-0.5 text-[9px] text-[var(--adc-info-fg)]">
                                Advisor focus
                              </span>
                            ) : null}
                            {(group.coverageScore ?? 0) < 50 || group.messagingMismatchCount ? (
                              <span className="rounded-full border border-border/70 bg-[var(--adc-danger-bg)]/40 px-1.5 py-0.5 text-[9px] text-[var(--adc-danger-fg)]">
                                Weak structure
                              </span>
                            ) : null}
                          </div>
                          <div className="flex items-start justify-between gap-2">
                            <div className="min-w-0">
                              <p className="truncate text-xs font-semibold">{group.name}</p>
                              <p className="text-[10px] text-muted-foreground">Spend {fmtCurrency(group.spend)} · ROAS {fmtRoas(group.roas)}</p>
                            </div>
                            <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold", group.roas >= blendedRoas ? "bg-[var(--adc-pos-bg)]/50 text-[var(--adc-pos-fg)]" : "bg-[var(--adc-danger-bg)]/50 text-[var(--adc-danger-fg)]")}>{group.roas >= blendedRoas ? "Above avg" : "Below avg"}</span>
                          </div>

                          <div className="mt-2 flex flex-wrap gap-1">
                            <span className="rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[9px] text-foreground/80">Theme fit {fmtPct(groupThemeAlignment)}</span>
                            <span className="rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[9px] text-foreground/80">Coverage {fmtPct(group.coverageScore ?? 0)}</span>
                            {group.messagingMismatchCount ? <span className="rounded-full border border-border/70 bg-[var(--adc-danger-bg)]/40 px-1.5 py-0.5 text-[9px] text-[var(--adc-danger-fg)]">{group.messagingMismatchCount} mismatch</span> : null}
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
                            <p className="truncate text-[10px] text-muted-foreground">
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


      {activePanel === "assets" ? (
        <section className="flex flex-col gap-4">
          {/* The design switches this screen between three surfaces with one
              pill row: the PMax asset groups, the served assets, the audiences. */}
          <div className="flex flex-wrap gap-2">
            {ASSET_VIEWS.map((view) => (
              <button
                key={view.key}
                type="button"
                onClick={() => setAssetView(view.key)}
                className={cn(
                  "inline-flex h-8 shrink-0 items-center whitespace-nowrap rounded-full border px-[13px] text-[12.5px] font-semibold transition-colors",
                  assetView === view.key
                    ? "border-[var(--adv-accent-bd)] bg-[var(--adv-accent-bg)] text-[var(--adv-accent)]"
                    : "border-[var(--adv-border)] bg-[var(--adv-surface)] text-[var(--adv-ink-2)] hover:bg-[var(--adv-fill)]"
                )}
              >
                {view.label}
              </button>
            ))}
          </div>

          {assetView === "groups" ? (
            isAssetGroupsLoading ? (
              <Skeleton className="h-40 w-full rounded-[14px]" />
            ) : (assetGroupData?.rows?.length ?? 0) === 0 ? (
              <EmptyState
                title={assetGroupEmptyState.title}
                description={assetGroupEmptyState.description}
              />
            ) : (
              <GoogleAssetGroupsTable
                rows={assetGroupData?.rows ?? []}
                currencyFormatter={fmtCurrency}
                focusedNames={focusedAssetGroups}
                footnote={assetGroupQueueNote}
              />
            )
          ) : null}

          {assetView === "assets" ? (
            isAssetsLoading ? (
              <Skeleton className="h-40 w-full rounded-[14px]" />
            ) : scopedAssets.length === 0 ? (
              <EmptyState
                title={assetsEmptyState.title}
                description={assetsEmptyState.description}
              />
            ) : (
              <GoogleAssetPair
                assets={scopedAssets}
                focusedLabels={focusedAssets}
                labelOf={getAssetDisplayLabel}
              />
            )
          ) : null}

          {assetView === "audiences" ? (
            isAudiencesLoading ? (
              <Skeleton className="h-40 w-full rounded-[14px]" />
            ) : (audiencesData?.rows?.length ?? 0) === 0 ? (
              <EmptyState
                title={audienceEmptyState.title}
                description={audienceEmptyState.description}
              />
            ) : (
              <GoogleAudiencesTable
                rows={audiencesData?.rows ?? []}
                currencyFormatter={fmtCurrency}
                footnote="Attach or detach applies from the Plan page as a guarded write — this view stays analysis."
              />
            )
          ) : null}

          <div className="grid gap-3 items-start [grid-template-columns:minmax(0,1.6fr)_minmax(290px,1fr)] max-[1100px]:[grid-template-columns:minmax(0,1fr)]">
          <div className="space-y-3 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-3">
          <p className="text-xs text-muted-foreground">Instantly highlights weak headline, description, image, and video assets</p>
          <SurfaceRecoveryNotice surface={assetSurfaceState} rangeCompletion={assetRangeCompletion} />
          {isAssetsLoading ? (
            <div className="space-y-2">{Array.from({ length: 2 }).map((_, i) => <Skeleton key={i} className="h-28 w-full rounded-[14px]" />)}</div>
          ) : scopedAssets.length === 0 ? (
            <EmptyState title={assetsEmptyState.title} description={assetsEmptyState.description} />
          ) : (
            <>
              <div className="flex flex-wrap items-center gap-1.5 text-[11px]">
                <span className="rounded-full border border-border/70 bg-[var(--adc-danger-bg)]/40 px-2 py-0.5 text-[var(--adc-danger-fg)]">Underperforming {underperformingAssets.length}</span>
                <span className="rounded-full border border-border/70 bg-[var(--adc-pos-bg)]/40 px-2 py-0.5 text-[var(--adc-pos-fg)]">Top assets {topAssets.length}</span>
                <span className="rounded-full border border-border/70 px-2 py-0.5 text-muted-foreground">Total assets {scopedAssets.length}</span>
              </div>
              <div className="grid gap-2 md:grid-cols-2 xl:grid-cols-4">
                {["Headline", "Description", "Image", "Video"].map((type) => {
                  const list = weakAssetsByType.get(type) ?? [];
                  return (
                    <div key={type} className="rounded-lg border border-border/70 bg-card p-3">
                      <div className="mb-2 flex items-center justify-between">
                        <p className="text-xs font-semibold">{type}</p>
                        <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold", list.length === 0 ? "bg-[var(--adc-pos-bg)]/50 text-[var(--adc-pos-fg)]" : "bg-[var(--adc-danger-bg)]/50 text-[var(--adc-danger-fg)]")}>{list.length === 0 ? "Healthy" : `${list.length} issue`}</span>
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
                                ) && "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)]/40"
                              )}
                            >
                              <p className="line-clamp-1 text-[11px] font-medium">{getAssetDisplayLabel(asset)}</p>
                              <p className="mt-0.5 text-[10px] text-muted-foreground">Spend {fmtCurrency(asset.spend)} · ROAS {fmtRoas(asset.roas)} · Conv {asset.conversions.toFixed(0)}</p>
                              {focusedAssets.some(
                                (name) =>
                                  name.toLowerCase().trim() ===
                                  getAssetDisplayLabel(asset)
                                    .toLowerCase()
                                    .trim()
                              ) ? (
                                <div className="mt-1">
                                  <span className="rounded-full border border-border/70 bg-[var(--adc-caution-bg)]/40 px-1.5 py-0.5 text-[9px] text-[var(--adc-caution-fg)]">
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
          </div>
          <GoogleAllocationRead
            recommendations={summaryAdvisor?.recommendations ?? []}
            layer="Assets & Testing"
            title="Asset read"
            subtitle="advisor · asset & audience coverage"
            footnote="Asset reads are directional — replacements apply from Advisor → Plan as guarded writes."
          />
          </div>
        </section>
      ) : null}
    </div>
  );
}

/**
 * Design's Google hero KPI card: mono label, 27px display value, then a delta
 * and a mono qualifier sharing one baseline row above the trend chart.
 */
/**
 * Account-level previous-period total, reconstructed from the per-row change the
 * campaigns endpoint serves (prev = current / (1 + change)). Returns null when
 * comparison is off or any row lacks a change, so the delta is withheld rather
 * than computed from a partial set.
 */
function previousTotalFrom(
  rows: Campaign[],
  current: (row: Campaign) => number,
  change: (row: Campaign) => number | null | undefined,
): number | null {
  if (rows.length === 0) return null;
  let total = 0;
  for (const row of rows) {
    const pct = change(row);
    if (pct === null || pct === undefined || !Number.isFinite(pct)) return null;
    const ratio = 1 + pct / 100;
    if (ratio <= 0) return null;
    total += current(row) / ratio;
  }
  return total;
}

/** Formats an account delta the way the design's KPI row reads it. */
function deltaOf(current: number, previous: number | null) {
  if (previous === null || previous === 0 || !Number.isFinite(previous)) {
    return { delta: null, tone: "neutral" as const };
  }
  const pct = ((current - previous) / Math.abs(previous)) * 100;
  return {
    delta: `${pct >= 0 ? "+" : ""}${pct.toFixed(1)}%`,
    tone: pct >= 0 ? ("pos" as const) : ("neg" as const),
  };
}

function Kpi({
  label,
  value,
  series,
  formatter,
  dateLabelMode,
  highlight,
  delta,
  deltaTone,
  sub,
}: {
  label: string;
  value: string;
  series: Array<{ date: string; value: number }>;
  formatter: (value: number) => string;
  dateLabelMode: TrendLabelMode;
  highlight?: boolean;
  delta?: string | null;
  deltaTone?: "pos" | "neg" | "neutral";
  sub?: string | null;
}) {
  return (
    <article
      className={cn(
        "rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] p-4",
        highlight && "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)]",
      )}
    >
      <p className="font-[family-name:var(--adv-font-mono)] text-[9.5px] uppercase tracking-[0.1em] text-[var(--adv-ink-3)]">
        {label}
      </p>
      <p
        className={cn(
          "mt-2 font-[family-name:var(--adv-font-display)] text-[27px] font-bold tabular-nums tracking-[-0.01em]",
          highlight ? "text-[var(--adc-pos-fg)]" : "text-[var(--adv-ink)]",
        )}
      >
        {value}
      </p>
      {delta || sub ? (
        <div className="mt-1.5 flex items-baseline justify-between gap-2">
          <span
            className="text-[11.5px] font-semibold"
            style={{
              color:
                deltaTone === "pos"
                  ? "var(--adc-pos-fg)"
                  : deltaTone === "neg"
                    ? "var(--adc-danger-fg)"
                    : "var(--adv-ink-3)",
            }}
          >
            {delta ?? ""}
          </span>
          <span className="font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
            {sub ?? ""}
          </span>
        </div>
      ) : null}
      <div className="mt-1.5">
        <MiniTrendAreaChart data={series} tone="neutral" valueFormatter={formatter} dateLabelMode={dateLabelMode} className="h-10 w-full" />
      </div>
    </article>
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
  // absent value against the account average made it fail the comparison and
  // render in the loss colour, so "we have no data for this" was displayed
  // identically to "this is losing money".
  const hasRoas = Number.isFinite(campaign.roas) && campaign.roas > 0;
  const roasColor = !hasRoas
    ? undefined
    : campaign.roas >= accountAvgRoas
      ? "text-emerald-700"
      : "text-rose-600";
  return (
    <div className="h-full rounded-[14px] border bg-card p-3">
      <div className="flex items-center gap-2">
        <span className={cn("h-2 w-2 rounded-full", isCampaignActive(campaign.status) ? "bg-[var(--adc-pos-fg)]" : "bg-slate-300")} />
        <p className="truncate text-[13px] font-medium">{campaign.name}</p>
      </div>
      <div className="mt-1.5 flex flex-wrap items-center gap-1">
        <span className="rounded-full bg-slate-100 px-1.5 py-0.5 text-[9px] font-medium text-slate-600">{campaign.channel}</span>
        <span className={cn("rounded-full border px-1.5 py-0.5 text-[9px] font-semibold", cfg.border, cfg.chip)}>
          <span className={cn("mr-1 inline-block h-1.5 w-1.5 rounded-full align-middle", cfg.dot)} />{cfg.label}
        </span>
        {advisorRow ? (
          <>
            <span className="rounded-full border border-border/70 bg-muted/30 px-1.5 py-0.5 text-[9px] text-foreground/80">
              {advisorRow.familyLabel}
            </span>
            <span className="rounded-full border border-border/70 bg-background px-1.5 py-0.5 text-[9px] text-muted-foreground">
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
              <p className="text-[9px] font-medium uppercase tracking-wide text-muted-foreground">
                Advisor
              </p>
              <p className="mt-1 line-clamp-2 text-[10px] text-foreground/80">
                {advisorRow.topActionHint}
              </p>
            </div>
            {advisorRow.recommendationCount > 0 ? (
              <span className="shrink-0 rounded-full border border-border/70 bg-muted/20 px-1.5 py-0.5 text-[9px] font-medium text-muted-foreground">
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
      <p className="text-[9px] font-medium text-muted-foreground">{label}</p>
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
  // The design renders these as cells of one card, split by hairlines, with no
  // per-cell accent bar — the accent prop is kept for call-site compatibility.
  void accent;

  return (
    <div className="border-r border-[var(--adv-hairline)] px-4 py-[11px] last:border-r-0">
      <p className="font-[family-name:var(--adv-font-mono)] text-[9px] uppercase tracking-[0.09em] text-[var(--adv-ink-4)]">{label}</p>
      <p className="mt-1 text-[15px] font-semibold tabular-nums text-[var(--adv-ink)]">{value}</p>
      <div className="mt-1">
        <MiniTrendAreaChart data={series} tone="neutral" valueFormatter={formatter} dateLabelMode={dateLabelMode} className="h-8 w-full" />
      </div>
    </div>
  );
}
