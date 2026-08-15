"use client";

import { SortableTable, type ColumnDef } from "./SortableTable";
import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrencySmart, formatPercentFromRatioSmart } from "@/lib/metric-format";
import { cn } from "@/lib/utils";

type DemoDimension =
  | "country"
  | "region"
  | "city"
  | "language"
  | "userAgeBracket"
  | "userGender"
  | "brandingInterest";

interface DemoRow {
  value: string;
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  purchases: number;
  revenue: number;
  purchaseCvr: number;
}

interface DemoSummary {
  topValue: string;
  topValuePurchaseCvr: number;
  avgPurchaseCvr: number;
}

const DIMENSION_LABELS: Record<DemoDimension, string> = {
  country: "Country",
  region: "Region",
  city: "City",
  language: "Language",
  userAgeBracket: "Age Group",
  userGender: "Gender",
  brandingInterest: "Interests",
};

function fmt(n: number, type: "number" | "percent" | "currency" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (type === "currency") {
    return formatCurrencySmart(n, "$");
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function buildColumns(dimensionLabel: string): ColumnDef<DemoRow>[] {
  return [
    {
      key: "value",
      header: dimensionLabel,
      accessor: (r) => r.value,
      sticky: true,
      render: (r) => (
        <span className="font-medium max-w-[180px] truncate block" title={r.value}>
          {r.value}
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
      header: "Engagement rate",
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
}

interface DemographicSectionProps {
  dimension: DemoDimension;
  onDimensionChange: (d: DemoDimension) => void;
  rows?: DemoRow[];
  summary?: DemoSummary | null;
  isLoading: boolean;
}

export function DemographicSection({
  dimension,
  onDimensionChange,
  rows,
  summary,
  isLoading,
}: DemographicSectionProps) {
  const dimensionLabel = DIMENSION_LABELS[dimension];
  const columns = buildColumns(dimensionLabel);

  return (
    <div className="space-y-4">
      {/* Dimension selector */}
      <div className="flex flex-wrap gap-2">
        {(Object.keys(DIMENSION_LABELS) as DemoDimension[]).map((d) => (
          <button
            key={d}
            onClick={() => onDimensionChange(d)}
            className={cn( "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              d === dimension
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground"
            )}
          >
            {DIMENSION_LABELS[d]}
          </button>
        ))}
      </div>

      {/* Summary callout */}
      {!isLoading && summary && summary.topValuePurchaseCvr > 0 && (
        <div className="rounded-lg border bg-muted/30 px-4 py-2.5">
          <p className="text-sm">
            <span className="font-semibold">{dimensionLabel} &ldquo;{summary.topValue}&rdquo;</span>
            {" "}has the highest purchase rate at{" "}
            <span className="font-semibold text-[var(--adc-pos-fg)] ">
              {fmt(summary.topValuePurchaseCvr, "percent")}
            </span>
            {summary.avgPurchaseCvr > 0 && (
              <span className="text-muted-foreground">
                {" "}(avg {fmt(summary.avgPurchaseCvr, "percent")})
              </span>
            )}
          </p>
        </div>
      )}

      {/* Table */}
      {isLoading ? (
        <div className="space-y-2">
          {Array.from({ length: 8 }).map((_, i) => (
            <Skeleton key={i} className="h-9 w-full rounded-lg" />
          ))}
        </div>
      ) : (
        <SortableTable
          columns={columns}
          rows={rows ?? []}
          defaultSortKey="sessions"
          emptyText={`No ${dimensionLabel.toLowerCase()} data found for this date range.`}
        />
      )}
    </div>
  );
}
