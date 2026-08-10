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
          className="inline-flex items-center gap-0.5 rounded bg-muted/70 px-1.5 py-0.5 text-[12px] text-muted-foreground"
          title={`${formatKey(key)}: ${value} pts`}
        >
          <span className="capitalize">{formatKey(key)}</span>
          <span className="font-semibold text-foreground/80">{value}</span>
        </span>
      ))}
      <span className="inline-flex items-center rounded bg-foreground/10 px-1.5 py-0.5 text-[12px] font-semibold text-foreground/70">
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
  breakout: "text-violet-600 dark:text-violet-400 font-semibold",
  rising:   "text-emerald-600 dark:text-emerald-400",
  stable:   "text-muted-foreground",
  declining:"text-amber-600 dark:text-amber-400",
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
  elite:     "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  strong:    "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  promising: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
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
  excellent: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  strong:    "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  developing:"bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  weak:      "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
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
  informational: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  commercial:    "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  comparative:   "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  transactional: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  navigational:  "bg-muted text-muted-foreground",
  inspirational: "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
};

export function QueryIntentBadge({ intent, format, confidence, isAiStyle, className }: IntentBadgeV3Props) {
  const cls = INTENT_STYLES[intent] ?? INTENT_STYLES["navigational"];
  const confidenceDot = confidence === "high" ? "bg-emerald-500" : confidence === "medium" ? "bg-amber-400" : "bg-muted-foreground";
  return (
    <div className={cn("flex items-center gap-1", className)}>
      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold capitalize", cls)}>
        {isAiStyle ? "✦ " : ""}{intent}
      </span>
      <span className="rounded bg-muted px-1.5 py-0.5 text-[12px] text-muted-foreground capitalize">
        {format.replace(/_/g, "-")}
      </span>
      <span className={cn("h-1.5 w-1.5 rounded-full", confidenceDot)} title={`${confidence} confidence`} />
    </div>
  );
}
