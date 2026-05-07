import type { ReactNode } from "react";
import { GitCompare, TrendingUp, X, Rocket, ArrowRight } from "lucide-react";
import type { DecisionLabel } from "@/components/common/briefing/types";
import { DecisionLabelChip } from "@/components/common/briefing/DecisionLabelChip";
import { formatCurrency, formatRoas, initials, sparklinePath, tileFor } from "@/lib/briefing/utils";

export interface CompareDrawerItem {
  id: string;
  name: string;
  brand?: string;
  label: DecisionLabel;
  spend?: number;
  roas?: number;
  ctr?: number;
  cpa?: number;
  purchases?: number;
  frequency?: number;
  sparkline?: number[];
}

export interface CompareDrawerMetric {
  key: string;
  label: string;
  format: (value: number) => string;
  getValue: (item: CompareDrawerItem) => number;
}

interface CompareDrawerProps {
  open: boolean;
  items: CompareDrawerItem[];
  metrics?: CompareDrawerMetric[];
  actionBar?: ReactNode;
  onClose?: () => void;
}

const DEFAULT_METRICS: CompareDrawerMetric[] = [
  { key: "spend", label: "Spend (28d)", getValue: (item) => item.spend ?? 0, format: formatCurrency },
  { key: "roas", label: "ROAS (28d)", getValue: (item) => item.roas ?? 0, format: formatRoas },
  { key: "ctr", label: "CTR", getValue: (item) => item.ctr ?? 0, format: (value) => `${value.toFixed(2)}%` },
  { key: "cpa", label: "CPA", getValue: (item) => item.cpa ?? 0, format: (value) => `$${value.toFixed(2)}` },
  { key: "purchases", label: "Purchases", getValue: (item) => item.purchases ?? 0, format: (value) => value.toString() },
  { key: "frequency", label: "Frequency", getValue: (item) => item.frequency ?? 0, format: (value) => value.toFixed(1) },
];

export function CompareDrawer({
  open,
  items,
  metrics = DEFAULT_METRICS,
  actionBar,
  onClose,
}: CompareDrawerProps) {
  if (!open) return null;

  const cards = items.slice(0, 5);
  const outliers = calculateOutliers(cards, metrics);

  return (
    <div className="fixed inset-x-0 bottom-0 z-40" data-drawer="compare">
      <div className="bg-white border-t border-slate-200 shadow-[0_-4px_24px_rgba(15,23,42,0.08)]">
        <div className="max-w-[1440px] mx-auto px-6 py-3 border-b border-slate-200 flex items-center gap-3">
          <div className="text-[14px] font-semibold text-slate-900 flex items-center gap-2">
            <GitCompare className="inline-block shrink-0" size={15} aria-hidden="true" />
            Compare {cards.length} creatives
          </div>
          <span className="text-[12px] text-slate-500">
            Diff highlights in <span className="text-amber-700 font-medium">amber</span>
          </span>
          {onClose ? (
            <button
              type="button"
              aria-label="Close compare drawer"
              className="ml-auto text-slate-400 hover:text-slate-900 px-2 py-1"
              data-drawer-close
              onClick={onClose}
            >
              <X className="inline-block shrink-0" size={16} aria-hidden="true" />
            </button>
          ) : null}
        </div>

        <div
          className="max-w-[1440px] mx-auto px-6 py-4 grid gap-3"
          style={{ gridTemplateColumns: `140px repeat(${cards.length}, minmax(0,1fr))` }}
        >
          <div />
          {cards.map((card) => {
            const [bg, fg] = tileFor(card.name);
            return (
              <div key={card.id} className="flex flex-col items-start gap-2">
                <div className={`${bg} ${fg} rounded-lg grid place-items-center font-semibold w-full`} style={{ height: 80, fontSize: 18 }}>
                  {initials(card.name)}
                </div>
                <div className="text-[12.5px] font-medium text-slate-900 leading-tight">{card.name}</div>
                {card.brand ? <div className="text-[10.5px] text-slate-500">{card.brand}</div> : null}
                <DecisionLabelChip label={card.label} size="sm" />
              </div>
            );
          })}

          {metrics.map((metric) => (
            <MetricRow
              key={metric.key}
              metric={metric}
              cards={cards}
              outliers={outliers[metric.key] ?? []}
            />
          ))}

          <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold flex items-center">
            28d ROAS trend
          </div>
          {cards.map((card) => (
            <div key={`${card.id}-sparkline`} className="rounded-md border border-slate-100 bg-slate-50/50 p-2">
              <svg viewBox="0 0 60 16" width="200" height="36" className={(card.roas ?? 0) >= 2 ? "text-emerald-500" : "text-rose-500"} preserveAspectRatio="none">
                <path
                  d={sparklinePath(card.sparkline ?? [card.roas ?? 0, card.roas ?? 0, card.roas ?? 0, card.roas ?? 0, card.roas ?? 0])}
                  fill="none"
                  stroke="currentColor"
                  strokeWidth="1.5"
                />
              </svg>
            </div>
          ))}
        </div>

        <div className="max-w-[1440px] mx-auto px-6 py-3 border-t border-slate-200 bg-slate-50 flex items-center gap-2">
          {actionBar ?? (
            <>
              <button type="button" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-rose-600 text-white border border-rose-600 hover:bg-rose-700 text-[12.5px] font-medium">
                <X className="inline-block shrink-0" size={13} aria-hidden="true" /> Cut weakest
              </button>
              <button type="button" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 text-white border border-emerald-600 hover:bg-emerald-700 text-[12.5px] font-medium">
                <TrendingUp className="inline-block shrink-0" size={13} aria-hidden="true" /> Scale strongest
              </button>
              <button type="button" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 text-[12.5px] font-medium">
                <Rocket className="inline-block shrink-0" size={13} aria-hidden="true" /> Launch test with these <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />
              </button>
              <span className="ml-auto text-[11.5px] text-slate-500">Tip: shift-click 2–5 cards anywhere to compare</span>
            </>
          )}
        </div>
      </div>
    </div>
  );
}

function MetricRow({
  metric,
  cards,
  outliers,
}: {
  metric: CompareDrawerMetric;
  cards: CompareDrawerItem[];
  outliers: boolean[];
}) {
  return (
    <>
      <div className="text-[10.5px] uppercase tracking-wider text-slate-400 font-semibold flex items-center">
        {metric.label}
      </div>
      {cards.map((card, index) => {
        const highlighted = outliers[index];
        return (
          <div
            key={`${metric.key}-${card.id}`}
            className={[
              "rounded-md px-2 py-1.5 font-mono tabular-nums text-[12.5px]",
              highlighted
                ? "bg-amber-50 border border-amber-200 text-amber-800 font-semibold"
                : "border border-slate-100 text-slate-800",
            ].join(" ")}
          >
            {metric.format(metric.getValue(card))}
          </div>
        );
      })}
    </>
  );
}

export function calculateOutliers(
  cards: CompareDrawerItem[],
  metrics: CompareDrawerMetric[],
): Record<string, boolean[]> {
  return Object.fromEntries(
    metrics.map((metric) => {
      const values = cards.map((card) => metric.getValue(card));
      const min = Math.min(...values);
      const max = Math.max(...values);
      const range = max - min || 1;
      const median = values.slice().sort((a, b) => a - b)[Math.floor(values.length / 2)] ?? 0;
      return [metric.key, values.map((value) => Math.abs(value - median) / range > 0.5)];
    }),
  );
}
