"use client";

import { useEffect, useMemo, useRef, useState } from "react";
import { Check, ChevronRight, Copy, ExternalLink, MousePointer2 } from "lucide-react";
import { cn } from "@/lib/utils";
import { formatMoney, resolveCreativeCurrency } from "@/components/creatives/money";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import type { DecisionOutput } from "@/lib/creative-decision-engine";
import { CreativeRenderSurface } from "@/components/creatives/CreativeRenderSurface";
import { CreativeDecisionLabelBadge } from "@/components/creatives/CreativeDecisionLabelBadge";
import {
  aggregateBreakdownRows,
  buildCreativeAssetFallbacks,
  DEFAULT_DRAWER_WIDTH,
  getAssociatedAdsCount,
  getCreativeAssetState,
  MIN_DRAWER_WIDTH,
  sortBreakdownRows,
  type BreakdownRow,
  type ChartMetric,
} from "@/components/creatives/creative-ad-breakdown-support";
import {
  CreativeDrawerHeader,
  CreativePerformanceChart,
  CreativeSummaryCards,
} from "@/components/creatives/creative-ad-breakdown-sections";

type PlacementSortKey = "spend" | "roas" | "purchases" | "age";

type CreativeAdBreakdownDrawerProps = {
  open: boolean;
  creative: MetaCreativeRow | null;
  rows: MetaCreativeRow[];
  loading?: boolean;
  defaultCurrency: string | null;
  decisionsByCreativeId?: Map<string, DecisionOutput>;
  onOpenPlacement?: (row: MetaCreativeRow) => void;
  onOpenChange: (open: boolean) => void;
};

const SORT_OPTIONS: Array<{ value: PlacementSortKey; label: string }> = [
  { value: "spend", label: "Spend" },
  { value: "roas", label: "ROAS" },
  { value: "purchases", label: "Purchases" },
  { value: "age", label: "Age" },
];

export const COPY_FEEDBACK_MS = 1_500;

export function getPlacementCopyState(copyValue: string, copiedValue: string | null) {
  const copied = copiedValue === copyValue;
  return {
    copied,
    label: copied ? "Copied" : "Copy",
  };
}

type CopiedSetter = (
  value: string | null | ((current: string | null) => string | null),
) => void;

export function handlePlacementCopy(
  value: string,
  setCopiedValue: CopiedSetter,
  writeText: ((value: string) => Promise<void>) | undefined =
    typeof navigator === "undefined"
      ? undefined
      : navigator.clipboard?.writeText?.bind(navigator.clipboard),
) {
  void writeText?.(value);
  setCopiedValue(value);
  globalThis.setTimeout(() => {
    setCopiedValue((current) => (current === value ? null : current));
  }, COPY_FEEDBACK_MS);
}

