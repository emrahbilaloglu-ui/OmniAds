"use client";

import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtPercent, fmtRoas, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";

interface Keyword {
  keyword: string;
  matchType: string;
  status: string;
  qualityScore: number | null;
  expectedCtr?: string | null;
  adRelevance?: string | null;
  landingPageExperience?: string | null;
  adGroup: string;
  campaign: string;
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
}

const MATCH_TYPE_CONFIG: Record<string, string> = {
  Exact: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] dark:bg-[var(--adc-info-fg)]/40 dark:text-[var(--adc-info-fg)]",
  Phrase: "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)] dark:bg-[var(--adc-caution-fg)]/40 dark:text-[var(--adc-caution-fg)]",
  Broad: "bg-muted text-muted-foreground",
};

function QsIndicator({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">—</span>;
  const cls =
    score >= 8 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)] font-semibold"
    : score >= 5 ? "text-foreground"
    : "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)] font-semibold";
  return <span className={cls}>{score}/10</span>;
}

const cols: ColDef<Keyword>[] = [
  {
    key: "keyword", header: "Keyword", accessor: (r) => r.keyword,
    render: (r) => (
      <div className="max-w-[180px]">
        <p className="text-xs font-medium truncate" title={r.keyword}>{r.keyword}</p>
        <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold", MATCH_TYPE_CONFIG[r.matchType] ?? "bg-muted text-muted-foreground")}>
          {r.matchType}
        </span>
        {(r.expectedCtr || r.adRelevance || r.landingPageExperience) && (
          <p className="mt-1 text-[9px] text-muted-foreground truncate">
            {r.expectedCtr ?? "n/a"} CTR · {r.adRelevance ?? "n/a"} rel · {r.landingPageExperience ?? "n/a"} LP
          </p>
        )}
      </div>
    ),
  },
  { key: "campaign", header: "Campaign", accessor: (r) => r.campaign, render: (r) => <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{r.campaign}</span> },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  { key: "cpa", header: "CPA", accessor: (r) => r.cpa === 0 ? 99999 : r.cpa, align: "right", render: (r) => r.conversions === 0 ? "—" : fmtCurrency(r.cpa) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => r.roas === 0 ? "—" : (
      <span className={cn(r.roas >= 3 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)]" : "")}>{fmtRoas(r.roas)}</span>
    ),
  },
  {
    key: "qualityScore", header: "QS", accessor: (r) => r.qualityScore ?? 0, align: "right",
    render: (r) => <QsIndicator score={r.qualityScore} />,
  },
  {
    key: "impressionShare", header: "IS", accessor: (r) => r.impressionShare ?? 0, align: "right",
    render: (r) => r.impressionShare != null ? fmtPercent(r.impressionShare * 100) : "—",
  },
  { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
  { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
  { key: "impressions", header: "Impr.", accessor: (r) => r.impressions, align: "right", render: (r) => fmtNumber(r.impressions) },
];

interface KeywordsTabProps {
  keywords?: Keyword[];
  insights?: { highCtrLowConvCount: number; highConvLowBudgetCount: number; deserveOwnAdGroupCount: number };
  isLoading: boolean;
}

export function KeywordsTab({ keywords, insights, isLoading }: KeywordsTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!keywords || keywords.length === 0) {
    return <TabEmpty message="No keyword data found for this period." />;
  }

  return (
    <div className="space-y-4">
      {insights && (
        <div className="flex flex-wrap gap-3 rounded-xl border bg-muted/30 px-4 py-3">
          {insights.highCtrLowConvCount > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-[var(--adc-caution-fg)] dark:text-[var(--adc-caution-fg)]">{insights.highCtrLowConvCount}</span> keywords: high CTR, zero conversions
            </span>
          )}
          {insights.highConvLowBudgetCount > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-[var(--adc-info-fg)] dark:text-[var(--adc-info-fg)]">{insights.highConvLowBudgetCount}</span> keywords with conversions but low impression share
            </span>
          )}
          {insights.deserveOwnAdGroupCount > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-[var(--adc-auto-fg)] dark:text-[var(--adc-auto-fg)]">{insights.deserveOwnAdGroupCount}</span> keywords may deserve their own ad group
            </span>
          )}
        </div>
      )}
      <SimpleTable cols={cols} rows={keywords} defaultSort="spend" />
    </div>
  );
}
