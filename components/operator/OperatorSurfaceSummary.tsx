import { cn } from "@/lib/utils";
import {
  operatorStateLabel,
  type OperatorAuthorityState,
  type OperatorSurfaceItem,
  type OperatorSurfaceModel,
} from "@/lib/operator-surface";

function toneClasses(state: OperatorAuthorityState) {
  if (state === "act_now") {
    return {
      panel: "border-emerald-200 bg-emerald-50/70",
      pill: "border-emerald-200 bg-emerald-100 text-emerald-900",
      action: "bg-emerald-600 text-white",
    };
  }
  if (state === "needs_truth") {
    return {
      panel: "border-amber-200 bg-amber-50/80",
      pill: "border-amber-200 bg-amber-100 text-amber-900",
      action: "bg-amber-600 text-white",
    };
  }
  if (state === "blocked") {
    return {
      panel: "border-orange-200 bg-orange-50/80",
      pill: "border-orange-200 bg-orange-100 text-orange-900",
      action: "bg-orange-600 text-white",
    };
  }
  if (state === "watch") {
    return {
      panel: "border-sky-200 bg-sky-50/80",
      pill: "border-sky-200 bg-sky-100 text-sky-900",
      action: "bg-sky-600 text-white",
    };
  }
  return {
    panel: "border-slate-200 bg-slate-50/80",
    pill: "border-slate-200 bg-slate-100 text-slate-800",
    action: "bg-slate-700 text-white",
  };
}

function confidenceTone(confidence: OperatorSurfaceItem["confidence"]) {
  if (confidence === "High") return "border-emerald-200 bg-emerald-50 text-emerald-800";
  if (confidence === "Medium") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-700";
}

function OperatorRowCard({
  item,
  authorityLabels,
  compact = false,
}: {
  item: OperatorSurfaceItem;
  authorityLabels?: Partial<Record<OperatorAuthorityState, string>>;
  compact?: boolean;
}) {
  const tones = toneClasses(item.authorityState);
  const authorityLabel =
    item.authorityLabel ?? authorityLabels?.[item.authorityState] ?? operatorStateLabel(item.authorityState);

  return (
    <div
      className={cn(
        "border border-slate-200 bg-white shadow-sm",
        compact ? "rounded-xl p-2.5" : "rounded-2xl p-3",
      )}
    >
      <div className="flex flex-wrap items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className={cn("truncate font-semibold text-slate-950", compact ? "text-[13px]" : "text-sm")}>
            {item.title}
          </p>
          {item.subtitle ? <p className="mt-0.5 truncate text-xs text-slate-500">{item.subtitle}</p> : null}
        </div>
        <div className="flex flex-wrap items-center justify-end gap-2">
          <span
            className={cn(
              "rounded-full px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
              tones.action,
            )}
          >
            {item.primaryAction}
          </span>
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
              tones.pill,
            )}
          >
            {authorityLabel}
          </span>
          <span
            className={cn(
              "rounded-full border px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide",
              confidenceTone(item.confidence),
            )}
          >
            {item.confidence}
          </span>
        </div>
      </div>

      {item.secondaryLabels && item.secondaryLabels.length > 0 ? (
        <div className="mt-2 flex flex-wrap gap-1.5">
          {item.secondaryLabels.slice(0, 3).map((label) => (
            <span
              key={`${item.id}:${label}`}
              className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[10px] font-medium uppercase tracking-wide text-slate-700"
            >
              {label}
            </span>
          ))}
        </div>
      ) : null}

      <p className={cn("mt-2 leading-relaxed text-slate-800", compact ? "text-[13px]" : "text-sm")}>
        {item.reason}
      </p>
      {item.blocker ? (
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Blocker: {item.blocker}
        </p>
      ) : null}
      {item.metrics.length > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {item.metrics.map((metric) => (
            <span
              key={`${item.id}:${metric.label}`}
              className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] text-slate-700"
            >
              <span className="font-semibold text-slate-900">{metric.label}</span> {metric.value}
            </span>
          ))}
        </div>
      ) : null}
    </div>
  );
}

export function OperatorSurfaceSummary({
  model,
  className,
  maxRowsPerBucket = 3,
  compact = false,
}: {
  model: OperatorSurfaceModel | null;
  className?: string;
  maxRowsPerBucket?: number;
  compact?: boolean;
}) {
  if (!model) return null;

  const tones = toneClasses(model.emphasis);
  const emphasisLabel = model.authorityLabels?.[model.emphasis] ?? operatorStateLabel(model.emphasis);

  return (
    <section
      className={cn(compact ? "space-y-3" : "space-y-4", className)}
      data-testid={`${model.surfaceLabel.toLowerCase()}-operator-surface`}
    >
      <div
        className={cn(
          "rounded-2xl border shadow-sm",
          compact ? "p-3.5" : "p-4",
          tones.panel,
        )}
      >
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div className="max-w-3xl">
            <p className="text-[11px] font-semibold uppercase tracking-[0.18em] text-slate-600">
              {model.surfaceLabel} {model.heading}
            </p>
            <h3 className={cn("mt-1 font-semibold text-slate-950", compact ? "text-base" : "text-lg")}>
              {model.headline}
            </h3>
            <p className={cn("mt-1 text-slate-700", compact ? "text-[13px]" : "text-sm")}>{model.note}</p>
            {model.blocker ? <p className="mt-2 text-xs text-slate-600">{model.blocker}</p> : null}
          </div>
          <span
            className={cn(
              "rounded-full border px-3 py-1.5 text-xs font-semibold uppercase tracking-wide",
              tones.pill,
            )}
          >
            {emphasisLabel}
          </span>
        </div>
        {model.hiddenSummary ? (
          <p className="mt-3 text-xs text-slate-600">{model.hiddenSummary}</p>
        ) : null}
      </div>

      {model.buckets.map((bucket) => (
        <div
          key={bucket.key}
          className={cn(
            "rounded-2xl border border-slate-200 bg-white shadow-sm",
            compact ? "p-3.5" : "p-4",
          )}
        >
          <div className="flex flex-wrap items-start justify-between gap-3">
            <div>
              <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-500">
                {bucket.label}
              </p>
              <p className="mt-1 text-sm text-slate-600">{bucket.summary}</p>
            </div>
            <span className="rounded-full border border-slate-200 bg-slate-50 px-3 py-1 text-xs font-semibold text-slate-800">
              {bucket.rows.length}
            </span>
          </div>
          {bucket.rows.length > 0 ? (
            <div
              className={cn(
                "mt-3 grid",
                compact ? "gap-2.5 2xl:grid-cols-2" : "gap-3 xl:grid-cols-2",
              )}
            >
              {bucket.rows.slice(0, maxRowsPerBucket).map((item) => (
                <OperatorRowCard
                  key={item.id}
                  item={item}
                  authorityLabels={model.authorityLabels}
                  compact={compact}
                />
              ))}
            </div>
          ) : null}
          {bucket.rows.length > maxRowsPerBucket ? (
            <p className="mt-3 text-xs text-slate-500">
              +{bucket.rows.length - maxRowsPerBucket} more {bucket.rows.length - maxRowsPerBucket === 1 ? "row" : "rows"} in this bucket.
            </p>
          ) : null}
          {bucket.mutedCount > 0 ? (
            <p className="mt-3 text-xs text-slate-500">
              {bucket.mutedCount} thin-signal or inactive {bucket.mutedCount === 1 ? "row stays" : "rows stay"} out of the headline stack.
            </p>
          ) : null}
        </div>
      ))}
    </section>
  );
}
