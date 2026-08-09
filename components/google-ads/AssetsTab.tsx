"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import {
  fmtCurrency, fmtNumber, fmtRoas, fmtPercent,
  TabSkeleton, TabEmpty, PerfBadge, PerfLabel, SectionLabel, SimpleTable, ColDef, StatusBadge,
} from "./shared";

interface Ad {
  id: string;
  headline: string;
  description: string;
  type: string;
  adStrength?: string | null;
  status: string;
  adGroup: string;
  campaign: string;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  convRate?: number;
  conversionRate?: number;
  impressions: number;
  clicks: number;
}

interface AdsInsights {
  topPerformerCtr: number;
  bottomPerformerCtr: number;
  bestAd: Ad | null;
  worstAd: Ad | null;
}

type PerfFilter = "all" | "top" | "average" | "underperforming";

function classifyAd(ad: Ad, avgCtr: number): PerfLabel {
  if (ad.impressions < 100) return "average";
  if (ad.ctr >= avgCtr * 1.5) return "top";
  if (ad.ctr < avgCtr * 0.5 && ad.spend > 5) return "underperforming";
  return "average";
}

function getHint(ad: Ad, avgCtr: number): string {
  if (ad.ctr < avgCtr * 0.5 && ad.spend > 5) return "CTR is well below average. Try benefit-driven messaging in the headline.";
  if (ad.conversions === 0 && ad.clicks > 50) return "Clicks but zero conversions — check landing page relevance.";
  if (ad.roas < 1 && ad.spend > 20) return "Spending without profitable returns. Pause and test new copy.";
  return "";
}

interface AssetsTabProps {
  ads?: Ad[];
  insights?: AdsInsights;
  isLoading: boolean;
}

export function AssetsTab({ ads, insights, isLoading }: AssetsTabProps) {
  const [filter, setFilter] = useState<PerfFilter>("all");

  if (isLoading) return <TabSkeleton />;
  if (!ads || ads.length === 0) {
    return <TabEmpty message="No asset performance data found for this period." />;
  }

  const activeAds = ads.filter((a) => a.impressions >= 100);
  const avgCtr = activeAds.length > 0 ? activeAds.reduce((s, a) => s + a.ctr, 0) / activeAds.length : 0;

  const labeled = ads.map((a) => ({ ...a, perf: classifyAd(a, avgCtr) }));
  const topCount = labeled.filter((a) => a.perf === "top").length;
  const underCount = labeled.filter((a) => a.perf === "underperforming").length;

  const FILTERS: { id: PerfFilter; label: string }[] = [
    { id: "all", label: `All (${ads.length})` },
    { id: "top", label: `✦ Top (${topCount})` },
    { id: "average", label: `Average` },
    { id: "underperforming", label: `↓ Under (${underCount})` },
  ];

  const filtered = filter === "all" ? labeled : labeled.filter((a) => a.perf === filter);

  const cols: ColDef<typeof labeled[number]>[] = [
    {
      key: "headline", header: "Asset", accessor: (r) => r.headline,
      render: (r) => (
        <div className="max-w-[220px]">
          <div className="flex items-center gap-1.5 mb-0.5">
            <PerfBadge label={r.perf} />
          </div>
          <p className="text-xs font-medium truncate" title={r.headline || r.id}>{r.headline || r.id || "—"}</p>
          {r.description && <p className="text-[12px] text-muted-foreground truncate">{r.description}</p>}
          <div className="flex items-center gap-1 mt-0.5">
            <StatusBadge status={r.status} />
            <span className="text-[12px] text-muted-foreground">{r.type?.replace(/_/g, " ")}</span>
            {r.adStrength && <span className="text-[12px] text-muted-foreground">· {r.adStrength}</span>}
          </div>
        </div>
      ),
    },
    { key: "campaign", header: "Campaign", accessor: (r) => r.campaign, render: (r) => <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{r.campaign}</span> },
    { key: "impressions", header: "Impr.", accessor: (r) => r.impressions, align: "right", render: (r) => fmtNumber(r.impressions) },
    { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
    {
      key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right",
      render: (r) => (
        <span className={cn(
          "font-medium",
          r.ctr >= avgCtr * 1.5 ? "text-emerald-600 dark:text-emerald-400"
          : r.ctr < avgCtr * 0.5 && r.impressions >= 100 ? "text-rose-600 dark:text-rose-400"
          : ""
        )}>
          {r.ctr.toFixed(1)}%
        </span>
      ),
    },
    { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
    { key: "revenue", header: "Conv. Value", accessor: (r) => r.revenue, align: "right", render: (r) => fmtCurrency(r.revenue) },
    {
      key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
      render: (r) => r.roas === 0 ? "—" : (
        <span className={cn(r.roas >= 3 ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "")}>
          {fmtRoas(r.roas)}
        </span>
      ),
    },
    { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  ];

  // Underperforming ads with hints
  const needsAttention = labeled.filter((a) => a.perf === "underperforming" && getHint(a, avgCtr));

  return (
    <div className="space-y-5">
      {/* Performance summary */}
      <div className="grid grid-cols-3 gap-3">
        <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-3">
          <p className="text-xs text-muted-foreground">Top Performing</p>
          <p className="text-2xl font-bold text-emerald-600 dark:text-emerald-400">{topCount}</p>
          <p className="text-[12px] text-muted-foreground">CTR ≥ {(avgCtr * 1.5).toFixed(1)}%</p>
        </div>
        <div className="rounded-xl border bg-card p-3">
          <p className="text-xs text-muted-foreground">Average</p>
          <p className="text-2xl font-bold">{labeled.filter((a) => a.perf === "average").length}</p>
          <p className="text-[12px] text-muted-foreground">Avg CTR {avgCtr.toFixed(1)}%</p>
        </div>
        <div className={cn("rounded-xl border p-3", underCount > 0 ? "border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30" : "bg-card")}>
          <p className="text-xs text-muted-foreground">Underperforming</p>
          <p className={cn("text-2xl font-bold", underCount > 0 ? "text-rose-600 dark:text-rose-400" : "")}>{underCount}</p>
          <p className="text-[12px] text-muted-foreground">CTR &lt; {(avgCtr * 0.5).toFixed(1)}%</p>
        </div>
      </div>

      {/* Optimization hints */}
      {needsAttention.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>Needs Attention</SectionLabel>
          <div className="space-y-2">
            {needsAttention.slice(0, 3).map((a, i) => {
              const hint = getHint(a, avgCtr);
              return (
                <div key={i} className="rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 px-4 py-3">
                  <p className="text-xs font-semibold truncate">{a.headline || a.id}</p>
                  <p className="text-xs text-muted-foreground mt-0.5">
                    CTR {a.ctr.toFixed(1)}% · {fmtCurrency(a.spend)} spent
                  </p>
                  <p className="text-xs mt-1">→ {hint}</p>
                </div>
              );
            })}
          </div>
        </div>
      )}

      {/* Filter pills */}
      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button
            key={f.id}
            onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.id
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground"
            )}
          >
            {f.label}
          </button>
        ))}
      </div>

      <SimpleTable cols={cols} rows={filtered} defaultSort="spend" emptyText="No assets match this filter." />

    </div>
  );
}
