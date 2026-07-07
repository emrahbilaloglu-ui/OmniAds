"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Clock, ExternalLink, X } from "lucide-react";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaWindowKey, MetaDrillItem } from "@/components/meta/redesign/types";
import { MetaEvidenceAccordion } from "@/components/meta/redesign/MetaEvidenceAccordion";
import { MetaCohortChip } from "@/components/meta/redesign/MetaCohortChip";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import {
  UpperFunnelKpiGrid,
  upperFunnelMetricsForRec,
} from "@/components/meta/redesign/MetaUpperFunnelInformationalCard";
import { formatMoney } from "@/components/meta/redesign/meta-card-utils";
import {
  decisionLabelForRec,
  evidenceValue,
  primaryLabelForRec,
  scopeNameForRec,
} from "@/components/meta/redesign/meta-card-utils";

interface MetaDrillDrawerProps {
  moneyCurrency?: string | null;
  /** Pulse target ROAS (a ratio) for the vs-target comparison. */
  targetRoas?: number | null;
  item: MetaDrillItem | null;
  /** "push" renders in-flow (>=1440px), "overlay" renders a fixed right drawer. */
  variant?: "push" | "overlay";
  onClose: () => void;
  onLaunch?: () => void;
  /** Accepted for call-site compatibility; the inspector no longer carries a
   * window switcher (it is a page-level control and must not mutate URL here). */
  window?: MetaWindowKey;
  onWindowChange?: (window: MetaWindowKey) => void;
}

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

