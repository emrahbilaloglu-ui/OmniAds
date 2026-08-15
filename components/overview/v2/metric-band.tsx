"use client";

import {
  ArrowDownRight,
  ArrowUpRight,
  BadgeDollarSign,
  Minus,
  Receipt,
  ShoppingCart,
  Target,
  Wallet,
  type LucideIcon,
} from "lucide-react";
import { EXACT_METRIC_FORMAT, formatMetricValue } from "@/lib/metric-format";
import type { OverviewMetricCardData } from "@/src/types/models";
import { AdvSparkline } from "./adv-sparkline";

/**
 * Design decision D6: one primary KPI band replaces the six-equal-card wall —
 * a full-bleed accent hero for the headline metric plus four supporting tiles.
 */

const TILE_TONES = [
  { bg: "var(--adv-rail)", line: "#0B1020", fill: "rgba(11,16,32,0.07)" },
  { bg: "var(--adc-pos-fg)", line: "#0E9F6E", fill: "rgba(14,159,110,0.09)" },
  { bg: "var(--adc-auto-fg)", line: "#6C41BE", fill: "rgba(108,65,190,0.08)" },
  { bg: "var(--adc-caution-fg)", line: "#B45309", fill: "rgba(180,83,9,0.08)" },
] as const;

const TILE_ICONS: LucideIcon[] = [Receipt, Target, ShoppingCart, Wallet];

export function DeltaChip({
  metric,
  tone = "solid",
}: {
  metric: OverviewMetricCardData;
  tone?: "solid" | "hero";
}) {
  if (metric.changePct === null || !Number.isFinite(metric.changePct)) {
    return (
      <span className="adv-chip" data-tone={tone === "hero" ? undefined : "neutral"}>
        —
      </span>
    );
  }
  const direction = metric.trendDirection;
  const Icon =
    direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  const label = `${metric.changePct > 0 ? "+" : ""}${metric.changePct.toFixed(1)}%`;

  if (tone === "hero") {
    return (
      <span
        className="inline-flex items-center gap-1 rounded-full px-[9px] py-[3px] text-[12px] font-semibold tabular-nums"
        style={{ background: "rgba(255,255,255,0.16)" }}
      >
        <Icon className="h-3 w-3" strokeWidth={2.2} aria-hidden="true" />
        {label}
      </span>
    );
  }

  return (
    <span
      className="adv-chip"
      data-tone={direction === "up" ? "pos" : direction === "down" ? "neg" : undefined}
    >
      {label}
    </span>
  );
}

/**
 * The band prints the short metric name only — the catalog's subtitle is a
 * sentence-length description, and inlining it blows the design's one-line
 * label out to two or three wrapped lines. It stays available as the tooltip.
 */
function metricLabel(metric: OverviewMetricCardData) {
  return metric.title;
}

export function HeroMetricCard({
  metric,
  currencySymbol,
}: {
  metric: OverviewMetricCardData;
  currencySymbol: string;
}) {
  const format = (value: number) => formatMetricValue(value, metric.unit, currencySymbol, EXACT_METRIC_FORMAT);
  return (
    <article
      className="flex min-w-0 flex-col justify-between rounded-[var(--adv-r-card)] p-5 text-white sm:col-span-2"
      style={{ background: "var(--adv-accent)", minHeight: 170 }}
    >
      <div className="flex items-center justify-between">
        <p
          className="adv-mono m-0 truncate text-[10.5px] uppercase tracking-[0.12em]"
          style={{ color: "rgba(255,255,255,0.75)" }}
          title={metric.subtitle}
        >
          {metricLabel(metric)}
        </p>
        <DeltaChip metric={metric} tone="hero" />
      </div>
      <p
        className="m-0 mt-2.5 text-[42px] font-bold leading-none tabular-nums"
        style={{ fontFamily: "var(--adv-font-display)", letterSpacing: "-0.03em" }}
      >
        {metric.value === null ? "—" : format(metric.value)}
      </p>
      <div className="mt-3">
        <AdvSparkline
          points={metric.sparklineData}
          previousPoints={metric.previousSparklineData}
          line="#ffffff"
          fill="rgba(255,255,255,0.14)"
          height={44}
          strokeWidth={1.6}
          tone="light"
          format={format}
          ariaLabel={`${metric.title} trend`}
        />
      </div>
    </article>
  );
}