export function CreativeAdBreakdownDrawer({
  open,
  creative,
  rows,
  loading = false,
  defaultCurrency,
  decisionsByCreativeId,
  onOpenPlacement,
  onOpenChange,
}: CreativeAdBreakdownDrawerProps) {
  const [width, setWidth] = useState(DEFAULT_DRAWER_WIDTH);
  const [chartMetric, setChartMetric] = useState<ChartMetric>("spend");
  const [sortKey, setSortKey] = useState<PlacementSortKey>("spend");
  const [copiedValue, setCopiedValue] = useState<string | null>(null);
  const resizeStateRef = useRef<{ startX: number; startWidth: number } | null>(null);

  const breakdownRows = rows as BreakdownRow[];
  const sortedRows = useMemo(
    () => sortPlacementRows(breakdownRows, sortKey),
    [breakdownRows, sortKey],
  );
  const aggregated = useMemo(() => aggregateBreakdownRows(breakdownRows), [breakdownRows]);
  const weightedCtr = useMemo(() => calculateWeightedCtr(breakdownRows), [breakdownRows]);
  const lifetimeAdsCount = useMemo(
    () => getAssociatedAdsCount(creative, breakdownRows),
    [breakdownRows, creative],
  );
  const currency = resolveCreativeCurrency(creative?.currency, defaultCurrency);
  const assetFallbacks = buildCreativeAssetFallbacks(creative);

  useEffect(() => {
    if (!open) return;
    const onMouseMove = (event: MouseEvent) => {
      const active = resizeStateRef.current;
      if (!active) return;
      const delta = active.startX - event.clientX;
      const viewportMax = typeof window !== "undefined" ? Math.max(640, window.innerWidth - 180) : 1280;
      setWidth(Math.max(MIN_DRAWER_WIDTH, Math.min(viewportMax, active.startWidth + delta)));
    };
    const onMouseUp = () => {
      resizeStateRef.current = null;
    };
    window.addEventListener("mousemove", onMouseMove);
    window.addEventListener("mouseup", onMouseUp);
    return () => {
      window.removeEventListener("mousemove", onMouseMove);
      window.removeEventListener("mouseup", onMouseUp);
    };
  }, [open]);

  useEffect(() => {
    if (!open) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") onOpenChange(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [onOpenChange, open]);

  if (!open) return null;

  const singlePlacement = !loading && sortedRows.length <= 1;

  return (
    <div className="fixed inset-0 z-[70]">
      <div className="absolute inset-0 bg-black/30 backdrop-blur-[2px]" onClick={() => onOpenChange(false)} />

      <aside
        className="absolute right-0 top-0 h-full border-l border-neutral-200 bg-neutral-50 shadow-[0_1px_2px_rgba(16,21,28,0.08)]"
        style={{ width }}
      >
        <button
          type="button"
          aria-label="Resize drawer"
          className="absolute left-0 top-0 h-full w-1.5 cursor-col-resize bg-transparent transition-colors hover:bg-primary/20"
          onMouseDown={(event) => {
            event.preventDefault();
            resizeStateRef.current = { startX: event.clientX, startWidth: width };
          }}
        />

        <div className="flex h-full flex-col">
          <CreativeDrawerHeader
            creative={creative}
            windowAdsCount={sortedRows.length}
            lifetimeAdsCount={lifetimeAdsCount}
            totalSpend={aggregated.totalSpend}
            weightedRoas={aggregated.avgRoas}
            currency={currency}
            defaultCurrency={defaultCurrency}
            assetFallbacks={assetFallbacks}
            onClose={() => onOpenChange(false)}
          />

          <div className="flex-1 overflow-y-auto">
            <div className="space-y-4 p-5">
              <CreativeSummaryCards
                totalSpend={aggregated.totalSpend}
                weightedRoas={aggregated.avgRoas}
                totalPurchases={aggregated.totalPurchases}
                weightedCtr={weightedCtr}
                adsCount={sortedRows.length}
                currency={currency}
                defaultCurrency={defaultCurrency}
              />

              <CreativePerformanceChart
                rows={sortedRows}
                metric={chartMetric}
                onMetricChange={setChartMetric}
                currency={currency}
                defaultCurrency={defaultCurrency}
              />

              <section className="rounded-xl border border-neutral-200 bg-white">
                <div className="flex flex-wrap items-center justify-between gap-3 border-b border-neutral-200 px-4 py-3">
                  <div>
                    <h4 className="text-sm font-semibold text-neutral-950">Placements</h4>
                    <p className="text-xs text-neutral-500">
                      {loading ? "Loading placements" : `${sortedRows.length} ad placements in this range`}
                    </p>
                  </div>
                  <label className="flex items-center gap-2 text-xs font-medium text-neutral-600">
                    Sort by
                    <select
                      value={sortKey}
                      onChange={(event) => setSortKey(event.target.value as PlacementSortKey)}
                      className="rounded-lg border border-neutral-200 bg-white px-2 py-1 text-xs font-medium text-neutral-900 outline-none focus:border-neutral-400"
                    >
                      {SORT_OPTIONS.map((option) => (
                        <option key={option.value} value={option.value}>
                          {option.label}
                        </option>
                      ))}
                    </select>
                  </label>
                </div>

                <div className="space-y-3 p-3">
                  {loading ? (
                    <LoadingPlacements />
                  ) : singlePlacement ? (
                    <SinglePlacementState
                      row={sortedRows[0] ?? creative}
                      onOpenPlacement={onOpenPlacement}
                    />
                  ) : (
                    sortedRows.map((row) => (
                      <PlacementCard
                        key={row.id}
                        row={row}
                        decision={decisionsByCreativeId?.get(row.creativeId) ?? null}
                        currency={currency}
                        defaultCurrency={defaultCurrency}
                        copiedValue={copiedValue}
                        onCopy={(value) => handlePlacementCopy(value, setCopiedValue)}
                        onOpenPlacement={onOpenPlacement}
                      />
                    ))
                  )}
                </div>
              </section>
            </div>
          </div>
        </div>
      </aside>
    </div>
  );
}

function PlacementCard({
  row,
  decision,
  currency,
  defaultCurrency,
  onOpenPlacement,
  copiedValue,
  onCopy,
}: {
  row: MetaCreativeRow;
  decision: DecisionOutput | null;
  currency: string | null;
  defaultCurrency: string | null;
  onOpenPlacement?: (row: MetaCreativeRow) => void;
  copiedValue: string | null;
  onCopy: (value: string) => void;
}) {
  const campaignName = row.campaignName?.trim() || "Unknown campaign";
  const adSetName = row.adSetName?.trim() || "Unknown ad set";
  const daysActive = getDaysActive(row.launchDate);
  const belowBreakeven = decision?.badges.find((badge) => badge.type === "below_breakeven") ?? null;
  const copyValue = row.realAdId?.trim() || row.id;
  const copyState = getPlacementCopyState(copyValue, copiedValue);
  const metaUrl = buildMetaAdsManagerUrl(row);
  const assetFallbacks = buildCreativeAssetFallbacks(row);

  const openPlacement = () => {
    onOpenPlacement?.(row);
  };

  return (
    <div
      role="button"
      tabIndex={0}
      onClick={openPlacement}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          openPlacement();
        }
      }}
      className="group rounded-xl border border-neutral-200 bg-white p-3 text-left outline-none transition hover:border-neutral-300 focus:border-neutral-400"
      data-placement-row-id={row.id}
    >
      <div className="flex gap-3">
        <div className="h-16 w-16 shrink-0 overflow-hidden rounded-xl border border-neutral-200 bg-neutral-100">
          <CreativeRenderSurface
            id={row.id}
            name={row.name}
            preview={row.preview}
            size="thumb"
            mode="asset"
            assetState={getCreativeAssetState(row)}
            assetFallbacks={assetFallbacks}
            className="h-full w-full object-cover"
          />
        </div>

        <div className="min-w-0 flex-1">
          <div className="flex items-start gap-3">
            <div className="min-w-0 flex-1">
              <p className="break-words text-sm font-semibold leading-snug text-neutral-950">
                {campaignName}
              </p>
              <div className="mt-1 flex flex-wrap items-center gap-1.5 text-xs text-neutral-500">
                <span className="break-words">{adSetName}</span>
                {row.effectiveStatus ? <StatusBadge status={row.effectiveStatus} /> : null}
              </div>
            </div>

            <div className="flex shrink-0 flex-wrap justify-end gap-1.5">
              {decision ? <CreativeDecisionLabelBadge label={decision.label} className="shadow-none" /> : null}
              {belowBreakeven ? <BelowBreakevenBadge label={belowBreakeven.label} /> : null}
              <ChevronRight className="mt-0.5 h-4 w-4 text-neutral-400 transition group-hover:text-neutral-700" />
            </div>
          </div>

          <div className="mt-3 grid grid-cols-2 gap-2 sm:grid-cols-5">
            <MetricPill label="Spend" value={formatMoney(row.spend, currency, defaultCurrency)} />
            <MetricPill label="Purchases" value={Math.round(row.purchases).toLocaleString()} />
            <MetricPill label="ROAS" value={`${row.roas.toFixed(2)}x`} />
            <MetricPill label="CTR" value={`${row.ctrAll.toFixed(2)}%`} />
            <MetricPill
              label="Freq"
              value={typeof row.frequency === "number" ? row.frequency.toFixed(2) : "n/a"}
            />
          </div>

          <div className="mt-3 flex flex-wrap items-center gap-2 text-xs text-neutral-500">
            <span className="font-mono text-[11px] text-neutral-600">{copyValue}</span>
            <button
              type="button"
              className="inline-flex min-w-[4.5rem] items-center justify-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900"
              onClick={(event) => {
                event.stopPropagation();
                onCopy(copyValue);
              }}
            >
              {copyState.copied ? <Check className="h-3 w-3" /> : <Copy className="h-3 w-3" />}
              {copyState.label}
            </button>
            {metaUrl ? (
              <a
                href={metaUrl}
                target="_blank"
                rel="noreferrer"
                className="inline-flex items-center gap-1 rounded-md border border-neutral-200 px-1.5 py-0.5 text-[11px] font-medium text-neutral-600 transition hover:border-neutral-300 hover:text-neutral-900"
                onClick={(event) => event.stopPropagation()}
              >
                <ExternalLink className="h-3 w-3" />
                Open in Meta Ads Manager
              </a>
            ) : null}
            {daysActive !== null ? (
              <span className="ml-auto font-mono text-[11px] text-neutral-500">
                {daysActive}d active
              </span>
            ) : null}
          </div>
        </div>
      </div>
    </div>
  );
}

