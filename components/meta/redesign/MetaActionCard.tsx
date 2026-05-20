"use client";

import { useState } from "react";
import { ArrowRight, Check, Clock, ExternalLink, Eye, Pause, Play, Sliders, SquareStack } from "lucide-react";
import {
  ConfidencePill,
  DecisionLabelChip,
  DeferChip,
  DeferTooltip,
  EvidencePopover,
} from "@/components/common/briefing";
import { cn } from "@/lib/utils";
import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { formatCurrency, sparklinePath } from "@/lib/briefing/utils";
import { MetaBidRegimeChip } from "@/components/meta/redesign/MetaBidRegimeChip";
import { MetaCampaignRoleChip } from "@/components/meta/redesign/MetaCampaignRoleChip";
import { MetaCohortChip } from "@/components/meta/redesign/MetaCohortChip";
import { buildMetaEvidenceSections } from "@/components/meta/redesign/MetaEvidenceAccordion";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import {
  decisionLabelForRec,
  primaryLabelForRec,
  proposedBidValue,
  scopeIdForRec,
  scopeNameForRec,
} from "@/components/meta/redesign/meta-card-utils";

interface MetaActionCardProps {
  rec?: MetaRecommendation;
  anomaly?: MetaAnomaly;
  selected?: boolean;
  deferred?: boolean;
  responseState?: "acted" | "deferred" | "ignored" | null;
  primaryPending?: boolean;
  actionFeedback?: { tone: "success" | "error"; title: string; detail?: string | null } | null;
  evidenceWindow?: string;
  onSelect?: (id: string, selected: boolean) => void;
  onPrimary?: (rec: MetaRecommendation) => void;
  onResume?: (rec: MetaRecommendation) => void;
  onOpenDrill?: (item: MetaRecommendation | MetaAnomaly) => void;
  onDefer?: (rec: MetaRecommendation) => void;
  onUndoDefer?: (rec: MetaRecommendation) => void;
}

function confidencePercent(rec: MetaRecommendation) {
  return Math.round((rec.confidenceScore ?? (rec.confidence === "high" ? 0.8 : rec.confidence === "medium" ? 0.62 : 0.42)) * 100);
}

function cardBorder(rec?: MetaRecommendation, anomaly?: MetaAnomaly) {
  if (anomaly?.severity === "high") return "border-2 border-rose-300";
  if (rec && confidencePercent(rec) >= 70) return "border-2 border-slate-300";
  return "border border-slate-200";
}

function EvidenceTags({ rec, evidenceWindow = "28d" }: { rec: MetaRecommendation; evidenceWindow?: string }) {
  const tags = rec.evidence.slice(0, 4);
  return (
    <div className="flex items-center gap-1.5 flex-wrap mt-3" data-evidence-tags>
      {tags.map((item) => (
        <span
          key={`${item.label}-${item.value}`}
          className={cn(
            "inline-flex items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px]",
            item.tone === "positive"
              ? "border-emerald-200 bg-emerald-50 text-emerald-700"
              : item.tone === "warning"
                ? "border-amber-200 bg-amber-50 text-amber-800"
                : "border-slate-200 bg-slate-50 text-slate-600",
          )}
        >
          <span className="text-slate-400">{item.label.replace(/^Selected|^Core/, evidenceWindow)}</span>
          <span className="font-medium">{item.value}</span>
        </span>
      ))}
    </div>
  );
}

function PrimaryIcon({ rec }: { rec: MetaRecommendation }) {
  if (rec.decisionState === "watch") return <Clock className="inline-block shrink-0" size={13} aria-hidden="true" />;
  if (rec.kind === "state") return <ExternalLink className="inline-block shrink-0" size={13} aria-hidden="true" />;
  if (rec.type === "adset_cut_spend") return <Pause className="inline-block shrink-0" size={13} aria-hidden="true" />;
  if (rec.type === "bid_strategy_fit" || rec.type === "bid_value_guidance" || rec.type === "bid_band_from_history") {
    return <Sliders className="inline-block shrink-0" size={13} aria-hidden="true" />;
  }
  return <ExternalLink className="inline-block shrink-0" size={13} aria-hidden="true" />;
}

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function calibrationScopeText(rec: MetaRecommendation) {
  const scope = rec.calibrationScope;
  if (!scope || typeof scope !== "object") return null;
  const type = stringValue(scope.type) ?? stringValue(scope.scope_type) ?? stringValue(scope.level);
  const source = stringValue(scope.source) ?? stringValue(scope.window);
  if (type && source) return `${type} · ${source}`;
  return type ?? source ?? null;
}

