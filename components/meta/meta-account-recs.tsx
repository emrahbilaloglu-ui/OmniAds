"use client";

/**
 * components/meta/meta-account-recs.tsx
 *
 * Account-level derived operator context.
 * - Before analysis: "Run analysis" button
 * - After analysis: compact cards derived from the same authority snapshot
 */

import { useState } from "react";
import { cn } from "@/lib/utils";
import { ChevronDown, ChevronUp } from "lucide-react";
import type { MetaRecommendation, MetaRecommendationsResponse } from "@/lib/meta/recommendations";

function formatRelativeAge(isoValue: string | null | undefined): string | null {
  if (!isoValue) return null;
  const timestamp = new Date(isoValue).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return null;
  const minute = 60_000, hour = 60 * minute, day = 24 * hour, month = 30 * day, year = 365 * day;
  if (diffMs >= year) return `${Math.floor(diffMs / year)}y ago`;
  if (diffMs >= month) return `${Math.floor(diffMs / month)}mo ago`;
  if (diffMs >= day) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs >= hour) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs >= minute) return `${Math.floor(diffMs / minute)}m ago`;
  return "just now";
}

function DecisionBadge({ state }: { state: MetaRecommendation["decisionState"] }) {
  const cls =
    state === "act"
      ? "bg-foreground text-background"
      : state === "test"
      ? "bg-violet-500/10 text-violet-700"
      : "bg-slate-100 text-slate-500";
  const labels: Record<typeof state, string> = { act: "ACT", test: "TEST", watch: "WATCH" };
  return (
    <span className={`inline-flex items-center rounded-full px-2 py-0.5 text-[12px] font-bold uppercase tracking-wide ${cls}`}>
      {labels[state]}
    </span>
  );
}

function RecCard({
  rec,
  checked,
  onToggleCheck,
}: {
  rec: MetaRecommendation;
  checked: boolean;
  onToggleCheck: (id: string) => void;
}) {
  const [open, setOpen] = useState(false);

  return (
    <div
      className={cn(
        "rounded-xl border transition-colors",
        checked ? "border-slate-200 bg-slate-50 opacity-60" : "border-slate-200 bg-white shadow-sm"
      )}
    >
      {/* Compact card — always visible, clickable to expand */}
      <button
        type="button"
        onClick={() => setOpen((v) => !v)}
        className="flex w-full items-start gap-3 p-3 text-left"
      >
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <DecisionBadge state={rec.decisionState} />
            <span className="truncate text-[12px] text-slate-400">{rec.title}</span>
          </div>
          <p className={cn(
            "mt-1.5 text-[13px] font-semibold leading-snug",
            checked ? "line-through text-slate-400" : "text-slate-900"
          )}>
            {rec.recommendedAction}
          </p>
          {rec.evidence.length > 0 && (
            <div className="mt-2 flex flex-wrap gap-1.5">
              {rec.evidence.slice(0, 3).map((ev) => (
                <span
                  key={ev.label}
                  className={cn(
                    "rounded-md px-2 py-0.5 text-[12px] font-medium",
                    ev.tone === "positive" ? "bg-emerald-50 text-emerald-700"
                    : ev.tone === "warning" ? "bg-amber-50 text-amber-700"
                    : "bg-slate-100 text-slate-600"
                  )}
                >
                  {ev.label}: {ev.value}
                </span>
              ))}
            </div>
          )}
        </div>
        <div className="mt-0.5 shrink-0 text-slate-400">
          {open ? <ChevronUp className="h-3.5 w-3.5" /> : <ChevronDown className="h-3.5 w-3.5" />}
        </div>
      </button>

      {/* Expanded detail */}
      {open && (
        <div className="space-y-3 border-t border-slate-100 px-3 pb-3 pt-2.5">
          {rec.why && (
            <div>
              <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">Why</p>
              <p className="text-xs leading-relaxed text-slate-600">{rec.why}</p>
            </div>
          )}
          {rec.summary && rec.summary !== rec.why && (
            <div>
              <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">Summary</p>
              <p className="text-xs leading-relaxed text-slate-600">{rec.summary}</p>
            </div>
          )}
          {rec.expectedImpact && (
            <div>
              <p className="mb-1 text-[12px] font-semibold uppercase tracking-wide text-slate-400">Expected impact</p>
              <p className="text-xs leading-relaxed text-slate-600">{rec.expectedImpact}</p>
            </div>
          )}
          {(rec.defensiveBidBand || rec.scaleBidBand) && (
            <div className="flex gap-3">
              {rec.defensiveBidBand && (
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">Defensive bid band</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-700">{rec.defensiveBidBand}</p>
                </div>
              )}
              {rec.scaleBidBand && (
                <div className="rounded-lg bg-slate-50 px-3 py-2">
                  <p className="text-[12px] font-semibold uppercase tracking-wide text-slate-400">Scale bid band</p>
                  <p className="mt-0.5 text-xs font-semibold text-slate-700">{rec.scaleBidBand}</p>
                </div>
              )}
            </div>
          )}

          {/* Mark as done checkbox */}
          <div className="flex items-center gap-2 border-t border-slate-100 pt-2">
            <button
              type="button"
              onClick={() => onToggleCheck(rec.id)}
              className={cn(
                "flex h-4 w-4 shrink-0 items-center justify-center rounded border transition-colors",
                checked
                  ? "border-emerald-500 bg-emerald-500 text-white"
                  : "border-slate-300 bg-white hover:border-slate-400"
              )}
            >
              {checked && (
                <svg viewBox="0 0 10 8" className="h-2.5 w-2.5 fill-current">
                  <path d="M1 4l3 3 5-6" stroke="currentColor" strokeWidth="1.5" fill="none" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
              )}
            </button>
            <span className="text-[12px] text-slate-500">
              {checked ? "Marked complete" : "Mark as complete"}
            </span>
          </div>
        </div>
      )}
    </div>
  );
}

