"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtRoas, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";

interface AudienceRow {
  criterionId: string;
  type: string;
  adGroup: string;
  campaign: string;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  impressions: number;
  clicks: number;
}

interface AudienceSummary {
  type: string;
  conversions: number;
  spend: number;
  roas: number;
}

const TYPE_CONFIG: Record<string, string> = {
  Remarketing: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  "In-Market": "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Affinity: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  "Custom Intent": "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  "Life Events": "bg-pink-100 text-pink-800 dark:bg-pink-900/40 dark:text-pink-300",
  "Similar Audiences": "bg-sky-100 text-sky-800 dark:bg-sky-900/40 dark:text-sky-300",
};

const cols: ColDef<AudienceRow>[] = [
  {
    key: "type", header: "Audience Type", accessor: (r) => r.type,
    render: (r) => (
      <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TYPE_CONFIG[r.type] ?? "bg-muted text-muted-foreground")}>
        {r.type}
      </span>
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
  { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
];

interface AudiencesTabProps {
  audiences?: AudienceRow[];
  insights?: string[];
  summary?: AudienceSummary[];
  isLoading: boolean;
}

export function AudiencesTab({ audiences, insights, summary, isLoading }: AudiencesTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!audiences || audiences.length === 0) {
    return <TabEmpty message="No audience data found. Requires campaigns with audience targeting or observation." />;
  }

  return (
    <div className="space-y-4">
      {insights && insights.length > 0 && (
        <div className="space-y-2">
          {insights.map((ins, i) => (
            <div key={i} className="rounded-xl border border-violet-200 dark:border-violet-900/50 bg-violet-50 dark:bg-violet-950/30 px-4 py-3">
              <p className="text-xs text-foreground">◈ {ins}</p>
            </div>
          ))}
        </div>
      )}

      {/* Type summary */}
      {summary && summary.length > 0 && (
        <div className="grid gap-2 grid-cols-2 sm:grid-cols-3 lg:grid-cols-4">
          {summary.map((s) => (
            <div key={s.type} className="rounded-xl border bg-card p-3">
              <span className={cn("rounded-full px-2 py-0.5 text-xs font-semibold", TYPE_CONFIG[s.type] ?? "bg-muted text-muted-foreground")}>
                {s.type}
              </span>
              <p className="text-sm font-bold mt-2">{fmtRoas(s.roas)}</p>
              <p className="text-[12px] text-muted-foreground">ROAS · {fmtNumber(s.conversions)} conv</p>
            </div>
          ))}
        </div>
      )}

      <SimpleTable cols={cols} rows={audiences} defaultSort="spend" />
    </div>
  );
}
