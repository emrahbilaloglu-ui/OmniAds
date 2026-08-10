"use client";

import { cn } from "@/lib/utils";
import {
  fmtCurrency, fmtNumber, fmtPercent, fmtRoas,
  TabSkeleton, TabEmpty, SectionLabel, SpendBar, SimpleTable, ColDef,
} from "./shared";

interface BudgetCampaign {
  id: string;
  name: string;
  dailyBudget: number;
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  impressions: number;
  clicks: number;
  impressionShare: number | null;
  lostIsBudget: number | null;
  lostIsRank?: number | null;
}

interface BudgetRec {
  campaign: string;
  currentSpend: number;
  suggestedBudgetChange: number;
  direction: "increase" | "decrease";
  reason: string;
}

interface BudgetScalingTabProps {
  campaigns?: BudgetCampaign[];
  recommendations?: BudgetRec[];
  totalSpend?: number;
  accountAvgRoas?: number;
  isLoading: boolean;
}

const cols: ColDef<BudgetCampaign>[] = [
  { key: "name", header: "Campaign", accessor: (r) => r.name, render: (r) => <span className="text-xs font-medium truncate block max-w-[160px]">{r.name}</span> },
  { key: "dailyBudget", header: "Daily Budget", accessor: (r) => r.dailyBudget, align: "right", render: (r) => r.dailyBudget > 0 ? fmtCurrency(r.dailyBudget) : "—" },
  { key: "spend", header: "Spend", accessor: (r) => r.spend, align: "right", render: (r) => fmtCurrency(r.spend) },
  { key: "conversions", header: "Conv.", accessor: (r) => r.conversions, align: "right", render: (r) => fmtNumber(r.conversions) },
  {
    key: "roas", header: "ROAS", accessor: (r) => r.roas, align: "right",
    render: (r) => (
      <span className={cn("font-semibold", r.roas >= 3 ? "text-emerald-600 dark:text-emerald-400" : r.roas < 1 ? "text-rose-600 dark:text-rose-400" : "")}>
        {r.roas === 0 ? "—" : fmtRoas(r.roas)}
      </span>
    ),
  },
  {
    key: "impressionShare", header: "IS", accessor: (r) => r.impressionShare ?? 0, align: "right",
    render: (r) => r.impressionShare != null ? fmtPercent(r.impressionShare * 100) : "—",
  },
  {
    key: "lostIsBudget", header: "Lost IS (Budget)", accessor: (r) => r.lostIsBudget ?? 0, align: "right",
    render: (r) => r.lostIsBudget != null && r.lostIsBudget > 0
      ? <span className="text-amber-600 dark:text-amber-400 font-semibold">{fmtPercent(r.lostIsBudget * 100)}</span>
      : "—",
  },
  {
    key: "lostIsRank", header: "Lost IS (Rank)", accessor: (r) => r.lostIsRank ?? 0, align: "right",
    render: (r) => r.lostIsRank != null && r.lostIsRank > 0
      ? <span className="text-rose-600 dark:text-rose-400 font-semibold">{fmtPercent(r.lostIsRank * 100)}</span>
      : "—",
  },
];

