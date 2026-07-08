"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import Link from "next/link";
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
import type { DecisionLabel, DecisionOutput } from "@/lib/creative-decision-engine";
import { LABEL_DISPLAY } from "@/components/creatives/decision-label-display";
import { DECISION_LABEL_PALETTE } from "@/components/common/briefing/decision-label-palette";
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
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";
import {
  BRIEFING_STATUS_FILTER_LABELS,
  BRIEFING_STATUS_FILTERS,
  parseBriefingStatusFilter,
  type BriefingStatusFilter,
} from "@/lib/meta/briefing-filter";
import type {
  MetaArchivedEntity,
  MetaDecisionsWorkspacePayload,
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

// Client-only queue-local filter: hide rows whose server-supplied spend is
// below this window threshold. Rows with a null spend stay HIDDEN when the
// toggle is on - they are never coerced to 0 (honesty law).
const META_MIN_SPEND_THRESHOLD = 50;

function passesMetaMinSpend(rec: MetaRecommendation, enabled: boolean): boolean {
  if (!enabled) return true;
  const spend = rec.metrics?.spend;
  return typeof spend === "number" && Number.isFinite(spend) && spend >= META_MIN_SPEND_THRESHOLD;
}

// Fixed render order for the Watching lane segmentation. Any segment the
// server did not describe still renders (header + count only) so no row is
// silently dropped, but the ordering stays stable across snapshots.
type MetaWatchingSegmentKey = MetaWatchingSegment["key"];
const META_WATCHING_SEGMENT_ORDER: MetaWatchingSegmentKey[] = [
  "issues",
  "missing_target",
  "unlabeled",
  "learning",
  "mid_confidence",
  "insufficient_signal",
  "recently_changed",
  "deferred",
  "other",
];

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

function fetchDecisionsWorkspace(
  businessId: string,
  window: MetaWindowKey,
  statusFilter: BriefingStatusFilter,
  range?: Pick<HtmlDateRangeValue, "start" | "end">,
) {
  const params = new URLSearchParams({ businessId, window, status_filter: statusFilter });
  if (window === "custom" && range) {
    params.set("startDate", range.start);
    params.set("endDate", range.end);
  }
  return readJson<MetaDecisionsWorkspacePayload>(`/api/meta/decisions-workspace?${params.toString()}`);
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

export type MetaRowSort = "money" | "priority" | "age";

/** Free-text row search over entity/label truth. Empty query keeps every row. */
export function metaRecSearchMatch(rec: MetaRecommendation, query: string): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [scopeNameForRec(rec), rec.campaignName ?? "", rec.adsetName ?? "", rec.decisionLabel ?? "", rec.title ?? ""]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

const META_PRIORITY_RANK: Record<string, number> = { high: 0, medium: 1, low: 2 };

function stableSortMetaRecs(
  recs: MetaRecommendation[],
  key: (rec: MetaRecommendation) => number | null,
): MetaRecommendation[] {
  // Higher key first; rows whose key is missing are kept LAST (never coerced
  // to zero). Ties preserve the incoming server priority order (stable).
  return recs
    .map((rec, index) => ({ rec, index, k: key(rec) }))
    .sort((a, b) => {
      if (a.k == null && b.k == null) return a.index - b.index;
      if (a.k == null) return 1;
      if (b.k == null) return -1;
      if (a.k === b.k) return a.index - b.index;
      return b.k - a.k;
    })
    .map((item) => item.rec);
}

/**
 * Client sort over server-structured truth only. Money = spend at stake,
 * Priority = server priority, Age = evidence age in days. Missing-metric rows
 * always sort last so an absent number never masquerades as the top row.
 */
export function sortMetaRecs(recs: MetaRecommendation[], sort: MetaRowSort): MetaRecommendation[] {
  if (sort === "priority") {
    return stableSortMetaRecs(recs, (rec) => {
      const rank = META_PRIORITY_RANK[rec.priority];
      return rank == null ? null : -rank;
    });
  }
  if (sort === "age") {
    return stableSortMetaRecs(recs, (rec) => {
      const age = rec.evidenceTrail?.age_days;
      return typeof age === "number" && Number.isFinite(age) ? age : null;
    });
  }
  return stableSortMetaRecs(recs, (rec) => {
    const spend = rec.metrics?.spend;
    return typeof spend === "number" && Number.isFinite(spend) ? spend : null;
  });
}

function useMinWidth(px: number) {
  const [matches, setMatches] = useState(false);
  useEffect(() => {
    if (typeof window === "undefined" || !window.matchMedia) return;
    const mq = window.matchMedia(`(min-width: ${px}px)`);
    const update = () => setMatches(mq.matches);
    update();
    mq.addEventListener?.("change", update);
    return () => mq.removeEventListener?.("change", update);
  }, [px]);
  return matches;
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
          ? "border-[var(--adc-auto-bd)] bg-[var(--adc-auto-bg)] text-[var(--adc-auto-fg)]"
          : "border-[var(--adc-b1)] bg-[var(--adc-s1)] text-[var(--adc-ink2)]",
      )}
    >
      {tone === "violet" ? (
        <Target className="inline-block shrink-0" size={10} aria-hidden="true" />
      ) : (
        <SlidersHorizontal className="inline-block shrink-0" size={10} aria-hidden="true" />
      )}
      <span className="shrink-0 text-[var(--adc-ink3)]">{label}</span>
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
      className="flex items-center gap-3 rounded-[8px] border border-dashed border-[var(--adc-b1)] bg-[var(--adc-s2)] px-3 py-2"
      data-healthy-synthetic-campaign={group.campaignKey}
    >
      <div className="size-[15px] rounded-full border border-[var(--adc-b2)] bg-[var(--adc-s1)]" aria-hidden="true" />
      <MetaScopeChip level="campaign" />
      <div className="min-w-0 flex-1">
        <div className="truncate text-[12.5px] font-medium text-[var(--adc-ink)]">{group.campaignName}</div>
        <div className="truncate text-[11px] text-[var(--adc-ink3)]">Campaign context inferred from adset snapshot</div>
      </div>
      <div className="hidden min-w-0 shrink-0 items-center justify-end gap-1.5 xl:flex">
        <SyntheticConfigChip label="Optimization" value={optimizationSummary.value} tone="violet" />
        <SyntheticConfigChip label="Bid" value={bidStrategySummary.value} />
      </div>
      <div className="text-[11px] text-[var(--adc-ink3)]">{group.adsets.length} {group.adsets.length === 1 ? "adset" : "adsets"}</div>
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
            className="rounded-[8px] border border-[var(--adc-b1)] bg-[var(--adc-s1)]/60 p-2"
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
                className="ml-5 mt-2 grid gap-2 border-l border-[var(--adc-b1)] pl-4"
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
    <div className="rounded-[8px] border border-dashed border-[var(--adc-b2)] bg-[var(--adc-s2)] p-8 text-center" data-empty-action-state>
      <div className="mx-auto grid size-10 place-items-center rounded-[8px] bg-[var(--adc-s1)] text-[var(--adc-ink3)]">
        <AlertTriangle className="inline-block shrink-0" size={18} aria-hidden="true" />
      </div>
      <h3 className="mt-3 text-[15px] font-semibold text-[var(--adc-ink)]">No high-confidence calls today</h3>
      <p className="mt-1 text-[12.5px] text-[var(--adc-ink3)]">
        {anomaliesCount > 0
          ? "Active anomalies are surfaced above while decision confidence stays below the act threshold."
          : "The engine is watching for stronger campaign or adset evidence before surfacing action."}
      </p>
      {showLabelCta || showTargetCta ? (
        <div className="mt-4 flex flex-wrap justify-center gap-2 text-left">
          {showLabelCta ? (
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--adc-caution-fg)] hover:bg-[var(--adc-s3)]"
              onClick={onManageLabels}
            >
              <Target className="inline-block shrink-0" size={12} aria-hidden="true" />
              Label {coverage!.unlabeledCampaigns} campaigns
            </button>
          ) : null}
          {showTargetCta ? (
            <a
              href="/commercial-truth"
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--adc-info-bd)] bg-[var(--adc-info-bg)] px-3 py-1.5 text-[12px] font-medium text-[var(--adc-info-fg)] hover:bg-[var(--adc-s3)]"
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
  readOnlyReason,
}: {
  pulse?: MetaPulsePayload | null;
  onRefresh: () => void;
  refreshing: boolean;
  onManageLabels: () => void;
  readOnlyReason?: string | null;
}) {
  if (!pulse) return null;
  const coverage = pulse.labelCoverage ?? null;
  const targetAnchor = pulse.targetAnchor ?? null;
  const snapshot = pulse.snapshotHealth ?? null;
  const needsLabels = Boolean(coverage && coverage.activeCampaigns > 0 && coverage.unlabeledCampaigns > 0);
  const needsTarget = Boolean(targetAnchor && !targetAnchor.configured);
  const staleSnapshot = Boolean(snapshot && snapshot.status !== "fresh");
  if (!needsLabels && !needsTarget && !staleSnapshot) return null;

  const items: Array<{
    id: string;
    title: string;
    detail: string;
    action: ReactNode;
  }> = [];

  if (needsLabels) {
    items.push({
      id: "labels",
      title: "Campaign labels incomplete",
      detail: `${coverage!.labeledCampaigns}/${coverage!.activeCampaigns} active campaigns labeled`,
      action: (
        <button type="button" className="meta-readiness-row__button" onClick={onManageLabels}>
          Label campaigns
        </button>
      ),
    });
  }

  if (needsTarget) {
    items.push({
      id: "target",
      title: "Target pack missing",
      detail: "ROAS target source is not configured for this business",
      action: (
        <a href="/commercial-truth" className="meta-readiness-row__button">
          Set target pack
        </a>
      ),
    });
  }

  if (staleSnapshot) {
    const ageLabel = snapshot?.ageHours != null ? formatSnapshotAge(snapshot.ageHours) : null;
    items.push({
      id: "snapshot",
      title: "Snapshot stale",
      detail: snapshot?.staleReason ?? (ageLabel ? `snapshot age ${ageLabel}` : "snapshot status is not fresh"),
      action: (
        <button
          type="button"
          className="meta-readiness-row__button"
          disabled={refreshing || Boolean(readOnlyReason)}
          title={readOnlyReason ?? undefined}
          onClick={onRefresh}
        >
          {refreshing ? "Refreshing..." : readOnlyReason ? "Snapshot read-only" : "Refresh decisions"}
        </button>
      ),
    });
  }

  return (
    <div className="meta-readiness-stack" data-meta-readiness-notice role="status" aria-label="Decision readiness status">
      <div className="meta-readiness-stack__head">
        <span className="meta-readiness-stack__mark" aria-hidden="true" />
        <span>Decision readiness</span>
        <small>required inputs before confident writes</small>
      </div>
      {items.map((item) => (
        <div key={item.id} className="meta-readiness-row" data-readiness-item={item.id}>
          <span className="meta-readiness-row__dot" aria-hidden="true" />
          <span className="meta-readiness-row__title">{item.title}</span>
          <span className="meta-readiness-row__detail">{item.detail}</span>
          <span className="meta-readiness-row__spacer" aria-hidden="true" />
          {item.action}
        </div>
      ))}
    </div>
  );
}

