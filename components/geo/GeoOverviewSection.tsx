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
    dot: "bg-[var(--adc-danger-fg)]",
    badge: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]  ",
    border: "border-[var(--adc-danger-bd)] ",
  },
  medium: {
    label: "Medium",
    dot: "bg-[var(--adc-caution-fg)]",
    badge: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]  ",
    border: "border-[var(--adc-caution-bd)] ",
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
                className="h-full rounded-full bg-[var(--adc-auto-fg)]"
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
                    <span className={cn("rounded-full px-2 py-0.5 text-[10px] font-semibold uppercase", cfg.badge)}>
                      {cfg.label}
                    </span>
                  </div>
                  <p className="text-sm font-semibold leading-snug mb-1">{p.title}</p>
                  <p className="text-xs text-muted-foreground leading-relaxed mb-2">{p.description}</p>
                  <div className="flex flex-wrap items-center gap-2">
                    <span className="text-[10px] text-[var(--adc-pos-fg)]  font-medium">{p.impact}</span>
                    <span className="text-[10px] text-muted-foreground">{p.effort} effort</span>
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
            <div className="rounded-xl border bg-[var(--adc-auto-bg)]  border-[var(--adc-auto-bd)]  p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--adc-auto-fg)]  mb-1">
                Strongest GEO Query
              </p>
              <p className="font-semibold text-sm truncate" title={highlights.strongestGeoQuery.query}>
                "{highlights.strongestGeoQuery.query}"
              </p>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {highlights.strongestGeoQuery.impressions.toLocaleString()} impressions
                </span>
                <span className="rounded-full bg-[var(--adc-auto-bg)]  px-2 py-0.5 text-xs font-semibold text-[var(--adc-auto-fg)] ">
                  GEO {highlights.strongestGeoQuery.geoScore}
                </span>
              </div>
            </div>
          )}
          {highlights.strongestGeoTopic && (
            <div className="rounded-xl border bg-[var(--adc-pos-bg)]  border-[var(--adc-pos-bd)]  p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--adc-pos-fg)]  mb-1">
                Strongest GEO Topic
              </p>
              <p className="font-semibold text-sm capitalize">{highlights.strongestGeoTopic.topic}</p>
              <div className="mt-1 flex items-center gap-2">
                <span className="text-xs text-muted-foreground">
                  {highlights.strongestGeoTopic.impressions.toLocaleString()} impressions ·{" "}
                  {highlights.strongestGeoTopic.coverageStrength} coverage
                </span>
                <span className="rounded-full bg-[var(--adc-pos-bg)]  px-2 py-0.5 text-xs font-semibold text-[var(--adc-pos-fg)] ">
                  GEO {highlights.strongestGeoTopic.geoScore}
                </span>
              </div>
            </div>
          )}
          {highlights.highestAiValueSource && (
            <div className="rounded-xl border bg-[var(--adc-info-bg)]  border-[var(--adc-info-bd)]  p-4">
              <p className="text-xs font-medium uppercase tracking-wide text-[var(--adc-info-fg)]  mb-1">
                Highest AI Value Source
              </p>
              <p className="font-semibold text-sm">{highlights.highestAiValueSource.engine}</p>
              <div className="mt-1 flex items-center gap-2">
                <span className={cn(
                  "rounded-full px-2 py-0.5 text-xs font-semibold capitalize",
                  highlights.highestAiValueSource.label === "elite"
                    ? "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)]  "
                    : highlights.highestAiValueSource.label === "strong"
                    ? "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]  "
                    : "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]  "
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
