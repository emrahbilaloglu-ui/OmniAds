import type { RunnerLeaseGuard } from "@/lib/sync/worker-runtime";
import { getProviderQuotaBudgetState } from "@/lib/provider-request-governance";
import type {
  ProviderSyncAdapter,
  ProviderSyncCheckpointState,
  ProviderSyncPartitionIdentity,
} from "@/lib/sync/provider-orchestration";
import type {
  ProviderAutoHealResult,
  ProviderLeasePlan,
} from "@/lib/sync/provider-status-truth";
import { resolveMetaCredentials } from "@/lib/api/meta";
import { getConnectedAssignedGoogleAccounts } from "@/lib/google-ads-gaql";
import { fetchGoogleAdsAccounts, refreshGoogleAccessToken } from "@/lib/google-ads-accounts";
import { getIntegration, refreshIntegrationCredentialTokens } from "@/lib/integrations";
import { fetchMetaAdAccounts, getMetaApiErrorMessage } from "@/lib/meta-ad-accounts";
import {
  getGoogleAdsCheckpointHealth,
  getGoogleAdsSyncCheckpoint,
  leaseGoogleAdsSyncPartitions,
  queueGoogleAdsSyncPartition,
  releaseGoogleAdsLeasedPartitionsForWorker,
  upsertGoogleAdsSyncCheckpoint,
} from "@/lib/google-ads/warehouse";
import type {
  GoogleAdsSyncCheckpointRecord,
  GoogleAdsSyncPartitionRecord,
  GoogleAdsWarehouseScope,
} from "@/lib/google-ads/warehouse-types";
import {
  getMetaCheckpointHealth,
  getMetaSyncCheckpoint,
  leaseMetaSyncPartitions,
  quarantineMetaTerminalActionRequiredPartitions,
  queueMetaSyncPartition,
  releaseMetaLeasedPartitionsForWorker,
  upsertMetaSyncCheckpoint,
} from "@/lib/meta/warehouse";
import type {
  MetaSyncCheckpointRecord,
  MetaSyncPartitionSource,
  MetaSyncPartitionRecord,
  MetaWarehouseScope,
} from "@/lib/meta/warehouse-types";
import type { ProviderReadinessLevel } from "@/lib/provider-readiness";
import {
  buildGoogleAdsWorkerLeasePlan,
  cancelCoveredGoogleAdsCoreBacklog,
  processGoogleAdsLifecyclePartition,
  syncGoogleAdsReports,
} from "@/lib/sync/google-ads-sync";
import {
  buildMetaWorkerLeasePlan,
  consumeMetaQueuedWork,
  processMetaLifecyclePartition,
} from "@/lib/sync/meta-sync";
import {
  runGoogleAdsRepairCycle,
  runMetaRepairCycle,
} from "@/lib/sync/provider-repair-engine";
import {
  ProviderAccountSnapshotRefreshError,
  readProviderAccountSnapshot,
  resolveProviderAccountSnapshot,
  scheduleProviderAccountSnapshotRefresh,
} from "@/lib/provider-account-snapshots";
import {
  mergeAutoRepairResult,
  runAutoSyncRepairPass,
} from "@/lib/sync/repair-executor";
import { syncShopifyCommerceReports } from "@/lib/sync/shopify-sync";

export interface ProviderWorkerAdapter
  extends ProviderSyncAdapter<
    ProviderSyncPartitionIdentity,
    ProviderSyncCheckpointState,
    unknown,
    string
  > {
  providerScope: "meta" | "google_ads" | "shopify";
  consumeBusiness(
    businessId: string,
    input?: {
      runtimeLeaseGuard?: RunnerLeaseGuard;
      runtimeWorkerId?: string;
    }
  ): Promise<unknown>;
  cleanupOwnedLeasedPartitions?(input: {
    businessId: string;
    workerId: string;
    failureReason?: string | null;
  }): Promise<number>;
  buildLeasePlan?(input: {
    businessId: string;
    leaseLimit: number;
  }): Promise<ProviderLeasePlan | null>;
  runAutoHeal?(businessId: string): Promise<ProviderAutoHealResult | null>;
}

type WorkerLifecyclePartition = ProviderSyncPartitionIdentity & {
  lane?: string;
  status?: string;
  priority?: number;
  source?: string;
  leaseEpoch?: number | null;
  leaseOwner?: string | null;
  leaseExpiresAt?: string | null;
  attemptCount?: number;
  nextRetryAt?: string | null;
  lastError?: string | null;
};

const META_ADAPTER_CORE_SCOPES: MetaWarehouseScope[] = ["account_daily", "adset_daily"];
const META_ACCOUNT_SNAPSHOT_FRESHNESS_MS = 6 * 60 * 60_000;
const META_AUTO_HEAL_DEAD_LETTER_SOURCES: MetaSyncPartitionSource[] = [
  "finalize_day",
  "priority_window",
  "repair_recent_day",
  "today_observe",
  "request_runtime",
  "manual_refresh",
  "recent",
  "recent_recovery",
  "historical",
  "historical_recovery",
  "initial_connect",
];
const GOOGLE_ADS_ADAPTER_CORE_SCOPES: GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
];
const GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS = 6 * 60 * 60_000;