function MetricPill({ label, value }: { label: string; value: string }) {
  return (
    <div className="rounded-lg border border-neutral-100 bg-neutral-50 px-2 py-1.5">
      <p className="text-[10px] font-semibold uppercase text-neutral-500">{label}</p>
      <p className="mt-0.5 font-mono text-xs font-semibold tabular-nums text-neutral-950">{value}</p>
    </div>
  );
}

function StatusBadge({ status }: { status: string }) {
  const normalized = status.toUpperCase();
  const active = normalized === "ACTIVE";
  return (
    <span
      className={cn(
        "inline-flex rounded-full border px-1.5 py-0.5 font-mono text-[10px] font-semibold",
        active
          ? "border-emerald-200 bg-emerald-50 text-emerald-700"
          : "border-neutral-200 bg-neutral-100 text-neutral-600",
      )}
    >
      {normalized}
    </span>
  );
}

function BelowBreakevenBadge({ label }: { label: string }) {
  return (
    <span className="inline-flex rounded-full border border-amber-200 bg-amber-50 px-2 py-0.5 text-[10px] font-semibold text-amber-800">
      {label || "Below breakeven"}
    </span>
  );
}

function SinglePlacementState({
  row,
  onOpenPlacement,
}: {
  row: MetaCreativeRow | null;
  onOpenPlacement?: (row: MetaCreativeRow) => void;
}) {
  return (
    <div className="rounded-xl border border-dashed border-neutral-200 bg-neutral-50 px-4 py-8 text-center">
      <MousePointer2 className="mx-auto h-5 w-5 text-neutral-400" />
      <p className="mt-3 text-sm font-semibold text-neutral-900">
        This creative runs in a single ad placement.
      </p>
      <p className="mx-auto mt-1 max-w-md text-sm text-neutral-500">
        Open the creative detail drawer for full evidence.
      </p>
      {row ? (
        <button
          type="button"
          className="mt-4 rounded-lg bg-neutral-950 px-3 py-2 text-xs font-semibold text-white transition hover:bg-neutral-800"
          onClick={() => onOpenPlacement?.(row)}
        >
          Open creative detail
        </button>
      ) : null}
    </div>
  );
}