function archiveStatusClassName(status: string) {
  const normalized = status.toUpperCase();
  if (normalized === "PAUSED") return "border-[var(--adc-caution-bd)] bg-[var(--adc-caution-bg)] text-[var(--adc-caution-fg)]";
  if (normalized === "ARCHIVED") return "border-[var(--adc-b1)] bg-[var(--adc-s1)] text-[var(--adc-ink2)]";
  if (normalized === "DELETED") return "border-[var(--adc-danger-bd)] bg-[var(--adc-danger-bg)] text-[var(--adc-danger-fg)]";
  return "border-[var(--adc-b1)] bg-[var(--adc-s2)] text-[var(--adc-ink3)]";
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

function labelCoveragePercent(pulse?: MetaPulsePayload | null) {
  const coverage = pulse?.labelCoverage;
  if (!coverage || coverage.activeCampaigns <= 0) return null;
  return Math.round((coverage.labeledCampaigns / coverage.activeCampaigns) * 100);
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

function mobileTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function mobileDecisionTone(rec: MetaRecommendation): "danger" | "positive" | "caution" {
  const label = decisionLabelForRec(rec);
  if (label === "cut" || label === "below_breakeven" || label === "fatigue") return "danger";
  if (label === "scale" || label === "keep") return "positive";
  return "caution";
}

function mobileDecisionLine(
  rec: MetaRecommendation,
  targetRoas: number | null | undefined,
  currency: string | null | undefined,
) {
  const metrics = structuredMetricsForRec(rec);
  const parts: string[] = [];
  if (typeof metrics?.spend === "number" && Number.isFinite(metrics.spend)) {
    parts.push(formatMoney(metrics.spend, currency));
  }
  if (typeof metrics?.roas === "number" && Number.isFinite(metrics.roas)) {
    const roas = `${metrics.roas.toFixed(2)}x`;
    parts.push(
      typeof targetRoas === "number" && Number.isFinite(targetRoas)
        ? `${roas} vs ${targetRoas.toFixed(2)}x target`
        : roas,
    );
  }
  return `${titleCaseCompact(decisionLabelForRec(rec))} · ${
    parts.length > 0 ? parts.join(" · ") : rec.expectedImpact || rec.summary || "server summary —"
  }`;
}

function MobileDecisionConfidence({ confidence }: { confidence: MetaRecommendation["confidence"] }) {
  const label = confidence === "high" ? "High" : confidence === "medium" ? "Medium" : "Low";
  const activeBars = label === "High" ? 3 : label === "Medium" ? 2 : 1;
  return (
    <span className="ad-confidence-pill">
      <span aria-hidden="true">
        {[0, 1, 2].map((index) => (
          <i key={index} data-active={index < activeBars ? "true" : "false"} />
        ))}
      </span>
      {label}
    </span>
  );
}

function MetaMobileCitationList({ items }: { items: Array<{ label: string; value: string }> }) {
  if (items.length === 0) return null;
  return (
    <div className="ad-mobile-citation-list">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          <span className="ad-mobile-cite">[{index + 1}]</span>
          <span>{item.label}: {item.value}</span>
        </div>
      ))}
    </div>
  );
}

function MetaMobileEvidenceScreen({
  item,
  targetRoas,
  moneyCurrency,
  onBack,
}: {
  item: MetaDrillItem;
  targetRoas: number | null | undefined;
  moneyCurrency: string | null | undefined;
  onBack: () => void;
}) {
  if (item.mode === "anomaly") {
    const citationItems = item.anomaly.diagnostics.slice(0, 2).map((diagnostic, index) => ({
      label: `Diagnostic ${index + 1}`,
      value: diagnostic,
    }));
    return (
      <section className="meta-mobile-decision-stage" data-testid="meta-mobile-evidence">
        <div className="ad-mobile-device">
          <div className="ad-mobile-screen">
            <div className="ad-mobile-status">
              <span>--:--</span>
              <span>evidence · read-only</span>
            </div>
            <button type="button" className="ad-mobile-back" onClick={onBack}>
              ← Decisions
            </button>
            <div className="ad-mobile-title">
              <h2>{item.anomaly.scopeLabel}</h2>
              <p>{titleCaseCompact(item.anomaly.scopeType)} · anomaly · detected {mobileTimestamp(item.anomaly.detectedAt)}</p>
            </div>
            <article className="ad-mobile-heat">
              <strong>{item.anomaly.title}</strong>
              <span>{item.anomaly.detail}</span>
            </article>
            <p className="ad-mobile-copy">
              {item.anomaly.diagnostics[0] ?? "The anomaly remains open in the server scan"}
              {citationItems[0] ? <> <span className="ad-mobile-cite">[1]</span></> : null}. Mobile keeps this
              as evidence review only.
            </p>
            <MetaMobileCitationList items={citationItems} />
            <div className="ad-mobile-desktop-note">Act on desktop — this device is read-only by design.</div>
          </div>
        </div>
      </section>
    );
  }

  const rec = item.rec;
  const metrics = structuredMetricsForRec(rec);
  const roasText =
    typeof metrics?.roas === "number" && Number.isFinite(metrics.roas)
      ? `${metrics.roas.toFixed(2)}x${typeof targetRoas === "number" && Number.isFinite(targetRoas) ? ` vs ${targetRoas.toFixed(2)}x target` : ""}`
      : "ROAS —";
  const spendText =
    typeof metrics?.spend === "number" && Number.isFinite(metrics.spend)
      ? formatMoney(metrics.spend, moneyCurrency)
      : "spend —";
  const citationItems = rec.evidence.slice(0, 2).map((evidence) => ({
    label: evidence.label,
    value: evidence.value,
  }));

  return (
    <section className="meta-mobile-decision-stage" data-testid="meta-mobile-evidence">
      <div className="ad-mobile-device">
        <div className="ad-mobile-screen">
          <div className="ad-mobile-status">
            <span>--:--</span>
            <span>evidence · read-only</span>
          </div>
          <button type="button" className="ad-mobile-back" onClick={onBack}>
            ← Decisions
          </button>
          <div className="ad-mobile-title">
            <h2>{scopeNameForRec(rec)}</h2>
            <p>{titleCaseCompact(rec.level)} · {rec.rowPresentation?.accountBadge ?? "account —"}</p>
          </div>
          <article className="ad-mobile-heat">
            <strong>{mobileDecisionLine(rec, targetRoas, moneyCurrency)}</strong>
            <span>{spendText} · {roasText}</span>
          </article>
          <p className="ad-mobile-copy">
            {rec.why || rec.summary || "Decision reasoning is unavailable in this payload"}
            {citationItems[0] ? <> <span className="ad-mobile-cite">[1]</span></> : null}; confidence is {rec.confidence}
            {citationItems[1] ? <> <span className="ad-mobile-cite">[2]</span></> : null}.
          </p>
          <MetaMobileCitationList items={citationItems} />
          <div className="ad-mobile-desktop-note">Act on desktop — this device is read-only by design.</div>
        </div>
      </div>
    </section>
  );
}

function MetaMobileDecisionRow({
  rec,
  targetRoas,
  moneyCurrency,
  onOpen,
}: {
  rec: MetaRecommendation;
  targetRoas: number | null | undefined;
  moneyCurrency: string | null | undefined;
  onOpen: (rec: MetaRecommendation) => void;
}) {
  return (
    <article className="ad-mobile-row-card">
      <div>
        <h3>{scopeNameForRec(rec)}</h3>
        <p data-tone={mobileDecisionTone(rec)}>{mobileDecisionLine(rec, targetRoas, moneyCurrency)}</p>
      </div>
      <div className="ad-mobile-row-footer">
        <MobileDecisionConfidence confidence={rec.confidence} />
        <button type="button" onClick={() => onOpen(rec)}>
          Read evidence →
        </button>
      </div>
    </article>
  );
}

