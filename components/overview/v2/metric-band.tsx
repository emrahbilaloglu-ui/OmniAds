"use client";

import { ArrowDownRight, ArrowUpRight, Minus } from "lucide-react";
import type { OverviewMetricCardData } from "@/src/types/models";
import { AdvSparkline } from "./adv-sparkline";
import { formatOverviewDelta, formatOverviewMetricValue, formatOverviewSparklineValue } from "./metric-format";

/**
 * Design decision D6: one primary KPI band replaces the six-equal-card wall —
 * a full-bleed accent hero for the headline metric plus four supporting tiles.
 */

const TILE_TONES = [
  {
    bg: "#0B1020",
    line: "#0B1020",
    fill: "rgba(11,16,32,0.07)",
    delta: "info",
  },
  {
    bg: "#0b7954",
    line: "#0b7954",
    fill: "rgba(14,159,110,0.09)",
    delta: "pos",
  },
  {
    bg: "#6C41BE",
    line: "#6C41BE",
    fill: "rgba(108,65,190,0.08)",
    delta: "pos",
  },
  { bg: "#B45309", line: "#B45309", fill: "rgba(180,83,9,0.08)", delta: "neg" },
] as const;

const TILE_ICON_PATHS = [
  "M4 2v20l2-1 2 1 2-1 2 1 2-1 2 1 2-1 2 1V2l-2 1-2-1-2 1-2-1-2 1-2-1-2 1z M8 7h8 M8 11h8 M8 15h5",
  "M12 22a10 10 0 1 0 0-20 10 10 0 0 0 0 20z M12 18a6 6 0 1 0 0-12 6 6 0 0 0 0 12z M12 14a2 2 0 1 0 0-4 2 2 0 0 0 0 4z",
  "M8 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M19 21a1 1 0 1 0 0-2 1 1 0 0 0 0 2z M2.05 2.05h2l2.66 12.42a2 2 0 0 0 2 1.58h9.78a2 2 0 0 0 1.95-1.57l1.65-7.43H5.12",
  "M19 5L5 19 M6.5 9a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z M17.5 20a2.5 2.5 0 1 0 0-5 2.5 2.5 0 0 0 0 5z",
] as const;

type DeltaTone = "pos" | "neg" | "info" | "neutral";

const DELTA_COLORS: Record<DeltaTone, { background: string; color: string }> = {
  pos: { background: "#E7F6F0", color: "#0b7954" },
  neg: { background: "#FDECF0", color: "#E11D48" },
  info: { background: "#EAF0FF", color: "#2a5fe2" },
  neutral: { background: "#F1F4F9", color: "#555d6d" },
};

export function DeltaChip({
  metric,
  tone = "solid",
  colorTone,
}: {
  metric: OverviewMetricCardData;
  tone?: "solid" | "hero";
  colorTone?: DeltaTone;
}) {
  if (metric.changePct === null || !Number.isFinite(metric.changePct)) {
    if (tone === "hero") {
      return (
        <span
          className="inline-flex items-center rounded-full px-[9px] py-[3px] text-[12px] font-semibold tabular-nums"
          style={{ background: "rgba(255,255,255,0.16)" }}
        >
          —
        </span>
      );
    }
    return (
      <span
        className="inline-flex items-center gap-[3px] rounded-full px-2 py-0.5 text-[11.5px] font-semibold tabular-nums"
        style={DELTA_COLORS.neutral}
      >
        —
      </span>
    );
  }
  const direction = metric.trendDirection;
  const Icon = direction === "up" ? ArrowUpRight : direction === "down" ? ArrowDownRight : Minus;
  const label = formatOverviewDelta(metric.changePct);

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

  const resolvedTone =
    colorTone ??
    (metric.trendSentiment === "positive" ? "pos" : metric.trendSentiment === "negative" ? "neg" : "neutral");

  return (
    <span
      className="inline-flex items-center gap-[3px] rounded-full px-2 py-0.5 text-[11.5px] font-semibold tabular-nums"
      style={DELTA_COLORS[resolvedTone]}
    >
      {label}
    </span>
  );
}

/** The canonical band prints only the short metric name. */
function metricLabel(metric: OverviewMetricCardData) {
  return metric.title;
}

