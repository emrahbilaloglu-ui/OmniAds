"use client";

import type { Campaign } from "@/components/google-ads/google-ads-dashboard-support";

/**
 * The v2 design renders Google campaigns as one table: identity plus a channel
 * chip, budget, spend with a share bar, revenue, ROAS, conversions, impression
 * share, lost impression share to budget, and a delivery pulse chip.
 *
 * Every cell reads a served field. Daily budget is not on the campaign
 * performance row, so it is joined in from the budget report; a campaign missing
 * from that report renders an em dash rather than a derived number.
 */

function pct(value: number | null | undefined, digits = 0) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "—";
  return `${(value * 100).toFixed(digits)}%`;
}

function roasTone(roas: number, benchmark: number) {
  if (!Number.isFinite(roas) || roas <= 0) return "neutral" as const;
  if (roas >= benchmark) return "pos" as const;
  if (roas >= benchmark * 0.75) return "warn" as const;
  return "neg" as const;
}

const TONE_STYLE = {
  pos: { background: "var(--adc-pos-bg)", color: "var(--adc-pos-fg)" },
  warn: { background: "var(--adc-caution-bg)", color: "var(--adc-caution-fg)" },
  neg: { background: "var(--adc-danger-bg)", color: "var(--adc-danger-fg)" },
  neutral: { background: "var(--adv-fill-2)", color: "var(--adv-ink-2)" },
} as const;

/** The design's delivery pulse chip, driven by the server's action state. */
function pulseOf(row: Campaign): { label: string; tone: keyof typeof TONE_STYLE } {
  const state = String(row.actionState ?? "").toLowerCase();
  if (state.includes("scale") || state.includes("healthy") || state.includes("winner")) {
    return { label: "Scaling room", tone: "pos" };
  }
  if (state.includes("watch") || state.includes("monitor")) {
    return { label: "Watch", tone: "warn" };
  }
  if (state.includes("cut") || state.includes("loss") || state.includes("risk")) {
    return { label: "Losing money", tone: "neg" };
  }
  if (row.lostIsBudget !== null && row.lostIsBudget !== undefined && row.lostIsBudget > 0.1) {
    return { label: "Budget capped", tone: "warn" };
  }
  if (String(row.status ?? "").toUpperCase() !== "ENABLED") {
    return { label: "Not delivering", tone: "neutral" };
  }
  return { label: "Stable", tone: "neutral" };
}

const HEAD =
  "px-3 py-[9px] font-[family-name:var(--adv-font-mono)] text-[10px] font-medium uppercase tracking-[0.1em] text-[var(--adv-ink-3)] whitespace-nowrap bg-[var(--adv-fill)]";

export function GoogleCampaignsTable({
  rows,
  accountAvgRoas,
  currencyFormatter,
  dailyBudgetById,
}: {
  rows: Campaign[];
  accountAvgRoas: number;
  currencyFormatter: (value: number) => string;
  /** Daily budgets from the budget report, keyed by campaign id and lowercased name. */
  dailyBudgetById?: Map<string, number>;
}) {
  const benchmark = accountAvgRoas > 0 ? accountAvgRoas : 1;
  const activeCount = rows.filter(
    (row) => String(row.status ?? "").toUpperCase() === "ENABLED",
  ).length;

  return (
    <article className="overflow-x-auto rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
          Campaigns
        </h2>
        <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          {activeCount} active · vs account {benchmark.toFixed(2)} · impression-share signals are Google-served
        </span>
      </div>
      <table className="w-full min-w-[840px] border-collapse text-[13px] tabular-nums">
        <thead>
          <tr>
            <th className={`${HEAD} text-left`}>Campaign</th>
            <th className={`${HEAD} text-right`}>Daily budget</th>
            <th className={`${HEAD} text-right`}>Spend</th>
            <th className={`${HEAD} text-left`}>Share</th>
            <th className={`${HEAD} text-right`}>Revenue</th>
            <th className={`${HEAD} text-right`}>ROAS</th>
            <th className={`${HEAD} text-right`}>Conv</th>
            <th className={`${HEAD} text-right`}>IS</th>
            <th className={`${HEAD} text-right`}>Lost IS · budget</th>
            <th className={`${HEAD} text-left`}>Pulse</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((row) => {
            const tone = roasTone(row.roas, benchmark);
            const pulse = pulseOf(row);
            const sharePct = Math.max(0, Math.min(1, row.spendShare ?? 0));
            return (
              <tr key={row.id} className="border-t border-[var(--adv-hairline)]">
                <td className="px-4 py-[11px]">
                  <span className="block whitespace-nowrap font-semibold text-[var(--adv-ink)]">
                    {row.name}
                  </span>
                  <span className="mt-[3px] inline-flex rounded-md bg-[var(--adv-fill-2)] px-[7px] py-px text-[10px] font-semibold text-[var(--adv-ink-2)]">
                    {row.channel}
                  </span>
                </td>
                <td className="whitespace-nowrap px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                  {(() => {
                    const budget =
                      dailyBudgetById?.get(String(row.id)) ??
                      dailyBudgetById?.get(row.name.toLowerCase().trim());
                    return budget === undefined ? "—" : currencyFormatter(budget);
                  })()}
                </td>
                <td className="px-3 py-[11px] text-right font-semibold text-[var(--adv-ink)]">
                  {currencyFormatter(row.spend)}
                </td>
                <td className="min-w-[86px] px-3 py-[11px]">
                  <div className="flex items-center gap-[7px]">
                    <div className="h-[5px] min-w-[44px] flex-1 overflow-hidden rounded-full bg-[var(--adv-fill-2)]">
                      <div
                        className="h-full rounded-full bg-[var(--adv-accent)]"
                        style={{ width: `${(sharePct * 100).toFixed(1)}%` }}
                      />
                    </div>
                    <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-3)]">
                      {pct(row.spendShare)}
                    </span>
                  </div>
                </td>
                <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                  {currencyFormatter(row.revenue)}
                </td>
                <td className="px-3 py-[11px] text-right">
                  <span
                    className="inline-flex rounded-md px-2 py-0.5 text-[11.5px] font-bold"
                    style={TONE_STYLE[tone]}
                  >
                    {Number.isFinite(row.roas) ? `${row.roas.toFixed(2)}x` : "—"}
                  </span>
                </td>
                <td className="px-3 py-[11px] text-right text-[var(--adv-ink-2)]">
                  {Number.isFinite(row.conversions) ? row.conversions.toFixed(0) : "—"}
                </td>
                <td className="px-3 py-[11px] text-right font-[family-name:var(--adv-font-mono)] text-[12px] text-[var(--adv-ink-3)]">
                  {pct(row.impressionShare)}
                </td>
                <td
                  className="px-3 py-[11px] text-right font-semibold"
                  style={{
                    color:
                      row.lostIsBudget !== null &&
                      row.lostIsBudget !== undefined &&
                      row.lostIsBudget > 0
                        ? "var(--adc-caution-fg)"
                        : "var(--adv-ink-3)",
                  }}
                >
                  {pct(row.lostIsBudget)}
                </td>
                <td className="px-4 py-[11px]">
                  <span
                    className="inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-[10.5px] font-semibold"
                    style={TONE_STYLE[pulse.tone]}
                  >
                    {pulse.label}
                  </span>
                </td>
              </tr>
            );
          })}
        </tbody>
      </table>
    </article>
  );
}
