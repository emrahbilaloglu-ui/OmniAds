"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, ChevronDown, Info, Play, Plus, RefreshCw, RotateCcw, Rocket, SlidersHorizontal, Tags, Target, TrendingUp } from "lucide-react";
import {
  CompareDrawer,
  TrackingConfirmModal,
  useDeferState,
  type CompareDrawerItem,
} from "@/components/common/briefing";
import {
  HtmlDateRangePicker,
  rangeForWindow,
  windowLabel,
  type HtmlDateRangeValue,
  type HtmlDateWindowKey,
} from "@/components/common/briefing/HtmlDateRangePicker";
import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { cn } from "@/lib/utils";
import { MetaActionCard } from "@/components/meta/redesign/MetaActionCard";
import { MetaCampaignLabelsSection } from "@/components/meta/redesign/MetaCampaignLabelsSection";
import { MetaDrillDrawer } from "@/components/meta/redesign/MetaDrillDrawer";
import { MetaHealthyRow } from "@/components/meta/redesign/MetaHealthyRow";
import { MetaLaunchpadOverlay } from "@/components/meta/redesign/MetaLaunchpadOverlay";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { MetaUpperFunnelInformationalCard } from "@/components/meta/redesign/MetaUpperFunnelInformationalCard";
import {
  decisionLabelForRec,
  launchModeForRec,
  proposedBidDisplayValue,
  proposedBidMinorForExecute,
  scopeIdForRec,
  scopeNameForRec,
  structuredMetricsForRec,
  formatMoney,
} from "@/components/meta/redesign/meta-card-utils";
import { formatCurrency, formatRoas, sparklinePath } from "@/lib/briefing/utils";
import {
  BRIEFING_STATUS_FILTER_LABELS,
  BRIEFING_STATUS_FILTERS,
  parseBriefingStatusFilter,
  type BriefingStatusFilter,
} from "@/lib/meta/briefing-filter";
import type {
  MetaArchivedEntity,
  MetaDrillItem,
  MetaHealthyEntity,
  MetaLanePayload,
  MetaLaunchMode,
  MetaPulsePayload,
  MetaWatchingSegment,
  MetaWindowKey,
} from "@/components/meta/redesign/types";

interface MetaPlatformPageProps {
  businessId: string;
  businessName?: string | null;
  currency?: string | null;
}

interface AnomaliesPayload {
  anomalies: MetaAnomaly[];
  snapshotDate: string | null;
  count: number;
}

interface OverlayState {
  open: boolean;
  mode: MetaLaunchMode;
  rec: MetaRecommendation | null;
}

const EMPTY_OVERLAY: OverlayState = { open: false, mode: "rebuild", rec: null };
type LocalResponseState = "acted" | "deferred" | "ignored";
type PrimaryActionFeedback = {
  recId: string;
  tone: "success" | "error" | "info";
  title: string;
  detail?: string | null;
};
type ArchiveActionFeedback = {
  key: string;
  tone: "success" | "error" | "info";
  title: string;
  detail?: string | null;
};
type PendingResumeIntent =
  | { kind: "recommendation"; rec: MetaRecommendation }
  | { kind: "archive"; row: MetaArchivedEntity };
type MetaLaneView = "action" | "watching" | "healthy" | "nonSales" | "archive";
type MetaLevelFilter = "campaign" | "adset";
type MetaAutomationFilter = "all" | "auto" | "manual";
type MetaLabelFilter = "all" | "main" | "test" | "mixed";
type MetaSecondaryMenu = "campaign" | "automation" | "label";

const META_AUTOMATION_FILTERS: Array<{ value: MetaAutomationFilter; label: string; description: string }> = [
  { value: "all", label: "All", description: "Show every recommendation in the current server lane." },
  { value: "auto", label: "Auto-ready", description: "Show recommendations already eligible for the primary action." },
  { value: "manual", label: "Manual only", description: "Show recommendations that still require buyer review." },
];

const META_LABEL_FILTERS: Array<{ value: MetaLabelFilter; label: string; description: string }> = [
  { value: "all", label: "All labels", description: "Do not narrow by Main, Test, or Mixed context." },
  { value: "main", label: "Main", description: "Campaigns currently treated as mainline buying." },
  { value: "test", label: "Test", description: "Campaigns currently treated as testing context." },
  { value: "mixed", label: "Mixed", description: "Campaigns explicitly marked as mixed context." },
];

function parseMetaLaneView(value: string | null): MetaLaneView {
  if (value === "watching" || value === "healthy" || value === "nonSales" || value === "archive") return value;
  return "action";
}

function parseMetaWindow(value: string | null): MetaWindowKey {
  if (value === "7d" || value === "14d" || value === "28d" || value === "90d" || value === "custom") return value;
  return "28d";
}

function metaDateRangeFromParams(params: URLSearchParams): HtmlDateRangeValue {
  const selected = parseMetaWindow(params.get("window"));
  if (selected === "custom") {
    const start = params.get("startDate") ?? "";
    const end = params.get("endDate") ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { window: "custom", start, end };
    }
  }
  return rangeForWindow(selected as HtmlDateWindowKey);
}

function recMatchesMetaFilters(rec: MetaRecommendation, input: {
  level: MetaLevelFilter;
  campaignId: string;
  automation: MetaAutomationFilter;
  label: MetaLabelFilter;
}) {
  if (input.level === "adset" && rec.level !== "adset") return false;
  if (input.campaignId !== "all" && rec.campaignId !== input.campaignId) return false;
  if (input.automation !== "all") {
    const tier = rec.automationReadiness?.tier ?? "manual_review";
    const autoReady = tier === "auto_execute" || tier === "backtest_candidate";
    if (input.automation === "auto" && !autoReady) return false;
    if (input.automation === "manual" && autoReady) return false;
  }
  return campaignKindMatchesMetaLabelFilter(rec.campaignKind, input.label);
}

export function campaignKindMatchesMetaLabelFilter(
  campaignKind: string | null | undefined,
  label: "all" | "main" | "test" | "mixed",
) {
  if (label === "all") return true;
  const normalized = String(campaignKind ?? "").toLowerCase();
  return normalized === label;
}

function healthyMatchesMetaFilters(row: MetaHealthyEntity, input: {
  level: MetaLevelFilter;
  campaignId: string;
  label: MetaLabelFilter;
}) {
  if (input.level === "adset" && row.level !== "adset") return false;
  if (input.campaignId !== "all") {
    const rowCampaignId = row.level === "campaign" ? row.id : row.campaignId;
    if (rowCampaignId !== input.campaignId) return false;
  }
  return campaignKindMatchesMetaLabelFilter(row.campaignKind, input.label);
}

function archivedMatchesMetaFilters(row: MetaArchivedEntity, input: {
  level: MetaLevelFilter;
  campaignId: string;
  label: MetaLabelFilter;
}) {
  if (input.level === "adset" && row.level !== "adset") return false;
  if (input.campaignId !== "all") {
    const rowCampaignId = row.level === "campaign" ? row.id : row.campaignId;
    if (rowCampaignId !== input.campaignId) return false;
  }
  return campaignKindMatchesMetaLabelFilter(row.campaignKind, input.label);
}

function todayPlusHours(hours: number) {
  return new Date(Date.now() + hours * 60 * 60 * 1000).toISOString();
}

async function readJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    const message =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : `Request failed (${response.status})`;
    throw new Error(message);
  }
  return payload as T;
}

function fetchPulse(businessId: string, window: MetaWindowKey, statusFilter: BriefingStatusFilter, range?: Pick<HtmlDateRangeValue, "start" | "end">) {
  const params = new URLSearchParams({ businessId, window, status_filter: statusFilter });
  if (window === "custom" && range) {
    params.set("startDate", range.start);
    params.set("endDate", range.end);
  }
  return readJson<MetaPulsePayload>(`/api/meta/account-pulse?${params.toString()}`);
}

function fetchLanes(businessId: string, window: MetaWindowKey, statusFilter: BriefingStatusFilter, range?: Pick<HtmlDateRangeValue, "start" | "end">) {
  const params = new URLSearchParams({ businessId, window, status_filter: statusFilter });
  if (window === "custom" && range) {
    params.set("startDate", range.start);
    params.set("endDate", range.end);
  }
  return readJson<MetaLanePayload>(`/api/meta/lane-classify?${params.toString()}`);
}

function fetchAnomalies(
  businessId: string,
  window: MetaWindowKey,
  statusFilter: BriefingStatusFilter,
  range?: Pick<HtmlDateRangeValue, "start" | "end">,
) {
  const params = new URLSearchParams({
    businessId,
    activeOnly: "1",
    status_filter: statusFilter,
  });
  // Scope the anomaly snapshot to the selected range's end so historical
  // ranges do not surface today's anomalies. Status filtering runs against
  // the entity status captured at anomaly write time; snapshots written
  // before that field existed fail open (see anomalyMatchesStatusFilter).
  if (window === "custom" && range) {
    params.set("endDate", range.end);
  }
  return readJson<AnomaliesPayload>(`/api/meta/anomalies?${params.toString()}`);
}

function postResponse(input: {
  businessId: string;
  recId: string;
  action: "acted" | "deferred" | "undeferred" | "ignored";
  actionSubtype?: string;
  reappearAt?: string;
}) {
  return fetch("/api/meta/recommendations/respond", {
    method: "POST",
    headers: { "Content-Type": "application/json", Accept: "application/json" },
    cache: "no-store",
    body: JSON.stringify(input),
  });
}

export function metaAdsetPauseNotice(status: unknown, dryRun = false) {
  if (dryRun) return "Dry run: ad set would pause.";
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";
  if (!normalized || normalized === "PAUSED") return "Ad set paused in Meta.";
  return `Ad set pause verified with status ${normalized}.`;
}

function actionPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

export function metaActionFailureMessage(payload: unknown, fallbackMessage: string) {
  const record = actionPayloadRecord(payload);
  const error = actionPayloadRecord(record?.error);
  if (error?.code === "kill_switch_engaged") {
    return "Meta writes are temporarily disabled (kill switch). Try again later.";
  }
  if (typeof record?.message === "string" && record.message.trim()) {
    return record.message;
  }
  if (typeof error?.message === "string" && error.message.trim()) {
    return error.message;
  }
  return fallbackMessage;
}

async function assertActionResponse(response: Response, fallbackMessage: string) {
  const payload = await response.json().catch(() => null);
  if (response.ok && payload?.ok !== false) return payload;
  throw new Error(metaActionFailureMessage(payload, fallbackMessage));
}

export function metaBidApplyNotice(payload: unknown) {
  const record = actionPayloadRecord(payload);
  const dryRun = record?.dryRun === true;
  const bidAmountMinor =
    typeof record?.bidAmountMinor === "number" && Number.isFinite(record.bidAmountMinor)
      ? record.bidAmountMinor
      : null;
  if (dryRun) {
    return {
      tone: "info" as const,
      title: bidAmountMinor
        ? `Dry run: bid cap would apply at ${formatCurrency(bidAmountMinor / 100)}.`
        : "Dry run completed.",
      detail: "No Meta write was performed; Meta verification completed.",
    };
  }
  return {
    tone: "success" as const,
    title: bidAmountMinor
      ? `Bid cap applied at ${formatCurrency(bidAmountMinor / 100)}.`
      : "Bid cap applied.",
    detail: "Meta verified the ad set bid.",
  };
}

