"use client";

import { useState } from "react";
import { ArrowRight, Copy, MoreHorizontal, Pause, Play, Sliders, ExternalLink } from "lucide-react";
import { DeferChip, DeferTooltip } from "@/components/common/briefing";
import { cn } from "@/lib/utils";
import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import {
  decisionLabelForRec,
  launchModeForRec,
  primaryLabelForRec,
  proposedBidMinorForExecute,
  scopeIdForRec,
  scopeNameForRec,
  formatMoney,
} from "@/components/meta/redesign/meta-card-utils";

interface MetaActionCardProps {
  moneyCurrency?: string | null;
  /** Server pulse target ROAS for this business — a ratio, currency-agnostic.
   * Used only to state ROAS-vs-target on the money line; never a projection. */
  targetRoas?: number | null;
  /** Real Ads Manager permalink when the parent can build one; the item is
   * hidden otherwise (no fabricated deep links). */
  adsManagerHref?: string | null;
  rec?: MetaRecommendation;
  anomaly?: MetaAnomaly;
  selected?: boolean;
  deferred?: boolean;
  responseState?: "acted" | "deferred" | "ignored" | null;
  primaryPending?: boolean;
  actionFeedback?: { tone: "success" | "error" | "info"; title: string; detail?: string | null } | null;
  /** Accepted for call-site compatibility; the row no longer surfaces the
   * window inline (secondary metrics live in the evidence inspector). */
  evidenceWindow?: string;
  onSelect?: (id: string, selected: boolean) => void;
  onPrimary?: (rec: MetaRecommendation) => void;
  onResume?: (rec: MetaRecommendation) => void;
  onOpenDrill?: (item: MetaRecommendation | MetaAnomaly) => void;
  onDefer?: (rec: MetaRecommendation) => void;
  onUndoDefer?: (rec: MetaRecommendation) => void;
  onCompare?: (rec: MetaRecommendation) => void;
}

type Tone = "danger" | "warn" | "ok" | "info" | "ink" | "muted";

const TONE_INK: Record<Tone, string> = {
  danger: "var(--danger)",
  warn: "var(--warn)",
  ok: "var(--ok)",
  info: "var(--brand)",
  ink: "var(--ink)",
  muted: "var(--muted)",
};

function confidencePercent(rec: MetaRecommendation) {
  return Math.round(
    (rec.confidenceScore ?? (rec.confidence === "high" ? 0.8 : rec.confidence === "medium" ? 0.62 : 0.42)) * 100,
  );
}

function confidenceBand(rec: MetaRecommendation): { label: string; level: 1 | 2 | 3 } {
  if (rec.confidence === "high") return { label: "High", level: 3 };
  if (rec.confidence === "medium") return { label: "Medium", level: 2 };
  return { label: "Low", level: 1 };
}

