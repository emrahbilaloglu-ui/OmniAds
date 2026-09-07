"use client";

import { useQuery, useQueryClient } from "@tanstack/react-query";
import { useCallback, useSyncExternalStore } from "react";
import type { MetaDecisionsWorkspacePayload } from "@/components/meta/redesign/types";
import type { TierZeroFreshnessState } from "@/components/states/TierZeroFreshness";
import type { GoogleAdsStatusResponse } from "@/lib/google-ads/status-types";
import type { MetaStatusResponse } from "@/lib/meta/status-types";
import type { GoogleAdvisorResponse } from "@/src/services/google";
import { useOptionalWorkspaceContext } from "@/components/workspace/workspace-context-provider";
import { useAppStore } from "@/store/app-store";
import { useTierZeroFreshnessStore } from "@/store/tier-zero-freshness-store";
import { SYNC_AGE_UNKNOWN_LABEL } from "@/lib/provider-sync-vocabulary";

/**
 * The one business the shell chrome is allowed to name — or `null`.
 *
 * The shell had two answers to "which business". The topbar read the
 * server-resolved envelope, while the rail, the lane badges and the freshness
 * pill read `selectedBusinessId` out of the persisted store. Those disagree for
 * the whole window between localStorage rehydration and AuthBootstrap: the
 * switcher named the session's workspace while the rail minted
 * `?businessId=<previous workspace>` links and the pill reported the previous
 * workspace's sync age. A link minted in that window lands on the Meta scope
 * refusal ("This link names a different workspace"), which is the operator
 * seeing our own desynchronisation reported back as their mistake.
 *
 * The rule, in order:
 *   1. The server-resolved envelope, when one exists. It is the only value that
 *      has been authorised for this request, so it always wins.
 *   2. Otherwise the store selection — but only once the shell has actually
 *      confirmed it: hydrated, auth bootstrap finished, and the id still
 *      present in the authenticated membership list.
 *   3. Otherwise `null`.
 *
 * `null` means "not yet confirmed", and nothing may be minted from it: no
 * href parameter, no query key, no badge. An unconfirmed scope is missing
 * data, and missing data is never rendered as a value.
 */
export function useConfirmedShellBusinessId(): string | null {
  const workspace = useOptionalWorkspaceContext();
  const selectedBusinessId = useAppStore((state) => state.selectedBusinessId);
  const businesses = useAppStore((state) => state.businesses);
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);

  const envelopeBusinessId = workspace?.business?.id ?? null;
  if (envelopeBusinessId) return envelopeBusinessId;

  if (!hasHydrated || authBootstrapStatus !== "ready" || !selectedBusinessId) {
    return null;
  }
  return businesses.some((business) => business.id === selectedBusinessId)
    ? selectedBusinessId
    : null;
}

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
  const businessId = useConfirmedShellBusinessId();

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
  const businessId = useConfirmedShellBusinessId();

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
  /** Bounded diagnostic metadata for automation and QA; never rendered as copy. */
  errorCode?: string | null;
  /** Present only when the active surface registered a real retry handler. */
  onRetry?: () => void;
}

export interface WorkspaceSyncOptions {
  /**
   * Whether the shell may fall back to the account-level Meta and Google Ads
   * status reads. A route that already owns a Tier-0 freshness source can turn
   * this off synchronously, before that source reports through its effect.
   */
  providerStatusEnabled?: boolean;
}

function minutesSince(iso: string | null | undefined, now: number) {
  if (!iso) return null;
  const at = Date.parse(iso);
  if (!Number.isFinite(at)) return null;
  return Math.max(0, Math.round((now - at) / 60_000));
}

export function formatSyncAge(minutes: number | null): string {
  if (minutes === null) return SYNC_AGE_UNKNOWN_LABEL;
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
export function useWorkspaceSyncState(
  options: WorkspaceSyncOptions = {},
): WorkspaceSyncState {
  // Same rule as the switcher above it and the rail beside it. Reading the
  // store directly is what let this pill report one workspace's sync age under
  // another workspace's name.
  const businessId = useConfirmedShellBusinessId();
  const activeSurface = useTierZeroFreshnessStore((state) => state.active);
  const runFreshnessRetry = useTierZeroFreshnessStore(
    (state) => state.runRetry,
  );
  const hasHydrated = useAppStore((state) => state.hasHydrated);
  const authBootstrapStatus = useAppStore((state) => state.authBootstrapStatus);
  const enabled =
    options.providerStatusEnabled !== false &&
    Boolean(businessId) &&
    hasHydrated &&
    authBootstrapStatus === "ready";

  const metaStatus = useQuery({
    queryKey: ["meta-status", businessId],
    enabled,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
    queryFn: () =>
      fetchJson<MetaStatusResponse>(
        `/api/meta/status?businessId=${encodeURIComponent(businessId!)}`,
      ),
  });

  const googleStatus = useQuery({
    queryKey: ["google-ads-status", businessId],
    enabled,
    staleTime: 60_000,
    retry: false,
    refetchOnWindowFocus: false,
    refetchOnReconnect: false,
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
        ...(activeSurfaceForBusiness.state === "error"
          ? { errorCode: activeSurfaceForBusiness.errorCode ?? "unknown" }
          : {}),
        ...(activeSurfaceForBusiness.retryKey
          ? {
              onRetry: () =>
                runFreshnessRetry(activeSurfaceForBusiness.retryKey!),
            }
          : {}),
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
    // The surface registered itself and reported NO age. Falling through to
    // the account-level sync times below would answer with a timestamp that
    // belongs to a different thing than the screen in front of the operator:
    // a surface serving an unavailable or unaged read was showing
    // "Synced 9h ago" from the last Meta sync. An unknown age is stated as
    // unknown, using the vocabulary this hook already has.
    return {
      tone: "unknown",
      label: SYNC_AGE_UNKNOWN_LABEL,
      freshnessState: "unknown",
    };
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
          label: SYNC_AGE_UNKNOWN_LABEL,
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
