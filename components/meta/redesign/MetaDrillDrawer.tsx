"use client";

import { ArrowRight, Clock, ExternalLink, X } from "lucide-react";
import { ConfidencePill, DecisionLabelChip } from "@/components/common/briefing";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaWindowKey, MetaDrillItem } from "@/components/meta/redesign/types";
import { MetaEvidenceAccordion } from "@/components/meta/redesign/MetaEvidenceAccordion";
import { MetaCohortChip } from "@/components/meta/redesign/MetaCohortChip";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import {
  UpperFunnelKpiGrid,
  upperFunnelMetricsForRec,
} from "@/components/meta/redesign/MetaUpperFunnelInformationalCard";
import { formatCurrency } from "@/lib/briefing/utils";
import {
  decisionLabelForRec,
  evidenceValue,
  primaryLabelForRec,
  scopeNameForRec,
} from "@/components/meta/redesign/meta-card-utils";

interface MetaDrillDrawerProps {
  item: MetaDrillItem | null;
  window: MetaWindowKey;
  onWindowChange: (window: MetaWindowKey) => void;
  onClose: () => void;
  onLaunch?: () => void;
}

const WINDOWS: MetaWindowKey[] = ["7d", "14d", "28d", "90d", "custom"];

function parseMetric(value: string | null | undefined) {
  if (!value) return null;
  const parsed = Number(value.replace(/,/g, "").replace(/[^0-9.-]/g, ""));
  return Number.isFinite(parsed) ? parsed : null;
}

function evidenceAny(rec: MetaRecommendation, labels: string[]) {
  for (const label of labels) {
    const value = evidenceValue(rec, label);
    if (value) return value;
  }
  return null;
}

function confidencePercent(rec: MetaRecommendation) {
  return Math.round((rec.confidenceScore ?? (rec.confidence === "high" ? 0.8 : rec.confidence === "medium" ? 0.62 : 0.42)) * 100);
}

function DecisionKpis({ rec, relatedRecs }: { rec: MetaRecommendation; relatedRecs: MetaRecommendation[] }) {
  const spend =
    relatedRecs.length > 0
      ? relatedRecs.reduce((sum, item) => sum + (parseMetric(evidenceAny(item, ["Ad set spend", "Spend", "Core spend"])) ?? 0), 0)
      : parseMetric(evidenceAny(rec, ["Spend", "Ad set spend", "Core spend"]));
  const roas = evidenceAny(rec, ["Core ROAS", "Ad set ROAS", "Selected ROAS", "Peer-group ROAS"]);
  const cpa = evidenceAny(rec, ["Core CPA", "CPA", "Cost / lead"]);

  return (
    <section className="grid gap-2 md:grid-cols-4" data-meta-drill-kpis>
      <Kpi label="Decision" value={rec.decision} />
      <Kpi label="Spend" value={spend != null && spend > 0 ? formatCurrency(spend) : "mixed"} mono />
      <Kpi label="ROAS" value={roas ?? "no ROAS"} mono />
      <Kpi label="CPA" value={cpa ?? "no CPA"} mono />
    </section>
  );
}

function Kpi({ label, value, mono = false }: { label: string; value: string; mono?: boolean }) {
  return (
    <div className="rounded-xl border border-slate-200 bg-white p-3">
      <div className="text-[10.5px] font-semibold uppercase tracking-wider text-slate-400">{label}</div>
      <div className={`mt-1 truncate text-[13px] font-semibold text-slate-900 ${mono ? "font-mono tabular-nums" : ""}`}>
        {value}
      </div>
    </div>
  );
}

