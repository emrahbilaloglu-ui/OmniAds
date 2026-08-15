"use client";

/**
 * components/meta/meta-campaign-detail.tsx
 *
 * Right panel in the master-detail layout.
 *
 * Two states:
 *  - No campaign selected: shows account-level recommendations + placement breakdown
 *  - Campaign selected: recommendation (if any) + metric grid + ad-set list
 */

import { useQuery } from "@tanstack/react-query";
import { useEffect, useMemo, useState } from "react";
import { cn } from "@/lib/utils";
import { useCurrencySymbol } from "@/hooks/use-currency";
import type { MetaCampaignTableRow } from "@/components/meta/meta-campaign-table";
import type { MetaRecommendation, MetaRecommendationsResponse } from "@/lib/meta/recommendations";
import {
  getMetaRecommendationSource,
  type MetaAnalysisStatus,
  type MetaRecommendationSourceSystem,
} from "@/lib/meta/analysis-state";
import { MetaAccountRecs } from "@/components/meta/meta-account-recs";
import type { MetaAdSetsResponse } from "@/app/api/meta/adsets/route";
import type { MetaBreakdownsResponse } from "@/app/api/meta/breakdowns/route";
import { MetaBreakdownGrid, type BreakdownRow } from "@/components/meta/meta-breakdown-grid";
import type { PlacementChartRow } from "@/components/meta/placement-breakdown-chart";
import { MetaOperatingModeCard } from "@/components/meta/meta-operating-mode-card";

// ── Formatters ────────────────────────────────────────────────────────────────

function formatRelativeAge(isoValue: string | null | undefined): string | null {
  if (!isoValue) return null;
  const timestamp = new Date(isoValue).getTime();
  if (!Number.isFinite(timestamp)) return null;
  const diffMs = Date.now() - timestamp;
  if (diffMs < 0) return null;
  const minute = 60_000, hour = 60 * minute, day = 24 * hour, month = 30 * day, year = 365 * day;
  if (diffMs >= year) return `${Math.floor(diffMs / year)}y ago`;
  if (diffMs >= month) return `${Math.floor(diffMs / month)}mo ago`;
  if (diffMs >= day) return `${Math.floor(diffMs / day)}d ago`;
  if (diffMs >= hour) return `${Math.floor(diffMs / hour)}h ago`;
  if (diffMs >= minute) return `${Math.floor(diffMs / minute)}m ago`;
  return "just now";
}

function fmt$(n: number, sym = "$") {
  return `${sym}${n.toLocaleString(undefined, { minimumFractionDigits: 2, maximumFractionDigits: 2 })}`;
}

function fmtK(n: number, sym = "$") {
  if (n >= 1_000_000) return `${sym}${(n / 1_000_000).toFixed(2)}M`;
  if (n >= 1_000) return `${sym}${(n / 1_000).toFixed(1)}k`;
  return fmt$(n, sym);
}

// ── Decision badge ────────────────────────────────────────────────────────────

function DecisionBadge({ state }: { state: MetaRecommendation["decisionState"] }) {
  const cls =
    state === "act"
      ? "bg-foreground text-background"
      : state === "test"
      ? "bg-[var(--adc-auto-fg)]/10 text-[var(--adc-auto-fg)]"
      : "bg-muted text-muted-foreground";

  const labels: Record<typeof state, string> = { act: "ACT", test: "TEST", watch: "WATCH" };

  return (
    <span className={`inline-block rounded-full px-2.5 py-1 text-[11px] font-bold uppercase tracking-wide ${cls}`}>
      {labels[state]}
    </span>
  );
}

// ── ROAS color ────────────────────────────────────────────────────────────────

function roasColor(roas: number) {
  if (roas > 2.5) return "text-[var(--adc-pos-fg)]";
  if (roas >= 1.5) return "text-[var(--adc-caution-fg)]";
  return "text-[var(--adc-danger-fg)]";
}

// ── Metric tile ───────────────────────────────────────────────────────────────

function MetricTile({
  label,
  value,
  sub,
  valueClass,
}: {
  label: string;
  value: string;
  sub?: string;
  valueClass?: string;
}) {
  return (
    <div className="rounded-lg border bg-white px-3 py-2 shadow-sm shadow-slate-100/60">
      <p className="text-[9px] font-semibold uppercase tracking-[0.14em] text-slate-400">{label}</p>
      <p className={cn("mt-0.5 font-mono text-sm font-bold tabular-nums leading-tight", valueClass ?? "text-slate-950")}>
        {value}
      </p>
      {sub && <p className="mt-0.5 text-[9px] text-slate-400">{sub}</p>}
    </div>
  );
}