function stringValue(value: unknown) {
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function calibrationScopeText(rec: MetaRecommendation) {
  const scope = rec.calibrationScope;
  if (!scope || typeof scope !== "object") return null;
  const type = stringValue((scope as Record<string, unknown>).type) ?? stringValue((scope as Record<string, unknown>).scope_type);
  const source = stringValue((scope as Record<string, unknown>).source) ?? stringValue((scope as Record<string, unknown>).window);
  if (type && source) return `${type} · ${source}`;
  return type ?? source ?? null;
}

function signalCapText(rec: MetaRecommendation) {
  const quality = rec.signalQuality;
  if (!quality || typeof quality !== "object") return null;
  return stringValue((quality as Record<string, unknown>).confidence_cap) ?? stringValue((quality as Record<string, unknown>).confidenceCap);
}

function automationTierLabel(tier: string | undefined) {
  if (tier === "auto_execute") return "Auto-ready";
  if (tier === "backtest_candidate") return "Backtest candidate";
  if (tier === "manual_review") return "Manual review";
  if (tier === "read_only") return "Read-only";
  return "—";
}

function SectionLabel({ children }: { children: React.ReactNode }) {
  return (
    <div
      className="mono"
      style={{
        fontSize: 11,
        letterSpacing: "0.03em",
        color: "var(--muted)",
        marginBottom: 6,
        textTransform: "uppercase",
      }}
    >
      {children}
    </div>
  );
}

function Panel({ children, style }: { children: React.ReactNode; style?: React.CSSProperties }) {
  return (
    <section
      style={{
        border: "1px solid var(--border)",
        borderRadius: "var(--r-lg)",
        background: "var(--surface)",
        padding: "12px 14px",
        ...style,
      }}
    >
      {children}
    </section>
  );
}

/** Blue→emerald gradient trend line, no fill, with an optional dashed target
 * baseline. Only renders when a real series exists. */
function GradientSpark({ values, target, gradientId }: { values: number[]; target?: number | null; gradientId: string }) {
  if (values.length < 2) return null;
  const W = 200;
  const H = 44;
  const pad = 4;
  const all = target != null && Number.isFinite(target) ? [...values, target] : values;
  const min = Math.min(...all);
  const max = Math.max(...all);
  const range = max - min || 1;
  const x = (i: number) => (values.length === 1 ? 0 : (i / (values.length - 1)) * W);
  const y = (v: number) => H - pad - ((v - min) / range) * (H - pad * 2);
  const points = values.map((v, i) => `${x(i).toFixed(1)},${y(v).toFixed(1)}`).join(" ");
  const targetY = target != null && Number.isFinite(target) ? y(target) : null;
  return (
    <svg width="100%" height={H} viewBox={`0 0 ${W} ${H}`} preserveAspectRatio="none" role="img" aria-label="ROAS trend">
      <defs>
        <linearGradient id={gradientId} x1="0" y1="0" x2="1" y2="0">
          <stop offset="0%" stopColor="var(--brand)" />
          <stop offset="100%" stopColor="var(--ok)" />
        </linearGradient>
      </defs>
      {targetY != null ? (
        <line x1="0" y1={targetY} x2={W} y2={targetY} stroke="var(--muted-2)" strokeWidth="1" strokeDasharray="3 3" />
      ) : null}
      <polyline points={points} fill="none" stroke={`url(#${gradientId})`} strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
  );
}

function MetricRow({
  k,
  v,
  note,
  tone = "ink",
}: {
  k: string;
  v: string;
  note?: string | null;
  tone?: "ink" | "ok" | "danger" | "warn";
}) {
  const toneColor =
    tone === "ok" ? "var(--ok)" : tone === "danger" ? "var(--danger)" : tone === "warn" ? "var(--warn)" : "var(--ink)";
  return (
    <div
      style={{
        display: "flex",
        justifyContent: "space-between",
        gap: 8,
        padding: "5px 0",
        borderTop: "1px solid var(--border)",
        fontSize: 12,
      }}
    >
      <span style={{ color: "var(--ink-2)" }}>{k}</span>
      <span style={{ textAlign: "right", fontVariantNumeric: "tabular-nums", fontWeight: 600, color: toneColor }}>
        {v}
        {note ? <span style={{ fontWeight: 400, color: "var(--muted)", fontSize: 11 }}> {note}</span> : null}
      </span>
    </div>
  );
}

function DecisionKpis({
  rec,
  relatedRecs,
  moneyCurrency,
  targetRoas,
  gradientId,
}: {
  rec: MetaRecommendation;
  relatedRecs: MetaRecommendation[];
  moneyCurrency?: string | null;
  targetRoas?: number | null;
  gradientId: string;
}) {
  // Structured rec.metrics is the primary source (server-owned, currency
  // aware). Evidence display strings remain an explicit fallback ONLY for
  // payloads whose recommendations predate the metrics contract - that
  // fallback is regression-tested, not incidental.
  const structuredSpend =
    relatedRecs.length > 0
      ? relatedRecs.reduce((sum, item) => sum + (item.metrics?.spend ?? 0), 0)
      : rec.metrics?.spend ?? null;
  const fallbackSpend =
    relatedRecs.length > 0
      ? relatedRecs.reduce(
          (sum, item) => sum + (parseMetric(evidenceAny(item, ["Ad set spend", "Spend", "Core spend"])) ?? 0),
          0,
        )
      : parseMetric(evidenceAny(rec, ["Spend", "Ad set spend", "Core spend"]));
  const hasStructured =
    relatedRecs.length > 0 ? relatedRecs.some((item) => item.metrics?.spend != null) : rec.metrics?.spend != null;
  const spend = hasStructured ? structuredSpend : fallbackSpend;
  const roasNumber = rec.metrics?.roas ?? null;
  const roas = roasNumber != null ? `${roasNumber.toFixed(2)}x` : evidenceAny(rec, ["Core ROAS", "Ad set ROAS", "Selected ROAS", "Peer-group ROAS"]);
  const cpa =
    rec.metrics?.cpa != null ? formatMoney(rec.metrics.cpa, moneyCurrency) : evidenceAny(rec, ["Core CPA", "CPA", "Cost / lead"]);
  const roasTone =
    roasNumber != null && targetRoas != null && Number.isFinite(targetRoas)
      ? roasNumber >= targetRoas
        ? "ok"
        : "danger"
      : "ink";

  const history = rec.evidenceTrail?.roas_history;
  const series = Array.isArray(history) ? history.map(Number).filter(Number.isFinite) : [];

  return (
    <Panel style={{ background: "var(--surface-2)" }}>
      <SectionLabel>Money impact &amp; metrics</SectionLabel>
      <section className="grid gap-2 md:grid-cols-4" data-meta-drill-kpis>
        <Kpi label="Decision" value={rec.decision} />
        <Kpi label="Spend" value={spend != null && spend > 0 ? formatMoney(spend, moneyCurrency) : "mixed"} mono />
        <Kpi label="ROAS" value={roas ?? "no ROAS"} mono tone={roasTone} />
        <Kpi label="CPA" value={cpa ?? "no CPA"} mono />
      </section>
      <div style={{ marginTop: 10 }}>
        {rec.metrics?.roas != null ? (
          <MetricRow
            k="ROAS vs target"
            v={targetRoas != null && Number.isFinite(targetRoas) ? `${rec.metrics.roas.toFixed(2)}× vs ${targetRoas.toFixed(2)}×` : `${rec.metrics.roas.toFixed(2)}×`}
            tone={roasTone === "ink" ? "ink" : roasTone}
          />
        ) : null}
        {rec.metrics?.cpa != null ? <MetricRow k="CPA" v={formatMoney(rec.metrics.cpa, moneyCurrency)} /> : null}
        {rec.metrics?.purchases != null ? <MetricRow k="Purchases" v={rec.metrics.purchases.toLocaleString("en-US")} /> : null}
        {rec.metrics?.frequency != null ? (
          <MetricRow k="Frequency" v={rec.metrics.frequency.toFixed(1)} tone={rec.metrics.frequency > 4 ? "warn" : "ink"} />
        ) : null}
      </div>
      {series.length >= 2 ? (
        <div style={{ marginTop: 10 }}>
          <GradientSpark values={series} target={targetRoas} gradientId={gradientId} />
          <div className="mono" style={{ fontSize: 10.5, color: "var(--muted)", marginTop: 2 }}>
            ROAS trend{targetRoas != null && Number.isFinite(targetRoas) ? ` · dashed = ${targetRoas.toFixed(2)}× target` : ""}
          </div>
        </div>
      ) : null}
    </Panel>
  );
}

function Kpi({
  label,
  value,
  mono = false,
  tone = "ink",
}: {
  label: string;
  value: string;
  mono?: boolean;
  tone?: "ink" | "ok" | "danger";
}) {
  const toneColor = tone === "ok" ? "var(--ok)" : tone === "danger" ? "var(--danger)" : "var(--ink)";
  return (
    <div style={{ border: "1px solid var(--border)", borderRadius: "var(--r)", background: "var(--surface)", padding: 10 }}>
      <div className="mono" style={{ fontSize: 10, letterSpacing: "0.04em", color: "var(--muted)", textTransform: "uppercase" }}>
        {label}
      </div>
      <div
        style={{
          marginTop: 3,
          overflow: "hidden",
          textOverflow: "ellipsis",
          whiteSpace: "nowrap",
          fontSize: 13,
          fontWeight: 600,
          color: toneColor,
          fontVariantNumeric: mono ? "tabular-nums" : undefined,
        }}
      >
        {value}
      </div>
    </div>
  );
}

function AdsetDepthTable({ recs, moneyCurrency }: { recs: MetaRecommendation[]; moneyCurrency?: string | null }) {
  const rows = recs.filter((rec) => rec.level === "adset");
  return (
    <Panel data-meta-adset-depth>
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <SectionLabel>Ad set depth</SectionLabel>
        <span
          className="mono"
          style={{ border: "1px solid var(--border-2)", borderRadius: 5, padding: "1px 6px", fontSize: 10.5, color: "var(--muted)" }}
        >
          {rows.length} rows
        </span>
      </div>
      {rows.length > 0 ? (
        <div style={{ overflowX: "auto", borderRadius: "var(--r)", border: "1px solid var(--border)", marginTop: 4 }}>
          <table style={{ minWidth: "100%", textAlign: "left", fontSize: 12, borderCollapse: "collapse" }}>
            <thead>
              <tr className="mono" style={{ background: "var(--surface-2)", color: "var(--muted)", fontSize: 10 }}>
                <th style={{ padding: "6px 10px", fontWeight: 600 }}>Ad set</th>
                <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Spend</th>
                <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>ROAS</th>
                <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>CPA</th>
                <th style={{ padding: "6px 10px", fontWeight: 600, textAlign: "right" }}>Decision</th>
              </tr>
            </thead>
            <tbody>
              {rows.map((row) => (
                <tr key={row.id} style={{ borderTop: "1px solid var(--border)" }}>
                  <td style={{ padding: "6px 10px", maxWidth: 220, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap", fontWeight: 500, color: "var(--ink)" }}>
                    {row.adsetName ?? row.title}
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--ink-2)" }}>
                    {row.metrics?.spend != null ? formatMoney(row.metrics.spend, moneyCurrency) : evidenceAny(row, ["Ad set spend", "Spend"]) ?? "—"}
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--ink-2)" }}>
                    {row.metrics?.roas != null ? `${row.metrics.roas.toFixed(2)}×` : evidenceAny(row, ["Ad set ROAS", "Core ROAS"]) ?? "—"}
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontVariantNumeric: "tabular-nums", color: "var(--ink-2)" }}>
                    {row.metrics?.cpa != null ? formatMoney(row.metrics.cpa, moneyCurrency) : evidenceAny(row, ["Core CPA", "CPA"]) ?? "—"}
                  </td>
                  <td style={{ padding: "6px 10px", textAlign: "right", fontWeight: 500, color: "var(--ink-2)" }}>
                    {primaryLabelForRec(row)}
                  </td>
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      ) : (
        <div style={{ borderRadius: "var(--r-sm)", border: "1px solid var(--border)", background: "var(--surface-2)", padding: "8px 12px", fontSize: 12.5, color: "var(--ink-2)", marginTop: 4 }}>
          No child adset decision rows were persisted for this snapshot.
        </div>
      )}
    </Panel>
  );
}

function useInspectorFocus(open: boolean, onClose: () => void, panelRef: React.RefObject<HTMLElement | null>) {
  useEffect(() => {
    if (!open) return;
    const previouslyFocused = typeof document !== "undefined" ? (document.activeElement as HTMLElement | null) : null;
    const panel = panelRef.current;
    const focusFirst = () => {
      const focusable = panel?.querySelector<HTMLElement>(
        'button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])',
      );
      (focusable ?? panel)?.focus();
    };
    focusFirst();

    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") {
        event.stopPropagation();
        onClose();
        return;
      }
      if (event.key !== "Tab" || !panel) return;
      const focusables = Array.from(
        panel.querySelectorAll<HTMLElement>('button, a[href], input, select, textarea, [tabindex]:not([tabindex="-1"])'),
      ).filter((el) => !el.hasAttribute("disabled"));
      if (focusables.length === 0) return;
      const first = focusables[0];
      const last = focusables[focusables.length - 1];
      const active = document.activeElement as HTMLElement | null;
      if (event.shiftKey && active === first) {
        event.preventDefault();
        last.focus();
      } else if (!event.shiftKey && active === last) {
        event.preventDefault();
        first.focus();
      }
    };
    document.addEventListener("keydown", onKeyDown, true);
    return () => {
      document.removeEventListener("keydown", onKeyDown, true);
      if (previouslyFocused && typeof previouslyFocused.focus === "function") previouslyFocused.focus();
    };
  }, [open, onClose, panelRef]);
}

