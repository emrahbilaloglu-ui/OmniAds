"use client";

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type CSSProperties,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { usePathname, useRouter, useSearchParams } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Layers,
  RefreshCw,
  Search,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  useDeferState,
  BulkToolbar,
  LaunchpadOverlay,
  LaneHeader,
  PhonePreview,
  PulseStrip,
  TrackingBlockerBanner,
  TrackingConfirmModal,
  computeRangeFromPreset,
  deriveTileFormat,
  deriveTileShape,
  type BulkAction,
  type DateRangeValue,
  type PhonePreviewPlacement,
} from "@/components/common/briefing";
import type { LaunchpadOverlayMode } from "@/components/common/briefing/LaunchpadOverlay";
import type { LaneKey } from "@/components/common/briefing/types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import {
  formatCurrency,
  formatRoas,
  sparklinePath,
} from "@/lib/briefing/utils";
import { useAppStore } from "@/store/app-store";
import { ActionNowCard } from "@/components/creatives/briefing/ActionNowCard";
import {
  ASSET_PRESETS,
  AssetLibrarySection,
  DEFAULT_VISIBLE_METRIC_IDS,
} from "@/components/creatives/briefing/AssetLibrarySection";
import { BulkCutConfirmModal } from "@/components/creatives/briefing/BulkCutConfirmModal";
import { CompareDrawerHost } from "@/components/creatives/briefing/CompareDrawerHost";
import { CreativeEvidenceDrawer } from "@/components/creatives/briefing/CreativeEvidenceDrawer";
import {
  CrossPlacementCard,
  isCrossPlacementRollup,
} from "@/components/creatives/briefing/CrossPlacementCard";
import {
  EMPTY_ACTION_LAUNCH_HREF,
  EmptyActionState,
} from "@/components/creatives/briefing/EmptyActionState";
import { HealthyRow } from "@/components/creatives/briefing/HealthyRow";
import { WatchingCard } from "@/components/creatives/briefing/WatchingCard";
import {
  cardAdset,
  cardId,
  cardName,
  numberOrZero,
} from "@/components/creatives/briefing/card-utils";
import {
  buildCutSuccessToast,
  getCreativeScopeId,
  pauseBriefingCard,
  type BriefingToast,
} from "@/components/creatives/briefing/action-handlers";
import {
  buildLaunchpadBridgeHref,
  buildLaunchpadOverlayItem,
  type LaunchpadBridgeMode,
  type LaunchpadOpenPayload,
} from "@/components/creatives/briefing/launchpad-bridge";
import {
  buildBulkLaunchpadHref,
  pauseBriefingCardsBulk,
  successfulBulkPauseCardIds,
  summarizeBulkPauseFailure,
} from "@/components/creatives/briefing/bulk-actions";
import type {
  BriefingActionItem,
  BriefingAggregateSuppressionTrace,
  BriefingCreativeCard,
  BriefingLaneSummary,
  BriefingRollupItem,
  CreativesBriefingResponse,
  MetaSummaryPulseResponse,
  MetaTrendsBriefingResponse,
} from "@/components/creatives/briefing/types";
import type { AccountDecisionProfile } from "@/lib/creative-decision-engine";
import type { DecisionLabel } from "@/components/common/briefing/types";
import {
  fetchMetaCreatives,
  mapApiRowToUiRow,
  toSharedCreative,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";
import {
  SHARE_METRIC_KEYS,
  type ShareLinkConfig,
  type ShareMetricKey,
} from "@/components/creatives/shareCreativeTypes";
import {
  HtmlDateRangePicker,
  rangeForWindow,
  windowLabel,
  type HtmlDateRangeValue,
  type HtmlDateWindowKey,
} from "@/components/common/briefing/HtmlDateRangePicker";

type LaneCollapseState = Record<
  Extract<LaneKey, "action" | "watching" | "healthy">,
  boolean
>;

interface AssetLibraryPayload {
  rows: MetaCreativeRow[];
  status?: string | null;
  message?: string | null;
}

interface CreativeDataNotice {
  title: string;
  body: string;
}

interface NormalizedActionItem {
  key: string;
  type: "card" | "rollup";
  card?: BriefingCreativeCard;
  rollup?: BriefingRollupItem;
}

export interface LaunchpadOverlayState {
  open: boolean;
  mode: LaunchpadOverlayMode | null;
  card: BriefingCreativeCard | null;
}

interface BulkCutModalState {
  open: boolean;
  cards: BriefingCreativeCard[];
}

interface CompareDrawerState {
  open: boolean;
  cards: BriefingCreativeCard[];
}

type WorkspaceMode = "briefing" | "library";
type CreativeLaneView = "all" | "action" | "watching" | "healthy";
type CreativeActionFilter =
  | "all"
  | "promote"
  | "scale"
  | "cut"
  | "fresh_test"
  | "diagnose"
  | "add_existing";
type CreativeCampaignFilter = "all" | "main" | "test" | "mixed";
type DecisionCenterRowForCard = NonNullable<
  BriefingCreativeCard["decisionCenterRow"]
>;
type DecisionCenterRowMaps = {
  byRowId: Map<string, DecisionCenterRowForCard>;
  byCreativeId: Map<string, DecisionCenterRowForCard>;
};
type DecisionCenterAssetLibraryRow = MetaCreativeRow & {
  decisionCenterRow?: DecisionCenterRowForCard | null;
};

const SPARSE_ACTION_MIN_COUNT = 3;
const SPARSE_ACTION_MIN_WATCHING_COUNT = 10;
const SPARSE_ACTION_MAX_VISIBLE_SHARE = 0.1;

interface EvidenceDrawerState {
  open: boolean;
  card: BriefingCreativeCard | null;
}

interface SectionErrorBoundaryProps {
  title: string;
  resetKey: string;
  children: ReactNode;
}

class SectionErrorBoundary extends Component<
  SectionErrorBoundaryProps,
  { hasError: boolean }
> {
  state = { hasError: false };

  static getDerivedStateFromError() {
    return { hasError: true };
  }

  componentDidUpdate(previousProps: SectionErrorBoundaryProps) {
    if (previousProps.resetKey !== this.props.resetKey && this.state.hasError) {
      this.setState({ hasError: false });
    }
  }

  componentDidCatch(error: Error, info: ErrorInfo) {
    console.error("[creatives-briefing-section-error]", {
      title: this.props.title,
      message: error.message,
      componentStack: info.componentStack,
    });
  }

  render() {
    if (!this.state.hasError) return this.props.children;
    return (
      <section className="mt-8 rounded-xl border border-amber-200 bg-amber-50/70 px-5 py-4 text-[12.5px] text-amber-950">
        <div className="font-semibold">{this.props.title}</div>
        <div className="mt-1 text-amber-900/80">
          This section received an unexpected creative data shape. The rest of
          the briefing remains available.
        </div>
      </section>
    );
  }
}

function CreativeDataSetupNotice({ notice }: { notice: CreativeDataNotice }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 mb-4 flex items-start gap-3">
      <AlertTriangle
        className="text-amber-600 mt-0.5 inline-block shrink-0"
        size={18}
        aria-hidden="true"
      />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-amber-950 leading-snug">
          {notice.title}
        </div>
        <div className="text-[12px] text-amber-900/80 mt-0.5">
          {notice.body}
        </div>
      </div>
    </div>
  );
}

export const CLOSED_LAUNCHPAD_OVERLAY_STATE: LaunchpadOverlayState = {
  open: false,
  mode: null,
  card: null,
};

const CLOSED_BULK_CUT_MODAL_STATE: BulkCutModalState = {
  open: false,
  cards: [],
};

const CLOSED_COMPARE_DRAWER_STATE: CompareDrawerState = {
  open: false,
  cards: [],
};

const CLOSED_EVIDENCE_DRAWER_STATE: EvidenceDrawerState = {
  open: false,
  card: null,
};

function workspaceModeFromTab(value: string | null | undefined): WorkspaceMode {
  return value === "library" ? "library" : "briefing";
}

function creativeLaneFromParam(
  value: string | null | undefined,
): CreativeLaneView | null {
  return value === "all" ||
    value === "action" ||
    value === "watching" ||
    value === "healthy"
    ? value
    : null;
}

function relativeTime(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value).getTime();
  if (!Number.isFinite(parsed)) return null;
  const diffSeconds = Math.max(0, Math.round((Date.now() - parsed) / 1000));
  if (diffSeconds < 5) return "just now";
  if (diffSeconds < 60) return `${diffSeconds}s ago`;
  const diffMinutes = Math.round(diffSeconds / 60);
  if (diffMinutes < 60) return `${diffMinutes}m ago`;
  const diffHours = Math.round(diffMinutes / 60);
  if (diffHours < 24) return `${diffHours}h ago`;
  return `${Math.round(diffHours / 24)}d ago`;
}

export function openLaunchpadOverlayState(
  payload: LaunchpadOpenPayload,
): LaunchpadOverlayState {
  return {
    open: true,
    mode: payload.mode,
    card: payload.card,
  };
}

export function launchpadHrefFromOverlayState(state: LaunchpadOverlayState) {
  if (!state.card || !state.mode) return null;
  return buildLaunchpadBridgeHref(state.card, state.mode);
}

export function filterSelectedIdsForLane(
  selectedIds: Iterable<string>,
  laneIds: Iterable<string>,
) {
  const laneIdSet = new Set(laneIds);
  return Array.from(selectedIds).filter((id) => laneIdSet.has(id));
}

