import {
  type MetaCredentials,
  publishMetaBreakdownAuthoritativeSurface,
  resolveMetaCredentials,
  syncMetaAccountBreakdownWarehouseDay,
  syncMetaAccountCoreWarehouseDay,
} from "@/lib/api/meta";
import { isMetaAuthoritativeFinalizationV2EnabledForBusiness } from "@/lib/meta/authoritative-finalization-config";
import { META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS } from "@/lib/meta/recent-edit-authority";
import {
  claimMetaAuthorityBootstrapAttempt,
  readMetaAuthorityBootstrapProbe,
} from "@/lib/meta/config-observation-attestation";
import {
  providerLocalCalendarDate,
  providerLocalDayEndExclusive,
  readMetaAccountTimeZones,
} from "@/lib/meta/provider-local-day";
import { sanitizeMetaGraphTraceId } from "@/lib/meta/graph-trace-id";
import { syncMetaCreativesWarehouseDay } from "@/lib/meta/creatives-warehouse";
import {
  META_PRODUCT_CORE_PARTITION_SCOPE,
  META_CORE_PARTITION_SCOPES,
  META_EXTENDED_SCOPES,
  META_PRODUCT_CORE_COVERAGE_SCOPES,
  META_RUNTIME_STATE_SCOPES,
  isMetaProductCoreCoverageScope,
} from "@/lib/meta/core-config";
import { assertSyncGrowthBoundary } from "@/lib/sync/db-growth-fence";
import { resolveMetaAccountAuthority } from "@/lib/meta/account-context";
import {
  isMetaProviderStopLossFailure,
  runMetaLeasedPartitionBatch,
} from "@/lib/sync/meta-batch-stop";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import {
  cancelMetaPartitionsForRevokedAccount,
  backfillMetaRunningRunsForTerminalPartition,
  cancelObsoleteMetaCoreScopePartitions,
  cleanupMetaPartitionOrchestration,
  completeMetaPartitionAttempt,
  createMetaAuthoritativeReconciliationEvent,
  createMetaSyncJob,
  createMetaSyncRun,
  expireStaleMetaSyncJobs,
  getMetaPartitionCompletionDenialSnapshot,
  getLatestRunningMetaSyncRunIdForPartition,
  getLatestMetaCheckpointForPartition,
  heartbeatMetaPartitionLease,
  getLatestMetaSyncHealth,
  getMetaAdDailyCoverage,
  getMetaAdSetDailyCoverage,
  getMetaAccountDailyCoverage,
  getMetaAuthoritativeDayVerification,
  getMetaAuthoritativeRequiredSurfacesForDayAge,
  getMetaCampaignDailyCoverage,
  getMetaCreativeDailyCoverage,
  getMetaDirtyRecentDates,
  getMetaIncompleteCoverageDates,
  getMetaPartitionStatesForDate,
  getMetaPublishedVerificationSummary,
  getMetaRecentAuthoritativeSliceGuard,
  listMetaAuthoritativeDayStates,
  getMetaQueueComposition,
  getMetaPartitionHealth,
  getMetaQueueHealth,
  getMetaRawSnapshotCoverageByEndpoint,
  getMetaSyncCheckpoint,
  getMetaSyncState,
  leaseMetaSyncPartitions,
  markMetaPartitionRunning,
  quarantineMetaTerminalActionRequiredPartitions,
  queueMetaSyncPartition,
  releaseMetaLeasedPartitionsForWorker,
  replayMetaDeadLetterPartitions,
  requeueMetaRetryableFailedPartitions,
  updateMetaSyncJob,
  updateMetaSyncRun,
  upsertMetaAuthoritativeDayState,
  reconcileMetaAuthoritativeDayStateFromVerification,
  upsertMetaSyncState,
  upsertMetaSyncCheckpoint,
} from "@/lib/meta/warehouse";
import type {
  MetaAuthoritativeDayStateRecord,
  MetaAuthoritativeDayVerification,
  MetaDirtyRecentDateRow,
  MetaDirtyRecentSeverity,
  MetaSelectedRangeTruthReadiness,
  MetaSyncCheckpointRecord,
  MetaSyncLane,
  MetaSyncPartitionRecord,
  MetaSyncPartitionSource,
  MetaSyncType,
  MetaWarehouseScope,
} from "@/lib/meta/warehouse-types";
import {
  getCreativeMediaRetentionStart,
  META_CREATIVE_WAREHOUSE_HISTORY_DAYS,
  META_WAREHOUSE_HISTORY_DAYS,
  dayCountInclusive,
} from "@/lib/meta/history";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  ensureProviderAccountReferenceBindings,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";
import {
  buildProviderProgressEvidence,
  deriveProviderStallFingerprints,
  hasRecentProviderAdvancement,
  type ProviderLeasePlan,
  type ProviderProgressEvidence,
  type ProviderProgressEvidenceStateRow,
} from "@/lib/sync/provider-status-truth";
import {
  classifyMetaSyncFailure,
  shouldDeadLetterMetaFailure,
} from "@/lib/sync/meta-error-classification";
import type { RunnerLeaseGuard } from "@/lib/sync/worker-runtime";
import { recordSyncReclaimEvents } from "@/lib/sync/worker-health";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import { logRuntimeInfo, logRuntimeWarn } from "@/lib/runtime-logging";
import { readThroughCache } from "@/lib/server-cache";
import {
  markProviderDayRolloverFinalizeStarted,
  markProviderDayRolloverFinalizeCompleted,
  syncProviderDayRolloverState,
} from "@/lib/sync/provider-day-rollover";

const META_BREAKDOWN_ENDPOINTS = [
  "breakdown_age",
  "breakdown_country",
  "breakdown_publisher_platform,platform_position,impression_device",
] as const;

const META_AUTHORITATIVE_CORE_PUBLISHED_SURFACES: MetaWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
  "adset_daily",
  "ad_daily",
];

const META_AUTHORITATIVE_PLANNER_PUBLISHED_SURFACES: MetaWarehouseScope[] = [
  ...META_AUTHORITATIVE_CORE_PUBLISHED_SURFACES,
  "breakdown_daily",
];

const META_SELECTED_RANGE_TRUTH_CACHE_TTL_MS = 60_000;

function shouldBypassMetaSelectedRangeTruthCache() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function buildMetaSelectedRangeTruthCacheKey(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  providerAccountIds: string[];
}) {
  return [
    "meta-selected-range-truth:v1",
    input.businessId,
    input.startDate,
    input.endDate,
    input.providerAccountIds.join(","),
  ].join(":");
}

async function upsertMetaCheckpointOrThrow(input: MetaSyncCheckpointRecord) {
  const checkpointId = await upsertMetaSyncCheckpoint(input);
  if (input.leaseOwner && !checkpointId) {
    throw new Error("lease_conflict:checkpoint_write_rejected");
  }
  return checkpointId;
}

function sleepMs(ms: number) {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function addUtcDays(date: string, delta: number) {
  const next = new Date(`${date}T00:00:00Z`);
  next.setUTCDate(next.getUTCDate() + delta);
  return next.toISOString().slice(0, 10);
}

function parseTimestampMs(value: unknown) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
}

type MetaQueueVisibilityEvent =
  | "meta_background_sync_already_scheduled"
  | "meta_queue_present_no_runner_lease"
  | "meta_runner_lease_not_acquired"
  | "meta_queue_health";

export function logMetaQueueVisibility(
  event: MetaQueueVisibilityEvent,
  details: Record<string, unknown>,
) {
  logRuntimeInfo("meta-sync", event, details);
}

type MetaPartitionStageName =
  | "syncMetaPartitionDay.coverage_before"
  | "syncMetaPartitionDay.account_core_sync"
  | "syncMetaPartitionDay.breakdown_sync"
  | "syncMetaPartitionDay.coverage_after"
  | "syncMetaPartitionDay.authoritative_verification";

type MetaPartitionStageTaggedError = Error & {
  metaPartitionStage?: MetaPartitionStageName;
};

function tagMetaPartitionStageError(
  error: unknown,
  stage: MetaPartitionStageName,
) {
  if (error instanceof Error && !(error as MetaPartitionStageTaggedError).metaPartitionStage) {
    (error as MetaPartitionStageTaggedError).metaPartitionStage = stage;
  }
  return error;
}

function getMetaPartitionStageFromError(error: unknown) {
  if (!(error instanceof Error)) return null;
  return (error as MetaPartitionStageTaggedError).metaPartitionStage ?? null;
}

function buildMetaPartitionStagePayload(input: {
  businessId: string;
  providerAccountId: string | null;
  partitionId: string;
  scope: string;
  lane: MetaSyncLane;
  source: string;
  day: string;
  durationMs: number;
  stage: MetaPartitionStageName;
  ok: boolean;
  errorMessage?: string | null;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    partitionId: input.partitionId,
    scope: input.scope,
    lane: input.lane,
    source: input.source,
    day: input.day,
    durationMs: input.durationMs,
    stage: input.stage,
    ok: input.ok,
    errorMessage: input.errorMessage ?? null,
  };
}

async function captureMetaPartitionStage<T>(input: {
  businessId: string;
  providerAccountId: string;
  partitionId: string;
  scope: string;
  lane: MetaSyncLane;
  source: string;
  day: string;
  stage: MetaPartitionStageName;
  run: () => Promise<T>;
}) {
  const startedAt = Date.now();
  try {
    const result = await input.run();
    logRuntimeInfo("meta-sync", "partition_stage", buildMetaPartitionStagePayload({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionId: input.partitionId,
      scope: input.scope,
      lane: input.lane,
      source: input.source,
      day: input.day,
      durationMs: Date.now() - startedAt,
      stage: input.stage,
      ok: true,
    }));
    return result;
  } catch (error) {
    const taggedError = tagMetaPartitionStageError(error, input.stage);
    const errorMessage = durableMetaFailureMessage(taggedError);
    logRuntimeWarn("meta-sync", "partition_stage_failed", buildMetaPartitionStagePayload({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionId: input.partitionId,
      scope: input.scope,
      lane: input.lane,
      source: input.source,
      day: input.day,
      durationMs: Date.now() - startedAt,
      stage: input.stage,
      ok: false,
      errorMessage,
    }));
    throw taggedError;
  }
}

/**
 * The failure text this module is allowed to PERSIST and LOG.
 *
 * WHY A FUNCTION AND NOT `error.message`. A provider refusal used to arrive
 * here as `new Error(json.error.message)` — Meta's own prose, which routinely
 * quotes the request that was refused — and every partition failure path wrote
 * it straight into `meta_sync_partitions.last_error`,
 * `meta_sync_runs.error_message` and the operator-facing logs. Those columns
 * are durable, are read by people, and are not the place for a third party's
 * free text.
 *
 * `lib/api/meta.ts` now refuses a Graph page as a `MetaGraphRequestError`
 * carrying the STRUCTURED identity (`httpStatus`, `errorCode`, `errorSubcode`,
 * `isTransient`, `fbtraceId`) and a message built from those numbers. This
 * function composes the durable record from those fields — never from the
 * carrier's message — so no path can reintroduce provider prose by throwing a
 * differently-worded Graph error.
 *
 * Duck-typed on purpose, exactly as `readGraphErrorIdentity` in
 * `lib/sync/meta-error-classification.ts` is: the sync layer classifies Graph
 * failures without taking a dependency on the Graph client.
 *
 * Errors that are NOT Graph refusals keep their message. Those are this
 * codebase's own text — a lease conflict, a database error, an assertion — and
 * suppressing them would blind the operator to the failures they can act on.
 */
export function durableMetaFailureMessage(error: unknown): string {
  const carrier =
    error != null && typeof error === "object"
      ? (error as Record<string, unknown>)
      : null;
  if (carrier?.name === "MetaGraphRequestError") {
    const field = (key: string) => {
      const value = carrier[key];
      if (value === null || value === undefined || value === "") return "none";
      return String(value);
    };
    /*
      `fbtraceId` IS THE ONE FIELD A THIRD PARTY WRITES.

      Every other member composed here is a number, a boolean or a termination
      string this codebase chose. `field()` would `String(...)` the trace id
      whatever it held — so prose, a newline that splits the durable record in
      two, or one of the `:`/`=`/` ` delimiters this very message uses as
      structure would be written straight into
      `meta_sync_partitions.last_error` and `meta_sync_runs.error_message`.
      The shared rule is applied here as well as at parse time, so a carrier
      built by some other route cannot smuggle a value through the formatter.
    */
    const fbtrace = sanitizeMetaGraphTraceId(carrier.fbtraceId) ?? "none";
    return [
      `meta_graph_refusal:${field("termination")}`,
      `status=${field("httpStatus")}`,
      `code=${field("errorCode")}`,
      `subcode=${field("errorSubcode")}`,
      `transient=${
        typeof carrier.isTransient === "boolean"
          ? String(carrier.isTransient)
          : "unknown"
      }`,
      `fbtrace=${fbtrace}`,
    ].join(" ");
  }
  return error instanceof Error ? error.message : String(error);
}

async function heartbeatMetaPartitionBeforeCompletion(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes: number;
}) {
  const ok = await heartbeatMetaPartitionLease({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes,
  });
  return ok
    ? ({ ok: true } as const)
    : ({ ok: false, reason: "lease_conflict" } as const);
}

async function heartbeatMetaPartitionDuringOrchestrationOrThrow(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes: number;
}) {
  const ok = await heartbeatMetaPartitionLease({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes,
  });
  if (!ok) {
    throw new Error("lease_conflict:lease_heartbeat_rejected");
  }
}

async function logMetaSuccessCompletionDenied(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch: number;
  lane: MetaSyncLane;
  scope: MetaWarehouseScope;
  partitionStatus: "succeeded" | "failed" | "dead_letter" | "cancelled";
  runStatus: "succeeded" | "failed" | "cancelled";
  reason: "lease_conflict" | "operational_error";
  message?: string | null;
}) {
  const [latestCheckpoint, denialSnapshot] = await Promise.all([
    getLatestMetaCheckpointForPartition({
      partitionId: input.partitionId,
    }).catch(() => null),
    getMetaPartitionCompletionDenialSnapshot({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
    }).catch(() => null),
  ]);
  console.warn("[meta-sync] partition_success_completion_denied", {
    partitionId: input.partitionId,
    runId: input.runId ?? null,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    lane: input.lane,
    scope: input.scope,
    partitionStatus: input.partitionStatus,
    runStatusBefore: "running",
    runStatusAfter: input.runStatus,
    reason: input.reason,
    message: input.message ?? null,
    currentPartitionStatus: denialSnapshot?.currentPartitionStatus ?? null,
    currentLeaseOwner: denialSnapshot?.currentLeaseOwner ?? null,
    currentLeaseEpoch: denialSnapshot?.currentLeaseEpoch ?? null,
    currentLeaseExpiresAt: denialSnapshot?.currentLeaseExpiresAt ?? null,
    ownerMatchesCaller: denialSnapshot?.ownerMatchesCaller ?? null,
    epochMatchesCaller: denialSnapshot?.epochMatchesCaller ?? null,
    leaseExpiredAtObservation:
      denialSnapshot?.leaseExpiredAtObservation ?? null,
    currentPartitionFinishedAt:
      denialSnapshot?.currentPartitionFinishedAt ?? null,
    checkpointScope:
      denialSnapshot?.latestCheckpointScope ??
      latestCheckpoint?.checkpointScope ??
      null,
    checkpointPhase:
      denialSnapshot?.latestCheckpointPhase ?? latestCheckpoint?.phase ?? null,
    checkpointUpdatedAt:
      denialSnapshot?.latestCheckpointUpdatedAt ??
      latestCheckpoint?.updatedAt ??
      null,
    latestRunningRunId: denialSnapshot?.latestRunningRunId ?? null,
    runningRunCount: denialSnapshot?.runningRunCount ?? 0,
    denialClassification:
      denialSnapshot?.denialClassification ?? "unknown_denial",
  });
  return denialSnapshot;
}

function isMetaTerminalSuccessDenial(
  denialSnapshot: Awaited<
    ReturnType<typeof getMetaPartitionCompletionDenialSnapshot>
  > | null,
) {
  return (
    denialSnapshot?.denialClassification === "already_terminal" &&
    denialSnapshot.currentPartitionStatus === "succeeded"
  );
}

