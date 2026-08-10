"use client";

import { cn } from "@/lib/utils";
import { formatPercentFromRatioSmart } from "@/lib/metric-format";
import { GeoKpiCard } from "./GeoKpiCard";
import { GeoInsightCallout } from "./GeoInsightCallout";
import type { GeoInsight } from "@/lib/geo-intelligence";

interface OverviewKpis {
  aiSessions: number;
  aiEngagementRate: number;
  aiPurchaseCvr: number;
  geoScore: number;
  aiPageCount: number;
  topAiSource: string | null;
  siteAvgEngagementRate: number;
  siteAvgPurchaseCvr: number;
  aiStyleQueryCount: number;
  totalQueryCount: number;
}

interface Top3Priority {
  title: string;
  description: string;
  priority: "high" | "medium" | "low";
  effort: string;
  impact: string;
}

interface Highlights {
  strongestGeoQuery?: { query: string; geoScore: number; impressions: number } | null;
  strongestGeoTopic?: { topic: string; geoScore: number; impressions: number; coverageStrength: string } | null;
  highestAiValueSource?: { engine: string; label: string; score: number } | null;
}

interface GeoOverviewSectionProps {
  kpis?: OverviewKpis;
  insights?: GeoInsight[];
  top3Priorities?: Top3Priority[];
  highlights?: Highlights;
  isLoading: boolean;
}

