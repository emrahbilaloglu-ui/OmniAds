"use client";

import { useState } from "react";
import { ArrowRight, Check, Clock, ExternalLink, Eye, Pause, Sliders, SquareStack } from "lucide-react";
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
  evidenceWindow?: string;
  onSelect?: (id: string, selected: boolean) => void;
  onPrimary?: (rec: MetaRecommendation) => void;
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
  evidenceWindow = "28d",
  onSelect,
  onPrimary,
  onOpenDrill,
  onDefer,
  onUndoDefer,
}: MetaActionCardProps) {
  const [evidenceOpen, setEvidenceOpen] = useState(false);

  if (anomaly) {
    return (
      <article className={cn("rounded-2xl bg-white p-4 transition-all relative shadow-[0_1px_2px_rgba(15,23,42,0.04)]", cardBorder(undefined, anomaly))} data-card="anomaly">
        <div className="flex items-start gap-3">
          <div className="mt-0.5 rounded-lg bg-rose-50 p-2 text-rose-600">
            <SquareStack className="inline-block shrink-0" size={16} aria-hidden="true" />
          </div>
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-1.5 flex-wrap">
              <MetaScopeChip level="anomaly" label={anomaly.scopeType} />
              <span className="rounded-md border border-rose-200 bg-rose-50 px-1.5 py-0.5 text-[9.5px] font-semibold uppercase tracking-wider text-rose-700">
                {anomaly.severity}
              </span>
            </div>
            <h4 className="mt-2 text-[14px] font-semibold leading-snug text-slate-900">{anomaly.title}</h4>
            <p className="mt-1 text-[12.5px] leading-snug text-slate-600">{anomaly.detail}</p>
            {anomaly.diagnosticLadder && anomaly.diagnosticLadder.length > 0 ? (
              <ol className="mt-3 grid gap-1.5">
                {anomaly.diagnosticLadder.slice(0, 3).map((step) => (
                  <li key={`${anomaly.id}-${step.step}`} className="flex items-start gap-2 text-[11.5px] text-slate-600">
                    <span className="mt-0.5 inline-flex size-4 shrink-0 items-center justify-center rounded-full bg-rose-100 text-[9px] font-semibold text-rose-700">
                      {step.step}
                    </span>
                    <span className="min-w-0">
                      <span className="font-semibold text-slate-700">{step.label}</span>: {step.detail}
                    </span>
                  </li>
                ))}
              </ol>
            ) : null}
            <div className="mt-3 flex items-center gap-2">
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md bg-rose-600 px-3 py-1.5 text-[12px] font-medium text-white hover:bg-rose-700"
                onClick={() => onOpenDrill?.(anomaly)}
              >
                Open diagnostic
                <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />
              </button>
              <span className="text-[11px] text-slate-500">{anomaly.scopeLabel}</span>
            </div>
          </div>
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

  return (
    <article
      className={cn(
        "rounded-2xl bg-white p-4 transition-all relative shadow-[0_1px_2px_rgba(15,23,42,0.04)]",
        cardBorder(rec),
        selected ? "ring-2 ring-blue-200" : "",
        deferred ? "opacity-75" : "",
      )}
      data-card="meta-action"
      data-rec-id={id}
    >
      <div className="flex items-start gap-3">
        <label className="mt-1 inline-flex items-center">
          <input
            type="checkbox"
            className="size-4 rounded border-slate-300"
            checked={selected}
            aria-label={`Select ${scopeName}`}
            onChange={(event) => onSelect?.(id, event.currentTarget.checked)}
          />
        </label>
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-1.5 flex-wrap">
            <MetaScopeChip level={rec.level} />
            <DecisionLabelChip label={label} surface="meta" size="sm" />
            {rec.level === "campaign" && rec.campaignRole ? <MetaCampaignRoleChip role={rec.campaignRole} /> : null}
            {rec.bidRegime ? <MetaBidRegimeChip regime={rec.bidRegime} /> : null}
            <ConfidencePill confidence={confidence} size="sm" className="ml-auto" />
          </div>

          <h4 className="mt-2 text-[14px] font-semibold leading-snug text-slate-900">{rec.title}</h4>
          <p className="mt-1 text-[12.5px] leading-snug text-slate-600">{rec.summary}</p>

          <EvidenceTags rec={rec} evidenceWindow={evidenceWindow} />
          <TrendSnapshot rec={rec} />
          <DeploymentQueue rec={rec} />

          {rec.level === "adset" && bidValue ? (
            <div className="mt-2 inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-1.5 py-0.5 text-[10.5px] text-blue-700">
              <Sliders className="inline-block shrink-0" size={11} aria-hidden="true" />
              Proposed bid {formatCurrency(bidValue)}
            </div>
          ) : null}

          <div className="mt-3 flex items-center gap-2 flex-wrap">
            <button
              type="button"
              className={cn(
                "inline-flex items-center gap-1 rounded-md px-3 py-1.5 text-[12px] font-medium",
                confidence >= 70
                  ? "bg-slate-900 text-white hover:bg-slate-800"
                  : "border border-slate-300 bg-white text-slate-700 hover:bg-slate-50",
              )}
              onClick={() => onPrimary?.(rec)}
            >
              <PrimaryIcon rec={rec} />
              {primaryLabelForRec(rec)}
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50"
              aria-haspopup="dialog"
              aria-expanded={evidenceOpen}
              onClick={() => setEvidenceOpen(true)}
            >
              <Eye className="inline-block shrink-0" size={12} aria-hidden="true" />
              Evidence
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50"
              onClick={() => onOpenDrill?.(rec)}
            >
              Drilldown
              <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
            </button>
            <DeferTooltip>
              <button
                type="button"
                className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2.5 py-1.5 text-[12px] text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
                onClick={() => onDefer?.(rec)}
              >
                <Clock className="inline-block shrink-0" size={12} aria-hidden="true" />
                Let cook
              </button>
            </DeferTooltip>
            <span className="ml-auto inline-flex items-center gap-1 text-[11px] text-slate-500">
              <Check className="inline-block shrink-0 text-emerald-600" size={12} aria-hidden="true" />
              {rec.engineVersion ?? "Meta engine"}
            </span>
          </div>
          <div className="mt-2 flex flex-wrap items-center gap-1.5 text-[10.5px]">
            {effectiveResponseState ? (
              <span
                className={cn(
                  "inline-flex items-center rounded-md border px-1.5 py-0.5 font-medium",
                  responseStateTone(effectiveResponseState),
                )}
                data-operator-response={effectiveResponseState}
              >
                {responseStateLabel(effectiveResponseState)}
              </span>
            ) : null}
            {calibration ? (
              <span
                className="inline-flex max-w-full items-center rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-slate-600"
                title={`Calibration scope: ${calibration}`}
                data-calibration-scope
              >
                <span className="shrink-0 text-slate-400">Calibration</span>
                <span className="ml-1 truncate font-medium text-slate-700">{calibration}</span>
              </span>
            ) : null}
            {signalQuality ? (
              <span
                className="inline-flex max-w-full items-center rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-slate-600"
                title={`Signal quality: ${signalQuality}`}
                data-signal-quality
              >
                <span className="shrink-0 text-slate-400">Signals</span>
                <span className="ml-1 truncate font-medium text-slate-700">{signalQuality}</span>
              </span>
            ) : null}
          </div>
          <DeferChip id={scopeIdForRec(rec)} deferred={deferred} onUndo={() => onUndoDefer?.(rec)} />
          <EvidencePopover
            open={evidenceOpen}
            title="Evidence"
            subtitle={scopeName}
            sections={buildMetaEvidenceSections(rec)}
            variant="meta"
            onClose={() => setEvidenceOpen(false)}
          />
        </div>
      </div>
    </article>
  );
}
