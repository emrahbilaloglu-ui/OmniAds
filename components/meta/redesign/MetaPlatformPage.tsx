"use client";

import { useEffect, useMemo, useRef, useState, type ReactNode } from "react";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import {
  AlertTriangle,
  ArrowRight,
  ChevronDown,
  History,
  ImageOff,
  PanelLeft,
  Plus,
  RefreshCw,
  Rocket,
  TrendingUp,
  X,
} from "lucide-react";
import {
  CompareDrawer,
  TrackingConfirmModal,
  useDeferState,
  type CompareDrawerItem,
} from "@/components/common/briefing";
import {
  DateRangePicker,
  dateWindowToRangeValue,
  getTodayIsoForTimeZone,
  normalizeDateWindowBounds,
  rangeValueToDateWindow,
  type DateWindowValue,
} from "@/components/date-range/DateRangePicker";
import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import type {
  MetaCanonicalDecision,
  MetaDecisionQueueSection,
} from "@/lib/meta/decisions-workspace-contract";
import {
  describeDecisionWorkspaceFailure,
  MetaRequestFailure,
} from "@/lib/meta/workspace-failure";
import type {
  MetaOsAdDecision,
  MetaOsDecisionsPresentation,
} from "@/lib/meta/decisions-os-contract";
import { metaDecisionSourceFallbackDetail } from "@/lib/meta/decision-source-health";
import { dashboardHrefForRouteFamily } from "@/lib/dashboard-v2/screen-registry";
import { cn } from "@/lib/utils";
import { MetaCampaignLabelsSection } from "@/components/meta/redesign/MetaCampaignLabelsSection";
import { MetaLaunchpadOverlay } from "@/components/meta/redesign/MetaLaunchpadOverlay";
import {
  MetaDecisionCenterExact,
  type MetaDecisionCenterExactLane,
  type MetaDecisionCenterExactViewModel,
  type MetaDecisionCenterExactWindow,
} from "@/components/meta/decision-center/MetaDecisionCenterExact";
import { buildMetaDecisionCenterExactViewModel } from "@/components/meta/decision-center/meta-decision-center-exact-adapter";
import { CreativeEvidenceWindowExact } from "@/components/creatives/CreativeEvidenceWindowExact";
import {
  buildCreativeEvidenceWindowExactViewModel,
  buildMetaAdsManagerHref,
  type CreativeEvidenceWindowExactAdRow,
  type CreativeEvidenceWindowExactSeriesPayload,
} from "@/components/creatives/creative-evidence-window-exact-adapter";
import type { MetaCreativeApiRow } from "@/lib/meta/creatives-types";
import styles from "./MetaPlatformPage.module.css";
import {
  decisionLabelForRec,
  launchModeForRec,
  proposedBidDisplayValue,
  scopeIdForRec,
  scopeNameForRec,
  structuredMetricsForRec,
  formatMoney,
} from "@/components/meta/redesign/meta-card-utils";
import { formatCurrency, formatRoas } from "@/lib/briefing/utils";
import { useTierZeroFreshness } from "@/components/states/useTierZeroFreshness";
import { measuredAsOf } from "@/lib/tier-zero-as-of";
import { fetchMetaHistoryAccounts } from "@/lib/meta/history-client";
import type { MetaHistoryAccount } from "@/lib/meta/history-contract";
import type { BriefingStatusFilter } from "@/lib/meta/briefing-filter";
import type {
  MetaArchivedEntity,
  MetaDecisionsWorkspacePayload,
  MetaDecisionsWorkspaceBanner as MetaWorkspaceBanner,
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
export const META_MONITOR_PAGE_SIZE = 48;

export function resolveMetaDecisionMoneyCurrency(
  decisionCurrency: string | null | undefined,
  providerCurrency: string | null | undefined,
): string | null {
  const normalizedDecisionCurrency = decisionCurrency?.trim();
  if (normalizedDecisionCurrency) return normalizedDecisionCurrency;

  const normalizedProviderCurrency = providerCurrency?.trim();
  return normalizedProviderCurrency || null;
}

type MetaSnapshotRunStatus = "ran" | "cooldown" | "already_running";

export function interpretMetaSnapshotRunResponse(
  responseOk: boolean,
  payload: unknown,
):
  | { ok: true; status: MetaSnapshotRunStatus }
  | { ok: false; message: string } {
  const record =
    payload && typeof payload === "object"
      ? (payload as Record<string, unknown>)
      : null;
  const status = record?.status;
  const validStatus =
    status === "ran" || status === "cooldown" || status === "already_running";
  if (responseOk && record?.ok === true && validStatus) {
    return { ok: true, status };
  }
  const message =
    typeof record?.message === "string" && record.message.trim()
      ? record.message
      : responseOk
        ? "Snapshot refresh returned an invalid response."
        : "Snapshot refresh failed.";
  return { ok: false, message };
}

export function paginateMetaMonitorRows<T>(rows: T[], page: number): T[] {
  const safePage = Math.max(1, Math.trunc(page) || 1);
  const start = (safePage - 1) * META_MONITOR_PAGE_SIZE;
  return rows.slice(start, start + META_MONITOR_PAGE_SIZE);
}

type LocalResponseState = "acted" | "deferred" | "ignored";
type PrimaryActionFeedback = {
  recId: string;
  tone: "success" | "error" | "info";
  title: string;
  detail?: string | null;
};
type MetaLaneView = "action" | "watching" | "healthy" | "nonSales" | "archive";
type MetaLevelFilter = "campaign" | "adset";

interface MetaScopeAdset {
  id: string;
  name: string;
  label: string | null;
}

interface MetaScopeCampaign {
  id: string;
  name: string;
  actionCount: number;
  watchingCount: number;
  adsets: MetaScopeAdset[];
}

// Client-only queue-local filter: hide rows whose server-supplied spend is
// below this window threshold. Rows with a null spend stay HIDDEN when the
// toggle is on - they are never coerced to 0 (honesty law).
const META_MIN_SPEND_THRESHOLD = 50;

function passesMetaMinSpend(
  rec: MetaRecommendation,
  enabled: boolean,
): boolean {
  if (!enabled) return true;
  const spend = rec.metrics?.spend;
  return (
    typeof spend === "number" &&
    Number.isFinite(spend) &&
    spend >= META_MIN_SPEND_THRESHOLD
  );
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

function parseMetaLaneView(value: string | null): MetaLaneView {
  if (
    value === "watching" ||
    value === "healthy" ||
    value === "nonSales" ||
    value === "archive"
  )
    return value;
  return "action";
}

function parseMetaWorkspaceLane(params: {
  get(name: string): string | null;
}): MetaLaneView {
  const legacyLane = params.get("lane");
  if (legacyLane) return parseMetaLaneView(legacyLane);
  if (params.get("area") !== "monitor") return "action";
  const segment = params.get("segment");
  if (segment === "healthy") return "healthy";
  if (segment === "out_of_scope") return "nonSales";
  if (segment === "structures") return "archive";
  return "watching";
}

function parseMetaWindow(value: string | null): MetaWindowKey {
  if (
    value === "7d" ||
    value === "14d" ||
    value === "28d" ||
    value === "90d" ||
    value === "custom"
  )
    return value;
  return "28d";
}

function exactLaneForMetaLane(lane: MetaLaneView): MetaDecisionCenterExactLane {
  return lane === "nonSales" ? "nonsales" : lane;
}

function metaLaneForExactLane(lane: MetaDecisionCenterExactLane): MetaLaneView {
  return lane === "nonsales" ? "nonSales" : lane;
}

function exactWindowForMetaWindow(
  window: MetaWindowKey,
): MetaDecisionCenterExactWindow | null {
  return window === "custom" ? null : window;
}

function metaOsCreativeSearchMatch(
  decision: MetaOsAdDecision,
  query: string,
): boolean {
  const normalized = query.trim().toLowerCase();
  if (!normalized) return true;
  return [
    decision.adName,
    decision.creativeName,
    decision.campaignName,
    decision.adsetName,
    decision.action.label,
    decision.publishedLabel,
  ].some((value) => value?.toLowerCase().includes(normalized));
}

function metaDateRangeFromParams(
  params: URLSearchParams,
  referenceDate?: string,
): DateWindowValue {
  const selected = parseMetaWindow(params.get("window"));
  if (selected === "custom") {
    const start = params.get("startDate") ?? "";
    const end = params.get("endDate") ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return normalizeDateWindowBounds(
        { window: "custom", start, end },
        { maxDate: referenceDate },
      );
    }
  }
  return rangeValueToDateWindow(
    dateWindowToRangeValue({ window: selected, start: "", end: "" }),
    referenceDate,
    { includeCurrentDay: true },
  );
}

function recMatchesMetaFilters(
  rec: MetaRecommendation,
  input: {
    level: MetaLevelFilter;
    campaignId: string;
    adsetId: string;
  },
) {
  if (input.level === "adset" && rec.level !== "adset") return false;
  if (input.campaignId !== "all" && rec.campaignId !== input.campaignId)
    return false;
  if (input.adsetId !== "all" && rec.adsetId !== input.adsetId) return false;
  return true;
}

export function campaignKindMatchesMetaLabelFilter(
  campaignKind: string | null | undefined,
  label: "all" | "main" | "test" | "mixed",
) {
  if (label === "all") return true;
  const normalized = String(campaignKind ?? "").toLowerCase();
  return normalized === label;
}

function healthyMatchesMetaFilters(
  row: MetaHealthyEntity,
  input: {
    level: MetaLevelFilter;
    campaignId: string;
    adsetId: string;
  },
) {
  if (input.level === "adset" && row.level !== "adset") return false;
  if (input.campaignId !== "all") {
    const rowCampaignId = row.level === "campaign" ? row.id : row.campaignId;
    if (rowCampaignId !== input.campaignId) return false;
  }
  if (
    input.adsetId !== "all" &&
    (row.level !== "adset" || row.id !== input.adsetId)
  )
    return false;
  return true;
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
    const serverMessage =
      payload && typeof payload === "object" && "message" in payload
        ? String((payload as { message?: unknown }).message)
        : null;
    throw new MetaRequestFailure({
      message: serverMessage ?? `Request failed (${response.status})`,
      status: response.status,
      hasServerReason: Boolean(serverMessage && serverMessage.trim()),
    });
  }
  return payload as T;
}

function fetchDecisionsWorkspace(
  businessId: string,
  providerAccountId: string,
  window: MetaWindowKey,
  statusFilter: BriefingStatusFilter,
  range?: Pick<DateWindowValue, "start" | "end">,
) {
  const params = new URLSearchParams({
    businessId,
    providerAccountId,
    window,
    status_filter: statusFilter,
  });
  if (window === "custom" && range) {
    params.set("startDate", range.start);
    params.set("endDate", range.end);
  }
  return readJson<MetaDecisionsWorkspacePayload>(
    `/api/meta/decisions-workspace?${params.toString()}`,
  );
}