function compactLabel(value: string) {
  return value.replace(/[_-]+/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
}

// Styling a server-provided decision label with a tone is presentation only;
// the label itself is decided server-side (rec.decisionLabel via
// rec-presentation.ts). This never derives the decision from type/text.
function decisionLabelTone(label: string): Tone {
  if (label === "cut" || label === "below_breakeven") return "danger";
  if (label === "scale" || label === "keep") return "ok";
  if (["test_more", "refresh", "review_adsets", "review_placements", "learning"].includes(label)) return "warn";
  if (label === "tune" || label === "switch" || label === "swap") return "info";
  return "ink";
}

function decisionLabelText(label: string) {
  if (label === "below_breakeven") return "Cut candidate";
  if (label === "test_more") return "Fresh test";
  if (label === "review_adsets") return "Review ad sets";
  if (label === "review_placements") return "Review placements";
  return label.replace(/_/g, " ").replace(/\b\w/g, (char) => char.toUpperCase());
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

function automationReadinessText(rec: MetaRecommendation) {
  const readiness = rec.automationReadiness;
  if (!readiness) return null;
  if (readiness.tier === "auto_execute") return "Auto-ready";
  if (readiness.tier === "backtest_candidate") return "Backtest needed";
  if (readiness.tier === "manual_review") return "Manual review";
  return "Read-only";
}

function PrimaryIcon({ rec }: { rec: MetaRecommendation }) {
  if (rec.type === "adset_cut_spend") return <Pause className="inline-block shrink-0" size={13} aria-hidden="true" />;
  if (rec.type === "bid_strategy_fit" || rec.type === "bid_value_guidance" || rec.type === "bid_band_from_history") {
    return <Sliders className="inline-block shrink-0" size={13} aria-hidden="true" />;
  }
  return <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />;
}

/**
 * Money at stake, stated from server-structured metrics only (spend + ROAS vs
 * the pulse target). Currency-aware for spend; ROAS is a ratio. No projected
 * or invented figures — missing renders as an em dash, never a guess.
 */
function moneyAtStake(
  rec: MetaRecommendation,
  targetRoas: number | null | undefined,
  currency: string | null | undefined,
): { text: string; tone: Tone; hasMetric: boolean } {
  const spend = rec.metrics?.spend;
  const roas = rec.metrics?.roas;
  const hasSpend = typeof spend === "number" && Number.isFinite(spend);
  const hasRoas = typeof roas === "number" && Number.isFinite(roas);
  if (!hasSpend && !hasRoas) return { text: "—", tone: "muted", hasMetric: false };

  const parts: string[] = [];
  if (hasSpend) parts.push(formatMoney(spend as number, currency));
  let tone: Tone = "ink";
  if (hasRoas) {
    const roasText = `${(roas as number).toFixed(2)}×`;
    if (typeof targetRoas === "number" && Number.isFinite(targetRoas)) {
      parts.push(`${roasText} vs ${targetRoas.toFixed(2)}× target`);
      tone = (roas as number) >= targetRoas ? "ok" : "danger";
    } else {
      parts.push(roasText);
    }
  }
  return { text: parts.join(" · "), tone, hasMetric: true };
}

function ConfidenceBandPill({ rec }: { rec: MetaRecommendation }) {
  const band = confidenceBand(rec);
  const score = rec.confidenceScore;
  const bars = [4, 7, 10];
  return (
    <span
      data-confidence-band={band.label.toLowerCase()}
      aria-label={`Evidence confidence ${band.label}${score != null ? ` ${score.toFixed(2)}` : ""}`}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 5,
        border: "1px solid var(--border-2)",
        borderRadius: 999,
        padding: "2px 9px",
        fontSize: 11,
        fontWeight: 600,
        fontVariantNumeric: "tabular-nums",
        color: "var(--ink-2)",
        background: "var(--surface)",
        whiteSpace: "nowrap",
      }}
    >
      <span style={{ display: "inline-flex", alignItems: "flex-end", gap: 1.5 }} aria-hidden="true">
        {bars.map((h, i) => (
          <span
            key={h}
            style={{
              width: 3,
              height: h,
              borderRadius: 1,
              background: i < band.level ? "var(--ink-2)" : "var(--border-2)",
            }}
          />
        ))}
      </span>
      {band.label}
      {score != null ? <span style={{ color: "var(--muted)", fontWeight: 500 }}>{score.toFixed(2)}</span> : null}
    </span>
  );
}

function QuietChip({
  children,
  tone = "muted",
  cohort,
}: {
  children: React.ReactNode;
  tone?: Tone;
  cohort?: string;
}) {
  return (
    <span
      data-cohort-chip={cohort}
      style={{
        display: "inline-flex",
        alignItems: "center",
        gap: 4,
        border: "1px solid var(--border-2)",
        borderRadius: 6,
        padding: "1px 7px",
        fontSize: 11,
        color: tone === "muted" ? "var(--muted)" : TONE_INK[tone],
        background: "var(--surface)",
        whiteSpace: "nowrap",
      }}
    >
      {children}
    </span>
  );
}

