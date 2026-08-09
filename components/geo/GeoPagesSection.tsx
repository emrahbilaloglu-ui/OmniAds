"use client";

import { useState } from "react";
import { Skeleton } from "@/components/ui/skeleton";
import { SortableTable, type ColumnDef } from "@/components/analytics/SortableTable";
import { formatPercentFromRatioSmart } from "@/lib/metric-format";
import { cn } from "@/lib/utils";
import {
  GeoScoreBreakdown,
  GeoMomentumBadge,
  AiTrafficValueBadge,
  PageReadinessBadge,
} from "./GeoScoreBreakdown";

interface GeoPage {
  path: string;
  aiSessions: number;
  engagementRate: number;
  purchases: number;
  purchaseCvr: number;
  geoScore: number;
  geoScoreBreakdown?: Record<string, number>;
  aiTrafficValueScore?: number;
  aiTrafficValueLabel?: "weak" | "promising" | "strong" | "elite";
  pageReadinessScore?: number;
  pageReadinessLabel?: "weak" | "developing" | "strong" | "excellent";
  momentum?: {
    status: "breakout" | "rising" | "stable" | "declining";
    label: string;
    score: number;
    growthRate: number;
  };
  priority: "high" | "medium" | "low";
  effort: "low" | "medium" | "high";
  confidence: "high" | "medium" | "low";
  strongestSignal: string;
  recommendation: string | null;
}

function fmt(n: number, type: "number" | "percent" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

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
      ? "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300"
      : score >= 30
      ? "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300"
      : "bg-muted text-muted-foreground";
  return (
    <div className="text-right">
      <button
        onClick={() => breakdown && setExpanded(!expanded)}
        className={cn(
          "rounded-full px-2 py-0.5 text-xs font-semibold",
          cls,
          breakdown ? "cursor-pointer hover:opacity-80" : ""
        )}
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

function PriorityBadge({ priority }: { priority: "high" | "medium" | "low" }) {
  const cls = {
    high: "bg-rose-100 text-rose-700 dark:bg-rose-900/40 dark:text-rose-300",
    medium: "bg-amber-100 text-amber-700 dark:bg-amber-900/40 dark:text-amber-300",
    low: "bg-muted text-muted-foreground",
  }[priority];
  return (
    <span className={cn("rounded-full px-2 py-0.5 text-[12px] font-semibold uppercase", cls)}>
      {priority}
    </span>
  );
}

const columns: ColumnDef<GeoPage>[] = [
  {
    key: "path",
    header: "Landing Page",
    accessor: (r) => r.path,
    sticky: true,
    render: (r) => (
      <span className="font-mono text-xs max-w-[160px] truncate block" title={r.path}>
        {r.path}
      </span>
    ),
  },
  {
    key: "geoScore",
    header: "GEO Score",
    accessor: (r) => r.geoScore,
    align: "right",
    render: (r) => <GeoScorePill score={r.geoScore} breakdown={r.geoScoreBreakdown} />,
  },
  {
    key: "pageReadinessLabel",
    header: "Readiness",
    accessor: (r) => ({ weak: 0, developing: 1, strong: 2, excellent: 3 }[r.pageReadinessLabel ?? "developing"]),
    align: "right",
    render: (r) =>
      r.pageReadinessLabel ? (
        <PageReadinessBadge label={r.pageReadinessLabel} score={r.pageReadinessScore} />
      ) : null,
  },
  {
    key: "aiTrafficValueLabel",
    header: "AI Value",
    accessor: (r) => ({ weak: 0, promising: 1, strong: 2, elite: 3 }[r.aiTrafficValueLabel ?? "weak"]),
    align: "right",
    render: (r) =>
      r.aiTrafficValueLabel ? (
        <AiTrafficValueBadge label={r.aiTrafficValueLabel} score={r.aiTrafficValueScore} />
      ) : null,
  },
  {
    key: "momentum",
    header: "Momentum",
    accessor: (r) => r.momentum?.score ?? 50,
    sortable: false,
    render: (r) =>
      r.momentum ? (
        <GeoMomentumBadge status={r.momentum.status} label={r.momentum.label} />
      ) : null,
  },
  {
    key: "aiSessions",
    header: "AI Sessions",
    accessor: (r) => r.aiSessions,
    align: "right",
    render: (r) => fmt(r.aiSessions),
  },
  {
    key: "engagementRate",
    header: "Engagement",
    accessor: (r) => r.engagementRate,
    align: "right",
    heatmap: true,
    render: (r) => fmt(r.engagementRate, "percent"),
  },
  {
    key: "priority",
    header: "Priority",
    accessor: (r) => ({ high: 0, medium: 1, low: 2 }[r.priority]),
    align: "right",
    render: (r) => <PriorityBadge priority={r.priority} />,
  },
  {
    key: "recommendation",
    header: "Action",
    accessor: (r) => r.recommendation ?? "",
    sortable: false,
    render: (r) =>
      r.recommendation ? (
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-[12px] block truncate max-w-[150px]"
          title={r.recommendation}
        >
          {r.recommendation}
        </span>
      ) : null,
  },
];

interface GeoPagesSectionProps {
  pages?: GeoPage[];
  isLoading: boolean;
}

export function GeoPagesSection({ pages, isLoading }: GeoPagesSectionProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Pages receiving AI-origin traffic scored by GEO readiness, AI traffic value, and momentum.
        Click a GEO score to see its breakdown. Readiness reflects structural suitability for AI
        discovery; AI Value reflects conversion quality relative to site average.
      </p>
      <SortableTable
        columns={columns}
        rows={pages ?? []}
        defaultSortKey="geoScore"
        emptyText="No page-level AI traffic data found. Connect GA4 and ensure a property is selected."
      />
    </div>
  );
}
