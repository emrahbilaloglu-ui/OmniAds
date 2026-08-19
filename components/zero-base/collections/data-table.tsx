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
 *
 * Column headings do not wrap at desk widths and do wrap on a phone. That rule
 * lives in the stylesheet rather than here: as an inline `nowrap` it could not
 * be overridden, and it forced every table wider than the narrowest supported
 * viewport — which pushed the right-hand columns, where the row actions are,
 * off the side of the screen.
 */
import type { ReactNode } from "react";

import type { MetricValue } from "@/lib/zero-base/state-types";

export type TableDensity = "comfortable" | "dense";

export interface TableColumn<Row> {
  id: string;
  header: string;
  /** Right-aligned mono, for money and counts. */
  numeric?: boolean;
  width?: number | string;
  minWidth?: number | string;
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
  /** A dense multi-column decision table may scroll, but must never overlap. */
  minWidth?: number | string;
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
  minWidth,
}: DataTableProps<Row>) {
  const headerColumnId = rowHeaderColumnId ?? columns[0]?.id;
  const padding = density === "dense" ? "8px 12px" : "12px 14px";

  return (
    // A table wide enough to need it scrolls inside its own frame. Letting the
    // surface scroll instead drags the heading and the navigation sideways with
    // it, and the columns that go off the edge — where the row actions are —
    // give no sign they exist.
    <div data-scroll-x="" data-responsive-table="" style={{ overflowX: "auto", maxWidth: "100%" }}>
    <table
      data-collection={collection}
      style={{
        width: "100%",
        minWidth,
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
                width: column.width,
                minWidth: column.minWidth,
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
                  data-label={column.header}
                  {...(isRowHeader ? { scope: "row" as const } : {})}
                  style={{
                    textAlign: column.numeric ? "right" : "left",
                    verticalAlign: "top",
                    padding,
                    height: ROW_HEIGHT[density],
                    fontWeight: isRowHeader ? 600 : 400,
                    fontFamily: column.numeric
                      ? "var(--font-adc-mono), ui-monospace, monospace"
                      : "inherit",
                    borderBottom: "1px solid var(--ledger-border-subtle)",
                    width: column.width,
                    minWidth: column.minWidth,
                    overflowWrap: "anywhere",
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
    <style>{`
      @media (max-width: 640px) {
        [data-responsive-table] { overflow-x: visible !important; }
        [data-responsive-table] table { display: block; width: 100% !important; }
        [data-responsive-table] caption { display: block; width: 100%; }
        [data-responsive-table] thead { position: absolute; width: 1px; height: 1px; overflow: hidden; clip: rect(0 0 0 0); white-space: nowrap; }
        [data-responsive-table] tbody { display: grid; gap: 10px; }
        [data-responsive-table] tbody tr { display: grid; min-width: 0; border: 1px solid var(--ledger-border-subtle); border-radius: var(--ledger-radius-card); background: var(--ledger-bg-surface); overflow: hidden; }
        [data-responsive-table] tbody td,
        [data-responsive-table] tbody th[scope="row"] { display: grid; grid-template-columns: minmax(82px, .65fr) minmax(0, 1.35fr); gap: 10px; align-items: start; box-sizing: border-box; width: 100%; min-width: 0; height: auto !important; padding: 9px 10px !important; border-bottom: 1px solid var(--ledger-border-subtle); text-align: left !important; font-family: inherit !important; overflow-wrap: anywhere; }
        [data-responsive-table] tbody tr > :last-child { border-bottom: 0; }
        [data-responsive-table] tbody td::before,
        [data-responsive-table] tbody th[scope="row"]::before { content: attr(data-label); color: var(--ledger-ink-tertiary); font: 600 10px/15px var(--font-adc-mono), ui-monospace, monospace; letter-spacing: .03em; text-transform: uppercase; }
        [data-responsive-table] button,
        [data-responsive-table] a { max-width: 100%; white-space: normal !important; overflow-wrap: anywhere; }
      }
    `}</style>
    </div>
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

  // `currency: null` is a declared state of MetricValue, not an accident, and
  // INVARIANTS.md is explicit: "Missing currency must not silently become USD,
  // $, TRY, or EUR; presentation may say account currency without changing the
  // underlying numeric decision." Formatting a null currency as USD did exactly
  // that - it printed an unknown unit as dollars on every zero-base surface
  // this table feeds. The number is still true, so it is still shown; only the
  // invented unit is withheld.
  const currencyUnknown = metric.unit === "currency" && !metric.currency;
  const formatted =
    metric.unit === "currency"
      ? metric.currency
        ? new Intl.NumberFormat("en-US", {
            style: "currency",
            currency: metric.currency,
            currencyDisplay: "narrowSymbol",
          }).format(metric.value)
        : new Intl.NumberFormat("en-US", {
            minimumFractionDigits: 2,
            maximumFractionDigits: 2,
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
      {currencyUnknown ? (
        <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}>
          {" "}
          (account currency)
        </span>
      ) : metric.unit === "currency" && !metric.currencyProven ? (
        <span style={{ fontSize: 12, color: "var(--ledger-ink-tertiary)" }}> (configured)</span>
      ) : null}
    </span>
  );
}