export interface MetaAccountRecsProps {
  recommendationsData: MetaRecommendationsResponse | undefined;
  isRecsLoading: boolean;
  lastAnalyzedAt: Date | null;
  checkedRecIds: Set<string>;
  onToggleCheck: (id: string) => void;
  onAnalyze: () => void;
  analysisError?: string | null;
  language: "en" | "tr";
}

export function MetaAccountRecs({
  recommendationsData,
  isRecsLoading,
  lastAnalyzedAt,
  checkedRecIds,
  onToggleCheck,
  onAnalyze,
  analysisError,
  language,
}: MetaAccountRecsProps) {
  const accountRecs = recommendationsData?.recommendations.filter((r) => !r.campaignId) ?? [];
  const ORDER: Record<MetaRecommendation["decisionState"], number> = { act: 0, test: 1, watch: 2 };
  const sorted = [...accountRecs].sort((a, b) => ORDER[a.decisionState] - ORDER[b.decisionState]);

  const allChecked = accountRecs.length > 0 && accountRecs.every((r) => checkedRecIds.has(r.id));
  const canReanalyze = lastAnalyzedAt === null || allChecked;

  return (
    <div className="space-y-4" data-testid="meta-recommendations-panel">
      <div className="space-y-1">
        <p className="text-[12px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {language === "tr" ? "Destekleyici Bağlam" : "Supporting Context"}
        </p>
        <p className="text-xs text-slate-500">
          {language === "tr"
            ? "Birincil aksiyon otoritesini destekleyen, yenileme tabanlı ikincil hesap notları."
            : "Refresh-driven secondary notes that support the primary action authority above."}
        </p>
      </div>

      {/* Run / refresh button */}
      <div className="flex items-center gap-3">
        <button
          onClick={onAnalyze}
          disabled={isRecsLoading || (lastAnalyzedAt !== null && !canReanalyze)}
          data-testid="meta-recommendations-run"
          className={cn(
            "flex items-center gap-2 rounded-xl border px-4 py-2 text-xs font-semibold transition-colors",
            isRecsLoading
              ? "cursor-wait border-slate-200 bg-slate-50 text-slate-400"
              : canReanalyze
              ? "border-foreground bg-foreground text-background hover:opacity-90"
              : "cursor-not-allowed border-slate-200 bg-slate-50 text-slate-400"
          )}
        >
          {isRecsLoading ? (
            <>
              <span className="h-3 w-3 animate-spin rounded-full border-2 border-current border-t-transparent" />
              {language === "tr" ? "Çalıştırılıyor..." : "Running..."}
            </>
          ) : lastAnalyzedAt === null ? (
            language === "tr" ? "Analizi Çalıştır" : "Run Analysis"
          ) : canReanalyze ? (
            language === "tr" ? "Analizi Yeniden Çalıştır" : "Run Analysis Again"
          ) : (
            language === "tr"
              ? `Yeniden çalıştırmak için tüm maddeleri işaretle (${checkedRecIds.size}/${accountRecs.length})`
              : `Check all items before re-running (${checkedRecIds.size}/${accountRecs.length})`
          )}
        </button>
        {lastAnalyzedAt && (
          <p className="text-[12px] text-slate-400">
            {language === "tr" ? "Son çalıştırma:" : "Last run:"}{" "}
            {formatRelativeAge(lastAnalyzedAt.toISOString())}
          </p>
        )}
      </div>
      {analysisError ? (
        <p className="text-xs text-red-500">
          {analysisError}
        </p>
      ) : null}

      {/* Loading skeleton */}
      {isRecsLoading && (
        <div className="space-y-2">
          {[0, 1, 2].map((i) => (
            <div key={i} className="h-20 animate-pulse rounded-xl bg-slate-100" />
          ))}
        </div>
      )}

      {/* Empty */}
      {!isRecsLoading && lastAnalyzedAt !== null && sorted.length === 0 && (
        <p className="text-xs text-slate-400">
          {language === "tr" ? "Güçlü bir hesap geneli sinyal bulunamadı." : "No account-level signals detected."}
        </p>
      )}

      {/* Rec cards */}
      {!isRecsLoading && sorted.length > 0 && (
        <div className="space-y-2">
          {sorted.map((rec) => (
            <RecCard
              key={rec.id}
              rec={rec}
              checked={checkedRecIds.has(rec.id)}
              onToggleCheck={onToggleCheck}
            />
          ))}
        </div>
      )}
    </div>
  );
}
