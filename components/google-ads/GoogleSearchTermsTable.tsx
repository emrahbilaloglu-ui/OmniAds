"use client";

import type { SearchIntelligenceRow } from "@/components/google-ads/google-ads-dashboard-support";

/**
 * The design's search-terms table: one row per served term, the intent chip and
 * the keyword-opportunity flag under the term itself, and the ROAS chip carrying
 * the only colour in the row.
 *
 * Clicks are not on the search-intelligence row, so that column renders an em
 * dash rather than a derived stand-in. CPA is spend / conversions, which the
 * same report already implies.
 */

const HEAD =
  "bg-[var(--adv-fill)] px-3 py-[9px] font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--adv-ink-3)]";

const INTENT_TONE: Record<string, { bg: string; fg: string }> = {
  brand: { bg: "var(--adc-info-bg)", fg: "var(--adc-info-fg)" },
  non_brand: { bg: "var(--adv-fill-2)", fg: "var(--adv-ink-2)" },
  competitor: { bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" },
  sku_specific: { bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" },
  weak_commercial: { bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" },
};

function roasTone(roas: number, target: number | null) {
  if (!Number.isFinite(roas) || roas <= 0) {
    return { bg: "var(--adv-fill-2)", fg: "var(--adv-ink-3)" };
  }
  if (target && roas >= target) return { bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" };
  if (target && roas < target * 0.75) {
    return { bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  }
  return { bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
}

export function GoogleSearchTermsTable({
  rows,
  currencyFormatter,
  targetRoas = null,
}: {
  rows: SearchIntelligenceRow[];
  currencyFormatter: (value: number) => string;
  targetRoas?: number | null;
}) {
  if (rows.length === 0) return null;

  return (
    <>
      <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
        <div className="overflow-x-auto">
          <table className="w-full min-w-[880px] border-collapse text-[13px] tabular-nums">
            <thead>
              <tr>
                <th className={`${HEAD} px-4 text-left`}>Search term</th>
                <th className={`${HEAD} text-left`}>Campaign</th>
                <th className={`${HEAD} text-right`}>Clicks</th>
                <th className={`${HEAD} text-right`}>Conv</th>
                <th className={`${HEAD} text-right`}>CPA</th>
                <th className={`${HEAD} text-right`}>Conv value</th>
                <th className={`${HEAD} text-right`}>ROAS</th>
                <th className={`${HEAD} text-right`}>CTR</th>
                <th className={`${HEAD} px-4 text-right`}>Spend</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row, index) => {
                const intent = row.ownershipClass ?? row.intent ?? null;
                const tone = intent ? INTENT_TONE[intent] : undefined;
                const conversions = Number(row.conversions) || 0;
                const spend = Number(row.spend) || 0;
                const cpa = conversions > 0 ? spend / conversions : null;
                const rt = roasTone(Number(row.roas), targetRoas);
                const wasteful = row.wasteFlag === true;
                return (
                  <tr
                    key={row.key ?? `${row.searchTerm}-${row.campaign ?? ""}-${index}`}
                    className="border-t border-[var(--adv-hairline)]"
                  >
                    <td className="px-4 py-2.5">
                      <span className="block font-semibold text-[var(--adv-ink)]">
                        {row.searchTerm}
                      </span>
                      <span className="mt-1 inline-flex gap-1">
                        {intent ? (
                          <span
                            className="rounded-md px-[7px] py-px text-[10px] font-semibold"
                            style={{
                              background: tone?.bg ?? "var(--adv-fill-2)",
                              color: tone?.fg ?? "var(--adv-ink-2)",
                            }}
                          >
                            {intent.replace(/_/g, " ")}
                          </span>
                        ) : null}
                        {row.keywordOpportunityFlag ? (
                          <span className="rounded-md bg-[var(--adc-auto-bg)] px-[7px] py-px text-[10px] font-semibold text-[var(--adc-auto-fg)]">
                            + KW opp
                          </span>
                        ) : null}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-[12px] text-[var(--adv-ink-3)]">
                      {row.campaign ?? "—"}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">—</td>
                    <td className="px-3 py-2.5 text-right font-semibold text-[var(--adv-ink)]">
                      {conversions.toLocaleString()}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {cpa === null ? "—" : currencyFormatter(cpa)}
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {currencyFormatter(Number(row.revenue) || 0)}
                    </td>
                    <td className="px-3 py-2.5 text-right">
                      <span
                        className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold"
                        style={{ background: rt.bg, color: rt.fg }}
                      >
                        {Number.isFinite(row.roas) && row.roas > 0
                          ? Number(row.roas).toFixed(2)
                          : "—"}
                      </span>
                    </td>
                    <td className="px-3 py-2.5 text-right text-[var(--adv-ink-2)]">
                      {typeof row.ctr === "number" ? `${(row.ctr * 100).toFixed(2)}%` : "—"}
                    </td>
                    <td
                      className="px-4 py-2.5 text-right"
                      style={{
                        fontWeight: wasteful ? 700 : 400,
                        color: wasteful ? "var(--adc-danger-fg)" : "var(--adv-ink-2)",
                      }}
                    >
                      {currencyFormatter(spend)}
                    </td>
                  </tr>
                );
              })}
            </tbody>
          </table>
        </div>
      </article>
      <p className="m-0 text-[11px] text-[var(--adv-ink-4)]">
        Wasteful = 30+ clicks, zero conversions, meaningful spend. The drafted
        negative pack applies from Advisor → Plan as one guarded write with a
        single receipt.
      </p>
    </>
  );
}
