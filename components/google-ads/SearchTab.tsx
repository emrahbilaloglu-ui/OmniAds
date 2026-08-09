"use client";

import { useState } from "react";
import { cn } from "@/lib/utils";
import { SubTabNav, fmtCurrency, fmtNumber, fmtPercent, fmtRoas, TabSkeleton, TabEmpty, SimpleTable, ColDef } from "./shared";

// ── Types ──────────────────────────────────────────────────────────────

type Intent = "transactional" | "commercial" | "informational" | "navigational";
type TermFilter = "all" | "wasteful" | "opportunity" | "high_performing";
type KwFilter = "all" | "wasting" | "high_qs" | "low_conv";
type SubTab = "terms" | "keywords";

const INTENT_CONFIG: Record<Intent, string> = {
  transactional: "bg-emerald-100 text-emerald-800 dark:bg-emerald-900/40 dark:text-emerald-300",
  commercial: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  informational: "bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300",
  navigational: "bg-muted text-muted-foreground",
};

const MATCH_TYPE_CONFIG: Record<string, string> = {
  Exact: "bg-blue-100 text-blue-800 dark:bg-blue-900/40 dark:text-blue-300",
  Phrase: "bg-amber-100 text-amber-800 dark:bg-amber-900/40 dark:text-amber-300",
  Broad: "bg-muted text-muted-foreground",
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

interface TermsSummary {
  wastefulCount: number;
  negativeKeywordCandidates: number;
  highPerformingCount: number;
  keywordOpportunities: number;
  wastefulSpend: number;
}

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

interface KeywordInsights {
  highCtrLowConvCount: number;
  highConvLowBudgetCount: number;
  deserveOwnAdGroupCount: number;
}

// ── Search Terms section ───────────────────────────────────────────────

function SearchTermsSection({ terms, summary, isLoading }: { terms?: SearchTerm[]; summary?: TermsSummary; isLoading: boolean }) {
  const [filter, setFilter] = useState<TermFilter>("all");

  if (isLoading) return <TabSkeleton />;
  if (!terms || terms.length === 0) return <TabEmpty message="No search term data found. Requires Search campaigns." />;

  const FILTERS: { id: TermFilter; label: string }[] = [
    { id: "all", label: "All Terms" },
    { id: "wasteful", label: "⚠ Wasteful" },
    { id: "opportunity", label: "✦ KW Opportunity" },
    { id: "high_performing", label: "★ High Performing" },
  ];

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
            <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold capitalize", INTENT_CONFIG[r.intent])}>
              {r.intent}
            </span>
            {!r.isKeyword && r.conversions >= 2 && (
              <span className="rounded-full bg-violet-100 text-violet-800 dark:bg-violet-900/40 dark:text-violet-300 px-1.5 py-0.5 text-[12px] font-semibold">
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
    { key: "revenue", header: "Conv. Value", accessor: (r) => r.revenue, align: "right", render: (r) => fmtCurrency(r.revenue) },
    {
      key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
      render: (r) => r.roas === 0 ? "—" : (
        <span className={cn(r.roas >= 3 ? "text-emerald-600 dark:text-emerald-400" : "")}>{fmtRoas(r.roas)}</span>
      ),
    },
    { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
    {
      key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right",
      render: (r) => (
        <span className={cn(r.spend > 50 && r.conversions === 0 ? "text-rose-600 dark:text-rose-400 font-semibold" : "")}>
          {fmtCurrency(r.spend)}
        </span>
      ),
    },
  ];

  return (
    <div className="space-y-4">
      {summary && (
        <div className="flex flex-wrap gap-3 rounded-xl border bg-muted/30 px-4 py-3">
          {summary.wastefulSpend > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-rose-500" />
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{fmtCurrency(summary.wastefulSpend)}</span> wasted on zero-conv terms
              </span>
            </div>
          )}
          {summary.keywordOpportunities > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-violet-500" />
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{summary.keywordOpportunities}</span> converting terms not yet keywords
              </span>
            </div>
          )}
          {summary.highPerformingCount > 0 && (
            <div className="flex items-center gap-1.5">
              <span className="h-2 w-2 rounded-full bg-emerald-500" />
              <span className="text-xs text-muted-foreground">
                <span className="font-semibold text-foreground">{summary.highPerformingCount}</span> high-performing terms
              </span>
            </div>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.id
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground"
            )}
          >{f.label}</button>
        ))}
      </div>

      <SimpleTable cols={cols} rows={filtered} defaultSort="spend" emptyText="No terms match this filter." />
    </div>
  );
}

// ── Keywords section ───────────────────────────────────────────────────

function QsIndicator({ score }: { score: number | null }) {
  if (score === null) return <span className="text-muted-foreground">—</span>;
  const cls = score >= 8 ? "text-emerald-600 dark:text-emerald-400 font-semibold" : score >= 5 ? "text-foreground" : "text-rose-600 dark:text-rose-400 font-semibold";
  return <span className={cls}>{score}/10</span>;
}

