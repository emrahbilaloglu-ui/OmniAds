"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { SortableTable, type ColumnDef } from "@/components/analytics/SortableTable";
import { formatCurrencySmart, formatPercentFromRatioSmart } from "@/lib/metric-format";
import { AiTrafficValueBadge, GeoMomentumBadge } from "./GeoScoreBreakdown";

interface AiSource {
  engine: string;
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  purchases: number;
  revenue: number;
  purchaseCvr: number;
  sources: string[];
  aiTrafficValueScore?: number;
  aiTrafficValueLabel?: "weak" | "promising" | "strong" | "elite";
  momentum?: {
    status: "breakout" | "rising" | "stable" | "declining";
    label: string;
    score: number;
    growthRate: number;
  };
  recommendation?: string | null;
}

const ENGINE_COLORS: Record<string, string> = {
  ChatGPT: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  Perplexity: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  Gemini: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Copilot: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  Claude: "bg-orange-100 text-orange-800 dark:bg-orange-900/40 dark:text-orange-300",
  "You.com": "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
  Phind: "bg-slate-100 text-slate-800 dark:bg-slate-900/40 dark:text-slate-300",
  "Other AI": "bg-muted text-muted-foreground",
};

function fmt(n: number, type: "number" | "percent" | "currency" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (type === "currency") {
    return formatCurrencySmart(n, "$");
  }
  if (n >= 1000) return `${(n / 1000).toFixed(1)}K`;
  return n.toFixed(0);
}

const columns: ColumnDef<AiSource>[] = [
  {
    key: "engine",
    header: "AI Engine",
    accessor: (r) => r.engine,
    sticky: true,
    render: (r) => {
      const cls = ENGINE_COLORS[r.engine] ?? ENGINE_COLORS["Other AI"];
      return (
        <span className={`rounded-full px-2.5 py-0.5 text-xs font-semibold ${cls}`}>
          {r.engine}
        </span>
      );
    },
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
    key: "sessions",
    header: "Sessions",
    accessor: (r) => r.sessions,
    align: "right",
    render: (r) => fmt(r.sessions),
  },
  {
    key: "engagementRate",
    header: "Engagement Rate",
    accessor: (r) => r.engagementRate,
    align: "right",
    heatmap: true,
    render: (r) => fmt(r.engagementRate, "percent"),
  },
  {
    key: "purchases",
    header: "Purchases",
    accessor: (r) => r.purchases,
    align: "right",
    render: (r) => fmt(r.purchases),
  },
  {
    key: "purchaseCvr",
    header: "Purchase CVR",
    accessor: (r) => r.purchaseCvr,
    align: "right",
    heatmap: true,
    render: (r) => fmt(r.purchaseCvr, "percent"),
  },
  {
    key: "revenue",
    header: "Revenue",
    accessor: (r) => r.revenue,
    align: "right",
    render: (r) => fmt(r.revenue, "currency"),
  },
  {
    key: "recommendation",
    header: "Recommendation",
    accessor: (r) => r.recommendation ?? "",
    sortable: false,
    render: (r) =>
      r.recommendation ? (
        <span
          className="rounded bg-muted px-1.5 py-0.5 text-[12px] block truncate max-w-[160px]"
          title={r.recommendation}
        >
          {r.recommendation}
        </span>
      ) : null,
  },
];

interface AiTrafficSourcesSectionProps {
  sources?: AiSource[];
  isLoading: boolean;
}

export function AiTrafficSourcesSection({
  sources,
  isLoading,
}: AiTrafficSourcesSectionProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 5 }).map((_, i) => (
          <Skeleton key={i} className="h-10 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  if (!sources || sources.length === 0) {
    return (
      <div className="rounded-xl border border-dashed py-10 text-center">
        <p className="text-sm font-medium">No AI-source traffic detected yet</p>
        <p className="mt-1 text-xs text-muted-foreground max-w-sm mx-auto">
          Traffic from ChatGPT, Perplexity, Gemini, Copilot, Claude, and other AI engines
          will appear here once users discover your content via these platforms.
        </p>
      </div>
    );
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Sessions arriving from known AI discovery engines. AI Value score reflects quality
        relative to your site average. Momentum compares to the previous equivalent period.
      </p>
      <SortableTable
        columns={columns}
        rows={sources}
        defaultSortKey="sessions"
        emptyText="No AI-source traffic found for this date range."
      />
    </div>
  );
}
