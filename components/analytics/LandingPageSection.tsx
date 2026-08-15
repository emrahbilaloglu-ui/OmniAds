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
      <span className="ml-1.5 rounded-full bg-[var(--adc-pos-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--adc-pos-fg)]">
        strong
      </span>
    );
  if (rate < threshold * 0.5)
    return (
      <span className="ml-1.5 rounded-full bg-[var(--adc-danger-bg)] px-1.5 py-0.5 text-[10px] font-semibold text-[var(--adc-danger-fg)]">
        weak
      </span>
    );
  return null;
}

/**
 * The design's Signal column: the one thing that is off about this page, read
 * from the served rates rather than from an opinion. A page whose rates are all
 * healthy carries no signal.
 */
function pageSignal(row: LandingPageRow): { label: string; bg: string; fg: string } | null {
  if (row.sessions >= 50 && row.purchases === 0) {
    return { label: "traffic, no purchase", bg: "var(--adc-danger-bg)", fg: "var(--adc-danger-fg)" };
  }
  if (typeof row.bounceRate === "number" && row.bounceRate >= 0.7) {
    return { label: "high bounce", bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
  }
  if (typeof row.engagementRate === "number" && row.engagementRate > 0 && row.engagementRate < 0.4) {
    return { label: "weak engagement", bg: "var(--adc-caution-bg)", fg: "var(--adc-caution-fg)" };
  }
  if (row.purchases > 0 && row.purchaseCvr >= 0.03) {
    return { label: "converting", bg: "var(--adc-pos-bg)", fg: "var(--adc-pos-fg)" };
  }
  return null;
}

const columns: ColumnDef<LandingPageRow>[] = [
  {
    key: "path",
    header: "Page",
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
    header: "Engagement rate",
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
    header: "Avg time",
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
    header: "Bounce rate",
    accessor: (r) => r.bounceRate,
    align: "right",
    heatmap: true,
    heatmapInvert: true,
    render: (r) => fmt(r.bounceRate, "percent"),
  },
  {
    key: "signal",
    header: "Signal",
    accessor: (r) => pageSignal(r)?.label ?? "",
    render: (r) => {
      const signal = pageSignal(r);
      if (!signal) return <span className="text-[var(--adv-ink-4)]">—</span>;
      return (
        <span
          className="inline-flex whitespace-nowrap rounded-md px-2 py-0.5 text-[11px] font-semibold"
          style={{ background: signal.bg, color: signal.fg }}
        >
          {signal.label}
        </span>
      );
    },
  },
];

const MAX_ROWS = 50;

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

  const rows = pages ?? [];
  const shown = Math.min(rows.length, MAX_ROWS);

  return (
    <div className="space-y-3">
      <SortableTable
        columns={columns}
        rows={rows}
        defaultSortKey="sessions"
        maxRows={MAX_ROWS}
        emptyText="No landing page data found for this date range."
      />
      {rows.length > 0 ? (
        <p className="m-0 font-[family-name:var(--adv-font-mono)] text-[10.5px] text-[var(--adv-ink-4)]">
          Showing {shown} of up to {MAX_ROWS} rows · sorted by sessions · page
          fixes route to Launchpad as lander drafts.
        </p>
      ) : null}
    </div>
  );
}
