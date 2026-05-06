"use client";

import { AlertTriangle, CheckCircle2, ClipboardList, Layers3 } from "lucide-react";
import type {
  CreativeDecisionCenterBuyerAction,
  DecisionCenterSnapshot,
} from "@/lib/creative-decision-center/contracts";
import { CREATIVE_DECISION_CENTER_BUYER_ACTIONS } from "@/lib/creative-decision-center/contracts";
import { cn } from "@/lib/utils";

const ACTION_LABELS: Record<CreativeDecisionCenterBuyerAction, string> = {
  scale: "Scale",
  cut: "Cut",
  refresh: "Refresh",
  protect: "Protect",
  test_more: "Test more",
  watch_launch: "Watch launch",
  fix_delivery: "Fix delivery",
  fix_policy: "Fix policy",
  diagnose_data: "Diagnose data",
};

const ACTION_TONES: Record<CreativeDecisionCenterBuyerAction, string> = {
  scale: "border-emerald-200 bg-emerald-50 text-emerald-800",
  cut: "border-rose-200 bg-rose-50 text-rose-800",
  refresh: "border-sky-200 bg-sky-50 text-sky-800",
  protect: "border-teal-200 bg-teal-50 text-teal-800",
  test_more: "border-indigo-200 bg-indigo-50 text-indigo-800",
  watch_launch: "border-blue-200 bg-blue-50 text-blue-800",
  fix_delivery: "border-amber-200 bg-amber-50 text-amber-800",
  fix_policy: "border-orange-200 bg-orange-50 text-orange-800",
  diagnose_data: "border-slate-200 bg-slate-50 text-slate-700",
};

export function CreativeDecisionCenterSurface({
  decisionCenter,
  onOpenRow,
}: {
  decisionCenter: DecisionCenterSnapshot | null;
  onOpenRow?: (rowId: string) => void;
}) {
  if (!decisionCenter) return null;

  const totalBucketItems = CREATIVE_DECISION_CENTER_BUYER_ACTIONS.reduce(
    (total, action) => total + (decisionCenter.actionBoard[action]?.length ?? 0),
    0,
  );
  const hasBrief = decisionCenter.todayBrief.length > 0;
  const hasRows = decisionCenter.rowDecisions.length > 0;
  const hasAggregates = decisionCenter.aggregateDecisions.length > 0;

  return (
    <section
      data-testid="creative-decision-center-surface"
      className="border-y border-slate-200 bg-white px-5 py-4"
    >
      <div className="flex flex-wrap items-start justify-between gap-4">
        <div className="min-w-0">
          <div className="flex items-center gap-2">
            <ClipboardList className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <h2 className="text-sm font-semibold text-slate-950">Decision Center V2.1</h2>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-600">
              {decisionCenter.contractVersion}
            </span>
          </div>
          <p className="mt-1 text-xs text-slate-500">
            {decisionCenter.rowDecisions.length} row decisions · {decisionCenter.aggregateDecisions.length} aggregate decisions · {totalBucketItems} action board items
          </p>
        </div>

        <div className="grid grid-cols-3 gap-2 text-right text-[11px] text-slate-500">
          <div>
            <p className="font-medium text-slate-900">{decisionCenter.dataFreshness.status}</p>
            <p>freshness</p>
          </div>
          <div>
            <p className="font-medium text-slate-900">{decisionCenter.configVersion}</p>
            <p>config</p>
          </div>
          <div>
            <p className="font-medium text-slate-900">{decisionCenter.adapterVersion}</p>
            <p>adapter</p>
          </div>
        </div>
      </div>

      {!hasBrief && !hasRows && !hasAggregates ? (
        <div className="mt-3 flex items-start gap-2 rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-600">
          <AlertTriangle className="mt-0.5 h-4 w-4 shrink-0 text-amber-600" aria-hidden="true" />
          <p>
            V2.1 is enabled, but this snapshot has no validated row or aggregate actions yet. Legacy Decision OS remains the active explanation surface.
          </p>
        </div>
      ) : null}

      <div className="mt-4 grid gap-4 lg:grid-cols-[minmax(0,1.1fr)_minmax(0,1fr)]">
        <div>
          <div className="mb-2 flex items-center gap-2">
            <CheckCircle2 className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Today Brief</h3>
          </div>
          {hasBrief ? (
            <div className="space-y-2">
              {decisionCenter.todayBrief.map((item) => (
                <button
                  key={item.id}
                  type="button"
                  onClick={() => {
                    const firstRowId = item.rowIds[0];
                    if (firstRowId) onOpenRow?.(firstRowId);
                  }}
                  className="block w-full rounded-md border border-slate-200 bg-white px-3 py-2 text-left text-sm hover:bg-slate-50"
                >
                  <span className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-400">
                    {item.priority}
                  </span>
                  <span className="mt-0.5 block text-slate-900">{item.text}</span>
                </button>
              ))}
            </div>
          ) : (
            <p className="rounded-md border border-slate-200 bg-slate-50 px-3 py-2 text-xs text-slate-500">
              No V2.1 brief items in this snapshot.
            </p>
          )}
        </div>

        <div>
          <div className="mb-2 flex items-center gap-2">
            <Layers3 className="h-4 w-4 text-slate-500" aria-hidden="true" />
            <h3 className="text-xs font-semibold uppercase tracking-[0.08em] text-slate-500">Action Board</h3>
          </div>
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3">
            {CREATIVE_DECISION_CENTER_BUYER_ACTIONS.map((action) => {
              const count = decisionCenter.actionBoard[action]?.length ?? 0;
              return (
                <div
                  key={action}
                  className={cn(
                    "rounded-md border px-3 py-2",
                    count > 0 ? ACTION_TONES[action] : "border-slate-200 bg-slate-50 text-slate-500",
                  )}
                >
                  <p className="text-[11px] font-semibold">{ACTION_LABELS[action]}</p>
                  <p className="mt-1 text-lg font-semibold tabular-nums">{count}</p>
                </div>
              );
            })}
          </div>
        </div>
      </div>
    </section>
  );
}
