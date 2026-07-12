import { CheckCircle2, SlidersHorizontal, Target } from "lucide-react";
import type { MetaHealthyEntity } from "@/components/meta/redesign/types";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
import { formatRoas } from "@/lib/briefing/utils";
import { cn } from "@/lib/utils";

interface MetaHealthyRowProps {
  moneyCurrency?: string | null;
  row: MetaHealthyEntity;
  depth?: "root" | "child";
  hideCampaignName?: boolean;
  hideOptimization?: boolean;
  optimizationValueOverride?: string | null;
  bidStrategyValueOverride?: string | null;
  hideBid?: boolean;
  hideBidStrategy?: boolean;
  showBidValue?: boolean;
  showPreviousBid?: boolean;
}

function formatBidValue(
  value: number | null | undefined,
  format: "currency" | "roas" | null | undefined,
  currency: string | null | undefined,
) {
  if (value == null) return null;
  if (format === "roas") return formatRoas(value);
  return formatMoney(value / 100, currency);
}

function formatConfigLabel(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && ["and", "or", "of", "to", "with"].includes(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
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
  className,
  valueClassName,
}: {
  label: string;
  value: string;
  tone?: "slate" | "violet";
  className?: string;
  valueClassName?: string;
}) {
  return (
    <span
      title={`${label}: ${value}`}
      className={cn(
        "inline-flex min-w-0 max-w-[220px] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px]",
        tone === "violet"
          ? "border-violet-200 bg-violet-50 text-violet-700"
          : "border-slate-200 bg-slate-50 text-slate-600",
        className,
      )}
    >
      {tone === "violet" ? (
        <Target className="inline-block shrink-0" size={10} aria-hidden="true" />
      ) : (
        <SlidersHorizontal className="inline-block shrink-0" size={10} aria-hidden="true" />
      )}
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className={cn("truncate font-medium", valueClassName)}>{value}</span>
    </span>
  );
}

function BidConfigChip({ strategy, bid }: { strategy: string | null; bid: string | null }) {
  if (!strategy && !bid) return null;
  const displayValue = [strategy, bid].filter(Boolean).join(" · ");
  return (
    <span
      title={`Bid: ${displayValue}`}
      className="inline-flex min-w-0 max-w-[260px] shrink-0 items-center gap-1 rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] text-slate-600"
    >
      <SlidersHorizontal className="inline-block shrink-0" size={10} aria-hidden="true" />
      <span className="shrink-0 text-slate-400">Bid</span>
      {strategy ? <span className="min-w-0 truncate font-medium text-slate-700">{strategy}</span> : null}
      {bid ? <span className="shrink-0 font-mono font-semibold tabular-nums text-slate-900">{bid}</span> : null}
    </span>
  );
}

export function MetaHealthyRow({
  moneyCurrency,
  row,
  depth = "root",
  hideCampaignName = false,
  hideOptimization = false,
  optimizationValueOverride,
  bidStrategyValueOverride,
  hideBid = false,
  hideBidStrategy = false,
  showBidValue = true,
  showPreviousBid = true,
}: MetaHealthyRowProps) {
  const optimizationValue = optimizationValueOverride ?? (row.isCustomEventTypeMixed
    ? "Mixed events"
    : formatConfigLabel(row.customEventType) ??
      (row.isOptimizationGoalMixed
        ? "Mixed goals"
        : formatConfigLabel(row.optimizationGoal) ?? "Unknown"));
  const bidStrategyValue = bidStrategyValueOverride ?? (row.isBidStrategyMixed
    ? "Mixed strategies"
    : (row.bidStrategyLabel ?? formatConfigLabel(row.bidStrategyType)) ?? "Unknown");
  const currentBidAmount = row.bidValue ?? row.manualBidAmount;
  const previousBidAmount = row.previousBidValue ?? row.previousManualBidAmount;
  const bidValue = showBidValue && row.isBidValueMixed
    ? "Mixed bids"
    : showBidValue
      ? formatBidValue(currentBidAmount, row.bidValueFormat, moneyCurrency)
      : null;
  const previousBidValue = formatBidValue(
    previousBidAmount,
    row.previousBidValueFormat ?? row.bidValueFormat,
    moneyCurrency,
  );
  const previousBidChangedAt = formatChangedAt(row.previousBidValueCapturedAt);
  const hasDifferentPreviousBid =
    previousBidAmount != null &&
    (
      currentBidAmount == null ||
      previousBidAmount !== currentBidAmount ||
      (row.previousBidValueFormat ?? row.bidValueFormat) !== row.bidValueFormat
    );
  const previousBidLabel = showPreviousBid && hasDifferentPreviousBid ? previousBidValue : null;

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
      <div className="hidden min-w-0 max-w-[58%] shrink-0 items-center justify-end gap-1.5 xl:flex" data-healthy-config={row.id}>
        {hideOptimization ? null : (
          <ConfigChip label="Optimization" value={optimizationValue} tone="violet" className="max-w-[210px]" />
        )}
        {hideBid ? null : <BidConfigChip strategy={hideBidStrategy ? null : bidStrategyValue} bid={bidValue} />}
        {previousBidLabel ? (
          <ConfigChip
            label="Prev"
            value={`${previousBidLabel}${previousBidChangedAt ? ` · changed ${previousBidChangedAt}` : ""}`}
            className="max-w-[240px]"
            valueClassName="font-mono tabular-nums"
          />
        ) : null}
      </div>
      <div className="font-mono tabular-nums text-[11.5px] text-slate-600">{formatMoney(row.spend, moneyCurrency)}</div>
      <div className="font-mono tabular-nums text-[11.5px] text-emerald-700">{formatRoas(row.roas)}</div>
    </div>
  );
}
