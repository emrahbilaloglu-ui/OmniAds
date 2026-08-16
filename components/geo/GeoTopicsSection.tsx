"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { cn } from "@/lib/utils";
import { GeoScoreBreakdown, GeoMomentumBadge } from "./GeoScoreBreakdown";

interface TopicRecommendation {
  title: string;
  effort: string;
  impact: string;
  expectedOutcome: string;
}

interface TopicCluster {
  topic: string;
  queryCount: number;
  impressions: number;
  clicks: number;
  avgPosition: number;
  geoScore: number;
  geoScoreBreakdown?: Record<string, number>;
  coverageStrength: "Strong" | "Moderate" | "Weak";
  coverageGap?: "high" | "medium" | "low";
  authorityStrength?: string;
  queries: string[];
  priority?: "high" | "medium" | "low";
  confidence?: "high" | "medium" | "low";
  momentum?: {
    status: "breakout" | "rising" | "stable" | "declining";
    label: string;
    score: number;
    growthRate: number;
  };
  recommendation?: TopicRecommendation | null;
}

function fmt(n: number): string {
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

const STRENGTH_CONFIG = {
  Strong: {
    cls: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]  ",
    bar: "bg-[var(--adc-pos-fg)]",
  },
  Moderate: {
    cls: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]  ",
    bar: "bg-[var(--adc-caution-fg)]",
  },
  Weak: {
    cls: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]  ",
    bar: "bg-[var(--adc-danger-fg)]",
  },
};

const COVERAGE_GAP_CONFIG: Record<"high" | "medium" | "low", string> = {
  high: "text-[var(--adc-danger-fg)] ",
  medium: "text-[var(--adc-caution-fg)] ",
  low: "text-muted-foreground",
};

const PRIORITY_COLOR = {
  high: "text-[var(--adc-danger-fg)] ",
  medium: "text-[var(--adc-caution-fg)] ",
  low: "text-muted-foreground",
};

function GeoScorePill({
  score,
  breakdown,
}: {
  score: number;
  breakdown?: Record<string, number>;
}) {
  const [expanded, setExpanded] = useState(false);
  const cls =
    score >= 60
      ? "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)]  "
      : score >= 35
      ? "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]  "
      : "bg-muted text-muted-foreground";
  return (
    <div>
      <button
        onClick={() => breakdown && setExpanded(!expanded)}
        className={cn(
          "rounded-full px-2 py-0.5 text-xs font-semibold",
          cls,
          breakdown ? "cursor-pointer hover:opacity-80" : ""
        )}
        title={breakdown ? "Click to see score breakdown" : undefined}
      >
        GEO {score}
      </button>
      {expanded && breakdown && (
        <GeoScoreBreakdown breakdown={breakdown} total={score} className="mt-1" />
      )}
    </div>
  );
}

interface GeoTopicsSectionProps {
  topics?: TopicCluster[];
  isLoading: boolean;
}

export function GeoTopicsSection({ topics, isLoading }: GeoTopicsSectionProps) {
  if (isLoading) {
    return (
      <div className="space-y-3">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-24 w-full rounded-xl" />
        ))}
      </div>
    );
  }

  if (!topics || topics.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-10 text-center">
        <p className="text-sm font-medium">No topic clusters yet</p>
        <p className="mt-1 text-xs text-muted-foreground">
          Connect Search Console to surface topic authority signals.
        </p>
      </div>
    );
  }

  const maxImpressions = Math.max(...topics.map((t) => t.impressions), 1);

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Topic clusters scored for GEO authority with momentum tracking. Strong coverage = many
        queries ranking for this topic. Click a GEO score to see its breakdown. Momentum compares
        to the previous equivalent period.
      </p>
      <div className="grid gap-2.5">
        {topics.slice(0, 20).map((topic) => {
          const cfg = STRENGTH_CONFIG[topic.coverageStrength];
          const barWidth = Math.min(100, (topic.impressions / maxImpressions) * 100);
          return (
            <div key={topic.topic} className="rounded-xl border border-[var(--adv-border)] bg-white p-4">
              <div className="flex items-start justify-between gap-3">
                <div className="min-w-0 flex-1">
                  {/* Topic name + badges */}
                  <div className="flex items-center gap-2 flex-wrap">
                    <span className="font-semibold capitalize">{topic.topic}</span>
                    <span className={cn("rounded-full px-2 py-0.5 text-xs font-medium", cfg.cls)}>
                      {topic.coverageStrength}
                    </span>
                    {topic.momentum && (
                      <GeoMomentumBadge
                        status={topic.momentum.status}
                        label={topic.momentum.label}
                      />
                    )}
                    {topic.priority && (
                      <span className={cn("text-xs font-medium", PRIORITY_COLOR[topic.priority])}>
                        {topic.priority.charAt(0).toUpperCase() + topic.priority.slice(1)} priority
                      </span>
                    )}
                    {topic.coverageGap && topic.coverageGap !== "low" && (
                      <span
                        className={cn(
                          "text-[10px] font-medium uppercase tracking-wide",
                          COVERAGE_GAP_CONFIG[topic.coverageGap]
                        )}
                      >
                        {topic.coverageGap === "high" ? "↑ High gap" : "↗ Gap opp"}
                      </span>
                    )}
                    <span className="text-xs text-muted-foreground">
                      {topic.queryCount} {topic.queryCount === 1 ? "query" : "queries"}
                    </span>
                  </div>

                  {/* Impression bar */}
                  <div className="mt-2 h-1 w-full rounded-full bg-muted overflow-hidden">
                    <div
                      className={cn("h-full rounded-full transition-all", cfg.bar)}
                      style={{ width: `${barWidth}%` }}
                    />
                  </div>

                  {/* Sample queries */}
                  {topic.queries.length > 0 && (
                    <div className="mt-2 flex flex-wrap gap-1">
                      {topic.queries.slice(0, 3).map((q, i) => (
                        <span
                          key={i}
                          className="rounded bg-muted px-1.5 py-0.5 text-[10px] text-muted-foreground"
                        >
                          {q}
                        </span>
                      ))}
                    </div>
                  )}

                  {/* Recommendation */}
                  {topic.recommendation && (
                    <div className="mt-2 rounded-lg border border-border/50 bg-background/60 px-2.5 py-1.5">
                      <p className="text-[10px] font-medium text-foreground">
                        {topic.recommendation.title}
                      </p>
                      <p className="mt-0.5 text-[10px] text-muted-foreground">
                        <span className="text-[var(--adc-pos-fg)] ">
                          {topic.recommendation.impact}
                        </span>
                        {" · "}
                        {topic.recommendation.effort} effort
                      </p>
                    </div>
                  )}
                </div>

                {/* Right stats */}
                <div className="shrink-0 text-right space-y-0.5">
                  {topic.geoScore !== undefined && (
                    <div className="flex justify-end mb-1">
                      <GeoScorePill score={topic.geoScore} breakdown={topic.geoScoreBreakdown} />
                    </div>
                  )}
                  <p className="text-sm font-semibold">{fmt(topic.impressions)}</p>
                  <p className="text-xs text-muted-foreground">impressions</p>
                  <p className="text-sm tabular-nums">{fmt(topic.clicks)}</p>
                  <p className="text-xs text-muted-foreground">clicks</p>
                  <p className="text-xs text-muted-foreground">
                    avg pos {topic.avgPosition.toFixed(1)}
                  </p>
                  {topic.authorityStrength && (
                    <p className="text-[10px] text-muted-foreground capitalize">
                      {topic.authorityStrength} authority
                    </p>
                  )}
                </div>
              </div>
            </div>
          );
        })}
      </div>
    </div>
  );
}
