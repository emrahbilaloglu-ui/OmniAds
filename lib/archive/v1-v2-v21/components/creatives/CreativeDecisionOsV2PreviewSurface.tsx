"use client";

import { useMemo } from "react";
import {
  AlertTriangle,
  CheckCircle2,
  Eye,
  Search,
  ShieldCheck,
  Sparkles,
  TrendingDown,
  Wrench,
} from "lucide-react";
import type {
  CreativeDecisionOsV2PreviewBucket,
  CreativeDecisionOsV2PreviewPayload,
  CreativeDecisionOsV2PreviewRow,
} from "@/lib/creative-decision-os-v2-preview";
import { cn } from "@/lib/utils";

type CreativeDecisionOsV2PreviewSurfaceProps = {
  preview: CreativeDecisionOsV2PreviewPayload | null | undefined;
  isLoading?: boolean;
  error?: string | null;
  onOpenRow?: (rowId: string) => void;
  className?: string;
};

const compactPillClasses = "rounded-full border px-2.5 py-1 text-[11px] font-semibold";
const mutedTinyPillClasses =
  "rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-semibold text-slate-700";
const inactiveTinyPillClasses =
  "rounded-full border border-slate-200 bg-slate-100 px-2.5 py-1 text-[11px] font-semibold text-slate-700";
const countBadgeClasses =
  "rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-xs font-semibold text-slate-700";
const whiteCountBadgeClasses =
  "rounded-full border border-slate-200 bg-white px-2.5 py-1 text-xs font-semibold text-slate-700";

function formatNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toLocaleString() : "n/a";
}

function formatMetric(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value) ? value.toFixed(2) : "n/a";
}

function formatSpend(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? `$${value.toLocaleString(undefined, { maximumFractionDigits: 0 })}`
    : "n/a";
}

function shortId(value: string) {
  if (value.length <= 18) return value;
  return `${value.slice(0, 8)}...${value.slice(-6)}`;
}

function humanizeTag(value: string) {
  return value
    .replace(/^review_/, "")
    .replace(/_/g, " ")
    .replace(/\b\w/g, (match) => match.toUpperCase());
}

function safeEvidenceText(value: string) {
  return value
    .replace(/\bdirect\s+Scale\b/gi, "immediate scale")
    .replace(/\bScale Review\b/g, "scale buyer review");
}

function safeTrustLabels(row: CreativeDecisionOsV2PreviewRow) {
  const labels: string[] = [];
  for (const flag of row.trustFlags) {
    const normalized = flag.toLowerCase();
    if (normalized.includes("degraded")) labels.push("Source degraded");
    else if (normalized.includes("missing")) labels.push("Evidence missing");
    else if (normalized.includes("read_only")) labels.push("Source read-only");
    else if (normalized.includes("blocked")) labels.push("Source blocked");
    else if (normalized.includes("limited")) labels.push("Source limited");
    else if (normalized.includes("review_required")) labels.push("Buyer confirmation required");
  }
  return Array.from(new Set(labels)).slice(0, 3);
}

function safeCampaignLabels(row: CreativeDecisionOsV2PreviewRow) {
  return row.campaignContextFlags
    .map((flag) => {
      const normalized = flag.toLowerCase();
      if (normalized.includes("inactive")) return "Inactive context";
      if (normalized.includes("campaign_status")) return "Campaign status needs review";
      if (normalized.includes("adset_status")) return "Ad set status needs review";
      if (normalized.includes("deployment_blocked")) return "Deployment blocked";
      if (normalized.includes("campaign_context")) return "Campaign context needs review";
      return humanizeTag(flag);
    })
    .slice(0, 3);
}

function riskClasses(riskLevel: CreativeDecisionOsV2PreviewRow["riskLevel"]) {
  if (riskLevel === "critical") return "border-rose-200 bg-rose-50 text-rose-800";
  if (riskLevel === "high") return "border-orange-200 bg-orange-50 text-orange-800";
  if (riskLevel === "medium") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-emerald-200 bg-emerald-50 text-emerald-800";
}

