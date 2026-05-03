"use client";

import { useCallback, useDeferredValue, useEffect, useMemo, useRef, useState } from "react";
import { useMutation, useQueries, useQuery, useQueryClient } from "@tanstack/react-query";
import dynamic from "next/dynamic";
import { useRouter, useSearchParams } from "next/navigation";
import { Sparkles } from "lucide-react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { useAppStore } from "@/store/app-store";
import { useIntegrationsStore } from "@/store/integrations-store";
import { usePreferencesStore } from "@/store/preferences-store";
import { buildDefaultProviderDomains, deriveProviderViewState } from "@/store/integrations-support";
import { isDemoBusinessSelected } from "@/lib/business-mode";
import { EmptyState } from "@/components/states/empty-state";
import { IntegrationEmptyState } from "@/components/states/IntegrationEmptyState";
import { LockedFeatureCard } from "@/components/states/LockedFeatureCard";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { Button } from "@/components/ui/button";
import {
  type MetaCreativeRow,
} from "@/components/creatives/metricConfig";
import { CreativesTableSection } from "@/components/creatives/CreativesTableSection";
import { CreativeDecisionCenterSurface } from "@/components/creatives/CreativeDecisionCenterSurface";
import { CreativeBenchmarkScopeControl } from "@/components/creatives/CreativeBenchmarkScopeControl";
import { CreativeDecisionOsV2PreviewSurface } from "@/components/creatives/CreativeDecisionOsV2PreviewSurface";
import {
  applyCreativeFilters,
  formatCreativeDateLabel,
  mapCreativeGroupByToApi,
  CreativeDateRangeValue,
  CreativeFilterRule,
  CreativeGroupBy,
  CreativesTopSection,
  resolveCreativeDateRange,
} from "@/components/creatives/CreativesTopSection";
import {
  filterRowsForCreativeBenchmarkScope,
  resolveCreativeBenchmarkCampaignContext,
  resolveCreativeBenchmarkScopeSelection,
  type CreativeBenchmarkScopeMode,
} from "@/components/creatives/creatives-top-section-support";
import { usePersistentCreativeDateRange } from "@/hooks/use-persistent-date-range";
import type { ShareMetricKey, SharePayload } from "@/components/creatives/shareCreativeTypes";
import {
  getCreativeDecisionOsSnapshot,
  getCreativeDecisionOsV2Preview,
  runCreativeDecisionOsAnalysis,
} from "@/src/services";
import {
  CreativesTableShell,
  buildCreativeHistoryById,
  fetchMetaCreatives,
  fetchMetaCreativesHistory,
  getPreviewPollingInterval,
  hasRenderablePreview,
  mapApiRowToUiRow,
  PLATFORM_LABELS,
  PreviewStripState,
  SHARE_METRIC_IDS,
  buildSharedCreativeAnalysisLookup,
  getSharedCreativeAnalysisForRow,
  shouldPollForPreviewReadiness,
  toCsv,
  toSharedCreative,
  type CreativeHistoryWindowKey,
} from "@/app/(dashboard)/creatives/page-support";
import { useBusinessIntegrationsBootstrap } from "@/hooks/use-business-integrations-bootstrap";
import { PlanGate } from "@/components/pricing/PlanGate";
import { usePlanState } from "@/lib/pricing/usePlan";
import { PRICING_PLANS } from "@/lib/pricing/plans";
import {
  META_CREATIVE_WAREHOUSE_HISTORY_DAYS,
  addDaysToIsoDate,
  dayCountInclusive,
} from "@/lib/meta/history";
import { getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import {
  buildCreativeQuickFilters,
  creativeQuickFilterShortLabel,
  type CreativeQuickFilterKey,
} from "@/lib/creative-operator-surface";

function clampCreativeDateRangeToHistoryLimit(
  value: CreativeDateRangeValue,
  maxHistoryDays: number | null
): CreativeDateRangeValue {
  if (maxHistoryDays === null) return value;
  const resolved = resolveCreativeDateRange(value);
  const totalDays = dayCountInclusive(resolved.start, resolved.end);
  if (totalDays <= maxHistoryDays) return value;
  return {
    ...value,
    preset: "custom",
    customStart: addDaysToIsoDate(resolved.end, -(maxHistoryDays - 1)),
    customEnd: resolved.end,
    lastDays: Math.min(value.lastDays, maxHistoryDays),
  };
}

function scheduleIdlePhase(work: () => void, timeout = 900) {
  if (typeof window === "undefined") {
    return () => undefined;
  }

  const idleWindow = window as typeof window & {
    requestIdleCallback?: (
      callback: IdleRequestCallback,
      options?: IdleRequestOptions
    ) => number;
    cancelIdleCallback?: (handle: number) => void;
  };

  if (typeof idleWindow.requestIdleCallback === "function") {
    const idleHandle = idleWindow.requestIdleCallback(() => work(), { timeout });
    return () => idleWindow.cancelIdleCallback?.(idleHandle);
  }

  const timeoutHandle = window.setTimeout(work, Math.min(timeout, 350));
  return () => window.clearTimeout(timeoutHandle);
}

const CreativeDetailExperience = dynamic(
  () => import("@/components/creatives/CreativeDetailExperience").then((mod) => mod.CreativeDetailExperience),
  { ssr: false, loading: () => null }
);
const CreativeAdBreakdownDrawer = dynamic(
  () => import("@/components/creatives/CreativeAdBreakdownDrawer").then((mod) => mod.CreativeAdBreakdownDrawer),
  { ssr: false, loading: () => null }
);
const CreativeDecisionOsDrawer = dynamic(
  () => import("@/components/creatives/CreativeDecisionOsDrawer").then((mod) => mod.CreativeDecisionOsDrawer),
  { ssr: false, loading: () => null }
);

function formatSnapshotTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

export default function CreativesPage() {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const { plan: currentPlan } = usePlanState();
  const businessId = selectedBusinessId ?? "";
  const selectedBusinessCurrency =
    businesses.find((business) => business.id === selectedBusinessId)?.currency ?? null;
  const language = usePreferencesStore((state) => state.language);

  const domains = useIntegrationsStore((state) =>
    selectedBusinessId ? state.domainsByBusinessId[selectedBusinessId] : undefined
  );
  const assignedAccountsByBusiness = useIntegrationsStore(
    (state) => state.assignedAccountsByBusiness
  );
  const { isBootstrapping, bootstrapStatus } = useBusinessIntegrationsBootstrap(
    selectedBusinessId ?? null
  );

  const [dateRangeValue, setDateRangeValue] = usePersistentCreativeDateRange();
  const allowedHistoryDays = PRICING_PLANS[currentPlan].limits.analyticsHistoryDays;
  const [groupBy, setGroupBy] = useState<CreativeGroupBy>("creative");
  const [topFilters, setTopFilters] = useState<CreativeFilterRule[]>([]);
  const [topMetricIds, setTopMetricIds] = useState<string[]>(["spend", "roas"]);
  const [selectionState, setSelectionState] = useState<{ selectedRowIds: string[] }>({
    selectedRowIds: [],
  });
  const hasUserInteractedSelectionRef = useRef(false);
  const [creativeDrawerState, setCreativeDrawerState] = useState<{ open: boolean; activeRowId: string | null }>({
    open: false,
    activeRowId: null,
  });
  const [breakdownDrawerState, setBreakdownDrawerState] = useState<{ open: boolean; activeRowId: string | null }>({
    open: false,
    activeRowId: null,
  });
  const [highlightedRowId, setHighlightedRowId] = useState<string | null>(null);
  const [notesByRowId, setNotesByRowId] = useState<Record<string, string>>({});
  const [shareExportLoading, setShareExportLoading] = useState(false);
  const [csvExportLoading, setCsvExportLoading] = useState(false);
  const [shareUrl, setShareUrl] = useState<string | null>(null);
  const [shareError, setShareError] = useState<string | null>(null);
  const [csvError, setCsvError] = useState<string | null>(null);
  const [historyPhaseStarted, setHistoryPhaseStarted] = useState(false);
  const [tableSortedRows, setTableSortedRows] = useState<MetaCreativeRow[]>([]);
  const [decisionOsFamilyFilter, setDecisionOsFamilyFilter] = useState<string | null>(null);
  const [activeQuickFilterKey, setActiveQuickFilterKey] = useState<CreativeQuickFilterKey | null>(null);
  const [decisionOsDrawerOpen, setDecisionOsDrawerOpen] = useState(false);
  const [benchmarkScopeMode, setBenchmarkScopeMode] =
    useState<CreativeBenchmarkScopeMode>("account");

  const platform: "meta" = "meta";
  const metaView = deriveProviderViewState(
    "meta",
    domains?.meta ?? buildDefaultProviderDomains().meta
  );
  const isDemoBusiness = isDemoBusinessSelected(selectedBusinessId, businesses);
  const platformConnected = metaView.isConnected || isDemoBusiness;
  const showBootstrapGuard =
    !isDemoBusiness &&
    (isBootstrapping ||
      metaView.status === "loading_data" ||
      (bootstrapStatus !== "ready" && !metaView.isConnected));
  const assignedMetaAccounts = assignedAccountsByBusiness[businessId]?.meta ?? [];
  const metaHasAssignments = isDemoBusiness || assignedMetaAccounts.length > 0;
  const canLoadCreatives =
    platform === "meta" && platformConnected && metaHasAssignments;

  const { start: drStart, end: drEnd } = resolveCreativeDateRange(dateRangeValue);
  const setBoundedDateRangeValue = useCallback(
    (next: CreativeDateRangeValue) => {
      setDateRangeValue(clampCreativeDateRangeToHistoryLimit(next, allowedHistoryDays));
    },
    [allowedHistoryDays, setDateRangeValue]
  );
  const mainTableApiGroupBy = mapCreativeGroupByToApi(groupBy);
  const endDate = new Date(`${drEnd}T00:00:00.000Z`);
  const offsetIso = useCallback(
    (days: number) => {
      const date = new Date(endDate);
      date.setUTCDate(date.getUTCDate() - days);
      return date.toISOString().slice(0, 10);
    },
    [endDate]
  );

  useEffect(() => {
    const normalized = clampCreativeDateRangeToHistoryLimit(dateRangeValue, allowedHistoryDays);
    if (JSON.stringify(normalized) !== JSON.stringify(dateRangeValue)) {
      setDateRangeValue(normalized);
    }
  }, [allowedHistoryDays, dateRangeValue, setDateRangeValue]);

  useEffect(() => {
    setHistoryPhaseStarted(false);
  }, [businessId, drStart, drEnd, groupBy]);

  const creativesMetadataQuery = useQuery({
    queryKey: [
      "meta-creatives-creatives-metadata",
      businessId,
      drStart,
      drEnd,
      groupBy,
    ],
    enabled: canLoadCreatives,
    queryFn: () =>
      fetchMetaCreatives({
        businessId,
        start: drStart,
        end: drEnd,
        groupBy: mainTableApiGroupBy,
        format: "all",
        sort: "spend",
        mediaMode: "metadata",
      }),
    staleTime: 30 * 1000,
    refetchOnWindowFocus: false,
    refetchInterval: (query) => getPreviewPollingInterval(query.state.data),
    placeholderData: (previousData) => previousData,
  });
  const shouldLoadHistory =
    historyPhaseStarted || creativeDrawerState.open || breakdownDrawerState.open;
  useEffect(() => {
    if (!canLoadCreatives || shouldLoadHistory) return;
    if (creativesMetadataQuery.isLoading || creativesMetadataQuery.isFetching) return;
    if ((creativesMetadataQuery.data?.rows?.length ?? 0) === 0) return;
    return scheduleIdlePhase(() => setHistoryPhaseStarted(true), 1_500);
  }, [
    canLoadCreatives,
    creativesMetadataQuery.data?.rows?.length,
    creativesMetadataQuery.isFetching,
    creativesMetadataQuery.isLoading,
    shouldLoadHistory,
  ]);
  const creativeHistoryWindowDefs = useMemo<Array<{ key: CreativeHistoryWindowKey; start: string; end: string }>>(
    () => [
      { key: "last3", start: offsetIso(2), end: drEnd },
      { key: "last7", start: offsetIso(6), end: drEnd },
      { key: "last14", start: offsetIso(13), end: drEnd },
      { key: "last30", start: offsetIso(29), end: drEnd },
      { key: "last90", start: offsetIso(89), end: drEnd },
      { key: "allHistory", start: offsetIso(META_CREATIVE_WAREHOUSE_HISTORY_DAYS - 1), end: drEnd },
    ],
    [drEnd, offsetIso]
  );
  const creativeHistoryQueries = useQueries({
    queries: creativeHistoryWindowDefs.map((windowDef) => ({
      queryKey: [
        "meta-creatives-history",
        businessId,
        drEnd,
        groupBy,
        windowDef.key,
        windowDef.start,
        windowDef.end,
      ],
      enabled: canLoadCreatives && shouldLoadHistory,
      queryFn: () =>
        fetchMetaCreativesHistory({
          businessId,
          start: windowDef.start,
          end: windowDef.end,
          groupBy: mainTableApiGroupBy,
          format: "all",
          sort: "spend",
          mediaMode: "metadata",
        }),
      staleTime: 1000 * 60 * 5,
      refetchOnWindowFocus: false,
    })),
  });
  const adBreakdownQuery = useQuery({
    queryKey: ["meta-creatives-ad-breakdown", businessId, drStart, drEnd],
    enabled:
      canLoadCreatives &&
      breakdownDrawerState.open &&
      Boolean(breakdownDrawerState.activeRowId),
    queryFn: () =>
      fetchMetaCreativesHistory({
        businessId,
        start: drStart,
        end: drEnd,
        groupBy: "adName",
        format: "all",
        sort: "spend",
      }),
  });
  const activeCreativesPayload = creativesMetadataQuery.data;

  const allRows = useMemo(() => {
    const payloadRows = activeCreativesPayload?.rows ?? [];
    const rows = payloadRows.map(mapApiRowToUiRow);
    if (rows.length > 0 && process.env.NODE_ENV !== "production") {
      const withPreview = rows.filter((r) => r.previewUrl).length;
      console.log("[creatives-page] UI row preview summary", {
        total: rows.length,
        with_previewUrl: withPreview,
        with_thumbnailUrl: rows.filter((r) => r.thumbnailUrl).length,
        with_imageUrl: rows.filter((r) => r.imageUrl).length,
        state_counts: {
          preview: rows.filter((r) => r.previewState === "preview").length,
          unavailable: rows.filter((r) => r.previewState === "unavailable").length,
        },
        samples: rows.slice(0, 3).map((r) => ({
          id: r.id,
          name: r.name.slice(0, 40),
          previewState: r.previewState,
          previewUrl: r.previewUrl ? r.previewUrl.slice(0, 80) : null,
          thumbnailUrl: r.thumbnailUrl ? r.thumbnailUrl.slice(0, 80) : null,
          imageUrl: r.imageUrl ? r.imageUrl.slice(0, 80) : null,
          isCatalog: r.isCatalog,
        })),
      });
      
      // DIAGNOSTIC: Log raw API data vs mapped rows
      const rawRows = payloadRows;
      console.log("[DIAGNOSTIC] API -> UI mapping check", {
        first_3_raw: rawRows.slice(0, 3).map((r) => ({
          id: r.id,
          name: r.name.slice(0, 30),
          thumbnail_url: r.thumbnail_url ?? "NULL",
          image_url: r.image_url ?? "NULL",
          preview_url: r.preview_url ?? "NULL",
          preview_state: r.preview_state,
          preview_render_mode: r.preview?.render_mode,
          preview_object_FULL: r.preview,
        })),
        first_3_mapped: rows.slice(0, 3).map((r) => ({
          id: r.id,
          name: r.name.slice(0, 30),
          thumbnailUrl: r.thumbnailUrl ?? "NULL",
          imageUrl: r.imageUrl ?? "NULL",
          previewUrl: r.previewUrl ?? "NULL",
          previewState: r.previewState,
          preview_image_url: r.preview?.image_url ?? "NULL",
          preview_poster_url: r.preview?.poster_url ?? "NULL",
          preview_object_FULL: r.preview,
        })),
      });
      
      // DIAGNOSTIC: Full backend response status
      console.log("[DIAGNOSTIC] Backend response metadata", {
        status: activeCreativesPayload?.status,
        total_rows: rawRows.length,
        has_preview_field: rawRows.length > 0 ? typeof rawRows[0]?.preview : "N/A",
        media_mode: activeCreativesPayload?.media_mode ?? null,
      });
    }
    return rows;
  }, [activeCreativesPayload?.media_mode, activeCreativesPayload?.rows]);
  const filterScopedRows = useMemo(
    () => applyCreativeFilters(allRows, topFilters),
    [allRows, topFilters],
  );
  const campaignBenchmarkContext = useMemo(
    () => resolveCreativeBenchmarkCampaignContext(filterScopedRows),
    [filterScopedRows],
  );
  const activeBenchmarkScope = useMemo(
    () =>
      resolveCreativeBenchmarkScopeSelection({
        mode: benchmarkScopeMode,
        campaignContext: campaignBenchmarkContext,
      }),
    [benchmarkScopeMode, campaignBenchmarkContext],
  );
  const benchmarkRows = useMemo(
    () => filterRowsForCreativeBenchmarkScope(allRows, activeBenchmarkScope),
    [activeBenchmarkScope, allRows],
  );
  useEffect(() => {
    if (benchmarkScopeMode === "campaign" && !campaignBenchmarkContext) {
      setBenchmarkScopeMode("account");
    }
  }, [benchmarkScopeMode, campaignBenchmarkContext]);
  const creativeDecisionOsSnapshotQueryKey = useMemo(
    () => [
      "creative-decision-os-snapshot",
      businessId,
      activeBenchmarkScope.scope,
      activeBenchmarkScope.scopeId ?? null,
    ],
    [activeBenchmarkScope.scope, activeBenchmarkScope.scopeId, businessId],
  );
  const creativeDecisionOsSnapshotQuery = useQuery({
    queryKey: [
      ...creativeDecisionOsSnapshotQueryKey,
    ],
    enabled: canLoadCreatives,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      getCreativeDecisionOsSnapshot(businessId, {
        benchmarkScope: activeBenchmarkScope,
      }),
  });
  const creativeDecisionOsV2PreviewDisabled =
    searchParams.get("creativeDecisionOsV2Preview") === "0" ||
    searchParams.get("creativeDecisionOsV2Preview")?.toLowerCase() === "false" ||
    searchParams.get("v2Preview") === "0" ||
    searchParams.get("v2Preview")?.toLowerCase() === "false";
  const creativeDecisionOsV2PreviewEnabled = !creativeDecisionOsV2PreviewDisabled;
  const creativeDecisionOsV2PreviewQuery = useQuery({
    queryKey: [
      "creative-decision-os-v2-preview",
      businessId,
      activeBenchmarkScope.scope,
      activeBenchmarkScope.scopeId ?? null,
      creativeDecisionOsV2PreviewEnabled,
    ],
    enabled: canLoadCreatives && creativeDecisionOsV2PreviewEnabled,
    staleTime: 60 * 1000,
    refetchOnWindowFocus: false,
    queryFn: () =>
      getCreativeDecisionOsV2Preview(businessId, {
        benchmarkScope: activeBenchmarkScope,
        enabled: creativeDecisionOsV2PreviewEnabled,
      }),
  });
  const creativeDecisionOsRunMutation = useMutation({
    mutationFn: () =>
      runCreativeDecisionOsAnalysis(businessId, drStart, drEnd, {
        benchmarkScope: activeBenchmarkScope,
      }),
    onSuccess: (payload) => {
      queryClient.setQueryData(creativeDecisionOsSnapshotQueryKey, payload);
    },
  });
  const creativeDecisionSnapshotResponse = creativeDecisionOsSnapshotQuery.data ?? null;
  const creativeDecisionSnapshot = creativeDecisionSnapshotResponse?.snapshot ?? null;
  const creativeDecisionOs = creativeDecisionSnapshotResponse?.decisionOs ?? null;
  const creativeDecisionCenter = creativeDecisionSnapshotResponse?.decisionCenter ?? null;
  const creativeDecisionOsV2Preview =
    creativeDecisionOsV2PreviewQuery.data?.decisionOsV2Preview ?? null;
  const decisionSnapshotGeneratedAt = formatSnapshotTimestamp(
    creativeDecisionSnapshot?.generatedAt,
  );
  const decisionSnapshotReportingRangeDiffers =
    Boolean(creativeDecisionSnapshot) &&
    (creativeDecisionSnapshot?.sourceWindow.reportingStartDate !== drStart ||
      creativeDecisionSnapshot?.sourceWindow.reportingEndDate !== drEnd);
  const decisionSnapshotStatusLabel = creativeDecisionOsRunMutation.isPending
    ? "Decision OS: Running"
    : creativeDecisionOs
      ? `Last analyzed: ${decisionSnapshotGeneratedAt ?? "available"}`
      : creativeDecisionOsSnapshotQuery.isLoading
        ? "Decision OS snapshot loading"
        : "Decision OS has not been run for this scope.";
  const decisionSnapshotSafeError =
    creativeDecisionOsRunMutation.error instanceof Error
      ? creativeDecisionOsRunMutation.error.message
      : creativeDecisionOsSnapshotQuery.error instanceof Error
        ? creativeDecisionOsSnapshotQuery.error.message
        : creativeDecisionSnapshotResponse?.error?.message ?? null;
  const handleRunCreativeAnalysis = useCallback(() => {
    if (!canLoadCreatives || creativeDecisionOsRunMutation.isPending) return;
    creativeDecisionOsRunMutation.mutate();
  }, [canLoadCreatives, creativeDecisionOsRunMutation]);

  const familyFocusIds = useMemo(() => {
    if (!creativeDecisionOs || !decisionOsFamilyFilter) return null;
    const family = creativeDecisionOs.families.find((item) => item.familyId === decisionOsFamilyFilter);
    return family ? new Set(family.creativeIds) : null;
  }, [creativeDecisionOs, decisionOsFamilyFilter]);
  const clearCreativeFocusFilters = useCallback(() => {
    hasUserInteractedSelectionRef.current = true;
    setDecisionOsFamilyFilter(null);
    setActiveQuickFilterKey(null);
    setSelectionState({ selectedRowIds: [] });
  }, []);
  const activeDecisionOsFamily = useMemo(
    () =>
      decisionOsFamilyFilter
        ? creativeDecisionOs?.families.find((item) => item.familyId === decisionOsFamilyFilter) ?? null
        : null,
    [creativeDecisionOs, decisionOsFamilyFilter],
  );
  const baseFilteredRows = useMemo(() => {
    if (platform !== "meta") return [];
    const baseRows = applyCreativeFilters(allRows, topFilters, creativeDecisionOs);
    if (!familyFocusIds || familyFocusIds.size === 0) return baseRows;
    return baseRows.filter((row) => familyFocusIds.has(row.id));
  }, [allRows, creativeDecisionOs, familyFocusIds, platform, topFilters]);
  const quickFilters = useMemo(
    () =>
      buildCreativeQuickFilters(creativeDecisionOs, {
        visibleIds: new Set(baseFilteredRows.map((row) => row.id)),
        includeZeroCounts: true,
      }),
    [baseFilteredRows, creativeDecisionOs],
  );
  const activeQuickFilter = useMemo(
    () =>
      activeQuickFilterKey
        ? quickFilters.find((filter) => filter.key === activeQuickFilterKey) ?? null
        : null,
    [activeQuickFilterKey, quickFilters],
  );
  const handlePerformanceQuickFilter = useCallback(
    (key: CreativeQuickFilterKey) => {
      hasUserInteractedSelectionRef.current = true;

      if (activeQuickFilterKey === key) {
        setActiveQuickFilterKey(null);
        setSelectionState({ selectedRowIds: [] });
        return;
      }

      const nextFilter = quickFilters.find((filter) => filter.key === key) ?? null;
      const nextFilterIds = new Set(nextFilter?.creativeIds ?? []);
      const nextSelectedRowIds = baseFilteredRows
        .filter((row) => nextFilterIds.has(row.id))
        .map((row) => row.id);

      setActiveQuickFilterKey(key);
      setSelectionState({ selectedRowIds: nextSelectedRowIds });
    },
    [activeQuickFilterKey, baseFilteredRows, quickFilters],
  );
  const filteredRows = useMemo(() => {
    if (!activeQuickFilter || activeQuickFilter.creativeIds.length === 0) return baseFilteredRows;
    const quickFilterIds = new Set(activeQuickFilter.creativeIds);
    return baseFilteredRows.filter((row) => quickFilterIds.has(row.id));
  }, [activeQuickFilter, baseFilteredRows]);
  useEffect(() => {
    if (!activeQuickFilterKey) return;
    const stillAvailable = quickFilters.some(
      (filter) => filter.key === activeQuickFilterKey && filter.count > 0,
    );
    if (!stillAvailable) {
      hasUserInteractedSelectionRef.current = true;
      setActiveQuickFilterKey(null);
      setSelectionState({ selectedRowIds: [] });
    }
  }, [activeQuickFilterKey, quickFilters]);
  const creativeHistoryById = useMemo(() => {
    const historyRows: Partial<Record<CreativeHistoryWindowKey, MetaCreativeRow[]>> = {};
    creativeHistoryQueries.forEach((query, index) => {
      const key = creativeHistoryWindowDefs[index]?.key;
      if (!key) return;
      historyRows[key] = (query.data?.rows ?? []).map(mapApiRowToUiRow);
    });
    return buildCreativeHistoryById(historyRows);
  }, [creativeHistoryQueries, creativeHistoryWindowDefs]);
  const deferredFilteredRows = useDeferredValue(filteredRows);

  const orderedTableRows = useMemo(() => {
    if (tableSortedRows.length === 0) return deferredFilteredRows;

    const filteredIds = new Set(deferredFilteredRows.map((row) => row.id));
    const sortedVisibleRows = tableSortedRows.filter((row) => filteredIds.has(row.id));

    return sortedVisibleRows.length === deferredFilteredRows.length
      ? sortedVisibleRows
      : deferredFilteredRows;
  }, [deferredFilteredRows, tableSortedRows]);

  useEffect(() => {
    setSelectionState((prev) => {
      const filteredIds = new Set(filteredRows.map((row) => row.id));
      const kept = prev.selectedRowIds.filter((id) => filteredIds.has(id));

      if (
        !hasUserInteractedSelectionRef.current &&
        kept.length === 0 &&
        filteredRows.length > 0
      ) {
        return { selectedRowIds: filteredRows.slice(0, 5).map((row) => row.id) };
      }

      if (kept.length !== prev.selectedRowIds.length) {
        return { selectedRowIds: kept };
      }

      return prev;
    });
  }, [filteredRows]);

  const selectedRows = useMemo(() => {
    const selectedRowIdSet = new Set(selectionState.selectedRowIds);
    return orderedTableRows.filter((row) => selectedRowIdSet.has(row.id));
  }, [orderedTableRows, selectionState.selectedRowIds]);
  const topPanelRows = useMemo(
    () => (selectedRows.length > 0 ? selectedRows : orderedTableRows),
    [orderedTableRows, selectedRows]
  );
  const topPreviewRows = useMemo(() => topPanelRows.slice(0, 20), [topPanelRows]);
  const previewStripSummary = useMemo(() => {
    const states = topPreviewRows.map((row) =>
      hasRenderablePreview(row) ? "ready" : getCreativeStaticPreviewState(row, "grid")
    );

    const ready = states.filter((state) => state === "ready").length;
    const pending = states.filter((state) => state === "pending").length;
    const missing = states.filter((state) => state === "missing").length;

    return {
      total: topPreviewRows.length,
      ready,
      pending,
      missing,
      minimumReady: Math.min(3, topPreviewRows.length),
    };
  }, [topPreviewRows]);
  const previewStripState = useMemo<PreviewStripState>(() => {
    const metadataRows = activeCreativesPayload?.rows ?? [];
    const hasMetadataRows = metadataRows.length > 0;

    if (!hasMetadataRows) {
      if (creativesMetadataQuery.isLoading || creativesMetadataQuery.isFetching) {
        return "data_loading";
      }
      return "missing";
    }

    if (topPreviewRows.length === 0) return "missing";
    if (previewStripSummary.ready > 0) return "ready";
    if (shouldPollForPreviewReadiness(activeCreativesPayload)) return "data_loading";
    if (previewStripSummary.pending > 0) return "data_loading";
    return "missing";
  }, [
    activeCreativesPayload,
    creativesMetadataQuery.isFetching,
    creativesMetadataQuery.isLoading,
    previewStripSummary.pending,
    previewStripSummary.ready,
    topPreviewRows.length,
  ]);

  useEffect(() => {
    if (process.env.NODE_ENV === "production") return;
    if (topPanelRows.length === 0 && filteredRows.length === 0) return;

    console.log("[creatives-page] before CreativesTopSection", {
      total: topPanelRows.length,
      samples: topPanelRows.slice(0, 3).map((row) => ({
        id: row.id,
        name: row.name,
        previewUrl: row.previewUrl ?? null,
        thumbnailUrl: row.thumbnailUrl ?? null,
        imageUrl: row.imageUrl ?? null,
        previewState: row.previewState,
        isCatalog: row.isCatalog,
      })),
    });

    console.log("[creatives-page] before CreativesTableSection", {
      total: filteredRows.length,
      samples: filteredRows.slice(0, 3).map((row) => ({
        id: row.id,
        name: row.name,
        previewUrl: row.previewUrl ?? null,
        thumbnailUrl: row.thumbnailUrl ?? null,
        imageUrl: row.imageUrl ?? null,
        previewState: row.previewState,
        isCatalog: row.isCatalog,
      })),
    });
  }, [filteredRows, topPanelRows]);

  const activeCreativeRow = useMemo(
    () => allRows.find((row) => row.id === creativeDrawerState.activeRowId) ?? null,
    [allRows, creativeDrawerState.activeRowId]
  );
  const activeBreakdownCreativeRow = useMemo(
    () => allRows.find((row) => row.id === breakdownDrawerState.activeRowId) ?? null,
    [allRows, breakdownDrawerState.activeRowId]
  );
  const adBreakdownRows = useMemo(() => {
    const creativeName = activeBreakdownCreativeRow?.name ?? null;
    if (!creativeName) return [];
      const rows = (adBreakdownQuery.data?.rows ?? []).map(mapApiRowToUiRow);
    return rows.filter((row) => row.name === creativeName);
  }, [activeBreakdownCreativeRow?.name, adBreakdownQuery.data?.rows]);

  const openCreativeDrawer = useCallback((rowId: string, scrollToRow = false) => {
    setCreativeDrawerState({ open: true, activeRowId: rowId });
    if (scrollToRow) {
      const target = document.getElementById(`creative-row-${rowId}`);
      if (target) target.scrollIntoView({ behavior: "smooth", block: "center" });
    }
  }, []);
  const openAdBreakdownDrawer = useCallback((rowId: string) => {
    setBreakdownDrawerState({ open: true, activeRowId: rowId });
    setHighlightedRowId(rowId);
    setTimeout(() => setHighlightedRowId((prev) => (prev === rowId ? null : prev)), 1400);
  }, []);

  const toggleRowSelection = useCallback((rowId: string) => {
    hasUserInteractedSelectionRef.current = true;
    setSelectionState((prev) => ({
      selectedRowIds: prev.selectedRowIds.includes(rowId)
        ? prev.selectedRowIds.filter((id) => id !== rowId)
        : [...prev.selectedRowIds, rowId],
    }));
  }, []);

  const toggleAllRows = useCallback(() => {
    hasUserInteractedSelectionRef.current = true;
    const allIds = deferredFilteredRows.map((row) => row.id);
    setSelectionState((prev) => ({
      selectedRowIds: allIds.every((id) => prev.selectedRowIds.includes(id)) ? [] : allIds,
    }));
  }, [deferredFilteredRows]);

  const handleCsvExport = async () => {
    setCsvError(null);
    setCsvExportLoading(true);
    try {
      const csv = toCsv(filteredRows);
      const blob = new Blob([csv], { type: "text/csv;charset=utf-8;" });
      const url = URL.createObjectURL(blob);
      const a = document.createElement("a");
      a.href = url;
      a.download = `top-creatives-${drStart}-to-${drEnd}.csv`;
      a.click();
      URL.revokeObjectURL(url);
    } catch {
      setCsvError("Could not export CSV.");
    } finally {
      setCsvExportLoading(false);
    }
  };

  const handleShareExport = async () => {
    setShareError(null);
    setShareExportLoading(true);
    try {
      let decisionOsForShare = creativeDecisionOs;
      if (!decisionOsForShare || decisionSnapshotReportingRangeDiffers) {
        const snapshotPayload = await runCreativeDecisionOsAnalysis(businessId, drStart, drEnd, {
          benchmarkScope: activeBenchmarkScope,
        });
        queryClient.setQueryData(creativeDecisionOsSnapshotQueryKey, snapshotPayload);
        decisionOsForShare = snapshotPayload.decisionOs ?? null;
      }
      const analysisLookup = buildSharedCreativeAnalysisLookup(decisionOsForShare);
      const selectedForShare =
        selectionState.selectedRowIds.length > 0
          ? filteredRows.filter((row) => selectionState.selectedRowIds.includes(row.id))
          : filteredRows;
      const shareMetrics = topMetricIds.filter((id): id is ShareMetricKey => SHARE_METRIC_IDS.has(id as ShareMetricKey));
      const payload: Omit<SharePayload, "token" | "createdAt"> = {
        title: "Top Creatives",
        dateRange: formatCreativeDateLabel(dateRangeValue),
        expiresAt: new Date(Date.now() + 1000 * 60 * 60 * 24 * 7).toISOString(),
        businessId,
        groupBy,
        filters: topFilters.map((rule) => `${rule.field}: ${rule.query}`),
        selectedRowIds: selectionState.selectedRowIds,
        totalRows: filteredRows.length,
        metrics: shareMetrics.length > 0 ? shareMetrics : ["spend", "roas"],
        includeNotes: false,
        note: "",
        creatives: selectedForShare.map((row) =>
          toSharedCreative(
            row,
            getSharedCreativeAnalysisForRow(row, analysisLookup, {
              includeMetricsOnlyFallback: true,
            }),
          ),
        ),
        // Keep share payload compact; public page falls back to `creatives` as benchmark when omitted.
        benchmarkCreatives: undefined,
      };

      const res = await fetch("/api/creatives/share", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(payload),
      });
      const text = await res.text();
      const json = (() => {
        if (!text) return null;
        try {
          return JSON.parse(text) as { url?: string; message?: string };
        } catch {
          return null;
        }
      })();
      if (!res.ok || !json?.url) {
        const fallbackMessage = res.status === 413
          ? "Share payload is too large. Narrow the selection and try again."
          : "Could not create share link.";
        throw new Error(json?.message ?? fallbackMessage);
      }
      setShareUrl(json.url);
    } catch (error: unknown) {
      setShareError(error instanceof Error ? error.message : "Could not create share link.");
    } finally {
      setShareExportLoading(false);
    }
  };

  const dataStatus = activeCreativesPayload?.status;

  useEffect(() => {
    if (typeof window === "undefined") return;
    const params = new URLSearchParams(window.location.search);
    if (creativeDrawerState.open && creativeDrawerState.activeRowId) {
      params.set("creative", creativeDrawerState.activeRowId);
    } else {
      params.delete("creative");
    }
    const next = params.toString();
    const nextUrl = `${window.location.pathname}${next ? `?${next}` : ""}`;
    window.history.replaceState(null, "", nextUrl);
  }, [creativeDrawerState.activeRowId, creativeDrawerState.open]);

  useEffect(() => {
    if (creativeDrawerState.open) return;
    if (typeof window === "undefined") return;
    const fromUrl = new URLSearchParams(window.location.search).get("creative");
    if (!fromUrl) return;
    const exists = filteredRows.some((row) => row.id === fromUrl);
    if (!exists) return;
    setCreativeDrawerState({ open: true, activeRowId: fromUrl });
  }, [creativeDrawerState.open, filteredRows]);

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
    <div className="space-y-5">
      <div className="space-y-2">
        <div className="flex flex-wrap items-center gap-2">
          <h1 className="text-2xl font-semibold tracking-tight">Top Creatives</h1>
        </div>
        <p className="text-sm text-muted-foreground">
          Identify the creatives driving the most spend and revenue across your ad accounts. Analyze performance, spot winners, and scale what works.
        </p>
      </div>

      {(() => {
        const platformLabel = PLATFORM_LABELS[platform] ?? platform;

        if (platform !== "meta") {
          if (!platformConnected) {
            return (
              <LockedFeatureCard
                providerLabel={platformLabel}
                description={`Connect ${platformLabel} to view creative performance and sharing tools.`}
              />
            );
          }
          return (
            <EmptyState
              title="Creative view unavailable"
              description={`Creative view for ${platformLabel} is not supported yet.`}
            />
          );
        }

        if (showBootstrapGuard) {
          return (
            <LoadingSkeleton
              rows={5}
              title={
                language === "tr"
                  ? "Creative görünümü hazırlanıyor"
                  : "Preparing the creatives view"
              }
              description={
                language === "tr"
                  ? "Meta bağlantısı, hesap atamaları ve ilk creative özetleri kontrol ediliyor."
                  : "We are checking the Meta connection, assigned accounts, and the initial creative snapshot."
              }
            />
          );
        }

        if (!platformConnected) {
          return (
            <IntegrationEmptyState
              providerLabel="Meta"
              status={metaView.status === "action_required" ? "error" : "disconnected"}
              title={
                language === "tr"
                  ? "Creative performansını açmak için Meta'yı bağlayın"
                  : "Connect Meta to unlock creative performance"
              }
              description={
                language === "tr"
                  ? "Creative performansı, önizlemeler ve paylaşım araçları Meta bağlantısı tamamlandığında görünür."
                  : "Creative performance, preview coverage, and sharing tools appear once Meta is connected."
              }
            />
          );
        }

        if (!metaHasAssignments || dataStatus === "no_accounts_assigned") {
          return (
            <div className="rounded-xl border border-dashed p-8 text-center">
              <h3 className="text-base font-semibold">
                {language === "tr"
                  ? "Creative verilerini açmak için Meta reklam hesaplarını atayın"
                  : "Assign Meta ad accounts to load creatives"}
              </h3>
              <p className="mt-2 text-sm text-muted-foreground">
                {language === "tr"
                  ? "Önce bu işletmeye en az bir Meta reklam hesabı bağlayıp atayın."
                  : "Connect and assign at least one Meta ad account for this business first."}
              </p>
              <Button className="mt-4" variant="outline" onClick={() => router.push("/integrations") }>
                {language === "tr" ? "Entegrasyonları aç" : "Open Integrations"}
              </Button>
            </div>
          );
        }

        return (
          <>
            <CreativesTopSection
              businessId={businessId}
              showHeader={false}
              showGroupByControl={false}
              showAiActionsRow={false}
              dateRange={dateRangeValue}
              onDateRangeChange={setBoundedDateRangeValue}
              groupBy={groupBy}
              onGroupByChange={setGroupBy}
              filters={topFilters}
              onFiltersChange={setTopFilters}
              selectedMetricIds={topMetricIds}
              onSelectedMetricIdsChange={setTopMetricIds}
              selectedRows={topPreviewRows}
              allRowsForHeatmap={filteredRows}
              benchmarkRows={benchmarkRows}
              defaultCurrency={selectedBusinessCurrency}
              onOpenRow={(rowId) => openCreativeDrawer(rowId, true)}
              onShareExport={handleShareExport}
              onCsvExport={handleCsvExport}
              shareExportLoading={shareExportLoading}
              csvExportLoading={csvExportLoading}
              shareUrl={shareUrl}
              shareError={shareError}
              csvError={csvError}
              previewStripState={previewStripState}
              previewStripSummary={previewStripSummary}
              decisionOs={creativeDecisionOs}
              quickFilters={[]}
              activeQuickFilterKey={activeQuickFilterKey}
              onToggleQuickFilter={handlePerformanceQuickFilter}
              showDecisionSupportSurface={false}
              belowToolbar={
                <div
                  className="rounded-2xl border border-slate-200 bg-white shadow-sm"
                  style={{ padding: "16px 18px", fontFamily: "Inter, system-ui, -apple-system, sans-serif" }}
                >
                  {/* Row 1: benchmark (left) · status + actions (right) */}
                  <div className="flex flex-wrap items-center justify-between gap-2.5">
                    <CreativeBenchmarkScopeControl
                      value={benchmarkScopeMode}
                      campaignContext={campaignBenchmarkContext}
                      onChange={setBenchmarkScopeMode}
                    />
                    <div className="flex flex-wrap items-center gap-3.5">
                      {creativeDecisionOs ? (
                        <div
                          className="text-[12px] text-slate-400"
                          style={{ fontVariantNumeric: "tabular-nums", letterSpacing: "0.005em" }}
                        >
                          {decisionSnapshotGeneratedAt ? (
                            <>
                              Last run <span className="text-slate-500">{decisionSnapshotGeneratedAt}</span>
                            </>
                          ) : null}
                          {creativeDecisionOs.decisionAsOf ? (
                            <>
                              <span className="mx-2 text-slate-200">·</span>
                              Decision as of <span className="text-slate-500">{creativeDecisionOs.decisionAsOf}</span>
                            </>
                          ) : null}
                        </div>
                      ) : null}
                      {/* Run / Re-run analysis */}
                      <button
                        type="button"
                        disabled={!canLoadCreatives || creativeDecisionOsRunMutation.isPending}
                        onClick={handleRunCreativeAnalysis}
                        className={`inline-flex h-11 items-center gap-2 rounded-full border px-[18px] text-[13px] font-semibold transition-colors disabled:cursor-not-allowed disabled:opacity-60 ${
                          creativeDecisionOs
                            ? "border-slate-200 bg-white text-slate-900 hover:border-slate-300 hover:bg-slate-50"
                            : "border-slate-900 bg-slate-900 text-white shadow-sm hover:bg-slate-800"
                        }`}
                      >
                        <Sparkles
                          className={`h-4 w-4 ${creativeDecisionOsRunMutation.isPending ? "animate-spin" : ""}`}
                        />
                        {creativeDecisionOsRunMutation.isPending
                          ? "Running analysis"
                          : creativeDecisionOs
                            ? "Re-run analysis"
                            : "Run Creative Analysis"}
                      </button>
                      {/* Decision OS */}
                      <button
                        type="button"
                        onClick={() => setDecisionOsDrawerOpen(true)}
                        className={`inline-flex h-11 items-center gap-2 rounded-full border px-[18px] text-[13px] font-semibold transition-colors ${
                          creativeDecisionOs
                            ? "border-slate-900 bg-slate-900 text-white shadow-sm hover:bg-slate-800"
                            : "border-slate-200 bg-white text-slate-900 hover:border-slate-300 hover:bg-slate-50"
                        }`}
                      >
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 14 14"
                          fill="none"
                          className={creativeDecisionOs ? "text-white" : "text-slate-500"}
                          aria-hidden="true"
                        >
                          <rect x="2" y="2" width="10" height="10" rx="2" stroke="currentColor" strokeWidth="1.4" />
                          <path d="M5 7l1.5 1.5L9.5 5.5" stroke="currentColor" strokeWidth="1.4" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                        Decision OS
                        {creativeDecisionOs ? (
                          <span className="ml-0.5 rounded-full bg-white/[0.18] px-[7px] py-px text-[11px] font-medium text-white">
                            Open
                          </span>
                        ) : null}
                      </button>
                    </div>
                  </div>

                  {/* Row 2: segment pills */}
                  {quickFilters.length > 0 ? (
                    <div className="mt-3.5 flex flex-wrap items-center gap-2">
                      {quickFilters.map((filter) => {
                        const active = activeQuickFilterKey === filter.key;
                        const toneMap: Record<string, { button: string; count: string }> = {
                          act_now: {
                            button: active
                              ? "border-emerald-700 bg-emerald-600 text-white shadow-sm"
                              : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:shadow-sm",
                            count: active ? "bg-white/20 text-white" : "bg-emerald-100 text-emerald-800",
                          },
                          watch: {
                            button: active
                              ? "border-blue-700 bg-blue-600 text-white shadow-sm"
                              : "border-blue-200 bg-blue-50 text-blue-700 hover:shadow-sm",
                            count: active ? "bg-white/20 text-white" : "bg-blue-100 text-blue-700",
                          },
                          needs_truth: {
                            button: active
                              ? "border-amber-700 bg-amber-600 text-white shadow-sm"
                              : "border-amber-200 bg-amber-50 text-amber-800 hover:shadow-sm",
                            count: active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-800",
                          },
                          blocked: {
                            button: active
                              ? "border-amber-700 bg-amber-600 text-white shadow-sm"
                              : "border-amber-200 bg-amber-50 text-amber-800 hover:shadow-sm",
                            count: active ? "bg-white/20 text-white" : "bg-amber-100 text-amber-800",
                          },
                        };
                        const toneClasses = toneMap[filter.tone] ?? {
                          button: active
                            ? "border-blue-700 bg-blue-600 text-white shadow-sm"
                            : "border-blue-200 bg-blue-50 text-blue-700 hover:shadow-sm",
                          count: active ? "bg-white/20 text-white" : "bg-blue-100 text-blue-700",
                        };
                        return (
                          <button
                            key={filter.key}
                            type="button"
                            onClick={() => handlePerformanceQuickFilter(filter.key)}
                            aria-label={`${creativeQuickFilterShortLabel(filter.key)}: ${filter.count.toLocaleString()} creatives`}
                            data-count={filter.count}
                            data-testid={`creative-performance-filter-${filter.key}`}
                            style={{ height: 30, padding: "0 4px 0 12px", transition: "box-shadow 120ms ease" }}
                            className={`inline-flex items-center gap-2 rounded-full border text-[12px] font-semibold ${toneClasses.button}`}
                          >
                            <span>{creativeQuickFilterShortLabel(filter.key)}</span>
                            <span
                              style={{ minWidth: 22, height: 22, padding: "0 7px", fontVariantNumeric: "tabular-nums" }}
                              className={`inline-flex items-center justify-center rounded-full text-[11px] font-semibold ${toneClasses.count}`}
                            >
                              {filter.count.toLocaleString()}
                            </span>
                          </button>
                        );
                      })}
                      {(activeQuickFilter || activeDecisionOsFamily) ? (
                        <button
                          type="button"
                          onClick={clearCreativeFocusFilters}
                          style={{ height: 30 }}
                          className="rounded-full border border-slate-200 bg-white px-3 text-[11px] font-medium text-slate-600 hover:bg-slate-50"
                        >
                          Clear
                        </button>
                      ) : null}
                    </div>
                  ) : null}

                  {/* Warnings */}
                  {decisionSnapshotReportingRangeDiffers ? (
                    <p className="mt-2 text-[11px] text-amber-700" data-testid="creative-decision-os-snapshot-status">
                      Reporting range changed. Snapshot unchanged until you re-run analysis.
                    </p>
                  ) : null}
                  {decisionSnapshotSafeError ? (
                    <p className="mt-2 text-[11px] text-rose-700" data-testid="creative-decision-os-snapshot-status">
                      {decisionSnapshotSafeError}
                    </p>
                  ) : null}
                </div>
              }
            />

            {creativeDecisionOsV2PreviewEnabled ? (
              <CreativeDecisionOsV2PreviewSurface
                preview={creativeDecisionOsV2Preview}
                isLoading={creativeDecisionOsV2PreviewQuery.isLoading}
                error={
                  creativeDecisionOsV2PreviewQuery.error instanceof Error
                    ? creativeDecisionOsV2PreviewQuery.error.message
                    : creativeDecisionOsV2PreviewQuery.data?.error?.message ?? null
                }
                onOpenRow={(rowId) => openCreativeDrawer(rowId, true)}
              />
            ) : null}

            <CreativeDecisionCenterSurface
              decisionCenter={creativeDecisionCenter}
              onOpenRow={(rowId) => openCreativeDrawer(rowId, true)}
            />

            {creativesMetadataQuery.isLoading && <CreativesTableShell />}

            {creativesMetadataQuery.isError && (
              <ErrorState
                title="Could not load creatives"
                description={
                  creativesMetadataQuery.error instanceof Error
                    ? creativesMetadataQuery.error.message
                    : "Could not load creative performance data."
                }
                onRetry={() => creativesMetadataQuery.refetch()}
              />
            )}

            {!creativesMetadataQuery.isLoading &&
              !creativesMetadataQuery.isError &&
              (deferredFilteredRows.length === 0 || dataStatus === "no_data") && (
                <EmptyState
                  title={
                    (activeCreativesPayload?.rows?.length ?? 0) > 0
                      ? language === "tr"
                        ? "Bu filtrelerle eşleşen creative bulunamadı"
                        : "No creatives match the current filters"
                      : language === "tr"
                        ? "Seçili aralık için creative performans verisi bulunamadı"
                        : "No creative performance data found for the selected range"
                  }
                  description={
                    (activeCreativesPayload?.rows?.length ?? 0) > 0
                      ? language === "tr"
                        ? "Tarih aralığını veya filtreleri gevşeterek daha fazla creative görebilirsiniz."
                        : "Relax the current filters or widen the date range to reveal more creatives."
                      : language === "tr"
                        ? "Daha geniş bir tarih aralığı deneyin veya bağlı Meta hesaplarında aktif reklam yayını olduğunu doğrulayın."
                        : "Try a wider date range or verify that assigned Meta accounts have active ad delivery."
                  }
                />
              )}

            {!creativesMetadataQuery.isLoading &&
              !creativesMetadataQuery.isError &&
              deferredFilteredRows.length > 0 &&
              dataStatus !== "no_data" && (
                <>
                  <CreativesTableSection
                    rows={deferredFilteredRows}
                    creativeHistoryById={creativeHistoryById}
                    decisionOs={creativeDecisionOs}
                    decisionCenter={creativeDecisionCenter}
                    selectedMetricIds={topMetricIds}
                    onSelectedMetricIdsChange={setTopMetricIds}
                    selectedRowIds={selectionState.selectedRowIds}
                    highlightedRowId={highlightedRowId}
                    defaultCurrency={selectedBusinessCurrency}
                    onToggleRow={toggleRowSelection}
                    onToggleAll={toggleAllRows}
                    onOpenRow={openCreativeDrawer}
                    onOpenBreakdownRow={openAdBreakdownDrawer}
                    onSortedRowsChange={setTableSortedRows}
                  />
                </>
              )}
          </>
        );
      })()}

      <CreativeDetailExperience
        businessId={businessId}
        row={activeCreativeRow}
        allRows={filteredRows}
        creativeHistoryById={creativeHistoryById}
        decisionOs={creativeDecisionOs}
        open={creativeDrawerState.open}
        notes={activeCreativeRow ? notesByRowId[activeCreativeRow.id] ?? "" : ""}
        dateRange={dateRangeValue}
        defaultCurrency={selectedBusinessCurrency}
        onOpenChange={(open) =>
          setCreativeDrawerState((prev) => ({ ...prev, open, activeRowId: open ? prev.activeRowId : null }))
        }
        onDateRangeChange={setDateRangeValue}
        onNotesChange={(value) => {
          if (!activeCreativeRow) return;
          setNotesByRowId((prev) => ({ ...prev, [activeCreativeRow.id]: value }));
        }}
      />
      <CreativeAdBreakdownDrawer
        open={breakdownDrawerState.open}
        creative={activeBreakdownCreativeRow}
        rows={adBreakdownRows}
        loading={adBreakdownQuery.isLoading}
        defaultCurrency={selectedBusinessCurrency}
        onOpenChange={(open) =>
          setBreakdownDrawerState((prev) => ({ ...prev, open, activeRowId: open ? prev.activeRowId : null }))
        }
      />
      <CreativeDecisionOsDrawer
        decisionOs={creativeDecisionOs}
        decisionCenter={creativeDecisionCenter}
        isLoading={creativeDecisionOsSnapshotQuery.isLoading || creativeDecisionOsRunMutation.isPending}
        snapshot={creativeDecisionSnapshot}
        snapshotStatus={creativeDecisionSnapshotResponse?.status ?? (creativeDecisionOsSnapshotQuery.isLoading ? "running" : "not_run")}
        snapshotError={decisionSnapshotSafeError}
        onRunAnalysis={handleRunCreativeAnalysis}
        isRunningAnalysis={creativeDecisionOsRunMutation.isPending}
        open={decisionOsDrawerOpen}
        onOpenChange={setDecisionOsDrawerOpen}
        quickFilters={quickFilters}
        allRows={filteredRows}
        selectedRows={topPreviewRows}
        activeFamilyId={decisionOsFamilyFilter}
        activeQuickFilterKey={activeQuickFilterKey}
        onSelectFamily={(familyId) => {
          setDecisionOsFamilyFilter(familyId);
        }}
        onSelectQuickFilter={handlePerformanceQuickFilter}
        onClearFilters={clearCreativeFocusFilters}
      />
    </div>
    </PlanGate>
  );
}
