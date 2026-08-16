"use client";

import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

/**
 * The design's Advisor summary tiles: four counts derived from the advisor
 * payload the server already ranked. Nothing here re-scores or invents — each
 * tile counts recommendations by a field the advisor emits.
 */
export function GoogleAdvisorTiles({
  recommendations,
  currencyFormatter,
}: {
  recommendations: GoogleRecommendation[];
  currencyFormatter: (value: number) => string;
}) {
  const open = recommendations.length;
  const high = recommendations.filter((item) => item.priority === "high").length;
  const blocked = recommendations.filter((item) => item.blockers.length > 0).length;

  // Money at stake sums the advisor's own currency midpoints. Recommendations
  // whose contribution is not expressed as a currency range carry no midpoint
  // and are excluded rather than estimated — the count says how many counted.
  const quantified = recommendations
    .map((item) => item.potentialContribution?.estimatedValueMidpoint)
    .filter((value): value is number => typeof value === "number" && Number.isFinite(value));
  const atStake =
    quantified.length > 0 ? quantified.reduce((sum, value) => sum + value, 0) : null;

  const tiles: Array<{ label: string; value: string; sub: string }> = [
    { label: "Open findings", value: String(open), sub: "ranked by the advisor" },
    { label: "High priority", value: String(high), sub: "act on these first" },
    {
      label: "Money at stake",
      value: atStake === null ? "—" : currencyFormatter(atStake),
      sub:
        atStake === null
          ? "no quantified contribution"
          : `${quantified.length} of ${open} quantified`,
    },
    { label: "Blocked", value: String(blocked), sub: "waiting on data or access" },
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
          <p className="m-0 mt-1.5 font-[family-name:var(--adv-font-display)] text-[23px] font-bold tabular-nums text-[var(--adv-ink)]">
            {tile.value}
          </p>
          <p className="m-0 mt-0.5 text-[11px] text-[var(--adv-ink-3)]">{tile.sub}</p>
        </article>
      ))}
    </div>
  );
}
