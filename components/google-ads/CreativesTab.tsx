"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtRoas, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";

interface Creative {
  id: string;
  name: string;
  type: string;
  status: string;
  adStrength?: "Best" | "Good" | "Low" | "Learning" | "Unknown" | null;
  campaign: string;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  impressions: number;
  clicks: number;
  assetCount?: number;
  assetMix?: Record<string, number>;
}

const STRENGTH_CONFIG: Record<string, string> = {
  Best: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  Good: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Low: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  Learning: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  Unknown: "bg-muted text-muted-foreground",
};

const cols: ColDef<Creative>[] = [
  {
    key: "name", header: "Asset Group", accessor: (r) => r.name,
    render: (r) => (
      <div className="max-w-[180px]">
        <p className="text-xs font-medium truncate" title={r.name}>{r.name}</p>
        <div className="flex items-center gap-1 mt-0.5">
          <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold", STRENGTH_CONFIG[r.adStrength ?? "Unknown"])}>
            {r.adStrength ?? "Unknown"}
          </span>
          <span className="text-[12px] text-muted-foreground">{r.type}</span>
          {typeof r.assetCount === "number" ? (
            <span className="text-[12px] text-muted-foreground">· {r.assetCount} assets</span>
          ) : null}
        </div>
      </div>
    ),
  },
  { key: "campaign", header: "Campaign", accessor: (r) => r.campaign, render: (r) => <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{r.campaign}</span> },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  { key: "cpa", header: "CPA", accessor: (r) => r.cpa === 0 ? 99999 : r.cpa, align: "right", render: (r) => r.conversions === 0 ? "—" : fmtCurrency(r.cpa) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => (
      <span className={cn(r.roas >= 3 ? "text-emerald-600 dark:text-emerald-400 font-semibold" : "")}>
        {r.roas === 0 ? "—" : fmtRoas(r.roas)}
      </span>
    ),
  },
  { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
  { key: "impressions", header: "Impr.", accessor: (r) => r.impressions, align: "right", render: (r) => fmtNumber(r.impressions) },
];

interface CreativesTabProps {
  creatives?: Creative[];
  insights?: string[];
  isLoading: boolean;
}

export function CreativesTab({ creatives, insights, isLoading }: CreativesTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!creatives || creatives.length === 0) {
    return <TabEmpty message="No creative data found. Requires Performance Max campaigns with asset groups." />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Creative reporting uses the richest valid Google Ads view available here: asset group
        performance plus asset mix. Asset-level spend and conversion value are not exposed uniformly
        by the API, so this tab stays honest about that limitation.
      </p>
      {insights && insights.length > 0 && (
        <div className="space-y-2">
          {insights.map((ins, i) => (
            <div key={i} className="rounded-xl border border-amber-200 dark:border-amber-900/50 bg-amber-50 dark:bg-amber-950/30 px-4 py-3">
              <p className="text-xs text-foreground">△ {ins}</p>
            </div>
          ))}
        </div>
      )}
      <SimpleTable cols={cols} rows={creatives} defaultSort="spend" />
    </div>
  );
}