function fmt(n: number, type: "number" | "percent" | "score" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (type === "score") return `${Math.round(n)} / 100`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

const PRIORITY_CONFIG = {
  high: {
    label: "High",
    dot: "bg-rose-500",
    badge: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
    border: "border-rose-200 dark:border-rose-900/50",
  },
  medium: {
    label: "Medium",
    dot: "bg-amber-400",
    badge: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    border: "border-amber-200 dark:border-amber-900/50",
  },
  low: {
    label: "Low",
    dot: "bg-muted-foreground",
    badge: "bg-muted text-muted-foreground",
    border: "border-border",
  },
};

export function GeoOverviewSection({
  kpis,
  insights,
  top3Priorities,
  highlights,
  isLoading,
}: GeoOverviewSectionProps) {
  return (
    <div className="space-y-5">
      {/* KPI Band */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <GeoKpiCard
          label="AI-Source Sessions"
          value={fmt(kpis?.aiSessions ?? 0)}
          isLoading={isLoading}
        />
        <GeoKpiCard
          label="AI Engagement Rate"
          value={fmt(kpis?.aiEngagementRate ?? 0, "percent")}
          sub={
            kpis && kpis.siteAvgEngagementRate > 0
              ? `site avg ${fmt(kpis.siteAvgEngagementRate, "percent")}`
              : undefined
          }
          isLoading={isLoading}
        />
        <GeoKpiCard
          label="AI Purchase CVR"
          value={fmt(kpis?.aiPurchaseCvr ?? 0, "percent")}
          sub={
            kpis && kpis.siteAvgPurchaseCvr > 0
              ? `site avg ${fmt(kpis.siteAvgPurchaseCvr, "percent")}`
              : undefined
          }
          isLoading={isLoading}
        />
        <GeoKpiCard
          label="GEO Opportunity Score"
          value={fmt(kpis?.geoScore ?? 0, "score")}
          highlight
          isLoading={isLoading}
        />
        <GeoKpiCard
          label="Pages with GEO Signals"
          value={fmt(kpis?.aiPageCount ?? 0)}
          isLoading={isLoading}
        />
        <GeoKpiCard
          label="Top AI Source"
          value={kpis?.topAiSource ?? "—"}
          isLoading={isLoading}
        />
      </div>

      {/* Query signal strip */}
      {!isLoading && kpis && kpis.totalQueryCount > 0 && (
        <div className="flex flex-wrap items-center gap-4 rounded-xl border bg-muted/30 px-4 py-3">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Search Intelligence
          </p>
          <div className="flex items-center gap-1.5">
            <span className="text-sm font-semibold">{kpis.aiStyleQueryCount}</span>
            <span className="text-xs text-muted-foreground">
              of {kpis.totalQueryCount} ranking queries have AI / answer intent
            </span>
          </div>
          {kpis.totalQueryCount > 0 && (
            <div className="h-1.5 flex-1 rounded-full bg-muted overflow-hidden min-w-[80px]">
              <div
                className="h-full rounded-full bg-violet-500"
                style={{
                  width: `${Math.min(100, (kpis.aiStyleQueryCount / kpis.totalQueryCount) * 100)}%`,
                }}
              />
            </div>
          )}
        </div>
      )}

      {/* Top 3 Priorities */}
      {!isLoading && top3Priorities && top3Priorities.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Top Priorities
          </p>
          <div className="grid gap-2.5 sm:grid-cols-3">
            {top3Priorities.map((p, i) => {
              const cfg = PRIORITY_CONFIG[p.priority];
              return (
                <div
                  key={i}
                  className={cn(
                    "rounded-xl border p-4",
                    cfg.border
                  )}
                >
                  <div className="flex items-center gap-2 mb-2">
                    <span className={cn("h-2 w-2 rounded-full shrink-0", cfg.dot)} />
                    <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold uppercase", cfg.badge)}>
                      {cfg.label}
                    </span>
                  </div>
                  <p className="text-sm font-semibold leading-snug mb-1">{p.title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed mb-2">{p.description}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[12px] text-emerald-600 dark:text-emerald-400 font-medium">{p.impact}</span>
                    <span className="text-[12px] text-muted-foreground">{p.effort} effort</span>
                  </div>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Strongest asset highlights */}
      {!isLoading && highlights && (highlights.strongestGeoQuery || highlights.strongestGeoTopic || highlights.highestAiValueSource) && (
        <div className="grid gap-2.5 sm:grid-cols-2 lg:grid-cols-3">
          {highlights.strongestGeoQuery && (
            <div className="rounded-xl border bg-violet-50 dark:bg-violet-950/30 border-violet-200 dark:border-violet-900/50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-violet-600 dark:text-violet-400 mb-1">
                Strongest GEO Query
              </p>
              <p className="font-semibold text-sm truncate" title={highlights.strongestGeoQuery.query}>
                "{highlights.strongestGeoQuery.query}"
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {highlights.strongestGeoQuery.impressions.toLocaleString()} impressions
                </span>
                <span className="rounded-full bg-violet-100 dark:bg-violet-900/40 px-2 py-0.5 text-xs font-semibold text-violet-800 dark:text-violet-300">
                  GEO {highlights.strongestGeoQuery.geoScore}
                </span>
              </div>
            </div>
          )}
          {highlights.strongestGeoTopic && (
            <div className="rounded-xl border bg-emerald-50 dark:bg-emerald-950/30 border-emerald-200 dark:border-emerald-900/50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-emerald-600 dark:text-emerald-400 mb-1">
                Strongest GEO Topic
              </p>
              <p className="font-semibold text-sm capitalize">{highlights.strongestGeoTopic.topic}</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {highlights.strongestGeoTopic.impressions.toLocaleString()} impressions ·{" "}
                  {highlights.strongestGeoTopic.coverageStrength} coverage
                </span>
                <span className="rounded-full bg-emerald-100 dark:bg-emerald-900/40 px-2 py-0.5 text-xs font-semibold text-emerald-800 dark:text-emerald-300">
                  GEO {highlights.strongestGeoTopic.geoScore}
                </span>
              </div>
            </div>
          )}
          {highlights.highestAiValueSource && (
            <div className="rounded-xl border bg-blue-50 dark:bg-blue-950/30 border-blue-200 dark:border-blue-900/50 p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-blue-600 dark:text-blue-400 mb-1">
                Highest AI Value Source
              </p>
              <p className="font-semibold text-sm">{highlights.highestAiValueSource.engine}</p>
              <div className="mt-1 flex items-center gap-2">
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold capitalize",
                  highlights.highestAiValueSource.label === "elite"
                    ? "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300"
                    : highlights.highestAiValueSource.label === "strong"
                    ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
                    : "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
                )}>
                  {highlights.highestAiValueSource.label}
                </span>
                <span className="text-xs text-muted-foreground">
                  value score {highlights.highestAiValueSource.score}/100
                </span>
              </div>
            </div>
          )}
        </div>
      )}

      {/* Insight callouts */}
      {!isLoading && insights && insights.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Insights
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {insights.map((insight, i) => (
              <GeoInsightCallout key={i} insight={insight} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