export function HeroMetricCard({ metric, currencySymbol }: { metric: OverviewMetricCardData; currencySymbol: string }) {
  const format = (value: number) => formatOverviewSparklineValue(metric, value, currencySymbol);
  return (
    <article
      data-overview-metric-id={metric.id}
      className="flex min-w-0 flex-col justify-between rounded-[var(--adv-r-card)] p-5 text-white sm:col-span-2"
      style={{ background: "var(--adv-accent)", minHeight: 170 }}
    >
      <div className="flex items-center justify-between">
        <p
          className="adv-mono m-0 truncate text-[10.5px] uppercase tracking-[0.12em]"
          style={{ color: "rgba(255,255,255,0.75)" }}
        >
          {metricLabel(metric)}
        </p>
        <DeltaChip metric={metric} tone="hero" />
      </div>
      <p
        className="m-0 mt-2.5 text-[42px] font-bold leading-none tabular-nums"
        style={{
          fontFamily: "var(--adv-font-display)",
          letterSpacing: "-0.03em",
        }}
      >
        {formatOverviewMetricValue(metric, metric.value, currencySymbol)}
      </p>
      <AdvSparkline
        points={metric.sparklineData}
        previousPoints={metric.previousSparklineData}
        line="#ffffff"
        fill="rgba(255,255,255,0.14)"
        height={44}
        strokeWidth={1.6}
        tone="light"
        variant="hero"
        format={format}
        ariaLabel={`${metric.title} trend`}
        marginTop={12}
      />
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
  const iconPath = TILE_ICON_PATHS[index % TILE_ICON_PATHS.length] ?? TILE_ICON_PATHS[0];
  const format = (value: number) => formatOverviewSparklineValue(metric, value, currencySymbol);

  return (
    <article data-overview-metric-id={metric.id} className="adv-card flex min-w-0 flex-col justify-between p-4">
      <div className="flex items-center justify-between gap-2">
        <span
          className="grid h-[30px] w-[30px] place-items-center rounded-[9px] text-white"
          style={{ background: tone.bg }}
        >
          <svg
            aria-hidden="true"
            viewBox="0 0 24 24"
            fill="none"
            stroke="currentColor"
            strokeWidth={2}
            strokeLinecap="round"
            strokeLinejoin="round"
            className="h-[15px] w-[15px]"
          >
            <path d={iconPath} />
          </svg>
        </span>
        <DeltaChip metric={metric} colorTone={tone.delta} />
      </div>
      <div className="mt-3.5">
        <p className="adv-num m-0 text-[26px] font-bold leading-none" style={{ fontFamily: "var(--adv-font-display)" }}>
          {formatOverviewMetricValue(metric, metric.value, currencySymbol)}
        </p>
        <p className="m-0 mt-1.5 truncate text-[12px] font-medium text-[var(--adv-ink-3)]">{metricLabel(metric)}</p>
      </div>
      <AdvSparkline
        points={metric.sparklineData}
        previousPoints={metric.previousSparklineData}
        line={tone.line}
        fill={tone.fill}
        height={38}
        variant="tile"
        format={format}
        ariaLabel={`${metric.title} trend`}
        marginTop={12}
      />
    </article>
  );
}

/** Compact bordered tile used by the Store / Web analytics sections. */
export function StatTile({
  metric,
  currencySymbol,
  line = "#2a5fe2",
  fill = "rgba(47,107,255,0.08)",
}: {
  metric: OverviewMetricCardData;
  currencySymbol: string;
  line?: string;
  fill?: string;
}) {
  const format = (value: number) => formatOverviewSparklineValue(metric, value, currencySymbol);
  const deltaColor =
    metric.trendSentiment === "positive" ? "#0b7954" : metric.trendSentiment === "negative" ? "#E11D48" : "#555d6d";
  return (
    <div className="adv-tile" data-overview-metric-id={metric.id}>
      <p
        className="m-0 truncate text-[9px] uppercase tracking-[0.08em] text-[#555d6d]"
        style={{ fontFamily: "var(--adv-font-mono)" }}
      >
        {metricLabel(metric)}
      </p>
      <p
        className="m-0 mt-1.5 whitespace-nowrap text-[19px] font-semibold tabular-nums text-[#0E1526]"
        style={{
          fontFamily: "var(--adv-font-display)",
          letterSpacing: "normal",
        }}
      >
        {formatOverviewMetricValue(metric, metric.value, currencySymbol)}
      </p>
      <p className="m-0 mt-1 text-[11px] font-semibold" style={{ color: deltaColor }}>
        {metric.changePct === null || !Number.isFinite(metric.changePct) ? "—" : formatOverviewDelta(metric.changePct)}
      </p>
      <AdvSparkline
        points={metric.sparklineData}
        previousPoints={metric.previousSparklineData}
        line={line}
        fill={fill}
        height={26}
        variant="compact"
        format={format}
        ariaLabel={`${metric.title} trend`}
        marginTop={8}
      />
    </div>
  );
}