function AdsetDepthTable({ recs }: { recs: MetaRecommendation[] }) {
  const rows = recs.filter((rec) => rec.level === "adset");

  return (
    <section className="rounded-xl border border-slate-200 bg-white p-4" data-meta-adset-depth>
      <div className="flex items-center justify-between gap-3">
        <div>
          <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Adset depth</div>
          <p className="mt-1 text-[12.5px] text-slate-500">Child decisions persisted in the selected snapshot.</p>
        </div>
        <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 font-mono text-[10.5px] text-slate-600">
          {rows.length} rows
        </span>
      </div>
      {rows.length > 0 ? (
        <div className="mt-3 overflow-x-auto rounded-lg border border-slate-100">
          <table className="min-w-full text-left text-[12px]">
            <thead className="bg-slate-50 text-[10px] uppercase tracking-wider text-slate-400">
              <tr>
                <th className="px-3 py-2 font-semibold">Name</th>
                <th className="px-3 py-2 font-semibold">Spend</th>
                <th className="px-3 py-2 font-semibold">ROAS</th>
                <th className="px-3 py-2 font-semibold">CPA</th>
                <th className="px-3 py-2 font-semibold">Freq</th>
                <th className="px-3 py-2 font-semibold">Decision</th>
                <th className="px-3 py-2 font-semibold">Conf.</th>
                <th className="px-3 py-2 font-semibold">Action</th>
              </tr>
            </thead>
            <tbody className="divide-y divide-slate-100">
              {rows.map((row) => (
                <tr key={row.id} className="bg-white">
                  <td className="max-w-[260px] truncate px-3 py-2 font-medium text-slate-900">{row.adsetName ?? row.title}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-slate-600">{evidenceAny(row, ["Ad set spend", "Spend"]) ?? "-"}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-slate-600">{evidenceAny(row, ["Ad set ROAS", "Core ROAS"]) ?? "-"}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-slate-600">{evidenceAny(row, ["Core CPA", "CPA"]) ?? "-"}</td>
                  <td className="px-3 py-2 font-mono tabular-nums text-slate-600">{evidenceAny(row, ["Frequency"]) ?? "-"}</td>
                  <td className="px-3 py-2">
                    <DecisionLabelChip label={decisionLabelForRec(row)} surface="meta" size="sm" />
                  </td>
                  <td className="px-3 py-2">
                    <ConfidencePill confidence={confidencePercent(row)} size="sm" />
                  </td>
                  <td className="px-3 py-2 text-[11.5px] font-medium text-slate-700">{primaryLabelForRec(row)}</td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div className="mt-3 rounded-md border border-slate-100 bg-slate-50 px-3 py-2 text-[12.5px] text-slate-600">
          No child adset decision rows were persisted for this snapshot.
        </div>
      )}
    </section>
  );
}

export function MetaDrillDrawer({
  item,
  window,
  onWindowChange,
  onClose,
  onLaunch,
}: MetaDrillDrawerProps) {
  if (!item) return null;
  const isAnomaly = item.mode === "anomaly";
  const isInformational = item.mode === "informational";
  const title = isAnomaly
    ? item.anomaly.title
    : isInformational
      ? item.rec.adsetName ?? item.rec.campaignName ?? item.rec.title
      : item.rec.title;
  const subtitle = isAnomaly
    ? item.anomaly.scopeLabel
    : isInformational
      ? "Brand-build cohort — no purchase decision evaluation"
      : scopeNameForRec(item.rec);
  const relatedRecs = item.mode === "decision" ? item.relatedRecs ?? [] : [];

  return (
    <div className="fixed inset-0 z-50" data-drawer="meta-drill" role="dialog" aria-modal="true">
      <button type="button" className="absolute inset-0 bg-slate-900/20" aria-label="Close drill drawer" onClick={onClose} />
      <aside className="absolute right-0 top-0 bottom-0 w-[80%] max-w-[1280px] bg-white border-l border-slate-200 shadow-xl overflow-y-auto">
        <div className="sticky top-0 z-10 border-b border-slate-200 bg-white px-5 py-4 flex items-start gap-3">
          <div className="min-w-0 flex-1">
            <div className="flex items-center gap-2 flex-wrap">
              {isAnomaly ? <MetaScopeChip level="anomaly" label={item.anomaly.scopeType} /> : <MetaScopeChip level={item.rec.level} />}
              {isInformational ? (
                <>
                  <MetaCohortChip cohort={item.rec.cohort} />
                  <span className="rounded-md border border-slate-200 bg-slate-50 px-1.5 py-0.5 text-[10.5px] font-medium text-slate-600">
                    Informational
                  </span>
                </>
              ) : null}
              <label className="inline-flex items-center gap-1 rounded-md border border-slate-200 bg-white px-2 py-1 text-[12px] text-slate-700">
                Date:
                <select
                  className="bg-transparent text-[12px] font-medium outline-none"
                  value={window}
                  aria-label="Drill drawer date range"
                  onChange={(event) => onWindowChange(event.currentTarget.value as MetaWindowKey)}
                >
                  {WINDOWS.map((item) => (
                    <option key={item} value={item}>
                      {item === "custom" ? "Custom" : item}
                    </option>
                  ))}
                </select>
              </label>
            </div>
            <h2 className="mt-2 text-[18px] font-semibold text-slate-900">{title}</h2>
            <div className="mt-1 text-[12.5px] text-slate-500">{subtitle}</div>
          </div>
          <button
            type="button"
            className="rounded-md p-2 text-slate-500 hover:bg-slate-50 hover:text-slate-900"
            aria-label="Close drill drawer"
            onClick={onClose}
          >
            <X className="inline-block shrink-0" size={18} aria-hidden="true" />
          </button>
        </div>

        <div className="grid gap-4 px-5 py-5">
          {isAnomaly ? (
            <>
              <section className="rounded-xl border border-rose-200 bg-rose-50/30 p-4">
                <div className="text-[12px] font-semibold uppercase tracking-wider text-rose-700">Diagnostic</div>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{item.anomaly.detail}</p>
                <div className="mt-3 grid gap-2">
                  {(item.anomaly.diagnosticLadder && item.anomaly.diagnosticLadder.length > 0
                    ? item.anomaly.diagnosticLadder.map((step) => `${step.step}. ${step.label}: ${step.detail}`)
                    : item.anomaly.diagnostics
                  ).map((diagnostic) => (
                    <div key={diagnostic} className="rounded-md border border-rose-100 bg-white px-3 py-2 text-[12.5px] text-slate-700">
                      {diagnostic}
                    </div>
                  ))}
                </div>
              </section>
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Recent status</div>
                <div className="mt-2 flex items-center gap-2 text-[12.5px] text-slate-600">
                  <Clock className="inline-block shrink-0" size={13} aria-hidden="true" />
                  Detected at {item.anomaly.detectedAt}
                </div>
              </section>
            </>
          ) : isInformational ? (
            <section className="rounded-xl border border-slate-200 bg-white p-4">
              <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Brand KPIs</div>
              <p className="mt-2 text-[13px] leading-relaxed text-slate-700">
                Upper-funnel delivery is shown for visibility only and is not evaluated as a purchase decision.
              </p>
              <div className="mt-4">
                <UpperFunnelKpiGrid metrics={upperFunnelMetricsForRec(item.rec)} />
              </div>
            </section>
          ) : (
            <>
              <DecisionKpis rec={item.rec} relatedRecs={relatedRecs} />
              <section className="rounded-xl border border-slate-200 bg-white p-4">
                <div className="text-[12px] font-semibold uppercase tracking-wider text-slate-500">Engine reasoning</div>
                <p className="mt-2 text-[13px] leading-relaxed text-slate-700">{item.rec.why}</p>
                <p className="mt-2 rounded-md bg-slate-50 px-3 py-2 text-[12.5px] text-slate-700">{item.rec.recommendedAction}</p>
              </section>
              {item.rec.level === "campaign" || relatedRecs.length > 0 ? <AdsetDepthTable recs={relatedRecs} /> : null}
              <MetaEvidenceAccordion rec={item.rec} />
            </>
          )}
        </div>

        <div className="sticky bottom-0 border-t border-slate-200 bg-slate-50 px-5 py-3 flex items-center gap-2">
          <button
            type="button"
            className="inline-flex items-center gap-1 rounded-md border border-slate-300 bg-white px-3 py-1.5 text-[12.5px] text-slate-700 hover:bg-slate-50"
            onClick={onClose}
          >
            Close
          </button>
          {item.mode === "decision" && onLaunch ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md bg-slate-900 px-3 py-1.5 text-[12.5px] font-medium text-white hover:bg-slate-800"
              onClick={onLaunch}
            >
              Launchpad bridge
              <ExternalLink className="inline-block shrink-0" size={13} aria-hidden="true" />
            </button>
          ) : isAnomaly ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-slate-500">
              Diagnose first
              <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
            </span>
          ) : isInformational ? (
            <span className="inline-flex items-center gap-1 text-[12px] text-slate-500">
              Read-only brand metrics
            </span>
          ) : null}
        </div>
      </aside>
    </div>
  );
}
