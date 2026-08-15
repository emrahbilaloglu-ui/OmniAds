"use client";

import { cn } from "@/lib/utils";
import type { DecisionEvidenceFloor, DecisionPolicyExplanation } from "@/src/types/decision-trust";

function formatLabel(value: string) {
  return value.replaceAll("_", " ");
}

function floorTone(status: DecisionEvidenceFloor["status"]) {
  if (status === "met") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (status === "watch") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function compareTone(state: DecisionPolicyExplanation["compare"]["cutoverState"]) {
  if (state === "candidate_active") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (state === "baseline_locked") return "border-amber-200 bg-amber-50 text-amber-700";
  return "border-slate-200 bg-slate-100 text-slate-700";
}

function FloorGroup({
  title,
  items,
}: {
  title: string;
  items: DecisionEvidenceFloor[];
}) {
  if (items.length === 0) return null;
  return (
    <div>
      <p className="text-[10px] font-semibold uppercase tracking-[0.16em] text-slate-400">
        {title}
      </p>
      <div className="mt-2 flex flex-wrap gap-2">
        {items.map((item) => (
          <div
            key={`${title}:${item.key}:${item.current}`}
            className={cn("rounded-xl border px-2.5 py-2 text-[11px]", floorTone(item.status))}
          >
            <p className="font-semibold">{item.label}</p>
            <p className="mt-1">{item.current}</p>
            {item.reason ? <p className="mt-1 text-[10px] opacity-80">{item.reason}</p> : null}
          </div>
        ))}
      </div>
    </div>
  );
}

export function DecisionPolicyExplanationPanel({
  explanation,
  title,
  className,
}: {
  explanation: DecisionPolicyExplanation | null | undefined;
  title?: string;
  className?: string;
}) {
  if (!explanation) return null;

  return (
    <section className={cn("rounded-2xl border border-slate-200 bg-white p-4", className)}>
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            {title ?? "Policy Review"}
          </p>
          <p className="mt-1 text-sm text-slate-700">{explanation.summary}</p>
        </div>
        <div
          className={cn(
            "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
            compareTone(explanation.compare.cutoverState),
          )}
        >
          {formatLabel(explanation.compare.cutoverState)}
        </div>
      </div>

      <p className="mt-3 text-xs text-slate-600">
        Baseline {formatLabel(explanation.compare.baselineAction)} · candidate{" "}
        {formatLabel(explanation.compare.candidateAction)} · selected{" "}
        {formatLabel(explanation.compare.selectedAction)}
      </p>
      <p className="mt-1 text-xs text-slate-500">{explanation.compare.reason}</p>

      <div className="mt-4 space-y-4">
        <FloorGroup title="Evidence Hits" items={explanation.evidenceHits} />
        <FloorGroup title="Missing Evidence" items={explanation.missingEvidence} />
        <FloorGroup title="Blockers" items={explanation.blockers} />
      </div>

      {explanation.degradedReasons.length > 0 ? (
        <div className="mt-4 rounded-xl border border-amber-200 bg-amber-50 px-3 py-2 text-xs text-amber-800">
          Degraded reasons: {explanation.degradedReasons.join(", ")}
        </div>
      ) : null}

      <div className="mt-4 space-y-2 text-xs text-slate-600">
        {explanation.actionCeiling ? <p>Action ceiling: {explanation.actionCeiling}</p> : null}
        {explanation.protectedWinnerHandling ? (
          <p>Protected winners: {explanation.protectedWinnerHandling}</p>
        ) : null}
        {explanation.fatigueOrComeback ? (
          <p>Fatigue / comeback: {explanation.fatigueOrComeback}</p>
        ) : null}
        {explanation.supplyPlanning ? <p>Supply planning: {explanation.supplyPlanning}</p> : null}
      </div>
    </section>
  );
}
