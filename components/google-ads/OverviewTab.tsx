"use client";

import { GadsKpiCard, GadsInsightCard, fmtCurrency, fmtNumber, fmtPercent, fmtRoas, TabSkeleton, TabEmpty } from "./shared";
import { cn } from "@/lib/utils";

interface Kpis {
  spend: number;
  conversions: number;
  revenue: number;
  roas: number;
  cpa: number;
  ctr: number;
  cpc: number;
  impressions: number;
  clicks: number;
  convRate: number;
}

interface Insight {
  id: string;
  severity: "critical" | "warning" | "opportunity" | "positive";
  title: string;
  description: string;
  evidence?: string;
  recommendation?: string;
}

interface TopCampaign {
  name: string;
  spend: number;
  roas: number;
  conversions: number;
  channel: string;
}

interface OverviewTabProps {
  kpis?: Kpis;
  insights?: Insight[];
  topCampaigns?: TopCampaign[];
  isLoading: boolean;
}

export function OverviewTab({ kpis, insights, topCampaigns, isLoading }: OverviewTabProps) {
  if (isLoading) {
    return (
      <div className="space-y-6">
        <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
          {Array.from({ length: 10 }).map((_, i) => (
            <GadsKpiCard key={i} label="" value="" isLoading />
          ))}
        </div>
        <TabSkeleton rows={4} />
      </div>
    );
  }

  if (!kpis) return <TabEmpty message="No overview data available." />;

  return (
    <div className="space-y-6">
      {/* KPI grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-5">
        <GadsKpiCard label="Total Spend" value={fmtCurrency(kpis.spend)} />
        <GadsKpiCard label="Conversions" value={fmtNumber(kpis.conversions)} />
        <GadsKpiCard label="Conv. Value" value={fmtCurrency(kpis.revenue)} />
        <GadsKpiCard label="ROAS" value={fmtRoas(kpis.roas)} highlight />
        <GadsKpiCard label="CPA" value={fmtCurrency(kpis.cpa)} />
        <GadsKpiCard label="CPC" value={fmtCurrency(kpis.cpc)} />
        <GadsKpiCard label="CTR" value={fmtPercent(kpis.ctr)} />
        <GadsKpiCard label="Impressions" value={fmtNumber(kpis.impressions)} />
        <GadsKpiCard label="Clicks" value={fmtNumber(kpis.clicks)} />
        <GadsKpiCard label="Conv. Rate" value={fmtPercent(kpis.convRate)} />
      </div>

      <div className="grid gap-5 lg:grid-cols-2">
        {/* Top campaigns */}
        {topCampaigns && topCampaigns.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Top Campaigns by Spend
            </p>
            <div className="rounded-xl border bg-card overflow-hidden">
              {topCampaigns.map((c, i) => (
                <div
                  key={i}
                  className={cn(
                    "flex items-center justify-between px-4 py-3 text-sm",
                    i < topCampaigns.length - 1 && "border-b"
                  )}
                >
                  <div className="min-w-0">
                    <p className="font-medium truncate max-w-[200px]" title={c.name}>
                      {c.name}
                    </p>
                    <p className="text-[12px] text-muted-foreground">{c.channel}</p>
                  </div>
                  <div className="flex items-center gap-4 shrink-0">
                    <div className="text-right">
                      <p className="text-xs font-semibold">{fmtCurrency(c.spend)}</p>
                      <p className="text-[12px] text-muted-foreground">spend</p>
                    </div>
                    <div className="text-right">
                      <p className={cn(
                        "text-xs font-semibold",
                        c.roas >= 3 ? "text-emerald-600 dark:text-emerald-400"
                          : c.roas >= 1 ? "text-foreground"
                          : "text-rose-600 dark:text-rose-400"
                      )}>
                        {fmtRoas(c.roas)}
                      </p>
                      <p className="text-[12px] text-muted-foreground">ROAS</p>
                    </div>
                    <div className="text-right">
                      <p className="text-xs font-semibold">{fmtNumber(c.conversions)}</p>
                      <p className="text-[12px] text-muted-foreground">conv.</p>
                    </div>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}

        {/* Insights */}
        {insights && insights.length > 0 && (
          <div className="space-y-2">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
              Account Insights
            </p>
            <div className="space-y-2">
              {insights.map((ins) => (
                <GadsInsightCard
                  key={ins.id}
                  severity={ins.severity}
                  title={ins.title}
                  description={ins.description}
                  evidence={ins.evidence}
                  recommendation={ins.recommendation}
                />
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
