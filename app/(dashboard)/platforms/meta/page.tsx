"use client";

/**
 * app/(dashboard)/platforms/meta/page.tsx — Premium Dashboard Overhaul
 *
 * Layout:
 *  ┌─────────────────────────────────────────────────┐
 *  │ Header + Date Range                             │
 *  ├──────────┬──────────┬──────────┬────────────────┤
 *  │ KPI Spend│ KPI Rev  │ Avg CPA  │ Blended ROAS   │  ← 4-up KPI row
 *  ├─────────────────────────────┬───────────────────┤
 *  │  Campaign Table (70%)       │  Sidebar (30%)    │
 *  │  • Accordion + lazy adsets  │  • Age badges     │  ← 2-col grid
 *  │  • Micro-bars in Spend/Rev  │  • Location list  │
 *  │                             │  • Placement bars │
 *  └─────────────────────────────┴───────────────────┘
 */

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import {
  DollarSign,
  TrendingUp,
  Target,
  BarChart2,
  RefreshCw,
  Sparkles,

} from "lucide-react";

import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { deriveProviderViewState } from "@/store/integrations-support";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { DataEmptyState } from "@/components/states/DataEmptyState";
import { Button } from "@/components/ui/button";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import type { MetaCampaignRow, MetaCampaignsResponse } from "@/app/api/meta/campaigns/route";
import type { MetaSummaryRouteResponse } from "@/app/api/meta/summary/route";
import {
  DateRangePicker,
  type ComparisonPreset,
  DateRangeValue,
  getPresetDates,
  getPresetDatesForReferenceDate,
} from "@/components/date-range/DateRangePicker";
import { usePersistentMetaDateRange } from "@/hooks/use-persistent-date-range";
import { useCurrencySymbol } from "@/hooks/use-currency";
import { type MetaCampaignTableRow } from "@/components/meta/meta-campaign-table";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { PlanGate } from "@/components/pricing/PlanGate";
import { MetaCampaignList } from "@/components/meta/meta-campaign-list";
import { MetaCampaignDetail } from "@/components/meta/meta-campaign-detail";
import { MetaAnalysisStatusCard } from "@/components/meta/meta-analysis-status-card";
import type { MetaRecommendationsResponse } from "@/lib/meta/recommendations";
import {
  deriveMetaAnalysisStatus,
  didMetaAnalysisRefetchProduceUsableData,
  metaAnalysisRunRangeMatches,
  type MetaAnalysisRunRange,
} from "@/lib/meta/analysis-state";
import { buildMetaCampaignLaneSignals } from "@/lib/meta/campaign-lanes";
import { ProviderReadinessIndicator } from "@/components/sync/provider-readiness-indicator";
import {
  SyncStatusPill,
  SyncStatusPillSkeleton,
} from "@/components/sync/sync-status-pill";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import { usePlanState } from "@/lib/pricing/usePlan";
import { PRICING_PLANS } from "@/lib/pricing/plans";
import { META_WAREHOUSE_HISTORY_DAYS } from "@/lib/meta/history";
import {
  getMetaPageReadiness,
  isMetaPageCurrentDayPreparing,
  shouldMaskMetaKpisAsPreparing,
} from "@/lib/meta/page-readiness";
import { getMetaPageStatusMessaging } from "@/lib/meta/ui-status";
import { resolveMetaSyncStatusPill } from "@/lib/sync/sync-status-pill";
import {
  formatMetaDate,
} from "@/lib/meta/ui";
import { getMetaPresetDates } from "@/lib/meta/date";

// ── Data fetchers ─────────────────────────────────────────────────────────────

async function fetchMetaCampaigns(
  businessId: string,
  startDate: string,
  endDate: string,
  includePrev = false,
  campaignId?: string | null
): Promise<MetaCampaignsResponse> {
  const params = new URLSearchParams({ businessId, startDate, endDate });
  if (includePrev) params.set("includePrev", "1");
  if (campaignId) params.set("campaignId", campaignId);
  const res = await fetch(`/api/meta/campaigns?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok)
    throw new Error(
      payload?.message ?? `Request failed (${res.status})`
    );
  return payload as MetaCampaignsResponse;
}

async function fetchMetaRecommendations(
  businessId: string,
  startDate: string,
  endDate: string
): Promise<MetaRecommendationsResponse> {
  const params = new URLSearchParams({ businessId, startDate, endDate });
  const res = await fetch(`/api/meta/recommendations?${params.toString()}`, {
    headers: { Accept: "application/json" },
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.message ?? `Request failed (${res.status})`);
  }
  return payload as MetaRecommendationsResponse;
}

async function fetchMetaSummary(
  businessId: string,
  startDate: string,
  endDate: string
): Promise<MetaSummaryRouteResponse> {
  const params = new URLSearchParams({ businessId, startDate, endDate });
  const res = await fetch(`/api/meta/summary?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.message ?? `Request failed (${res.status})`);
  }
  return payload as MetaSummaryRouteResponse;
}

