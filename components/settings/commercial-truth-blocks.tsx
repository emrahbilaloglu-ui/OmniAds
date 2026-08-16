"use client";

import { useQuery } from "@tanstack/react-query";

/**
 * The three design blocks that sit around the target pack on Commercial Truth:
 * the revenue split derived from the pack, the register of surfaces that read
 * it, and the saved change history.
 *
 * Every number in the split comes from the pack the operator saved — nothing is
 * assumed, and a cost the pack leaves unset drops out of the bar instead of
 * being guessed at.
 */

const CARD =
  "rounded-2xl border border-[var(--adv-border)] bg-[var(--adv-surface)]";

const TITLE =
  "m-0 font-[family-name:var(--adv-font-display)] text-[15px] font-semibold text-[var(--adv-ink)]";

const SUB = "font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]";

export interface RevenueSplitInput {
  cogsPercent: number | null;
  shippingPercent: number | null;
  fulfillmentPercent: number | null;
  paymentProcessingPercent: number | null;
  /** Fixed costs expressed against the same window's revenue. */
  fixedCostShare?: number | null;
  /** Blended MER for the window: ad spend as a share of revenue. */
  adSpendShare: number | null;
}

const SEGMENT_TONES = [
  "var(--adc-info-fg)",
  "var(--adc-caution-fg)",
  "var(--adv-ink-3)",
  "var(--adv-ink-4)",
  "var(--adc-auto-fg)",
  "var(--adv-accent)",
];

export function CommercialRevenueSplit({ input }: { input: RevenueSplitInput }) {
  const costs = [
    { k: "COGS", share: input.cogsPercent },
    { k: "Shipping", share: input.shippingPercent },
    { k: "Fulfillment", share: input.fulfillmentPercent },
    { k: "Payment fees", share: input.paymentProcessingPercent },
    { k: "Fixed costs", share: input.fixedCostShare ?? null },
    { k: "Ads", share: input.adSpendShare },
  ].filter((item): item is { k: string; share: number } =>
    typeof item.share === "number" && Number.isFinite(item.share) && item.share > 0,
  );

  if (costs.length === 0) {
    return (
      <article className={`${CARD} p-[18px]`}>
        <div className="flex items-baseline gap-2.5">
          <h2 className={TITLE}>Where $100 of revenue goes</h2>
          <span className={SUB}>derived from this pack</span>
        </div>
        <p className="m-0 mt-3 text-[12px] leading-[1.55] text-[var(--adv-ink-3)]">
          Save a cost structure above and this splits every $100 of revenue
          across COGS, shipping, fulfilment, payment fees, ads and contribution.
        </p>
      </article>
    );
  }

  const consumed = costs.reduce((sum, item) => sum + item.share, 0);
  const contribution = Math.max(0, 1 - consumed);
  const segments = [
    ...costs.map((item, index) => ({
      ...item,
      bg: SEGMENT_TONES[index % SEGMENT_TONES.length],
    })),
    { k: "Contribution", share: contribution, bg: "var(--adc-pos-fg)" },
  ];
  const dollars = (share: number) => `$${(share * 100).toFixed(0)}`;
  const adShare = input.adSpendShare;

  return (
    <article className={`${CARD} p-[18px]`}>
      <div className="flex items-baseline gap-2.5">
        <h2 className={TITLE}>Where $100 of revenue goes</h2>
        <span className={SUB}>derived from this pack</span>
      </div>
      <div className="mt-3 flex h-9 overflow-hidden rounded-[10px]">
        {segments.map((segment) => (
          <span
            key={segment.k}
            style={{ width: `${segment.share * 100}%`, background: segment.bg }}
            title={`${segment.k} · ${dollars(segment.share)}`}
          />
        ))}
      </div>
      <div className="mt-3 flex flex-wrap gap-x-[18px] gap-y-2">
        {segments.map((segment) => (
          <span key={segment.k} className="inline-flex items-center gap-1.5">
            <span
              className="h-[9px] w-[9px] rounded-[3px]"
              style={{ background: segment.bg }}
            />
            <span className="text-[12px] text-[var(--adv-ink-2)]">{segment.k}</span>
            <span className="text-[11px] tabular-nums text-[var(--adv-ink)]">
              {dollars(segment.share)}
            </span>
          </span>
        ))}
      </div>
      <p className="m-0 mt-3 text-[12px] leading-[1.55] text-[var(--adv-ink-3)]">
        {typeof adShare === "number"
          ? `At the current blended MER, ${dollars(adShare)} of every $100 goes to ads and ${dollars(contribution)} remains as contribution.`
          : `Costs in this pack take ${dollars(consumed)} of every $100; connect a platform so ad spend can take its share of the rest.`}
      </p>
    </article>
  );
}

export interface TruthConsumer {
  name: string;
  note: string;
  reads: string;
  tone: string;
}

