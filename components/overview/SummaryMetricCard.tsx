"use client";

import type { OverviewMetricCardData } from "@/src/types/models";
import {
  Activity,
  ArrowDownRight,
  ArrowUpRight,
  BadgeDollarSign,
  ChartLine,
  Clock3,
  Gauge,
  Minus,
  Percent,
  Receipt,
  ShoppingCart,
  Target,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { MiniTrendAreaChart } from "@/components/overview/MiniTrendAreaChart";
import { MetricSourceLogos } from "@/components/overview/MetricSourceLogos";
import { formatMetricValue as formatMetricByUnit } from "@/lib/metric-format";
import { cn } from "@/lib/utils";

const ICONS: Record<string, LucideIcon> = {
  activity: Activity,
  "badge-dollar-sign": BadgeDollarSign,
  "chart-line": ChartLine,
  "clock-3": Clock3,
  gauge: Gauge,
  "line-chart": ChartLine,
  percent: Percent,
  receipt: Receipt,
  "shopping-cart": ShoppingCart,
  target: Target,
  wallet: Wallet,
};

export function SummaryMetricCard({
  metric,
  currencySymbol,
  businessId,
  chartLoading = false,
}: {
  metric: OverviewMetricCardData;
  currencySymbol: string;
  businessId?: string;
  chartLoading?: boolean;
}) {
  const Icon = metric.icon ? ICONS[metric.icon] : null;
  const delta = resolveDelta(
    metric.changePct,
    metric.trendDirection,
    metric.trendSentiment
  );
  const DeltaIcon = delta.direction === "up" ? ArrowUpRight : delta.direction === "down" ? ArrowDownRight : Minus;

  return (
    <article className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-start justify-between gap-3">
        <div className="min-w-0 space-y-1">
          <div className="flex items-center gap-2">
            {Icon ? (
              <span className="inline-flex h-7 w-7 items-center justify-center rounded-lg bg-neutral-100 text-neutral-500">
                <Icon className="h-[15px] w-[15px]" />
              </span>
            ) : null}
            <div className="min-w-0">
              <p className="truncate text-[11px] font-medium uppercase tracking-[0.07em] text-neutral-500">
                {metric.title}
              </p>
              {metric.subtitle ? (
                <p className="truncate text-[11px] text-neutral-500">{metric.subtitle}</p>
              ) : null}
            </div>
          </div>
        </div>
        <span
          className={cn(
            "rounded-full px-2 py-0.5 text-[12px] font-medium capitalize",
            metric.status === "available"
              ? "bg-neutral-100 text-neutral-500"
              : metric.status === "partial"
              ? "bg-amber-50 text-amber-700 border border-amber-200"
              : "hidden"
          )}
        >
          {metric.status}
        </span>
      </div>

      <div className="mt-3.5 flex items-end justify-between gap-3">
        <div className="min-w-0">
          <p className="text-[28px] font-semibold leading-none tracking-tight tabular-nums text-neutral-900 md:text-[30px]">
            {formatMetricValue(metric, currencySymbol)}
          </p>
          <div className="mt-2.5 flex flex-wrap items-center gap-2">
            <span
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] font-semibold tabular-nums",
                delta.className
              )}
            >
              <DeltaIcon className="h-3.5 w-3.5" />
              {delta.label}
            </span>
          </div>
        </div>
      </div>

      <div className="mt-3">
        <MiniTrendAreaChart
          data={metric.sparklineData}
          comparisonData={metric.previousSparklineData}
          tone={metric.trendDirection}
          unit={metric.unit}
          valueFormatter={(value) => formatMetricNumber(value, metric.unit, currencySymbol)}
          className="h-12 w-full"
          loading={chartLoading && metric.sparklineData.length === 0}
        />
      </div>

      <div className="mt-3 flex items-end justify-between gap-3">
        <div className="space-y-1 text-xs">
          {metric.helperText ? <p className="text-neutral-500">{metric.helperText}</p> : null}
        </div>
        <MetricSourceLogos
          sourceKey={metric.dataSource.key}
          sourceLabel={metric.dataSource.label}
          businessId={businessId}
        />
      </div>
    </article>
  );
}

function formatMetricValue(metric: OverviewMetricCardData, currencySymbol: string) {
  if (metric.value === null || Number.isNaN(metric.value)) return "\u2014";
  return formatMetricByUnit(metric.value, metric.unit, currencySymbol);
}

function formatMetricNumber(
  value: number,
  unit: OverviewMetricCardData["unit"],
  currencySymbol: string
) {
  return formatMetricByUnit(value, unit, currencySymbol);
}

/**
 * The delta chip: which way it moved, and whether that is good.
 *
 * These used to be one decision. The chip took `trendDirection` — the
 * arithmetic sign of the change — and painted emerald for up, rose for down.
 * On this card that meant a rising CPA, a rising CPC and a rising refund rate
 * all got the same green treatment as rising revenue: the single thing A-3
 * says must never happen, on the most-read card in the product.
 *
 * The arrow still comes from the arithmetic. The colour comes from what the
 * change means for that particular metric, and an unclassified metric gets the
 * neutral treatment rather than being coloured by its sign.
 */
function resolveDelta(
  changePct: number | null,
  trendDirection: OverviewMetricCardData["trendDirection"],
  trendSentiment: OverviewMetricCardData["trendSentiment"]
) {
  const value = changePct ?? 0;
  const label = `${value > 0 ? "+" : ""}${value.toFixed(1)}%`;
  const direction =
    trendDirection === "up"
      ? ("up" as const)
      : trendDirection === "down"
        ? ("down" as const)
        : ("neutral" as const);

  const className =
    trendSentiment === "positive"
      ? "bg-emerald-500/10 text-emerald-600"
      : trendSentiment === "negative"
        ? "bg-rose-500/10 text-rose-600"
        : "bg-neutral-200/70 text-neutral-600";

  return { direction, label, className };
}
