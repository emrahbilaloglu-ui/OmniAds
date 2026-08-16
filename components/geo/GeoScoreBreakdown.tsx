"use client";

import { cn } from "@/lib/utils";

// ── Score Breakdown chips ────────────────────────────────────────────

interface ScoreBreakdownProps {
  breakdown: Record<string, number>;
  total: number;
  className?: string;
}

/**
 * Small inline row of chips showing each component's contribution
 * to a GEO score (e.g. "visibility: 24 / 25").
 */
export function GeoScoreBreakdown({ breakdown, total, className }: ScoreBreakdownProps) {
  return (
    <div className={cn("flex flex-wrap gap-1 mt-1", className)}>
      {Object.entries(breakdown).map(([key, value]) => (
        <span
          key={key}
          className="inline-flex items-center gap-0.5 rounded bg-muted/70 px-1.5 py-0.5 text-[9px] text-muted-foreground"
          title={`${formatKey(key)}: ${value} pts`}
        >
          <span className="capitalize">{formatKey(key)}</span>
          <span className="font-semibold text-foreground/80">{value}</span>
        </span>
      ))}
      <span className="inline-flex items-center rounded bg-foreground/10 px-1.5 py-0.5 text-[9px] font-semibold text-foreground/70">
        = {total}
      </span>
    </div>
  );
}

function formatKey(key: string): string {
  return key
    .replace(/([A-Z])/g, " $1")
    .replace(/_/g, " ")
    .toLowerCase()
    .trim();
}

// ── Momentum badge ───────────────────────────────────────────────────

type MomentumStatus = "breakout" | "rising" | "stable" | "declining";

interface MomentumBadgeProps {
  status: MomentumStatus;
  label: string;
  className?: string;
}

const MOMENTUM_STYLES: Record<MomentumStatus, string> = {
  breakout: "text-[var(--adc-auto-fg)]  font-semibold",
  rising:   "text-[var(--adc-pos-fg)] ",
  stable:   "text-muted-foreground",
  declining:"text-[var(--adc-caution-fg)] ",
};

export function GeoMomentumBadge({ status, label, className }: MomentumBadgeProps) {
  return (
    <span className={cn("text-xs whitespace-nowrap", MOMENTUM_STYLES[status], className)} title={label}>
      {status === "breakout" ? "⚡" : status === "rising" ? "↑" : status === "declining" ? "↓" : "→"}{" "}
      {status.charAt(0).toUpperCase() + status.slice(1)}
    </span>
  );
}

// ── AI Traffic Value badge ───────────────────────────────────────────

type TrafficValueLabel = "weak" | "promising" | "strong" | "elite";

interface TrafficValueBadgeProps {
  label: TrafficValueLabel;
  score?: number;
  className?: string;
}

const VALUE_STYLES: Record<TrafficValueLabel, string> = {
  elite:     "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)]  ",
  strong:    "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]  ",
  promising: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]  ",
  weak:      "bg-muted text-muted-foreground",
};

export function AiTrafficValueBadge({ label, score, className }: TrafficValueBadgeProps) {
  return (
    <span
      className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize", VALUE_STYLES[label], className)}
      title={score !== undefined ? `AI Traffic Value Score: ${score}/100` : undefined}
    >
      {label}
    </span>
  );
}

// ── Page Readiness badge ─────────────────────────────────────────────

type ReadinessLabel = "weak" | "developing" | "strong" | "excellent";

interface ReadinessBadgeProps {
  label: ReadinessLabel;
  score?: number;
  className?: string;
}

const READINESS_STYLES: Record<ReadinessLabel, string> = {
  excellent: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]  ",
  strong:    "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]  ",
  developing:"bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]  ",
  weak:      "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]  ",
};

export function PageReadinessBadge({ label, score, className }: ReadinessBadgeProps) {
  return (
    <span
      className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize", READINESS_STYLES[label], className)}
      title={score !== undefined ? `Page Readiness Score: ${score}/100` : undefined}
    >
      {label}
    </span>
  );
}

// ── Intent + Format badges ───────────────────────────────────────────

interface IntentBadgeV3Props {
  intent: string;
  format: string;
  confidence: string;
  isAiStyle: boolean;
  className?: string;
}

const INTENT_STYLES: Record<string, string> = {
  informational: "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)]  ",
  commercial:    "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)]  ",
  comparative:   "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]  ",
  transactional: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]  ",
  navigational:  "bg-muted text-muted-foreground",
  inspirational: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
};

export function QueryIntentBadge({ intent, format, confidence, isAiStyle, className }: IntentBadgeV3Props) {
  const cls = INTENT_STYLES[intent] ?? INTENT_STYLES["navigational"];
  const confidenceDot = confidence === "high" ? "bg-[var(--adc-pos-fg)]" : confidence === "medium" ? "bg-[var(--adc-caution-fg)]" : "bg-muted-foreground";
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize", cls)}>
        {isAiStyle ? "✦ " : ""}{intent}
      </span>
      <span className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground capitalize">
        {format.replace(/_/g, "-")}
      </span>
      <span className={cn("h-1.5 w-1.5 rounded-full", confidenceDot)} title={`${confidence} confidence`} />
    </div>
  );
}