/**
 * The surfaces that resolve their thresholds from this pack. The list is the
 * code's own consumer set, not a registry of observed reads — so it states what
 * each surface reads rather than claiming a last-read timestamp we do not log.
 */
export const TRUTH_CONSUMERS: TruthConsumer[] = [
  {
    name: "Meta Decisions",
    note: "Scale, hold and cut thresholds resolve from the pack's target and break-even ROAS.",
    reads: "target ROAS · break-even ROAS · contribution margin",
    tone: "var(--adc-info-fg)",
  },
  {
    name: "Creative Studio",
    note: "Creative verdicts compare each line against the same efficiency anchors.",
    reads: "target ROAS · target CPA",
    tone: "var(--adc-auto-fg)",
  },
  {
    name: "Google advisor",
    note: "Budget and structure recommendations are ranked against the pack's economics.",
    reads: "target ROAS · cost structure",
    tone: "var(--adc-pos-fg)",
  },
  {
    name: "Launchpad",
    note: "New campaign drafts inherit the pack's targets as their starting guardrails.",
    reads: "target ROAS · target CPA · risk posture",
    tone: "var(--adc-caution-fg)",
  },
];

export function CommercialConsumers() {
  return (
    <article className={`${CARD} overflow-hidden`}>
      <div className="flex items-baseline gap-2 border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className={TITLE}>Consumed by</h2>
        <span className={SUB}>{TRUTH_CONSUMERS.length} surfaces</span>
      </div>
      {TRUTH_CONSUMERS.map((consumer) => (
        <div
          key={consumer.name}
          className="flex gap-2.5 border-t border-[var(--adv-canvas)] px-4 py-3 first-of-type:border-t-0"
        >
          <span
            className="mt-1.5 h-2 w-2 shrink-0 rounded-full"
            style={{ background: consumer.tone }}
          />
          <div className="min-w-0 flex-1">
            <span className="text-[13px] font-semibold text-[var(--adv-ink)]">
              {consumer.name}
            </span>
            <p className="m-0 mt-[3px] text-[12px] leading-[1.5] text-[var(--adv-ink-3)]">
              {consumer.note}
            </p>
            <p className="m-0 mt-1 font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
              reads: {consumer.reads}
            </p>
          </div>
        </div>
      ))}
    </article>
  );
}

interface HistoryEntry {
  id: string;
  at: string;
  operation: "upsert" | "delete";
  sourceLabel: string | null;
  actor: string | null;
  changes: string[];
}

export function CommercialChangeHistory({ businessId }: { businessId: string }) {
  const { data, isLoading } = useQuery<{ entries?: HistoryEntry[] }>({
    queryKey: ["commercial-truth-history", businessId],
    queryFn: async () => {
      const res = await fetch(
        `/api/business-commercial-settings/history?businessId=${encodeURIComponent(businessId)}`,
      );
      if (!res.ok) throw new Error("history fetch failed");
      return res.json();
    },
    staleTime: 60 * 1000,
  });

  const entries = data?.entries ?? [];

  return (
    <article className={`${CARD} overflow-hidden`}>
      <div className="border-b border-[var(--adv-hairline)] px-4 py-[13px]">
        <h2 className={TITLE}>Change history</h2>
      </div>
      {isLoading ? (
        <p className="m-0 px-4 py-3 text-[12px] text-[var(--adv-ink-4)]">
          Loading revisions…
        </p>
      ) : entries.length === 0 ? (
        <p className="m-0 px-4 py-3 text-[12px] text-[var(--adv-ink-4)]">
          No saved revision yet — the first pack you save appears here.
        </p>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.id}
            className="flex items-start gap-2.5 border-t border-[var(--adv-canvas)] px-4 py-[11px] first-of-type:border-t-0"
          >
            <span className="w-11 shrink-0 font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
              {new Date(entry.at).toLocaleDateString(undefined, {
                month: "short",
                day: "numeric",
              })}
            </span>
            <div className="min-w-0 flex-1">
              <p className="m-0 text-[12.5px] font-semibold text-[var(--adv-ink)]">
                {entry.changes.join(" · ")}
              </p>
              <p className="m-0 mt-0.5 text-[12px] text-[var(--adv-ink-3)]">
                {entry.sourceLabel ?? "manual save"}
                {entry.actor ? ` · ${entry.actor}` : ""}
              </p>
            </div>
          </div>
        ))
      )}
      <p className="m-0 border-t border-[var(--adv-canvas)] px-4 py-2.5 font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
        every change re-stamps downstream decisions on the next snapshot
      </p>
    </article>
  );
}

export interface SpendBandRow {
  name: string;
  spend: number;
  roas: number;
}

/**
 * The design's "Where spend sits against these targets": live campaign spend
 * labelled against the pack's own target and break-even ROAS. Editing either
 * threshold above re-labels every row, because the bands are derived here
 * rather than stored.
 */