export function HeroTile({
  metric,
  currencySymbol,
  index,
}: {
  metric: OverviewMetricCardData;
  currencySymbol: string;
  index: number;
}) {
  const tone = TILE_TONES[index % TILE_TONES.length]!;
  const Icon = TILE_ICONS[index % TILE_ICONS.length] ?? BadgeDollarSign;
  const format = (value: number) => formatMetricValue(value, metric.unit, currencySymbol, EXACT_METRIC_FORMAT);

  return (
    <article className="adv-card flex min-w-0 flex-col justify-between p-4">
      <div className="flex items-center justify-between gap-2">
        <span
          className="grid h-[30px] w-[30px] place-items-center rounded-[9px] text-white"
          style={{ background: tone.bg }}
        >
          <Icon className="h-[15px] w-[15px]" strokeWidth={2} aria-hidden="true" />
        </span>
        <DeltaChip metric={metric} />
      </div>
      <div className="mt-3.5">
        <p
          className="adv-num m-0 text-[26px] font-bold leading-none"
          style={{ fontFamily: "var(--adv-font-display)" }}
        >
          {metric.value === null ? "—" : format(metric.value)}
        </p>
        <p
          className="m-0 mt-1.5 truncate text-[12px] font-medium text-[var(--adv-ink-3)]"
          title={metric.subtitle}
        >
          {metricLabel(metric)}
        </p>
      </div>
      <div className="mt-3">
        <AdvSparkline
          points={metric.sparklineData}
          previousPoints={metric.previousSparklineData}
          line={tone.line}
          fill={tone.fill}
          height={38}
          format={format}
          ariaLabel={`${metric.title} trend`}
        />
      </div>
    </article>
  );
}

/** Compact bordered tile used by the Store / Web analytics sections. */
export function StatTile({
  metric,
  currencySymbol,
}: {
  metric: OverviewMetricCardData;
  currencySymbol: string;
}) {
  const format = (value: number) => formatMetricValue(value, metric.unit, currencySymbol, EXACT_METRIC_FORMAT);
  const direction = metric.trendDirection;
  const deltaColor =
    direction === "up"
      ? "var(--adc-pos-fg)"
      : direction === "down"
        ? "var(--adc-danger-fg)"
        : "var(--adv-ink-3)";
  return (
    <div className="adv-tile">
      <p className="adv-label truncate" title={metric.subtitle}>
        {metricLabel(metric)}
      </p>
      <p
        className="adv-num m-0 mt-1.5 whitespace-nowrap text-[19px] font-semibold"
        style={{ fontFamily: "var(--adv-font-display)" }}
      >
        {metric.value === null ? "—" : format(metric.value)}
      </p>
      <p className="m-0 mt-1 text-[11px] font-semibold" style={{ color: deltaColor }}>
        {metric.changePct === null || !Number.isFinite(metric.changePct)
          ? "—"
          : `${metric.changePct > 0 ? "+" : ""}${metric.changePct.toFixed(1)}%`}
      </p>
      <div className="mt-2">
        <AdvSparkline
          points={metric.sparklineData}
          previousPoints={metric.previousSparklineData}
          line={
            direction === "down" ? "#E11D48" : direction === "up" ? "#0E9F6E" : "#2F6BFF"
          }
          fill={
            direction === "down"
              ? "rgba(225,29,72,0.08)"
              : direction === "up"
                ? "rgba(14,159,110,0.09)"
                : "rgba(47,107,255,0.08)"
          }
          height={26}
          format={format}
          ariaLabel={`${metric.title} trend`}
        />
      </div>
    </div>
  );
}
