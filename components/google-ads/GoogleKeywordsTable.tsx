"use client";

/**
 * The design's keyword table on the Search intelligence screen: the served
 * keyword report with Quality Score and impression share, the match type and
 * the QS components sitting under the keyword itself.
 *
 * Every column reads a Google-served field — nothing is derived here except CPA
 * when the report omits it, which is spend over conversions by definition.
 */

export interface GoogleKeywordRow {
  criterionId?: string | null;
  keywordText?: string;
  matchType?: string;
  campaignName?: string;
  adGroupName?: string;
  spend?: number;
  conversions?: number;
  cpa?: number | null;
  roas?: number;
  ctr?: number;
  impressionShare?: number | null;
  qualityScore?: number | null;
  expectedCtr?: string | null;
  adRelevance?: string | null;
  landingPageExperience?: string | null;
}

const HEAD =
  "bg-[var(--adv-fill)] px-3 py-[9px] font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--adv-ink-3)]";

/** Google reports Quality Score 1-10; 8+ reads as healthy, 5 and under as weak. */
function qsTone(score: number) {
  if (score >= 8) return { bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" };
  if (score <= 5) return { bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  return { bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
}

function percent(value: number | null | undefined) {
  if (typeof value !== "number" || !Number.isFinite(value)) return "—";
  // The report emits shares as fractions and rates as fractions alike.
  return `${(value * 100).toFixed(value < 0.1 ? 2 : 1)}%`;
}

export function GoogleKeywordsTable({
  rows,
  currencyFormatter,
}: {
  rows: GoogleKeywordRow[];
  currencyFormatter: (value: number) => string;
}) {
  if (rows.length === 0) return null;

  const withQs = rows.filter((row) => typeof row.qualityScore === "number");
  const weak = withQs.filter((row) => (row.qualityScore ?? 10) <= 5).length;
  const strong = withQs.filter((row) => (row.qualityScore ?? 0) >= 8).length;

  return (
    <>
      <div className="flex flex-wrap gap-2.5">
        {[
          { n: rows.length, label: "keywords", fg: "var(--adv-ink)" },
          { n: strong, label: "quality score 8+", fg: "var(--adc-pos-fg)" },
          { n: weak, label: "quality score ≤5", fg: "var(--adc-danger-fg)" },
        ].map((stat) => (
          <span
            key={stat.label}
            className="inline-flex items-center gap-[7px] rounded-full border border-[var(--adv-border)] bg-[var(--adv-surface)] px-[13px] py-1.5 text-[12px] text-[var(--adv-ink-2)]"
          >
            <span className="font-bold" style={{ color: stat.fg }}>
              {stat.n}
            </span>
            {stat.label}
          </span>
        ))}
      </div>

      <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-[13px] tabular-nums">
            <thead>
              <tr>
                <th className={`${HEAD} px-4 text-left`}>Keyword</th>
                <th className={`${HEAD} text-left`}>Campaign</th>
                <th className={`${HEAD} text-right`}>Spend</th>
                <th className={`${HEAD} text-right`}>Conv</th>
                <th className={`${HEAD} text-right`}>CPA</th>
                <th className={`${HEAD} text-right`}>ROAS</th>
                <th className={`${HEAD} text-right`}>QS</th>
                <th className={`${HEAD} text-right`}>IS</th>
                <th className={`${HEAD} px-4 text-right`}>CTR</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const spend = Number(row.spend) || 0;
                const conversions = Number(row.conversions) || 0;
                const cpa =
                  typeof row.cpa === "number" && Number.isFinite(row.cpa)
                    ? row.cpa
                    : conversions > 0
                      ? spend / conversions
                      : null;
                const qs = typeof row.qualityScore === "number" ? row.qualityScore : null;
                const tone = qs === null ? null : qsTone(qs);
                const components = [row.expectedCtr, row.adRelevance, row.landingPageExperience]
                  .filter(Boolean)
                  .join(" · ");
                return (
                  <tr
                    key={row.criterionId ?? `${row.keywordText}-${index}`}
                    className="border-t border-[var(--adv-hairline)]"
                  >
                    <td className="px-4 py-2.5">
                      <span className="block font-semibold text-[var(--adv-ink)]">
                        {row.keywordText ?? "—"}
                        {row.matchType ? (
                          <span className="ml-1.5 font-[family-name:var(--adv-font-mono)] text-[10px] font-normal uppercase tracking-[0.06em] text-[var(--adv-ink-4)]">
                            {row.matchType.replace(/_/g, " ").toLowerCase()}
                          </span>
                        ) : null}
                      </span>
                      {components ? (
                        <span className="mt-0.5 block text-[11px] text-[var(--adv-ink-4)]">
                          {components}
                        </span>
                      ) : null}
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-[var(--adv-ink-3)]">
                      {row.campaignName ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {currencyFormatter(spend)}
                    </td>
                    <td className="px-3 py-2.5 text-right font-semibold text-[var(--adv-ink)]">
                      {conversions.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {cpa === null ? "—" : currencyFormatter(cpa)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {typeof row.roas === "number" && row.roas > 0 ? row.roas.toFixed(2) : "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      {qs === null ? (
                        <span className="text-[var(--adv-ink-4)]">—</span>
                      ) : (
                        <span
                          className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold"
                          style={{ background: tone!.bg, color: tone!.fg }}
                        >
                          {qs}
                        </span>
                      )}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {percent(row.impressionShare)}
                    </td>
                    <td className="px-4 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {percent(row.ctr)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
      <p className="m-0 text-[11px] text-[var(--adv-ink-4)]">
        Quality Score and its components (expected CTR · ad relevance · landing
        page) are Google-served, refreshed each sync.
      </p>
    </>
  );
}
