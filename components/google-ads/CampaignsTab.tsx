"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtPercent, fmtRoas, TabSkeleton, TabEmpty, StatusBadge, CampaignBadges, SimpleTable, ColDef } from "./shared";

interface Campaign {
  id: string;
  name: string;
  status: string;
  channel: string;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  cpc: number;
  impressions: number;
  clicks: number;
  impressionShare: number | null;
  lostIsBudget: number | null;
  lostIsRank: number | null;
  badges: string[];
}

const CHANNEL_COLORS: Record<string, string> = {
  Search: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Shopping: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "Performance Max": "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  Display: "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
  Video: "bg-rose-100 text-rose-800 dark:bg-rose-900/40 dark:text-rose-300",
  App: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
};

const cols: ColDef<Campaign>[] = [
  {
    key: "name",
    header: "Campaign",
    accessor: (r) => r.name,
    render: (r) => (
      <div className="max-w-[180px]">
        <p className="font-medium truncate text-xs" title={r.name}>{r.name}</p>
        <div className="flex items-center gap-1 mt-0.5 flex-wrap">
          <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold", CHANNEL_COLORS[r.channel] ?? "bg-muted text-muted-foreground")}>
            {r.channel}
          </span>
          <StatusBadge status={r.status} />
        </div>
        {r.badges.length > 0 && (
          <div className="mt-1">
            <CampaignBadges badges={r.badges} />
          </div>
        )}
      </div>
    ),
  },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  { key: "revenue", header: "Conv. Value", accessor: (r) => r.revenue, align: "right", render: (r) => fmtCurrency(r.revenue) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => (
      <span className={cn("font-semibold", r.roas >= 3 ? "text-emerald-600 dark:text-emerald-400" : r.roas < 1 ? "text-rose-600 dark:text-rose-400" : "")}>
        {fmtRoas(r.roas)}
      </span>
    ),
  },
  { key: "cpa", header: "CPA", accessor: (r) => r.cpa, align: "right", render: (r) => fmtCurrency(r.cpa) },
  { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
  { key: "impressions", header: "Impr.", accessor: (r) => r.impressions, align: "right", render: (r) => fmtNumber(r.impressions) },
  { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
  {
    key: "impressionShare", header: "Impr. Share", accessor: (r) => r.impressionShare ?? 0, align: "right",
    render: (r) => r.impressionShare != null ? fmtPercent(r.impressionShare * 100) : "—",
  },
  {
    key: "lostIsBudget", header: "Lost IS (Budget)", accessor: (r) => r.lostIsBudget ?? 0, align: "right",
    render: (r) => r.lostIsBudget != null && r.lostIsBudget > 0
      ? <span className="text-amber-600 dark:text-amber-400">{fmtPercent(r.lostIsBudget * 100)}</span>
      : "—",
  },
  {
    key: "lostIsRank", header: "Lost IS (Rank)", accessor: (r) => r.lostIsRank ?? 0, align: "right",
    render: (r) => r.lostIsRank != null && r.lostIsRank > 0
      ? <span className="text-rose-600 dark:text-rose-400">{fmtPercent(r.lostIsRank * 100)}</span>
      : "—",
  },
];

interface CampaignsTabProps {
  campaigns?: Campaign[];
  isLoading: boolean;
  emptyMessage?: string;
}

export function CampaignsTab({ campaigns, isLoading, emptyMessage }: CampaignsTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!campaigns || campaigns.length === 0) {
    return <TabEmpty message={emptyMessage ?? "No campaign data found for this period."} />;
  }

  return (
    <div className="space-y-4">
      <p className="text-sm text-muted-foreground">
        Campaign performance with impression share and lost IS signals. Click column headers to sort.
        Badges highlight campaigns needing attention.
      </p>
      <SimpleTable cols={cols} rows={campaigns} defaultSort="spend" />
    </div>
  );
}