function metaEntityResumeNotice(level: "campaign" | "adset" | "ad", status: unknown, dryRun = false) {
  const normalized = typeof status === "string" ? status.trim().toUpperCase() : "";
  const label = level === "campaign" ? "Campaign" : level === "adset" ? "Ad set" : "Ad";
  if (dryRun) return `Dry run: ${label.toLowerCase()} would resume.`;
  if (!normalized || normalized === "ACTIVE") return `${label} resumed in Meta.`;
  return `${label} resume verified with status ${normalized}.`;
}

function launchpadHrefForRec(rec: MetaRecommendation, mode: MetaLaunchMode) {
  const params = new URLSearchParams({
    mode,
    fromMetaBriefing: "true",
  });
  if (rec.campaignId) params.set("campaignIds", rec.campaignId);
  if (rec.adsetId) params.set("adsetIds", rec.adsetId);
  return `/platforms/meta/launchpad?${params.toString()}`;
}

export function compareItemForRec(rec: MetaRecommendation): CompareDrawerItem {
  const trail = rec.evidenceTrail;
  // Numbers come ONLY from the server's structured metrics (and the typed
  // evidence trail); formatted evidence display strings are never parsed
  // back into math. Missing metrics stay null and the entity is excluded
  // from numeric ranking rather than silently becoming zero.
  const metrics = structuredMetricsForRec(rec);
  const peerValue = trail?.peer_comparison?.this_value;
  return {
    id: rec.id,
    name: scopeNameForRec(rec),
    brand: rec.campaignName ?? "Meta",
    label: decisionLabelForRec(rec),
    spend: metrics?.spend ?? undefined,
    roas:
      typeof peerValue === "number" ? peerValue : metrics?.roas ?? undefined,
    cpa: metrics?.cpa ?? undefined,
    ctr: metrics?.ctr ?? undefined,
    purchases: metrics?.purchases ?? undefined,
    frequency: metrics?.frequency ?? undefined,
    sparkline: Array.isArray(trail?.roas_history) ? trail.roas_history.map(Number) : undefined,
  };
}

function groupAdsetRollups(recs: MetaRecommendation[]) {
  const groups = new Map<string, MetaRecommendation[]>();
  for (const rec of recs) {
    if (rec.level !== "adset" || !rec.campaignId) continue;
    groups.set(rec.campaignId, [...(groups.get(rec.campaignId) ?? []), rec]);
  }
  return [...groups.entries()]
    .filter(([, items]) => items.length >= 2)
    .filter(([, items]) => new Set(items.map(decisionLabelForRec)).size > 1)
    .map(([campaignId, items]) => ({
      campaignId,
      campaignName: items[0]?.campaignName ?? campaignId,
      items,
    }));
}

interface HealthyCampaignGroup {
  campaignKey: string;
  campaignName: string;
  campaign?: MetaHealthyEntity;
  adsets: MetaHealthyEntity[];
}

interface HealthyConfigSummary {
  isMixed: boolean;
  value: string | null;
}

function healthyCampaignKey(row: MetaHealthyEntity) {
  if (row.level === "campaign") return row.campaignId ?? row.id;
  if (row.campaignId) return row.campaignId;
  if (row.campaignName) return `campaign-name:${row.campaignName}`;
  return "unassigned-campaign";
}

function ensureHealthyGroup(groups: Map<string, HealthyCampaignGroup>, row: MetaHealthyEntity) {
  const campaignKey = healthyCampaignKey(row);
  const fallbackName =
    row.level === "campaign"
      ? row.name
      : row.campaignName ?? (row.campaignId ? `Campaign ${row.campaignId}` : "Unassigned campaign");
  const existing = groups.get(campaignKey);
  if (existing) return existing;
  const next: HealthyCampaignGroup = {
    campaignKey,
    campaignName: fallbackName,
    adsets: [],
  };
  groups.set(campaignKey, next);
  return next;
}

function groupHealthyEntities(rows: MetaHealthyEntity[]) {
  const groups = new Map<string, HealthyCampaignGroup>();
  for (const row of rows) {
    const group = ensureHealthyGroup(groups, row);
    if (row.level === "campaign") {
      group.campaign = row;
      group.campaignName = row.name;
    } else {
      group.adsets.push(row);
      if (!group.campaign && row.campaignName) group.campaignName = row.campaignName;
    }
  }
  return [...groups.values()];
}

function formatHealthyConfigLabel(value: string | null | undefined) {
  if (!value) return null;
  return value
    .replace(/_/g, " ")
    .toLowerCase()
    .split(/\s+/)
    .map((word, index) => {
      if (index > 0 && ["and", "or", "of", "to", "with"].includes(word)) return word;
      return word.charAt(0).toUpperCase() + word.slice(1);
    })
    .join(" ");
}

function rowOptimizationDisplayValue(row: MetaHealthyEntity) {
  return formatHealthyConfigLabel(row.customEventType) ?? formatHealthyConfigLabel(row.optimizationGoal);
}

function rowOptimizationKey(row: MetaHealthyEntity) {
  if (row.isCustomEventTypeMixed || row.isOptimizationGoalMixed) return "__mixed__";
  return (row.customEventType ?? row.optimizationGoal ?? "").trim().toLowerCase() || "__missing__";
}

function rowBidStrategyDisplayValue(row: MetaHealthyEntity) {
  return row.bidStrategyLabel ?? formatHealthyConfigLabel(row.bidStrategyType);
}

function rowBidStrategyKey(row: MetaHealthyEntity) {
  if (row.isBidStrategyMixed) return "__mixed__";
  return (row.bidStrategyType ?? row.bidStrategyLabel ?? "").trim().toLowerCase() || "__missing__";
}

function summarizeGroupConfig(
  adsets: MetaHealthyEntity[],
  keyForRow: (row: MetaHealthyEntity) => string,
  labelForRow: (row: MetaHealthyEntity) => string | null | undefined,
): HealthyConfigSummary {
  if (adsets.length === 0) return { isMixed: false, value: null };
  const keys = new Set(adsets.map(keyForRow));
  if (keys.size !== 1 || keys.has("__mixed__")) return { isMixed: true, value: "Mix" };
  return { isMixed: false, value: labelForRow(adsets[0]) ?? null };
}

function SyntheticConfigChip({
  label,
  value,
  tone = "slate",
}: {
  label: string;
  value: string | null;
  tone?: "slate" | "violet";
}) {
  if (!value) return null;
  return (
    <span
      title={`${label}: ${value}`}
      className={cn(
        "inline-flex min-w-0 max-w-[210px] items-center gap-1 rounded-md border px-1.5 py-0.5 text-[10.5px]",
        tone === "violet"
          ? "border-violet-200 bg-violet-50 text-violet-700"
          : "border-slate-200 bg-slate-50 text-slate-600",
      )}
    >
      {tone === "violet" ? (
        <Target className="inline-block shrink-0" size={10} aria-hidden="true" />
      ) : (
        <SlidersHorizontal className="inline-block shrink-0" size={10} aria-hidden="true" />
      )}
      <span className="shrink-0 text-slate-400">{label}</span>
      <span className="truncate font-medium">{value}</span>
    </span>
  );
}

function SyntheticHealthyCampaignHeader({
  group,
  optimizationSummary,
  bidStrategySummary,
}: {
  group: HealthyCampaignGroup;
  optimizationSummary: HealthyConfigSummary;
  bidStrategySummary: HealthyConfigSummary;
}) {
  return (
    <div
      className="flex items-center gap-3 rounded-lg border border-dashed border-slate-200 bg-white px-3 py-2"
      data-healthy-synthetic-campaign={group.campaignKey}
    >
      <div className="size-[15px] rounded-full border border-slate-300 bg-slate-50" aria-hidden="true" />
      <MetaScopeChip level="campaign" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-slate-900">{group.campaignName}</div>
        <div className="truncate text-[11px] text-slate-500">Campaign context inferred from adset snapshot</div>
      </div>
      <div className="hidden min-w-0 shrink-0 items-center justify-end gap-1.5 xl:flex">
        <SyntheticConfigChip label="Optimization" value={optimizationSummary.value} tone="violet" />
        <SyntheticConfigChip label="Bid" value={bidStrategySummary.value} />
      </div>
      <div className="text-[11px] text-slate-500">{group.adsets.length} {group.adsets.length === 1 ? "adset" : "adsets"}</div>
    </div>
  );
}

function MetaHealthyHierarchy({
  groups,
  moneyCurrency,
}: {
  groups: HealthyCampaignGroup[];
  moneyCurrency?: string | null;
}) {
  return (
    <>
      {groups.map((group) => {
        const optimizationSummary = summarizeGroupConfig(
          group.adsets,
          rowOptimizationKey,
          rowOptimizationDisplayValue,
        );
        const bidStrategySummary = summarizeGroupConfig(
          group.adsets,
          rowBidStrategyKey,
          rowBidStrategyDisplayValue,
        );
        const hasAdsets = group.adsets.length > 0;

        return (
          <div
            key={group.campaignKey}
            className="rounded-xl border border-slate-200 bg-slate-50/60 p-2"
            data-healthy-campaign-group={group.campaignKey}
          >
            {group.campaign ? (
              <MetaHealthyRow
                row={group.campaign}
                moneyCurrency={moneyCurrency}
                optimizationValueOverride={hasAdsets ? optimizationSummary.value : undefined}
                bidStrategyValueOverride={hasAdsets ? bidStrategySummary.value : undefined}
                showBidValue={false}
                showPreviousBid={false}
              />
            ) : (
              <SyntheticHealthyCampaignHeader
                group={group}
                optimizationSummary={optimizationSummary}
                bidStrategySummary={bidStrategySummary}
              />
            )}
            {group.adsets.length > 0 ? (
              <div
                className="ml-5 mt-2 grid gap-2 border-l border-slate-200 pl-4"
                data-healthy-adsets-for-campaign={group.campaignKey}
              >
                {group.adsets.map((row) => (
                  <MetaHealthyRow
                    key={`${row.level}-${row.id}`}
                    row={row}
                    moneyCurrency={moneyCurrency}
                    depth="child"
                    hideCampaignName={row.campaignName === group.campaignName}
                    hideOptimization={!optimizationSummary.isMixed}
                    hideBidStrategy={!bidStrategySummary.isMixed}
                  />
                ))}
              </div>
            ) : null}
          </div>
        );
      })}
    </>
  );
}