function enumerateDays(startDate: string, endDate: string) {
  const start = new Date(`${startDate}T00:00:00.000Z`);
  const end = new Date(`${endDate}T00:00:00.000Z`);
  if (!Number.isFinite(start.getTime()) || !Number.isFinite(end.getTime()) || start > end) {
    return [] as string[];
  }

  const days: string[] = [];
  for (let cursor = start; cursor <= end; cursor = new Date(cursor.getTime() + 86_400_000)) {
    days.push(cursor.toISOString().slice(0, 10));
  }
  return days;
}

function mapMetaPartition(
  partition: MetaSyncPartitionRecord & { id?: string }
): WorkerLifecyclePartition {
  return {
    partitionId: String(partition.id ?? `${partition.providerAccountId}:${partition.scope}:${partition.partitionDate}`),
    businessId: partition.businessId,
    providerAccountId: partition.providerAccountId,
    scope: partition.scope,
    partitionDate: partition.partitionDate,
    lane: partition.lane,
    status: partition.status,
    priority: partition.priority,
    source: partition.source,
    leaseEpoch: partition.leaseEpoch ?? null,
    leaseOwner: partition.leaseOwner ?? null,
    leaseExpiresAt: partition.leaseExpiresAt ?? null,
    attemptCount: partition.attemptCount,
    nextRetryAt: partition.nextRetryAt ?? null,
    lastError: partition.lastError ?? null,
  };
}

function mapGoogleAdsPartition(
  partition: GoogleAdsSyncPartitionRecord & { id?: string }
): WorkerLifecyclePartition {
  return {
    partitionId: String(partition.id ?? `${partition.providerAccountId}:${partition.scope}:${partition.partitionDate}`),
    businessId: partition.businessId,
    providerAccountId: partition.providerAccountId,
    scope: partition.scope,
    partitionDate: partition.partitionDate,
    lane: partition.lane,
    status: partition.status,
    priority: partition.priority,
    source: partition.source,
    leaseEpoch: partition.leaseEpoch ?? null,
    leaseOwner: partition.leaseOwner ?? null,
    leaseExpiresAt: partition.leaseExpiresAt ?? null,
    attemptCount: partition.attemptCount,
    nextRetryAt: partition.nextRetryAt ?? null,
    lastError: partition.lastError ?? null,
  };
}

function mapMetaCheckpoint(record: Awaited<ReturnType<typeof getMetaSyncCheckpoint>>) {
  if (!record) return null;
  return {
    checkpointId: record.id ?? null,
    checkpointScope: record.checkpointScope,
    phase: record.phase,
    pageIndex: record.pageIndex,
    cursor: record.providerCursor ?? null,
    nextCursor: record.nextPageUrl ?? null,
    rowsFetched: record.rowsFetched ?? 0,
    rowsWritten: record.rowsWritten ?? 0,
    attemptCount: record.attemptCount,
    retryAfterAt: record.retryAfterAt ?? null,
    heartbeatAt: record.updatedAt ?? null,
  } satisfies ProviderSyncCheckpointState;
}

function mapGoogleAdsCheckpoint(record: Awaited<ReturnType<typeof getGoogleAdsSyncCheckpoint>>) {
  if (!record) return null;
  return {
    checkpointId: record.id ?? null,
    checkpointScope: record.checkpointScope,
    phase: record.phase,
    pageIndex: record.pageIndex,
    isPaginated: record.isPaginated ?? false,
    cursor: record.providerCursor ?? null,
    nextCursor: record.nextPageToken ?? null,
    rawSnapshotIds: record.rawSnapshotIds ?? [],
    rowsFetched: record.rowsFetched ?? 0,
    rowsWritten: record.rowsWritten ?? 0,
    attemptCount: record.attemptCount,
    retryAfterAt: record.retryAfterAt ?? null,
    heartbeatAt: record.progressHeartbeatAt ?? record.updatedAt ?? null,
    poisonedAt: record.poisonedAt ?? null,
    poisonReason: record.poisonReason ?? null,
  } satisfies ProviderSyncCheckpointState;
}

function normalizeCheckpointChunk(
  checkpoint: ProviderSyncCheckpointState | null,
  chunk: unknown
) {
  const payload = chunk && typeof chunk === "object" ? (chunk as Record<string, unknown>) : {};
  return {
    phase: typeof payload.phase === "string" ? payload.phase : checkpoint?.phase ?? "fetch_raw",
    pageIndex:
      typeof payload.pageIndex === "number" ? payload.pageIndex : checkpoint?.pageIndex ?? 0,
    cursor:
      typeof payload.cursor === "string"
        ? payload.cursor
        : checkpoint?.cursor ?? null,
    nextCursor:
      typeof payload.nextCursor === "string"
        ? payload.nextCursor
        : checkpoint?.nextCursor ?? null,
    rowsFetched:
      typeof payload.rowsFetched === "number"
        ? payload.rowsFetched
        : checkpoint?.rowsFetched ?? 0,
    rowsWritten:
      typeof payload.rowsWritten === "number"
        ? payload.rowsWritten
        : checkpoint?.rowsWritten ?? 0,
    attemptCount:
      typeof payload.attemptCount === "number"
        ? payload.attemptCount
        : checkpoint?.attemptCount ?? 0,
    status:
      typeof payload.status === "string"
        ? payload.status
        : "running",
    isPaginated:
      typeof payload.isPaginated === "boolean"
        ? payload.isPaginated
        : checkpoint?.isPaginated ?? false,
    rawSnapshotIds: Array.isArray(payload.rawSnapshotIds)
      ? payload.rawSnapshotIds.map((value) => String(value))
      : checkpoint?.rawSnapshotIds ?? [],
    retryAfterAt:
      typeof payload.retryAfterAt === "string"
        ? payload.retryAfterAt
        : checkpoint?.retryAfterAt ?? null,
    poisonedAt:
      typeof payload.poisonedAt === "string"
        ? payload.poisonedAt
        : checkpoint?.poisonedAt ?? null,
    poisonReason:
      typeof payload.poisonReason === "string"
        ? payload.poisonReason
        : checkpoint?.poisonReason ?? null,
  };
}

