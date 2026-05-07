import type { MetaAnalysisStatus } from "@/lib/meta/analysis-state";

function formatAnalyzedAt(value: string | null) {
  if (!value) return null;
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) return value;
  return `${date.toISOString().slice(0, 16).replace("T", " ")} UTC`;
}

function statusTone(status: MetaAnalysisStatus["decisionOsStatus"]) {
  switch (status) {
    case "archived":
      return "border-slate-200 bg-slate-50 text-slate-700";
    case "error":
    case "mismatch":
      return "border-rose-200 bg-rose-50 text-rose-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

function sourceTone(source: MetaAnalysisStatus["recommendationSource"]) {
  switch (source) {
    case "snapshot_fallback":
      return "border-amber-200 bg-amber-50 text-amber-800";
    case "snapshot_persistent":
      return "border-emerald-200 bg-emerald-50 text-emerald-800";
    case "snapshot_live":
      return "border-sky-200 bg-sky-50 text-sky-800";
    case "demo":
      return "border-violet-200 bg-violet-50 text-violet-800";
    default:
      return "border-slate-200 bg-slate-50 text-slate-700";
  }
}

export function MetaAnalysisStatusCard({
  status,
  className = "",
}: {
  status: MetaAnalysisStatus;
  className?: string;
}) {
  const analyzedAt = formatAnalyzedAt(status.lastAnalyzedAtIso);

  return (
    <section
      className={`rounded-2xl border border-slate-200 bg-white p-4 shadow-sm ${className}`}
      data-testid="meta-analysis-status-card"
      data-analysis-state={status.state}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
            Analysis status
          </p>
          <p className="mt-1 text-sm font-semibold text-slate-950">{status.message}</p>
        </div>
        <div className="flex flex-wrap gap-2">
          {status.isAnalysisRunning ? (
            <span
              className="rounded-full border border-sky-200 bg-sky-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-sky-800"
              data-testid="meta-analysis-running-label"
            >
              Analysis: Running
            </span>
          ) : null}
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${statusTone(status.decisionOsStatus)}`}
            data-testid="meta-analysis-decision-os-label"
          >
            Decision OS: {status.decisionOsLabel}
          </span>
          <span
            className={`rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide ${sourceTone(status.recommendationSource)}`}
            data-testid="meta-analysis-source-label"
          >
            Recommendation source: {status.recommendationSourceLabel}
          </span>
          <span
            className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-slate-700"
            data-testid="meta-analysis-presentation-label"
          >
            Presentation: {status.presentationModeLabel}
          </span>
        </div>
      </div>

      {analyzedAt || status.analyzedRangeLabel ? (
        <p className="mt-3 text-xs text-slate-500" data-testid="meta-analysis-range-label">
          {analyzedAt ? `Last successful analysis at ${analyzedAt}. ` : null}
          {status.analyzedRangeLabel ? `Analyzed for ${status.analyzedRangeLabel}.` : null}
        </p>
      ) : null}

      {status.safeErrorMessage ? (
        <p className="mt-3 rounded-xl border border-rose-100 bg-rose-50 px-3 py-2 text-xs text-rose-700">
          {status.safeErrorMessage}
        </p>
      ) : null}

      {status.detailReasons.length > 0 ? (
        <ul className="mt-3 space-y-1 text-xs text-slate-600" data-testid="meta-analysis-detail-reasons">
          {status.detailReasons.slice(0, 4).map((reason) => (
            <li key={reason}>{reason}</li>
          ))}
        </ul>
      ) : null}
    </section>
  );
}