function EmptyActionState({
  anomaliesCount,
  pulse,
  onManageLabels,
}: {
  anomaliesCount: number;
  pulse?: MetaPulsePayload | null;
  onManageLabels: () => void;
}) {
  const coverage = pulse?.labelCoverage ?? null;
  const targetAnchor = pulse?.targetAnchor ?? null;
  const showLabelCta = Boolean(coverage && coverage.activeCampaigns > 0 && coverage.unlabeledCampaigns > 0);
  const showTargetCta = Boolean(targetAnchor && !targetAnchor.configured);

  return (
    <div className="rounded-2xl border border-dashed border-slate-300 bg-white p-8 text-center" data-empty-action-state>
      <div className="mx-auto grid size-10 place-items-center rounded-full bg-slate-50 text-slate-500">
        <AlertTriangle className="inline-block shrink-0" size={18} aria-hidden="true" />
      </div>
      <h3 className="mt-3 text-[15px] font-semibold text-slate-900">No high-confidence calls today</h3>
      <p className="mt-1 text-[12.5px] text-slate-500">
        {anomaliesCount > 0
          ? "Active anomalies are surfaced above while decision confidence stays below the act threshold."
          : "The engine is watching for stronger campaign or adset evidence before surfacing action."}
      </p>
      {showLabelCta || showTargetCta ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2 text-left">
          {showLabelCta ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-md border border-amber-200 bg-amber-50 px-3 py-1.5 text-[12px] font-medium text-amber-800 hover:bg-amber-100"
              onClick={onManageLabels}
            >
              <Target className="inline-block shrink-0" size={12} aria-hidden="true" />
              Label {coverage!.unlabeledCampaigns} campaigns
            </button>
          ) : null}
          {showTargetCta ? (
            <a
              href="/commercial-truth"
              className="inline-flex items-center gap-1 rounded-md border border-blue-200 bg-blue-50 px-3 py-1.5 text-[12px] font-medium text-blue-700 hover:bg-blue-100"
            >
              <SlidersHorizontal className="inline-block shrink-0" size={12} aria-hidden="true" />
              Set target pack
            </a>
          ) : null}
        </div>
      ) : null}
    </div>
  );
}

function formatSnapshotAge(hours: number | null | undefined) {
  if (hours == null || !Number.isFinite(hours)) return null;
  if (hours < 1) return `${Math.max(1, Math.round(hours * 60))}m`;
  if (hours < 48) return `${Math.round(hours)}h`;
  return `${Math.round(hours / 24)}d`;
}

function ReadinessNotice({
  pulse,
  onRefresh,
  refreshing,
  onManageLabels,
}: {
  pulse?: MetaPulsePayload | null;
  onRefresh: () => void;
  refreshing: boolean;
  onManageLabels: () => void;
}) {
  if (!pulse) return null;
  const coverage = pulse.labelCoverage ?? null;
  const targetAnchor = pulse.targetAnchor ?? null;
  const snapshot = pulse.snapshotHealth ?? null;
  const needsLabels = Boolean(coverage && coverage.activeCampaigns > 0 && coverage.unlabeledCampaigns > 0);
  const needsTarget = Boolean(targetAnchor && !targetAnchor.configured);
  const staleSnapshot = Boolean(snapshot && snapshot.status !== "fresh");
  if (!needsLabels && !needsTarget && !staleSnapshot) return null;

  return (
    <div className="mb-4 rounded-xl border border-amber-200 bg-amber-50/80 px-4 py-3 text-[12.5px] text-amber-950" data-meta-readiness-notice>
      <div className="flex flex-wrap items-center gap-2">
        <AlertTriangle className="inline-block shrink-0 text-amber-700" size={15} aria-hidden="true" />
        <span className="font-semibold">Decision readiness needs attention</span>
        {snapshot?.ageHours != null ? (
          <span className="rounded-md border border-amber-200 bg-white/70 px-1.5 py-0.5 text-[10.5px] font-medium text-amber-800">
            snapshot age {formatSnapshotAge(snapshot.ageHours)}
          </span>
        ) : null}
      </div>
      <div className="mt-2 flex flex-wrap gap-2">
        {needsLabels ? (
          <button
            type="button"
            className="rounded-md border border-amber-300 bg-white px-2.5 py-1.5 font-medium text-amber-800 hover:bg-amber-100"
            onClick={onManageLabels}
          >
            {coverage!.labeledCampaigns}/{coverage!.activeCampaigns} active campaigns labeled
          </button>
        ) : null}
        {needsTarget ? (
          <a href="/commercial-truth" className="rounded-md border border-blue-200 bg-white px-2.5 py-1.5 font-medium text-blue-700 hover:bg-blue-50">
            Target pack missing
          </a>
        ) : null}
        {staleSnapshot ? (
          <button
            type="button"
            className="rounded-md border border-slate-300 bg-white px-2.5 py-1.5 font-medium text-slate-700 hover:bg-slate-50 disabled:cursor-not-allowed disabled:opacity-60"
            disabled={refreshing}
            onClick={onRefresh}
          >
            {refreshing ? "Refreshing..." : "Refresh decisions now"}
          </button>
        ) : null}
      </div>
      {snapshot?.staleReason ? <p className="mt-2 text-[11.5px] text-amber-800">{snapshot.staleReason}</p> : null}
    </div>
  );
}

function WatchingSegments({
  segments,
  onManageLabels,
}: {
  segments?: MetaWatchingSegment[] | null;
  onManageLabels: () => void;
}) {
  if (!segments?.length) return null;
  return (
    <div className="mb-3 flex flex-wrap gap-2" data-meta-watching-segments>
      {segments.map((segment) => {
        const content = (
          <>
            <span className="font-semibold">{segment.label}</span>
            <span className="font-mono tabular-nums">{segment.count}</span>
            {segment.ctaLabel ? <span className="text-slate-400">{segment.ctaLabel}</span> : null}
          </>
        );
        const className =
          "inline-flex items-center gap-1.5 rounded-md border border-slate-200 bg-white px-2 py-1 text-[11.5px] text-slate-600 shadow-sm";
        if (segment.key === "unlabeled") {
          return (
            <button
              key={segment.key}
              type="button"
              className={className}
              title={segment.description}
              data-watch-segment={segment.key}
              onClick={onManageLabels}
            >
              {content}
            </button>
          );
        }
        return segment.href ? (
          <a key={segment.key} href={segment.href} className={className} title={segment.description} data-watch-segment={segment.key}>
            {content}
          </a>
        ) : (
          <span key={segment.key} className={className} title={segment.description} data-watch-segment={segment.key}>
            {content}
          </span>
        );
      })}
    </div>
  );
}

function archiveStatusClassName(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === "PAUSED") return "border-amber-200 bg-amber-50 text-amber-700";
  if (normalized === "ARCHIVED") return "border-slate-200 bg-slate-50 text-slate-600";
  if (normalized === "DELETED") return "border-rose-200 bg-rose-50 text-rose-700";
  return "border-slate-200 bg-white text-slate-500";
}