function CampaignOperatorHeadline({
  recommendation,
  analysisStatus,
  recommendationSource,
}: {
  recommendation: MetaRecommendation | null;
  analysisStatus?: MetaAnalysisStatus;
  recommendationSource: MetaRecommendationSourceSystem;
}) {
  const fallbackRecommendation = recommendationSource === "snapshot_fallback";
  const shouldDemoteAggressiveRecommendation =
    recommendation?.decisionState === "act" &&
    analysisStatus?.presentationMode !== "fallback_context";
  const shouldShowRecommendationAsContext =
    fallbackRecommendation || shouldDemoteAggressiveRecommendation;

  if (!recommendation) return null;

  return (
    <div
      className="rounded-2xl border border-slate-200 bg-gradient-to-b from-white to-slate-50 p-4 shadow-sm"
      data-testid="meta-campaign-operator-headline"
    >
      <div className="flex flex-wrap items-center gap-2.5">
        {!shouldShowRecommendationAsContext ? (
          <DecisionBadge state={recommendation.decisionState} />
        ) : (
          <span className="rounded-full bg-[var(--adc-caution-fg)]/10 px-2.5 py-1 text-[10px] font-semibold uppercase tracking-wide text-[var(--adc-caution-fg)]">
            Context
          </span>
        )}
        <p className="text-[11px] text-slate-500">
          {fallbackRecommendation
            ? "Snapshot recommendation context"
            : recommendation.title}
        </p>
      </div>
      <p className="mt-2.5 text-base font-semibold leading-snug text-slate-950">
        {shouldShowRecommendationAsContext
          ? recommendation.summary ?? recommendation.why ?? recommendation.title
          : recommendation.recommendedAction}
      </p>
      {fallbackRecommendation ? (
        <p className="mt-2 text-xs leading-relaxed text-[var(--adc-caution-fg)]">
          Snapshot context only. Legacy Meta Decision OS authority is archived in Phase 4.1.
        </p>
      ) : null}
      {shouldDemoteAggressiveRecommendation && !fallbackRecommendation ? (
        <p className="mt-2 text-xs leading-relaxed text-[var(--adc-caution-fg)]">
          Recommendation is shown as context until a current authority surface is ready for this range.
        </p>
      ) : null}
      {recommendation.why ? (
        <p className="mt-3 text-xs leading-relaxed text-slate-500">{recommendation.why}</p>
      ) : null}
      {(recommendation?.evidence.length ?? 0) > 0 ? (
        <div className="mt-3 flex flex-wrap gap-2">
          {recommendation?.evidence.slice(0, 3).map((ev) => (
            <div
              key={ev.label}
              className="rounded-lg border border-slate-200 bg-white px-2.5 py-1.5 shadow-sm"
            >
              <p className="text-[10px] font-medium uppercase tracking-wide text-slate-400">
                {ev.label}
              </p>
              <p className="text-xs font-semibold text-slate-800">{ev.value}</p>
            </div>
          ))}
        </div>
      ) : null}
    </div>
  );
}

// ── Props ─────────────────────────────────────────────────────────────────────

interface MetaCampaignDetailProps {
  campaign: MetaCampaignTableRow | null;
  recommendationsData: MetaRecommendationsResponse | undefined;
  analysisStatus?: MetaAnalysisStatus;
  isRecsLoading: boolean;
  lastAnalyzedAt: Date | null;
  recommendationsError?: string | null;
  checkedRecIds: Set<string>;
  onToggleCheck: (id: string) => void;
  onAnalyze: () => void;
  onClearSelection: () => void;
  businessId: string;
  since: string;
  until: string;
  language: "en" | "tr";
}

// ── Ad-set list ───────────────────────────────────────────────────────────────

