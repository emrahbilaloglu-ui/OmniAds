"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { X } from "lucide-react";
import { BusinessEmptyState } from "@/components/business/BusinessEmptyState";
import { EmptyState } from "@/components/states/empty-state";
import { ErrorState } from "@/components/states/error-state";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { Badge } from "@/components/ui/badge";
import { CreativesTableSection } from "@/components/creatives/CreativesTableSection";
import {
  applyCreativeFilters,
  DEFAULT_COPY_TOP_METRIC_IDS,
  CreativeDateRangeValue,
  CreativeFilterRule,
  CreativeGroupBy,
  CreativesTopSection,
  resolveCreativeDateRange,
} from "@/components/creatives/CreativesTopSection";
import { usePersistentCreativeDateRange } from "@/hooks/use-persistent-date-range";
import { PlanGate } from "@/components/pricing/PlanGate";
import { useAppStore } from "@/store/app-store";
import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";
import {
  mapApiRowToCopyRow,
  type CopyMotionRow,
} from "@/app/(dashboard)/platforms/meta/copies/page-support";

interface MetaCopiesResponse {
  status?: string;
  message?: string;
  rows: MetaCopyApiRow[];
  meta?: {
    unresolved_filtered_count?: number;
    generatedAt?: string;
  };
}

const COPY_GROUP_OPTIONS: Array<{ value: CreativeGroupBy; label: string }> = [
  { value: "copy", label: "Copy" },
  { value: "adName", label: "Ad Name" },
  { value: "campaign", label: "Campaign" },
  { value: "adSet", label: "Ad Set" },
];

function hasMessage(payload: unknown): payload is { message: string } {
  if (!payload || typeof payload !== "object") return false;
  return "message" in payload && typeof payload.message === "string";
}

async function fetchCopyRows(params: {
  businessId: string;
  start: string;
  end: string;
  groupBy: "copy" | "adName" | "campaign" | "adSet";
}): Promise<MetaCopiesResponse> {
  const query = new URLSearchParams({
    businessId: params.businessId,
    start: params.start,
    end: params.end,
    groupBy: params.groupBy,
    format: "all",
    sort: "spend",
  });

  const response = await fetch(`/api/meta/copies?${query.toString()}`, {
    headers: { Accept: "application/json" },
  });

  const payload: unknown = await response.json().catch(() => null);
  if (!response.ok) {
    const message = hasMessage(payload)
      ? payload.message
      : `Could not load copies (${response.status}).`;
    throw new Error(message);
  }

  if (
    !payload ||
    typeof payload !== "object" ||
    !Array.isArray((payload as MetaCopiesResponse).rows)
  ) {
    throw new Error("Invalid copies response received from backend.");
  }

  return payload as MetaCopiesResponse;
}

