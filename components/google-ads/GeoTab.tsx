"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtRoas, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";

interface GeoRow {
  country: string;
  impressions: number;
  clicks: number;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  convRate?: number;
  conversionRate?: number;
  vsAvgCpa: number | null;
}

const cols: ColDef<GeoRow>[] = [
  { key: "country", header: "Country", accessor: (r) => r.country, render: (r) => <span className="text-xs font-medium">{r.country}</span> },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => (
      <span className={cn(r.roas >= 3 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)] font-semibold" : r.roas < 1 ? "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]" : "")}>
        {r.roas === 0 ? "—" : fmtRoas(r.roas)}
      </span>
    ),
  },
  { key: "cpa", header: "CPA", accessor: (r) => r.cpa === 0 ? 99999 : r.cpa, align: "right", render: (r) => r.conversions === 0 ? "—" : fmtCurrency(r.cpa) },
  {
    key: "vsAvgCpa", header: "vs Avg CPA", accessor: (r) => r.vsAvgCpa ?? 0, align: "right",
    render: (r) =>
      r.vsAvgCpa == null ? "—" : (
        <span className={cn(r.vsAvgCpa < -10 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)] font-semibold" : r.vsAvgCpa > 20 ? "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]" : "text-muted-foreground")}>
          {r.vsAvgCpa > 0 ? "+" : ""}{r.vsAvgCpa}%
        </span>
      ),
  },
  { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
  { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
  { key: "impressions", header: "Impr.", accessor: (r) => r.impressions, align: "right", render: (r) => fmtNumber(r.impressions) },
];

interface GeoTabProps {
  geoData?: GeoRow[];
  insights?: string[];
  isLoading: boolean;
}

export function GeoTab({ geoData, insights, isLoading }: GeoTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!geoData || geoData.length === 0) {
    return <TabEmpty message="No geographic data found. Requires campaigns with geographic targeting." />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Performance by country. "vs Avg CPA" shows how each location compares to your account average.
        Green = below average CPA (more efficient). Red = above average.
      </p>
      {insights && insights.length > 0 && (
        <div className="space-y-2">
          {insights.map((ins, i) => (
            <div key={i} className="rounded-xl border border-[var(--adc-info-bd)] dark:border-[var(--adc-info-bd)]/50 bg-[var(--adc-info-bg)] dark:bg-[var(--adc-info-fg)]/30 px-4 py-3">
              <p className="text-xs text-foreground">◈ {ins}</p>
            </div>
          ))}
        </div>
      )}
      <SimpleTable cols={cols} rows={geoData} defaultSort="spend" />
    </div>
  );
}
