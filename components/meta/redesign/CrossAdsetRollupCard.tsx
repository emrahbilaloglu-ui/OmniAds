"use client";

import { ArrowRight, Layers } from "lucide-react";
import { ConfidencePill, DecisionLabelChip } from "@/components/common/briefing";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";
import { decisionLabelForRec, evidenceValue } from "@/components/meta/redesign/meta-card-utils";

interface CrossAdsetRollupCardProps {
  campaignName: string;
  recs: MetaRecommendation[];
  onOpenRec?: (rec: MetaRecommendation) => void;
}

export function CrossAdsetRollupCard({ campaignName, recs, onOpenRec }: CrossAdsetRollupCardProps) {
  if (recs.length < 2) return null;
  const totalSpend = recs.reduce((sum, rec) => sum + parseMetric(evidenceValue(rec, "Ad set spend") ?? evidenceValue(rec, "Spend")), 0);
  const roasValues = recs
    .map((rec) => parseMetric(evidenceValue(rec, "Ad set ROAS") ?? evidenceValue(rec, "Core ROAS")))
    .filter((value) => value > 0);
  const averageRoas = roasValues.length > 0 ? roasValues.reduce((sum, value) => sum + value, 0) / roasValues.length : 0;
  const primary = recs
    .slice()
    .sort((left, right) => (right.confidenceScore ?? 0) - (left.confidenceScore ?? 0))[0];

  return (
    <article className="relative rounded-2xl border border-slate-200 bg-white p-4 shadow-[0_1px_2px_rgba(15,23,42,0.04)]" data-card="cross-adset-rollup">
      <div className="absolute -right-1 -top-1 h-full w-full rounded-2xl border border-slate-100 bg-slate-50 -z-10" />
      <div className="flex items-center gap-2">
        <div className="rounded-md bg-violet-50 p-2 text-violet-700">
          <Layers className="inline-block shrink-0" size={16} aria-hidden="true" />
        </div>
        <div>
          <div className="text-[13px] font-semibold text-slate-900">{campaignName}</div>
          <div className="text-[11.5px] text-slate-500">Cross-adset rollup · mixed decisions</div>
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
            Mixed
          </span>
          <DecisionLabelChip label="review_adsets" surface="meta" size="sm">
            Review adsets
          </DecisionLabelChip>
        </div>
      </div>

      <p className="mt-3 text-[12.5px] leading-snug text-slate-600">
        {recs.length} ad sets under this campaign are pulling in different directions. Review the child decisions before applying one campaign-level move.
      </p>

      <div className="mt-3 grid grid-cols-3 gap-2">
        <MetricTile label="Adsets" value={String(recs.length)} />
        <MetricTile label="Spend" value={totalSpend > 0 ? formatCurrency(totalSpend) : "mixed"} />
        <MetricTile label="Avg ROAS" value={averageRoas > 0 ? formatRoas(averageRoas) : "mixed"} />
      </div>

      <div className="mt-3 divide-y divide-slate-100 rounded-lg border border-slate-100">
        {recs.slice(0, 5).map((rec) => (
          <button
            key={rec.id}
            type="button"
            className="flex w-full items-center gap-2 px-3 py-2 text-left hover:bg-slate-50"
            onClick={() => onOpenRec?.(rec)}
          >
            <span className="min-w-0 flex-1 truncate text-[12.5px] font-medium text-slate-800">
              {rec.adsetName ?? rec.title}
            </span>
            <DecisionLabelChip label={decisionLabelForRec(rec)} surface="meta" size="sm" />
            <ConfidencePill confidence={Math.round((rec.confidenceScore ?? 0.5) * 100)} size="sm" />
            <span className="hidden min-w-[72px] text-right font-mono text-[10.5px] text-slate-500 md:inline">
              {evidenceValue(rec, "Ad set ROAS") ?? evidenceValue(rec, "Core ROAS") ?? "no ROAS"}
            </span>
          </button>
        ))}
      </div>
      <button
        type="button"
        className="mt-3 inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-slate-800"
        onClick={() => {
          if (primary) onOpenRec?.(primary);
        }}
      >
        Review adsets
        <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />
      </button>
    </article>
  );
}

function MetricTile({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5">
      <div className="text-[10px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className="mt-0.5 truncate font-mono text-[12px] text-slate-800">{value}</div>
    </div>
  );
}

function parseMetric(value: string | null | undefined) {
  if (!value) return 0;
  const parsed = Number(value.replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : 0;
}
