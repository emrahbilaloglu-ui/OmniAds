"use client";

import {
  Component,
  useCallback,
  useEffect,
  useMemo,
  useState,
  type ErrorInfo,
  type ReactNode,
} from "react";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useRouter } from "next/navigation";
import {
  AlertTriangle,
  ChevronDown,
  ExternalLink,
  Layers,
  RefreshCw,
  ShieldCheck,
  TrendingDown,
  TrendingUp,
} from "lucide-react";
import {
  useDeferState,
  BulkToolbar,
  LaunchpadOverlay,
  LaneHeader,
  PulseStrip,
  TrackingBlockerBanner,
  TrackingConfirmModal,
  type BulkAction,
} from "@/components/common/briefing";
import type { LaunchpadOverlayMode } from "@/components/common/briefing/LaunchpadOverlay";
import type { LaneKey } from "@/components/common/briefing/types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import { formatCurrency, formatRoas, sparklinePath } from "@/lib/briefing/utils";
import { useAppStore } from "@/store/app-store";
import { ActionNowCard } from "@/components/creatives/briefing/ActionNowCard";
import { AssetLibrarySection } from "@/components/creatives/briefing/AssetLibrarySection";
import { BulkCutConfirmModal } from "@/components/creatives/briefing/BulkCutConfirmModal";
import { CompareDrawerHost } from "@/components/creatives/briefing/CompareDrawerHost";
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
  cardId,
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
} from "@/components/creatives/briefing/bulk-actions";
import type {
  BriefingActionItem,
  BriefingCreativeCard,
  BriefingRollupItem,
  CreativesBriefingResponse,
  MetaSummaryPulseResponse,
} from "@/components/creatives/briefing/types";
import {
  fetchMetaCreatives,
  mapApiRowToUiRow,
} from "@/app/(dashboard)/platforms/meta/creatives/page-support";
import type { MetaCreativeRow } from "@/components/creatives/metricConfig";

type LaneCollapseState = Record<Extract<LaneKey, "action" | "watching" | "healthy">, boolean>;

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
      <section className="mt-8 rounded-2xl border border-amber-200 bg-amber-50/70 px-5 py-4 text-[12.5px] text-amber-950">
        <div className="font-semibold">{this.props.title}</div>
        <div className="mt-1 text-amber-900/80">
          This section received an unexpected creative data shape. The rest of the briefing remains available.
        </div>
      </section>
    );
  }
}