function KeywordsSection({ keywords, insights, isLoading }: { keywords?: Keyword[]; insights?: KeywordInsights; isLoading: boolean }) {
  const [filter, setFilter] = useState<KwFilter>("all");

  if (isLoading) return <TabSkeleton />;
  if (!keywords || keywords.length === 0) return <TabEmpty message="No keyword data found for this period." />;

  const FILTERS: { id: KwFilter; label: string }[] = [
    { id: "all", label: "All Keywords" },
    { id: "wasting", label: "⚠ Wasting Spend" },
    { id: "high_qs", label: "✦ High QS" },
    { id: "low_conv", label: "↓ Low Conv." },
  ];

  const filtered = keywords.filter((k) => {
    if (filter === "wasting") return k.spend > 20 && k.conversions === 0;
    if (filter === "high_qs") return (k.qualityScore ?? 0) >= 8;
    if (filter === "low_conv") return k.clicks > 50 && k.conversions === 0;
    return true;
  });

  const cols: ColDef<Keyword>[] = [
    {
      key: "keyword", header: "Keyword", accessor: (r) => r.keyword,
      render: (r) => (
        <div className="max-w-[180px]">
          <p className="text-xs font-medium truncate" title={r.keyword}>{r.keyword}</p>
          <span className={cn("rounded-full px-1.5 py-0.5 text-[12px] font-semibold", MATCH_TYPE_CONFIG[r.matchType] ?? "bg-muted text-muted-foreground")}>
            {r.matchType}
          </span>
          {(r.expectedCtr || r.adRelevance || r.landingPageExperience) && (
            <p className="mt-1 text-[12px] text-muted-foreground truncate">
              {r.expectedCtr ?? "n/a"} CTR · {r.adRelevance ?? "n/a"} rel · {r.landingPageExperience ?? "n/a"} LP
            </p>
          )}
        </div>
      ),
    },
    { key: "campaign", header: "Campaign", accessor: (r) => r.campaign, render: (r) => <span className="text-xs text-muted-foreground truncate block max-w-[120px]">{r.campaign}</span> },
    { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
    { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
    { key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right", render: (r) => r.roas === 0 ? "—" : <span className={cn(r.roas >= 3 ? "text-emerald-600 dark:text-emerald-400" : "")}>{fmtRoas(r.roas)}</span> },
    { key: "qualityScore", header: "QS", accessor: (r) => r.qualityScore ?? 0, align: "right", render: (r) => <QsIndicator score={r.qualityScore} /> },
    { key: "impressionShare", header: "IS", accessor: (r) => r.impressionShare ?? 0, align: "right", render: (r) => r.impressionShare != null ? fmtPercent(r.impressionShare * 100) : "—" },
    { key: "ctr", header: "CTR", accessor: (r) => r.ctr, align: "right", render: (r) => `${r.ctr.toFixed(1)}%` },
    { key: "clicks", header: "Clicks", accessor: (r) => r.clicks, align: "right", render: (r) => fmtNumber(r.clicks) },
  ];

  return (
    <div className="space-y-4">
      {insights && (
        <div className="flex flex-wrap gap-3 rounded-xl border bg-muted/30 px-4 py-3">
          {insights.highCtrLowConvCount > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-amber-600 dark:text-amber-400">{insights.highCtrLowConvCount}</span> keywords: high CTR, zero conversions
            </span>
          )}
          {insights.highConvLowBudgetCount > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-blue-600 dark:text-blue-400">{insights.highConvLowBudgetCount}</span> keywords with conversions but low impression share
            </span>
          )}
          {insights.deserveOwnAdGroupCount > 0 && (
            <span className="text-xs text-muted-foreground">
              <span className="font-semibold text-violet-600 dark:text-violet-400">{insights.deserveOwnAdGroupCount}</span> keywords may deserve their own ad group
            </span>
          )}
        </div>
      )}

      <div className="flex flex-wrap gap-2">
        {FILTERS.map((f) => (
          <button key={f.id} onClick={() => setFilter(f.id)}
            className={cn(
              "rounded-full border px-3 py-1 text-xs font-medium transition-colors",
              filter === f.id
                ? "border-foreground bg-foreground text-background"
                : "border-border bg-background text-muted-foreground hover:border-foreground/50 hover:text-foreground"
            )}
          >{f.label}</button>
        ))}
      </div>

      <SimpleTable cols={cols} rows={filtered} defaultSort="spend" emptyText="No keywords match this filter." />
    </div>
  );
}

// ── Main component ─────────────────────────────────────────────────────

interface SearchTabProps {
  terms?: SearchTerm[];
  termsSummary?: TermsSummary;
  keywords?: Keyword[];
  keywordInsights?: KeywordInsights;
  isLoadingTerms: boolean;
  isLoadingKeywords: boolean;
}

export function SearchTab({ terms, termsSummary, keywords, keywordInsights, isLoadingTerms, isLoadingKeywords }: SearchTabProps) {
  const [subTab, setSubTab] = useState<SubTab>("terms");

  const SUB_TABS: { id: SubTab; label: string }[] = [
    { id: "terms", label: `Search Terms${terms ? ` (${terms.length})` : ""}` },
    { id: "keywords", label: `Keywords${keywords ? ` (${keywords.length})` : ""}` },
  ];

  return (
    <div className="space-y-0">
      <SubTabNav tabs={SUB_TABS} active={subTab} onChange={setSubTab} />
      <div className="pt-4">
        {subTab === "terms" && <SearchTermsSection terms={terms} summary={termsSummary} isLoading={isLoadingTerms} />}
        {subTab === "keywords" && <KeywordsSection keywords={keywords} insights={keywordInsights} isLoading={isLoadingKeywords} />}
      </div>
    </div>
  );
}
