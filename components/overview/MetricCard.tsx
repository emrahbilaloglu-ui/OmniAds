"use client";

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuSub,
  DropdownMenuSubContent,
  DropdownMenuSubTrigger,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { Button } from "@/components/ui/button";
import { MiniTrendAreaChart } from "@/components/overview/MiniTrendAreaChart";
import { MetricSourceLogos } from "@/components/overview/MetricSourceLogos";
import { MISSING_VALUE, formatMetricValue as formatMetricByUnit } from "@/lib/metric-format";
import { type ComparisonMode, resolveComparison } from "@/lib/metric-semantics";
import { ArrowDownRight, ArrowUpRight, Minus, MoreHorizontal } from "lucide-react";

export function MetricCard({
  title,
  value,
  changePercent,
  comparisonMode,
  trendData,
  comparisonTrendData,
  trendLoading = false,
  dataSource,
  sourceKey,
  businessId,
  metricKey,
  unit,
  currencySymbol,
  helperText,
  replaceOptions = [],
  onRemove,
  onReplace,
  onViewBreakdown,
  onMoveLeft,
  onMoveRight,
}: {
  title: string;
  value: number | null;
  changePercent: number | null;
  /**
   * Comparison the delta is measured against. When omitted, a null changePercent
   * is still treated as "no comparison" rather than a zero change.
   */
  comparisonMode?: ComparisonMode;
  trendData: Array<{ date: string; value: number }>;
  comparisonTrendData?: Array<{ date: string; value: number }>;
  trendLoading?: boolean;
  dataSource: string;
  sourceKey?: string;
  businessId?: string;
  metricKey: string;
  unit: "currency" | "count" | "ratio" | "percent" | "duration_seconds";
  currencySymbol: string;
  helperText?: string;
  replaceOptions?: Array<{ key: string; title: string }>;
  onRemove?: (metricKey: string) => void;
  onReplace?: (metricKey: string, nextMetricKey: string) => void;
  onViewBreakdown?: (metricKey: string) => void;
  onMoveLeft?: (metricKey: string) => void;
  onMoveRight?: (metricKey: string) => void;
}) {
  const delta = resolveDelta(changePercent, metricKey, comparisonMode);
  const DeltaIcon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;

  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[12px] font-medium uppercase tracking-[0.07em] text-neutral-500">
            {title}
          </p>
          <p className="mt-2 text-[28px] font-semibold leading-none tracking-tight tabular-nums text-neutral-900 md:text-[32px]">
            {formatValue(value, unit, currencySymbol)}
          </p>
          <div className="mt-2.5">
            <span
              className={`inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[12px] font-semibold tabular-nums ${delta.className}`}
              title={delta.title}
              aria-label={delta.srLabel}
            >
              <DeltaIcon className="h-3.5 w-3.5" aria-hidden="true" />
              {delta.label}
            </span>
            {delta.title ? (
              <span className="ml-1.5 text-[12px] text-neutral-500">{delta.title}</span>
            ) : null}
          </div>
        </div>

        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="ghost" size="icon" className="rounded-lg">
              <MoreHorizontal className="h-4 w-4" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-56">
            <DropdownMenuLabel>Metric actions</DropdownMenuLabel>
            {onRemove ? (
              <DropdownMenuItem onClick={() => onRemove(metricKey)}>Remove from Pins</DropdownMenuItem>
            ) : null}
            {replaceOptions.length > 0 && onReplace ? (
              <DropdownMenuSub>
                <DropdownMenuSubTrigger>Change metric</DropdownMenuSubTrigger>
                <DropdownMenuSubContent className="w-56">
                  {replaceOptions.map((option) => (
                    <DropdownMenuItem
                      key={option.key}
                      onClick={() => onReplace(metricKey, option.key)}
                    >
                      {option.title}
                    </DropdownMenuItem>
                  ))}
                </DropdownMenuSubContent>
              </DropdownMenuSub>
            ) : null}
            <DropdownMenuSeparator />
            {onMoveLeft ? (
              <DropdownMenuItem onClick={() => onMoveLeft(metricKey)}>Move left</DropdownMenuItem>
            ) : null}
            {onMoveRight ? (
              <DropdownMenuItem onClick={() => onMoveRight(metricKey)}>Move right</DropdownMenuItem>
            ) : null}
            {onViewBreakdown ? (
              <>
                <DropdownMenuSeparator />
                <DropdownMenuItem onClick={() => onViewBreakdown(metricKey)}>
                  View breakdown
                </DropdownMenuItem>
              </>
            ) : null}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="mt-3">
        <MiniTrendAreaChart
          data={trendData}
          comparisonData={comparisonTrendData}
          label={title}
          unit={unit}
          valueFormatter={(nextValue) => formatValue(nextValue, unit, currencySymbol)}
          loading={trendLoading}
          className="h-12 w-full"
        />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="space-y-1 text-xs">
          {helperText ? <p className="text-neutral-500">{helperText}</p> : null}
        </div>
        <MetricSourceLogos
          sourceKey={sourceKey}
          sourceLabel={dataSource}
          businessId={businessId}
        />
      </div>
    </article>
  );
}

function formatValue(
  value: number | null,
  unit: "currency" | "count" | "ratio" | "percent" | "duration_seconds",
  currencySymbol: string
) {
  return formatMetricByUnit(value, unit, currencySymbol);
}

const NEUTRAL_DELTA_CLASS = "bg-neutral-200/70 text-neutral-600";

/**
 * Turn a change into something renderable.
 *
 * A comparison that does not exist renders as a missing value with no colour,
 * because a fabricated `+0.0%` is indistinguishable from a measured flat period.
 * Colour comes from the metric's business direction, so a cost metric that rose
 * is not painted as a win.
 */
function resolveDelta(
  changePercent: number | null,
  metricKey: string,
  comparisonMode: ComparisonMode | undefined,
) {
  const comparison = resolveComparison({
    metricKey,
    mode: comparisonMode ?? (changePercent == null ? "none" : "previous_period"),
    currentValue: null,
    changePercent,
  });

  if (!comparison.available) {
    return {
      direction: "neutral" as const,
      label: MISSING_VALUE,
      srLabel: "No comparison for the selected period",
      title: "No comparison selected for this period",
      className: NEUTRAL_DELTA_CLASS,
    };
  }

  const percent = comparison.changePercent ?? 0;
  const label = `${percent > 0 ? "+" : ""}${percent.toFixed(1)}%`;
  const className =
    comparison.sentiment === "positive"
      ? "bg-emerald-500/10 text-emerald-600"
      : comparison.sentiment === "negative"
        ? "bg-rose-500/10 text-rose-600"
        : NEUTRAL_DELTA_CLASS;

  return {
    direction: comparison.arrow === "flat" ? ("neutral" as const) : comparison.arrow,
    label,
    srLabel: `${label} ${comparison.basisLabel}`,
    title: comparison.basisLabel,
    className,
  };
}