export function MetaActionCard({
  moneyCurrency,
  targetRoas,
  adsManagerHref,
  rec,
  anomaly,
  selected = false,
  deferred = false,
  responseState = null,
  primaryPending = false,
  actionFeedback = null,
  onSelect,
  onPrimary,
  onResume,
  onOpenDrill,
  onDefer,
  onUndoDefer,
  onCompare,
}: MetaActionCardProps) {
  const [menuOpen, setMenuOpen] = useState(false);

  if (anomaly) {
    return (
      <article className="meta-row" data-card="anomaly" data-anomaly-id={anomaly.id}>
        <div className="meta-row__lead" aria-hidden="true">
          <span className="meta-row__glyph meta-row__glyph--anomaly" />
        </div>
        <div
          className="meta-row__open"
          role="button"
          tabIndex={0}
          onClick={() => onOpenDrill?.(anomaly)}
          onKeyDown={(event) => {
            if (event.key === "Enter" || event.key === " ") {
              event.preventDefault();
              onOpenDrill?.(anomaly);
            }
          }}
        >
          <div className="meta-row__name-line">
            <span className="meta-row__name">{anomaly.title}</span>
            <QuietChip tone="warn">{anomaly.scopeType}</QuietChip>
          </div>
          <div className="meta-row__sub">
            <span style={{ color: "var(--warn)", fontWeight: 600 }}>Anomaly · diagnose first</span>
            <span className="meta-row__stake meta-row__stake--muted">
              {anomaly.scopeLabel} · severity {anomaly.severity}
            </span>
          </div>
        </div>
        <div className="meta-row__actions">
          <button
            type="button"
            className="btn btn--primary"
            onClick={(event) => {
              event.stopPropagation();
              onOpenDrill?.(anomaly);
            }}
          >
            Open diagnostic
            <ArrowRight className="inline-block shrink-0" size={13} aria-hidden="true" />
          </button>
        </div>
        {anomaly.diagnosticLadder?.length ? (
          <div className="meta-row__ladder" data-anomaly-ladder>
            {anomaly.diagnosticLadder.slice(0, 3).map((step) => (
              <span key={`${anomaly.id}-${step.step}`} title={step.detail}>
                {step.label}
                <small>{step.detail}</small>
              </span>
            ))}
          </div>
        ) : null}
      </article>
    );
  }

  if (!rec) return null;

  const id = rec.id;
  const label = decisionLabelForRec(rec);
  const labelTone = decisionLabelTone(label);
  const scopeName = scopeNameForRec(rec);
  const effectiveResponseState = responseState ?? (deferred ? "deferred" : null);
  const automationReadiness = automationReadinessText(rec);
  const stake = moneyAtStake(rec, targetRoas, moneyCurrency);

  const chips: Array<{ key: string; text: string; tone?: Tone; cohort?: string }> = [];
  if (rec.campaignRole) chips.push({ key: "role", text: compactLabel(rec.campaignRole) });
  if (rec.bidRegime) chips.push({ key: "bid", text: compactLabel(rec.bidRegime), tone: "warn" });
  if (rec.cohort && rec.cohort !== "purchase") {
    chips.push({ key: "cohort", text: compactLabel(rec.cohort), cohort: rec.cohort });
  }
  const visibleChips = chips.slice(0, 3);
  const overflowChips = chips.length - visibleChips.length;

  const watchPrimaryDefers =
    rec.decisionState === "watch" && Boolean(onDefer) && effectiveResponseState !== "deferred";
  const primaryActionLabel = watchPrimaryDefers ? "Let cook" : primaryLabelForRec(rec);
  const primaryCompleted = effectiveResponseState === "acted";
  const primaryCanResume = Boolean(onResume) && canResumeCompletedPrimary(rec, primaryCompleted);
  const primaryDisabledForContract =
    launchModeForRec(rec) === "apply_bid" && proposedBidMinorForExecute(rec) == null;

  const openDrill = () => onOpenDrill?.(rec);
  const copyEntityId = () => {
    setMenuOpen(false);
    if (typeof navigator !== "undefined" && navigator.clipboard) {
      void navigator.clipboard.writeText(scopeIdForRec(rec));
    }
  };

  return (
    <article
      className={cn("meta-row", selected ? "meta-row--selected" : "", deferred ? "meta-row--deferred" : "")}
      data-card="meta-action"
      data-rec-id={id}
    >
      {onSelect ? (
        <label className="meta-row__lead">
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
        <div className="meta-row__lead" aria-hidden="true">
          <span className="meta-row__glyph" data-decision-tone={labelTone} style={{ background: TONE_INK[labelTone] }} />
        </div>
      )}

      <div
        className="meta-row__open"
        role="button"
        tabIndex={0}
        aria-label={`Open evidence for ${scopeName}`}
        onClick={openDrill}
        onKeyDown={(event) => {
          if (event.key === "Enter" || event.key === " ") {
            event.preventDefault();
            openDrill();
          }
        }}
      >
        <div className="meta-row__name-line">
          <span className="meta-row__name" title={scopeName}>{scopeName}</span>
          <span className="meta-row__level">{rec.level}</span>
          {visibleChips.map((chip) => (
            <QuietChip key={chip.key} tone={chip.tone} cohort={chip.cohort}>
              {chip.text}
            </QuietChip>
          ))}
          {overflowChips > 0 ? <QuietChip>+{overflowChips}</QuietChip> : null}
          {effectiveResponseState ? (
            <span className="meta-row__response" data-operator-response={effectiveResponseState}>
              {responseStateLabel(effectiveResponseState)}
            </span>
          ) : null}
        </div>
        <div className="meta-row__sub">
          <span
            className="meta-row__label"
            data-decision-label={label}
            style={{ color: TONE_INK[labelTone] }}
          >
            {decisionLabelText(label)}
          </span>
          <span
            className={cn("meta-row__stake", !stake.hasMetric ? "meta-row__stake--muted" : "")}
            data-money-at-stake
            style={{ color: TONE_INK[stake.tone] }}
          >
            {stake.text}
          </span>
          {automationReadiness ? (
            <span
              className="meta-row__auto"
              data-automation-readiness
              title={rec.automationReadiness?.reason}
            >
              {automationReadiness}
            </span>
          ) : null}
          {deferred ? <DeferChip id={scopeIdForRec(rec)} deferred={deferred} onUndo={() => onUndoDefer?.(rec)} /> : null}
        </div>
      </div>

      <div className="meta-row__actions">
        <ConfidenceBandPill rec={rec} />
        <button
          type="button"
          className="btn btn--primary"
          disabled={primaryPending || primaryDisabledForContract || (primaryCompleted && !primaryCanResume)}
          title={primaryDisabledForContract ? "No executable bid value - open evidence" : undefined}
          onClick={(event) => {
            event.stopPropagation();
            if (primaryCanResume) return onResume?.(rec);
            if (watchPrimaryDefers) return onDefer?.(rec);
            return onPrimary?.(rec);
          }}
        >
          {primaryCanResume ? <Play className="inline-block shrink-0" size={13} aria-hidden="true" /> : <PrimaryIcon rec={rec} />}
          {primaryPending
            ? "Working..."
            : primaryCanResume
              ? resumePrimaryLabel(rec)
              : primaryCompleted
                ? completedPrimaryLabel(rec)
                : primaryActionLabel}
        </button>
        <button
          type="button"
          className="btn btn--ghost btn--sm meta-row__more"
          aria-label="More actions"
          aria-expanded={menuOpen}
          onClick={(event) => {
            event.stopPropagation();
            setMenuOpen((open) => !open);
          }}
        >
          <MoreHorizontal className="inline-block shrink-0" size={15} aria-hidden="true" />
        </button>
      </div>

      {menuOpen ? (
        <div className="meta-row__menu" role="menu" onClick={(event) => event.stopPropagation()}>
          {onDefer && effectiveResponseState !== "deferred" ? (
            <DeferTooltip>
              <button
                type="button"
                className="meta-row__menu-item"
                role="menuitem"
                onClick={() => {
                  setMenuOpen(false);
                  onDefer(rec);
                }}
              >
                Let cook 24h
              </button>
            </DeferTooltip>
          ) : null}
          {onCompare ? (
            <button
              type="button"
              className="meta-row__menu-item"
              role="menuitem"
              onClick={() => {
                setMenuOpen(false);
                onCompare(rec);
              }}
            >
              Compare
            </button>
          ) : null}
          {adsManagerHref ? (
            <a
              className="meta-row__menu-item"
              role="menuitem"
              href={adsManagerHref}
              target="_blank"
              rel="noreferrer"
              onClick={() => setMenuOpen(false)}
            >
              Open in Ads Manager
              <ExternalLink className="inline-block shrink-0" size={12} aria-hidden="true" />
            </a>
          ) : null}
          <button type="button" className="meta-row__menu-item" role="menuitem" onClick={copyEntityId}>
            <Copy className="inline-block shrink-0" size={12} aria-hidden="true" />
            Copy entity ID
          </button>
        </div>
      ) : null}

      {actionFeedback ? (
        <div
          className={cn("meta-action-feedback meta-row__feedback", `meta-action-feedback--${actionFeedback.tone}`)}
          role="status"
          data-meta-action-feedback={actionFeedback.tone}
        >
          <span className="dot" aria-hidden="true" />
          <span>
            <b>{actionFeedback.title}</b>
            {actionFeedback.detail ? <small>{actionFeedback.detail}</small> : null}
          </span>
        </div>
      ) : null}
    </article>
  );
}
