"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";
import type { TierZeroFreshnessState } from "@/components/states/TierZeroFreshness";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { GoogleAdvisorResponse } from "@/src/services/google";
import { useAppStore } from "@/store/app-store";
import { useTierZeroFreshnessStore } from "@/store/tier-zero-freshness-store";

/**
 * Reads the Action Now lane size straight out of whatever the decisions
 * workspace query has already cached for this business.
 *
 * The workspace endpoint is a composed fan-out with a multi-second deadline, so
 * the rail must never trigger it on its own — it only mirrors a count the Meta
 * surface has already paid for. When no snapshot is cached the badge stays
 * absent rather than rendering a fabricated 0, per the page contract that
 * missing data is never shown as zero.
 *
 * The cache is read through `useSyncExternalStore` rather than a subscription
 * that calls `setState`. Mounting any `useQuery` emits a cache event during the
 * owning component's render, so a setState-based subscriber updated the rail
 * mid-render of an unrelated page and React warned about it.
 */
export function useMetaActionNowCount(): number | null {
  const queryClient = useQueryClient();
  const businessId = useAppStore((state) => state.selectedBusinessId);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  );

  const getSnapshot = useCallback(() => {
    if (!businessId) return null;
    const entries = queryClient
      .getQueryCache()
      .findAll({ queryKey: ["meta-decisions-workspace", businessId] });
    let next: number | null = null;
    for (const entry of entries) {
      const payload = entry.state.data as
        MetaDecisionsWorkspacePayload | undefined;
      const lanes = payload?.lanes;
      if (lanes && typeof lanes.counts?.actionNow === "number") {
        next = lanes.counts.actionNow;
      }
    }
    return next;
  }, [businessId, queryClient]);

  // The server never has a cached workspace snapshot, so the badge is absent there.
  const getServerSnapshot = useCallback(() => null, []);

  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

/** Mirrors the last real Google Advisor result already loaded for this business. */
export function useGoogleAdvisorCount(): number | null {
  const queryClient = useQueryClient();
  const businessId = useAppStore((state) => state.selectedBusinessId);

  const subscribe = useCallback(
    (onStoreChange: () => void) =>
      queryClient.getQueryCache().subscribe(onStoreChange),
    [queryClient],
  );

  const getSnapshot = useCallback(() => {
    if (!businessId) return null;
    const payload = queryClient.getQueryData<GoogleAdvisorResponse>([
      "google-advisor",
      businessId,
    ]);
    return payload ? payload.recommendations.length : null;
  }, [businessId, queryClient]);

  const getServerSnapshot = useCallback(() => null, []);
  return useSyncExternalStore(subscribe, getSnapshot, getServerSnapshot);
}

async function fetchJson<T>(url: string): Promise<T> {
  const response = await fetch(url, {
    cache: "no-store",
    headers: { Accept: "application/json" },
  });
  const payload = await response.json().catch(() => null);
  if (!response.ok) {
    throw new Error(
      (payload as { message?: string } | null)?.message ??
        `Request failed (${response.status})`,
    );
  }
  return payload as T;
}

export type WorkspaceSyncTone = "fresh" | "syncing" | "attention" | "unknown";

export interface WorkspaceSyncState {
  tone: WorkspaceSyncTone;
  label: string;
  freshnessState: TierZeroFreshnessState | "unknown";
}

function minutesSince(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / 60_000));
}

export function formatSyncAge(minutes: number | null): string {
  if (minutes === null) return "Synced —";
  if (minutes < 1) return "Synced just now";
  if (minutes < 60) return `Synced ${minutes}m ago`;
  const hours = Math.round(minutes / 60);
  if (hours < 24) return `Synced ${hours}h ago`;
  return `Synced ${Math.round(hours / 24)}d ago`;
}

/**
 * Topbar freshness chip. Reuses the Meta and Google Ads status endpoints (and
 * therefore their existing react-query cache entries) and reports the most
 * recent completed provider sync across the workspace.
 */
export function useWorkspaceSyncState(): WorkspaceSyncState {
  const businessId = useAppStore((state) => state.selectedBusinessId);
  const activeSurface = useTierZeroFreshnessStore((state) => state.active);
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const enabled =
    Boolean(businessId) && hasHydrated && authBootstrapStatus === "ready";

  const metaStatus = useQuery({
    queryKey: ["meta-status", businessId],
    enabled,
    staleTime: 60_000,
    queryFn: () =>
      fetchJson<MetaStatusResponse>(
        `/api/meta/status?businessId=${encodeURIComponent(businessId!)}`,
      ),
  });

  const googleStatus = useQuery({
    queryKey: ["google-ads-status", businessId],
    enabled,
    staleTime: 60_000,
    queryFn: () =>
      fetchJson<GoogleAdsStatusResponse>(
        `/api/google-ads/status?businessId=${encodeURIComponent(businessId!)}`,
      ),
  });

  const activeSurfaceForBusiness =
    activeSurface &&
    (!activeSurface.businessId || activeSurface.businessId === businessId)
      ? activeSurface
      : null;

  const now = Date.now();
  if (activeSurfaceForBusiness) {
    if (
      activeSurfaceForBusiness.state === "loading" ||
      activeSurfaceForBusiness.state === "refreshing"
    ) {
      return {
        tone: "syncing",
        label: "Syncing now",
        freshnessState: activeSurfaceForBusiness.state,
      };
    }
    if (
      activeSurfaceForBusiness.state === "error" ||
      activeSurfaceForBusiness.state === "partial"
    ) {
      return {
        tone: "attention",
        label: "Sync needs attention",
        freshnessState: activeSurfaceForBusiness.state,
      };
    }
    const surfaceAge = minutesSince(activeSurfaceForBusiness.asOf, now);
    if (surfaceAge !== null) {
      return {
        tone: "fresh",
        label: formatSyncAge(surfaceAge),
        freshnessState: "ready",
      };
    }
  }

  const ages = [
    minutesSince(metaStatus.data?.latestSync?.finishedAt, now),
    minutesSince(googleStatus.data?.latestSync?.finishedAt, now),
  ].filter((value): value is number => value !== null);

  const syncing =
    metaStatus.data?.state === "syncing" ||
    googleStatus.data?.state === "syncing";
  const attention =
    metaStatus.data?.state === "action_required" ||
    metaStatus.data?.state === "connected_no_assignment" ||
    googleStatus.data?.state === "action_required" ||
    googleStatus.data?.state === "connected_no_assignment";

  if (syncing) {
    return {
      tone: "syncing",
      label: "Syncing now",
      freshnessState: ages.length === 0 ? "loading" : "refreshing",
    };
  }
  if (ages.length === 0) {
    return attention
      ? {
          tone: "attention",
          label: "Sync needs attention",
          freshnessState: "partial",
        }
      : {
          tone: "unknown",
          label: "Synced —",
          freshnessState: "unknown",
        };
  }

  const freshest = Math.min(...ages);
  return {
    tone: attention ? "attention" : "fresh",
    label: formatSyncAge(freshest),
    freshnessState: attention ? "partial" : "ready",
  };
}
