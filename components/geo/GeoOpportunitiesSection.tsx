"use client";

import { useState } from "react";
import { Zap, AlertTriangle, TrendingUp, Globe } from "lucide-react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";

interface GeoOpportunity {
  type: "content" | "traffic" | "conversion" | "coverage";
  priority: "high" | "medium" | "low";
  effort: "low" | "medium" | "high";
  confidence: "high" | "medium" | "low";
  impact: string;
  title: string;
  target: string;
  evidence: string;
  recommendation: string;
  whyItMatters?: string;
}

type FilterOption = "all" | "high" | "medium" | "low";
type SortOption = "priority" | "effort_asc" | "effort_desc";

const TYPE_CONFIG = {
  content: {
    icon: <TrendingUp className="h-4 w-4" />,
    label: "Content",
    color: "text-violet-600 dark:text-violet-400",
    border: "border-violet-200 dark:border-violet-900/50",
    bg: "bg-violet-50 dark:bg-violet-950/30",
  },
  traffic: {
    icon: <Zap className="h-4 w-4" />,
    label: "Traffic",
    color: "text-blue-600 dark:text-blue-400",
    border: "border-blue-200 dark:border-blue-900/50",
    bg: "bg-blue-50 dark:bg-blue-950/30",
  },
  conversion: {
    icon: <AlertTriangle className="h-4 w-4" />,
    label: "Conversion",
    color: "text-amber-600 dark:text-amber-400",
    border: "border-amber-200 dark:border-amber-900/50",
    bg: "bg-amber-50 dark:bg-amber-950/30",
  },
  coverage: {
    icon: <Globe className="h-4 w-4" />,
    label: "Coverage",
    color: "text-emerald-600 dark:text-emerald-400",
    border: "border-emerald-200 dark:border-emerald-900/50",
    bg: "bg-emerald-50 dark:bg-emerald-950/30",
  },
};

const PRIORITY_BADGE: Record<string, string> = {
  high: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  low: "bg-muted text-muted-foreground",
};

const EFFORT_BADGE: Record<string, string> = {
  low: "bg-emerald-100 text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300",
  medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
  high: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
};

const CONFIDENCE_DOT: Record<string, string> = {
  high: "bg-emerald-500",
  medium: "bg-amber-400",
  low: "bg-muted-foreground",
};

const PRIORITY_ORDER: Record<string, number> = { high: 0, medium: 1, low: 2 };
const EFFORT_ORDER: Record<string, number> = { low: 0, medium: 1, high: 2 };

const FILTERS: { id: FilterOption; label: string }[] = [
  { id: "all", label: "All" },
  { id: "high", label: "High Priority" },
  { id: "medium", label: "Medium" },
  { id: "low", label: "Low" },
];

interface GeoOpportunitiesSectionProps {
  opportunities?: GeoOpportunity[];
  isLoading: boolean;
}

