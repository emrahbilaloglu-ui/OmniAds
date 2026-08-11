"use client";

/**
 * Spend & ROAS trend (H03), with a real table alternative.
 *
 * The contract for `live:chart-table-toggle` is specific and worth honouring
 * exactly: the toggle swaps the chart for **real `<table>` markup in place**,
 * announces "table view", and the preference is **persisted per surface**.
 *
 * Two things follow from that:
 *
 * - The table is a genuine `<table>` with headers, not an ARIA grid painted
 *   over divs. A screen reader user gets the actual figures, not a description
 *   of a picture.
 * - Persistence is per surface, so a buyer who always wants numbers on Home
 *   gets numbers on Home without forcing that choice onto every other chart.
 *
 * A null point is a gap, not a zero — the line breaks rather than diving to the
 * axis, because a day with no spend recorded is not a day of zero spend.
 */
import { useCallback, useEffect, useId, useState } from "react";
import { useCopy } from "@/components/zero-base/i18n/copy-provider";

export interface TrendPoint {
  date: string;
  /** Null when no spend was recorded that day. Never coerced to 0. */
  spend: number | null;
  /** Null when ROAS could not be derived that day. */
  roas: number | null;
}

const STORAGE_PREFIX = "zero-base:trend-view:";

/** Read the persisted preference. Absent storage is not an error. */
function readPreference(surface: string): boolean {
  if (typeof window === "undefined") return false;
  try {
    return window.localStorage.getItem(`${STORAGE_PREFIX}${surface}`) === "table";
  } catch {
    // Storage can be denied outright; a disabled preference is not a failure.
    return false;
  }
}

function writePreference(surface: string, table: boolean): void {
  if (typeof window === "undefined") return;
  try {
    window.localStorage.setItem(`${STORAGE_PREFIX}${surface}`, table ? "table" : "chart");
  } catch {
    /* Preference is a convenience; losing it must never break the surface. */
  }
}