function decisionClasses(decision: CreativeDecisionOsV2PreviewRow["primaryDecision"]) {
  if (decision === "Scale") return "border-emerald-200 bg-emerald-50 text-emerald-900";
  if (decision === "Cut") return "border-rose-200 bg-rose-50 text-rose-900";
  if (decision === "Refresh") return "border-cyan-200 bg-cyan-50 text-cyan-900";
  if (decision === "Protect") return "border-slate-200 bg-slate-50 text-slate-900";
  if (decision === "Test More") return "border-violet-200 bg-violet-50 text-violet-900";
  return "border-amber-200 bg-amber-50 text-amber-900";
}

function actionButtonLabel(row: CreativeDecisionOsV2PreviewRow) {
  if (row.primaryDecision === "Diagnose") return "View diagnosis";
  if (row.blockerReasons.length > 0 || row.campaignContextFlags.length > 0) return "See blocker";
  if (row.primaryDecision === "Protect") return "Compare evidence";
  return "Open detail";
}

function laneShellClasses(tone: "priority" | "confirmation" | "review" | "diagnose" | "inactive") {
  const toneClass = {
    priority: "border-l-4 border-l-rose-500 bg-white",
    confirmation: "border-l-4 border-l-emerald-500 bg-emerald-50/30",
    review: "border-l-4 border-l-cyan-500 bg-cyan-50/25",
    diagnose: "border-l-4 border-l-amber-500 bg-amber-50/35",
    inactive: "border-l-4 border-l-slate-400 bg-slate-50/80",
  }[tone];
  return cn("rounded-lg border border-slate-200 p-4 shadow-sm", toneClass);
}

function LaneBadge({
  children,
  tone,
}: {
  children: string;
  tone: "priority" | "confirmation" | "review" | "diagnose" | "inactive";
}) {
  const toneClass = {
    priority: "border-rose-200 bg-rose-50 text-rose-800",
    confirmation: "border-emerald-200 bg-emerald-50 text-emerald-800",
    review: "border-cyan-200 bg-cyan-50 text-cyan-800",
    diagnose: "border-amber-200 bg-amber-50 text-amber-800",
    inactive: "border-slate-200 bg-slate-100 text-slate-700",
  }[tone];
  return <span className={cn(compactPillClasses, toneClass)}>{children}</span>;
}

function SummaryMetric({
  label,
  value,
  tone,
  detail,
}: {
  label: string;
  value: number;
  tone: "danger" | "success" | "refresh" | "protect" | "diagnose";
  detail?: string;
}) {
  const toneClass = {
    danger: "border-rose-200 bg-rose-50 text-rose-900",
    success: "border-emerald-200 bg-emerald-50 text-emerald-900",
    refresh: "border-cyan-200 bg-cyan-50 text-cyan-900",
    protect: "border-slate-200 bg-slate-50 text-slate-900",
    diagnose: "border-amber-200 bg-amber-50 text-amber-900",
  }[tone];
  return (
    <div className={cn("rounded-lg border px-3 py-2", toneClass)}>
      <p className="text-[11px] font-semibold uppercase tracking-wide">{label}</p>
      <p className="mt-1 text-2xl font-semibold tabular-nums">{value}</p>
      {detail ? <p className="mt-1 text-[11px] leading-snug opacity-85">{detail}</p> : null}
    </div>
  );
}