function shortRelativeTime(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return null;
  const diffSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (diffSeconds < 60) return `${Math.max(1, diffSeconds)}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 48) return `${diffHours}h ago`;
  return `${Math.round(diffHours / 24)}d ago`;
}

function formatCompactCurrency(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (Math.abs(value) >= 1000) return `$${(value / 1000).toFixed(value >= 10_000 ? 1 : 2).replace(/\.0$/, "")}k`;
  return formatCurrency(value);
}

function formatSignedPercent(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return null;
  const rounded = Math.round(value);
  if (rounded === 0) return "0%";
  return `${rounded > 0 ? "+" : ""}${rounded}%`;
}

/**
 * Tracking confirm label from the server-owned actionKind. The old ternary
 * keyed on rec.type and defaulted to "Rebuild anyway", so once execute_bid
 * became tracking-gated its confirm modal lied about the action (Codex
 * follow-up review). Copy must always name what confirming will do.
 */
export function trackingConfirmLabelForRec(
  rec: Pick<MetaRecommendation, "actionKind"> | null | undefined,
): string {
  switch (rec?.actionKind) {
    case "execute_pause":
      return "Pause anyway";
    case "execute_bid":
      return "Apply bid anyway";
    case "execute_resume":
      return "Resume anyway";
    case "route_launchpad_rebuild":
      return "Rebuild anyway";
    default:
      return "Continue anyway";
  }
}

/**
 * Write gate for tracking anomalies. Pure and dismissal-free BY SIGNATURE:
 * the banner's Dismiss button only hides the banner; it can never unlock
 * pause/rebuild/resume (Codex review: the old gate keyed on dismissal).
 */
export function isTrackingWriteBlocked(
  pulse: Pick<MetaPulsePayload, "trackingAnomalyActive" | "trackingHealth"> | null | undefined,
): boolean {
  return Boolean(
    pulse?.trackingAnomalyActive ??
      (pulse?.trackingHealth.status === "blocked" ||
        pulse?.trackingHealth.status === "degraded"),
  );
}

function percentDelta(current: number | null | undefined, previous: number | null | undefined) {
  if (current == null || previous == null || !Number.isFinite(current) || !Number.isFinite(previous) || previous <= 0) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function formatAverageCount(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  return value >= 10 ? String(Math.round(value)) : value.toFixed(value >= 1 ? 1 : 2).replace(/\.0$/, "");
}

function labelCoveragePercent(pulse?: MetaPulsePayload | null) {
  const coverage = pulse?.labelCoverage;
  if (!coverage || coverage.activeCampaigns <= 0) return null;
  return Math.round((coverage.labeledCampaigns / coverage.activeCampaigns) * 100);
}

function snapshotStatusClass(status: NonNullable<MetaPulsePayload["snapshotHealth"]>["status"] | undefined) {
  if (status === "fresh") return "chip--healthy";
  if (status === "stale" || status === "engine_version_mismatch") return "chip--watch";
  return "chip--ghost";
}

function trackingClass(status: MetaPulsePayload["trackingHealth"]["status"] | undefined) {
  if (status === "healthy") return "chip--healthy";
  if (status === "degraded" || status === "blocked") return "chip--action";
  return "chip--ghost";
}

function titleCaseCompact(value: string | null | undefined) {
  if (!value) return "—";
  return value
    .replace(/[_-]+/g, " ")
    .replace(/\s+/g, " ")
    .trim()
    .replace(/\b\w/g, (char) => char.toUpperCase());
}

function automationFilterLabel(value: MetaAutomationFilter) {
  return META_AUTOMATION_FILTERS.find((option) => option.value === value)?.label ?? "All";
}

function labelFilterLabel(value: MetaLabelFilter) {
  return META_LABEL_FILTERS.find((option) => option.value === value)?.label ?? "All labels";
}

function MetaCompactFilter({
  id,
  label,
  value,
  active,
  open,
  onToggle,
  children,
}: {
  id: MetaSecondaryMenu;
  label: string;
  value: string;
  active: boolean;
  open: boolean;
  onToggle: (id: MetaSecondaryMenu) => void;
  children: ReactNode;
}) {
  return (
    <div className="filter-menu-wrap">
      <button
        type="button"
        className={cn("filter-trigger", active && "is-active", open && "is-open")}
        aria-haspopup="menu"
        aria-expanded={open}
        aria-controls={`meta-filter-${id}`}
        onClick={() => onToggle(id)}
      >
        <span className="k">{label}</span>
        <span className="v">{value}</span>
        <ChevronDown className="chev" size={14} aria-hidden="true" />
      </button>
      {open ? (
        <div id={`meta-filter-${id}`} className="filter-popover" role="menu" aria-label={`${label} filter`}>
          {children}
        </div>
      ) : null}
    </div>
  );
}

function MetaStatusControls({
  selectedStatusFilter,
  onStatusFilterChange,
}: {
  selectedStatusFilter: BriefingStatusFilter;
  onStatusFilterChange: (filter: BriefingStatusFilter) => void;
}) {
  return (
    <div className="group" aria-label="Meta status selector">
      {BRIEFING_STATUS_FILTERS.map((filter) => (
        <button
          key={filter}
          type="button"
          className={selectedStatusFilter === filter ? "on" : ""}
          data-status-filter-option={filter}
          onClick={() => onStatusFilterChange(filter)}
        >
          {BRIEFING_STATUS_FILTER_LABELS[filter]}
        </button>
      ))}
    </div>
  );
}

function MetaLaneTab({
  active,
  className,
  label,
  count,
  onClick,
}: {
  active: boolean;
  className?: string;
  label: string;
  count: number;
  onClick: () => void;
}) {
  return (
    <button type="button" className={cn("tab", className, active ? "active" : "")} onClick={onClick}>
      {label} <span className="count">{count}</span>
    </button>
  );
}

function FinalMetaPulse({
  pulse,
  window,
  onManageLabels,
  moneyCurrency,
  laneAsOf,
}: {
  pulse?: MetaPulsePayload | null;
  window: MetaWindowKey;
  onManageLabels: () => void;
  moneyCurrency?: string | null;
  laneAsOf?: { snapshotDate: string | null; snapshotCreatedAt?: string | null } | null;
}) {
  const endIsToday =
    !pulse?.endDate || pulse.endDate === new Date().toISOString().slice(0, 10);
  const lastSyncLabel = pulse?.lastSyncAt
    ? shortRelativeTime(pulse.lastSyncAt)
    : null;
  const labelPercent = labelCoveragePercent(pulse);
  const snapshotAge =
    pulse?.snapshotHealth?.ageHours != null
      ? formatSnapshotAge(pulse.snapshotHealth.ageHours)
      : shortRelativeTime(pulse?.engineLastRun);
  const snapshotStatus = pulse?.snapshotHealth?.status ?? "missing";
  const dailySpend =
    pulse?.pacing.spendToday ??
    (pulse?.pacing.dayPace != null && pulse?.pacing.dailyTarget != null
      ? pulse.pacing.dayPace * pulse.pacing.dailyTarget
      : null);
  const avg7dSpend = pulse?.pacing.avg7dSpend ?? null;
  const spendVs7dAvg = formatSignedPercent(percentDelta(dailySpend, avg7dSpend));
  const conversionsToday = pulse?.pacing.conversionsToday ?? null;
  const avg7dConversions = pulse?.pacing.avg7dConversions ?? null;
  const roasValue =
    window === "custom"
      ? pulse?.roas.selected
      : window === "7d"
        ? pulse?.roas.d7
        : window === "14d"
          ? pulse?.roas.d14
          : pulse?.roas.d28;

  return (
    <div className="pulse pulse--five">
      <div className="cell">
        <div className="label">
          <span>{endIsToday ? "Spend · today" : `Spend · ${pulse?.endDate ?? "last day"}`}</span>
          <span style={{ color: "var(--muted)" }}>vs 7d avg</span>
        </div>
        <div className="value">
          {dailySpend == null ? "—" : formatMoney(dailySpend, moneyCurrency)}
          <span className="sub">
            {avg7dSpend == null
              ? " avg —"
              : ` avg ${formatMoney(avg7dSpend, moneyCurrency)}/day${spendVs7dAvg ? ` · ${spendVs7dAvg}` : ""}`}
          </span>
        </div>
        <div className="micro">
          conversions · {conversionsToday == null ? "—" : formatAverageCount(conversionsToday)}
          {avg7dConversions == null ? "" : ` · 7d avg ${formatAverageCount(avg7dConversions)}/day`}
        </div>
      </div>
      <div className="cell">
        <div className="label">
          <span>ROAS · {window === "90d" ? "28d" : window}</span>
          <span style={{ color: "var(--ok)" }}>{pulse?.roas.target && roasValue && roasValue >= pulse.roas.target ? "↑ vs target" : "vs target"}</span>
        </div>
        <div className="value">
          {formatRoas(roasValue)} <span className="sub">tgt {pulse?.roas.target == null ? "—" : formatRoas(pulse.roas.target)}</span>
        </div>
        {pulse?.roasHistory?.length ? (
          <svg className="spark" viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden="true">
            <defs>
              <linearGradient id="meta-pulse-spark" x1="0" y1="0" x2="1" y2="0">
                <stop offset="0%" stopColor="#2f6bff" />
                <stop offset="100%" stopColor="#0e9f6e" />
              </linearGradient>
            </defs>
            <path
              d={sparklinePath(pulse.roasHistory.slice(-28))}
              fill="none"
              stroke="url(#meta-pulse-spark)"
              strokeWidth="2"
              strokeLinecap="round"
              strokeLinejoin="round"
            />
          </svg>
        ) : null}
      </div>
      <div className="cell">
        <div className="label">
          <span>Snapshot</span>
          <span className={cn("chip", snapshotStatusClass(snapshotStatus))} style={{ height: 16, padding: "0 6px", fontSize: 9.5 }}>
            <span className="dot" />
            {snapshotStatus === "engine_version_mismatch" ? "version" : snapshotStatus}
          </span>
        </div>
        <div className="value">{snapshotAge ?? "—"}</div>
        <div className="micro">
          engine {pulse?.engineVersion ?? "—"} · ran {pulse?.engineLastRun ? new Date(pulse.engineLastRun).toLocaleTimeString([], { hour: "2-digit", minute: "2-digit" }) : "—"} · data{" "}
          {lastSyncLabel ? `synced ${lastSyncLabel}` : "sync unknown"}
          {laneAsOf ? ` · lanes ${laneAsOf.snapshotDate ?? "unavailable"}` : null}
        </div>
      </div>
      <div className="cell">
        <div className="label">
          <span>Labels</span>
          {labelPercent != null ? (
            <span className={cn("chip", labelPercent >= 90 ? "chip--healthy" : "chip--watch")} style={{ height: 16, padding: "0 6px", fontSize: 9.5 }}>
              <span className="dot" />
              {labelPercent}%
            </span>
          ) : null}
        </div>
        <div className="value">
          {pulse?.labelCoverage ? `${pulse.labelCoverage.labeledCampaigns} / ${pulse.labelCoverage.activeCampaigns}` : "—"}
        </div>
        <div className="micro">
          {pulse?.labelCoverage ? `${pulse.labelCoverage.unlabeledCampaigns} unlabeled · ` : "coverage unavailable · "}
          <button
            type="button"
            className="linklike"
            aria-label="Manage campaign labels"
            onClick={onManageLabels}
          >
            Manage labels
          </button>
        </div>
      </div>
      <div className="cell">
        <div className="label"><span>Mode</span></div>
        <div className="value" style={{ fontSize: 14 }}>{titleCaseCompact(pulse?.operatingMode || "Manual review")}</div>
        <div className="status-row">
          <span className="chip chip--ghost"><span className="dot" />{titleCaseCompact(pulse?.seasonalRegime || "normal")}</span>
          <span className={cn("chip", trackingClass(pulse?.trackingHealth?.status))}><span className="dot" />{pulse?.trackingHealth?.status ?? "unknown"}</span>
        </div>
      </div>
    </div>
  );
}

export function MetaPlatformPage({ businessId, businessName, currency = "USD" }: MetaPlatformPageProps) {
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const selectedWindow = parseMetaWindow(searchParams.get("window"));
  const selectedDateRange = metaDateRangeFromParams(searchParams);
  const selectedStatusFilter = parseBriefingStatusFilter(searchParams.get("status_filter"));
  const initialLane = parseMetaLaneView(searchParams.get("lane"));
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({ nonSales: true });
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drillItem, setDrillItem] = useState<MetaDrillItem | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
  const [compareOpen, setCompareOpen] = useState(false);
  const [pendingPrimaryRec, setPendingPrimaryRec] = useState<MetaRecommendation | null>(null);
  const [pendingResumeIntent, setPendingResumeIntent] = useState<PendingResumeIntent | null>(null);
  const [localDeferredIds, setLocalDeferredIds] = useState<Set<string>>(new Set());
  const [localResponseStates, setLocalResponseStates] = useState<Record<string, LocalResponseState>>({});
  const [trackingDismissed, setTrackingDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [primaryActionFeedback, setPrimaryActionFeedback] = useState<PrimaryActionFeedback | null>(null);
  const [archiveActionFeedback, setArchiveActionFeedback] = useState<ArchiveActionFeedback | null>(null);
  const [pendingActionRecId, setPendingActionRecId] = useState<string | null>(null);
  const [pendingArchiveEntityKey, setPendingArchiveEntityKey] = useState<string | null>(null);
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [activeLane, setActiveLane] = useState<MetaLaneView>(initialLane);
  const [levelFilter, setLevelFilter] = useState<MetaLevelFilter>("campaign");
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [automationFilter, setAutomationFilter] = useState<MetaAutomationFilter>("all");
  const [labelFilter, setLabelFilter] = useState<MetaLabelFilter>("all");
  const [labelModalOpen, setLabelModalOpen] = useState(false);
  const [openSecondaryMenu, setOpenSecondaryMenu] = useState<MetaSecondaryMenu | null>(null);
  const latestSearchParamsRef = useRef(searchParams.toString());
  const secondaryControlsRef = useRef<HTMLDivElement | null>(null);

  useEffect(() => {
    latestSearchParamsRef.current = searchParams.toString();
  }, [searchParams]);

  useEffect(() => {
    if (!labelModalOpen) return;
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setLabelModalOpen(false);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [labelModalOpen]);

  useEffect(() => {
    if (!openSecondaryMenu) return;
    const closeWhenOutside = (event: MouseEvent | PointerEvent | TouchEvent) => {
      const target = event.target;
      if (!(target instanceof Node)) return;
      if (target instanceof Element && target.closest(".filter-menu-wrap")) return;
      setOpenSecondaryMenu(null);
    };
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.key === "Escape") setOpenSecondaryMenu(null);
    };
    document.addEventListener("pointerdown", closeWhenOutside);
    document.addEventListener("mousedown", closeWhenOutside);
    document.addEventListener("touchstart", closeWhenOutside);
    document.addEventListener("keydown", onKeyDown);
    return () => {
      document.removeEventListener("pointerdown", closeWhenOutside);
      document.removeEventListener("mousedown", closeWhenOutside);
      document.removeEventListener("touchstart", closeWhenOutside);
      document.removeEventListener("keydown", onKeyDown);
    };
  }, [openSecondaryMenu]);

  const pulseQuery = useQuery({
    queryKey: ["meta-account-pulse", businessId, selectedWindow, selectedStatusFilter, selectedDateRange.start, selectedDateRange.end],
    enabled: Boolean(businessId),
    queryFn: () => fetchPulse(businessId, selectedWindow, selectedStatusFilter, selectedDateRange),
  });
  const moneyCurrency = pulseQuery.data?.currency ?? currency ?? null;

  const laneQuery = useQuery({
    queryKey: ["meta-lanes", businessId, selectedWindow, selectedStatusFilter, selectedDateRange.start, selectedDateRange.end],
    enabled: Boolean(businessId),
    queryFn: () => fetchLanes(businessId, selectedWindow, selectedStatusFilter, selectedDateRange),
  });
  const anomalyQuery = useQuery({
    queryKey: [
      "meta-anomalies",
      businessId,
      selectedWindow,
      selectedStatusFilter,
      selectedDateRange?.start ?? null,
      selectedDateRange?.end ?? null,
    ],
    enabled: Boolean(businessId),
    queryFn: () => fetchAnomalies(businessId, selectedWindow, selectedStatusFilter, selectedDateRange),
  });
  const campaignDefer = useDeferState({
    businessId,
    scopeType: "campaign",
    snapshotDate: laneQuery.data?.snapshotDate,
  });
  const adsetDefer = useDeferState({
    businessId,
    scopeType: "adset",
    snapshotDate: laneQuery.data?.snapshotDate,
  });

  const actionNow = laneQuery.data?.actionNow ?? [];
  const watching = laneQuery.data?.watching ?? [];
  const healthy = laneQuery.data?.healthy ?? [];
  const nonSales = laneQuery.data?.nonSales ?? [];
  const archive = laneQuery.data?.archive ?? [];
  const anomalies = anomalyQuery.data?.anomalies ?? [];

  useEffect(() => {
    const payload = laneQuery.data;
    if (!payload) return;
    const serverRecs = new Map(
      [...payload.actionNow, ...payload.watching, ...payload.nonSales].map((rec) => [rec.id, rec]),
    );
    setLocalResponseStates((current) => {
      let changed = false;
      const next = { ...current };
      for (const [recId, localState] of Object.entries(current)) {
        const serverRec = serverRecs.get(recId);
        if (!serverRec) continue;
        if (serverRec.operatorResponseState === localState || (localState === "acted" && !serverRec.operatorResponseState)) {
          delete next[recId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [laneQuery.data]);

  const campaignOptions = useMemo(() => {
    const rows = [
      ...actionNow.map((rec) => ({ id: rec.campaignId ?? "", name: rec.campaignName ?? rec.title })),
      ...watching.map((rec) => ({ id: rec.campaignId ?? "", name: rec.campaignName ?? rec.title })),
      ...healthy.map((row) => ({ id: row.level === "campaign" ? row.id : row.campaignId ?? "", name: row.level === "campaign" ? row.name : row.campaignName ?? row.name })),
      ...nonSales.map((rec) => ({ id: rec.campaignId ?? "", name: rec.campaignName ?? rec.title })),
    ]
      .filter((item) => item.id);
    return Array.from(new Map(rows.map((item) => [item.id, item])).values()).slice(0, 12);
  }, [actionNow, healthy, nonSales, watching]);
  const selectedCampaignLabel = useMemo(() => {
    if (campaignFilter === "all") return "All campaigns";
    return campaignOptions.find((campaign) => campaign.id === campaignFilter)?.name ?? "Selected campaign";
  }, [campaignFilter, campaignOptions]);
  const toggleSecondaryMenu = (menu: MetaSecondaryMenu) => {
    setOpenSecondaryMenu((current) => (current === menu ? null : menu));
  };
  const resetMetaFilters = () => {
    setLevelFilter("campaign");
    setCampaignFilter("all");
    setAutomationFilter("all");
    setLabelFilter("all");
    setOpenSecondaryMenu(null);
  };
  const metaFilterInput = useMemo(
    () => ({ level: levelFilter, campaignId: campaignFilter, automation: automationFilter, label: labelFilter }),
    [automationFilter, campaignFilter, labelFilter, levelFilter],
  );
  const metaFiltersActive =
    levelFilter !== "campaign" ||
    campaignFilter !== "all" ||
    automationFilter !== "all" ||
    labelFilter !== "all";
  const filteredActionNow = useMemo(() => actionNow.filter((rec) => recMatchesMetaFilters(rec, metaFilterInput)), [actionNow, metaFilterInput]);
  const filteredWatching = useMemo(() => watching.filter((rec) => recMatchesMetaFilters(rec, metaFilterInput)), [metaFilterInput, watching]);
  const filteredHealthy = useMemo(
    () => healthy.filter((row) => healthyMatchesMetaFilters(row, {
      level: levelFilter,
      campaignId: campaignFilter,
      label: labelFilter,
    })),
    [campaignFilter, healthy, labelFilter, levelFilter],
  );
  const filteredNonSales = useMemo(() => nonSales.filter((rec) => recMatchesMetaFilters(rec, metaFilterInput)), [metaFilterInput, nonSales]);
  const filteredArchive = useMemo(
    () => archive.filter((row) => archivedMatchesMetaFilters(row, {
      level: levelFilter,
      campaignId: campaignFilter,
      label: labelFilter,
    })),
    [archive, campaignFilter, labelFilter, levelFilter],
  );
  const healthyGroups = useMemo(() => groupHealthyEntities(filteredHealthy), [filteredHealthy]);
  const rollups = useMemo(() => groupAdsetRollups(filteredActionNow), [filteredActionNow]);
  const rollupRecIds = useMemo(
    () => new Set(rollups.flatMap((rollup) => rollup.items.map((rec) => rec.id))),
    [rollups],
  );
  const individualActionNow = useMemo(
    () => filteredActionNow.filter((rec) => !rollupRecIds.has(rec.id)),
    [filteredActionNow, rollupRecIds],
  );
  const allRecs = useMemo(() => [...filteredActionNow, ...filteredWatching], [filteredActionNow, filteredWatching]);
  const adsetRecsByCampaign = useMemo(() => {
    const next = new Map<string, MetaRecommendation[]>();
    for (const rec of allRecs) {
      if (rec.level !== "adset" || !rec.campaignId) continue;
      next.set(rec.campaignId, [...(next.get(rec.campaignId) ?? []), rec]);
    }
    return next;
  }, [allRecs]);
  const selectedRecs = useMemo(
    () => allRecs.filter((rec) => selectedIds.has(rec.id)),
    [allRecs, selectedIds],
  );

  const trackingBlocked = isTrackingWriteBlocked(pulseQuery.data);
  const trackingBannerVisible = trackingBlocked && !trackingDismissed;

  const currentUrlParams = () =>
    new URLSearchParams(
      latestSearchParamsRef.current ||
        (typeof window === "undefined" ? searchParams.toString() : window.location.search),
    );

  const replaceMetaParams = (params: URLSearchParams) => {
    const query = params.toString();
    latestSearchParamsRef.current = query;
    router.replace(`/platforms/meta${query ? `?${query}` : ""}`);
  };

  const setWindow = (next: MetaWindowKey) => {
    const params = currentUrlParams();
    if (next === "28d") {
      params.delete("window");
    } else {
      params.set("window", next);
    }
    params.delete("startDate");
    params.delete("endDate");
    replaceMetaParams(params);
  };

  const setDateRange = (next: HtmlDateRangeValue) => {
    const params = currentUrlParams();
    const nextWindow: MetaWindowKey =
      next.window === "7d" || next.window === "14d" || next.window === "28d" || next.window === "90d"
        ? next.window
        : "custom";
    if (nextWindow === "28d") {
      params.delete("window");
    } else {
      params.set("window", nextWindow);
    }
    if (nextWindow === "custom") {
      params.set("startDate", next.start);
      params.set("endDate", next.end);
    } else {
      params.delete("startDate");
      params.delete("endDate");
    }
    const query = params.toString();
    const nextHref = `/platforms/meta${query ? `?${query}` : ""}`;
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", nextHref);
    }
    latestSearchParamsRef.current = query;
    router.replace(nextHref);
  };

  const setStatusFilter = (next: BriefingStatusFilter) => {
    const params = currentUrlParams();
    if (next === "active") {
      params.delete("status_filter");
    } else {
      params.set("status_filter", next);
    }
    replaceMetaParams(params);
  };

  const selectRec = (id: string, selected: boolean) => {
    setSelectedIds((current) => {
      const next = new Set(current);
      if (selected) next.add(id);
      else next.delete(id);
      return next;
    });
  };

  const refreshDecisionData = async () => {
    await Promise.all([
      queryClient.invalidateQueries({ queryKey: ["meta-lanes", businessId] }),
      queryClient.invalidateQueries({ queryKey: ["meta-anomalies", businessId] }),
      queryClient.invalidateQueries({ queryKey: ["meta-account-pulse", businessId] }),
    ]);
  };

  const refreshDecisionDataInBackground = (recId?: string) => {
    void refreshDecisionData().catch((error) => {
      const message = error instanceof Error ? error.message : "unknown error";
      if (recId) {
        setPrimaryActionFeedback({
          recId,
          tone: "success",
          title: "Meta action succeeded.",
          detail: `Decision data refresh failed: ${message}`,
        });
      }
    });
  };

  const refreshSnapshotNow = async () => {
    if (!businessId || refreshingSnapshot) return;
    setRefreshingSnapshot(true);
    setNotice(null);
    try {
      const response = await fetch("/api/meta/snapshot/run-now", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ businessId }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || payload?.ok === false) {
        const message =
          payload && typeof payload === "object" && "message" in payload
            ? String((payload as { message?: unknown }).message)
            : "Snapshot refresh failed.";
        throw new Error(message);
      }
      const status = payload && typeof payload === "object" && "status" in payload
        ? String((payload as { status?: unknown }).status)
        : "ran";
      setNotice(status === "cooldown" ? "Decision snapshot refresh is in cooldown." : "Decision snapshot refreshed.");
      await refreshDecisionData();
    } catch (error) {
      setNotice(error instanceof Error ? error.message : "Decision snapshot refresh failed.");
    } finally {
      setRefreshingSnapshot(false);
    }
  };

  const markActed = async (rec: MetaRecommendation, subtype: string) => {
    setLocalResponseStates((current) => ({ ...current, [rec.id]: "acted" }));
    await postResponse({ businessId, recId: rec.id, action: "acted", actionSubtype: subtype }).catch(() => null);
  };

  const deferRec = async (rec: MetaRecommendation) => {
    const scopeId = scopeIdForRec(rec);
    const state = rec.level === "adset" ? adsetDefer : campaignDefer;
    setLocalDeferredIds((current) => new Set(current).add(rec.id));
    setLocalResponseStates((current) => ({ ...current, [rec.id]: "deferred" }));
    await state.defer(scopeId);
    await postResponse({
      businessId,
      recId: rec.id,
      action: "deferred",
      actionSubtype: "let_cook_24h",
      reappearAt: todayPlusHours(24),
    }).catch(() => null);
  };

  const undeferRec = async (rec: MetaRecommendation) => {
    const scopeId = scopeIdForRec(rec);
    const state = rec.level === "adset" ? adsetDefer : campaignDefer;
    setLocalDeferredIds((current) => {
      const next = new Set(current);
      next.delete(rec.id);
      return next;
    });
    setLocalResponseStates((current) => {
      const next = { ...current };
      delete next[rec.id];
      return next;
    });
    await state.undefer(scopeId);
    await postResponse({
      businessId,
      recId: rec.id,
      action: "undeferred",
      actionSubtype: "undo_defer",
    }).catch(() => null);
  };

  const isDeferred = (rec: MetaRecommendation) => {
    const state = rec.level === "adset" ? adsetDefer : campaignDefer;
    return rec.operatorResponseState === "deferred" || localDeferredIds.has(rec.id) || state.isDeferred(scopeIdForRec(rec));
  };

  const responseStateForRec = (rec: MetaRecommendation): LocalResponseState | null => {
    return localResponseStates[rec.id] ?? rec.operatorResponseState ?? (isDeferred(rec) ? "deferred" : null);
  };

  const openOverlayForRec = (rec: MetaRecommendation, mode: MetaLaunchMode) => {
    if (mode === "apply_bid" && proposedBidMinorForExecute(rec) == null) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "error",
        title: "Bid cap is not executable.",
        detail: "This recommendation has no typed bidAmountMinor value. Open evidence instead.",
      });
      return;
    }
    setOverlay({ open: true, mode, rec });
  };

  const openDrillForRec = (rec: MetaRecommendation) => {
    setDrillItem({
      mode: "decision",
      rec,
      relatedRecs: rec.campaignId ? (adsetRecsByCampaign.get(rec.campaignId) ?? []) : [],
    });
  };

  const isTrackingSensitiveRec = (rec: MetaRecommendation) => {
    return (
      rec.actionKind === "execute_pause" ||
      rec.actionKind === "execute_bid" ||
      rec.actionKind === "route_launchpad_rebuild"
    );
  };

  const performPrimary = async (rec: MetaRecommendation) => {
    setPrimaryActionFeedback(null);
    // Routing follows the server-owned actionKind; the UI never infers what
    // a primary control does from the rec type or its display text.
    if (rec.actionKind === "execute_pause" && rec.adsetId) {
      setPendingActionRecId(rec.id);
      try {
        const response = await fetch(`/api/meta/adsets/${encodeURIComponent(rec.adsetId)}/pause`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ businessId, recId: rec.id }),
        });
        const payload = await assertActionResponse(response, "Ad set pause failed.");
        const isDryRun = payload?.dryRun === true;
        setPendingActionRecId(null);
        if (!isDryRun) {
          void markActed(rec, "paused");
        }
        setPrimaryActionFeedback({
          recId: rec.id,
          tone: isDryRun ? "info" : "success",
          title: metaAdsetPauseNotice(payload?.status, isDryRun),
          detail: isDryRun
            ? "No Meta write was performed; Meta verification completed."
            : "Meta verified the ad set status.",
        });
        if (!isDryRun) {
          refreshDecisionDataInBackground(rec.id);
        }
      } catch (error) {
        setPrimaryActionFeedback({
          recId: rec.id,
          tone: "error",
          title: "Meta action failed.",
          detail: error instanceof Error ? error.message : "Ad set pause failed.",
        });
      } finally {
        setPendingActionRecId(null);
      }
      return;
    }
    if (rec.actionKind === "execute_resume") {
      await resumeRecommendation(rec);
      return;
    }
    const mode = launchModeForRec(rec);
    if (mode) {
      openOverlayForRec(rec, mode);
      return;
    }
    openDrillForRec(rec);
  };

  const resumeEndpointForEntity = (level: "campaign" | "adset" | "ad", entityId: string) => {
    if (level === "campaign") return `/api/meta/campaigns/${encodeURIComponent(entityId)}/resume`;
    if (level === "adset") return `/api/meta/adsets/${encodeURIComponent(entityId)}/resume`;
    return `/api/meta/ads/${encodeURIComponent(entityId)}/resume`;
  };

  const resumeRecommendation = async (rec: MetaRecommendation) => {
    const entityId = rec.level === "campaign" ? rec.campaignId : rec.level === "adset" ? rec.adsetId : null;
    if (!entityId || (rec.level !== "campaign" && rec.level !== "adset")) return;
    setPrimaryActionFeedback(null);
    setPendingActionRecId(rec.id);
    try {
      const response = await fetch(resumeEndpointForEntity(rec.level, entityId), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ businessId }),
      });
      const payload = await assertActionResponse(response, `${rec.level === "campaign" ? "Campaign" : "Ad set"} resume failed.`);
      const isDryRun = payload?.dryRun === true;
      if (!isDryRun) {
        setLocalResponseStates((current) => {
          const next = { ...current };
          delete next[rec.id];
          return next;
        });
      }
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: isDryRun ? "info" : "success",
        title: metaEntityResumeNotice(rec.level, payload?.status, isDryRun),
        detail: isDryRun
          ? "No Meta write was performed; Meta verification completed."
          : `Meta verified the ${rec.level === "campaign" ? "campaign" : "ad set"} status.`,
      });
      if (!isDryRun) {
        refreshDecisionDataInBackground(rec.id);
      }
    } catch (error) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "error",
        title: "Meta action failed.",
        detail: error instanceof Error ? error.message : `${rec.level === "campaign" ? "Campaign" : "Ad set"} resume failed.`,
      });
    } finally {
      setPendingActionRecId(null);
    }
  };

  const resumeArchivedEntity = async (row: MetaArchivedEntity) => {
    if (row.status !== "PAUSED") return;
    const key = `${row.level}-${row.id}`;
    setArchiveActionFeedback(null);
    setPendingArchiveEntityKey(key);
    try {
      const response = await fetch(resumeEndpointForEntity(row.level, row.id), {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        cache: "no-store",
        body: JSON.stringify({ businessId }),
      });
      const payload = await assertActionResponse(response, `${row.level === "campaign" ? "Campaign" : "Ad set"} resume failed.`);
      const isDryRun = payload?.dryRun === true;
      setArchiveActionFeedback({
        key,
        tone: isDryRun ? "info" : "success",
        title: metaEntityResumeNotice(row.level, payload?.status, isDryRun),
        detail: isDryRun
          ? "No Meta write was performed; Meta verification completed."
          : "Meta verified the active status.",
      });
      if (!isDryRun) {
        clearLocalResponseStatesForEntity(row.level, row.id);
        refreshDecisionDataInBackground();
      }
    } catch (error) {
      setArchiveActionFeedback({
        key,
        tone: "error",
        title: "Meta action failed.",
        detail: error instanceof Error ? error.message : `${row.level === "campaign" ? "Campaign" : "Ad set"} resume failed.`,
      });
    } finally {
      setPendingArchiveEntityKey(null);
    }
  };

  const clearLocalResponseStatesForEntity = (level: "campaign" | "adset", entityId: string) => {
    const matchingRecIds = new Set(
      [...actionNow, ...watching, ...nonSales]
        .filter((rec) => {
          if (level === "campaign") return rec.level === "campaign" && rec.campaignId === entityId;
          return rec.level === "adset" && rec.adsetId === entityId;
        })
        .map((rec) => rec.id),
    );
    if (matchingRecIds.size === 0) return;
    setLocalResponseStates((current) => {
      let changed = false;
      const next = { ...current };
      for (const recId of matchingRecIds) {
        if (recId in next) {
          delete next[recId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  };

  const requestResumeRecommendation = (rec: MetaRecommendation) => {
    if (trackingBlocked && (rec.level === "campaign" || rec.level === "adset")) {
      setPendingResumeIntent({ kind: "recommendation", rec });
      return;
    }
    void resumeRecommendation(rec);
  };

  const requestResumeArchivedEntity = (row: MetaArchivedEntity) => {
    if (trackingBlocked) {
      setPendingResumeIntent({ kind: "archive", row });
      return;
    }
    void resumeArchivedEntity(row);
  };

  const confirmResumeIntent = () => {
    const intent = pendingResumeIntent;
    setPendingResumeIntent(null);
    if (!intent) return;
    if (intent.kind === "recommendation") {
      void resumeRecommendation(intent.rec);
      return;
    }
    void resumeArchivedEntity(intent.row);
  };

  const handlePrimary = async (rec: MetaRecommendation) => {
    if (trackingBlocked && isTrackingSensitiveRec(rec)) {
      setPendingPrimaryRec(rec);
      return;
    }
    await performPrimary(rec);
  };

  const confirmOverlay = async () => {
    const rec = overlay.rec;
    if (!rec) return;
    setPrimaryActionFeedback(null);
    if (overlay.mode === "apply_bid" && rec.adsetId) {
      const bidAmountMinor = proposedBidMinorForExecute(rec);
      if (!bidAmountMinor) {
        setPrimaryActionFeedback({
          recId: rec.id,
          tone: "error",
          title: "Bid cap is not executable.",
          detail: "This recommendation has no typed bidAmountMinor value. Open evidence instead.",
        });
        setOverlay(EMPTY_OVERLAY);
        return;
      }
      setPendingActionRecId(rec.id);
      try {
        const response = await fetch(`/api/meta/adsets/${encodeURIComponent(rec.adsetId)}/apply-bid`, {
          method: "POST",
          headers: { "Content-Type": "application/json", Accept: "application/json" },
          body: JSON.stringify({ businessId, bidAmountMinor, recId: rec.id }),
        });
        const payload = await assertActionResponse(response, "Bid cap apply failed.");
        const isDryRun = payload?.dryRun === true;
        setPendingActionRecId(null);
        if (!isDryRun) {
          void markActed(rec, "bid_applied");
        }
        const notice = metaBidApplyNotice(payload);
        setPrimaryActionFeedback({
          recId: rec.id,
          tone: notice.tone,
          title: notice.title,
          detail: notice.detail,
        });
        setOverlay(EMPTY_OVERLAY);
        if (!isDryRun) {
          refreshDecisionDataInBackground(rec.id);
        }
      } catch (error) {
        setPrimaryActionFeedback({
          recId: rec.id,
          tone: "error",
          title: "Meta action failed.",
          detail: error instanceof Error ? error.message : "Bid cap apply failed.",
        });
      } finally {
        setPendingActionRecId(null);
      }
      return;
    }
    const href = launchpadHrefForRec(rec, overlay.mode);
    await markActed(rec, overlay.mode === "rebuild" ? "rebuild_clicked" : "audience_swap_clicked");
    router.push(href);
  };

  const handleBulkAction = (action: string) => {
    if (action === "clear") {
      setSelectedIds(new Set());
      return;
    }
    if (action === "compare") {
      setCompareOpen(true);
      return;
    }
    const first = selectedRecs[0];
    if (!first) return;
    if (action === "rebuild") openOverlayForRec(first, "rebuild");
    if (action === "duplicate") openOverlayForRec(first, "duplicate");
    if (action === "apply_bid") openOverlayForRec(first, "apply_bid");
  };

  const selectedRecByRoas = (direction: "weakest" | "strongest") => {
    // Only entities with server-supplied ROAS participate in destructive
    // ranking; unknown metrics must never rank as zero (which made every
    // metrics-less entity "the weakest").
    const ranked = selectedRecs
      .map((rec) => ({ rec, roas: compareItemForRec(rec).roas }))
      .filter((item): item is { rec: MetaRecommendation; roas: number } =>
        typeof item.roas === "number" && Number.isFinite(item.roas),
      )
      .sort((left, right) => left.roas - right.roas);
    const item = direction === "strongest" ? ranked.at(-1) : ranked[0];
    return item?.rec ?? null;
  };

  const openLaunchpadForSelectedRecs = () => {
    if (selectedRecs.length === 0) return;
    const params = new URLSearchParams({
      mode: "duplicate",
      fromMetaBriefing: "true",
    });
    const campaignIds = selectedRecs.map((rec) => rec.campaignId).filter((id): id is string => Boolean(id));
    const adsetIds = selectedRecs.map((rec) => rec.adsetId).filter((id): id is string => Boolean(id));
    if (campaignIds.length > 0) params.set("campaignIds", Array.from(new Set(campaignIds)).join(","));
    if (adsetIds.length > 0) params.set("adsetIds", Array.from(new Set(adsetIds)).join(","));
    router.push(`/platforms/meta/launchpad?${params.toString()}`);
  };

  const handleCompareDrawerAction = async (action: "pause_weakest" | "scale_strongest" | "launch_selected") => {
    if (action === "launch_selected") {
      openLaunchpadForSelectedRecs();
      return;
    }
    const rec = selectedRecByRoas(action === "scale_strongest" ? "strongest" : "weakest");
    if (!rec) return;
    await handlePrimary(rec);
  };

  const loading = pulseQuery.isLoading || laneQuery.isLoading;
  const error = pulseQuery.error ?? laneQuery.error ?? anomalyQuery.error;

  return (
    <div className="ad-final" data-testid="meta-platform-page">
      <div className="topbar">
        <div>
          <div className="crumbs">Platforms · <b>Meta</b> · Decision Center</div>
          <h1 className="page-title">Meta · Decision Center</h1>
        </div>
        <div className="right-tools">
          <div className="controls" style={{ border: "none", padding: 0 }}>
            <HtmlDateRangePicker value={selectedDateRange} onApply={setDateRange} />
            <MetaStatusControls selectedStatusFilter={selectedStatusFilter} onStatusFilterChange={setStatusFilter} />
          </div>
          <button type="button" className="btn" disabled={refreshingSnapshot} onClick={refreshSnapshotNow}>
            <RefreshCw className="inline-block shrink-0" size={13} aria-hidden="true" />
            {refreshingSnapshot ? "Running..." : "Run snapshot"}
          </button>
          <a className="btn btn--primary" href="/platforms/meta/launchpad?fromMetaBriefing=true&mode=duplicate">+ New campaign</a>
        </div>
      </div>

      <FinalMetaPulse
        pulse={pulseQuery.data ?? null}
        window={selectedWindow}
        onManageLabels={() => setLabelModalOpen(true)}
        moneyCurrency={moneyCurrency}
        laneAsOf={
          laneQuery.data
            ? {
                snapshotDate: laneQuery.data.snapshotDate,
                snapshotCreatedAt: laneQuery.data.snapshotCreatedAt ?? null,
              }
            : null
        }
      />

      {pulseQuery.data?.dataReadiness &&
      (pulseQuery.data.dataReadiness.status !== "ok" ||
        pulseQuery.data.dataReadiness.isPartial) ? (
        <div className="banner warn" data-testid="meta-data-readiness">
          <div className="icon">i</div>
          <div className="msg">
            <b>Data is not fully ready.</b>
            <span className="sub">
              {pulseQuery.data.dataReadiness.notReadyReason ??
                "The selected range is partially verified; numbers may be incomplete."}
            </span>
          </div>
        </div>
      ) : null}

      <ReadinessNotice
        pulse={pulseQuery.data ?? null}
        onManageLabels={() => setLabelModalOpen(true)}
        onRefresh={refreshSnapshotNow}
        refreshing={refreshingSnapshot}
      />

      {notice ? (
        <div className="banner warn">
          <div className="icon">i</div>
          <div className="msg"><b>{notice}</b><span className="sub">{businessName ?? "Selected account"}</span></div>
        </div>
      ) : null}

      {trackingBannerVisible ? (
        <div className="banner danger">
          <div className="icon">!</div>
          <div className="msg">
            <b>Tracking anomaly active.</b>
            <span className="sub">{pulseQuery.data?.trackingHealth.detail ?? "Hard actions stay gated until tracking is checked."}</span>
          </div>
          <button type="button" className="btn btn--sm" onClick={() => setDrillItem(anomalies[0] ? { mode: "anomaly", anomaly: anomalies[0] } : null)}>View details</button>
          <button type="button" className="btn btn--ghost btn--sm" onClick={() => setTrackingDismissed(true)}>Hide banner</button>
        </div>
      ) : null}

      <div className="lane-tabs">
        <MetaLaneTab active={activeLane === "action"} className="action" label="Action Now" count={filteredActionNow.length + anomalies.length} onClick={() => setActiveLane("action")} />
        <MetaLaneTab active={activeLane === "watching"} className="watch" label="Watching" count={filteredWatching.length} onClick={() => setActiveLane("watching")} />
        <MetaLaneTab active={activeLane === "healthy"} className="healthy" label="Healthy" count={filteredHealthy.length} onClick={() => setActiveLane("healthy")} />
        <MetaLaneTab active={activeLane === "nonSales"} label="Non-sales" count={filteredNonSales.length} onClick={() => setActiveLane("nonSales")} />
        <MetaLaneTab active={activeLane === "archive"} label="Archive" count={filteredArchive.length} onClick={() => setActiveLane("archive")} />
        <div style={{ flex: 1 }} />
        <div className="tab" style={{ color: "var(--muted)" }}>
          <span className="chip chip--ghost"><span className="dot" />Deferred {localDeferredIds.size + campaignDefer.deferredCount + adsetDefer.deferredCount}</span>
        </div>
      </div>

      <div className="controls meta-filterbar" data-meta-secondary-controls ref={secondaryControlsRef}>
        <div className="group level-switch" aria-label="Meta entity level">
          <button type="button" className={levelFilter === "campaign" ? "on" : ""} onClick={() => setLevelFilter("campaign")}>Campaigns</button>
          <button type="button" className={levelFilter === "adset" ? "on" : ""} onClick={() => setLevelFilter("adset")}>Ad sets</button>
        </div>
        <MetaCompactFilter
          id="campaign"
          label="Campaign"
          value={selectedCampaignLabel}
          active={campaignFilter !== "all"}
          open={openSecondaryMenu === "campaign"}
          onToggle={toggleSecondaryMenu}
        >
          <div className="filter-popover-head">
            <b>Campaign</b>
            <span>{campaignOptions.length > 0 ? `${campaignOptions.length} available` : "No active campaign options"}</span>
          </div>
          <div className="filter-option-list campaign-list">
            <button
              type="button"
              role="menuitemradio"
              aria-checked={campaignFilter === "all"}
              className={cn("filter-option", campaignFilter === "all" && "is-selected")}
              onClick={() => {
                setCampaignFilter("all");
                setOpenSecondaryMenu(null);
              }}
            >
              <span>
                <b>All campaigns</b>
                <small>Keep every campaign in the selected server lanes.</small>
              </span>
            </button>
            {campaignOptions.map((campaign) => (
              <button
                key={campaign.id}
                type="button"
                role="menuitemradio"
                aria-checked={campaignFilter === campaign.id}
                className={cn("filter-option", campaignFilter === campaign.id && "is-selected")}
                onClick={() => {
                  setCampaignFilter(campaign.id);
                  setOpenSecondaryMenu(null);
                }}
              >
                <span>
                  <b>{campaign.name}</b>
                  <small>{campaign.id}</small>
                </span>
              </button>
            ))}
          </div>
        </MetaCompactFilter>
        <MetaCompactFilter
          id="automation"
          label="Readiness"
          value={automationFilterLabel(automationFilter)}
          active={automationFilter !== "all"}
          open={openSecondaryMenu === "automation"}
          onToggle={toggleSecondaryMenu}
        >
          <div className="filter-popover-head">
            <b>Readiness</b>
            <span>Client-side narrowing only</span>
          </div>
          <div className="filter-option-list">
            {META_AUTOMATION_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={automationFilter === option.value}
                className={cn("filter-option", automationFilter === option.value && "is-selected")}
                onClick={() => {
                  setAutomationFilter(option.value);
                  setOpenSecondaryMenu(null);
                }}
              >
                <span>
                  <b>{option.label}</b>
                  <small>{option.description}</small>
                </span>
              </button>
            ))}
          </div>
        </MetaCompactFilter>
        <MetaCompactFilter
          id="label"
          label="Labels"
          value={labelFilterLabel(labelFilter)}
          active={labelFilter !== "all"}
          open={openSecondaryMenu === "label"}
          onToggle={toggleSecondaryMenu}
        >
          <div className="filter-popover-head">
            <b>Labels</b>
            <span>Main, Test, Mixed context</span>
          </div>
          <div className="filter-option-list">
            {META_LABEL_FILTERS.map((option) => (
              <button
                key={option.value}
                type="button"
                role="menuitemradio"
                aria-checked={labelFilter === option.value}
                className={cn("filter-option", labelFilter === option.value && "is-selected")}
                onClick={() => {
                  setLabelFilter(option.value);
                  setOpenSecondaryMenu(null);
                }}
              >
                <span>
                  <b>{option.label}</b>
                  <small>{option.description}</small>
                </span>
              </button>
            ))}
          </div>
          <div className="filter-popover-foot">
            <button
              type="button"
              className="filter-footer-action"
              aria-label="Manage campaign labels"
              onClick={() => {
                setOpenSecondaryMenu(null);
                setLabelModalOpen(true);
              }}
            >
              <Tags className="inline-block shrink-0" size={13} aria-hidden="true" />
              Manage labels
            </button>
          </div>
        </MetaCompactFilter>
        {metaFiltersActive ? (
          <button type="button" className="filter-reset" onClick={resetMetaFilters}>
            <RotateCcw className="inline-block shrink-0" size={13} aria-hidden="true" />
            Reset
          </button>
        ) : null}
        <div className="spacer" />
        <span
          className="filter-info-chip"
          title="These controls narrow server-provided lanes. They do not recompute recommendation lanes in the UI."
        >
          <span>{windowLabel(selectedDateRange.window)}</span>
          <Info className="inline-block shrink-0" size={13} aria-hidden="true" />
        </span>
      </div>

      <div className="workspace workspace-rel">
        {loading ? (
          <div className="lane-stack">
            {Array.from({ length: 3 }).map((_, index) => (
              <div key={index} className="dcard animate-pulse">
                <div className="check" />
                <div className="min-h-[150px]" />
                <div className="actions-col" />
              </div>
            ))}
          </div>
        ) : error ? (
          <div className="lane-stack">
            <div className="lane-empty">{error instanceof Error ? error.message : "Meta briefing failed."}</div>
          </div>
        ) : (
          <div className="lane-stack">
            {activeLane === "action" ? (
              <>
                {anomalies.length > 0 && anomalyQuery.data?.snapshotDate ? (
                  <div className="micro" data-testid="meta-anomaly-asof" style={{ padding: "2px 4px" }}>
                    anomaly scan as of {anomalyQuery.data.snapshotDate}
                  </div>
                ) : null}
                {anomalies.map((anomaly) => (
                  <MetaActionCard key={anomaly.id} anomaly={anomaly} onOpenDrill={(item) => setDrillItem({ mode: "anomaly", anomaly: item as MetaAnomaly })} />
                ))}
                {rollups.map((rollup) => (
                  <article key={rollup.campaignId} className="dcard" data-card="cross-adset-rollup">
                    <div className="check" />
                    <div>
                      <div className="meta-line">
                        <span className="chip chip--watch"><span className="dot" />Review adsets</span>
                        <span className="chip chip--ghost"><span className="dot" />Mixed</span>
                        <b>{rollup.campaignName}</b>
                      </div>
                      <div className="title">{rollup.campaignName} has mixed ad set decisions</div>
                      <div className="why">
                        {rollup.items.length} ad sets are pulling in different directions.
                        <span className="from">source · grouped adset decisions · review before campaign move</span>
                      </div>
                      <div className="metric-strip">
                        {rollup.items.slice(0, 5).map((rec) => (
                          <div key={rec.id} className="m">
                            <span className="k">{rec.adsetName ?? rec.title}</span>
                            <span className="v">{titleCaseCompact(decisionLabelForRec(rec))}</span>
                          </div>
                        ))}
                      </div>
                    </div>
                    <div className="actions-col">
                      <span className="why-action">Recommended</span>
                      <button type="button" className="btn btn--primary" onClick={() => rollup.items[0] ? openDrillForRec(rollup.items[0]) : undefined}>
                        Review ad sets
                      </button>
                    </div>
                  </article>
                ))}
                {individualActionNow.map((rec) => (
                  <MetaActionCard
                    key={rec.id}
                    moneyCurrency={moneyCurrency}
                    rec={rec}
                    selected={selectedIds.has(rec.id)}
                    deferred={isDeferred(rec)}
                    responseState={responseStateForRec(rec)}
                    primaryPending={pendingActionRecId === rec.id}
                    actionFeedback={primaryActionFeedback?.recId === rec.id ? primaryActionFeedback : null}
                    evidenceWindow={selectedWindow}
                    onSelect={selectRec}
                    onPrimary={handlePrimary}
                    onResume={requestResumeRecommendation}
                    onOpenDrill={(item) => openDrillForRec(item as MetaRecommendation)}
                    onDefer={deferRec}
                    onUndoDefer={undeferRec}
                  />
                ))}
                {filteredActionNow.length === 0 && anomalies.length === 0 ? (
                  <EmptyActionState
                    anomaliesCount={0}
                    pulse={pulseQuery.data}
                    onManageLabels={() => setLabelModalOpen(true)}
                  />
                ) : null}
              </>
            ) : activeLane === "watching" ? (
              <>
                <WatchingSegments
                  segments={laneQuery.data?.watchingSegments}
                  onManageLabels={() => setLabelModalOpen(true)}
                />
                {filteredWatching.map((rec) => (
                  <MetaActionCard
                    key={rec.id}
                    moneyCurrency={moneyCurrency}
                    rec={rec}
                    selected={selectedIds.has(rec.id)}
                    deferred={isDeferred(rec)}
                    responseState={responseStateForRec(rec)}
                    primaryPending={pendingActionRecId === rec.id}
                    actionFeedback={primaryActionFeedback?.recId === rec.id ? primaryActionFeedback : null}
                    evidenceWindow={selectedWindow}
                    onSelect={selectRec}
                    onPrimary={handlePrimary}
                    onResume={requestResumeRecommendation}
                    onOpenDrill={(item) => openDrillForRec(item as MetaRecommendation)}
                    onDefer={deferRec}
                    onUndoDefer={undeferRec}
                  />
                ))}
                {filteredWatching.length === 0 ? <div className="lane-empty">{metaFiltersActive ? "No watchlist items match the current filters." : "No watchlist items in the latest snapshot."}</div> : null}
              </>
            ) : activeLane === "healthy" ? (
              healthyGroups.length > 0 ? (
                <MetaHealthyHierarchy groups={healthyGroups} moneyCurrency={moneyCurrency} />
              ) : (
                <div className="lane-empty">Healthy entities will appear after the latest snapshot has enough stable mature rows.</div>
              )
            ) : activeLane === "nonSales" ? (
              <>
                {filteredNonSales.map((rec) => (
                  rec.cohort === "upper_funnel" ? (
                    <MetaUpperFunnelInformationalCard
                      key={rec.id}
                      rec={rec}
                      onOpenDrill={(item) => setDrillItem({ mode: "informational", rec: item })}
                    />
                  ) : (
                    <MetaActionCard
                      key={rec.id}
                      moneyCurrency={moneyCurrency}
                      rec={rec}
                      selected={selectedIds.has(rec.id)}
                      deferred={isDeferred(rec)}
                      responseState={responseStateForRec(rec)}
                      primaryPending={pendingActionRecId === rec.id}
                      actionFeedback={primaryActionFeedback?.recId === rec.id ? primaryActionFeedback : null}
                      evidenceWindow={selectedWindow}
                      onPrimary={handlePrimary}
                      onResume={requestResumeRecommendation}
                      onOpenDrill={(item) => openDrillForRec(item as MetaRecommendation)}
                      onDefer={deferRec}
                      onUndoDefer={undeferRec}
                    />
                  )
                ))}
                {filteredNonSales.length === 0 ? <div className="lane-empty">{metaFiltersActive ? "No non-purchase entities match the current filters." : "No non-purchase entities in the current window."}</div> : null}
              </>
            ) : filteredArchive.length > 0 ? (
              <div className="overflow-x-auto rounded-xl border border-slate-200 bg-white" data-meta-archive>
                <table className="asset-table">
                  <thead>
                    <tr>
                      <th>Entity</th>
                      <th>Status</th>
                      <th className="num">Spend</th>
                      <th className="num">ROAS</th>
                      <th className="num">CPA</th>
                      <th>Action</th>
                    </tr>
                  </thead>
                  <tbody>
                    {filteredArchive.slice(0, 30).map((row) => {
                      const key = `${row.level}-${row.id}`;
                      const canResume = row.status === "PAUSED";
                      const pending = pendingArchiveEntityKey === key;
                      const feedback = archiveActionFeedback?.key === key ? archiveActionFeedback : null;
                      return (
                        <tr key={key}>
                          <td>
                            <span className="row-name">
                              <span className="row-thumb">{row.level === "campaign" ? "C" : "A"}<span className="micro-fmt">{row.level === "campaign" ? "CMP" : "ADS"}</span></span>
                              <span className="name-text"><b>{row.name}</b><span>{row.diagnosticNote ?? row.lastKnownWindow}</span></span>
                            </span>
                          </td>
                          <td><span className="chip chip--ghost"><span className="dot" />{row.statusLabel}</span></td>
                          <td className="num">{formatMoney(row.spend, moneyCurrency)}</td>
                          <td className="num">{formatRoas(row.roas)}</td>
                          <td className="num">{row.cpa == null ? "—" : formatMoney(row.cpa, moneyCurrency)}</td>
                          <td>
                            {canResume ? (
                              <div className="archive-action-cell">
                                <button
                                  type="button"
                                  className="btn btn--sm"
                                  disabled={pending}
                                  onClick={() => requestResumeArchivedEntity(row)}
                                >
                                  <Play className="inline-block shrink-0" size={12} aria-hidden="true" />
                                  {pending ? "Working..." : row.level === "campaign" ? "Resume campaign" : "Resume adset"}
                                </button>
                                {feedback ? (
                                  <div className={cn("meta-action-feedback", `meta-action-feedback--${feedback.tone}`)} role="status" data-archive-action-feedback={feedback.tone}>
                                    <span className="dot" aria-hidden="true" />
                                    <span>
                                      <b>{feedback.title}</b>
                                      {feedback.detail ? <small>{feedback.detail}</small> : null}
                                    </span>
                                  </div>
                                ) : null}
                              </div>
                            ) : (
                              <span className="muted">—</span>
                            )}
                          </td>
                        </tr>
                      );
                    })}
                  </tbody>
                </table>
              </div>
            ) : (
              <div className="lane-empty">No closed entities in this briefing scope.</div>
            )}

            {selectedRecs.length > 0 ? (
              <div className="bulkbar">
                <span>{selectedRecs.length} selected · {selectedRecs.slice(0, 2).map(scopeNameForRec).join(", ")}</span>
                <div className="acts">
                  <button type="button" className="btn" onClick={() => handleBulkAction("compare")}>Compare</button>
                  <button type="button" className="btn" onClick={() => handleBulkAction("duplicate")}>Send to Launchpad</button>
                  <button type="button" className="btn btn--danger" onClick={() => handleBulkAction("rebuild")}>Rebuild</button>
                  <button type="button" className="btn btn--ghost" onClick={() => handleBulkAction("clear")}>×</button>
                </div>
              </div>
            ) : null}
          </div>
        )}

      </div>

      {labelModalOpen ? (
        <div
          className="modal-backdrop meta-label-modal-backdrop"
          data-meta-label-management-modal
          onMouseDown={() => setLabelModalOpen(false)}
        >
          <div
            className="meta-label-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="meta-label-modal-title"
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="meta-label-modal-head">
              <div>
                <h2 id="meta-label-modal-title">Manage campaign labels</h2>
                <p>Main, Test, or Mixed context is used by the Meta decision lanes.</p>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label="Close campaign label manager"
                onClick={() => setLabelModalOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="meta-label-modal-body">
              <MetaCampaignLabelsSection businessId={businessId} />
            </div>
          </div>
        </div>
      ) : null}

      <MetaDrillDrawer
        moneyCurrency={moneyCurrency}
        item={drillItem}
        window={selectedWindow}
        onWindowChange={setWindow}
        onClose={() => setDrillItem(null)}
        onLaunch={
          drillItem?.mode === "decision" && launchModeForRec(drillItem.rec)
            ? () => openOverlayForRec(drillItem.rec, launchModeForRec(drillItem.rec)!)
            : undefined
        }
      />

      <MetaLaunchpadOverlay
        open={overlay.open}
        mode={overlay.mode}
        item={{
          id: overlay.rec ? scopeIdForRec(overlay.rec) : "meta",
          name: overlay.rec ? scopeNameForRec(overlay.rec) : "Meta action",
          campaign: overlay.rec?.campaignName,
          proposedBidCap: overlay.rec ? (proposedBidDisplayValue(overlay.rec) ?? undefined) : undefined,
        }}
        onClose={() => setOverlay(EMPTY_OVERLAY)}
        onConfirm={confirmOverlay}
      />

      <CompareDrawer
        open={compareOpen}
        items={selectedRecs.map(compareItemForRec)}
        onClose={() => setCompareOpen(false)}
        entityLabel="Meta entities"
        trendLabel={`${selectedWindow === "custom" ? "Custom" : selectedWindow} ROAS trend`}
        actionBar={
          <>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-rose-600 text-white border border-rose-600 hover:bg-rose-700 text-[12.5px] font-medium"
              onClick={() => void handleCompareDrawerAction("pause_weakest")}
            >
              <AlertTriangle className="inline-block shrink-0" size={13} aria-hidden="true" /> Pause weakest
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 text-white border border-emerald-600 hover:bg-emerald-700 text-[12.5px] font-medium"
              onClick={() => void handleCompareDrawerAction("scale_strongest")}
            >
              <TrendingUp className="inline-block shrink-0" size={13} aria-hidden="true" /> Scale strongest
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 text-[12.5px] font-medium"
              onClick={() => void handleCompareDrawerAction("launch_selected")}
            >
              <Rocket className="inline-block shrink-0" size={13} aria-hidden="true" /> Send selected to Launchpad
            </button>
          </>
        }
      />

      <TrackingConfirmModal
        open={pendingPrimaryRec != null}
        primaryLabel={trackingConfirmLabelForRec(pendingPrimaryRec)}
        onClose={() => setPendingPrimaryRec(null)}
        onConfirm={() => {
          const rec = pendingPrimaryRec;
          setPendingPrimaryRec(null);
          if (rec) void performPrimary(rec);
        }}
      />
      <TrackingConfirmModal
        open={pendingResumeIntent != null}
        primaryLabel="Resume anyway"
        description="Resuming during a tracking anomaly may reopen spend with incomplete attribution. Continue anyway, or resolve tracking first?"
        onClose={() => setPendingResumeIntent(null)}
        onConfirm={confirmResumeIntent}
      />
    </div>
  );
}