function MetaMobileDecisionsScreen({
  businessName,
  moneyCurrency,
  pulse,
  laneSnapshotDate,
  loading,
  error,
  anomalies,
  actionRows,
  watchingRows,
  targetRoas,
  onOpenRec,
  onOpenAnomaly,
}: {
  businessName?: string | null;
  moneyCurrency: string | null | undefined;
  pulse: MetaPulsePayload | null;
  laneSnapshotDate: string | null;
  loading: boolean;
  error: Error | null;
  anomalies: MetaAnomaly[];
  actionRows: MetaRecommendation[];
  watchingRows: MetaRecommendation[];
  targetRoas: number | null | undefined;
  onOpenRec: (rec: MetaRecommendation) => void;
  onOpenAnomaly: (anomaly: MetaAnomaly) => void;
}) {
  const actCount = loading || error ? "—" : actionRows.length + anomalies.length;
  const primaryRows = [...actionRows, ...watchingRows].slice(0, 2);
  return (
    <section className="meta-mobile-decision-stage" data-testid="meta-mobile-decisions">
      <div className="ad-mobile-device">
        <div className="ad-mobile-screen">
          <div className="ad-mobile-status">
            <span>--:--</span>
            <span>{businessName ?? "Meta"} · Act now {actCount}</span>
          </div>
          <div className="ad-mobile-freshness">
            synced {mobileTimestamp(pulse?.lastSyncAt ?? null)} · snapshot {laneSnapshotDate ?? "—"}
          </div>
          {loading ? (
            <article className="ad-mobile-row-card">
              <h3>Decision queue</h3>
              <p>loading server snapshot —</p>
            </article>
          ) : error ? (
            <article className="ad-mobile-anomaly">
              <b>Decision queue unavailable.</b>
              <div>{error.message || "Missing data is withheld, never shown as zero."}</div>
            </article>
          ) : anomalies[0] ? (
            <button type="button" className="ad-mobile-anomaly ad-mobile-anomaly-button" onClick={() => onOpenAnomaly(anomalies[0]!)}>
              <b>Anomaly:</b> {anomalies[0].title}
              <div>detected {mobileTimestamp(anomalies[0].detectedAt)} · read evidence on mobile, act on desktop</div>
            </button>
          ) : (
            <article className="ad-mobile-anomaly">
              <b>No active anomaly.</b>
              <div>Rows still open evidence on mobile; execution stays desktop-only.</div>
            </article>
          )}
          {primaryRows.map((rec) => (
            <MetaMobileDecisionRow
              key={rec.id}
              rec={rec}
              targetRoas={targetRoas}
              moneyCurrency={moneyCurrency}
              onOpen={onOpenRec}
            />
          ))}
          {!loading && !error && primaryRows.length === 0 ? (
            <article className="ad-mobile-row-card">
              <h3>No high-confidence calls</h3>
              <p>server queue has no mobile-readable action rows</p>
            </article>
          ) : null}
          <div className="ad-mobile-desktop-note">
            Writes are desktop-only — rows here open evidence, never a pause button. Hit targets ≥44px.
          </div>
        </div>
      </div>
    </section>
  );
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
  count: number | null;
  onClick: () => void;
}) {
  return (
    <button type="button" className={cn("tab", className, active ? "active" : "")} onClick={onClick}>
      {label} <span className="count">{count == null ? "—" : count}</span>
    </button>
  );
}

function FinalMetaPulse({
  pulse,
  window,
  onManageLabels,
  moneyCurrency,
  laneAsOf,
  loading = false,
  error = null,
}: {
  pulse?: MetaPulsePayload | null;
  window: MetaWindowKey;
  onManageLabels: () => void;
  moneyCurrency?: string | null;
  laneAsOf?: { snapshotDate: string | null; snapshotCreatedAt?: string | null } | null;
  loading?: boolean;
  error?: Error | null;
}) {
  if (loading || error) {
    const unavailable = Boolean(error);
    const status = unavailable ? "Unavailable" : "Loading";
    const detail = unavailable
      ? error?.message ?? "Meta briefing failed."
      : "Waiting for the Meta briefing payload.";
    return (
      <div
        className="pulse pulse--thin"
        data-testid={unavailable ? "meta-pulse-error" : "meta-pulse-loading"}
        role="status"
      >
        <span>
          Business strip <b>{status}</b>
        </span>
        <span>{detail}</span>
        <span>tones from this business&apos;s server targets</span>
      </div>
    );
  }

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
  const dailySpend =
    pulse?.pacing.spendToday ??
    (pulse?.pacing.dayPace != null && pulse?.pacing.dailyTarget != null
      ? pulse.pacing.dayPace * pulse.pacing.dailyTarget
      : null);
  const avg7dSpend = pulse?.pacing.avg7dSpend ?? null;
  const spendVs7dAvg = formatSignedPercent(percentDelta(dailySpend, avg7dSpend));
  const roasValue =
    window === "custom"
      ? pulse?.roas.selected
      : window === "7d"
        ? pulse?.roas.d7
        : window === "14d"
          ? pulse?.roas.d14
          : pulse?.roas.d28;

  return (
    <div className="pulse pulse--thin" data-testid="meta-business-strip">
      <span>
        {endIsToday ? "Spend · today" : `Spend · ${pulse?.endDate ?? "last day"}`}{" "}
        <b>{dailySpend == null ? "—" : formatMoney(dailySpend, moneyCurrency)}</b>
        {" vs 7d avg "}
        {avg7dSpend == null ? "—" : `${formatMoney(avg7dSpend, moneyCurrency)}/day`}
        {spendVs7dAvg ? ` · ${spendVs7dAvg}` : ""}
      </span>
      <span>
        ROAS · {window === "90d" ? "28d" : window} <b>{formatRoas(roasValue)}</b>
        {" vs target "}
        {pulse?.roas.target == null ? "—" : formatRoas(pulse.roas.target)}
      </span>
      <span className={cn("chip", trackingClass(pulse?.trackingHealth?.status))}>
        <span className="dot" />
        {pulse?.trackingHealth?.status ?? "unknown"}
      </span>
      <span>
        labels {pulse?.labelCoverage ? `${pulse.labelCoverage.labeledCampaigns}/${pulse.labelCoverage.activeCampaigns}` : "—"}
        {labelPercent != null ? ` · ${labelPercent}%` : ""}
        {" · "}
        <button
          type="button"
          className="linklike"
          aria-label="Manage campaign labels"
          onClick={onManageLabels}
        >
          Manage labels
        </button>
      </span>
      <span>
        snapshot {snapshotAge ?? "—"} · engine {pulse?.engineVersion ?? "—"}
        {laneAsOf ? ` · lanes ${laneAsOf.snapshotDate ?? "unavailable"}` : ""}
        {lastSyncLabel ? ` · synced ${lastSyncLabel}` : " · sync unknown"}
      </span>
      <span>tones from this business&apos;s server targets</span>
    </div>
  );
}

function MetaOvernightDigest({
  snapshotDate,
  digest,
  actionStates,
  anomaliesCount,
  deferredCount,
}: {
  snapshotDate: string | null;
  digest?: MetaDecisionsWorkspacePayload["digest"] | null;
  actionStates?: MetaDecisionsWorkspacePayload["queue"]["actionStates"] | null;
  anomaliesCount: number;
  deferredCount: number;
}) {
  const [open, setOpen] = useState(false);
  const executable =
    (actionStates?.executablePause ?? 0) +
    (actionStates?.executableBid ?? 0) +
    (actionStates?.executableResume ?? 0);
  const routes = actionStates?.launchpadRoutes ?? 0;
  const reviewOnly = actionStates?.reviewOnly ?? 0;
  const missing = actionStates?.missingActionKind ?? 0;
  const labelFlipText = digest
    ? `${countPhrase(digest.labelFlips.count, "label flip")} (${digest.labelFlips.publishedCount} published)`
    : "label flips unavailable";
  const actionText = digest
    ? `${countPhrase(digest.actions.verifiedCount, "action")} verified${digest.actions.silentFailureCount > 0 ? ` · ${digest.actions.silentFailureCount} silent_failure` : ""}`
    : `actions ready ${executable}`;
  const anomalyText = digest ? `${countPhrase(digest.anomalies.openedCount, "anomaly")} opened` : `anomalies ${anomaliesCount}`;
  const deferralText = digest ? `${countPhrase(digest.deferrals.dueCount, "deferral")} due back` : `deferrals due ${deferredCount}`;
  return (
    <div className="meta-digest" data-testid="meta-overnight-digest">
      <button
        type="button"
        className="meta-digest__toggle"
        aria-expanded={open}
        aria-controls="meta-digest-details"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown className={cn("meta-digest__chevron", open && "open")} size={13} aria-hidden="true" />
        <span className="meta-digest__title">Since last snapshot</span>
        <b>{snapshotDate ?? "snapshot —"}</b>
        <span className="meta-digest__summary">
          {labelFlipText} · {actionText} · {anomalyText} · {deferralText}
        </span>
      </button>
      {open ? (
        <div id="meta-digest-details" className="meta-digest__details">
          {digest?.unavailableReason ? (
            <div className="meta-digest__line muted">Digest details unavailable: {digest.unavailableReason}</div>
          ) : null}
          <div className="meta-digest__line">
            <span>Label flips:</span>{" "}
            {digest && digest.labelFlips.items.length > 0
              ? digest.labelFlips.items.slice(0, 3).map((item, index) => (
                  <span key={item.id} className="meta-digest__item">
                    {index > 0 ? "; " : null}
                    <b>{item.title}</b> {item.previousLabel} -&gt; {item.currentLabel}{" "}
                    <em>{item.status}</em>
                  </span>
                ))
              : "none in the served snapshot window"}
          </div>
          <div className="meta-digest__line">
            <span>Actions:</span>{" "}
            {digest && digest.actions.items.length > 0
              ? digest.actions.items.slice(0, 4).map((item, index) => (
                  <span key={item.id} className="meta-digest__item">
                    {index > 0 ? " · " : null}
                    {item.action} <b>{item.target}</b>
                    {item.actor ? ` by ${item.actor}` : ""}{" "}
                    <em className={item.status === "silent_failure" ? "danger" : "success"}>
                      {item.status === "silent_failure"
                        ? `silent_failure${item.detail ? ` - ${item.detail}` : ""}`
                        : `verified${formatDigestTime(item.occurredAt) ? ` ${formatDigestTime(item.occurredAt)}` : ""}`}
                    </em>
                  </span>
                ))
              : digest
                ? "no verified action logs in the served window"
                : `ready ${executable} · routes ${routes} · review-only ${reviewOnly}`}
          </div>
          <div className="meta-digest__line">
            <span>Anomalies:</span>{" "}
            {digest && digest.anomalies.items.length > 0
              ? digest.anomalies.items.slice(0, 3).map((item, index) => (
                  <span key={item.id} className="meta-digest__item">
                    {index > 0 ? " · " : null}
                    <b>{item.title}</b> {item.status}
                    {formatDigestTime(item.occurredAt) ? ` ${formatDigestTime(item.occurredAt)}` : ""}
                  </span>
                ))
              : `${anomaliesCount} counted separately`}
          </div>
          <div className="meta-digest__line">
            <span>Deferrals due back:</span>{" "}
            {digest && digest.deferrals.items.length > 0
              ? digest.deferrals.items.slice(0, 3).map((item, index) => (
                  <span key={item.id} className="meta-digest__item">
                    {index > 0 ? " · " : null}
                    <b>{item.title}</b>
                    {formatDigestTime(item.dueAt) ? ` (${formatDigestTime(item.dueAt)})` : ""}
                    {item.detail ? ` · ${item.detail}` : ""}
                  </span>
                ))
              : `${deferredCount} deferred rows in local state`}
          </div>
          {missing > 0 ? <div className="meta-digest__line muted">Missing action kind: {missing}</div> : null}
        </div>
      ) : null}
    </div>
  );
}

