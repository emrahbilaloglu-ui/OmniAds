"use client";

import { useMemo } from "react";
import { BarChart3, Layers, Minus, TrendingDown, TrendingUp, X } from "lucide-react";
import { cn } from "@/lib/utils";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { formatMoney } from "@/components/creatives/money";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import { getCreativeFormatSummaryLabel } from "@/lib/meta/creative-taxonomy";
import {
  CHART_METRICS,
  fmtChartMetricValue,
  getChartMetricValue,
  getCreativeAssetState,
  type BreakdownRow,
  type ChartMetric,
} from "@/components/creatives/creative-ad-breakdown-support";

export function CreativeDrawerHeader({
  creative,
  windowAdsCount,
  lifetimeAdsCount,
  totalSpend,
  weightedRoas,
  currency,
  defaultCurrency,
  assetFallbacks,
  onClose,
}: {
  creative: MetaCreativeRow | null;
  windowAdsCount: number;
  lifetimeAdsCount: number;
  totalSpend: number;
  weightedRoas: number;
  currency: string | null;
  defaultCurrency: string | null;
  assetFallbacks: (string | null)[];
  onClose: () => void;
}) {
  const formatLabel = creative
    ? getCreativeFormatSummaryLabel({
        creative_delivery_type: creative.creativeDeliveryType,
        creative_visual_format: creative.creativeVisualFormat,
        creative_primary_type: creative.creativePrimaryType,
        creative_primary_label: creative.creativePrimaryLabel,
        creative_secondary_type: creative.creativeSecondaryType,
        creative_secondary_label: creative.creativeSecondaryLabel,
        taxonomy_source: creative.taxonomySource ?? null,
      })
    : null;
  const adsLabel =
    lifetimeAdsCount > 0 && windowAdsCount > 0 && windowAdsCount !== lifetimeAdsCount
      ? `${windowAdsCount} of ${lifetimeAdsCount} ads (selected window)`
      : `${windowAdsCount || lifetimeAdsCount} ${(windowAdsCount || lifetimeAdsCount) === 1 ? "ad" : "ads"}`;

  return (
    <header className="shrink-0 border-b border-slate-200 bg-white">
      <div className="flex items-center justify-between px-5 pb-2 pt-4">
        <div className="flex items-center gap-2">
          <div className="flex h-6 items-center rounded-md bg-primary/10 px-2">
            <Layers className="mr-1.5 h-3 w-3 text-primary" />
            <span className="text-[11px] font-semibold uppercase tracking-wider text-primary">
              Ad breakdown
            </span>
          </div>
        </div>
        <button
          type="button"
          className="rounded-lg p-1.5 text-muted-foreground transition-colors hover:bg-accent hover:text-foreground"
          onClick={onClose}
          aria-label="Close"
        >
          <X className="h-4 w-4" />
        </button>
      </div>

      <div className="flex gap-4 px-5 pb-4">
        <div className="shrink-0 overflow-hidden rounded-xl border bg-background shadow-sm" style={{ width: 96, height: 96 }}>
          {creative ? (
            <CreativeRenderSurface
              id={creative.id}
              name={creative.name}
              preview={creative.preview}
              size="card"
              mode="asset"
              assetState={getCreativeAssetState(creative)}
              assetFallbacks={assetFallbacks}
              className="h-full w-full object-cover"
            />
          ) : (
            <div className="flex h-full w-full items-center justify-center bg-muted text-muted-foreground">
              <BarChart3 className="h-6 w-6" />
            </div>
          )}
        </div>

        <div className="flex min-w-0 flex-1 flex-col justify-center">
          <h3 className="truncate text-base font-semibold leading-tight tracking-tight text-slate-950">
            {creative?.name ?? "Creative"}
          </h3>
          <div className="mt-1.5 flex flex-wrap items-center gap-1.5">
            <span className="inline-flex items-center rounded-md bg-blue-500/10 px-2 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:text-blue-400">
              Meta
            </span>
            {formatLabel ? (
              <span className="inline-flex items-center rounded-md bg-muted px-2 py-0.5 text-[10px] font-medium text-muted-foreground">
                {formatLabel}
              </span>
            ) : null}
            <span className="text-[11px] text-muted-foreground">
              {adsLabel}
            </span>
          </div>
          <div className="mt-3 flex flex-wrap gap-2">
            <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
              Spend{" "}
              <strong className="font-mono text-slate-950">
                {formatMoney(totalSpend, currency, defaultCurrency)}
              </strong>
            </span>
            <span className="rounded-lg border border-slate-200 bg-slate-50 px-2 py-1 text-[11px] text-slate-600">
              Weighted ROAS{" "}
              <strong className="font-mono text-slate-950">{weightedRoas.toFixed(2)}x</strong>
            </span>
          </div>
          {creative?.launchDate && (
            <p className="mt-1 text-[11px] text-muted-foreground/70">
              Launched {creative.launchDate}
            </p>
          )}
        </div>
      </div>
    </header>
  );
}

