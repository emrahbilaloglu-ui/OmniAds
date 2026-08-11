"use client";

/**
 * A real `<table>`.
 *
 * Grid-of-divs loses row/column association for screen readers, and there is
 * no ARIA patch that fully restores it. Every column declares `scope="col"`,
 * and the caller nominates one column as the row header so each cell is
 * announced with the row it belongs to.
 *
 * Density changes padding only — type never shrinks below the 12 px floor, so
 * "compact" cannot quietly become unreadable.
 */
import type { ReactNode } from "react";

import type { MetricValue } from "@/lib/zero-base/state-types";

export type TableDensity = "comfortable" | "dense";

export interface TableColumn<Row> {
  id: string;
  header: string;
  /** Right-aligned mono, for money and counts. */
  numeric?: boolean;
  render: (row: Row) => ReactNode;
}

export interface DataTableProps<Row> {
  caption: string;
  columns: ReadonlyArray<TableColumn<Row>>;
  rows: readonly Row[];
  /** Index is offered so callers never need a random key for rows with no id. */
  rowKey: (row: Row, index: number) => string;
  /** Column whose cell is the row header. Defaults to the first. */
  rowHeaderColumnId?: string;
  density?: TableDensity;
  /**
   * Name of the collection this table is, per the accepted design.
   *
   * Declared by the caller rather than inferred here: the table primitive has
   * no way to know whether it is the clients directory or the decisions lane,
   * and guessing would put the wrong name on the wrong data.
   */
  collection?: string;
}

const ROW_HEIGHT: Record<TableDensity, number> = { comfortable: 48, dense: 40 };

export function DataTable<Row>({
  caption,
  columns,
  rows,
  rowKey,
  rowHeaderColumnId,
  density = "comfortable",
  collection,
}: DataTableProps<Row>) {
  const headerColumnId = rowHeaderColumnId ?? columns[0]?.id;
  const padding = density === "dense" ? "8px 12px" : "12px 14px";

  return (
    <table
      data-collection={collection}
      style={{
        width: "100%",
        borderCollapse: "collapse",
        fontSize: 13,
        lineHeight: "19px",
        color: "var(--ledger-ink-primary)",
      }}
    >
      <caption
        style={{
          captionSide: "top",
          textAlign: "left",
          fontSize: 12,
          lineHeight: "16px",
          color: "var(--ledger-ink-tertiary)",
          paddingBottom: 8,
        }}
      >
        {caption}
      </caption>
      <thead>
        <tr>
          {columns.map((column) => (
            <th
              key={column.id}
              scope="col"
              style={{
                textAlign: column.numeric ? "right" : "left",
                padding,
                fontSize: 12,
                fontWeight: 600,
                lineHeight: "16px",
                color: "var(--ledger-ink-secondary)",
                borderBottom: "1px solid var(--ledger-border-subtle)",
                whiteSpace: "nowrap",
              }}
            >
              {column.header}
            </th>
          ))}
        </tr>
      </thead>
      <tbody>
        {rows.map((row, index) => (
          <tr key={rowKey(row, index)} style={{ minHeight: ROW_HEIGHT[density] }}>
            {columns.map((column) => {
              const isRowHeader = column.id === headerColumnId;
              const Cell = isRowHeader ? "th" : "td";
              return (
                <Cell
                  key={column.id}
                  {...(isRowHeader ? { scope: "row" as const } : {})}
                  style={{
                    textAlign: column.numeric ? "right" : "left",
                    padding,
                    height: ROW_HEIGHT[density],
                    fontWeight: isRowHeader ? 600 : 400,
                    fontFamily: column.numeric
                      ? "var(--font-adc-mono), ui-monospace, monospace"
                      : "inherit",
                    borderBottom: "1px solid var(--ledger-border-subtle)",
                  }}
                >
                  {column.render(row)}
                </Cell>
              );
            })}
          </tr>
        ))}
      </tbody>
    </table>
  );
}

/**
 * Renders a metric, or an em dash with the reason attached.
 *
 * The em dash is the whole point: an unavailable metric must never render as
 * `0`, because `0` is a claim about the world and "not served" is not.
 */
export function MetricCell({ metric }: { metric: MetricValue }) {
  if (metric.state === "unavailable") {
    return (
      <span title={metric.reason} data-metric="unavailable" style={{ color: "var(--ledger-ink-tertiary)" }}>
        —<span style={{ position: "absolute", width: 1, height: 1, overflow: "hidden", clip: "rect(0 0 0 0)" }}>
          {" "}
          unavailable: {metric.reason}
        </span>
      </span>
    );
  }

  const formatted =
    metric.unit === "currency"
      ? new Intl.NumberFormat("en-US", {
          style: "currency",
          currency: metric.currency ?? "USD",
          currencyDisplay: "narrowSymbol",
        }).format(metric.value)
      : metric.unit === "percent"
        ? `${metric.value.toFixed(1)}%`
        : metric.unit === "ratio"
          ? metric.value.toFixed(2)
          : new Intl.NumberFormat("en-US").format(metric.value);

  return (
    <span data-metric="available">
      {formatted}
      {/* An unproven currency is labelled, so a configured guess is never
          presented as an observed fact. */}
      {metric.unit === "currency" && !metric.currencyProven ? (
        <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}> (configured)</span>
      ) : null}
    </span>
  );
}
