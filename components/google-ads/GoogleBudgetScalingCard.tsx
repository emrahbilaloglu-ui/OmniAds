"use client";

import type {
  BudgetCampaign,
  BudgetRec,
} from "@/components/google-ads/BudgetScalingTab";

/**
 * The design's Overview "Budget & scaling" card: a KPI strip over the advisor's
 * suggested budget shifts. This surface is a PREVIEW only — the design's own
 * subtitle says the shifts are applied as guarded writes from the Plan page, so
 * nothing here mutates a provider.
 */
export function GoogleBudgetScalingCard({
  campaigns,
  recommendations,
  currencyFormatter,
}: {
  campaigns: BudgetCampaign[];
  recommendations: BudgetRec[];
  currencyFormatter: (value: number) => string;
}) {
  if (campaigns.length === 0 && recommendations.length === 0) return null;

  const dailyBudgetTotal = campaigns.reduce(
    (sum, row) => sum + (Number.isFinite(row.dailyBudget) ? row.dailyBudget : 0),
    0,
  );
  const cappedByBudget = campaigns.filter(
    (row) => row.lostIsBudget !== null && row.lostIsBudget !== undefined && row.lostIsBudget > 0,
  );
  const increases = recommendations.filter((item) => item.direction === "increase");
  const decreases = recommendations.filter((item) => item.direction === "decrease");
  // Only rows that carry a served change amount enter the net; a bucket that
  // gives direction alone must not be counted as a zero-value move.
  const scored = recommendations.filter((item) => item.suggestedBudgetChange !== null);
  const netShift = scored.reduce(
    (sum, item) =>
      sum +
      (item.direction === "increase"
        ? (item.suggestedBudgetChange as number)
        : -(item.suggestedBudgetChange as number)),
    0,
  );

  const kpis: Array<{ label: string; value: string; sub: string }> = [
    {
      label: "Daily budget",
      value: currencyFormatter(dailyBudgetTotal),
      sub: `${campaigns.length} campaign${campaigns.length === 1 ? "" : "s"}`,
    },
    {
      label: "Capped by budget",
      value: String(cappedByBudget.length),
      sub: "losing impression share",
    },
    {
      label: "Suggested moves",
      value: String(recommendations.length),
      sub: `${increases.length} up · ${decreases.length} down`,
    },
    {
      label: "Net shift",
      value:
        scored.length === 0
          ? "—"
          : `${netShift >= 0 ? "+" : "−"}${currencyFormatter(Math.abs(netShift))}`,
      sub:
        scored.length === 0
          ? "no change amount served"
          : Math.abs(netShift) < 0.5
            ? "budget-neutral"
            : "vs today's budget",
    },
  ];

  return (
    <article className="overflow-hidden rounded-[14px] border border-[var(--adv-border)] bg-[var(--adv-surface)]">
      <div className="flex flex-wrap items-center gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className="m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]">
          Budget &amp; scaling
        </h2>
        <span className="font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          suggested shifts are advisor previews — applied as guarded writes from the Plan page
        </span>
      </div>

      <div className="grid border-b border-[var(--adv-hairline)] [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {kpis.map((kpi) => (
          <div
            key={kpi.label}
            className="border-r border-[var(--adv-hairline)] px-4 py-3 last:border-r-0"
          >
            <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[9px] uppercase tracking-[0.09em] text-[var(--adv-ink-4)]">
              {kpi.label}
            </p>
            <p className="m-0 mt-1 font-[family-name:var(--adv-font-display)] text-[19px] font-bold tabular-nums text-[var(--adv-ink)]">
              {kpi.value}
            </p>
            <p className="m-0 mt-0.5 text-[11px] text-[var(--adv-ink-3)]">{kpi.sub}</p>
          </div>
        ))}
      </div>

      {recommendations.length > 0 ? (
        <div className="grid gap-2.5 px-4 py-3 [grid-template-columns:repeat(auto-fit,minmax(260px,1fr))]">
          {recommendations.map((item, index) => {
            const up = item.direction === "increase";
            return (
              <div
                key={`${item.campaign}-${index}`}
                className="rounded-[10px] border border-[var(--adv-hairline)] px-[13px] py-[11px]"
              >
                <div className="flex items-center justify-between gap-2">
                  <span className="text-[12.5px] font-semibold text-[var(--adv-ink)]">
                    {item.campaign}
                  </span>
                  <span
                    className="rounded-md px-2 py-0.5 text-[11.5px] font-bold tabular-nums"
                    style={
                      up
                        ? { background: "var(--adc-pos-bg)", color: "var(--adc-pos-fg)" }
                        : { background: "var(--adc-caution-bg)", color: "var(--adc-caution-fg)" }
                    }
                  >
                    {up ? "+" : "−"}
                    {item.suggestedBudgetChange === null
                      ? (up ? "Scale up" : "Pull back")
                      : currencyFormatter(Math.abs(item.suggestedBudgetChange))}
                  </span>
                </div>
                <p className="m-0 mt-1.5 text-[11.5px] leading-[1.5] text-[var(--adv-ink-3)]">
                  {item.reason}
                </p>
              </div>
            );
          })}
        </div>
      ) : null}
    </article>
  );
}
