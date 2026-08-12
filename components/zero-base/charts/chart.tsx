"use client";

/**
 * Chart with a table view of the same numbers.
 *
 * The toggle is not a convenience feature. An SVG chart is unreadable to a
 * screen reader and hard to read for anyone who needs exact values, so every
 * chart ships the table that produced it and either view is one keypress away.
 * Both render from the same `series` array — there is no separate table data
 * to drift, which is what the parity test pins.
 *
 * Points with no value are *gaps*, not zeroes: the line breaks rather than
 * diving to the axis, because a missing day is not a day of zero spend.
 */
import { useId, useState } from "react";

import { DataTable } from "@/components/zero-base/collections/data-table";
import { Button } from "@/components/zero-base/primitives/button";
import { UnavailableState } from "@/components/zero-base/states/surface-state";

export interface ChartPoint {
  label: string;
  /** null means not served for this point. Never coerced to 0. */
  value: number | null;
}

export interface ChartSeries {
  id: string;
  label: string;
  points: readonly ChartPoint[];
}

export interface ChartProps {
  title: string;
  series: readonly ChartSeries[];
  /** Formats a value for both the axis and the table, so they agree. */
  format?: (value: number) => string;
  unavailableReason?: string;
  height?: number;
}

const SERIES_COLOURS = [
  "var(--ledger-accent-action)",
  "var(--ledger-semantic-ok)",
  "var(--ledger-lane-monitor)",
];

export function Chart({ title, series, format, unavailableReason, height = 200 }: ChartProps) {
  const [view, setView] = useState<"chart" | "table">("chart");
  const titleId = useId();

  if (unavailableReason) {
    return <UnavailableState reason={unavailableReason} />;
  }

  const formatValue = format ?? ((value: number) => new Intl.NumberFormat("en-US").format(value));
  const labels = series[0]?.points.map((point) => point.label) ?? [];
  const values = series.flatMap((s) => s.points.map((p) => p.value)).filter((v): v is number => v !== null);
  const max = values.length ? Math.max(...values) : 0;
  const min = Math.min(0, ...values);
  const span = max - min || 1;

  const width = 640;
  const padding = { top: 8, right: 8, bottom: 24, left: 8 };
  const plotWidth = width - padding.left - padding.right;
  const plotHeight = height - padding.top - padding.bottom;

  const x = (index: number, count: number) =>
    padding.left + (count <= 1 ? plotWidth / 2 : (index / (count - 1)) * plotWidth);
  const y = (value: number) => padding.top + plotHeight - ((value - min) / span) * plotHeight;

  return (
    <figure style={{ margin: 0 }}>
      <figcaption
        style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}
      >
        <span id={titleId} style={{ fontSize: 16, fontWeight: 600, lineHeight: "22px" }}>
          {title}
        </span>
        <Button
          variant="secondary"
          aria-pressed={view === "table"}
          onClick={() => setView((current) => (current === "chart" ? "table" : "chart"))}
        >
          {view === "chart" ? "View as table" : "View as chart"}
        </Button>
      </figcaption>

      {view === "table" ? (
        <div style={{ marginTop: 12 }}>
          <DataTable
            caption={`${title} — table view`}
            rowKey={(row) => row.label}
            rows={labels.map((label, index) => ({
              label,
              cells: series.map((s) => s.points[index]?.value ?? null),
            }))}
            columns={[
              { id: "label", header: "Period", render: (row) => row.label },
              ...series.map((s, seriesIndex) => ({
                id: s.id,
                header: s.label,
                numeric: true,
                render: (row: { cells: Array<number | null> }) => {
                  const value = row.cells[seriesIndex];
                  // Same em-dash rule as the table: a gap is not a zero.
                  return value === null ? (
                    <span style={{ color: "var(--ledger-ink-tertiary)" }}>—</span>
                  ) : (
                    formatValue(value)
                  );
                },
              })),
            ]}
          />
        </div>
      ) : (
        <svg
          role="img"
          aria-labelledby={titleId}
          viewBox={`0 0 ${width} ${height}`}
          style={{ width: "100%", height, marginTop: 12, overflow: "visible" }}
        >
          <line
            x1={padding.left}
            y1={y(min)}
            x2={width - padding.right}
            y2={y(min)}
            stroke="var(--ledger-border-subtle)"
            strokeWidth={1}
          />
          {series.map((s, seriesIndex) => {
            const colour = SERIES_COLOURS[seriesIndex % SERIES_COLOURS.length];
            // Each run of consecutive present points is its own path, so a
            // null leaves a visible gap instead of a line through zero.
            const runs: Array<Array<{ index: number; value: number }>> = [];
            s.points.forEach((point, index) => {
              if (point.value === null) {
                runs.push([]);
                return;
              }
              if (runs.length === 0) runs.push([]);
              runs[runs.length - 1].push({ index, value: point.value });
            });
            return (
              <g key={s.id}>
                {runs
                  .filter((run) => run.length > 0)
                  .map((run, runIndex) => (
                    <polyline
                      key={runIndex}
                      fill="none"
                      stroke={colour}
                      strokeWidth={2}
                      points={run
                        .map((p) => `${x(p.index, s.points.length)},${y(p.value)}`)
                        .join(" ")}
                    />
                  ))}
              </g>
            );
          })}
          {labels.map((label, index) => (
            <text
              key={label}
              x={x(index, labels.length)}
              y={height - 6}
              textAnchor="middle"
              // 12px floor holds inside the chart too.
              style={{ fontSize: 12, fill: "var(--ledger-ink-tertiary)" }}
            >
              {label}
            </text>
          ))}
        </svg>
      )}
    </figure>
  );
}
