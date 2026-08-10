"use client";

import { Play } from "lucide-react";
import type { CSSProperties, ReactNode } from "react";

export type TileShape = "portrait" | "square";
export type TileFormat = "VID" | "IMG" | "CAR";
export type TileVariant = "action" | "watch" | "healthy";

export interface TileMetric {
  key: string;
  label: string;
  value: string;
  tone?: "neutral" | "good" | "warn";
}

interface BriefingTileProps {
  testId?: string;
  laneVariant: TileVariant;
  shape: TileShape;
  format: TileFormat;
  durationLabel?: string;
  chips: ReactNode;
  name: string;
  meta: string;
  why: ReactNode;
  metrics: TileMetric[];
  primaryAction?: ReactNode;
  secondaryActions?: ReactNode;
  selected?: boolean;
  onSelectChange?: (selected: boolean) => void;
  selectLabel?: string;
  deferred?: boolean;
  removing?: boolean;
  borderClass?: string;
  thumbContent?: ReactNode;
  thumbAriaLabel?: string;
}

const SHAPE_DIMENSIONS: Record<TileShape, { width: number; height: number; ratio: string }> = {
  portrait: { width: 90, height: 150, ratio: "9:16" },
  square: { width: 140, height: 140, ratio: "1:1" },
};

const METRIC_TONE_CLASS: Record<NonNullable<TileMetric["tone"]>, string> = {
  neutral: "text-neutral-900",
  good: "text-emerald-700",
  warn: "text-rose-700",
};

