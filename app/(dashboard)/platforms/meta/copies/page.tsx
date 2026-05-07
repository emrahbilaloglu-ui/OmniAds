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
import type { MetaCreativeRow, MetaCreativePreview } from "@/components/creatives/metricConfig";
import { coerceCreativeTaxonomyFromLegacy } from "@/lib/meta/creative-taxonomy";
import { useAppStore } from "@/store/app-store";
import type { MetaCopyApiRow } from "@/app/api/meta/copies/route";

type CopyMotionRow = MetaCreativeRow & {
  copyText: string;
  usedInCampaigns: string[];
  usedInAds: string[];
};

interface MetaCopiesResponse {
  status?: string;
  message?: string;
  rows: MetaCopyApiRow[];
  meta?: {
    unresolved_filtered_count?: number;
  };
}

const COPY_GROUP_OPTIONS: Array<{ value: CreativeGroupBy; label: string }> = [
  { value: "copy", label: "Copy" },
  { value: "adName", label: "Ad Name" },
  { value: "campaign", label: "Campaign" },
  { value: "adSet", label: "Ad Set" },
];

const EMPTY_PREVIEW: MetaCreativePreview = {
  render_mode: "unavailable",
  image_url: null,
  video_url: null,
  poster_url: null,
  source: null,
  is_catalog: false,
};

function clamp(value: number, min: number, max: number) {
  return Math.min(max, Math.max(min, value));
}

function normalizeCopyIdentity(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const normalized = value
    .replace(/\r\n/g, "\n")
    .replace(/\u00a0/g, " ")
    .replace(/[ \t]+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
  if (!normalized) return null;
  return normalized;
}

function excerptCopyText(value: string, max = 220): string {
  if (value.length <= max) return value;
  return `${value.slice(0, max).trim()}...`;
}

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

function resolveCopyDisplayText(row: MetaCopyApiRow): string {
  return (
    normalizeCopyIdentity(row.copy_text) ??
    normalizeCopyIdentity(row.primary_text) ??
    normalizeCopyIdentity(row.headline) ??
    normalizeCopyIdentity(row.description) ??
    normalizeCopyIdentity(row.name) ??
    "Copy unavailable"
  );
}

function mapApiRowToCopyRow(row: MetaCopyApiRow): CopyMotionRow {
  const linkClicks = row.link_clicks ?? 0;
  const clicks = linkClicks;
  const purchases = row.purchases ?? 0;
  const addToCart = row.add_to_cart ?? 0;
  const impressions = row.impressions ?? 0;
  const clickToAddToCart = row.click_to_atc_ratio ?? (linkClicks > 0 ? (addToCart / linkClicks) * 100 : 0);
  const clickToPurchase = row.click_to_purchase ?? (linkClicks > 0 ? (purchases / linkClicks) * 100 : 0);
  const linkCtr = impressions > 0 ? (linkClicks / impressions) * 100 : 0;
  const fallbackFormat = row.is_catalog ? "catalog" : row.preview?.render_mode === "video" ? "video" : "image";
  const fallbackCreativeType = row.is_catalog ? "feed_catalog" : row.preview?.render_mode === "video" ? "video" : "feed";
  const creativeTaxonomy = coerceCreativeTaxonomyFromLegacy({
    format: fallbackFormat,
    creative_type: fallbackCreativeType,
    is_catalog: row.is_catalog,
  });

  const copyText = resolveCopyDisplayText(row);
  const displayName = excerptCopyText(copyText, 180);

  return {
    id: row.id,
    creativeId: row.creative_id ?? row.id,
    objectStoryId: null,
    effectiveObjectStoryId: null,
    postId: row.post_id ?? null,
    name: displayName,
    associatedAdsCount: 1,
    accountId: row.account_id ?? null,
    accountName: row.account_name ?? null,
    campaignId: row.campaign_id,
    campaignName: row.campaign_name,
    adSetId: row.adset_id,
    adSetName: row.adset_name,
    currency: row.currency ?? null,
    format: fallbackFormat,
    creativeType: fallbackCreativeType,
    creativeTypeLabel: row.is_catalog ? "Feed (Catalog ads)" : row.preview?.render_mode === "video" ? "Video" : "Feed",
    creativeDeliveryType: creativeTaxonomy.creative_delivery_type,
    creativeVisualFormat: creativeTaxonomy.creative_visual_format,
    creativePrimaryType: creativeTaxonomy.creative_primary_type,
    creativePrimaryLabel: creativeTaxonomy.creative_primary_label,
    creativeSecondaryType: creativeTaxonomy.creative_secondary_type,
    creativeSecondaryLabel: creativeTaxonomy.creative_secondary_label,
    thumbnailUrl: row.thumbnail_url,
    previewUrl: row.preview_url,
    imageUrl: row.image_url,
    tableThumbnailUrl: row.table_thumbnail_url ?? row.thumbnail_url ?? null,
    cardPreviewUrl:
      row.card_preview_url ?? row.image_url ?? row.thumbnail_url ?? row.preview_url ?? null,
    cachedThumbnailUrl: null,
    isCatalog: row.is_catalog ?? false,
    previewState: row.preview_state,
    preview: row.preview ?? EMPTY_PREVIEW,
    launchDate: row.launch_date ?? "",
    tags: [],
    aiTags: {},
    spend: row.spend,
    purchaseValue: row.purchase_value ?? 0,
    roas: row.roas,
    cpa: row.cpa,
    cpcLink: row.cpc_link,
    cpm: row.cpm,
    ctrAll: row.ctr_all,
    linkCtr,
    purchases,
    impressions,
    clicks,
    linkClicks,
    landingPageViews: 0,
    addToCart,
    initiateCheckout: 0,
    leads: 0,
    messages: 0,
    thumbstop: row.thumbstop ?? 0,
    clickToAddToCart,
    clickToPurchase,
    seeMoreRate: row.see_more_rate ?? clamp(row.ctr_all * 1.5, 0, 100),
    video25: 0,
    video50: 0,
    video75: 0,
    video100: 0,
    atcToPurchaseRatio:
      (row.atc_to_purchase_ratio ?? 0) > 0
        ? (row.atc_to_purchase_ratio ?? 0)
        : addToCart > 0
          ? (purchases / addToCart) * 100
          : 0,
    copyText,
    usedInCampaigns: row.campaign_name ? [row.campaign_name] : [],
    usedInAds: row.name ? [row.name] : [],
  };
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
