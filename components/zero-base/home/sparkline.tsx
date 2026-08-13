"use client";

/**
 * A sparkline with a real alternative.
 *
 * An SVG trend line is invisible to a screen reader and unreadable for exact
 * values, so every sparkline ships the table that produced it, one keypress
 * away, rendered from the same points array. There is no second copy of the
 * data to drift.
 *
 * A null point is a gap, not a zero: the line breaks rather than diving to the
 * axis, because a day with no data is not a day of zero revenue.
 */
import { useId, useState } from "react";

import type { OverviewMetricUnit } from "@/src/types/models";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface SparklinePoint {
  date: string;
  value: number | null;
}

export function Sparkline({
  title,
  points,
  unit,
  currency = null,
}: {
  title: string;
  points: ReadonlyArray<SparklinePoint>;
  unit: OverviewMetricUnit;
  currency?: string | null;
}) {
  const copy = useCopy();
  const [showTable, setShowTable] = useState(false);
  const [activeIndex, setActiveIndex] = useState<number | null>(null);
  const tableId = useId();
  const gradientId = useId().replace(/:/g, "");

  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const span = max - min || 1;

  const width = 320;
  const height = 72;
  const plotTop = 6;
  const plotBottom = 62;
  const x = (index: number) => (points.length <= 1 ? width / 2 : (index / (points.length - 1)) * width);
  const y = (value: number) => plotBottom - ((value - min) / span) * (plotBottom - plotTop);

  // Each run of consecutive present points is its own path.
  const runs: Array<Array<{ index: number; value: number }>> = [];
  points.forEach((point, index) => {
    if (point.value === null) {
      runs.push([]);
      return;
    }
    if (runs.length === 0) runs.push([]);
    runs[runs.length - 1].push({ index, value: point.value });
  });

  const format = (value: number) =>
    unit === "percent"
      ? `${value.toFixed(1)}%`
      : unit === "ratio"
        ? `${value.toFixed(2)}x`
        : unit === "currency" && currency
          ? `${currency} ${new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value)}`
          : new Intl.NumberFormat("en-US", { maximumFractionDigits: 2 }).format(value);

  const first = points[0]?.date ?? "";
  const last = points[points.length - 1]?.date ?? "";
  const summary =
    values.length === 0
      ? `${title}: no values in this window.`
      : `${title}: ${values.length} points from ${first} to ${last}, low ${format(min)}, high ${format(max)}.`;

  return (
    <div>
      <div data-sparkline-chart="" style={{ position: "relative", marginTop: 4 }}>
        {/* Exact values are exposed by the focusable point targets below. */}
        <svg
          role="img"
          aria-label={summary}
          viewBox={`0 0 ${width} ${height}`}
          preserveAspectRatio="none"
          style={{ width: "100%", height, display: "block", overflow: "visible" }}
        >
          <defs>
            <linearGradient id={gradientId} x1="0" x2="1" y1="0" y2="0">
              <stop offset="0%" stopColor="var(--ledger-accent-action)" />
              <stop offset="100%" stopColor="var(--ledger-semantic-ok)" />
            </linearGradient>
          </defs>
          <line x1="0" x2={width} y1={plotBottom} y2={plotBottom} stroke="var(--ledger-border-subtle)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
          {runs
            .filter((run) => run.length > 0)
            .map((run, runIndex) => (
              <polyline
                key={runIndex}
                fill="none"
                stroke={`url(#${gradientId})`}
                strokeWidth={2.5}
                strokeLinecap="round"
                strokeLinejoin="round"
                vectorEffect="non-scaling-stroke"
                points={run.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")}
              />
            ))}
          {activeIndex !== null && points[activeIndex]?.value != null ? (
            <>
              <line x1={x(activeIndex)} x2={x(activeIndex)} y1={plotTop} y2={plotBottom} stroke="var(--ledger-border-control)" strokeWidth="1" vectorEffect="non-scaling-stroke" />
              <circle cx={x(activeIndex)} cy={y(points[activeIndex].value)} r="4" fill="var(--ledger-bg-surface)" stroke="var(--ledger-accent-action)" strokeWidth="2" vectorEffect="non-scaling-stroke" />
            </>
          ) : null}
        </svg>

        <div style={{ position: "absolute", inset: 0, display: "grid", gridTemplateColumns: `repeat(${Math.max(points.length, 1)}, 1fr)` }}>
          {points.map((point, index) => (
            <button
              type="button"
              key={point.date}
              data-sparkline-point={point.date}
              aria-label={`${title}, ${point.date}: ${point.value === null ? "No data" : format(point.value)}`}
              onMouseEnter={() => setActiveIndex(index)}
              onMouseLeave={() => setActiveIndex(null)}
              onFocus={() => setActiveIndex(index)}
              onBlur={() => setActiveIndex(null)}
              style={{ minWidth: 0, padding: 0, border: 0, background: "transparent", cursor: "crosshair" }}
            />
          ))}
        </div>

        {activeIndex !== null && points[activeIndex] ? (
          <div
            role="tooltip"
            data-sparkline-tooltip=""
            style={{
              position: "absolute",
              zIndex: 4,
              left: `clamp(64px, ${(x(activeIndex) / width) * 100}%, calc(100% - 64px))`,
              top: -8,
              transform: "translate(-50%, -100%)",
              minWidth: 128,
              padding: "7px 9px",
              border: "1px solid var(--ledger-border-control)",
              borderRadius: "var(--ledger-radius-button)",
              background: "var(--ledger-bg-surface)",
              boxShadow: "var(--ledger-elevation-2)",
              fontSize: 12,
              lineHeight: "17px",
              pointerEvents: "none",
            }}
          >
            <strong style={{ display: "block" }}>{pointDateLabel(points[activeIndex].date)}</strong>
            <span style={{ display: "block", fontFamily: "var(--font-adc-mono), ui-monospace, monospace" }}>
              {points[activeIndex].value === null ? "No data" : format(points[activeIndex].value)}
            </span>
          </div>
        ) : null}
      </div>

      <button
        type="button"
        aria-expanded={showTable}
        aria-controls={tableId}
        data-ctl="live:chart-table-toggle"
        onClick={() => setShowTable((current) => !current)}
        data-sparkline-toggle=""
        style={{
          minHeight: 24,
          marginTop: 4,
          padding: 0,
          background: "transparent",
          border: 0,
          fontSize: 12,
          color: "var(--ledger-accent-action)",
          cursor: "pointer",
          textDecoration: "underline",
        }}
      >
        {showTable ? "Hide values" : "Show values"}
      </button>

      {showTable ? (
        <div id={tableId} style={{ overflowX: "auto", marginTop: 4 }}>
          <table style={{ borderCollapse: "collapse", fontSize: 12, width: "100%" }}>
            <caption style={{ textAlign: "left", color: "var(--ledger-ink-tertiary)" }}>
              {title} — values
            </caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", padding: "2px 6px" }}>
                  {copy.date}
                </th>
                <th scope="col" style={{ textAlign: "right", padding: "2px 6px" }}>
                  {copy.value}
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date}>
                  <th scope="row" style={{ textAlign: "left", fontWeight: 400, padding: "2px 6px" }}>
                    {point.date}
                  </th>
                  <td
                    style={{
                      textAlign: "right",
                      padding: "2px 6px",
                      fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
                    }}
                  >
                    {/* A gap renders as an em dash, never as 0. */}
                    {point.value === null ? "—" : format(point.value)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : null}
    </div>
  );
}

function pointDateLabel(value: string): string {
  const parsed = new Date(`${value}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return value;
  return new Intl.DateTimeFormat("en-US", { month: "short", day: "2-digit", year: "numeric", timeZone: "UTC" }).format(parsed);
}