async function backfillMetaDeniedTerminalRuns(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch: number;
  lane: MetaSyncLane;
  scope: MetaWarehouseScope;
  pathKind: "primary" | "backfill" | "repair";
}) {
  try {
    const result = await backfillMetaRunningRunsForTerminalPartition({
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
    });
    console.warn("[meta-sync] terminal_parent_running_runs_backfilled", {
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      lane: input.lane,
      scope: input.scope,
      pathKind: input.pathKind,
      partitionStatus: result.partitionStatus,
      closedRunningRunCount: result.closedRunningRunCount,
      callerRunIdWasClosed: result.callerRunIdWasClosed,
      closedRunningRunIds: result.closedRunningRunIds,
    });
  } catch (error) {
    console.warn("[meta-sync] terminal_parent_running_runs_backfill_failed", {
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      lane: input.lane,
      scope: input.scope,
      pathKind: input.pathKind,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

async function enqueueMetaExtendedPartitionsAfterSuccess(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  source: string;
}) {
  const maxAttempts = 3;
  for (let attempt = 1; attempt <= maxAttempts; attempt += 1) {
    try {
      await enqueueMetaExtendedPartitionsForDate(input);
      return true;
    } catch (error) {
      if (attempt >= maxAttempts) {
        console.warn("[meta-sync] post_success_extended_enqueue_failed", {
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          date: input.date,
          source: input.source,
          attempts: attempt,
          message: error instanceof Error ? error.message : String(error),
        });
        return false;
      }
      await sleepMs(attempt * 250);
    }
  }
  return false;
}

async function backfillMetaRunTerminalState(input: {
  runId: string | null;
  recoveredRunId?: string | null;
  startedAtMs: number;
  status: "succeeded" | "failed" | "cancelled";
  errorClass?: string | null;
  errorMessage?: string | null;
  finishedAt: string;
  context: {
    partitionId: string;
    workerId: string;
    leaseEpoch: number;
    lane: MetaSyncLane;
    scope: MetaWarehouseScope;
  };
}) {
  if (!input.runId) return;
  console.warn("[meta-sync] partition_completion_run_backfill", {
    partitionId: input.context.partitionId,
    runId: input.runId,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.context.workerId,
    leaseEpoch: input.context.leaseEpoch,
    lane: input.context.lane,
    scope: input.context.scope,
    partitionStatus: input.status,
    runStatusBefore: "running",
    runStatusAfter: input.status,
    pathKind: "backfill",
  });
  await updateMetaSyncRun({
    id: input.runId,
    status: input.status,
    durationMs: Date.now() - input.startedAtMs,
    errorClass: input.errorClass ?? null,
    errorMessage: input.errorMessage ?? null,
    finishedAt: input.finishedAt,
    onlyIfCurrentStatus: "running",
  }).catch(() => null);
}

const META_DEPRECATED_SCOPE_REASONS: Partial<
  Record<MetaWarehouseScope, string>
> = {};

export function getDeprecatedMetaPartitionCancellationReason(
  scope: MetaWarehouseScope,
): string | null {
  return META_DEPRECATED_SCOPE_REASONS[scope] ?? null;
}

const META_CORE_SCOPES: MetaWarehouseScope[] = [
  ...META_PRODUCT_CORE_COVERAGE_SCOPES,
];
const META_CORE_PARTITION_QUEUE_SCOPES: MetaWarehouseScope[] = [
  ...META_CORE_PARTITION_SCOPES,
];
const META_EXTENDED_SCOPE_LIST: MetaWarehouseScope[] = [
  ...META_EXTENDED_SCOPES,
];
const META_STATE_SCOPES: MetaWarehouseScope[] = [...META_RUNTIME_STATE_SCOPES];

const runtimeSyncStore = globalThis as typeof globalThis & {
  __metaBackgroundSyncKeys?: Set<string>;
  __metaBackgroundWorkerTimers?: Map<string, ReturnType<typeof setTimeout>>;
  __metaBackgroundErrorCounts?: Map<string, number>;
};

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

const META_BACKGROUND_IDLE_DELAY_MS = envNumber(
  "META_BACKGROUND_IDLE_DELAY_MS",
  envNumber("META_BACKGROUND_LOOP_DELAY_MS", 5_000),
);
const META_BACKGROUND_BUSY_DELAY_MS = envNumber(
  "META_BACKGROUND_BUSY_DELAY_MS",
  150,
);
const META_BACKGROUND_WAITING_DELAY_MS = envNumber(
  "META_BACKGROUND_WAITING_DELAY_MS",
  1_500,
);
const META_BACKGROUND_ERROR_BASE_DELAY_MS = envNumber(
  "META_BACKGROUND_ERROR_BASE_DELAY_MS",
  1_000,
);
const META_BACKGROUND_ERROR_MAX_DELAY_MS = envNumber(
  "META_BACKGROUND_ERROR_MAX_DELAY_MS",
  15_000,
);
const META_CORE_WORKER_LIMIT = envNumber("META_CORE_WORKER_LIMIT", 4);
const META_CORE_FAIRNESS_WORKER_LIMIT = envNumber(
  "META_CORE_FAIRNESS_WORKER_LIMIT",
  1,
);
const META_EXTENDED_WORKER_LIMIT = envNumber("META_EXTENDED_WORKER_LIMIT", 2);
const META_EXTENDED_HISTORICAL_FAIRNESS_WORKER_LIMIT = envNumber(
  "META_EXTENDED_HISTORICAL_FAIRNESS_WORKER_LIMIT",
  1,
);
const META_MAINTENANCE_WORKER_LIMIT = envNumber(
  "META_MAINTENANCE_WORKER_LIMIT",
  2,
);
const META_PRIORITY_BACKLOG_LEASE_LIMIT = envNumber(
  "META_PRIORITY_BACKLOG_LEASE_LIMIT",
  3,
);
const META_FORWARD_PROGRESS_LEASE_LIMIT = envNumber(
  "META_FORWARD_PROGRESS_LEASE_LIMIT",
  2,
);
const META_PRODUCTIVE_LEASE_LIMIT = envNumber(
  "META_PRODUCTIVE_LEASE_LIMIT",
  6,
);
const META_PARTITION_LEASE_MINUTES = envNumber(
  "META_PARTITION_LEASE_MINUTES",
  6,
);
const META_PARTITION_MAX_ATTEMPTS = envNumber("META_PARTITION_MAX_ATTEMPTS", 6);
const META_ENQUEUE_BATCH_SIZE = envNumber("META_ENQUEUE_BATCH_SIZE", 25);
const META_HISTORICAL_ENQUEUE_DAYS_PER_RUN = envNumber(
  "META_HISTORICAL_ENQUEUE_DAYS_PER_RUN",
  21,
);
const META_CREATIVE_WAREHOUSE_HISTORICAL_ENQUEUE_DAYS_PER_RUN = envNumber(
  "META_CREATIVE_WAREHOUSE_HISTORICAL_ENQUEUE_DAYS_PER_RUN",
  90,
);
const META_CREATIVE_WAREHOUSE_RECENT_ENQUEUE_DAYS = envNumber(
  "META_CREATIVE_WAREHOUSE_RECENT_ENQUEUE_DAYS",
  2,
);
const META_CREATIVE_WAREHOUSE_DAILY_FULL_UTC_HOUR = envNumber(
  "META_CREATIVE_WAREHOUSE_DAILY_FULL_UTC_HOUR",
  3,
);
const META_CREATIVE_WAREHOUSE_INCREMENTAL_COOLDOWN_MINUTES = envNumber(
  "META_CREATIVE_WAREHOUSE_INCREMENTAL_COOLDOWN_MINUTES",
  55,
);
const META_RECENT_RECOVERY_DAYS = envNumber("META_RECENT_RECOVERY_DAYS", 14);
const META_RUN_PROGRESS_GRACE_MINUTES = envNumber(
  "META_RUN_PROGRESS_GRACE_MINUTES",
  3,
);
const META_STALE_RUN_CORE_MINUTES = envNumber(
  "META_STALE_RUN_CORE_MINUTES",
  12,
);
const META_STALE_RUN_MAINTENANCE_MINUTES = envNumber(
  "META_STALE_RUN_MAINTENANCE_MINUTES",
  15,
);
const META_STALE_RUN_EXTENDED_MINUTES = envNumber(
  "META_STALE_RUN_EXTENDED_MINUTES",
  25,
);
const META_IN_PROCESS_RUNTIME_ENABLED =
  process.env.META_ENABLE_IN_PROCESS_RUNTIME?.trim().toLowerCase() === "1" ||
  process.env.META_ENABLE_IN_PROCESS_RUNTIME?.trim().toLowerCase() === "true";

export function hasMetaInProcessBackgroundWorkerIdentity(
  env: NodeJS.ProcessEnv = process.env,
) {
  return Boolean(
    env.META_WORKER_ID?.trim() || env.WORKER_INSTANCE_ID?.trim(),
  );
}

function canUseInProcessBackgroundScheduling() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SYNC_WORKER_MODE === "1" &&
    META_IN_PROCESS_RUNTIME_ENABLED &&
    hasMetaInProcessBackgroundWorkerIdentity()
  );
}

function getBackgroundSyncKeys() {
  if (!runtimeSyncStore.__metaBackgroundSyncKeys) {
    runtimeSyncStore.__metaBackgroundSyncKeys = new Set<string>();
  }
  return runtimeSyncStore.__metaBackgroundSyncKeys;
}

function getBackgroundWorkerTimers() {
  if (!runtimeSyncStore.__metaBackgroundWorkerTimers) {
    runtimeSyncStore.__metaBackgroundWorkerTimers = new Map();
  }
  return runtimeSyncStore.__metaBackgroundWorkerTimers;
}

function getBackgroundErrorCounts() {
  if (!runtimeSyncStore.__metaBackgroundErrorCounts) {
    runtimeSyncStore.__metaBackgroundErrorCounts = new Map();
  }
  return runtimeSyncStore.__metaBackgroundErrorCounts;
}

function getTodayIsoForTimeZoneServer(timeZone: string): string {
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
}

export function buildMetaD1AccountTargetDates(input: {
  providerAccountIds: string[];
  boundAccountTimezones: ReadonlyMap<string, string>;
}) {
  return new Map(
    input.providerAccountIds.map((providerAccountId) => {
      const timezone = input.boundAccountTimezones.get(providerAccountId) ?? "UTC";
      const today = getTodayIsoForTimeZoneServer(timezone);
      return [providerAccountId, addUtcDays(today, -1)] as const;
    }),
  );
}

function toIsoDate(date: Date) {
  return date.toISOString().slice(0, 10);
}

export function normalizeMetaPartitionDate(value: string | Date) {
  if (value instanceof Date) return toIsoDate(value);
  const text = String(value ?? "").trim();
  if (/^\d{4}-\d{2}-\d{2}/.test(text)) return text.slice(0, 10);
  const parsed = new Date(text);
  if (Number.isFinite(parsed.getTime())) return toIsoDate(parsed);
  throw new Error(`Invalid Meta partition date: ${value}`);
}

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

const META_RECENT_SOURCE_SET = new Set([
  "finalize_day",
  "priority_window",
  "repair_recent_day",
  "yesterday",
  "today_observe",
  "today",
  "request_runtime",
  "recent",
  "recent_recovery",
  "manual_refresh",
  "core_success",
]);

const META_HISTORICAL_SOURCE_SET = new Set([
  "historical",
  "historical_recovery",
  "initial_connect",
]);
const META_PRIORITY_CORE_SOURCE_LIST = [...META_RECENT_SOURCE_SET];
const META_HISTORICAL_SOURCE_LIST = [...META_HISTORICAL_SOURCE_SET];

const META_PROGRESS_EVIDENCE_WINDOW_MINUTES = envNumber(
  "META_PROGRESS_EVIDENCE_WINDOW_MINUTES",
  20,
);

type MetaQueueHealth = Awaited<ReturnType<typeof getMetaQueueHealth>>;
type MetaLaneEvidence = Record<
  "core" | "extended_recent" | "extended_historical" | "maintenance",
  ProviderProgressEvidence
>;
type MetaStatesByScope = Partial<
  Record<MetaWarehouseScope, ProviderProgressEvidenceStateRow[]>
>;

export interface MetaFairnessLeasePlan {
  coreFairnessLimit: number;
  extendedHistoricalFairnessLimit: number;
}

export interface MetaFollowupLeasePlan {
  extendedRecentLimit: number;
  historicalCoreLimit: number;
  extendedHistoricalLimit: number;
}

function hasMetaCoreBacklog(queueHealth?: MetaQueueHealth | null) {
  return (
    (queueHealth?.coreQueueDepth ?? 0) > 0 ||
    (queueHealth?.historicalCoreQueueDepth ?? 0) > 0 ||
    (queueHealth?.historicalCoreLeasedPartitions ?? 0) > 0
  );
}

function hasMetaExtendedBacklog(queueHealth?: MetaQueueHealth | null) {
  return (
    (queueHealth?.extendedQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedRecentQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedRecentLeasedPartitions ?? 0) > 0 ||
    (queueHealth?.extendedHistoricalQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedHistoricalLeasedPartitions ?? 0) > 0
  );
}

function getMetaPriorityCoreQueueDepth(queueHealth?: MetaQueueHealth | null) {
  return Math.max(
    0,
    (queueHealth?.coreQueueDepth ?? 0) - (queueHealth?.historicalCoreQueueDepth ?? 0),
  );
}

function hasMetaMaintenanceBacklog(queueHealth?: MetaQueueHealth | null) {
  return (
    (queueHealth?.maintenanceQueueDepth ?? 0) > 0 ||
    (queueHealth?.maintenanceLeasedPartitions ?? 0) > 0
  );
}

function hasMetaExtendedRecentBacklog(queueHealth?: MetaQueueHealth | null) {
  return (
    (queueHealth?.extendedRecentQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedRecentLeasedPartitions ?? 0) > 0
  );
}

function hasMetaPriorityCoreBacklog(queueHealth?: MetaQueueHealth | null) {
  return getMetaPriorityCoreQueueDepth(queueHealth) > 0;
}

function hasMetaHistoricalCoreBacklog(queueHealth?: MetaQueueHealth | null) {
  return (
    (queueHealth?.historicalCoreQueueDepth ?? 0) > 0 ||
    (queueHealth?.historicalCoreLeasedPartitions ?? 0) > 0
  );
}

function hasMetaExtendedHistoricalBacklog(queueHealth?: MetaQueueHealth | null) {
  return (
    (queueHealth?.extendedHistoricalQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedHistoricalLeasedPartitions ?? 0) > 0
  );
}

function getMetaPriorityBacklogDepth(queueHealth?: MetaQueueHealth | null) {
  return (
    (queueHealth?.queueDepth ?? 0) +
    (queueHealth?.maintenanceQueueDepth ?? 0) +
    (queueHealth?.extendedRecentQueueDepth ?? 0)
  );
}

function hasRecentMetaForwardProgress(input: {
  laneProgressEvidence?: Partial<MetaLaneEvidence> | null;
  queueHealth?: MetaQueueHealth | null;
  nowMs?: number;
}) {
  return (
    hasRecentProviderAdvancement({
      progressEvidence: input.laneProgressEvidence?.maintenance ?? null,
      fallbackLatestPartitionActivityAt:
        input.queueHealth?.latestMaintenanceActivityAt ?? null,
      nowMs: input.nowMs,
    }) ||
    hasRecentProviderAdvancement({
      progressEvidence: input.laneProgressEvidence?.core ?? null,
      fallbackLatestPartitionActivityAt: input.queueHealth?.latestCoreActivityAt ?? null,
      nowMs: input.nowMs,
    }) ||
    hasRecentProviderAdvancement({
      progressEvidence: input.laneProgressEvidence?.extended_recent ?? null,
      fallbackLatestPartitionActivityAt:
        input.queueHealth?.latestExtendedActivityAt ?? null,
      nowMs: input.nowMs,
    })
  );
}

export function resolveMetaWorkerRequestedLimit(input: {
  leaseLimit: number;
  queueHealth?: MetaQueueHealth | null;
  laneProgressEvidence?: Partial<MetaLaneEvidence> | null;
  nowMs?: number;
}) {
  const baseLimit = Math.max(1, input.leaseLimit);
  const queueHealth = input.queueHealth ?? null;
  if (!queueHealth || (queueHealth.queueDepth ?? 0) <= 0) return baseLimit;
  if (
    (queueHealth.deadLetterPartitions ?? 0) > 0 ||
    (queueHealth.retryableFailedPartitions ?? 0) > 0
  ) {
    return baseLimit;
  }

  const hasPriorityBacklog = getMetaPriorityBacklogDepth(queueHealth) > 0;
  const hasForwardProgress = hasRecentMetaForwardProgress({
    laneProgressEvidence: input.laneProgressEvidence,
    queueHealth,
    nowMs: input.nowMs,
  });

  if (hasPriorityBacklog && hasForwardProgress) {
    return Math.max(baseLimit, META_PRODUCTIVE_LEASE_LIMIT);
  }
  if (hasPriorityBacklog) {
    return Math.max(
      baseLimit,
      Math.min(META_PRODUCTIVE_LEASE_LIMIT, META_PRIORITY_BACKLOG_LEASE_LIMIT),
    );
  }
  if (hasForwardProgress) {
    return Math.max(
      baseLimit,
      Math.min(META_PRODUCTIVE_LEASE_LIMIT, META_FORWARD_PROGRESS_LEASE_LIMIT),
    );
  }
  return baseLimit;
}

export function resolveMetaBackgroundLoopDelayMs(input: {
  hasPendingWork: boolean;
  hasForwardProgress: boolean;
  hadError?: boolean;
  errorStreak?: number;
}) {
  if (input.hadError) {
    const exponent = Math.max(0, (input.errorStreak ?? 1) - 1);
    return Math.min(
      META_BACKGROUND_ERROR_MAX_DELAY_MS,
      META_BACKGROUND_ERROR_BASE_DELAY_MS * 2 ** exponent,
    );
  }
  if (input.hasPendingWork && input.hasForwardProgress) {
    return META_BACKGROUND_BUSY_DELAY_MS;
  }
  if (input.hasPendingWork) {
    return META_BACKGROUND_WAITING_DELAY_MS;
  }
  return META_BACKGROUND_IDLE_DELAY_MS;
}

export async function buildMetaWorkerLeasePlan(input: {
  businessId: string;
  leaseLimit: number;
}): Promise<ProviderLeasePlan> {
  const queueHealth = await getMetaQueueHealth({
    businessId: input.businessId,
  }).catch(() => null);
  const laneProgressEvidence = buildMetaLaneProgressEvidence({
    queueHealth,
  });
  const latestPartitionActivityAt =
    queueHealth?.latestCoreActivityAt ??
    queueHealth?.latestExtendedActivityAt ??
    queueHealth?.latestMaintenanceActivityAt ??
    null;
  const hasMaintenance = hasMetaMaintenanceBacklog(queueHealth);
  const hasCore = hasMetaCoreBacklog(queueHealth);
  const hasExtended = hasMetaExtendedBacklog(queueHealth);
  const steps: ProviderLeasePlan["steps"] = [];
  if (hasCore) {
    steps.push({
      key: "core",
      lane: "core",
      limit: META_CORE_WORKER_LIMIT,
    });
  }
  if (hasExtended) {
    steps.push({
      key: "extended",
      lane: "extended",
      limit: META_EXTENDED_WORKER_LIMIT,
    });
  }
  if (hasMaintenance) {
    steps.push({
      key: "maintenance",
      lane: "maintenance",
      limit: META_MAINTENANCE_WORKER_LIMIT,
    });
  }
  return {
    kind: "meta_policy_lease_plan",
    requestedLimit: resolveMetaWorkerRequestedLimit({
      leaseLimit: input.leaseLimit,
      queueHealth,
      laneProgressEvidence,
    }),
    steps: steps.filter((step) => step.limit > 0),
    maintenancePlan: {
      autoHealEnabled: true,
      enqueueScheduledWork: false,
    },
    fairnessInputs: {
      maintenanceLimit: META_MAINTENANCE_WORKER_LIMIT,
      coreFairnessLimit: 0,
      extendedHistoricalFairnessLimit: 0,
      extendedRecentLimit: 0,
    },
    progressEvidence: laneProgressEvidence.core,
    latestPartitionActivityAt,
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    hasRepairableBacklog: (queueHealth?.retryableFailedPartitions ?? 0) > 0,
    staleRunPressure: 0,
    stallFingerprints: deriveProviderStallFingerprints({
      queueDepth: queueHealth?.queueDepth ?? 0,
      leasedPartitions: queueHealth?.leasedPartitions ?? 0,
      checkpointLagMinutes: null,
      latestPartitionActivityAt,
      blocked: (queueHealth?.deadLetterPartitions ?? 0) > 0,
      hasRepairableBacklog: (queueHealth?.retryableFailedPartitions ?? 0) > 0,
      progressEvidence: laneProgressEvidence.core,
      historicalBacklogDepth:
        (queueHealth?.historicalCoreQueueDepth ?? 0) +
        (queueHealth?.historicalCoreLeasedPartitions ?? 0) +
        (queueHealth?.extendedHistoricalQueueDepth ?? 0) +
        (queueHealth?.extendedHistoricalLeasedPartitions ?? 0),
      blockedReasonCodes:
        (queueHealth?.deadLetterPartitions ?? 0) > 0
          ? ["required_dead_letter_partitions"]
          : [],
    }),
  };
}

function isRecentMetaSource(source: string | null | undefined) {
  return META_RECENT_SOURCE_SET.has(String(source ?? ""));
}

function buildMetaSyntheticEvidenceState(
  activityAt: string | null | undefined,
) {
  if (!activityAt) return [];
  return [
    {
      latestBackgroundActivityAt: activityAt,
      updatedAt: activityAt,
    } satisfies ProviderProgressEvidenceStateRow,
  ];
}

export function buildMetaLaneProgressEvidence(input: {
  statesByScope?: MetaStatesByScope;
  queueHealth?: MetaQueueHealth | null;
}): MetaLaneEvidence {
  const statesByScope = input.statesByScope ?? {};
  const queueHealth = input.queueHealth ?? null;
  const coreStates = [
    ...(statesByScope.account_daily ?? []),
    ...(statesByScope.campaign_daily ?? []),
    ...buildMetaSyntheticEvidenceState(
      queueHealth?.latestCoreActivityAt ?? null,
    ),
  ];
  const extendedStates = [
    ...(statesByScope.creative_daily ?? []),
    ...(statesByScope.ad_daily ?? []),
    ...buildMetaSyntheticEvidenceState(
      queueHealth?.latestExtendedActivityAt ?? null,
    ),
  ];
  const maintenanceStates = buildMetaSyntheticEvidenceState(
    queueHealth?.latestMaintenanceActivityAt ?? null,
  );

  return {
    core: buildProviderProgressEvidence({
      states: coreStates,
      aggregation: "bottleneck",
      recentActivityWindowMinutes: META_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
    extended_recent: buildProviderProgressEvidence({
      states: extendedStates,
      aggregation: "latest",
      recentActivityWindowMinutes: META_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
    extended_historical: buildProviderProgressEvidence({
      states: extendedStates,
      aggregation: "bottleneck",
      recentActivityWindowMinutes: META_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
    maintenance: buildProviderProgressEvidence({
      states: maintenanceStates,
      aggregation: "latest",
      recentActivityWindowMinutes: META_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
  };
}

export function getMetaHistoricalCoreFairnessLimit(input: {
  queueHealth?: MetaQueueHealth | null;
  progressEvidence?: ProviderProgressEvidence | null;
  nowMs?: number;
}) {
  const queueHealth = input.queueHealth ?? null;
  if (hasMetaMaintenanceBacklog(queueHealth)) {
    return 0;
  }
  const backlogExists =
    (queueHealth?.historicalCoreQueueDepth ?? 0) > 0 ||
    (queueHealth?.historicalCoreLeasedPartitions ?? 0) > 0;
  if (!backlogExists) return 0;
  const baseLimit = Math.min(
    META_CORE_WORKER_LIMIT,
    META_CORE_FAIRNESS_WORKER_LIMIT,
  );
  if (baseLimit <= 0) return 0;
  const hasRecentAdvancement = hasRecentProviderAdvancement({
    progressEvidence: input.progressEvidence ?? null,
    fallbackLatestPartitionActivityAt:
      queueHealth?.latestCoreActivityAt ?? null,
    nowMs: input.nowMs,
  });
  return hasRecentAdvancement
    ? baseLimit
    : Math.min(META_CORE_WORKER_LIMIT, baseLimit + 1);
}

export function getMetaExtendedHistoricalFairnessLimit(input: {
  queueHealth?: MetaQueueHealth | null;
  progressEvidence?: ProviderProgressEvidence | null;
  nowMs?: number;
}) {
  const queueHealth = input.queueHealth ?? null;
  if (hasMetaMaintenanceBacklog(queueHealth)) {
    return 0;
  }
  const backlogExists =
    (queueHealth?.extendedHistoricalQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedHistoricalLeasedPartitions ?? 0) > 0;
  if (!backlogExists) return 0;
  const baseLimit = Math.min(
    META_EXTENDED_WORKER_LIMIT,
    META_EXTENDED_HISTORICAL_FAIRNESS_WORKER_LIMIT,
  );
  if (baseLimit <= 0) return 0;
  const hasRecentAdvancement = hasRecentProviderAdvancement({
    progressEvidence: input.progressEvidence ?? null,
    fallbackLatestPartitionActivityAt:
      queueHealth?.latestExtendedActivityAt ?? null,
    nowMs: input.nowMs,
  });
  return hasRecentAdvancement
    ? baseLimit
    : Math.min(META_EXTENDED_WORKER_LIMIT, baseLimit + 1);
}

export function buildMetaFairnessLeasePlan(input: {
  queueHealth?: MetaQueueHealth | null;
  laneProgressEvidence?: Partial<MetaLaneEvidence> | null;
  nowMs?: number;
}): MetaFairnessLeasePlan {
  return {
    coreFairnessLimit: getMetaHistoricalCoreFairnessLimit({
      queueHealth: input.queueHealth,
      progressEvidence: input.laneProgressEvidence?.core ?? null,
      nowMs: input.nowMs,
    }),
    extendedHistoricalFairnessLimit: getMetaExtendedHistoricalFairnessLimit({
      queueHealth: input.queueHealth,
      progressEvidence: input.laneProgressEvidence?.extended_historical ?? null,
      nowMs: input.nowMs,
    }),
  };
}

export function buildMetaFollowupLeasePlan(input: {
  queueHealth?: MetaQueueHealth | null;
  leasedCorePriorityCount?: number;
  leasedCoreFairnessCount: number;
  leasedExtendedHistoricalFairnessCount: number;
  leasedExtendedRecentCount?: number;
}): MetaFollowupLeasePlan {
  const queueHealth = input.queueHealth ?? null;
  const hasMaintenanceBacklog = hasMetaMaintenanceBacklog(queueHealth);
  const remainingExtendedCapacity = Math.max(
    0,
    META_EXTENDED_WORKER_LIMIT - input.leasedExtendedHistoricalFairnessCount,
  );
  const remainingExtendedHistoricalCapacity = Math.max(
    0,
    remainingExtendedCapacity - (input.leasedExtendedRecentCount ?? 0),
  );

  return {
    extendedRecentLimit: hasMaintenanceBacklog ? 0 : remainingExtendedCapacity,
    historicalCoreLimit: hasMaintenanceBacklog
      ? 0
      : Math.max(
          0,
          META_CORE_WORKER_LIMIT -
            (input.leasedCorePriorityCount ?? 0) -
            input.leasedCoreFairnessCount,
        ),
    extendedHistoricalLimit: hasMaintenanceBacklog
      ? 0
      : remainingExtendedHistoricalCapacity,
  };
}

function isHistoricalMetaSource(source: string | null | undefined) {
  return META_HISTORICAL_SOURCE_SET.has(String(source ?? ""));
}

function enumerateDays(
  startDate: string,
  endDate: string,
  recentFirst = false,
) {
  const rows: string[] = [];
  let cursor = new Date(`${startDate}T00:00:00Z`);
  const end = new Date(`${endDate}T00:00:00Z`);
  while (cursor <= end) {
    rows.push(toIsoDate(cursor));
    cursor = addDays(cursor, 1);
  }
  return recentFirst ? rows.reverse() : rows;
}

function getMetaReferenceToday(
  credentials: Awaited<ReturnType<typeof resolveMetaCredentials>>,
  providerAccountId?: string | null,
) {
  const referenceAccountId = providerAccountId ?? credentials?.accountIds[0] ?? null;
  const referenceTimeZone =
    referenceAccountId &&
    credentials?.accountProfiles?.[referenceAccountId]?.timezone
      ? credentials.accountProfiles[referenceAccountId].timezone
      : null;
  return referenceTimeZone
    ? getTodayIsoForTimeZoneServer(referenceTimeZone)
    : toIsoDate(new Date());
}

function getMetaHistoricalWindow(
  credentials: Awaited<ReturnType<typeof resolveMetaCredentials>>,
) {
  const today = getMetaReferenceToday(credentials);
  const historicalEnd = addDays(new Date(`${today}T00:00:00Z`), -1);
  const historicalStart = addDays(
    historicalEnd,
    -(META_WAREHOUSE_HISTORY_DAYS - 1),
  );
  return {
    startDate: toIsoDate(historicalStart),
    endDate: toIsoDate(historicalEnd),
    today,
  };
}

function getMetaHistoricalDayAge(input: {
  day: string;
  referenceToday: string;
}) {
  const historicalEnd = addUtcDays(input.referenceToday, -1);
  if (input.day > historicalEnd) return 0;
  return Math.max(0, dayCountInclusive(input.day, historicalEnd) - 1);
}

function getMetaPlannerRequiredPublishedSurfacesForDay(input: {
  day: string;
  referenceToday: string;
}) {
  return getMetaAuthoritativeRequiredSurfacesForDayAge(
    getMetaHistoricalDayAge(input),
  )
    .filter((requirement) => requirement.state !== "not_applicable")
    .map((requirement) => requirement.surface)
    .filter((surface): surface is MetaWarehouseScope =>
      META_AUTHORITATIVE_PLANNER_PUBLISHED_SURFACES.includes(surface),
    );
}

function getMetaPlannerSurfaceRequirementsForDay(input: {
  day: string;
  referenceToday: string;
}) {
  return getMetaAuthoritativeRequiredSurfacesForDayAge(
    getMetaHistoricalDayAge(input),
  );
}

function shouldSyncMetaBreakdownsForDay(input: {
  day: string;
  referenceToday: string;
  truthState: "provisional" | "finalized";
}) {
  if (input.truthState !== "finalized") return false;
  return getMetaAuthoritativeRequiredSurfacesForDayAge(
    getMetaHistoricalDayAge({
      day: input.day,
      referenceToday: input.referenceToday,
    }),
  ).some(
    (requirement) =>
      requirement.surface === "breakdown_daily" &&
      requirement.state !== "not_applicable",
  );
}

function buildMetaAuthoritativeDayStateMap(
  rows: Awaited<ReturnType<typeof listMetaAuthoritativeDayStates>>,
) {
  const byDay = new Map<string, Map<MetaWarehouseScope, string>>();
  for (const row of rows) {
    const states = byDay.get(row.day) ?? new Map<MetaWarehouseScope, string>();
    states.set(row.surface, row.state);
    byDay.set(row.day, states);
  }
  return byDay;
}

async function seedMetaAuthoritativePlannerDayStates(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  referenceToday: string;
  accountTimezone: string;
  existingStates?: Map<MetaWarehouseScope, string> | null;
}) {
  const requirements = getMetaPlannerSurfaceRequirementsForDay({
    day: input.day,
    referenceToday: input.referenceToday,
  });
  if (requirements.length === 0) return [];
  const existingStates = input.existingStates ?? new Map<MetaWarehouseScope, string>();
  const missingRequirements = requirements.filter(
    (requirement) => !existingStates.has(requirement.surface),
  );
  if (missingRequirements.length === 0) return [];
  return Promise.all(
    missingRequirements.map((requirement) =>
      upsertMetaAuthoritativeDayState({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        day: input.day,
        surface: requirement.surface,
        state: requirement.state,
        accountTimezone: input.accountTimezone,
      }),
    ),
  );
}

function isMetaPlannerDayPublished(input: {
  day: string;
  referenceToday: string;
  statesBySurface?: Map<MetaWarehouseScope, string> | null;
}) {
  const requiredSurfaces = getMetaPlannerRequiredPublishedSurfacesForDay({
    day: input.day,
    referenceToday: input.referenceToday,
  });
  if (requiredSurfaces.length === 0) return true;
  return requiredSurfaces.every(
    (surface) => input.statesBySurface?.get(surface) === "published",
  );
}

async function getNextMetaHistoricalAuthoritativeDay(input: {
  businessId: string;
  providerAccountId: string;
  startDate: string;
  referenceToday: string;
  accountTimezone: string;
}) {
  const endDate = addUtcDays(input.referenceToday, -2);
  if (endDate < input.startDate) return null;
  const finalizeDay = addUtcDays(input.referenceToday, -1);
  const dayStateRows = await listMetaAuthoritativeDayStates({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    startDay: input.startDate,
    endDay: finalizeDay,
  }).catch(() => []);
  const statesByDay = buildMetaAuthoritativeDayStateMap(dayStateRows);
  const finalizeDayStates = statesByDay.get(finalizeDay) ?? null;
  await seedMetaAuthoritativePlannerDayStates({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    day: finalizeDay,
    referenceToday: input.referenceToday,
    accountTimezone: input.accountTimezone,
    existingStates: finalizeDayStates,
  });
  if (
    !isMetaPlannerDayPublished({
      day: finalizeDay,
      referenceToday: input.referenceToday,
      statesBySurface: finalizeDayStates,
    })
  ) {
    return null;
  }
  for (const day of enumerateDays(input.startDate, endDate, false)) {
    const existingStates = statesByDay.get(day) ?? null;
    await seedMetaAuthoritativePlannerDayStates({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      day,
      referenceToday: input.referenceToday,
      accountTimezone: input.accountTimezone,
      existingStates,
    });
    if (
      isMetaPlannerDayPublished({
        day,
        referenceToday: input.referenceToday,
        statesBySurface: statesByDay.get(day) ?? existingStates,
      })
    ) {
      continue;
    }
    return day;
  }
  return null;
}

type MetaRecentTargetWindow = {
  providerAccountId: string;
  today: string;
  d1: string;
  d2: string;
  d3: string;
  d7Start: string;
};

type MetaRecentAutoHealSummary = {
  accountsScanned: number;
  recentDaysScanned: number;
  dirtyDaysFound: number;
  oldestDirtyDate: string | null;
  finalizeEnqueued: number;
  repairEnqueued: number;
  skippedActiveDuplicate: number;
  skippedCooldown: number;
  skippedRecentSuccess: number;
  skippedRepeatedFailures: number;
  reasonCounts: Record<string, number>;
};

function emptyMetaRecentAutoHealSummary(): MetaRecentAutoHealSummary {
  return {
    accountsScanned: 0,
    recentDaysScanned: 0,
    dirtyDaysFound: 0,
    oldestDirtyDate: null,
    finalizeEnqueued: 0,
    repairEnqueued: 0,
    skippedActiveDuplicate: 0,
    skippedCooldown: 0,
    skippedRecentSuccess: 0,
    skippedRepeatedFailures: 0,
    reasonCounts: {},
  };
}

function buildMetaRecentTargetWindows(credentials: MetaCredentials) {
  return credentials.accountIds.map((providerAccountId) => {
    const timezone =
      credentials.accountProfiles?.[providerAccountId]?.timezone ?? "UTC";
    const today = getTodayIsoForTimeZoneServer(timezone);
    return {
      providerAccountId,
      today,
      d1: toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -1)),
      d2: toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -2)),
      d3: toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -3)),
      d7Start: toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -7)),
    } satisfies MetaRecentTargetWindow;
  });
}

