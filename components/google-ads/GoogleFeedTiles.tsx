"use client";

import type { ProductRow } from "@/components/google-ads/google-ads-dashboard-support";

/**
 * The design's Products & feed tile row. Each tile counts products by the state
 * the products endpoint already assigned — the UI does not classify feed health
 * itself, and a state the server did not set is never inferred.
 */
export function GoogleFeedTiles({
  rows,
  currencyFormatter,
}: {
  rows: ProductRow[];
  currencyFormatter: (value: number) => string;
}) {
  const spending = rows.filter((row) => row.spend > 0);
  const converting = spending.filter((row) => row.conversions > 0);
  const draining = spending.filter((row) => row.contributionState === "negative");
  const drainingSpend = draining.reduce((sum, row) => sum + row.spend, 0);
  const scale = rows.filter((row) => row.statusLabel === "scale").length;

  const tiles: Array<{ label: string; value: string; sub: string; tone?: "neg" }> = [
    {
      label: "Products with spend",
      value: String(spending.length),
      sub: `${rows.length} in the served feed`,
    },
    {
      label: "Converting",
      value: String(converting.length),
      sub:
        spending.length > 0
          ? `${Math.round((converting.length / spending.length) * 100)}% of spenders`
          : "no spend in window",
    },
    {
      label: "Draining spend",
      value: currencyFormatter(drainingSpend),
      sub: `${draining.length} negative-contribution product${draining.length === 1 ? "" : "s"}`,
      tone: draining.length > 0 ? "neg" : undefined,
    },
    {
      label: "Scale candidates",
      value: String(scale),
      sub: "server-assigned status",
    },
  ];

  return (
    <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(200px,1fr))]">
      {tiles.map((tile) => (
        <article
          key={tile.label}
          className="rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-4 py-3.5"
        >
          <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[9.5px] uppercase tracking-[0.1em] text-[var(--adv-ink-3)]">
            {tile.label}
          </p>
          <p
            className="m-0 mt-1.5 font-[family-name:var(--adv-font-display)] text-[23px] font-bold tabular-nums"
            style={{
              color: tile.tone === "neg" ? "var(--adc-danger-fg)" : "var(--adv-ink)",
            }}
          >
            {tile.value}
          </p>
          <p className="m-0 mt-0.5 text-[11px] text-[var(--adv-ink-3)]">{tile.sub}</p>
        </article>
      ))}
    </div>
  );
}
