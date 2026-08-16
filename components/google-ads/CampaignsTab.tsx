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
  Search: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] dark:bg-[var(--adc-info-fg)]/40 dark:text-[var(--adc-info-fg)]",
  Shopping: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] dark:bg-[var(--adc-caution-fg)]/40 dark:text-[var(--adc-caution-fg)]",
  "Performance Max": "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)] dark:bg-[var(--adc-auto-fg)]/40 dark:text-[var(--adc-auto-fg)]",
  Display: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] dark:bg-[var(--adc-info-fg)]/40 dark:text-[var(--adc-info-fg)]",
  Video: "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)] dark:bg-[var(--adc-danger-fg)]/40 dark:text-[var(--adc-danger-fg)]",
  App: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] dark:bg-[var(--adc-pos-fg)]/40 dark:text-[var(--adc-pos-fg)]",
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
          <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold", CHANNEL_COLORS[r.channel] ?? "bg-muted text-muted-foreground")}>
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
      <span className={cn("font-semibold", r.roas >= 3 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)]" : r.roas < 1 ? "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]" : "")}>
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
      ? <span className="text-[var(--adc-caution-fg)] dark:text-[var(--adc-caution-fg)]">{fmtPercent(r.lostIsBudget * 100)}</span>
      : "—",
  },
  {
    key: "lostIsRank", header: "Lost IS (Rank)", accessor: (r) => r.lostIsRank ?? 0, align: "right",
    render: (r) => r.lostIsRank != null && r.lostIsRank > 0
      ? <span className="text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]">{fmtPercent(r.lostIsRank * 100)}</span>
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