function LoadingPlacements() {
  return (
    <div className="space-y-3">
      {Array.from({ length: 3 }).map((_, index) => (
        <div key={index} className="rounded-xl border border-neutral-200 bg-white p-3">
          <div className="flex gap-3">
            <div className="h-16 w-16 animate-pulse rounded-xl bg-neutral-100" />
            <div className="flex-1 space-y-2">
              <div className="h-4 w-2/3 animate-pulse rounded bg-neutral-100" />
              <div className="h-3 w-1/2 animate-pulse rounded bg-neutral-100" />
              <div className="grid grid-cols-5 gap-2 pt-2">
                {Array.from({ length: 5 }).map((__, metricIndex) => (
                  <div key={metricIndex} className="h-10 animate-pulse rounded-lg bg-neutral-100" />
                ))}
              </div>
            </div>
          </div>
        </div>
      ))}
    </div>
  );
}

function sortPlacementRows(rows: BreakdownRow[], sortKey: PlacementSortKey) {
  if (sortKey === "age") {
    return [...rows].sort((a, b) => (getDaysActive(b.launchDate) ?? 0) - (getDaysActive(a.launchDate) ?? 0));
  }
  return sortBreakdownRows(rows, sortKey, "desc");
}

function calculateWeightedCtr(rows: BreakdownRow[]) {
  const impressions = rows.reduce((total, row) => total + Math.max(0, row.impressions), 0);
  if (impressions <= 0) return 0;
  return rows.reduce((total, row) => total + row.ctrAll * Math.max(0, row.impressions), 0) / impressions;
}

function getDaysActive(launchDate: string | null | undefined) {
  if (!launchDate) return null;
  const parsed = new Date(`${launchDate.slice(0, 10)}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime())) return null;
  const elapsed = Date.now() - parsed.getTime();
  return Math.max(1, Math.floor(elapsed / 86_400_000) + 1);
}

export function buildMetaAdsManagerUrl(row: MetaCreativeRow) {
  const accountId = row.accountId?.replace(/^act_/, "").trim() ?? null;
  const adId = row.realAdId?.trim() || null;
  if (!accountId || !adId) return null;
  const params = new URLSearchParams({
    act: accountId,
    selected_ad_ids: adId,
  });
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?${params.toString()}`;
}
