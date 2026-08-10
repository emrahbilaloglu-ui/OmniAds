"use client";

import { useMemo } from "react";
import { Badge } from "@/components/ui/badge";
import { CreativePreview } from "@/components/creatives/CreativePreview";
import {
  METRIC_CONFIG,
  MetaCreativeRow,
  MetaMetricKey,
} from "@/components/creatives/metricConfig";
import {
  getCreativeFormatSummaryLabel,
  getCreativePreviewBadgeLabel,
} from "@/lib/meta/creative-taxonomy";
import { getCreativeStaticPreviewSources, getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import { cn } from "@/lib/utils";

interface CreativesTableLegacyProps {
  rows: MetaCreativeRow[];
  selectedMetrics: MetaMetricKey[];
  selectedRowIds: string[];
  highlightedRowId?: string | null;
  density: "compact" | "comfortable";
  heatmapIntensity: "low" | "medium" | "high";
  onToggleRow: (rowId: string) => void;
  onToggleAll: () => void;
  onOpenRow: (rowId: string) => void;
}

type RowMetricExtremes = Record<MetaMetricKey, { min: number; max: number }>;

type CreativeRowLike = MetaCreativeRow & {
  isCatalog?: boolean;
  is_catalog?: boolean;
  associatedAdsCount?: number;
  associated_ads_count?: number;
  launchDate?: string;
  launch_date?: string;
  tableThumbnailUrl?: string | null;
  table_thumbnail_url?: string | null;
  cardPreviewUrl?: string | null;
  card_preview_url?: string | null;
  cachedThumbnailUrl?: string | null;
  cached_thumbnail_url?: string | null;
  previewUrl?: string | null;
  preview_url?: string | null;
  imageUrl?: string | null;
  image_url?: string | null;
  thumbnailUrl?: string | null;
  thumbnail_url?: string | null;
};

export function CreativesTableLegacy({
  rows,
  selectedMetrics,
  selectedRowIds,
  highlightedRowId = null,
  density,
  heatmapIntensity,
  onToggleRow,
  onToggleAll,
  onOpenRow,
}: CreativesTableLegacyProps) {
  const selectedRowIdSet = useMemo(() => new Set(selectedRowIds), [selectedRowIds]);

  const allSelected = rows.length > 0 && rows.every((row) => selectedRowIdSet.has(row.id));

  const metricExtremes = useMemo<RowMetricExtremes>(() => {
    return selectedMetrics.reduce((acc, metric) => {
      const values = rows.map((row) => Number(row[metric]) || 0);
      acc[metric] = {
        min: values.length ? Math.min(...values) : 0,
        max: values.length ? Math.max(...values) : 0,
      };
      return acc;
    }, {} as RowMetricExtremes);
  }, [rows, selectedMetrics]);

  return (
    <div className="space-y-2">
      <div className="flex items-center gap-2 px-1 text-sm">
        <input
          type="checkbox"
          className="cursor-pointer rounded border-gray-300 shadow-sm"
          checked={allSelected}
          onChange={onToggleAll}
          aria-label="Select all rows"
        />
        <span className="font-medium text-muted-foreground">{selectedRowIds.length} ad groups selected</span>
      </div>

      <div className="max-h-[620px] overflow-auto rounded-xl border border-border bg-background shadow-sm">
        <table className="min-w-full border-separate border-spacing-0 text-sm">
          <thead className="sticky top-0 z-30 bg-background/95 backdrop-blur-sm">
            <tr className="border-b">
              <th className="w-10 border-b px-4 py-3 text-left" />
              <th className="sticky left-0 z-40 min-w-[280px] border-b bg-background px-4 py-3 text-left font-semibold">
                Creative / Ad Name
              </th>
              <th className="min-w-[120px] border-b px-4 py-3 text-left font-medium text-muted-foreground">
                Launch date
              </th>
              <th className="min-w-[160px] border-b px-4 py-3 text-left font-medium text-muted-foreground">
                Tags
              </th>
              {selectedMetrics.map((metric) => (
                <th
                  key={metric}
                  className="min-w-[130px] border-b px-4 py-3 text-left font-medium text-muted-foreground"
                >
                  {METRIC_CONFIG[metric].label}
                </th>
              ))}
            </tr>
          </thead>

          <tbody className="divide-y divide-border/40">
            {rows.map((row) => {
              const isSelected = selectedRowIdSet.has(row.id);
              const isHighlighted = highlightedRowId === row.id;

              return (
                <tr
                  key={row.id}
                  onClick={() => onOpenRow(row.id)}
                  className={cn(
                    "group cursor-pointer transition-colors hover:bg-muted/30",
                    isHighlighted && "bg-emerald-500/10"
                  )}
                >
                  <td className={cn("px-4", density === "compact" ? "py-2" : "py-4")}>
                    <input
                      type="checkbox"
                      className="rounded border-gray-300"
                      checked={isSelected}
                      aria-label={`Select ${row.name}`}
                      onChange={(event) => {
                        event.stopPropagation();
                        onToggleRow(row.id);
                      }}
                      onClick={(event) => event.stopPropagation()}
                    />
                  </td>

                  <td
                    className={cn(
                      "sticky left-0 z-20 bg-background px-4 transition-colors group-hover:bg-muted/30",
                      density === "compact" ? "py-2" : "py-4"
                    )}
                  >
                    <CreativeNameCell row={row as CreativeRowLike} />
                  </td>

                  <td className="whitespace-nowrap px-4 text-muted-foreground">
                    {(row as CreativeRowLike).launchDate || (row as CreativeRowLike).launch_date || "-"}
                  </td>

                  <td className="px-4">
                    <div className="flex flex-wrap gap-1">
                      {(row.tags || []).slice(0, 2).map((tag: string) => (
                        <Badge key={tag} variant="secondary" className="px-1.5 py-0 text-[12px] font-normal">
                          {tag}
                        </Badge>
                      ))}
                    </div>
                  </td>

                  {selectedMetrics.map((metric) => {
                    const value = Number(row[metric]) || 0;
                    const extremes = metricExtremes[metric] ?? { min: 0, max: 0 };
                    const heat = getHeatColor(metric, value, extremes.min, extremes.max);

                    return (
                      <td
                        key={metric}
                        className="px-4 font-medium"
                        style={{ backgroundColor: withIntensity(heat, heatmapIntensity) }}
                      >
                        {METRIC_CONFIG[metric].format(value)}
                      </td>
                    );
                  })}
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </div>
  );
}

function CreativeNameCell({ row }: { row: CreativeRowLike }) {
  const isCatalog = Boolean(row.isCatalog || row.is_catalog || row.preview?.is_catalog);
  const associatedAdsCount = row.associatedAdsCount || row.associated_ads_count || 0;
  const formatLabel = getCreativeFormatSummaryLabel({
    creative_delivery_type: row.creativeDeliveryType,
    creative_visual_format: row.creativeVisualFormat,
    creative_primary_type: row.creativePrimaryType,
    creative_primary_label: row.creativePrimaryLabel,
    creative_secondary_type: row.creativeSecondaryType,
    creative_secondary_label: row.creativeSecondaryLabel,
    taxonomy_source: row.taxonomySource ?? null,
  });

  const sourcePriority = useMemo(
    () => getCreativeStaticPreviewSources(row, "table"),
    [row]
  );
  const assetState = getCreativeStaticPreviewState(row, "table");
  const badgeLabel = getCreativePreviewBadgeLabel({
    creative_delivery_type: row.creativeDeliveryType,
    creative_visual_format: row.creativeVisualFormat,
    creative_primary_type: row.creativePrimaryType,
    creative_primary_label: row.creativePrimaryLabel,
    creative_secondary_type: row.creativeSecondaryType,
    creative_secondary_label: row.creativeSecondaryLabel,
    taxonomy_source: row.taxonomySource ?? null,
  });

  return (
    <div className="flex items-center gap-3">
      <CreativePreview
        id={row.id}
        name={row.name}
        cachedUrl={row.cachedThumbnailUrl ?? row.cached_thumbnail_url ?? null}
        thumbnailUrl={row.tableThumbnailUrl ?? row.table_thumbnail_url ?? row.thumbnailUrl ?? row.thumbnail_url ?? null}
        imageUrl={row.imageUrl ?? row.image_url ?? row.preview?.image_url ?? null}
        previewUrl={row.preview?.poster_url ?? row.previewUrl ?? row.preview_url ?? null}
        sourcePriority={sourcePriority}
        assetState={assetState}
        format={row.creativeVisualFormat === "video" ? "video" : isCatalog ? "catalog" : "image"}
        isCatalog={isCatalog}
        badgeLabel={badgeLabel}
        size="thumb"
        className="shadow-sm"
      />

      <div className="min-w-0 flex-1">
        <p className="truncate text-[13px] font-semibold tracking-tight text-foreground">{row.name}</p>
        <div className="mt-0.5 flex items-center gap-1.5 text-[12px] text-muted-foreground">
          {formatLabel ? <span className="capitalize">{formatLabel}</span> : null}
          {associatedAdsCount > 1 && (
            <span className="flex items-center gap-1.5">
              {formatLabel ? <span className="h-1 w-1 rounded-full bg-muted-foreground/40" /> : null}
              {associatedAdsCount} ads
            </span>
          )}
        </div>
      </div>
    </div>
  );
}

function withIntensity(color: string, intensity: "low" | "medium" | "high") {
  const multiplier = intensity === "low" ? 0.7 : intensity === "high" ? 1.3 : 1;
  const match = color.match(/rgba\((\d+),\s*(\d+),\s*(\d+),\s*([0-9.]+)\)/);
  if (!match) return color;
  const [, r, g, b, alpha] = match;
  const nextAlpha = Math.max(0.04, Math.min(0.38, Number(alpha) * multiplier));
  return `rgba(${r}, ${g}, ${b}, ${nextAlpha.toFixed(3)})`;
}

function getHeatColor(metric: MetaMetricKey, value: number, min: number, max: number) {
  if (max <= min) return "transparent";
  const normalize = (value - min) / (max - min);
  const direction = METRIC_CONFIG[metric].goodDirection;
  if (direction === "neutral") {
    const alpha = 0.06 + normalize * 0.14;
    return `rgba(148, 163, 184, ${alpha.toFixed(3)})`;
  }
  const score = direction === "low" ? 1 - normalize : normalize;
  if (score >= 0.5) {
    const alpha = 0.08 + ((score - 0.5) / 0.5) * 0.22;
    return `rgba(16, 185, 129, ${alpha.toFixed(3)})`;
  }
  const alpha = 0.08 + ((0.5 - score) / 0.5) * 0.22;
  return `rgba(239, 68, 68, ${alpha.toFixed(3)})`;
}
