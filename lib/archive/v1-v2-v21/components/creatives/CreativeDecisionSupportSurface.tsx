"use client";

import { useMemo } from "react";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { OperatorSurfaceSummary } from "@/components/operator/OperatorSurfaceSummary";
import {
  buildCreativeOperatorSurfaceModel,
  buildCreativePreviewTruthSummary,
  type CreativePreviewTruthSummary,
  type CreativeQuickFilter,
  type CreativeQuickFilterKey,
} from "@/lib/creative-operator-surface";
import type { CreativeDecisionOsV1Response } from "@/lib/creative-decision-os";
import { cn } from "@/lib/utils";

function quickFilterToneClasses(
  filter: CreativeQuickFilter,
  active: boolean,
) {
  if (filter.tone === "act_now") {
    return active
      ? "border-emerald-700 bg-emerald-700 text-white"
      : "border-emerald-200 bg-emerald-50 text-emerald-800 hover:bg-emerald-100";
  }
  if (filter.tone === "needs_truth") {
    return active
      ? "border-amber-600 bg-amber-600 text-white"
      : "border-amber-200 bg-amber-50 text-amber-800 hover:bg-amber-100";
  }
  if (filter.tone === "blocked") {
    return active
      ? "border-orange-600 bg-orange-600 text-white"
      : "border-orange-200 bg-orange-50 text-orange-800 hover:bg-orange-100";
  }
  if (filter.tone === "watch") {
    return active
      ? "border-sky-600 bg-sky-600 text-white"
      : "border-sky-200 bg-sky-50 text-sky-800 hover:bg-sky-100";
  }
  return active
    ? "border-slate-700 bg-slate-700 text-white"
    : "border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100";
}

function previewTruthTone(summary: CreativePreviewTruthSummary | null | undefined) {
  if (!summary || summary.state === "ready") {
    return {
      panel: "border-emerald-200 bg-emerald-50/70",
      badge: "border-emerald-200 bg-emerald-100 text-emerald-900",
      stat: "border-emerald-200 bg-white",
    };
  }
  if (summary.state === "missing") {
    return {
      panel: "border-rose-200 bg-rose-50/70",
      badge: "border-rose-200 bg-rose-100 text-rose-900",
      stat: "border-rose-200 bg-white",
    };
  }
  return {
    panel: "border-amber-200 bg-amber-50/70",
    badge: "border-amber-200 bg-amber-100 text-amber-900",
    stat: "border-amber-200 bg-white",
  };
}

type CreativeDecisionSupportSurfaceProps = {
  decisionOs: CreativeDecisionOsV1Response | null | undefined;
  allRows: MetaCreativeRow[];
  selectedRows: MetaCreativeRow[];
  quickFilters?: CreativeQuickFilter[];
  activeQuickFilterKey?: CreativeQuickFilterKey | null;
  onToggleQuickFilter?: (key: CreativeQuickFilterKey) => void;
  className?: string;
};