function formatDigestTime(value: string | null | undefined) {
  if (!value) return null;
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return null;
  return new Intl.DateTimeFormat("en", {
    hour: "2-digit",
    minute: "2-digit",
    hour12: false,
    timeZone: "UTC",
  }).format(date);
}

function countPhrase(count: number, noun: string) {
  return `${count} ${noun}${count === 1 ? "" : "s"}`;
}

// The creative decision engine is a SEPARATE engine from the Meta v1 media-buying
// engine. Its per-creative decisions are surfaced in the Action Now lane as their OWN
// group, ranked only among themselves — never globally ranked against campaign/adset
// money-at-stake ("no fake global rank across engines"). These are analysis-only:
// Review links to Creative Studio, never a write. Gated by the engine's surfaceVisible.
const ACTIONABLE_CREATIVE_LABELS = new Set<DecisionLabel>([
  "scale",
  "cut",
  "refresh",
  "test_more",
  "diagnose",
]);

interface CreativeEngineDecisions {
  decisions: DecisionOutput[];
  surfaceVisible: boolean;
}

async function fetchCreativeEngineDecisions(
  businessId: string,
  asOf: string,
): Promise<CreativeEngineDecisions> {
  const params = new URLSearchParams({ businessId });
  if (asOf) params.set("asOf", asOf);
  const response = await fetch(`/api/creatives/decision-engine-v3?${params.toString()}`);
  if (!response.ok) {
    throw new Error(`creative decision engine request failed (${response.status})`);
  }
  const payload = await response.json().catch(() => null);
  if (!payload || payload.status === "disabled") {
    return { decisions: [], surfaceVisible: false };
  }
  return {
    decisions: Array.isArray(payload.decisions) ? (payload.decisions as DecisionOutput[]) : [],
    surfaceVisible: Boolean(payload.flags?.enabled && payload.flags?.surfaceVisible),
  };
}

function creativeDecisionSearchMatch(decision: DecisionOutput, search: string) {
  const q = search.trim().toLowerCase();
  if (!q) return true;
  return [decision.creativeName ?? "", decision.creativeId, decision.label, decision.reason].some(
    (value) => value.toLowerCase().includes(q),
  );
}

function MetaCreativeDecisionCard({
  decision,
  moneyCurrency,
}: {
  decision: DecisionOutput;
  moneyCurrency: string | null;
}) {
  const display = LABEL_DISPLAY[decision.label];
  const palette = DECISION_LABEL_PALETTE[decision.label];
  const roas = decision.metrics.roas;
  return (
    <article className="dcard" data-card="creative-decision" data-creative-id={decision.creativeId}>
      <div className="check" />
      <div>
        <div className="meta-line">
          <span className={cn("chip", palette.legacyClassName)} data-creative-label>
            {display.label}
          </span>
          <b>{decision.creativeName ?? decision.creativeId}</b>
        </div>
        <div className="why">
          {decision.reason || "Creative decision from the creative decision engine."}
          <span className="from">
            source · creative decision engine{decision.engineVersion ? ` · ${decision.engineVersion}` : ""}
          </span>
        </div>
        <div className="metric-strip">
          <div className="m">
            <span className="k">Spend</span>
            <span className="v">
              {decision.metrics.spend != null ? formatMoney(decision.metrics.spend, moneyCurrency) : "—"}
            </span>
          </div>
          <div className="m">
            <span className="k">ROAS 28d</span>
            <span className="v">{roas != null ? formatRoas(roas) : "—"}</span>
          </div>
          <div className="m">
            <span className="k">Confidence</span>
            <span className="v">
              {Number.isFinite(decision.confidence) ? `${Math.round(decision.confidence)}%` : "—"}
            </span>
          </div>
        </div>
      </div>
      <div className="actions-col">
        <span className="why-action">Analysis only</span>
        <Link className="btn btn--primary" href="/platforms/meta/creatives" data-testid="meta-creative-review">
          Review
        </Link>
      </div>
    </article>
  );
}

function MetaLaneGroupHeader({
  title,
  note,
}: {
  title: string;
  note?: ReactNode;
}) {
  return (
    <div className="meta-lane-group-head" data-testid="meta-lane-group-head">
      <span>{title}</span>
      {typeof note === "string" ? <small>{note}</small> : note}
    </div>
  );
}

type MetaWorkspaceBanner = MetaDecisionsWorkspacePayload["banners"][number];

function workspaceBannerPriority(banner: MetaWorkspaceBanner) {
  if (banner.id === "meta_write_kill_switch") return 0;
  if (banner.id === "dry_run_mode" || banner.id === "dry_run_only_guardrail") return 1;
  if (banner.id === "tracking_write_gate") return 2;
  if (banner.id === "reviewer_read_only" || banner.id === "workspace_read_only") return 3;
  if (banner.blocking) return 3;
  if (banner.id === "snapshot_health") return 4;
  if (banner.id === "data_readiness") return 5;
  return 6;
}

function workspaceBannerToneClass(banner: MetaWorkspaceBanner) {
  if (banner.tone === "danger") return "danger";
  if (banner.tone === "warning") return "warn";
  if (banner.tone === "success") return "success";
  return "info";
}

function workspaceBannerDetail(banner: MetaWorkspaceBanner) {
  if (banner.id === "tracking_write_gate") {
    return `${banner.detail} Pause, bid and rebuild writes ask for confirmation first. Hiding this banner does not unlock writes; the gate stays active.`;
  }
  if (banner.id === "meta_write_kill_switch") {
    return `${banner.detail} The queue stays readable; execute and route actions are locked until an Admin releases it.`;
  }
  return banner.detail;
}

function MetaWorkspacePostureBanners({
  banners,
  trackingDismissed,
  onDismissTracking,
  onOpenTrackingDetails,
}: {
  banners: MetaWorkspaceBanner[];
  trackingDismissed: boolean;
  onDismissTracking: () => void;
  onOpenTrackingDetails: () => void;
}) {
  const visibleBanners = [...banners]
    .filter((banner) => !(banner.id === "tracking_write_gate" && trackingDismissed))
    .sort((left, right) => workspaceBannerPriority(left) - workspaceBannerPriority(right));
  if (visibleBanners.length === 0) return null;
  return (
    <div className="meta-posture-banners" data-testid="meta-posture-banners">
      {visibleBanners.map((banner) => {
        const tone = workspaceBannerToneClass(banner);
        return (
          <div
            key={banner.id}
            className={cn("meta-posture-banner", `meta-posture-banner--${tone}`)}
            data-banner-id={banner.id}
            data-banner-blocking={banner.blocking ? "true" : "false"}
            role={banner.blocking || tone === "danger" ? "alert" : "status"}
          >
            <span className="meta-posture-banner__mark" aria-hidden="true" />
            <span className="meta-posture-banner__title">{banner.title}</span>
            <span className="meta-posture-banner__detail">{workspaceBannerDetail(banner)}</span>
            <span className="meta-posture-banner__spacer" aria-hidden="true" />
            {banner.id === "meta_write_kill_switch" ? (
              <a className="meta-posture-banner__button" href="/platforms/meta/automation">System Status</a>
            ) : null}
            {banner.id === "tracking_write_gate" ? (
              <>
                <button type="button" className="meta-posture-banner__button" onClick={onOpenTrackingDetails}>View details</button>
                <button type="button" className="meta-posture-banner__button meta-posture-banner__button--ghost" onClick={onDismissTracking}>Hide banner</button>
              </>
            ) : null}
          </div>
        );
      })}
    </div>
  );
}

function formatEngineRunTime(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) return null;
  return `${parsed.toISOString().slice(11, 16)} UTC`;
}

/**
 * Header as-of cluster. Surfaces the divergent as-of contract already carried
 * by the payloads: ingest freshness (pulse.lastSyncAt), the served lane
 * snapshot date (lane-classify), and the engine version + run time (pulse).
 * Each value is real or an honest em dash — never fabricated "now".
 */