function AdSetList({
  campaignId,
  businessId,
  since,
  until,
  sym,
  language,
}: {
  campaignId: string;
  businessId: string;
  since: string;
  until: string;
  sym: string;
  language: "en" | "tr";
}) {
  const { data, isLoading, isError } = useQuery<MetaAdSetsResponse>({
    queryKey: ["meta-adsets", businessId, campaignId, since, until],
    queryFn: async () => {
      const params = new URLSearchParams({ businessId, campaignId, startDate: since, endDate: until });
      const res = await fetch(`/api/meta/adsets?${params}`);
      if (!res.ok) throw new Error("adsets fetch failed");
      return res.json();
    },
    staleTime: 5 * 60 * 1000,
  });

  if (isLoading) {
    return (
      <div className="space-y-1.5">
        {[0, 1, 2].map((i) => (
          <div key={i} className="h-10 animate-pulse rounded-lg bg-slate-100" />
        ))}
      </div>
    );
  }

  if (isError || !data?.rows?.length) {
    return (
      <p className="text-xs text-muted-foreground">
        {language === "tr" ? "Ad set verisi yok." : "No ad set data for this range."}
      </p>
    );
  }

  return (
    <div className="space-y-2">
      {data.rows.map((adset) => {
        const roas = adset.spend > 0 ? adset.revenue / adset.spend : 0;
        const isActive = adset.status.toLowerCase() === "active";

        // Bid zone
        const bidLabel = adset.bidStrategyLabel ?? "—";
        const bidValueStr = adset.bidValue != null
          ? adset.bidValueFormat === "roas"
            ? `${adset.bidValue.toFixed(2)}×`
            : fmt$(adset.bidValue / 100, sym)
          : null;
        const prevBidValueStr = adset.previousBidValue != null
          ? (adset.previousBidValueFormat ?? adset.bidValueFormat) === "roas"
            ? `${adset.previousBidValue.toFixed(2)}×`
            : fmt$(adset.previousBidValue / 100, sym)
          : null;
        const prevBidAge = adset.previousBidValueCapturedAt
          ? formatRelativeAge(adset.previousBidValueCapturedAt)
          : null;

        // Link CTR: prefer inline_link_click_ctr (link clicks / impressions),
        // fall back to generic ctr (all clicks / impressions) for warehouse data.
        const linkCtr = adset.inlineLinkClickCtr ?? adset.ctr;
        const ctrStr = linkCtr != null && linkCtr > 0
          ? `${linkCtr.toFixed(2)}%`
          : "—";

        return (
          <div
            key={adset.id}
            className="rounded-xl border border-slate-100 bg-white px-3 py-2.5 shadow-sm"
          >
            <div className="flex items-start gap-3">
              {/* Zone 1 — Identity (fixed ~35% so short names don't expand) */}
              <div className="flex w-[35%] min-w-0 shrink-0 items-start gap-2">
                <span className={cn("mt-1 h-1.5 w-1.5 shrink-0 rounded-full", isActive ? "bg-[var(--adc-pos-fg)]" : "bg-slate-400")} />
                <div className="min-w-0">
                  <p className="truncate text-[12px] font-semibold text-slate-800">{adset.name}</p>
                  {adset.optimizationGoal && (
                    <p className="mt-0.5 truncate text-[10px] uppercase tracking-wide text-slate-400">
                      {adset.optimizationGoal}
                    </p>
                  )}
                </div>
              </div>

              {/* Zone 2 — Bid (flex-1 so it fills remaining space between name and metrics) */}
              <div className="min-w-0 flex-1">
                <div className="flex items-baseline gap-1.5">
                  <span className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">
                    {bidLabel}
                  </span>
                  {bidValueStr && (
                    <span className="font-mono text-[12px] font-bold text-slate-800">
                      {bidValueStr}
                    </span>
                  )}
                </div>
                {prevBidValueStr && (
                  <p className="mt-0.5 text-[10px] text-slate-400">
                    ← {prevBidValueStr}{prevBidAge ? ` · ${prevBidAge}` : ""}
                  </p>
                )}
              </div>

              {/* Zone 3 — Metrics: Spend | ROAS | CPA | CTR */}
              <div className="flex shrink-0 items-center gap-3">
                <div className="text-right">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">Spend</p>
                  <p className="font-mono text-[11px] font-bold tabular-nums text-slate-700">{fmtK(adset.spend, sym)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">ROAS</p>
                  <p className={cn("font-mono text-[11px] font-bold tabular-nums", roasColor(roas))}>{roas.toFixed(2)}×</p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">CPA</p>
                  <p className="font-mono text-[11px] font-bold tabular-nums text-slate-700">{fmt$(adset.cpa, sym)}</p>
                </div>
                <div className="text-right">
                  <p className="text-[9px] font-semibold uppercase tracking-wide text-slate-400">CTR</p>
                  <p className="font-mono text-[11px] font-bold tabular-nums text-slate-700">{ctrStr}</p>
                </div>
              </div>
            </div>
          </div>
        );
      })}
    </div>
  );
}

// ── Empty / account overview state ───────────────────────────────────────────

interface AccountOverviewProps {
  recommendationsData: MetaRecommendationsResponse | undefined;
  isRecsLoading: boolean;
  lastAnalyzedAt: Date | null;
  recommendationsError?: string | null;
  checkedRecIds: Set<string>;
  onToggleCheck: (id: string) => void;
  onAnalyze: () => void;
  ageRows: BreakdownRow[];
  placementRows: PlacementChartRow[];
  isBreakdownLoading: boolean;
  businessId: string;
  since: string;
  until: string;
  language: "en" | "tr";
  supportingContextOpen: boolean;
  onSupportingContextToggle: (open: boolean) => void;
}

function AccountOverview(props: AccountOverviewProps) {
  return (
    <div className="space-y-4 p-6" data-testid="meta-account-overview">
      <div className="rounded-2xl border border-slate-200 bg-white p-4 shadow-sm">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          Account Drilldown
        </p>
        <p className="mt-1 text-sm font-semibold text-slate-950">
          Use the campaign list to inspect the rows that need review next.
        </p>
        <p className="mt-2 text-xs leading-relaxed text-slate-500">
          Campaign Drilldown stays on the left, while snapshot-backed recommendations and
          supporting context stay together in this detail pane.
        </p>
      </div>
      <details
        className="rounded-2xl border border-slate-200 bg-white shadow-sm"
        data-testid="meta-supporting-context"
        onToggle={(event) =>
          props.onSupportingContextToggle(event.currentTarget.open)
        }
      >
        <summary className="cursor-pointer list-none px-4 py-3 text-sm font-semibold text-slate-900">
          Workflow and context
        </summary>
        {props.supportingContextOpen ? (
          <div className="space-y-4 border-t border-slate-200 px-4 py-4">
            <MetaOperatingModeCard
              businessId={props.businessId}
              startDate={props.since}
              endDate={props.until}
              enabled={props.supportingContextOpen}
            />
            <MetaAccountRecs
              recommendationsData={props.recommendationsData}
              isRecsLoading={props.isRecsLoading}
              lastAnalyzedAt={props.lastAnalyzedAt}
              checkedRecIds={props.checkedRecIds}
              onToggleCheck={props.onToggleCheck}
              onAnalyze={props.onAnalyze}
              analysisError={props.recommendationsError}
              language={props.language}
            />
            <MetaBreakdownGrid
              ageRows={props.ageRows}
              placementRows={props.placementRows}
              isLoading={props.isBreakdownLoading}
              language={props.language}
            />
          </div>
        ) : null}
      </details>
    </div>
  );
}

// ── Main component ────────────────────────────────────────────────────────────

export function MetaCampaignDetail({
  campaign,
  recommendationsData,
  analysisStatus,
  isRecsLoading,
  lastAnalyzedAt,
  recommendationsError,
  checkedRecIds,
  onToggleCheck,
  onAnalyze,
  onClearSelection,
  businessId,
  since,
  until,
  language,
}: MetaCampaignDetailProps) {
  const sym = useCurrencySymbol();
  const [supportingContextOpen, setSupportingContextOpen] = useState(false);
  const shouldLoadBreakdowns = Boolean(
    !campaign && supportingContextOpen && businessId && since && until
  );
  const breakdownsQuery = useQuery<MetaBreakdownsResponse>({
    queryKey: ["meta-breakdowns", businessId, since, until],
    enabled: shouldLoadBreakdowns,
    staleTime: 60 * 1000,
    queryFn: async () => {
      const params = new URLSearchParams({
        businessId,
        startDate: since,
        endDate: until,
      });
      const res = await fetch(`/api/meta/breakdowns?${params.toString()}`, {
        headers: { Accept: "application/json" },
        cache: "no-store",
      });
      const payload = await res.json().catch(() => null);
      if (!res.ok) {
        throw new Error(payload?.message ?? `Request failed (${res.status})`);
      }
      return payload as MetaBreakdownsResponse;
    },
  });
  const placementRows = useMemo(
    () =>
      (breakdownsQuery.data?.placement ?? []).map((row) => ({
        key: row.key,
        label: row.label,
        spend: row.spend,
        roas: row.spend > 0 ? row.revenue / row.spend : 0,
      })),
    [breakdownsQuery.data?.placement]
  );
  const recommendationSource =
    analysisStatus?.recommendationSource ?? getMetaRecommendationSource(recommendationsData);

  useEffect(() => {
    if (campaign) setSupportingContextOpen(false);
  }, [campaign]);

  if (!campaign) {
    return (
      <AccountOverview
        recommendationsData={recommendationsData}
        isRecsLoading={isRecsLoading}
        lastAnalyzedAt={lastAnalyzedAt}
        recommendationsError={recommendationsError}
        checkedRecIds={checkedRecIds}
        onToggleCheck={onToggleCheck}
        onAnalyze={onAnalyze}
        ageRows={breakdownsQuery.data?.age ?? []}
        placementRows={placementRows}
        isBreakdownLoading={breakdownsQuery.isLoading}
        businessId={businessId}
        since={since}
        until={until}
        language={language}
        supportingContextOpen={supportingContextOpen}
        onSupportingContextToggle={setSupportingContextOpen}
      />
    );
  }

  // Find this campaign's recommendation (highest priority = act > test > watch)

  const ORDER: Record<MetaRecommendation["decisionState"], number> = { act: 0, test: 1, watch: 2 };
  const rec = (recommendationsData?.recommendations ?? [])
    .filter((r) => r.campaignId === campaign.id)
    .sort((a, b) => ORDER[a.decisionState] - ORDER[b.decisionState])[0] ?? null;

  const roas = campaign.roas;


  return (
    <div className="space-y-5 p-6" data-testid="meta-campaign-detail">
      {/* Back breadcrumb */}
      <button
        onClick={onClearSelection}
        className="flex items-center gap-1 text-[11px] text-slate-400 transition-colors hover:text-slate-600"
      >
        ← {language === "tr" ? "Hesap Geneli" : "Account Overview"}
      </button>

      {/* Campaign header */}
      <div>
        <div className="flex items-start gap-2">
          <div className="min-w-0 flex-1">
            <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
              {campaign.objective ?? "—"}
            </p>
            <h2 className="mt-0.5 text-lg font-bold leading-tight text-slate-950">
              {campaign.name}
            </h2>
          </div>
          <span
            className={cn(
              "shrink-0 rounded-full px-2 py-1 text-[10px] font-semibold uppercase",
              campaign.status.toLowerCase() === "active"
                ? "bg-[var(--adc-pos-fg)]/10 text-[var(--adc-pos-fg)]"
                : "bg-slate-400/10 text-slate-500"
            )}
          >
            {campaign.status}
          </span>
        </div>
      </div>

      <CampaignOperatorHeadline
        recommendation={rec}
        analysisStatus={analysisStatus}
        recommendationSource={recommendationSource}
      />

      {/* Metric grid — Spend / Revenue / ROAS / CPA / Budget */}
      <div className="grid grid-cols-5 gap-1.5">
        <MetricTile label="Spend" value={fmtK(campaign.spend, sym)} />
        <MetricTile label="Revenue" value={fmtK(campaign.revenue, sym)} valueClass="text-[var(--adc-pos-fg)]" />
        <MetricTile label="ROAS" value={`${roas.toFixed(2)}×`} valueClass={roasColor(roas)} />
        <MetricTile label="CPA" value={fmt$(campaign.cpa, sym)} />
        {(campaign.dailyBudget != null || campaign.lifetimeBudget != null) && (
          <MetricTile
            label={language === "tr" ? "Bütçe" : "Budget"}
            value={campaign.dailyBudget != null
              ? `${fmt$(campaign.dailyBudget / 100, sym)}/day`
              : `${fmt$(campaign.lifetimeBudget! / 100, sym)} lifetime`}
            sub={(campaign.previousDailyBudget != null || campaign.previousLifetimeBudget != null)
              ? `prev ${campaign.previousDailyBudget != null
                  ? `${fmt$(campaign.previousDailyBudget / 100, sym)}/d`
                  : `${fmt$(campaign.previousLifetimeBudget! / 100, sym)}`}${campaign.previousBudgetCapturedAt ? ` · ${formatRelativeAge(campaign.previousBudgetCapturedAt)}` : ""}`
              : undefined}
          />
        )}
      </div>

      {/* Ad sets */}
      <div className="space-y-2" data-testid="meta-adsets-section">
        <p className="text-[11px] font-semibold uppercase tracking-[0.16em] text-slate-400">
          {language === "tr" ? "Ad Set'ler" : "Ad Sets"}
        </p>
        <AdSetList
          campaignId={campaign.id}
          businessId={businessId}
          since={since}
          until={until}
          sym={sym}
          language={language}
        />
      </div>

    </div>
  );
}
