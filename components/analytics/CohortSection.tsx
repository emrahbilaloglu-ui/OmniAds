"use client";

import { Skeleton } from "@/components/ui/skeleton";
import { formatCurrencySmart, formatPercentFromRatioSmart } from "@/lib/metric-format";
import { cn } from "@/lib/utils";

interface CohortWeek {
  week: string;
  newSessions: number;
  returningSessions: number;
  newPurchases: number;
  returningPurchases: number;
  retentionRate: number;
}

interface MonthlyData {
  month: string;
  newUsers: number;
  activeUsers: number;
  sessions: number;
  purchases: number;
  revenue: number;
  purchaseCvr: number;
}

interface CohortSectionProps {
  cohortWeeks?: CohortWeek[];
  monthlyData?: MonthlyData[];
  isLoading: boolean;
}

function fmt(n: number, type: "number" | "percent" | "currency" = "number"): string {
  if (isNaN(n) || n === undefined) return "—";
  if (type === "percent") return formatPercentFromRatioSmart(n);
  if (type === "currency") {
    return formatCurrencySmart(n, "$");
  }
  if (n >= 1_000) return `${(n / 1_000).toFixed(1)}K`;
  return n.toFixed(0);
}

function retentionColor(rate: number): string {
  if (rate >= 0.4) return "bg-[var(--adc-pos-fg)] text-white";
  if (rate >= 0.25) return "bg-[var(--adc-pos-fg)] text-[var(--adc-pos-fg)]";
  if (rate >= 0.15) return "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]";
  if (rate >= 0.05) return "bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]";
  return "bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]";
}

function formatWeek(week: string): string {
  // week is "YYYYWW" format e.g. "202401"
  if (week.length === 6) {
    const year = week.slice(0, 4);
    const w = week.slice(4);
    return `W${w} '${year.slice(2)}`;
  }
  return week;
}

function formatMonth(month: string): string {
  // month is "YYYYMM" format
  if (month.length === 6) {
    const year = month.slice(0, 4);
    const m = parseInt(month.slice(4));
    const monthNames = ["Jan", "Feb", "Mar", "Apr", "May", "Jun", "Jul", "Aug", "Sep", "Oct", "Nov", "Dec"];
    return `${monthNames[m - 1] ?? m} '${year.slice(2)}`;
  }
  return month;
}

export function CohortSection({
  cohortWeeks,
  monthlyData,
  isLoading,
}: CohortSectionProps) {
  if (isLoading) {
    return (
      <div className="space-y-4">
        <Skeleton className="h-48 w-full rounded-xl" />
        <Skeleton className="h-32 w-full rounded-xl" />
      </div>
    );
  }

  const hasWeekly = cohortWeeks && cohortWeeks.length > 0;
  const hasMonthly = monthlyData && monthlyData.length > 0;

  if (!hasWeekly && !hasMonthly) {
    return (
      <p className="py-8 text-center text-sm text-muted-foreground">
        No cohort data found for this date range.
      </p>
    );
  }

  return (
    <div className="space-y-6">
      <p className="text-sm text-muted-foreground">
        Understand retention and return behavior. Higher returning session share indicates
        audience that keeps coming back.
      </p>

      {/* Weekly Retention Heatmap */}
      {hasWeekly && (
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Weekly New vs Returning Sessions
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4 text-left font-medium text-muted-foreground">Week</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">New</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">Returning</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">Retention</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">New Purchases</th>
                  <th className="py-2 text-right font-medium text-muted-foreground">Return Purchases</th>
                </tr>
              </thead>
              <tbody>
                {cohortWeeks!.slice(-12).map((w) => (
                  <tr key={w.week} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-4 font-medium tabular-nums">{formatWeek(w.week)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmt(w.newSessions)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmt(w.returningSessions)}</td>
                    <td className="py-2.5 pr-4 text-right">
                      <span
                        className={cn( "rounded px-1.5 py-0.5 font-semibold tabular-nums",
                          retentionColor(w.retentionRate)
                        )}
                      >
                        {fmt(w.retentionRate, "percent")}
                      </span>
                    </td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmt(w.newPurchases)}</td>
                    <td className="py-2.5 text-right tabular-nums">{fmt(w.returningPurchases)}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}

      {/* Monthly Summary */}
      {hasMonthly && (
        <div>
          <p className="mb-3 text-xs font-medium uppercase tracking-wide text-muted-foreground">
            Monthly Acquisition Summary
          </p>
          <div className="overflow-x-auto">
            <table className="w-full text-xs">
              <thead>
                <tr className="border-b">
                  <th className="py-2 pr-4 text-left font-medium text-muted-foreground">Month</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">New Users</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">Active Users</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">Sessions</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">Purchases</th>
                  <th className="py-2 pr-4 text-right font-medium text-muted-foreground">CVR</th>
                  <th className="py-2 text-right font-medium text-muted-foreground">Revenue</th>
                </tr>
              </thead>
              <tbody>
                {monthlyData!.map((m) => (
                  <tr key={m.month} className="border-b last:border-0 hover:bg-muted/30 transition-colors">
                    <td className="py-2.5 pr-4 font-medium">{formatMonth(m.month)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmt(m.newUsers)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmt(m.activeUsers)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmt(m.sessions)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">{fmt(m.purchases)}</td>
                    <td className="py-2.5 pr-4 text-right tabular-nums">
                      <span className={cn( "font-medium",
                        m.purchaseCvr >= 0.02 ? "text-[var(--adc-pos-fg)] " : ""
                      )}>
                        {fmt(m.purchaseCvr, "percent")}
                      </span>
                    </td>
                    <td className="py-2.5 text-right tabular-nums">{fmt(m.revenue, "currency")}</td>
                  </tr>
                ))}
              </tbody>
            </table>
          </div>
        </div>
      )}
    </div>
  );
}
