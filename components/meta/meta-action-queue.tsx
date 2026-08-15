"use client";

/**
 * components/meta/meta-action-queue.tsx
 *
 * Compact "what to do now" panel shown above the campaign table.
 * Displays recommendations ordered by urgency: act → test → watch.
 * Each row shows only the decision badge, campaign name, and one-line action.
 *
 * Full detail is available via the "Show full analysis" toggle which
 * controls MetaInsightPanel visibility in the parent.
 */

import { TrendingUp, ShieldAlert, Workflow } from "lucide-react";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { Badge } from "@/components/ui/badge";
import { usePreferencesStore } from "@/store/preferences-store";

// ── Decision sort order ───────────────────────────────────────────────────────

const DECISION_ORDER: Record<MetaRecommendation["decisionState"], number> = {
  act: 0,
  test: 1,
  watch: 2,
};

// ── Badge styles ──────────────────────────────────────────────────────────────

function decisionStyle(state: MetaRecommendation["decisionState"]) {
  if (state === "act")
    return "bg-foreground text-background hover:bg-foreground/90";
  if (state === "test")
    return "bg-[var(--adc-auto-fg)]/10 text-[var(--adc-auto-fg)] hover:bg-[var(--adc-auto-fg)]/15";
  return "bg-muted text-muted-foreground";
}

function decisionLabel(
  state: MetaRecommendation["decisionState"],
  language: "en" | "tr"
) {
  if (language === "tr") {
    if (state === "act") return "AKSİYON";
    if (state === "test") return "TEST";
    return "İZLE";
  }
  return state.toUpperCase();
}

// ── Lens icon ─────────────────────────────────────────────────────────────────

function LensIcon({ lens }: { lens: MetaRecommendation["lens"] }) {
  if (lens === "volume")
    return <TrendingUp className="h-3.5 w-3.5 shrink-0 text-[var(--adc-info-fg)]" />;
  if (lens === "profitability")
    return <ShieldAlert className="h-3.5 w-3.5 shrink-0 text-[var(--adc-pos-fg)]" />;
  return <Workflow className="h-3.5 w-3.5 shrink-0 text-[var(--adc-caution-fg)]" />;
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface MetaActionQueueProps {
  recommendations: MetaRecommendation[];
  isLoading: boolean;
  isError: boolean;
  onRetry: () => void;
  onOpenCampaign?: (id: string) => void;
  showFullAnalysis: boolean;
  onToggleFullAnalysis: () => void;
}

// ── Component ─────────────────────────────────────────────────────────────────

export function MetaActionQueue({
  recommendations,
  isLoading,
  isError,
  onRetry,
  onOpenCampaign,
  showFullAnalysis,
  onToggleFullAnalysis,
}: MetaActionQueueProps) {
  const language = "en";

  const sorted = [...recommendations].sort(
    (a, b) => DECISION_ORDER[a.decisionState] - DECISION_ORDER[b.decisionState]
  );

  const actCount = recommendations.filter((r) => r.decisionState === "act").length;
  const testCount = recommendations.filter((r) => r.decisionState === "test").length;

  // ── Loading state ─────────────────────────────────────────────────────────

  if (isLoading) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-4 shadow-sm shadow-slate-200/40">
        <div className="mb-3 space-y-1">
          <div className="h-2.5 w-24 animate-pulse rounded bg-slate-200" />
          <div className="h-4 w-40 animate-pulse rounded bg-slate-200" />
        </div>
        <div className="space-y-1.5">
          {[0, 1, 2].map((i) => (
            <div
              key={i}
              className="flex items-center gap-3 rounded-xl border bg-white px-3 py-3"
            >
              <div className="h-5 w-16 animate-pulse rounded-full bg-slate-200" />
              <div className="flex-1 space-y-1">
                <div className="h-3 w-32 animate-pulse rounded bg-slate-200" />
                <div className="h-2.5 w-48 animate-pulse rounded bg-slate-100" />
              </div>
            </div>
          ))}
        </div>
      </div>
    );
  }

  // ── Error state ───────────────────────────────────────────────────────────

  if (isError) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-4 shadow-sm shadow-slate-200/40">
        <div className="flex items-center justify-between gap-3">
          <div>
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
              Action Queue
            </p>
            <p className="text-sm text-muted-foreground">Could not load analysis</p>
          </div>
          <button
            type="button"
            onClick={onRetry}
            className="rounded-lg border px-3 py-1.5 text-xs font-medium hover:bg-muted"
          >
            Retry
          </button>
        </div>
      </div>
    );
  }

  // ── Empty state ───────────────────────────────────────────────────────────

  if (sorted.length === 0) {
    return (
      <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-4 shadow-sm shadow-slate-200/40">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
          Action Queue
        </p>
        <p className="mt-1 text-sm text-muted-foreground">No strong signals detected for this period.</p>
      </div>
    );
  }

  // ── Main ──────────────────────────────────────────────────────────────────

  return (
    <div className="rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-4 shadow-sm shadow-slate-200/40">
      {/* Header */}
      <div className="mb-3 flex items-center justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
            Action Queue
          </p>
          <p className="text-sm font-semibold text-slate-950">
            {actCount > 0
              ? `${actCount} immediate action${actCount !== 1 ? "s" : ""}`
              : "No immediate actions required"}
          </p>
        </div>
        <div className="flex items-center gap-1.5">
          {actCount > 0 && (
            <Badge className="border-0 bg-foreground text-background">
              {actCount} ACT
            </Badge>
          )}
          {testCount > 0 && (
            <Badge className="border-0 bg-[var(--adc-auto-fg)]/10 text-[var(--adc-auto-fg)]">
              {testCount} TEST
            </Badge>
          )}
        </div>
      </div>

      {/* Action rows */}
      <div className="space-y-1.5">
        {sorted.map((rec) => (
          <div
            key={rec.id}
            className="flex items-center gap-3 rounded-xl border border-slate-200 bg-white px-3 py-2.5 shadow-sm shadow-slate-100/60"
          >
            {/* Decision badge */}
            <span
              className={`shrink-0 rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${decisionStyle(rec.decisionState)}`}
            >
              {decisionLabel(rec.decisionState, language)}
            </span>

            {/* Campaign + action */}
            <div className="min-w-0 flex-1">
              <p className="truncate text-xs font-semibold text-slate-700">
                {rec.campaignName ??
                  "Account-level"}
              </p>
              <p className="truncate text-[11px] text-slate-500">
                {rec.recommendedAction}
              </p>
            </div>

            {/* Lens icon */}
            <LensIcon lens={rec.lens} />

            {/* Jump to campaign */}
            {rec.campaignId && onOpenCampaign && (
              <button
                type="button"
                onClick={() => onOpenCampaign(rec.campaignId!)}
                className="shrink-0 text-[11px] font-medium text-[var(--adc-info-fg)] hover:underline"
              >
                View
              </button>
            )}
          </div>
        ))}
      </div>

      {/* Toggle full analysis */}
      <button
        type="button"
        onClick={onToggleFullAnalysis}
        className="mt-3 flex w-full items-center justify-center gap-1.5 rounded-xl border border-dashed py-2 text-xs font-medium text-muted-foreground transition-colors hover:bg-muted/50"
      >
        {showFullAnalysis
          ? "Hide Full Analysis ▲"
          : "Show Full Recommendation Analysis ▼"}
      </button>
    </div>
  );
}
