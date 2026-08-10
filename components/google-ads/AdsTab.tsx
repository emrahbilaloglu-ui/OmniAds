"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtRoas, TabSkeleton, TabEmpty, StatusBadge, SimpleTable, ColDef } from "./shared";

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

const cols: ColDef<Ad>[] = [
  {
    key: "headline", header: "Ad", accessor: (r) => r.headline,
    render: (r) => (
      <div className="max-w-[220px]">
        <p className="text-xs font-medium truncate" title={r.headline || r.id}>{r.headline || r.id || "—"}</p>
        {r.description && (
          <p className="text-[12px] text-muted-foreground truncate" title={r.description}>{r.description}</p>
        )}
        <div className="flex items-center gap-1 mt-0.5">
          <StatusBadge status={r.status} />
          <span className="text-[12px] text-muted-foreground">{r.type?.replace(/_/g, " ")}</span>
          {r.adStrength ? <span className="text-[12px] text-muted-foreground">· {r.adStrength}</span> : null}
        </div>
      </div>
    ),
  },
  { key: "campaign", header: "Campaign", accessor: (r) => r.campaign, render: (r) => <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{r.campaign}</span> },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  {
    key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right",
    render: (r) => (
      <span className={cn(r.ctr >= 5 ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "")}>
        {r.ctr.toFixed(1)}%
      </span>
    ),
  },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  {
    key: "convRate",
    header: "Conv. Rate",
    accessor: (r) => r.conversionRate ?? r.convRate ?? 0,
    align: "right",
    render: (r) => `${(r.conversionRate ?? r.convRate ?? 0).toFixed(1)}%`,
  },
  { key: "cpa", header: "CPA", accessor: (r) => r.cpa === 0 ? 99999 : r.cpa, align: "right", render: (r) => r.conversions === 0 ? "—" : fmtCurrency(r.cpa) },
  { key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right", render: (r) => r.roas === 0 ? "—" : fmtRoas(r.roas) },
];

interface AdsTabProps {
  ads?: Ad[];
  insights?: AdsInsights;
  isLoading: boolean;
}

export function AdsTab({ ads, insights, isLoading }: AdsTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!ads || ads.length === 0) {
    return <TabEmpty message="No ad performance data found for this period." />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Analyse ad copy performance. High CTR with low conversion rate signals a landing page issue.
        Pause underperforming ads to concentrate budget on winners.
      </p>

      {insights && insights.topPerformerCtr > insights.bottomPerformerCtr * 1.3 && (
        <div className="rounded-xl border bg-amber-50 dark:bg-amber-950/30 border-amber-200 dark:border-amber-900/50 p-4">
          <p className="text-sm font-semibold">Top ads CTR ({insights.topPerformerCtr.toFixed(1)}%) vs bottom ({insights.bottomPerformerCtr.toFixed(1)}%)</p>
          <p className="text-xs text-muted-foreground mt-0.5">
            Pause bottom-quartile ads and test new copy inspired by your best performers.
          </p>
        </div>
      )}

      <SimpleTable cols={cols} rows={ads} defaultSort="spend" />
    </div>
  );
}