function metaRecentDirtySeverityPriority(
  severity: MetaDirtyRecentSeverity,
) {
  switch (severity) {
    case "critical":
      return 3;
    case "high":
      return 2;
    case "low":
    default:
      return 1;
  }
}

function metaRecentSourcePriority(source: MetaSyncPartitionSource) {
  switch (source) {
    case "finalize_day":
      return 3;
    case "repair_recent_day":
      return 2;
    case "today_observe":
      return 1;
    default:
      return 0;
  }
}

function mergeMetaDirtyRecentRows(
  rows: MetaDirtyRecentDateRow[],
): MetaDirtyRecentDateRow[] {
  const merged = new Map<string, MetaDirtyRecentDateRow>();
  for (const row of rows) {
    const key = `${row.providerAccountId}:${row.date}`;
    const existing = merged.get(key);
    if (!existing) {
      const reasons = Array.from(new Set(row.reasons));
      merged.set(key, {
        ...row,
        reasons,
        breakdownOnly:
          reasons.length > 0 &&
          reasons.every((reason) => reason === "missing_breakdown"),
      });
      continue;
    }
    const mergedReasons = Array.from(new Set([...existing.reasons, ...row.reasons]));
    merged.set(key, {
      providerAccountId: row.providerAccountId,
      date: row.date,
      severity:
        metaRecentDirtySeverityPriority(row.severity) >
        metaRecentDirtySeverityPriority(existing.severity)
          ? row.severity
          : existing.severity,
      reasons: mergedReasons,
      breakdownOnly:
        mergedReasons.length > 0 &&
        mergedReasons.every((reason) => reason === "missing_breakdown"),
      nonFinalized: Boolean(existing.nonFinalized || row.nonFinalized),
      validationFailed: Boolean(
        existing.validationFailed || row.validationFailed,
      ),
      coverageMissing: Boolean(existing.coverageMissing || row.coverageMissing),
      spendDrift: Boolean(existing.spendDrift || row.spendDrift),
    });
  }
  return Array.from(merged.values()).sort((left, right) =>
    `${right.date}:${left.providerAccountId}`.localeCompare(
      `${left.date}:${right.providerAccountId}`,
    ),
  );
}

function classifyMetaRecentAction(input: {
  target: MetaRecentTargetWindow;
  dirty: MetaDirtyRecentDateRow;
}): MetaSyncPartitionSource | null {
  if (input.dirty.date === input.target.d1) return "finalize_day";
  const breakdownOnly =
    input.dirty.reasons.length > 0 &&
    input.dirty.reasons.every((reason) => reason === "missing_breakdown");
  if (input.dirty.date === input.target.d2) {
    if (breakdownOnly) return null;
    return input.dirty.severity === "critical"
      ? "finalize_day"
      : "repair_recent_day";
  }
  if (input.dirty.date === input.target.d3) {
    return breakdownOnly ? "repair_recent_day" : "repair_recent_day";
  }
  if (breakdownOnly) {
    return "repair_recent_day";
  }
  return "repair_recent_day";
}