function MetaAsOfCluster({
  pulse,
  laneSnapshotDate,
  loading = false,
  error = null,
}: {
  pulse?: MetaPulsePayload | null;
  laneSnapshotDate?: string | null;
  loading?: boolean;
  error?: Error | null;
}) {
  if (loading || error) {
    return (
      <div
        className="meta-asof"
        data-testid="meta-asof-cluster"
        title="The briefing payload is not available yet; as-of values are withheld instead of fabricated."
      >
        <span>{error ? "briefing unavailable" : "briefing loading"}</span>
        <span className="sep" aria-hidden="true">·</span>
        <span>snapshot —</span>
        <span className="sep" aria-hidden="true">·</span>
        <span>engine —</span>
      </div>
    );
  }
  const synced = pulse?.lastSyncAt ? `synced ${shortRelativeTime(pulse.lastSyncAt)}` : "sync unknown";
  const snapshot = laneSnapshotDate ? `snapshot ${laneSnapshotDate}` : "snapshot —";
  const engineVersion = pulse?.engineVersion ?? "—";
  const runTime = formatEngineRunTime(pulse?.engineLastRun);
  return (
    <div
      className="meta-asof"
      data-testid="meta-asof-cluster"
      title="Ingest, decision snapshot, and engine run each carry their own as-of; they can legitimately diverge."
    >
      <span>{synced}</span>
      <span className="sep" aria-hidden="true">·</span>
      <span>{snapshot}</span>
      <span className="sep" aria-hidden="true">·</span>
      <span>
        engine {engineVersion}
        {runTime ? ` · ${runTime}` : ""}
      </span>
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
  const [rowSort, setRowSort] = useState<MetaRowSort>("money");
  const [rowSearch, setRowSearch] = useState("");
  const [minSpendOnly, setMinSpendOnly] = useState(false);
  const [laneDensity, setLaneDensity] = useState<"cozy" | "compact">("cozy");
  const [pendingPauseRec, setPendingPauseRec] = useState<MetaRecommendation | null>(null);
  const [bulkPauseOpen, setBulkPauseOpen] = useState(false);
  const pushInspector = useMinWidth(1440);
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

  const workspaceQuery = useQuery({
    queryKey: ["meta-decisions-workspace", businessId, selectedWindow, selectedStatusFilter, selectedDateRange.start, selectedDateRange.end],
    enabled: Boolean(businessId),
    queryFn: () => fetchDecisionsWorkspace(businessId, selectedWindow, selectedStatusFilter, selectedDateRange),
    // A transient upstream slowness (e.g. a cold route compile the first time the
    // decisions-workspace fan-out is hit) previously left a permanent empty shell
    // because retry was disabled. Retry with backoff so a one-off timeout self-heals.
    retry: 2,
    retryDelay: (attempt) => Math.min(1500 * 2 ** attempt, 6000),
  });
  const pulseQuery = {
    data: workspaceQuery.data?.pulse,
    isLoading: workspaceQuery.isLoading,
    error: workspaceQuery.error,
  };
  const laneQuery = {
    data: workspaceQuery.data?.lanes,
    isLoading: workspaceQuery.isLoading,
    error: workspaceQuery.error,
  };
  const moneyCurrency = pulseQuery.data?.currency ?? currency ?? null;
  const targetRoas = pulseQuery.data?.roas.target ?? null;
  const entityParam = searchParams.get("entity");

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
  // Creative decision engine (separate from the Meta v1 media-buying engine). Surfaced
  // as its own Action Now group, ranked only among creatives. Analysis-only.
  const creativeDecisionsQuery = useQuery({
    queryKey: ["meta-decisions-creative-engine", businessId, selectedDateRange?.end ?? null],
    enabled: Boolean(businessId),
    queryFn: () => fetchCreativeEngineDecisions(businessId, selectedDateRange?.end ?? ""),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const briefingLoading = pulseQuery.isLoading || laneQuery.isLoading;
  const briefingError = (pulseQuery.error ?? laneQuery.error ?? null) as Error | null;
  const briefingUnavailable = briefingLoading || Boolean(briefingError);
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
  // Row search + sort over structured server truth; missing-metric rows kept
  // last. Applied to the rendered rec lists only (tab counts stay lane totals).
  const visibleActionRecs = useMemo(
    () => sortMetaRecs(individualActionNow.filter((rec) => metaRecSearchMatch(rec, rowSearch) && passesMetaMinSpend(rec, minSpendOnly)), rowSort),
    [individualActionNow, rowSearch, rowSort, minSpendOnly],
  );
  // Creative decisions that call for a decision (excludes keep/out_of_scope). Same
  // search + min-spend filters as the campaign rows; null spend stays hidden, never 0.
  const creativeActionDecisions = useMemo(() => {
    const data = creativeDecisionsQuery.data;
    if (!data || !data.surfaceVisible) return [] as DecisionOutput[];
    return data.decisions
      .filter((decision) => ACTIONABLE_CREATIVE_LABELS.has(decision.label))
      .filter((decision) => creativeDecisionSearchMatch(decision, rowSearch))
      .filter(
        (decision) =>
          !minSpendOnly || (typeof decision.metrics.spend === "number" && decision.metrics.spend >= 50),
      );
  }, [creativeDecisionsQuery.data, rowSearch, minSpendOnly]);
  const visibleWatchingRecs = useMemo(
    () => sortMetaRecs(filteredWatching.filter((rec) => metaRecSearchMatch(rec, rowSearch) && passesMetaMinSpend(rec, minSpendOnly)), rowSort),
    [filteredWatching, rowSearch, rowSort, minSpendOnly],
  );
  const visibleNonSalesRecs = useMemo(
    () => sortMetaRecs(filteredNonSales.filter((rec) => metaRecSearchMatch(rec, rowSearch) && passesMetaMinSpend(rec, minSpendOnly)), rowSort),
    [filteredNonSales, rowSearch, rowSort, minSpendOnly],
  );
  const rowSearchActive = rowSearch.trim().length > 0;
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
  const viewerReadOnlyReason = workspaceQuery.data?.viewer?.readOnly
    ? (workspaceQuery.data.viewer.readOnlyReason ?? "Current viewer is read-only; write controls are downgraded to review.")
    : null;
  const isViewerReadOnly = Boolean(viewerReadOnlyReason);
  const workspaceBanners = useMemo<MetaWorkspaceBanner[]>(() => {
    const served = workspaceQuery.data?.banners ?? [];
    if (served.length > 0) return served;
    const fallback: MetaWorkspaceBanner[] = [];
    const readiness = pulseQuery.data?.dataReadiness ?? null;
    if (readiness && (readiness.status !== "ok" || readiness.isPartial)) {
      fallback.push({
        id: "data_readiness",
        tone: "warning",
        title: "Data is not fully ready.",
        detail: readiness.notReadyReason ?? "The selected range is partially verified; numbers may be incomplete.",
        blocking: false,
      });
    }
    if (trackingBlocked) {
      fallback.push({
        id: "tracking_write_gate",
        tone: "warning",
        title: "Tracking degraded — purchase signal may be incomplete.",
        detail: pulseQuery.data?.trackingHealth.detail ?? "Hard actions stay gated until tracking is checked.",
        blocking: true,
      });
    }
    const snapshotHealth = pulseQuery.data?.snapshotHealth ?? laneQuery.data?.snapshotHealth ?? null;
    if (snapshotHealth && snapshotHealth.status !== "fresh") {
      fallback.push({
        id: "snapshot_health",
        tone: snapshotHealth.status === "missing" ? "danger" : "warning",
        title: "Decision snapshot is not fresh.",
        detail: snapshotHealth.staleReason ?? "The served snapshot does not meet the current freshness contract.",
        blocking: snapshotHealth.status === "missing",
      });
    }
    if (workspaceQuery.data?.system.killSwitchEngaged) {
      fallback.push({
        id: "meta_write_kill_switch",
        tone: "danger",
        title: "Kill switch engaged.",
        detail: workspaceQuery.data.system.killSwitchReason ?? "Meta writes are disabled by kill switch.",
        blocking: true,
      });
    }
    const viewer = workspaceQuery.data?.viewer ?? null;
    if (viewer?.readOnly && viewer.readOnlyReason) {
      fallback.push({
        id: viewer.isReviewer ? "reviewer_read_only" : "workspace_read_only",
        tone: "info",
        title: viewer.isReviewer ? "Reviewer access is read-only." : "Workspace access is read-only.",
        detail: viewer.readOnlyReason,
        blocking: false,
      });
    }
    return fallback;
  }, [workspaceQuery.data, pulseQuery.data, laneQuery.data, trackingBlocked]);

  const laneSnapshotDate = laneQuery.data?.snapshotDate ?? null;
  const deferredCount = localDeferredIds.size + campaignDefer.deferredCount + adsetDefer.deferredCount;
  const actionGroupCount = rollups.length + visibleActionRecs.length;

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
      queryClient.invalidateQueries({ queryKey: ["meta-decisions-workspace", businessId] }),
      queryClient.invalidateQueries({ queryKey: ["meta-anomalies", businessId] }),
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
    if (isViewerReadOnly) {
      setNotice(viewerReadOnlyReason ?? "Current viewer is read-only; snapshot refresh is unavailable.");
      return;
    }
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
    if (isViewerReadOnly) return;
    setLocalResponseStates((current) => ({ ...current, [rec.id]: "acted" }));
    await postResponse({ businessId, recId: rec.id, action: "acted", actionSubtype: subtype }).catch(() => null);
  };

  const deferRec = async (rec: MetaRecommendation) => {
    if (isViewerReadOnly) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      openDrillForRec(rec);
      return;
    }
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
    if (isViewerReadOnly) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      openDrillForRec(rec);
      return;
    }
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

  const setEntityParam = (entityId: string | null) => {
    const params = currentUrlParams();
    if (entityId) {
      params.set("entity", entityId);
    } else {
      params.delete("entity");
    }
    replaceMetaParams(params);
  };

  const openDrillForRec = (rec: MetaRecommendation) => {
    setDrillItem({
      mode: "decision",
      rec,
      relatedRecs: rec.campaignId ? (adsetRecsByCampaign.get(rec.campaignId) ?? []) : [],
    });
    // Deep-link the open entity (a selection, not a drawer-local control).
    setEntityParam(rec.id);
  };

  const closeDrill = () => {
    setDrillItem(null);
    if (entityParam) setEntityParam(null);
  };

  const compareRec = (rec: MetaRecommendation) => {
    setSelectedIds((current) => new Set(current).add(rec.id));
    setCompareOpen(true);
  };

  // Deep-link restore: open the drawer for ?entity=<id> once lanes are loaded.
  useEffect(() => {
    if (!entityParam || drillItem) return;
    const rec = [...actionNow, ...watching, ...nonSales].find((candidate) => candidate.id === entityParam);
    if (rec) {
      setDrillItem({
        mode: "decision",
        rec,
        relatedRecs: rec.campaignId ? (adsetRecsByCampaign.get(rec.campaignId) ?? []) : [],
      });
    }
  }, [entityParam, laneQuery.data]);

  const isTrackingSensitiveRec = (rec: MetaRecommendation) => {
    return (
      rec.actionKind === "execute_pause" ||
      rec.actionKind === "execute_bid" ||
      rec.actionKind === "route_launchpad_rebuild"
    );
  };

  const performPrimary = async (rec: MetaRecommendation) => {
    if (isViewerReadOnly) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      openDrillForRec(rec);
      return;
    }
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
    if (isViewerReadOnly) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      openDrillForRec(rec);
      return;
    }
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
    if (isViewerReadOnly) {
      setArchiveActionFeedback({
        key: `${row.level}-${row.id}`,
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      return;
    }
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
    if (isViewerReadOnly) {
      openDrillForRec(rec);
      return;
    }
    // A pause is a delivery-stopping write: always show the Current -> Proposed
    // delta first. This modal subsumes the tracking-anomaly confirm for pauses,
    // so the trackingBlocked branch is chained into the delta Confirm rather
    // than shown as a second dialog.
    if (rec.actionKind === "execute_pause") {
      setPendingPauseRec(rec);
      return;
    }
    if (trackingBlocked && isTrackingSensitiveRec(rec)) {
      setPendingPrimaryRec(rec);
      return;
    }
    await performPrimary(rec);
  };

  const confirmPendingPause = () => {
    const rec = pendingPauseRec;
    setPendingPauseRec(null);
    if (rec) void performPrimary(rec);
  };

  // Bulk pause: pauses each selected entity through the exact single-row pause
  // path (performPrimary -> /api/meta/adsets/{id}/pause). Only adset-level
  // execute_pause rows are pausable, so non-pausable selections are left
  // untouched rather than silently "handled".
  const bulkPausableRecs = useMemo(
    () => selectedRecs.filter((rec) => rec.actionKind === "execute_pause" && Boolean(rec.adsetId)),
    [selectedRecs],
  );

  const confirmBulkPause = async () => {
    setBulkPauseOpen(false);
    for (const rec of bulkPausableRecs) {
      await performPrimary(rec);
    }
  };

  const deferSelectedRecs = async () => {
    for (const rec of selectedRecs) {
      await deferRec(rec);
    }
  };

  const confirmOverlay = async () => {
    const rec = overlay.rec;
    if (!rec) return;
    if (isViewerReadOnly) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Read-only access.",
        detail: viewerReadOnlyReason,
      });
      setOverlay(EMPTY_OVERLAY);
      openDrillForRec(rec);
      return;
    }
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
    if (isViewerReadOnly && action !== "compare") {
      openDrillForRec(first);
      return;
    }
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
    if (isViewerReadOnly) {
      const first = selectedRecs[0];
      if (first) openDrillForRec(first);
      return;
    }
    if (action === "launch_selected") {
      openLaunchpadForSelectedRecs();
      return;
    }
    const rec = selectedRecByRoas(action === "scale_strongest" ? "strongest" : "weakest");
    if (!rec) return;
    await handlePrimary(rec);
  };

  const loading = briefingLoading;
  const error = briefingError ?? ((anomalyQuery.error ?? null) as Error | null);

  return (
    <div className="ad-final meta-decisions-final" data-testid="meta-platform-page">
      {drillItem ? (
        <MetaMobileEvidenceScreen
          item={drillItem}
          targetRoas={targetRoas}
          moneyCurrency={moneyCurrency}
          onBack={() => setDrillItem(null)}
        />
      ) : (
        <MetaMobileDecisionsScreen
          businessName={businessName}
          moneyCurrency={moneyCurrency}
          pulse={pulseQuery.data ?? null}
          laneSnapshotDate={laneSnapshotDate}
          loading={loading}
          error={error}
          anomalies={anomalies}
          actionRows={visibleActionRecs}
          watchingRows={visibleWatchingRecs}
          targetRoas={targetRoas}
          onOpenRec={(rec) => openDrillForRec(rec)}
          onOpenAnomaly={(anomaly) => setDrillItem({ mode: "anomaly", anomaly })}
        />
      )}
      <div className="topbar">
        <div className="meta-topbar-left">
          <div>
            <div className="crumbs">Platforms · <b>Meta</b> · Decision Center</div>
            <h1 className="page-title">Meta · Decision Center</h1>
          </div>
          <div className="controls" style={{ border: "none", padding: 0 }}>
            <HtmlDateRangePicker value={selectedDateRange} onApply={setDateRange} />
            <MetaStatusControls selectedStatusFilter={selectedStatusFilter} onStatusFilterChange={setStatusFilter} />
          </div>
        </div>
        <div className="right-tools">
          <MetaAsOfCluster
            pulse={pulseQuery.data ?? null}
            laneSnapshotDate={laneSnapshotDate}
            loading={briefingLoading}
            error={briefingError}
          />
          <button
            type="button"
            className="btn"
            disabled={refreshingSnapshot || isViewerReadOnly}
            title={isViewerReadOnly ? viewerReadOnlyReason ?? "Current viewer is read-only." : undefined}
            onClick={refreshSnapshotNow}
          >
            <RefreshCw className="inline-block shrink-0" size={13} aria-hidden="true" />
            {isViewerReadOnly ? "Snapshot read-only" : refreshingSnapshot ? "Running..." : "Run snapshot"}
          </button>
          <a className="btn btn--primary" href="/platforms/meta/launchpad?fromMetaBriefing=true&mode=duplicate">+ New campaign</a>
        </div>
      </div>

      <p className="meta-queue-scope-note" data-testid="meta-queue-scope-note">
        {briefingLoading ? (
          "queue is loading the latest decision snapshot"
        ) : briefingError ? (
          "queue unavailable — snapshot and decision counts are withheld until the briefing reloads"
        ) : (
          <>
            queue reflects{" "}
            {laneSnapshotDate ? (
              <>
                snapshot <b>{laneSnapshotDate}</b>
              </>
            ) : (
              "the latest snapshot"
            )}{" "}
            — the date range scopes metrics, not decisions
          </>
        )}
      </p>

      {briefingError ? (
        <div className="banner danger" data-testid="meta-briefing-error">
          <div className="icon">!</div>
          <div className="msg">
            <b>Meta briefing could not load.</b>
            <span className="sub">
              {briefingError.message || "Decision metrics and counts are withheld to avoid showing false zeros."}
            </span>
          </div>
          <button
            type="button"
            className="btn btn--sm"
            data-testid="meta-briefing-retry"
            disabled={workspaceQuery.isFetching}
            onClick={() => void workspaceQuery.refetch()}
          >
            {workspaceQuery.isFetching ? "Retrying…" : "Retry"}
          </button>
        </div>
      ) : null}

      {notice ? (
        <div className="banner warn">
          <div className="icon">i</div>
          <div className="msg"><b>{notice}</b><span className="sub">{businessName ?? "Selected account"}</span></div>
        </div>
      ) : null}

      <MetaWorkspacePostureBanners
        banners={workspaceBanners}
        trackingDismissed={trackingDismissed}
        onDismissTracking={() => setTrackingDismissed(true)}
        onOpenTrackingDetails={() => setDrillItem(anomalies[0] ? { mode: "anomaly", anomaly: anomalies[0] } : null)}
      />

      <div className="lane-tabs">
        <MetaLaneTab active={activeLane === "action"} className="action" label="Action Now" count={briefingUnavailable ? null : filteredActionNow.length + anomalies.length} onClick={() => setActiveLane("action")} />
        <MetaLaneTab active={activeLane === "watching"} className="watch" label="Watching" count={briefingUnavailable ? null : filteredWatching.length} onClick={() => setActiveLane("watching")} />
        <MetaLaneTab active={activeLane === "healthy"} className="healthy" label="Healthy" count={briefingUnavailable ? null : filteredHealthy.length} onClick={() => setActiveLane("healthy")} />
        <MetaLaneTab active={activeLane === "nonSales"} label="Non-sales" count={briefingUnavailable ? null : filteredNonSales.length} onClick={() => setActiveLane("nonSales")} />
        <MetaLaneTab active={activeLane === "archive"} label="Archive" count={briefingUnavailable ? null : filteredArchive.length} onClick={() => setActiveLane("archive")} />
        <div style={{ flex: 1 }} />
        <div className="tab" style={{ color: "var(--muted)" }}>
          <span className="chip chip--ghost"><span className="dot" />Deferred {deferredCount}</span>
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
        <label
          className="meta-row-sort"
          style={{ display: "inline-flex", alignItems: "center", gap: 5, fontSize: 11.5, color: "var(--muted)" }}
        >
          Sort
          <select
            data-testid="meta-row-sort"
            value={rowSort}
            onChange={(event) => setRowSort(event.currentTarget.value as MetaRowSort)}
            aria-label="Sort decision rows"
            style={{
              fontFamily: "inherit",
              fontSize: 12,
              color: "var(--ink)",
              background: "var(--surface)",
              border: "1px solid var(--border-2)",
              borderRadius: "var(--r-sm)",
              padding: "3px 6px",
            }}
          >
            <option value="money">Money at stake</option>
            <option value="priority">Priority</option>
            <option value="age">Age</option>
          </select>
        </label>
        <input
          data-testid="meta-row-search"
          value={rowSearch}
          onChange={(event) => setRowSearch(event.currentTarget.value)}
          placeholder="Search entities"
          aria-label="Search decision rows"
          style={{
            fontFamily: "inherit",
            fontSize: 12,
            color: "var(--ink)",
            background: "var(--surface-2)",
            border: "1px solid var(--border-2)",
            borderRadius: "var(--r-sm)",
            padding: "4px 9px",
            width: 150,
          }}
        />
        <button
          type="button"
          data-testid="meta-min-spend-toggle"
          data-active={minSpendOnly ? "true" : "false"}
          aria-pressed={minSpendOnly}
          onClick={() => setMinSpendOnly((current) => !current)}
          title={`Client-only: hide rows with window spend below ${formatMoney(META_MIN_SPEND_THRESHOLD, moneyCurrency)}. Rows with no spend stay hidden — never counted as 0.`}
          style={{
            fontFamily: "inherit",
            fontSize: 11.5,
            color: minSpendOnly ? "var(--ink)" : "var(--muted)",
            background: minSpendOnly ? "var(--surface)" : "var(--surface-2)",
            border: `1px solid ${minSpendOnly ? "var(--ink)" : "var(--border-2)"}`,
            borderRadius: "var(--r-sm)",
            padding: "4px 9px",
            cursor: "pointer",
          }}
        >
          Min spend ≥ {formatMoney(META_MIN_SPEND_THRESHOLD, moneyCurrency)}
        </button>
        <button
          type="button"
          data-testid="meta-density-toggle"
          data-density={laneDensity}
          aria-label={`Row density: ${laneDensity}`}
          onClick={() => setLaneDensity((current) => (current === "cozy" ? "compact" : "cozy"))}
          title="Toggle row density (client-only)."
          style={{
            fontFamily: "inherit",
            fontSize: 11.5,
            color: "var(--muted)",
            background: "var(--surface-2)",
            border: "1px solid var(--border-2)",
            borderRadius: "var(--r-sm)",
            padding: "4px 9px",
            cursor: "pointer",
          }}
        >
          {laneDensity === "cozy" ? "Compact rows" : "Cozy rows"}
        </button>
        <span
          className="filter-info-chip"
          title="These controls narrow server-provided lanes. They do not recompute recommendation lanes in the UI."
        >
          <span>{windowLabel(selectedDateRange.window)}</span>
          <Info className="inline-block shrink-0" size={13} aria-hidden="true" />
        </span>
      </div>

      <div className="meta-content-row">
        <div className="meta-queue-col">
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
            loading={briefingLoading}
            error={briefingError}
          />
          <MetaOvernightDigest
            snapshotDate={laneSnapshotDate}
            digest={workspaceQuery.data?.digest ?? null}
            actionStates={workspaceQuery.data?.queue.actionStates ?? null}
            anomaliesCount={anomalies.length}
            deferredCount={deferredCount}
          />
          <ReadinessNotice
            pulse={pulseQuery.data ?? null}
            onManageLabels={() => setLabelModalOpen(true)}
            onRefresh={refreshSnapshotNow}
            refreshing={refreshingSnapshot}
            readOnlyReason={viewerReadOnlyReason}
          />
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
          <div className="lane-stack" data-density={laneDensity}>
            {activeLane === "action" ? (
              <>
                {anomalies.length > 0 ? (
                  <MetaLaneGroupHeader
                    title={`ANOMALIES · ${anomalies.length} · counted separately`}
                    note={
                      <small data-testid="meta-anomaly-asof">
                        {anomalyQuery.data?.snapshotDate ? `anomaly scan as of ${anomalyQuery.data.snapshotDate}` : "anomaly scan as of —"}
                      </small>
                    }
                  />
                ) : null}
                {anomalies.map((anomaly) => (
                  <MetaActionCard key={anomaly.id} anomaly={anomaly} onOpenDrill={(item) => setDrillItem({ mode: "anomaly", anomaly: item as MetaAnomaly })} />
                ))}
                {actionGroupCount > 0 ? (
                  <MetaLaneGroupHeader
                    title={`CAMPAIGNS & AD SETS · ${actionGroupCount}`}
                    note="server-provided rows; filters only narrow the queue"
                  />
                ) : null}
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
                {visibleActionRecs.map((rec) => (
                  <MetaActionCard
                    key={rec.id}
                    moneyCurrency={moneyCurrency}
                    targetRoas={targetRoas}
                    rec={rec}
                    selected={selectedIds.has(rec.id)}
                    deferred={isDeferred(rec)}
                    responseState={responseStateForRec(rec)}
                    primaryPending={pendingActionRecId === rec.id}
                    actionFeedback={primaryActionFeedback?.recId === rec.id ? primaryActionFeedback : null}
                    readOnlyReason={viewerReadOnlyReason}
                    evidenceWindow={selectedWindow}
                    onSelect={selectRec}
                    onPrimary={handlePrimary}
                    onResume={requestResumeRecommendation}
                    onOpenDrill={(item) => openDrillForRec(item as MetaRecommendation)}
                    onDefer={deferRec}
                    onUndoDefer={undeferRec}
                    onCompare={compareRec}
                  />
                ))}
                {creativeActionDecisions.length > 0 ? (
                  <>
                    <MetaLaneGroupHeader
                      title={`CREATIVES · ${creativeActionDecisions.length}`}
                      note="creative decision engine · ranked separately — no fake global rank across engines"
                    />
                    {creativeActionDecisions.map((decision) => (
                      <MetaCreativeDecisionCard
                        key={decision.creativeId}
                        decision={decision}
                        moneyCurrency={moneyCurrency}
                      />
                    ))}
                  </>
                ) : null}
                {rowSearchActive && visibleActionRecs.length === 0 && rollups.length === 0 && anomalies.length === 0 && creativeActionDecisions.length === 0 && filteredActionNow.length > 0 ? (
                  <div className="lane-empty">No Action Now rows match “{rowSearch.trim()}”.</div>
                ) : null}
                {filteredActionNow.length === 0 && anomalies.length === 0 && creativeActionDecisions.length === 0 ? (
                  <EmptyActionState
                    anomaliesCount={0}
                    pulse={pulseQuery.data}
                    onManageLabels={() => setLabelModalOpen(true)}
                  />
                ) : null}
              </>
            ) : activeLane === "watching" ? (
              visibleWatchingRecs.length === 0 ? (
                <div className="lane-empty">
                  {rowSearchActive && filteredWatching.length > 0
                    ? `No watchlist items match “${rowSearch.trim()}”.`
                    : metaFiltersActive
                      ? "No watchlist items match the current filters."
                      : "No watchlist items in the latest snapshot."}
                </div>
              ) : (
                (() => {
                  // Segment the rendered watchlist rows by the server-owned
                  // rec.watchSegment. Header copy (label/description/cta) comes
                  // only from the watchingSegments[] payload; a segment the
                  // server did not describe still renders with just its header
                  // and count, never fabricated prose.
                  const copyByKey = new Map(
                    (laneQuery.data?.watchingSegments ?? []).map((segment) => [segment.key, segment]),
                  );
                  const grouped = new Map<MetaWatchingSegmentKey, MetaRecommendation[]>();
                  for (const rec of visibleWatchingRecs) {
                    const key = (rec.watchSegment ?? "other") as MetaWatchingSegmentKey;
                    grouped.set(key, [...(grouped.get(key) ?? []), rec]);
                  }
                  const orderedKeys = [
                    ...META_WATCHING_SEGMENT_ORDER.filter((key) => grouped.has(key)),
                    ...[...grouped.keys()].filter((key) => !META_WATCHING_SEGMENT_ORDER.includes(key)),
                  ];
                  return orderedKeys.map((key) => {
                    const recs = grouped.get(key) ?? [];
                    const copy = copyByKey.get(key) ?? null;
                    return (
                      <div key={key} data-meta-watching-segment={key}>
                        <MetaLaneGroupHeader
                          title={`SEGMENT · ${key.toUpperCase()} · ${recs.length}`}
                          note={copy?.label ?? undefined}
                        />
                        {copy?.description ? (
                          <p
                            className="lane-segment-explain"
                            style={{ margin: "2px 2px 8px", fontSize: 12, color: "var(--muted)" }}
                          >
                            {copy.description}
                          </p>
                        ) : null}
                        {copy?.ctaLabel ? (
                          key === "unlabeled" ? (
                            <button
                              type="button"
                              className="btn btn--ghost"
                              style={{ marginBottom: 8 }}
                              onClick={() => setLabelModalOpen(true)}
                            >
                              {copy.ctaLabel}
                            </button>
                          ) : copy.href ? (
                            <a
                              className="btn btn--ghost"
                              href={copy.href}
                              style={{ display: "inline-flex", marginBottom: 8 }}
                            >
                              {copy.ctaLabel}
                            </a>
                          ) : null
                        ) : null}
                        {recs.map((rec) => (
                          <MetaActionCard
                            key={rec.id}
                            moneyCurrency={moneyCurrency}
                            targetRoas={targetRoas}
                            rec={rec}
                            selected={selectedIds.has(rec.id)}
                            deferred={isDeferred(rec)}
                            responseState={responseStateForRec(rec)}
                            primaryPending={pendingActionRecId === rec.id}
                            actionFeedback={primaryActionFeedback?.recId === rec.id ? primaryActionFeedback : null}
                            readOnlyReason={viewerReadOnlyReason}
                            evidenceWindow={selectedWindow}
                            onSelect={selectRec}
                            onPrimary={handlePrimary}
                            onResume={requestResumeRecommendation}
                            onOpenDrill={(item) => openDrillForRec(item as MetaRecommendation)}
                            onDefer={deferRec}
                            onUndoDefer={undeferRec}
                            onCompare={compareRec}
                          />
                        ))}
                      </div>
                    );
                  });
                })()
              )
            ) : activeLane === "healthy" ? (
              healthyGroups.length > 0 ? (
                <MetaHealthyHierarchy groups={healthyGroups} moneyCurrency={moneyCurrency} />
              ) : (
                <div className="lane-empty">Healthy entities will appear after the latest snapshot has enough stable mature rows.</div>
              )
            ) : activeLane === "nonSales" ? (
              <>
                {visibleNonSalesRecs.map((rec) => (
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
                      targetRoas={targetRoas}
                      rec={rec}
                      selected={selectedIds.has(rec.id)}
                      deferred={isDeferred(rec)}
                      responseState={responseStateForRec(rec)}
                      primaryPending={pendingActionRecId === rec.id}
                      actionFeedback={primaryActionFeedback?.recId === rec.id ? primaryActionFeedback : null}
                      readOnlyReason={viewerReadOnlyReason}
                      evidenceWindow={selectedWindow}
                      onPrimary={handlePrimary}
                      onResume={requestResumeRecommendation}
                      onOpenDrill={(item) => openDrillForRec(item as MetaRecommendation)}
                      onDefer={deferRec}
                      onUndoDefer={undeferRec}
                      onCompare={compareRec}
                    />
                  )
                ))}
                {visibleNonSalesRecs.length === 0 ? (
                  <div className="lane-empty">
                    {rowSearchActive && filteredNonSales.length > 0
                      ? `No non-purchase entities match “${rowSearch.trim()}”.`
                      : metaFiltersActive
                        ? "No non-purchase entities match the current filters."
                        : "No non-purchase entities in the current window."}
                  </div>
                ) : null}
              </>
            ) : filteredArchive.length > 0 ? (
              <div className="overflow-x-auto rounded-[8px] border border-[var(--adc-b1)] bg-[var(--adc-s2)]" data-meta-archive>
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
                                  disabled={pending || isViewerReadOnly}
                                  title={isViewerReadOnly ? viewerReadOnlyReason ?? "Current viewer is read-only." : undefined}
                                  onClick={() => requestResumeArchivedEntity(row)}
                                >
                                  <Play className="inline-block shrink-0" size={12} aria-hidden="true" />
                                  {isViewerReadOnly ? "Review only" : pending ? "Working..." : row.level === "campaign" ? "Resume campaign" : "Resume adset"}
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
                  <button
                    type="button"
                    className="btn btn--danger"
                    data-testid="meta-bulk-pause"
                    disabled={isViewerReadOnly || bulkPausableRecs.length === 0}
                    title={
                      isViewerReadOnly
                        ? viewerReadOnlyReason ?? "Current viewer is read-only."
                        : bulkPausableRecs.length === 0
                          ? "No selected rows are pausable ad sets."
                          : undefined
                    }
                    onClick={() => setBulkPauseOpen(true)}
                  >
                    Pause selected
                  </button>
                  <button
                    type="button"
                    className="btn"
                    data-testid="meta-bulk-defer"
                    disabled={isViewerReadOnly}
                    title={isViewerReadOnly ? viewerReadOnlyReason ?? "Current viewer is read-only." : undefined}
                    onClick={() => void deferSelectedRecs()}
                  >
                    Defer selected 24h
                  </button>
                  <button type="button" className="btn btn--ghost" onClick={() => handleBulkAction("compare")}>Compare</button>
                  <button type="button" className="btn btn--ghost" disabled={isViewerReadOnly} title={isViewerReadOnly ? viewerReadOnlyReason ?? "Current viewer is read-only." : undefined} onClick={() => handleBulkAction("duplicate")}>Send to Launchpad</button>
                  <button type="button" className="btn btn--ghost" onClick={() => handleBulkAction("clear")}>×</button>
                </div>
              </div>
            ) : null}
          </div>
        )}
          </div>
        </div>
        {pushInspector && drillItem ? (
          <div
            className="meta-inspector-dock"
            style={{
              width: "min(480px, 40vw)",
              flex: "none",
              alignSelf: "flex-start",
              position: "sticky",
              top: 12,
              height: "calc(100vh - 120px)",
            }}
          >
            <MetaDrillDrawer
              moneyCurrency={moneyCurrency}
              targetRoas={targetRoas}
              item={drillItem}
              variant="push"
              onClose={closeDrill}
              onLaunch={
                !isViewerReadOnly && drillItem?.mode === "decision" && launchModeForRec(drillItem.rec)
                  ? () => openOverlayForRec(drillItem.rec, launchModeForRec(drillItem.rec)!)
                  : undefined
              }
            />
          </div>
        ) : null}
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

      {pendingPauseRec ? (
        <div
          className="modal-backdrop meta-label-modal-backdrop"
          data-testid="meta-pause-delta-modal"
          onMouseDown={() => setPendingPauseRec(null)}
        >
          <div
            className="meta-label-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="meta-pause-delta-title"
            style={{ maxWidth: 440 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="meta-label-modal-head">
              <div>
                <h2 id="meta-pause-delta-title">Pause {scopeNameForRec(pendingPauseRec)}?</h2>
                <p>Review the status change before this write reaches Meta.</p>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label="Cancel pause"
                onClick={() => setPendingPauseRec(null)}
              >
                ×
              </button>
            </div>
            <div className="meta-label-modal-body">
              <div
                data-testid="meta-pause-delta-grid"
                style={{ display: "grid", gridTemplateColumns: "1fr 1fr", gap: 10, marginBottom: 12 }}
              >
                <div style={{ border: "1px solid var(--border-2)", borderRadius: "var(--r-sm)", padding: "8px 10px" }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Current</div>
                  <div style={{ fontSize: 13 }}>Status ACTIVE</div>
                </div>
                <div style={{ border: "1px solid var(--border-2)", borderRadius: "var(--r-sm)", padding: "8px 10px" }}>
                  <div style={{ fontSize: 11, color: "var(--muted)", textTransform: "uppercase", letterSpacing: 0.4 }}>Proposed</div>
                  <div style={{ fontSize: 13 }}>Status PAUSED</div>
                </div>
              </div>
              <p style={{ fontSize: 12, color: "var(--muted)", margin: 0 }}>
                Confirming stops the ad set from delivering. It stays paused until a resume, which is a separate activation write.
              </p>
              {trackingBlocked ? (
                <p style={{ fontSize: 12, color: "var(--muted)", marginTop: 8 }}>
                  Tracking is currently flagged; purchase signal may be incomplete. This confirmation is the tracking gate — proceed only if the pause is warranted.
                </p>
              ) : null}
            </div>
            <div className="meta-label-modal-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 16px" }}>
              <button type="button" className="btn btn--ghost" onClick={() => setPendingPauseRec(null)}>
                Cancel
              </button>
              <button type="button" className="btn btn--danger" data-testid="meta-pause-delta-confirm" onClick={confirmPendingPause}>
                Confirm pause
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {bulkPauseOpen ? (
        <div
          className="modal-backdrop meta-label-modal-backdrop"
          data-testid="meta-bulk-pause-modal"
          onMouseDown={() => setBulkPauseOpen(false)}
        >
          <div
            className="meta-label-modal"
            role="dialog"
            aria-modal="true"
            aria-labelledby="meta-bulk-pause-title"
            style={{ maxWidth: 480 }}
            onMouseDown={(event) => event.stopPropagation()}
          >
            <div className="meta-label-modal-head">
              <div>
                <h2 id="meta-bulk-pause-title">Pause {bulkPausableRecs.length} ad {bulkPausableRecs.length === 1 ? "set" : "sets"}?</h2>
                <p>Each row is paused individually through the verified Meta pause path.</p>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label="Cancel bulk pause"
                onClick={() => setBulkPauseOpen(false)}
              >
                ×
              </button>
            </div>
            <div className="meta-label-modal-body">
              <ul style={{ listStyle: "none", margin: 0, padding: 0, display: "flex", flexDirection: "column", gap: 6 }}>
                {bulkPausableRecs.map((rec) => (
                  <li
                    key={rec.id}
                    style={{ display: "flex", justifyContent: "space-between", gap: 12, fontSize: 12.5, borderBottom: "1px solid var(--border-2)", paddingBottom: 6 }}
                  >
                    <span>{scopeNameForRec(rec)}</span>
                    <span style={{ fontVariantNumeric: "tabular-nums", color: "var(--muted)" }}>
                      {formatMoney(rec.metrics?.spend, moneyCurrency)}
                    </span>
                  </li>
                ))}
              </ul>
              <p style={{ fontSize: 11.5, color: "var(--muted)", marginTop: 10 }}>
                Money shown is each entity&rsquo;s own window spend. Totals are not summed — mixed-currency accounts cannot be added together.
              </p>
            </div>
            <div className="meta-label-modal-foot" style={{ display: "flex", justifyContent: "flex-end", gap: 8, padding: "12px 16px" }}>
              <button type="button" className="btn btn--ghost" onClick={() => setBulkPauseOpen(false)}>
                Cancel
              </button>
              <button
                type="button"
                className="btn btn--danger"
                data-testid="meta-bulk-pause-confirm"
                disabled={bulkPausableRecs.length === 0}
                onClick={() => void confirmBulkPause()}
              >
                Pause {bulkPausableRecs.length} ad {bulkPausableRecs.length === 1 ? "set" : "sets"}
              </button>
            </div>
          </div>
        </div>
      ) : null}

      {pushInspector ? null : (
        <MetaDrillDrawer
          moneyCurrency={moneyCurrency}
          targetRoas={targetRoas}
          item={drillItem}
          variant="overlay"
          onClose={closeDrill}
          onLaunch={
            !isViewerReadOnly && drillItem?.mode === "decision" && launchModeForRec(drillItem.rec)
              ? () => openOverlayForRec(drillItem.rec, launchModeForRec(drillItem.rec)!)
              : undefined
          }
        />
      )}

      <MetaLaunchpadOverlay
        open={overlay.open}
        mode={overlay.mode}
        item={{
          id: overlay.rec ? scopeIdForRec(overlay.rec) : "meta",
          name: overlay.rec ? scopeNameForRec(overlay.rec) : "Meta action",
          campaign: overlay.rec?.campaignName,
          proposedBidCap: overlay.rec ? (proposedBidDisplayValue(overlay.rec) ?? undefined) : undefined,
          currencyCode: moneyCurrency ?? undefined,
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
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--adc-danger-fg)] bg-[var(--adc-danger-fg)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--adc-s2)] hover:brightness-95"
              disabled={isViewerReadOnly}
              title={isViewerReadOnly ? viewerReadOnlyReason ?? "Current viewer is read-only." : undefined}
              onClick={() => void handleCompareDrawerAction("pause_weakest")}
            >
              <AlertTriangle className="inline-block shrink-0" size={13} aria-hidden="true" /> Pause weakest
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--adc-pos-fg)] bg-[var(--adc-pos-fg)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--adc-s2)] hover:brightness-95"
              disabled={isViewerReadOnly}
              title={isViewerReadOnly ? viewerReadOnlyReason ?? "Current viewer is read-only." : undefined}
              onClick={() => void handleCompareDrawerAction("scale_strongest")}
            >
              <TrendingUp className="inline-block shrink-0" size={13} aria-hidden="true" /> Scale strongest
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--adc-info-bd)] bg-[var(--adc-s2)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--adc-info-fg)] hover:bg-[var(--adc-info-bg)]"
              disabled={isViewerReadOnly}
              title={isViewerReadOnly ? viewerReadOnlyReason ?? "Current viewer is read-only." : undefined}
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