export function GeoOpportunitiesSection({
  opportunities,
  isLoading,
}: GeoOpportunitiesSectionProps) {
  const [priorityFilter, setPriorityFilter] = useState<FilterOption>("all");
  const [sort, setSort] = useState<SortOption>("priority");

  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 4 }).map((_, i) => (
          <Skeleton key={i} className="h-36 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!opportunities || opportunities.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-10 text-center">
        <p className="text-sm font-medium">No opportunities detected yet</p>
        <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
          Connect GA4 and Search Console to unlock data-driven GEO recommendations.
        </p>
      </div>
    );
  }

  const filtered = opportunities.filter(
    (op) => priorityFilter === "all" || op.priority === priorityFilter
  );

  const sorted = [...filtered].sort((a, b) => {
    if (sort === "priority") return PRIORITY_ORDER[a.priority] - PRIORITY_ORDER[b.priority];
    if (sort === "effort_asc") return EFFORT_ORDER[a.effort] - EFFORT_ORDER[b.effort];
    if (sort === "effort_desc") return EFFORT_ORDER[b.effort] - EFFORT_ORDER[a.effort];
    return 0;
  });

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Evidence-based actions to improve your AI-era discoverability. Each card shows
        estimated impact, effort, and confidence based on your real data signals.
      </p>

      {/* Filter + sort bar */}
      <div className="flex flex-wrap items-center gap-2">
        <div className="flex flex-wrap gap-1.5">
          {FILTERS.map((f) => {
            const count = f.id === "all"
              ? opportunities.length
              : opportunities.filter((op) => op.priority === f.id).length;
            return (
              <button
                key={f.id}
                onClick={() => setPriorityFilter(f.id)}
                className={cn(
                  "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                  priorityFilter === f.id
                    ? "border-foreground bg-foreground text-background"
                    : "border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground"
                )}
              >
                {f.label}
                <span className="ml-1.5 text-[12px] opacity-60">{count}</span>
              </button>
            );
          })}
        </div>
        <div className="ml-auto flex items-center gap-1.5">
          <span className="text-xs text-muted-foreground">Sort:</span>
          <select
            value={sort}
            onChange={(e) => setSort(e.target.value as SortOption)}
            className="rounded border border-border bg-background px-2 py-1 text-xs text-foreground focus:outline-none"
          >
            <option value="priority">Priority</option>
            <option value="effort_asc">Lowest effort first</option>
            <option value="effort_desc">Highest effort first</option>
          </select>
        </div>
      </div>

      {sorted.length === 0 && (
        <p className="py-6 text-center text-sm text-muted-foreground">
          No opportunities match this filter.
        </p>
      )}

      {sorted.map((op, i) => {
        const cfg = TYPE_CONFIG[op.type];
        return (
          <div
            key={i}
            className={`rounded-xl border p-4 ${cfg.border} ${cfg.bg}`}
          >
            <div className="flex items-start gap-3">
              <div className={`mt-0.5 shrink-0 ${cfg.color}`}>{cfg.icon}</div>
              <div className="min-w-0 flex-1">
                {/* Header row */}
                <div className="flex flex-wrap items-center gap-2 mb-1.5">
                  <span className="font-semibold text-sm">{op.title}</span>
                  <span
                    className={`rounded-full px-2 py-0.5 text-[12px] font-semibold uppercase ${PRIORITY_BADGE[op.priority]}`}
                  >
                    {op.priority}
                  </span>
                  <span className="rounded-full bg-muted px-2 py-0.5 text-[12px] text-muted-foreground">
                    {cfg.label}
                  </span>
                </div>

                {/* Metadata row: impact, effort, confidence */}
                <div className="flex flex-wrap items-center gap-3 mb-2">
                  {op.impact && (
                    <span className="text-xs font-medium text-foreground">
                      Impact: <span className="text-emerald-600 dark:text-emerald-400">{op.impact}</span>
                    </span>
                  )}
                  <span className={cn("rounded px-1.5 py-0.5 text-[12px] font-medium", EFFORT_BADGE[op.effort])}>
                    {op.effort.charAt(0).toUpperCase() + op.effort.slice(1)} effort
                  </span>
                  {op.confidence && (
                    <span className="flex items-center gap-1 text-[12px] text-muted-foreground">
                      <span className={cn("h-1.5 w-1.5 rounded-full", CONFIDENCE_DOT[op.confidence])} />
                      {op.confidence.charAt(0).toUpperCase() + op.confidence.slice(1)} confidence
                    </span>
                  )}
                </div>

                {/* Target + evidence */}
                <p className="text-xs text-muted-foreground mb-1">
                  <span className="font-medium">Target:</span> {op.target}
                </p>
                <p className="text-xs text-muted-foreground mb-2">
                  <span className="font-medium">Evidence:</span> {op.evidence}
                </p>

                {/* Recommendation box */}
                <div className="rounded-lg bg-background/60 px-3 py-2 border border-border/50">
                  <p className="text-xs font-medium text-foreground">Recommendation</p>
                  <p className="mt-0.5 text-xs text-muted-foreground">{op.recommendation}</p>
                  {op.whyItMatters && (
                    <p className="mt-1 text-xs text-muted-foreground/70 italic">{op.whyItMatters}</p>
                  )}
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}