function getMetaWorkerId() {
  const overridden = process.env.META_WORKER_ID?.trim();
  if (overridden) return overridden;
  const sharedWorkerId = process.env.WORKER_INSTANCE_ID?.trim();
  if (sharedWorkerId) return sharedWorkerId;
  return `meta-worker:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}

function classifyMetaError(error: unknown) {
  if (error instanceof MetaAuthoritativeExecutorError) {
    switch (error.classification) {
      case "blocked":
        return {
          errorClass: "authoritative_blocked",
          terminal: true,
          retryDelayMinutes: 0,
        };
      case "repair_required":
        return {
          errorClass: "authoritative_repair_required",
          terminal: false,
          retryDelayMinutes: 3,
        };
      case "failed":
      default:
        return {
          errorClass: "authoritative_failed",
          terminal: false,
          retryDelayMinutes: 5,
        };
    }
  }
  return classifyMetaSyncFailure({ error });
}

function computeRetryDelayMinutes(
  partition: { attemptCount: number },
  baseMinutes: number,
) {
  return Math.min(
    60,
    baseMinutes * Math.max(1, 2 ** Math.max(0, partition.attemptCount - 1)),
  );
}

export interface MetaSyncResult {
  businessId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
  hasPendingWork?: boolean;
  hasForwardProgress?: boolean;
  nextDelayMs?: number;
  outcome?: "consume_failed_before_leasing" | "consume_failed_after_leasing";
  failureReason?: string | null;
}

async function getMetaWarehouseWindowCompletion(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  if (isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId)) {
    const assignments = await getProviderAccountAssignments(
      input.businessId,
      "meta",
    ).catch(() => null);
    const providerAccountIds = assignments?.account_ids ?? [];
    if (providerAccountIds.length > 0) {
      const verification = await getMetaPublishedVerificationSummary({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
        providerAccountIds,
        surfaces: META_AUTHORITATIVE_PLANNER_PUBLISHED_SURFACES,
      }).catch(() => null);
      if (verification) {
        return {
          totalDays: verification.totalDays,
          completedDays: verification.completedCoreDays,
          complete: verification.truthReady,
        };
      }
    }
  }
  const totalDays = dayCountInclusive(input.startDate, input.endDate);
  const [accountCoverage, campaignCoverage] = await Promise.all([
    getMetaAccountDailyCoverage({
      businessId: input.businessId,
      providerAccountId: null,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => null),
    getMetaCampaignDailyCoverage({
      businessId: input.businessId,
      providerAccountId: null,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => null),
  ]);
  const completedDays = Math.min(
    accountCoverage?.completed_days ?? 0,
    campaignCoverage?.completed_days ?? 0,
  );
  return {
    totalDays,
    completedDays,
    complete: completedDays >= totalDays,
  };
}

export async function getMetaSelectedRangeTruthReadiness(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}): Promise<MetaSelectedRangeTruthReadiness> {
  const totalDays = dayCountInclusive(input.startDate, input.endDate);
  const pendingState: MetaSelectedRangeTruthReadiness = {
    truthReady: false,
    state: "processing",
    verificationState: "processing",
    totalDays,
    completedCoreDays: 0,
    blockingReasons: [],
    reasonCounts: {},
    detectorReasonCodes: [],
    sourceFetchedAt: null,
    publishedAt: null,
    asOf: null,
  };
  if (!isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId)) {
    return pendingState;
  }
  const assignments = await getProviderAccountAssignments(
    input.businessId,
    "meta",
  ).catch(() => null);
  const providerAccountIds = assignments?.account_ids ?? [];
  if (providerAccountIds.length === 0) {
    return pendingState;
  }
  const loadReadiness = async (): Promise<MetaSelectedRangeTruthReadiness> => {
    const verification = await getMetaPublishedVerificationSummary({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      providerAccountIds,
      surfaces: META_AUTHORITATIVE_PLANNER_PUBLISHED_SURFACES,
      timeoutMs: input.timeoutMs,
    }).catch(() => null);
    if (!verification) {
      return pendingState;
    }
    const detectorReasonCodes = Object.entries(verification.reasonCounts)
      .filter(
        ([code, count]) =>
          count > 0 &&
          ![
            "blocked",
            "failed",
            "processing",
            "queued",
            "repair_required",
            "running",
          ].includes(code),
      )
      .map(([code]) => code);
    return {
      truthReady: verification.truthReady,
      state: verification.verificationState,
      totalDays: verification.totalDays,
      completedCoreDays: verification.completedCoreDays,
      blockingReasons:
        verification.verificationState === "failed"
          ? ["validation_failed"]
          : verification.verificationState === "repair_required"
            ? ["non_finalized"]
            : [],
      reasonCounts: verification.reasonCounts,
      detectorReasonCodes,
      sourceFetchedAt: verification.sourceFetchedAt,
      publishedAt: verification.publishedAt,
      verificationState: verification.verificationState,
      asOf: verification.asOf,
    };
  };

  if (shouldBypassMetaSelectedRangeTruthCache()) {
    return loadReadiness();
  }

  return readThroughCache({
    key: buildMetaSelectedRangeTruthCacheKey({
      businessId: input.businessId,
      startDate: input.startDate,
      endDate: input.endDate,
      providerAccountIds,
    }),
    ttlMs: META_SELECTED_RANGE_TRUTH_CACHE_TTL_MS,
    loader: loadReadiness,
  });
}

async function getMetaDailyCoverageState(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  referenceToday?: string | null;
}) {
  /*
    ── ROUND 20, ITEM 1: THE CURRENT DAY IS NEVER "PUBLISHED" ────────────────

    Under authoritative-finalization V2 this asked
    `getMetaPublishedVerificationSummary(...).truthReady` for EVERY day. That is
    the right question for a finalized day and an impossible one for the current
    day: the current day is PROVISIONAL by construction, the core sync never
    publishes authoritative slices for it, so `truthReady` is false no matter how
    complete the account's own daily rows are.

    Two consequences, both silent. Current-day coverage never reads complete, so
    the coverage short-circuit never engages — and the recent-edit authority
    bootstrap, which only fires when coverage WOULD otherwise skip the core
    sync, could never engage either. Every current-day partition took the
    ordinary incomplete-coverage path and the bootstrap was unreachable in
    production.

    The current day therefore uses the raw account+campaign+adset daily
    coverage below, which measures what has actually been ingested. V2's
    published-truth question is reserved for the historical/finalized days it
    was written for.
  */
  const referenceToday =
    input.referenceToday ?? new Date().toISOString().slice(0, 10);
  const isCurrentDay = normalizeMetaPartitionDate(input.day) === referenceToday;
  if (
    !isCurrentDay &&
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId)
  ) {
    const requiredSurfaces = getMetaPlannerRequiredPublishedSurfacesForDay({
      day: input.day,
      referenceToday,
    });
    const verification = await getMetaPublishedVerificationSummary({
      businessId: input.businessId,
      startDate: input.day,
      endDate: input.day,
      providerAccountIds: [input.providerAccountId],
      surfaces: requiredSurfaces,
    }).catch(() => null);
    const creativeCoverage = await getMetaCreativeDailyCoverage({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      startDate: input.day,
      endDate: input.day,
    }).catch(() => null);
    return {
      productCoreComplete: verification?.truthReady ?? false,
      creativesComplete: (creativeCoverage?.completed_days ?? 0) >= 1,
    };
  }

  const [accountCoverage, campaignCoverage, adsetCoverage, creativeCoverage] =
    await Promise.all([
      getMetaAccountDailyCoverage({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        startDate: input.day,
        endDate: input.day,
      }).catch(() => null),
      getMetaCampaignDailyCoverage({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        startDate: input.day,
        endDate: input.day,
      }).catch(() => null),
      getMetaAdSetDailyCoverage({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        startDate: input.day,
        endDate: input.day,
      }).catch(() => null),
      getMetaCreativeDailyCoverage({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        startDate: input.day,
        endDate: input.day,
      }).catch(() => null),
    ]);

  const productCoreComplete =
    (accountCoverage?.completed_days ?? 0) >= 1 &&
    (campaignCoverage?.completed_days ?? 0) >= 1 &&
    (adsetCoverage?.completed_days ?? 0) >= 1;
  const creativesComplete = (creativeCoverage?.completed_days ?? 0) >= 1;

  return {
    productCoreComplete,
    creativesComplete,
  };
}

export function buildMetaDailyCoverageLookup(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
}) {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    day: normalizeMetaPartitionDate(input.day),
  };
}

export function isMetaAuthoritativeHistoricalSource(source: string) {
  return new Set([
    "yesterday",
    "finalize_day",
    "repair_recent_day",
    "priority_window",
    "manual_refresh",
    "recent",
    "recent_recovery",
    "historical",
    "historical_recovery",
    "initial_connect",
    "request_runtime",
  ]).has(source);
}

/**
 * ── ROUND 17, ITEMS 1 AND 2: THE BOOTSTRAP DECISION ─────────────────────────
 *
 * Exported so the production sync path and its lifecycle test drive the SAME
 * function. The decision has a WRITE side effect — it records the attempt in
 * the durable ledger before returning true — so it cannot live inside a pure
 * predicate, and it cannot honestly be proven by two disconnected halves.
 *
 * ITEM 1 — THE SAME TIMEZONE AUTHORITY THE ACTION PATH USES. This used to read
 * `credentials.accountProfiles[...].timezone`, a value carried in the caller's
 * credential payload. The recent-edit authority resolves the zone from the
 * exact `business_provider_accounts` -> `provider_accounts` binding via
 * `readMetaAccountTimeZones`. Two sources means two provider-local days: the
 * bootstrap could decide an account was recoverable on one calendar while the
 * authority judged its evidence on another. The binding is now the only source.
 *
 * AND A MISSING OR UNTRUSTED ZONE NO LONGER BYPASSES. Round 16 treated an
 * unresolvable zone as "unknown, so allow the repair". A config refetch cannot
 * heal a timezone — the authority holds on `provider_timezone_untrusted`
 * however many times the provider is called — so that bypass was a
 * guaranteed-useless provider request. No trusted zone, no bypass.
 *
 * ITEM 2 — THE ATTEMPT IS RECORDED BEFORE THE CALL. Every path returning true
 * has already written a ledger row, so a zero-receipt failure and a
 * campaign-only commit each count exactly once. Any provenance or ledger
 * failure returns false: an uncounted attempt is how a bounded retry becomes a
 * provider-call loop.
 */
/**
 * ── ROUND 18, ITEM A3: THE PARTITION'S ONE BOUND DATE ───────────────────────
 *
 * Resolved from the DB binding the recent-edit authority uses, once, at
 * partition start. `trusted` is false when no binding or no usable zone exists;
 * the credential zone is then used only to keep `truthState` behaving as it
 * always has, and the bootstrap refuses outright rather than reasoning about a
 * day it cannot establish.
 */
export interface MetaPartitionDateAuthority {
  trusted: boolean;
  timeZone: string | null;
  providerLocalToday: string;
}

export async function resolveMetaPartitionDateAuthority(input: {
  businessId: string;
  providerAccountId: string;
  credentials: MetaCredentials;
  now?: Date;
}): Promise<MetaPartitionDateAuthority> {
  const now = input.now ?? new Date();
  const credentialToday = getMetaReferenceToday(
    input.credentials,
    input.providerAccountId,
  );
  try {
    const zones = await readMetaAccountTimeZones({
      businessId: input.businessId,
      providerAccountIds: [input.providerAccountId],
      query: (text, params) => getDb().query(text, params),
    });
    const timeZone = zones.get(input.providerAccountId) ?? null;
    if (!timeZone) {
      return { trusted: false, timeZone: null, providerLocalToday: credentialToday };
    }
    const providerLocalToday = providerLocalCalendarDate({ instant: now, timeZone });
    if (!providerLocalToday) {
      return { trusted: false, timeZone: null, providerLocalToday: credentialToday };
    }
    return { trusted: true, timeZone, providerLocalToday };
  } catch {
    return { trusted: false, timeZone: null, providerLocalToday: credentialToday };
  }
}

/**
 * ── ROUND 18, ITEMS A1-A3: THE BOOTSTRAP DECISION ───────────────────────────
 *
 * Exported so the production sync path and its lifecycle seam drive the SAME
 * function. Returning true means an attempt has ALREADY been claimed
 * atomically, so the caller must proceed to the provider call it paid for.
 *
 * A1 — the claim is one statement: the bound is enforced in SQL and the slot is
 * taken by the unique constraint, so two workers racing the same budget cannot
 * both proceed. Round 17's read-then-insert had two gaps between them.
 *
 * A3 — the day comes from the SHARED partition authority, not from a second
 * resolution. `input.day` must be that same provider-local day: a partition
 * whose target day is not today cannot be bootstrapped, and a mismatch is a
 * disagreement about the calendar rather than a reason to guess.
 */
export async function resolveMetaAuthorityBootstrapDecision(input: {
  businessId: string;
  providerAccountId: string;
  day: string;
  truthState: "provisional" | "finalized";
  coverageComplete: boolean;
  partitionAuthority: MetaPartitionDateAuthority;
  now?: Date;
}): Promise<boolean> {
  if (input.truthState !== "provisional" || !input.coverageComplete) return false;
  // A config refetch cannot heal a timezone: without a trusted binding the
  // authority holds however many times the provider is called.
  if (!input.partitionAuthority.trusted || !input.partitionAuthority.timeZone) {
    return false;
  }
  // FAIL CLOSED ON A CALENDAR DISAGREEMENT.
  if (input.day !== input.partitionAuthority.providerLocalToday) return false;
  try {
    const dayEnd = providerLocalDayEndExclusive({
      day: input.partitionAuthority.providerLocalToday,
      timeZone: input.partitionAuthority.timeZone,
    });
    if (!dayEnd) return false;
    const now = input.now ?? new Date();
    const probe = await readMetaAuthorityBootstrapProbe({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      knowledgeEndExclusive: new Date(Math.min(now.getTime(), dayEnd.getTime())),
    });
    if (probe.campaignReceiptLinked && probe.adsetReceiptLinked) return false;
    const claim = await claimMetaAuthorityBootstrapAttempt({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      providerLocalDay: input.partitionAuthority.providerLocalToday,
      maxAttempts: META_AUTHORITY_BOOTSTRAP_MAX_ATTEMPTS,
    });
    return claim.claimed;
  } catch {
    return false;
  }
}

export function shouldBypassMetaCoverageShortCircuit(input: {
  source: string;
  truthState: "provisional" | "finalized";
  businessId: string;
  /**
   * ── ROUND 17 ─────────────────────────────────────────────────────────────
   * Whether the caller has already DECIDED to bootstrap — and, in deciding,
   * recorded the attempt in the durable ledger before any provider call. The
   * decision cannot live here because it has a write side effect that must
   * happen exactly once per attempt.
   */
  authorityBootstrapForced?: boolean;
}) {
  if (
    input.truthState === "finalized" &&
    isMetaAuthoritativeHistoricalSource(input.source) &&
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId)
  ) {
    return true;
  }
  /*
    The bounded, SELF-TERMINATING half. Complete daily coverage skips the whole
    account-core sync, which is the only path that writes current-config
    receipts — so an account that is already up to date would never write the
    linked receipt its authority now requires, and would hold every
    purchase-budget hard action forever on a refusal that is individually
    correct. One scoped refetch is allowed until such receipts exist; from then
    on this answers false and ordinary short-circuiting resumes.
  */
  return input.authorityBootstrapForced === true;
}

export function shouldBypassMetaCreativeCoverageShortCircuit(input: {
  truthState: "provisional" | "finalized";
}) {
  return input.truthState === "provisional";
}

export function resolveMetaTruthState(input: {
  day: string;
  referenceToday: string;
}) {
  return input.day === input.referenceToday ? "provisional" : "finalized";
}

type MetaPartitionDayResult = {
  truthState: "provisional" | "finalized";
  referenceToday: string;
  beforeCoverage: Awaited<ReturnType<typeof getMetaDailyCoverageState>>;
  afterCoverage: Awaited<ReturnType<typeof getMetaDailyCoverageState>>;
  authoritative:
    | {
        verification: MetaAuthoritativeDayVerification;
        plannerStates: MetaAuthoritativeDayStateRecord[];
        requiredSurfaces: MetaWarehouseScope[];
      }
    | null;
};

type MetaPartitionProcessResult = {
  outcome: "succeeded" | "failed" | "requeued";
  failureClass?: string | null;
  stopBatch?: boolean;
  /** Backoff the batch runner applies when this unit stopped the batch. */
  retryDelayMinutes?: number;
};

/**
 * Per-work-unit authority revalidation, shared by the queue consumer and the
 * lifecycle entrypoint so the two can never disagree.
 *
 * Credentials are resolved once before a whole batch is leased, and the account
 * context is memoised on top of that, so without this a deselection or
 * disconnect made mid-batch stays invisible and the worker keeps fetching a
 * revoked account. The check is uncached and reads the same authority the batch
 * gate reads.
 *
 * Returns `null` when the unit may proceed, or the refusal result when it may
 * not. Refusal is "requeued", never "failed": the unit did not fail, it lost
 * authority — and `stopBatch` keeps the account's remaining leased partitions
 * away from the provider entirely.
 */
async function refuseRevokedMetaPartition(partition: {
  id?: string;
  businessId: string;
  providerAccountId: string;
  scope: MetaWarehouseScope;
  partitionDate: string;
}): Promise<MetaPartitionProcessResult | null> {
  const authority = await resolveMetaAccountAuthority(
    partition.businessId,
    partition.providerAccountId,
  );
  if (authority.state === "authorized") return null;

  // Uncertainty is NOT revocation. A database outage, a timeout, or a schema
  // caught mid-migration used to collapse to the same `false` as a real
  // revocation, and this path then cancelled every partition for the account
  // terminally. Requeue instead, and stop the batch so the worker does not
  // keep hammering an unreadable authority — but cancel nothing.
  if (authority.state === "unknown_error") {
    console.error("[meta-sync] partition_authority_unknown", {
      businessId: partition.businessId,
      providerAccountId: partition.providerAccountId,
      partitionId: partition.id ?? null,
      scope: partition.scope,
      partitionDate: partition.partitionDate,
      errorMessage: authority.errorMessage,
    });
    return {
      outcome: "requeued",
      stopBatch: true,
      failureClass: "meta_account_authority_unknown",
    } satisfies MetaPartitionProcessResult;
  }

  const cancelled = await cancelMetaPartitionsForRevokedAccount({
    businessId: partition.businessId,
    providerAccountId: partition.providerAccountId,
  }).catch(() => [] as string[]);
  console.warn("[meta-sync] partition_account_selection_revoked", {
    businessId: partition.businessId,
    providerAccountId: partition.providerAccountId,
    partitionId: partition.id ?? null,
    scope: partition.scope,
    partitionDate: partition.partitionDate,
    cancelledPartitions: cancelled.length,
  });
  return {
    outcome: "requeued",
    stopBatch: true,
    failureClass: "meta_account_selection_revoked",
  } satisfies MetaPartitionProcessResult;
}

class MetaAuthoritativeExecutorError extends Error {
  constructor(
    readonly classification: "failed" | "repair_required" | "blocked",
    message: string,
  ) {
    super(message);
    this.name = "MetaAuthoritativeExecutorError";
  }
}

function buildMetaPlannerStateBySurface(
  plannerStates: MetaAuthoritativeDayStateRecord[],
) {
  return new Map(
    plannerStates.map((plannerState) => [plannerState.surface, plannerState]),
  );
}

function describeMetaPlannerSurfaceStates(input: {
  plannerStates: MetaAuthoritativeDayStateRecord[];
  requiredSurfaces: MetaWarehouseScope[];
}) {
  const plannerStateBySurface = buildMetaPlannerStateBySurface(
    input.plannerStates,
  );
  return input.requiredSurfaces
    .map(
      (surface) =>
        `${surface}=${plannerStateBySurface.get(surface)?.state ?? "pending"}`,
    )
    .join(", ");
}

function getMetaAuthoritativePartitionOutcome(input: {
  plannerStates: MetaAuthoritativeDayStateRecord[];
  requiredSurfaces: MetaWarehouseScope[];
  verification: MetaAuthoritativeDayVerification;
}) {
  const plannerStateBySurface = buildMetaPlannerStateBySurface(
    input.plannerStates,
  );
  const requiredPlannerStates = input.requiredSurfaces.map((surface) => ({
    surface,
    state: plannerStateBySurface.get(surface)?.state ?? "pending",
  }));
  if (
    requiredPlannerStates.length === 0 ||
    requiredPlannerStates.every(
      (plannerState) => plannerState.state === "published",
    )
  ) {
    return {
      outcome: "published" as const,
      message: null,
    };
  }

  const verificationSummary = [
    `verification=${input.verification.verificationState}`,
    `manifest=${input.verification.sourceManifestState}`,
    `planner=${describeMetaPlannerSurfaceStates({
      plannerStates: input.plannerStates,
      requiredSurfaces: input.requiredSurfaces,
    })}`,
  ].join(", ");

  if (
    requiredPlannerStates.some((plannerState) => plannerState.state === "blocked")
  ) {
    return {
      outcome: "blocked" as const,
      message: `authoritative_publication_missing:${verificationSummary}`,
    };
  }
  if (
    requiredPlannerStates.some(
      (plannerState) => plannerState.state === "repair_required",
    )
  ) {
    return {
      outcome: "repair_required" as const,
      message: `authoritative_repair_required:${verificationSummary}`,
    };
  }
  if (
    requiredPlannerStates.some((plannerState) => plannerState.state === "failed")
  ) {
    return {
      outcome: "failed" as const,
      message: `authoritative_finalize_failed:${verificationSummary}`,
    };
  }
  return {
    outcome: "requeued" as const,
    message: `authoritative_publication_pending:${verificationSummary}`,
  };
}

async function recordMetaAuthoritativePublicationShortfall(input: {
  authoritative: NonNullable<MetaPartitionDayResult["authoritative"]>;
  message: string;
  reason:
    | "publication_pointer_missing_after_finalize"
    | "authoritative_publication_repair_required";
}) {
  const plannerStateBySurface = buildMetaPlannerStateBySurface(
    input.authoritative.plannerStates,
  );
  const verificationSurfaceById = new Map(
    input.authoritative.verification.surfaces.map((surfaceState) => [
      surfaceState.surface,
      surfaceState,
    ]),
  );

  await Promise.all(
    input.authoritative.requiredSurfaces
      .filter(
        (surface) => plannerStateBySurface.get(surface)?.state !== "published",
      )
      .map((surface) => {
        const surfaceVerification = verificationSurfaceById.get(surface) ?? null;
        return createMetaAuthoritativeReconciliationEvent({
          businessId: input.authoritative.verification.businessId,
          providerAccountId:
            input.authoritative.verification.providerAccountId,
          day: input.authoritative.verification.day,
          surface,
          sliceVersionId: null,
          manifestId: surfaceVerification?.manifest?.id ?? null,
          eventKind: "publication_missing",
          severity: "error",
          sourceSpend: surfaceVerification?.manifest?.sourceSpend ?? null,
          warehouseAccountSpend: null,
          warehouseCampaignSpend: null,
          toleranceApplied: null,
          result: "repair_required",
          detailsJson: {
            reason: input.reason,
            plannerState:
              plannerStateBySurface.get(surface)?.state ?? "pending",
            verificationState:
              input.authoritative.verification.verificationState,
            sourceManifestState:
              input.authoritative.verification.sourceManifestState,
            message: input.message,
          },
        }).catch(() => null);
      }),
  );
}

function getMetaRequeuePriority(input: {
  lane: MetaSyncLane;
  source: string;
  priority?: number;
}) {
  if (typeof input.priority === "number" && Number.isFinite(input.priority)) {
    return input.priority;
  }
  switch (input.source) {
    case "priority_window":
      return 90;
    case "finalize_day":
      return 80;
    case "yesterday":
      return 70;
    case "repair_recent_day":
      return 65;
    case "today":
    case "today_observe":
      return 60;
    case "recent_recovery":
      return 25;
    case "recent":
      return 20;
    case "manual_refresh":
      return input.lane === "maintenance" ? 90 : 40;
    case "historical_recovery":
      return 25;
    case "historical":
    case "initial_connect":
      return 20;
    default:
      return input.lane === "maintenance" ? 60 : 20;
  }
}

/**
 * ── ROUND 19, ITEM A2 ───────────────────────────────────────────────────────
 * Exported narrowly so the bootstrap lifecycle seam drives the REAL
 * orchestration — coverage read, bootstrap decision, core refetch, receipt
 * writes — instead of hand-assembling those steps in a test and calling it a
 * lifecycle. Nothing in production imports the alias.
 */
export { syncMetaPartitionDay as __syncMetaPartitionDayForSeams };

async function syncMetaPartitionDay(input: {
  credentials: MetaCredentials;
  businessId: string;
  providerAccountId: string;
  day: string;
  lane: MetaSyncLane;
  partitionScope: MetaWarehouseScope;
  source: string;
  scopes: MetaWarehouseScope[];
  partitionId: string;
  /**
   * ROUND 14: the real `meta_sync_runs.id` for this attempt, created or
   * recovered by `processMetaPartition`. Null only when the run row could not
   * be established at all, which the authority reader denies on.
   */
  syncRunId?: string | null;
  /**
   * ROUND 19, ITEM A1: the DB-bound provider-local today for this account,
   * threaded to the core writer so every layer shares one calendar.
   */
  providerLocalToday?: string | null;
  /**
   * ── ROUND 21, ITEM 1: THE NARROW SEAM CLOCK ──────────────────────────────
   *
   * The instant at which this partition is evaluated. Production never passes
   * it and every reader below falls back to `new Date()`, exactly as before.
   *
   * It exists because the account calendar is the thing under test and the
   * real clock cannot exercise it. The orchestration seam distinguishes the DB
   * binding (America/Los_Angeles) from the credential profile
   * (Europe/Istanbul) -- but for most of any real day those two zones are on
   * the SAME calendar date, so the assertion that the run used the DB binding
   * passed whichever source it had actually read. Pinning one instant where
   * the two calendars provably differ is what turns that assertion into a
   * discriminator.
   *
   * Deliberately narrow: it reaches only the two functions that already accept
   * a `now`, so nothing else in the pipeline can be made to lie about time.
   */
  evaluationNow?: Date;
  workerId: string;
  leaseEpoch: number;
  attemptCount: number;
}): Promise<MetaPartitionDayResult> {
  const normalizedDay = normalizeMetaPartitionDate(input.day);
  const credentials = input.credentials;
  if (!credentials?.accountIds?.length) {
    throw new Error("Meta credentials are not available for this business.");
  }
  const assignedAccountIds = credentials.accountIds;
  /*
    ── ROUND 18, ITEM A3: ONE BOUND DATE, RESOLVED ONCE AT PARTITION START ───

    `getMetaReferenceToday` reads `credentials.accountProfiles[...].timezone` —
    the caller's payload — while the recent-edit authority resolves the exact
    `business_provider_accounts` -> `provider_accounts` binding. Two sources
    means `truthState`, the bootstrap's eligibility day, the provider call and
    the current-evidence/receipt writer could each be reasoning about a
    different provider-local day.

    Resolved ONCE here from the DB binding and shared by all four. The credential
    zone remains the fallback only where no binding exists at all, and in that
    case the bootstrap refuses outright rather than guessing (see below).
  */
  const partitionAuthority = await resolveMetaPartitionDateAuthority({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    credentials,
    now: input.evaluationNow,
  });
  const referenceToday = partitionAuthority.providerLocalToday;
  /*
    Only a TRUSTED binding is threaded onward. An untrusted resolution fell back
    to the credential zone for `truthState`, and passing that value down as
    though it were DB-bound would launder a guess into the receipt writer.
  */
  const boundProviderLocalToday = partitionAuthority.trusted
    ? partitionAuthority.providerLocalToday
    : null;
  const coverageState = await captureMetaPartitionStage({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    partitionId: input.partitionId,
    scope: input.partitionScope,
    lane: input.lane,
    source: input.source,
    day: normalizedDay,
    stage: "syncMetaPartitionDay.coverage_before",
    run: () =>
      getMetaDailyCoverageState({
        ...buildMetaDailyCoverageLookup({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          day: normalizedDay,
        }),
        referenceToday,
      }),
  });
  const beforeCoverage = coverageState;
  const sourceTodayWindow = normalizedDay === referenceToday;
  const truthState = resolveMetaTruthState({
    day: normalizedDay,
    referenceToday,
  });
  const shouldSyncBreakdowns = shouldSyncMetaBreakdownsForDay({
    day: normalizedDay,
    referenceToday,
    truthState,
  });
  const requiredPublishedSurfaces = getMetaPlannerRequiredPublishedSurfacesForDay({
    day: normalizedDay,
    referenceToday,
  });
  const requiresAuthoritativePublication =
    input.scopes.some((scope) => isMetaProductCoreCoverageScope(scope));
  const freshStart =
    truthState === "finalized" &&
    isMetaAuthoritativeHistoricalSource(input.source);
  /*
    ── ROUND 17, ITEMS 1 AND 2: THE BOOTSTRAP DECISION ──────────────────────

    Probed only on the CURRENT provider-local day and only when coverage would
    otherwise short-circuit, so a healthy account pays nothing.

    ITEM 1 — THE SAME TIMEZONE AUTHORITY THE ACTION PATH USES. This read
    `credentials.accountProfiles[...].timezone`, a value supplied by the
    caller's credential payload. The recent-edit authority resolves the zone
    from the exact `business_provider_accounts` -> `provider_accounts` binding
    via `readMetaAccountTimeZones`. Two sources means two cutoffs: the bootstrap
    could compute a different provider-local day from the authority it exists to
    heal, decide the account was recoverable on one calendar, and refetch
    against evidence judged on another. The DB binding is now the only source.

    AND A MISSING OR UNTRUSTED ZONE NO LONGER BYPASSES. Round 16 treated an
    unresolvable zone as "unknown, so allow the repair". That was wrong in a
    specific way: a config refetch cannot heal a timezone. The authority holds
    on `provider_timezone_untrusted` no matter how many times the provider is
    called, so calling it is a guaranteed-useless provider request. No zone,
    no bypass.

    ITEM 2 — AND THE ATTEMPT IS RECORDED BEFORE THE CALL. Every path that
    returns `true` here has already written a durable ledger row, so a
    zero-receipt failure and a campaign-only commit both count exactly once. A
    ledger that cannot be read or written yields no bypass at all.
  */
  /*
    ── ROUND 18, ITEM A2: THE CLAIM BELONGS TO THE CORE REFETCH ─────────────

    Round 17 decided (and spent a ledger attempt) before knowing whether this
    partition would call the core provider at all. An extended creative/ad-scope
    partition therefore burned the account's bootstrap budget without ever
    touching the endpoint whose receipts the budget exists to obtain — three
    such partitions could exhaust the day and leave the account unrepaired.

    Eligibility is now decided first, and the attempt is claimed immediately
    before the refetch that consumes it.
  */
  const productCoreEligible = input.scopes.some((scope) =>
    isMetaProductCoreCoverageScope(scope),
  );
  const coverageWouldSkip =
    productCoreEligible && coverageState.productCoreComplete;
  const authorityBootstrapForced = coverageWouldSkip
    ? await resolveMetaAuthorityBootstrapDecision({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        day: normalizedDay,
        truthState,
        coverageComplete: true,
        partitionAuthority,
        now: input.evaluationNow,
      })
    : false;
  const forceAuthoritativeRefetch = shouldBypassMetaCoverageShortCircuit({
    source: input.source,
    truthState,
    businessId: input.businessId,
    // The decision is taken above, where the attempt is claimed immediately
    // before the call it pays for. This flag only reports it.
    authorityBootstrapForced,
  });

  if (
    productCoreEligible &&
    (forceAuthoritativeRefetch || !coverageState.productCoreComplete)
  ) {
    const bulkResult = await captureMetaPartitionStage({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionId: input.partitionId,
      scope: "account_daily",
      lane: input.lane,
      source: input.source,
      day: normalizedDay,
      stage: "syncMetaPartitionDay.account_core_sync",
      run: () =>
        syncMetaAccountCoreWarehouseDay({
          credentials,
          accountId: input.providerAccountId,
          day: normalizedDay,
          partitionId: input.partitionId,
          workerId: input.workerId,
          leaseEpoch: input.leaseEpoch,
          attemptCount: input.attemptCount + 1,
          leaseMinutes: META_PARTITION_LEASE_MINUTES,
          freshStart,
          truthState,
          lane: input.lane,
          sourceRunId: input.partitionId,
          // ROUND 14: the ATTEMPT, distinct from the partition above.
          syncRunId: input.syncRunId ?? null,
          /*
            ROUND 19, ITEM A1: the ONE DB-bound date, so the current-evidence
            gate and the receipt writer share the calendar that decided
            truthState and bootstrap eligibility. Passed only when the binding
            actually resolved; otherwise the core day keeps its own fallback.
          */
          providerLocalToday: boundProviderLocalToday,
          source: input.source,
        }),
    });
    if (bulkResult.memoryInstrumentation?.oversizeWarning) {
      console.warn("[meta-sync] oversized_partition_detected", {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        day: normalizedDay,
        maxHeapUsedBytes: bulkResult.memoryInstrumentation.maxHeapUsedBytes,
        maxRowsBuffered: bulkResult.memoryInstrumentation.maxRowsBuffered,
        flushThresholdRows: bulkResult.memoryInstrumentation.flushThresholdRows,
      });
    }
    if (shouldSyncBreakdowns) {
      await captureMetaPartitionStage({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        partitionId: input.partitionId,
        scope: "breakdown_daily",
        lane: input.lane,
        source: input.source,
        day: normalizedDay,
        stage: "syncMetaPartitionDay.breakdown_sync",
        run: async () => {
          const breakdownStartedAt = new Date().toISOString();
          const breakdownJobs = [
            {
              breakdowns: "age,gender",
              endpointName: "breakdown_age",
            },
            {
              breakdowns: "country",
              endpointName: "breakdown_country",
            },
            {
              breakdowns: "publisher_platform,platform_position,impression_device",
              endpointName:
                "breakdown_publisher_platform,platform_position,impression_device",
            },
          ];
          const breakdownResults = await Promise.all(
            breakdownJobs.map(async (breakdownJob) => {
              try {
                await syncMetaAccountBreakdownWarehouseDay({
                  credentials,
                  accountId: input.providerAccountId,
                  day: normalizedDay,
                  partitionId: input.partitionId,
                  workerId: input.workerId,
                  leaseEpoch: input.leaseEpoch,
                  attemptCount: input.attemptCount + 1,
                  breakdowns: breakdownJob.breakdowns,
                  endpointName: breakdownJob.endpointName,
                  positiveSpendAdIds: bulkResult.positiveSpendAdIds,
                  source: input.source,
                  publishAuthoritativeSurface: false,
                  referenceToday,
                  leaseMinutes: META_PARTITION_LEASE_MINUTES,
                });
                return {
                  breakdownJob,
                  error: null as Error | null,
                };
              } catch (error) {
                await upsertMetaCheckpointOrThrow({
                  partitionId: input.partitionId,
                  businessId: input.businessId,
                  providerAccountId: input.providerAccountId,
                  checkpointScope: `breakdown:${breakdownJob.breakdowns}`,
                  phase: "fetch_raw",
                  status: "failed",
                  pageIndex: 0,
                  nextPageUrl: null,
                  providerCursor: null,
                  rowsFetched: 0,
                  rowsWritten: 0,
                  lastSuccessfulEntityKey: null,
                  lastResponseHeaders: {},
                  attemptCount: input.attemptCount + 1,
                  leaseEpoch: input.leaseEpoch,
                  leaseOwner: input.workerId,
                  startedAt: new Date().toISOString(),
                  finishedAt: new Date().toISOString(),
                }).catch(() => null);
                console.warn("[meta-sync] breakdown_sync_failed", {
                  businessId: input.businessId,
                  providerAccountId: input.providerAccountId,
                  partitionDate: normalizedDay,
                  breakdowns: breakdownJob.breakdowns,
                  message: durableMetaFailureMessage(error),
                });
                return {
                  breakdownJob,
                  error:
                    error instanceof Error ? error : new Error(String(error)),
                };
              }
            }),
          );
          const failedBreakdown = breakdownResults.find((result) => result.error);
          if (failedBreakdown?.error) {
            throw failedBreakdown.error;
          }
          await publishMetaBreakdownAuthoritativeSurface({
            credentials,
            accountId: input.providerAccountId,
            day: normalizedDay,
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            endpointName:
              "breakdown_publisher_platform,platform_position,impression_device",
            source: input.source,
            referenceToday,
            leaseMinutes: META_PARTITION_LEASE_MINUTES,
            startedAt: breakdownStartedAt,
          });
        },
      });
    }
    await heartbeatMetaPartitionDuringOrchestrationOrThrow({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
      leaseMinutes: META_PARTITION_LEASE_MINUTES,
    });
  }

  if (input.scopes.includes("creative_daily")) {
    const forceCreativeRefetch = shouldBypassMetaCreativeCoverageShortCircuit({
      truthState,
    });
    if (forceCreativeRefetch || !coverageState.creativesComplete) {
      await syncMetaCreativesWarehouseDay({
        businessId: input.businessId,
        day: normalizedDay,
        accessToken: credentials.accessToken,
        assignedAccountIds: [input.providerAccountId],
        sourceRunId: input.partitionId,
        mediaMode:
          input.day >= getCreativeMediaRetentionStart(referenceToday)
            ? "full"
            : "metadata",
      });
    }
  }

  const afterCoverage = await captureMetaPartitionStage({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    partitionId: input.partitionId,
    scope: input.partitionScope,
    lane: input.lane,
    source: input.source,
    day: normalizedDay,
    stage: "syncMetaPartitionDay.coverage_after",
    run: () =>
      getMetaDailyCoverageState({
        ...buildMetaDailyCoverageLookup({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          day: normalizedDay,
        }),
        referenceToday,
      }),
  });

  if (
    truthState === "finalized" &&
    requiresAuthoritativePublication &&
    isMetaAuthoritativeFinalizationV2EnabledForBusiness(input.businessId)
  ) {
    const { verification, plannerStates } = await captureMetaPartitionStage({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionId: input.partitionId,
      scope: "account_daily",
      lane: input.lane,
      source: input.source,
      day: normalizedDay,
      stage: "syncMetaPartitionDay.authoritative_verification",
      run: async () => {
        const verification = await getMetaAuthoritativeDayVerification({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          day: normalizedDay,
        });
        const plannerStates =
          await reconcileMetaAuthoritativeDayStateFromVerification({
            verification,
            accountTimezone:
              credentials.accountProfiles?.[input.providerAccountId]?.timezone ??
              "UTC",
            activePartitionIdBySurface: Object.fromEntries(
              requiredPublishedSurfaces.map((surface) => [surface, input.partitionId]),
            ),
          });
        return {
          verification,
          plannerStates,
        };
      },
    });
    logRuntimeInfo("meta-sync", "partition_authoritative_verification", {
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionDate: normalizedDay,
      source: input.source,
      verificationState: verification.verificationState,
      sourceManifestState: verification.sourceManifestState,
      requiredPublishedSurfaces,
      plannerStates: plannerStates.map((plannerState) => ({
        surface: plannerState.surface,
        state: plannerState.state,
      })),
    });
    logRuntimeInfo("meta-sync", "partition_day_result", {
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      partitionDate: normalizedDay,
      scopes: input.scopes,
      sourceTodayWindow,
      truthState,
      source: input.source,
      productCoreCompleteBefore: beforeCoverage.productCoreComplete,
      productCoreCompleteAfter: afterCoverage.productCoreComplete,
      creativesCompleteBefore: beforeCoverage.creativesComplete,
      creativesCompleteAfter: afterCoverage.creativesComplete,
    });
    return {
      truthState,
      referenceToday,
      beforeCoverage,
      afterCoverage,
      authoritative: {
        verification,
        plannerStates,
        requiredSurfaces: requiredPublishedSurfaces,
      },
    };
  }

  logRuntimeInfo("meta-sync", "partition_day_result", {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    partitionDate: normalizedDay,
    scopes: input.scopes,
    sourceTodayWindow: normalizedDay === referenceToday,
    truthState,
    source: input.source,
    productCoreCompleteBefore: beforeCoverage.productCoreComplete,
    productCoreCompleteAfter: afterCoverage.productCoreComplete,
    creativesCompleteBefore: beforeCoverage.creativesComplete,
    creativesCompleteAfter: afterCoverage.creativesComplete,
  });
  return {
    truthState,
    referenceToday,
    beforeCoverage,
    afterCoverage,
    authoritative: null,
  };
}

function logMetaRunObservability(input: {
  event:
    | "run_row_created"
    | "run_id_attached_to_execution_context"
    | "latest_running_run_lookup_result"
    | "completion_attempt_started";
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch: number;
  lane: MetaSyncLane;
  scope: MetaWarehouseScope;
  partitionStatus: string;
  runStatusBefore?: string | null;
  runStatusAfter?: string | null;
  pathKind: "primary" | "backfill" | "repair";
}) {
  logRuntimeInfo("meta-sync", input.event, {
    partitionId: input.partitionId,
    runId: input.runId ?? null,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    lane: input.lane,
    scope: input.scope,
    partitionStatus: input.partitionStatus,
    runStatusBefore: input.runStatusBefore ?? null,
    runStatusAfter: input.runStatusAfter ?? null,
    pathKind: input.pathKind,
  });
}

async function enqueueMetaDates(input: {
  businessId: string;
  accountIds: string[];
  dates: string[];
  triggerSource: string;
  lane: MetaSyncLane;
  scopes: MetaWarehouseScope[];
  priority: number;
}) {
  if (input.accountIds.length === 0) return 0;
  let queued = 0;

  const workItems = input.accountIds.flatMap((providerAccountId) =>
    input.dates.flatMap((date) =>
      input.scopes.map((scope) => ({
        businessId: input.businessId,
        providerAccountId,
        lane: input.lane,
        scope,
        partitionDate: normalizeMetaPartitionDate(date),
        status: "queued" as const,
        priority: input.priority,
        source: input.triggerSource,
        attemptCount: 0,
      })),
    ),
  );

  for (
    let index = 0;
    index < workItems.length;
    index += META_ENQUEUE_BATCH_SIZE
  ) {
    const rows = await Promise.all(
      workItems
        .slice(index, index + META_ENQUEUE_BATCH_SIZE)
        .map((item) => queueMetaSyncPartition(item).catch(() => null)),
    );
    for (const row of rows) {
      if (row?.id && row.status === "queued") queued += 1;
    }
  }

  return queued;
}

export function resolveMetaHistoricalReplaySource(
  partitionStates: Map<
    string,
    {
      status: string;
      source: string;
      finishedAt: string | null;
    }
  >,
) {
  const states = Array.from(partitionStates.values()).map(
    (value) => value.status,
  );
  if (
    states.some((status) => ["queued", "leased", "running"].includes(status))
  ) {
    return null;
  }
  if (
    states.some((status) =>
      ["succeeded", "failed", "dead_letter", "cancelled"].includes(status),
    )
  ) {
    return "historical_recovery" as const;
  }
  return "historical" as const;
}

async function enqueueMetaHistoricalCorePartitions(
  businessId: string,
  credentials: MetaCredentials,
  maxDates = META_HISTORICAL_ENQUEUE_DAYS_PER_RUN,
) {
  if (!credentials?.accountIds?.length) return 0;
  const { startDate } = getMetaHistoricalWindow(credentials);
  let queued = 0;

  for (const providerAccountId of credentials.accountIds) {
    const referenceToday =
      credentials.accountProfiles?.[providerAccountId]?.timezone
        ? getTodayIsoForTimeZoneServer(
            credentials.accountProfiles[providerAccountId].timezone,
          )
        : getMetaReferenceToday(credentials);
    const nextIncompleteDate = await getNextMetaHistoricalAuthoritativeDay({
      businessId,
      providerAccountId,
      startDate,
      referenceToday,
      accountTimezone:
        credentials.accountProfiles?.[providerAccountId]?.timezone ?? "UTC",
    }).catch(() => null);
    const incompleteDates = nextIncompleteDate ? [nextIncompleteDate] : [];

    const historicalDates: string[] = [];
    const historicalRecoveryDates: string[] = [];

    for (const date of incompleteDates) {
      const partitionStates = await getMetaPartitionStatesForDate({
        businessId,
        providerAccountId,
        lane: "core",
        partitionDate: date,
        scopes: META_CORE_PARTITION_QUEUE_SCOPES,
      }).catch(() => new Map());
      const triggerSource = resolveMetaHistoricalReplaySource(partitionStates);
      if (triggerSource === "historical_recovery") {
        historicalRecoveryDates.push(date);
      } else if (triggerSource === "historical") {
        historicalDates.push(date);
      }
    }

    if (historicalDates.length > 0) {
      queued += await enqueueMetaDates({
        businessId,
        accountIds: [providerAccountId],
        dates: historicalDates,
        triggerSource: "historical",
        lane: "core",
        scopes: META_CORE_PARTITION_QUEUE_SCOPES,
        priority: 20,
      });
    }

    if (historicalRecoveryDates.length > 0) {
      queued += await enqueueMetaDates({
        businessId,
        accountIds: [providerAccountId],
        dates: historicalRecoveryDates,
        triggerSource: "historical_recovery",
        lane: "core",
        scopes: META_CORE_PARTITION_QUEUE_SCOPES,
        priority: 25,
      });
    }
  }

  return queued;
}

async function enqueueMetaMaintenancePartitions(
  businessId: string,
  credentials: MetaCredentials,
) {
  if (!credentials?.accountIds?.length) return 0;
  const targets = buildMetaRecentTargetWindows(credentials);
  const allRecentDates = new Set<string>();
  const narrowSlowPathDates = new Set<string>();
  const targetByAccountId = new Map<string, MetaRecentTargetWindow>();
  const summary = emptyMetaRecentAutoHealSummary();
  summary.accountsScanned = targets.length;

  for (const target of targets) {
    targetByAccountId.set(target.providerAccountId, target);
    allRecentDates.add(target.d1);
    allRecentDates.add(target.d2);
    allRecentDates.add(target.d3);
    narrowSlowPathDates.add(target.d1);
    for (const date of enumerateDays(target.d7Start, target.d1, false)) {
      allRecentDates.add(date);
    }
  }

  const narrowDates = Array.from(narrowSlowPathDates).sort();
  const widerDates = Array.from(allRecentDates).sort();
  const narrowDirtyRows =
    narrowDates.length > 0
      ? await getMetaDirtyRecentDates({
          businessId,
          startDate: narrowDates[0],
          endDate: narrowDates[narrowDates.length - 1],
          slowPathDates: narrowDates,
        }).catch(() => [])
      : [];
  const widerDirtyRows =
    widerDates.length > 0
      ? await getMetaDirtyRecentDates({
          businessId,
          startDate: widerDates[0],
          endDate: widerDates[widerDates.length - 1],
        }).catch(() => [])
      : [];
  const dirtyRows = mergeMetaDirtyRecentRows([...narrowDirtyRows, ...widerDirtyRows]);
  summary.recentDaysScanned = targets.length * 7;
  summary.dirtyDaysFound = dirtyRows.length;
  summary.oldestDirtyDate =
    dirtyRows.length > 0
      ? dirtyRows.reduce(
          (oldest, row) => (oldest == null || row.date < oldest ? row.date : oldest),
          null as string | null,
        )
      : null;

  const dirtyBySlice = new Map<string, MetaDirtyRecentDateRow>();
  for (const row of dirtyRows) {
    dirtyBySlice.set(`${row.providerAccountId}:${row.date}`, row);
    for (const reason of row.reasons) {
      summary.reasonCounts[reason] = (summary.reasonCounts[reason] ?? 0) + 1;
    }
  }

  const enqueueAuthoritativeSlice = async (
    providerAccountId: string,
    date: string,
    source: MetaSyncPartitionSource,
    dirty?: MetaDirtyRecentDateRow | null,
    options?: { eventualFinalization?: boolean },
  ) => {
    const guard = await getMetaRecentAuthoritativeSliceGuard({
      businessId,
      providerAccountId,
      date,
      source,
    }).catch(() => null);
    if (
      guard?.activeAuthoritativeSource &&
      guard.activeAuthoritativePriority >= metaRecentSourcePriority(source)
    ) {
      summary.skippedActiveDuplicate += 1;
      return 0;
    }
    if (guard?.repeatedFailures24h && guard.repeatedFailures24h >= 3) {
      summary.skippedRepeatedFailures += 1;
      summary.reasonCounts.repeated_failures_skip =
        (summary.reasonCounts.repeated_failures_skip ?? 0) + 1;
      console.warn("[meta-sync] stuck_dirty_day", {
        businessId,
        providerAccountId,
        date,
        source,
        repeatedFailures24h: guard.repeatedFailures24h,
      });
      return 0;
    }
    const bypassRecentSuccess =
      options?.eventualFinalization === true || dirty?.severity === "critical";
    if (guard?.lastSameSourceSuccessAt && !bypassRecentSuccess) {
      summary.skippedRecentSuccess += 1;
      return 0;
    }
    if (guard?.lastSameSourceAttemptAt) {
      summary.skippedCooldown += 1;
      return 0;
    }
    const queued = await enqueueMetaDates({
      businessId,
      accountIds: [providerAccountId],
      dates: [date],
      triggerSource: source,
      lane: "maintenance",
      scopes: META_CORE_PARTITION_QUEUE_SCOPES,
      priority: source === "finalize_day" ? 80 : 65,
    });
    if (queued > 0) {
      if (source === "finalize_day") {
        summary.finalizeEnqueued += queued;
      } else {
        summary.repairEnqueued += queued;
      }
    }
    return queued;
  };

  let queued = 0;
  for (const target of targets) {
    queued += await enqueueAuthoritativeSlice(
      target.providerAccountId,
      target.d1,
      "finalize_day",
      dirtyBySlice.get(`${target.providerAccountId}:${target.d1}`) ?? null,
      { eventualFinalization: true },
    );
  }

  for (const target of targets) {
    const plannerRows = await listMetaAuthoritativeDayStates({
      businessId,
      providerAccountId: target.providerAccountId,
      startDay: target.d3,
      endDay: target.d1,
    }).catch(() => []);
    const plannerStatesByDay = buildMetaAuthoritativeDayStateMap(plannerRows);
    for (const date of [target.d1, target.d2, target.d3]) {
      await seedMetaAuthoritativePlannerDayStates({
        businessId,
        providerAccountId: target.providerAccountId,
        day: date,
        referenceToday: target.today,
        accountTimezone:
          credentials.accountProfiles?.[target.providerAccountId]?.timezone ??
          "UTC",
        existingStates: plannerStatesByDay.get(date) ?? null,
      }).catch(() => []);
    }
    const d1Published = isMetaPlannerDayPublished({
      day: target.d1,
      referenceToday: target.today,
      statesBySurface: plannerStatesByDay.get(target.d1) ?? null,
    });
    const d2Published = isMetaPlannerDayPublished({
      day: target.d2,
      referenceToday: target.today,
      statesBySurface: plannerStatesByDay.get(target.d2) ?? null,
    });
    const d3Published = isMetaPlannerDayPublished({
      day: target.d3,
      referenceToday: target.today,
      statesBySurface: plannerStatesByDay.get(target.d3) ?? null,
    });
    for (const date of [target.d2, target.d3]) {
      if (date === target.d2 && !d1Published) continue;
      if (date === target.d3 && !d2Published) continue;
      const dirty = dirtyBySlice.get(`${target.providerAccountId}:${date}`);
      if (!dirty) continue;
      const action = classifyMetaRecentAction({ target, dirty });
      if (!action) continue;
      queued += await enqueueAuthoritativeSlice(
        target.providerAccountId,
        date,
        action,
        dirty,
      );
    }
    if (!d3Published) continue;
    for (const date of enumerateDays(target.d7Start, target.d1, false)) {
      if (date === target.d1 || date === target.d2 || date === target.d3) continue;
      const dirty = dirtyBySlice.get(`${target.providerAccountId}:${date}`);
      if (!dirty) continue;
      const action = classifyMetaRecentAction({ target, dirty });
      if (!action) continue;
      queued += await enqueueAuthoritativeSlice(
        target.providerAccountId,
        date,
        action,
        dirty,
      );
    }
  }

  const todayTargets = new Set(targets.map((target) => `${target.providerAccountId}:${target.today}`));
  for (const pair of todayTargets) {
    const [providerAccountId, date] = pair.split(":");
    queued += await enqueueMetaDates({
      businessId,
      accountIds: [providerAccountId],
      dates: [date],
      triggerSource: "today_observe",
      lane: "maintenance",
      scopes: META_CORE_PARTITION_QUEUE_SCOPES,
      priority: 60,
    });
  }

  logRuntimeInfo("meta-sync", "recent_auto_heal_summary", {
    businessId,
    ...summary,
  });

  return {
    queued,
    recentAutoHeal: summary,
  };
}

function isMetaCreativeDailyFullScanWindow(now = new Date()) {
  return now.getUTCHours() === META_CREATIVE_WAREHOUSE_DAILY_FULL_UTC_HOUR;
}

function isRecentCreativeWarehouseAttemptFresh(
  finishedAt: string | null | undefined,
  nowMs = Date.now(),
) {
  const finishedAtMs = parseTimestampMs(finishedAt);
  if (!finishedAtMs) return false;
  return (
    nowMs - finishedAtMs <
    META_CREATIVE_WAREHOUSE_INCREMENTAL_COOLDOWN_MINUTES * 60_000
  );
}

async function enqueueMetaCreativeWarehouseDate(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  source: MetaSyncPartitionSource;
  priority: number;
  enforceIncrementalCooldown?: boolean;
}) {
  const existingPartitions = await getMetaPartitionStatesForDate({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    lane: "extended",
    partitionDate: input.date,
    scopes: ["creative_daily"],
  }).catch(() => new Map());
  const existing = existingPartitions.get("creative_daily");
  if (existing && ["queued", "leased", "running"].includes(existing.status)) {
    return 0;
  }
  if (
    input.enforceIncrementalCooldown &&
    existing?.status === "succeeded" &&
    isRecentCreativeWarehouseAttemptFresh(existing.finishedAt)
  ) {
    return 0;
  }
  const row = await queueMetaSyncPartition({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    lane: "extended",
    scope: "creative_daily",
    partitionDate: input.date,
    status: "queued",
    priority: input.priority,
    source: input.source,
    attemptCount: 0,
  }).catch(() => null);
  return row?.id && row.status === "queued" ? 1 : 0;
}

async function enqueueMetaCreativeWarehousePartitions(
  businessId: string,
  credentials: MetaCredentials,
) {
  if (!credentials?.accountIds?.length) return 0;
  let queued = 0;
  for (const providerAccountId of credentials.accountIds) {
    const accountTimezone =
      credentials.accountProfiles?.[providerAccountId]?.timezone ?? "UTC";
    const today = getTodayIsoForTimeZoneServer(accountTimezone);
    const finalizedEndDate = addUtcDays(today, -1);
    const recentStartDate = addUtcDays(
      today,
      -(Math.max(1, META_CREATIVE_WAREHOUSE_RECENT_ENQUEUE_DAYS) - 1),
    );
    const recentDates = Array.from(
      new Set([finalizedEndDate, ...enumerateDays(recentStartDate, today, true)]),
    ).sort();

    for (const date of recentDates) {
      const source =
        date === today
          ? "today_observe"
          : date === finalizedEndDate
            ? "finalize_day"
            : "recent_recovery";
      queued += await enqueueMetaCreativeWarehouseDate({
        businessId,
        providerAccountId,
        date,
        source,
        priority:
          source === "finalize_day" ? 64 : source === "today_observe" ? 62 : 58,
        enforceIncrementalCooldown: true,
      });
    }

    const historicalStartDate = addUtcDays(
      finalizedEndDate,
      -(META_CREATIVE_WAREHOUSE_HISTORY_DAYS - 1),
    );
    const missingDates = await getMetaIncompleteCoverageDates({
      businessId,
      providerAccountId,
      startDate: historicalStartDate,
      endDate: finalizedEndDate,
      scopes: ["creative_daily"],
      limit: META_CREATIVE_WAREHOUSE_HISTORICAL_ENQUEUE_DAYS_PER_RUN,
    }).catch(() => []);

    for (const date of missingDates) {
      queued += await enqueueMetaCreativeWarehouseDate({
        businessId,
        providerAccountId,
        date,
        source: "historical_recovery",
        priority: 35,
      });
    }
  }

  return queued;
}

export async function enqueueMetaScheduledWork(businessId: string) {
  assertSyncLaneEnabled("cron_enqueue");
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_enqueue_scheduled_work", { fresh: true });
  const credentials = await resolveMetaCredentials(businessId).catch(
    () => null,
  );
  const rolloverAccounts = await syncProviderDayRolloverState({
    provider: "meta",
    businessId,
  }).catch(() => []);
  const d1Recovery = await recoverMetaD1FinalizePartitions({
    businessId,
  }).catch(() => null);
  let queuedCore = 0;
  let queuedMaintenance = 0;
  let queuedCreative = 0;
  let queueDepth = 0;
  let leasedPartitions = 0;
  let recentAutoHeal = emptyMetaRecentAutoHealSummary();

  const cancelledObsoletePartitions =
    await cancelObsoleteMetaCoreScopePartitions({
      businessId,
      canonicalScope: META_PRODUCT_CORE_PARTITION_SCOPE,
    }).catch(() => []);

  if (credentials?.accountIds?.length) {
    const queueHealth = await getMetaQueueHealth({ businessId }).catch(
      () => null,
    );
    queueDepth = queueHealth?.queueDepth ?? 0;
    leasedPartitions = queueHealth?.leasedPartitions ?? 0;
    const hasHistoricalCoreBacklog =
      (queueHealth?.historicalCoreQueueDepth ?? 0) > 0 ||
      (queueHealth?.historicalCoreLeasedPartitions ?? 0) > 0;
    const hasMaintenanceBacklog =
      (queueHealth?.maintenanceQueueDepth ?? 0) > 0 ||
      (queueHealth?.maintenanceLeasedPartitions ?? 0) > 0;
    const requiresD1Maintenance =
      rolloverAccounts.some(
        (account) =>
          account.rolloverDetected || account.d1FinalizeCompletedAt == null,
      ) ||
      (d1Recovery?.candidateCount ?? 0) > 0 ||
      (d1Recovery?.historicalFinalizePollutionCount ?? 0) > 0 ||
      (d1Recovery?.stalledReclaimableCount ?? 0) > 0 ||
      Boolean(d1Recovery?.d1FinalizeRecoveryQueued);

    await refreshMetaSyncStateForBusiness({ businessId, credentials }).catch(
      () => null,
    );
    if (!hasHistoricalCoreBacklog) {
      queuedCore = await enqueueMetaHistoricalCorePartitions(
        businessId,
        credentials,
      ).catch(() => 0);
    }
    if (!hasMaintenanceBacklog || requiresD1Maintenance) {
      const maintenanceResult = await enqueueMetaMaintenancePartitions(
        businessId,
        credentials,
      ).catch(() => 0);
      if (typeof maintenanceResult === "number") {
        queuedMaintenance = maintenanceResult;
      } else {
        queuedMaintenance = maintenanceResult.queued;
        recentAutoHeal = maintenanceResult.recentAutoHeal;
      }
    }
    queuedCreative = await enqueueMetaCreativeWarehousePartitions(
      businessId,
      credentials,
    ).catch(() => 0);
  }

  return {
    businessId,
    queuedCore,
    queuedMaintenance,
    queuedCreative,
    d1Recovery,
    queueDepth,
    leasedPartitions,
    recentAutoHeal,
    cancelledObsoletePartitions: cancelledObsoletePartitions.length,
  };
}

async function enqueueMetaExtendedPartitionsForDate(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  source: string;
}) {
  const normalizedSource = isHistoricalMetaSource(input.source)
    ? "historical_recovery"
    : "recent_recovery";
  const existingPartitions = await getMetaPartitionStatesForDate({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    lane: "extended",
    partitionDate: input.date,
    scopes: META_EXTENDED_SCOPE_LIST,
  });
  for (const scope of META_EXTENDED_SCOPE_LIST) {
    const existing = existingPartitions.get(scope);
    if (
      existing &&
      (["queued", "leased", "running", "succeeded"].includes(existing.status) ||
        (normalizedSource === "recent_recovery" &&
          ["failed", "dead_letter", "cancelled"].includes(existing.status) &&
          isRecentMetaSource(existing.source)))
    ) {
      continue;
    }
    await queueMetaSyncPartition({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      lane: "extended",
      scope,
      partitionDate: input.date,
      status: "queued",
      priority: 25,
      source: normalizedSource,
      attemptCount: 0,
    });
  }
}

export async function refreshMetaSyncStateForBusiness(input: {
  businessId: string;
  credentials?: MetaCredentials | null;
}) {
  await assertSyncGrowthBoundary("meta_refresh_sync_state", { fresh: true });
  const credentials =
    input.credentials ??
    (await resolveMetaCredentials(input.businessId).catch(() => null));
  if (!credentials?.accountIds?.length) return;
  const { startDate, endDate } = getMetaHistoricalWindow(credentials);

  await Promise.all(
    credentials.accountIds.flatMap((providerAccountId) =>
      META_STATE_SCOPES.map(async (scope) => {
        const scopeStartDate =
          scope === "creative_daily"
            ? addUtcDays(endDate, -(META_CREATIVE_WAREHOUSE_HISTORY_DAYS - 1))
            : startDate;
        const coverage =
          scope === "account_daily"
            ? await getMetaAccountDailyCoverage({
                businessId: input.businessId,
                providerAccountId,
                startDate: scopeStartDate,
                endDate,
              }).catch(() => null)
            : scope === "campaign_daily"
              ? await getMetaCampaignDailyCoverage({
                  businessId: input.businessId,
                  providerAccountId,
                  startDate: scopeStartDate,
                  endDate,
                }).catch(() => null)
              : scope === "adset_daily"
                ? await getMetaAdSetDailyCoverage({
                    businessId: input.businessId,
                    providerAccountId,
                    startDate: scopeStartDate,
                    endDate,
                  }).catch(() => null)
                : scope === "creative_daily"
                  ? await getMetaCreativeDailyCoverage({
                      businessId: input.businessId,
                      providerAccountId,
                      startDate: scopeStartDate,
                      endDate,
                    }).catch(() => null)
                  : await getMetaAdDailyCoverage({
                      businessId: input.businessId,
                      providerAccountId,
                      startDate: scopeStartDate,
                      endDate,
                    }).catch(() => null);

        const partitionHealth = await getMetaPartitionHealth({
          businessId: input.businessId,
          providerAccountId,
          scope,
        }).catch(() => null);

        await upsertMetaSyncState({
          businessId: input.businessId,
          providerAccountId,
          scope,
          historicalTargetStart: scopeStartDate,
          historicalTargetEnd: endDate,
          effectiveTargetStart: scopeStartDate,
          effectiveTargetEnd: endDate,
          readyThroughDate: coverage?.ready_through_date ?? null,
          lastSuccessfulPartitionDate: coverage?.ready_through_date ?? null,
          latestBackgroundActivityAt:
            partitionHealth?.latestActivityAt ??
            coverage?.latest_updated_at ??
            null,
          latestSuccessfulSyncAt: coverage?.latest_updated_at ?? null,
          completedDays: coverage?.completed_days ?? 0,
          deadLetterCount: partitionHealth?.deadLetterPartitions ?? 0,
        }).catch(() => null);
      }),
    ),
  );
}

export function scheduleMetaBackgroundSync(input: {
  businessId: string;
  delayMs?: number;
}) {
  if (!canUseInProcessBackgroundScheduling()) {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.SYNC_WORKER_MODE === "1" &&
      META_IN_PROCESS_RUNTIME_ENABLED &&
      !hasMetaInProcessBackgroundWorkerIdentity()
    ) {
      logMetaQueueVisibility("meta_runner_lease_not_acquired", {
        businessId: input.businessId,
        reason: "in_process_worker_identity_missing",
        source: "schedule",
      });
    }
    return false;
  }
  const backgroundSyncKeys = getBackgroundSyncKeys();
  const timers = getBackgroundWorkerTimers();
  const key = input.businessId;
  if (backgroundSyncKeys.has(key)) {
    logMetaQueueVisibility("meta_background_sync_already_scheduled", {
      businessId: input.businessId,
      delayMs: Math.max(0, input.delayMs ?? 0),
      source: "schedule",
    });
    return false;
  }
  backgroundSyncKeys.add(key);
  const errorCounts = getBackgroundErrorCounts();
  const timer = setTimeout(
    async () => {
      timers.delete(key);
      const runtimeWorkerId =
        process.env.META_WORKER_ID?.trim() ||
        process.env.WORKER_INSTANCE_ID?.trim() ||
        undefined;
      let nextDelayMs = META_BACKGROUND_IDLE_DELAY_MS;
      try {
        const result = await syncMetaReports(
          input.businessId,
          runtimeWorkerId ? { runtimeWorkerId } : undefined,
        );
        const hadError = result.failed > 0 && result.succeeded === 0;
        const nextErrorCount = hadError ? (errorCounts.get(key) ?? 0) + 1 : 0;
        if (nextErrorCount > 0) {
          errorCounts.set(key, nextErrorCount);
        } else {
          errorCounts.delete(key);
        }
        nextDelayMs =
          result.nextDelayMs ??
          resolveMetaBackgroundLoopDelayMs({
            hasPendingWork: result.hasPendingWork ?? false,
            hasForwardProgress: result.hasForwardProgress ?? false,
            hadError,
            errorStreak: nextErrorCount,
          });
      } catch (error) {
        const nextErrorCount = (errorCounts.get(key) ?? 0) + 1;
        errorCounts.set(key, nextErrorCount);
        nextDelayMs = resolveMetaBackgroundLoopDelayMs({
          hasPendingWork: true,
          hasForwardProgress: false,
          hadError: true,
          errorStreak: nextErrorCount,
        });
        console.warn("[meta-sync] background_run_failed", {
          businessId: input.businessId,
          workerId: runtimeWorkerId ?? null,
          nextDelayMs,
          message: durableMetaFailureMessage(error),
        });
      } finally {
        backgroundSyncKeys.delete(key);
        if (canUseInProcessBackgroundScheduling()) {
          scheduleMetaBackgroundSync({
            businessId: input.businessId,
            delayMs: nextDelayMs,
          });
        }
      }
    },
    Math.max(0, input.delayMs ?? META_BACKGROUND_IDLE_DELAY_MS),
  );
  timers.set(key, timer);
  return true;
}

async function cancelDeprecatedMetaPartition(input: {
  partition: {
    id: string;
    businessId: string;
    providerAccountId: string;
    lane: MetaSyncLane;
    scope: MetaWarehouseScope;
    partitionDate: string;
    attemptCount: number;
    leaseEpoch: number;
    source: string;
  };
  workerId: string;
  runId: string | null;
  recoveredRunId?: string | null;
  startedAtMs: number;
  reason: string;
}) {
  const cancelledAt = new Date().toISOString();
  const checkpoint = await getMetaSyncCheckpoint({
    partitionId: input.partition.id,
    checkpointScope: input.partition.scope,
    runId: input.runId ?? input.partition.id,
  }).catch(() => null);

  if (checkpoint) {
    await upsertMetaCheckpointOrThrow({
      partitionId: input.partition.id,
      businessId: input.partition.businessId,
      providerAccountId: input.partition.providerAccountId,
      checkpointScope: input.partition.scope,
      phase: "finalize",
      status: "cancelled",
      pageIndex: checkpoint.pageIndex,
      nextPageUrl: null,
      providerCursor: null,
      rowsFetched: checkpoint.rowsFetched ?? 0,
      rowsWritten: checkpoint.rowsWritten ?? 0,
      lastSuccessfulEntityKey: checkpoint.lastSuccessfulEntityKey ?? null,
      lastResponseHeaders: checkpoint.lastResponseHeaders ?? {},
      attemptCount: Math.max(
        checkpoint.attemptCount,
        input.partition.attemptCount + 1,
      ),
      leaseEpoch: input.partition.leaseEpoch,
      leaseOwner: input.workerId,
      startedAt: checkpoint.startedAt ?? cancelledAt,
      finishedAt: cancelledAt,
    }).catch(() => null);
  }

  logMetaRunObservability({
    event: "completion_attempt_started",
    partitionId: input.partition.id,
    runId: input.runId,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch,
    lane: input.partition.lane,
    scope: input.partition.scope,
    partitionStatus: "cancelled",
    runStatusBefore: "running",
    runStatusAfter: "cancelled",
    pathKind: "primary",
  });
  const completionHeartbeatOk = await heartbeatMetaPartitionBeforeCompletion({
    partitionId: input.partition.id,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch,
    leaseMinutes: META_PARTITION_LEASE_MINUTES,
  });
  if (!completionHeartbeatOk.ok) {
    if (input.runId) {
      await updateMetaSyncRun({
        id: input.runId,
        status: "failed",
        durationMs: Date.now() - input.startedAtMs,
        errorClass: "lease_conflict",
        errorMessage:
          "partition lost ownership before deprecated-scope cancellation",
        finishedAt: cancelledAt,
        onlyIfCurrentStatus: "running",
      }).catch(() => null);
    }
    return false;
  }
  let completion;
  try {
    completion = await completeMetaPartitionAttempt({
      partitionId: input.partition.id,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch,
      runId: input.runId,
      partitionStatus: "cancelled",
      runStatus: "cancelled",
      durationMs: Date.now() - input.startedAtMs,
      finishedAt: cancelledAt,
      lastError: input.reason,
      lane: input.partition.lane,
      scope: input.partition.scope,
      observabilityPath: "primary",
      recoveredRunId: input.recoveredRunId ?? null,
    });
  } catch (error) {
    if (input.runId) {
      await updateMetaSyncRun({
        id: input.runId,
        status: "failed",
        durationMs: Date.now() - input.startedAtMs,
        errorClass: "operational",
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt: cancelledAt,
        onlyIfCurrentStatus: "running",
      }).catch(() => null);
    }
    return false;
  }
  if (!completion.ok) {
    if (input.runId) {
      await updateMetaSyncRun({
        id: input.runId,
        status: "failed",
        durationMs: Date.now() - input.startedAtMs,
        errorClass: "lease_conflict",
        errorMessage:
          "partition lost ownership before deprecated-scope cancellation",
        finishedAt: cancelledAt,
        onlyIfCurrentStatus: "running",
      }).catch(() => null);
    }
    return false;
  }
  if (!completion.runUpdated) {
    await backfillMetaRunTerminalState({
      runId: input.runId,
      recoveredRunId: input.recoveredRunId ?? null,
      startedAtMs: input.startedAtMs,
      status: "cancelled",
      finishedAt: cancelledAt,
      context: {
        partitionId: input.partition.id,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch,
        lane: input.partition.lane,
        scope: input.partition.scope,
      },
    });
  }

  logRuntimeInfo("meta-sync", "partition_cancelled_deprecated_scope", {
    businessId: input.partition.businessId,
    partitionId: input.partition.id,
    workerId: input.workerId,
    scope: input.partition.scope,
    partitionDate: input.partition.partitionDate,
    source: input.partition.source,
  });
  return true;
}

async function requeueMetaPartitionWithoutSuccess(input: {
  partition: {
    id: string;
    businessId: string;
    providerAccountId: string;
    lane: MetaSyncLane;
    scope: MetaWarehouseScope;
    partitionDate: string;
    attemptCount: number;
    leaseEpoch: number;
    source: string;
    priority?: number;
  };
  workerId: string;
  runId: string | null;
  recoveredRunId?: string | null;
  startedAtMs: number;
  reason: string;
}) {
  const finishedAt = new Date().toISOString();
  logMetaRunObservability({
    event: "completion_attempt_started",
    partitionId: input.partition.id,
    runId: input.runId,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch,
    lane: input.partition.lane,
    scope: input.partition.scope,
    partitionStatus: "cancelled",
    runStatusBefore: "running",
    runStatusAfter: "cancelled",
    pathKind: "primary",
  });
  const completionHeartbeatOk = await heartbeatMetaPartitionBeforeCompletion({
    partitionId: input.partition.id,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch,
    leaseMinutes: META_PARTITION_LEASE_MINUTES,
  });
  if (!completionHeartbeatOk.ok) {
    if (input.runId) {
      await updateMetaSyncRun({
        id: input.runId,
        status: "failed",
        durationMs: Date.now() - input.startedAtMs,
        errorClass: "lease_conflict",
        errorMessage:
          "partition lost ownership before non-terminal authoritative requeue",
        finishedAt,
        onlyIfCurrentStatus: "running",
      }).catch(() => null);
    }
    return { outcome: "failed" } satisfies MetaPartitionProcessResult;
  }

  let completion;
  try {
    completion = await completeMetaPartitionAttempt({
      partitionId: input.partition.id,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch,
      runId: input.runId,
      partitionStatus: "cancelled",
      runStatus: "cancelled",
      durationMs: Date.now() - input.startedAtMs,
      finishedAt,
      lastError: input.reason,
      lane: input.partition.lane,
      scope: input.partition.scope,
      observabilityPath: "primary",
      recoveredRunId: input.recoveredRunId ?? null,
    });
  } catch (error) {
    if (input.runId) {
      await updateMetaSyncRun({
        id: input.runId,
        status: "failed",
        durationMs: Date.now() - input.startedAtMs,
        errorClass: "operational",
        errorMessage: error instanceof Error ? error.message : String(error),
        finishedAt,
        onlyIfCurrentStatus: "running",
      }).catch(() => null);
    }
    return { outcome: "failed" } satisfies MetaPartitionProcessResult;
  }
  if (!completion.ok) {
    if (input.runId) {
      await updateMetaSyncRun({
        id: input.runId,
        status: "failed",
        durationMs: Date.now() - input.startedAtMs,
        errorClass: "lease_conflict",
        errorMessage:
          "partition lost ownership before non-terminal authoritative requeue",
        finishedAt,
        onlyIfCurrentStatus: "running",
      }).catch(() => null);
    }
    return { outcome: "failed" } satisfies MetaPartitionProcessResult;
  }
  if (!completion.runUpdated) {
    await backfillMetaRunTerminalState({
      runId: input.runId,
      recoveredRunId: input.recoveredRunId ?? null,
      startedAtMs: input.startedAtMs,
      status: "cancelled",
      finishedAt,
      context: {
        partitionId: input.partition.id,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch,
        lane: input.partition.lane,
        scope: input.partition.scope,
      },
    });
  }

  const requeued = await queueMetaSyncPartition({
    businessId: input.partition.businessId,
    providerAccountId: input.partition.providerAccountId,
    lane: input.partition.lane,
    scope: input.partition.scope,
    partitionDate: input.partition.partitionDate,
    status: "queued",
    priority: getMetaRequeuePriority({
      lane: input.partition.lane,
      source: input.partition.source,
      priority: input.partition.priority,
    }),
    source: input.partition.source,
    attemptCount: input.partition.attemptCount,
  }).catch(() => null);

  logRuntimeInfo("meta-sync", "partition_requeued_without_success", {
    businessId: input.partition.businessId,
    partitionId: input.partition.id,
    workerId: input.workerId,
    scope: input.partition.scope,
    partitionDate: input.partition.partitionDate,
    source: input.partition.source,
    reason: input.reason,
    requeued: requeued?.status === "queued",
  });

  return requeued?.status === "queued"
    ? ({ outcome: "requeued" } satisfies MetaPartitionProcessResult)
    : ({ outcome: "failed" } satisfies MetaPartitionProcessResult);
}

async function processMetaPartition(input: {
  credentials: MetaCredentials;
  partition: {
    id?: string;
    businessId: string;
    providerAccountId: string;
    lane: MetaSyncLane;
    scope: MetaWarehouseScope;
    partitionDate: string;
    priority?: number;
    attemptCount: number;
    leaseEpoch: number;
    source: string;
  };
  workerId: string;
}): Promise<MetaPartitionProcessResult> {
  // The real work-unit boundary. The consumer calls THIS function directly, so
  // the gate on processMetaLifecyclePartition never ran for queued work — a
  // long batch could cross the capacity budget unchecked, one partition at a
  // time. It has to be here, before authority, before mark-running, and before
  // any provider call or state mutation.
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_process_partition");
  const partitionId = input.partition.id;
  const revoked = await refuseRevokedMetaPartition(input.partition);
  if (revoked) return revoked;
  if (!partitionId) return { outcome: "failed" };
  const markRunningOk = await markMetaPartitionRunning({
    partitionId,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch,
    leaseMinutes: META_PARTITION_LEASE_MINUTES,
  }).catch(() => false);
  if (!markRunningOk) {
    console.warn("[meta-sync] partition_lost_ownership_before_run", {
      businessId: input.partition.businessId,
      partitionId,
      workerId: input.workerId,
      scope: input.partition.scope,
      partitionDate: input.partition.partitionDate,
    });
    return { outcome: "failed" };
  }
  const startedAt = Date.now();
  const createdRunId = await createMetaSyncRun({
    partitionId,
    businessId: input.partition.businessId,
    providerAccountId: input.partition.providerAccountId,
    lane: input.partition.lane,
    scope: input.partition.scope,
    partitionDate: input.partition.partitionDate,
    status: "running",
    workerId: input.workerId,
    attemptCount: input.partition.attemptCount + 1,
    metaJson: {
      source: input.partition.source,
      leaseEpoch: input.partition.leaseEpoch,
    },
  }).catch(() => null);
  logMetaRunObservability({
    event: "run_row_created",
    partitionId,
    runId: createdRunId,
    recoveredRunId: null,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch,
    lane: input.partition.lane,
    scope: input.partition.scope,
    partitionStatus: "running",
    runStatusBefore: null,
    runStatusAfter: createdRunId ? "running" : null,
    pathKind: "primary",
  });
  let runId = createdRunId;
  let recoveredRunId: string | null = null;
  if (!runId) {
    recoveredRunId = await getLatestRunningMetaSyncRunIdForPartition({
      partitionId,
    }).catch(() => null);
    logMetaRunObservability({
      event: "latest_running_run_lookup_result",
      partitionId,
      runId: createdRunId,
      recoveredRunId,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch,
      lane: input.partition.lane,
      scope: input.partition.scope,
      partitionStatus: "running",
      runStatusBefore: null,
      runStatusAfter: recoveredRunId ? "running" : null,
      pathKind: "primary",
    });
    runId = recoveredRunId;
  }
  logMetaRunObservability({
    event: "run_id_attached_to_execution_context",
    partitionId,
    runId,
    recoveredRunId,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch,
    lane: input.partition.lane,
    scope: input.partition.scope,
    partitionStatus: "running",
    runStatusBefore: null,
    runStatusAfter: runId ? "running" : null,
    pathKind: "primary",
  });

  const deprecatedScopeReason = getDeprecatedMetaPartitionCancellationReason(
    input.partition.scope,
  );
  if (deprecatedScopeReason) {
    return (await cancelDeprecatedMetaPartition({
      partition: {
        id: partitionId,
        businessId: input.partition.businessId,
        providerAccountId: input.partition.providerAccountId,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionDate: input.partition.partitionDate,
        attemptCount: input.partition.attemptCount,
        leaseEpoch: input.partition.leaseEpoch,
        source: input.partition.source,
      },
      workerId: input.workerId,
      runId,
      recoveredRunId,
      startedAtMs: startedAt,
      reason: deprecatedScopeReason,
    }))
      ? ({ outcome: "succeeded" } satisfies MetaPartitionProcessResult)
      : ({ outcome: "failed" } satisfies MetaPartitionProcessResult);
  }

  try {
    if (input.partition.source === "finalize_day") {
      await markProviderDayRolloverFinalizeStarted({
        provider: "meta",
        businessId: input.partition.businessId,
        providerAccountId: input.partition.providerAccountId,
        targetDate: input.partition.partitionDate,
      }).catch(() => null);
    }
    const scopes =
      input.partition.lane === "core" || input.partition.lane === "maintenance"
        ? META_CORE_SCOPES
        : [input.partition.scope];
    const partitionDayResult = await syncMetaPartitionDay({
      credentials: input.credentials,
      businessId: input.partition.businessId,
      providerAccountId: input.partition.providerAccountId,
      day: input.partition.partitionDate,
      lane: input.partition.lane,
      partitionScope: input.partition.scope,
      source: input.partition.source,
      scopes,
      partitionId,
      // ROUND 14: the created-or-recovered run id, threaded to the receipt.
      syncRunId: runId,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch,
      attemptCount: input.partition.attemptCount,
    });
    const authoritativeOutcome = partitionDayResult.authoritative
      ? getMetaAuthoritativePartitionOutcome({
          plannerStates: partitionDayResult.authoritative.plannerStates,
          requiredSurfaces: partitionDayResult.authoritative.requiredSurfaces,
          verification: partitionDayResult.authoritative.verification,
        })
      : { outcome: "published" as const, message: null };

    if (authoritativeOutcome.outcome === "requeued") {
      return requeueMetaPartitionWithoutSuccess({
        partition: {
          id: partitionId,
          businessId: input.partition.businessId,
          providerAccountId: input.partition.providerAccountId,
          lane: input.partition.lane,
          scope: input.partition.scope,
          partitionDate: input.partition.partitionDate,
          priority: input.partition.priority,
          attemptCount: input.partition.attemptCount,
          leaseEpoch: input.partition.leaseEpoch,
          source: input.partition.source,
        },
        workerId: input.workerId,
        runId,
        recoveredRunId,
        startedAtMs: startedAt,
        reason: authoritativeOutcome.message ?? "authoritative_publication_pending",
      });
    }
    if (
      partitionDayResult.authoritative &&
      (authoritativeOutcome.outcome === "blocked" ||
        authoritativeOutcome.outcome === "repair_required")
    ) {
      await recordMetaAuthoritativePublicationShortfall({
        authoritative: partitionDayResult.authoritative,
        message:
          authoritativeOutcome.message ??
          "authoritative_publication_missing",
        reason:
          authoritativeOutcome.outcome === "blocked"
            ? "publication_pointer_missing_after_finalize"
            : "authoritative_publication_repair_required",
      });
    }
    if (
      authoritativeOutcome.outcome === "blocked" ||
      authoritativeOutcome.outcome === "repair_required" ||
      authoritativeOutcome.outcome === "failed"
    ) {
      throw new MetaAuthoritativeExecutorError(
        authoritativeOutcome.outcome,
        authoritativeOutcome.message ??
          "authoritative_executor_completion_denied",
      );
    }
    try {
      const completionHeartbeat = await heartbeatMetaPartitionBeforeCompletion({
        partitionId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch,
        leaseMinutes: META_PARTITION_LEASE_MINUTES,
      });
      if (!completionHeartbeat.ok) {
        const denialSnapshot = await logMetaSuccessCompletionDenied({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch,
          lane: input.partition.lane,
          scope: input.partition.scope,
          partitionStatus: "succeeded",
          runStatus: "succeeded",
          reason: "lease_conflict",
        });
        if (denialSnapshot?.denialClassification === "already_terminal") {
          await backfillMetaDeniedTerminalRuns({
            partitionId,
            runId,
            recoveredRunId,
            workerId: input.workerId,
            leaseEpoch: input.partition.leaseEpoch,
            lane: input.partition.lane,
            scope: input.partition.scope,
            pathKind: "primary",
          });
        }
        if (isMetaTerminalSuccessDenial(denialSnapshot)) {
          await backfillMetaRunTerminalState({
            runId,
            recoveredRunId,
            startedAtMs: startedAt,
            status: "succeeded",
            finishedAt: new Date().toISOString(),
            context: {
              partitionId,
              workerId: input.workerId,
              leaseEpoch: input.partition.leaseEpoch,
              lane: input.partition.lane,
              scope: input.partition.scope,
            },
          });
          return { outcome: "succeeded" };
        }
        if (runId) {
          await updateMetaSyncRun({
            id: runId,
            status: "failed",
            durationMs: Date.now() - startedAt,
            errorClass: "lease_conflict",
            errorMessage: "partition lost ownership before success completion",
            finishedAt: new Date().toISOString(),
            onlyIfCurrentStatus: "running",
          }).catch(() => null);
        }
        return { outcome: "failed" };
      }
      logMetaRunObservability({
        event: "completion_attempt_started",
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: "succeeded",
        runStatusBefore: "running",
        runStatusAfter: "succeeded",
        pathKind: "primary",
      });
      const completed = await completeMetaPartitionAttempt({
        partitionId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch,
        runId,
        partitionStatus: "succeeded",
        runStatus: "succeeded",
        durationMs: Date.now() - startedAt,
        finishedAt: new Date().toISOString(),
        lane: input.partition.lane,
        scope: input.partition.scope,
        observabilityPath: "primary",
        recoveredRunId,
      });
      if (!completed.ok) {
        const denialSnapshot = await logMetaSuccessCompletionDenied({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch,
          lane: input.partition.lane,
          scope: input.partition.scope,
          partitionStatus: "succeeded",
          runStatus: "succeeded",
          reason: "lease_conflict",
        });
        if (denialSnapshot?.denialClassification === "already_terminal") {
          await backfillMetaDeniedTerminalRuns({
            partitionId,
            runId,
            recoveredRunId,
            workerId: input.workerId,
            leaseEpoch: input.partition.leaseEpoch,
            lane: input.partition.lane,
            scope: input.partition.scope,
            pathKind: "primary",
          });
        }
        if (isMetaTerminalSuccessDenial(denialSnapshot)) {
          await backfillMetaRunTerminalState({
            runId,
            recoveredRunId,
            startedAtMs: startedAt,
            status: "succeeded",
            finishedAt: new Date().toISOString(),
            context: {
              partitionId,
              workerId: input.workerId,
              leaseEpoch: input.partition.leaseEpoch,
              lane: input.partition.lane,
              scope: input.partition.scope,
            },
          });
          return { outcome: "succeeded" };
        }
        if (runId) {
          await updateMetaSyncRun({
            id: runId,
            status: "failed",
            durationMs: Date.now() - startedAt,
            errorClass: "lease_conflict",
            errorMessage: "partition lost ownership before success completion",
            finishedAt: new Date().toISOString(),
            onlyIfCurrentStatus: "running",
          }).catch(() => null);
        }
        return { outcome: "failed" };
      }
      if (!completed.runUpdated) {
        await backfillMetaRunTerminalState({
          runId,
          recoveredRunId,
          startedAtMs: startedAt,
          status: "succeeded",
          finishedAt: new Date().toISOString(),
          context: {
            partitionId,
            workerId: input.workerId,
            leaseEpoch: input.partition.leaseEpoch,
            lane: input.partition.lane,
            scope: input.partition.scope,
          },
        });
      }
    } catch (completionError) {
      const denialSnapshot = await logMetaSuccessCompletionDenied({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: "succeeded",
        runStatus: "succeeded",
        reason: "operational_error",
        message:
          completionError instanceof Error
            ? completionError.message
            : String(completionError),
      });
      if (denialSnapshot?.denialClassification === "already_terminal") {
        await backfillMetaDeniedTerminalRuns({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch,
          lane: input.partition.lane,
          scope: input.partition.scope,
          pathKind: "primary",
        });
      }
      throw completionError;
    }
    if (
      input.partition.lane === "core" ||
      input.partition.lane === "maintenance"
    ) {
      await enqueueMetaExtendedPartitionsAfterSuccess({
        businessId: input.partition.businessId,
        providerAccountId: input.partition.providerAccountId,
        date: input.partition.partitionDate,
        source: input.partition.source,
      });
    }
    if (input.partition.source === "finalize_day") {
      await markProviderDayRolloverFinalizeCompleted({
        provider: "meta",
        businessId: input.partition.businessId,
        providerAccountId: input.partition.providerAccountId,
        targetDate: input.partition.partitionDate,
      }).catch(() => null);
    }
    return { outcome: "succeeded" };
  } catch (error) {
    const classified = classifyMetaError(error);
    // Durable: this value reaches `meta_sync_partitions.last_error`,
    // `meta_sync_runs.error_message` and the operator log below.
    const message = durableMetaFailureMessage(error);
    const shouldDeadLetter = shouldDeadLetterMetaFailure({
      errorClass: classified.errorClass,
      terminal: classified.terminal,
      attemptCount: input.partition.attemptCount,
      maxAttempts: META_PARTITION_MAX_ATTEMPTS,
    });
    try {
      const completionHeartbeat = await heartbeatMetaPartitionBeforeCompletion({
        partitionId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch,
        leaseMinutes: META_PARTITION_LEASE_MINUTES,
      });
      if (completionHeartbeat.ok) {
        logMetaRunObservability({
          event: "completion_attempt_started",
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch,
          lane: input.partition.lane,
          scope: input.partition.scope,
          partitionStatus: shouldDeadLetter ? "dead_letter" : "failed",
          runStatusBefore: "running",
          runStatusAfter: "failed",
          pathKind: "primary",
        });
        const completed = await completeMetaPartitionAttempt({
          partitionId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch,
          runId,
          partitionStatus: shouldDeadLetter ? "dead_letter" : "failed",
          runStatus: "failed",
          durationMs: Date.now() - startedAt,
          errorClass: classified.errorClass,
          errorMessage: message,
          finishedAt: new Date().toISOString(),
          lastError: message,
          retryDelayMinutes: shouldDeadLetter
            ? undefined
            : computeRetryDelayMinutes(
                input.partition,
                classified.retryDelayMinutes,
              ),
          lane: input.partition.lane,
          scope: input.partition.scope,
          observabilityPath: "primary",
          recoveredRunId,
        });
        if (!completed.ok) {
          if (runId) {
            await updateMetaSyncRun({
              id: runId,
              status: "failed",
              durationMs: Date.now() - startedAt,
              errorClass: "lease_conflict",
              errorMessage:
                "partition lost ownership before failure completion",
              finishedAt: new Date().toISOString(),
              onlyIfCurrentStatus: "running",
            }).catch(() => null);
          }
        } else if (!completed.runUpdated) {
          await backfillMetaRunTerminalState({
            runId,
            recoveredRunId,
            startedAtMs: startedAt,
            status: "failed",
            errorClass: classified.errorClass,
            errorMessage: message,
            finishedAt: new Date().toISOString(),
            context: {
              partitionId,
              workerId: input.workerId,
              leaseEpoch: input.partition.leaseEpoch,
              lane: input.partition.lane,
              scope: input.partition.scope,
            },
          });
        }
      } else if (runId) {
        await updateMetaSyncRun({
          id: runId,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errorClass: "lease_conflict",
          errorMessage: "partition lost ownership before failure completion",
          finishedAt: new Date().toISOString(),
          onlyIfCurrentStatus: "running",
        }).catch(() => null);
      }
    } catch (completionError) {
      console.warn("[meta-sync] partition_failure_completion_error", {
        businessId: input.partition.businessId,
        partitionId,
        scope: input.partition.scope,
        lane: input.partition.lane,
        message:
          completionError instanceof Error
            ? completionError.message
            : String(completionError),
      });
      if (runId) {
        await updateMetaSyncRun({
          id: runId,
          status: "failed",
          durationMs: Date.now() - startedAt,
          errorClass: classified.errorClass,
          errorMessage: message,
          finishedAt: new Date().toISOString(),
          onlyIfCurrentStatus: "running",
        }).catch(() => null);
      }
    }
    console.warn("[meta-sync] partition_failed", {
      businessId: input.partition.businessId,
      providerAccountId: input.partition.providerAccountId,
      partitionId,
      scope: input.partition.scope,
      partitionDate: input.partition.partitionDate,
      lane: input.partition.lane,
      source: input.partition.source,
      stage: getMetaPartitionStageFromError(error),
      errorClass: classified.errorClass,
      message,
    });
    // Provider stop-loss. isMetaProviderStopLossFailure existed and was never
    // consulted here, so a quota wall or an open circuit breaker failed one
    // partition and the batch walked straight into the same wall for every
    // remaining leased unit. Signalling stopBatch is what makes the tri-state
    // contract whole: confirmed revocation and unknown authority already stop
    // the batch from refuseRevokedMetaPartition; this is the third case.
    const stopBatch = isMetaProviderStopLossFailure({
      error,
      errorClass: classified.errorClass,
    });
    return {
      outcome: "failed",
      ...(stopBatch
        ? {
            stopBatch: true,
            failureClass: classified.errorClass || "meta_provider_stop_loss",
            retryDelayMinutes: classified.retryDelayMinutes,
          }
        : {}),
    };
  }
}

export async function processMetaLifecyclePartition(input: {
  partition: {
    id?: string;
    businessId: string;
    providerAccountId: string;
    lane: MetaSyncLane;
    scope: MetaWarehouseScope;
    partitionDate: string;
    attemptCount: number;
    leaseEpoch: number;
    source: string;
  };
  workerId: string;
}) {
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_lifecycle_partition");
  // Authority first: a revoked account must be refused as a loss of authority,
  // not surface as an unavailable-credentials failure.
  const revoked = await refuseRevokedMetaPartition(input.partition);
  if (revoked) return revoked.outcome !== "failed";

  const credentials = await resolveMetaCredentials(
    input.partition.businessId,
  ).catch(() => null);
  if (!credentials) {
    throw new Error("meta_credentials_unavailable");
  }
  const result = await processMetaPartition({
    credentials,
    partition: input.partition,
    workerId: input.workerId,
  });
  return result.outcome !== "failed";
}

export async function consumeMetaQueuedWork(
  businessId: string,
  input?: {
    runtimeLeaseGuard?: RunnerLeaseGuard;
    runtimeWorkerId?: string;
  },
): Promise<MetaSyncResult> {
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_consume_queued_work");
  const credentials = await resolveMetaCredentials(businessId).catch(
    () => null,
  );
  if (!credentials?.accountIds?.length) {
    logRuntimeInfo("meta-sync", "meta_consume_skipped_no_credentials", {
      businessId,
    });
    return {
      businessId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
      hasPendingWork: false,
      hasForwardProgress: false,
      nextDelayMs: resolveMetaBackgroundLoopDelayMs({
        hasPendingWork: false,
        hasForwardProgress: false,
      }),
    };
  }
  logRuntimeInfo("meta-sync", "meta_consume_started", {
    businessId,
    accountIds: credentials.accountIds,
  });
  const cancelledObsoletePartitions =
    await cancelObsoleteMetaCoreScopePartitions({
      businessId,
      canonicalScope: META_PRODUCT_CORE_PARTITION_SCOPE,
    }).catch(() => []);
  if (cancelledObsoletePartitions.length > 0) {
    logRuntimeInfo("meta-sync", "cancelled_obsolete_core_scope_partitions", {
      businessId,
      cancelledCount: cancelledObsoletePartitions.length,
    });
  }
  await expireStaleMetaSyncJobs({ businessId }).catch(() => null);
  await cleanupMetaPartitionOrchestration({
    businessId,
    staleRunMinutesByLane: {
      core: META_STALE_RUN_CORE_MINUTES,
      maintenance: META_STALE_RUN_MAINTENANCE_MINUTES,
      extended: META_STALE_RUN_EXTENDED_MINUTES,
    },
    runProgressGraceMinutes: META_RUN_PROGRESS_GRACE_MINUTES,
  }).catch(() => null);
  await quarantineMetaTerminalActionRequiredPartitions({ businessId }).catch(
    () => null,
  );
  await requeueMetaRetryableFailedPartitions({ businessId });

  const lockKey = `background:${businessId}`;
  const backgroundSyncKeys = getBackgroundSyncKeys();
  if (backgroundSyncKeys.has(lockKey)) {
    logMetaQueueVisibility("meta_background_sync_already_scheduled", {
      businessId,
      lockKey,
      source: "consume",
    });
    return {
      businessId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
      hasPendingWork: true,
      hasForwardProgress: false,
      nextDelayMs: resolveMetaBackgroundLoopDelayMs({
        hasPendingWork: true,
        hasForwardProgress: false,
      }),
    };
  }

  backgroundSyncKeys.add(lockKey);
  const workerId = input?.runtimeWorkerId ?? getMetaWorkerId();
  try {
    const leaseConflictReason = () =>
      input?.runtimeLeaseGuard?.getLeaseLossReason() ?? "runner_lease_conflict";
    const hasLeaseConflict = () =>
      input?.runtimeLeaseGuard?.isLeaseLost() ?? false;
    await refreshMetaSyncStateForBusiness({ businessId, credentials }).catch(
      () => null,
    );
    const queueHealthBeforeEnqueue = await getMetaQueueHealth({
      businessId,
    }).catch(() => null);
    const stateRowsBeforeLeasing = await Promise.all(
      META_STATE_SCOPES.map((scope) =>
        getMetaSyncState({ businessId, scope }).catch(() => []),
      ),
    ).catch(() => META_STATE_SCOPES.map(() => []));
    const statesByScope = Object.fromEntries(
      META_STATE_SCOPES.map((scope, index) => [
        scope,
        stateRowsBeforeLeasing[index] ?? [],
      ]),
    ) as Record<
      MetaWarehouseScope,
      Awaited<ReturnType<typeof getMetaSyncState>>
    >;
    const laneProgressEvidence = buildMetaLaneProgressEvidence({
      statesByScope,
      queueHealth: queueHealthBeforeEnqueue,
    });
    const queueCompositionBeforeEnqueue = await getMetaQueueComposition({
      businessId,
    }).catch(() => null);
    const queueHealthPayload = {
      businessId,
      queueDepth: queueHealthBeforeEnqueue?.queueDepth ?? 0,
      leasedPartitions: queueHealthBeforeEnqueue?.leasedPartitions ?? 0,
      coreQueueDepth: queueHealthBeforeEnqueue?.coreQueueDepth ?? 0,
      maintenanceQueueDepth:
        queueHealthBeforeEnqueue?.maintenanceQueueDepth ?? 0,
      extendedQueueDepth: queueHealthBeforeEnqueue?.extendedQueueDepth ?? 0,
      historicalCoreQueued:
        queueCompositionBeforeEnqueue?.summary.historicalCoreQueued ?? 0,
      extendedRecentQueued:
        queueCompositionBeforeEnqueue?.summary.extendedRecentQueued ?? 0,
      extendedHistoricalQueued:
        queueCompositionBeforeEnqueue?.summary.extendedHistoricalQueued ?? 0,
    };
    logRuntimeInfo("meta-sync", "meta_consume_queue_health", queueHealthPayload);
    logMetaQueueVisibility("meta_queue_health", queueHealthPayload);
    const hasHistoricalCoreBacklogBeforeEnqueue =
      (queueHealthBeforeEnqueue?.historicalCoreQueueDepth ?? 0) > 0 ||
      (queueHealthBeforeEnqueue?.historicalCoreLeasedPartitions ?? 0) > 0;
    const hasMaintenanceBacklog =
      (queueHealthBeforeEnqueue?.maintenanceQueueDepth ?? 0) > 0 ||
      (queueHealthBeforeEnqueue?.maintenanceLeasedPartitions ?? 0) > 0;

    if (!hasHistoricalCoreBacklogBeforeEnqueue) {
      await enqueueMetaHistoricalCorePartitions(businessId, credentials).catch(
        () => 0,
      );
    }
    if (!hasMaintenanceBacklog) {
      await enqueueMetaMaintenancePartitions(businessId, credentials).catch(
        () => 0,
      );
    }

    if (hasLeaseConflict()) {
      return {
        businessId,
        attempted: 0,
        succeeded: 0,
        failed: 1,
        skipped: false,
        hasPendingWork: true,
        hasForwardProgress: false,
        nextDelayMs: resolveMetaBackgroundLoopDelayMs({
          hasPendingWork: true,
          hasForwardProgress: false,
          hadError: true,
          errorStreak: 1,
        }),
        outcome: "consume_failed_before_leasing",
        failureReason: leaseConflictReason(),
      };
    }

    const leasedMaintenancePartitions = await leaseMetaSyncPartitions({
      businessId,
      lane: "maintenance",
      workerId,
      limit: META_MAINTENANCE_WORKER_LIMIT,
      leaseMinutes: META_PARTITION_LEASE_MINUTES,
    });
    const leasedCorePartitions = await leaseMetaSyncPartitions({
      businessId,
      lane: "core",
      workerId,
      limit: META_CORE_WORKER_LIMIT,
      leaseMinutes: META_PARTITION_LEASE_MINUTES,
    });
    const leasedExtendedPartitions = await leaseMetaSyncPartitions({
      businessId,
      lane: "extended",
      workerId,
      limit: META_EXTENDED_WORKER_LIMIT,
      leaseMinutes: META_PARTITION_LEASE_MINUTES,
    });

    let partitions = [
      ...leasedMaintenancePartitions,
      ...leasedCorePartitions,
      ...leasedExtendedPartitions,
    ];
    logRuntimeInfo("meta-sync", "meta_consume_leased_partitions", {
      businessId,
      maintenanceLeased: leasedMaintenancePartitions.length,
      coreLeased: leasedCorePartitions.length,
      extendedLeased: leasedExtendedPartitions.length,
      totalLeased: partitions.length,
    });
    if (partitions.length === 0) {
      const queueHealth = await getMetaQueueHealth({ businessId }).catch(
        () => null,
      );
      const hasPendingWork =
        (queueHealth?.queueDepth ?? 0) > 0 ||
        (queueHealth?.leasedPartitions ?? 0) > 0 ||
        (queueHealth?.retryableFailedPartitions ?? 0) > 0;
      logRuntimeInfo("meta-sync", "meta_consume_no_partitions", {
        businessId,
        queueDepth: queueHealth?.queueDepth ?? 0,
        leasedPartitions: queueHealth?.leasedPartitions ?? 0,
        hasPendingWork,
      });
      if (
        (queueHealth?.queueDepth ?? 0) > 0 ||
        (queueHealth?.leasedPartitions ?? 0) > 0
      ) {
        const noLeasePayload = {
          businessId,
          workerId,
          queueDepth: queueHealth?.queueDepth ?? 0,
          leasedPartitions: queueHealth?.leasedPartitions ?? 0,
          latestCoreActivityAt: queueHealth?.latestCoreActivityAt ?? null,
          latestMaintenanceActivityAt:
            queueHealth?.latestMaintenanceActivityAt ?? null,
          latestExtendedActivityAt:
            queueHealth?.latestExtendedActivityAt ?? null,
        };
        console.warn("[meta-sync] queue_idle_without_lease", noLeasePayload);
        logMetaQueueVisibility(
          "meta_queue_present_no_runner_lease",
          noLeasePayload,
        );
        logMetaQueueVisibility(
          "meta_runner_lease_not_acquired",
          noLeasePayload,
        );
      }
      return {
        businessId,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: true,
        hasPendingWork,
        hasForwardProgress: false,
        nextDelayMs: resolveMetaBackgroundLoopDelayMs({
          hasPendingWork,
          hasForwardProgress: false,
        }),
      };
    }

    // The batch runner, not a bare loop. `stopBatch` exists precisely so a
    // revocation or a provider stop-loss halts the REST of this worker's leased
    // partitions; the previous loop ignored it and processed all of them, which
    // meant a revoked account still saw every remaining partition attempt and a
    // quota stop-loss kept pushing into the same wall.
    const batch = await runMetaLeasedPartitionBatch({
      partitions,
      beforePartition: () =>
        hasLeaseConflict()
          ? {
              stopReason: "meta_runner_lease_lost",
              countAsFailure: true,
            }
          : null,
      processPartition: (partition) =>
        processMetaPartition({
          credentials,
          partition: {
            id: partition.id,
            businessId: partition.businessId,
            providerAccountId: partition.providerAccountId,
            lane: partition.lane,
            scope: partition.scope,
            partitionDate: partition.partitionDate,
            priority: partition.priority,
            attemptCount: partition.attemptCount,
            leaseEpoch: partition.leaseEpoch ?? 0,
            source: partition.source,
          },
          workerId,
        }),
    });
    let attempted = batch.attempted;
    const succeeded = batch.succeeded;
    const failed = batch.failed;
    if (batch.stopReason) {
      // Whatever this worker still holds must go back to the queue rather than
      // sitting leased until the lease expires. Revoked partitions were already
      // cancelled by the refusal itself, so this only releases the ones that are
      // still legitimately pending.
      const released = await releaseMetaLeasedPartitionsForWorker({
        businessId,
        workerId,
        retryDelayMinutes: batch.retryDelayMinutes,
        lastError: `batch stopped: ${batch.stopReason}`,
      }).catch(() => 0);
      logRuntimeInfo("meta-sync", "meta_consume_batch_stopped", {
        businessId,
        workerId,
        stopReason: batch.stopReason,
        retryDelayMinutes: batch.retryDelayMinutes,
        leasedPartitions: partitions.length,
        attempted: batch.attempted,
        releasedPartitions: released,
      });
    }

    await refreshMetaSyncStateForBusiness({ businessId, credentials }).catch(
      () => null,
    );
    const queueHealthAfterConsume = await getMetaQueueHealth({ businessId }).catch(
      () => null,
    );
    const hasPendingWork =
      (queueHealthAfterConsume?.queueDepth ?? 0) > 0 ||
      (queueHealthAfterConsume?.leasedPartitions ?? 0) > 0 ||
      (queueHealthAfterConsume?.retryableFailedPartitions ?? 0) > 0;
    const hasForwardProgress =
      succeeded > 0 ||
      (queueHealthAfterConsume?.queueDepth ?? 0) <
        (queueHealthBeforeEnqueue?.queueDepth ?? 0);
    const nextDelayMs = resolveMetaBackgroundLoopDelayMs({
      hasPendingWork,
      hasForwardProgress,
      hadError: failed > 0 && succeeded === 0,
      errorStreak: failed > 0 && succeeded === 0 ? 1 : 0,
    });
    logRuntimeInfo("meta-sync", "meta_consume_finished", {
      businessId,
      attempted,
      succeeded,
      failed,
      hasPendingWork,
      hasForwardProgress,
      nextDelayMs,
      queueDepthAfter: queueHealthAfterConsume?.queueDepth ?? 0,
      leasedAfter: queueHealthAfterConsume?.leasedPartitions ?? 0,
    });
    return {
      businessId,
      attempted,
      succeeded,
      failed,
      skipped: attempted === 0,
      hasPendingWork,
      hasForwardProgress,
      nextDelayMs,
      outcome:
        failed > 0 && succeeded === 0
          ? "consume_failed_after_leasing"
          : undefined,
      failureReason:
        failed > 0 && succeeded === 0 ? leaseConflictReason() : null,
    };
  } finally {
    await releaseMetaLeasedPartitionsForWorker({
      businessId,
      workerId,
      lastError: "leased partition released automatically after consumeMetaQueuedWork returned",
    }).catch(() => null);
    backgroundSyncKeys.delete(lockKey);
  }
}

export async function syncMetaReports(
  businessId: string,
  input?: {
    runtimeLeaseGuard?: RunnerLeaseGuard;
    runtimeWorkerId?: string;
  },
): Promise<MetaSyncResult> {
  // Admission BEFORE the first source-related write.
  //
  // This is a real top-level work unit: it reaches a provider, writes warehouse
  // or governance state, or requeues durable work. A refusal escapes unchanged
  // so a caller can tell "we were told not to" from "we tried and failed".
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_report_wrapper", { fresh: true });
  if (process.env.SYNC_WORKER_MODE !== "1") {
    await enqueueMetaScheduledWork(businessId).catch(() => null);
    return { businessId, attempted: 0, succeeded: 0, failed: 0, skipped: true };
  }
  await recoverMetaD1FinalizePartitions({
    businessId,
  }).catch(() => null);
  return consumeMetaQueuedWork(businessId, input);
}

async function enqueueMetaRangeJob(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  triggerSource: string;
  syncType: MetaSyncType;
  lane: MetaSyncLane;
  scopes: MetaWarehouseScope[];
  priority: number;
}) {
  // Every manual range, recent, today, repair and initial path funnels here,
  // and each queues durable work across a date range. Fresh, because a cached
  // admission would authorise a whole backfill wave.
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_enqueue_range_job", { fresh: true });
  const credentials = await resolveMetaCredentials(input.businessId);
  if (!credentials?.accountIds?.length) {
    return {
      businessId: input.businessId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
    };
  }
  const days = enumerateDays(input.startDate, input.endDate, false);
  const primaryAccountId = credentials.accountIds[0] ?? "workspace";
  const syncJobId = await createMetaSyncJob({
    businessId: input.businessId,
    providerAccountId: primaryAccountId,
    syncType: input.syncType,
    scope: input.scopes[0] ?? "account_daily",
    startDate: input.startDate,
    endDate: input.endDate,
    status: "running",
    progressPercent: 5,
    triggerSource: input.triggerSource,
    retryCount: 0,
    lastError: null,
    startedAt: new Date().toISOString(),
  }).catch(() => null);

  const queued = await enqueueMetaDates({
    businessId: input.businessId,
    accountIds: credentials.accountIds,
    dates: days,
    triggerSource: input.triggerSource,
    lane: input.lane,
    scopes: input.scopes,
    priority: input.priority,
  }).catch(() => 0);

  if (syncJobId) {
    await updateMetaSyncJob({
      id: syncJobId,
      status: "succeeded",
      progressPercent: 100,
      finishedAt: new Date().toISOString(),
      lastError: queued === 0 ? "No partitions were queued." : null,
    }).catch(() => null);
  }

  scheduleMetaBackgroundSync({ businessId: input.businessId, delayMs: 0 });
  return {
    businessId: input.businessId,
    attempted: days.length,
    succeeded: queued,
    failed: 0,
    skipped: queued === 0,
  };
}

export async function backfillMetaRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  triggerSource?: string;
  syncType?: MetaSyncType;
}): Promise<MetaSyncResult> {
  // Admission BEFORE the first source-related write.
  //
  // This is a real top-level work unit: it reaches a provider, writes warehouse
  // or governance state, or requeues durable work. A refusal escapes unchanged
  // so a caller can tell "we were told not to" from "we tried and failed".
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_backfill_range", { fresh: true });
  return enqueueMetaRangeJob({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    triggerSource: input.triggerSource ?? "manual_refresh",
    syncType: input.syncType ?? "repair_window",
    lane: input.triggerSource === "priority_window" ? "maintenance" : "core",
    scopes: META_CORE_PARTITION_QUEUE_SCOPES,
    priority: input.triggerSource === "priority_window" ? 90 : 40,
  });
}

export async function syncMetaRecent(
  businessId: string,
): Promise<MetaSyncResult> {
  // Admission BEFORE the first source-related write.
  //
  // This is a real top-level work unit: it reaches a provider, writes warehouse
  // or governance state, or requeues durable work. A refusal escapes unchanged
  // so a caller can tell "we were told not to" from "we tried and failed".
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_sync_recent", { fresh: true });
  const credentials = await resolveMetaCredentials(businessId);
  if (!credentials) {
    return { businessId, attempted: 0, succeeded: 0, failed: 0, skipped: true };
  }
  const { endDate } = getMetaHistoricalWindow(credentials);
  const start = addDays(new Date(`${endDate}T00:00:00Z`), -6);
  return enqueueMetaRangeJob({
    businessId,
    startDate: toIsoDate(start),
    endDate,
    triggerSource: "recent",
    syncType: "incremental_recent",
    lane: "maintenance",
    scopes: META_CORE_PARTITION_QUEUE_SCOPES,
    priority: 20,
  });
}

export async function syncMetaToday(
  businessId: string,
): Promise<MetaSyncResult> {
  // Admission BEFORE the first source-related write.
  //
  // This is a real top-level work unit: it reaches a provider, writes warehouse
  // or governance state, or requeues durable work. A refusal escapes unchanged
  // so a caller can tell "we were told not to" from "we tried and failed".
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_sync_today", { fresh: true });
  const credentials = await resolveMetaCredentials(businessId);
  if (!credentials) {
    return { businessId, attempted: 0, succeeded: 0, failed: 0, skipped: true };
  }
  const today = getMetaReferenceToday(credentials);
  return enqueueMetaRangeJob({
    businessId,
    startDate: today,
    endDate: today,
    triggerSource: "today_observe",
    syncType: "today_observe",
    lane: "maintenance",
    scopes: META_CORE_PARTITION_QUEUE_SCOPES,
    priority: 60,
  });
}

export async function recoverMetaD1FinalizePartitions(input: {
  businessId: string;
  staleLeaseMinutes?: number;
  finalizeSlaMinutes?: number;
}) {
  // The lane, not only capacity. A disabled lane means this work unit must not
  // run at all; a capacity check alone still admits it during a quiesce.
  assertSyncLaneEnabled("meta_sync");
  // Recovery requeues partitions, which is durable work that will write.
  await assertSyncGrowthBoundary("meta_d1_finalize_recovery", { fresh: true });
  await assertDbSchemaReady({
    tables: ["meta_sync_partitions"],
    context: "meta_sync:recover_d1_finalize",
  });
  const sql = getDb();
  const staleThresholdMs = Math.max(1, input.staleLeaseMinutes ?? 8) * 60_000;
  const finalizeSlaMs = Math.max(1, input.finalizeSlaMinutes ?? 20) * 60_000;
  const businessRefId =
    (await resolveBusinessReferenceIds([input.businessId])).get(input.businessId) ??
    null;
  const credentials = await resolveMetaCredentials(input.businessId).catch(() => null);
  const providerAccountBindings = await ensureProviderAccountReferenceBindings({
    provider: "meta",
    accounts: (credentials?.accountIds ?? []).map((providerAccountId) => ({
      externalAccountId: providerAccountId,
      timezone: credentials?.accountProfiles?.[providerAccountId]?.timezone ?? null,
    })),
  });
  const providerAccountRefIds = providerAccountBindings.refIds;
  const accountTargetDates = buildMetaD1AccountTargetDates({
    providerAccountIds: credentials?.accountIds ?? [],
    // The binding returned by the preserve-mode upsert is the calendar
    // authority. The credential profile may be stale or absent and must not
    // reclassify a legitimate provider-local D-1 partition.
    boundAccountTimezones: providerAccountBindings.timezones,
  });
  const targetDates = Array.from(new Set(accountTargetDates.values())).sort();
  const targetDate = targetDates[0] ?? addUtcDays(new Date().toISOString().slice(0, 10), -1);
  const verification = await getMetaPublishedVerificationSummary({
    businessId: input.businessId,
    startDate: targetDate,
    endDate: targetDates[targetDates.length - 1] ?? targetDate,
    providerAccountIds: credentials?.accountIds ?? [],
    surfaces: ["account_daily", "campaign_daily"],
  }).catch(() => null);
  const publishedAccountKeys = new Set(
    verification?.publishedKeysBySurface.account_daily ?? [],
  );
  const publishedCampaignKeys = new Set(
    verification?.publishedKeysBySurface.campaign_daily ?? [],
  );
  const publishedTargetKeys = new Set(
    Array.from(publishedAccountKeys).filter((key) => publishedCampaignKeys.has(key)),
  );
  const candidates = await sql`
    SELECT
      partition.id,
      partition.provider_account_id,
      partition.partition_date::text AS partition_date,
      partition.status,
      partition.updated_at,
      partition.lease_owner,
      partition.lease_expires_at,
      checkpoint.updated_at AS checkpoint_updated_at,
      run.status AS run_status,
      EXISTS (
        SELECT 1
        FROM sync_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.provider_scope = 'meta'
          AND lease.lease_owner = partition.lease_owner
          AND lease.lease_expires_at > now()
      ) AS has_matching_runner_lease
    FROM meta_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT checkpoint.updated_at
      FROM meta_sync_checkpoints checkpoint
      WHERE checkpoint.partition_id = partition.id
        AND COALESCE(checkpoint.lease_epoch, 0) = COALESCE(partition.lease_epoch, 0)
      ORDER BY checkpoint.updated_at DESC
      LIMIT 1
    ) checkpoint ON TRUE
    LEFT JOIN LATERAL (
      SELECT run.status
      FROM meta_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.created_at DESC
      LIMIT 1
    ) run ON TRUE
    WHERE partition.business_id = ${input.businessId}
      AND partition.lane = 'maintenance'
      AND partition.scope = 'account_daily'
      AND partition.source = 'finalize_day'
      AND partition.status IN ('queued', 'leased', 'running')
  ` as Array<{
    id: string;
    provider_account_id: string;
    partition_date: string | Date;
    status: string;
    updated_at: string | Date | null;
    lease_owner: string | null;
    lease_expires_at: string | Date | null;
    checkpoint_updated_at: string | Date | null;
    run_status: string | null;
    has_matching_runner_lease: boolean;
  }>;
  const matchingCandidates = candidates.filter((row) => {
    const providerAccountId = String(row.provider_account_id ?? "");
    const target = accountTargetDates.get(providerAccountId);
    if (!target) return false;
    return normalizeMetaPartitionDate(row.partition_date) === target;
  });
  const pollutedCandidates = candidates.filter((row) => {
    const providerAccountId = String(row.provider_account_id ?? "");
    const target = accountTargetDates.get(providerAccountId);
    if (!target) return false;
    return normalizeMetaPartitionDate(row.partition_date) !== target;
  });
  const alreadyPublishedRows = matchingCandidates.filter((row) =>
    publishedTargetKeys.has(
      `${String(row.provider_account_id)}:${normalizeMetaPartitionDate(row.partition_date)}`,
    ),
  );
  const succeededRunRows = matchingCandidates.filter(
    (row) => row.run_status === "succeeded",
  );
  const alreadyPublishedPartitionIds = alreadyPublishedRows.map((row) => String(row.id));
  const succeededRunPartitionIds = succeededRunRows
    .map((row) => String(row.id))
    .filter((id) => !alreadyPublishedPartitionIds.includes(id));
  const autoSucceededPartitionIds = Array.from(
    new Set([...alreadyPublishedPartitionIds, ...succeededRunPartitionIds]),
  );

  if (autoSucceededPartitionIds.length > 0) {
    await sql`
      UPDATE meta_sync_partitions
      SET
        status = 'succeeded',
        lease_owner = NULL,
        lease_expires_at = NULL,
        finished_at = COALESCE(finished_at, now()),
        business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
        last_error = NULL,
        updated_at = now()
      WHERE id = ANY(${autoSucceededPartitionIds}::uuid[])
    `;
    if (providerAccountRefIds.size > 0) {
      await sql`
        UPDATE meta_sync_partitions AS partition
        SET provider_account_ref_id = provider_account.id
        FROM provider_accounts AS provider_account
        WHERE partition.id = ANY(${autoSucceededPartitionIds}::uuid[])
          AND partition.provider_account_ref_id IS NULL
          AND provider_account.provider = 'meta'
          AND provider_account.external_account_id = partition.provider_account_id
      `;
    }
    await Promise.all(
      [...alreadyPublishedRows, ...succeededRunRows].map((row) =>
        markProviderDayRolloverFinalizeCompleted({
          provider: "meta",
          businessId: input.businessId,
          providerAccountId: String(row.provider_account_id),
          targetDate: normalizeMetaPartitionDate(row.partition_date),
        }).catch(() => null),
      ),
    );
  }

  const nowMs = Date.now();
  const aliveSlowPartitionIds: string[] = [];
  const stalledPartitionIds: string[] = [];

  for (const row of matchingCandidates) {
    if (autoSucceededPartitionIds.includes(String(row.id))) {
      continue;
    }
    const progressMs = parseTimestampMs(row.checkpoint_updated_at);
    const updatedMs = parseTimestampMs(row.updated_at);
    const leaseExpiresMs = parseTimestampMs(row.lease_expires_at);
    const hasRecentProgress =
      progressMs != null && nowMs - progressMs <= staleThresholdMs;
    const hasMatchingRunnerLease = Boolean(row.has_matching_runner_lease);
    const leaseNotExpired = leaseExpiresMs != null && leaseExpiresMs > nowMs;
    const finalizeSlaExceeded =
      updatedMs != null && nowMs - updatedMs > finalizeSlaMs;
    const orphanedLiveLease =
      leaseNotExpired &&
      !hasMatchingRunnerLease &&
      !hasRecentProgress &&
      finalizeSlaExceeded;

    if (hasRecentProgress || hasMatchingRunnerLease) {
      aliveSlowPartitionIds.push(String(row.id));
      continue;
    }
    if (orphanedLiveLease) {
      stalledPartitionIds.push(String(row.id));
      continue;
    }
    stalledPartitionIds.push(String(row.id));
  }
  const pollutedPartitionIds = pollutedCandidates.map((row) => String(row.id));

  let reconciledRunCount = 0;
  const reclaimedPartitionIds = Array.from(
    new Set([...stalledPartitionIds, ...pollutedPartitionIds]),
  );
  if (reclaimedPartitionIds.length > 0) {
    await sql`
      UPDATE meta_sync_partitions
      SET
        status = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        finished_at = COALESCE(finished_at, now()),
        business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
        last_error = CASE
          WHEN id = ANY(${pollutedPartitionIds}::uuid[]) THEN COALESCE(last_error, 'historical finalize_day partition reclassified automatically')
          ELSE COALESCE(last_error, 'stale D-1 finalize lease reclaimed automatically')
        END,
        updated_at = now()
      WHERE id = ANY(${reclaimedPartitionIds}::uuid[])
    `;
    if (providerAccountRefIds.size > 0) {
      await sql`
        UPDATE meta_sync_partitions AS partition
        SET provider_account_ref_id = provider_account.id
        FROM provider_accounts AS provider_account
        WHERE partition.id = ANY(${reclaimedPartitionIds}::uuid[])
          AND partition.provider_account_ref_id IS NULL
          AND provider_account.provider = 'meta'
          AND provider_account.external_account_id = partition.provider_account_id
      `;
    }
    const reconciledRuns = await sql`
      UPDATE meta_sync_runs run
      SET
        business_ref_id = COALESCE(run.business_ref_id, ${businessRefId}),
        provider_account_ref_id = COALESCE(
          run.provider_account_ref_id,
          provider_account.id
        ),
        status = 'cancelled',
        error_class = CASE
          WHEN run.partition_id = ANY(${pollutedPartitionIds}::uuid[]) THEN COALESCE(error_class, 'historical_finalize_reclassified')
          ELSE COALESCE(error_class, 'stale_d1_finalize')
        END,
        error_message = CASE
          WHEN run.partition_id = ANY(${pollutedPartitionIds}::uuid[]) THEN COALESCE(error_message, 'historical finalize_day run reclassified automatically')
          ELSE COALESCE(error_message, 'stale D-1 finalize run closed automatically')
        END,
        finished_at = COALESCE(run.finished_at, now()),
        duration_ms = COALESCE(
          duration_ms,
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(run.started_at, run.created_at))) * 1000))::int
        ),
        meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
          'decisionCaller', 'recoverMetaD1FinalizePartitions',
          'closureReason', CASE
            WHEN run.partition_id = ANY(${pollutedPartitionIds}::uuid[]) THEN 'historical_finalize_reclassified'
            ELSE 'stale_d1_finalize_reclaimed'
          END
        ),
        updated_at = now()
      FROM meta_sync_partitions partition
      LEFT JOIN provider_accounts provider_account
        ON provider_account.provider = 'meta'
        AND provider_account.external_account_id = partition.provider_account_id
      WHERE run.partition_id = partition.id
        AND run.business_id = ${input.businessId}
        AND run.partition_id = ANY(${reclaimedPartitionIds}::uuid[])
        AND run.status = 'running'
      RETURNING run.id
    ` as Array<{ id: string }>;
    reconciledRunCount = reconciledRuns.length;
    await recordSyncReclaimEvents({
      providerScope: "meta",
      businessId: input.businessId,
      partitionIds: reclaimedPartitionIds,
      eventType: "reclaimed",
      disposition: "stalled_reclaimable",
      reasonCode:
        pollutedPartitionIds.length > 0 && stalledPartitionIds.length === 0
          ? "historical_finalize_misclassified"
          : "lease_expired_no_progress",
      detail:
        pollutedPartitionIds.length > 0
          ? "Historical finalize_day partitions were reclassified automatically."
          : "Stale D-1 finalize partition reclaimed automatically.",
    }).catch(() => null);
  }

  const requeueDates = Array.from(
    new Set([
      ...stalledPartitionIds
        .map((partitionId) =>
          matchingCandidates.find((candidate) => String(candidate.id) === partitionId),
        )
        .filter((candidate): candidate is (typeof matchingCandidates)[number] => Boolean(candidate))
        .map((candidate) => normalizeMetaPartitionDate(candidate.partition_date)),
      ...pollutedCandidates.map((candidate) =>
        normalizeMetaPartitionDate(candidate.partition_date),
      ),
    ]),
  ).sort();
  const requeueResult =
    requeueDates.length > 0
      ? await Promise.all(
          requeueDates.map((date) => {
            const isTargetDate = targetDates.includes(date);
            return syncMetaRepairRange({
              businessId: input.businessId,
              startDate: date,
              endDate: date,
              triggerSource: isTargetDate ? "finalize_day" : "repair_recent_day",
            }).catch(() => null);
          }),
        )
      : null;

  return {
    businessId: input.businessId,
    targetDate,
    targetDates,
    candidateCount: matchingCandidates.length,
    historicalFinalizePollutionCount: pollutedCandidates.length,
    aliveSlowCount: aliveSlowPartitionIds.length,
    stalledReclaimableCount: stalledPartitionIds.length,
    reclaimedPartitionIds,
    reconciledRunCount,
    d1FinalizeRecoveryQueued:
      Array.isArray(requeueResult) ? requeueResult.some((row) => Boolean(row)) : Boolean(requeueResult),
    d1FinalizeRecoveredCount: stalledPartitionIds.length,
    d1FinalizeForceReclaimedCount: stalledPartitionIds.length,
    requeueResult,
  };
}

export async function syncMetaRepairRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  triggerSource?: MetaSyncPartitionSource;
}): Promise<MetaSyncResult> {
  // Admission BEFORE the first source-related write. D1 recovery requeues
  // durable work and drives repair ranges that call the provider.
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_d1_finalize_recovery", { fresh: true });
  // Admission BEFORE the first source-related write.
  //
  // This is a real top-level work unit: it reaches a provider, writes warehouse
  // or governance state, or requeues durable work. A refusal escapes unchanged
  // so a caller can tell "we were told not to" from "we tried and failed".
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_repair_range", { fresh: true });
  return enqueueMetaRangeJob({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    triggerSource:
      input.triggerSource ??
      (input.startDate === input.endDate ? "finalize_day" : "priority_window"),
    syncType:
      input.startDate === input.endDate ? "finalize_range" : "repair_window",
    lane: "maintenance",
    scopes: META_CORE_PARTITION_QUEUE_SCOPES,
    priority: 90,
  });
}

export async function syncMetaInitial(
  businessId: string,
): Promise<MetaSyncResult> {
  // Admission BEFORE the first source-related write.
  //
  // This is a real top-level work unit: it reaches a provider, writes warehouse
  // or governance state, or requeues durable work. A refusal escapes unchanged
  // so a caller can tell "we were told not to" from "we tried and failed".
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_initial_sync", { fresh: true });
  const credentials = await resolveMetaCredentials(businessId).catch(() => null);
  if (!credentials?.accountIds?.length) {
    return {
      businessId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
    };
  }

  let queued = 0;
  for (const providerAccountId of credentials.accountIds) {
    const accountTimezone =
      credentials.accountProfiles?.[providerAccountId]?.timezone ?? "UTC";
    const today = getTodayIsoForTimeZoneServer(accountTimezone);
    const d1 = toIsoDate(addDays(new Date(`${today}T00:00:00Z`), -1));
    const existingDayStates = buildMetaAuthoritativeDayStateMap(
      await listMetaAuthoritativeDayStates({
        businessId,
        providerAccountId,
        startDay: d1,
        endDay: d1,
      }).catch(() => []),
    );
    await seedMetaAuthoritativePlannerDayStates({
      businessId,
      providerAccountId,
      day: d1,
      referenceToday: today,
      accountTimezone,
      existingStates: existingDayStates.get(d1) ?? null,
    }).catch(() => []);
    queued += await enqueueMetaDates({
      businessId,
      accountIds: [providerAccountId],
      dates: [d1],
      triggerSource: "yesterday",
      lane: "maintenance",
      scopes: META_CORE_PARTITION_QUEUE_SCOPES,
      priority: 70,
    });
  }

  return {
    businessId,
    attempted: queued,
    succeeded: queued,
    failed: 0,
    skipped: queued === 0,
  };
}

export async function ensureMetaWarehouseRangeFilled(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}): Promise<MetaSyncResult | null> {
  // Admission BEFORE the first source-related write.
  //
  // This is a real top-level work unit: it reaches a provider, writes warehouse
  // or governance state, or requeues durable work. A refusal escapes unchanged
  // so a caller can tell "we were told not to" from "we tried and failed".
  assertSyncLaneEnabled("meta_sync");
  await assertSyncGrowthBoundary("meta_ensure_range", { fresh: true });
  const completion = await getMetaWarehouseWindowCompletion({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
  }).catch(() => null);
  if (completion?.complete) return null;
  return syncMetaRepairRange(input);
}

export async function runMetaMaintenanceSync(businessId: string) {
  const result = await enqueueMetaScheduledWork(businessId);
  if (canUseInProcessBackgroundScheduling()) {
    scheduleMetaBackgroundSync({ businessId, delayMs: 0 });
  }
  return result;
}

export async function refreshMetaSyncStateAndQueue(businessId: string) {
  await refreshMetaSyncStateForBusiness({ businessId });
  return getMetaQueueHealth({ businessId });
}

export async function replayMetaDeadLettersAndResume(input: {
  businessId: string;
  scope?: MetaWarehouseScope | null;
}) {
  const replayed = await replayMetaDeadLetterPartitions({
    ...input,
    recoveryKinds: ["replayable_transient"],
  });
  scheduleMetaBackgroundSync({ businessId: input.businessId, delayMs: 0 });
  return replayed;
}

export async function getMetaSelectedRangeState(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  const [completion, queueHealth, latestSync, states, truthReadiness] = await Promise.all([
    getMetaWarehouseWindowCompletion(input).catch(() => null),
    getMetaQueueHealth({ businessId: input.businessId }).catch(() => null),
    getLatestMetaSyncHealth({
      businessId: input.businessId,
      providerAccountId: null,
    }).catch(() => null),
    Promise.all(
      META_STATE_SCOPES.map((scope) =>
        getMetaSyncState({
          businessId: input.businessId,
          scope,
        }).catch(() => []),
      ),
    ),
    getMetaSelectedRangeTruthReadiness(input).catch(() => null),
  ]);
  return { completion, queueHealth, latestSync, states, truthReadiness };
}
