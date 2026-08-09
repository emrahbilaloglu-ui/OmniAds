"use client";

import { cn } from "@/lib/utils";
import { Skeleton } from "@/components/ui/skeleton";
import { getCurrencySymbol } from "@/hooks/use-currency";
import { formatCurrencySmart, formatPercentSmart } from "@/lib/metric-format";

// ── Formatting ────────────────────────────────────────────────────────

export function fmtCurrency(n: number): string {
  return formatCurrencySmart(n, getCurrencySymbol());
}

export function fmtNumber(n: number): string {
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export function fmtPercent(n: number): string {
  return formatPercentSmart(n);
}

export function fmtRoas(n: number): string {
  return `${n.toFixed(2)}x`;
}

// ── KPI Card ──────────────────────────────────────────────────────────

interface KpiCardProps {
  label: string;
  value: string | number;
  sub?: string;
  highlight?: boolean;
  isLoading?: boolean;
  trend?: "up" | "down" | "neutral";
}

export function GadsKpiCard({ label, value, sub, highlight, isLoading, trend }: KpiCardProps) {
  if (isLoading) {
    return (
      <div className="rounded-xl border bg-card p-4">
        <Skeleton className="h-3 w-20 mb-3" />
        <Skeleton className="h-7 w-16" />
      </div>
    );
  }
  return (
    <div className={cn("rounded-xl border bg-card p-4", highlight && "border-primary/30 bg-primary/5")}>
      <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-1">
        {label}
      </p>
      <p className={cn("text-2xl font-bold tracking-tight", highlight && "text-primary")}>
        {value}
      </p>
      {sub && (
        <p className="mt-0.5 text-xs text-muted-foreground">{sub}</p>
      )}
    </div>
  );
}

// ── Insight Card ──────────────────────────────────────────────────────

type Severity = "critical" | "warning" | "opportunity" | "positive";

const SEVERITY_CONFIG: Record<Severity, { border: string; icon: string; iconCls: string }> = {
  critical: { border: "border-rose-200 dark:border-rose-900/50", icon: "⚠", iconCls: "text-rose-500" },
  warning: { border: "border-amber-200 dark:border-amber-900/50", icon: "△", iconCls: "text-amber-500" },
  opportunity: { border: "border-blue-200 dark:border-blue-900/50", icon: "◈", iconCls: "text-blue-500" },
  positive: { border: "border-emerald-200 dark:border-emerald-900/50", icon: "✓", iconCls: "text-emerald-500" },
};

interface InsightCardProps {
  severity: Severity;
  title: string;
  description: string;
  evidence?: string;
  recommendation?: string;
}

export function GadsInsightCard({ severity, title, description, evidence, recommendation }: InsightCardProps) {
  const cfg = SEVERITY_CONFIG[severity];
  return (
    <div className={cn("rounded-xl border p-4 space-y-1.5", cfg.border)}>
      <div className="flex items-start gap-2">
        <span className={cn("text-base leading-none mt-0.5 shrink-0", cfg.iconCls)}>{cfg.icon}</span>
        <p className="text-sm font-semibold leading-snug">{title}</p>
      </div>
      <p className="text-xs text-muted-foreground pl-6">{description}</p>
      {evidence && (
        <p className="text-[12px] text-muted-foreground pl-6 italic">{evidence}</p>
      )}
      {recommendation && (
        <p className="text-xs text-foreground/80 pl-6">→ {recommendation}</p>
      )}
    </div>
  );
}

// ── Opportunity Card ──────────────────────────────────────────────────

type EffortLevel = "low" | "medium" | "high";
type PriorityLevel = "high" | "medium" | "low";

const EFFORT_CONFIG: Record<EffortLevel, string> = {
  low: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  medium: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
};

const PRIORITY_DOT: Record<PriorityLevel, string> = {
  high: "bg-rose-500",
  medium: "bg-amber-400",
  low: "bg-muted-foreground",
};

const TYPE_LABELS: Record<string, string> = {
  budget_shift: "Budget Shift",
  negative_keyword: "Negative Keywords",
  new_keyword: "New Keyword",
  ad_copy: "Ad Copy",
  audience_expansion: "Audience",
  creative_test: "Creative Test",
  bid_adjustment: "Bid Adjustment",
};

interface OpportunityCardProps {
  type: string;
  title: string;
  whyItMatters: string;
  evidence: string;
  expectedImpact: string;
  effort: EffortLevel;
  priority: PriorityLevel;
}

export function GadsOpportunityCard({
  type, title, whyItMatters, evidence, expectedImpact, effort, priority,
}: OpportunityCardProps) {
  return (
    <div className="rounded-xl border bg-card p-4 space-y-2.5">
      <div className="flex items-start justify-between gap-3">
        <div className="flex items-center gap-2 flex-wrap">
          <span className={cn("h-2 w-2 rounded-full shrink-0", PRIORITY_DOT[priority])} />
          <span className="rounded bg-muted px-1.5 py-0.5 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
            {TYPE_LABELS[type] ?? type}
          </span>
        </div>
        <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold shrink-0", EFFORT_CONFIG[effort])}>
          {effort} effort
        </span>
      </div>
      <p className="text-sm font-semibold leading-snug">{title}</p>
      <p className="text-xs text-muted-foreground">{whyItMatters}</p>
      {evidence && (
        <p className="text-[12px] text-muted-foreground italic rounded bg-muted px-2 py-1">
          {evidence}
        </p>
      )}
      <div className="flex items-center gap-1.5 text-xs">
        <span className="text-muted-foreground">Expected impact:</span>
        <span className="font-medium text-emerald-600 dark:text-emerald-400">{expectedImpact}</span>
      </div>
    </div>
  );
}

// ── Status Badge ──────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
  const cls =
    status === "active"
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : status === "paused"
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-muted text-muted-foreground";
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold uppercase", cls)}>
      {status}
    </span>
  );
}