function fetchAnomalies(
  businessId: string,
  providerAccountId: string,
  window: MetaWindowKey,
  statusFilter: BriefingStatusFilter,
  range?: Pick<DateWindowValue, "start" | "end">,
) {
  const params = new URLSearchParams({
    businessId,
    providerAccountId,
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
  const normalized =
    typeof status === "string" ? status.trim().toUpperCase() : "";
  if (!normalized || normalized === "PAUSED") return "Ad set paused in Meta.";
  return `Ad set pause verified with status ${normalized}.`;
}

function actionPayloadRecord(payload: unknown): Record<string, unknown> | null {
  return payload && typeof payload === "object" && !Array.isArray(payload)
    ? (payload as Record<string, unknown>)
    : null;
}

export function metaActionFailureMessage(
  payload: unknown,
  fallbackMessage: string,
) {
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

export function metaBidApplyNotice(
  payload: unknown,
  currency?: string | null,
) {
  const record = actionPayloadRecord(payload);
  const dryRun = record?.dryRun === true;
  const bidAmountMinor =
    typeof record?.bidAmountMinor === "number" &&
    Number.isFinite(record.bidAmountMinor)
      ? record.bidAmountMinor
      : null;
  if (dryRun) {
    return {
      tone: "info" as const,
      title: bidAmountMinor
        ? `Dry run: bid cap would apply at ${formatCurrency(
            bidAmountMinor / 100,
            currency,
          )}.`
        : "Dry run completed.",
      detail: "No Meta write was performed; Meta verification completed.",
    };
  }
  return {
    tone: "success" as const,
    title: bidAmountMinor
      ? `Bid cap applied at ${formatCurrency(
          bidAmountMinor / 100,
          currency,
        )}.`
      : "Bid cap applied.",
    detail: "Meta verified the ad set bid.",
  };
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
      typeof peerValue === "number" ? peerValue : (metrics?.roas ?? undefined),
    cpa: metrics?.cpa ?? undefined,
    ctr: metrics?.ctr ?? undefined,
    purchases: metrics?.purchases ?? undefined,
    frequency: metrics?.frequency ?? undefined,
    sparkline: Array.isArray(trail?.roas_history)
      ? trail.roas_history.map(Number)
      : undefined,
  };
}

export type MetaRowSort = "money" | "priority" | "age";

/** Free-text row search over entity/label truth. Empty query keeps every row. */
export function metaRecSearchMatch(
  rec: MetaRecommendation,
  query: string,
): boolean {
  const q = query.trim().toLowerCase();
  if (!q) return true;
  return [
    scopeNameForRec(rec),
    rec.campaignName ?? "",
    rec.adsetName ?? "",
    rec.decisionLabel ?? "",
    rec.title ?? "",
  ]
    .join(" ")
    .toLowerCase()
    .includes(q);
}

const META_PRIORITY_RANK: Record<string, number> = {
  high: 0,
  medium: 1,
  low: 2,
};

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
export function sortMetaRecs(
  recs: MetaRecommendation[],
  sort: MetaRowSort,
): MetaRecommendation[] {
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
  pulse:
    | Pick<MetaPulsePayload, "trackingAnomalyActive" | "trackingHealth">
    | null
    | undefined,
): boolean {
  return Boolean(
    pulse?.trackingAnomalyActive ??
    (pulse?.trackingHealth.status === "blocked" ||
      pulse?.trackingHealth.status === "degraded"),
  );
}

function percentDelta(
  current: number | null | undefined,
  previous: number | null | undefined,
) {
  if (
    current == null ||
    previous == null ||
    !Number.isFinite(current) ||
    !Number.isFinite(previous) ||
    previous <= 0
  ) {
    return null;
  }
  return ((current - previous) / previous) * 100;
}

function trackingClass(
  status: MetaPulsePayload["trackingHealth"]["status"] | undefined,
) {
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

function mobileTimestamp(value: string | null | undefined) {
  if (!value) return "—";
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) return "—";
  return `${date.toISOString().slice(11, 16)} UTC`;
}

function mobileDecisionTone(
  rec: MetaRecommendation,
): "danger" | "positive" | "caution" {
  const label = decisionLabelForRec(rec);
  if (label === "cut" || label === "below_breakeven" || label === "fatigue")
    return "danger";
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
    parts.length > 0
      ? parts.join(" · ")
      : rec.expectedImpact || rec.summary || "server summary —"
  }`;
}

function MobileDecisionConfidence({
  confidence,
}: {
  confidence: MetaRecommendation["confidence"];
}) {
  const label =
    confidence === "high" ? "High" : confidence === "medium" ? "Medium" : "Low";
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

function MetaMobileCitationList({
  items,
}: {
  items: Array<{ label: string; value: string }>;
}) {
  if (items.length === 0) return null;
  return (
    <div className="ad-mobile-citation-list">
      {items.map((item, index) => (
        <div key={`${item.label}-${index}`}>
          <span className="ad-mobile-cite">[{index + 1}]</span>
          <span>
            {item.label}: {item.value}
          </span>
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
    const citationItems = item.anomaly.diagnostics
      .slice(0, 2)
      .map((diagnostic, index) => ({
        label: `Diagnostic ${index + 1}`,
        value: diagnostic,
      }));
    return (
      <section
        className="meta-mobile-decision-stage"
        data-testid="meta-mobile-evidence"
      >
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
              <p>
                {titleCaseCompact(item.anomaly.scopeType)} · anomaly · detected{" "}
                {mobileTimestamp(item.anomaly.detectedAt)}
              </p>
            </div>
            <article className="ad-mobile-heat">
              <strong>{item.anomaly.title}</strong>
              <span>{item.anomaly.detail}</span>
            </article>
            <p className="ad-mobile-copy">
              {item.anomaly.diagnostics[0] ??
                "The anomaly remains open in the server scan"}
              {citationItems[0] ? (
                <>
                  {" "}
                  <span className="ad-mobile-cite">[1]</span>
                </>
              ) : null}
              . Mobile keeps this as evidence review only.
            </p>
            <MetaMobileCitationList items={citationItems} />
            <div className="ad-mobile-desktop-note">
              Act on desktop — this device is read-only by design.
            </div>
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
    <section
      className="meta-mobile-decision-stage"
      data-testid="meta-mobile-evidence"
    >
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
            <p>
              {titleCaseCompact(rec.level)} ·{" "}
              {rec.rowPresentation?.accountBadge ?? "account —"}
            </p>
          </div>
          <article className="ad-mobile-heat">
            <strong>
              {mobileDecisionLine(rec, targetRoas, moneyCurrency)}
            </strong>
            <span>
              {spendText} · {roasText}
            </span>
          </article>
          <p className="ad-mobile-copy">
            {rec.why ||
              rec.summary ||
              "Decision reasoning is unavailable in this payload"}
            {citationItems[0] ? (
              <>
                {" "}
                <span className="ad-mobile-cite">[1]</span>
              </>
            ) : null}
            ; confidence is {rec.confidence}
            {citationItems[1] ? (
              <>
                {" "}
                <span className="ad-mobile-cite">[2]</span>
              </>
            ) : null}
            .
          </p>
          <MetaMobileCitationList items={citationItems} />
          <div className="ad-mobile-desktop-note">
            Act on desktop — this device is read-only by design.
          </div>
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
        <p data-tone={mobileDecisionTone(rec)}>
          {mobileDecisionLine(rec, targetRoas, moneyCurrency)}
        </p>
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
  const actCount =
    loading || error ? "—" : actionRows.length + anomalies.length;
  const primaryRows = [...actionRows, ...watchingRows].slice(0, 2);
  return (
    <section
      className="meta-mobile-decision-stage"
      data-testid="meta-mobile-decisions"
    >
      <div className="ad-mobile-device">
        <div className="ad-mobile-screen">
          <div className="ad-mobile-status">
            <span>--:--</span>
            <span>
              {businessName ?? "Meta"} · Act now {actCount}
            </span>
          </div>
          <div className="ad-mobile-freshness">
            synced {mobileTimestamp(pulse?.lastSyncAt ?? null)} · snapshot{" "}
            {laneSnapshotDate ?? "—"}
          </div>
          {loading ? (
            <article className="ad-mobile-row-card">
              <h3>Decision queue</h3>
              <p>loading server snapshot —</p>
            </article>
          ) : error ? (
            <article className="ad-mobile-anomaly">
              <b>Decision queue unavailable.</b>
              <div>
                {error.message ||
                  "Missing data is withheld, never shown as zero."}
              </div>
            </article>
          ) : anomalies[0] ? (
            <button
              type="button"
              className="ad-mobile-anomaly ad-mobile-anomaly-button"
              onClick={() => onOpenAnomaly(anomalies[0]!)}
            >
              <b>Anomaly:</b> {anomalies[0].title}
              <div>
                detected {mobileTimestamp(anomalies[0].detectedAt)} · read
                evidence on mobile, act on desktop
              </div>
            </button>
          ) : (
            <article className="ad-mobile-anomaly">
              <b>No active anomaly.</b>
              <div>
                Rows still open evidence on mobile; execution stays
                desktop-only.
              </div>
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
            Writes are desktop-only — rows here open evidence, never a pause
            button. Hit targets ≥44px.
          </div>
        </div>
      </div>
    </section>
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
  laneAsOf?: {
    snapshotDate: string | null;
    snapshotCreatedAt?: string | null;
  } | null;
  loading?: boolean;
  error?: Error | null;
}) {
  if (loading || error) {
    const unavailable = Boolean(error);
    const status = unavailable ? "Unavailable" : "Loading";
    const detail = unavailable
      ? (error?.message ?? "Meta briefing failed.")
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
  const dailySpend =
    pulse?.pacing.spendToday ??
    (pulse?.pacing.dayPace != null && pulse?.pacing.dailyTarget != null
      ? pulse.pacing.dayPace * pulse.pacing.dailyTarget
      : null);
  const avg7dSpend = pulse?.pacing.avg7dSpend ?? null;
  const spendVs7dAvg = formatSignedPercent(
    percentDelta(dailySpend, avg7dSpend),
  );
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
        {endIsToday
          ? "Spend · today"
          : `Spend · ${pulse?.endDate ?? "last day"}`}{" "}
        <b>
          {dailySpend == null ? "—" : formatMoney(dailySpend, moneyCurrency)}
        </b>
        {" vs 7d avg "}
        {avg7dSpend == null
          ? "—"
          : `${formatMoney(avg7dSpend, moneyCurrency)}/day`}
        {spendVs7dAvg ? ` · ${spendVs7dAvg}` : ""}
      </span>
      <span>
        ROAS · {window === "90d" ? "28d" : window}{" "}
        <b>{formatRoas(roasValue)}</b>
        {" vs target "}
        {pulse?.roas.target == null ? "—" : formatRoas(pulse.roas.target)}
      </span>
      <span
        className={cn("chip", trackingClass(pulse?.trackingHealth?.status))}
      >
        <span className="dot" />
        {pulse?.trackingHealth?.status ?? "unknown"}
      </span>
      <span>
        {pulse?.campaignContextMode === "automatic"
          ? "automatic context"
          : pulse?.campaignContextMode === "legacy_labels"
            ? "legacy context"
            : "context withheld"}
        {pulse?.labelCoverage
          ? ` · ${pulse.labelCoverage.labeledCampaigns} overrides`
          : ""}
        {" · "}
        <button
          type="button"
          className="linklike"
          aria-label="Review campaign context exceptions"
          onClick={onManageLabels}
        >
          Review exceptions
        </button>
      </span>
      <span data-target-freshness={pulse?.roas.targetFreshness ?? "unknown"}>
        {pulse?.roas.target_source === "commercial_truth_stale" ? (
          pulse.roas.targetFreshness === "stale" ? (
            <>
              Target review due - authority unchanged ·{" "}
              <a href="/commercial-truth">Review target pack</a>
            </>
          ) : (
            <>
              Target timestamp unavailable - Scale/Cut authority withheld ·{" "}
              <a href="/commercial-truth">Review target pack</a>
            </>
          )
        ) : (
          "tones from this business's server targets"
        )}
      </span>
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
  const anomalyText = digest
    ? `${countPhrase(digest.anomalies.openedCount, "anomaly")} opened`
    : `anomalies ${anomaliesCount}`;
  const deferralText = digest
    ? `${countPhrase(digest.deferrals.dueCount, "deferral")} due back`
    : `deferrals due ${deferredCount}`;
  return (
    <div className="meta-digest" data-testid="meta-overnight-digest">
      <button
        type="button"
        className="meta-digest__toggle"
        aria-expanded={open}
        aria-controls="meta-digest-details"
        onClick={() => setOpen((value) => !value)}
      >
        <ChevronDown
          className={cn("meta-digest__chevron", open && "open")}
          size={13}
          aria-hidden="true"
        />
        <span className="meta-digest__title">Since last snapshot</span>
        <b>{snapshotDate ?? "snapshot —"}</b>
        <span className="meta-digest__summary">
          {labelFlipText} · {actionText} · {anomalyText} · {deferralText}
        </span>
      </button>
      {open ? (
        <div id="meta-digest-details" className="meta-digest__details">
          {digest?.unavailableReason ? (
            <div className="meta-digest__line muted">
              Digest details unavailable: {digest.unavailableReason}
            </div>
          ) : null}
          <div className="meta-digest__line">
            <span>Label flips:</span>{" "}
            {digest && digest.labelFlips.items.length > 0
              ? digest.labelFlips.items.slice(0, 3).map((item, index) => (
                  <span key={item.id} className="meta-digest__item">
                    {index > 0 ? "; " : null}
                    <b>{item.title}</b> {item.previousLabel} -&gt;{" "}
                    {item.currentLabel} <em>{item.status}</em>
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
                    <em
                      className={
                        item.status === "silent_failure" ? "danger" : "success"
                      }
                    >
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
                    {formatDigestTime(item.occurredAt)
                      ? ` ${formatDigestTime(item.occurredAt)}`
                      : ""}
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
                    {formatDigestTime(item.dueAt)
                      ? ` (${formatDigestTime(item.dueAt)})`
                      : ""}
                    {item.detail ? ` · ${item.detail}` : ""}
                  </span>
                ))
              : `${deferredCount} deferred rows in local state`}
          </div>
          {missing > 0 ? (
            <div className="meta-digest__line muted">
              Missing action kind: {missing}
            </div>
          ) : null}
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

// Bounded triage-board helpers. These render only server-structured evidence;
// unavailable preview, hierarchy, and metric fields remain explicit.

function humanizeDecisionToken(value: string | null | undefined) {
  if (!value) return "Unavailable";
  return value
    .replaceAll("_", " ")
    .replace(/\b\w/g, (letter) => letter.toUpperCase());
}

function canonicalCreativeSearchMatch(
  decision: MetaCanonicalDecision,
  search: string,
) {
  const query = search.trim().toLowerCase();
  if (!query) return true;
  return [
    decision.parentChain.ad?.name,
    decision.parentChain.ad?.id,
    decision.parentChain.creative?.name,
    decision.parentChain.creative?.id,
    decision.parentChain.campaign?.name,
    decision.parentChain.campaign?.id,
    decision.parentChain.adset?.name,
    decision.classification.buyerLabel,
    decision.sourceDecision.reason,
  ]
    .filter((value): value is string => Boolean(value))
    .some((value) => value.toLowerCase().includes(query));
}

function MetaCreativeDecisionCard({
  decision,
  onOpen,
}: {
  decision: MetaCanonicalDecision;
  onOpen: () => void;
}) {
  const previewUrl = decision.media.thumbnail.url;
  const adName =
    decision.parentChain.ad?.name ??
    decision.parentChain.ad?.id ??
    decision.parentChain.creative?.name ??
    decision.parentChain.creative?.id ??
    "Ad identity unavailable";
  const creativeName =
    decision.parentChain.creative?.name ??
    decision.parentChain.creative?.id ??
    null;
  const action = decision.classification.executionAction
    ? `${decision.classification.buyerLabel} · ${humanizeDecisionToken(decision.classification.executionAction)}`
    : decision.classification.buyerLabel;

  return (
    <button
      type="button"
      className={cn(
        styles.creativeCard,
        previewUrl && styles.creativeCardWithPreview,
      )}
      data-testid="meta-creative-call"
      data-ad-id={decision.parentChain.ad?.id ?? undefined}
      data-creative-id={decision.parentChain.creative?.id ?? undefined}
      data-decision-id={decision.decisionId}
      data-preview-state={previewUrl ? "ready" : "missing"}
      onClick={onOpen}
      aria-label={`Open ad evidence for ${adName}`}
    >
      <span className={styles.creativeMedia}>
        {previewUrl ? (
          // The server-projected media envelope owns this URL; no client
          // preview fallback is invented.
          <img src={previewUrl} alt="" />
        ) : (
          <>
            <ImageOff size={16} aria-hidden="true" />
            <small>Preview unavailable</small>
          </>
        )}
      </span>
      <span className={styles.creativeBody}>
        <span className={styles.creativeTopline}>
          <span className="chip chip--info">{action}</span>
          <span className={styles.microChip}>
            {humanizeDecisionToken(decision.classification.lifecycleRole.value)}
          </span>
          <span className={styles.microChip}>
            {decision.sourceDecision.confidenceBand} confidence
          </span>
        </span>
        <strong title={adName}>{adName}</strong>
        <small>
          {decision.parentChain.campaign?.name ?? "Campaign unavailable"} ·{" "}
          {humanizeDecisionToken(decision.classification.assessment.value)}
        </small>
        {creativeName ? (
          <small>Creative group · {creativeName}</small>
        ) : (
          <small>Creative grouping unavailable</small>
        )}
        <span className={styles.creativeReason}>
          {decision.sourceDecision.reason ||
            "Creative engine evidence is available."}
        </span>
      </span>
      <span className={styles.creativeMetrics}>
        <span>
          <small>Spend</small>
          <b>
            {formatMoney(decision.metrics.spend, decision.metrics.currency)}
          </b>
        </span>
        <span>
          <small>ROAS</small>
          <b>
            {decision.metrics.roas == null
              ? "—"
              : formatRoas(decision.metrics.roas)}
          </b>
        </span>
        <span>
          <small>Purchases</small>
          <b>{decision.metrics.purchases ?? "—"}</b>
        </span>
      </span>
      <span className={styles.creativeOpen}>
        Evidence <ArrowRight size={12} aria-hidden="true" />
      </span>
    </button>
  );
}

/**
 * The decisions-workspace contract stops at spend / purchases / ROAS. The
 * funnel, thumbstop, first-seen date and per-ad-set split the evidence window
 * draws are ad-grain facts served by `/api/meta/creatives`, which keeps its
 * own `requireBusinessAccess` gate. Reading them here adds no new authority.
 */
async function fetchCreativeEvidenceAdRows(input: {
  businessId: string;
  providerAccountId: string;
  creativeId: string;
  start: string;
  end: string;
}): Promise<CreativeEvidenceWindowExactAdRow[]> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    creativeId: input.creativeId,
    groupBy: "ad",
    mediaMode: "metadata",
    start: input.start,
    end: input.end,
  });
  const response = await fetch(`/api/meta/creatives?${query.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("Ad-grain creative evidence is unavailable.");
  }
  const payload: unknown = await response.json();
  const rows: MetaCreativeApiRow[] =
    payload && typeof payload === "object" && Array.isArray((payload as { rows?: unknown }).rows)
      ? ((payload as { rows: MetaCreativeApiRow[] }).rows ?? [])
      : [];
  return rows
    .filter((row) => row.creative_id === input.creativeId)
    .map((row) => ({
      id: row.id,
      adsetId: row.adset_id ?? null,
      adsetName: row.adset_name ?? null,
      spend: numberOrNull(row.spend),
      purchaseValue: numberOrNull(row.purchase_value),
      roas: numberOrNull(row.roas),
      impressions: numberOrNull(row.impressions),
      linkClicks: numberOrNull(row.link_clicks),
      addToCart: numberOrNull(row.add_to_cart),
      purchases: numberOrNull(row.purchases),
      thumbstop: numberOrNull(row.thumbstop),
      launchDate: row.launch_date ?? null,
    }));
}

/**
 * The daily CTR / frequency trail behind the two sparkline cards.
 *
 * `meta_ad_daily` has stored date + ad_id + link_clicks + frequency all along —
 * indexed on (ad_id, date DESC) — but nothing read it as a series, so both
 * cards drew an empty path. `/api/meta/ads/series` is that read path and keeps
 * its own `requireBusinessAccess` gate.
 */
async function fetchCreativeEvidenceAdSeries(input: {
  businessId: string;
  adIds: string[];
  start: string;
  end: string;
}): Promise<CreativeEvidenceWindowExactSeriesPayload> {
  const query = new URLSearchParams({
    businessId: input.businessId,
    adIds: input.adIds.join(","),
    start: input.start,
    end: input.end,
  });
  const response = await fetch(`/api/meta/ads/series?${query.toString()}`, {
    cache: "no-store",
  });
  if (!response.ok) {
    throw new Error("The per-ad daily series is unavailable.");
  }
  const payload = (await response.json()) as Partial<CreativeEvidenceWindowExactSeriesPayload>;
  return {
    adCount: typeof payload.adCount === "number" ? payload.adCount : 0,
    points: Array.isArray(payload.points) ? payload.points : [],
  };
}

function numberOrNull(value: number | null | undefined): number | null {
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

/**
 * The evidence window's primary carries the server decision's own caption. It
 * only gets a destination when that decision routes to a draft; execute-intent
 * decisions keep their confirmation ceremony on the decision row and are not
 * given a second, unguarded trigger here.
 */
function creativeEvidenceLaunchpadHref(input: {
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision;
  pathname: string | null;
}): string | null {
  const code = input.decision?.action.code ?? null;
  const mode =
    code === "plan_promotion"
      ? "duplicate"
      : code === "refresh_creative"
        ? "rebuild"
        : null;
  const creativeId = input.canonical.parentChain.creative?.id?.trim() || null;
  if (!mode || !creativeId) return null;
  const params = new URLSearchParams({
    fromMetaBriefing: "true",
    providerAccountId: input.canonical.providerAccountId,
    sourceDecisionId: input.canonical.decisionId,
    sourceDecisionSnapshotId: input.canonical.sourceSnapshotId,
    creativeIds: creativeId,
    mode,
  });
  return dashboardHrefForRouteFamily(
    `/platforms/meta/launchpad?${params.toString()}`,
    input.pathname ?? "",
  );
}

function creativeEvidenceStudioHref(input: {
  canonical: MetaCanonicalDecision;
  pathname: string | null;
}): string {
  const params = new URLSearchParams({
    providerAccountId: input.canonical.providerAccountId,
  });
  const creativeId = input.canonical.parentChain.creative?.id?.trim() || null;
  if (creativeId) params.set("creativeId", creativeId);
  return dashboardHrefForRouteFamily(
    `/platforms/meta/creatives?${params.toString()}`,
    input.pathname ?? "",
  );
}

function MetaLaneSectionHeader({
  title,
  note,
  count,
}: {
  title: string;
  note?: ReactNode;
  count?: number | string;
}) {
  return (
    <div
      className={styles.sectionHeader}
      data-testid="meta-lane-section-header"
    >
      <div>
        <strong>{title}</strong>
        {count !== undefined ? <span>{count}</span> : null}
      </div>
      {note ? <small>{note}</small> : null}
    </div>
  );
}

function MetaRevealReceipt({
  visible,
  total,
  noun,
  onReveal,
}: {
  visible: number;
  total: number;
  noun: string;
  onReveal: () => void;
}) {
  const hidden = Math.max(0, total - visible);
  if (hidden === 0) return null;
  return (
    <div className={styles.revealReceipt} data-testid="meta-reveal-receipt">
      <span>
        Showing {visible} of {total} {noun} · {hidden} hidden to keep this view
        bounded
      </span>
      <button type="button" onClick={onReveal}>
        Show more
      </button>
    </div>
  );
}

function MetaMonitorPager({
  page,
  total,
  noun,
  onPage,
}: {
  page: number;
  total: number;
  noun: string;
  onPage: (page: number) => void;
}) {
  const pageCount = Math.max(1, Math.ceil(total / META_MONITOR_PAGE_SIZE));
  if (pageCount <= 1) return null;
  const start = (page - 1) * META_MONITOR_PAGE_SIZE + 1;
  const end = Math.min(page * META_MONITOR_PAGE_SIZE, total);
  return (
    <nav
      className={styles.revealReceipt}
      aria-label={`${noun} pages`}
      data-testid="meta-monitor-pager"
    >
      <span>
        Showing {start}-{end} of {total} {noun} · page {page} of {pageCount}
      </span>
      <div className={styles.monitorPagerActions}>
        <button
          type="button"
          disabled={page <= 1}
          onClick={() => onPage(page - 1)}
        >
          Previous
        </button>
        <button
          type="button"
          disabled={page >= pageCount}
          onClick={() => onPage(page + 1)}
        >
          Next
        </button>
      </div>
    </nav>
  );
}

function MetaServerSuppressionReceipt({
  section,
}: {
  section: MetaDecisionQueueSection | null;
}) {
  if (!section) {
    return (
      <div className={styles.revealReceipt} data-testid="meta-server-receipt">
        <span>
          Creative selection unavailable · no client fallback or fabricated zero
          is shown
        </span>
      </div>
    );
  }
  const receipt = section.suppressionReceipt;
  return (
    <div className={styles.revealReceipt} data-testid="meta-server-receipt">
      <span>
        Server selected {receipt.selectedCount} of {receipt.preCapCount} · top{" "}
        {receipt.topN} · {receipt.suppressedCount} suppressed
        {section.unrankablePreCapCount > 0
          ? ` · ${section.unrankablePreCapCount} unrankable`
          : ""}
      </span>
    </div>
  );
}

function MetaQuietEntityRow({
  row,
  moneyCurrency,
}: {
  row: MetaHealthyEntity;
  moneyCurrency: string | null;
}) {
  return (
    <div className={styles.quietRow} data-quiet-row="healthy">
      <span className={styles.quietGrain}>
        {row.level === "adset" ? "SET" : "CMP"}
      </span>
      <span className={styles.quietIdentity}>
        <strong>{row.name}</strong>
        <small>
          {row.level === "adset"
            ? (row.campaignName ?? "Ad set")
            : (row.campaignKind ?? "Campaign")}
        </small>
      </span>
      <span className={styles.quietMetrics}>
        <span>
          <small>Spend</small>
          <b>{formatMoney(row.spend, moneyCurrency)}</b>
        </span>
        <span>
          <small>ROAS</small>
          <b>{row.roas == null ? "—" : formatRoas(row.roas)}</b>
        </span>
        <span>
          <small>CPA</small>
          <b>{row.cpa == null ? "—" : formatMoney(row.cpa, moneyCurrency)}</b>
        </span>
      </span>
      <span className={styles.quietStatus} data-tone="healthy">
        Healthy
      </span>
    </div>
  );
}

function MetaInactiveStructureRow({
  row,
  moneyCurrency,
}: {
  row: MetaArchivedEntity;
  moneyCurrency: string | null;
}) {
  return (
    <div className={styles.quietRow} data-quiet-row="inactive-structure">
      <span className={styles.quietGrain}>
        {row.level === "adset" ? "SET" : "CMP"}
      </span>
      <span className={styles.quietIdentity}>
        <strong>{row.name}</strong>
        <small>
          {row.level === "adset"
            ? (row.campaignName ?? "Ad set")
            : (row.campaignKind ?? "Campaign")}
        </small>
        {row.advisory ? (
          <small title={row.advisory.why}>
            Advisory · {row.advisory.primaryActionLabel}
          </small>
        ) : null}
      </span>
      <span className={styles.quietMetrics}>
        <span>
          <small>Spend</small>
          <b>{formatMoney(row.spend, moneyCurrency)}</b>
        </span>
        <span>
          <small>ROAS</small>
          <b>{formatRoas(row.roas)}</b>
        </span>
        <span>
          <small>Purchases</small>
          <b>{row.purchases}</b>
        </span>
      </span>
      <span className={styles.quietStatus} data-tone="inactive">
        {row.statusLabel}
      </span>
    </div>
  );
}

function MetaInactiveAdRow({
  decision,
  moneyCurrency,
  onOpen,
}: {
  decision: MetaCanonicalDecision;
  moneyCurrency: string | null;
  onOpen: () => void;
}) {
  const ad = decision.parentChain.ad;
  const status =
    decision.deliveryScope?.adStatus ??
    decision.deliveryScope?.adsetStatus ??
    decision.deliveryScope?.campaignStatus ??
    "Unknown";
  return (
    <div
      className={styles.quietRow}
      data-quiet-row="inactive-ad"
      role="button"
      tabIndex={0}
      onClick={onOpen}
      onKeyDown={(event) => {
        if (event.key === "Enter" || event.key === " ") {
          event.preventDefault();
          onOpen();
        }
      }}
    >
      <span className={styles.quietGrain}>AD</span>
      <span className={styles.quietIdentity}>
        <strong>{ad?.name ?? ad?.id ?? "Ad identity unavailable"}</strong>
        <small>
          {decision.parentChain.campaign?.name ?? "Campaign unavailable"} ·{" "}
          {decision.parentChain.adset?.name ?? "Ad set unavailable"}
        </small>
        <small title={decision.sourceDecision.reason}>
          Advisory · {decision.sourceDecision.label.replaceAll("_", " ")}
        </small>
      </span>
      <span className={styles.quietMetrics}>
        <span>
          <small>Spend</small>
          <b>
            {decision.metrics.spend == null
              ? "—"
              : formatMoney(decision.metrics.spend, moneyCurrency)}
          </b>
        </span>
        <span>
          <small>ROAS</small>
          <b>
            {decision.metrics.roas == null
              ? "—"
              : formatRoas(decision.metrics.roas)}
          </b>
        </span>
        <span>
          <small>Confidence</small>
          <b>{decision.sourceDecision.confidenceBand}</b>
        </span>
      </span>
      <span className={styles.quietStatus} data-tone="inactive">
        {status.replaceAll("_", " ")}
      </span>
    </div>
  );
}

function buildMetaScopeCampaigns(input: {
  actionNow: MetaRecommendation[];
  watching: MetaRecommendation[];
  nonSales: MetaRecommendation[];
  healthy: MetaHealthyEntity[];
}): MetaScopeCampaign[] {
  const campaigns = new Map<
    string,
    MetaScopeCampaign & { adsetMap: Map<string, MetaScopeAdset> }
  >();
  const ensureCampaign = (id: string, name: string) => {
    const current = campaigns.get(id);
    if (current) return current;
    const created = {
      id,
      name,
      actionCount: 0,
      watchingCount: 0,
      adsets: [],
      adsetMap: new Map<string, MetaScopeAdset>(),
    };
    campaigns.set(id, created);
    return created;
  };
  const addRec = (
    rec: MetaRecommendation,
    lane: "action" | "watching" | "context",
  ) => {
    const campaignId = rec.campaignId?.trim();
    if (!campaignId) return;
    const campaign = ensureCampaign(
      campaignId,
      rec.campaignName ?? rec.title ?? campaignId,
    );
    if (lane === "action") campaign.actionCount += 1;
    if (lane === "watching") campaign.watchingCount += 1;
    if (rec.adsetId) {
      const existing = campaign.adsetMap.get(rec.adsetId);
      campaign.adsetMap.set(rec.adsetId, {
        id: rec.adsetId,
        name: rec.adsetName ?? rec.title,
        label:
          lane === "action" || !existing?.label
            ? decisionLabelForRec(rec)
            : existing.label,
      });
    }
  };
  input.actionNow.forEach((rec) => addRec(rec, "action"));
  input.watching.forEach((rec) => addRec(rec, "watching"));
  input.nonSales.forEach((rec) => addRec(rec, "context"));
  for (const row of input.healthy) {
    const campaignId = row.level === "campaign" ? row.id : row.campaignId;
    if (!campaignId) continue;
    const campaign = ensureCampaign(
      campaignId,
      row.level === "campaign" ? row.name : (row.campaignName ?? row.name),
    );
    if (row.level === "adset")
      campaign.adsetMap.set(row.id, {
        id: row.id,
        name: row.name,
        label: "keep",
      });
  }
  return [...campaigns.values()]
    .map(({ adsetMap, ...campaign }) => ({
      ...campaign,
      adsets: [...adsetMap.values()].sort((left, right) =>
        left.name.localeCompare(right.name),
      ),
    }))
    .sort(
      (left, right) =>
        right.actionCount - left.actionCount ||
        right.watchingCount - left.watchingCount ||
        left.name.localeCompare(right.name),
    );
}

function MetaScopeRail({
  campaigns,
  selectedCampaignId,
  selectedAdsetId,
  disabled,
  onSelectCampaign,
  onSelectAdset,
}: {
  campaigns: MetaScopeCampaign[];
  selectedCampaignId: string;
  selectedAdsetId: string;
  disabled: boolean;
  onSelectCampaign: (id: string) => void;
  onSelectAdset: (campaignId: string, adsetId: string) => void;
}) {
  const selectedCampaign =
    campaigns.find((campaign) => campaign.id === selectedCampaignId) ?? null;
  return (
    <aside
      className={styles.scopeRail}
      data-testid="meta-scope-rail"
      data-disabled={disabled ? "true" : "false"}
    >
      <header>
        <div>
          <strong>{disabled ? "Creative scope" : "Account structure"}</strong>
          <span>
            {disabled ? "account-wide" : `${campaigns.length} campaigns`}
          </span>
        </div>
        <small>
          {disabled
            ? "This engine has no parent mapping."
            : "Selection filters decisions. It never hides account-wide calls."}
        </small>
      </header>
      {disabled ? (
        <div className={styles.scopeDisabledNote}>
          Creative calls are account-wide because this engine does not provide
          campaign or ad-set mapping.
        </div>
      ) : null}
      {!disabled ? (
        <div
          className={styles.scopeList}
          aria-label="Campaign and ad set scope"
        >
          <button
            type="button"
            className={cn(
              styles.scopeCampaign,
              selectedCampaignId === "all" && styles.scopeSelected,
            )}
            onClick={() => onSelectCampaign("all")}
          >
            <span>
              <strong>All decisions</strong>
              <small>Full account</small>
            </span>
            <b>ALL</b>
          </button>
          {campaigns.map((campaign) => (
            <div key={campaign.id} className={styles.scopeGroup}>
              <button
                type="button"
                className={cn(
                  styles.scopeCampaign,
                  selectedCampaignId === campaign.id &&
                    selectedAdsetId === "all" &&
                    styles.scopeSelected,
                )}
                onClick={() => onSelectCampaign(campaign.id)}
                title={campaign.name}
              >
                <span>
                  <strong>{campaign.name}</strong>
                  <small>{campaign.adsets.length} ad sets</small>
                </span>
                <b>
                  {campaign.actionCount > 0
                    ? `${campaign.actionCount} act`
                    : campaign.watchingCount > 0
                      ? `${campaign.watchingCount} watch`
                      : "context"}
                </b>
              </button>
              {selectedCampaignId === campaign.id ? (
                <div className={styles.scopeAdsets}>
                  {campaign.adsets.length > 0 ? (
                    campaign.adsets.map((adset) => (
                      <button
                        key={adset.id}
                        type="button"
                        className={cn(
                          selectedAdsetId === adset.id &&
                            styles.scopeAdsetSelected,
                        )}
                        onClick={() => onSelectAdset(campaign.id, adset.id)}
                        title={adset.name}
                      >
                        <span>{adset.name}</span>
                        <small>{adset.label ?? "—"}</small>
                      </button>
                    ))
                  ) : (
                    <p>No ad-set rows in the loaded decision lanes.</p>
                  )}
                </div>
              ) : null}
            </div>
          ))}
        </div>
      ) : null}
      {selectedCampaign && !disabled ? (
        <button
          type="button"
          className={styles.clearScope}
          onClick={() => onSelectCampaign("all")}
        >
          Clear scope
        </button>
      ) : null}
    </aside>
  );
}

function workspaceBannerPriority(banner: MetaWorkspaceBanner) {
  if (banner.id === "meta_write_kill_switch") return 0;
  if (banner.id === "dry_run_mode" || banner.id === "dry_run_only_guardrail")
    return 1;
  if (banner.id === "tracking_write_gate") return 2;
  if (banner.id === "reviewer_read_only" || banner.id === "workspace_read_only")
    return 3;
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

function MetaDecisionSourceHealthBanner({
  source,
}: {
  source: MetaOsDecisionsPresentation["source"] | null | undefined;
}) {
  if (source?.adsSource !== "legacy_creative_review_only") {
    return null;
  }
  const fallbackReason = source.fallbackReason ?? "native_fallback_unspecified";
  const detail = metaDecisionSourceFallbackDetail(fallbackReason);

  return (
    <div
      className="banner warn"
      data-testid="meta-decision-source-health"
      data-source-health="degraded"
      data-fallback-reason={fallbackReason}
      data-blocking="true"
      role="alert"
    >
      <div className="icon">
        <AlertTriangle size={15} aria-hidden="true" />
      </div>
      <div className="msg">
        <b>Native Ad decisions are degraded.</b>
        <span className="sub">
          {detail} Legacy decisions remain visible for review only; exact Ad
          actions are blocked. Source: {fallbackReason}.
        </span>
      </div>
    </div>
  );
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
    .filter(
      (banner) => !(banner.id === "tracking_write_gate" && trackingDismissed),
    )
    .sort(
      (left, right) =>
        workspaceBannerPriority(left) - workspaceBannerPriority(right),
    );
  if (visibleBanners.length === 0) return null;
  return (
    <div className="meta-posture-banners" data-testid="meta-posture-banners">
      {visibleBanners.map((banner) => {
        const tone = workspaceBannerToneClass(banner);
        return (
          <div
            key={banner.id}
            className={cn(
              "meta-posture-banner",
              `meta-posture-banner--${tone}`,
            )}
            data-banner-id={banner.id}
            data-banner-blocking={banner.blocking ? "true" : "false"}
            role={banner.blocking || tone === "danger" ? "alert" : "status"}
          >
            <span className="meta-posture-banner__mark" aria-hidden="true" />
            <span className="meta-posture-banner__title">{banner.title}</span>
            <span className="meta-posture-banner__detail">
              {workspaceBannerDetail(banner)}
            </span>
            <span className="meta-posture-banner__spacer" aria-hidden="true" />
            {banner.id === "meta_write_kill_switch" ? (
              <a
                className="meta-posture-banner__button"
                href="/platforms/meta/automation"
              >
                System Status
              </a>
            ) : null}
            {banner.id === "tracking_write_gate" ? (
              <>
                <button
                  type="button"
                  className="meta-posture-banner__button"
                  onClick={onOpenTrackingDetails}
                >
                  View details
                </button>
                <button
                  type="button"
                  className="meta-posture-banner__button meta-posture-banner__button--ghost"
                  onClick={onDismissTracking}
                >
                  Hide banner
                </button>
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
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <span>snapshot —</span>
        <span className="sep" aria-hidden="true">
          ·
        </span>
        <span>engine —</span>
      </div>
    );
  }
  const synced = pulse?.lastSyncAt
    ? `synced ${shortRelativeTime(pulse.lastSyncAt)}`
    : "sync unknown";
  const snapshot = laneSnapshotDate
    ? `snapshot ${laneSnapshotDate}`
    : "snapshot —";
  const engineVersion = pulse?.engineVersion ?? "—";
  const runTime = formatEngineRunTime(pulse?.engineLastRun);
  return (
    <div
      className="meta-asof"
      data-testid="meta-asof-cluster"
      title="Ingest, decision snapshot, and engine run each carry their own as-of; they can legitimately diverge."
    >
      <span>{synced}</span>
      <span className="sep" aria-hidden="true">
        ·
      </span>
      <span>{snapshot}</span>
      <span className="sep" aria-hidden="true">
        ·
      </span>
      <span>
        engine {engineVersion}
        {runTime ? ` · ${runTime}` : ""}
      </span>
    </div>
  );
}

export function MetaPlatformPage({
  businessId,
  businessName,
}: MetaPlatformPageProps) {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const selectedWindow = parseMetaWindow(searchParams.get("window"));
  const selectedStatusFilter: BriefingStatusFilter = "active";
  const initialLane = parseMetaWorkspaceLane(searchParams);
  const requestedProviderAccountId =
    searchParams.get("providerAccountId")?.trim() || null;
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drillItem, setDrillItem] = useState<MetaDrillItem | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
  const [compareOpen, setCompareOpen] = useState(false);
  const [pendingPrimaryRec, setPendingPrimaryRec] =
    useState<MetaRecommendation | null>(null);
  const [localDeferredIds, setLocalDeferredIds] = useState<Set<string>>(
    new Set(),
  );
  const [localResponseStates, setLocalResponseStates] = useState<
    Record<string, LocalResponseState>
  >({});
  const [trackingDismissed, setTrackingDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);
  const [primaryActionFeedback, setPrimaryActionFeedback] =
    useState<PrimaryActionFeedback | null>(null);
  const [refreshingSnapshot, setRefreshingSnapshot] = useState(false);
  const [activeLane, setActiveLane] = useState<MetaLaneView>(initialLane);
  const [levelFilter, setLevelFilter] = useState<MetaLevelFilter>("campaign");
  const [campaignFilter, setCampaignFilter] = useState("all");
  const [adsetFilter, setAdsetFilter] = useState("all");
  const [labelModalOpen, setLabelModalOpen] = useState(false);
  const [rowSort, setRowSort] = useState<MetaRowSort>("money");
  const [rowSearch, setRowSearch] = useState("");
  const [minSpendOnly, setMinSpendOnly] = useState(false);
  const [visibleLimit, setVisibleLimit] = useState(6);
  const [monitorPage, setMonitorPage] = useState(1);
  const [creativeDrill, setCreativeDrill] = useState<{
    decision: MetaOsAdDecision | null;
    canonical: MetaCanonicalDecision;
  } | null>(null);
  const [scopeRailOpen, setScopeRailOpen] = useState(false);
  const latestSearchParamsRef = useRef(searchParams.toString());

  useEffect(() => {
    latestSearchParamsRef.current = searchParams.toString();
    setActiveLane(parseMetaWorkspaceLane(searchParams));
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
    setVisibleLimit(activeLane === "action" ? 6 : 12);
    setMonitorPage(1);
  }, [
    activeLane,
    adsetFilter,
    campaignFilter,
    minSpendOnly,
    rowSearch,
    rowSort,
  ]);

  const providerAccountsQuery = useQuery({
    queryKey: ["meta-provider-accounts", businessId],
    enabled: Boolean(businessId),
    queryFn: () => fetchMetaHistoryAccounts({ businessId }),
    staleTime: 5 * 60 * 1000,
    retry: 1,
  });
  const providerAccounts = providerAccountsQuery.data ?? [];
  const selectedProviderAccount = useMemo<MetaHistoryAccount | null>(() => {
    if (requestedProviderAccountId) {
      return (
        providerAccounts.find(
          (account) => account.id === requestedProviderAccountId,
        ) ?? null
      );
    }
    return providerAccounts.length === 1 ? providerAccounts[0]! : null;
  }, [providerAccounts, requestedProviderAccountId]);
  const providerAccountId = selectedProviderAccount?.id ?? null;
  const selectedAccountTimeZone = selectedProviderAccount?.timezone || "UTC";
  const selectedReferenceDate = getTodayIsoForTimeZone(selectedAccountTimeZone);
  const selectedDateRange = metaDateRangeFromParams(
    searchParams,
    selectedReferenceDate,
  );

  const creativeEvidenceCreativeId =
    creativeDrill?.canonical.parentChain.creative?.id?.trim() ||
    creativeDrill?.decision?.creativeId?.trim() ||
    null;
  const creativeEvidenceQuery = useQuery({
    queryKey: [
      "meta-creative-evidence-ad-rows",
      businessId,
      providerAccountId,
      creativeEvidenceCreativeId,
      selectedDateRange.start,
      selectedDateRange.end,
    ],
    enabled: Boolean(
      businessId && providerAccountId && creativeEvidenceCreativeId,
    ),
    queryFn: () =>
      fetchCreativeEvidenceAdRows({
        businessId,
        providerAccountId: providerAccountId!,
        creativeId: creativeEvidenceCreativeId!,
        start: selectedDateRange.start,
        end: selectedDateRange.end,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  /**
   * The sparkline pair is the decision's own ad, not the creative's whole ad
   * set: the Frequency evidence key beside it is that ad's frequency, and a
   * cross-ad frequency would need a deduplicated reach Meta does not report.
   */
  const creativeEvidenceAdId =
    creativeDrill?.canonical.parentChain.ad?.id?.trim() ||
    creativeDrill?.decision?.adId?.trim() ||
    null;
  const creativeEvidenceSeriesQuery = useQuery({
    queryKey: [
      "meta-creative-evidence-series",
      businessId,
      creativeEvidenceAdId,
      selectedDateRange.start,
      selectedDateRange.end,
    ],
    enabled: Boolean(businessId && creativeEvidenceAdId),
    queryFn: () =>
      fetchCreativeEvidenceAdSeries({
        businessId,
        adIds: [creativeEvidenceAdId!],
        start: selectedDateRange.start,
        end: selectedDateRange.end,
      }),
    staleTime: 5 * 60 * 1000,
    refetchOnWindowFocus: false,
  });

  const workspaceQuery = useQuery({
    queryKey: [
      "meta-decisions-workspace",
      businessId,
      providerAccountId,
      selectedWindow,
      selectedStatusFilter,
      selectedDateRange.start,
      selectedDateRange.end,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: () =>
      fetchDecisionsWorkspace(
        businessId,
        providerAccountId!,
        selectedWindow,
        selectedStatusFilter,
        selectedDateRange,
      ),
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
  const moneyCurrency = resolveMetaDecisionMoneyCurrency(
    pulseQuery.data?.currency,
    selectedProviderAccount?.currency,
  );
  const targetRoas = pulseQuery.data?.roas.target ?? null;
  const entityParam = searchParams.get("entity");

  const anomalyQuery = useQuery({
    queryKey: [
      "meta-anomalies",
      businessId,
      providerAccountId,
      selectedWindow,
      selectedStatusFilter,
      selectedDateRange?.start ?? null,
      selectedDateRange?.end ?? null,
    ],
    enabled: Boolean(businessId && providerAccountId),
    queryFn: () =>
      fetchAnomalies(
        businessId,
        providerAccountId!,
        selectedWindow,
        selectedStatusFilter,
        selectedDateRange,
      ),
  });
  useTierZeroFreshness({
    surface: "meta_decisions",
    isLoading: workspaceQuery.isLoading,
    isFetching: workspaceQuery.isFetching,
    error: workspaceQuery.error,
    asOf: measuredAsOf(workspaceQuery.data?.pulse.lastSyncAt ?? null),
    businessId,
    onRetry: () => void workspaceQuery.refetch(),
  });
  const briefingLoading =
    providerAccountsQuery.isLoading ||
    (Boolean(providerAccountId) &&
      (pulseQuery.isLoading || laneQuery.isLoading));
  const briefingError = (providerAccountsQuery.error ??
    pulseQuery.error ??
    laneQuery.error ??
    null) as Error | null;
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
  const anomalies = anomalyQuery.data?.anomalies ?? [];

  useEffect(() => {
    const payload = laneQuery.data;
    if (!payload) return;
    const serverRecs = new Map(
      [...payload.actionNow, ...payload.watching, ...payload.nonSales].map(
        (rec) => [rec.id, rec],
      ),
    );
    setLocalResponseStates((current) => {
      let changed = false;
      const next = { ...current };
      for (const [recId, localState] of Object.entries(current)) {
        const serverRec = serverRecs.get(recId);
        if (!serverRec) continue;
        if (
          serverRec.operatorResponseState === localState ||
          (localState === "acted" && !serverRec.operatorResponseState)
        ) {
          delete next[recId];
          changed = true;
        }
      }
      return changed ? next : current;
    });
  }, [laneQuery.data]);

  const scopeCampaigns = useMemo(
    () => buildMetaScopeCampaigns({ actionNow, watching, nonSales, healthy }),
    [actionNow, healthy, nonSales, watching],
  );
  const selectCampaignScope = (campaignId: string) => {
    setCampaignFilter(campaignId);
    setAdsetFilter("all");
    setLevelFilter("campaign");
  };
  const selectAdsetScope = (campaignId: string, adsetId: string) => {
    setCampaignFilter(campaignId);
    setAdsetFilter(adsetId);
    setLevelFilter("adset");
  };
  const metaFilterInput = useMemo(
    () => ({
      level: levelFilter,
      campaignId: campaignFilter,
      adsetId: adsetFilter,
    }),
    [adsetFilter, campaignFilter, levelFilter],
  );
  const filteredActionNow = useMemo(
    () =>
      actionNow.filter((rec) => recMatchesMetaFilters(rec, metaFilterInput)),
    [actionNow, metaFilterInput],
  );
  const filteredWatching = useMemo(
    () => watching.filter((rec) => recMatchesMetaFilters(rec, metaFilterInput)),
    [metaFilterInput, watching],
  );
  const filteredHealthy = useMemo(
    () =>
      healthy.filter((row) =>
        healthyMatchesMetaFilters(row, {
          level: levelFilter,
          campaignId: campaignFilter,
          adsetId: adsetFilter,
        }),
      ),
    [adsetFilter, campaignFilter, healthy, levelFilter],
  );
  const filteredNonSales = useMemo(
    () => nonSales.filter((rec) => recMatchesMetaFilters(rec, metaFilterInput)),
    [metaFilterInput, nonSales],
  );
  // Row search + sort over structured server truth; missing-metric rows kept
  // last. Applied to the rendered rec lists only (tab counts stay lane totals).
  const visibleActionRecs = useMemo(
    () =>
      sortMetaRecs(
        filteredActionNow.filter(
          (rec) =>
            metaRecSearchMatch(rec, rowSearch) &&
            passesMetaMinSpend(rec, minSpendOnly),
        ),
        rowSort,
      ),
    [filteredActionNow, rowSearch, rowSort, minSpendOnly],
  );
  const canonicalDecisionModel = workspaceQuery.data?.decisionReadModel ?? null;
  const creativeDecisionSection =
    canonicalDecisionModel?.status === "available"
      ? canonicalDecisionModel.queue.sections.creative_rotation
      : null;
  const nativeAdDecisionAuthority =
    canonicalDecisionModel?.source.authority === "native_ad";
  const inactiveStructureRows = laneQuery.data?.archive ?? [];
  const inactiveAdDecisions =
    canonicalDecisionModel?.queue.inactiveAssets?.items ?? [];
  const inactiveViewItems = useMemo(() => {
    const query = rowSearch.trim().toLowerCase();
    const structures = inactiveStructureRows
      .filter(
        (row) =>
          !query ||
          [row.name, row.campaignName ?? "", row.statusLabel].some((value) =>
            value.toLowerCase().includes(query),
          ),
      )
      .filter((row) => !minSpendOnly || row.spend >= META_MIN_SPEND_THRESHOLD)
      .map((row) => ({ kind: "structure" as const, row, spend: row.spend }));
    const ads = inactiveAdDecisions
      .filter((decision) => canonicalCreativeSearchMatch(decision, rowSearch))
      .filter(
        (decision) =>
          !minSpendOnly ||
          (decision.metrics.spend != null &&
            decision.metrics.spend >= META_MIN_SPEND_THRESHOLD),
      )
      .map((decision) => ({
        kind: "ad" as const,
        decision,
        spend: decision.metrics.spend ?? -1,
      }));
    return [...structures, ...ads].sort(
      (left, right) => right.spend - left.spend,
    );
  }, [inactiveAdDecisions, inactiveStructureRows, minSpendOnly, rowSearch]);
  // Presentation-only filters run over the server-selected top-N. They never
  // reclassify, rerank, or pull suppressed decisions into the client.
  const creativeActionDecisions = useMemo(() => {
    if (!creativeDecisionSection) return [] as MetaCanonicalDecision[];
    return creativeDecisionSection.items
      .filter((decision) => canonicalCreativeSearchMatch(decision, rowSearch))
      .filter(
        (decision) =>
          !minSpendOnly ||
          (decision.metrics.spend != null &&
            decision.metrics.spend >= META_MIN_SPEND_THRESHOLD),
      );
  }, [creativeDecisionSection, rowSearch, minSpendOnly]);
  const visibleWatchingRecs = useMemo(
    () =>
      sortMetaRecs(
        filteredWatching.filter(
          (rec) =>
            metaRecSearchMatch(rec, rowSearch) &&
            passesMetaMinSpend(rec, minSpendOnly),
        ),
        rowSort,
      ),
    [filteredWatching, rowSearch, rowSort, minSpendOnly],
  );
  const visibleNonSalesRecs = useMemo(
    () =>
      sortMetaRecs(
        filteredNonSales.filter(
          (rec) =>
            metaRecSearchMatch(rec, rowSearch) &&
            passesMetaMinSpend(rec, minSpendOnly),
        ),
        rowSort,
      ),
    [filteredNonSales, rowSearch, rowSort, minSpendOnly],
  );
  const rowSearchActive = rowSearch.trim().length > 0;
  const allRecs = useMemo(
    () => [...filteredActionNow, ...filteredWatching],
    [filteredActionNow, filteredWatching],
  );
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
  const viewerReadOnlyReason = !workspaceQuery.data?.viewer
    ? "Decision authority is unavailable; write controls remain disabled."
    : workspaceQuery.data.viewer.readOnly
      ? (workspaceQuery.data.viewer.readOnlyReason ??
        "Current viewer is read-only; write controls are downgraded to review.")
      : null;
  const isViewerReadOnly = viewerReadOnlyReason !== null;
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
        detail:
          readiness.notReadyReason ??
          "The selected range is partially verified; numbers may be incomplete.",
        blocking: false,
      });
    }
    if (trackingBlocked) {
      fallback.push({
        id: "tracking_write_gate",
        tone: "warning",
        title: "Tracking degraded — purchase signal may be incomplete.",
        detail:
          pulseQuery.data?.trackingHealth.detail ??
          "Hard actions stay gated until tracking is checked.",
        blocking: true,
      });
    }
    const snapshotHealth =
      pulseQuery.data?.snapshotHealth ?? laneQuery.data?.snapshotHealth ?? null;
    if (snapshotHealth && snapshotHealth.status !== "fresh") {
      fallback.push({
        id: "snapshot_health",
        tone: snapshotHealth.status === "missing" ? "danger" : "warning",
        title: "Decision snapshot is not fresh.",
        detail:
          snapshotHealth.staleReason ??
          "The served snapshot does not meet the current freshness contract.",
        blocking: snapshotHealth.status === "missing",
      });
    }
    if (workspaceQuery.data?.system.killSwitchEngaged) {
      fallback.push({
        id: "meta_write_kill_switch",
        tone: "danger",
        title: "Kill switch engaged.",
        detail:
          workspaceQuery.data.system.killSwitchReason ??
          "Meta writes are disabled by kill switch.",
        blocking: true,
      });
    }
    const viewer = workspaceQuery.data?.viewer ?? null;
    if (viewer?.readOnly && viewer.readOnlyReason) {
      fallback.push({
        id: viewer.isReviewer ? "reviewer_read_only" : "workspace_read_only",
        tone: "info",
        title: viewer.isReviewer
          ? "Reviewer access is read-only."
          : "Workspace access is read-only.",
        detail: viewer.readOnlyReason,
        blocking: false,
      });
    }
    return fallback;
  }, [workspaceQuery.data, pulseQuery.data, laneQuery.data, trackingBlocked]);

  const laneSnapshotDate = laneQuery.data?.snapshotDate ?? null;
  const deferredCount =
    localDeferredIds.size +
    campaignDefer.deferredCount +
    adsetDefer.deferredCount;

  const currentUrlParams = () =>
    new URLSearchParams(
      latestSearchParamsRef.current ||
        (typeof window === "undefined"
          ? searchParams.toString()
          : window.location.search),
    );

  const metaDecisionsHref = dashboardHrefForRouteFamily(
    "/platforms/meta",
    pathname,
  );

  const replaceMetaParams = (params: URLSearchParams) => {
    const query = params.toString();
    latestSearchParamsRef.current = query;
    router.replace(`${metaDecisionsHref}${query ? `?${query}` : ""}`);
  };

  const setDateRange = (next: DateWindowValue) => {
    const params = currentUrlParams();
    const nextWindow: MetaWindowKey =
      next.window === "7d" ||
      next.window === "14d" ||
      next.window === "28d" ||
      next.window === "90d"
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
    const nextHref = `${metaDecisionsHref}${query ? `?${query}` : ""}`;
    if (typeof window !== "undefined") {
      window.history.replaceState(null, "", nextHref);
    }
    latestSearchParamsRef.current = query;
    router.replace(nextHref);
  };

  const selectExactWindow = (nextWindow: MetaDecisionCenterExactWindow) => {
    setDateRange(
      rangeValueToDateWindow(
        dateWindowToRangeValue({ window: nextWindow, start: "", end: "" }),
        selectedReferenceDate,
        { includeCurrentDay: true },
      ),
    );
  };

  const setProviderAccount = (nextProviderAccountId: string) => {
    const params = currentUrlParams();
    if (nextProviderAccountId) {
      params.set("providerAccountId", nextProviderAccountId);
    } else {
      params.delete("providerAccountId");
    }
    params.delete("entity");
    setSelectedIds(new Set());
    setDrillItem(null);
    setCreativeDrill(null);
    setCampaignFilter("all");
    setAdsetFilter("all");
    replaceMetaParams(params);
  };

  const selectLane = (next: MetaLaneView) => {
    setActiveLane(next);
    const params = currentUrlParams();
    params.delete("lane");
    if (next === "action") {
      params.delete("area");
      params.delete("segment");
    } else {
      params.set("area", "monitor");
      if (next === "watching") params.delete("segment");
      else if (next === "healthy") params.set("segment", "healthy");
      else if (next === "nonSales") params.set("segment", "out_of_scope");
      else params.set("segment", "structures");
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
      queryClient.invalidateQueries({
        queryKey: ["meta-decisions-workspace", businessId],
      }),
      queryClient.invalidateQueries({
        queryKey: ["meta-anomalies", businessId],
      }),
    ]);
  };

  const refreshSnapshotNow = async () => {
    if (!businessId || refreshingSnapshot) return;
    if (isViewerReadOnly) {
      setNotice(
        viewerReadOnlyReason ??
          "Current viewer is read-only; snapshot refresh is unavailable.",
      );
      return;
    }
    setRefreshingSnapshot(true);
    setNotice(null);
    try {
      const response = await fetch("/api/meta/snapshot/run-now", {
        method: "POST",
        headers: {
          "Content-Type": "application/json",
          Accept: "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({ businessId }),
      });
      const payload = await response.json().catch(() => null);
      const outcome = interpretMetaSnapshotRunResponse(response.ok, payload);
      if (!outcome.ok) throw new Error(outcome.message);
      setNotice(
        outcome.status === "cooldown"
          ? "Decision snapshot refresh is in cooldown."
          : outcome.status === "already_running"
            ? "Decision snapshot refresh is already running."
            : "Decision snapshot refreshed.",
      );
      await refreshDecisionData();
    } catch (error) {
      setNotice(
        error instanceof Error
          ? error.message
          : "Decision snapshot refresh failed.",
      );
    } finally {
      setRefreshingSnapshot(false);
    }
  };

  const markActed = async (rec: MetaRecommendation, subtype: string) => {
    if (isViewerReadOnly) return;
    setLocalResponseStates((current) => ({ ...current, [rec.id]: "acted" }));
    await postResponse({
      businessId,
      recId: rec.id,
      action: "acted",
      actionSubtype: subtype,
    }).catch(() => null);
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
    return (
      rec.operatorResponseState === "deferred" ||
      localDeferredIds.has(rec.id) ||
      state.isDeferred(scopeIdForRec(rec))
    );
  };

  const responseStateForRec = (
    rec: MetaRecommendation,
  ): LocalResponseState | null => {
    return (
      localResponseStates[rec.id] ??
      rec.operatorResponseState ??
      (isDeferred(rec) ? "deferred" : null)
    );
  };

  const openOverlayForRec = (rec: MetaRecommendation, mode: MetaLaunchMode) => {
    if (mode === "apply_bid") {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Recommendation is review-only.",
        detail:
          "Campaign and ad-set bid recommendations cannot write to Meta until a canonical execution-authority contract is available.",
      });
      openDrillForRec(rec);
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
      relatedRecs: rec.campaignId
        ? (adsetRecsByCampaign.get(rec.campaignId) ?? [])
        : [],
    });
    // Deep-link the open entity (a selection, not a drawer-local control).
    setEntityParam(rec.id);
  };

  const compareRec = (rec: MetaRecommendation) => {
    setSelectedIds((current) => new Set(current).add(rec.id));
    setCompareOpen(true);
  };

  // Deep-link restore: open the drawer for ?entity=<id> once lanes are loaded.
  useEffect(() => {
    if (!entityParam || drillItem) return;
    const rec = [...actionNow, ...watching, ...nonSales].find(
      (candidate) => candidate.id === entityParam,
    );
    if (rec) {
      setDrillItem({
        mode: "decision",
        rec,
        relatedRecs: rec.campaignId
          ? (adsetRecsByCampaign.get(rec.campaignId) ?? [])
          : [],
      });
    }
  }, [entityParam, laneQuery.data]);

  const isTrackingSensitiveRec = (rec: MetaRecommendation) => {
    return rec.actionKind === "route_launchpad_rebuild";
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
    // Campaign/ad-set recommendation cards are advisory until they carry a
    // canonical decision-origin execution contract. launchModeForRec fails
    // closed for stale/injected execute_* values, so this path has no provider
    // mutation endpoint.
    const mode = launchModeForRec(rec);
    if (mode) {
      openOverlayForRec(rec, mode);
      return;
    }
    if (
      rec.actionKind === "execute_pause" ||
      rec.actionKind === "execute_resume" ||
      rec.actionKind === "execute_bid"
    ) {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Recommendation is review-only.",
        detail:
          "This legacy execution hint is not a canonical provider-write authority.",
      });
    }
    openDrillForRec(rec);
  };

  const handlePrimary = async (rec: MetaRecommendation) => {
    if (isViewerReadOnly) {
      openDrillForRec(rec);
      return;
    }
    if (trackingBlocked && isTrackingSensitiveRec(rec)) {
      setPendingPrimaryRec(rec);
      return;
    }
    await performPrimary(rec);
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
    if (overlay.mode === "apply_bid") {
      setPrimaryActionFeedback({
        recId: rec.id,
        tone: "info",
        title: "Recommendation is review-only.",
        detail:
          "Campaign and ad-set bid recommendations cannot write to Meta without canonical execution authority.",
      });
      setOverlay(EMPTY_OVERLAY);
      openDrillForRec(rec);
      return;
    }
    const href = launchpadHrefForRec(rec, overlay.mode);
    await markActed(
      rec,
      overlay.mode === "rebuild" ? "rebuild_clicked" : "audience_swap_clicked",
    );
    router.push(dashboardHrefForRouteFamily(href, pathname));
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
  };

  const selectedRecByRoas = (direction: "weakest" | "strongest") => {
    // Only entities with server-supplied ROAS participate in destructive
    // ranking; unknown metrics must never rank as zero (which made every
    // metrics-less entity "the weakest").
    const ranked = selectedRecs
      .map((rec) => ({ rec, roas: compareItemForRec(rec).roas }))
      .filter(
        (item): item is { rec: MetaRecommendation; roas: number } =>
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
      providerAccountId: providerAccountId ?? "",
    });
    const campaignIds = selectedRecs
      .map((rec) => rec.campaignId)
      .filter((id): id is string => Boolean(id));
    const adsetIds = selectedRecs
      .map((rec) => rec.adsetId)
      .filter((id): id is string => Boolean(id));
    if (campaignIds.length > 0)
      params.set("campaignIds", Array.from(new Set(campaignIds)).join(","));
    if (adsetIds.length > 0)
      params.set("adsetIds", Array.from(new Set(adsetIds)).join(","));
    router.push(
      dashboardHrefForRouteFamily(
        `/platforms/meta/launchpad?${params.toString()}`,
        pathname,
      ),
    );
  };

  const handleCompareDrawerAction = async (
    action: "pause_weakest" | "scale_strongest" | "launch_selected",
  ) => {
    if (isViewerReadOnly) {
      const first = selectedRecs[0];
      if (first) openDrillForRec(first);
      return;
    }
    if (action === "launch_selected") {
      openLaunchpadForSelectedRecs();
      return;
    }
    const rec = selectedRecByRoas(
      action === "scale_strongest" ? "strongest" : "weakest",
    );
    if (!rec) return;
    await handlePrimary(rec);
  };

  const loading = briefingLoading;
  const error = briefingError ?? ((anomalyQuery.error ?? null) as Error | null);

  const boundedActionRecs = visibleActionRecs.slice(0, visibleLimit);
  const healthyRowsForView = filteredHealthy.filter((row) => {
    const searchMatch =
      !rowSearch.trim() ||
      [row.name, row.campaignName ?? ""].some((value) =>
        value.toLowerCase().includes(rowSearch.trim().toLowerCase()),
      );
    const spendMatch =
      !minSpendOnly ||
      (typeof row.spend === "number" && row.spend >= META_MIN_SPEND_THRESHOLD);
    return searchMatch && spendMatch;
  });
  const activeMonitorTotal =
    activeLane === "watching"
      ? visibleWatchingRecs.length
      : activeLane === "healthy"
        ? healthyRowsForView.length
        : activeLane === "nonSales"
          ? visibleNonSalesRecs.length
          : activeLane === "archive"
            ? inactiveViewItems.length
          : 0;
  const activeMonitorPageCount = Math.max(
    1,
    Math.ceil(activeMonitorTotal / META_MONITOR_PAGE_SIZE),
  );
  const effectiveMonitorPage = Math.min(monitorPage, activeMonitorPageCount);
  const boundedWatchingRecs = paginateMetaMonitorRows(
    visibleWatchingRecs,
    effectiveMonitorPage,
  );
  const boundedNonSalesRecs = paginateMetaMonitorRows(
    visibleNonSalesRecs,
    effectiveMonitorPage,
  );
  const boundedHealthyRows = paginateMetaMonitorRows(
    healthyRowsForView,
    effectiveMonitorPage,
  );
  const boundedInactiveItems = paginateMetaMonitorRows(
    inactiveViewItems,
    effectiveMonitorPage,
  );

  useEffect(() => {
    setMonitorPage((current) => Math.min(current, activeMonitorPageCount));
  }, [activeMonitorPageCount]);
  const boundedCreativeDecisions = creativeActionDecisions;
  const creativeActionTotal = creativeDecisionSection?.preCapCount ?? null;
  const exactCanonicalKeys = new Set(
    creativeActionDecisions.map(
      (decision) => `${decision.decisionId}\u0000${decision.sourceSnapshotId}`,
    ),
  );
  const exactCreativeDecisions = (workspaceQuery.data?.os?.ads?.items ?? []).filter(
    (decision) =>
      exactCanonicalKeys.has(
        `${decision.decisionId}\u0000${decision.sourceSnapshotId}`,
      ) &&
      metaOsCreativeSearchMatch(decision, rowSearch) &&
      (!minSpendOnly ||
        (typeof decision.metrics.spend === "number" &&
          decision.metrics.spend >= META_MIN_SPEND_THRESHOLD)),
  );
  const exactArchiveRows = inactiveViewItems.flatMap((item) =>
    item.kind === "structure" ? [item.row] : [],
  );
  const exactActionRows = sortMetaRecs(
    actionNow.filter(
      (recommendation) =>
        metaRecSearchMatch(recommendation, rowSearch) &&
        passesMetaMinSpend(recommendation, minSpendOnly),
    ),
    rowSort,
  );
  const exactWatchingRows = sortMetaRecs(
    watching.filter(
      (recommendation) =>
        metaRecSearchMatch(recommendation, rowSearch) &&
        passesMetaMinSpend(recommendation, minSpendOnly),
    ),
    rowSort,
  );
  const exactNonSalesRows = sortMetaRecs(
    nonSales.filter(
      (recommendation) =>
        metaRecSearchMatch(recommendation, rowSearch) &&
        passesMetaMinSpend(recommendation, minSpendOnly),
    ),
    rowSort,
  );
  const exactHealthyRows = healthy.filter((row) => {
    const searchMatch =
      !rowSearch.trim() ||
      [row.name, row.campaignName ?? ""].some((value) =>
        value.toLowerCase().includes(rowSearch.trim().toLowerCase()),
      );
    const spendMatch =
      !minSpendOnly || row.spend >= META_MIN_SPEND_THRESHOLD;
    return searchMatch && spendMatch;
  });
  const exactViewModel: MetaDecisionCenterExactViewModel = workspaceQuery.data
    ? buildMetaDecisionCenterExactViewModel({
        workspace: workspaceQuery.data,
        account: selectedProviderAccount,
        now: Date.now(),
        selection:
          drillItem && drillItem.mode !== "anomaly"
            ? {
                kind: "structure",
                recommendationId: drillItem.rec.id,
              }
            : undefined,
        overrides: {
          actionNow: exactActionRows,
          watching: exactWatchingRows,
          healthy: exactHealthyRows,
          nonSales: exactNonSalesRows,
          archive: exactArchiveRows,
          creatives: exactCreativeDecisions,
          canonicalDecisions: creativeActionDecisions,
          deferredCount,
        },
        callbacks: {
          onStructurePrimary:
            !isViewerReadOnly && !workspaceQuery.data.system.killSwitchEngaged
              ? (recommendation) => {
                  void handlePrimary(recommendation);
                }
              : undefined,
          onStructureMenu: openDrillForRec,
          onWatchingReview: openDrillForRec,
          onCreativeReview: (decision, canonicalDecision) => {
            if (canonicalDecision) {
              // The presentation decision carries CTR, frequency and the ad
              // set identity the canonical envelope does not; the evidence
              // window needs both.
              setCreativeDrill({ decision, canonical: canonicalDecision });
              return;
            }
            setNotice("Canonical creative evidence is unavailable.");
          },
        },
      })
    : {
        activeWindow: exactWindowForMetaWindow(selectedWindow),
        identity: {
          accountLabel:
            selectedProviderAccount?.name ?? selectedProviderAccount?.id ?? null,
          currency: moneyCurrency,
        },
      };

  return (
    <div
      className={cn("ad-final meta-decisions-final", styles.metaPageRoot)}
      data-testid="meta-platform-page"
      data-workspace-query-status={workspaceQuery.status}
      data-workspace-fetch-status={workspaceQuery.fetchStatus}
    >
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
          onOpenAnomaly={(anomaly) =>
            setDrillItem({ mode: "anomaly", anomaly })
          }
        />
      )}

      <div className={styles.metaOsDesktop} data-testid="meta-os-decisions">
        {!providerAccountsQuery.isLoading && !providerAccountId ? (
          <div className="banner warn" data-testid="meta-account-required">
            <div className="icon">i</div>
            <div className="msg">
              <b>Select a Meta ad account.</b>
              <span className="sub">
                Decisions stay withheld until an explicitly assigned provider
                account defines identity and currency scope.
              </span>
              <label>
                <span className="sr-only">Meta ad account</span>
                <select
                  aria-label="Meta ad account"
                  value=""
                  onChange={(event) =>
                    setProviderAccount(event.currentTarget.value)
                  }
                >
                  <option value="">
                    {providerAccounts.length === 0
                      ? "No assigned account"
                      : "Select account"}
                  </option>
                  {providerAccounts.map((account) => (
                    <option key={account.id} value={account.id}>
                      {account.name ?? account.id}
                      {account.currency ? " · " + account.currency : ""}
                    </option>
                  ))}
                </select>
              </label>
            </div>
          </div>
        ) : null}

        {briefingError ? (
          <div
            className="banner danger"
            data-testid="meta-briefing-error"
            role="alert"
          >
            <div className="icon">!</div>
            <div className="msg">
              <b>Decision workspace could not load.</b>
              <span className="sub">
                {describeDecisionWorkspaceFailure(briefingError)}
              </span>
            </div>
            <button
              type="button"
              className="btn btn--sm"
              data-testid="meta-briefing-retry"
              disabled={workspaceQuery.isFetching}
              onClick={() => void workspaceQuery.refetch()}
            >
              {workspaceQuery.isFetching ? "Retrying..." : "Retry"}
            </button>
          </div>
        ) : null}

        {anomalyQuery.error && !briefingError ? (
          <div className="banner warn" data-testid="meta-anomaly-error" role="alert">
            <div className="icon">!</div>
            <div className="msg">
              <b>Integrity scan is unavailable.</b>
              <span className="sub">
                {anomalyQuery.error instanceof Error
                  ? anomalyQuery.error.message
                  : "Integrity evidence is withheld; the decision workspace remains readable."}
              </span>
            </div>
          </div>
        ) : null}

        {notice ? (
          <div className="banner warn" role="status">
            <div className="icon">i</div>
            <div className="msg">
              <b>{notice}</b>
              <span className="sub">
                {selectedProviderAccount?.name ??
                  selectedProviderAccount?.id ??
                  "Selected account"}
              </span>
            </div>
          </div>
        ) : null}

        {workspaceQuery.data?.decisionReadModel.status === "unavailable" ? (
          <div
            className="banner danger"
            data-testid="meta-decision-unavailable"
            role="alert"
          >
            <div className="icon">!</div>
            <div className="msg">
              <b>Canonical decision source is unavailable.</b>
              <span className="sub">
                {workspaceQuery.data.decisionReadModel.unavailable?.message ??
                  "Decision rows are withheld because source authority could not be verified."}
              </span>
            </div>
          </div>
        ) : null}

        <MetaDecisionSourceHealthBanner
          source={workspaceQuery.data?.os?.source}
        />

        <MetaWorkspacePostureBanners
          banners={workspaceBanners}
          trackingDismissed={trackingDismissed}
          onDismissTracking={() => setTrackingDismissed(true)}
          onOpenTrackingDetails={() =>
            setDrillItem(
              anomalies[0] ? { mode: "anomaly", anomaly: anomalies[0] } : null,
            )
          }
        />

        <MetaDecisionCenterExact
          viewModel={exactViewModel}
          lane={exactLaneForMetaLane(activeLane)}
          onLaneChange={(lane) => selectLane(metaLaneForExactLane(lane))}
          onWindowChange={selectExactWindow}
          onRunSnapshot={
            providerAccountId && !refreshingSnapshot && !isViewerReadOnly
              ? () => void refreshSnapshotNow()
              : undefined
          }
          onNewCampaign={
            providerAccountId && !isViewerReadOnly
              ? () => {
                  const params = new URLSearchParams({
                    fromMetaBriefing: "true",
                    mode: "duplicate",
                    providerAccountId,
                  });
                  router.push(
                    dashboardHrefForRouteFamily(
                      "/platforms/meta/launchpad?" + params.toString(),
                      pathname,
                    ),
                  );
                }
              : undefined
          }
          onManageLabels={
            providerAccountId && !isViewerReadOnly
              ? () => setLabelModalOpen(true)
              : undefined
          }
          onSortChange={setRowSort}
          onSearchChange={setRowSearch}
          onOpenCreativeStudio={() => {
            const query = providerAccountId
              ? "?providerAccountId=" + encodeURIComponent(providerAccountId)
              : "";
            router.push(
              dashboardHrefForRouteFamily(
                "/platforms/meta/creatives" + query,
                pathname,
              ),
            );
          }}
        />
      </div>

      {creativeDrill ? (
        <CreativeEvidenceWindowExact
          onClose={() => setCreativeDrill(null)}
          viewModel={buildCreativeEvidenceWindowExactViewModel({
            decision: creativeDrill.decision,
            canonical: creativeDrill.canonical,
            adRows: creativeEvidenceQuery.data,
            adSeries: creativeEvidenceSeriesQuery.data,
            fallbackCurrency: moneyCurrency,
            hrefs: {
              primary: creativeEvidenceLaunchpadHref({
                decision: creativeDrill.decision,
                canonical: creativeDrill.canonical,
                pathname,
              }),
              compareInStudio: creativeEvidenceStudioHref({
                canonical: creativeDrill.canonical,
                pathname,
              }),
              adsManager: buildMetaAdsManagerHref({
                providerAccountId: creativeDrill.canonical.providerAccountId,
                adId:
                  creativeDrill.canonical.parentChain.ad?.id ??
                  creativeDrill.decision?.adId ??
                  null,
              }),
            },
          })}
        />
      ) : null}

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
                <h2 id="meta-label-modal-title">Campaign context exceptions</h2>
                <p>
                  Automatic context is the default. Use an override only when
                  the inferred role is wrong.
                </p>
              </div>
              <button
                type="button"
                className="btn btn--ghost"
                aria-label="Close campaign context exceptions"
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

      <MetaLaunchpadOverlay
        open={overlay.open}
        mode={overlay.mode}
        item={{
          id: overlay.rec ? scopeIdForRec(overlay.rec) : "meta",
          name: overlay.rec ? scopeNameForRec(overlay.rec) : "Meta action",
          campaign: overlay.rec?.campaignName,
          proposedBidCap: overlay.rec
            ? (proposedBidDisplayValue(overlay.rec) ?? undefined)
            : undefined,
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
              title={
                isViewerReadOnly
                  ? (viewerReadOnlyReason ?? "Current viewer is read-only.")
                  : undefined
              }
              onClick={() => void handleCompareDrawerAction("pause_weakest")}
            >
              <AlertTriangle
                className="inline-block shrink-0"
                size={13}
                aria-hidden="true"
              />{" "}
              Review weakest
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--adc-pos-fg)] bg-[var(--adc-pos-fg)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--adc-s2)] hover:brightness-95"
              disabled={isViewerReadOnly}
              title={
                isViewerReadOnly
                  ? (viewerReadOnlyReason ?? "Current viewer is read-only.")
                  : undefined
              }
              onClick={() => void handleCompareDrawerAction("scale_strongest")}
            >
              <TrendingUp
                className="inline-block shrink-0"
                size={13}
                aria-hidden="true"
              />{" "}
              Review strongest
            </button>
            <button
              type="button"
              className="inline-flex items-center gap-1 rounded-[6px] border border-[var(--adc-info-bd)] bg-[var(--adc-s2)] px-3 py-1.5 text-[12.5px] font-medium text-[var(--adc-info-fg)] hover:bg-[var(--adc-info-bg)]"
              disabled={isViewerReadOnly}
              title={
                isViewerReadOnly
                  ? (viewerReadOnlyReason ?? "Current viewer is read-only.")
                  : undefined
              }
              onClick={() => void handleCompareDrawerAction("launch_selected")}
            >
              <Rocket
                className="inline-block shrink-0"
                size={13}
                aria-hidden="true"
              />{" "}
              Send selected to Launchpad
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
    </div>
  );
}
