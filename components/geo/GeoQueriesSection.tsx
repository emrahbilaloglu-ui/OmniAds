"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPercentFromRatioSmart } from "@/lib/metric-format";
import { cn } from "@/lib/utils";
import { GeoScoreBreakdown, GeoMomentumBadge, QueryIntentBadge } from "./GeoScoreBreakdown";

interface QueryClassification {
  intent: string;
  intentLabel: string;
  format: string;
  formatLabel: string;
  confidence: string;
  signals?: string[];
}

interface QueryMomentum {
  status: "breakout" | "rising" | "stable" | "declining";
  label: string;
  score: number;
  growthRate: number;
}

interface GeoQuery {
  query: string;
  clicks: number;
  impressions: number;
  ctr: number;
  position: number;
  // v2 compat
  intent: string;
  isAiStyle: boolean;
  opportunityLabel: string | null;
  // v3
  classification?: QueryClassification;
  geoScore: number;
  geoScoreBreakdown?: Record<string, number>;
  momentum?: QueryMomentum;
  priority: "high" | "medium" | "low";
  confidence: "high" | "medium" | "low";
  recommendation: string | null;
}

type Filter = "all" | "ai_style" | "high_impression" | "weak_ctr" | "rising";
type SortKey = "impressions" | "clicks" | "ctr" | "position" | "geoScore";

const FILTERS: { id: Filter; label: string }[] = [
  { id: "all", label: "All Queries" },
  { id: "ai_style", label: "AI Intent" },
  { id: "high_impression", label: "High Impressions" },
  { id: "weak_ctr", label: "Weak CTR" },
  { id: "rising", label: "Rising ↑" },
];