// ── Campaign Badge ────────────────────────────────────────────────────

const BADGE_CONFIG: Record<string, { label: string; cls: string }> = {
  strong_performer: { label: "✦ Strong", cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300" },
  budget_limited: { label: "⊘ Budget", cls: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300" },
  low_roas: { label: "↓ Low ROAS", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  high_cpa: { label: "↑ High CPA", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
  wasted_spend: { label: "✕ Wasted Spend", cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300" },
};

export function CampaignBadges({ badges }: { badges: string[] }) {
  return (
    <div className="flex flex-wrap gap-1">
      {badges.map((b) => {
        const cfg = BADGE_CONFIG[b];
        if (!cfg) return null;
        return (
          <span key={b} className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold whitespace-nowrap", cfg.cls)}>
            {cfg.label}
          </span>
        );
      })}
    </div>
  );
}

// ── Section skeleton ─────────────────────────────────────────────────

export function TabSkeleton({ rows = 6 }: { rows?: number }) {
  return (
    <div className="space-y-2">
      {Array.from({ length: rows }).map((_, i) => (
        <Skeleton key={i} className="h-10 w-full rounded-lg" />
      ))}
    </div>
  );
}

// ── Empty state ───────────────────────────────────────────────────────

export function TabEmpty({ message }: { message: string }) {
  return (
    <div className="rounded-xl border border-dashed py-12 text-center">
      <p className="text-sm font-medium">No data available</p>
      <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">{message}</p>
    </div>
  );
}

export function TabAlert({
  tone,
  title,
  items,
}: {
  tone: "error" | "warning" | "info";
  title: string;
  items: string[];
}) {
  if (items.length === 0) return null;

  const styles =
    tone === "error"
      ? "border-rose-200 bg-rose-50 text-rose-900 dark:border-rose-900/50 dark:bg-rose-950/30 dark:text-rose-100"
      : tone === "warning"
      ? "border-amber-200 bg-amber-50 text-amber-900 dark:border-amber-900/50 dark:bg-amber-950/30 dark:text-amber-100"
      : "border-slate-200 bg-slate-50 text-slate-900 dark:border-slate-800 dark:bg-slate-950/30 dark:text-slate-100";

  return (
    <div className={cn("rounded-xl border px-4 py-3", styles)}>
      <p className="text-xs font-semibold uppercase tracking-wide">{title}</p>
      <div className="mt-2 space-y-1">
        {items.map((item, index) => (
          <p key={`${title}-${index}`} className="text-xs">
            {item}
          </p>
        ))}
      </div>
    </div>
  );
}

// ── Sortable table ────────────────────────────────────────────────────

export interface ColDef<T> {
  key: string;
  header: string;
  accessor: (r: T) => string | number;
  render?: (r: T) => React.ReactNode;
  align?: "left" | "right";
  sortable?: boolean;
  sticky?: boolean;
}

import { useState } from "react";

export function SimpleTable<T extends object>({
  cols,
  rows,
  defaultSort,
  emptyText,
}: {
  cols: ColDef<T>[];
  rows: T[];
  defaultSort?: string;
  emptyText?: string;
}) {
  const [sortKey, setSortKey] = useState(defaultSort ?? cols[0]?.key ?? "");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  function toggleSort(key: string) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  const col = cols.find((c) => c.key === sortKey);
  const sorted = col
    ? [...rows].sort((a, b) => {
        const av = col.accessor(a);
        const bv = col.accessor(b);
        if (typeof av === "number" && typeof bv === "number")
          return sortDir === "asc" ? av - bv : bv - av;
        return sortDir === "asc"
          ? String(av).localeCompare(String(bv))
          : String(bv).localeCompare(String(av));
      })
    : rows;

  return (
    <div className="overflow-x-auto rounded-2xl border border-border/70">
      <table className="w-full text-sm">
        <thead className="sticky top-0 z-30 bg-card/95 backdrop-blur">
          <tr className="border-b border-border/70">
            {cols.map((c) => (
              <th
                key={c.key}
                className={cn(
                  "py-3 pr-4 text-xs font-medium uppercase tracking-wide text-muted-foreground",
                  c.align === "right" ? "text-right" : "text-left",
                  c.sortable !== false && "cursor-pointer select-none hover:text-foreground",
                  c.sticky && "sticky left-0 z-20 bg-card px-4 shadow-[8px_0_18px_-16px_rgba(15,23,42,0.45)]"
                )}
                onClick={() => c.sortable !== false && toggleSort(c.key)}
              >
                {c.header}
                {sortKey === c.key ? (sortDir === "asc" ? " ↑" : " ↓") : ""}
              </th>
            ))}
          </tr>
        </thead>
        <tbody>
          {sorted.slice(0, 100).map((row, i) => (
            <tr key={i} className="border-b border-border/70 last:border-0 hover:bg-muted/20 transition-colors">
              {cols.map((c) => (
                <td
                  key={c.key}
                  className={cn(
                    "py-3 pr-4 text-xs tabular-nums align-top",
                    c.align === "right" ? "text-right" : "",
                    c.sticky && "sticky left-0 z-10 bg-card px-4 shadow-[8px_0_18px_-16px_rgba(15,23,42,0.45)]"
                  )}
                >
                  {c.render ? c.render(row) : String(c.accessor(row))}
                </td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {sorted.length === 0 && (
        <p className="py-8 text-center text-sm text-muted-foreground">
          {emptyText ?? "No data for this period."}
        </p>
      )}
    </div>
  );
}

// ── Health Badge ──────────────────────────────────────────────────────

export type HealthState = "healthy" | "warning" | "critical" | "neutral";

const HEALTH_CFG: Record<HealthState, string> = {
  healthy: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  warning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  critical: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  neutral: "bg-muted text-muted-foreground",
};

export function HealthBadge({ state, label }: { state: HealthState; label?: string }) {
  const defaultLabel = state === "healthy" ? "Healthy" : state === "warning" ? "Warning" : state === "critical" ? "Critical" : "Neutral";
  return (
    <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold uppercase", HEALTH_CFG[state])}>
      {label ?? defaultLabel}
    </span>
  );
}

// ── Performance label ─────────────────────────────────────────────────

export type PerfLabel = "top" | "average" | "underperforming";

export function PerfBadge({ label }: { label: PerfLabel }) {
  const cfg: Record<PerfLabel, { cls: string; text: string }> = {
    top: { cls: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300", text: "✦ Top" },
    average: { cls: "bg-muted text-muted-foreground", text: "Average" },
    underperforming: { cls: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300", text: "↓ Under" },
  };
  const c = cfg[label];
  return (
    <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold", c.cls)}>{c.text}</span>
  );
}

// ── Spend bar ─────────────────────────────────────────────────────────

export function SpendBar({ value, max }: { value: number; max: number }) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="h-1.5 w-full rounded-full bg-muted overflow-hidden">
      <div className="h-full rounded-full bg-primary/40" style={{ width: `${pct}%` }} />
    </div>
  );
}

// ── Sub-tab navigation ────────────────────────────────────────────────

export function SubTabNav<T extends string>({
  tabs,
  active,
  onChange,
}: {
  tabs: { id: T; label: string }[];
  active: T;
  onChange: (id: T) => void;
}) {
  return (
    <div className="flex gap-0 border-b">
      {tabs.map((t) => (
        <button
          key={t.id}
          onClick={() => onChange(t.id)}
          className={cn(
            "relative px-4 py-2.5 text-sm font-medium whitespace-nowrap transition-colors",
            active === t.id
              ? "text-foreground after:absolute after:bottom-0 after:left-0 after:right-0 after:h-0.5 after:bg-primary"
              : "text-muted-foreground hover:text-foreground"
          )}
        >
          {t.label}
        </button>
      ))}
    </div>
  );
}

// ── Section label ─────────────────────────────────────────────────────

export function SectionLabel({ children }: { children: React.ReactNode }) {
  return <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">{children}</p>;
}
