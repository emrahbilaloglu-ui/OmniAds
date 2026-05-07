"use client";

import { Layers } from "lucide-react";
import { ConfidencePill, DecisionLabelChip } from "@/components/common/briefing";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { decisionLabelForRec } from "@/components/meta/redesign/meta-card-utils";

interface CrossAdsetRollupCardProps {
  campaignName: string;
  recs: MetaRecommendation[];
  onOpenRec?: (rec: MetaRecommendation) => void;
}

export function CrossAdsetRollupCard({ campaignName, recs, onOpenRec }: CrossAdsetRollupCardProps) {
  if (recs.length < 2) return null;
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
        <span className="ml-auto rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wider text-slate-600">
          Mixed
        </span>
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
          </button>
        ))}
      </div>
    </article>
  );
}