function classifyReadinessLevel(input: {
  assignedAccountCount: number;
  checkpointUpdatedAt: string | null;
  checkpointLagMinutes: number | null;
  resumeCapable: boolean;
}): ProviderReadinessLevel {
  if (input.assignedAccountCount === 0) return "partial";
  if (input.checkpointUpdatedAt && (input.checkpointLagMinutes == null || input.checkpointLagMinutes <= 20)) {
    return "ready";
  }
  return input.resumeCapable ? "usable" : "partial";
}

async function fetchLegacyPartitionChunk(input: {
  partition: WorkerLifecyclePartition;
  checkpoint: ProviderSyncCheckpointState | null;
}) {
  return {
    partition: input.partition,
    checkpoint: input.checkpoint,
    fetchedAt: new Date().toISOString(),
    bridgeMode: "legacy_provider_runtime",
  };
}

async function noopLifecycleStep() {}

async function leaseMetaPartitionsWithPlan(input: {
  businessId: string;
  workerId: string;
  limit: number;
  plan: ProviderLeasePlan | null | undefined;
}) {
  await quarantineMetaTerminalActionRequiredPartitions({
    businessId: input.businessId,
  }).catch(() => null);
  const plan = input.plan;
  if (!plan?.steps?.length) {
    return leaseMetaSyncPartitions({
      businessId: input.businessId,
      workerId: input.workerId,
      limit: input.limit,
    });
  }

  const leased: MetaSyncPartitionRecord[] = [];
  let remaining = Math.max(1, plan.requestedLimit ?? input.limit);
  for (const step of plan.steps) {
    if (remaining <= 0) break;
    if (step.onlyIfNoLease && leased.length > 0) continue;
    const stepLimit = Math.min(remaining, Math.max(0, step.limit));
    if (stepLimit <= 0) continue;
    const rows = await leaseMetaSyncPartitions({
      businessId: input.businessId,
      lane: (step.lane as MetaSyncPartitionRecord["lane"] | undefined) ?? undefined,
      sources: step.sources ?? null,
      workerId: input.workerId,
      limit: stepLimit,
    });
    leased.push(...rows);
    remaining = Math.max(0, remaining - rows.length);
  }
  return leased;
}

async function leaseGoogleAdsPartitionsWithPlan(input: {
  businessId: string;
  workerId: string;
  limit: number;
  plan: ProviderLeasePlan | null | undefined;
}) {
  const plan = input.plan;
  if (!plan?.steps?.length) {
    return leaseGoogleAdsSyncPartitions({
      businessId: input.businessId,
      workerId: input.workerId,
      limit: input.limit,
    });
  }

  const leased: GoogleAdsSyncPartitionRecord[] = [];
  let remaining = Math.max(1, plan.requestedLimit ?? input.limit);
  for (const step of plan.steps) {
    if (remaining <= 0) break;
    if (step.onlyIfNoLease && leased.length > 0) continue;
    const stepLimit = Math.min(remaining, Math.max(0, step.limit));
    if (stepLimit <= 0) continue;
    const rows = await leaseGoogleAdsSyncPartitions({
      businessId: input.businessId,
      lane: (step.lane as GoogleAdsSyncPartitionRecord["lane"] | undefined) ?? undefined,
      workerId: input.workerId,
      limit: stepLimit,
      sourceFilter: step.sourceFilter ?? "all",
      scopeFilter: (step.scopeFilter as GoogleAdsWarehouseScope[] | undefined) ?? undefined,
      excludedScopeFilter:
        (step.excludedScopeFilter as GoogleAdsWarehouseScope[] | undefined) ?? undefined,
      startDate: step.startDate ?? null,
      endDate: step.endDate ?? null,
    });
    leased.push(...rows);
    remaining = Math.max(0, remaining - rows.length);
  }
  return leased;
}

function isFutureTimestamp(value: string | null | undefined) {
  if (!value) return false;
  const time = new Date(value).getTime();
  return Number.isFinite(time) && time > Date.now();
}

