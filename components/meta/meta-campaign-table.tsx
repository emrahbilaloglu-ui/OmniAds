"use client";

/**
 * components/meta/meta-campaign-table.tsx
 *
 * Props:
 *  campaigns     MetaCampaignData[]   — server-serialized, no client fetch
 *  businessId / since / until         — passed to lazy ad-set query
 *  showMicroBars  boolean (default false)
 *    When true, renders a 3 px relative-spend bar under Spend and Revenue.
 *  columns  "full" | "compact" (default "full")
 *    "full"    — 10 cols: Campaign · Status · Objective · Budget · Spend · Conv · Revenue · ROAS · CPA · CTR · CPM
 *    "compact" — 7 cols: Campaign · Status · Objective · Budget · Spend · Revenue · ROAS · CPA
 *    Conv, CTR, CPM are still visible in the expanded ad-set sub-table.
 */

import { useEffect, useState } from "react";
import { useQuery } from "@tanstack/react-query";
import { useCurrencySymbol } from "@/hooks/use-currency";
import { ChevronDown, ChevronRight, Loader2, AlertCircle } from "lucide-react";
import { Badge } from "@/components/ui/badge";
import { Button } from "@/components/ui/button";
import type { MetaCampaignData, MetaAdSetData } from "@/lib/api/meta";
import type { MetaAdSetsResponse } from "@/app/api/meta/adsets/route";
import { usePreferencesStore } from "@/store/preferences-store";

// ── Types ─────────────────────────────────────────────────────────────────────

type ColumnMode = "full" | "compact";

const ADSET_COLUMN_WIDTHS = [
  "240px",
  "120px",
  "200px",
  "160px",
  "130px",
  "140px",
  "130px",
  "110px",
  "130px",
  "110px",
  "110px",
  "110px",
  "110px",
] as const;

interface MetaCampaignTableProps {
  campaigns: MetaCampaignTableRow[];
  businessId: string;
  since: string;
  until: string;
  isCampaignPrevLoading?: boolean;
  showMicroBars?: boolean;
  columns?: ColumnMode;
}

export type MetaCampaignTableRow = MetaCampaignData & {
  previousSpend?: number;
  previousRevenue?: number;
  previousRoas?: number;
  previousCpa?: number;
  previousManualBidAmount?: number | null;
  laneLabel?: "Scaling" | "Validation" | "Test" | null;
  recommendationCount?: number;
  topActionHint?: string | null;
  isFocused?: boolean;
};

// ── Formatters ────────────────────────────────────────────────────────────────

