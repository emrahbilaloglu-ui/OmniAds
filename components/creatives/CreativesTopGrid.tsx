"use client";

import { useMemo } from "react";
import { CreativePreview } from "@/components/creatives/CreativePreview";
import { CreativeDecisionLabelBadge } from "@/components/creatives/CreativeDecisionLabelBadge";
import { METRIC_CONFIG, MetaCreativeRow } from "@/components/creatives/metricConfig";
import { getCreativeFormatSummaryLabel } from "@/lib/meta/creative-taxonomy";
import { getCreativeStaticPreviewSources, getCreativeStaticPreviewState } from "@/lib/meta/creatives-preview";
import type {
  DecisionLabel,
  DecisionOutput,
  EngineV3Flags,
} from "@/lib/creative-decision-engine";

interface CreativesTopGridProps {
  rows: MetaCreativeRow[];
  selectedIds: string[];
  onToggleSelect: (rowId: string) => void;
  onOpenRow: (rowId: string) => void;
  v3Decisions?: DecisionOutput[] | null;
  v3Flags?: EngineV3Flags | null;
}

type CreativeRowLike = MetaCreativeRow & {
  cachedThumbnailUrl?: string | null;
  cached_thumbnail_url?: string | null;
  cardPreviewUrl?: string | null;
  card_preview_url?: string | null;
  thumbnailUrl?: string | null;
  thumbnail_url?: string | null;
  imageUrl?: string | null;
  image_url?: string | null;
  previewUrl?: string | null;
  preview_url?: string | null;
  isCatalog?: boolean;
  is_catalog?: boolean;
  preview?: {
    image_url?: string | null;
    poster_url?: string | null;
    is_catalog?: boolean;
  } | null;
};

export function CreativesTopGrid({
  rows,
  selectedIds,
  onToggleSelect,
  onOpenRow,
  v3Decisions = null,
  v3Flags = null,
}: CreativesTopGridProps) {
  const selectedIdSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  const v3SurfaceVisible = Boolean(v3Flags?.enabled && v3Flags.surfaceVisible);
  const decisionLabelByCreativeId = useMemo(() => {
    if (!v3Decisions) return new Map<string, DecisionLabel>();
    return new Map(
      v3Decisions.map((decision) => [decision.creativeId, decision.label]),
    );
  }, [v3Decisions]);

  return (
    <div className="space-y-2">
      <div className="flex items-center justify-between">
        <h2 className="text-sm font-semibold">Selected creatives</h2>
        <p className="text-xs text-muted-foreground">{rows.length} items</p>
      </div>

      <div className="grid gap-3 sm:grid-cols-2 xl:grid-cols-4">
        {rows.map((row) => {
          // Row ids can be grouped UI ids; v3 decisions are keyed by Meta creative id.
          const decisionLabel = row.creativeId
            ? (row.creativeId ? decisionLabelByCreativeId.get(row.creativeId) : undefined) ?? null
            : null;

          return (
            <CreativeCard
              key={row.id}
              row={row as CreativeRowLike}
              selected={selectedIdSet.has(row.id)}
              showDecisionBadge={v3SurfaceVisible}
              decisionLabel={decisionLabel}
              onToggleSelect={onToggleSelect}
              onOpenRow={onOpenRow}
            />
          );
        })}
      </div>
    </div>
  );
}

export function buildPlacementTooltip(row: {
  campaignName?: string | null;
  campaignId?: string | null;
  adSetName?: string | null;
  adSetId?: string | null;
}): string | undefined {
  const parts: string[] = [];
  const campaignName = buyerFacingEntityName(
    row.campaignName,
    row.campaignId,
    "Campaign",
  );
  const adSetName = buyerFacingEntityName(row.adSetName, row.adSetId, "Ad set");
  if (campaignName) parts.push(`Campaign: ${campaignName}`);
  if (adSetName) parts.push(`Ad set: ${adSetName}`);
  if (parts.length === 0) return undefined;
  return parts.join("\n");
}

function buyerFacingEntityName(
  value: string | null | undefined,
  providerId: string | null | undefined,
  entityLabel: "Creative" | "Campaign" | "Ad set",
): string | null {
  const name = value?.trim() ?? "";
  const id = providerId?.trim() ?? "";
  if (!name) return id ? `Unnamed ${entityLabel.toLowerCase()}` : null;
  if (!id) return name;
  const normalizedName = name.toLowerCase();
  const normalizedId = id.toLowerCase();
  if (
    normalizedName === normalizedId ||
    normalizedName === `${entityLabel.toLowerCase()} ${normalizedId}` ||
    normalizedName === `${entityLabel.toLowerCase()} id: ${normalizedId}`
  ) {
    return `Unnamed ${entityLabel.toLowerCase()}`;
  }
  return name;
}