export function CreativeDecisionSupportSurface({
  decisionOs,
  allRows,
  selectedRows,
  quickFilters = [],
  activeQuickFilterKey = null,
  onToggleQuickFilter,
  className,
}: CreativeDecisionSupportSurfaceProps) {
  const operatorSurface = useMemo(
    () =>
      buildCreativeOperatorSurfaceModel(decisionOs ?? null, {
        visibleIds: new Set(allRows.map((row) => row.id)),
      }),
    [allRows, decisionOs],
  );
  const previewTruthSummary = useMemo(
    () =>
      buildCreativePreviewTruthSummary(decisionOs ?? null, {
        creativeIds: allRows.map((row) => row.id),
      }),
    [allRows, decisionOs],
  );
  const selectedPreviewTruthSummary = useMemo(
    () =>
      selectedRows.length > 0
        ? buildCreativePreviewTruthSummary(decisionOs ?? null, {
            creativeIds: selectedRows.map((row) => row.id),
          })
        : null,
    [decisionOs, selectedRows],
  );
  const previewTruthClasses = previewTruthTone(previewTruthSummary);

  if (!previewTruthSummary && quickFilters.length === 0 && !operatorSurface) {
    return null;
  }

  return (
    <div className={cn("space-y-4", className)}>
      {(previewTruthSummary || quickFilters.length > 0) ? (
        <section
          className={cn("rounded-2xl border p-4 shadow-sm", previewTruthClasses.panel)}
          data-testid="creative-preview-truth-contract"
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div className="max-w-3xl">
              <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
                Preview Truth Contract
              </p>
              <h3 className="mt-1 text-lg font-semibold text-slate-950">
                {previewTruthSummary?.headline ?? "Preview truth is still being prepared for this review scope."}
              </h3>
              <p className="mt-1 text-sm text-slate-700">
                {previewTruthSummary?.summary ??
                  "Authoritative creative action depends on preview readiness before the row can read as decisive work."}
              </p>
              <p className="mt-2 text-xs text-slate-600">
                Ready preview media supports decisive action language. Degraded preview keeps review metrics-only. Missing preview blocks authoritative action.
              </p>
            </div>
            <span
              className={cn(
                "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide",
                previewTruthClasses.badge,
              )}
            >
              {previewTruthSummary?.state === "ready"
                ? "Preview ready"
                : previewTruthSummary?.state === "missing"
                  ? "Preview missing"
                  : "Preview gated"}
            </span>
          </div>

          {previewTruthSummary ? (
            <div className="mt-4 grid gap-3 md:grid-cols-3">
              {[
                ["Ready", previewTruthSummary.readyCount],
                ["Degraded", previewTruthSummary.degradedCount],
                ["Missing", previewTruthSummary.missingCount],
              ].map(([label, value]) => (
                <div
                  key={String(label)}
                  className={cn("rounded-2xl border px-4 py-3", previewTruthClasses.stat)}
                >
                  <p className="text-[11px] uppercase tracking-[0.18em] text-slate-500">{label}</p>
                  <p className="mt-1 text-2xl font-semibold text-slate-950">{value}</p>
                </div>
              ))}
            </div>
          ) : null}

          {selectedPreviewTruthSummary ? (
            <div className="mt-4 rounded-2xl border border-white/60 bg-white/80 px-4 py-3">
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                Selected Preview Truth
              </p>
              <p className="mt-1 text-sm font-semibold text-slate-950">
                {selectedPreviewTruthSummary.readyCount} ready · {selectedPreviewTruthSummary.degradedCount} degraded · {selectedPreviewTruthSummary.missingCount} missing
              </p>
              <p className="mt-1 text-xs text-slate-600">
                The preview strip and table now follow this truth before they read as clean operator action.
              </p>
            </div>
          ) : null}

          {quickFilters.length > 0 ? (
            <div className="mt-4 space-y-2" data-testid="creative-quick-filters-panel">
              <div className="flex flex-wrap items-center justify-between gap-2">
                <div>
                  <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                    Primary Decisions
                  </p>
                  <p className="mt-1 text-sm text-slate-700">
                    Filter by the same primary operator decisions shown on each creative row.
                  </p>
                  <p className="mt-1 text-xs text-slate-600">
                    Counts follow the current visible reporting set. The row segment itself stays anchored to the Decision OS window.
                  </p>
                </div>
              </div>
              <div className="grid gap-2 lg:grid-cols-6" data-testid="creative-quick-filters">
                {quickFilters.map((filter) => {
                  const active = activeQuickFilterKey === filter.key;
                  const scaleReviewRequired =
                    filter.key === "scale"
                      ? (filter.reviewOnlyCount ?? 0) + (filter.mutedCount ?? 0)
                      : 0;
                  return (
                    <button
                      key={filter.key}
                      type="button"
                      onClick={() => onToggleQuickFilter?.(filter.key)}
                      data-count={filter.count}
                      data-testid={`creative-quick-filter-${filter.key}`}
                      className={cn(
                        "rounded-2xl border p-3 text-left transition-colors",
                        quickFilterToneClasses(filter, active),
                      )}
                    >
                      <div className="flex items-start justify-between gap-3">
                        <div>
                          <p className="text-sm font-semibold">{filter.label}</p>
                          <p className="mt-1 text-xs opacity-85">{filter.summary}</p>
                          {scaleReviewRequired > 0 ? (
                            <p
                              className="mt-1 text-[11px] font-semibold opacity-85"
                              data-testid="creative-support-scale-review-required"
                            >
                              {scaleReviewRequired.toLocaleString()} require review before scale action
                            </p>
                          ) : null}
                        </div>
                        <span className={cn("rounded-full px-2 py-1 text-[11px] font-semibold", active ? "bg-white/20" : "bg-black/5")}>
                          {filter.count}
                        </span>
                      </div>
                    </button>
                  );
                })}
              </div>
            </div>
          ) : null}
        </section>
      ) : null}

      <OperatorSurfaceSummary model={operatorSurface} maxRowsPerBucket={2} />
    </div>
  );
}