export function TrendPanel({
  title,
  points,
  currency,
  targetRoas,
  surface,
}: {
  title: string;
  points: readonly TrendPoint[];
  /** Null when the account currency is genuinely unknown. */
  currency: string | null;
  targetRoas: number | null;
  /** Identity the view preference is stored against. */
  surface: string;
}) {
  const [showTable, setShowTable] = useState(false);
  const copy = useCopy();
  const regionId = useId();

  // The preference is read after mount so the server and first client render
  // agree; hydrating straight from storage would mismatch.
  useEffect(() => {
    setShowTable(readPreference(surface));
  }, [surface]);

  const toggle = useCallback(() => {
    setShowTable((previous) => {
      const next = !previous;
      writePreference(surface, next);
      return next;
    });
  }, [surface]);

  const spends = points
    .map((point) => point.spend)
    .filter((value): value is number => value !== null);
  const max = spends.length ? Math.max(...spends) : 0;
  const first = points.at(0)?.date ?? null;
  const last = points.at(-1)?.date ?? null;

  const unitLabel = currency ? `daily spend ${currency}` : "daily spend, currency unknown";
  const targetLabel =
    targetRoas === null
      ? "no ROAS target set"
      : `indigo = ROAS ≥ target ${targetRoas.toFixed(1)}`;

  return (
    <section
      data-trend-panel={surface}
      aria-label={title}
      style={{
        borderRadius: "var(--ledger-radius-card)",
        border: "1px solid var(--ledger-border-subtle)",
        background: "var(--ledger-bg-surface)",
        padding: 16,
      }}
    >
      <div
        style={{
          display: "flex",
          alignItems: "baseline",
          justifyContent: "space-between",
          gap: 12,
          marginBottom: 12,
        }}
      >
        <h2 style={{ margin: 0, fontSize: 16, fontWeight: 600, lineHeight: "22px" }}>{title}</h2>
        <button
          type="button"
          data-ctl="live:chart-table-toggle"
          onClick={toggle}
          aria-pressed={showTable}
          aria-controls={regionId}
          style={{
            background: "none",
            border: "1px solid var(--ledger-border-control)",
            borderRadius: "var(--ledger-radius-control)",
            color: "var(--ledger-ink-secondary)",
            cursor: "pointer",
            fontSize: 12.5,
            lineHeight: "18px",
            padding: "4px 10px",
          }}
        >
          {showTable ? "View as chart" : "View as table"}
        </button>
      </div>

      {/* The mode change is announced, because the content swapped underneath
          a user who cannot see it happen. */}
      <p
        role="status"
        aria-live="polite"
        data-trend-mode={showTable ? "table" : "chart"}
        style={{
          position: "absolute",
          width: 1,
          height: 1,
          overflow: "hidden",
          clip: "rect(0 0 0 0)",
          whiteSpace: "nowrap",
        }}
      >
        {showTable ? "table view" : "chart view"}
      </p>

      <div id={regionId}>
        {showTable ? (
          <table style={{ width: "100%", borderCollapse: "collapse", fontSize: 13 }}>
            <caption
              style={{
                textAlign: "left",
                fontSize: 12,
                color: "var(--ledger-ink-tertiary)",
                paddingBottom: 6,
              }}
            >
              {unitLabel} · {targetLabel}
            </caption>
            <thead>
              <tr>
                <th scope="col" style={{ textAlign: "left", padding: "6px 8px", fontSize: 12 }}>
                  {copy.date}
                </th>
                <th scope="col" style={{ textAlign: "right", padding: "6px 8px", fontSize: 12 }}>
                  {copy.spend}
                </th>
                <th scope="col" style={{ textAlign: "right", padding: "6px 8px", fontSize: 12 }}>
                  {copy.returnOnAdSpend}
                </th>
              </tr>
            </thead>
            <tbody>
              {points.map((point) => (
                <tr key={point.date} data-trend-row={point.date}>
                  <th
                    scope="row"
                    style={{ textAlign: "left", fontWeight: 500, padding: "6px 8px" }}
                  >
                    {point.date}
                  </th>
                  <td
                    style={{
                      textAlign: "right",
                      padding: "6px 8px",
                      fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
                    }}
                  >
                    {/* "No data" and 0 are different facts. */}
                    {point.spend === null ? "No data" : point.spend.toFixed(2)}
                  </td>
                  <td
                    style={{
                      textAlign: "right",
                      padding: "6px 8px",
                      fontFamily: "var(--font-adc-mono), ui-monospace, monospace",
                    }}
                  >
                    {point.roas === null ? "No data" : point.roas.toFixed(2)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        ) : (
          <div data-trend-chart="">
            <div
              style={{
                display: "flex",
                alignItems: "flex-end",
                gap: 2,
                height: 96,
              }}
            >
              {points.map((point) => {
                const height = point.spend === null || max === 0 ? 0 : (point.spend / max) * 96;
                const atTarget =
                  targetRoas !== null && point.roas !== null && point.roas >= targetRoas;
                return (
                  <div
                    key={point.date}
                    data-trend-bar={point.date}
                    data-at-target={atTarget ? "true" : "false"}
                    title={`${point.date}: ${point.spend === null ? "no data" : point.spend.toFixed(2)}`}
                    style={{
                      flex: 1,
                      height: Math.max(height, point.spend === null ? 0 : 1),
                      background: atTarget
                        ? "var(--ledger-accent-primary)"
                        : "var(--ledger-border-control)",
                      borderRadius: 1,
                    }}
                  />
                );
              })}
            </div>
            <p
              style={{
                display: "flex",
                justifyContent: "space-between",
                gap: 8,
                margin: "8px 0 0",
                fontSize: 12,
                lineHeight: "16px",
                color: "var(--ledger-ink-tertiary)",
              }}
            >
              <span>{first ?? "—"}</span>
              <span>
                {unitLabel} · {targetLabel}
              </span>
              <span>{last ?? "—"}</span>
            </p>
          </div>
        )}
      </div>
    </section>
  );
}