export function CreativeSummaryCards({
  totalSpend,
  weightedRoas,
  totalPurchases,
  weightedCtr,
  adsCount,
  currency,
  defaultCurrency,
}: {
  totalSpend: number;
  weightedRoas: number;
  totalPurchases: number;
  weightedCtr: number;
  adsCount: number;
  currency: string | null;
  defaultCurrency: string | null;
}) {
  return (
    <div className="grid grid-cols-2 gap-3 md:grid-cols-5">
      <SummaryCard
        label="Placements"
        value={adsCount.toString()}
        icon={<Layers className="h-3.5 w-3.5 text-blue-500" />}
      />
      <SummaryCard
        label="Total Spend"
        value={formatMoney(totalSpend, currency, defaultCurrency)}
        icon={<span className="text-amber-500">$</span>}
      />
      <SummaryCard
        label="Weighted ROAS"
        value={`${weightedRoas.toFixed(2)}x`}
        icon={weightedRoas >= 1 ? <TrendingUp className="h-3.5 w-3.5 text-emerald-500" /> : <TrendingDown className="h-3.5 w-3.5 text-red-400" />}
      />
      <SummaryCard
        label="Total Purchases"
        value={Math.round(totalPurchases).toLocaleString()}
        icon={<span className="text-xs font-bold text-violet-500">#</span>}
      />
      <SummaryCard
        label="Weighted CTR"
        value={`${weightedCtr.toFixed(2)}%`}
        icon={<Minus className="h-3.5 w-3.5 text-orange-400" />}
      />
    </div>
  );
}

function SummaryCard({ label, value, icon }: { label: string; value: string; icon: React.ReactNode }) {
  return (
    <div className="rounded-2xl border border-slate-200 bg-white p-3 shadow-sm">
      <div className="flex items-center gap-1.5">
        <div className="flex h-5 w-5 items-center justify-center rounded-md bg-muted/60">{icon}</div>
        <p className="text-[10px] font-medium uppercase tracking-wider text-muted-foreground">{label}</p>
      </div>
      <p className="mt-1.5 font-mono text-lg font-bold tabular-nums tracking-tight">{value}</p>
    </div>
  );
}

export function CreativePerformanceChart({
  rows,
  metric,
  onMetricChange,
  currency,
  defaultCurrency,
}: {
  rows: BreakdownRow[];
  metric: ChartMetric;
  onMetricChange: (metric: ChartMetric) => void;
  currency: string | null;
  defaultCurrency: string | null;
}) {
  const shouldUseCampaignLabels = useMemo(() => {
    const campaignNames = new Set(
      rows
        .map((row) => row.campaignName?.trim())
        .filter((value): value is string => Boolean(value)),
    );
    return campaignNames.size > 1;
  }, [rows]);
  const maxValue = useMemo(() => {
    const values = rows.map((row) => getChartMetricValue(row, metric));
    return Math.max(...values, 0.01);
  }, [rows, metric]);

  return (
    <div className="rounded-2xl border border-slate-200 bg-white shadow-sm">
      <div className="flex items-center justify-between border-b border-slate-200 px-4 py-3">
        <div className="flex items-center gap-2">
          <BarChart3 className="h-4 w-4 text-muted-foreground" />
          <h4 className="text-[13px] font-semibold">Performance by Ad</h4>
        </div>
        <div className="flex gap-1">
          {CHART_METRICS.map((metricOption) => (
            <button
              key={metricOption.key}
              type="button"
              onClick={() => onMetricChange(metricOption.key)}
              className={cn(
                "rounded-lg px-2.5 py-1 text-[11px] font-medium transition-colors",
                metric === metricOption.key
                  ? "bg-primary text-primary-foreground shadow-sm"
                  : "text-muted-foreground hover:bg-muted hover:text-foreground"
              )}
            >
              {metricOption.label}
            </button>
          ))}
        </div>
      </div>

      <div className="px-4 py-3">
        {rows.length === 0 ? (
          <p className="py-8 text-center text-sm text-muted-foreground">No data to chart</p>
        ) : (
          <div className="space-y-2">
            {rows.slice(0, 8).map((row) => {
              const value = getChartMetricValue(row, metric);
              const pct = maxValue > 0 ? (value / maxValue) * 100 : 0;
              const displayValue = fmtChartMetricValue(value, metric, currency, defaultCurrency);
              const label = shouldUseCampaignLabels
                ? row.campaignName?.trim() || row.name
                : row.name;
              const sublabel = shouldUseCampaignLabels ? row.adSetName?.trim() || null : null;
              const title = [
                row.campaignName ? `Campaign: ${row.campaignName}` : null,
                row.adSetName ? `Ad set: ${row.adSetName}` : null,
              ].filter(Boolean).join(" • ");
              return (
                <div key={row.id} className="group" title={title || row.name}>
                  <div className="mb-0.5 flex items-center justify-between gap-3">
                    <div className="min-w-0">
                      <p
                        className="max-w-[20rem] truncate text-[11px] font-medium text-foreground"
                        data-chart-row-label={label}
                      >
                        {label}
                      </p>
                      {sublabel ? (
                        <p className="max-w-[18rem] truncate text-[10px] text-muted-foreground">
                          {sublabel}
                        </p>
                      ) : null}
                    </div>
                    <span className="text-[11px] font-semibold tabular-nums text-foreground">{displayValue}</span>
                  </div>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-muted/60">
                    <div
                      className="h-full rounded-full bg-primary/80 transition-all duration-300 group-hover:bg-primary"
                      style={{ width: `${Math.max(pct, 1.5)}%` }}
                    />
                  </div>
                </div>
              );
            })}
            {rows.length > 8 && (
              <p className="pt-1 text-center text-[10px] text-muted-foreground">+{rows.length - 8} more ads</p>
            )}
          </div>
        )}
      </div>
    </div>
  );
}
