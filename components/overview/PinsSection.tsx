"use client";

import { useEffect } from "react";
import { useQueries } from "@tanstack/react-query";
import { Plus } from "lucide-react";
import { Button } from "@/components/ui/button";
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from "@/components/ui/dropdown-menu";
import { MetricCard } from "@/components/overview/MetricCard";
import type { ComparisonMode } from "@/lib/metric-semantics";
import type { OverviewMetricCatalogEntry } from "@/src/types/models";
import { getMetricTrend } from "@/src/services";
import { usePreferencesStore } from "@/store/preferences-store";
import { DEFAULT_PINNED_METRICS } from "@/lib/overview-metric-catalog";

export function PinsSection({
  businessId,
  contextKey,
  startDate,
  endDate,
  currencySymbol,
  catalog,
  comparisonMode,
  onViewBreakdown,
}: {
  businessId: string;
  contextKey: string;
  startDate: string;
  endDate: string;
  currencySymbol: string;
  catalog: OverviewMetricCatalogEntry[];
  comparisonMode?: ComparisonMode;
  onViewBreakdown?: (metricKey: string) => void;
}) {
  const pinnedByContext = usePreferencesStore((state) => state.overviewPinsByContext);
  const setOverviewPins = usePreferencesStore((state) => state.setOverviewPins);
  const pinOverviewMetric = usePreferencesStore((state) => state.pinOverviewMetric);
  const unpinOverviewMetric = usePreferencesStore((state) => state.unpinOverviewMetric);
  const replaceOverviewMetric = usePreferencesStore((state) => state.replaceOverviewMetric);
  const moveOverviewMetric = usePreferencesStore((state) => state.moveOverviewMetric);

  useEffect(() => {
    if (catalog.length === 0) return;
    if ((pinnedByContext[contextKey] ?? []).length > 0) return;
    const defaults = DEFAULT_PINNED_METRICS.filter((key) =>
      catalog.some((entry) => entry.key === key)
    );
    if (defaults.length > 0) {
      setOverviewPins(contextKey, defaults);
    }
  }, [catalog, contextKey, pinnedByContext, setOverviewPins]);

  const pinnedKeys = pinnedByContext[contextKey] ?? [];
  const pinnedMetrics = pinnedKeys
    .map((key) => catalog.find((entry) => entry.key === key))
    .filter((entry): entry is OverviewMetricCatalogEntry => Boolean(entry));

  const trendQueries = useQueries({
    queries: pinnedMetrics.map((entry) => ({
      queryKey: ["metric-trend", businessId, startDate, endDate, entry.key],
      queryFn: () =>
        getMetricTrend(businessId, {
          metric: entry.key,
          startDate,
          endDate,
        }),
      enabled: Boolean(businessId) && shouldFetchRemoteTrend(entry.metric),
      staleTime: 5 * 60 * 1000,
    })),
  });

  const availableToAdd = catalog.filter((entry) => !pinnedKeys.includes(entry.key));

  return (
    <div className="space-y-4">
      <div className="flex flex-wrap items-center justify-end gap-3">
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button className="gap-2 rounded-xl">
              <Plus className="h-4 w-4" />
              Add metric
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end" className="w-64">
            {availableToAdd.length === 0 ? (
              <DropdownMenuItem disabled>All available metrics are pinned</DropdownMenuItem>
            ) : (
              availableToAdd.map((entry) => (
                <DropdownMenuItem
                  key={entry.key}
                  onClick={() => pinOverviewMetric(contextKey, entry.key)}
                >
                  {entry.title}
                </DropdownMenuItem>
              ))
            )}
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div className="grid gap-4 md:grid-cols-2 xl:grid-cols-3">
        {pinnedMetrics.map((entry, index) => {
          const queryState = trendQueries[index];
          const usesRemoteTrend = shouldFetchRemoteTrend(entry.metric);
          const trendPoints = queryState?.data?.data ?? [];
          const trendData = usesRemoteTrend ? trendPoints : entry.metric.sparklineData ?? [];
          const trendLoading = usesRemoteTrend
            ? Boolean(queryState?.isLoading || queryState?.isFetching) && trendData.length === 0
            : false;
          return (
            <MetricCard
              key={entry.key}
              title={entry.metric.title}
              value={entry.metric.value}
              changePercent={entry.metric.changePct}
              comparisonMode={comparisonMode}
              trendData={trendData}
              comparisonTrendData={entry.metric.previousSparklineData}
              trendLoading={trendLoading}
              dataSource={entry.metric.dataSource.label}
              sourceKey={entry.metric.dataSource.key}
              businessId={businessId}
              metricKey={entry.key}
              unit={entry.metric.unit}
              currencySymbol={currencySymbol}
              helperText={entry.metric.helperText}
              replaceOptions={availableToAdd.map((item) => ({
                key: item.key,
                title: item.title,
              }))}
              onRemove={unpinOverviewMetric.bind(null, contextKey)}
              onReplace={(metricKey, nextMetricKey) =>
                replaceOverviewMetric(contextKey, metricKey, nextMetricKey)
              }
              onViewBreakdown={onViewBreakdown}
              onMoveLeft={(metricKey) => moveOverviewMetric(contextKey, metricKey, "left")}
              onMoveRight={(metricKey) => moveOverviewMetric(contextKey, metricKey, "right")}
            />
          );
        })}
      </div>
    </div>
  );
}

function shouldFetchRemoteTrend(metric: OverviewMetricCatalogEntry["metric"]) {
  return (metric.sparklineData?.length ?? 0) < 7;
}
