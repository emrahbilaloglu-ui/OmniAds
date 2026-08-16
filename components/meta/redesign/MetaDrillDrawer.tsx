"use client";

import { useEffect, useId, useRef, useState } from "react";
import { ArrowRight, Clock, ExternalLink, X } from "lucide-react";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type { MetaEmpiricalOutcomeSummary } from "@/lib/meta/empirical-outcomes";
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

function confidenceBandLabel(confidence: MetaRecommendation["confidence"]) {
  if (confidence === "high") return "High";
  if (confidence === "medium") return "Medium";
  return "Low";
}

function confidenceScoreDisplay(rec: MetaRecommendation) {
  const score = rec.confidenceScore;
  const band = confidenceBandLabel(rec.confidence);
  if (score == null) {
    return {
      headline: `${band} band`,
      detail: "Numeric confidence score not served.",
    };
  }
  if (!Number.isFinite(score) || score < 0 || score > 1) {
    return {
      headline: `${band} band`,
      detail: `Server score outside expected 0-1 range: ${String(score)}`,
    };
  }
  return {
    headline: `${Math.round(score * 100)}%`,
    detail: `${band} band · server score ${score.toFixed(2)}`,
  };
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

function SectionLabel({ number, children }: { number?: string; children: React.ReactNode }) {
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
      {number ? <span style={{ color: "var(--ink)", marginRight: 4 }}>{number} ·</span> : null}
      {children}
    </div>
  );
}

