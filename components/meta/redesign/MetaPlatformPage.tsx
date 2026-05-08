"use client";

import { useMemo, useState } from "react";
import { useRouter, useSearchParams } from "next/navigation";
import { useQuery, useQueryClient } from "@tanstack/react-query";
import { AlertTriangle, GitCompare, Plus, RefreshCw, Rocket, SlidersHorizontal, Target, TrendingUp } from "lucide-react";
import {
  BulkToolbar,
  CompareDrawer,
  LaneHeader,
  TrackingConfirmModal,
  TrackingBlockerBanner,
  useDeferState,
  type CompareDrawerItem,
} from "@/components/common/briefing";
import type { MetaAnomaly } from "@/lib/meta/anomalies";
import type { MetaRecommendation } from "@/lib/meta/recommendations";
import { cn } from "@/lib/utils";
import { CrossAdsetRollupCard } from "@/components/meta/redesign/CrossAdsetRollupCard";
import { MetaActionCard } from "@/components/meta/redesign/MetaActionCard";
import { MetaAlertsStrip } from "@/components/meta/redesign/MetaAlertsStrip";
import { MetaDrillDrawer } from "@/components/meta/redesign/MetaDrillDrawer";
import { MetaHealthyRow } from "@/components/meta/redesign/MetaHealthyRow";
import { MetaLaunchpadOverlay } from "@/components/meta/redesign/MetaLaunchpadOverlay";
import { MetaPulse } from "@/components/meta/redesign/MetaPulse";
import { MetaScopeChip } from "@/components/meta/redesign/MetaScopeChip";
import { MetaWatchingCard } from "@/components/meta/redesign/MetaWatchingCard";
import {
  decisionLabelForRec,
  launchModeForRec,
  proposedBidValue,
  scopeIdForRec,
  scopeNameForRec,
} from "@/components/meta/redesign/meta-card-utils";
import type {
  MetaDrillItem,
  MetaHealthyEntity,
  MetaLanePayload,
  MetaLaunchMode,
  MetaPulsePayload,
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

function fetchPulse(businessId: string, window: MetaWindowKey) {
  const params = new URLSearchParams({ businessId, window });
  return readJson<MetaPulsePayload>(`/api/meta/account-pulse?${params.toString()}`);
}

function fetchLanes(businessId: string, window: MetaWindowKey) {
  const params = new URLSearchParams({ businessId, window });
  return readJson<MetaLanePayload>(`/api/meta/lane-classify?${params.toString()}`);
}

function fetchAnomalies(businessId: string) {
  const params = new URLSearchParams({ businessId, activeOnly: "1" });
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

function launchpadHrefForRec(rec: MetaRecommendation, mode: MetaLaunchMode) {
  const params = new URLSearchParams({
    mode,
    fromMetaBriefing: "true",
  });
  if (rec.campaignId) params.set("campaignIds", rec.campaignId);
  if (rec.adsetId) params.set("adsetIds", rec.adsetId);
  return `/platforms/meta/launchpad?${params.toString()}`;
}

function compareItemForRec(rec: MetaRecommendation): CompareDrawerItem {
  const trail = rec.evidenceTrail;
  const peerValue = trail?.peer_comparison?.this_value;
  return {
    id: rec.id,
    name: scopeNameForRec(rec),
    brand: rec.campaignName ?? "Meta",
    label: decisionLabelForRec(rec),
    spend: Number(rec.evidence.find((item) => /spend/i.test(item.label))?.value.replace(/[^0-9.]/g, "") ?? 0),
    roas: typeof peerValue === "number" ? peerValue : Number(rec.evidence.find((item) => /roas/i.test(item.label))?.value.replace(/[^0-9.]/g, "") ?? 0),
    cpa: Number(rec.evidence.find((item) => /cpa/i.test(item.label))?.value.replace(/[^0-9.]/g, "") ?? 0),
    ctr: Number(rec.evidence.find((item) => /ctr/i.test(item.label))?.value.replace(/[^0-9.]/g, "") ?? 0),
    purchases: Number(rec.evidence.find((item) => /purchase/i.test(item.label))?.value.replace(/[^0-9.]/g, "") ?? 0),
    frequency: Number(rec.evidence.find((item) => /frequency/i.test(item.label))?.value.replace(/[^0-9.]/g, "") ?? 0),
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

function MetaHealthyHierarchy({ groups }: { groups: HealthyCampaignGroup[] }) {
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

function EmptyActionState({ anomaliesCount }: { anomaliesCount: number }) {
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
    </div>
  );
}

export function MetaPlatformPage({ businessId, businessName, currency = "USD" }: MetaPlatformPageProps) {
  void currency;
  const router = useRouter();
  const searchParams = useSearchParams();
  const queryClient = useQueryClient();
  const selectedWindow = (searchParams.get("window") as MetaWindowKey | null) ?? "28d";
  const [collapsed, setCollapsed] = useState<Record<string, boolean>>({});
  const [selectedIds, setSelectedIds] = useState<Set<string>>(new Set());
  const [drillItem, setDrillItem] = useState<MetaDrillItem | null>(null);
  const [overlay, setOverlay] = useState<OverlayState>(EMPTY_OVERLAY);
  const [compareOpen, setCompareOpen] = useState(false);
  const [pendingPrimaryRec, setPendingPrimaryRec] = useState<MetaRecommendation | null>(null);
  const [localDeferredIds, setLocalDeferredIds] = useState<Set<string>>(new Set());
  const [trackingDismissed, setTrackingDismissed] = useState(false);
  const [notice, setNotice] = useState<string | null>(null);

  const pulseQuery = useQuery({
    queryKey: ["meta-account-pulse", businessId, selectedWindow],
    enabled: Boolean(businessId),
    queryFn: () => fetchPulse(businessId, selectedWindow),
  });
  const laneQuery = useQuery({
    queryKey: ["meta-lanes", businessId, selectedWindow],
    enabled: Boolean(businessId),
    queryFn: () => fetchLanes(businessId, selectedWindow),
  });
  const anomalyQuery = useQuery({
    queryKey: ["meta-anomalies", businessId],
    enabled: Boolean(businessId),
    queryFn: () => fetchAnomalies(businessId),
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
  const anomalies = anomalyQuery.data?.anomalies ?? [];
  const healthyGroups = useMemo(() => groupHealthyEntities(healthy), [healthy]);
  const rollups = useMemo(() => groupAdsetRollups(actionNow), [actionNow]);
  const rollupRecIds = useMemo(
    () => new Set(rollups.flatMap((rollup) => rollup.items.map((rec) => rec.id))),
    [rollups],
  );
  const individualActionNow = useMemo(
    () => actionNow.filter((rec) => !rollupRecIds.has(rec.id)),
    [actionNow, rollupRecIds],
  );
  const allRecs = useMemo(() => [...actionNow, ...watching], [actionNow, watching]);
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

  const trackingBlocked =
    !trackingDismissed &&
    Boolean(
      pulseQuery.data?.trackingAnomalyActive ??
        (pulseQuery.data?.trackingHealth.status === "blocked" ||
          pulseQuery.data?.trackingHealth.status === "degraded"),
    );

  const setWindow = (next: MetaWindowKey) => {
    const params = new URLSearchParams(searchParams.toString());
    if (next === "28d") {
      params.delete("window");
    } else {
      params.set("window", next);
    }
    router.replace(`/platforms/meta${params.toString() ? `?${params.toString()}` : ""}`);
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

  const markActed = async (rec: MetaRecommendation, subtype: string) => {
    await postResponse({ businessId, recId: rec.id, action: "acted", actionSubtype: subtype }).catch(() => null);
  };

  const deferRec = async (rec: MetaRecommendation) => {
    const scopeId = scopeIdForRec(rec);
    const state = rec.level === "adset" ? adsetDefer : campaignDefer;
    setLocalDeferredIds((current) => new Set(current).add(rec.id));
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
    return localDeferredIds.has(rec.id) || state.isDeferred(scopeIdForRec(rec));
  };

  const openOverlayForRec = (rec: MetaRecommendation, mode: MetaLaunchMode) => {
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
    return rec.type === "adset_cut_spend" || launchModeForRec(rec) === "rebuild";
  };

  const performPrimary = async (rec: MetaRecommendation) => {
    if (rec.type === "adset_cut_spend" && rec.adsetId) {
      await fetch(`/api/meta/adsets/${encodeURIComponent(rec.adsetId)}/pause`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, recId: rec.id }),
      });
      await markActed(rec, "paused");
      setNotice("Adset pause requested.");
      await refreshDecisionData();
      return;
    }
    const mode = launchModeForRec(rec);
    if (mode) {
      openOverlayForRec(rec, mode);
      return;
    }
    openDrillForRec(rec);
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
    if (overlay.mode === "apply_bid" && rec.adsetId) {
      const proposed = proposedBidValue(rec) ?? 0;
      await fetch(`/api/meta/adsets/${encodeURIComponent(rec.adsetId)}/apply-bid`, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ businessId, bidValue: proposed, recId: rec.id }),
      });
      await markActed(rec, "bid_applied");
      setNotice("Bid cap apply requested.");
      setOverlay(EMPTY_OVERLAY);
      await refreshDecisionData();
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

  const loading = pulseQuery.isLoading || laneQuery.isLoading;
  const error = pulseQuery.error ?? laneQuery.error ?? anomalyQuery.error;

  return (
    <div className="min-h-screen bg-slate-100 text-slate-900" data-testid="meta-platform-page">
      <MetaPulse pulse={pulseQuery.data ?? null} window={selectedWindow} onWindowChange={setWindow} />

      <main className="mx-auto max-w-[1440px] px-6 py-5">
        <div className="mb-4 flex items-center gap-3">
          <div>
            <h1 className="text-[18px] font-semibold text-slate-950">Meta Decision Center</h1>
            <div className="text-[12px] text-slate-500">{businessName ?? "Selected account"} · snapshot-first briefing</div>
          </div>
          {notice ? (
            <div className="ml-auto rounded-md border border-emerald-200 bg-emerald-50 px-2 py-1 text-[12px] text-emerald-700">
              {notice}
            </div>
          ) : null}
        </div>

        {trackingBlocked ? (
          <TrackingBlockerBanner
            detail={pulseQuery.data?.trackingHealth.detail}
            onViewDetails={() => setDrillItem(anomalies[0] ? { mode: "anomaly", anomaly: anomalies[0] } : null)}
            onDismiss={() => setTrackingDismissed(true)}
          />
        ) : null}

        <MetaAlertsStrip
          anomalies={anomalies}
          snapshotDate={anomalyQuery.data?.snapshotDate}
          onOpenDiagnostic={(anomaly) => setDrillItem({ mode: "anomaly", anomaly })}
        />

        <BulkToolbar
          selectedCount={selectedIds.size}
          variant="meta"
          trackingBlocked={trackingBlocked}
          stickyTop="132px"
          onAction={handleBulkAction}
          onClear={() => setSelectedIds(new Set())}
        />

        {loading ? (
          <div className="mt-4 grid gap-3 md:grid-cols-2">
            {Array.from({ length: 4 }).map((_, index) => (
              <div key={index} className="h-48 animate-pulse rounded-2xl border border-slate-200 bg-white" />
            ))}
          </div>
        ) : error ? (
          <div className="mt-4 rounded-xl border border-rose-200 bg-rose-50 p-4 text-[13px] text-rose-700">
            {error instanceof Error ? error.message : "Meta briefing failed."}
          </div>
        ) : (
          <div className="mt-4 grid gap-5">
            <section id="action-now" className="scroll-mt-40">
              <LaneHeader
                laneKey="action"
                title="Action Now"
                count={individualActionNow.length + rollups.length + anomalies.length}
                subtitle="confidence >= 70%, excluding deferred and learning"
                variant="meta"
                collapsed={collapsed.action}
                onToggle={() => setCollapsed((current) => ({ ...current, action: !current.action }))}
              />
              {!collapsed.action ? (
                <div className={cn("grid gap-3", individualActionNow.length + rollups.length > 1 || anomalies.length > 0 ? "lg:grid-cols-2" : "")}>
                  {anomalies.map((anomaly) => (
                    <MetaActionCard
                      key={anomaly.id}
                      anomaly={anomaly}
                      onOpenDrill={(item) => setDrillItem({ mode: "anomaly", anomaly: item as MetaAnomaly })}
                    />
                  ))}
                  {rollups.map((rollup) => (
                    <CrossAdsetRollupCard
                      key={rollup.campaignId}
                      campaignName={rollup.campaignName}
                      recs={rollup.items}
                      onOpenRec={openDrillForRec}
                    />
                  ))}
                  {individualActionNow.map((rec) => (
                    <MetaActionCard
                      key={rec.id}
                      rec={rec}
                      selected={selectedIds.has(rec.id)}
                      deferred={isDeferred(rec)}
                      evidenceWindow={selectedWindow}
                      onSelect={selectRec}
                      onPrimary={handlePrimary}
                      onOpenDrill={(item) => openDrillForRec(item as MetaRecommendation)}
                      onDefer={deferRec}
                      onUndoDefer={undeferRec}
                    />
                  ))}
                  {individualActionNow.length === 0 && rollups.length === 0 && anomalies.length === 0 ? <EmptyActionState anomaliesCount={0} /> : null}
                </div>
              ) : null}
            </section>

            <section id="watching" className="scroll-mt-40">
              <LaneHeader
                laneKey="watching"
                title="Watching"
                count={watching.length}
                subtitle="learning, recent changes, or insufficient signal"
                variant="meta"
                collapsed={collapsed.watching}
                onToggle={() => setCollapsed((current) => ({ ...current, watching: !current.watching }))}
              />
              {!collapsed.watching ? (
                <div className="grid gap-3 lg:grid-cols-2">
                  {watching.map((rec) => (
                    <MetaWatchingCard
                      key={rec.id}
                      rec={rec}
                      deferred={isDeferred(rec)}
                      evidenceWindow={selectedWindow}
                      onOpenDrill={openDrillForRec}
                      onDefer={deferRec}
                      onUndoDefer={undeferRec}
                    />
                  ))}
                  {watching.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12.5px] text-slate-500">
                      No watchlist items in the latest snapshot.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section id="healthy" className="scroll-mt-40">
              <LaneHeader
                laneKey="healthy"
                title="Healthy"
                count={healthy.length}
                subtitle="stable mature campaigns and adsets without triggered recs"
                variant="meta"
                collapsed={collapsed.healthy}
                onToggle={() => setCollapsed((current) => ({ ...current, healthy: !current.healthy }))}
              />
              {!collapsed.healthy ? (
                <div className="grid gap-2">
                  <MetaHealthyHierarchy groups={healthyGroups} />
                  {healthy.length === 0 ? (
                    <div className="rounded-xl border border-slate-200 bg-white p-4 text-[12.5px] text-slate-500">
                      Healthy entities will appear after the latest snapshot has enough stable mature rows.
                    </div>
                  ) : null}
                </div>
              ) : null}
            </section>

            <section id="audience-builder" className="scroll-mt-40 opacity-80">
              <LaneHeader
                laneKey="audience"
                title="Audience Builder"
                count={0}
                subtitle="reserved slot for audience clustering and Meta Launchpad handoff"
                variant="meta"
                collapsed={collapsed.audience}
                onToggle={() => setCollapsed((current) => ({ ...current, audience: !current.audience }))}
              />
              {!collapsed.audience ? (
                <div className="rounded-2xl border border-dashed border-violet-200 bg-white/70 p-4" data-meta-audience-builder>
                  <div className="flex items-start gap-3">
                    <div className="rounded-lg bg-violet-50 p-2 text-violet-700">
                      <Target className="inline-block shrink-0" size={16} aria-hidden="true" />
                    </div>
                    <div className="min-w-0">
                      <div className="text-[13px] font-semibold text-slate-900">Audience builder</div>
                      <p className="mt-1 text-[12.5px] leading-snug text-slate-500">
                        Future Meta audience clusters will land here before they are bridged into Launchpad. Current live decisions continue to use campaign and adset lanes above.
                      </p>
                    </div>
                  </div>
                </div>
              ) : null}
            </section>
          </div>
        )}
      </main>

      <MetaDrillDrawer
        item={drillItem}
        window={selectedWindow}
        onWindowChange={setWindow}
        onClose={() => setDrillItem(null)}
        onLaunch={() => {
          if (drillItem?.mode !== "decision") return;
          const mode = launchModeForRec(drillItem.rec) ?? "rebuild";
          openOverlayForRec(drillItem.rec, mode);
        }}
      />

      <MetaLaunchpadOverlay
        open={overlay.open}
        mode={overlay.mode}
        item={{
          id: overlay.rec ? scopeIdForRec(overlay.rec) : "meta",
          name: overlay.rec ? scopeNameForRec(overlay.rec) : "Meta action",
          campaign: overlay.rec?.campaignName,
          proposedBidCap: overlay.rec ? (proposedBidValue(overlay.rec) ?? undefined) : undefined,
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
            <button type="button" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-rose-600 text-white border border-rose-600 hover:bg-rose-700 text-[12.5px] font-medium">
              <AlertTriangle className="inline-block shrink-0" size={13} aria-hidden="true" /> Pause weakest
            </button>
            <button type="button" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md bg-emerald-600 text-white border border-emerald-600 hover:bg-emerald-700 text-[12.5px] font-medium">
              <TrendingUp className="inline-block shrink-0" size={13} aria-hidden="true" /> Scale strongest
            </button>
            <button type="button" className="inline-flex items-center gap-1 px-3 py-1.5 rounded-md border border-blue-200 bg-white text-blue-700 hover:bg-blue-50 text-[12.5px] font-medium">
              <Rocket className="inline-block shrink-0" size={13} aria-hidden="true" /> Launch test with these
            </button>
            <span className="ml-auto inline-flex items-center gap-1 text-[11.5px] text-slate-500">
              <GitCompare className="inline-block shrink-0" size={12} aria-hidden="true" />
              Meta metrics: spend, ROAS, CPA, CPM, frequency, conversions
            </span>
          </>
        }
      />

      <TrackingConfirmModal
        open={pendingPrimaryRec != null}
        primaryLabel={pendingPrimaryRec?.type === "adset_cut_spend" ? "Pause anyway" : "Rebuild anyway"}
        onClose={() => setPendingPrimaryRec(null)}
        onConfirm={() => {
          const rec = pendingPrimaryRec;
          setPendingPrimaryRec(null);
          if (rec) void performPrimary(rec);
        }}
      />

      <a
        href="/platforms/meta/launchpad?fromMetaBriefing=true&mode=duplicate"
        className="fixed bottom-5 right-5 inline-flex items-center gap-1 rounded-full bg-slate-900 px-4 py-2 text-[12.5px] font-medium text-white shadow-lg hover:bg-slate-800"
      >
        <Plus className="inline-block shrink-0" size={14} aria-hidden="true" />
        Launch test
      </a>
      <button
        type="button"
        className="fixed bottom-5 right-[150px] inline-flex items-center gap-1 rounded-full border border-slate-300 bg-white px-3 py-2 text-[12.5px] font-medium text-slate-700 shadow-lg hover:bg-slate-50"
        onClick={() => {
          const first = actionNow[0];
          if (first) openOverlayForRec(first, "rebuild");
        }}
      >
        <RefreshCw className="inline-block shrink-0" size={14} aria-hidden="true" />
        Rebuild
      </button>
    </div>
  );
}