function RowCard({
  row,
  compact = false,
  onOpenRow,
}: {
  row: CreativeDecisionOsV2PreviewRow;
  compact?: boolean;
  onOpenRow?: (rowId: string) => void;
}) {
  const trustLabels = safeTrustLabels(row);
  const campaignLabels = safeCampaignLabels(row);
  const blocker = row.blockerReasons[0] ?? null;

  return (
    <article
      className={cn(
        "rounded-lg border border-slate-200 bg-white p-3 shadow-sm",
        row.activeStatus === false && "bg-slate-50 opacity-80",
      )}
      data-testid="creative-v2-preview-row"
      data-row-id={row.rowId}
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div className="min-w-0">
          <div className="flex flex-wrap items-center gap-2">
            <span className={cn(compactPillClasses, decisionClasses(row.primaryDecision))}>
              {row.primaryDecision}
            </span>
            <span className={mutedTinyPillClasses}>{row.actionabilityLabel}</span>
            <span className={cn(compactPillClasses, riskClasses(row.riskLevel))}>
              {humanizeTag(row.riskLevel)} risk
            </span>
            {row.activeStatus === false ? (
              <span className={inactiveTinyPillClasses}>Inactive</span>
            ) : null}
          </div>
          <h4 className="mt-2 truncate text-sm font-semibold text-slate-950">
            {row.buyerActionLabel} - {shortId(row.creativeId)}
          </h4>
          <p className="mt-1 text-sm text-slate-700">{safeEvidenceText(row.evidenceSummary)}</p>
        </div>
        <button
          type="button"
          onClick={() => onOpenRow?.(row.rowId)}
          className={cn(
            "inline-flex h-9 shrink-0 items-center gap-1.5 rounded-lg border",
            "border-slate-200 bg-white px-3 text-xs font-semibold text-slate-700",
            "hover:bg-slate-50",
          )}
        >
          <Eye className="h-3.5 w-3.5" aria-hidden="true" />
          {actionButtonLabel(row)}
        </button>
      </div>

      <div
        className={cn(
          "mt-3 grid gap-2 text-xs text-slate-700",
          compact ? "grid-cols-2" : "sm:grid-cols-5",
        )}
      >
        <span>Spend {formatSpend(row.metrics.spend)}</span>
        <span>ROAS {formatMetric(row.metrics.roas)}</span>
        <span>Recent {formatMetric(row.metrics.recentRoas)}</span>
        <span>Purchases {formatNumber(row.metrics.purchases)}</span>
        <span>Benchmark {formatMetric(row.metrics.activeBenchmarkRoas)}</span>
      </div>

      <div className="mt-3 flex flex-wrap gap-1.5">
        {row.reasonTags.slice(0, 3).map((tag) => (
          <span
            key={tag}
            className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700"
          >
            {humanizeTag(tag)}
          </span>
        ))}
        {blocker ? (
          <span className="rounded-full bg-amber-100 px-2 py-1 text-[11px] font-medium text-amber-800">
            {humanizeTag(blocker)}
          </span>
        ) : null}
        {[...campaignLabels, ...trustLabels].slice(0, 3).map((label) => (
          <span
            key={label}
            className="rounded-full bg-slate-100 px-2 py-1 text-[11px] font-medium text-slate-700"
          >
            {label}
          </span>
        ))}
      </div>
    </article>
  );
}

function BucketSection({
  bucket,
  rowsById,
  limit = 6,
  onOpenRow,
}: {
  bucket: CreativeDecisionOsV2PreviewBucket;
  rowsById: Map<string, CreativeDecisionOsV2PreviewRow>;
  limit?: number;
  onOpenRow?: (rowId: string) => void;
}) {
  const rows = bucket.rowIds
    .map((rowId) => rowsById.get(rowId))
    .filter((row): row is CreativeDecisionOsV2PreviewRow => Boolean(row))
    .slice(0, limit);

  return (
    <section data-testid={`creative-v2-${bucket.id}`} className="space-y-3">
      <div className="flex flex-wrap items-center justify-between gap-2">
        <div>
          <h3 className="text-sm font-semibold text-slate-950">{bucket.label}</h3>
          <p className="text-xs text-slate-600">{bucket.summary}</p>
        </div>
        <span className={whiteCountBadgeClasses}>{bucket.rowIds.length}</span>
      </div>
      {rows.length > 0 ? (
        <div className="grid gap-3 lg:grid-cols-2">
          {rows.map((row) => (
            <RowCard key={row.rowId} row={row} compact onOpenRow={onOpenRow} />
          ))}
        </div>
      ) : (
        <p className="rounded-lg border border-dashed border-slate-200 bg-slate-50 p-3 text-sm text-slate-600">
          No rows in this buyer lane.
        </p>
      )}
    </section>
  );
}

