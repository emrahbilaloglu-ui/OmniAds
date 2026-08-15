"use client";

import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";

/**
 * The design's Products table: one row per served item, the SKU under the
 * title, and the only two coloured cells being the ROAS chip and the feed
 * status chip.
 *
 * Google does not report a Merchant Center disapproval on the shopping report,
 * so the status chip carries the serving condition the account does report —
 * whether the item served at all, whether the spend converted, and whether the
 * contribution the server assigned came out negative.
 */

const HEAD =
  "bg-[var(--adv-fill)] px-3 py-[9px] font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] whitespace-nowrap text-[var(--adv-ink-3)]";

const CHIP = "inline-flex rounded-md px-2 py-0.5 text-[11px] font-semibold whitespace-nowrap";

function roasTone(roas: number, average: number) {
  if (!Number.isFinite(roas) || roas <= 0) {
    return { bg: "var(--adv-fill-2)", fg: "var(--adv-ink-3)" };
  }
  if (average > 0 && roas >= average) return { bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" };
  if (average > 0 && roas < average * 0.6) {
    return { bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  }
  return { bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
}

/** Every branch reads a field the products report served; nothing is inferred. */
function feedStatus(row: ProductRow) {
  const spend = Number(row.spend) || 0;
  const clicks = Number(row.clicks) || 0;
  if (spend === 0 && clicks === 0) {
    return { label: "Not serving", bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  }
  if (spend > 0 && (Number(row.conversions) || 0) === 0) {
    return { label: "No conversions", bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
  }
  if (row.contributionState === "negative") {
    return { label: "Negative return", bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  }
  if (row.statusLabel === "scale") {
    return { label: "Scale candidate", bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" };
  }
  return { label: "Serving", bg: "var(--adv-fill-2)", fg: "var(--adv-ink-2)" };
}

/**
 * A served feed runs to thousands of items; the table shows the top slice by
 * spend and says so, rather than mounting every row.
 */
const VISIBLE_ROWS = 50;

export function GoogleProductsTable({
  rows,
  currencyFormatter,
  focusedTitles = [],
}: {
  rows: ProductRow[];
  currencyFormatter: (value: number) => string;
  /** Titles the advisor sent here via Focus; the row carries the selection tint. */
  focusedTitles?: string[];
}) {
  if (rows.length === 0) return null;

  const focused = new Set(focusedTitles.map((title) => title.toLowerCase().trim()));

  const totalSpend = rows.reduce((sum, row) => sum + (Number(row.spend) || 0), 0);
  const totalRevenue = rows.reduce((sum, row) => sum + (Number(row.revenue) || 0), 0);
  const averageRoas = totalSpend > 0 ? totalRevenue / totalSpend : 0;
  const visible = rows.slice(0, VISIBLE_ROWS);

  return (
    <article className="overflow-x-auto rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
          Products
        </h2>
        <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          Shopping + PMax · feed from Shopify
        </span>
      </div>
      <table className="w-full min-w-[640px] border-collapse text-[13px] tabular-nums">
        <thead>
          <tr>
            <th className={`${HEAD} px-4 text-left`}>Product</th>
            <th className={`${HEAD} text-right`}>Clicks</th>
            <th className={`${HEAD} text-right`}>Cost</th>
            <th className={`${HEAD} text-right`}>Conv value</th>
            <th className={`${HEAD} text-right`}>ROAS</th>
            <th className={`${HEAD} px-4 text-left`}>Feed status</th>
          </tr>
        </thead>
        <tbody>
          {visible.map((row, index) => {
            const roas = Number(row.roas) || 0;
            const tone = roasTone(roas, averageRoas);
            const status = feedStatus(row);
            return (
              <tr
                key={row.itemId ?? `${row.title ?? "product"}-${index}`}
                className="border-t border-[var(--adv-hairline)]"
                style={
                  focused.has((row.title ?? "").toLowerCase().trim())
                    ? { background: "var(--adv-accent-bg)" }
                    : undefined
                }
              >
                <td className="px-4 py-[11px]">
                  <span className="block font-semibold text-[var(--adv-ink)]">
                    {row.title ?? row.itemId ?? "Unnamed product"}
                  </span>
                  <span className="mt-px block font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
                    {row.itemId ?? "no item id"}
                  </span>
                </td>
                <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                  {(Number(row.clicks) || 0).toLocaleString()}
                </td>
                <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                  {currencyFormatter(Number(row.spend) || 0)}
                </td>
                <td className="px-3 py-[11px] text-right font-semibold text-[var(--adv-ink)]">
                  {currencyFormatter(Number(row.revenue) || 0)}
                </td>
                <td className="px-3 py-[11px] text-right">
                  <span
                    className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold"
                    style={{ background: tone.bg, color: tone.fg }}
                  >
                    {roas > 0 ? roas.toFixed(2) : "—"}
                  </span>
                </td>
                <td className="px-4 py-[11px]">
                  <span className={CHIP} style={{ background: status.bg, color: status.fg }}>
                    {status.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
      {rows.length > VISIBLE_ROWS ? (
        <p className="m-0 border-t border-[var(--adv-hairline)] px-4 py-2.5 font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          Showing the top {VISIBLE_ROWS} of {rows.length.toLocaleString()} served
          products by spend.
        </p>
      ) : null}
    </article>
  );
}
