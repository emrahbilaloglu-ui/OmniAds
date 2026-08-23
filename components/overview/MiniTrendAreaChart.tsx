"use client";

import React, { useMemo, useState } from "react";
import type { PointerEvent } from "react";
import {
  normalizePercentSeries,
  resolveChartDomain,
  type ChartDomainMode,
} from "@/lib/chart-domain";
import type { OverviewMetricCardData } from "@/src/types/models";

const CHART_WIDTH = 160;
const CHART_HEIGHT = 52;
const PLOT_LEFT = 2;
const PLOT_RIGHT = 2;
const PLOT_TOP = 4;
const PLOT_BOTTOM = 4;

type ChartUnit = OverviewMetricCardData["unit"] | "unknown";
type DateLabelMode = "auto" | "day" | "month";

// Cardinal spline — veri bozulmadan görsel yuvarlama
function createSmoothPath(pts: Array<{ x: number; y: number }>) {
  if (pts.length === 0) return "";
  if (pts.length === 1) return `M ${pts[0].x} ${pts[0].y}`;

  const tension = 0.3;
  let path = `M ${pts[0].x} ${pts[0].y}`;

  for (let i = 0; i < pts.length - 1; i++) {
    const p0 = pts[Math.max(0, i - 1)];
    const p1 = pts[i];
    const p2 = pts[i + 1];
    const p3 = pts[Math.min(pts.length - 1, i + 2)];
    const cp1x = p1.x + (p2.x - p0.x) * tension;
    const cp1y = p1.y + (p2.y - p0.y) * tension;
    const cp2x = p2.x - (p3.x - p1.x) * tension;
    const cp2y = p2.y - (p3.y - p1.y) * tension;
    path += ` C ${cp1x.toFixed(2)} ${cp1y.toFixed(2)} ${cp2x.toFixed(2)} ${cp2y.toFixed(2)} ${p2.x.toFixed(2)} ${p2.y.toFixed(2)}`;
  }
  return path;
}

function toPoints(
  data: Array<{ date: string; value: number }>,
  unit: ChartUnit,
  domain: { min: number; max: number }
) {
  if (data.length < 2) return [];

  const inputValues = data.map((p) => (Number.isFinite(p.value) ? p.value : 0));
  const values = unit === "percent" ? normalizePercentSeries(inputValues) : inputValues;

  const min = domain.min;
  const max = domain.max;
  const range = max - min || 1;
  const plotWidth = CHART_WIDTH - PLOT_LEFT - PLOT_RIGHT;
  const plotHeight = CHART_HEIGHT - PLOT_TOP - PLOT_BOTTOM;

  return data.map((item, index) => {
    const x = PLOT_LEFT + (index / Math.max(data.length - 1, 1)) * plotWidth;
    const clamped = Math.min(Math.max(values[index], min), max);
    const y = PLOT_TOP + (1 - (clamped - min) / range) * plotHeight;
    return { x, y, value: values[index], date: item.date, index };
  });
}

function formatPointLabel(value: string, mode: DateLabelMode = "auto") {
  if (/^\d{4}-\d{2}-\d{2}$/.test(value)) {
    const date = new Date(`${value}T00:00:00Z`);
    if (!Number.isNaN(date.getTime())) {
      if (mode === "month") {
        return new Intl.DateTimeFormat("en-US", { month: "short", year: "numeric" }).format(date);
      }
      if (mode === "day") {
        return new Intl.DateTimeFormat("en-US", { month: "short", day: "numeric" }).format(date);
      }
      return new Intl.DateTimeFormat("en-US", {
        month: "short",
        day: "numeric",
        year: "numeric",
      }).format(date);
    }
  }
  return value;
}

function formatCompactValue(value: number) {
  if (Number.isNaN(value)) return "—";
  if (Math.abs(value) >= 1_000_000) return `${(value / 1_000_000).toFixed(1)}M`;
  if (Math.abs(value) >= 1_000) return `${(value / 1_000).toFixed(1)}K`;
  if (Number.isInteger(value)) return String(value);
  return value.toFixed(2);
}

