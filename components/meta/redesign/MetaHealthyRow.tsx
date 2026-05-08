import { CheckCircle2, SlidersHorizontal, Target } from "lucide-react";
import type { MetaHealthyEntity } from "@/components/meta/redesign/types";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";
import { cn } from "@/lib/utils";

interface MetaHealthyRowProps {
  row: MetaHealthyEntity;
  depth?: "root" | "child";
  hideCampaignName?: boolean;
}

function formatBidValue(value: number | null | undefined, format: "currency" | "roas" | null | undefined) {
  if (value == null) return null;
  if (format === "roas") return formatRoas(value);
  return formatCurrency(value / 100);
}

function formatConfigLabel(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function formatChangedAt(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  }).format(date);
}

function ConfigChip({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string;
  tone?: "slate" | "violet";
}) {
  return (
    <span
      className={cn(
        "inline-flex min-w-0 items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px]",
        tone === "violet"
          ? "border-violet-200 bg-violet-50 text-violet-700"
          : "border-slate-200 bg-slate-50 text-slate-600",
      )}
    >
      {tone === "violet" ? (
        <Target className="inline-block shrink-0" size={10} aria-hidden="true" />
      ) : (
        <SlidersHorizontal className="inline-block shrink-0" size={10} aria-hidden="true" />
      )}
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </span>
  );
}

export function MetaHealthyRow({ row, depth = "root", hideCampaignName = false }: MetaHealthyRowProps) {
  const optimizationValue = row.isOptimizationGoalMixed
    ? "Mixed goals"
    : formatConfigLabel(row.optimizationGoal) ?? "Unknown";
  const bidStrategyValue = row.isBidStrategyMixed
    ? "Mixed strategies"
    : (row.bidStrategyLabel ?? formatConfigLabel(row.bidStrategyType)) ?? "Unknown";
  const currentBidAmount = row.bidValue ?? row.manualBidAmount;
  const previousBidAmount = row.previousBidValue ?? row.previousManualBidAmount;
  const bidValue = row.isBidValueMixed
    ? "Mixed bids"
    : formatBidValue(currentBidAmount, row.bidValueFormat);
  const previousBidValue = formatBidValue(
    previousBidAmount,
    row.previousBidValueFormat ?? row.bidValueFormat,
  );
  const previousBidChangedAt = formatChangedAt(row.previousBidValueCapturedAt);

  return (
    <div
      className={cn(
        "flex items-center gap-3 rounded-lg border border-slate-200 bg-white px-3 py-2",
        depth === "child" ? "shadow-[0_1px_1px_rgba(15,23,42,0.03)]" : "",
      )}
      data-healthy-row={row.id}
      data-healthy-level={row.level}
      data-healthy-depth={depth}
    >
      <CheckCircle2 className="inline-block shrink-0 text-emerald-600" size={15} aria-hidden="true" />
      <MetaScopeChip level={row.level} />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-slate-900">{row.name}</div>
        {!hideCampaignName && row.campaignName ? <div className="truncate text-[11px] text-slate-500">{row.campaignName}</div> : null}
      </div>
      <div className="hidden min-w-0 flex-1 items-center gap-1.5 xl:flex" data-healthy-config={row.id}>
        <ConfigChip label="Optimization" value={optimizationValue} tone="violet" />
        <ConfigChip label="Bid" value={bidValue ? `${bidStrategyValue} · ${bidValue}` : bidStrategyValue} />
        {previousBidValue ? (
          <ConfigChip
            label="Prev"
            value={`${previousBidValue}${previousBidChangedAt ? ` · changed ${previousBidChangedAt}` : ""}`}
          />
        ) : null}
      </div>
      <div className="font-mono tabular-nums text-[11.5px] text-slate-600">{formatCurrency(row.spend)}</div>
      <div className="font-mono tabular-nums text-[11.5px] text-emerald-700">{formatRoas(row.roas)}</div>
    </div>
  );
}