export function BriefingTile({
  testId,
  laneVariant,
  shape,
  format,
  durationLabel,
  chips,
  name,
  meta,
  why,
  metrics,
  primaryAction,
  secondaryActions,
  selected = false,
  onSelectChange,
  selectLabel = "Select tile",
  deferred = false,
  removing = false,
  borderClass,
  thumbContent,
  thumbAriaLabel,
}: BriefingTileProps) {
  const dims = SHAPE_DIMENSIONS[shape];
  const fmtLabel = durationLabel ? `${format} · ${durationLabel}` : format;
  const wrapperClasses = [
    "flex flex-col overflow-hidden rounded-xl border bg-white",
    "shadow-[0_1px_2px_rgba(16,21,28,0.04)]",
    "transition-[box-shadow,border-color,transform] duration-150",
    "hover:shadow-md hover:border-neutral-300",
    borderClass ?? "border-neutral-200",
    deferred ? "opacity-60" : "",
    removing ? "opacity-0 -translate-x-4 pointer-events-none" : "",
  ]
    .filter(Boolean)
    .join(" ");

  const shapeStyle: CSSProperties = {
    width: `${dims.width}px`,
    height: `${dims.height}px`,
  };

  return (
    <article
      className={wrapperClasses}
      data-tile-variant={laneVariant}
      data-testid={testId}
    >
      <div className="relative flex h-[170px] items-center justify-center border-b border-neutral-200 bg-neutral-50 p-3.5">
        <span className="absolute left-2.5 top-2.5 rounded border border-neutral-200 bg-white px-1.5 py-0.5 font-mono text-[12px] font-semibold tracking-wider text-neutral-600">
          {fmtLabel}
        </span>
        <button
          type="button"
          role="checkbox"
          aria-checked={selected}
          aria-label={selectLabel}
          onClick={() => onSelectChange?.(!selected)}
          className={
            "absolute right-2.5 top-2.5 inline-flex h-[18px] w-[18px] items-center justify-center rounded " +
            "border focus:outline-none focus-visible:ring-2 focus-visible:ring-blue-500 " +
            (selected
              ? "bg-neutral-900 border-neutral-900 text-white"
              : "border-neutral-300 bg-white text-transparent hover:border-neutral-400")
          }
        >
          {selected ? (
            <span aria-hidden="true" className="text-[12px] font-bold leading-none">
              ✓
            </span>
          ) : null}
        </button>
        <div
          aria-label={thumbAriaLabel ?? `${name} preview`}
          style={shapeStyle}
          className="relative flex items-center justify-center rounded text-white text-xl"
        >
          <div
            className="absolute inset-0 rounded"
            style={{
              background:
                "linear-gradient(135deg, #a3a3a3 0%, #525252 100%)",
              boxShadow: "0 1px 2px rgba(16,21,28,0.08)",
            }}
            aria-hidden="true"
          />
          <div className="relative flex h-full w-full items-center justify-center">
            {thumbContent ??
              (format === "VID" ? (
                <span className="inline-flex h-9 w-9 items-center justify-center rounded-full bg-white text-neutral-900 shadow-md">
                  <Play size={14} aria-hidden="true" fill="currentColor" />
                </span>
              ) : (
                <span className="text-2xl text-white/90" aria-hidden="true">
                  {format === "CAR" ? "▣" : "▭"}
                </span>
              ))}
          </div>
          <span className="absolute bottom-1.5 right-1.5 rounded bg-black/55 px-1 py-px font-mono text-[12px] font-semibold tracking-wider text-white">
            {dims.ratio}
          </span>
        </div>
      </div>

      <div className="flex min-w-0 flex-1 flex-col gap-2 px-4 pb-4 pt-3.5">
        <div className="flex flex-wrap gap-1.5">{chips}</div>
        <div className="truncate text-[14px] font-semibold tracking-tight text-neutral-900">
          {name}
        </div>
        <div className="truncate font-mono text-[12px] text-neutral-500">
          {meta}
        </div>
        <div
          className="rounded-r border-l-[3px] border-neutral-300 bg-neutral-50 px-3 py-2 text-[12px] leading-snug text-neutral-700 line-clamp-2"
          data-tile-why
        >
          {why}
        </div>
        <div className="grid grid-cols-3 overflow-hidden rounded-md border border-neutral-200 bg-neutral-50">
          {metrics.slice(0, 3).map((metric, index) => (
            <div
              key={metric.key}
              className={
                "px-2 py-1.5 " +
                (index < 2 ? "border-r border-neutral-200" : "")
              }
            >
              <span className="block text-[12px] font-semibold uppercase tracking-wider text-neutral-500">
                {metric.label}
              </span>
              <span
                className={
                  "block text-[13px] font-semibold tabular-nums " +
                  METRIC_TONE_CLASS[metric.tone ?? "neutral"]
                }
              >
                {metric.value}
              </span>
            </div>
          ))}
        </div>
        <div className="mt-1 flex items-center justify-between gap-1.5 border-t border-neutral-200 pt-2.5">
          <div className="min-w-0 flex-1">{primaryAction}</div>
          <div className="flex shrink-0 items-center gap-1">{secondaryActions}</div>
        </div>
      </div>
    </article>
  );
}

interface PlacementShapeHint {
  name?: string | null;
  placement?: string | null;
  placementName?: string | null;
  adset?: string | null;
  adsetName?: string | null;
}

export function deriveTileShape(card: {
  bestPlacement?: string | null;
  placementList?: ReadonlyArray<PlacementShapeHint | null> | null;
}): TileShape {
  const candidates: string[] = [];
  if (typeof card.bestPlacement === "string") candidates.push(card.bestPlacement);
  for (const placement of card.placementList ?? []) {
    if (!placement) continue;
    if (typeof placement.name === "string") candidates.push(placement.name);
    if (typeof placement.placement === "string") candidates.push(placement.placement);
    if (typeof placement.placementName === "string")
      candidates.push(placement.placementName);
    if (typeof placement.adset === "string") candidates.push(placement.adset);
    if (typeof placement.adsetName === "string") candidates.push(placement.adsetName);
  }
  const lower = candidates.map((value) => value.toLowerCase());
  if (
    lower.some(
      (value) =>
        value.includes("reels") ||
        value.includes("story") ||
        value.includes("stories"),
    )
  ) {
    return "portrait";
  }
  return "square";
}

export function deriveTileFormat(card: {
  primary?: { kind?: string | null } | null;
  placements?: number | null;
}): TileFormat {
  if ((card.placements ?? 0) > 1) return "CAR";
  return "IMG";
}