export function MiniTrendAreaChart({
  data,
  label,
  unit = "unknown",
  loading = false,
  className = "h-12 w-full",
  valueFormatter,
  dateLabelMode = "auto",
  domainMode = "adaptive",
  comparisonData,
}: {
  data: Array<{ date: string; value: number }>;
  /**
   * Historical prop from the Google Ads tiles. It is deliberately not read:
   * the line is neutral for every metric, so there is nothing to colour from.
   * Kept in the type only so those call sites keep compiling; new callers
   * should pass `label` instead.
   */
  tone?: OverviewMetricCardData["trendDirection"];
  /**
   * What this line is of. Carries the accessible name: "a chart" tells a
   * screen-reader user nothing about which metric they are on.
   */
  label?: string;
  unit?: ChartUnit;
  loading?: boolean;
  className?: string;
  valueFormatter?: (value: number) => string;
  dateLabelMode?: DateLabelMode;
  domainMode?: ChartDomainMode;
  comparisonData?: Array<{ date: string; value: number }>;
}) {
  const [hoverIndex, setHoverIndex] = useState<number | null>(null);

  const domain = useMemo(() => {
    const inputValues = data.map((p) => (Number.isFinite(p.value) ? p.value : 0));
    const primary = unit === "percent" ? normalizePercentSeries(inputValues) : inputValues;

    // Domain, comparison dahil tüm değerlerden hesaplanır → her iki çizgi aynı ölçekte
    let allValues = primary;
    if (comparisonData && comparisonData.length > 0) {
      const cmpRaw = comparisonData.map((p) => (Number.isFinite(p.value) ? p.value : 0));
      const cmp = unit === "percent" ? normalizePercentSeries(cmpRaw) : cmpRaw;
      allValues = [...primary, ...cmp];
    }

    return resolveChartDomain(allValues, { unit, mode: domainMode, detailLevel: "sparkline" });
  }, [data, comparisonData, unit, domainMode]);

  const points = useMemo(() => toPoints(data, unit, domain), [data, unit, domain]);

  const comparisonPoints = useMemo(
    () =>
      comparisonData && comparisonData.length >= 2 ? toPoints(comparisonData, unit, domain) : [],
    [comparisonData, unit, domain]
  );

  if (loading) {
    return <div className={`animate-pulse rounded-lg bg-neutral-100 ${className}`} />;
  }

  if (!data || data.length < 2 || points.length < 2) {
    // An empty box reads as a flat line to a sighted user and as nothing at
    // all to everyone else.
    return (
      <div className={`${className} flex items-center text-[12px] text-neutral-600`}>
        No trend data
      </div>
    );
  }

  const activeIndex = hoverIndex ?? points.length - 1;
  const activePoint = points[activeIndex];

  // Comparison: pozisyon oranına göre index-aligned (tarih eşleşmesi aranmaz)
  const activeCmpIndex =
    comparisonPoints.length > 0
      ? Math.round(
          (activeIndex / Math.max(points.length - 1, 1)) *
            Math.max(comparisonPoints.length - 1, 0)
        )
      : null;
  const activeCmpPoint = activeCmpIndex !== null ? comparisonPoints[activeCmpIndex] : null;

  const linePath = createSmoothPath(points);
  const compLinePath = comparisonPoints.length >= 2 ? createSmoothPath(comparisonPoints) : null;

  const activeLabel = formatPointLabel(activePoint.date, dateLabelMode);
  const formattedValue = valueFormatter
    ? valueFormatter(activePoint.value)
    : formatCompactValue(activePoint.value);
  const formattedCmpValue =
    activeCmpPoint && valueFormatter
      ? valueFormatter(activeCmpPoint.value)
      : activeCmpPoint
        ? formatCompactValue(activeCmpPoint.value)
        : null;

  const handlePointerMove = (event: PointerEvent<SVGSVGElement>) => {
    const bounds = event.currentTarget.getBoundingClientRect();
    if (!bounds.width) return;
    const x = ((event.clientX - bounds.left) / bounds.width) * CHART_WIDTH;
    const nextIndex = points.reduce((best, pt, idx, arr) => {
      return Math.abs(arr[best].x - x) <= Math.abs(pt.x - x) ? best : idx;
    }, 0);
    setHoverIndex(nextIndex);
  };

  const xPercent = (activePoint.x / CHART_WIDTH) * 100;
  const tooltipStyle: React.CSSProperties =
    xPercent > 65
      ? { right: 0 }
      : xPercent < 15
        ? { left: 0 }
        : { left: `${xPercent}%`, transform: "translateX(-50%)" };

  const gradientId = `spark-line-${unit}`;

  /**
   * What a screen reader is told, and what a keyboard user moves through.
   *
   * The SVG was `aria-hidden` and the only way to read a point was a pointer
   * tooltip, so the trend did not exist for anyone not using a mouse. The
   * summary states arithmetic — first, last, lowest, highest — and no verdict,
   * because the chart has no basis for one.
   */
  const chartName = label && label.trim() ? label : "Trend";
  const fmt = (value: number) =>
    valueFormatter ? valueFormatter(value) : formatCompactValue(value);
  const first = points[0];
  const last = points[points.length - 1];
  const lowest = points.reduce((a, b) => (b.value < a.value ? b : a), points[0]);
  const highest = points.reduce((a, b) => (b.value > a.value ? b : a), points[0]);
  const accessibleSummary =
    `${chartName} over ${points.length} points. ` +
    `Starts ${fmt(first.value)} on ${formatPointLabel(first.date, dateLabelMode)}, ` +
    `ends ${fmt(last.value)} on ${formatPointLabel(last.date, dateLabelMode)}. ` +
    `Lowest ${fmt(lowest.value)}, highest ${fmt(highest.value)}.` +
    (comparisonPoints.length >= 2
      ? " A dashed line shows the previous period for comparison."
      : "");

  const handleKeyDown = (event: React.KeyboardEvent<HTMLDivElement>) => {
    if (event.key === "ArrowRight" || event.key === "ArrowLeft") {
      event.preventDefault();
      const step = event.key === "ArrowRight" ? 1 : -1;
      const base = hoverIndex ?? points.length - 1;
      const next = Math.min(points.length - 1, Math.max(0, base + step));
      setHoverIndex(next);
      return;
    }
    if (event.key === "Home") {
      event.preventDefault();
      setHoverIndex(0);
      return;
    }
    if (event.key === "End") {
      event.preventDefault();
      setHoverIndex(points.length - 1);
      return;
    }
    if (event.key === "Escape") setHoverIndex(null);
  };

  return (
    <div
      className="relative overflow-visible"
      role="group"
      tabIndex={0}
      aria-label={accessibleSummary}
      data-mini-trend-chart="true"
      // Which point is being read, exposed so a browser test can prove an
      // Arrow key moved the reading rather than merely being accepted. The
      // sr-only live region carries the same fact for a screen reader; this
      // is the machine-checkable form of it.
      data-active-point={hoverIndex === null ? "none" : String(hoverIndex)}
      onKeyDown={handleKeyDown}
      onBlur={() => setHoverIndex(null)}
    >
      {/*
        The tooltip's content, always in the accessibility tree. A hover-only
        readout is unreachable by keyboard and invisible to a screen reader,
        and this is the only place the individual values are stated.
      */}
      <span className="sr-only" data-chart-summary="true">
        {accessibleSummary} Data points:{" "}
        {points.map((point) => `${point.date}: ${fmt(point.value)}`).join("; ")}.
      </span>
      <span aria-live="polite" className="sr-only">
        {hoverIndex !== null
          ? `${formatPointLabel(points[hoverIndex].date, dateLabelMode)}: ${fmt(points[hoverIndex].value)}`
          : ""}
      </span>
      {hoverIndex !== null ? (
        <div
          className="pointer-events-none absolute bottom-full z-20 mb-1.5 min-w-[7rem] rounded-md border border-neutral-200 bg-white/95 px-2.5 py-1.5 text-[12px] shadow-md shadow-neutral-200/70 backdrop-blur-sm"
          style={tooltipStyle}
        >
          <p className="font-medium text-neutral-500">{activeLabel}</p>
          <p className="mt-0.5 font-semibold text-neutral-950">{formattedValue}</p>
          {formattedCmpValue ? (
            <p className="mt-0.5 text-neutral-400">
              <span className="mr-1">vs</span>
              {formattedCmpValue}
            </p>
          ) : null}
        </div>
      ) : null}

      <svg
        viewBox={`0 0 ${CHART_WIDTH} ${CHART_HEIGHT}`}
        className={className}
        preserveAspectRatio="none"
        // The wrapper carries the role, name and keyboard behaviour; the SVG
        // itself is presentation.
        aria-hidden="true"
        focusable="false"
        onPointerMove={handlePointerMove}
        onPointerLeave={() => setHoverIndex(null)}
      >
        <defs>
          {/*
            Triple-Whale-calm sparkline: one thin horizontal line carries the
            trend; no area fill, muted baseline.

            It used to fade blue into emerald, so a rising CPA and rising
            revenue were drawn identically and both read as "good". The chart
            has no trustworthy per-metric direction to colour from, so it
            states the shape and lets the numbers beside it carry the meaning.
          */}
          <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
            <stop offset="0%" stopColor="#2a5fe2" />
            <stop offset="100%" stopColor="#2a5fe2" />
          </linearGradient>
        </defs>

        {/* Muted baseline */}
        <line
          x1={PLOT_LEFT}
          x2={CHART_WIDTH - PLOT_RIGHT}
          y1={CHART_HEIGHT - PLOT_BOTTOM}
          y2={CHART_HEIGHT - PLOT_BOTTOM}
          stroke="#ECEDEF"
          strokeWidth="1"
        />

        {/* Previous period — dashed, muted neutral */}
        {compLinePath ? (
          <path
            d={compLinePath}
            fill="none"
            stroke="#9AA1AC"
            strokeWidth="1.5"
            strokeDasharray="3 4"
            strokeLinecap="round"
            opacity="0.6"
          />
        ) : null}

        {/* Trend line */}
        <path
          d={linePath}
          fill="none"
          stroke={`url(#${gradientId})`}
          strokeWidth="2"
          strokeLinecap="round"
          strokeLinejoin="round"
        />

        {/* Hover göstergesi */}
        {hoverIndex !== null ? (
          <>
            <line
              x1={activePoint.x}
              x2={activePoint.x}
              y1={PLOT_TOP}
              y2={CHART_HEIGHT - PLOT_BOTTOM}
              stroke="#D4D7DD"
              strokeDasharray="2 4"
              strokeWidth="1"
            />
            <circle
              cx={activePoint.x}
              cy={activePoint.y}
              r="3"
              fill="#ffffff"
              stroke="#2a5fe2"
              strokeWidth="2"
            />
            {activeCmpPoint ? (
              <circle
                cx={activeCmpPoint.x}
                cy={activeCmpPoint.y}
                r="2.5"
                fill="#ffffff"
                stroke="#94a3b8"
                strokeWidth="1.5"
              />
            ) : null}
          </>
        ) : null}
      </svg>
    </div>
  );
}
