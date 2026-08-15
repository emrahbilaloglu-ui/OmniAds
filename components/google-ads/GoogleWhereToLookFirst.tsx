"use client";

import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

/**
 * The design's "Where to look first" band: the highest-ranked advisor findings
 * as a card grid, each carrying a severity chip, the finding, its evidence line
 * and the action link. Ranking is the server's `rankScore` — the UI never
 * re-scores, it only orders what the advisor already decided.
 */

const SEVERITY_STYLE = {
  high: { background: "var(--adc-danger-bg)", color: "var(--adc-danger-fg)", label: "Risk" },
  medium: { background: "var(--adc-caution-bg)", color: "var(--adc-caution-fg)", label: "Watch" },
  low: { background: "var(--adc-info-bg)", color: "var(--adc-info-fg)", label: "Opportunity" },
} as const;

export function GoogleWhereToLookFirst({
  recommendations,
  onFocus,
  limit = 4,
}: {
  recommendations: GoogleRecommendation[];
  onFocus?: (recommendation: GoogleRecommendation) => void;
  limit?: number;
}) {
  const ranked = [...recommendations]
    .sort((left, right) => (right.rankScore ?? 0) - (left.rankScore ?? 0))
    .slice(0, limit);

  if (ranked.length === 0) return null;

  return (
    <section className="grid gap-3 [grid-template-columns:repeat(auto-fit,minmax(290px,1fr))]">
      {ranked.map((recommendation) => {
        const severity =
          SEVERITY_STYLE[recommendation.priority] ?? SEVERITY_STYLE.low;
        const evidence =
          recommendation.rankExplanation ||
          recommendation.whyNow ||
          recommendation.confidenceExplanation ||
          "";
        return (
          <article
            key={recommendation.id}
            className="flex flex-col gap-1.5 rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-4 py-3.5"
          >
            <div>
              <span
                className="rounded-[5px] px-[7px] py-[3px] font-[family-name:var(--adv-font-mono)] text-[9px] uppercase tracking-[0.08em]"
                style={{ background: severity.background, color: severity.color }}
              >
                {severity.label}
              </span>
            </div>
            <p className="m-0 mt-0.5 text-[13.5px] font-semibold leading-[1.35] text-[var(--adv-ink)]">
              {recommendation.title}
            </p>
            <p className="m-0 text-[12.5px] leading-[1.5] text-[var(--adv-ink-2)]">
              {recommendation.summary}
            </p>
            <div className="mt-auto flex flex-wrap items-center justify-between gap-2 pt-1.5">
              <span className="font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
                {evidence}
              </span>
              {onFocus ? (
                <button
                  type="button"
                  onClick={() => onFocus(recommendation)}
                  className="whitespace-nowrap text-[12px] font-semibold text-[var(--adv-accent)]"
                >
                  {recommendation.recommendedAction || "Review"} →
                </button>
              ) : null}
            </div>
          </article>
        );
      })}
    </section>
  );
}
