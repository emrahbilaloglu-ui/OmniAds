"use client";

import type { ReactNode } from "react";

export interface KpiSummaryTile {
  key: string;
  title: string;
  scope?: string;
  value: string;
  unit?: string;
  micro?: ReactNode;
  highlight?: "neutral" | "warn" | "good";
}

interface KpiSummaryTilesProps {
  tiles: KpiSummaryTile[];
  testId?: string;
}

const HIGHLIGHT_STYLES: Record<NonNullable<KpiSummaryTile["highlight"]>, string> = {
  neutral: "border-neutral-200 bg-white",
  warn: "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)]/50",
  good: "border-[var(--adc-pos-bd)] bg-[var(--adc-pos-bg)]/50",
};

export function KpiSummaryTiles({
  tiles,
  testId = "kpi-summary-tiles",
}: KpiSummaryTilesProps) {
  if (tiles.length === 0) return null;
  return (
    <div
      className="grid grid-cols-1 gap-3 sm:grid-cols-2 lg:grid-cols-4"
      data-testid={testId}
    >
      {tiles.map((tile) => (
        <div
          key={tile.key}
          className={
            "rounded-xl border px-3.5 py-3 shadow-[0_1px_2px_rgba(16,21,28,0.04)] " +
            HIGHLIGHT_STYLES[tile.highlight ?? "neutral"]
          }
        >
          <div className="flex items-center justify-between text-[10.5px] uppercase tracking-wider text-neutral-500">
            <span className="font-semibold">{tile.title}</span>
            {tile.scope ? <span className="font-mono normal-case">{tile.scope}</span> : null}
          </div>
          <div className="mt-1 flex items-baseline gap-1">
            <span className="text-[20px] font-bold tabular-nums text-neutral-900">
              {tile.value}
            </span>
            {tile.unit ? (
              <span className="text-[12px] text-neutral-500">{tile.unit}</span>
            ) : null}
          </div>
          {tile.micro ? (
            <div className="mt-1 text-[11px] text-neutral-500">{tile.micro}</div>
          ) : null}
        </div>
      ))}
    </div>
  );
}
