import { getActiveBusinesses } from "@/lib/sync/active-businesses";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import {
  assertSyncLaneEnabled,
  type SyncLane,
} from "@/lib/sync/global-kill-switch";
import {
  describeSyncSafetyRefusal,
  type SyncSafetyRefusal,
} from "@/lib/sync/safety-refusal";
import { getCurrentRuntimeBuildId } from "@/lib/build-runtime";
import type { ProviderWorkerAdapter } from "@/lib/sync/provider-worker-adapters";
import type { ProviderLeasePlan } from "@/lib/sync/provider-status-truth";
import {
  acquireSyncRunnerLease,
  heartbeatSyncWorker,
  renewSyncRunnerLease,
  releaseSyncRunnerLease,
} from "@/lib/sync/worker-health";
import { executeGoogleAdsRetentionPolicy } from "@/lib/google-ads/warehouse-retention";
import { executeMetaRetentionPolicy } from "@/lib/meta/warehouse-retention";
import { pruneSyncLifecycleData } from "@/lib/sync/retention";
import { logRuntimeInfo } from "@/lib/runtime-logging";
import { getDbRuntimeDiagnostics } from "@/lib/db";
import { getProviderJobLockState } from "@/lib/sync/provider-job-lock";
import { getSyncReleaseCanaryBusinessIds } from "@/lib/sync/runtime-contract";
import { getLatestSyncGateRecords } from "@/lib/sync/release-gates";
import { readConnectedGoogleAdsControlPlaneBusinesses } from "@/lib/google-ads/control-plane-runtime";

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function sleep(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export interface DurableWorkerRuntimeOptions {
  adapters: ProviderWorkerAdapter[];
}

export interface RunnerLeaseGuard {
  isLeaseLost(): boolean;
  getLeaseLossReason(): string | null;
}

export function createRunnerLeaseGuard() {
  let leaseLost = false;
  let leaseLossReason: string | null = null;
  return {
    markLeaseLost(reason: string) {
      if (leaseLost) return;
      leaseLost = true;
      leaseLossReason = reason;
    },
    isLeaseLost() {
      return leaseLost;
    },
    getLeaseLossReason() {
      return leaseLossReason;
    },
  };
}

function parseEnvList(name: string) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

export function getPriorityBusinessIdsForAdapter(
  providerScope: string,
  env: NodeJS.ProcessEnv = process.env,
) {
  const debugPriorityIds = parseEnvList(
    providerScope === "google_ads"
      ? "GOOGLE_ADS_DEBUG_PRIORITY_BUSINESS_IDS"
      : providerScope === "meta"
        ? "META_DEBUG_PRIORITY_BUSINESS_IDS"
        : "",
  );
  const releaseCanaryIds =
    providerScope === "meta" || providerScope === "google_ads"
      ? getSyncReleaseCanaryBusinessIds(env)
      : [];
  return Array.from(new Set([...debugPriorityIds, ...releaseCanaryIds]));
}

export function prioritizeBusinessesForAdapter(
  providerScope: string,
  businesses: Array<{ id: string; name: string }>,
) {
  const prioritizedIds = getPriorityBusinessIdsForAdapter(providerScope);
  if (prioritizedIds.length === 0) return businesses;
  const priorityRank = new Map(prioritizedIds.map((id, index) => [id, index]));
  return [...businesses].sort((left, right) => {
    const leftRank = priorityRank.get(left.id);
    const rightRank = priorityRank.get(right.id);
    if (leftRank == null && rightRank == null) return 0;
    if (leftRank == null) return 1;
    if (rightRank == null) return -1;
    return leftRank - rightRank;
  });
}

export type WorkerBusiness = { id: string; name: string };

export interface ProviderBusinessBatchPlan<
  TAdapter extends Pick<ProviderWorkerAdapter, "providerScope"> =
    ProviderWorkerAdapter,
> {
  adapter: TAdapter;
  businesses: WorkerBusiness[];
  effectiveConcurrency: number;
}

export function buildProviderRoundRobinBusinessBatches<
  TAdapter extends Pick<ProviderWorkerAdapter, "providerScope">,
>(
  plans: Array<{
    adapter: TAdapter;
    businesses: WorkerBusiness[];
    effectiveConcurrency: number;
  }>,
): Array<ProviderBusinessBatchPlan<TAdapter>> {
  const chunkedPlans = plans.map((plan) => {
    const batchSize = Math.max(1, Math.floor(plan.effectiveConcurrency));
    const batches: WorkerBusiness[][] = [];
    for (let index = 0; index < plan.businesses.length; index += batchSize) {
      batches.push(plan.businesses.slice(index, index + batchSize));
    }
    return {
      adapter: plan.adapter,
      batches,
      effectiveConcurrency: batchSize,
    };
  });
  const maxBatchCount = chunkedPlans.reduce(
    (max, plan) => Math.max(max, plan.batches.length),
    0,
  );
  const roundRobinBatches: Array<ProviderBusinessBatchPlan<TAdapter>> = [];
  for (let batchIndex = 0; batchIndex < maxBatchCount; batchIndex += 1) {
    for (const plan of chunkedPlans) {
      const businesses = plan.batches[batchIndex];
      if (!businesses || businesses.length === 0) continue;
      roundRobinBatches.push({
        adapter: plan.adapter,
        businesses,
        effectiveConcurrency: plan.effectiveConcurrency,
      });
    }
  }
  return roundRobinBatches;
}

async function resolveProviderScopedTickBusinesses(input: {
  providerScope: string;
  businesses: Array<{ id: string; name: string }>;
}) {
  if (input.providerScope !== "google_ads") {
    return input.businesses;
  }

  const connectedGoogleBusinesses =
    await readConnectedGoogleAdsControlPlaneBusinesses().catch(() => null);
  if (connectedGoogleBusinesses == null) {
    return input.businesses;
  }
  if (connectedGoogleBusinesses.length === 0) {
    return [];
  }

  const existingNames = new Map(
    input.businesses.map((business) => [business.id, business.name] as const),
  );
  const prioritizedIds = getPriorityBusinessIdsForAdapter(input.providerScope);
  const priorityRank = new Map(prioritizedIds.map((id, index) => [id, index]));

  return connectedGoogleBusinesses
    .map((business) => ({
      id: business.businessId,
      name:
        existingNames.get(business.businessId) ??
        business.businessName ??
        business.businessId,
      backfillIncomplete: business.backfillIncomplete === true,
      incompleteScopeCount: Number(business.incompleteScopeCount ?? 0),
      latestSuccessfulSyncAt: business.latestSuccessfulSyncAt ?? null,
    }))
    .sort((left, right) => {
      const leftRank = priorityRank.get(left.id);
      const rightRank = priorityRank.get(right.id);
      if (leftRank == null && rightRank == null) {
        if (left.backfillIncomplete !== right.backfillIncomplete) {
          return left.backfillIncomplete ? -1 : 1;
        }
        if (left.incompleteScopeCount !== right.incompleteScopeCount) {
          return right.incompleteScopeCount - left.incompleteScopeCount;
        }
        if (
          left.latestSuccessfulSyncAt == null &&
          right.latestSuccessfulSyncAt != null
        ) {
          return -1;
        }
        if (
          left.latestSuccessfulSyncAt != null &&
          right.latestSuccessfulSyncAt == null
        ) {
          return 1;
        }
        if (
          left.latestSuccessfulSyncAt != null &&
          right.latestSuccessfulSyncAt != null
        ) {
          return left.latestSuccessfulSyncAt.localeCompare(
            right.latestSuccessfulSyncAt,
          );
        }
        return 0;
      }
      if (leftRank == null) return 1;
      if (rightRank == null) return -1;
      return leftRank - rightRank;
    })
    .map((business) => ({
      id: business.id,
      name: business.name,
    }));
}

export async function resolveTickBusinessesForAdapter(input: {
  providerScope: string;
  businesses: Array<{ id: string; name: string }>;
}) {
  if (input.providerScope === "google_ads") {
    return resolveProviderScopedTickBusinesses(input);
  }

  const prioritizedIds = getPriorityBusinessIdsForAdapter(input.providerScope);
  if (prioritizedIds.length === 0) {
    return resolveProviderScopedTickBusinesses(input);
  }

  const prioritizedSet = new Set(prioritizedIds);
  const prioritizedBusinesses = input.businesses.filter((business) =>
    prioritizedSet.has(business.id),
  );
  if (prioritizedBusinesses.length === 0) return input.businesses;

  if (input.providerScope !== "meta" && input.providerScope !== "google_ads") {
    return input.businesses;
  }

  const gateRecords = await getLatestSyncGateRecords({
    buildId: getCurrentRuntimeBuildId(),
    providerScope: input.providerScope,
  }).catch(() => null);
  if (gateRecords?.releaseGate?.verdict === "pass") {
    return resolveProviderScopedTickBusinesses(input);
  }

  return prioritizedBusinesses;
}

export function buildProviderHeartbeatWorkerId(
  workerId: string,
  providerScope: string,
) {
  return providerScope === "all" ? workerId : `${workerId}:${providerScope}`;
}

export async function resolveAdapterLifecycleSnapshot(input: {
  adapter: ProviderWorkerAdapter;
  businessId: string;
}) {
  if (!input.adapter.getReadiness) return null;
  try {
    const readiness = await input.adapter.getReadiness({
      businessId: input.businessId,
      providerAccountId: null,
    });
    return {
      readinessLevel: readiness.readinessLevel,
      checkpointHealth: readiness.checkpointHealth,
      domainReadiness: readiness.domainReadiness ?? null,
    };
  } catch {
    return null;
  }
}

export interface AdapterLifecycleTickResult {
  attempted: number;
  succeeded: number;
  failed: number;
  leasedPartitionIds: string[];
  laneLeaseCounts: Record<string, number>;
  lastPartitionId: string | null;
  failureReasons: string[];
  /**
   * A lane or capacity refusal, preserved as structure.
   *
   * `failureReasons` is a list of strings, so a refusal that landed there was
   * indistinguishable from a provider timeout to everything downstream — which
   * is exactly how a capacity refusal can run unnoticed.
   */
  safetyRefusal?: SyncSafetyRefusal | null;
}

export interface ConsumeBusinessFallbackDecision {
  allowed: boolean;
  reason: "compatibility_cooldown" | "repair_workflow_active" | null;
}

const CONSUME_BUSINESS_REPAIR_LOCK_BY_PROVIDER = {
  meta: {
    provider: "meta",
    reportType: "auto_remediation",
    dateRangeKey: "control_plane",
  },
  google_ads: {
    provider: "google_ads",
    reportType: "auto_remediation",
    dateRangeKey: "control_plane",
  },
} as const;

export async function resolveConsumeBusinessFallbackDecision(input: {
  providerScope: string;
  businessId: string;
  lastFallbackAtMs?: number | null;
  cooldownMs: number;
}): Promise<ConsumeBusinessFallbackDecision> {
  const lastFallbackAtMs = input.lastFallbackAtMs ?? null;
  if (
    Number.isFinite(lastFallbackAtMs) &&
    lastFallbackAtMs != null &&
    Date.now() - lastFallbackAtMs < Math.max(1, input.cooldownMs)
  ) {
    return {
      allowed: false,
      reason: "compatibility_cooldown",
    };
  }

  const repairLockKey =
    input.providerScope === "meta" || input.providerScope === "google_ads"
      ? CONSUME_BUSINESS_REPAIR_LOCK_BY_PROVIDER[input.providerScope]
      : null;
  if (!repairLockKey) {
    return {
      allowed: true,
      reason: null,
    };
  }

  const repairLockState = await getProviderJobLockState({
    businessId: input.businessId,
    ...repairLockKey,
  }).catch(() => null);
  if (
    repairLockState?.status === "running" &&
    repairLockState.isExpired !== true
  ) {
    return {
      allowed: false,
      reason: "repair_workflow_active",
    };
  }

  return {
    allowed: true,
    reason: null,
  };
}

/** The kill-switch lane that owns each adapter's provider scope. */
const ADAPTER_LANE: Record<ProviderWorkerAdapter["providerScope"], SyncLane> = {
  meta: "meta_sync",
  google_ads: "google_sync",
  shopify: "shopify_sync",
};

export async function runAdapterLifecycleTick(input: {
  adapter: ProviderWorkerAdapter;
  businessId: string;
  workerId: string;
  leaseLimit: number;
  leasePlan?: ProviderLeasePlan | null;
  leaseGuard?: RunnerLeaseGuard;
}): Promise<AdapterLifecycleTickResult> {
  // Admission BEFORE the lease.
  //
  // This is the real work-unit boundary: everything the adapter does — taking
  // leases, reading and advancing checkpoints, persisting chunks, completing
  // partitions — happens after it. Leasing first meant a disabled lane or a full
  // database still mutated partition state on every tick, and the refusal then
  // arrived as one more string in `failureReasons`, indistinguishable from a
  // provider timeout.
  //
  // `fresh: true`, because a tick is a coarse boundary and a cached admission
  // from a previous tick is not evidence about this one.
  const lane = ADAPTER_LANE[input.adapter.providerScope];
  try {
    assertSyncLaneEnabled(lane);
    await assertSyncGrowthBoundary(`${input.adapter.providerScope}_worker_tick`, {
      fresh: true,
    });
  } catch (error) {
    const refusal = describeSyncSafetyRefusal(error);
    console.error("[durable-worker] lifecycle_tick_refused", {
      businessId: input.businessId,
      providerScope: input.adapter.providerScope,
      refusal,
    });
    // Zero attempted, zero leased, zero mutated — and the refusal survives as
    // structure so a caller can tell "we were told not to" from "we tried and
    // failed".
    return {
      attempted: 0,
      succeeded: 0,
      failed: 0,
      leasedPartitionIds: [],
      laneLeaseCounts: {},
      lastPartitionId: null,
      failureReasons: [refusal?.kind ?? "sync_admission_refused"],
      safetyRefusal: refusal,
    };
  }

  const leasedPartitions = await input.adapter.leasePartitions({
    businessId: input.businessId,
    workerId: input.workerId,
    limit: Math.max(1, input.leaseLimit),
    plan: input.leasePlan ?? null,
  });
  const leasedPartitionIds = leasedPartitions.map(
    (partition) => partition.partitionId,
  );
  const laneLeaseCounts = leasedPartitions.reduce<Record<string, number>>(
    (acc, partition) => {
      const lane =
        "lane" in partition && typeof partition.lane === "string"
          ? partition.lane
          : "unknown";
      acc[lane] = (acc[lane] ?? 0) + 1;
      return acc;
    },
    {},
  );
  let succeeded = 0;
  let failed = 0;
  let lastPartitionId: string | null = null;
  const failureReasons: string[] = [];
  let safetyRefusal: SyncSafetyRefusal | null = null;

  for (const partition of leasedPartitions) {
    if (input.leaseGuard?.isLeaseLost()) {
      failed += 1;
      const reason =
        input.leaseGuard.getLeaseLossReason() ?? "runner_lease_conflict";
      failureReasons.push(reason);
      break;
    }

    // Re-admission at every work unit, so a long tick cannot cross the budget
    // unchecked. Cached (not fresh) because re-measuring per partition would
    // itself be the load problem; a refusal is never cached, so recovery is
    // immediate. On refusal the loop STOPS: the remaining partitions keep their
    // leases and are retried later, which is recoverable, whereas continuing
    // would keep writing.
    try {
      assertSyncLaneEnabled(lane);
      await assertSyncGrowthBoundary(
        `${input.adapter.providerScope}_worker_partition`,
      );
    } catch (error) {
      const refusal = describeSyncSafetyRefusal(error);
      safetyRefusal = refusal;
      failureReasons.push(refusal?.kind ?? "sync_admission_refused");
      console.error("[durable-worker] lifecycle_partition_refused", {
        businessId: input.businessId,
        providerScope: input.adapter.providerScope,
        partitionId: partition.partitionId,
        refusal,
      });
      break;
    }

    lastPartitionId = partition.partitionId;
    try {
      const checkpoint = await input.adapter.getCheckpoint({ partition });
      const chunk = await input.adapter.fetchChunk({ partition, checkpoint });
      await input.adapter.persistChunk({ partition, chunk });
      await input.adapter.transformChunk({ partition, chunk });
      await input.adapter.advanceCheckpoint({ partition, chunk });
      await input.adapter.writeFacts({ partition, chunk });
      await input.adapter.completePartition({ partition });
      succeeded += 1;
    } catch (error) {
      failed += 1;
      failureReasons.push(input.adapter.classifyFailure(error));
      console.error("[durable-worker] lifecycle_partition_failed", {
        businessId: input.businessId,
        providerScope: input.adapter.providerScope,
        partitionId: partition.partitionId,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    attempted: leasedPartitions.length,
    succeeded,
    failed,
    leasedPartitionIds,
    laneLeaseCounts,
    lastPartitionId,
    failureReasons,
    safetyRefusal,
  };
}

export async function runDurableWorkerRuntime(
  options: DurableWorkerRuntimeOptions,
) {
  process.env.SYNC_WORKER_MODE = "1";
  const workerId =
    process.env.WORKER_INSTANCE_ID?.trim() ||
    `sync-worker:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  const pollIntervalMs = envNumber("WORKER_POLL_INTERVAL_MS", 10_000);
  const maxBusinessesPerTick = envNumber("WORKER_MAX_BUSINESSES_PER_TICK", 50);
  const leaseMinutes = envNumber("WORKER_RUNNER_LEASE_MINUTES", 2);
  const heartbeatIntervalMs = envNumber("WORKER_HEARTBEAT_INTERVAL_MS", 15_000);
  const globalDbConcurrency = envNumber("WORKER_GLOBAL_DB_CONCURRENCY", 4);
  const partitionTickLimit = envNumber("WORKER_PARTITION_TICK_LIMIT", 1);
  const pruneIntervalMs = envNumber(
    "WORKER_PRUNE_INTERVAL_MS",
    6 * 60 * 60_000,
  );
  const pruneRetryIntervalMs = envNumber(
    "WORKER_PRUNE_RETRY_INTERVAL_MS",
    15 * 60_000,
  );
  const googleAdsRetentionIntervalMs = envNumber(
    "GOOGLE_ADS_RETENTION_INTERVAL_MS",
    6 * 60 * 60_000,
  );
  const googleAdsRetentionRetryIntervalMs = envNumber(
    "GOOGLE_ADS_RETENTION_RETRY_INTERVAL_MS",
    15 * 60_000,
  );
  const metaRetentionIntervalMs = envNumber(
    "META_RETENTION_INTERVAL_MS",
    6 * 60 * 60_000,
  );
  const metaRetentionRetryIntervalMs = envNumber(
    "META_RETENTION_RETRY_INTERVAL_MS",
    15 * 60_000,
  );
  const autoHealCooldownMs = envNumber("WORKER_AUTO_HEAL_COOLDOWN_MS", 60_000);
  const consumeBusinessFallbackCooldownMs = envNumber(
    "WORKER_CONSUME_BUSINESS_FALLBACK_COOLDOWN_MS",
    60_000,
  );
  const stallExitMs = envNumber("WORKER_STALL_EXIT_MS", 300_000);
  const workerStartedAt = new Date().toISOString();
  const workerBuildId = getCurrentRuntimeBuildId();
  const startedAtMs = Date.now();
  const discoveredBusinesses = new Set<string>();
  const lastAutoHealAtByKey = new Map<string, number>();
  const lastConsumeBusinessFallbackAtByKey = new Map<string, number>();
  let shuttingDown = false;
  let lastHeartbeatAt = 0;
  let nextPruneAt = startedAtMs + pruneIntervalMs;
  let nextGoogleAdsRetentionAt = startedAtMs + googleAdsRetentionIntervalMs;
  let nextMetaRetentionAt = startedAtMs + metaRetentionIntervalMs;
  const providerScopes = Array.from(
    new Set(
      options.adapters.map((adapter) => adapter.providerScope).filter(Boolean),
    ),
  );

  async function heartbeat(input: {
    providerScope: string;
    status: "starting" | "idle" | "running" | "stopping" | "stopped";
    lastBusinessId?: string | null;
    lastPartitionId?: string | null;
    metaJson?: Record<string, unknown>;
    force?: boolean;
  }) {
    const now = Date.now();
    if (!input.force && now - lastHeartbeatAt < heartbeatIntervalMs) return;
    lastHeartbeatAt = now;
    await heartbeatSyncWorker({
      workerId: buildProviderHeartbeatWorkerId(workerId, input.providerScope),
      instanceType: "durable_sync_worker",
      providerScope: input.providerScope,
      status: input.status,
      lastBusinessId: input.lastBusinessId,
      lastPartitionId: input.lastPartitionId,
      metaJson: {
        ...input.metaJson,
        dbRuntime: getDbRuntimeDiagnostics(),
      },
    });
  }

  const shutdown = async () => {
    shuttingDown = true;
    await heartbeat({
      providerScope: "all",
      status: "stopping",
      force: true,
    }).catch(() => null);
  };

  process.on("SIGINT", shutdown);
  process.on("SIGTERM", shutdown);

  await heartbeat({
    providerScope: "all",
    status: "starting",
    metaJson: {
      workerBuildId,
      workerStartedAt,
      adapters: providerScopes,
      globalDbConcurrency,
    },
    force: true,
  });

  for (const providerScope of providerScopes) {
    await heartbeat({
      providerScope,
      status: "starting",
      metaJson: {
        workerBuildId,
        workerStartedAt,
        providerScope,
        adapters: providerScopes,
        globalDbConcurrency,
      },
      force: true,
    }).catch(() => null);
  }

  // Self-heal watchdog. The tick loop is a single sequential event loop, so any
  // unguarded await (a stalled fetch, a blocked DB call) freezes the entire
  // worker WITHOUT the process exiting — which is how it once went dark for 12
  // days while `restart: unless-stopped` never fired. This independent timer
  // still runs in the timer phase even while the loop is parked on I/O; if no
  // heartbeat has advanced within the stall window, force a restart via the
  // container restart policy. Per-request fetch timeouts should make this rarely
  // fire — it is the catch-all backstop for any future unguarded await.
  const stallWatchdog = setInterval(() => {
    if (shuttingDown || lastHeartbeatAt === 0) return;
    const sinceHeartbeatMs = Date.now() - lastHeartbeatAt;
    if (sinceHeartbeatMs > stallExitMs) {
      console.error("[durable-worker] tick_stalled_self_exit", {
        workerId,
        lastHeartbeatAt: new Date(lastHeartbeatAt).toISOString(),
        sinceHeartbeatMs,
        stallExitMs,
      });
      process.exit(1);
    }
  }, Math.min(stallExitMs, 30_000));
  stallWatchdog.unref();

  while (!shuttingDown) {
    if (Date.now() >= nextPruneAt) {
      await pruneSyncLifecycleData()
        .then((result) => {
          nextPruneAt =
            Date.now() +
            (result.skippedDueToActiveLease
              ? pruneRetryIntervalMs
              : pruneIntervalMs);
          logRuntimeInfo("durable-worker", "lifecycle_prune", result);
        })
        .catch((error) => {
          nextPruneAt = Date.now() + pruneRetryIntervalMs;
          console.error("[durable-worker] lifecycle_prune_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    if (Date.now() >= nextGoogleAdsRetentionAt) {
      await executeGoogleAdsRetentionPolicy({
        asOfDate: new Date().toISOString().slice(0, 10),
      })
        .then((result) => {
          nextGoogleAdsRetentionAt =
            Date.now() +
            (result.skippedDueToActiveLease
              ? googleAdsRetentionRetryIntervalMs
              : googleAdsRetentionIntervalMs);
          logRuntimeInfo("durable-worker", "google_ads_retention", result);
        })
        .catch((error) => {
          nextGoogleAdsRetentionAt =
            Date.now() + googleAdsRetentionRetryIntervalMs;
          console.error("[durable-worker] google_ads_retention_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }
    if (Date.now() >= nextMetaRetentionAt) {
      await executeMetaRetentionPolicy({
        asOfDate: new Date().toISOString().slice(0, 10),
      })
        .then((result) => {
          nextMetaRetentionAt =
            Date.now() +
            (result.skippedDueToActiveLease
              ? metaRetentionRetryIntervalMs
              : metaRetentionIntervalMs);
          logRuntimeInfo("durable-worker", "meta_retention", result);
        })
        .catch((error) => {
          nextMetaRetentionAt = Date.now() + metaRetentionRetryIntervalMs;
          console.error("[durable-worker] meta_retention_failed", {
            message: error instanceof Error ? error.message : String(error),
          });
        });
    }

    await heartbeat({
      providerScope: "all",
      status: "idle",
      metaJson: {
        workerBuildId,
        workerStartedAt,
        tickStartedAt: new Date().toISOString(),
        adapters: options.adapters.map((adapter) => adapter.providerScope),
        globalDbConcurrency,
      },
      force: true,
    }).catch(() => null);

    const prioritizedBusinessIds = Array.from(
      new Set(
        options.adapters.flatMap((adapter) =>
          getPriorityBusinessIdsForAdapter(adapter.providerScope),
        ),
      ),
    );
    const businesses = await getActiveBusinesses(maxBusinessesPerTick, {
      prioritizedIds: prioritizedBusinessIds,
    }).catch(() => []);
    for (const business of businesses) {
      discoveredBusinesses.add(business.id);
    }
    const providerBusinessPlans: ProviderBusinessBatchPlan[] = [];
    for (const adapter of options.adapters) {
      const prioritizedBusinesses = prioritizeBusinessesForAdapter(
        adapter.providerScope,
        businesses,
      );
      const adapterBusinesses = await resolveTickBusinessesForAdapter({
        providerScope: adapter.providerScope,
        businesses: prioritizedBusinesses,
      });
      await heartbeat({
        providerScope: adapter.providerScope,
        status: "idle",
        metaJson: {
          workerBuildId,
          workerStartedAt,
          providerScope: adapter.providerScope,
          tickStartedAt: new Date().toISOString(),
          batchBusinessIds: adapterBusinesses.map((business) => business.id),
          globalDbConcurrency,
        },
        force: true,
      }).catch(() => null);
      const concurrency = envNumber(
        adapter.providerScope === "meta"
          ? "META_WORKER_CONCURRENCY"
          : adapter.providerScope === "shopify"
            ? "SHOPIFY_WORKER_CONCURRENCY"
            : "GOOGLE_ADS_WORKER_CONCURRENCY",
        1,
      );
      const effectiveConcurrency = Math.max(
        1,
        Math.min(concurrency, globalDbConcurrency),
      );
      providerBusinessPlans.push({
        adapter,
        businesses: adapterBusinesses,
        effectiveConcurrency,
      });
    }

    for (const {
      adapter,
      businesses: businessBatch,
    } of buildProviderRoundRobinBusinessBatches(providerBusinessPlans)) {
      await Promise.all(
        businessBatch.map(async (business) => {
          const batchBusinessIds = businessBatch.map((entry) => entry.id);
          const consumeStartedAt = new Date().toISOString();
          await heartbeat({
            providerScope: adapter.providerScope,
            status: "idle",
            lastBusinessId: business.id,
            metaJson: {
              workerBuildId,
              workerStartedAt,
              providerScope: adapter.providerScope,
              tickStartedAt: new Date().toISOString(),
              batchBusinessIds,
              currentBusinessId: business.id,
              consumeStage: "discovered",
              consumeOutcome: null,
            },
            force: true,
          }).catch(() => null);
          const leased = await acquireSyncRunnerLease({
            businessId: business.id,
            providerScope: adapter.providerScope,
            leaseOwner: workerId,
            leaseMinutes,
          }).catch(() => false);
          if (!leased) {
            await heartbeat({
              providerScope: adapter.providerScope,
              status: "idle",
              lastBusinessId: business.id,
              metaJson: {
                workerBuildId,
                workerStartedAt,
                providerScope: adapter.providerScope,
                batchBusinessIds,
                currentBusinessId: business.id,
                consumeStage: "lease_denied",
                consumeOutcome: "lease_denied",
                consumeReason: "lease_not_acquired",
                consumeFinishedAt: new Date().toISOString(),
              },
              force: true,
            }).catch(() => null);
            return;
          }

          await heartbeat({
            providerScope: adapter.providerScope,
            status: "running",
            lastBusinessId: business.id,
            metaJson: {
              workerBuildId,
              workerStartedAt,
              providerScope: adapter.providerScope,
              batchBusinessIds,
              currentBusinessId: business.id,
              consumeStage: "lease_acquired",
              consumeOutcome: null,
              lastLeaseAcquiredAt: new Date().toISOString(),
            },
            force: true,
          }).catch(() => null);

          const leaseGuard = createRunnerLeaseGuard();
          let leaseRenewalStopped = false;
          let leaseRenewalInFlight: Promise<void> | null = null;
          const leaseRenewalIntervalMs = Math.max(
            10_000,
            Math.floor((leaseMinutes * 60_000) / 2),
          );
          const leaseRenewalTimer = setInterval(() => {
            if (leaseRenewalStopped) return;
            leaseRenewalInFlight = renewSyncRunnerLease({
              businessId: business.id,
              providerScope: adapter.providerScope,
              leaseOwner: workerId,
              leaseMinutes,
            })
              .then((renewed) => {
                if (renewed) return;
                leaseGuard.markLeaseLost("runner_lease_conflict");
                console.warn("[durable-worker] runner_lease_lost", {
                  businessId: business.id,
                  providerScope: adapter.providerScope,
                  workerId,
                });
              })
              .catch((error) => {
                leaseGuard.markLeaseLost("runner_lease_renewal_failed");
                console.warn("[durable-worker] runner_lease_renewal_failed", {
                  businessId: business.id,
                  providerScope: adapter.providerScope,
                  workerId,
                  message:
                    error instanceof Error ? error.message : String(error),
                });
              });
          }, leaseRenewalIntervalMs);

          try {
            const autoHealKey = `${adapter.providerScope}:${business.id}`;
            const nowMs = Date.now();
            let autoHealResult: Awaited<
              ReturnType<NonNullable<typeof adapter.runAutoHeal>>
            > | null = null;
            if (
              adapter.runAutoHeal &&
              nowMs - (lastAutoHealAtByKey.get(autoHealKey) ?? 0) >=
                autoHealCooldownMs
            ) {
              autoHealResult = await adapter
                .runAutoHeal(business.id)
                .catch(() => null);
              lastAutoHealAtByKey.set(autoHealKey, nowMs);
            }
            const lifecycleSnapshot = await resolveAdapterLifecycleSnapshot({
              adapter,
              businessId: business.id,
            });
            const leasePlan = adapter.buildLeasePlan
              ? await adapter
                  .buildLeasePlan({
                    businessId: business.id,
                    leaseLimit: partitionTickLimit,
                  })
                  .catch(() => null)
              : null;
            await heartbeat({
              providerScope: adapter.providerScope,
              status: "running",
              lastBusinessId: business.id,
              metaJson: {
                workerBuildId,
                workerStartedAt,
                providerScope: adapter.providerScope,
                batchBusinessIds,
                currentBusinessId: business.id,
                consumeStage: "lifecycle_tick_started",
                consumeStartedAt,
                lifecycleReadinessLevel:
                  lifecycleSnapshot?.readinessLevel ?? null,
                lifecycleCheckpointHealth:
                  lifecycleSnapshot?.checkpointHealth ?? null,
                leasePlanKind: leasePlan?.kind ?? null,
                lanePlanSummary:
                  leasePlan?.steps.map((step) => ({
                    key: step.key,
                    lane: step.lane ?? null,
                    limit: step.limit,
                    sourceFilter: step.sourceFilter ?? null,
                    sources: step.sources ?? null,
                    scopeFilter: step.scopeFilter ?? null,
                    startDate: step.startDate ?? null,
                    endDate: step.endDate ?? null,
                    onlyIfNoLease: step.onlyIfNoLease ?? false,
                  })) ?? [],
                fairnessInputs: leasePlan?.fairnessInputs ?? null,
                repairActionsRun: autoHealResult
                  ? {
                      reclaimed: autoHealResult.reclaimed,
                      replayed: autoHealResult.replayed,
                      requeued: autoHealResult.requeued,
                      blocked: autoHealResult.blocked,
                    }
                  : null,
                repairCounts: autoHealResult
                  ? {
                      reclaimed: autoHealResult.reclaimed,
                      replayed: autoHealResult.replayed,
                      requeued: autoHealResult.requeued,
                    }
                  : null,
                repairMeta: autoHealResult?.meta ?? null,
                lastAdvancementEvidence: leasePlan?.progressEvidence ?? null,
                stallFingerprints: leasePlan?.stallFingerprints ?? [],
                blockedReasonCodes: leasePlan?.blockedReasonCodes ?? [],
              },
              force: true,
            }).catch(() => null);
            const lifecycleResult = await runAdapterLifecycleTick({
              adapter,
              businessId: business.id,
              workerId,
              leaseLimit: partitionTickLimit,
              leasePlan,
              leaseGuard,
            });
            let result: unknown = null;
            let executionMode: "lifecycle_tick" | "consume_business_fallback" =
              "lifecycle_tick";
            if (
              lifecycleResult.attempted === 0 &&
              lifecycleResult.failed === 0
            ) {
              executionMode = "consume_business_fallback";
              const fallbackKey = `${adapter.providerScope}:${business.id}`;
              const fallbackDecision =
                await resolveConsumeBusinessFallbackDecision({
                  providerScope: adapter.providerScope,
                  businessId: business.id,
                  lastFallbackAtMs:
                    lastConsumeBusinessFallbackAtByKey.get(fallbackKey) ?? null,
                  cooldownMs: consumeBusinessFallbackCooldownMs,
                });
              await heartbeat({
                providerScope: adapter.providerScope,
                status: "running",
                lastBusinessId: business.id,
                metaJson: {
                  workerBuildId,
                  workerStartedAt,
                  providerScope: adapter.providerScope,
                  batchBusinessIds,
                  currentBusinessId: business.id,
                  consumeStage: "consume_started",
                  consumeStartedAt,
                  executionMode,
                  lifecycleAttempted: lifecycleResult.attempted,
                  lifecycleSucceeded: lifecycleResult.succeeded,
                  lifecycleFailed: lifecycleResult.failed,
                  lifecycleLeasedPartitionIds:
                    lifecycleResult.leasedPartitionIds,
                  laneLeaseCounts: lifecycleResult.laneLeaseCounts,
                  compatibilityFallbackAllowed: fallbackDecision.allowed,
                  compatibilityFallbackReason: fallbackDecision.reason,
                  lifecycleCheckpointHealth:
                    lifecycleSnapshot?.checkpointHealth ?? null,
                  leasePlanKind: leasePlan?.kind ?? null,
                  fairnessInputs: leasePlan?.fairnessInputs ?? null,
                  repairActionsRun: autoHealResult
                    ? {
                        reclaimed: autoHealResult.reclaimed,
                        replayed: autoHealResult.replayed,
                        requeued: autoHealResult.requeued,
                        blocked: autoHealResult.blocked,
                      }
                    : null,
                  repairMeta: autoHealResult?.meta ?? null,
                  stallFingerprints: leasePlan?.stallFingerprints ?? [],
                  blockedReasonCodes: leasePlan?.blockedReasonCodes ?? [],
                },
                force: true,
              }).catch(() => null);
              if (!fallbackDecision.allowed) {
                result = {
                  businessId: business.id,
                  attempted: 0,
                  succeeded: 0,
                  failed: 0,
                  skipped: true,
                  outcome: "consume_business_fenced",
                  failureReason: fallbackDecision.reason,
                  lastPartitionId: null,
                  leasedPartitionIds: [],
                };
              } else {
                lastConsumeBusinessFallbackAtByKey.set(fallbackKey, Date.now());
                result = await adapter.consumeBusiness(business.id, {
                  runtimeLeaseGuard: leaseGuard,
                  runtimeWorkerId: workerId,
                });
              }
            } else {
              result = {
                businessId: business.id,
                attempted: lifecycleResult.attempted,
                succeeded: lifecycleResult.succeeded,
                failed: lifecycleResult.failed,
                skipped: lifecycleResult.attempted === 0,
                outcome:
                  lifecycleResult.failed > 0 && lifecycleResult.succeeded === 0
                    ? "lifecycle_tick_failed"
                    : lifecycleResult.succeeded > 0
                      ? "lifecycle_tick_succeeded"
                      : "lifecycle_tick_idle",
                failureReason: lifecycleResult.failureReasons[0] ?? null,
                lastPartitionId: lifecycleResult.lastPartitionId,
                leasedPartitionIds: lifecycleResult.leasedPartitionIds,
              };
            }
            const syncResult =
              result && typeof result === "object"
                ? (result as Record<string, unknown>)
                : null;
            await heartbeat({
              providerScope: adapter.providerScope,
              status: "idle",
              lastBusinessId: business.id,
              metaJson: {
                workerBuildId,
                workerStartedAt,
                providerScope: adapter.providerScope,
                batchBusinessIds,
                currentBusinessId: business.id,
                consumeStage:
                  executionMode === "lifecycle_tick"
                    ? "lifecycle_tick_succeeded"
                    : "consume_succeeded",
                consumeStartedAt:
                  syncResult?.consumeStartedAt &&
                  typeof syncResult.consumeStartedAt === "string"
                    ? syncResult.consumeStartedAt
                    : consumeStartedAt,
                consumeFinishedAt: new Date().toISOString(),
                consumeOutcome:
                  syncResult?.outcome && typeof syncResult.outcome === "string"
                    ? syncResult.outcome
                    : "consume_succeeded",
                consumeReason:
                  syncResult?.failureReason &&
                  typeof syncResult.failureReason === "string"
                    ? syncResult.failureReason
                    : null,
                executionMode,
                lifecycleReadinessLevel:
                  lifecycleSnapshot?.readinessLevel ?? null,
                lifecycleCheckpointHealth:
                  lifecycleSnapshot?.checkpointHealth ?? null,
                lifecycleLastPartitionId:
                  syncResult?.lastPartitionId &&
                  typeof syncResult.lastPartitionId === "string"
                    ? syncResult.lastPartitionId
                    : lifecycleResult.lastPartitionId,
                lifecycleLeasedPartitionIds: Array.isArray(
                  syncResult?.leasedPartitionIds,
                )
                  ? syncResult?.leasedPartitionIds
                  : lifecycleResult.leasedPartitionIds,
                laneLeaseCounts: lifecycleResult.laneLeaseCounts,
                leasePlanKind: leasePlan?.kind ?? null,
                fairnessInputs: leasePlan?.fairnessInputs ?? null,
                repairActionsRun: autoHealResult
                  ? {
                      reclaimed: autoHealResult.reclaimed,
                      replayed: autoHealResult.replayed,
                      requeued: autoHealResult.requeued,
                      blocked: autoHealResult.blocked,
                    }
                  : null,
                repairCounts: autoHealResult
                  ? {
                      reclaimed: autoHealResult.reclaimed,
                      replayed: autoHealResult.replayed,
                      requeued: autoHealResult.requeued,
                    }
                  : null,
                repairMeta: autoHealResult?.meta ?? null,
                lastAdvancementEvidence: leasePlan?.progressEvidence ?? null,
                stallFingerprints: leasePlan?.stallFingerprints ?? [],
                blockedReasonCodes: leasePlan?.blockedReasonCodes ?? [],
                consumeAttempted:
                  syncResult?.attempted &&
                  typeof syncResult.attempted === "number"
                    ? syncResult.attempted
                    : null,
                consumeSucceeded:
                  syncResult?.succeeded &&
                  typeof syncResult.succeeded === "number"
                    ? syncResult.succeeded
                    : null,
                consumeFailed:
                  syncResult?.failed && typeof syncResult.failed === "number"
                    ? syncResult.failed
                    : null,
                discoveredBusinessCount: discoveredBusinesses.size,
              },
              force: true,
            }).catch(() => null);
          } catch (error) {
            console.error("[durable-worker] consume_failed", {
              businessId: business.id,
              providerScope: adapter.providerScope,
              message: error instanceof Error ? error.message : String(error),
            });
            await heartbeat({
              providerScope: adapter.providerScope,
              status: "idle",
              lastBusinessId: business.id,
              metaJson: {
                workerBuildId,
                workerStartedAt,
                providerScope: adapter.providerScope,
                batchBusinessIds,
                currentBusinessId: business.id,
                consumeStage: "consume_failed",
                consumeStartedAt,
                consumeFinishedAt: new Date().toISOString(),
                consumeOutcome: "consume_failed",
                consumeReason:
                  error instanceof Error ? error.message : String(error),
              },
              force: true,
            }).catch(() => null);
          } finally {
            leaseRenewalStopped = true;
            clearInterval(leaseRenewalTimer);
            if (leaseRenewalInFlight) {
              const renewalPromise: Promise<void> = leaseRenewalInFlight;
              await renewalPromise.catch(() => null);
            }
            await adapter
              .cleanupOwnedLeasedPartitions?.({
                businessId: business.id,
                workerId,
                failureReason: leaseGuard.getLeaseLossReason(),
              })
              .catch(() => null);
            await releaseSyncRunnerLease({
              businessId: business.id,
              providerScope: adapter.providerScope,
              leaseOwner: workerId,
            }).catch(() => null);
          }
        }),
      );
    }

    await sleep(pollIntervalMs);
  }

  clearInterval(stallWatchdog);
  await heartbeat({
    providerScope: "all",
    status: "stopped",
    force: true,
  }).catch(() => null);
}
