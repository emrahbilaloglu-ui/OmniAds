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
}: {
  title: string;
  points: ReadonlyArray<SparklinePoint>;
  unit: OverviewMetricUnit;
}) {
  const copy = useCopy();
  const [showTable, setShowTable] = useState(false);
  const tableId = useId();

  const values = points.map((point) => point.value).filter((value): value is number => value !== null);
  const max = values.length ? Math.max(...values) : 0;
  const min = values.length ? Math.min(...values) : 0;
  const span = max - min || 1;

  const width = 160;
  const height = 32;
  const x = (index: number) => (points.length <= 1 ? width / 2 : (index / (points.length - 1)) * width);
  const y = (value: number) => height - ((value - min) / span) * height;

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
        ? value.toFixed(2)
        : new Intl.NumberFormat("en-US").format(value);

  const first = points[0]?.date ?? "";
  const last = points[points.length - 1]?.date ?? "";
  const summary =
    values.length === 0
      ? `${title}: no values in this window.`
      : `${title}: ${values.length} points from ${first} to ${last}, low ${format(min)}, high ${format(max)}.`;

  return (
    <div>
      {/* The summary is the accessible content; the drawing is decorative. */}
      <svg
        role="img"
        aria-label={summary}
        viewBox={`0 0 ${width} ${height}`}
        style={{ width: "100%", height, display: "block" }}
      >
        {runs
          .filter((run) => run.length > 0)
          .map((run, runIndex) => (
            <polyline
              key={runIndex}
              fill="none"
              stroke="var(--ledger-accent-action)"
              strokeWidth={1.5}
              points={run.map((point) => `${x(point.index)},${y(point.value)}`).join(" ")}
            />
          ))}
      </svg>

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
