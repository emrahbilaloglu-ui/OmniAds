"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { fmtCurrency, fmtNumber, fmtRoas, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";

type Intent = "transactional" | "commercial" | "informational" | "navigational";

const INTENT_CONFIG: Record<Intent, string> = {
  transactional: "bg-[var(--adc-pos-bg)] text-[var(--adc-pos-fg)] dark:bg-[var(--adc-pos-fg)]/40 dark:text-[var(--adc-pos-fg)]",
  commercial: "bg-[var(--adc-info-bg)] text-[var(--adc-info-fg)] dark:bg-[var(--adc-info-fg)]/40 dark:text-[var(--adc-info-fg)]",
  informational: "bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)] dark:bg-[var(--adc-auto-fg)]/40 dark:text-[var(--adc-auto-fg)]",
  navigational: "bg-muted text-muted-foreground",
};

interface SearchTerm {
  searchTerm: string;
  campaign: string;
  adGroup: string;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  impressions: number;
  clicks: number;
  intent: Intent;
  isKeyword: boolean;
}

interface Summary {
  wastefulCount: number;
  negativeKeywordCandidates: number;
  highPerformingCount: number;
  keywordOpportunities: number;
  wastefulSpend: number;
}

type Filter = "all" | "wasteful" | "opportunity" | "high_performing";

const FILTERS = [
  { id: "all" as Filter, label: "All Terms" },
  { id: "wasteful" as Filter, label: "⚠ Wasteful" },
  { id: "opportunity" as Filter, label: "✦ KW Opportunity" },
  { id: "high_performing" as Filter, label: "★ High Performing" },
];

interface SearchTermsTabProps {
  terms?: SearchTerm[];
  summary?: Summary;
  isLoading: boolean;
}

export function SearchTermsTab({ terms, summary, isLoading }: SearchTermsTabProps) {
  const [filter, setFilter] = useState<Filter>("all");

  if (isLoading) return <TabSkeleton />;
  if (!terms || terms.length === 0) {
    return <TabEmpty message="No search term data found. Requires Search campaigns with search term data." />;
  }

  const filtered = terms.filter((t) => {
    if (filter === "wasteful") return t.clicks >= 30 && t.conversions === 0 && t.spend > 10;
    if (filter === "opportunity") return t.conversions >= 2 && !t.isKeyword;
    if (filter === "high_performing") return t.conversions >= 3 && t.roas > 3;
    return true;
  });

  const cols: ColDef<SearchTerm>[] = [
    {
      key: "searchTerm", header: "Search Term", accessor: (r) => r.searchTerm,
      render: (r) => (
        <div className="max-w-[200px]">
          <p className="text-xs font-medium truncate" title={r.searchTerm}>{r.searchTerm}</p>
          <div className="flex items-center gap-1 mt-0.5">
            <span className={cn("rounded-full px-1.5 py-0.5 text-[9px] font-semibold capitalize", INTENT_CONFIG[r.intent])}>
              {r.intent}
            </span>
            {!r.isKeyword && r.conversions >= 2 && (
              <span className="rounded-full bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)] dark:bg-[var(--adc-auto-fg)]/40 dark:text-[var(--adc-auto-fg)] px-1.5 py-0.5 text-[9px] font-semibold">
                + KW opp
              </span>
            )}
          </div>
        </div>
      ),
    },
    { key: "campaign", header: "Campaign", accessor: (r) => r.campaign, render: (r) => <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{r.campaign}</span> },
    { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
    { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
    {
      key: "cpa", header: "CPA", accessor: (r) => r.cpa === 0 ? 99999 : r.cpa, align: "right",
      render: (r) => r.conversions === 0
        ? <span className="text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)]">—</span>
        : fmtCurrency(r.cpa),
    },
    { key: "revenue", header: "Conv. Value", accessor: (r) => r.revenue, align: "right", render: (r) => fmtCurrency(r.revenue) },
    {
      key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
      render: (r) => r.roas === 0 ? "—" : (
        <span className={cn(r.roas >= 3 ? "text-[var(--adc-pos-fg)] dark:text-[var(--adc-pos-fg)]" : "")}>{fmtRoas(r.roas)}</span>
      ),
    },
    { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
    {
      key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right",
      render: (r) => (
        <span className={cn(r.spend > 50 && r.conversions === 0 ? "text-[var(--adc-danger-fg)] dark:text-[var(--adc-danger-fg)] font-semibold" : "")}>
          {fmtCurrency(r.spend)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {/* Summary strip */}
      {summary && (
        <div className="flex flex-wrap gap-3 rounded-xl border bg-muted/30 px-4 py-3">
          {summary.wastefulSpend > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--adc-danger-fg)]" />
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{fmtCurrency(summary.wastefulSpend)}</span> wasted on zero-conv terms
              </span>
            </div>
          )}
          {summary.keywordOpportunities > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--adc-auto-fg)]" />
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{summary.keywordOpportunities}</span> converting terms not yet keywords
              </span>
            </div>
          )}
          {summary.highPerformingCount > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-[var(--adc-pos-fg)]" />
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{summary.highPerformingCount}</span> high-performing terms
              </span>
            </div>
          )}
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

      <SimpleTable cols={cols} rows={filtered} defaultSort="spend" emptyText="No search terms match this filter." />
    </div>
  );
}