export default function CopiesPage() {
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const businessId = selectedBusinessId ?? "";
  const selectedBusinessCurrency =
    businesses.find((business) => business.id === selectedBusinessId)?.currency ?? null;

  const [dateRangeValue, setDateRangeValue] = usePersistentCreativeDateRange();
  const [groupBy, setGroupBy] = useState<CreativeGroupBy>("copy");
  const [topFilters, setTopFilters] = useState<CreativeFilterRule[]>([]);
  const [topMetricIds, setTopMetricIds] = useState<string[]>(
    DEFAULT_COPY_TOP_METRIC_IDS,
  );
  const [selectionState, setSelectionState] = useState<{ selectedRowIds: string[] }>({
    selectedRowIds: [],
  });
  const [detailRowId, setDetailRowId] = useState<string | null>(null);
  const hasInitializedDefaultSelectionRef = useRef(false);
  const hasUserInteractedSelectionRef = useRef(false);

  const { start: drStart, end: drEnd } = resolveCreativeDateRange(dateRangeValue);
  const copyApiGroupBy: "copy" | "adName" | "campaign" | "adSet" =
    groupBy === "copy" || groupBy === "adName" || groupBy === "campaign" || groupBy === "adSet"
      ? groupBy
      : "copy";

  const copiesQuery = useQuery({
    queryKey: ["copies-creatives", businessId, drStart, drEnd, copyApiGroupBy],
    enabled: Boolean(selectedBusinessId),
    queryFn: () =>
      fetchCopyRows({
        businessId,
        start: drStart,
        end: drEnd,
        groupBy: copyApiGroupBy,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
    placeholderData: (previousData) => previousData,
  });

  const allRows = useMemo(() => {
    return (copiesQuery.data?.rows ?? []).map(mapApiRowToCopyRow);
  }, [copiesQuery.data?.rows]);

  const filteredRows = useMemo(
    () => applyCreativeFilters(allRows, topFilters),
    [allRows, topFilters],
  );

  useEffect(() => {
    setSelectionState((prev) => {
      const filteredIds = new Set(filteredRows.map((row) => row.id));
      const kept = prev.selectedRowIds.filter((id) => filteredIds.has(id));

      if (
        !hasInitializedDefaultSelectionRef.current &&
        !hasUserInteractedSelectionRef.current &&
        kept.length === 0 &&
        filteredRows.length > 0
      ) {
        hasInitializedDefaultSelectionRef.current = true;
        return { selectedRowIds: filteredRows.slice(0, 5).map((row) => row.id) };
      }

      if (kept.length !== prev.selectedRowIds.length) {
        return { selectedRowIds: kept };
      }

      return prev;
    });
  }, [filteredRows]);

  const selectedRows = useMemo(
    () =>
      filteredRows
        .filter((row) => selectionState.selectedRowIds.includes(row.id)),
    [filteredRows, selectionState.selectedRowIds],
  );

  const topPanelRows = useMemo(
    () => (selectedRows.length > 0 ? selectedRows : filteredRows),
    [filteredRows, selectedRows],
  );

  const activeDetailRow = useMemo(
    () => filteredRows.find((row) => row.id === detailRowId) ?? null,
    [detailRowId, filteredRows],
  );

  const generatedAt = copiesQuery.data?.meta?.generatedAt ?? null;
  const unresolvedFilteredCount = copiesQuery.data?.meta?.unresolved_filtered_count ?? 0;

  const toggleRowSelection = (rowId: string) => {
    hasUserInteractedSelectionRef.current = true;
    setSelectionState((prev) => ({
      selectedRowIds: prev.selectedRowIds.includes(rowId)
        ? prev.selectedRowIds.filter((id) => id !== rowId)
        : [...prev.selectedRowIds, rowId],
    }));
  };

  const toggleAllRows = () => {
    hasUserInteractedSelectionRef.current = true;
    const allIds = filteredRows.map((row) => row.id);
    setSelectionState((prev) => ({
      selectedRowIds: allIds.every((id) => prev.selectedRowIds.includes(id))
        ? []
        : allIds,
    }));
  };

  if (!selectedBusinessId) return <BusinessEmptyState />;

  return (
    <PlanGate requiredPlan="growth">
    <div className="space-y-5">
      <div className="space-y-1">
        <h1 className="text-2xl font-semibold tracking-tight">Copies</h1>
        <p className="text-sm text-muted-foreground">
          Compare copy performance and inspect usage across campaign structure.
        </p>
        {(generatedAt || unresolvedFilteredCount > 0) && (
          <p className="text-xs text-muted-foreground" data-testid="copies-data-meta">
            {generatedAt
              ? `Data as of ${new Date(generatedAt).toLocaleString()}`
              : null}
            {generatedAt && unresolvedFilteredCount > 0 ? " \u00b7 " : null}
            {unresolvedFilteredCount > 0
              ? `${unresolvedFilteredCount} ad${unresolvedFilteredCount === 1 ? "" : "s"} hidden (copy text could not be resolved)`
              : null}
          </p>
        )}
      </div>

      <CreativesTopSection
        showHeader={false}
        title="Top copy"
        description="Compare high-performing ad texts, isolate winning angles, and scale copy that drives efficient purchases."
        dateRange={dateRangeValue}
        onDateRangeChange={setDateRangeValue}
        groupBy={groupBy}
        onGroupByChange={setGroupBy}
        groupByOptions={COPY_GROUP_OPTIONS}
        filters={topFilters}
        onFiltersChange={setTopFilters}
        selectedMetricIds={topMetricIds}
        onSelectedMetricIdsChange={setTopMetricIds}
        selectedRows={topPanelRows}
        allRowsForHeatmap={filteredRows}
        defaultCurrency={selectedBusinessCurrency}
        previewMode="copy"
        getPreviewCopyText={(row) => (row as CopyMotionRow).copyText}
        onOpenRow={(rowId) => setDetailRowId(rowId)}
        onShareExport={() => undefined}
        onCsvExport={() => undefined}
      />

      {copiesQuery.isLoading && <LoadingSkeleton rows={5} />}

      {copiesQuery.isError && (
        <ErrorState
          title="Could not load copies"
          description={
            copiesQuery.error instanceof Error
              ? copiesQuery.error.message
              : "Could not load copy performance data."
          }
          onRetry={() => copiesQuery.refetch()}
        />
      )}

      {!copiesQuery.isLoading && !copiesQuery.isError && filteredRows.length === 0 && (
        <EmptyState
          title="No copy performance data found for the selected range"
          description="Try a wider date range or adjust filters to inspect copy performance."
        />
      )}

      {!copiesQuery.isLoading && !copiesQuery.isError && filteredRows.length > 0 && (
        <CreativesTableSection
          rows={filteredRows}
          initialPresetName="Meta Copy Performance"
          selectedMetricIds={topMetricIds}
          onSelectedMetricIdsChange={setTopMetricIds}
          selectedRowIds={selectionState.selectedRowIds}
          defaultCurrency={selectedBusinessCurrency}
          onToggleRow={toggleRowSelection}
          onToggleAll={toggleAllRows}
          onOpenRow={(rowId) => setDetailRowId(rowId)}
        />
      )}

      {activeDetailRow ? (
        <div className="fixed inset-0 z-50 bg-black/35">
          <button
            type="button"
            className="absolute inset-0"
            onClick={() => setDetailRowId(null)}
            aria-label="Close drawer overlay"
          />
          <aside className="absolute right-0 top-0 h-full w-full max-w-xl overflow-y-auto border-l bg-background p-5 shadow-xl">
            <div className="mb-4 flex items-center justify-between">
              <h2 className="text-lg font-semibold">Copy Detail</h2>
              <button
                type="button"
                onClick={() => setDetailRowId(null)}
                className="rounded-md p-1 text-muted-foreground hover:bg-muted"
                aria-label="Close drawer"
              >
                <X className="h-4 w-4" />
              </button>
            </div>

            <div className="space-y-4 rounded-xl border p-4">
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Copy unit
                </p>
                <p className="mt-1 text-base font-semibold">{activeDetailRow.name}</p>
              </div>
              <div>
                <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
                  Copy text
                </p>
                <p className="mt-1 whitespace-pre-wrap text-sm leading-6">
                  {(activeDetailRow as CopyMotionRow).copyText}
                </p>
              </div>
              <div className="flex flex-wrap gap-2">
                {(activeDetailRow.tags ?? []).map((tag) => (
                  <Badge key={tag} variant="outline" className="capitalize">
                    {tag}
                  </Badge>
                ))}
              </div>
            </div>
          </aside>
        </div>
      ) : null}
    </div>
    </PlanGate>
  );
}