export function BudgetScalingTab({ campaigns, recommendations, totalSpend, accountAvgRoas, isLoading }: BudgetScalingTabProps) {
  if (isLoading) return <TabSkeleton />;
  if (!campaigns || campaigns.length === 0) return <TabEmpty message="No budget data found for this period." />;

  const spend = totalSpend ?? campaigns.reduce((s, c) => s + c.spend, 0);
  const avgRoas = accountAvgRoas ?? (spend > 0 ? campaigns.reduce((s, c) => s + c.revenue, 0) / spend : 0);
  const sorted = [...campaigns].sort((a, b) => b.spend - a.spend);

  // Scaling candidates: strong ROAS + losing IS to budget
  const scalingCandidates = campaigns.filter(
    (c) => c.roas >= avgRoas * 1.1 && (c.lostIsBudget ?? 0) > 0.1 && c.spend > 50
  );

  // Waste: high spend, zero conversions or very low ROAS
  const wastedCampaigns = campaigns
    .filter((c) => (c.spend > 100 && c.conversions === 0) || (c.roas < avgRoas * 0.3 && c.spend > 100))
    .sort((a, b) => b.spend - a.spend);

  const budgetLimited = campaigns.filter((c) => (c.lostIsBudget ?? 0) > 0.15).length;

  return (
    <div className="space-y-6">
      {/* Account KPIs */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-4">
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Total Spend</p>
          <p className="text-2xl font-bold mt-1">{fmtCurrency(spend)}</p>
        </div>
        <div className="rounded-xl border bg-card p-4">
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Campaigns</p>
          <p className="text-2xl font-bold mt-1">{campaigns.length}</p>
        </div>
        <div className={cn("rounded-xl border p-4", avgRoas >= 3 ? "border-emerald-200 dark:border-emerald-900/50" : avgRoas < 1 ? "border-rose-200 dark:border-rose-900/50" : "bg-card")}>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Avg ROAS</p>
          <p className={cn("text-2xl font-bold mt-1", avgRoas >= 3 ? "text-emerald-600 dark:text-emerald-400" : avgRoas < 1 ? "text-rose-600 dark:text-rose-400" : "")}>
            {fmtRoas(avgRoas)}
          </p>
        </div>
        <div className={cn("rounded-xl border p-4", budgetLimited > 0 ? "border-amber-200 dark:border-amber-900/50" : "bg-card")}>
          <p className="text-xs text-muted-foreground uppercase tracking-wide">Budget-Limited</p>
          <p className={cn("text-2xl font-bold mt-1", budgetLimited > 0 ? "text-amber-600 dark:text-amber-400" : "")}>{budgetLimited}</p>
          <p className="text-[12px] text-muted-foreground">campaigns losing IS</p>
        </div>
      </div>

      {/* Budget recommendations */}
      {recommendations && recommendations.length > 0 && (
        <div className="space-y-2">
          <SectionLabel>Budget Recommendations</SectionLabel>
          <div className="grid gap-2 sm:grid-cols-2">
            {recommendations.slice(0, 6).map((rec, i) => (
              <div
                key={i}
                className={cn(
                  "rounded-xl border p-4",
                  rec.direction === "increase"
                    ? "border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30"
                    : "border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30"
                )}
              >
                <p className="text-xs font-semibold truncate" title={rec.campaign}>{rec.campaign}</p>
                <p className="text-xs text-muted-foreground mt-0.5">{rec.reason}</p>
                <p className={cn("text-sm font-bold mt-2", rec.direction === "increase" ? "text-emerald-600 dark:text-emerald-400" : "text-rose-600 dark:text-rose-400")}>
                  {rec.direction === "increase" ? "+" : "-"}{fmtCurrency(Math.abs(rec.suggestedBudgetChange))}
                  <span className="text-xs font-normal text-muted-foreground ml-1">suggested shift</span>
                </p>
              </div>
            ))}
          </div>
        </div>
      )}

      {/* Scaling + Waste */}
      <div className="grid gap-4 lg:grid-cols-2">
        {scalingCandidates.length > 0 && (
          <div className="rounded-xl border border-emerald-200 dark:border-emerald-900/50 bg-emerald-50 dark:bg-emerald-950/30 p-4">
            <p className="text-xs font-semibold text-emerald-900 dark:text-emerald-100 mb-1">
              {scalingCandidates.length} campaign{scalingCandidates.length > 1 ? "s" : ""} ready to scale
            </p>
            <p className="text-[12px] text-emerald-700 dark:text-emerald-300 mb-3">
              Strong ROAS but losing impression share to budget — increasing budgets here should yield efficient growth.
            </p>
            <div className="space-y-2">
              {scalingCandidates.map((c, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="truncate text-emerald-900 dark:text-emerald-100 max-w-[180px]">{c.name}</span>
                  <div className="flex items-center gap-3 shrink-0 text-emerald-700 dark:text-emerald-300">
                    <span>{fmtRoas(c.roas)} ROAS</span>
                    <span>{fmtPercent((c.lostIsBudget ?? 0) * 100)} lost to budget</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {wastedCampaigns.length > 0 && (
          <div className="rounded-xl border border-rose-200 dark:border-rose-900/50 bg-rose-50 dark:bg-rose-950/30 p-4">
            <p className="text-xs font-semibold text-rose-900 dark:text-rose-100 mb-1">
              {fmtCurrency(wastedCampaigns.reduce((s, c) => s + c.spend, 0))} in low-efficiency spend
            </p>
            <p className="text-[12px] text-rose-700 dark:text-rose-300 mb-3">
              These campaigns have significant spend with weak or zero returns — reallocate to high performers.
            </p>
            <div className="space-y-2">
              {wastedCampaigns.slice(0, 4).map((c, i) => (
                <div key={i} className="flex items-center justify-between text-xs">
                  <span className="truncate text-rose-900 dark:text-rose-100 max-w-[180px]">{c.name}</span>
                  <div className="flex items-center gap-3 shrink-0 text-rose-700 dark:text-rose-300">
                    <span>{fmtCurrency(c.spend)} spent</span>
                    <span>{c.conversions === 0 ? "0 conv." : `${fmtRoas(c.roas)} ROAS`}</span>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>

      {/* Spend concentration */}
      <div className="space-y-2">
        <SectionLabel>Spend Concentration</SectionLabel>
        <div className="rounded-xl border bg-card p-4 space-y-3">
          {sorted.slice(0, 8).map((c, i) => {
            const pct = spend > 0 ? (c.spend / spend) * 100 : 0;
            return (
              <div key={i} className="flex items-center gap-3">
                <div className="min-w-0 flex-1">
                  <div className="flex items-center justify-between mb-1">
                    <span className="text-xs truncate max-w-[180px]" title={c.name}>{c.name}</span>
                    <span className="text-[12px] text-muted-foreground shrink-0 ml-2">{pct.toFixed(1)}%</span>
                  </div>
                  <SpendBar value={c.spend} max={spend} />
                </div>
                <div className="text-right shrink-0 w-20">
                  <p className="text-xs tabular-nums">{fmtCurrency(c.spend)}</p>
                  <p className={cn("text-[12px]", c.roas >= 3 ? "text-emerald-600 dark:text-emerald-400" : c.roas < 1 ? "text-rose-600 dark:text-rose-400" : "text-muted-foreground")}>
                    {c.roas > 0 ? `${fmtRoas(c.roas)} ROAS` : "—"}
                  </p>
                </div>
              </div>
            );
          })}
        </div>
      </div>

      {/* Full table */}
      <div>
        <SectionLabel>Campaign Detail</SectionLabel>
        <div className="mt-3">
          <SimpleTable cols={cols} rows={campaigns} defaultSort="spend" />
        </div>
      </div>
    </div>
  );
}