function signalQualityText(rec: MetaRecommendation) {
  const quality = rec.signalQuality;
  if (!quality || typeof quality !== "object") return null;
  const status = stringValue(quality.quality_status) ?? stringValue(quality.status);
  const cap = stringValue(quality.confidence_cap) ?? stringValue(quality.confidenceCap);
  if (status && cap) return `${status} · cap ${cap}`;
  return status ?? (cap ? `cap ${cap}` : null);
}

function automationReadinessText(rec: MetaRecommendation) {
  const readiness = rec.automationReadiness;
  if (!readiness) return null;
  if (readiness.tier === "auto_execute") return "Eligible";
  if (readiness.tier === "backtest_candidate") return "Backtest needed";
  if (readiness.tier === "manual_review") return "Manual review";
  return "Read-only";
}

function responseStateTone(responseState: "acted" | "deferred" | "ignored") {
  if (responseState === "acted") return "border-emerald-200 bg-emerald-50 text-emerald-700";
  if (responseState === "deferred") return "border-amber-200 bg-amber-50 text-amber-800";
  return "border-slate-200 bg-slate-50 text-slate-600";
}

function responseStateLabel(responseState: "acted" | "deferred" | "ignored") {
  if (responseState === "acted") return "Acted";
  if (responseState === "deferred") return "Deferred";
  return "Ignored";
}

function completedPrimaryLabel(rec: MetaRecommendation) {
  if (rec.type === "adset_cut_spend") return "Paused";
  if (rec.type === "bid_strategy_fit" || rec.type === "bid_value_guidance" || rec.type === "bid_band_from_history") return "Applied";
  return "Acted";
}

function canResumeCompletedPrimary(rec: MetaRecommendation, primaryCompleted: boolean) {
  if (!primaryCompleted) return false;
  const subtype = (rec.operatorResponseSubtype ?? "").toLowerCase();
  const pauseLike = subtype.includes("pause") || (!subtype && rec.type === "adset_cut_spend");
  if (!pauseLike) return false;
  return (rec.level === "adset" && Boolean(rec.adsetId)) || (rec.level === "campaign" && Boolean(rec.campaignId));
}

function resumePrimaryLabel(rec: MetaRecommendation) {
  return rec.level === "campaign" ? "Resume campaign" : "Resume adset";
}

function evidenceValue(rec: MetaRecommendation, pattern: RegExp) {
  return rec.evidence.find((item) => pattern.test(item.label))?.value ?? null;
}