async function loadMetaProviderAccountsForSnapshot(input: {
  accessToken: string | null;
  tokenExpiresAt: string | null;
}) {
  if (!input.accessToken) {
    throw new Error("Meta access token is missing for this business integration.");
  }
  if (
    input.tokenExpiresAt &&
    new Date(input.tokenExpiresAt).getTime() <= Date.now()
  ) {
    throw new Error("Meta access token has expired. Please reconnect Meta integration.");
  }

  const metaResult = await fetchMetaAdAccounts(input.accessToken);
  if (!metaResult.ok || metaResult.body?.error) {
    throw new Error(getMetaApiErrorMessage(metaResult));
  }
  return metaResult.normalized.map((account) => ({
    id: account.id,
    name: account.name,
    currency: account.currency ?? undefined,
    timezone: account.timezone ?? undefined,
    isManager: false,
  }));
}

async function refreshMetaProviderAccountSnapshotIfNeeded(businessId: string) {
  const integration = await getIntegration(businessId, "meta").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return { outcome: "skipped_no_connected_integration" };
  }
  // The generation this loader's credential belongs to, taken from the SAME row
  // the token came from. Reading it separately afterwards would reopen the
  // window: a reconnect in between pairs an old token with a new generation, and
  // the resulting account list is then stamped as current.
  const capturedGeneration = `${integration.connection_generation ?? 1}:${integration.status}`;

  const liveLoader = () =>
    loadMetaProviderAccountsForSnapshot({
      accessToken: integration.access_token,
      tokenExpiresAt: integration.token_expires_at,
    });
  const snapshot = await readProviderAccountSnapshot({
    businessId,
    provider: "meta",
    freshnessMs: META_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
  }).catch(() => null);

  if (snapshot?.meta.refreshInProgress) {
    return {
      outcome: "skipped_refresh_in_progress",
      fetchedAt: snapshot.meta.fetchedAt,
    };
  }

  if (
    snapshot?.meta.retryAfterAt &&
    isFutureTimestamp(snapshot.meta.retryAfterAt)
  ) {
    return {
      outcome: "skipped_cooldown",
      retryAfterAt: snapshot.meta.retryAfterAt,
      failureClass: snapshot.meta.failureClass,
    };
  }

  if (!snapshot) {
    try {
      const refreshed = await resolveProviderAccountSnapshot({
        businessId,
        provider: "meta",
        freshnessMs: META_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
        reason: "worker_missing_account_snapshot",
        expectedConnectionGeneration: capturedGeneration,
        liveLoader,
      });
      return {
        outcome: "refreshed_missing_snapshot",
        accountCount: refreshed.accounts.length,
        fetchedAt: refreshed.meta.fetchedAt,
      };
    } catch (error: unknown) {
      return {
        outcome:
          error instanceof ProviderAccountSnapshotRefreshError &&
          error.dueToRecentFailure
            ? "skipped_cooldown"
            : "refresh_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (snapshot.accounts.length === 0 || snapshot.meta.stale) {
    await scheduleProviderAccountSnapshotRefresh({
      businessId,
      provider: "meta",
      freshnessMs: META_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
      reason:
        snapshot.accounts.length === 0
          ? "worker_empty_account_snapshot"
          : "worker_stale_account_snapshot",
      skipIfFresh: snapshot.accounts.length > 0,
      expectedConnectionGeneration: capturedGeneration,
      liveLoader,
    }).catch(() => null);
    return {
      outcome:
        snapshot.accounts.length === 0
          ? "scheduled_empty_snapshot_refresh"
          : "scheduled_stale_snapshot_refresh",
      accountCount: snapshot.accounts.length,
      fetchedAt: snapshot.meta.fetchedAt,
    };
  }

  return {
    outcome: "fresh",
    accountCount: snapshot.accounts.length,
    fetchedAt: snapshot.meta.fetchedAt,
  };
}

async function loadGoogleProviderAccountsForSnapshot(input: {
  businessId: string;
  accessToken: string | null;
  refreshToken: string | null;
  tokenExpiresAt: string | null;
  scopes: string | null;
  /**
   * The generation the caller captured with this credential — the SAME one it
   * hands the snapshot writer as `expectedConnectionGeneration`.
   */
  connectionGeneration: string;
}) {
  const hasAdsScope = Boolean(
    input.scopes?.split(/\s+/).includes("https://www.googleapis.com/auth/adwords"),
  );
  if (!hasAdsScope) {
    throw new Error(
      "This Google connection is missing the Google Ads scope. Reconnect Google Ads and approve Google Ads access.",
    );
  }

  let accessToken = input.accessToken;
  if (!accessToken) {
    throw new Error("Google integration has no valid access token.");
  }

  if (input.tokenExpiresAt) {
    const isExpired = new Date(input.tokenExpiresAt).getTime() <= Date.now();
    if (isExpired && input.refreshToken) {
      const refreshed = await refreshGoogleAccessToken(input.refreshToken);
      accessToken = refreshed.accessToken;
      // The NARROW credential write path, not `upsertIntegration`.
      //
      // `upsertIntegration` classifies any write carrying an access token as a
      // reconnect, so this routine refresh used to BUMP connection_generation —
      // and this loader's own caller passes the generation it captured BEFORE
      // the refresh as `expectedConnectionGeneration`. The worker therefore
      // invalidated its own snapshot claim: every scheduled refresh that found
      // an expired token failed with "the provider connection changed while its
      // account list was being fetched". Writing only the credential leaves the
      // generation alone, so the claim it was taken under still holds.
      //
      // The refresh token is not re-supplied: it did not change, and the
      // narrow path preserves it rather than clearing it as foreign.
      await refreshIntegrationCredentialTokens({
        businessId: input.businessId,
        provider: "google",
        accessToken: refreshed.accessToken,
        tokenExpiresAt: new Date(Date.now() + refreshed.expiresIn * 1000),
        expectedConnectionGeneration: input.connectionGeneration,
      });
    } else if (isExpired) {
      throw new Error(
        "Google access token has expired and no refresh token is available. Please reconnect.",
      );
    }
  }

  const result = await fetchGoogleAdsAccounts(accessToken, {
    scopePresent: hasAdsScope,
  });
  if (!result.ok) {
    throw new Error(
      result.error ?? "Could not discover accessible Google Ads accounts.",
    );
  }

  return result.customers.map((customer) => ({
    id: customer.id,
    name: customer.name,
    currency: customer.currency ?? undefined,
    timezone: customer.timezone ?? undefined,
    isManager: customer.isManager,
  }));
}

async function refreshGoogleProviderAccountSnapshotIfNeeded(businessId: string) {
  const integration = await getIntegration(businessId, "google").catch(() => null);
  if (!integration || integration.status !== "connected") {
    return { outcome: "skipped_no_connected_integration" };
  }
  // The generation this loader's credential belongs to, taken from the SAME row
  // the token came from. Reading it separately afterwards would reopen the
  // window: a reconnect in between pairs an old token with a new generation, and
  // the resulting account list is then stamped as current.
  const capturedGeneration = `${integration.connection_generation ?? 1}:${integration.status}`;

  const liveLoader = () =>
    loadGoogleProviderAccountsForSnapshot({
      businessId,
      accessToken: integration.access_token,
      refreshToken: integration.refresh_token,
      tokenExpiresAt: integration.token_expires_at,
      scopes: integration.scopes,
      connectionGeneration: capturedGeneration,
    });
  const snapshot = await readProviderAccountSnapshot({
    businessId,
    provider: "google",
    freshnessMs: GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
  }).catch(() => null);

  if (snapshot?.meta.refreshInProgress) {
    return {
      outcome: "skipped_refresh_in_progress",
      fetchedAt: snapshot.meta.fetchedAt,
    };
  }

  if (
    snapshot?.meta.retryAfterAt &&
    isFutureTimestamp(snapshot.meta.retryAfterAt)
  ) {
    return {
      outcome: "skipped_cooldown",
      retryAfterAt: snapshot.meta.retryAfterAt,
      failureClass: snapshot.meta.failureClass,
    };
  }

  if (!snapshot) {
    try {
      const refreshed = await resolveProviderAccountSnapshot({
        businessId,
        provider: "google",
        freshnessMs: GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
        reason: "worker_missing_account_snapshot",
        expectedConnectionGeneration: capturedGeneration,
        liveLoader,
      });
      return {
        outcome: "refreshed_missing_snapshot",
        accountCount: refreshed.accounts.length,
        fetchedAt: refreshed.meta.fetchedAt,
      };
    } catch (error: unknown) {
      return {
        outcome:
          error instanceof ProviderAccountSnapshotRefreshError &&
          error.dueToRecentFailure
            ? "skipped_cooldown"
            : "refresh_failed",
        error: error instanceof Error ? error.message : String(error),
      };
    }
  }

  if (snapshot.accounts.length === 0 || snapshot.meta.stale) {
    await scheduleProviderAccountSnapshotRefresh({
      businessId,
      provider: "google",
      freshnessMs: GOOGLE_ACCOUNT_SNAPSHOT_FRESHNESS_MS,
      reason:
        snapshot.accounts.length === 0
          ? "worker_empty_account_snapshot"
          : "worker_stale_account_snapshot",
      skipIfFresh: snapshot.accounts.length > 0,
      expectedConnectionGeneration: capturedGeneration,
      liveLoader,
    }).catch(() => null);
    return {
      outcome:
        snapshot.accounts.length === 0
          ? "scheduled_empty_snapshot_refresh"
          : "scheduled_stale_snapshot_refresh",
      accountCount: snapshot.accounts.length,
      fetchedAt: snapshot.meta.fetchedAt,
      failureClass: snapshot.meta.failureClass,
    };
  }

  return {
    outcome: "fresh",
    accountCount: snapshot.accounts.length,
    fetchedAt: snapshot.meta.fetchedAt,
  };
}

export const metaWorkerAdapter: ProviderWorkerAdapter = {
  providerScope: "meta",
  async planPartitions(range) {
    const credentials = await resolveMetaCredentials(range.businessId);
    if (!credentials) return { partitions: [] };
    const partitions: WorkerLifecyclePartition[] = [];
    for (const accountId of credentials.accountIds) {
      for (const partitionDate of enumerateDays(range.startDate, range.endDate)) {
        for (const scope of META_ADAPTER_CORE_SCOPES) {
          await queueMetaSyncPartition({
            businessId: range.businessId,
            providerAccountId: accountId,
            lane: "core",
            scope,
            partitionDate,
            status: "queued",
            priority: 200,
            source: "request_runtime",
            attemptCount: 0,
          });
          partitions.push({
            partitionId: `${accountId}:${scope}:${partitionDate}`,
            businessId: range.businessId,
            providerAccountId: accountId,
            scope,
            partitionDate,
            lane: "core",
            source: "request_runtime",
            status: "queued",
            priority: 200,
          });
        }
      }
    }
    return { partitions };
  },
  async leasePartitions(input) {
    const leased = await leaseMetaPartitionsWithPlan({
      businessId: input.businessId,
      workerId: input.workerId,
      limit: input.limit,
      plan: input.plan,
    });
    return leased.map((partition) => mapMetaPartition(partition));
  },
  async getCheckpoint(input) {
    return mapMetaCheckpoint(
      await getMetaSyncCheckpoint({
        partitionId: input.partition.partitionId,
        checkpointScope: input.partition.scope,
        runId: input.partition.partitionId,
      })
    );
  },
  fetchChunk: fetchLegacyPartitionChunk,
  persistChunk: noopLifecycleStep,
  transformChunk: noopLifecycleStep,
  async writeFacts(input) {
    const partition = input.partition as WorkerLifecyclePartition;
    const processed = await processMetaLifecyclePartition({
      partition: {
        id: partition.partitionId,
        businessId: partition.businessId,
        providerAccountId: partition.providerAccountId,
        lane: (partition.lane ?? "core") as MetaSyncPartitionRecord["lane"],
        scope: partition.scope as MetaWarehouseScope,
        partitionDate: partition.partitionDate,
        attemptCount: partition.attemptCount ?? 0,
        leaseEpoch: partition.leaseEpoch ?? 0,
        source: partition.source ?? "request_runtime",
      },
      workerId: partition.leaseOwner ?? "",
    });
    if (!processed) {
      throw new Error("meta_partition_processing_failed");
    }
  },
  async advanceCheckpoint(input) {
    const partition = input.partition as WorkerLifecyclePartition;
    const currentCheckpoint = await getMetaSyncCheckpoint({
      partitionId: partition.partitionId,
      checkpointScope: partition.scope,
      runId: partition.partitionId,
    });
    const normalized = normalizeCheckpointChunk(mapMetaCheckpoint(currentCheckpoint), input.chunk);
    const upsertInput: MetaSyncCheckpointRecord = {
      partitionId: partition.partitionId,
      businessId: partition.businessId,
      providerAccountId: partition.providerAccountId,
      checkpointScope: partition.scope,
      phase: normalized.phase as MetaSyncCheckpointRecord["phase"],
      status: normalized.status as MetaSyncCheckpointRecord["status"],
      pageIndex: normalized.pageIndex,
      nextPageUrl: normalized.nextCursor,
      providerCursor: normalized.cursor,
      rowsFetched: normalized.rowsFetched,
      rowsWritten: normalized.rowsWritten,
      attemptCount: normalized.attemptCount,
      retryAfterAt: normalized.retryAfterAt,
      leaseEpoch: partition.leaseEpoch ?? null,
      leaseOwner: partition.leaseOwner ?? null,
    };
    await upsertMetaSyncCheckpoint(upsertInput);
  },
  async completePartition(input) {
    void input;
  },
  classifyFailure(error) {
    return error instanceof Error ? error.message : String(error);
  },
  async getReadiness(input) {
    const credentials = await resolveMetaCredentials(input.businessId).catch(() => null);
    const assignedAccountCount = credentials?.accountIds.length ?? 0;
    const checkpointHealth = await getMetaCheckpointHealth({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId ?? null,
    }).catch(() => null);
    return {
      readinessLevel: classifyReadinessLevel({
        assignedAccountCount,
        checkpointUpdatedAt: checkpointHealth?.latestCheckpointUpdatedAt ?? null,
        checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
        resumeCapable: checkpointHealth?.resumeCapable ?? false,
      }),
      checkpointHealth,
      domainReadiness: null,
    };
  },
  async consumeBusiness(businessId: string, input) {
    return consumeMetaQueuedWork(businessId, input);
  },
  async cleanupOwnedLeasedPartitions(input) {
    return releaseMetaLeasedPartitionsForWorker({
      businessId: input.businessId,
      workerId: input.workerId,
      lastError: input.failureReason
        ? `leased partition released automatically after ${input.failureReason}`
        : null,
    });
  },
  async buildLeasePlan(input) {
    return buildMetaWorkerLeasePlan(input);
  },
  async runAutoHeal(businessId: string) {
    const providerAccountSnapshotRepair =
      await refreshMetaProviderAccountSnapshotIfNeeded(businessId).catch(
        (error: unknown) => ({
          outcome: "refresh_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    const result = await runMetaRepairCycle(businessId, {
      enqueueScheduledWork: false,
      metaDeadLetterSources: META_AUTO_HEAL_DEAD_LETTER_SOURCES,
      metaDeadLetterRecoveryKinds: ["replayable_transient"],
    });
    const shouldConsumeAfterRepair =
      (result.repair.replayed ?? 0) > 0 ||
      (result.repair.requeued ?? 0) > 0 ||
      (result.repair.reclaimed ?? 0) > 0;
    const consumeAfterRepair = shouldConsumeAfterRepair
      ? await consumeMetaQueuedWork(businessId, {
          runtimeWorkerId: `meta-autoheal:${businessId}`,
        }).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }))
      : null;
    const autoRepair = await runAutoSyncRepairPass({
      providerScope: "meta",
      source: "worker",
      businessId,
      consumeQueuedMetaWork: true,
    }).catch(() => null);
    const merged = mergeAutoRepairResult(
      result.repair,
      autoRepair ? [autoRepair] : [],
    );
    return {
      ...merged,
      meta: {
        ...(merged.meta ?? {}),
        consumeAfterRepair,
        providerAccountSnapshotRepair,
      },
    };
  },
};

