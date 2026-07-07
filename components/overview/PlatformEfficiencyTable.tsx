"use client";

import { DataEmptyState } from "@/components/states/DataEmptyState";
import { LoadingSkeleton } from "@/components/states/loading-skeleton";
import { formatCurrencySmart } from "@/lib/metric-format";
import type { OverviewData } from "@/src/types/models";

interface PlatformEfficiencyTableProps {
  rows?: OverviewData["platformEfficiency"] | null;
  currencySymbol: string;
  isLoading?: boolean;
}

export function PlatformEfficiencyTable({
  rows,
  currencySymbol,
  isLoading = false,
}: PlatformEfficiencyTableProps) {
  if (isLoading) {
    return (
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Platform Efficiency</h2>
        </div>
        <LoadingSkeleton rows={2} />
      </section>
    );
  }

  const safeRows = rows ?? [];
  if (safeRows.length === 0) {
    return (
      <section className="rounded-2xl border bg-card p-5 shadow-sm">
        <div className="mb-3">
          <h2 className="text-lg font-semibold tracking-tight">Platform Efficiency</h2>
          <p className="text-sm text-muted-foreground">
            Spend distribution and efficiency from synced ad platform data.
          </p>
        </div>
        <DataEmptyState
          title="No platform data available"
          description="Connect ad platforms and wait for synced spend data to view efficiency breakdown."
          ctaLabel="Open Integrations"
          ctaHref="/integrations"
        />
      </section>
    );
  }

  const totalSpend = safeRows.reduce((sum, row) => sum + row.spend, 0);

  return (
    <section className="rounded-2xl border bg-card p-5 shadow-sm">
      <div className="mb-3">
        <h2 className="text-lg font-semibold tracking-tight">Platform Efficiency</h2>
        <p className="text-sm text-muted-foreground">
          Spend distribution and efficiency breakdown from backend-synced platform data.
        </p>
      </div>

      <div className="overflow-x-auto">
        <table className="min-w-full text-sm">
          <thead className="text-left text-xs uppercase tracking-wide text-muted-foreground">
            <tr className="border-b">
              <th className="px-2 py-3 font-medium">Platform</th>
              <th className="px-2 py-3 font-medium">Spend</th>
              <th className="px-2 py-3 font-medium">Revenue</th>
              <th className="px-2 py-3 font-medium">ROAS</th>
              <th className="px-2 py-3 font-medium">Purchases</th>
              <th className="px-2 py-3 font-medium">CPA</th>
              <th className="px-2 py-3 font-medium">Share of spend</th>
            </tr>
          </thead>
          <tbody>
            {safeRows.map((row) => {
              const spendShare = totalSpend > 0 ? (row.spend / totalSpend) * 100 : 0;

              return (
                <tr key={row.platform} className="border-b last:border-0">
                  <td className="px-2 py-3">
                    <span className="inline-flex rounded-md bg-muted px-2 py-1 capitalize">
                      {row.platform}
                    </span>
                  </td>
                  <td className="px-2 py-3">{formatCurrency(row.spend, currencySymbol)}</td>
                  <td className="px-2 py-3">{formatCurrency(row.revenue, currencySymbol)}</td>
                  <td className="px-2 py-3">{row.roas.toFixed(2)}</td>
                  <td className="px-2 py-3">{row.purchases.toLocaleString()}</td>
                  <td className="px-2 py-3">{formatCurrency(row.cpa, currencySymbol)}</td>
                  <td className="px-2 py-3">
                    <div className="w-28">
                      <div className="h-2 rounded-full bg-muted">
                        <div
                          className="h-full rounded-full bg-neutral-700/70"
                          style={{ width: `${Math.max(6, Math.min(spendShare, 100))}%` }}
                        />
                      </div>
                      <p className="mt-1 text-xs text-muted-foreground">{spendShare.toFixed(1)}%</p>
                    </div>
                  </td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
}

function formatCurrency(value: number, symbol: string) {
  return formatCurrencySmart(value, symbol);
}
