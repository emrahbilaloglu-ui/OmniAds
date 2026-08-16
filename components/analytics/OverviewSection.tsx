"use client";

import { AnalyticsKpiCard } from "./AnalyticsKpiCard";
import { InsightCallout } from "./InsightCallout";
import type { AnalyticsInsight } from "@/lib/google-analytics-reporting";
import { formatCurrencySmart, formatPercentFromRatioSmart } from "@/lib/metric-format";

interface OverviewKpis {
  sessions: number;
  engagedSessions: number;
  engagementRate: number;
  purchases: number;
  purchaseCvr: number;
  revenue: number;
  avgSessionDuration: number;
}

interface NewVsReturning {
  new: { sessions: number; purchases: number; purchaseCvr: number };
  returning: { sessions: number; purchases: number; purchaseCvr: number };
}

interface OverviewSectionProps {
  kpis?: OverviewKpis;
  newVsReturning?: NewVsReturning;
  insights?: AnalyticsInsight[];
  isLoading: boolean;
}

function fmt(n: number, type: "number" | "percent" | "currency" | "duration" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (type === "currency") {
    return formatCurrencySmart(n, "$");
  }
  if (type === "duration") {
    const mins = Math.floor(n / 60);
    const secs = Math.floor(n % 60);
    return mins > 0 ? `${mins}m ${secs}s` : `${secs}s`;
  }
  if (n >= 1_000_000) return `${(n / 1_000_000).toFixed(1)}M`;
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

export function OverviewSection({
  kpis,
  newVsReturning,
  insights,
  isLoading,
}: OverviewSectionProps) {
  const newCvr = newVsReturning?.new.purchaseCvr ?? 0;
  const returningCvr = newVsReturning?.returning.purchaseCvr ?? 0;
  const multiplier = newCvr > 0 ? returningCvr / newCvr : 0;

  return (
    <div className="space-y-5">
      {/* KPI Grid */}
      <div className="grid grid-cols-2 gap-3 sm:grid-cols-3 lg:grid-cols-6">
        <AnalyticsKpiCard
          label="Sessions"
          value={fmt(kpis?.sessions ?? 0)}
          isLoading={isLoading}
        />
        <AnalyticsKpiCard
          label="Engaged Sessions"
          value={fmt(kpis?.engagedSessions ?? 0)}
          isLoading={isLoading}
        />
        <AnalyticsKpiCard
          label="Engagement Rate"
          value={fmt(kpis?.engagementRate ?? 0, "percent")}
          isLoading={isLoading}
        />
        <AnalyticsKpiCard
          label="Purchases"
          value={fmt(kpis?.purchases ?? 0)}
          isLoading={isLoading}
        />
        <AnalyticsKpiCard
          label="Purchase CVR"
          value={fmt(kpis?.purchaseCvr ?? 0, "percent")}
          isLoading={isLoading}
        />
        <AnalyticsKpiCard
          label="Revenue"
          value={fmt(kpis?.revenue ?? 0, "currency")}
          isLoading={isLoading}
        />
      </div>

      {/* New vs Returning Comparison */}
      {!isLoading && newVsReturning && (
        <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
          <div className="rounded-xl border border-[var(--adv-border)] bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
              New Visitors
            </p>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xl font-semibold">
                  {fmt(newVsReturning.new.sessions)}
                </p>
                <p className="text-xs text-muted-foreground">sessions</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-semibold">
                  {fmt(newCvr, "percent")}
                </p>
                <p className="text-xs text-muted-foreground">purchase CVR</p>
              </div>
            </div>
          </div>
          <div className="rounded-xl border border-[var(--adv-border)] bg-white p-4">
            <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground mb-3">
              Returning Visitors
              {multiplier >= 1.5 && (
                <span className="ml-2 rounded-full bg-[var(--adc-pos-bg)] px-2 py-0.5 text-xs font-semibold text-[var(--adc-pos-fg)] ">
                  {multiplier.toFixed(1)}× better CVR
                </span>
              )}
            </p>
            <div className="flex items-end justify-between">
              <div>
                <p className="text-xl font-semibold">
                  {fmt(newVsReturning.returning.sessions)}
                </p>
                <p className="text-xs text-muted-foreground">sessions</p>
              </div>
              <div className="text-right">
                <p className="text-xl font-semibold text-[var(--adc-pos-fg)] ">
                  {fmt(returningCvr, "percent")}
                </p>
                <p className="text-xs text-muted-foreground">purchase CVR</p>
              </div>
            </div>
          </div>
        </div>
      )}

      {/* Insights */}
      {!isLoading && insights && insights.length > 0 && (
        <div className="space-y-2">
          <p className="text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Insights
          </p>
          <div className="grid gap-2 sm:grid-cols-2">
            {insights.map((insight, i) => (
              <InsightCallout key={i} insight={insight} />
            ))}
          </div>
        </div>
      )}
    </div>
  );
}