export const googleAdsWorkerAdapter: ProviderWorkerAdapter = {
  providerScope: "google_ads",
  async planPartitions(range) {
    const accountIds = await getConnectedAssignedGoogleAccounts(range.businessId).catch(() => []);
    const partitions: WorkerLifecyclePartition[] = [];
    for (const accountId of accountIds) {
      for (const partitionDate of enumerateDays(range.startDate, range.endDate)) {
        for (const scope of GOOGLE_ADS_ADAPTER_CORE_SCOPES) {
          await queueGoogleAdsSyncPartition({
            businessId: range.businessId,
            providerAccountId: accountId,
            lane: "core",
            scope,
            partitionDate,
            status: "queued",
            priority: 200,
            source: "selected_range",
            attemptCount: 0,
          });
          partitions.push({
            partitionId: `${accountId}:${scope}:${partitionDate}`,
            businessId: range.businessId,
            providerAccountId: accountId,
            scope,
            partitionDate,
            lane: "core",
            source: "selected_range",
            status: "queued",
            priority: 200,
          });
        }
      }
    }
    return { partitions };
  },
  async leasePartitions(input) {
    // Lease nothing for a business whose daily Google Ads request budget is
    // spent.
    //
    // This is the path the durable worker actually takes, and it had no
    // admission check of any kind. On 2026-08-06 one exhausted account
    // (5,000/5,000 calls, 4,951 of them errors) took 40 of 40 runs in a
    // half-hour while three businesses with 12-16 calls used got nothing.
    // Its requests fail on arrival, and because those failures are instant it
    // cycles through ticks far faster than an account doing real work — the
    // more broken it is, the more of the worker it takes.
    //
    // A gate was added to `buildGoogleAdsLaneAdmissionPolicy` first, which was
    // the wrong path: that policy governs `syncGoogleAdsReports`, not the
    // lifecycle adapter, and the exhausted account kept running for 15 minutes
    // after it shipped. Measured, not assumed.
    //
    // Fails OPEN: an unreadable budget must never stop leasing.
    const budgetState = await getProviderQuotaBudgetState({
      provider: "google",
      businessId: input.businessId,
    }).catch(() => null);
    if (budgetState && !budgetState.withinDailyBudget) {
      return [];
    }
    const leased = await leaseGoogleAdsPartitionsWithPlan({
      businessId: input.businessId,
      workerId: input.workerId,
      limit: input.limit,
      plan: input.plan,
    });
    return leased.map((partition) => mapGoogleAdsPartition(partition));
  },
  async getCheckpoint(input) {
    return mapGoogleAdsCheckpoint(
      await getGoogleAdsSyncCheckpoint({
        partitionId: input.partition.partitionId,
        checkpointScope: input.partition.scope,
      })
    );
  },
  fetchChunk: fetchLegacyPartitionChunk,
  persistChunk: noopLifecycleStep,
  transformChunk: noopLifecycleStep,
  async writeFacts(input) {
    const partition = input.partition as WorkerLifecyclePartition;
    const processed = await processGoogleAdsLifecyclePartition({
      partition: {
        id: partition.partitionId,
        businessId: partition.businessId,
        providerAccountId: partition.providerAccountId,
        lane: (partition.lane ?? "core") as GoogleAdsSyncPartitionRecord["lane"],
        scope: partition.scope as GoogleAdsWarehouseScope,
        partitionDate: partition.partitionDate,
        attemptCount: partition.attemptCount ?? 0,
        leaseEpoch: partition.leaseEpoch ?? 0,
        source: partition.source ?? "selected_range",
      },
      workerId: partition.leaseOwner ?? "",
    });
    if (!processed) {
      throw new Error("google_ads_partition_processing_failed");
    }
  },
  async advanceCheckpoint(input) {
    const partition = input.partition as WorkerLifecyclePartition;
    const currentCheckpoint = await getGoogleAdsSyncCheckpoint({
      partitionId: partition.partitionId,
      checkpointScope: partition.scope,
    });
    const normalized = normalizeCheckpointChunk(mapGoogleAdsCheckpoint(currentCheckpoint), input.chunk);
    const upsertInput: GoogleAdsSyncCheckpointRecord = {
      partitionId: partition.partitionId,
      businessId: partition.businessId,
      providerAccountId: partition.providerAccountId,
      checkpointScope: partition.scope,
      isPaginated: normalized.isPaginated,
      phase: normalized.phase as GoogleAdsSyncCheckpointRecord["phase"],
      status: normalized.status as GoogleAdsSyncCheckpointRecord["status"],
      pageIndex: normalized.pageIndex,
      nextPageToken: normalized.nextCursor,
      providerCursor: normalized.cursor,
      rawSnapshotIds: normalized.rawSnapshotIds,
      rowsFetched: normalized.rowsFetched,
      rowsWritten: normalized.rowsWritten,
      attemptCount: normalized.attemptCount,
      progressHeartbeatAt: new Date().toISOString(),
      retryAfterAt: normalized.retryAfterAt,
      leaseEpoch: partition.leaseEpoch ?? null,
      leaseOwner: partition.leaseOwner ?? null,
      leaseExpiresAt: partition.leaseExpiresAt ?? null,
      poisonedAt: normalized.poisonedAt,
      poisonReason: normalized.poisonReason,
    };
    await upsertGoogleAdsSyncCheckpoint(upsertInput);
  },
  async completePartition(input) {
    void input;
  },
  classifyFailure(error) {
    return error instanceof Error ? error.message : String(error);
  },
  async getReadiness(input) {
    const accountIds = await getConnectedAssignedGoogleAccounts(input.businessId).catch(() => []);
    const checkpointHealth = await getGoogleAdsCheckpointHealth({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId ?? null,
    }).catch(() => null);
    return {
      readinessLevel: classifyReadinessLevel({
        assignedAccountCount: accountIds.length,
        checkpointUpdatedAt: checkpointHealth?.latestCheckpointUpdatedAt ?? null,
        checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
        resumeCapable: checkpointHealth?.resumeCapable ?? false,
      }),
      checkpointHealth,
      domainReadiness: null,
    };
  },
  async consumeBusiness(businessId: string, input) {
    return syncGoogleAdsReports(businessId, input);
  },
  async cleanupOwnedLeasedPartitions(input) {
    return releaseGoogleAdsLeasedPartitionsForWorker({
      businessId: input.businessId,
      workerId: input.workerId,
      lastError: input.failureReason
        ? `leased partition released automatically after ${input.failureReason}`
        : null,
    });
  },
  async buildLeasePlan(input) {
    await cancelCoveredGoogleAdsCoreBacklog({
      businessId: input.businessId,
    }).catch(() => 0);
    return buildGoogleAdsWorkerLeasePlan(input);
  },
  async runAutoHeal(businessId: string) {
    const providerAccountSnapshotRepair =
      await refreshGoogleProviderAccountSnapshotIfNeeded(businessId).catch(
        (error: unknown) => ({
          outcome: "refresh_failed",
          error: error instanceof Error ? error.message : String(error),
        }),
      );
    const result = await runGoogleAdsRepairCycle(businessId, {
      enqueueScheduledWork: false,
      googleDeadLetterRecoveryKinds: ["replayable_transient"],
    });
    const repairMeta = (result.repair.meta ?? {}) as Record<string, unknown>;
    const queuedWarehouseRepairs = Number(repairMeta.queuedWarehouseRepairs ?? 0);
    const queuedRecentGapRepairs = Number(repairMeta.queuedRecentGapRepairs ?? 0);
    const shouldConsumeAfterRepair =
      (result.repair.replayed ?? 0) > 0 ||
      (result.repair.requeued ?? 0) > 0 ||
      (result.repair.reclaimed ?? 0) > 0 ||
      queuedWarehouseRepairs > 0 ||
      queuedRecentGapRepairs > 0;
    const consumeAfterRepair = shouldConsumeAfterRepair
      ? await syncGoogleAdsReports(businessId, {
          runtimeWorkerId: `google-ads-autoheal:${businessId}`,
        }).catch((error: unknown) => ({
          error: error instanceof Error ? error.message : String(error),
        }))
      : null;
    const autoRepair = await runAutoSyncRepairPass({
      providerScope: "google_ads",
      source: "worker",
      businessId,
    }).catch(() => null);
    const merged = mergeAutoRepairResult(
      result.repair,
      autoRepair ? [autoRepair] : [],
    );
    return {
      ...merged,
      meta: {
        ...(merged.meta ?? {}),
        consumeAfterRepair,
        providerAccountSnapshotRepair,
      },
    };
  },
};

export const shopifyWorkerAdapter: ProviderWorkerAdapter = {
  providerScope: "shopify",
  async planPartitions() {
    return { partitions: [] };
  },
  async leasePartitions() {
    return [];
  },
  async getCheckpoint() {
    return null;
  },
  fetchChunk: fetchLegacyPartitionChunk,
  persistChunk: noopLifecycleStep,
  transformChunk: noopLifecycleStep,
  writeFacts: noopLifecycleStep,
  async advanceCheckpoint() {},
  async completePartition() {},
  classifyFailure(error) {
    return error instanceof Error ? error.message : String(error);
  },
  async consumeBusiness(businessId: string, input) {
    return syncShopifyCommerceReports(businessId, input);
  },
};

export const durableWorkerAdapters = [metaWorkerAdapter, googleAdsWorkerAdapter, shopifyWorkerAdapter];