export function CommercialSpendBands({
  rows,
  targetRoas,
  breakEvenRoas,
  currencyFormatter,
  coverageNote,
}: {
  rows: SpendBandRow[];
  targetRoas: number | null;
  breakEvenRoas: number | null;
  currencyFormatter: (value: number) => string;
  coverageNote: string;
}) {
  const spending = rows.filter((row) => Number(row.spend) > 0);

  if (targetRoas === null || breakEvenRoas === null || spending.length === 0) {
    return (
      <article className={`${CARD} overflow-hidden`}>
        <div className="flex items-baseline gap-2.5 px-[18px] pt-[15px]">
          <h2 className={TITLE}>Where spend sits against these targets</h2>
          <span className={SUB}>live preview</span>
        </div>
        <p className="m-0 px-[18px] pb-[15px] pt-3 text-[12px] leading-[1.55] text-[var(--adv-ink-3)]">
          {targetRoas === null || breakEvenRoas === null
            ? "Set a target and a break-even ROAS above, and every campaign re-labels against them here."
            : "No campaign carries spend in this window, so there is nothing to label yet."}
        </p>
      </article>
    );
  }

  const totalSpend = spending.reduce((sum, row) => sum + row.spend, 0);
  const bands = [
    {
      name: "Above target",
      range: `ROAS ≥ ${targetRoas.toFixed(2)}`,
      verdict: "scale candidates",
      tone: "var(--adc-pos-fg)",
      match: (roas: number) => roas >= targetRoas,
    },
    {
      name: "Target to break-even",
      range: `${breakEvenRoas.toFixed(2)} – ${targetRoas.toFixed(2)}`,
      verdict: "holding, not scaling",
      tone: "var(--adc-caution-fg)",
      match: (roas: number) => roas >= breakEvenRoas && roas < targetRoas,
    },
    {
      name: "Below break-even",
      range: `0 < ROAS < ${breakEvenRoas.toFixed(2)}`,
      verdict: "losing contribution",
      tone: "var(--adc-danger-fg)",
      match: (roas: number) => roas > 0 && roas < breakEvenRoas,
    },
    {
      name: "No return",
      range: "spend, zero revenue",
      verdict: "cut or diagnose",
      tone: "var(--adv-ink-3)",
      match: (roas: number) => !(roas > 0),
    },
  ].map((band) => {
    const members = spending.filter((row) => band.match(Number(row.roas) || 0));
    const spend = members.reduce((sum, row) => sum + row.spend, 0);
    return {
      ...band,
      n: members.length,
      spend,
      share: totalSpend > 0 ? spend / totalSpend : 0,
    };
  });

  return (
    <article className={`${CARD} overflow-hidden`}>
      <div className="flex flex-wrap items-baseline gap-2.5 px-[18px] pt-[15px]">
        <h2 className={TITLE}>Where spend sits against these targets</h2>
        <span className={SUB}>
          live preview — edit Target or Break-even ROAS above and every row re-labels
        </span>
      </div>
      <div className="grid gap-2.5 px-[18px] pb-1 pt-3.5 [grid-template-columns:repeat(auto-fit,minmax(180px,1fr))]">
        {bands.map((band) => (
          <div
            key={band.name}
            className="rounded-xl border border-[var(--adv-hairline)] bg-[var(--adv-fill)] px-[13px] py-2.5"
          >
            <div className="flex items-baseline gap-1.5">
              <span className="text-[12px] font-semibold text-[var(--adv-ink)]">{band.name}</span>
              <span className="font-[family-name:var(--adv-font-mono)] text-[9.5px] text-[var(--adv-ink-4)]">
                {band.range}
              </span>
            </div>
            <p className="m-0 mt-1.5 text-[17px] font-bold tabular-nums text-[var(--adv-ink)]">
              {currencyFormatter(band.spend)}
              <span className="ml-1 text-[12px] font-medium text-[var(--adv-ink-3)]">
                · {(band.share * 100).toFixed(0)}%
              </span>
            </p>
            <p className="m-0 mt-[3px] text-[12px] text-[var(--adv-ink-3)]">
              {band.n} {band.n === 1 ? "campaign" : "campaigns"} →{" "}
              <b style={{ color: band.tone }}>{band.verdict}</b>
            </p>
          </div>
        ))}
      </div>
      <div className="px-[18px] pb-3.5 pt-1.5">
        <div className="flex h-3 overflow-hidden rounded-md">
          {bands
            .filter((band) => band.share > 0)
            .map((band) => (
              <span
                key={band.name}
                style={{ width: `${band.share * 100}%`, background: band.tone }}
                title={`${band.name} · ${(band.share * 100).toFixed(0)}%`}
              />
            ))}
        </div>
        <p className="m-0 mt-1.5 font-[family-name:var(--adv-font-mono)] text-[10px] text-[var(--adv-ink-4)]">
          share of labeled ad spend · {coverageNote}
        </p>
      </div>
    </article>
  );
}