export function MetaDrillDrawer({
  moneyCurrency,
  targetRoas,
  item,
  variant = "overlay",
  onClose,
  onLaunch,
}: MetaDrillDrawerProps) {
  const panelRef = useRef<HTMLElement | null>(null);
  const gradientId = useId();
  const [jsonOpen, setJsonOpen] = useState(false);
  useInspectorFocus(Boolean(item), onClose, panelRef);

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

  const rawJson =
    item.mode === "decision"
      ? JSON.stringify(
          {
            id: item.rec.id,
            level: item.rec.level,
            decisionLabel: item.rec.decisionLabel ?? null,
            actionKind: item.rec.actionKind ?? null,
            confidenceScore: item.rec.confidenceScore ?? null,
            engineVersion: item.rec.engineVersion ?? null,
            metrics: item.rec.metrics ?? null,
          },
          null,
          2,
        )
      : null;

  const panel = (
    <aside
      ref={panelRef}
      className="meta-inspector"
      data-drawer="meta-drill"
      data-inspector-variant={variant}
      role="dialog"
      aria-modal={variant === "overlay"}
      aria-label={`Evidence · ${title}`}
      tabIndex={-1}
      style={{
        display: "flex",
        flexDirection: "column",
        height: "100%",
        background: "var(--surface)",
        borderLeft: "1px solid var(--border-2)",
      }}
    >
      <div
        style={{
          position: "sticky",
          top: 0,
          zIndex: 1,
          display: "flex",
          alignItems: "flex-start",
          gap: 10,
          borderBottom: "1px solid var(--border)",
          background: "var(--surface)",
          padding: "12px 16px",
        }}
      >
        <div style={{ display: "flex", flexWrap: "wrap", gap: 6, alignItems: "center" }}>
          {isAnomaly ? <MetaScopeChip level="anomaly" label={item.anomaly.scopeType} /> : <MetaScopeChip level={item.rec.level} />}
          {isInformational ? <MetaCohortChip cohort={item.rec.cohort} /> : null}
        </div>
        <div style={{ flex: 1, minWidth: 0, marginLeft: 2 }}>
          <div style={{ fontSize: 15, fontWeight: 650, color: "var(--ink)", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" }}>
            {title}
          </div>
          <div style={{ fontSize: 12, color: "var(--muted)" }}>{subtitle}</div>
        </div>
        <button
          type="button"
          className="btn btn--ghost btn--sm"
          aria-label="Close inspector"
          onClick={onClose}
          style={{ flex: "none", padding: "0 8px" }}
        >
          <X className="inline-block shrink-0" size={16} aria-hidden="true" />
        </button>
      </div>

      <div style={{ flex: 1, overflowY: "auto", padding: "14px 16px", display: "flex", flexDirection: "column", gap: 14 }}>
        {isAnomaly ? (
          <>
            <Panel style={{ borderColor: "var(--warn-bd)", background: "var(--warn-bg)" }}>
              <SectionLabel>Diagnostic</SectionLabel>
              <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)" }}>{item.anomaly.detail}</p>
              <div style={{ display: "grid", gap: 6, marginTop: 8 }}>
                {(item.anomaly.diagnosticLadder && item.anomaly.diagnosticLadder.length > 0
                  ? item.anomaly.diagnosticLadder.map((step) => `${step.step}. ${step.label}: ${step.detail}`)
                  : item.anomaly.diagnostics
                ).map((diagnostic) => (
                  <div
                    key={diagnostic}
                    style={{ border: "1px solid var(--border)", borderRadius: "var(--r-sm)", background: "var(--surface)", padding: "6px 10px", fontSize: 12.5, color: "var(--ink-2)" }}
                  >
                    {diagnostic}
                  </div>
                ))}
              </div>
            </Panel>
            <Panel>
              <SectionLabel>Recent status</SectionLabel>
              <div style={{ display: "flex", alignItems: "center", gap: 6, fontSize: 12.5, color: "var(--muted)" }}>
                <Clock className="inline-block shrink-0" size={13} aria-hidden="true" />
                Detected at {item.anomaly.detectedAt}
              </div>
            </Panel>
          </>
        ) : isInformational ? (
          <Panel>
            <SectionLabel>Brand KPIs</SectionLabel>
            <p style={{ fontSize: 13, lineHeight: 1.55, color: "var(--ink-2)" }}>
              Upper-funnel delivery is shown for visibility only and is not evaluated as a purchase decision.
            </p>
            <div style={{ marginTop: 12 }}>
              <UpperFunnelKpiGrid metrics={upperFunnelMetricsForRec(item.rec)} />
            </div>
          </Panel>
        ) : (
          <>
            {/* 1 · Decision contract */}
            <Panel>
              <SectionLabel>Decision contract</SectionLabel>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 650, color: "var(--ink)" }}>{decisionLabelForRec(item.rec)}</span>
                {item.rec.actionKind ? (
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px" }}>
                    {item.rec.actionKind}
                  </span>
                ) : null}
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{item.rec.engineVersion ?? "meta engine"}</span>
              </div>
              <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 5 }}>
                state <b style={{ fontWeight: 600 }}>{item.rec.decisionState}</b> · primary action: {primaryLabelForRec(item.rec)}
              </div>
            </Panel>

            {/* 2 · Why */}
            <Panel>
              <SectionLabel>Engine reasoning</SectionLabel>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>{item.rec.why}</p>
              <p style={{ marginTop: 8, borderRadius: "var(--r-sm)", background: "var(--surface-2)", padding: "8px 10px", fontSize: 12.5, color: "var(--ink-2)" }}>
                {item.rec.recommendedAction}
              </p>
            </Panel>

            {/* 3 · Money impact & metrics vs target + gradient spark */}
            <DecisionKpis rec={item.rec} relatedRecs={relatedRecs} moneyCurrency={moneyCurrency} targetRoas={targetRoas} gradientId={gradientId} />

            {/* 4 · Confidence + cap  ·  5 · Automation readiness */}
            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Panel>
                <SectionLabel>Evidence confidence</SectionLabel>
                <div style={{ fontSize: 22, fontWeight: 650, color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
                  {confidencePercent(item.rec)}%
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {item.rec.confidence} band{item.rec.confidenceScore != null ? ` · ${item.rec.confidenceScore.toFixed(2)}` : ""}
                </div>
                {signalCapText(item.rec) ? (
                  <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 6 }}>cap: {signalCapText(item.rec)}</div>
                ) : null}
              </Panel>
              <Panel>
                <SectionLabel>Automation readiness</SectionLabel>
                <span
                  style={{
                    display: "inline-flex",
                    alignItems: "center",
                    gap: 5,
                    border: "1px solid var(--border-2)",
                    borderRadius: "var(--r-sm)",
                    padding: "2px 8px",
                    fontSize: 11.5,
                    fontWeight: 600,
                    color: "var(--ink-2)",
                  }}
                >
                  {automationTierLabel(item.rec.automationReadiness?.tier)}
                </span>
                {item.rec.automationReadiness?.reason ? (
                  <div style={{ fontSize: 11.5, color: "var(--ink-2)", marginTop: 6, lineHeight: 1.5 }}>
                    {item.rec.automationReadiness.reason}
                  </div>
                ) : null}
              </Panel>
            </div>

            {/* 6 · Blockers */}
            {item.rec.automationReadiness?.blockers && item.rec.automationReadiness.blockers.length > 0 ? (
              <Panel style={{ borderColor: "var(--warn-bd)", background: "var(--warn-bg)" }}>
                <SectionLabel>Blockers</SectionLabel>
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--warn)" }}>
                  {item.rec.automationReadiness.blockers.map((blocker) => (
                    <li key={blocker}>{blocker.replace(/_/g, " ")}</li>
                  ))}
                </ul>
              </Panel>
            ) : null}

            {/* 7 · Ad set depth */}
            {item.rec.level === "campaign" || relatedRecs.length > 0 ? (
              <AdsetDepthTable recs={relatedRecs} moneyCurrency={moneyCurrency} />
            ) : null}

            {/* 8 · Evidence */}
            <MetaEvidenceAccordion rec={item.rec} />

            {/* 9 · Provenance */}
            <Panel>
              <SectionLabel>Provenance</SectionLabel>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
                engine {item.rec.engineVersion ?? "—"}
                {calibrationScopeText(item.rec) ? <><br />calibration: {calibrationScopeText(item.rec)}</> : null}
                {signalCapText(item.rec) ? <><br />signal cap: {signalCapText(item.rec)}</> : null}
              </div>
              {rawJson ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm mono"
                    style={{ marginTop: 8 }}
                    aria-expanded={jsonOpen}
                    onClick={() => setJsonOpen((open) => !open)}
                  >
                    {jsonOpen ? "▾" : "▸"} raw decision JSON
                  </button>
                  {jsonOpen ? (
                    <pre
                      className="mono"
                      style={{
                        margin: "6px 0 0",
                        background: "var(--surface-2)",
                        border: "1px solid var(--border)",
                        borderRadius: "var(--r-sm)",
                        padding: 10,
                        fontSize: 11,
                        color: "var(--ink-2)",
                        overflowX: "auto",
                        whiteSpace: "pre-wrap",
                      }}
                    >
                      {rawJson}
                    </pre>
                  ) : null}
                </>
              ) : null}
            </Panel>
          </>
        )}
      </div>

      <div
        style={{
          flex: "none",
          borderTop: "1px solid var(--border)",
          background: "var(--surface)",
          padding: "10px 16px",
          display: "flex",
          alignItems: "center",
          gap: 8,
        }}
      >
        <button type="button" className="btn btn--sm" onClick={onClose}>
          Close
        </button>
        {item.mode === "decision" && onLaunch ? (
          <button type="button" className="btn btn--primary btn--sm" onClick={onLaunch}>
            Launchpad bridge
            <ExternalLink className="inline-block shrink-0" size={13} aria-hidden="true" />
          </button>
        ) : isAnomaly ? (
          <span style={{ display: "inline-flex", alignItems: "center", gap: 4, fontSize: 12, color: "var(--muted)" }}>
            Diagnose first
            <ArrowRight className="inline-block shrink-0" size={12} aria-hidden="true" />
          </span>
        ) : isInformational ? (
          <span style={{ fontSize: 12, color: "var(--muted)" }}>Read-only brand metrics</span>
        ) : null}
      </div>
    </aside>
  );

  if (variant === "push") {
    return panel;
  }

  return (
    <div className="fixed inset-0 z-50 flex justify-end">
      <button type="button" aria-label="Close inspector" onClick={onClose} style={{ position: "absolute", inset: 0, background: "rgba(16,18,22,0.32)" }} />
      <div style={{ position: "relative", width: 480, maxWidth: "94vw", height: "100%", boxShadow: "var(--shadow-xl)" }}>{panel}</div>
    </div>
  );
}
