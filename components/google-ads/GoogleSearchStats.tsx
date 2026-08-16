"use client";

import type { SearchIntelligenceRow } from "@/components/google-ads/google-ads-dashboard-support";

/**
 * The design's Search-intelligence stat row and filter pills. Every count comes
 * from a flag the search-intelligence endpoint sets on the row — the UI does not
 * reclassify terms, it only tallies what the server already decided.
 */

export type SearchTermFilter = "all" | "waste" | "opportunity" | "negative";

const DOTS: Record<Exclude<SearchTermFilter, "all">, string> = {
  waste: "var(--adc-danger-fg)",
  opportunity: "var(--adc-pos-fg)",
  negative: "var(--adc-caution-fg)",
};

export function countSearchTerms(rows: SearchIntelligenceRow[]) {
  return {
    all: rows.length,
    waste: rows.filter((row) => row.wasteFlag).length,
    opportunity: rows.filter((row) => row.keywordOpportunityFlag).length,
    negative: rows.filter((row) => row.negativeKeywordFlag).length,
  };
}

export function GoogleSearchStats({
  rows,
  active,
  onFilterChange,
  currencyFormatter,
}: {
  rows: SearchIntelligenceRow[];
  active: SearchTermFilter;
  onFilterChange: (next: SearchTermFilter) => void;
  currencyFormatter: (value: number) => string;
}) {
  const counts = countSearchTerms(rows);
  const wastedSpend = rows
    .filter((row) => row.wasteFlag)
    .reduce((sum, row) => sum + (Number.isFinite(row.spend) ? row.spend : 0), 0);
  const opportunityRevenue = rows
    .filter((row) => row.keywordOpportunityFlag)
    .reduce((sum, row) => sum + (Number.isFinite(row.revenue) ? row.revenue : 0), 0);

  const stats: Array<{ dot: string; value: string; label: string }> = [
    {
      dot: DOTS.waste,
      value: currencyFormatter(wastedSpend),
      label: `spend on ${counts.waste} wasteful term${counts.waste === 1 ? "" : "s"}`,
    },
    {
      dot: DOTS.opportunity,
      value: currencyFormatter(opportunityRevenue),
      label: `revenue from ${counts.opportunity} unharvested term${counts.opportunity === 1 ? "" : "s"}`,
    },
    {
      dot: DOTS.negative,
      value: String(counts.negative),
      label: "negative-keyword candidates",
    },
  ];

  const filters: Array<{ key: SearchTermFilter; label: string }> = [
    { key: "all", label: "All terms" },
    { key: "waste", label: "Waste" },
    { key: "opportunity", label: "Opportunity" },
    { key: "negative", label: "Negative candidates" },
  ];

  return (
    <div className="flex flex-col gap-3">
      <div className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(230px,1fr))]">
        {stats.map((stat) => (
          <article
            key={stat.label}
            className="flex items-center gap-3 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-4 py-3.5"
          >
            <span
              className="h-2 w-2 shrink-0 rounded-full"
              style={{ background: stat.dot }}
              aria-hidden="true"
            />
            <div className="min-w-0">
              <p className="m-0 font-[family-name:var(--adv-font-display)] text-[21px] font-bold tabular-nums text-[var(--adv-ink)]">
                {stat.value}
              </p>
              <p className="m-0 mt-px text-[11.5px] text-[var(--adv-ink-3)]">{stat.label}</p>
            </div>
          </article>
        ))}
      </div>

      <div className="flex flex-wrap gap-2">
        {filters.map((filter) => {
          const on = active === filter.key;
          return (
            <button
              key={filter.key}
              type="button"
              aria-pressed={on}
              onClick={() => onFilterChange(filter.key)}
              className="inline-flex h-[30px] items-center gap-1.5 rounded-full border px-3 text-[12px] font-semibold transition-colors"
              style={{
                borderColor: on ? "var(--adv-accent-bd)" : "var(--adv-border)",
                background: on ? "var(--adv-accent-bg)" : "var(--adv-surface)",
                color: on ? "var(--adv-accent)" : "var(--adv-ink-2)",
              }}
            >
              {filter.label}
              <span className="font-[family-name:var(--adv-font-mono)] text-[10px] opacity-75">
                {counts[filter.key]}
              </span>
            </button>
          );
        })}
      </div>
    </div>
  );
}
