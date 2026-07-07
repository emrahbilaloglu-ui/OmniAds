"use client";

import { SortableTable, type ColumnDef } from "./SortableTable";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrencySmart, formatPercentFromRatioSmart } from "@/lib/metric-format";

interface AudienceSegment {
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  purchases: number;
  revenue: number;
  purchaseCvr: number;
}

interface ChannelRow {
  sourceMedium: string;
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  purchases: number;
  revenue: number;
  purchaseCvr: number;
}

function fmt(n: number, type: "number" | "percent" | "currency" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (type === "currency") {
    return formatCurrencySmart(n, "$");
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

const channelColumns: ColumnDef<ChannelRow>[] = [
  {
    key: "sourceMedium",
    header: "Source / Medium",
    accessor: (r) => r.sourceMedium,
    sticky: true,
    render: (r) => (
      <span className="font-mono text-xs" title={r.sourceMedium}>
        {r.sourceMedium}
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
];

interface AudienceSectionProps {
  segments?: Record<string, AudienceSegment>;
  channels?: ChannelRow[];
  isLoading: boolean;
}

export function AudienceSection({
  segments,
  channels,
  isLoading,
}: AudienceSectionProps) {
  const newSeg = segments?.new;
  const returnSeg = segments?.returning;

  const multiplier =
    newSeg && returnSeg && newSeg.purchaseCvr > 0
      ? returnSeg.purchaseCvr / newSeg.purchaseCvr
      : 0;

  if (isLoading) {
    return (
      <div className="space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Skeleton className="h-28 rounded-xl" />
          <Skeleton className="h-28 rounded-xl" />
        </div>
        <div className="space-y-2">
          {Array.from({ length: 5 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      </div>
    );
  }

  return (
    <div className="space-y-6">
      {/* New vs Returning comparison */}
      {newSeg && returnSeg && (
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            New vs Returning Visitors
          </p>
          <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
            <SegmentCard
              label="New Visitors"
              segment={newSeg}
            />
            <SegmentCard
              label="Returning Visitors"
              segment={returnSeg}
              multiplierVs={newSeg.purchaseCvr}
              multiplier={multiplier}
            />
          </div>
        </div>
      )}

      {/* Channel / Source quality table */}
      <div>
        <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
          Traffic Source Quality
        </p>
        <p className="mb-3 text-sm text-muted-foreground">
          Which sources bring high-quality, converting visitors?
        </p>
        <SortableTable
          columns={channelColumns}
          rows={channels ?? []}
          defaultSortKey="sessions"
          emptyText="No channel data found for this date range."
        />
      </div>
    </div>
  );
}

function SegmentCard({
  label,
  segment,
  multiplier,
  multiplierVs,
}: {
  label: string;
  segment: AudienceSegment;
  multiplier?: number;
  multiplierVs?: number;
}) {
  const isBetter = multiplier !== undefined && multiplierVs !== undefined && multiplier >= 1.3;
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-center justify-between mb-3">
        <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
          {label}
        </p>
        {isBetter && (
          <span className="rounded-full bg-emerald-100 px-2 py-0.5 text-xs font-semibold text-emerald-700 dark:bg-emerald-900/40 dark:text-emerald-300">
            {multiplier!.toFixed(1)}× better CVR
          </span>
        )}
      </div>
      <div className="grid grid-cols-3 gap-2">
        <Metric label="Sessions" value={fmt(segment.sessions)} />
        <Metric label="Engagement" value={fmt(segment.engagementRate, "percent")} />
        <Metric
          label="Purchase CVR"
          value={fmt(segment.purchaseCvr, "percent")}
          highlight={isBetter}
        />
      </div>
    </div>
  );
}

function Metric({
  label,
  value,
  highlight,
}: {
  label: string;
  value: string;
  highlight?: boolean;
}) {
  return (
    <div>
      <p className="text-xs text-muted-foreground">{label}</p>
      <p
        className={`text-base font-semibold ${highlight ? "text-emerald-600 dark:text-emerald-400" : ""}`}
      >
        {value}
      </p>
    </div>
  );
}