async function fetchMetaPageStatus(
  businessId: string,
  startDate?: string,
  endDate?: string
): Promise<MetaStatusResponse> {
  const params = new URLSearchParams({ businessId });
  if (startDate) params.set("startDate", startDate);
  if (endDate) params.set("endDate", endDate);
  const res = await fetch(`/api/meta/page-status?${params.toString()}`, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await res.json().catch(() => null);
  if (!res.ok) {
    throw new Error(payload?.message ?? `Request failed (${res.status})`);
  }
  return payload as MetaStatusResponse;
}

function getMetaStatusRefetchInterval(status: MetaStatusResponse | undefined) {
  const state = status?.state;
  const selectedRangeReady = status?.pageReadiness?.state === "ready";
  const backgroundExtendedLagOnly =
    selectedRangeReady &&
    Boolean(
      status?.extendedCompleteness &&
        !status.extendedCompleteness.complete &&
        status.extendedCompleteness.state !== "blocked"
    );
  const historicalExtendedWorkActive =
    (status?.jobHealth?.extendedHistoricalQueueDepth ?? 0) > 0 ||
    (status?.jobHealth?.extendedHistoricalLeasedPartitions ?? 0) > 0;
  if (state === "syncing") {
    if (selectedRangeReady && status?.extendedCompleteness?.complete) {
      return (status?.jobHealth?.queueDepth ?? 0) > 0 ||
        (status?.jobHealth?.leasedPartitions ?? 0) > 0
        ? 10_000
        : false;
    }
    if (backgroundExtendedLagOnly) {
      return historicalExtendedWorkActive ? 30_000 : false;
    }
    return 5_000;
  }
  if (state === "partial") {
    if (backgroundExtendedLagOnly) {
      return historicalExtendedWorkActive ? 30_000 : false;
    }
    return 10_000;
  }
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

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt$(n: number, sym = "$"): string {
  return `${sym}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtK(n: number, sym = "$"): string {
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(1)}k`;
  return fmt$(n, sym);
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}


function parseISODate(value: string): Date {
  return new Date(`${value}T00:00:00.000Z`);
}

function addDaysToISO(value: string, days: number): string {
  const date = parseISODate(value);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function dayDiffInclusive(startDate: string, endDate: string): number {
  const start = parseISODate(startDate).getTime();
  const end = parseISODate(endDate).getTime();
  return Math.max(1, Math.floor((end - start) / 86_400_000) + 1);
}

const META_ANALYSIS_SAFE_ERROR_MESSAGE =
  "Analysis could not complete safely. Run analysis again for this range.";

function overlapDayCountInclusive(
  startA: string,
  endA: string,
  startB: string,
  endB: string
): number {
  const start = startA > startB ? startA : startB;
  const end = endA < endB ? endA : endB;
  if (start > end) return 0;
  return dayDiffInclusive(start, end);
}

function getComparisonWindow(
  startDate: string,
  endDate: string,
  preset: ComparisonPreset,
  comparisonStart?: string,
  comparisonEnd?: string
): { startDate: string; endDate: string } | null {
  if (preset === "none") return null;

  if (comparisonStart && comparisonEnd) {
    return { startDate: comparisonStart, endDate: comparisonEnd };
  }

  if (preset === "previousPeriod") {
    const days = dayDiffInclusive(startDate, endDate);
    const previousEnd = addDaysToISO(startDate, -1);
    const previousStart = addDaysToISO(previousEnd, -(days - 1));
    return { startDate: previousStart, endDate: previousEnd };
  }

  if (preset === "previousWeek") {
    return {
      startDate: addDaysToISO(startDate, -7),
      endDate: addDaysToISO(endDate, -7),
    };
  }

  if (preset === "previousMonth") {
    return {
      startDate: addDaysToISO(startDate, -30),
      endDate: addDaysToISO(endDate, -30),
    };
  }

  if (preset === "previousQuarter") {
    return {
      startDate: addDaysToISO(startDate, -90),
      endDate: addDaysToISO(endDate, -90),
    };
  }

  return {
    startDate: addDaysToISO(startDate, -365),
    endDate: addDaysToISO(endDate, -365),
  };
}

function getComparisonLabel(
  preset: ComparisonPreset,
  comparisonStart?: string | null,
  comparisonEnd?: string | null
) {
  if (preset === "custom" && comparisonStart && comparisonEnd) {
    return "vs custom range";
  }
  if (preset === "previousWeek") return "vs previous week";
  if (preset === "previousMonth") return "vs previous month";
  if (preset === "previousQuarter") return "vs previous quarter";
  if (preset === "previousYear" || preset === "previousYearMatch") return "vs previous year";
  return "vs previous period";
}

function clampDateRangeForHistoryLimit(
  value: DateRangeValue,
  referenceDate: string | undefined,
  maxHistoryDays: number | null
): DateRangeValue {
  if (maxHistoryDays === null) return value;
  const resolved = referenceDate
    ? getPresetDatesForReferenceDate(
        value.rangePreset,
        referenceDate,
        value.customStart,
        value.customEnd
      )
    : getPresetDates(value.rangePreset, value.customStart, value.customEnd);
  const earliestAllowed = addDaysToISO(resolved.end, -(maxHistoryDays - 1));
  const clampedStart =
    value.rangePreset === "custom" && resolved.start < earliestAllowed
      ? earliestAllowed
      : value.customStart;
  const comparisonPreset =
    value.comparisonPreset === "previousYear" || value.comparisonPreset === "previousYearMatch"
      ? "none"
      : value.comparisonPreset;
  return {
    ...value,
    customStart: clampedStart,
    comparisonPreset,
    comparisonStart: comparisonPreset === "none" ? "" : value.comparisonStart,
    comparisonEnd: comparisonPreset === "none" ? "" : value.comparisonEnd,
  };
}

// ── KPI Cards ─────────────────────────────────────────────────────────────────

interface KpiData {
  totalSpend: number;
  totalRevenue: number;
  avgCpa: number;
  blendedRoas: number;
}

function computeChangePct(current: number, previous: number): number | null {
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function computeKpis(rows: MetaCampaignRow[]): KpiData {
  const totalSpend = rows.reduce((a, r) => a + r.spend, 0);
  const totalRevenue = rows.reduce((a, r) => a + r.revenue, 0);
  const totalPurchases = rows.reduce((a, r) => a + r.purchases, 0);
  return {
    totalSpend,
    totalRevenue,
    avgCpa: totalPurchases > 0 ? totalSpend / totalPurchases : 0,
    blendedRoas: totalSpend > 0 ? totalRevenue / totalSpend : 0,
  };
}

interface KpiCardProps {
  label: string;
  value: string;
  subLabel: string;
  icon: React.ElementType;
  accentClass: string; // left-border color
  valueClass?: string; // optional value color override
  changePct?: number | null;
  positiveIsGood?: boolean;
  comparisonLabel?: string;
}

function KpiCard({
  label,
  value,
  subLabel,
  icon: Icon,
  accentClass,
  valueClass = "text-foreground",
  changePct = null,
  positiveIsGood = true,
  comparisonLabel = "vs previous period",
}: KpiCardProps) {
  const hasChange = typeof changePct === "number";
  const isPositive = hasChange ? changePct > 0 : false;
  const isNegative = hasChange ? changePct < 0 : false;
  const colorClass = !hasChange
    ? "text-muted-foreground"
    : positiveIsGood
      ? isPositive
        ? "text-emerald-600"
        : isNegative
          ? "text-red-500"
          : "text-muted-foreground"
      : isPositive
        ? "text-red-500"
        : isNegative
          ? "text-emerald-600"
          : "text-muted-foreground";
  const sign = hasChange && changePct > 0 ? "+" : "";

  return (
    <div
      className={`relative overflow-hidden rounded-2xl border bg-card p-5 shadow-sm ${accentClass}`}
    >
      {/* Subtle background glow */}
      <div className="pointer-events-none absolute inset-0 bg-gradient-to-br from-transparent to-muted/30" />

      <div className="relative flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[11px] font-semibold uppercase tracking-widest text-muted-foreground">
            {label}
          </p>
          <p
            className={`mt-1.5 font-mono text-3xl font-bold tracking-tight ${valueClass}`}
          >
            {value}
          </p>
          <p className="mt-1 text-xs text-muted-foreground">{subLabel}</p>
          {hasChange && (
            <p className={`mt-1 text-[11px] font-semibold ${colorClass}`}>
              {sign}
              {changePct.toFixed(1)}% {comparisonLabel}
            </p>
          )}
        </div>
        <div className="shrink-0 rounded-xl bg-muted/50 p-2.5">
          <Icon className="h-5 w-5 text-muted-foreground" />
        </div>
      </div>
    </div>
  );
}

// ── Section error ─────────────────────────────────────────────────────────────

function SectionError({
  message,
  onRetry,
  language,
}: {
  message: string;
  onRetry: () => void;
  language: "en" | "tr";
}) {
  return (
    <div className="rounded-xl border border-destructive/30 bg-destructive/5 p-4">
      <p className="text-sm font-medium text-destructive">
        {language === "tr" ? "Veri yüklenemedi" : "Could not load data"}
      </p>
      <p className="mt-1 text-xs text-destructive/80">{message}</p>
      <Button className="mt-3" variant="outline" size="sm" onClick={onRetry}>
        {language === "tr" ? "Tekrar dene" : "Retry"}
      </Button>
    </div>
  );
}

function MetaStatusBanner({
  status,
  language: _language,
}: {
  status: MetaStatusResponse | undefined;
  language: "en" | "tr";
}) {
  const messages = getMetaPageStatusMessaging(status, _language);
  if (!messages.banner.visible || !messages.banner.description) return null;
  const toneClasses =
    messages.banner.tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-900"
      : "border-blue-200 bg-blue-50 text-blue-900";
  return (
    <div className={`rounded-xl border px-4 py-3 text-sm ${toneClasses}`}>
      {messages.banner.title ? <p className="font-medium">{messages.banner.title}</p> : null}
      <p className={messages.banner.title ? "mt-1" : ""}>{messages.banner.description}</p>
    </div>
  );
}

function NoAccountsAssigned() {
  const router = useRouter();
  return (
    <div className="rounded-xl border border-dashed p-8 text-center">
      <p className="text-sm font-medium">No Meta ad accounts assigned</p>
      <p className="mt-1 text-sm text-muted-foreground">
        Assign one or more Meta ad accounts to this business.
      </p>
      <Button
        className="mt-4"
        variant="outline"
        onClick={() => router.push("/integrations")}
      >
        Open Integrations
      </Button>
    </div>
  );
}

// ── Page ──────────────────────────────────────────────────────────────────────

export default function MetaPage() {
  const language = "en" as "en" | "tr";
  const businesses = useAppStore((s) => s.businesses);
  const selectedBusinessId = useAppStore((s) => s.selectedBusinessId);
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const { plan: currentPlan } = usePlanState();
  const businessId = selectedBusinessId ?? "";
  const sym = useCurrencySymbol();

  const domains = useIntegrationsStore((s) =>
    selectedBusinessId ? s.domainsByBusinessId[selectedBusinessId] : undefined
  );
  const { isBootstrapping, bootstrapStatus } = useBusinessIntegrationsBootstrap(
    selectedBusinessId ?? null,
    { providers: ["meta"] }
  );

  const [dateRange, setDateRange] = usePersistentMetaDateRange();
  const [selectedCampaignId, setSelectedCampaignId] = useState<string | null>(null);
  const [lastAnalyzedAt, setLastAnalyzedAt] = useState<Date | null>(null);
  const [lastAnalyzedRange, setLastAnalyzedRange] =
    useState<MetaAnalysisRunRange | null>(null);
  const activeAnalysisRangeRef = useRef<MetaAnalysisRunRange | null>(null);
  const [checkedRecIds, setCheckedRecIds] = useState<Set<string>>(new Set());
  const [recommendationsError, setRecommendationsError] = useState<string | null>(null);
  const [isManualRefreshRunning, setIsManualRefreshRunning] = useState(false);
  const allowedHistoryDays = PRICING_PLANS[currentPlan].limits.analyticsHistoryDays;
  const previousYearAllowed = allowedHistoryDays === null || allowedHistoryDays > 365;
  const campaignIdParam = searchParams.get("campaignId");


  if (!selectedBusinessId) return <BusinessEmptyState />;

  const isDemoBusiness = isDemoBusinessSelected(selectedBusinessId, businesses);
  const metaView = deriveProviderViewState("meta", domains?.meta ?? {
    provider: "meta",
    connection: { status: "disconnected" },
    discovery: {
      status: "idle",
      entities: [],
      source: null,
      fetchedAt: null,
      notice: null,
      stale: false,
      refreshFailed: false,
    },
    assignment: {
      status: "idle",
      selectedIds: [],
      updatedAt: null,
    },
  });
  const showBootstrapGuard =
    !isDemoBusiness &&
    !metaView.isConnected &&
    (isBootstrapping ||
      metaView.status === "loading_data" ||
      bootstrapStatus !== "ready");
  const metaConnected = metaView.isConnected || isDemoBusiness;

  useEffect(() => {
    if (campaignIdParam === selectedCampaignId) return;
    setSelectedCampaignId(campaignIdParam);
  }, [campaignIdParam, selectedCampaignId]);

  const metaReferenceQuery = useQuery({
    queryKey: ["meta-page-reference", businessId],
    enabled: metaConnected,
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaPageStatus(businessId),
  });

  const effectiveMetaReferenceDate =
    metaReferenceQuery.data?.currentDateInTimezone ?? null;
  const effectiveMetaTimeZoneLabel =
    metaReferenceQuery.data?.primaryAccountTimezone ?? null;
  const shouldFallbackToLocalMetaReference =
    metaConnected &&
    !effectiveMetaReferenceDate &&
    (metaReferenceQuery.isSuccess || metaReferenceQuery.isError);
  const isMetaReferenceReady =
    !metaConnected ||
    Boolean(effectiveMetaReferenceDate) ||
    shouldFallbackToLocalMetaReference;
  const resolvedMetaRange = isMetaReferenceReady
    ? getMetaPresetDates({
        value: dateRange,
        referenceDate: effectiveMetaReferenceDate,
      })
    : null;
  const startDate = resolvedMetaRange?.start ?? null;
  const endDate = resolvedMetaRange?.end ?? null;
  activeAnalysisRangeRef.current =
    businessId && startDate && endDate
      ? { businessId, startDate, endDate }
      : null;

  useEffect(() => {
    if (allowedHistoryDays === null && previousYearAllowed) return;
    const normalized = clampDateRangeForHistoryLimit(
      dateRange,
      effectiveMetaReferenceDate ?? undefined,
      allowedHistoryDays
    );
    const changed =
      normalized.customStart !== dateRange.customStart ||
      normalized.customEnd !== dateRange.customEnd ||
      normalized.comparisonPreset !== dateRange.comparisonPreset ||
      normalized.comparisonStart !== dateRange.comparisonStart ||
      normalized.comparisonEnd !== dateRange.comparisonEnd;
    if (changed) {
      setDateRange(normalized);
    }
  }, [allowedHistoryDays, dateRange, effectiveMetaReferenceDate, previousYearAllowed, setDateRange]);
  const comparisonWindow =
    startDate && endDate
      ? getComparisonWindow(
          startDate,
          endDate,
          dateRange.comparisonPreset,
          dateRange.comparisonStart,
          dateRange.comparisonEnd
        )
      : null;
  const comparisonLabel = getComparisonLabel(
    dateRange.comparisonPreset,
    dateRange.comparisonStart,
    dateRange.comparisonEnd
  );
  const isTodayRange =
    dateRange.rangePreset === "today" ||
    (Boolean(effectiveMetaReferenceDate) &&
      Boolean(startDate && endDate) &&
      startDate === endDate &&
      startDate === effectiveMetaReferenceDate);
  const shouldFetchSummary =
    metaConnected && isMetaReferenceReady && Boolean(startDate && endDate) && !isTodayRange;

  const pageStatusQuery = useQuery({
    queryKey: ["meta-page-status", businessId, startDate, endDate],
    enabled: metaConnected && isMetaReferenceReady && Boolean(startDate && endDate),
    staleTime: 30 * 1000,
    refetchInterval: (query) =>
      getMetaStatusRefetchInterval(query.state.data as MetaStatusResponse | undefined),
    queryFn: () => fetchMetaPageStatus(businessId, startDate!, endDate!),
  });

  const effectiveStatus = pageStatusQuery.data ?? metaReferenceQuery.data;
  const campaignsQuery = useQuery({
    queryKey: ["meta-campaigns", businessId, startDate, endDate],
    enabled: metaConnected && isMetaReferenceReady && Boolean(startDate && endDate),
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaCampaigns(businessId, startDate!, endDate!, false),
  });

  const selectedCampaignPrevQuery = useQuery({
    queryKey: [
      "meta-campaigns-prev",
      businessId,
      startDate,
      endDate,
      selectedCampaignId,
    ],
    enabled:
      metaConnected &&
      isMetaReferenceReady &&
      campaignsQuery.isSuccess &&
      Boolean(selectedCampaignId),
    staleTime: 5 * 60 * 1000,
    queryFn: () =>
      fetchMetaCampaigns(
        businessId,
        startDate!,
        endDate!,
        true,
        selectedCampaignId
      ),
  });

  const summaryQuery = useQuery({
    queryKey: ["meta-warehouse-summary", businessId, startDate, endDate],
    enabled: shouldFetchSummary,
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaSummary(businessId, startDate!, endDate!),
  });

  const coreQueriesSettled =
    (pageStatusQuery.isSuccess || pageStatusQuery.isError) &&
    (campaignsQuery.isSuccess || campaignsQuery.isError) &&
    (!shouldFetchSummary || summaryQuery.isSuccess || summaryQuery.isError);

  const recommendationsQuery = useQuery({
    queryKey: ["meta-recommendations-v8", businessId, startDate, endDate],
    enabled: false,
    staleTime: Infinity,
    queryFn: () => fetchMetaRecommendations(businessId, startDate!, endDate!),
  });

  const isAnalysisRunning = recommendationsQuery.isFetching;
  const analysisStatus = useMemo(
    () =>
      deriveMetaAnalysisStatus({
        businessId,
        startDate,
        endDate,
        recommendationsData: recommendationsQuery.data,
        recommendationsError: recommendationsError ?? recommendationsQuery.error,
        recommendationsIsFetching: recommendationsQuery.isFetching,
        lastAnalyzedAt,
        lastAnalyzedRange,
      }),
    [
      businessId,
      endDate,
      lastAnalyzedAt,
      lastAnalyzedRange,
      recommendationsError,
      recommendationsQuery.data,
      recommendationsQuery.error,
      recommendationsQuery.isFetching,
      startDate,
    ],
  );

  // Scroll the left panel item into view when a campaign is selected from recommendations.
  useEffect(() => {
    if (!selectedCampaignId) return;
    const el = document.getElementById(`meta-list-item-${selectedCampaignId}`);
    el?.scrollIntoView({ behavior: "smooth", block: "nearest" });
  }, [selectedCampaignId]);

  useEffect(() => {
    const nextParams = new URLSearchParams(searchParams.toString());
    if (selectedCampaignId) {
      nextParams.set("campaignId", selectedCampaignId);
    } else {
      nextParams.delete("campaignId");
    }
    const currentQuery = searchParams.toString();
    const nextQuery = nextParams.toString();
    if (currentQuery === nextQuery) return;
    const nextHref = nextQuery ? `${pathname}?${nextQuery}` : pathname;
    router.replace(nextHref, { scroll: false });
  }, [pathname, router, searchParams, selectedCampaignId]);

  useEffect(() => {
    setRecommendationsError(null);
    setLastAnalyzedAt(null);
    setLastAnalyzedRange(null);
    setCheckedRecIds(new Set());
  }, [businessId, startDate, endDate]);

  async function handleAnalyze() {
    if (!businessId || !startDate || !endDate || !isMetaReferenceReady) return;
    const runRange = { businessId, startDate, endDate };
    setRecommendationsError(null);
    let recommendationsResult: Awaited<ReturnType<typeof recommendationsQuery.refetch>>;
    try {
      recommendationsResult = await recommendationsQuery.refetch();
    } catch {
      setRecommendationsError(META_ANALYSIS_SAFE_ERROR_MESSAGE);
      return;
    }
    const hasUsableAnalysis = didMetaAnalysisRefetchProduceUsableData({
      recommendationsResult,
      expectedRange: runRange,
    });
    if (!hasUsableAnalysis) {
      setRecommendationsError(META_ANALYSIS_SAFE_ERROR_MESSAGE);
      return;
    }
    if (!metaAnalysisRunRangeMatches(activeAnalysisRangeRef.current, runRange)) {
      return;
    }
    const analyzedAt = new Date();
    setLastAnalyzedAt(analyzedAt);
    setLastAnalyzedRange(runRange);
    setCheckedRecIds(new Set());
  }

  function handleToggleCheck(id: string) {
    setCheckedRecIds((prev) => {
      const next = new Set(prev);
      if (next.has(id)) next.delete(id);
      else next.add(id);
      return next;
    });
  }

  async function handleRefreshData() {
    if (!businessId || isManualRefreshRunning || isSyncInProgress || !startDate || !endDate || !isMetaReferenceReady) return;
    try {
      setIsManualRefreshRunning(true);
      const previousSummarySpend = summaryQuery.data?.totals?.spend ?? null;
      const previousCampaignSpend = (campaignsQuery.data?.rows ?? []).reduce(
        (sum, row) => sum + (row.spend ?? 0),
        0,
      );

      const response = await fetch("/api/sync/refresh", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        body: JSON.stringify({
          businessId,
          provider: "meta",
          mode: isTodayRange ? "today" : "repair",
          startDate,
          endDate,
        }),
      });
      if (!response.ok) {
        const payload = await response.json().catch(() => null);
        throw new Error(payload?.error ?? payload?.message ?? `Refresh failed (${response.status})`);
      }
      const refreshPayload = await response.json().catch(() => null);

      await Promise.allSettled(
        [
          pageStatusQuery.refetch(),
          campaignsQuery.refetch(),
          shouldFetchSummary ? summaryQuery.refetch() : null,
          selectedCampaignId ? selectedCampaignPrevQuery.refetch() : null,
          comparisonWindow ? comparisonCampaignsQuery.refetch() : null,
          comparisonWindow ? comparisonSummaryQuery.refetch() : null,
        ].filter(Boolean)
      );

      for (let attempt = 0; attempt < 20; attempt += 1) {
        await sleep(2_000);
        const [
          statusResult,
          campaignsResult,
          summaryResult,
          campaignPrevResult,
          compareCampaignsResult,
          compareSummaryResult,
        ] = await Promise.allSettled([
          pageStatusQuery.refetch(),
          campaignsQuery.refetch(),
          shouldFetchSummary ? summaryQuery.refetch() : Promise.resolve(undefined),
          selectedCampaignId
            ? selectedCampaignPrevQuery.refetch()
            : Promise.resolve(undefined),
          comparisonWindow
            ? comparisonCampaignsQuery.refetch()
            : Promise.resolve(undefined),
          comparisonWindow
            ? comparisonSummaryQuery.refetch()
            : Promise.resolve(undefined),
        ]);

        const refreshedStatus =
          statusResult.status === "fulfilled" ? statusResult.value.data : undefined;
        const refreshedCampaigns =
          campaignsResult.status === "fulfilled" ? campaignsResult.value.data : undefined;
        const refreshedSummary =
          summaryResult.status === "fulfilled" ? summaryResult.value?.data : undefined;

        const queueDepth = refreshedStatus?.jobHealth?.queueDepth ?? 0;
        const leasedPartitions = refreshedStatus?.jobHealth?.leasedPartitions ?? 0;
        const currentSummarySpend = refreshedSummary?.totals?.spend ?? null;
        const currentCampaignSpend = (refreshedCampaigns?.rows ?? []).reduce(
          (sum, row) => sum + (row.spend ?? 0),
          0,
        );
        const dataChanged =
          currentSummarySpend !== previousSummarySpend ||
          currentCampaignSpend !== previousCampaignSpend;
        const syncSettled =
          (refreshedStatus?.state ?? "ready") !== "syncing" &&
          queueDepth <= 0 &&
          leasedPartitions <= 0;
        const selectedRangeCoreReady = Boolean(
          refreshedStatus?.pageReadiness?.requiredSurfaces?.summary?.state === "ready" &&
            refreshedStatus?.pageReadiness?.requiredSurfaces?.campaigns?.state === "ready"
        );
        const truthReady = isTodayRange
          ? syncSettled
          : selectedRangeCoreReady;

        if (
          dataChanged ||
          truthReady ||
          (refreshPayload?.status === "finalized" && syncSettled)
        ) {
          void campaignPrevResult;
          void compareCampaignsResult;
          void compareSummaryResult;
          break;
        }
      }
    } finally {
      setIsManualRefreshRunning(false);
    }
  }

  const comparisonCampaignsQuery = useQuery({
    queryKey: [
      "meta-campaigns-compare",
      businessId,
      comparisonWindow?.startDate,
      comparisonWindow?.endDate,
    ],
    enabled: metaConnected && Boolean(comparisonWindow) && coreQueriesSettled,
    queryFn: () =>
      fetchMetaCampaigns(
        businessId,
        comparisonWindow!.startDate,
        comparisonWindow!.endDate,
        false
      ),
  });

  const comparisonSummaryQuery = useQuery({
    queryKey: [
      "meta-warehouse-summary-compare",
      businessId,
      comparisonWindow?.startDate,
      comparisonWindow?.endDate,
    ],
    enabled: metaConnected && Boolean(comparisonWindow) && coreQueriesSettled,
    staleTime: 60 * 1000,
    queryFn: () =>
      fetchMetaSummary(
        businessId,
        comparisonWindow!.startDate,
        comparisonWindow!.endDate
      ),
  });

  // KPIs are derived from the campaign rows — no extra API call
  const warehouseKpis = useMemo(() => {
    const totals = summaryQuery.data?.totals;
    if (!totals) return null;
    return {
      totalSpend: totals.spend,
      totalRevenue: totals.revenue,
      avgCpa: totals.cpa ?? 0,
      blendedRoas: totals.roas,
    } satisfies KpiData;
  }, [summaryQuery.data]);
  const campaignWarehouseKpis = useMemo(
    () => computeKpis(campaignsQuery.data?.rows ?? []),
    [campaignsQuery.data]
  );
  const statusHistoricalProgress = effectiveStatus?.latestSync
    ? {
        progressPercent: effectiveStatus.latestSync.progressPercent ?? 0,
        completedDays: effectiveStatus.latestSync.completedDays ?? 0,
        totalDays: effectiveStatus.latestSync.totalDays ?? META_WAREHOUSE_HISTORY_DAYS,
        readyThroughDate: effectiveStatus.latestSync.readyThroughDate ?? null,
        state: (effectiveStatus.state === "ready"
          ? "ready"
          : effectiveStatus.state === "partial"
            ? "partial"
          : "syncing") as "ready" | "syncing" | "partial",
      }
    : null;
  const hasCampaignSpend =
    (campaignsQuery.data?.rows ?? []).some((row) => (row.spend ?? 0) > 0);
  const emptyKpis: KpiData = {
    totalSpend: 0,
    totalRevenue: 0,
    avgCpa: 0,
    blendedRoas: 0,
  };
  const kpis = warehouseKpis ?? campaignWarehouseKpis ?? emptyKpis;
  const historicalProgressStatus = effectiveStatus;
  const metaSyncPill = resolveMetaSyncStatusPill(historicalProgressStatus);
  const shouldShowHistoricalProgress =
    metaConnected &&
    (metaSyncPill?.state ?? "active") !== "active";
  const isCoreRangePending =
    metaConnected &&
    !isMetaReferenceReady &&
    !shouldFallbackToLocalMetaReference;
  const isStatusLoading =
    metaConnected &&
    !effectiveStatus &&
    (metaReferenceQuery.isLoading || pageStatusQuery.isLoading);
  const isSyncInProgress =
    metaSyncPill?.state === "syncing";

  const previousWarehouseKpis = useMemo(() => {
    const totals = comparisonSummaryQuery.data?.totals;
    if (!totals) return null;
    return {
      totalSpend: totals.spend,
      totalRevenue: totals.revenue,
      avgCpa: totals.cpa ?? 0,
      blendedRoas: totals.roas,
    } satisfies KpiData;
  }, [comparisonSummaryQuery.data]);
  const previousCampaignKpis = useMemo(
    () => computeKpis(comparisonCampaignsQuery.data?.rows ?? []),
    [comparisonCampaignsQuery.data]
  );
  const previousKpis = previousWarehouseKpis ?? previousCampaignKpis ?? emptyKpis;
  const pageReadiness = getMetaPageReadiness(effectiveStatus);
  const isCurrentDayPreparing = isMetaPageCurrentDayPreparing(effectiveStatus);
  const pageMessages = getMetaPageStatusMessaging(effectiveStatus, language);
  const metaAccountDayLabel =
    effectiveMetaReferenceDate && effectiveMetaTimeZoneLabel
      ? `Meta account day: ${formatMetaDate(effectiveMetaReferenceDate, language) ?? effectiveMetaReferenceDate} (${effectiveMetaTimeZoneLabel})`
      : null;
  const shouldMaskKpisAsPreparing = shouldMaskMetaKpisAsPreparing({
    status: effectiveStatus,
    hasCampaignSpend,
    summaryLoading: summaryQuery.isLoading,
  });
  const canRenderKpis =
    !shouldMaskKpisAsPreparing &&
    Boolean(warehouseKpis ?? campaignWarehouseKpis);
  const campaignCountLabel = shouldMaskKpisAsPreparing
    ? pageMessages.kpi.spendSubLabel
    : campaignsQuery.isLoading
      ? "Campaign drilldown is loading"
      : `${campaignsQuery.data?.rows?.length ?? 0} campaigns`;
  const campaignSurfaceLoadingTitle =
    summaryQuery.data && pageReadiness?.state === "ready"
      ? "Loading campaign drilldown"
      : "Loading campaign performance";
  const campaignSurfaceLoadingDescription =
    summaryQuery.data && pageReadiness?.state === "ready"
      ? "Summary truth is ready. Campaign rows are still loading in the background."
      : "Campaign, breakdown, and recovery surfaces will appear as sync finishes.";
  const campaignRowsForTable = useMemo<MetaCampaignTableRow[]>(() => {
    const rows = campaignsQuery.data?.rows ?? [];
    const laneById = buildMetaCampaignLaneSignals(rows);
    const recommendationMetaById = new Map<
      string,
      { count: number; topActionHint: string | null }
    >();
    for (const recommendation of recommendationsQuery.data?.recommendations ?? []) {
      if (!recommendation.campaignId) continue;
      const existing = recommendationMetaById.get(recommendation.campaignId);
      if (!existing) {
        recommendationMetaById.set(recommendation.campaignId, {
          count: 1,
          topActionHint: recommendation.title,
        });
        continue;
      }
      recommendationMetaById.set(recommendation.campaignId, {
        count: existing.count + 1,
        topActionHint: existing.topActionHint ?? recommendation.title,
      });
    }
    const prevConfigById = new Map(
      (selectedCampaignPrevQuery.data?.rows ?? []).map((row) => [row.id, row])
    );
    if (!comparisonWindow || !comparisonCampaignsQuery.data?.rows?.length) {
      return rows.map((row) => ({
        ...row,
        laneLabel: laneById.get(row.id)?.lane ?? null,
        recommendationCount: recommendationMetaById.get(row.id)?.count ?? 0,
        topActionHint: recommendationMetaById.get(row.id)?.topActionHint ?? null,
        isFocused: selectedCampaignId === row.id,
        previousManualBidAmount: prevConfigById.get(row.id)?.previousManualBidAmount ?? row.previousManualBidAmount,
        previousBidValue: prevConfigById.get(row.id)?.previousBidValue ?? row.previousBidValue,
        previousBidValueFormat: prevConfigById.get(row.id)?.previousBidValueFormat ?? row.previousBidValueFormat,
        previousBidValueCapturedAt:
          prevConfigById.get(row.id)?.previousBidValueCapturedAt ?? row.previousBidValueCapturedAt,
        previousDailyBudget: prevConfigById.get(row.id)?.previousDailyBudget ?? row.previousDailyBudget,
        previousLifetimeBudget:
          prevConfigById.get(row.id)?.previousLifetimeBudget ?? row.previousLifetimeBudget,
        previousBudgetCapturedAt:
          prevConfigById.get(row.id)?.previousBudgetCapturedAt ?? row.previousBudgetCapturedAt,
      }));
    }

    const previousById = new Map(
      comparisonCampaignsQuery.data.rows.map((row) => [row.id, row])
    );

    return rows.map((row) => {
      const prev = previousById.get(row.id);
      return {
        ...row,
        laneLabel: laneById.get(row.id)?.lane ?? null,
        recommendationCount: recommendationMetaById.get(row.id)?.count ?? 0,
        topActionHint: recommendationMetaById.get(row.id)?.topActionHint ?? null,
        isFocused: selectedCampaignId === row.id,
        previousManualBidAmount: prevConfigById.get(row.id)?.previousManualBidAmount ?? row.previousManualBidAmount,
        previousBidValue: prevConfigById.get(row.id)?.previousBidValue ?? row.previousBidValue,
        previousBidValueFormat: prevConfigById.get(row.id)?.previousBidValueFormat ?? row.previousBidValueFormat,
        previousBidValueCapturedAt:
          prevConfigById.get(row.id)?.previousBidValueCapturedAt ?? row.previousBidValueCapturedAt,
        previousDailyBudget: prevConfigById.get(row.id)?.previousDailyBudget ?? row.previousDailyBudget,
        previousLifetimeBudget:
          prevConfigById.get(row.id)?.previousLifetimeBudget ?? row.previousLifetimeBudget,
        previousBudgetCapturedAt:
          prevConfigById.get(row.id)?.previousBudgetCapturedAt ?? row.previousBudgetCapturedAt,
        previousSpend: prev?.spend,
        previousRevenue: prev?.revenue,
        previousRoas: prev?.roas,
        previousCpa: prev?.cpa,
      };
    });
  }, [
    selectedCampaignPrevQuery.data?.rows,
    campaignsQuery.data?.rows,
    comparisonCampaignsQuery.data?.rows,
    comparisonWindow,
    selectedCampaignId,
    recommendationsQuery.data?.recommendations,
  ]);
  return (
    <PlanGate requiredPlan="growth">
    <div className="space-y-5">
      {/* ── Header ──────────────────────────────────────────────────────── */}
      <div className="flex items-center justify-between gap-4">
        <div>
          <div className="flex flex-wrap items-center gap-2">
            <h1 className="text-2xl font-bold tracking-tight">Meta Ads</h1>
            {metaConnected && historicalProgressStatus ? (
              <ProviderReadinessIndicator
                readinessLevel={historicalProgressStatus.readinessLevel}
                domainReadiness={historicalProgressStatus.domainReadiness}
              />
            ) : null}
          </div>
          <p className="mt-0.5 text-sm text-muted-foreground">
            Daily operator surface for what needs action now, what is profitable but capped,
            what should stay untouched, and what still needs truth before a stronger move.
          </p>
          {metaConnected && metaAccountDayLabel ? (
            <p className="mt-1 text-xs text-muted-foreground">{metaAccountDayLabel}</p>
          ) : null}
        </div>
        <div className="flex items-center gap-2">
          {metaConnected && isStatusLoading && (
            <SyncStatusPillSkeleton className="w-28" />
          )}
          {metaConnected && !isStatusLoading && shouldShowHistoricalProgress && (
            <SyncStatusPill pill={metaSyncPill} />
          )}
          {metaConnected && (
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => void handleAnalyze()}
              disabled={isAnalysisRunning || !isMetaReferenceReady || !startDate || !endDate}
            >
              <Sparkles
                className={`mr-2 h-4 w-4 ${isAnalysisRunning ? "animate-spin" : ""}`}
              />
              {isAnalysisRunning ? "Running analysis" : "Run analysis"}
            </Button>
          )}
          {metaConnected && (
            <Button
              variant="outline"
              className="shrink-0"
              onClick={() => void handleRefreshData()}
              disabled={isManualRefreshRunning || isSyncInProgress || !isMetaReferenceReady || !startDate || !endDate}
            >
              <RefreshCw
                className={`mr-2 h-4 w-4 ${(isManualRefreshRunning || isSyncInProgress) ? "animate-spin" : ""}`}
              />
              {isManualRefreshRunning || isSyncInProgress
                ? "Sync in progress"
                : "Refresh data"}
            </Button>
          )}
          <div className="shrink-0 rounded-xl border bg-card p-1 shadow-sm">
            {metaConnected && !isMetaReferenceReady ? (
              <div className="h-10 w-[224px] animate-pulse rounded-lg bg-muted/50" />
            ) : (
              <DateRangePicker
                value={dateRange}
                onChange={(next) =>
                  setDateRange(
                    clampDateRangeForHistoryLimit(next, effectiveMetaReferenceDate ?? undefined, allowedHistoryDays)
                  )
                }
                rangePresets={["today", "yesterday", "3d", "7d", "14d", "30d", "90d", "custom"]}
                comparisonPresets={
                  previousYearAllowed
                    ? undefined
                    : ["none", "custom", "previousPeriod", "previousWeek", "previousMonth", "previousQuarter"]
                }
                referenceDate={effectiveMetaReferenceDate ?? undefined}
                timeZoneLabel={effectiveMetaTimeZoneLabel ?? undefined}
              />
            )}
          </div>
        </div>
      </div>

      {/* ── Integration gate ─────────────────────────────────────────────── */}
      {!metaConnected && showBootstrapGuard && (
        <LoadingSkeleton
          rows={4}
          title="Preparing Meta connection"
          description="We are checking the connection, available ad accounts, and assignment state."
        />
      )}

      {!showBootstrapGuard && !metaConnected && (
        <IntegrationEmptyState
          providerLabel="Meta"
          status={
            metaView.status === "action_required" ? "error" : "disconnected"
          }
          title="Finish connecting Meta"
          description="Connect your Meta account to unlock campaigns, ad sets, and creative insights."
        />
      )}

      {metaConnected && (
        <>
          {/* ── KPI Row ──────────────────────────────────────────────────── */}
          <div className="grid grid-cols-2 gap-3 lg:grid-cols-4">
            <KpiCard
              label="Total Spend"
              value={
                !canRenderKpis
                  ? "—"
                  : fmtK(kpis.totalSpend, sym)
              }
              subLabel={campaignCountLabel}
              icon={DollarSign}
              accentClass="border-l-4 border-l-blue-500/60"
              comparisonLabel={comparisonLabel}
              changePct={comparisonWindow ? computeChangePct(kpis.totalSpend, previousKpis.totalSpend) : null}
            />
            <KpiCard
              label="Total Revenue"
              value={
                !canRenderKpis
                  ? "—"
                  : fmtK(kpis.totalRevenue, sym)
              }
              subLabel={
                shouldMaskKpisAsPreparing
                  ? pageMessages.kpi.revenueSubLabel
                  : "Attributed purchases"
              }
              icon={TrendingUp}
              accentClass="border-l-4 border-l-emerald-500/60"
              valueClass="text-emerald-600"
              comparisonLabel={comparisonLabel}
              changePct={comparisonWindow ? computeChangePct(kpis.totalRevenue, previousKpis.totalRevenue) : null}
            />
            <KpiCard
              label="Avg. CPA"
              value={
                !canRenderKpis
                  ? "—"
                  : fmt$(kpis.avgCpa, sym)
              }
              subLabel={
                shouldMaskKpisAsPreparing
                  ? pageMessages.kpi.avgCpaSubLabel
                  : "Cost per conversion"
              }
              icon={Target}
              accentClass="border-l-4 border-l-violet-500/60"
              comparisonLabel={comparisonLabel}
              changePct={comparisonWindow ? computeChangePct(kpis.avgCpa, previousKpis.avgCpa) : null}
              positiveIsGood={false}
            />
            <KpiCard
              label="Blended ROAS"
              value={
                !canRenderKpis
                  ? "—"
                  : `${kpis.blendedRoas.toFixed(2)}×`
              }
              subLabel={
                shouldMaskKpisAsPreparing
                  ? pageMessages.kpi.roasSubLabel
                  : "All campaigns combined"
              }
              icon={BarChart2}
              accentClass={
                kpis.blendedRoas > 2.5
                  ? "border-l-4 border-l-emerald-500/60"
                  : kpis.blendedRoas >= 1.5
                    ? "border-l-4 border-l-amber-500/60"
                    : "border-l-4 border-l-red-500/60"
              }
              valueClass={
                kpis.blendedRoas > 2.5
                  ? "text-emerald-600"
                  : kpis.blendedRoas >= 1.5
                    ? "text-amber-500"
                    : "text-red-500"
              }
              changePct={comparisonWindow ? computeChangePct(kpis.blendedRoas, previousKpis.blendedRoas) : null}
              comparisonLabel={comparisonLabel}
            />
          </div>

          <MetaStatusBanner status={effectiveStatus} language={language} />

          {/* ── Master-detail layout ─────────────────────────────────────── */}
          {(isCoreRangePending || campaignsQuery.isLoading) && (
            <LoadingSkeleton
              rows={6}
              title={campaignSurfaceLoadingTitle}
              description={campaignSurfaceLoadingDescription}
            />
          )}

          {!isCoreRangePending && campaignsQuery.isError && (
            <SectionError
              message={
                campaignsQuery.error instanceof Error
                  ? campaignsQuery.error.message
                  : "Could not load campaign data."
              }
              language={language}
              onRetry={() => campaignsQuery.refetch()}
            />
          )}

          {!isCoreRangePending && !campaignsQuery.isLoading && !campaignsQuery.isError && (() => {
            const status = campaignsQuery.data?.status;
            if (status === "no_accounts_assigned") return <NoAccountsAssigned />;

            const rows = campaignsQuery.data?.rows ?? [];
            if (rows.length === 0)
              return (
                <DataEmptyState
                  title={
                    pageReadiness && pageReadiness.state !== "ready"
                      ? pageMessages.emptyState.title
                      : getMetaPageStatusMessaging(effectiveStatus, language, { readyButEmpty: true }).emptyState.title
                  }
                  description={
                    pageReadiness && pageReadiness.state !== "ready"
                      ? (isCurrentDayPreparing
                          ? pageMessages.currentDayPreparing.description
                          : pageMessages.emptyState.description)
                      : getMetaPageStatusMessaging(effectiveStatus, language, { readyButEmpty: true }).emptyState.description
                  }
                />
              );

            const selectedCampaign =
              campaignRowsForTable.find((c) => c.id === selectedCampaignId) ?? null;

            return (
              <div className="flex gap-4" style={{ minHeight: "520px" }}>
                <div className="flex w-72 shrink-0 flex-col gap-3 xl:w-80">
                  <div className="overflow-hidden rounded-2xl border border-slate-200 bg-white shadow-sm">
                    <div className="border-b border-slate-100 px-3 py-2.5">
                      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
                        Campaign Drilldown
                        <span className="ml-1.5 text-slate-300">{campaignRowsForTable.length}</span>
                      </p>
                    </div>
                    <div className="max-h-[620px] overflow-y-auto p-1.5">
                      <MetaCampaignList
                        campaigns={campaignRowsForTable}
                        selectedId={selectedCampaignId}
                        onSelect={setSelectedCampaignId}
                      />
                    </div>
                  </div>
                </div>

                <div className="min-h-0 flex-1 overflow-y-auto rounded-2xl border border-slate-200 bg-slate-50/60 shadow-sm">
                  <div className="border-b border-slate-200 bg-white p-4">
                    <MetaAnalysisStatusCard status={analysisStatus} />
                  </div>
                  <MetaCampaignDetail
                    campaign={selectedCampaign}
                    recommendationsData={recommendationsQuery.data}
                    analysisStatus={analysisStatus}
                    isRecsLoading={recommendationsQuery.isFetching}
                    lastAnalyzedAt={lastAnalyzedAt}
                    recommendationsError={recommendationsError}
                    checkedRecIds={checkedRecIds}
                    onToggleCheck={handleToggleCheck}
                    onAnalyze={handleAnalyze}
                    onClearSelection={() => setSelectedCampaignId(null)}
                    businessId={businessId}
                    since={startDate!}
                    until={endDate!}
                    language={language}
                  />
                </div>
              </div>
            );
          })()}
        </>
      )}
    </div>
    </PlanGate>
  );
}