function fmt$(n: number, sym = "$"): string {
  return `${sym}${n.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtBudget(daily: number | null, lifetime: number | null, sym = "$"): string {
  if (daily != null) return `${fmt$(daily / 100, sym)}/day`;
  if (lifetime != null) return `${fmt$(lifetime / 100, sym)} lifetime`;
  return "—";
}

function hasBudgetValue(daily: number | null | undefined, lifetime: number | null | undefined) {
  return typeof daily === "number" || typeof lifetime === "number";
}

function fmtBidValue(
  amount: number | null | undefined,
  format: "currency" | "roas" | null | undefined,
  sym = "$"
): string {
  if (typeof amount !== "number" || !Number.isFinite(amount)) return "—";
  if (format === "roas") return `${amount.toFixed(2)}x`;
  return fmt$(amount / 100, sym);
}

function renderConfigText(value: string | null | undefined, isMixed?: boolean) {
  const language = "en" as "en" | "tr";
  if (isMixed) return language === "tr" ? "Karışık" : "Mixed";
  if (!value) return "—";
  return value;
}

function renderBidValueText(
  value: number | null | undefined,
  format: "currency" | "roas" | null | undefined,
  isMixed: boolean | undefined,
  sym: string
) {
  if (isMixed) return "Mixed";
  return fmtBidValue(value, format, sym);
}

function formatRelativeAge(isoValue: string | null | undefined): string | null {
  if (!isoValue) return null;
  const timestamp = new Date(isoValue).getTime();
  if (!Number.isFinite(timestamp)) return null;

  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return null;

  const minute = 60_000;
  const hour = 60 * minute;
  const day = 24 * hour;
  const month = 30 * day;
  const year = 365 * day;

  if (diffMs >= year) return `${Math.floor(diffMs / year)}y ago`;
  if (diffMs >= month) return `${Math.floor(diffMs / month)}mo ago`;
  if (diffMs >= day) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs >= hour) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs >= minute) return `${Math.floor(diffMs / minute)}m ago`;
  return "jüst now";
}

function diffPct(current: number, previous?: number): number | null {
  if (typeof previous !== "number") return null;
  if (!Number.isFinite(current) || !Number.isFinite(previous)) return null;
  if (previous <= 0) return null;
  return ((current - previous) / previous) * 100;
}

function diffPctText(current: number, previous?: number): string | null {
  const pct = diffPct(current, previous);
  if (pct === null) return null;
  const sign = pct > 0 ? "+" : "";
  return `${sign}${pct.toFixed(1)}%`;
}

function diffClass(current: number, previous?: number) {
  if (typeof previous !== "number") return "text-muted-foreground";
  const diff = current - previous;
  if (diff > 0) return "text-emerald-600";
  if (diff < 0) return "text-red-500";
  return "text-muted-foreground";
}

// ── Micro-bar ─────────────────────────────────────────────────────────────────

function MicroBar({
  value,
  max,
  color = "bg-blue-500/50",
}: {
  value: number;
  max: number;
  color?: string;
}) {
  const pct = max > 0 ? Math.min((value / max) * 100, 100) : 0;
  return (
    <div className="mt-1 h-[3px] w-full overflow-hidden rounded-full bg-muted">
      <div
        className={`h-full rounded-full ${color}`}
        style={{ width: `${pct.toFixed(2)}%` }}
      />
    </div>
  );
}

// ── Status badge ──────────────────────────────────────────────────────────────

export function StatusBadge({ status }: { status: string }) {
  const language = "en" as "en" | "tr";
  const lower = status.toLowerCase();
  if (lower === "active")
    return (
      <Badge className="border-0 bg-emerald-500/15 font-medium text-emerald-600 hover:bg-emerald-500/20">
        {language === "tr" ? "Aktif" : "Active"}
      </Badge>
    );
  if (lower === "paused")
    return (
      <Badge className="border-0 bg-slate-400/15 text-slate-500 hover:bg-slate-400/20">
        {language === "tr" ? "Duraklatildi" : "Paused"}
      </Badge>
    );
  if (lower === "archived")
    return (
      <Badge className="border-0 bg-zinc-400/10 text-zinc-400">{language === "tr" ? "Arsivlendi" : "Archived"}</Badge>
    );
  if (lower === "in_process")
    return (
      <Badge className="border-0 bg-blue-500/15 text-blue-600">
        {language === "tr" ? "Isleniyor" : "In Process"}
      </Badge>
    );
  if (lower === "with_issues")
    return (
      <Badge className="border-0 bg-amber-500/15 text-amber-600">{language === "tr" ? "Sorunlar" : "Issues"}</Badge>
    );
  return (
    <Badge variant="outline" className="text-xs">
      {status.toLowerCase()}
    </Badge>
  );
}

function LaneBadge({ lane }: { lane: "Scaling" | "Validation" | "Test" }) {
  const language = "en" as "en" | "tr";
  if (lane === "Scaling") {
    return (
      <Badge className="border-0 bg-blue-500/10 text-blue-700 hover:bg-blue-500/15">
        {language === "tr" ? "Scaling" : "Scaling"}
      </Badge>
    );
  }

  if (lane === "Validation") {
    return (
      <Badge className="border-0 bg-slate-500/10 text-slate-700 hover:bg-slate-500/15">
        {language === "tr" ? "Dogrulama" : "Validation"}
      </Badge>
    );
  }

  return (
    <Badge className="border-0 bg-amber-500/10 text-amber-700 hover:bg-amber-500/15">
      {language === "tr" ? "Test" : "Test"}
    </Badge>
  );
}

// ── ROAS cell ─────────────────────────────────────────────────────────────────

export function RoasCell({ roas }: { roas: number }) {
  if (roas > 2.5)
    return (
      <span className="font-semibold tabular-nums text-emerald-600">
        {roas.toFixed(2)}
      </span>
    );
  if (roas >= 1.5)
    return (
      <span className="font-semibold tabular-nums text-amber-500">
        {roas.toFixed(2)}
      </span>
    );
  return (
    <span className="font-semibold tabular-nums text-red-500">
      {roas.toFixed(2)}
    </span>
  );
}

// ── Ad set sub-table (always shows all columns) ───────────────────────────────

function AdSetSubTable({
  rows,
  showBudgetOnCampaignRow,
  isPrevLoading,
  campaignBidValue,
  campaignBidValueFormat,
  campaignPreviousBidValue,
  campaignPreviousBidValueFormat,
  campaignPreviousBidValueCapturedAt,
}: {
  rows: MetaAdSetData[];
  showBudgetOnCampaignRow: boolean;
  isPrevLoading: boolean;
  campaignBidValue: number | null | undefined;
  campaignBidValueFormat: "currency" | "roas" | null | undefined;
  campaignPreviousBidValue: number | null | undefined;
  campaignPreviousBidValueFormat: "currency" | "roas" | null | undefined;
  campaignPreviousBidValueCapturedAt: string | null | undefined;
}) {
  const sym = useCurrencySymbol();
  const language = "en" as "en" | "tr";
  if (rows.length === 0) {
    return (
      <div className="px-4 py-3 text-xs text-muted-foreground">
        {language === "tr" ? "Secilen tarih araliginda ad set verisi yok." : "No ad set data for the selected date range."}
      </div>
    );
  }

  return (
    <div className="overflow-x-auto border-t bg-indigo-500/[0.03]">
      <table className="min-w-full table-fixed text-xs">
        <colgroup>
          {ADSET_COLUMN_WIDTHS.map((width, index) => (
            <col key={`${index}-${width}`} style={{ width }} />
          ))}
        </colgroup>
        <thead className="bg-muted/40 text-left">
          <tr>
            <th className="px-4 py-2 pl-10 font-medium">{language === "tr" ? "Ad Set" : "Ad Set"}</th>
            <th className="px-3 py-2 font-medium">{language === "tr" ? "Durum" : "Status"}</th>
            <th className="px-3 py-2 font-medium">{language === "tr" ? "Optimizasyon" : "Optimization"}</th>
            <th className="px-3 py-2 font-medium">{language === "tr" ? "Teklifleme" : "Bidding"}</th>
            <th className="px-3 py-2 font-medium">{language === "tr" ? "Butce" : "Budget"}</th>
            <th className="px-3 py-2 text-right font-medium">Bid Value</th>
            <th className="px-3 py-2 text-right font-medium">Spend</th>
            <th className="px-3 py-2 text-right font-medium">Conv.</th>
            <th className="px-3 py-2 text-right font-medium">Revenue</th>
            <th className="px-3 py-2 text-right font-medium">ROAS</th>
            <th className="px-3 py-2 text-right font-medium">CPA</th>
            <th className="px-3 py-2 text-right font-medium">CTR</th>
            <th className="px-3 py-2 text-right font-medium">CPM</th>
          </tr>
        </thead>
        <tbody>
          {rows.map((adset) => (
            (() => {
              const effectiveBidValue =
                adset.bidValue ??
                (adset.bidStrategyType === "target_roas" ? campaignBidValue ?? null : null);
              const effectiveBidValueFormat =
                adset.bidValueFormat ??
                (adset.bidStrategyType === "target_roas" ? campaignBidValueFormat ?? null : null);
              const effectivePreviousBidValue =
                adset.previousBidValue ??
                (adset.bidStrategyType === "target_roas" ? campaignPreviousBidValue ?? null : null);
              const effectivePreviousBidValueFormat =
                adset.previousBidValueFormat ??
                (adset.bidStrategyType === "target_roas"
                  ? campaignPreviousBidValueFormat ?? campaignBidValueFormat ?? null
                  : null);
              const effectivePreviousBidValueCapturedAt =
                adset.previousBidValueCapturedAt ??
                (adset.bidStrategyType === "target_roas"
                  ? campaignPreviousBidValueCapturedAt ?? null
                  : null);

              return (
            <tr
              key={adset.id}
              className="border-t transition-colors hover:bg-indigo-500/[0.07]"
            >
              <td className="border-l-2 border-l-indigo-400/40 px-4 py-2 pl-8 font-medium">
                <div className="truncate" title={adset.name}>
                  {adset.name}
                </div>
              </td>
              <td className="px-3 py-2">
                <StatusBadge status={adset.status} />
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                <div
                  className="truncate"
                  title={renderConfigText(adset.optimizationGoal, adset.isOptimizationGoalMixed)}
                >
                  {renderConfigText(adset.optimizationGoal, adset.isOptimizationGoalMixed)}
                </div>
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                <div
                  className="truncate"
                  title={renderConfigText(adset.bidStrategyLabel, adset.isBidStrategyMixed)}
                >
                  {renderConfigText(adset.bidStrategyLabel, adset.isBidStrategyMixed)}
                </div>
              </td>
              <td className="px-3 py-2 text-muted-foreground">
                {showBudgetOnCampaignRow ? (
                  <div className="truncate">—</div>
                ) : (
                  <>
                    <div className="truncate" title={fmtBudget(adset.dailyBudget, adset.lifetimeBudget, sym)}>
                      {fmtBudget(adset.dailyBudget, adset.lifetimeBudget, sym)}
                    </div>
                    {(typeof adset.previousDailyBudget === "number" ||
                      typeof adset.previousLifetimeBudget === "number") && (
                      <div className="truncate text-[12px] tabular-nums text-muted-foreground">
                        {language === "tr" ? "önceki" : "prev"} {fmtBudget(adset.previousDailyBudget ?? null, adset.previousLifetimeBudget ?? null, sym)}
                        {formatRelativeAge(adset.previousBudgetCapturedAt)
                          ? ` · ${formatRelativeAge(adset.previousBudgetCapturedAt)}`
                          : ""}
                      </div>
                    )}
                    {!(typeof adset.previousDailyBudget === "number" ||
                      typeof adset.previousLifetimeBudget === "number") &&
                      isPrevLoading &&
                      hasBudgetValue(adset.dailyBudget, adset.lifetimeBudget) && (
                        <div className="truncate text-[12px] text-muted-foreground">
                          {language === "tr" ? "getiriliyor..." : "fetching..."}
                        </div>
                      )}
                  </>
                )}
              </td>
              <td className="px-3 py-2 text-right text-muted-foreground">
                <div className="tabular-nums">
                  {renderBidValueText(effectiveBidValue, effectiveBidValueFormat, adset.isBidValueMixed, sym)}
                </div>
                {typeof effectivePreviousBidValue === "number" && !adset.isBidValueMixed && (
                  <div className="text-[12px] tabular-nums text-muted-foreground">
                    {language === "tr" ? "önceki" : "prev"} {fmtBidValue(
                      effectivePreviousBidValue,
                      effectivePreviousBidValueFormat ?? effectiveBidValueFormat,
                      sym
                    )}
                    {formatRelativeAge(effectivePreviousBidValueCapturedAt)
                      ? ` · ${formatRelativeAge(effectivePreviousBidValueCapturedAt)}`
                      : ""}
                  </div>
                )}
                {typeof effectivePreviousBidValue !== "number" &&
                  !adset.isBidValueMixed &&
                  isPrevLoading &&
                  typeof effectiveBidValue === "number" && (
                    <div className="text-[12px] text-muted-foreground">
                      {language === "tr" ? "getiriliyor..." : "fetching..."}
                    </div>
                  )}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt$(adset.spend, sym)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {adset.purchases.toLocaleString()}
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt$(adset.revenue, sym)}</td>
              <td className="px-3 py-2 text-right">
                <RoasCell roas={adset.roas} />
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt$(adset.cpa, sym)}</td>
              <td className="px-3 py-2 text-right tabular-nums">
                {adset.ctr.toFixed(2)}%
              </td>
              <td className="px-3 py-2 text-right tabular-nums">{fmt$(adset.cpm, sym)}</td>
            </tr>
              );
            })()
          ))}
        </tbody>
      </table>
    </div>
  );
}

// ── Campaign row ──────────────────────────────────────────────────────────────

interface CampaignRowProps {
  campaign: MetaCampaignTableRow;
  isExpanded: boolean;
  onToggle: () => void;
  businessId: string;
  since: string;
  until: string;
  maxSpend: number;
  maxRevenue: number;
  showMicroBars: boolean;
  columns: ColumnMode;
  isCampaignPrevLoading: boolean;
}

function CampaignRow({
  campaign,
  isExpanded,
  onToggle,
  businessId,
  since,
  until,
  maxSpend,
  maxRevenue,
  showMicroBars,
  columns,
  isCampaignPrevLoading,
}: CampaignRowProps) {
  const sym = useCurrencySymbol();
  const language = "en" as "en" | "tr";
  const colSpan = columns === "compact" ? 8 : 11;
  const showBudgetOnCampaignRow =
    campaign.budgetLevel === "campaign" &&
    hasBudgetValue(campaign.dailyBudget, campaign.lifetimeBudget);

  const adSetsQuery = useQuery<MetaAdSetsResponse>({
    queryKey: ["meta-adsets", businessId, campaign.id, since, until],
    enabled: isExpanded,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const params = new URLSearchParams({
        businessId,
        campaignId: campaign.id,
        startDate: since,
        endDate: until,
      });
      const res = await fetch(`/api/meta/adsets?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.message ?? `Request failed (${res.status})`);
      }
      return res.json() as Promise<MetaAdSetsResponse>;
    },
  });

  const adSetsPrevQuery = useQuery<MetaAdSetsResponse>({
    queryKey: ["meta-adsets-prev", businessId, campaign.id, since, until],
    enabled: isExpanded && adSetsQuery.isSuccess,
    staleTime: 5 * 60 * 1000,
    queryFn: async () => {
      const params = new URLSearchParams({
        businessId,
        campaignId: campaign.id,
        startDate: since,
        endDate: until,
        includePrev: "1",
      });
      const res = await fetch(`/api/meta/adsets?${params.toString()}`);
      if (!res.ok) {
        const payload = await res.json().catch(() => null);
        throw new Error(payload?.message ?? `Request failed (${res.status})`);
      }
      return res.json() as Promise<MetaAdSetsResponse>;
    },
  });

  const mergedAdSetRows = (() => {
    const baseRows = adSetsQuery.data?.rows ?? [];
    const prevById = new Map((adSetsPrevQuery.data?.rows ?? []).map((row) => [row.id, row]));
    return baseRows.map((row) => {
      const prev = prevById.get(row.id);
      return {
        ...row,
        optimizationGoal: prev?.optimizationGoal ?? row.optimizationGoal,
        bidStrategyType: prev?.bidStrategyType ?? row.bidStrategyType,
        bidStrategyLabel: prev?.bidStrategyLabel ?? row.bidStrategyLabel,
        manualBidAmount: prev?.manualBidAmount ?? row.manualBidAmount,
        bidValue: prev?.bidValue ?? row.bidValue,
        bidValueFormat: prev?.bidValueFormat ?? row.bidValueFormat,
        dailyBudget: prev?.dailyBudget ?? row.dailyBudget,
        lifetimeBudget: prev?.lifetimeBudget ?? row.lifetimeBudget,
        previousManualBidAmount: prev?.previousManualBidAmount ?? row.previousManualBidAmount,
        previousBidValue: prev?.previousBidValue ?? row.previousBidValue,
        previousBidValueFormat: prev?.previousBidValueFormat ?? row.previousBidValueFormat,
        previousBidValueCapturedAt:
          prev?.previousBidValueCapturedAt ?? row.previousBidValueCapturedAt,
        previousDailyBudget: prev?.previousDailyBudget ?? row.previousDailyBudget,
        previousLifetimeBudget: prev?.previousLifetimeBudget ?? row.previousLifetimeBudget,
        previousBudgetCapturedAt: prev?.previousBudgetCapturedAt ?? row.previousBudgetCapturedAt,
      };
    });
  })();

  return (
    <>
      <tr
        id={`meta-campaign-${campaign.id}`}
        className={`cursor-pointer border-t transition-colors hover:bg-muted/25 ${campaign.isFocused ? "bg-blue-50/60" : ""}`}
        onClick={onToggle}
      >
        {/* Campaign name */}
        <td className="px-3 py-2.5">
          <div className="flex items-center gap-2">
            <span className="shrink-0 text-muted-foreground">
              {isExpanded ? (
                <ChevronDown className="h-4 w-4" />
              ) : (
                <ChevronRight className="h-4 w-4" />
              )}
            </span>
            <div className="min-w-0">
              <div className="truncate font-medium" title={campaign.name}>
                {campaign.name}
              </div>
              {(campaign.laneLabel || campaign.recommendationCount) ? (
                <div className="mt-1 flex flex-wrap items-center gap-2">
                  {campaign.laneLabel ? (
                    <LaneBadge lane={campaign.laneLabel} />
                  ) : null}
                  {campaign.recommendationCount ? (
                    <span className="rounded-full bg-muted px-2 py-1 text-[12px] font-medium uppercase tracking-wide text-muted-foreground">
                      {campaign.recommendationCount} {language === "tr" ? "icgoru" : `insight${campaign.recommendationCount > 1 ? "s" : ""}`}
                    </span>
                  ) : null}
                </div>
              ) : null}
              {campaign.topActionHint ? (
                <div className="mt-1 truncate text-[12px] text-muted-foreground" title={campaign.topActionHint}>
                  {campaign.topActionHint}
                </div>
              ) : null}
            </div>
          </div>
        </td>

        {/* Status */}
        <td className="px-3 py-2.5">
          <StatusBadge status={campaign.status} />
        </td>

        {/* Objective */}
        <td className="px-3 py-2.5 text-muted-foreground">
          <div
            className="truncate"
            title={renderConfigText(campaign.objective)}
          >
            {renderConfigText(campaign.objective)}
          </div>
        </td>

        {/* Budget */}
        <td className="px-3 py-2.5 text-muted-foreground">
          {showBudgetOnCampaignRow ? (
            <>
              <div className="truncate" title={fmtBudget(campaign.dailyBudget, campaign.lifetimeBudget, sym)}>
                {fmtBudget(campaign.dailyBudget, campaign.lifetimeBudget, sym)}
              </div>
              {(typeof campaign.previousDailyBudget === "number" ||
                typeof campaign.previousLifetimeBudget === "number") && (
                <div className="truncate text-[12px] tabular-nums text-muted-foreground">
                  {language === "tr" ? "önceki" : "prev"} {fmtBudget(campaign.previousDailyBudget ?? null, campaign.previousLifetimeBudget ?? null, sym)}
                  {formatRelativeAge(campaign.previousBudgetCapturedAt)
                    ? ` · ${formatRelativeAge(campaign.previousBudgetCapturedAt)}`
                    : ""}
                </div>
              )}
              {!(typeof campaign.previousDailyBudget === "number" ||
                typeof campaign.previousLifetimeBudget === "number") &&
                isCampaignPrevLoading && (
                  <div className="truncate text-[12px] text-muted-foreground">
                    {language === "tr" ? "getiriliyor..." : "fetching..."}
                  </div>
                )}
            </>
          ) : (
            <span>—</span>
          )}
        </td>

        {/* Spend + micro-bar */}
        <td className="px-3 py-2.5">
          <span className="tabular-nums">{fmt$(campaign.spend, sym)}</span>
          {typeof campaign.previousSpend === "number" && (
            <div
              className={`mt-0.5 text-[12px] font-medium tabular-nums ${diffClass(
                campaign.spend,
                campaign.previousSpend
              )}`}
            >
              {diffPctText(campaign.spend, campaign.previousSpend)}
            </div>
          )}
          {showMicroBars && (
            <MicroBar
              value={campaign.spend}
              max={maxSpend}
              color="bg-blue-500/50"
            />
          )}
        </td>

        {/* Conv. — full mode only */}
        {columns === "full" && (
          <td className="px-3 py-2.5 tabular-nums">
            {campaign.purchases.toLocaleString()}
          </td>
        )}

        {/* Revenue + micro-bar */}
        <td className="px-3 py-2.5">
          <span className="tabular-nums">{fmt$(campaign.revenue, sym)}</span>
          {typeof campaign.previousRevenue === "number" && (
            <div
              className={`mt-0.5 text-[12px] font-medium tabular-nums ${diffClass(
                campaign.revenue,
                campaign.previousRevenue
              )}`}
            >
              {diffPctText(campaign.revenue, campaign.previousRevenue)}
            </div>
          )}
          {showMicroBars && (
            <MicroBar
              value={campaign.revenue}
              max={maxRevenue}
              color="bg-emerald-500/40"
            />
          )}
        </td>

        {/* ROAS */}
        <td className="px-3 py-2.5">
          <RoasCell roas={campaign.roas} />
          {typeof campaign.previousRoas === "number" && (
            <div
              className={`mt-0.5 text-[12px] font-medium tabular-nums ${diffClass(
                campaign.roas,
                campaign.previousRoas
              )}`}
            >
              {diffPctText(campaign.roas, campaign.previousRoas)}
            </div>
          )}
        </td>

        {/* CPA */}
        <td className="px-3 py-2.5 tabular-nums">
          {fmt$(campaign.cpa, sym)}
          {typeof campaign.previousCpa === "number" && (
            <div
              className={`mt-0.5 text-[12px] font-medium tabular-nums ${diffClass(
                campaign.previousCpa,
                campaign.cpa
              )}`}
            >
              {diffPctText(campaign.cpa, campaign.previousCpa)}
            </div>
          )}
        </td>

        {/* CTR — full mode only */}
        {columns === "full" && (
          <td className="px-3 py-2.5 tabular-nums">
            {campaign.ctr.toFixed(2)}%
          </td>
        )}

        {/* CPM — full mode only */}
        {columns === "full" && (
          <td className="px-3 py-2.5 tabular-nums">{fmt$(campaign.cpm, sym)}</td>
        )}
      </tr>

      {/* Lazy ad set child tree */}
      {isExpanded && (
        <tr>
          <td colSpan={colSpan} className="p-0">
            {adSetsQuery.isLoading && (
              <div className="flex items-center gap-2 border-t bg-muted/20 px-4 py-3 text-xs text-muted-foreground">
                <Loader2 className="h-3 w-3 animate-spin" />
                {language === "tr" ? "Ad set'ler yükleniyor..." : "Loading ad sets..."}
              </div>
            )}
            {adSetsQuery.isError && (
              <div className="flex items-center gap-2 border-t bg-destructive/5 px-4 py-3 text-xs text-destructive">
                <AlertCircle className="h-3 w-3" />
                {adSetsQuery.error instanceof Error
                  ? adSetsQuery.error.message
                  : language === "tr"
                    ? "Ad set'ler yüklenemedi."
                    : "Could not load ad sets."}
                <Button
                  size="sm"
                  variant="ghost"
                  className="ml-auto h-6 text-xs"
                  onClick={(e) => {
                    e.stopPropagation();
                    adSetsQuery.refetch();
                  }}
                >
                  {language === "tr" ? "Tekrar dene" : "Retry"}
                </Button>
              </div>
            )}
            {adSetsQuery.isSuccess && (
              <AdSetSubTable
                rows={mergedAdSetRows}
                showBudgetOnCampaignRow={showBudgetOnCampaignRow}
                isPrevLoading={adSetsPrevQuery.isLoading || adSetsPrevQuery.isFetching}
                campaignBidValue={campaign.bidValue}
                campaignBidValueFormat={campaign.bidValueFormat}
                campaignPreviousBidValue={campaign.previousBidValue}
                campaignPreviousBidValueFormat={campaign.previousBidValueFormat}
                campaignPreviousBidValueCapturedAt={campaign.previousBidValueCapturedAt}
              />
            )}
          </td>
        </tr>
      )}
    </>
  );
}

