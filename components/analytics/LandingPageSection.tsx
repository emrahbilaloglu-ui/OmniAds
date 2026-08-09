"use client";

import { SortableTable, type ColumnDef } from "./SortableTable";
import { Skeleton } from "@/components/ui/skeleton";
import { formatPercentFromRatioSmart } from "@/lib/metric-format";

interface LandingPageRow {
  path: string;
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  avgEngagementTime: number;
  purchases: number;
  purchaseCvr: number;
  bounceRate: number;
}

function fmt(n: number, type: "number" | "percent" | "duration" = "number"): string {
  if (isNaN(n)) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (type === "duration") {
    const mins = Math.floor(n / 60);
    const secs = Math.floor(n % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function QualityBadge({ rate, threshold }: { rate: number; threshold: number }) {
  if (rate >= threshold * 1.5)
    return (
      <span className="ml-1.5 rounded-full bg-emerald-100 px-1.5 py-0.5 text-[12px] font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
        strong
      </span>
    );
  if (rate < threshold * 0.5)
    return (
      <span className="ml-1.5 rounded-full bg-rose-100 px-1.5 py-0.5 text-[12px] font-semibold text-rose-700 dark:bg-rose-900/40 dark:text-rose-300">
        weak
      </span>
    );
  return null;
}

const columns: ColumnDef<LandingPageRow>[] = [
  {
    key: "path",
    header: "Landing Page",
    accessor: (r) => r.path,
    sticky: true,
    render: (r) => (
      <span className="font-mono text-xs max-w-[220px] truncate block" title={r.path}>
        {r.path}
      </span>
    ),
  },
  {
    key: "sessions",
    header: "Sessions",
    accessor: (r) => r.sessions,
    align: "right",
    render: (r) => fmt(r.sessions),
  },
  {
    key: "engagedSessions",
    header: "Engaged",
    accessor: (r) => r.engagedSessions,
    align: "right",
    render: (r) => fmt(r.engagedSessions),
  },
  {
    key: "engagementRate",
    header: "Engagement Rate",
    accessor: (r) => r.engagementRate,
    align: "right",
    heatmap: true,
    render: (r) => (
      <span>
        {fmt(r.engagementRate, "percent")}
        <QualityBadge rate={r.engagementRate} threshold={0.55} />
      </span>
    ),
  },
  {
    key: "avgEngagementTime",
    header: "Avg Time",
    accessor: (r) => r.avgEngagementTime,
    align: "right",
    render: (r) => fmt(r.avgEngagementTime, "duration"),
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
    key: "bounceRate",
    header: "Bounce Rate",
    accessor: (r) => r.bounceRate,
    align: "right",
    heatmap: true,
    heatmapInvert: true,
    render: (r) => fmt(r.bounceRate, "percent"),
  },
];

interface LandingPageSectionProps {
  pages?: LandingPageRow[];
  isLoading: boolean;
}

export function LandingPageSection({ pages, isLoading }: LandingPageSectionProps) {
  if (isLoading) {
    return (
      <div className="space-y-2">
        {Array.from({ length: 6 }).map((_, i) => (
          <Skeleton key={i} className="h-9 w-full rounded-lg" />
        ))}
      </div>
    );
  }

  return (
    <div className="space-y-3">
      <p className="text-sm text-muted-foreground">
        Identify pages that attract traffic but fail to engage or convert.
        Strong/weak badges flag pages relative to site average.
      </p>
      <SortableTable
        columns={columns}
        rows={pages ?? []}
        defaultSortKey="sessions"
        emptyText="No landing page data found for this date range."
      />
    </div>
  );
}
