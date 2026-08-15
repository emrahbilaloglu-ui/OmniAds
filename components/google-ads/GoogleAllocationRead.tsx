"use client";

import type { GoogleRecommendation } from "@/lib/google-ads/growth-advisor-types";

/**
 * The design's "Allocation read" side panel. Each block is one advisor finding
 * for the given strategy layer, rendered as a mono label over its exact-change
 * chips. Directional only — restructures are applied from Advisor → Plan.
 */
export function GoogleAllocationRead({
  recommendations,
  layer,
  title = "Allocation read",
  subtitle,
  footnote,
  limit = 4,
}: {
  recommendations: GoogleRecommendation[];
  /** Advisor strategy layer this panel reads, e.g. "Shopping & Products". */
  layer: GoogleRecommendation["strategyLayer"];
  title?: string;
  subtitle: string;
  footnote: string;
  limit?: number;
}) {
  const scoped = recommendations
    .filter((item) => item.strategyLayer === layer)
    .sort((left, right) => (right.rankScore ?? 0) - (left.rankScore ?? 0))
    .slice(0, limit);

  if (scoped.length === 0) return null;

  return (
    <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
          {title}
        </h2>
        <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          {subtitle}
        </span>
      </div>
      <div className="flex flex-col gap-[11px] px-4 py-[13px]">
        {scoped.map((item) => {
          // Prefer the advisor's own reason codes; fall back to the finding itself
          // so a block never renders with a label and no content.
          const chips =
            item.reasonCodes.length > 0
              ? item.reasonCodes
              : [item.recommendedAction || item.summary].filter(Boolean);
          return (
            <div key={item.id}>
              <p className="m-0 mb-[5px] font-[family-name:var(--adv-font-mono)] text-[9.5px] uppercase tracking-[0.06em] text-[var(--adv-ink-3)]">
                {item.title}
              </p>
              <div className="flex flex-wrap gap-1.5">
                {chips.map((chip, index) => (
                  <span
                    key={`${item.id}-${index}`}
                    className="rounded-[7px] border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[9px] py-[3px] text-[12px] text-[var(--adv-ink)]"
                  >
                    {chip}
                  </span>
                ))}
              </div>
            </div>
          );
        })}
        <p className="m-0 text-[11.5px] leading-[1.5] text-[var(--adv-ink-4)]">{footnote}</p>
      </div>
    </article>
  );
}