function CreativeDataSetupNotice({ notice }: { notice: CreativeDataNotice }) {
  return (
    <div className="rounded-lg border border-amber-200 bg-amber-50/70 px-4 py-3 mb-4 flex items-start gap-3">
      <AlertTriangle className="text-amber-600 mt-0.5 inline-block shrink-0" size={18} aria-hidden="true" />
      <div className="flex-1 min-w-0">
        <div className="text-[13px] font-semibold text-amber-950 leading-snug">
          {notice.title}
        </div>
        <div className="text-[12px] text-amber-900/80 mt-0.5">{notice.body}</div>
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

function fetchCreativesBriefing(businessId: string): Promise<CreativesBriefingResponse> {
  const params = new URLSearchParams({ businessId });
  return fetchJson<CreativesBriefingResponse>(`/api/creatives/briefing?${params.toString()}`);
}

function fetchMetaSummary(
  businessId: string,
  startDate: string,
  endDate: string,
): Promise<MetaSummaryPulseResponse> {
  const params = new URLSearchParams({ businessId, startDate, endDate });
  return fetchJson<MetaSummaryPulseResponse>(`/api/meta/summary?${params.toString()}`);
}

function fetchMetaStatus(businessId: string): Promise<MetaStatusResponse> {
  const params = new URLSearchParams({ businessId });
  return fetchJson<MetaStatusResponse>(`/api/meta/status?${params.toString()}`);
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

function isCardRollup(card: BriefingCreativeCard) {
  return Array.isArray(card.placementList) && card.placementList.length > 1;
}

function safeArray<T>(value: unknown): T[] {
  return Array.isArray(value) ? value.filter((item): item is T => Boolean(item && typeof item === "object")) : [];
}

export function normalizeSpendHistory(value: unknown): number[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value
    .map((item) => (typeof item === "number" ? item : typeof item === "string" ? Number(item) : Number.NaN))
    .filter((item) => Number.isFinite(item));
  return normalized.length > 0 ? normalized : null;
}

export function normalizeCreativesBriefingPayload(
  payload: CreativesBriefingResponse | null | undefined,
): CreativesBriefingResponse | undefined {
  if (!payload || typeof payload !== "object") return undefined;
  const pulse = payload.pulse && typeof payload.pulse === "object" && !Array.isArray(payload.pulse)
    ? {
        ...payload.pulse,
        spendHistory: normalizeSpendHistory(payload.pulse.spendHistory),
      }
    : null;

  return {
    ...payload,
    actionNow: safeArray<BriefingActionItem>(payload.actionNow),
    watching: safeArray<BriefingCreativeCard>(payload.watching),
    healthy: safeArray<BriefingCreativeCard>(payload.healthy),
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

  if (metaStatus?.state === "not_connected" || metaStatus?.connected === false || assetLibraryStatus === "no_connection") {
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
  return input.message || "No Meta creative rows were found for the selected window.";
}

function normalizeActionItems(items: unknown): NormalizedActionItem[] {
  return safeArray<BriefingActionItem>(items).flatMap<NormalizedActionItem>((item, index) => {
    if (isCrossPlacementRollup(item) && item.primaryRec && typeof item.primaryRec === "object") {
      const key = item.id || item.primaryRec.id || `rollup-${index}`;
      return [{ key, type: "rollup", rollup: item }];
    }

    const card = item as BriefingCreativeCard;
    if (isCardRollup(card)) {
      const placementList = Array.isArray(card.placementList) ? card.placementList : [];
      return [{
        key: cardId(card),
        type: "rollup",
        rollup: {
          id: cardId(card),
          primaryRec: card,
          placementList,
          mixed: card.mixed,
        },
      }];
    }

    return [{ key: cardId(card), type: "card", card }];
  });
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

export function briefingCardForActionItem(item: NormalizedActionItem): BriefingCreativeCard | null {
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

export function CreativesBriefingPage() {
  const router = useRouter();
  const queryClient = useQueryClient();
  const businesses = useAppStore((state) => state.businesses);
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const activeBusiness = businesses.find((business) => business.id === selectedBusinessId) ?? null;
  const businessId = selectedBusinessId ?? "";
  const todayIso = useMemo(
    () => getTodayIsoForTimeZone(activeBusiness?.timezone ?? "UTC"),
    [activeBusiness?.timezone],
  );
  const sevenDayStart = useMemo(() => addDaysToIso(todayIso, -6), [todayIso]);
  const libraryStart = useMemo(() => addDaysToIso(todayIso, -29), [todayIso]);

  const briefingQuery = useQuery({
    queryKey: ["creatives-briefing", businessId],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    queryFn: () => fetchCreativesBriefing(businessId),
  });
  const todaySummaryQuery = useQuery({
    queryKey: ["creatives-briefing-meta-summary-today", businessId, todayIso],
    enabled: Boolean(businessId),
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaSummary(businessId, todayIso, todayIso),
  });
  const sevenDaySummaryQuery = useQuery({
    queryKey: ["creatives-briefing-meta-summary-7d", businessId, sevenDayStart, todayIso],
    enabled: Boolean(businessId),
    staleTime: 60 * 1000,
    queryFn: () => fetchMetaSummary(businessId, sevenDayStart, todayIso),
  });
  const metaStatusQuery = useQuery({
    queryKey: ["creatives-briefing-meta-status", businessId],
    enabled: Boolean(businessId),
    staleTime: 30 * 1000,
    queryFn: () => fetchMetaStatus(businessId),
  });
  const assetLibraryQuery = useQuery({
    queryKey: ["creatives-briefing-asset-library", businessId, libraryStart, todayIso],
    enabled: Boolean(businessId),
    staleTime: 60 * 1000,
    queryFn: () => fetchAssetLibraryRows({ businessId, startDate: libraryStart, endDate: todayIso }),
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
  const [removedActionIds, setRemovedActionIds] = useState<Set<string>>(new Set());
  const [launchpadOverlayState, setLaunchpadOverlayState] =
    useState<LaunchpadOverlayState>(CLOSED_LAUNCHPAD_OVERLAY_STATE);
  const [bulkCutModalState, setBulkCutModalState] =
    useState<BulkCutModalState>(CLOSED_BULK_CUT_MODAL_STATE);
  const [compareDrawerState, setCompareDrawerState] =
    useState<CompareDrawerState>(CLOSED_COMPARE_DRAWER_STATE);
  const [trackingCutCard, setTrackingCutCard] = useState<BriefingCreativeCard | null>(null);
  const [librarySelectedRowIds, setLibrarySelectedRowIds] = useState<string[]>([]);
  const [libraryHighlightedRowId, setLibraryHighlightedRowId] = useState<string | null>(null);
  const [libraryMetricIds, setLibraryMetricIds] = useState<string[]>(["spend", "roas", "cpa", "ctrAll"]);
  const [selectedIds, setSelectedIds] = usePersistentSelectedIds(businessId);
  const selectedSet = useMemo(() => new Set(selectedIds), [selectedIds]);
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

  const handleToggleLane = useCallback((laneKey: LaneKey) => {
    if (laneKey !== "action" && laneKey !== "watching" && laneKey !== "healthy") return;
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
  const actionIds = useMemo(() => visibleActionItems.map(actionItemId), [visibleActionItems]);
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

  const trackingAnomalyActive = Boolean(
    normalizedBriefingData?.trackingAnomalyActive ||
      normalizedBriefingData?.trackingBlocked ||
      normalizedBriefingData?.pulse?.trackingAnomalyActive ||
      metaStatusQuery.data?.degradedServing,
  );
  const matureCount = normalizedBriefingData?.pulse?.matureCount ?? healthyItems.length;
  const isInitialLoading = briefingQuery.isLoading && !normalizedBriefingData;
  const briefingError = briefingQuery.error instanceof Error ? briefingQuery.error.message : null;
  const deferredCount = deferState.deferredCount || normalizedBriefingData?.deferredCount || 0;
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
  const assetLibraryStatus = Array.isArray(assetLibraryPayload)
    ? null
    : assetLibraryPayload?.status ?? null;
  const assetLibraryMessage = Array.isArray(assetLibraryPayload)
    ? null
    : assetLibraryPayload?.message ?? null;
  const assetLibraryError = assetLibraryQuery.error instanceof Error ? assetLibraryQuery.error.message : null;
  const creativeDataSetupNotice = getCreativeDataSetupNotice({
    metaStatus: metaStatusQuery.data,
    assetLibraryStatus,
  });
  const assetLibraryEmptyMessage = getAssetLibraryEmptyMessage({
    status: assetLibraryStatus,
    message: assetLibraryMessage,
  });
  const launchpadOverlayItem = launchpadOverlayState.card
    ? buildLaunchpadOverlayItem(launchpadOverlayState.card)
    : null;

  const handleLaunchpadOpen = useCallback((payload: LaunchpadOpenPayload) => {
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
          void queryClient.invalidateQueries({ queryKey: ["creatives-briefing", businessId] });
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

  const handleBulkCutOpen = useCallback((cards: BriefingCreativeCard[] = selectedActionCards) => {
    if (cards.length === 0) return;
    setBulkCutModalState({ open: true, cards });
  }, [selectedActionCards]);

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
        const result = await pauseBriefingCardsBulk({ businessId, cards, trackingBlocked: trackingAnomalyActive });
        if (!result.ok) {
          throw new Error(
            result.failedCount
              ? `Bulk cut failed for ${result.failedCount} creatives.`
              : "Bulk cut failed.",
          );
        }
        showToast({
          type: "success",
          message: `Cut ${cards.length} creatives`,
        });
        setCuttingIds((current) => {
          const next = new Set(current);
          itemIds.forEach((id) => next.add(id));
          return next;
        });
        window.setTimeout(() => {
          setRemovedActionIds((current) => {
            const next = new Set(current);
            itemIds.forEach((id) => next.add(id));
            return next;
          });
          setSelectedIds((current) => current.filter((id) => !itemIds.includes(id)));
          setCuttingIds((current) => {
            const next = new Set(current);
            itemIds.forEach((id) => next.delete(id));
            return next;
          });
          void queryClient.invalidateQueries({ queryKey: ["creatives-briefing", businessId] });
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
      router.push(buildBulkLaunchpadHref(cards, mode));
    },
    [router],
  );

  const handleCompareOpen = useCallback((cards: BriefingCreativeCard[] = selectedActionCards) => {
    if (cards.length === 0) return;
    setCompareDrawerState({ open: true, cards: cards.slice(0, 5) });
  }, [selectedActionCards]);

  const handleBulkToolbarAction = useCallback(
    (action: BulkAction, cards: BriefingCreativeCard[] = selectedActionCards) => {
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

  const handleLaunchEmptyNewTest = useCallback(() => {
    router.push(EMPTY_ACTION_LAUNCH_HREF);
  }, [router]);

  if (!businessId) {
    return <div className="min-h-screen bg-slate-50 text-slate-900" />;
  }

  return (
    <div className="min-h-screen bg-slate-50 text-slate-900">
      <PulseStrip
        sticky={false}
        left={<PulseScope />}
        center={
          <PulseCenter
            spendToday={todaySummaryQuery.data?.totals?.spend}
            spendTarget={normalizedBriefingData?.pulse?.spendTarget}
            spendHistory={normalizedBriefingData?.pulse?.spendHistory}
            roas7d={sevenDaySummaryQuery.data?.totals?.roas}
            roasTarget={normalizedBriefingData?.pulse?.rolling7dRoasTarget}
            matureCount={matureCount}
          />
        }
        right={
          <PulseRight
            metaStatus={metaStatusQuery.data}
            trackingAnomalyActive={trackingAnomalyActive}
            engineVersion={normalizedBriefingData?.pulse?.engineVersion}
            calibratedAgo={normalizedBriefingData?.pulse?.calibratedAgo}
          />
        }
        jumpNav={<PulseJumpNav />}
      />

      <div className="max-w-[1440px] mx-auto px-6 pt-6 pb-2">
        <div className="flex items-baseline gap-3">
          <h1 className="text-[22px] font-semibold text-slate-900 tracking-tight">Creatives</h1>
          <span className="text-[12.5px] text-slate-500">
            Daily 5-minute triage. Engine v3 has done the thinking — confirm or redirect.
          </span>
        </div>
      </div>

      <section className="max-w-[1440px] mx-auto px-6 py-4">
        <div className="flex items-baseline gap-3 mb-3">
          <h2 className="text-[15px] font-semibold text-slate-900">Decision briefing</h2>
          <span className="text-[12px] text-slate-500">Today · {formatTodayLabel()}</span>
          <span className="ml-auto text-[11.5px] text-slate-500">
            Engine v3 confidence ≥ 70 surfaces here
          </span>
        </div>

        <TrackingBlockerBanner
          visible={trackingAnomalyActive}
          detail={trackingBlockerDetail}
        />

        {creativeDataSetupNotice ? (
          <CreativeDataSetupNotice notice={creativeDataSetupNotice} />
        ) : null}

        {briefingError ? (
          <div className="rounded-lg border border-rose-200 bg-rose-50/60 px-4 py-3 mb-4 flex items-start gap-3">
            <AlertTriangle className="text-rose-600 mt-0.5 inline-block shrink-0" size={18} aria-hidden="true" />
            <div className="flex-1 min-w-0">
              <div className="text-[13px] font-semibold text-rose-900 leading-snug">
                Briefing could not load.
              </div>
              <div className="text-[12px] text-rose-800/80 mt-0.5">{briefingError}</div>
            </div>
          </div>
        ) : null}

        <BulkToolbar
          selectedCount={actionSelectedIds.length}
          variant="creative"
          scope="action"
          actions={["cut", "demote", "launch_new", "add_existing", "compare", "clear"]}
          trackingBlocked={trackingAnomalyActive}
          trackingConfirmBehavior="consumer"
          stickyTop={trackingAnomalyActive ? "170px" : "126px"}
          onAction={(action) => handleBulkToolbarAction(action, selectedActionCards)}
          onClear={() => clearSelectedIdsForLane(actionSelectedIds)}
        />

        <div className="mb-6" data-lane-section="action" id="lane-action">
          <LaneHeader
            laneKey="action"
            title="Action now"
            count={visibleActionItems.length}
            subtitle={
              deferredCount > 0
                ? `${deferredCount} deferred — back tomorrow 9am`
                : "High-confidence engine recommendations awaiting your call."
            }
            collapsed={collapsed.action}
            onToggle={handleToggleLane}
          />
          {collapsed.action ? null : (
            <div className="space-y-3">
              {isInitialLoading ? <LaneSkeleton /> : null}
              {!isInitialLoading &&
              !briefingError &&
              visibleActionItems.length === 0 &&
              !trackingAnomalyActive &&
              !creativeDataSetupNotice ? (
                <EmptyActionState
                  matureCount={matureCount}
                  watchingCount={watchingItems.length}
                  onLaunchNewTest={handleLaunchEmptyNewTest}
                />
              ) : null}
              {!isInitialLoading && !briefingError && visibleActionItems.length === 0 && trackingAnomalyActive ? (
                <div className="rounded-2xl border border-rose-200 bg-rose-50/60 px-5 py-4 text-[12.5px] text-rose-900">
                  <div className="font-semibold">Tracking needs attention before action triage.</div>
                  <div className="mt-1 text-rose-800/80">
                    No high-confidence action cards are shown while tracking is degraded. Resolve the blocker or open Watching for diagnostic cases.
                  </div>
                </div>
              ) : null}
              {visibleActionItems.length > 0 ? visibleActionItems.map((item) =>
                  item.type === "rollup" && item.rollup ? (
                    <CrossPlacementCard
                      key={item.key}
                      rollup={item.rollup}
                      selected={selectedSet.has(actionItemId(item))}
                      onSelectChange={handleSelectChange}
                      deferred={deferState.isDeferred(getCreativeScopeId(item.rollup.primaryRec))}
                      onDefer={handleDefer}
                      onUndefer={handleUndefer}
                      onLaunchpadOpen={handleLaunchpadOpen}
                      cutting={cuttingIds.has(actionItemId(item))}
                    />
                  ) : item.card ? (
                    <ActionNowCard
                      key={item.key}
                      card={item.card}
                      selected={selectedSet.has(cardId(item.card))}
                      onSelectChange={handleSelectChange}
                      deferred={deferState.isDeferred(getCreativeScopeId(item.card))}
                      cutting={cuttingIds.has(cardId(item.card))}
                      cutPending={cutPendingIds.has(cardId(item.card)) || bulkPendingIds.has(cardId(item.card))}
                      onDefer={handleDefer}
                      onUndefer={handleUndefer}
                      onCut={handleCutRequest}
                      onLaunchpadOpen={handleLaunchpadOpen}
                    />
                  ) : null,
                ) : null}
            </div>
          )}
        </div>

        <div className="mb-6" data-lane-section="watching" id="lane-watching">
          <LaneHeader
            laneKey="watching"
            title="Watching"
            count={watchingItems.length}
            subtitle={
              collapsed.watching
                ? "Low-confidence and diagnose cases. Click expand to triage."
                : "Low-confidence cases · let cook or open evidence."
            }
            collapsed={collapsed.watching}
            onToggle={handleToggleLane}
          />
          {collapsed.watching ? null : (
            <>
              <BulkToolbar
                selectedCount={watchingSelectedIds.length}
                variant="creative"
                scope="watching"
                actions={["launch_new", "add_existing", "compare", "clear"]}
                trackingBlocked={trackingAnomalyActive}
                trackingConfirmBehavior="consumer"
                stickyTop={trackingAnomalyActive ? "170px" : "126px"}
                onAction={(action) => handleBulkToolbarAction(action, selectedWatchingCards)}
                onClear={() => clearSelectedIdsForLane(watchingSelectedIds)}
              />
              <div className="grid grid-cols-1 lg:grid-cols-2 gap-2">
                {watchingItems.map((card) => (
                  <WatchingCard
                    key={cardId(card)}
                    card={card}
                    selected={selectedSet.has(cardId(card))}
                    onSelectChange={handleSelectChange}
                    deferred={deferState.isDeferred(getCreativeScopeId(card))}
                    onDefer={handleDefer}
                    onUndefer={handleUndefer}
                    onLaunchpadOpen={handleLaunchpadOpen}
                  />
                ))}
              </div>
            </>
          )}
        </div>

        <div className="mb-2" data-lane-section="healthy" id="lane-healthy">
          <LaneHeader
            laneKey="healthy"
            title="Healthy"
            count={healthyItems.length}
            subtitle={
              collapsed.healthy
                ? "Stable keep + scale. Operator rarely opens this lane."
                : "Compact list — name, label, ROAS only."
            }
            collapsed={collapsed.healthy}
            onToggle={handleToggleLane}
          />
          {collapsed.healthy ? null : (
            <div className="rounded-xl border border-slate-200 bg-white overflow-hidden divide-y divide-slate-100 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
              {healthyItems.slice(0, 20).map((card) => (
                <HealthyRow
                  key={cardId(card)}
                  card={card}
                  selected={selectedSet.has(cardId(card))}
                  onSelectChange={handleSelectChange}
                />
              ))}
              {healthyItems.length > 20 ? (
                <div className="px-3 py-2 text-[11px] text-slate-400 bg-slate-50 text-center">
                  + {healthyItems.length - 20} more healthy creatives in{" "}
                  <span className="text-slate-500">Library</span>
                </div>
              ) : null}
            </div>
          )}
        </div>

        <span className="sr-only">{actionSelectedIds.length} action selections prepared for Phase 3.4</span>
        <span className="sr-only">{watchingIds.length + healthyIds.length} non-action lane rows loaded</span>
        <SectionErrorBoundary
          title="Asset Library is temporarily unavailable."
          resetKey={`${businessId}:${libraryStart}:${todayIso}:${assetLibraryRows.length}`}
        >
          {assetLibraryError ? (
            <div className="mt-8 rounded-2xl border border-amber-200 bg-amber-50/70 px-5 py-4 text-[12.5px] text-amber-950">
              <div className="font-semibold">Asset Library could not load.</div>
              <div className="mt-1 text-amber-900/80">{assetLibraryError}</div>
            </div>
          ) : (
            <AssetLibrarySection
              rows={assetLibraryRows}
              emptyMessage={assetLibraryEmptyMessage}
              defaultCurrency={activeBusiness?.currency ?? null}
              selectedMetricIds={libraryMetricIds}
              onSelectedMetricIdsChange={setLibraryMetricIds}
              selectedRowIds={librarySelectedRowIds}
              highlightedRowId={libraryHighlightedRowId}
              onToggleRow={handleToggleLibraryRow}
              onToggleAll={handleToggleAllLibraryRows}
              onOpenRow={setLibraryHighlightedRowId}
              onSortedRowsChange={(rows: MetaCreativeRow[]) => {
                if (!libraryHighlightedRowId && rows[0]) setLibraryHighlightedRowId(rows[0].id);
              }}
            />
          )}
        </SectionErrorBoundary>
      </section>
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
      <CompareDrawerHost
        open={compareDrawerState.open}
        cards={compareDrawerState.cards}
        onClose={() => setCompareDrawerState(CLOSED_COMPARE_DRAWER_STATE)}
        onCutCards={handleBulkCutOpen}
        onLaunchpad={handleBulkLaunchpadTeleport}
      />
      <BriefingToastViewport toast={toast} />
    </div>
  );
}

function PulseScope() {
  return (
    <button
      type="button"
      data-pulse="scope"
      className="flex items-center gap-1.5 px-2 py-1 rounded-md border border-slate-200 bg-slate-50 text-slate-700 hover:bg-slate-100"
      onClick={(event) => {
        event.preventDefault();
        // TODO Phase 11+: within-business scope filter — Account / Campaign / Adset.
      }}
    >
      <span className="text-slate-400">
        <Layers className="inline-block shrink-0" size={13} aria-hidden="true" />
      </span>
      <span>Scope:</span>
      <span className="font-medium text-slate-900">Account</span>
      <ChevronDown className="inline-block shrink-0 text-slate-400" size={12} aria-hidden="true" />
    </button>
  );
}

function BriefingToastViewport({ toast }: { toast: BriefingToast | null }) {
  if (!toast) return null;

  return (
    <div
      className={`fixed bottom-5 right-5 z-[120] max-w-md rounded-xl border px-4 py-3 text-sm shadow-xl ${
        toast.type === "success"
          ? "border-emerald-200 bg-emerald-50 text-emerald-900"
          : toast.type === "error"
            ? "border-rose-200 bg-rose-50 text-rose-900"
            : "border-slate-200 bg-white text-slate-900"
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
            <ExternalLink className="inline-block shrink-0" size={13} aria-hidden="true" />
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
  const sparkValues = Array.isArray(spendHistory) && spendHistory.length > 0
    ? spendHistory.concat([spend])
    : [0, spend * 0.62, spend * 0.78, spend];
  const roas = numberOrZero(roas7d);
  const targetRoas = numberOrZero(roasTarget) || roas || 1;
  const roasDelta = Math.round(((roas - targetRoas) / targetRoas) * 100);
  const DeltaIcon = roasDelta >= 0 ? TrendingUp : TrendingDown;

  return (
    <>
      <div className="h-5 w-px bg-slate-200" />
      <button data-pulse="spend" className="flex items-center gap-2 hover:bg-slate-50 rounded-md px-1.5 py-1">
        <span className="text-slate-500">Spend today</span>
        <span className="font-mono tabular-nums font-semibold text-slate-900">
          {formatCurrency(spend)}
        </span>
        <span className="text-slate-400">/ {formatCurrency(target)}</span>
        <svg viewBox="0 0 60 16" width="60" height="16" className="text-blue-600" aria-hidden="true">
          <path d={sparklinePath(sparkValues)} fill="none" stroke="currentColor" strokeWidth="1.5" />
        </svg>
        <span className="text-slate-500 font-mono tabular-nums">{spendPct}%</span>
      </button>
      <button data-pulse="roas" className="flex items-center gap-2 hover:bg-slate-50 rounded-md px-1.5 py-1">
        <span className="text-slate-500">7d ROAS</span>
        <span className="font-mono tabular-nums font-semibold text-slate-900">{formatRoas(roas)}</span>
        <span className={`${roasDelta >= 0 ? "text-emerald-600" : "text-rose-600"} inline-flex items-center gap-0.5`}>
          <DeltaIcon className="inline-block shrink-0" size={12} aria-hidden="true" />
          <span className="font-mono tabular-nums">{roasDelta >= 0 ? "+" : ""}{roasDelta}%</span>
        </span>
        <span className="text-slate-400">vs {formatRoas(targetRoas)}</span>
      </button>
      <button data-pulse="mature" className="flex items-center gap-1.5 hover:bg-slate-50 rounded-md px-1.5 py-1">
        <span className="text-slate-500">Mature</span>
        <span className="font-mono tabular-nums font-semibold text-slate-900">{matureCount}</span>
      </button>
      <div className="h-5 w-px bg-slate-200" />
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
  const engineLive = !metaStatus || metaStatus.state === "ready" || metaStatus.state === "partial";
  const syncMinutes = getSyncMinutes(metaStatus);
  const calibratedLabel = relativeTime(calibratedAgo) ?? "2d ago";

  return (
    <div className="flex flex-wrap items-center gap-3 text-slate-500">
      <button
        data-pulse="engine"
        className="flex flex-shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 whitespace-nowrap hover:bg-slate-50"
      >
        <span
          className={`inline-flex items-center gap-1 px-1.5 py-0.5 rounded-md text-[10px] font-semibold uppercase tracking-wider ${
            engineLive
              ? "bg-emerald-500/15 text-emerald-700 border border-emerald-200"
              : "bg-amber-500/15 text-amber-800 border border-amber-200"
          }`}
        >
          <span className={`w-1.5 h-1.5 rounded-full ${engineLive ? "bg-emerald-500" : "bg-amber-500"}`} />
          {engineLive ? "Live" : "Syncing"}
        </span>
        <span className="max-w-[180px] truncate text-slate-500">{engineVersion || "Engine v3"}</span>
        <span className="text-slate-400">· calibrated {calibratedLabel}</span>
      </button>
      <button
        data-pulse="tracking"
        className="flex flex-shrink-0 items-center gap-1.5 rounded-md px-1.5 py-1 whitespace-nowrap hover:bg-slate-50"
        id="pulse-tracking"
      >
        {trackingAnomalyActive ? (
          <AlertTriangle className="inline-block shrink-0 text-rose-600" size={13} aria-hidden="true" />
        ) : (
          <ShieldCheck className="inline-block shrink-0 text-emerald-600" size={13} aria-hidden="true" />
        )}
        <span className={trackingAnomalyActive ? "text-rose-700" : "text-slate-700"}>
          {trackingAnomalyActive ? "Tracking anomaly active" : "Tracking healthy"}
        </span>
      </button>
      <span className="inline-flex flex-shrink-0 items-center gap-1 whitespace-nowrap">
        <span className="text-slate-400">
          <RefreshCw className="inline-block shrink-0" size={12} aria-hidden="true" />
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
      className="shrink-0 inline-flex items-center gap-1 px-2 py-1 rounded-md text-slate-500 hover:bg-slate-100 hover:text-slate-900"
    >
      <span className="font-mono tabular-nums text-slate-400">{num}</span>
      <span>{label}</span>
    </a>
  );
}

function LaneSkeleton() {
  return (
    <div className="rounded-2xl bg-white p-4 border border-slate-200 shadow-[0_1px_2px_rgba(15,23,42,0.04)]">
      <div className="flex items-start gap-3">
        <div className="w-4 h-4 rounded border border-slate-200 bg-slate-100" />
        <div className="w-[72px] h-[72px] rounded-xl bg-slate-100" />
        <div className="flex-1 min-w-0 space-y-2">
          <div className="h-4 w-60 rounded bg-slate-100" />
          <div className="h-3 w-96 rounded bg-slate-100" />
          <div className="h-3 w-full rounded bg-slate-100" />
        </div>
      </div>
    </div>
  );
}