function CreativeCard({
  row,
  selected,
  showDecisionBadge,
  decisionLabel,
  onToggleSelect,
  onOpenRow,
}: {
  row: CreativeRowLike;
  selected: boolean;
  showDecisionBadge: boolean;
  decisionLabel: DecisionLabel | null;
  onToggleSelect: (rowId: string) => void;
  onOpenRow: (rowId: string) => void;
}) {
  const isCatalog = Boolean(row.isCatalog || row.is_catalog || row.preview?.is_catalog);
  const placementTooltip = buildPlacementTooltip(row);
  const rowName =
    buyerFacingEntityName(row.name, row.creativeId ?? row.id, "Creative") ??
    "Unnamed creative";
  const campaignName = buyerFacingEntityName(
    row.campaignName,
    row.campaignId,
    "Campaign",
  );

  const sourcePriority = useMemo(
    () => getCreativeStaticPreviewSources(row, "grid"),
    [row]
  );
  const assetState = getCreativeStaticPreviewState(row, "grid");
  const badgeLabel = getCreativeFormatSummaryLabel({
    creative_delivery_type: row.creativeDeliveryType,
    creative_visual_format: row.creativeVisualFormat,
    creative_primary_type: row.creativePrimaryType,
    creative_primary_label: row.creativePrimaryLabel,
    creative_secondary_type: row.creativeSecondaryType,
    creative_secondary_label: row.creativeSecondaryLabel,
    taxonomy_source: row.taxonomySource ?? null,
  });

  return (
    <div className="group overflow-hidden rounded-xl border bg-background transition-shadow hover:shadow-md hover:ring-1 hover:ring-border">
      <button type="button" onClick={() => onOpenRow(row.id)} className="w-full text-left">
        <div className="relative">
          <CreativePreview
            id={row.id}
            name={rowName}
            cachedUrl={row.cachedThumbnailUrl ?? row.cached_thumbnail_url ?? null}
            imageUrl={
              row.cardPreviewUrl ??
              row.card_preview_url ??
              row.imageUrl ??
              row.image_url ??
              row.preview?.image_url ??
              null
            }
            previewUrl={row.preview?.poster_url ?? row.previewUrl ?? row.preview_url ?? null}
            thumbnailUrl={row.thumbnailUrl ?? row.thumbnail_url ?? null}
            sourcePriority={sourcePriority}
            assetState={assetState}
            format={row.creativeVisualFormat === "video" ? "video" : isCatalog ? "catalog" : "image"}
            isCatalog={isCatalog}
            badgeLabel={badgeLabel}
            pendingLabel="Waiting for Meta"
            size="card"
          />
          {showDecisionBadge && decisionLabel ? (
            <CreativeDecisionLabelBadge
              label={decisionLabel}
              className="absolute right-1.5 top-1.5 z-10"
            />
          ) : null}
        </div>

        <div className="px-3 pb-3 pt-2" title={placementTooltip}>
          <p className="line-clamp-2 text-[12px] font-semibold leading-tight">{rowName}</p>
          {campaignName ? (
            <p className="mt-0.5 line-clamp-1 text-[10px] text-muted-foreground">
              {campaignName}
            </p>
          ) : null}
          <div className="mt-2 flex items-center gap-4 text-[11px]">
            <MetricMini
              label="Spend"
              value={METRIC_CONFIG.spend.format(row.spend, row.currency)}
            />
            <MetricMini label="ROAS" value={METRIC_CONFIG.roas.format(row.roas)} />
          </div>
        </div>
      </button>

      <label className="flex items-center justify-between border-t px-3 py-1.5 text-[11px] text-muted-foreground">
        <span>Selected</span>
        <input
          type="checkbox"
          checked={selected}
          aria-label={`Select ${rowName}`}
          onChange={() => onToggleSelect(row.id)}
          onClick={(event) => event.stopPropagation()}
        />
      </label>
    </div>
  );
}

function MetricMini({ label, value }: { label: string; value: string }) {
  return (
    <div className="min-w-0">
      <p className="text-muted-foreground">{label}</p>
      <p className="font-semibold tabular-nums">{value}</p>
    </div>
  );
}