export function CreativeDecisionOsV2PreviewSurface({
  preview,
  isLoading = false,
  error = null,
  onOpenRow,
  className,
}: CreativeDecisionOsV2PreviewSurfaceProps) {
  const rowsById = useMemo(() => {
    const map = new Map<string, CreativeDecisionOsV2PreviewRow>();
    for (const row of preview?.surface.rows ?? []) map.set(row.rowId, row);
    return map;
  }, [preview?.surface.rows]);

  if (isLoading) {
    return (
      <section className={cn("rounded-lg border border-slate-200 bg-white p-4", className)}>
        <p className="text-sm font-semibold text-slate-900">Decision OS v2 preview loading</p>
        <p className="mt-1 text-sm text-slate-600">
          Preparing read-only buyer lanes for this scope.
        </p>
      </section>
    );
  }

  if (error) {
    return (
      <section className={cn("rounded-lg border border-rose-200 bg-rose-50 p-4", className)}>
        <p className="text-sm font-semibold text-rose-900">Decision OS v2 preview unavailable</p>
        <p className="mt-1 text-sm text-rose-700">{error}</p>
      </section>
    );
  }

  if (!preview) {
    return (
      <section
        className={cn(
          "rounded-lg border border-dashed border-slate-300 bg-slate-50 p-4",
          className,
        )}
      >
        <p className="text-sm font-semibold text-slate-900">Decision OS v2 preview is enabled</p>
        <p className="mt-1 text-sm text-slate-600">
          Run the current Decision OS analysis first to prepare read-only buyer lanes.
        </p>
      </section>
    );
  }

  const surface = preview.surface;
  const todayPriority = surface.buckets.find((bucket) => bucket.id === "today_priority");
  const readyForConfirmation = surface.buckets.find(
    (bucket) => bucket.id === "ready_for_buyer_confirmation",
  );
  const diagnoseFirst = surface.buckets.find((bucket) => bucket.id === "diagnose_first");
  const inactiveReview = surface.buckets.find((bucket) => bucket.id === "inactive_review");
  const scaleReadyDetail =
    surface.aboveTheFold.scaleWorthyCount === 0
      ? "No scale-ready creative cleared the evidence bar yet. " +
        "Promising creatives may still appear under Protect, Test More, or Today Priority " +
        "until recent evidence is strong enough."
      : "Only creatives that clear the stricter evidence bar count as scale-ready.";

  return (
    <section
      className={cn(
        "space-y-5 rounded-lg border border-slate-200 bg-slate-50/70 p-4 shadow-sm",
        className,
      )}
      data-testid="creative-v2-preview-surface"
    >
      <div className="flex flex-wrap items-start justify-between gap-3">
        <div>
          <p className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
            Read-only buyer preview
          </p>
          <h2 className="mt-1 text-lg font-semibold text-slate-950">
            Decision OS v2 operator surface
          </h2>
          <p className="mt-1 max-w-3xl text-sm text-slate-700">
            Buyer urgency is separated from confidence. This panel helps review the highest spend
            and highest risk decisions without changing platform state.
          </p>
        </div>
        <span
          className={cn(
            "inline-flex items-center gap-1.5 rounded-full border border-slate-200",
            "bg-white px-3 py-1.5 text-xs font-semibold text-slate-700",
          )}
        >
          <ShieldCheck className="h-3.5 w-3.5" aria-hidden="true" />
          Read-only
        </span>
      </div>

      <div className="grid gap-3 md:grid-cols-5" data-testid="creative-v2-above-fold">
        <SummaryMetric
          label="Bleeding spend"
          value={surface.aboveTheFold.bleedingSpendCount}
          tone="danger"
        />
        <SummaryMetric
          label="Scale-ready"
          value={surface.aboveTheFold.scaleWorthyCount}
          tone="success"
          detail={scaleReadyDetail}
        />
        <SummaryMetric
          label="Fatiguing on budget"
          value={surface.aboveTheFold.fatigueOnBudgetCount}
          tone="refresh"
        />
        <SummaryMetric
          label="Leave alone"
          value={surface.aboveTheFold.protectCount}
          tone="protect"
        />
        <SummaryMetric
          label="Needs diagnosis"
          value={surface.aboveTheFold.diagnoseCount}
          tone="diagnose"
        />
      </div>

      {todayPriority ? (
        <section className={laneShellClasses("priority")} data-testid="creative-v2-today-priority">
          <div className="mb-3 flex flex-wrap items-center justify-between gap-2">
            <div>
              <LaneBadge tone="priority">Highest urgency</LaneBadge>
              <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                <AlertTriangle className="h-4 w-4 text-rose-600" aria-hidden="true" />
                Today Priority / Buyer Command Strip
              </h3>
              <p className="mt-1 text-xs text-slate-600">
                Scale cases, high-spend cuts, active refresh candidates, and highest-risk changes
                appear here first.
              </p>
            </div>
            <span className={countBadgeClasses}>{todayPriority.rowIds.length}</span>
          </div>
          <div className="grid gap-3 xl:grid-cols-2">
            {todayPriority.rowIds.slice(0, 8).map((rowId) => {
              const row = rowsById.get(rowId);
              return row ? <RowCard key={row.rowId} row={row} onOpenRow={onOpenRow} /> : null;
            })}
          </div>
        </section>
      ) : null}

      <div className="flex items-center gap-3 pt-1">
        <span className="text-[11px] font-semibold uppercase tracking-wide text-slate-500">
          Review lanes
        </span>
        <span className="h-px flex-1 bg-slate-200" aria-hidden="true" />
      </div>

      <div className="grid gap-5 xl:grid-cols-2">
        {readyForConfirmation ? (
          <section
            className={laneShellClasses("confirmation")}
            data-testid="creative-v2-ready-confirmation"
          >
            <div className="mb-3 flex items-center justify-between gap-2">
              <div>
                <LaneBadge tone="confirmation">Confirmation lane</LaneBadge>
                <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                  <CheckCircle2 className="h-4 w-4 text-emerald-600" aria-hidden="true" />
                  Ready for Buyer Confirmation
                </h3>
                <p className="mt-1 text-xs text-slate-600">
                  Separate from Diagnose. These rows have enough evidence for buyer confirmation but
                  still make no live changes.
                </p>
              </div>
              <span className={countBadgeClasses}>{readyForConfirmation.rowIds.length}</span>
            </div>
            <div className="space-y-3">
              {readyForConfirmation.rowIds.length > 0 ? (
                readyForConfirmation.rowIds.slice(0, 4).map((rowId) => {
                  const row = rowsById.get(rowId);
                  return row ? (
                    <RowCard key={row.rowId} row={row} compact onOpenRow={onOpenRow} />
                  ) : null;
                })
              ) : (
                <p
                  className={cn(
                    "rounded-lg border border-dashed border-emerald-200",
                    "bg-emerald-50/60 p-3 text-sm text-emerald-900",
                  )}
                >
                  No direct confirmation candidates in this workspace.
                </p>
              )}
            </div>
          </section>
        ) : null}

        <section className={laneShellClasses("review")} data-testid="creative-v2-buyer-review">
          <div className="mb-3">
            <LaneBadge tone="review">Decision review</LaneBadge>
            <h3 className="flex items-center gap-2 text-sm font-semibold text-slate-950">
              <Sparkles className="h-4 w-4 text-cyan-600" aria-hidden="true" />
              Buyer Review
            </h3>
            <p className="mt-1 text-xs text-slate-600">
              Review required rows are split by buyer decision.
            </p>
          </div>
          <div className="space-y-3">
            {surface.reviewGroups.map((group) => (
              <div key={group.id} className="rounded-lg border border-slate-100 bg-slate-50 p-3">
                <div className="flex items-center justify-between gap-2">
                  <p className="text-xs font-semibold text-slate-800">{group.label}</p>
                  <span className="text-xs font-semibold tabular-nums text-slate-600">
                    {group.rowIds.length}
                  </span>
                </div>
                <div className="mt-2 space-y-2">
                  {group.rowIds.slice(0, 2).map((rowId) => {
                    const row = rowsById.get(rowId);
                    return row ? (
                      <RowCard key={row.rowId} row={row} compact onOpenRow={onOpenRow} />
                    ) : null;
                  })}
                </div>
              </div>
            ))}
          </div>
        </section>
      </div>

      {diagnoseFirst ? (
        <details className={laneShellClasses("diagnose")} data-testid="creative-v2-diagnose-first">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <span>
              <LaneBadge tone="diagnose">Investigation lane</LaneBadge>
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                <Search className="h-4 w-4 text-amber-600" aria-hidden="true" />
                Diagnose First
              </span>
              <span className="mt-1 block text-xs text-slate-600">
                Needs investigation before buyer action. This is not buyer confirmation.
              </span>
            </span>
            <span className={countBadgeClasses}>{diagnoseFirst.rowIds.length}</span>
          </summary>
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {surface.diagnoseGroups.slice(0, 8).map((group) => (
              <div
                key={group.key}
                className="rounded-lg border border-amber-100 bg-amber-50/70 p-3"
              >
                <p className="text-xs font-semibold text-amber-900">{group.label}</p>
                <p className="mt-1 text-xs text-amber-800">
                  {group.rowIds.length} rows need investigation.
                </p>
                <div
                  className={cn(
                    "mt-2 inline-flex min-h-8 items-center gap-1.5 rounded-lg border",
                    "border-amber-200 bg-white px-2.5 py-1.5 text-xs font-semibold text-amber-900",
                  )}
                >
                  <Search className="h-3.5 w-3.5" aria-hidden="true" />
                  Needs investigation before buyer action
                </div>
              </div>
            ))}
          </div>
        </details>
      ) : null}

      {inactiveReview ? (
        <details className={laneShellClasses("inactive")} data-testid="creative-v2-inactive-review">
          <summary className="flex cursor-pointer list-none items-center justify-between gap-3">
            <span>
              <LaneBadge tone="inactive">Muted lane</LaneBadge>
              <span className="flex items-center gap-2 text-sm font-semibold text-slate-950">
                <Wrench className="h-4 w-4 text-slate-500" aria-hidden="true" />
                Inactive Review
              </span>
              <span className="mt-1 block text-xs text-slate-600">
                Muted by default unless spend or risk makes a row urgent.
              </span>
            </span>
            <span className={countBadgeClasses}>{inactiveReview.rowIds.length}</span>
          </summary>
          <div className="mt-4 grid gap-3 xl:grid-cols-2">
            {inactiveReview.rowIds.slice(0, 6).map((rowId) => {
              const row = rowsById.get(rowId);
              return row ? (
                <RowCard key={row.rowId} row={row} compact onOpenRow={onOpenRow} />
              ) : null;
            })}
          </div>
        </details>
      ) : null}

      <div className="grid gap-3 text-xs text-slate-600 md:grid-cols-3">
        <p className="inline-flex items-center gap-2 rounded-lg border border-slate-200 bg-white p-3">
          <TrendingDown className="h-4 w-4 text-rose-600" aria-hidden="true" />
          High spend and high risk are sorted ahead of confidence-only rows.
        </p>
        <p className="rounded-lg border border-slate-200 bg-white p-3">
          Diagnose and inactive rows stay collapsed so the page does not become a flat review list.
        </p>
        <p className="rounded-lg border border-slate-200 bg-white p-3">
          Row buttons only open evidence or blocker context.
        </p>
      </div>
    </section>
  );
}
