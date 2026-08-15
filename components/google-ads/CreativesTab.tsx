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
  Best: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] dark:bg-[var(--adc-pos-fg)]/40 dark:text-[var(--adc-pos-fg)]",
  Good: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] dark:bg-[var(--adc-info-fg)]/40 dark:text-[var(--adc-info-fg)]",
  Low: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)] dark:bg-[var(--adc-danger-fg)]/40 dark:text-[var(--adc-danger-fg)]",
  Learning: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] dark:bg-[var(--adc-caution-fg)]/40 dark:text-[var(--adc-caution-fg)]",
  Unknown: "bg-muted text-muted-foreground",
};

const cols: ColDef<Creative>[] = [
  {
    key: "name", header: "Asset Group", accessor: (r) => r.name,
    render: (r) => (
      <div className="max-w-[180px]">
        <p className="text-xs font-medium truncate" title={r.name}>{r.name}</p>
        <div className="flex items-center gap-1 mt-0.5">
          <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold", STRENGTH_CONFIG[r.adStrength ?? "Unknown"])}>
            {r.adStrength ?? "Unknown"}
          </span>
          <span className="text-[9px] text-muted-foreground">{r.type}</span>
          {typeof r.assetCount === "number" ? (
            <span className="text-[9px] text-muted-foreground">· {r.assetCount} assets</span>
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
      <span className={cn(r.roas >= 3 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)] font-semibold" : "")}>
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
            <div key={i} className="rounded-xl border border-[var(--adc-caution-bd)] dark:border-[var(--adc-caution-bd)]/50 bg-[var(--adc-caution-bg)] dark:bg-[var(--adc-caution-fg)]/30 px-4 py-3">
              <p className="text-xs text-foreground">△ {ins}</p>
            </div>
          ))}
        </div>
      )}
      <SimpleTable cols={cols} rows={creatives} defaultSort="spend" />
    </div>
  );
}