function Panel({
  children,
  style,
  section,
}: {
  children: React.ReactNode;
  style?: React.CSSProperties;
  section?: string;
}) {
  return (
    <section
      data-inspector-section={section}
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

function MissingState({ children = "Not captured in the served decision row." }: { children?: React.ReactNode }) {
  return (
    <div
      style={{
        border: "1px dashed var(--border-2)",
        borderRadius: "var(--r-sm)",
        background: "var(--surface-2)",
        padding: "8px 10px",
        fontSize: 12,
        lineHeight: 1.5,
        color: "var(--muted)",
      }}
    >
      {children}
    </div>
  );
}

function FieldRow({ label, value }: { label: string; value: React.ReactNode }) {
  return (
    <div
      style={{
        display: "grid",
        gridTemplateColumns: "minmax(92px, 0.42fr) minmax(0, 1fr)",
        gap: 10,
        borderTop: "1px solid var(--border)",
        padding: "6px 0",
        fontSize: 12,
      }}
    >
      <span className="mono" style={{ color: "var(--muted)", fontSize: 10.5, textTransform: "uppercase" }}>
        {label}
      </span>
      <span style={{ minWidth: 0, color: "var(--ink-2)", overflowWrap: "anywhere" }}>{value}</span>
    </div>
  );
}

function EvidenceCitationChips({ rec }: { rec: MetaRecommendation }) {
  if (rec.evidence.length === 0) return <MissingState>No cited evidence rows were persisted with this recommendation.</MissingState>;
  return (
    <div style={{ display: "flex", flexWrap: "wrap", gap: 6, marginTop: 8 }}>
      {rec.evidence.slice(0, 6).map((evidence, index) => (
        <span
          key={`${evidence.label}-${evidence.value}-${index}`}
          className="mono"
          style={{
            display: "inline-flex",
            alignItems: "center",
            gap: 4,
            border: "1px solid var(--info-bd)",
            borderRadius: 5,
            background: "var(--info-bg)",
            padding: "2px 6px",
            color: "var(--info-fg)",
            fontSize: 10.5,
          }}
          title={`${evidence.label}: ${evidence.value}`}
        >
          [{index + 1}] {evidence.label}
        </span>
      ))}
    </div>
  );
}

function formatNullableDate(value: string | null | undefined) {
  if (!value) return "—";
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return value;
  return parsed.toISOString().replace("T", " ").slice(0, 16);
}

function changeSummary(change: NonNullable<MetaRecommendation["evidenceTrail"]>["recent_changes"][number]) {
  const type = change.type.replace(/_/g, " ");
  const when = formatNullableDate(change.applied_at);
  return `${type} · ${when}`;
}

/** Pretty-print a recent-change payload. Surfaces the two known keys (bid
 * amount, status); anything else falls back to a compact JSON string. Returns
 * null when the payload carries nothing to show, so the caller can omit it. */
function formatChangeValue(value: unknown): string | null {
  if (value == null) return null;
  if (typeof value === "string") return value.trim() || null;
  if (typeof value === "number" || typeof value === "boolean") return String(value);
  if (typeof value !== "object") return String(value);

  const record = value as Record<string, unknown>;
  const parts: string[] = [];

  const rawBid = record.bid_amount ?? record.bidAmount ?? record.amount;
  if (typeof rawBid === "number" && Number.isFinite(rawBid)) {
    parts.push(`bid amount ${rawBid.toLocaleString("en-US")}`);
  } else if (typeof rawBid === "string" && rawBid.trim()) {
    parts.push(`bid amount ${rawBid.trim()}`);
  }

  const rawStatus = record.status ?? record.effective_status;
  if (typeof rawStatus === "string" && rawStatus.trim()) {
    parts.push(`status ${rawStatus.trim()}`);
  }

  if (parts.length > 0) return parts.join(" · ");

  const json = JSON.stringify(value);
  if (!json || json === "{}") return null;
  return json.length > 80 ? `${json.slice(0, 79)}…` : json;
}

function peerDistributionText(peer: NonNullable<MetaRecommendation["evidenceTrail"]>["peer_comparison"]) {
  return `${peer.this_value.toFixed(2)}x vs p10 ${peer.p10.toFixed(2)} / p50 ${peer.p50.toFixed(2)} / p90 ${peer.p90.toFixed(2)}`;
}

/** Readable render of the persisted empirical-outcome summary. Never invents a
 * value: precision/negativeRate collapse to "—" when the server sent null. */
function PrecedentSummary({ summary }: { summary: MetaEmpiricalOutcomeSummary }) {
  const precision = summary.precision != null ? `${(summary.precision * 100).toFixed(0)}%` : "—";
  const negativeRate = summary.negativeRate != null ? `${(summary.negativeRate * 100).toFixed(0)}%` : "—";
  const sample = `${summary.judgedSampleSize} judged / ${summary.sampleSize} total`;
  return (
    <div>
      <FieldRow label="precision" value={precision} />
      <FieldRow label="negative rate" value={negativeRate} />
      <FieldRow label="sample" value={sample} />
      <FieldRow label="confidence band" value={summary.confidenceBand} />
      <FieldRow
        label="outcomes"
        value={
          <span className="mono" style={{ fontVariantNumeric: "tabular-nums" }}>
            {summary.positiveCount} positive · {summary.negativeCount} negative · {summary.neutralCount} neutral ·{" "}
            {summary.unknownCount} unknown
          </span>
        }
      />
      <FieldRow label="auto eligible" value={summary.autoEligible ? "yes" : "no"} />
    </div>
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

function configuredBidDisplay(
  value: number | null | undefined,
  format: "currency" | "roas" | null | undefined,
  currency: string | null | undefined,
) {
  if (value == null || !Number.isFinite(value)) return "—";
  return format === "roas"
    ? `${value.toFixed(2)}×`
    : formatMoney(value / 100, currency);
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
    <Panel section="money-impact" style={{ background: "var(--surface-2)" }}>
      <SectionLabel number="3">Money impact &amp; metrics</SectionLabel>
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
    <Panel section="adset-depth">
      <div style={{ display: "flex", alignItems: "center", justifyContent: "space-between", gap: 12 }}>
        <SectionLabel number="9">Ad set depth</SectionLabel>
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
  const confidenceDisplay = item.mode === "decision" ? confidenceScoreDisplay(item.rec) : null;

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
            <Panel section="decision-contract">
              <SectionLabel number="1">Decision contract</SectionLabel>
              <div style={{ display: "flex", alignItems: "center", flexWrap: "wrap", gap: 8 }}>
                <span style={{ fontSize: 15, fontWeight: 650, color: "var(--ink)" }}>{decisionLabelForRec(item.rec)}</span>
                {item.rec.actionKind ? (
                  <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)", border: "1px solid var(--border)", borderRadius: 4, padding: "1px 6px" }}>
                    {item.rec.actionKind}
                  </span>
                ) : null}
                <span className="mono" style={{ fontSize: 10.5, color: "var(--muted)" }}>{item.rec.engineVersion ?? "meta engine"}</span>
              </div>
              <div style={{ marginTop: 8 }}>
                <FieldRow label="published" value={decisionLabelForRec(item.rec)} />
                <FieldRow label="raw label" value={item.rec.decisionLabel ?? "—"} />
                <FieldRow label="state" value={item.rec.decisionState} />
                <FieldRow label="primary action" value={primaryLabelForRec(item.rec)} />
                <FieldRow
                  label="hysteresis"
                  value={
                    item.rec.labelTransform
                      ? `${item.rec.labelTransform.fromDecisionLabel ?? "raw"} → ${item.rec.labelTransform.toDecisionLabel} · ${item.rec.labelTransform.reason}`
                      : "No label transform persisted"
                  }
                />
              </div>
            </Panel>

            <Panel section="why">
              <SectionLabel number="2">WHY · engine reasoning</SectionLabel>
              <p style={{ fontSize: 13, lineHeight: 1.6, color: "var(--ink-2)" }}>{item.rec.why}</p>
              <p style={{ marginTop: 8, borderRadius: "var(--r-sm)", background: "var(--surface-2)", padding: "8px 10px", fontSize: 12.5, color: "var(--ink-2)" }}>
                {item.rec.recommendedAction}
              </p>
              <EvidenceCitationChips rec={item.rec} />
            </Panel>

            {item.rec.entityConfiguration ? (
              <Panel section="entity-configuration">
                <SectionLabel>Provider configuration</SectionLabel>
                <FieldRow
                  label="status"
                  value={item.rec.entityConfiguration.status ?? "—"}
                />
                <FieldRow
                  label="optimization"
                  value={item.rec.entityConfiguration.optimizationGoal ?? "—"}
                />
                <FieldRow
                  label="bid strategy"
                  value={
                    item.rec.entityConfiguration.bidStrategyLabel ??
                    item.rec.entityConfiguration.bidStrategyType ??
                    "—"
                  }
                />
                <FieldRow
                  label="current bid"
                  value={configuredBidDisplay(
                    item.rec.entityConfiguration.bidValue,
                    item.rec.entityConfiguration.bidValueFormat,
                    moneyCurrency,
                  )}
                />
                <FieldRow
                  label="previous bid"
                  value={`${configuredBidDisplay(
                    item.rec.entityConfiguration.previousBidValue,
                    item.rec.entityConfiguration.previousBidValueFormat,
                    moneyCurrency,
                  )}${
                    item.rec.entityConfiguration.previousBidValueCapturedAt
                      ? ` · ${item.rec.entityConfiguration.previousBidValueCapturedAt.slice(0, 10)}`
                      : ""
                  }`}
                />
                <FieldRow
                  label="budget utilization"
                  value={
                    item.rec.entityConfiguration.budgetUtilization == null
                      ? "—"
                      : `${Math.round(item.rec.entityConfiguration.budgetUtilization * 100)}%`
                  }
                />
              </Panel>
            ) : null}

            <DecisionKpis rec={item.rec} relatedRecs={relatedRecs} moneyCurrency={moneyCurrency} targetRoas={targetRoas} gradientId={gradientId} />

            <Panel section="precedent">
              <SectionLabel number="4">Precedent</SectionLabel>
              {item.rec.empiricalOutcomeSummary ? (
                <PrecedentSummary summary={item.rec.empiricalOutcomeSummary} />
              ) : (
                <MissingState>No judged precedent window is persisted for this recommendation.</MissingState>
              )}
              {item.rec.evidenceTrail?.peer_comparison ? (
                <div style={{ marginTop: 4 }}>
                  <FieldRow label="peer distribution" value={peerDistributionText(item.rec.evidenceTrail.peer_comparison)} />
                </div>
              ) : null}
            </Panel>

            <div style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 12 }}>
              <Panel section="confidence">
                <SectionLabel number="5">Confidence</SectionLabel>
                <div style={{ fontSize: 22, fontWeight: 650, color: "var(--ink)", fontVariantNumeric: "tabular-nums" }}>
                  {confidenceDisplay?.headline}
                </div>
                <div style={{ fontSize: 11.5, color: "var(--muted)" }}>
                  {confidenceDisplay?.detail}
                </div>
                {signalCapText(item.rec) ? (
                  <div style={{ fontSize: 11.5, color: "var(--warn)", marginTop: 6 }}>cap: {signalCapText(item.rec)}</div>
                ) : null}
              </Panel>
              <Panel section="automation-readiness">
                <SectionLabel number="6">Automation readiness</SectionLabel>
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

            <Panel
              section="blockers"
              style={
                item.rec.automationReadiness?.blockers && item.rec.automationReadiness.blockers.length > 0
                  ? { borderColor: "var(--warn-bd)", background: "var(--warn-bg)" }
                  : undefined
              }
            >
              <SectionLabel number="7">Blockers</SectionLabel>
              {item.rec.automationReadiness?.blockers && item.rec.automationReadiness.blockers.length > 0 ? (
                <ul style={{ margin: 0, paddingLeft: 16, fontSize: 12, color: "var(--warn)" }}>
                  {item.rec.automationReadiness.blockers.map((blocker) => (
                    <li key={blocker}>{blocker.replace(/_/g, " ")}</li>
                  ))}
                </ul>
              ) : (
                <MissingState>No automation blockers were persisted on this recommendation.</MissingState>
              )}
            </Panel>

            <Panel section="maturity">
              <SectionLabel number="8">Maturity</SectionLabel>
              <FieldRow label="age" value={item.rec.evidenceTrail?.age_days != null ? `${item.rec.evidenceTrail.age_days}d evidence age` : "—"} />
              <FieldRow label="regime" value={item.rec.evidenceTrail?.regime_stability != null ? `${Math.round(item.rec.evidenceTrail.regime_stability * 100)}% stable` : "—"} />
              <FieldRow label="timeframe" value={item.rec.timeframeContext.coreVerdict} />
              <FieldRow label="history" value={item.rec.timeframeContext.historicalSupport} />
            </Panel>

            <AdsetDepthTable recs={relatedRecs} moneyCurrency={moneyCurrency} />

            <Panel section="creative-evidence">
              <SectionLabel number="10">Creative evidence</SectionLabel>
              {item.rec.promoteCreatives?.length || item.rec.keepTestingCreatives?.length || item.rec.doNotDeployCreatives?.length ? (
                <div style={{ display: "grid", gap: 6, marginBottom: 10 }}>
                  {item.rec.promoteCreatives?.length ? <FieldRow label="promote" value={item.rec.promoteCreatives.join(", ")} /> : null}
                  {item.rec.keepTestingCreatives?.length ? <FieldRow label="keep testing" value={item.rec.keepTestingCreatives.join(", ")} /> : null}
                  {item.rec.doNotDeployCreatives?.length ? <FieldRow label="avoid" value={item.rec.doNotDeployCreatives.join(", ")} /> : null}
                </div>
              ) : (
                <MissingState>Creative-level quartiles/thumbstop fields are not persisted on this decision row.</MissingState>
              )}
              <div style={{ marginTop: 10 }}>
                <MetaEvidenceAccordion rec={item.rec} />
              </div>
            </Panel>

            <Panel section="timeline">
              <SectionLabel number="11">Entity timeline</SectionLabel>
              {item.rec.evidenceTrail?.recent_changes && item.rec.evidenceTrail.recent_changes.length > 0 ? (
                <div style={{ display: "grid", gap: 6 }}>
                  {item.rec.evidenceTrail.recent_changes.slice(0, 6).map((change, index) => {
                    const formattedValue = formatChangeValue(change.value);
                    return (
                      <div key={`${change.type}-${change.applied_at}-${index}`} style={{ borderTop: index === 0 ? 0 : "1px solid var(--border)", paddingTop: index === 0 ? 0 : 6 }}>
                        <div className="mono" style={{ fontSize: 11, color: "var(--ink)" }}>{changeSummary(change)}</div>
                        {formattedValue ? (
                          <div style={{ fontSize: 12, color: "var(--muted)", overflowWrap: "anywhere" }}>{formattedValue}</div>
                        ) : null}
                      </div>
                    );
                  })}
                </div>
              ) : item.rec.operatorResponseAt ? (
                <FieldRow label="operator" value={`${item.rec.operatorResponseState ?? "response"} · ${formatNullableDate(item.rec.operatorResponseAt)}`} />
              ) : (
                <MissingState>No entity timeline or recent-change rows are persisted for this recommendation.</MissingState>
              )}
            </Panel>

            <Panel section="notes-protection">
              <SectionLabel number="12">Notes &amp; protection</SectionLabel>
              <FieldRow label="operator" value={item.rec.operatorResponseState ? `${item.rec.operatorResponseState}${item.rec.operatorResponseSubtype ? ` · ${item.rec.operatorResponseSubtype}` : ""}` : "—"} />
              <FieldRow label="response at" value={formatNullableDate(item.rec.operatorResponseAt)} />
              <FieldRow label="protection" value={item.rec.automationReadiness?.operatorReviewRequired ? "operator review required" : "No protection note persisted"} />
            </Panel>

            <Panel section="provenance">
              <SectionLabel number="13">Provenance</SectionLabel>
              <div className="mono" style={{ fontSize: 11, color: "var(--ink-2)", lineHeight: 1.8 }}>
                engine {item.rec.engineVersion ?? "—"}
                {calibrationScopeText(item.rec) ? <><br />calibration: {calibrationScopeText(item.rec)}</> : null}
                {signalCapText(item.rec) ? <><br />signal cap: {signalCapText(item.rec)}</> : null}
                {item.rec.campaignRole ? <><br />campaign role: {item.rec.campaignRole}</> : null}
                {item.rec.bidRegime ? <><br />bid regime: {item.rec.bidRegime}</> : null}
              </div>
            </Panel>

            <Panel section="raw-json">
              <SectionLabel number="14">Raw JSON</SectionLabel>
              {rawJson ? (
                <>
                  <button
                    type="button"
                    className="btn btn--ghost btn--sm mono"
                    style={{ marginTop: 2 }}
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
              ) : (
                <MissingState>Raw decision JSON is unavailable for this inspector mode.</MissingState>
              )}
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