function numericEvidenceValue(rec: MetaRecommendation, pattern: RegExp) {
  const raw = evidenceValue(rec, pattern);
  if (!raw) return null;
  const parsed = Number(raw.replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function decisionChipClass(label: string) {
  if (["cut", "below_breakeven", "rebuild", "diagnose"].includes(label)) return "chip--action";
  if (["scale", "switch", "tune", "swap"].includes(label)) return "chip--action";
  if (["refresh", "test_more", "review_adsets", "review_placements"].includes(label)) return "chip--watch";
  if (label === "keep") return "chip--healthy";
  return "chip--ghost";
}

function decisionChipLabel(label: string) {
  if (label === "below_breakeven") return "Cut candidate";
  if (label === "test_more") return "Fresh test";
  if (label === "review_adsets") return "Review ad sets";
  if (label === "review_placements") return "Review placements";
  return label.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function compactLabel(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

function metricTone(label: string, value: string | null) {
  const numeric = value ? Number(value.replace(/[^0-9.-]/g, "")) : null;
  if (!Number.isFinite(numeric)) return "";
  if (/roas/i.test(label) && numeric != null) {
    if (numeric < 1) return "warn";
    if (numeric >= 2) return "good";
  }
  if (/cpa|freq/i.test(label) && numeric != null && numeric > 4) return "warn";
  return "";
}

function cardMetricRows(rec: MetaRecommendation, evidenceWindow: string) {
  const metricEvidence = [
    { key: "Spend", value: evidenceValue(rec, /spend/i), pattern: /spend/i },
    { key: `ROAS ${evidenceWindow}`, value: evidenceValue(rec, /roas/i), pattern: /roas/i },
    { key: "CPA", value: evidenceValue(rec, /cpa/i), pattern: /cpa/i },
    { key: "Purchases", value: evidenceValue(rec, /purchase/i), pattern: /purchase/i },
    { key: "Freq", value: evidenceValue(rec, /freq/i), pattern: /freq/i },
  ];
  const rows = metricEvidence.flatMap((metric) =>
    metric.value ? [{ key: metric.key, value: metric.value }] : [],
  );
  const fallbackEvidence = rec.evidence
    .filter((item) => item.value && !metricEvidence.some((metric) => metric.pattern.test(item.label)))
    .slice(0, Math.max(0, 5 - rows.length))
    .map((item) => ({ key: item.label, value: item.value }));
  const confidence = confidencePercent(rec);
  const paddedRows = [...rows, ...fallbackEvidence];
  if (!paddedRows.some((row) => row.key === "Confidence")) {
    paddedRows.push({ key: "Confidence", value: `${confidence}%` });
  }
  if (paddedRows.length < 5 && !paddedRows.some((row) => row.key === "Priority")) {
    paddedRows.push({ key: "Priority", value: rec.priority });
  }
  return paddedRows.slice(0, 5);
}

function TrendSnapshot({ rec }: { rec: MetaRecommendation }) {
  const history = rec.evidenceTrail?.roas_history;
  const values = Array.isArray(history) ? history.map(Number).filter(Number.isFinite) : [];
  if (values.length === 0 && !rec.predictiveOverlay) return null;
  const latest = values.at(-1);
  const first = values[0];
  const trendTone = latest != null && first != null && latest >= first ? "text-emerald-600" : "text-rose-600";

  return (
    <div className="mt-3 flex items-center gap-2 rounded-lg border border-slate-100 bg-slate-50 px-2 py-1.5" data-meta-trend>
      {values.length > 0 ? (
        <svg viewBox="0 0 60 16" width="92" height="24" className={trendTone} preserveAspectRatio="none" aria-hidden="true">
          <path d={sparklinePath(values)} fill="none" stroke="currentColor" strokeWidth="1.6" />
        </svg>
      ) : null}
      <span className="min-w-0 flex-1 truncate text-[11.5px] text-slate-600">
        {rec.predictiveOverlay ?? rec.timeframeContext.selectedRangeOverlay}
      </span>
    </div>
  );
}

function DeploymentQueue({ rec }: { rec: MetaRecommendation }) {
  const rows = [
    { label: "Promote to main", values: rec.promoteCreatives, className: "border-emerald-200 bg-emerald-50 text-emerald-700" },
    { label: "Keep testing", values: rec.keepTestingCreatives, className: "border-blue-200 bg-blue-50 text-blue-700" },
    { label: "Do not deploy", values: rec.doNotDeployCreatives, className: "border-rose-200 bg-rose-50 text-rose-700" },
  ].filter((row) => row.values && row.values.length > 0);

  if (rows.length === 0 && !rec.targetScalingLane) return null;

  return (
    <div className="mt-3 flex flex-wrap items-center gap-1.5" data-meta-deployment-queue>
      {rec.targetScalingLane ? (
        <span className="inline-flex max-w-full items-center rounded-md border border-slate-200 bg-white px-1.5 py-0.5 text-[10.5px] text-slate-600">
          Target: <span className="ml-1 truncate font-medium text-slate-800">{rec.targetScalingLane}</span>
        </span>
      ) : null}
      {rows.map((row) => (
        <span
          key={row.label}
          className={`inline-flex max-w-full items-center rounded-md border px-1.5 py-0.5 text-[10.5px] ${row.className}`}
        >
          {row.label}: <span className="ml-1 truncate font-medium">{row.values?.slice(0, 2).join(", ")}</span>
        </span>
      ))}
    </div>
  );
}

export function MetaActionCard({
  rec,
  anomaly,
  selected = false,
  deferred = false,
  responseState = null,
  primaryPending = false,
  actionFeedback = null,
  evidenceWindow = "28d",
  onSelect,
  onPrimary,
  onResume,
  onOpenDrill,
  onDefer,
  onUndoDefer,
}: MetaActionCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  if (anomaly) {
    return (
      <article className="dcard" data-card="anomaly">
        <div className="check" />
        <div>
          <div className="meta-line">
            <span className="chip chip--action"><span className="dot" />Tracking</span>
            <span className="chip chip--ghost"><span className="dot" />{anomaly.scopeType}</span>
            <b>{anomaly.scopeLabel}</b>
          </div>
          <div className="title">{anomaly.title}</div>
          <div className="why">
            {anomaly.detail}
            {anomaly.diagnosticLadder?.[0] ? (
              <span className="from">source · {anomaly.diagnosticLadder[0].label} · severity {anomaly.severity}</span>
            ) : (
              <span className="from">source · anomalies · severity {anomaly.severity}</span>
            )}
          </div>
          {anomaly.diagnosticLadder?.length ? (
            <div className="badges-row">
              {anomaly.diagnosticLadder.slice(0, 3).map((step) => (
                <span key={`${anomaly.id}-${step.step}`} className="chip chip--ghost" title={step.detail}><span className="dot" />{step.label}</span>
              ))}
            </div>
          ) : null}
        </div>
        <div className="actions-col">
          <span className="why-action">Recommended</span>
          <button type="button" className="btn btn--primary" onClick={() => onOpenDrill?.(anomaly)}>
            Open diagnostic
            <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />
          </button>
        </div>
      </article>
    );
  }

  if (!rec) return null;

  const id = rec.id;
  const label = decisionLabelForRec(rec);
  const confidence = confidencePercent(rec);
  const bidValue = proposedBidValue(rec);
  const scopeName = scopeNameForRec(rec);
  const effectiveResponseState = responseState ?? (deferred ? "deferred" : null);
  const calibration = calibrationScopeText(rec);
  const signalQuality = signalQualityText(rec);
  const automationReadiness = automationReadinessText(rec);
  const metricRows = cardMetricRows(rec, evidenceWindow);
  const primaryActionLabel = rec.decisionState === "watch" ? "Let cook" : primaryLabelForRec(rec);
  const primaryCompleted = effectiveResponseState === "acted";
  const primaryCanResume = Boolean(onResume) && canResumeCompletedPrimary(rec, primaryCompleted);

  return (
    <article
      className={cn(
        "dcard",
        selected ? "ring-2 ring-blue-200" : "",
        deferred ? "opacity-75" : "",
      )}
      data-card="meta-action"
      data-rec-id={id}
    >
      {onSelect ? (
        <label>
          <input
            type="checkbox"
            className="sr-only"
            checked={selected}
            aria-label={`Select ${scopeName}`}
            onChange={(event) => onSelect(id, event.currentTarget.checked)}
          />
          <span className={cn("check", selected ? "on" : "")} aria-hidden="true" />
        </label>
      ) : (
        <div className={cn("check", selected ? "on" : "")} />
      )}
      <div>
        <div className="meta-line">
          <span className={cn("chip", decisionChipClass(label))}><span className="dot" />{decisionChipLabel(label)}</span>
          {rec.campaignRole ? <span className="chip"><span className="dot" />{compactLabel(rec.campaignRole)}</span> : null}
          {rec.bidRegime ? <span className="chip chip--warn"><span className="dot" />{compactLabel(rec.bidRegime)}</span> : null}
          {rec.cohort && rec.cohort !== "purchase" ? (
            <span className="chip chip--ghost" data-cohort-chip={rec.cohort}><span className="dot" />{compactLabel(rec.cohort)}</span>
          ) : null}
          <span>{rec.level}</span> · <b>{scopeName}</b>
          {rec.timeframeContext?.selectedRangeOverlay ? <span>· {rec.timeframeContext.selectedRangeOverlay}</span> : null}
        </div>

        <div className="title">{rec.title}</div>
        <div className="why">
          {rec.summary || rec.why || rec.decision}
          <span className="from">
            source · {rec.decisionState} · {calibration ? `${calibration} · ` : ""}{signalQuality ? `${signalQuality} · ` : ""}{rec.engineVersion ?? "meta engine"}
          </span>
        </div>

        <div className="metric-strip">
          {metricRows.map((metric) => (
            <div key={metric.key} className="m">
              <span className="k">{metric.key}</span>
              <span className={cn("v", metricTone(metric.key, metric.value))}>{metric.value}</span>
            </div>
          ))}
        </div>

        <div className="badges-row">
          {automationReadiness ? (
            <span className={cn("chip", automationReadiness === "Eligible" ? "chip--auto" : "chip--ghost")} title={rec.automationReadiness?.reason} data-automation-readiness>
              <span className="dot" />{automationReadiness === "Eligible" ? "Auto-ready" : automationReadiness}
            </span>
          ) : null}
          <span className="chip"><span className="dot" />Confidence {rec.confidence}</span>
          <span className="conf"><span className="bar"><i style={{ width: `${Math.max(2, Math.min(100, confidence))}%` }} /></span>{(confidence / 100).toFixed(2)}</span>
          {effectiveResponseState ? (
            <span className="chip chip--ghost" data-operator-response={effectiveResponseState}><span className="dot" />{responseStateLabel(effectiveResponseState)}</span>
          ) : null}
          {bidValue ? <span className="chip chip--info"><span className="dot" />Bid {formatCurrency(bidValue)}</span> : null}
        </div>
        <DeferChip id={scopeIdForRec(rec)} deferred={deferred} onUndo={() => onUndoDefer?.(rec)} />
      </div>
      <div className="actions-col">
        <span className="why-action">Recommended</span>
        <button
          type="button"
          className="btn btn--primary"
          disabled={primaryPending || (primaryCompleted && !primaryCanResume)}
          onClick={() => (primaryCanResume ? onResume?.(rec) : onPrimary?.(rec))}
        >
          {primaryCanResume ? <Play className="inline-block shrink-0" size={13} aria-hidden="true" /> : <PrimaryIcon rec={rec} />}
          {primaryPending ? "Working..." : primaryCanResume ? resumePrimaryLabel(rec) : primaryCompleted ? completedPrimaryLabel(rec) : primaryActionLabel}
        </button>
        {actionFeedback ? (
          <div className={cn("meta-action-feedback", `meta-action-feedback--${actionFeedback.tone}`)} role="status" data-meta-action-feedback={actionFeedback.tone}>
            <span className="dot" aria-hidden="true" />
            <span>
              <b>{actionFeedback.title}</b>
              {actionFeedback.detail ? <small>{actionFeedback.detail}</small> : null}
            </span>
          </div>
        ) : null}
        <button type="button" className="btn" onClick={() => onOpenDrill?.(rec)}>
          {rec.level === "adset" ? "View ad set" : "View ad sets"}
          <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
        </button>
        <div className="flex gap-1.5">
          <DeferTooltip>
            <button type="button" className="btn btn--ghost btn--sm" onClick={() => onDefer?.(rec)}>
              Defer
            </button>
          </DeferTooltip>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setEvidenceOpen(true)}>Evidence</button>
        </div>
      </div>
      <EvidencePopover
        open={evidenceOpen}
        title="Evidence"
        subtitle={scopeName}
        sections={buildMetaEvidenceSections(rec)}
        variant="meta"
        onClose={() => setEvidenceOpen(false)}
      />
    </article>
  );
}
