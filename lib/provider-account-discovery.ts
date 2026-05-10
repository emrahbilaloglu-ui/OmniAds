import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  readProviderAccountSnapshot,
  type ProviderAccountSnapshotItem,
  type ProviderAccountSnapshotMeta,
  type ProviderAccountSnapshotResult,
} from "@/lib/provider-account-snapshots";

export interface ProviderDiscoveryRow extends ProviderAccountSnapshotItem {
  assigned: boolean;
}

export interface ProviderDiscoveryPayload {
  data: ProviderDiscoveryRow[];
  meta: ProviderAccountSnapshotMeta;
  notice: string | null;
}

const DEFAULT_FRESHNESS_MS = 6 * 60 * 60_000;

function buildMeta(input: Partial<ProviderAccountSnapshotMeta>): ProviderAccountSnapshotMeta {
  return {
    source: input.source ?? "snapshot",
    sourceHealth: input.sourceHealth ?? "degraded_blocking",
    fetchedAt: input.fetchedAt ?? null,
    stale: input.stale ?? true,
    refreshFailed: input.refreshFailed ?? false,
    failureClass: input.failureClass ?? null,
    lastError: input.lastError ?? null,
    lastKnownGoodAvailable: input.lastKnownGoodAvailable ?? false,
    refreshRequestedAt: input.refreshRequestedAt ?? null,
    lastRefreshAttemptAt: input.lastRefreshAttemptAt ?? null,
    nextRefreshAfter: input.nextRefreshAfter ?? null,
    retryAfterAt: input.retryAfterAt ?? null,
    refreshInProgress: input.refreshInProgress ?? false,
    sourceReason: input.sourceReason ?? null,
    trustLevel: input.trustLevel,
    trustScore: input.trustScore,
    snapshotAgeHours: input.snapshotAgeHours ?? null,
    lastSuccessfulRefreshAgeHours: input.lastSuccessfulRefreshAgeHours ?? null,
    refreshFailureStreak: input.refreshFailureStreak ?? 0,
  };
}

function buildDiscoveryNotice(input: {
  snapshot: ProviderAccountSnapshotResult;
  degradedNotice: string;
  quotaNotice?: (retryAfterAt: string | null) => string;
}) {
  if (!input.snapshot.meta.refreshFailed) {
    return null;
  }

  if (input.snapshot.meta.failureClass === "quota") {
    return input.quotaNotice?.(input.snapshot.meta.retryAfterAt) ?? input.degradedNotice;
  }

  if (input.snapshot.meta.sourceHealth === "stale_cached") {
    return input.snapshot.meta.trustLevel === "risky"
      ? "Cached accounts are available, but freshness is currently risky."
      : input.degradedNotice;
  }

  return input.degradedNotice;
}

function mergeAssignments(
  accounts: ProviderAccountSnapshotItem[],
  assignedIds: string[]
): ProviderDiscoveryRow[] {
  const assignedSet = new Set(assignedIds);
  return accounts.map((account) => ({
    ...account,
    assigned: assignedSet.has(account.id),
  }));
}

function buildAssignedFallbackRows(accountIds: string[]): ProviderDiscoveryRow[] {
  return accountIds.map((accountId) => ({
    id: accountId,
    name: accountId,
    assigned: true,
  }));
}

export async function resolveProviderDiscoveryPayload(input: {
  businessId: string;
  provider: "meta" | "google";
  refreshRequested: boolean;
  liveLoader: () => Promise<ProviderAccountSnapshotItem[]>;
  missingSnapshotNotice: string;
  degradedNotice: string;
  unavailableNotice: string;
  quotaNotice?: (retryAfterAt: string | null) => string;
  freshnessMs?: number;
}): Promise<ProviderDiscoveryPayload> {
  const freshnessMs = input.freshnessMs ?? DEFAULT_FRESHNESS_MS;
  const assignmentRow = await getProviderAccountAssignments(input.businessId, input.provider).catch(
    () => null
  );
  const assignedIds = assignmentRow?.account_ids ?? [];

  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: input.provider,
    freshnessMs,
  });

  if (snapshot) {
    if (snapshot.accounts.length === 0 && assignedIds.length > 0) {
      return {
        data: buildAssignedFallbackRows(assignedIds),
        meta: snapshot.meta,
        notice: snapshot.meta.refreshFailed
          ? buildDiscoveryNotice({
              snapshot,
              degradedNotice: input.degradedNotice,
              quotaNotice: input.quotaNotice,
            })
          : input.missingSnapshotNotice,
      };
    }

    return {
      data: mergeAssignments(snapshot.accounts, assignedIds),
      meta: snapshot.meta,
      notice: buildDiscoveryNotice({
        snapshot,
        degradedNotice: input.degradedNotice,
        quotaNotice: input.quotaNotice,
      }),
    };
  }

  if (assignedIds.length > 0) {
    return {
      data: buildAssignedFallbackRows(assignedIds),
      meta: buildMeta({
        stale: true,
        sourceHealth: "healthy_cached",
        lastKnownGoodAvailable: true,
        refreshInProgress: false,
        sourceReason: "initial_snapshot_refresh",
        trustLevel: "safe",
        trustScore: 68,
      }),
      notice: input.missingSnapshotNotice,
    };
  }

  return {
    data: [],
      meta: buildMeta({
        stale: true,
        sourceHealth: "degraded_blocking",
        lastKnownGoodAvailable: false,
        refreshInProgress: false,
        sourceReason: "initial_snapshot_refresh",
        trustLevel: "blocking",
        trustScore: 0,
      }),
      notice: input.unavailableNotice,
    };
}

export function toSnapshotResultFromPayload(
  payload: ProviderDiscoveryPayload
): ProviderAccountSnapshotResult {
  return {
    accounts: payload.data.map(({ assigned: _assigned, ...account }) => account),
    meta: payload.meta,
  };
}