function fmt(n: number, type: "number" | "percent" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

function GeoScorePill({ score, breakdown }: { score: number; breakdown?: Record<string, number> }) {
  const [expanded, setExpanded] = useState(false);
  const cls =
    score >= 60
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : score >= 35
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-muted text-muted-foreground";
  return (
    <div className="text-right">
      <button
        onClick={() => breakdown && setExpanded(!expanded)}
        className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", cls, breakdown ? "cursor-pointer hover:opacity-80" : "")}
        title={breakdown ? "Click to see score breakdown" : undefined}
      >
        {score}
      </button>
      {expanded && breakdown && (
        <GeoScoreBreakdown breakdown={breakdown} total={score} className="justify-end" />
      )}
    </div>
  );
}

function PriorityDot({ priority }: { priority: "high" | "medium" | "low" }) {
  const cls = { high: "bg-rose-500", medium: "bg-amber-400", low: "bg-muted-foreground" }[priority];
  return <span className={cn("inline-block h-2 w-2 rounded-full shrink-0", cls)} title={`${priority} priority`} />;
}

interface GeoQueriesSectionProps {
  queries?: GeoQuery[];
  isLoading: boolean;
}

export function GeoQueriesSection({ queries, isLoading }: GeoQueriesSectionProps) {
  const [activeFilter, setActiveFilter] = useState<Filter>("ai_style");
  const [sortKey, setSortKey] = useState<SortKey>("geoScore");
  const [sortDir, setSortDir] = useState<"asc" | "desc">("desc");

  const filtered = (queries ?? []).filter((q) => {
    if (activeFilter === "ai_style") return q.isAiStyle;
    if (activeFilter === "high_impression") return q.impressions > 100;
    if (activeFilter === "weak_ctr") return q.ctr < 0.03 && q.impressions > 50;
    if (activeFilter === "rising") return q.momentum?.status === "rising" || q.momentum?.status === "breakout";
    return true;
  });

  const sorted = [...filtered].sort((a, b) => {
    const av = a[sortKey] as number;
    const bv = b[sortKey] as number;
    return sortDir === "asc" ? av - bv : bv - av;
  });

  function toggleSort(key: SortKey) {
    if (sortKey === key) setSortDir((d) => (d === "asc" ? "desc" : "asc"));
    else { setSortKey(key); setSortDir("desc"); }
  }

  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 8 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (!queries || queries.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-10 text-center">
        <p className="text-sm font-medium">No query data available</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect Search Console and select a site in Integrations to unlock query intelligence.
        </p>
      </div>
    );
  }

  const risingCount = (queries ?? []).filter(
    (q) => q.momentum?.status === "rising" || q.momentum?.status === "breakout"
  ).length;

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Queries classified by semantic intent and format, scored for GEO relevance.
        ✦ marks high AI answer-engine potential. Click a GEO score to see its breakdown.
        Momentum compares to the previous equivalent period.
      </p>

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => {
          const count =
            f.id === "all" ? queries.length :
            f.id === "ai_style" ? queries.filter((q) => q.isAiStyle).length :
            f.id === "high_impression" ? queries.filter((q) => q.impressions > 100).length :
            f.id === "weak_ctr" ? queries.filter((q) => q.ctr < 0.03 && q.impressions > 50).length :
            risingCount;
          return (
            <button
              key={f.id}
              onClick={() => setActiveFilter(f.id)}
              className={cn(
                "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
                activeFilter === f.id
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

      {/* Table */}
      <div className="overflow-x-auto">
        <table className="w-full text-sm">
          <thead>
            <tr className="border-b">
              <th className="py-2.5 pr-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground w-[180px]">Query</th>
              <th className="py-2.5 pr-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Intent / Format</th>
              <th className="py-2.5 pr-4 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Momentum</th>
              <SortableHeader label="GEO Score" sortKey="geoScore" current={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Impressions" sortKey="impressions" current={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHeader label="CTR" sortKey="ctr" current={sortKey} dir={sortDir} onSort={toggleSort} />
              <SortableHeader label="Position" sortKey="position" current={sortKey} dir={sortDir} onSort={toggleSort} />
              <th className="py-2.5 text-left text-xs font-medium uppercase tracking-wide text-muted-foreground">Recommendation</th>
            </tr>
          </thead>
          <tbody>
            {sorted.slice(0, 50).map((q, i) => (
              <tr key={i} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                <td className="py-2.5 pr-4 max-w-[180px]">
                  <div className="flex items-center gap-1.5">
                    <PriorityDot priority={q.priority} />
                    <span className="truncate block text-xs font-medium" title={q.query}>{q.query}</span>
                  </div>
                </td>
                <td className="py-2.5 pr-4">
                  {q.classification ? (
                    <QueryIntentBadge
                      intent={q.classification.intent}
                      format={q.classification.format}
                      confidence={q.classification.confidence}
                      isAiStyle={q.isAiStyle}
                    />
                  ) : (
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold",
                      q.isAiStyle
                        ? "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
                        : "bg-muted text-muted-foreground"
                    )}>
                      {q.intent}
                    </span>
                  )}
                </td>
                <td className="py-2.5 pr-4">
                  {q.momentum && (
                    <GeoMomentumBadge status={q.momentum.status} label={q.momentum.label} />
                  )}
                </td>
                <td className="py-2.5 pr-4">
                  <GeoScorePill score={q.geoScore} breakdown={q.geoScoreBreakdown} />
                </td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-xs">{fmt(q.impressions)}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-xs">{fmt(q.ctr, "percent")}</td>
                <td className="py-2.5 pr-4 text-right tabular-nums text-xs">
                  <span className={cn(
                    q.position <= 3 ? "text-emerald-600 dark:text-emerald-400 font-medium" :
                    q.position <= 10 ? "text-foreground" :
                    "text-amber-600 dark:text-amber-400"
                  )}>
                    {q.position.toFixed(1)}
                  </span>
                </td>
                <td className="py-2.5 text-xs text-muted-foreground max-w-[170px]">
                  {q.recommendation && (
                    <span className="rounded bg-muted px-1.5 py-0.5 text-[12px] block truncate" title={q.recommendation}>
                      {q.recommendation}
                    </span>
                  )}
                </td>
              </tr>
            ))}
          </tbody>
        </table>
        {sorted.length === 0 && (
          <p className="py-6 text-center text-sm text-muted-foreground">No queries match this filter.</p>
        )}
      </div>
    </div>
  );
}

function SortableHeader({
  label, sortKey, current, dir, onSort,
}: {
  label: string; sortKey: string; current: string; dir: "asc" | "desc"; onSort: (key: SortKey) => void;
}) {
  const active = current === sortKey;
  return (
    <th
      className="py-2.5 pr-4 text-right text-xs font-medium uppercase tracking-wide text-muted-foreground cursor-pointer select-none hover:text-foreground"
      onClick={() => onSort(sortKey as SortKey)}
    >
      {label} {active ? (dir === "asc" ? "↑" : "↓") : ""}
    </th>
  );
}