// ── Public component ──────────────────────────────────────────────────────────

export function MetaCampaignTable({
  campaigns,
  businessId,
  since,
  until,
  isCampaignPrevLoading = false,
  showMicroBars = false,
  columns = "full",
}: MetaCampaignTableProps) {
  const language = "en" as "en" | "tr";
  const [expandedIds, setExpandedIds] = useState<Set<string>>(
    () => new Set(campaigns.map((campaign) => campaign.id))
  );

  useEffect(() => {
    setExpandedIds(new Set(campaigns.map((campaign) => campaign.id)));
  }, [campaigns]);

  const maxSpend = campaigns.reduce((m, c) => Math.max(m, c.spend), 0);
  const maxRevenue = campaigns.reduce((m, c) => Math.max(m, c.revenue), 0);

  // Minimum table width so columns never squish below readable size.
  // compact (8 cols): 980 px · full (11 cols): 1280 px
  const minW = columns === "compact" ? "min-w-[980px]" : "min-w-[1280px]";

  if (campaigns.length === 0) {
    return (
      <div className="rounded-xl border border-dashed p-8 text-center text-sm text-muted-foreground">
        {language === "tr" ? "Secilen tarih araliginda kampanya bulunamadi." : "No campaigns found for the selected date range."}
      </div>
    );
  }

  return (
    <div className="overflow-hidden rounded-xl border">
      {/* overflow-x-auto: table scrolls horizontally if viewport < minW */}
      <div className="overflow-x-auto">
        <table className={`${minW} w-full text-sm`}>
          <thead className="sticky top-0 z-10 bg-card text-left text-xs font-medium uppercase tracking-wider text-muted-foreground border-b">
            <tr>
              <th className="px-3 py-2.5">{language === "tr" ? "Kampanya" : "Campaign"}</th>
              <th className="px-3 py-2.5">{language === "tr" ? "Durum" : "Status"}</th>
              <th className="px-3 py-2.5">{language === "tr" ? "Objective" : "Objective"}</th>
              <th className="px-3 py-2.5">{language === "tr" ? "Butce" : "Budget"}</th>
              <th className="px-3 py-2.5">{language === "tr" ? "Harcama" : "Spend"}</th>
              {columns === "full" && (
                <th className="px-3 py-2.5">Conv.</th>
              )}
              <th className="px-3 py-2.5">{language === "tr" ? "Gelir" : "Revenue"}</th>
              <th className="px-3 py-2.5">ROAS</th>
              <th className="px-3 py-2.5">CPA</th>
              {columns === "full" && (
                <>
                  <th className="px-3 py-2.5">CTR</th>
                  <th className="px-3 py-2.5">CPM</th>
                </>
              )}
            </tr>
          </thead>
          <tbody>
            {campaigns.map((campaign) => (
              <CampaignRow
                key={campaign.id}
                campaign={campaign}
                isExpanded={expandedIds.has(campaign.id)}
                onToggle={() =>
                  setExpandedIds((prev) => {
                    const next = new Set(prev);
                    if (next.has(campaign.id)) {
                      next.delete(campaign.id);
                    } else {
                      next.add(campaign.id);
                    }
                    return next;
                  })
                }
                businessId={businessId}
                since={since}
                until={until}
                maxSpend={maxSpend}
                maxRevenue={maxRevenue}
                showMicroBars={showMicroBars}
                columns={columns}
                isCampaignPrevLoading={isCampaignPrevLoading}
              />
            ))}
          </tbody>
        </table>
      </div>
      <div className="border-t bg-muted/20 px-3 py-2 text-xs text-muted-foreground">
        {campaigns.length} campaign{campaigns.length !== 1 ? "s" : ""} — click
        a row to expand ad sets
      </div>
    </div>
  );
}