async function fetchJson<T>(path: string): Promise<T> {
  const response = await fetch(path, {
    headers: { Accept: "application/json" },
    cache: "no-store",
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(payload?.message ?? `Request failed (${response.status})`);
  }
  return payload as T;
}

export interface MetaInsightsRefreshResponse {
  ok?: boolean;
  status?: string | null;
  provider?: string | null;
  error?: string | null;
  message?: string | null;
}

export async function requestMetaInsightsRefresh(
  businessId: string,
): Promise<MetaInsightsRefreshResponse> {
  const response = await fetch("/api/sync/refresh", {
    method: "POST",
    headers: {
      Accept: "application/json",
      "Content-Type": "application/json",
    },
    body: JSON.stringify({
      businessId,
      provider: "meta",
    }),
  });
  const payload = (await response.json().catch(() => null)) as
    | MetaInsightsRefreshResponse
    | null;
  if (!response.ok) {
    throw new Error(
      payload?.message ?? payload?.error ?? `Refresh failed (${response.status})`,
    );
  }
  return payload ?? { ok: true, status: "started", provider: "meta" };
}

function metaInsightsRefreshMessage(payload: MetaInsightsRefreshResponse) {
  const status = payload.status ?? "started";
  if (status === "already_running") return "Refresh already running";
  if (status === "processing") return "Refresh processing";
  if (status === "finalized_verified") return "Refresh verified";
  if (status === "blocked") return "Refresh needs operator review";
  return "Refresh queued";
}

type DecisionCenterUiParamState = "truthy" | "falsy" | "unset";

function decisionCenterUiParamState(
  value: string | null | undefined,
): DecisionCenterUiParamState {
  if (value == null) return "unset";
  const normalized = value.trim().toLowerCase();
  if (normalized === "1" || normalized === "true") return "truthy";
  if (
    normalized === "0" ||
    normalized === "false" ||
    normalized === "off" ||
    normalized === "no"
  ) {
    return "falsy";
  }
  return "unset";
}

function resolveDecisionCenterUiParamState(
  params: { get(name: string): string | null } | null | undefined,
): DecisionCenterUiParamState {
  const camel = decisionCenterUiParamState(params?.get("decisionCenter"));
  if (camel !== "unset") return camel;
  return decisionCenterUiParamState(params?.get("decision_center"));
}

export function isDecisionCenterUiEnabled(
  params: { get(name: string): string | null } | null | undefined,
) {
  return resolveDecisionCenterUiParamState(params) !== "falsy";
}

function fetchCreativesBriefing(
  businessId: string,
  options: { decisionCenterEnabled?: boolean } = {},
): Promise<CreativesBriefingResponse> {
  const params = new URLSearchParams({ businessId });
  if (options.decisionCenterEnabled === false) {
    params.set("decisionCenter", "0");
  }
  return fetchJson<CreativesBriefingResponse>(
    `/api/creatives/briefing?${params.toString()}`,
  );
}

function fetchMetaSummary(
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<MetaSummaryPulseResponse> {
  const params = new URLSearchParams({ businessId, startDate, endDate });
  return fetchJson<MetaSummaryPulseResponse>(
    `/api/meta/summary?${params.toString()}`,
  );
}

function fetchMetaStatus(businessId: string): Promise<MetaStatusResponse> {
  const params = new URLSearchParams({ businessId });
  return fetchJson<MetaStatusResponse>(`/api/meta/status?${params.toString()}`);
}

function fetchMetaTrends(
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<MetaTrendsBriefingResponse> {
  const params = new URLSearchParams({ businessId, startDate, endDate });
  return fetchJson<MetaTrendsBriefingResponse>(
    `/api/meta/trends?${params.toString()}`,
  );
}

async function fetchAssetLibraryRows(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<AssetLibraryPayload> {
  const response = await fetchMetaCreatives({
    businessId: input.businessId,
    start: input.startDate,
    end: input.endDate,
    groupBy: "creative",
    format: "all",
    sort: "spend",
    mediaMode: "full",
  });
  return {
    rows: response.rows.map(mapApiRowToUiRow),
    status: response.status ?? "ok",
    message: response.message ?? null,
  };
}

function getTodayIsoForTimeZone(timeZone: string) {
  try {
    const parts = new Intl.DateTimeFormat("en-CA", {
      timeZone,
      year: "numeric",
      month: "2-digit",
      day: "2-digit",
    }).formatToParts(new Date());
    const year = parts.find((part) => part.type === "year")?.value ?? "1970";
    const month = parts.find((part) => part.type === "month")?.value ?? "01";
    const day = parts.find((part) => part.type === "day")?.value ?? "01";
    return `${year}-${month}-${day}`;
  } catch {
    return new Date().toISOString().slice(0, 10);
  }
}

function addDaysToIso(value: string, days: number) {
  const date = new Date(`${value}T00:00:00.000Z`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString().slice(0, 10);
}

function formatTodayLabel() {
  return new Date().toLocaleDateString("en-US", {
    month: "short",
    day: "numeric",
    year: "numeric",
  });
}

function formatProfileNumber(value: number | null | undefined) {
  return typeof value === "number" && Number.isFinite(value)
    ? value.toLocaleString(undefined, { maximumFractionDigits: 2 })
    : "n/a";
}

function CreativeEngineProfileStrip({
  profile,
  dataSource,
  asOf,
}: {
  profile?: AccountDecisionProfile | null;
  dataSource?: string | null;
  asOf?: string | null;
}) {
  if (!profile) return null;
  const hardActions =
    [
      profile.hardActionEligibility.scale ? "scale" : null,
      profile.hardActionEligibility.cut ? "cut" : null,
      profile.hardActionEligibility.refresh ? "refresh" : null,
    ]
      .filter(Boolean)
      .join(", ") || "review only";
  const quality = [
    profile.quality.commercialTruthReady ? "truth ready" : "truth missing",
    profile.quality.calibrationReady ? "calibration ready" : "calibration thin",
    typeof profile.accountBaselines.winnerPurchaseP50 === "number" &&
    Number.isFinite(profile.accountBaselines.winnerPurchaseP50) &&
    profile.accountBaselines.winnerPurchaseP50 > 0
      ? "scale benchmark ready"
      : "scale benchmark missing",
  ].join(" / ");

  return (
    <div
      className="mb-4 rounded-xl border border-neutral-200 bg-white px-4 py-3"
      data-creative-engine-profile-strip
    >
      <div className="flex flex-wrap items-center gap-2 text-[12px] text-neutral-600">
        <ShieldCheck
          className="inline-block shrink-0 text-neutral-500"
          size={14}
          aria-hidden="true"
        />
        <span className="font-semibold text-neutral-900">Engine profile</span>
        <span className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-600">
          {profile.scope.type}:{profile.scope.id}
        </span>
        <span className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-600">
          preset {profile.preset}
        </span>
        {dataSource ? (
          <span className="rounded-md border border-neutral-200 bg-neutral-50 px-1.5 py-0.5 text-[10.5px] font-medium text-neutral-600">
            {dataSource}
          </span>
        ) : null}
        {asOf ? (
          <span className="text-[11px] text-neutral-400">as of {asOf}</span>
        ) : null}
      </div>
      <div className="mt-2 grid gap-2 text-[11.5px] text-neutral-600 md:grid-cols-5">
        <div>
          <span className="text-neutral-400">Hard actions</span>
          <div className="font-medium text-neutral-900">{hardActions}</div>
        </div>
        <div>
          <span className="text-neutral-400">Scale floor</span>
          <div className="font-mono text-neutral-900">
            {profile.thresholds.scaleMinPurchases} purch · P50{" "}
            {formatProfileNumber(profile.accountBaselines.winnerPurchaseP50)}
          </div>
        </div>
        <div>
          <span className="text-neutral-400">Target / break-even ROAS</span>
          <div className="font-mono text-neutral-900">
            {formatProfileNumber(profile.spendUnitEvidence.targetRoas)} /{" "}
            {formatProfileNumber(profile.spendUnitEvidence.breakEvenRoas)}
          </div>
        </div>
        <div>
          <span className="text-neutral-400">Mature creatives</span>
          <div className="font-mono text-neutral-900">
            {profile.accountBaselines.matureCreativeCount}
          </div>
        </div>
        <div>
          <span className="text-neutral-400">Quality</span>
          <div className="font-medium text-neutral-900">{quality}</div>
        </div>
      </div>
      {profile.scope.fallbackReason ? (
        <div className="mt-2 text-[11.5px] text-amber-700">
          Scope fallback: {profile.scope.fallbackReason.replace(/_/g, " ")}
        </div>
      ) : null}
    </div>
  );
}

function isCardRollup(card: BriefingCreativeCard) {
  return Array.isArray(card.placementList) && card.placementList.length > 1;
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value)
    ? value.filter((item): item is T =>
        Boolean(item && typeof item === "object"),
      )
    : [];
}

function safeDecisionCenterRows(
  snapshot: CreativesBriefingResponse["decisionCenter"],
): DecisionCenterRowForCard[] {
  return Array.isArray(snapshot?.rowDecisions)
    ? snapshot.rowDecisions.filter((row): row is DecisionCenterRowForCard =>
        Boolean(row && typeof row === "object"),
      )
    : [];
}

function isDecisionCenterSnapshotObject(
  snapshot: CreativesBriefingResponse["decisionCenter"],
): snapshot is NonNullable<CreativesBriefingResponse["decisionCenter"]> {
  return Boolean(
    snapshot && typeof snapshot === "object" && !Array.isArray(snapshot),
  );
}

function normalizedDecisionCenterKey(value: string | null | undefined) {
  const trimmed = value?.trim();
  return trimmed ? trimmed : null;
}

function decisionCenterRowMaps(
  snapshot: CreativesBriefingResponse["decisionCenter"],
): DecisionCenterRowMaps {
  const byRowId = new Map<string, DecisionCenterRowForCard>();
  const byCreativeId = new Map<string, DecisionCenterRowForCard>();
  for (const row of safeDecisionCenterRows(snapshot)) {
    const rowId = normalizedDecisionCenterKey(row.rowId);
    const creativeId = normalizedDecisionCenterKey(row.creativeId);
    if (rowId && !byRowId.has(rowId)) byRowId.set(rowId, row);
    if (creativeId && !byCreativeId.has(creativeId)) {
      byCreativeId.set(creativeId, row);
    }
  }
  return { byRowId, byCreativeId };
}

function attachDecisionCenterRowToCard<T extends BriefingCreativeCard>(
  card: T,
  maps: DecisionCenterRowMaps,
): T {
  const rowId = normalizedDecisionCenterKey(card.id);
  const creativeId =
    normalizedDecisionCenterKey(card.creativeId) ??
    normalizedDecisionCenterKey(card.id);
  const decisionCenterRow =
    (rowId ? maps.byRowId.get(rowId) : undefined) ??
    (creativeId ? maps.byCreativeId.get(creativeId) : undefined);

  return decisionCenterRow ? { ...card, decisionCenterRow } : card;
}

export function attachDecisionCenterRowsToAssetLibraryRows(
  rows: MetaCreativeRow[],
  snapshot: CreativesBriefingResponse["decisionCenter"],
  enabled: boolean,
): MetaCreativeRow[] {
  if (!enabled || !isDecisionCenterSnapshotObject(snapshot)) return rows;
  const maps = decisionCenterRowMaps(snapshot);
  return rows.map((row): DecisionCenterAssetLibraryRow => {
    const rowId = normalizedDecisionCenterKey(row.id);
    const creativeId = normalizedDecisionCenterKey(row.creativeId);
    const decisionCenterRow =
      (rowId ? maps.byRowId.get(rowId) : undefined) ??
      (creativeId ? maps.byCreativeId.get(creativeId) : undefined);
    return decisionCenterRow ? { ...row, decisionCenterRow } : row;
  });
}

function isBriefingRollupItem(item: BriefingActionItem): item is BriefingRollupItem {
  return Boolean(
    item &&
      typeof item === "object" &&
      "primaryRec" in item &&
      (item as BriefingRollupItem).primaryRec,
  );
}

function attachDecisionCenterRowToActionItem(
  item: BriefingActionItem,
  maps: DecisionCenterRowMaps,
): BriefingActionItem {
  if (!isBriefingRollupItem(item)) {
    return attachDecisionCenterRowToCard(item, maps);
  }
  return {
    ...item,
    primaryRec: attachDecisionCenterRowToCard(item.primaryRec, maps),
  };
}

export function normalizeSpendHistory(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .map((item) =>
      typeof item === "number"
        ? item
        : typeof item === "string"
          ? Number(item)
          : Number.NaN,
    )
    .filter((item) => Number.isFinite(item));
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCreativesBriefingPayload(
  payload: CreativesBriefingResponse | null | undefined,
): CreativesBriefingResponse | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const rowMaps = decisionCenterRowMaps(payload.decisionCenter);
  const pulse =
    payload.pulse &&
    typeof payload.pulse === "object" &&
    !Array.isArray(payload.pulse)
      ? {
          ...payload.pulse,
          spendHistory: normalizeSpendHistory(payload.pulse.spendHistory),
        }
      : null;

  return {
    ...payload,
    actionNow: safeArray<BriefingActionItem>(payload.actionNow).map((item) =>
      attachDecisionCenterRowToActionItem(item, rowMaps),
    ),
    watching: safeArray<BriefingCreativeCard>(payload.watching).map((card) =>
      attachDecisionCenterRowToCard(card, rowMaps),
    ),
    healthy: safeArray<BriefingCreativeCard>(payload.healthy).map((card) =>
      attachDecisionCenterRowToCard(card, rowMaps),
    ),
    pulse,
  };
}

export function getCreativeDataSetupNotice(input: {
  metaStatus?: MetaStatusResponse | null;
  assetLibraryStatus?: string | null;
}): CreativeDataNotice | null {
  const { metaStatus, assetLibraryStatus } = input;
  const assignedAccountCount = metaStatus?.assignedAccountIds?.length;

  if (
    metaStatus?.state === "connected_no_assignment" ||
    assetLibraryStatus === "no_accounts_assigned" ||
    (metaStatus?.connected === true && assignedAccountCount === 0)
  ) {
    return {
      title: "Meta ad account assignment is missing.",
      body: "Meta is connected for this workspace, but no Meta ad account is assigned. Assign an ad account to load creative briefing and Asset Library data.",
    };
  }

  if (
    metaStatus?.state === "not_connected" ||
    metaStatus?.connected === false ||
    assetLibraryStatus === "no_connection"
  ) {
    return {
      title: "Meta is not connected.",
      body: "Connect Meta for this workspace before creative briefing and Asset Library data can load.",
    };
  }

  if (assetLibraryStatus === "no_access_token") {
    return {
      title: "Meta needs to be reconnected.",
      body: "The Meta connection is missing an access token. Reconnect Meta to load creative data.",
    };
  }

  return null;
}

export function getAssetLibraryEmptyMessage(input: {
  status?: string | null;
  message?: string | null;
}) {
  if (input.status === "no_accounts_assigned") {
    return "No Meta ad account is assigned to this workspace. Assign a Meta account to load creative data.";
  }
  if (input.status === "no_connection") {
    return "Meta is not connected for this workspace.";
  }
  if (input.status === "no_access_token") {
    return "Meta connection is missing an access token. Reconnect Meta to load creative data.";
  }
  return (
    input.message || "No Meta creative rows were found for the selected window."
  );
}

function supportedShareMetrics(metricIds: string[]): ShareMetricKey[] {
  const allowed = new Set<string>(SHARE_METRIC_KEYS);
  const selected = metricIds.filter((metricId): metricId is ShareMetricKey => allowed.has(metricId));
  return selected.length > 0 ? selected : ["spend", "roas", "cpa", "ctrAll"];
}

function creativeDateRangeFromParams(params: URLSearchParams | null, todayIso: string): HtmlDateRangeValue {
  const rawWindow = params?.get("window");
  const windowKey: HtmlDateWindowKey =
    rawWindow === "7d" || rawWindow === "14d" || rawWindow === "28d" || rawWindow === "90d"
      ? rawWindow
      : rawWindow === "today" || rawWindow === "yesterday" || rawWindow === "this_month" || rawWindow === "last_month" || rawWindow === "custom"
        ? rawWindow
        : "14d";
  if (windowKey === "custom") {
    const start = params?.get("start") ?? "";
    const end = params?.get("end") ?? "";
    if (/^\d{4}-\d{2}-\d{2}$/.test(start) && /^\d{4}-\d{2}-\d{2}$/.test(end)) {
      return { window: "custom", start, end };
    }
  }
  return rangeForWindow(windowKey, new Date(`${todayIso}T00:00:00`));
}

function assetMetricIdsFromPresetParam(value: string | null | undefined) {
  const preset = ASSET_PRESETS.find((item) => item.id === value);
  return preset ? preset.metricIds : DEFAULT_VISIBLE_METRIC_IDS;
}

// Action filtering reads the server-supplied decisionCenter row (buyerAction /
// executionAction enums) when present; the legacy substring match over
// card.primary/card.label remains only as fallback for cards without a
// decisionCenter row. The UI never derives buyerAction itself.
export function cardMatchesActionFilter(
  card: BriefingCreativeCard,
  actionFilter: CreativeActionFilter,
): boolean {
  if (actionFilter === "all") return true;
  const row = card.decisionCenterRow;
  // add_existing is a launchpad workflow action with no decision-center
  // equivalent, so it always uses the legacy card-kind match below.
  if (row && actionFilter !== "add_existing") {
    if (actionFilter === "promote") {
      return row.executionAction === "promote_to_main";
    }
    switch (row.buyerAction) {
      case "scale":
        return actionFilter === "scale";
      case "cut":
        return actionFilter === "cut";
      case "refresh":
      case "test_more":
      case "watch_launch":
        // refresh maps to the Fresh-test chip like the legacy
        // "Launch fresh test" CTA did.
        return actionFilter === "fresh_test";
      default:
        // Blocked cuts surface as diagnose_data rows but the server marks
        // the blocked action; legacy showed them under the Cut chip
        // ("Cut review") and the Cut chip keeps that. Everything else in
        // the default arm (protect / fix_delivery / fix_policy / unblocked
        // diagnose_data) previously had no chip at all - the Diagnose chip
        // gives those rows a home.
        if (actionFilter === "cut") return card.blockedActionType === "cut";
        return actionFilter === "diagnose";
    }
  }
  const kind = String(card.primary?.kind ?? card.label ?? "").toLowerCase();
  const label = String(card.primary?.label ?? card.label ?? "").toLowerCase();
  return actionFilter === "promote"
    ? kind.includes("promote") || label.includes("promote")
    : actionFilter === "scale"
      ? kind.includes("scale") || label.includes("scale")
      : actionFilter === "cut"
        ? kind.includes("cut") || label.includes("cut") || kind.includes("pause")
        : actionFilter === "fresh_test"
          ? kind.includes("fresh") || kind.includes("test") || label.includes("fresh")
          : actionFilter === "diagnose"
            ? kind.includes("diagnose") || kind.includes("fix") || kind.includes("review") || label.includes("diagnose") || label.includes("fix")
            : kind.includes("existing") || label.includes("existing");
}

function cardMatchesCreativeFilters(card: BriefingCreativeCard, input: {
  actionFilter: CreativeActionFilter;
  campaignFilter: CreativeCampaignFilter;
  search: string;
}) {
  if (!cardMatchesActionFilter(card, input.actionFilter)) return false;
  if (input.campaignFilter !== "all" && card.campaignKind !== input.campaignFilter) return false;
  const search = input.search.trim().toLowerCase();
  if (!search) return true;
  return [card.name, card.creativeName, card.campaign, card.campaignName, card.adset, card.adsetName]
    .some((value) => typeof value === "string" && value.toLowerCase().includes(search));
}

export function chooseDefaultCreativeLane(input: {
  actionCount: number;
  watchingCount: number;
  healthyCount: number;
}): CreativeLaneView {
  const total = input.actionCount + input.watchingCount + input.healthyCount;
  const actionShare = total > 0 ? input.actionCount / total : 0;
  const sparseActionCount = Math.max(
    SPARSE_ACTION_MIN_COUNT,
    Math.ceil(total * SPARSE_ACTION_MAX_VISIBLE_SHARE),
  );
  if (
    input.actionCount > 0 &&
    input.actionCount < sparseActionCount &&
    input.watchingCount >= SPARSE_ACTION_MIN_WATCHING_COUNT &&
    actionShare <= SPARSE_ACTION_MAX_VISIBLE_SHARE
  ) {
    return "watching";
  }
  return "action";
}

export function decisionVisibilitySummary(input: {
  actionCount: number;
  watchingCount: number;
  healthyCount: number;
  activeLane: CreativeLaneView;
}) {
  const total = input.actionCount + input.watchingCount + input.healthyCount;
  const activeCount =
    input.activeLane === "all"
      ? total
      : input.activeLane === "action"
      ? input.actionCount
      : input.activeLane === "watching"
        ? input.watchingCount
        : input.healthyCount;
  const visibleShare = total > 0 ? activeCount / total : 0;
  const actionShare = total > 0 ? input.actionCount / total : 0;
  const sparseActionThreshold = Math.max(
    SPARSE_ACTION_MIN_COUNT,
    Math.ceil(total * SPARSE_ACTION_MAX_VISIBLE_SHARE),
  );
  return {
    total,
    activeCount,
    visibleShare,
    actionShare,
    sparseActionThreshold,
    isSparseActionDefault:
      input.activeLane === "watching" &&
      input.actionCount > 0 &&
      input.actionCount < sparseActionThreshold &&
      input.watchingCount >= SPARSE_ACTION_MIN_WATCHING_COUNT,
  };
}

function briefingCardFromAssetRow(row: MetaCreativeRow): BriefingCreativeCard {
  const engineLabel = (row as MetaCreativeRow & { engineLabel?: string | null }).engineLabel;
  return {
    id: row.id,
    creativeId: row.creativeId,
    realAdId: row.realAdId,
    accountId: row.accountId,
    name: row.name,
    campaign: row.campaignName,
    campaignName: row.campaignName,
    adset: row.adSetName,
    adsetName: row.adSetName,
    label: (engineLabel as DecisionLabel | string | null) ?? "keep",
    confidence: null,
    reason: "Selected from Asset Library.",
    spend: row.spend,
    roas: row.roas,
    ctr: row.ctrAll,
    cpa: row.cpa,
    purchases: row.purchases,
    impressions: row.impressions,
    linkClicks: row.linkClicks,
    addToCart: row.addToCart,
    frequency: row.frequency,
    fatigue: Array.isArray(row.tags) ? row.tags.some((tag) => String(tag).toLowerCase().includes("fatigue")) : false,
    primary: { kind: "promote", label: "Send to Launchpad" },
    status: row.effectiveStatus,
    campaignLabelStatus: "labeled",
    mediaPreviewUrl: row.cardPreviewUrl ?? row.imageUrl ?? row.previewUrl ?? row.thumbnailUrl ?? null,
    thumbnailUrl: row.thumbnailUrl ?? null,
    tableThumbnailUrl: row.tableThumbnailUrl ?? row.thumbnailUrl ?? null,
    cardPreviewUrl: row.cardPreviewUrl ?? row.imageUrl ?? row.thumbnailUrl ?? row.previewUrl ?? null,
    previewUrl: row.previewUrl ?? null,
    imageUrl: row.imageUrl ?? null,
    cachedThumbnailUrl: row.cachedThumbnailUrl ?? null,
    preview: row.preview ?? null,
    previewState: row.previewState ?? null,
    isCatalog: row.isCatalog ?? null,
    format: row.format ?? null,
  };
}

function normalizeActionItems(items: unknown): NormalizedActionItem[] {
  return safeArray<BriefingActionItem>(items).flatMap<NormalizedActionItem>(
    (item, index) => {
      if (
        isCrossPlacementRollup(item) &&
        item.primaryRec &&
        typeof item.primaryRec === "object"
      ) {
        const key = item.id || item.primaryRec.id || `rollup-${index}`;
        return [{ key, type: "rollup", rollup: item }];
      }

      const card = item as BriefingCreativeCard;
      if (isCardRollup(card)) {
        const placementList = Array.isArray(card.placementList)
          ? card.placementList
          : [];
        return [
          {
            key: cardId(card),
            type: "rollup",
            rollup: {
              id: cardId(card),
              primaryRec: card,
              placementList,
              mixed: card.mixed,
            },
          },
        ];
      }

      return [{ key: cardId(card), type: "card", card }];
    },
  );
}

export function actionItemId(item: NormalizedActionItem) {
  if (item.type === "rollup") {
    return item.rollup?.primaryRec.id || item.rollup?.id || item.key;
  }
  return item.card ? cardId(item.card) : item.key;
}

export function filterRemovedActionItems(
  items: NormalizedActionItem[],
  removedIds: Iterable<string>,
) {
  const removed = new Set(removedIds);
  return items.filter((item) => !removed.has(actionItemId(item)));
}

export function briefingCardForActionItem(
  item: NormalizedActionItem,
): BriefingCreativeCard | null {
  if (item.type === "card") return item.card ?? null;
  if (!item.rollup) return null;
  const placementList = item.rollup.placementList ?? [];
  return {
    ...item.rollup.primaryRec,
    id: item.rollup.primaryRec.id || item.rollup.id || item.key,
    placementList,
    placements: placementList.length,
    mixed: item.rollup.mixed,
  };
}

export function selectedCardsForActionItems(
  items: NormalizedActionItem[],
  selectedIds: Iterable<string>,
) {
  const selected = new Set(selectedIds);
  return items
    .filter((item) => selected.has(actionItemId(item)))
    .map(briefingCardForActionItem)
    .filter((card): card is BriefingCreativeCard => Boolean(card));
}

export function selectedCardsForCards(
  items: BriefingCreativeCard[],
  selectedIds: Iterable<string>,
) {
  const selected = new Set(selectedIds);
  return items.filter((card) => selected.has(cardId(card)));
}

function usePersistentSelectedIds(businessId: string) {
  const [selectedIds, setSelectedIds] = useState<string[]>([]);
  const [ready, setReady] = useState(false);
  const storageKey = `creatives-briefing-selected:${businessId}`;

  useEffect(() => {
    setReady(false);
    if (!businessId || typeof window === "undefined") {
      setSelectedIds([]);
      setReady(true);
      return;
    }

    const raw = window.localStorage.getItem(storageKey);
    try {
      setSelectedIds(raw ? (JSON.parse(raw) as string[]) : []);
    } catch {
      setSelectedIds([]);
    }
    setReady(true);
  }, [businessId, storageKey]);

  useEffect(() => {
    if (!ready || !businessId || typeof window === "undefined") return;
    window.localStorage.setItem(storageKey, JSON.stringify(selectedIds));
  }, [businessId, ready, selectedIds, storageKey]);

  return [selectedIds, setSelectedIds] as const;
}

function CreativeLaneTab({
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
    <button type="button" className={["tab", className, active ? "active" : ""].filter(Boolean).join(" ")} onClick={onClick}>
      {label} <span className="count">{count}</span>
    </button>
  );
}

function LaneSummaryHeader({
  summary,
}: {
  summary?: BriefingLaneSummary | null;
}) {
  if (!summary) return null;
  const watching = summary.watching;
  return (
    <div
      className="mt-3 flex flex-wrap items-center gap-2 text-[11.5px] text-neutral-500"
      data-creative-lane-summary
    >
      <span className="font-semibold text-neutral-700">
        Server lane summary
      </span>
      <span className="chip chip--ghost">Action {summary.actionNow}</span>
      <span className="chip chip--ghost">Watching {watching.total}</span>
      <span className="chip chip--ghost">Healthy {summary.healthy}</span>
      <span className="chip chip--ghost">Deferred {summary.deferred}</span>
      {watching.total > 0 ? (
        <>
          <span className="text-neutral-300">·</span>
          <span>
            Near action {watching.nearAction}, test maturing{" "}
            {watching.testMaturing}, diagnostic {watching.diagnostic}, labels{" "}
            {watching.waitingOnLabels}
          </span>
        </>
      ) : null}
    </div>
  );
}

function AggregateSuppressionNotice({
  trace,
}: {
  trace?: BriefingAggregateSuppressionTrace | null;
}) {
  const suppressed = trace?.suppressed ?? [];
  if (suppressed.length === 0) return null;
  return (
    <div
      className="mt-3 rounded-lg border border-neutral-200 bg-white px-3 py-2 text-[12px] text-neutral-600"
      data-aggregate-suppression-trace
    >
      <div className="font-semibold text-neutral-800">
        Aggregate decisions not available
      </div>
      <div className="mt-1 flex flex-wrap gap-2">
        {suppressed.slice(0, 4).map((item, index) => (
          <span
            key={`${item.action}-${index}`}
            className="chip chip--ghost"
            title={[
              ...item.missingRequiredData,
              ...item.candidateMissingData,
            ].join(", ")}
          >
            {item.action.replace(/_/g, " ")}: {item.reason.replace(/_/g, " ")}
          </span>
        ))}
      </div>
    </div>
  );
}

function watchingBucketLabel(value: BriefingCreativeCard["watchingSubBucket"]) {
  if (value === "near_action") return "Near action";
  if (value === "test_maturing") return "Test maturing";
  if (value === "diagnostic") return "Diagnostic";
  if (value === "waiting_on_labels") return "Waiting on labels";
  return "Other watching";
}

function laneGroupTitle(lane: CreativeLaneView) {
  if (lane === "action") return "Action Now";
  if (lane === "watching") return "Watching";
  if (lane === "healthy") return "Healthy";
  return "All decisions";
}

function CreativePulseFinal({
  spendToday,
  conversions,
  roas7d,
  roas7dHistory,
  roasTarget,
  topCreative,
  profile,
  trackingAnomalyActive,
  engineVersion,
  refreshStatus,
  refreshMessage,
  onRefreshInsights,
}: {
  spendToday?: number | null;
  conversions?: number | null;
  roas7d?: number | null;
  roas7dHistory?: Array<{ roas?: number | null }> | null;
  roasTarget?: number | null;
  topCreative?: BriefingCreativeCard | null;
  profile?: AccountDecisionProfile | null;
  trackingAnomalyActive: boolean;
  engineVersion?: string | null;
  refreshStatus: "idle" | "running" | "queued" | "error";
  refreshMessage?: string | null;
  onRefreshInsights: () => void;
}) {
  const roas = numberOrZero(roas7d);
  const target = numberOrZero(roasTarget) || roas || 1;
  const sparkValues = Array.isArray(roas7dHistory)
    ? roas7dHistory
        .map((point) => numberOrZero(point?.roas))
        .filter((value) => Number.isFinite(value))
    : [];
  const topName = topCreative ? cardName(topCreative) : "—";
  const topContext = topCreative
    ? (topCreative.bestPlacement ?? cardAdset(topCreative) ?? topCreative.status ?? "active")
    : "—";
  const labelStatus = trackingAnomalyActive ? "Action gated" : "Meta connected";
  const profileLabel = profile
    ? `${profile.accountBaselines.matureCreativeCount} mature · ${profile.preset}`
    : "Account profile";
  const refreshBusy = refreshStatus === "running";
  const refreshChipClass =
    refreshStatus === "error"
      ? "chip chip--action"
      : refreshStatus === "queued"
        ? "chip chip--healthy"
        : "chip";
  const refreshChipLabel =
    refreshMessage ??
    (refreshBusy ? "queueing" : "ad insights pipeline");

  return (
    <div className="pulse">
      <div className="cell">
        <div className="label"><span>Spend · today</span><span>vs 7d avg</span></div>
        <div className="value">{formatCurrency(spendToday)} <span className="sub">{conversions == null ? "" : `${conversions} conv`}</span></div>
        <div className="micro">conversions · {conversions ?? "—"}</div>
      </div>
      <div className="cell">
        <div className="label"><span>ROAS · 7d</span><span style={{ color: "var(--ok)" }}>{roas >= target ? "↑" : "↓"}</span></div>
        <div className="value">{formatRoas(roas)} <span className="sub">tgt {formatRoas(target)}</span></div>
        <svg className="spark" viewBox="0 0 60 16" preserveAspectRatio="none" aria-hidden="true">
          {sparkValues.length >= 2 ? (
            <path d={sparklinePath(sparkValues)} fill="none" stroke="#047857" strokeWidth="1.8" strokeLinecap="round" />
          ) : null}
        </svg>
      </div>
      <div className="cell">
        <div className="label"><span>Top creative · 7d</span><span style={{ color: "var(--ok)" }}>▲ winning</span></div>
        <div className="value" style={{ fontSize: 14 }}>{topName}</div>
        <div className="micro">ROAS <b>{formatRoas(topCreative?.roas)}</b> · spend {formatCurrency(topCreative?.spend)} · {topContext}</div>
      </div>
      <div className="cell">
        <div className="label"><span>Account profile</span><span className="chip chip--info" style={{ height: 16, padding: "0 6px", fontSize: 9.5 }}><span className="dot" />scoped</span></div>
        <div className="value" style={{ fontSize: 14 }}>{profileLabel}</div>
        <div className="micro">scale floor · {profile?.thresholds.scaleMinPurchases ?? "—"} purchases / 7d</div>
      </div>
      <div className="cell">
        <div className="label"><span>Parent labels</span><span className="chip chip--healthy" style={{ height: 16, padding: "0 6px", fontSize: 9.5 }}><span className="dot" />server</span></div>
        <div className="value" style={{ fontSize: 14 }}>{labelStatus}</div>
        <div className="micro">{trackingAnomalyActive ? "tracking confirmation required" : "briefing payload active"}</div>
      </div>
      <div className="cell">
        <div className="label">
          <span>Insights data</span>
          <span className="chip" style={{ height: 16, padding: "0 6px", fontSize: 9.5 }}>
            <span className="dot" />read-only
          </span>
        </div>
        <button
          type="button"
          className="btn btn--ghost"
          style={{ justifyContent: "center", marginTop: 6, width: "100%" }}
          disabled={refreshBusy}
          onClick={onRefreshInsights}
        >
          <RefreshCw
            className={`inline-block shrink-0 ${refreshBusy ? "animate-spin" : ""}`}
            size={14}
            aria-hidden="true"
          />
          {refreshBusy ? "Refreshing..." : "Refresh insights"}
        </button>
        <div className="status-row">
          <span className={refreshChipClass}><span className="dot" />{refreshChipLabel}</span>
          <span className="chip"><span className="dot" />{engineVersion ?? "engine"}</span>
        </div>
      </div>
    </div>
  );
}

export function CreativesBriefingPage() {
  const router = useRouter();
  const pathname = usePathname();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const activeBusiness =
    businesses.find((business) => business.id === selectedBusinessId) ?? null;
  const businessId = selectedBusinessId ?? "";
  const todayIso = useMemo(
    () => getTodayIsoForTimeZone(activeBusiness?.timezone ?? "UTC"),
    [activeBusiness?.timezone],
  );
  const [dateRange, setDateRange] = useState<HtmlDateRangeValue>(() =>
    creativeDateRangeFromParams(searchParams, todayIso),
  );
  const sevenDayStart = useMemo(() => addDaysToIso(todayIso, -6), [todayIso]);
  const libraryStart = dateRange.start;
  const libraryEnd = dateRange.end;
  const tabParam = searchParams?.get("tab") ?? null;
  const laneParam = searchParams?.get("lane") ?? null;
  const decisionCenterUiEnabled = useMemo(
    () => isDecisionCenterUiEnabled(searchParams),
    [searchParams],
  );
  const [workspaceMode, setWorkspaceMode] = useState<WorkspaceMode>(
    workspaceModeFromTab(tabParam),
  );
  const [manualActiveLane, setManualActiveLane] =
    useState<CreativeLaneView | null>(() => creativeLaneFromParam(laneParam));
  const [actionFilter, setActionFilter] = useState<CreativeActionFilter>("all");
  const [campaignFilter, setCampaignFilter] = useState<CreativeCampaignFilter>("all");
  const [briefingSearch, setBriefingSearch] = useState("");

  const briefingQuery = useQuery({
    queryKey: ["creatives-briefing", businessId, decisionCenterUiEnabled],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    queryFn: () =>
      fetchCreativesBriefing(businessId, {
        decisionCenterEnabled: decisionCenterUiEnabled,
      }),
  });
  const todaySummaryQuery = useQuery({
    queryKey: ["creatives-briefing-meta-summary-today", businessId, todayIso],
    enabled: Boolean(businessId),
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaSummary(businessId, todayIso, todayIso),
  });
  const sevenDaySummaryQuery = useQuery({
    queryKey: [
      "creatives-briefing-meta-summary-7d",
      businessId,
      sevenDayStart,
      todayIso,
    ],
    enabled: Boolean(businessId),
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaSummary(businessId, sevenDayStart, todayIso),
  });
  const sevenDayTrendsQuery = useQuery({
    queryKey: [
      "creatives-briefing-meta-trends-7d",
      businessId,
      sevenDayStart,
      todayIso,
    ],
    enabled: Boolean(businessId),
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaTrends(businessId, sevenDayStart, todayIso),
  });
  const metaStatusQuery = useQuery({
    queryKey: ["creatives-briefing-meta-status", businessId],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    queryFn: () => fetchMetaStatus(businessId),
  });
  const assetLibraryQuery = useQuery({
    queryKey: [
      "creatives-briefing-asset-library",
      businessId,
      libraryStart,
      libraryEnd,
    ],
    enabled: Boolean(businessId),
    staleTime: 60 * 1000,
    queryFn: () =>
      fetchAssetLibraryRows({
        businessId,
        startDate: libraryStart,
        endDate: libraryEnd,
      }),
  });

  const [collapsed, setCollapsed] = useState<LaneCollapseState>({
    action: false,
    watching: true,
    healthy: true,
  });
  const [toast, setToast] = useState<BriefingToast | null>(null);
  const [cuttingIds, setCuttingIds] = useState<Set<string>>(new Set());
  const [cutPendingIds, setCutPendingIds] = useState<Set<string>>(new Set());
  const [bulkPendingIds, setBulkPendingIds] = useState<Set<string>>(new Set());
  const [removedActionIds, setRemovedActionIds] = useState<Set<string>>(
    new Set(),
  );
  const [launchpadOverlayState, setLaunchpadOverlayState] =
    useState<LaunchpadOverlayState>(CLOSED_LAUNCHPAD_OVERLAY_STATE);
  const [bulkCutModalState, setBulkCutModalState] = useState<BulkCutModalState>(
    CLOSED_BULK_CUT_MODAL_STATE,
  );
  const [compareDrawerState, setCompareDrawerState] =
    useState<CompareDrawerState>(CLOSED_COMPARE_DRAWER_STATE);
  const [evidenceDrawerState, setEvidenceDrawerState] =
    useState<EvidenceDrawerState>(CLOSED_EVIDENCE_DRAWER_STATE);
  const [insightsRefreshState, setInsightsRefreshState] = useState<{
    status: "idle" | "running" | "queued" | "error";
    message: string | null;
  }>({ status: "idle", message: null });
  const [trackingCutCard, setTrackingCutCard] =
    useState<BriefingCreativeCard | null>(null);
  const [librarySelectedRowIds, setLibrarySelectedRowIds] = useState<string[]>(
    [],
  );
  const [libraryHighlightedRowId, setLibraryHighlightedRowId] = useState<
    string | null
  >(null);
  const presetParam = searchParams?.get("preset") ?? null;
  const [libraryMetricIds, setLibraryMetricIds] = useState<string[]>(() =>
    assetMetricIdsFromPresetParam(presetParam),
  );
  const [selectedIds, setSelectedIds] = usePersistentSelectedIds(businessId);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
  useEffect(() => {
    setWorkspaceMode(workspaceModeFromTab(tabParam));
  }, [tabParam]);
  useEffect(() => {
    setManualActiveLane(creativeLaneFromParam(laneParam));
  }, [laneParam]);
  useEffect(() => {
    if (!presetParam) return;
    setLibraryMetricIds(assetMetricIdsFromPresetParam(presetParam));
  }, [presetParam]);
  useEffect(() => {
    setManualActiveLane(null);
  }, [businessId]);
  const showToast = useCallback((nextToast: BriefingToast) => {
    setToast(nextToast);
  }, []);
  const deferState = useDeferState({
    businessId,
    scopeType: "creative",
    snapshotDate: todayIso,
    onError: (message) => showToast({ type: "error", message }),
  });

  useEffect(() => {
    if (!toast) return;
    const timeout = window.setTimeout(() => setToast(null), 3600);
    return () => window.clearTimeout(timeout);
  }, [toast]);

  const handleRefreshInsights = useCallback(async () => {
    if (!businessId) {
      const message = "Select a workspace before refreshing Meta insights.";
      setInsightsRefreshState({ status: "error", message });
      showToast({ type: "error", message });
      return;
    }
    setInsightsRefreshState({
      status: "running",
      message: "Queueing refresh",
    });
    try {
      const payload = await requestMetaInsightsRefresh(businessId);
      const message = metaInsightsRefreshMessage(payload);
      setInsightsRefreshState({ status: "queued", message });
      showToast({ type: "success", message });
      await Promise.all([
        queryClient.invalidateQueries({
          queryKey: ["creatives-briefing", businessId, decisionCenterUiEnabled],
        }),
        queryClient.invalidateQueries({
          queryKey: ["creatives-briefing-meta-status", businessId],
        }),
        queryClient.invalidateQueries({
          queryKey: ["creatives-briefing-meta-summary-today", businessId, todayIso],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "creatives-briefing-meta-summary-7d",
            businessId,
            sevenDayStart,
            todayIso,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "creatives-briefing-meta-trends-7d",
            businessId,
            sevenDayStart,
            todayIso,
          ],
        }),
        queryClient.invalidateQueries({
          queryKey: [
            "creatives-briefing-asset-library",
            businessId,
            libraryStart,
            libraryEnd,
          ],
        }),
      ]);
    } catch (error) {
      const message =
        error instanceof Error ? error.message : "Could not queue refresh.";
      setInsightsRefreshState({ status: "error", message });
      showToast({ type: "error", message });
    }
  }, [
    businessId,
    decisionCenterUiEnabled,
    libraryEnd,
    libraryStart,
    queryClient,
    sevenDayStart,
    showToast,
    todayIso,
  ]);

  const handleToggleLane = useCallback((laneKey: LaneKey) => {
    if (laneKey !== "action" && laneKey !== "watching" && laneKey !== "healthy")
      return;
    setCollapsed((current) => ({ ...current, [laneKey]: !current[laneKey] }));
  }, []);

  const handleSelectChange = useCallback(
    (id: string, nextSelected: boolean) => {
      setSelectedIds((current) => {
        const next = new Set(current);
        if (nextSelected) {
          next.add(id);
        } else {
          next.delete(id);
        }
        return Array.from(next);
      });
    },
    [setSelectedIds],
  );

  const clearSelectedIdsForLane = useCallback(
    (idsToClear: Iterable<string>) => {
      const clearSet = new Set(idsToClear);
      setSelectedIds((current) => current.filter((id) => !clearSet.has(id)));
    },
    [setSelectedIds],
  );

  const briefingData = briefingQuery.data;
  const normalizedBriefingData = useMemo(
    () => normalizeCreativesBriefingPayload(briefingData),
    [briefingData],
  );
  const decisionCenterSnapshot = normalizedBriefingData?.decisionCenter;
  const actionItems = useMemo(
    () => normalizeActionItems(normalizedBriefingData?.actionNow ?? []),
    [normalizedBriefingData?.actionNow],
  );
  const visibleActionItems = useMemo(
    () => filterRemovedActionItems(actionItems, removedActionIds),
    [actionItems, removedActionIds],
  );
  const watchingItems = normalizedBriefingData?.watching ?? [];
  const healthyItems = normalizedBriefingData?.healthy ?? [];
  const actionIds = useMemo(
    () => visibleActionItems.map(actionItemId),
    [visibleActionItems],
  );
  const watchingIds = useMemo(() => watchingItems.map(cardId), [watchingItems]);
  const healthyIds = useMemo(() => healthyItems.map(cardId), [healthyItems]);
  const actionSelectedIds = useMemo(
    () => filterSelectedIdsForLane(selectedIds, actionIds),
    [actionIds, selectedIds],
  );
  const watchingSelectedIds = useMemo(
    () => filterSelectedIdsForLane(selectedIds, watchingIds),
    [selectedIds, watchingIds],
  );
  const selectedActionCards = useMemo(
    () => selectedCardsForActionItems(visibleActionItems, actionSelectedIds),
    [actionSelectedIds, visibleActionItems],
  );
  const selectedWatchingCards = useMemo(
    () => selectedCardsForCards(watchingItems, watchingSelectedIds),
    [watchingItems, watchingSelectedIds],
  );
  const actionCards = useMemo(
    () =>
      visibleActionItems
        .map(briefingCardForActionItem)
        .filter((card): card is BriefingCreativeCard => Boolean(card)),
    [visibleActionItems],
  );
  const healthySelectedIds = useMemo(
    () => filterSelectedIdsForLane(selectedIds, healthyIds),
    [healthyIds, selectedIds],
  );
  const selectedHealthyCards = useMemo(
    () => selectedCardsForCards(healthyItems, healthySelectedIds),
    [healthyItems, healthySelectedIds],
  );
  const creativeFilterInput = useMemo(
    () => ({ actionFilter, campaignFilter, search: briefingSearch }),
    [actionFilter, briefingSearch, campaignFilter],
  );
  const filteredActionCards = useMemo(
    () => actionCards.filter((card) => cardMatchesCreativeFilters(card, creativeFilterInput)),
    [actionCards, creativeFilterInput],
  );
  const filteredWatchingItems = useMemo(
    () => watchingItems.filter((card) => cardMatchesCreativeFilters(card, creativeFilterInput)),
    [creativeFilterInput, watchingItems],
  );
  const filteredHealthyItems = useMemo(
    () => healthyItems.filter((card) => cardMatchesCreativeFilters(card, creativeFilterInput)),
    [creativeFilterInput, healthyItems],
  );
  const allFilteredCards = useMemo(
    () => [
      ...filteredActionCards,
      ...filteredWatchingItems,
      ...filteredHealthyItems,
    ],
    [filteredActionCards, filteredHealthyItems, filteredWatchingItems],
  );
  const defaultActiveLane = chooseDefaultCreativeLane({
    actionCount: filteredActionCards.length,
    watchingCount: filteredWatchingItems.length,
    healthyCount: filteredHealthyItems.length,
  });
  const activeLane = manualActiveLane ?? defaultActiveLane;
  const laneSummary = normalizedBriefingData?.source?.laneSummary ?? null;
  const aggregateSuppressionTrace =
    normalizedBriefingData?.source?.aggregateSuppressionTrace ?? null;
  const visibilitySummary = decisionVisibilitySummary({
    actionCount: filteredActionCards.length,
    watchingCount: filteredWatchingItems.length,
    healthyCount: filteredHealthyItems.length,
    activeLane,
  });

  const trackingAnomalyActive = Boolean(
    normalizedBriefingData?.trackingAnomalyActive ||
    normalizedBriefingData?.trackingBlocked ||
    normalizedBriefingData?.pulse?.trackingAnomalyActive ||
    metaStatusQuery.data?.degradedServing,
  );
  const matureCount =
    normalizedBriefingData?.pulse?.matureCount ?? healthyItems.length;
  const engineProfile = normalizedBriefingData?.source?.accountProfile ?? null;
  const isInitialLoading = briefingQuery.isLoading && !normalizedBriefingData;
  const briefingError =
    briefingQuery.error instanceof Error ? briefingQuery.error.message : null;
  const deferredCount =
    deferState.deferredCount || normalizedBriefingData?.deferredCount || 0;
  const trackingBlockerDetail =
    normalizedBriefingData?.trackingDetail ||
    normalizedBriefingData?.trackingAnomalyDetail ||
    normalizedBriefingData?.pulse?.trackingDetail ||
    normalizedBriefingData?.pulse?.trackingAnomalyDetail ||
    undefined;

  const assetLibraryPayload = assetLibraryQuery.data;
  const assetLibraryRows = Array.isArray(assetLibraryPayload)
    ? assetLibraryPayload
    : Array.isArray(assetLibraryPayload?.rows)
      ? assetLibraryPayload.rows
      : [];
  const decisionCenterAssetLibraryRows = useMemo(
    () =>
      attachDecisionCenterRowsToAssetLibraryRows(
        assetLibraryRows,
        decisionCenterSnapshot,
        decisionCenterUiEnabled,
      ),
    [assetLibraryRows, decisionCenterSnapshot, decisionCenterUiEnabled],
  );
  const assetLibraryStatus = Array.isArray(assetLibraryPayload)
    ? null
    : (assetLibraryPayload?.status ?? null);
  const assetLibraryMessage = Array.isArray(assetLibraryPayload)
    ? null
    : (assetLibraryPayload?.message ?? null);
  const assetLibraryError =
    assetLibraryQuery.error instanceof Error
      ? assetLibraryQuery.error.message
      : null;
  const creativeDataSetupNotice = getCreativeDataSetupNotice({
    metaStatus: metaStatusQuery.data,
    assetLibraryStatus,
  });
  const assetLibraryEmptyMessage = getAssetLibraryEmptyMessage({
    status: assetLibraryStatus,
    message: assetLibraryMessage,
  });
  const pageStyle = {
    "--briefing-bulk-top": trackingAnomalyActive ? "112px" : "96px",
  } as CSSProperties;
  const activeEvidenceCard = evidenceDrawerState.open
    ? evidenceDrawerState.card
    : null;
  const activeEvidenceCardId = activeEvidenceCard ? cardId(activeEvidenceCard) : null;
  const launchpadOverlayItem = launchpadOverlayState.card
    ? buildLaunchpadOverlayItem(launchpadOverlayState.card)
    : null;

  const handleWorkspaceModeChange = useCallback(
    (nextMode: WorkspaceMode) => {
      setWorkspaceMode(nextMode);
      const params = new URLSearchParams(
        typeof window === "undefined" ? (searchParams?.toString() ?? "") : window.location.search,
      );
      if (nextMode === "library") {
        params.set("tab", "library");
      } else {
        params.delete("tab");
      }
      const query = params.toString();
      router.replace(`${pathname}${query ? `?${query}` : ""}`, {
        scroll: false,
      });
    },
    [pathname, router, searchParams],
  );

  const handleLaneChange = useCallback((lane: CreativeLaneView) => {
    setManualActiveLane(lane);
  }, []);

  const handleDateRangeApply = useCallback(
    (nextRange: HtmlDateRangeValue) => {
      setDateRange(nextRange);
      const params = new URLSearchParams(
        typeof window === "undefined" ? (searchParams?.toString() ?? "") : window.location.search,
      );
      params.set("window", nextRange.window);
      if (nextRange.window === "custom") {
        params.set("start", nextRange.start);
        params.set("end", nextRange.end);
      } else {
        params.delete("start");
        params.delete("end");
      }
      const query = params.toString();
      const nextHref = `${pathname}${query ? `?${query}` : ""}`;
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", nextHref);
      }
      router.replace(nextHref, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const replaceCreativeQueryParam = useCallback(
    (mutate: (params: URLSearchParams) => void) => {
      const params = new URLSearchParams(
        typeof window === "undefined" ? (searchParams?.toString() ?? "") : window.location.search,
      );
      mutate(params);
      const query = params.toString();
      const nextHref = `${pathname}${query ? `?${query}` : ""}`;
      if (typeof window !== "undefined") {
        window.history.replaceState(null, "", nextHref);
      }
      router.replace(nextHref, { scroll: false });
    },
    [pathname, router, searchParams],
  );

  const handleLibraryMetricIdsChange = useCallback(
    (nextIds: string[]) => {
      setLibraryMetricIds(nextIds);
      replaceCreativeQueryParam((params) => {
        params.delete("preset");
      });
    },
    [replaceCreativeQueryParam],
  );

  const handleLibraryPresetChange = useCallback(
    (presetId: string) => {
      replaceCreativeQueryParam((params) => {
        params.set("tab", "library");
        params.set("preset", presetId);
      });
    },
    [replaceCreativeQueryParam],
  );

  const handleEvidenceOpen = useCallback((card: BriefingCreativeCard) => {
    setCompareDrawerState(CLOSED_COMPARE_DRAWER_STATE);
    setEvidenceDrawerState({ open: true, card });
  }, []);

  const handleLaunchpadOpen = useCallback((payload: LaunchpadOpenPayload) => {
    setEvidenceDrawerState(CLOSED_EVIDENCE_DRAWER_STATE);
    setLaunchpadOverlayState(openLaunchpadOverlayState(payload));
  }, []);

  const handleLaunchpadCancel = useCallback(() => {
    setLaunchpadOverlayState(CLOSED_LAUNCHPAD_OVERLAY_STATE);
  }, []);

  const handleLaunchpadConfirm = useCallback(() => {
    const href = launchpadHrefFromOverlayState(launchpadOverlayState);
    if (!href) return;
    setLaunchpadOverlayState(CLOSED_LAUNCHPAD_OVERLAY_STATE);
    router.push(href);
  }, [launchpadOverlayState, router]);

  const handleDefer = useCallback(
    (id: string) => {
      void deferState.defer(id);
    },
    [deferState],
  );

  const handleUndefer = useCallback(
    (id: string) => {
      void deferState.undefer(id);
    },
    [deferState],
  );

  const handleCut = useCallback(
    async (card: BriefingCreativeCard) => {
      const itemId = cardId(card);
      setCutPendingIds((current) => new Set(current).add(itemId));
      try {
        const result = await pauseBriefingCard({ businessId, card });
        showToast(buildCutSuccessToast(card, result));
        setCuttingIds((current) => new Set(current).add(itemId));
        window.setTimeout(() => {
          setRemovedActionIds((current) => new Set(current).add(itemId));
          setCuttingIds((current) => {
            const next = new Set(current);
            next.delete(itemId);
            return next;
          });
          void queryClient.invalidateQueries({
            queryKey: ["creatives-briefing", businessId],
          });
        }, 220);
      } catch (error) {
        showToast({
          type: "error",
          message: error instanceof Error ? error.message : "Cut failed.",
        });
      } finally {
        setCutPendingIds((current) => {
          const next = new Set(current);
          next.delete(itemId);
          return next;
        });
      }
    },
    [businessId, queryClient, showToast],
  );

  const handleCutRequest = useCallback(
    (card: BriefingCreativeCard) => {
      if (trackingAnomalyActive) {
        setTrackingCutCard(card);
        return;
      }
      void handleCut(card);
    },
    [handleCut, trackingAnomalyActive],
  );

  const handleBulkCutOpen = useCallback(
    (cards: BriefingCreativeCard[] = selectedActionCards) => {
      if (cards.length === 0) return;
      setCompareDrawerState(CLOSED_COMPARE_DRAWER_STATE);
      setEvidenceDrawerState(CLOSED_EVIDENCE_DRAWER_STATE);
      setBulkCutModalState({ open: true, cards });
    },
    [selectedActionCards],
  );

  const executeBulkCut = useCallback(
    async (cards: BriefingCreativeCard[]) => {
      if (cards.length === 0) return;
      const itemIds = cards.map(cardId);
      setBulkCutModalState(CLOSED_BULK_CUT_MODAL_STATE);
      setBulkPendingIds((current) => {
        const next = new Set(current);
        itemIds.forEach((id) => next.add(id));
        return next;
      });
      try {
        const result = await pauseBriefingCardsBulk({
          businessId,
          cards,
          trackingBlocked: trackingAnomalyActive,
        });
        const successfulIds = successfulBulkPauseCardIds(cards, result);
        if (!result.ok) {
          if (successfulIds.length === 0) {
            throw new Error(summarizeBulkPauseFailure(result));
          }
          showToast({
            type: "error",
            message: `${successfulIds.length} cut applied, ${result.failedCount ?? cards.length - successfulIds.length} failed · ${summarizeBulkPauseFailure(result)}`,
          });
        } else {
          showToast({
            type: "success",
            message: `Cut ${successfulIds.length} creatives`,
          });
        }
        setCuttingIds((current) => {
          const next = new Set(current);
          successfulIds.forEach((id) => next.add(id));
          return next;
        });
        window.setTimeout(() => {
          setRemovedActionIds((current) => {
            const next = new Set(current);
            successfulIds.forEach((id) => next.add(id));
            return next;
          });
          setSelectedIds((current) =>
            current.filter((id) => !successfulIds.includes(id)),
          );
          setCuttingIds((current) => {
            const next = new Set(current);
            successfulIds.forEach((id) => next.delete(id));
            return next;
          });
          void queryClient.invalidateQueries({
            queryKey: ["creatives-briefing", businessId],
          });
        }, 220);
      } catch (error) {
        showToast({
          type: "error",
          message: error instanceof Error ? error.message : "Bulk cut failed.",
        });
      } finally {
        setBulkPendingIds((current) => {
          const next = new Set(current);
          itemIds.forEach((id) => next.delete(id));
          return next;
        });
      }
    },
    [businessId, queryClient, setSelectedIds, showToast, trackingAnomalyActive],
  );

  const handleBulkLaunchpadTeleport = useCallback(
    (cards: BriefingCreativeCard[], mode: LaunchpadBridgeMode) => {
      if (cards.length === 0) return;
      setCompareDrawerState(CLOSED_COMPARE_DRAWER_STATE);
      setEvidenceDrawerState(CLOSED_EVIDENCE_DRAWER_STATE);
      router.push(buildBulkLaunchpadHref(cards, mode));
    },
    [router],
  );

  const handleCompareOpen = useCallback(
    (cards: BriefingCreativeCard[] = selectedActionCards) => {
      if (cards.length === 0) return;
      setEvidenceDrawerState(CLOSED_EVIDENCE_DRAWER_STATE);
      setCompareDrawerState({ open: true, cards: cards.slice(0, 4) });
    },
    [selectedActionCards],
  );

  const handleCompareCutWeakest = useCallback(
    (card: BriefingCreativeCard) => {
      setCompareDrawerState(CLOSED_COMPARE_DRAWER_STATE);
      handleCutRequest(card);
    },
    [handleCutRequest],
  );

  const handleBulkToolbarAction = useCallback(
    (
      action: BulkAction,
      cards: BriefingCreativeCard[] = selectedActionCards,
    ) => {
      if (action === "clear") {
        return;
      }
      if (action === "cut") {
        handleBulkCutOpen(cards);
        return;
      }
      if (action === "demote") {
        handleBulkLaunchpadTeleport(cards, "demote");
        return;
      }
      if (action === "launch_new") {
        handleBulkLaunchpadTeleport(cards, "fresh_test");
        return;
      }
      if (action === "add_existing") {
        handleBulkLaunchpadTeleport(cards, "add_existing");
        return;
      }
      if (action === "compare") {
        handleCompareOpen(cards);
      }
    },
    [
      handleBulkCutOpen,
      handleBulkLaunchpadTeleport,
      handleCompareOpen,
      selectedActionCards,
    ],
  );

  const handleToggleLibraryRow = useCallback((rowId: string) => {
    setLibrarySelectedRowIds((current) =>
      current.includes(rowId)
        ? current.filter((id) => id !== rowId)
        : [...current, rowId],
    );
  }, []);

  const handleToggleAllLibraryRows = useCallback(() => {
    setLibrarySelectedRowIds((current) =>
      current.length === assetLibraryRows.length
        ? []
        : assetLibraryRows.map((row) => row.id),
    );
  }, [assetLibraryRows]);

  const handleCompareLibraryRows = useCallback((rows: MetaCreativeRow[]) => {
    if (rows.length < 2) return;
    setEvidenceDrawerState(CLOSED_EVIDENCE_DRAWER_STATE);
    setCompareDrawerState({
      open: true,
      cards: rows.slice(0, 4).map(briefingCardFromAssetRow),
    });
  }, []);

  const handleShareLibraryRows = useCallback(
    async (rows: MetaCreativeRow[], metricIds: string[], config?: ShareLinkConfig) => {
      const metrics = supportedShareMetrics(config?.metrics?.length ? config.metrics : metricIds);
      const days = Number(config?.expiration ?? "7");
      const expiresAt = new Date(Date.now() + days * 24 * 60 * 60 * 1000).toISOString();
      const response = await fetch("/api/creatives/share", {
        method: "POST",
        headers: { "Content-Type": "application/json", Accept: "application/json" },
        body: JSON.stringify({
          title: config?.title ?? "Asset Library view",
          businessId,
          dateRange: `${libraryStart} - ${libraryEnd}`,
          expiresAt,
          metrics,
          includeNotes: Boolean(config?.includeNotes),
          audience: config?.audience ?? "buyer",
          presetId: config?.presetId,
          presetLabel: config?.presetLabel,
          includeCampaignNames: config?.includeCampaignNames ?? true,
          includeDecisionLanguage: config?.includeDecisionLanguage ?? true,
          allowCsv: Boolean(config?.allowCsv),
          snapshotOnly: config?.snapshotOnly ?? true,
          filters: ["Asset Library", rows.length === librarySelectedRowIds.length ? "selected rows" : "visible rows"],
          selectedRowIds: rows.map((row) => row.id),
          totalRows: assetLibraryRows.length,
          creatives: rows.map((row) => toSharedCreative(row)),
        }),
      });
      const payload = await response.json().catch(() => null);
      if (!response.ok || !payload?.url) {
        const message = payload && typeof payload === "object" && "message" in payload
          ? String((payload as { message?: unknown }).message)
          : "Share link could not be created.";
        throw new Error(message);
      }
      const url = `${window.location.origin}${payload.url}`;
      showToast({ type: "success", message: "Asset Library share link created." });
      return { url };
    },
    [assetLibraryRows.length, businessId, libraryEnd, librarySelectedRowIds.length, libraryStart, showToast],
  );

  const handleLaunchEmptyNewTest = useCallback(() => {
    router.push(EMPTY_ACTION_LAUNCH_HREF);
  }, [router]);

  if (!businessId) {
    return <div className="min-h-screen bg-neutral-50 text-neutral-900" />;
  }

  const activeCards =
    activeLane === "all"
      ? allFilteredCards
      : activeLane === "action"
      ? filteredActionCards
      : activeLane === "watching"
        ? filteredWatchingItems
        : filteredHealthyItems;
  const activeSelectedIds =
    activeLane === "all"
      ? filterSelectedIdsForLane(selectedIds, allFilteredCards.map(cardId))
      : activeLane === "action"
      ? actionSelectedIds
      : activeLane === "watching"
        ? watchingSelectedIds
        : healthySelectedIds;
  const activeSelectedCards =
    activeLane === "all"
      ? selectedCardsForCards(allFilteredCards, activeSelectedIds)
      : activeLane === "action"
      ? selectedActionCards.filter((card) => activeCards.some((item) => cardId(item) === cardId(card)))
      : activeLane === "watching"
        ? selectedWatchingCards.filter((card) => activeCards.some((item) => cardId(item) === cardId(card)))
        : selectedHealthyCards.filter((card) => activeCards.some((item) => cardId(item) === cardId(card)));
  const activeGroups = (() => {
    if (activeLane === "all") {
      return [
        { key: "action", title: "Action Now", cards: filteredActionCards },
        { key: "watching", title: "Watching", cards: filteredWatchingItems },
        { key: "healthy", title: "Healthy", cards: filteredHealthyItems },
      ].filter((group) => group.cards.length > 0);
    }
    if (activeLane === "watching") {
      const bucketOrder: Array<BriefingCreativeCard["watchingSubBucket"] | null> = [
        "near_action",
        "test_maturing",
        "diagnostic",
        "waiting_on_labels",
        null,
      ];
      return bucketOrder
        .map((bucket) => ({
          key: bucket ?? "other",
          title: watchingBucketLabel(bucket),
          cards: filteredWatchingItems.filter(
            (card) => (card.watchingSubBucket ?? null) === bucket,
          ),
        }))
        .filter((group) => group.cards.length > 0);
    }
    return [
      {
        key: activeLane,
        title: laneGroupTitle(activeLane),
        cards: activeCards,
      },
    ];
  })();
  const topCreative = [...actionCards, ...watchingItems, ...healthyItems]
    .filter((card) => Number.isFinite(card.roas ?? Number.NaN))
    .sort((a, b) => numberOrZero(b.roas) - numberOrZero(a.roas))[0] ?? null;

  return (
    <div className="ad-final" style={pageStyle} data-testid="creative-platform-page">
      <div className="topbar">
        <div>
          <div className="crumbs">Platforms · Meta · <b>Creatives</b></div>
          <h1 className="page-title">{workspaceMode === "library" ? "Asset Library" : "Creative · Decision Center"}</h1>
        </div>
        <div className="right-tools">
          <div className="lane-tabs" style={{ border: "1px solid var(--border-2)", borderRadius: "var(--r)", padding: 0, background: "#fff" }}>
            <button type="button" className={`tab ${workspaceMode === "briefing" ? "active" : ""}`} style={{ padding: "8px 14px" }} onClick={() => handleWorkspaceModeChange("briefing")}>Briefing</button>
            <button type="button" className={`tab ${workspaceMode === "library" ? "active" : ""}`} style={{ padding: "8px 14px" }} onClick={() => handleWorkspaceModeChange("library")}>Asset Library</button>
          </div>
          <HtmlDateRangePicker value={dateRange} onApply={handleDateRangeApply} />
          <span className={`chip ${trackingAnomalyActive ? "chip--action" : "chip--healthy"}`}><span className="dot" />{trackingAnomalyActive ? "Action gated" : "Meta connected"}</span>
        </div>
      </div>

      <CreativePulseFinal
        spendToday={todaySummaryQuery.data?.totals?.spend}
        conversions={todaySummaryQuery.data?.totals?.conversions}
        roas7d={sevenDaySummaryQuery.data?.totals?.roas}
        roas7dHistory={sevenDayTrendsQuery.data?.points}
        roasTarget={normalizedBriefingData?.pulse?.rolling7dRoasTarget}
        topCreative={topCreative}
        profile={engineProfile}
        trackingAnomalyActive={trackingAnomalyActive}
        engineVersion={normalizedBriefingData?.pulse?.engineVersion}
        refreshStatus={insightsRefreshState.status}
        refreshMessage={insightsRefreshState.message}
        onRefreshInsights={handleRefreshInsights}
      />

      {trackingAnomalyActive ? (
        <div className="banner danger" data-tracking-blocker>
          <div className="icon">!</div>
          <div className="msg"><b>Tracking is currently in anomaly.</b><span className="sub">{trackingBlockerDetail ?? "Confirm tracking before pause or duplicate actions."}</span></div>
        </div>
      ) : null}

      {creativeDataSetupNotice ? (
        <div className="banner warn">
          <div className="icon">i</div>
          <div className="msg"><b>{creativeDataSetupNotice.title}</b><span className="sub">{creativeDataSetupNotice.body}</span></div>
        </div>
      ) : null}

      {briefingError ? (
        <div className="banner danger">
          <div className="icon">!</div>
          <div className="msg"><b>Briefing could not load.</b><span className="sub">{briefingError}</span></div>
        </div>
      ) : null}

      {workspaceMode === "briefing" ? (
        <>
          <div className="lane-tabs">
            <CreativeLaneTab active={activeLane === "all"} className="all" label="All" count={allFilteredCards.length} onClick={() => handleLaneChange("all")} />
            <CreativeLaneTab active={activeLane === "action"} className="action" label="Action Now" count={filteredActionCards.length} onClick={() => handleLaneChange("action")} />
            <CreativeLaneTab active={activeLane === "watching"} className="watch" label="Watching" count={filteredWatchingItems.length} onClick={() => handleLaneChange("watching")} />
            <CreativeLaneTab active={activeLane === "healthy"} className="healthy" label="Healthy" count={filteredHealthyItems.length} onClick={() => handleLaneChange("healthy")} />
            <div style={{ flex: 1 }} />
            <div className="tab" style={{ color: "var(--muted)" }}><span className="chip chip--ghost"><span className="dot" />Deferred {deferredCount}</span></div>
          </div>
          <div className="mt-3 flex flex-wrap items-center gap-2 text-[12px] text-neutral-500" data-creative-visibility-summary>
            <span className="font-medium text-neutral-700">
              Visible {visibilitySummary.activeCount}/{visibilitySummary.total}
            </span>
            <span className="text-neutral-300">·</span>
            <span>
              Action {filteredActionCards.length}, Watching {filteredWatchingItems.length}, Healthy {filteredHealthyItems.length}
            </span>
            {visibilitySummary.isSparseActionDefault ? (
              <>
                <span className="text-neutral-300">·</span>
                <span>Action is sparse; Watching is shown first.</span>
              </>
            ) : null}
          </div>
          <LaneSummaryHeader summary={laneSummary} />
          <AggregateSuppressionNotice trace={aggregateSuppressionTrace} />

          <div className="controls" data-creative-secondary-controls>
            <div className="group" role="group" aria-label="Creative action filter">
              {([
                ["all", "All"],
                ["promote", "Promote"],
                ["scale", "Scale"],
                ["cut", "Cut"],
                ["fresh_test", "Fresh test"],
                ["diagnose", "Diagnose"],
                ["add_existing", "Add existing"],
              ] as Array<[CreativeActionFilter, string]>).map(([value, label]) => (
                <button key={value} type="button" className={actionFilter === value ? "on" : ""} onClick={() => setActionFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="group" role="group" aria-label="Campaign label filter">
              {([
                ["all", "All campaigns"],
                ["main", "Main"],
                ["test", "Test"],
                ["mixed", "Mixed"],
              ] as Array<[CreativeCampaignFilter, string]>).map(([value, label]) => (
                <button key={value} type="button" className={campaignFilter === value ? "on" : ""} onClick={() => setCampaignFilter(value)}>
                  {label}
                </button>
              ))}
            </div>
            <div className="spacer" />
            <label className="search">
              <Search className="inline-block shrink-0" size={14} aria-hidden="true" />
              <input
                type="search"
                value={briefingSearch}
                onChange={(event) => setBriefingSearch(event.currentTarget.value)}
                placeholder="creative / campaign / ad set"
              />
            </label>
          </div>

          <div className="workspace workspace-rel">
            <div className="lane-stack">
              {isInitialLoading ? (
                <div className="ccard-grid">
                  {Array.from({ length: 6 }).map((_, index) => (
                    <div key={index} className="ccard-tile animate-pulse"><div className="tile-thumb" /><div className="tile-body" /></div>
                  ))}
                </div>
              ) : activeCards.length === 0 && trackingAnomalyActive && !briefingError && !creativeDataSetupNotice ? (
                <div className="lane-empty" data-tracking-blocker>
                  Tracking needs attention before action triage.
                </div>
              ) : activeCards.length === 0 && !briefingError && !creativeDataSetupNotice ? (
                <EmptyActionState
                  matureCount={matureCount}
                  watchingCount={watchingItems.length}
                  onLaunchNewTest={handleLaunchEmptyNewTest}
                  onBrowseAssetLibrary={() => handleWorkspaceModeChange("library")}
                />
              ) : (
                <div className="space-y-5">
                  {activeGroups.map((group) => (
                    <section key={group.key} data-creative-lane-group={group.key}>
                      {(activeLane === "all" || activeLane === "watching") ? (
                        <div className="mb-2 flex items-center gap-2 text-[12px] font-semibold text-neutral-700">
                          <span>{group.title}</span>
                          <span className="chip chip--ghost">{group.cards.length}</span>
                        </div>
                      ) : null}
                      <div className="ccard-grid">
                        {group.cards.map((card) => (
                          <ActionNowCard
                            key={cardId(card)}
                            card={card}
                            selected={selectedSet.has(cardId(card))}
                            onSelectChange={handleSelectChange}
                            deferred={deferState.isDeferred(getCreativeScopeId(card))}
                            cutting={cuttingIds.has(cardId(card))}
                            cutPending={cutPendingIds.has(cardId(card)) || bulkPendingIds.has(cardId(card))}
                            onDefer={handleDefer}
                            onUndefer={handleUndefer}
                            onCut={handleCutRequest}
                            onLaunchpadOpen={handleLaunchpadOpen}
                            evidenceOpen={activeEvidenceCardId === cardId(card)}
                            onEvidenceOpen={handleEvidenceOpen}
                          />
                        ))}
                      </div>
                    </section>
                  ))}
                </div>
              )}

              {activeSelectedCards.length > 0 ? (
                <div className="bulkbar">
                  <span>{activeSelectedCards.length} selected · {activeSelectedCards.slice(0, 2).map(cardName).join(", ")}</span>
                  <div className="acts">
                    <button type="button" className="btn" onClick={() => handleBulkToolbarAction("compare", activeSelectedCards)}>Compare</button>
                    <button type="button" className="btn" onClick={() => handleBulkToolbarAction("demote", activeSelectedCards)}>Send as Promote ↗</button>
                    <button type="button" className="btn" onClick={() => handleBulkToolbarAction("launch_new", activeSelectedCards)}>Send as Fresh test ↗</button>
                    <button type="button" className="btn btn--danger" onClick={() => handleBulkToolbarAction("cut", activeSelectedCards)}>Pause</button>
                    <button type="button" className="btn btn--ghost" onClick={() => clearSelectedIdsForLane(activeSelectedIds)}>×</button>
                  </div>
                </div>
              ) : null}
            </div>
          </div>
        </>
      ) : (
        <SectionErrorBoundary
          title="Asset Library is temporarily unavailable."
          resetKey={`${businessId}:${libraryStart}:${libraryEnd}:${assetLibraryRows.length}`}
        >
          {assetLibraryError ? (
            <div className="lane-stack"><div className="lane-empty">{assetLibraryError}</div></div>
          ) : (
            <AssetLibrarySection
              rows={decisionCenterAssetLibraryRows}
              decisionCenterUiEnabled={decisionCenterUiEnabled}
              emptyMessage={assetLibraryEmptyMessage}
              defaultCurrency={activeBusiness?.currency ?? null}
              selectedMetricIds={libraryMetricIds}
              onSelectedMetricIdsChange={handleLibraryMetricIdsChange}
              onPresetChange={handleLibraryPresetChange}
              selectedRowIds={librarySelectedRowIds}
              highlightedRowId={libraryHighlightedRowId}
              onToggleRow={handleToggleLibraryRow}
              onToggleAll={handleToggleAllLibraryRows}
              onOpenRow={setLibraryHighlightedRowId}
              onCompareRows={handleCompareLibraryRows}
              onShareRows={handleShareLibraryRows}
              dateRangeLabel={windowLabel(dateRange.window)}
              dateRangeDetail={`${libraryStart} - ${libraryEnd}`}
              onDateRangeClick={() => {
                const trigger = document.querySelector<HTMLButtonElement>(".date-picker-wrap .date-chip");
                trigger?.click();
              }}
              onSortedRowsChange={(rows: MetaCreativeRow[]) => {
                if (!libraryHighlightedRowId && rows[0]) setLibraryHighlightedRowId(rows[0].id);
              }}
            />
          )}
        </SectionErrorBoundary>
      )}
      <LaunchpadOverlay
        open={launchpadOverlayState.open && Boolean(launchpadOverlayItem)}
        mode={launchpadOverlayState.mode ?? "fresh_test"}
        item={launchpadOverlayItem ?? { id: "launchpad-briefing" }}
        onClose={handleLaunchpadCancel}
        onConfirm={handleLaunchpadConfirm}
        presentation="modal"
      />
      <BulkCutConfirmModal
        open={bulkCutModalState.open}
        cards={bulkCutModalState.cards}
        trackingBlocked={trackingAnomalyActive}
        onCancel={() => setBulkCutModalState(CLOSED_BULK_CUT_MODAL_STATE)}
        onConfirm={() => void executeBulkCut(bulkCutModalState.cards)}
      />
      <TrackingConfirmModal
        open={trackingCutCard != null}
        primaryLabel="Cut anyway"
        onClose={() => setTrackingCutCard(null)}
        onConfirm={() => {
          const card = trackingCutCard;
          setTrackingCutCard(null);
          if (card) void handleCut(card);
        }}
      />
      <CreativeEvidenceDrawer
        open={Boolean(activeEvidenceCard)}
        card={activeEvidenceCard}
        businessId={businessId}
        deferred={activeEvidenceCard ? deferState.isDeferred(getCreativeScopeId(activeEvidenceCard)) : false}
        cutPending={activeEvidenceCardId ? cutPendingIds.has(activeEvidenceCardId) : false}
        onClose={() => setEvidenceDrawerState(CLOSED_EVIDENCE_DRAWER_STATE)}
        onCut={handleCutRequest}
        onDefer={handleDefer}
        onUndefer={handleUndefer}
        onLaunchpad={(card, mode) => {
          if (mode === "add_existing") {
            handleBulkLaunchpadTeleport([card], mode);
            return;
          }
          handleLaunchpadOpen({ card, mode });
        }}
      />
      <CompareDrawerHost
        open={compareDrawerState.open}
        cards={compareDrawerState.cards}
        onClose={() => setCompareDrawerState(CLOSED_COMPARE_DRAWER_STATE)}
        onCutCard={handleCompareCutWeakest}
        onLaunchpad={handleBulkLaunchpadTeleport}
      />
      <BriefingToastViewport toast={toast} />
    </div>
  );
}

function WorkspaceSwitcher({
  mode,
  actionCount,
  watchingCount,
  healthyCount,
  assetCount,
  onChange,
}: {
  mode: WorkspaceMode;
  actionCount: number;
  watchingCount: number;
  healthyCount: number;
  assetCount: number;
  onChange: (nextMode: WorkspaceMode) => void;
}) {
  return (
    <div
      className="inline-flex w-full rounded-lg border border-neutral-200 bg-white p-1 shadow-[0_1px_2px_rgba(16,21,28,0.04)] sm:w-auto"
      aria-label="Creatives workspace"
    >
      <WorkspaceButton
        active={mode === "briefing"}
        icon={<ShieldCheck className="inline-block shrink-0" size={14} aria-hidden="true" />}
        label="Decision briefing"
        summary={`${actionCount} action · ${watchingCount} watch · ${healthyCount} healthy`}
        onClick={() => onChange("briefing")}
      />
      <WorkspaceButton
        active={mode === "library"}
        icon={<Layers className="inline-block shrink-0" size={14} aria-hidden="true" />}
        label="Asset Library"
        summary={`${assetCount} assets`}
        onClick={() => onChange("library")}
      />
    </div>
  );
}

function WorkspaceButton({
  active,
  icon,
  label,
  summary,
  onClick,
}: {
  active: boolean;
  icon: ReactNode;
  label: string;
  summary: string;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      aria-pressed={active}
      className={[
        "min-w-0 rounded-md px-3 py-2 text-left transition-colors",
        active
          ? "bg-neutral-900 text-white"
          : "text-neutral-600 hover:bg-neutral-50 hover:text-neutral-900",
      ].join(" ")}
      onClick={onClick}
    >
      <span className="flex items-center gap-1.5 text-[12.5px] font-semibold">
        {icon}
        {label}
      </span>
      <span
        className={[
          "mt-0.5 block whitespace-nowrap font-mono text-[10.5px]",
          active ? "text-neutral-300" : "text-neutral-400",
        ].join(" ")}
      >
        {summary}
      </span>
    </button>
  );
}

function PulseScope() {
  return (
    <button
      type="button"
      data-pulse="scope"
      className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-neutral-200 bg-neutral-50 text-neutral-700 hover:bg-neutral-100"
      onClick={(event) => {
        event.preventDefault();
        // TODO Phase 11+: within-business scope filter — Account / Campaign / Adset.
      }}
    >
      <span className="text-neutral-400">
        <Layers
          className="inline-block shrink-0"
          size={13}
          aria-hidden="true"
        />
      </span>
      <span>Scope:</span>
      <span className="font-medium text-neutral-900">Account</span>
      <ChevronDown
        className="inline-block shrink-0 text-neutral-400"
        size={12}
        aria-hidden="true"
      />
    </button>
  );
}

function resolvePhonePlacement(
  bestPlacement: string | null,
): PhonePreviewPlacement | undefined {
  if (!bestPlacement) return undefined;
  const value = bestPlacement.toLowerCase();
  if (value.includes("reels")) return "reels";
  if (value.includes("story") || value.includes("stories")) return "stories";
  if (value.includes("feed") || value.includes("home")) return "feed";
  return undefined;
}

function BriefingToastViewport({ toast }: { toast: BriefingToast | null }) {
  if (!toast) return null;

  return (
    <div
      className={`fixed bottom-5 right-5 z-[120] max-w-md rounded-xl border px-4 py-3 text-sm shadow-[0_8px_24px_-12px_rgba(16,21,28,0.18)] ${
        toast.type === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : toast.type === "error"
            ? "border-rose-200 bg-rose-50 text-rose-900"
            : "border-neutral-200 bg-white text-neutral-900"
      }`}
    >
      <div className="flex items-center gap-3">
        <span>{toast.message}</span>
        {toast.link ? (
          <a
            href={toast.link.href}
            target="_blank"
            rel="noreferrer"
            className="inline-flex items-center gap-1 font-semibold underline"
          >
            {toast.link.label}
            <ExternalLink
              className="inline-block shrink-0"
              size={13}
              aria-hidden="true"
            />
          </a>
        ) : null}
      </div>
    </div>
  );
}

function PulseCenter({
  spendToday,
  spendTarget,
  spendHistory,
  roas7d,
  roasTarget,
  matureCount,
}: {
  spendToday?: number | null;
  spendTarget?: number | null;
  spendHistory?: number[] | null;
  roas7d?: number | null;
  roasTarget?: number | null;
  matureCount: number;
}) {
  const spend = numberOrZero(spendToday);
  const target = numberOrZero(spendTarget) || spend || 1;
  const spendPct = Math.round((spend / target) * 100);
  const sparkValues =
    Array.isArray(spendHistory) && spendHistory.length > 0
      ? spendHistory.concat([spend])
      : [0, spend * 0.62, spend * 0.78, spend];
  const roas = numberOrZero(roas7d);
  const targetRoas = numberOrZero(roasTarget) || roas || 1;
  const roasDelta = Math.round(((roas - targetRoas) / targetRoas) * 100);
  const DeltaIcon = roasDelta >= 0 ? TrendingUp : TrendingDown;

  return (
    <>
      <div className="h-5 w-px bg-neutral-200" />
      <div
        data-pulse="spend"
        className="flex items-center gap-2 rounded-md px-1.5 py-1"
      >
        <span className="text-neutral-500">Spend today</span>
        <span className="font-mono tabular-nums font-semibold text-neutral-900">
          {formatCurrency(spend)}
        </span>
        <span className="text-neutral-400">/ {formatCurrency(target)}</span>
        <svg
          viewBox="0 0 60 16"
          width="60"
          height="16"
          className="text-blue-600"
          aria-hidden="true"
        >
          <path
            d={sparklinePath(sparkValues)}
            fill="none"
            stroke="currentColor"
            strokeWidth="1.5"
          />
        </svg>
        <span className="text-neutral-500 font-mono tabular-nums">
          {spendPct}%
        </span>
      </div>
      <div
        data-pulse="roas"
        className="flex items-center gap-2 rounded-md px-1.5 py-1"
      >
        <span className="text-neutral-500">7d ROAS</span>
        <span className="font-mono tabular-nums font-semibold text-neutral-900">
          {formatRoas(roas)}
        </span>
        <span
          className={`${roasDelta >= 0 ? "text-emerald-600" : "text-rose-600"} inline-flex items-center gap-0.5`}
        >
          <DeltaIcon
            className="inline-block shrink-0"
            size={12}
            aria-hidden="true"
          />
          <span className="font-mono tabular-nums">
            {roasDelta >= 0 ? "+" : ""}
            {roasDelta}%
          </span>
        </span>
        <span className="text-neutral-400">vs {formatRoas(targetRoas)}</span>
      </div>
      <div
        data-pulse="mature"
        className="flex items-center gap-1.5 rounded-md px-1.5 py-1"
      >
        <span className="text-neutral-500">Mature</span>
        <span className="font-mono tabular-nums font-semibold text-neutral-900">
          {matureCount}
        </span>
      </div>
      <div className="h-5 w-px bg-neutral-200" />
    </>
  );
}

function PulseRight({
  metaStatus,
  trackingAnomalyActive,
  engineVersion,
  calibratedAgo,
}: {
  metaStatus?: MetaStatusResponse;
  trackingAnomalyActive: boolean;
  engineVersion?: string | null;
  calibratedAgo?: string | null;
}) {
  const engineLive =
    !metaStatus ||
    metaStatus.state === "ready" ||
    metaStatus.state === "partial";
  const syncMinutes = getSyncMinutes(metaStatus);
  const calibratedLabel = relativeTime(calibratedAgo) ?? "2d ago";

  return (
    <div className="flex flex-wrap items-center gap-3 text-neutral-500">
      <div
        data-pulse="engine"
        className="flex flex-shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 whitespace-nowrap"
      >
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider ${
            engineLive
              ? "bg-emerald-500/15 text-emerald-700 border border-emerald-200"
              : "bg-amber-500/15 text-amber-800 border border-amber-200"
          }`}
        >
          <span
            className={`w-1.5 h-1.5 rounded-full ${engineLive ? "bg-emerald-500" : "bg-amber-500"}`}
          />
          {engineLive ? "Live" : "Syncing"}
        </span>
        <span className="max-w-[180px] truncate text-neutral-500">
          {engineVersion || "Engine v3"}
        </span>
        <span className="text-neutral-400">· calibrated {calibratedLabel}</span>
      </div>
      <div
        data-pulse="tracking"
        className="flex flex-shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 whitespace-nowrap"
        id="pulse-tracking"
      >
        {trackingAnomalyActive ? (
          <AlertTriangle
            className="inline-block shrink-0 text-rose-600"
            size={13}
            aria-hidden="true"
          />
        ) : (
          <ShieldCheck
            className="inline-block shrink-0 text-emerald-600"
            size={13}
            aria-hidden="true"
          />
        )}
        <span
          className={trackingAnomalyActive ? "text-rose-700" : "text-neutral-700"}
        >
          {trackingAnomalyActive
            ? "Tracking anomaly active"
            : "Tracking healthy"}
        </span>
      </div>
      <span className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap">
        <span className="text-neutral-400">
          <RefreshCw
            className="inline-block shrink-0"
            size={12}
            aria-hidden="true"
          />
        </span>
        Sync {syncMinutes}
      </span>
    </div>
  );
}

function getSyncMinutes(metaStatus?: MetaStatusResponse) {
  const timestamp =
    metaStatus?.latestSync?.finishedAt ||
    metaStatus?.latestSync?.startedAt ||
    null;
  if (!timestamp) return "—";
  const ms = Date.now() - new Date(timestamp).getTime();
  if (!Number.isFinite(ms) || ms < 0) return "—";
  const minutes = Math.max(1, Math.round(ms / 60_000));
  return `${minutes}m ago`;
}

function PulseJumpNav() {
  return (
    <>
      <JumpLink href="#lane-action" num="1" label="Action Now" />
      <JumpLink href="#lane-watching" num="2" label="Watching" />
      <JumpLink href="#lane-healthy" num="3" label="Healthy" />
    </>
  );
}

function JumpLink({
  href,
  num,
  label,
}: {
  href: string;
  num: string;
  label: string;
}) {
  return (
    <a
      href={href}
      className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-neutral-500 hover:bg-neutral-100 hover:text-neutral-900"
    >
      <span className="font-mono tabular-nums text-neutral-400">{num}</span>
      <span>{label}</span>
    </a>
  );
}

function LaneSkeleton() {
  return (
    <div className="rounded-xl border border-neutral-200 bg-white p-4">
      <div className="flex items-start gap-3">
        <div className="w-4 h-4 rounded border border-neutral-200 bg-neutral-100" />
        <div className="w-[72px] h-[72px] rounded-xl bg-neutral-100" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-4 w-60 rounded bg-neutral-100" />
          <div className="h-3 w-96 rounded bg-neutral-100" />
          <div className="h-3 w-full rounded bg-neutral-100" />
        </div>
      </div>
    </div>
  );
}
