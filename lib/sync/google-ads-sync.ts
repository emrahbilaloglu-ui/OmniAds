import {
  getGoogleAdsAdsReport,
  getGoogleAdsAssetGroupsReport,
  getGoogleAdsAssetsReport,
  getGoogleAdsAudiencesReport,
  getGoogleAdsCampaignsReport,
  getGoogleAdsDevicesReport,
  getGoogleAdsGeoReport,
  getGoogleAdsKeywordsReport,
  getGoogleAdsProductsReport,
  getGoogleAdsSearchIntelligenceReport,
} from "@/lib/google-ads/reporting";
import type { GoogleAdsReportMeta } from "@/lib/google-ads/normalizers";
import { buildGoogleAdsQueryHash, normalizeGoogleAdsQueryText, persistGoogleAdsSearchIntelligenceFoundation } from "@/lib/google-ads/search-intelligence-storage";
import { GOOGLE_ADS_CAMPAIGN_CORE_LIMIT, buildCustomerSummaryQuery } from "@/lib/google-ads/query-builders";
import {
  aggregateOverviewKpis,
  resolveContext,
  runNamedQuery,
} from "@/lib/google-ads/reporting-core";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import { getConnectedAssignedGoogleAccounts } from "@/lib/google-ads-gaql";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  clearProviderGlobalCircuitBreaker,
  clearProviderGlobalCircuitBreakerRecoveryState,
  enterProviderGlobalCircuitBreakerRecoveryState,
  getProviderCircuitBreakerRecoveryState,
  getProviderGlobalCircuitBreaker,
  getProviderQuotaBudgetState,
  openProviderGlobalCircuitBreaker,
  ProviderRequestCooldownError,
} from "@/lib/provider-request-governance";
import {
  getProviderWorkerHealthState,
  recordSyncReclaimEvents,
} from "@/lib/sync/worker-health";
import type { RunnerLeaseGuard } from "@/lib/sync/worker-runtime";
import type { ProviderReplayReasonCode } from "@/lib/sync/provider-orchestration";
import {
  buildProviderProgressEvidence,
  deriveProviderStallFingerprints,
  getActivePartitionBlockingStatuses,
  hasRecentProviderAdvancement,
  type ProviderLeasePlan,
  type ProviderProgressEvidence,
  type ProviderProgressEvidenceStateRow,
} from "@/lib/sync/provider-status-truth";
import {
  classifyGoogleAdsSyncFailure,
  shouldDeadLetterGoogleAdsFailure,
} from "@/lib/sync/google-ads-error-classification";
import {
  buildGoogleAdsRawSnapshotHash,
  backfillGoogleAdsRunningCheckpointsForTerminalPartition,
  backfillGoogleAdsRunningRunsForTerminalPartition,
  compactGoogleAdsExtendedBacklog,
  cleanupGoogleAdsObsoleteSyncJobs,
  cleanupGoogleAdsPartitionOrchestration,
  cancelGoogleAdsPartitionsBySource,
  completeGoogleAdsPartitionAttempt,
  createGoogleAdsSyncJob,
  createGoogleAdsSyncRun,
  expireStaleGoogleAdsSyncJobs,
  getGoogleAdsCoveredDates,
  getGoogleAdsDailyCoverage,
  getGoogleAdsPartitionCompletionDenialSnapshot,
  getGoogleAdsPartitionHealth,
  getGoogleAdsPartitionDates,
  getGoogleAdsQueueHealth,
  getGoogleAdsWarehouseIntegrityIncidents,
  hasRecentGoogleAdsTerminalActionRequiredDeadLetter,
  getLatestGoogleAdsCheckpointForPartition,
  getLatestRunningGoogleAdsSyncRunIdForPartition,
  getGoogleAdsSyncState,
  getGoogleAdsSyncCheckpoint,
  leaseGoogleAdsSyncPartitions,
  listGoogleAdsRawSnapshotsForPartition,
  persistGoogleAdsRawSnapshot,
  queueGoogleAdsSyncPartition,
  heartbeatGoogleAdsPartitionLease,
  releaseGoogleAdsLeasedPartitionsForWorker,
  upsertGoogleAdsSyncState,
  upsertGoogleAdsSyncCheckpoint,
  updateGoogleAdsSyncRun,
  updateGoogleAdsSyncJob,
  upsertGoogleAdsDailyRows,
  markGoogleAdsPartitionRunning,
} from "@/lib/google-ads/warehouse";
import {
  GOOGLE_ADS_WAREHOUSE_HISTORY_DAYS,
  addDaysToIsoDate,
  dayCountInclusive,
  enumerateDays,
  getHistoricalWindowStart,
} from "@/lib/google-ads/history";
import type {
  GoogleAdsSyncCheckpointRecord,
  GoogleAdsSyncLane,
  GoogleAdsSyncType,
  GoogleAdsWarehouseDailyRow,
  GoogleAdsWarehouseScope,
} from "@/lib/google-ads/warehouse-types";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import {
  ensureProviderAccountReferenceIds,
  resolveBusinessReferenceIds,
} from "@/lib/provider-account-reference-store";
import {
  getProviderPlatformCurrentDate,
} from "@/lib/provider-platform-date";
import {
  markProviderDayRolloverFinalizeCompleted,
  markProviderDayRolloverFinalizeStarted,
  markProviderDayRolloverRecovered,
  syncProviderDayRolloverState,
} from "@/lib/sync/provider-day-rollover";
import { logRuntimeInfo } from "@/lib/runtime-logging";

type GenericRow = Record<string, unknown>;
type GoogleAdsWarehouseReportLike = {
  rows?: unknown[];
  meta?: Pick<
    GoogleAdsReportMeta,
    "failed_queries" | "query_names" | "row_counts"
  > | null;
};

const runtimeSyncStore = globalThis as typeof globalThis & {
  __googleAdsBackgroundSyncKeys?: Set<string>;
  __googleAdsBackgroundWorkerTimers?: Map<
    string,
    ReturnType<typeof setTimeout>
  >;
};

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

function getBackgroundSyncKeys() {
  if (!runtimeSyncStore.__googleAdsBackgroundSyncKeys) {
    runtimeSyncStore.__googleAdsBackgroundSyncKeys = new Set<string>();
  }
  return runtimeSyncStore.__googleAdsBackgroundSyncKeys;
}

function getBackgroundWorkerTimers() {
  if (!runtimeSyncStore.__googleAdsBackgroundWorkerTimers) {
    runtimeSyncStore.__googleAdsBackgroundWorkerTimers = new Map();
  }
  return runtimeSyncStore.__googleAdsBackgroundWorkerTimers;
}

const GOOGLE_ADS_BOOTSTRAP_BATCH_DAYS = 4;
const GOOGLE_ADS_RECENT_MAINTENANCE_DAYS = 7;
const GOOGLE_ADS_D1_FINALIZE_PRIORITY = 120;
const GOOGLE_ADS_D1_FINALIZE_SCOPES: GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
];
const GOOGLE_ADS_BACKGROUND_LOOP_DELAY_MS = envNumber(
  "GOOGLE_ADS_BACKGROUND_LOOP_DELAY_MS",
  3_000,
);
const GOOGLE_ADS_CORE_WORKER_LIMIT = envNumber(
  "GOOGLE_ADS_CORE_WORKER_LIMIT",
  4,
);
const GOOGLE_ADS_MAINTENANCE_WORKER_LIMIT = envNumber(
  "GOOGLE_ADS_MAINTENANCE_WORKER_LIMIT",
  2,
);
const GOOGLE_ADS_EXTENDED_WORKER_LIMIT = envNumber(
  "GOOGLE_ADS_EXTENDED_WORKER_LIMIT",
  6,
);
const GOOGLE_ADS_EXTENDED_BURST_WORKER_LIMIT = envNumber(
  "GOOGLE_ADS_EXTENDED_BURST_WORKER_LIMIT",
  3,
);
const GOOGLE_ADS_EXTENDED_FULL_SYNC_PRIORITY_LIMIT = envNumber(
  "GOOGLE_ADS_EXTENDED_FULL_SYNC_PRIORITY_LIMIT",
  3,
);
const GOOGLE_ADS_EXTENDED_CORE_BACKLOG_THRESHOLD = envNumber(
  "GOOGLE_ADS_EXTENDED_CORE_BACKLOG_THRESHOLD",
  2,
);
const GOOGLE_ADS_PRIORITY_BACKLOG_LEASE_LIMIT = envNumber(
  "GOOGLE_ADS_PRIORITY_BACKLOG_LEASE_LIMIT",
  6,
);
const GOOGLE_ADS_FORWARD_PROGRESS_LEASE_LIMIT = envNumber(
  "GOOGLE_ADS_FORWARD_PROGRESS_LEASE_LIMIT",
  4,
);
const GOOGLE_ADS_PRODUCTIVE_LEASE_LIMIT = envNumber(
  "GOOGLE_ADS_PRODUCTIVE_LEASE_LIMIT",
  8,
);

export function getGoogleAdsGapPlannerBlockingStatuses() {
  return getActivePartitionBlockingStatuses();
}

export function canReuseExistingGoogleAdsSyncJob(input: {
  syncType: GoogleAdsSyncType;
  triggerSource: string;
}) {
  return (
    input.syncType === "repair_window" ||
    input.triggerSource.startsWith("manual_targeted_repair:") ||
    input.triggerSource.startsWith("repair_recent_")
  );
}

function parseTimestampMs(value: unknown) {
  if (!value) return null;
  const parsed = value instanceof Date ? value : new Date(String(value));
  const ms = parsed.getTime();
  return Number.isFinite(ms) ? ms : null;
}
const GOOGLE_ADS_PARTITION_LEASE_MINUTES = envNumber(
  "GOOGLE_ADS_PARTITION_LEASE_MINUTES",
  15,
);
const GOOGLE_ADS_TRANSIENT_RETRY_BASE_MINUTES = envNumber(
  "GOOGLE_ADS_TRANSIENT_RETRY_BASE_MINUTES",
  2,
);
const GOOGLE_ADS_QUOTA_RETRY_BASE_MINUTES = envNumber(
  "GOOGLE_ADS_QUOTA_RETRY_BASE_MINUTES",
  8,
);
const GOOGLE_ADS_PARTITION_MAX_ATTEMPTS = 6;
const GOOGLE_ADS_CHECKPOINT_CHUNK_SIZE = envNumber(
  "GOOGLE_ADS_CHECKPOINT_CHUNK_SIZE",
  250,
);
const GOOGLE_ADS_CAMPAIGN_CHECKPOINT_CHUNK_SIZE = Math.min(
  GOOGLE_ADS_CHECKPOINT_CHUNK_SIZE,
  envNumber("GOOGLE_ADS_CAMPAIGN_CHECKPOINT_CHUNK_SIZE", 150),
);
const GOOGLE_ADS_GEO_CHECKPOINT_CHUNK_SIZE = Math.min(
  GOOGLE_ADS_CHECKPOINT_CHUNK_SIZE,
  envNumber("GOOGLE_ADS_GEO_CHECKPOINT_CHUNK_SIZE", 125),
);
const GOOGLE_ADS_PRODUCT_CHECKPOINT_CHUNK_SIZE = envNumber(
  "GOOGLE_ADS_PRODUCT_CHECKPOINT_CHUNK_SIZE",
  1_000,
);
const GOOGLE_ADS_CAMPAIGN_CORE_LIMIT_ERROR_CODE =
  "google_ads_campaign_core_limit_exceeded";
class GoogleAdsRetryableSyncError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "GoogleAdsRetryableSyncError";
  }
}

class GoogleAdsScopeActionRequiredError extends Error {
  constructor(input: { scope: GoogleAdsWarehouseScope }) {
    super(
      `google_ads_scope_action_required: ${input.scope} sync is paused because this Google Ads account recently returned a terminal access failure for the same surface.`,
    );
    this.name = "GoogleAdsScopeActionRequiredError";
  }
}
const GOOGLE_ADS_CIRCUIT_BREAKER_BASE_MINUTES = envNumber(
  "GOOGLE_ADS_CIRCUIT_BREAKER_BASE_MINUTES",
  15,
);
const GOOGLE_ADS_CIRCUIT_BREAKER_REPEAT_MINUTES = envNumber(
  "GOOGLE_ADS_CIRCUIT_BREAKER_REPEAT_MINUTES",
  30,
);

export function getGoogleAdsScopeCheckpointChunkSize(
  scope: GoogleAdsWarehouseScope,
) {
  if (scope === "campaign_daily")
    return GOOGLE_ADS_CAMPAIGN_CHECKPOINT_CHUNK_SIZE;
  if (scope === "geo_daily") return GOOGLE_ADS_GEO_CHECKPOINT_CHUNK_SIZE;
  if (scope === "product_daily")
    return GOOGLE_ADS_PRODUCT_CHECKPOINT_CHUNK_SIZE;
  return GOOGLE_ADS_CHECKPOINT_CHUNK_SIZE;
}

type GoogleAdsPhaseTelemetry = {
  businessId: string;
  providerAccountId: string;
  date: string;
  primaryScope: GoogleAdsWarehouseScope;
  fetchMs: number;
  transformMs: number;
  persistMs: number;
  finalizeMs: number;
  totalMs: number;
  scopeMetrics: Array<{
    scope: GoogleAdsWarehouseScope;
    rowCount: number;
    batchCount: number;
    chunkSize: number;
    persistedRowCount: number;
    durationMs: number;
  }>;
};

export function logGoogleAdsPhaseTelemetry(input: GoogleAdsPhaseTelemetry) {
  logRuntimeInfo("google-ads-sync", "google_ads_scope_phase_metrics", input);
}

function logGoogleAdsPersistChunkTelemetry(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  scope: GoogleAdsWarehouseScope;
  partitionId?: string | null;
  pageIndex: number;
  rowCount: number;
  hashMs: number;
  checkpointMs: number;
  rawSnapshotMs: number;
  transformMs: number;
  warehouseUpsertMs: number;
  totalMs: number;
}) {
  if (input.scope !== "product_daily" && input.totalMs < 5_000) return;
  logRuntimeInfo("google-ads-sync", "google_ads_persist_chunk_metrics", input);
}

type GoogleAdsLeaseStepLog = {
  businessId: string;
  step:
    | "core"
    | "historical_fairness"
    | "recent_repair"
    | "full_sync_priority"
    | "maintenance"
    | "fallback_extended";
  limit: number;
  lane: GoogleAdsSyncLane;
  sourceFilter?: "all" | "recent_only" | "historical_only";
  scopeFilter?: GoogleAdsWarehouseScope[];
  excludedScopeFilter?: GoogleAdsWarehouseScope[];
  startDate?: string | null;
  endDate?: string | null;
  leasedCount: number;
  queueHealth?: {
    coreQueueDepth?: number;
    maintenanceQueueDepth?: number;
    leasedPartitions?: number;
  } | null;
  fullSyncPriorityRequired: boolean;
  historicalLeaseStartDate?: string | null;
  policy?: {
    suspendMaintenance?: boolean;
    suspendExtended?: boolean;
  } | null;
  budgetState?: {
    pressure?: number | null;
    maintenanceAllowed?: boolean | null;
    extendedAllowed?: boolean | null;
  } | null;
};

export function logGoogleAdsLeaseStepResult(input: GoogleAdsLeaseStepLog) {
  logRuntimeInfo("google-ads-sync", "google_ads_lease_step_result", input);
}

export type GoogleAdsLeaseableBacklogClassification =
  | "leaseable_now"
  | "suspended_maintenance"
  | "outside_frontier"
  | "retry_cooldown";

export type GoogleAdsQueuedCampaignDailyPartition = {
  lane: GoogleAdsSyncLane;
  partitionDate: string | null;
  nextRetryAt: string | null;
};

export function classifyGoogleAdsQueuedCampaignDailyPartition(input: {
  row: GoogleAdsQueuedCampaignDailyPartition;
  frontierStart: string | null;
  suspendMaintenance: boolean;
  now?: Date;
}): GoogleAdsLeaseableBacklogClassification {
  const nowIso = (input.now ?? new Date()).toISOString();
  if (input.row.nextRetryAt && input.row.nextRetryAt > nowIso) {
    return "retry_cooldown";
  }

  if (
    input.row.lane === "core" &&
    input.frontierStart &&
    input.row.partitionDate &&
    input.row.partitionDate < input.frontierStart
  ) {
    return "outside_frontier";
  }

  if (input.row.lane === "maintenance" && input.suspendMaintenance) {
    return "suspended_maintenance";
  }

  return "leaseable_now";
}
const GOOGLE_ADS_WORKER_STALE_THRESHOLD_MS = envNumber(
  "GOOGLE_ADS_WORKER_STALE_THRESHOLD_MS",
  5 * 60_000,
);
const GOOGLE_ADS_RUN_PROGRESS_GRACE_MINUTES = envNumber(
  "GOOGLE_ADS_RUN_PROGRESS_GRACE_MINUTES",
  3,
);
const GOOGLE_ADS_STALE_RUN_CORE_MINUTES = envNumber(
  "GOOGLE_ADS_STALE_RUN_CORE_MINUTES",
  12,
);
const GOOGLE_ADS_STALE_RUN_MAINTENANCE_MINUTES = envNumber(
  "GOOGLE_ADS_STALE_RUN_MAINTENANCE_MINUTES",
  15,
);
const GOOGLE_ADS_STALE_RUN_EXTENDED_MINUTES = envNumber(
  "GOOGLE_ADS_STALE_RUN_EXTENDED_MINUTES",
  25,
);
const GOOGLE_ADS_EXTENDED_BACKLOG_HARD_LIMIT = envNumber(
  "GOOGLE_ADS_EXTENDED_BACKLOG_HARD_LIMIT",
  1000,
);
const GOOGLE_ADS_MAINTENANCE_BACKLOG_HARD_LIMIT = envNumber(
  "GOOGLE_ADS_MAINTENANCE_BACKLOG_HARD_LIMIT",
  250,
);
const GOOGLE_ADS_EXTENDED_CANARY_BURST_WORKER_LIMIT = envNumber(
  "GOOGLE_ADS_EXTENDED_CANARY_BURST_WORKER_LIMIT",
  2,
);
const GOOGLE_ADS_RECENT_REPAIR_WORKER_LIMIT = envNumber(
  "GOOGLE_ADS_RECENT_REPAIR_WORKER_LIMIT",
  2,
);
const GOOGLE_ADS_RECENT_EXTENDED_RECOVERY_DAYS = envNumber(
  "GOOGLE_ADS_RECENT_EXTENDED_RECOVERY_DAYS",
  84,
);
const GOOGLE_ADS_EXTENDED_RECENT_BATCH_DAYS = envNumber(
  "GOOGLE_ADS_EXTENDED_RECENT_BATCH_DAYS",
  6,
);
const GOOGLE_ADS_EXTENDED_HISTORICAL_BATCH_DAYS = envNumber(
  "GOOGLE_ADS_EXTENDED_HISTORICAL_BATCH_DAYS",
  3,
);
const GOOGLE_ADS_EXTENDED_HISTORICAL_PRESSURE_LIMIT = Number(
  process.env.GOOGLE_ADS_EXTENDED_HISTORICAL_PRESSURE_LIMIT ?? "0.7",
);
const GOOGLE_ADS_EXTENDED_REOPEN_GENERAL_ENABLED =
  process.env.GOOGLE_ADS_EXTENDED_GENERAL_REOPEN?.trim().toLowerCase() ===
    "1" ||
  process.env.GOOGLE_ADS_EXTENDED_GENERAL_REOPEN?.trim().toLowerCase() ===
    "true";
const GOOGLE_ADS_IN_PROCESS_RUNTIME_ENABLED =
  process.env.GOOGLE_ADS_ENABLE_IN_PROCESS_RUNTIME?.trim().toLowerCase() ===
    "1" ||
  process.env.GOOGLE_ADS_ENABLE_IN_PROCESS_RUNTIME?.trim().toLowerCase() ===
    "true";
const GOOGLE_ADS_PROGRESS_EVIDENCE_WINDOW_MINUTES = envNumber(
  "GOOGLE_ADS_PROGRESS_EVIDENCE_WINDOW_MINUTES",
  20,
);

type GoogleAdsQueueHealth = Awaited<ReturnType<typeof getGoogleAdsQueueHealth>>;
type GoogleAdsLaneEvidence = Record<
  "core" | "extended_recent" | "extended_historical" | "maintenance",
  ProviderProgressEvidence
>;
type GoogleAdsStatesByScope = Partial<
  Record<GoogleAdsWarehouseScope, ProviderProgressEvidenceStateRow[]>
>;

export interface GoogleAdsPrimaryLeasePlan {
  historicalFairnessLimit: number;
  recentRepairLimit: number;
  fullSyncPriorityLimit: number;
}

export interface GoogleAdsMaintenanceLeasePlan {
  maintenanceLimit: number;
}

export interface GoogleAdsFallbackExtendedLeasePlan {
  sourceFilter: "recent_only" | "historical_only" | "all";
  limit: number;
  scopeFilter?: GoogleAdsWarehouseScope[];
  startDate: string | null;
  endDate: string | null;
  onlyIfNoLease?: boolean;
}

function parseEnvList(name: string) {
  const raw = process.env[name];
  if (!raw) return [];
  return raw
    .split(",")
    .map((part) => part.trim())
    .filter(Boolean);
}

async function upsertGoogleAdsCheckpointOrThrow(
  input: GoogleAdsSyncCheckpointRecord,
) {
  const checkpointId = await upsertGoogleAdsSyncCheckpoint(input);
  if (input.leaseOwner && !checkpointId) {
    throw new Error("lease_conflict:checkpoint_write_rejected");
  }
  return checkpointId;
}

async function heartbeatGoogleAdsPartitionBeforeCompletion(input: {
  partitionId: string;
  workerId: string;
  leaseEpoch: number;
  leaseMinutes: number;
}) {
  const ok = await heartbeatGoogleAdsPartitionLease({
    partitionId: input.partitionId,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch,
    leaseMinutes: input.leaseMinutes,
  });
  return ok
    ? ({ ok: true } as const)
    : ({ ok: false, reason: "lease_conflict" } as const);
}

async function logGoogleAdsCompletionDenied(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch: number;
  lane: GoogleAdsSyncLane;
  scope: GoogleAdsWarehouseScope;
  partitionStatus: "succeeded" | "failed" | "dead_letter" | "cancelled";
  runStatus: "succeeded" | "failed" | "cancelled";
  reason: "lease_conflict" | "operational_error";
  message?: string | null;
}) {
  const [latestCheckpoint, denialSnapshot] = await Promise.all([
    getLatestGoogleAdsCheckpointForPartition({
      partitionId: input.partitionId,
    }).catch(() => null),
    getGoogleAdsPartitionCompletionDenialSnapshot({
      partitionId: input.partitionId,
      workerId: input.workerId,
      leaseEpoch: input.leaseEpoch,
    }).catch(() => null),
  ]);

  console.warn("[google-ads-sync] partition_completion_denied", {
    partitionId: input.partitionId,
    runId: input.runId ?? null,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.workerId,
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

function isGoogleAdsTerminalSuccessDenial(
  denialSnapshot: Awaited<
    ReturnType<typeof getGoogleAdsPartitionCompletionDenialSnapshot>
  > | null,
) {
  return (
    denialSnapshot?.denialClassification === "already_terminal" &&
    denialSnapshot.currentPartitionStatus === "succeeded"
  );
}

async function backfillGoogleAdsDeniedTerminalChildren(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch?: number | null;
  lane: GoogleAdsSyncLane;
  scope: GoogleAdsWarehouseScope;
  pathKind: "primary" | "repair";
}) {
  try {
    const [runResult, checkpointResult] = await Promise.all([
      backfillGoogleAdsRunningRunsForTerminalPartition({
        partitionId: input.partitionId,
        runId: input.runId ?? null,
        recoveredRunId: input.recoveredRunId ?? null,
      }),
      backfillGoogleAdsRunningCheckpointsForTerminalPartition({
        partitionId: input.partitionId,
      }),
    ]);
    console.warn("[google-ads-sync] terminal_parent_children_backfilled", {
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
      workerId: input.workerId,
      lane: input.lane,
      scope: input.scope,
      pathKind: input.pathKind,
      partitionStatus: runResult.partitionStatus,
      closedRunningRunCount: runResult.closedRunningRunCount,
      closedRunningCheckpointCount:
        checkpointResult.closedRunningCheckpointCount,
      closedCheckpointGroups: checkpointResult.closedCheckpointGroups,
    });
  } catch (error) {
    console.warn("[google-ads-sync] terminal_parent_children_backfill_failed", {
      partitionId: input.partitionId,
      runId: input.runId ?? null,
      recoveredRunId: input.recoveredRunId ?? null,
      workerId: input.workerId,
      lane: input.lane,
      scope: input.scope,
      pathKind: input.pathKind,
      message: error instanceof Error ? error.message : String(error),
    });
  }
}

export function logGoogleAdsCompletionOutcome(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch?: number | null;
  lane: GoogleAdsSyncLane;
  scope: GoogleAdsWarehouseScope;
  partitionStatus: "succeeded" | "failed" | "dead_letter" | "cancelled";
  outcome:
    | {
        ok: true;
        closedRunningRunCount: number;
        callerRunIdWasClosed: boolean | null;
      }
    | {
        ok: false;
        reason: string;
      };
  denialClassification?: string | null;
}) {
  const shouldFailureBackfill =
    !input.outcome.ok &&
    (input.denialClassification ?? null) === "already_terminal";

  console.warn("[google-ads-sync] google_ads_completion_outcome", {
    partitionId: input.partitionId,
    runId: input.runId ?? null,
    recoveredRunId: input.recoveredRunId ?? null,
    workerId: input.workerId,
    leaseEpoch: input.leaseEpoch ?? null,
    lane: input.lane,
    scope: input.scope,
    partitionStatus: input.partitionStatus,
    ok: input.outcome.ok,
    reason: input.outcome.ok ? null : input.outcome.reason,
    closedRunningRunCount: input.outcome.ok
      ? input.outcome.closedRunningRunCount
      : null,
    callerRunIdWasClosed: input.outcome.ok
      ? input.outcome.callerRunIdWasClosed
      : null,
    denialClassification: input.denialClassification ?? null,
    failureBackfillWillTrigger: shouldFailureBackfill,
  });

  if (
    input.outcome.ok &&
    (input.outcome.closedRunningRunCount === 0 ||
      input.outcome.callerRunIdWasClosed === false)
  ) {
    console.warn(
      "[google-ads-sync] google_ads_completion_weak_close_detected",
      {
        partitionId: input.partitionId,
        runId: input.runId ?? null,
        recoveredRunId: input.recoveredRunId ?? null,
        workerId: input.workerId,
        leaseEpoch: input.leaseEpoch ?? null,
        lane: input.lane,
        scope: input.scope,
        partitionStatus: input.partitionStatus,
        closedRunningRunCount: input.outcome.closedRunningRunCount,
        callerRunIdWasClosed: input.outcome.callerRunIdWasClosed,
        successBackfillWillTrigger: true,
      },
    );
  }
}

export async function maybeBackfillGoogleAdsCompletionSuccess(input: {
  partitionId: string;
  runId?: string | null;
  recoveredRunId?: string | null;
  workerId: string;
  leaseEpoch?: number | null;
  lane: GoogleAdsSyncLane;
  scope: GoogleAdsWarehouseScope;
  completionResult: {
    ok: true;
    closedRunningRunCount: number;
    callerRunIdWasClosed: boolean | null;
  };
}) {
  const shouldBackfill =
    input.completionResult.closedRunningRunCount === 0 ||
    input.completionResult.callerRunIdWasClosed === false;
  if (!shouldBackfill) {
    return;
  }

  try {
    const [runResult, checkpointResult] = await Promise.all([
      backfillGoogleAdsRunningRunsForTerminalPartition({
        partitionId: input.partitionId,
        runId: input.runId ?? null,
        recoveredRunId: input.recoveredRunId ?? null,
      }),
      backfillGoogleAdsRunningCheckpointsForTerminalPartition({
        partitionId: input.partitionId,
      }),
    ]);
    console.warn(
      "[google-ads-sync] google_ads_completion_success_backfill_triggered",
      {
        partitionId: input.partitionId,
        runId: input.runId ?? null,
        recoveredRunId: input.recoveredRunId ?? null,
        workerId: input.workerId,
        leaseEpoch: input.leaseEpoch ?? null,
        lane: input.lane,
        scope: input.scope,
        closedRunningRunCount: input.completionResult.closedRunningRunCount,
        callerRunIdWasClosed: input.completionResult.callerRunIdWasClosed,
        backfilledRunCount: runResult.closedRunningRunCount,
        backfilledCheckpointCount:
          checkpointResult.closedRunningCheckpointCount,
        closedCheckpointGroups: checkpointResult.closedCheckpointGroups,
      },
    );
  } catch (error) {
    console.warn(
      "[google-ads-sync] google_ads_completion_success_backfill_failed",
      {
        partitionId: input.partitionId,
        runId: input.runId ?? null,
        recoveredRunId: input.recoveredRunId ?? null,
        workerId: input.workerId,
        leaseEpoch: input.leaseEpoch ?? null,
        lane: input.lane,
        scope: input.scope,
        closedRunningRunCount: input.completionResult.closedRunningRunCount,
        callerRunIdWasClosed: input.completionResult.callerRunIdWasClosed,
        message: error instanceof Error ? error.message : String(error),
      },
    );
  }
}

const GOOGLE_ADS_EXTENDED_CANARY_BUSINESS_IDS = new Set(
  parseEnvList("GOOGLE_ADS_EXTENDED_CANARY_BUSINESS_IDS"),
);

export function hasGoogleAdsInProcessBackgroundWorkerIdentity(
  env: NodeJS.ProcessEnv = process.env,
) {
  return Boolean(
    env.GOOGLE_ADS_WORKER_ID?.trim() || env.WORKER_INSTANCE_ID?.trim(),
  );
}

function canUseInProcessBackgroundScheduling() {
  return (
    process.env.NODE_ENV !== "production" &&
    process.env.SYNC_WORKER_MODE === "1" &&
    GOOGLE_ADS_IN_PROCESS_RUNTIME_ENABLED &&
    hasGoogleAdsInProcessBackgroundWorkerIdentity()
  );
}

export function isGoogleAdsIncidentSafeModeEnabled() {
  const raw = process.env.GOOGLE_ADS_INCIDENT_SAFE_MODE?.trim().toLowerCase();
  return raw === "1" || raw === "true" || raw === "yes";
}

export function isGoogleAdsExtendedCanaryBusiness(businessId: string) {
  return GOOGLE_ADS_EXTENDED_CANARY_BUSINESS_IDS.has(businessId);
}

const GOOGLE_ADS_EXTENDED_SCOPES: GoogleAdsWarehouseScope[] = [
  "search_term_daily",
  "product_daily",
  "asset_group_daily",
  "asset_daily",
  "geo_daily",
  "device_daily",
  "audience_daily",
  "ad_group_daily",
  "ad_daily",
  "keyword_daily",
];

const GOOGLE_ADS_RECENT_SELF_HEAL_SCOPES: GoogleAdsWarehouseScope[] = [
  "search_term_daily",
  "product_daily",
  "asset_daily",
];

const GOOGLE_ADS_ADVISOR_PRIMARY_PRIORITY_SCOPES: GoogleAdsWarehouseScope[] = [
  "search_term_daily",
  "product_daily",
];

const GOOGLE_ADS_ADVISOR_SUPPORTIVE_PRIORITY_SCOPES: GoogleAdsWarehouseScope[] =
  ["asset_daily"];

const GOOGLE_ADS_STATE_SCOPES: GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
  "search_term_daily",
  "product_daily",
  "asset_group_daily",
  "asset_daily",
  "geo_daily",
  "device_daily",
  "audience_daily",
];

const GOOGLE_ADS_RECENT_90_FRONTIER_SCOPES: GoogleAdsWarehouseScope[] = [
  "account_daily",
  "campaign_daily",
  ...GOOGLE_ADS_EXTENDED_SCOPES,
];

function buildGoogleAdsSyntheticEvidenceState(
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

export function buildGoogleAdsLaneProgressEvidence(input: {
  statesByScope?: GoogleAdsStatesByScope;
  queueHealth?: GoogleAdsQueueHealth | null;
}): GoogleAdsLaneEvidence {
  const statesByScope = input.statesByScope ?? {};
  const queueHealth = input.queueHealth ?? null;
  const coreStates = [
    ...(statesByScope.account_daily ?? []),
    ...(statesByScope.campaign_daily ?? []),
    ...buildGoogleAdsSyntheticEvidenceState(
      queueHealth?.latestCoreActivityAt ?? null,
    ),
  ];
  const extendedStates = [
    ...GOOGLE_ADS_EXTENDED_SCOPES.flatMap(
      (scope) => statesByScope[scope] ?? [],
    ),
    ...buildGoogleAdsSyntheticEvidenceState(
      queueHealth?.latestExtendedActivityAt ?? null,
    ),
  ];
  const maintenanceStates = buildGoogleAdsSyntheticEvidenceState(
    queueHealth?.latestMaintenanceActivityAt ?? null,
  );

  return {
    core: buildProviderProgressEvidence({
      states: coreStates,
      aggregation: "bottleneck",
      recentActivityWindowMinutes: GOOGLE_ADS_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
    extended_recent: buildProviderProgressEvidence({
      states: extendedStates,
      aggregation: "latest",
      recentActivityWindowMinutes: GOOGLE_ADS_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
    extended_historical: buildProviderProgressEvidence({
      states: extendedStates,
      aggregation: "bottleneck",
      recentActivityWindowMinutes: GOOGLE_ADS_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
    maintenance: buildProviderProgressEvidence({
      states: maintenanceStates,
      aggregation: "latest",
      recentActivityWindowMinutes: GOOGLE_ADS_PROGRESS_EVIDENCE_WINDOW_MINUTES,
    }),
  };
}

export function buildGoogleAdsLaneAdmissionPolicy(input: {
  safeModeEnabled: boolean;
  workerHealthy: boolean;
  workerCapacityAvailable?: boolean;
  breakerOpen: boolean;
  queueDepth: number;
  extendedQueueDepth: number;
  maintenanceQueueDepth?: number;
  quotaPressure?: number;
  maintenanceBudgetAllowed?: boolean;
  extendedBudgetAllowed?: boolean;
  extendedCanaryEligible?: boolean;
  recoveryMode?: "open" | "half_open" | "closed";
}) {
  const workerCapacityAvailable =
    input.workerCapacityAvailable ?? input.workerHealthy;
  const quotaPressure = input.quotaPressure ?? 0;
  const maintenanceBudgetAllowed = input.maintenanceBudgetAllowed ?? true;
  const extendedBudgetAllowed = input.extendedBudgetAllowed ?? true;
  const extendedCanaryEligible = input.extendedCanaryEligible ?? true;
  const suspendExtendedRecent =
    input.safeModeEnabled ||
    !input.workerHealthy ||
    !workerCapacityAvailable ||
    input.breakerOpen ||
    !extendedBudgetAllowed ||
    !extendedCanaryEligible;
  const suspendExtendedHistorical =
    suspendExtendedRecent ||
    (input.recoveryMode ?? (input.breakerOpen ? "open" : "closed")) !==
      "closed" ||
    quotaPressure >= GOOGLE_ADS_EXTENDED_HISTORICAL_PRESSURE_LIMIT;
  const suspendMaintenance =
    !maintenanceBudgetAllowed ||
    !workerCapacityAvailable ||
    (input.maintenanceQueueDepth ?? 0) >=
      GOOGLE_ADS_MAINTENANCE_BACKLOG_HARD_LIMIT ||
    quotaPressure >= 1;

  return {
    safeModeEnabled: input.safeModeEnabled,
    workerHealthy: input.workerHealthy,
    workerCapacityAvailable,
    breakerOpen: input.breakerOpen,
    quotaPressure,
    maintenanceBudgetAllowed,
    extendedBudgetAllowed,
    extendedCanaryEligible,
    recoveryMode: input.recoveryMode ?? (input.breakerOpen ? "open" : "closed"),
    lanePolicy: {
      core: "admit",
      maintenance: suspendMaintenance ? "suspended" : "admit",
      extended: suspendExtendedRecent ? "suspended" : "admit",
      extendedRecent: suspendExtendedRecent ? "suspended" : "admit",
      extendedHistorical: suspendExtendedHistorical ? "suspended" : "admit",
    } as const,
    suspendMaintenance,
    suspendExtended: suspendExtendedRecent,
    suspendExtendedRecent,
    suspendExtendedHistorical,
    executionMode: suspendExtendedRecent
      ? "core_only"
      : suspendExtendedHistorical
        ? "extended_recovery"
        : "extended_normal",
  };
}

export function getGoogleAdsExtendedRecoveryBlockReason(input: {
  policy: ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>;
  queueHealth?: Awaited<ReturnType<typeof getGoogleAdsQueueHealth>> | null;
}) {
  if (input.policy.safeModeEnabled) return "safe_mode";
  if (input.policy.breakerOpen) return "circuit_breaker_open";
  if (!input.policy.workerHealthy) return "worker_unhealthy";
  if (!input.policy.workerCapacityAvailable)
    return "worker_capacity_unavailable";
  if (!input.policy.extendedBudgetAllowed) return "extended_budget_denied";
  if (!input.policy.extendedCanaryEligible) return "global_execution_disabled";
  if (
    (input.queueHealth?.extendedQueueDepth ?? 0) >=
    GOOGLE_ADS_EXTENDED_BACKLOG_HARD_LIMIT
  ) {
    return "extended_backlog_hard_limit";
  }
  if (
    input.policy.recoveryMode === "half_open" &&
    (input.queueHealth?.extendedRecentQueueDepth ?? 0) === 0 &&
    (input.queueHealth?.extendedHistoricalQueueDepth ?? 0) > 0
  ) {
    return "half_open_recent_only";
  }
  if (
    input.policy.lanePolicy.extendedHistorical === "suspended" &&
    (input.queueHealth?.extendedHistoricalQueueDepth ?? 0) > 0
  ) {
    return "historical_recovery_suspended";
  }
  if (
    (input.queueHealth?.extendedRecentQueueDepth ?? 0) > 0 &&
    (input.queueHealth?.extendedRecentLeasedPartitions ?? 0) === 0 &&
    (input.queueHealth?.maintenanceLeasedPartitions ?? 0) > 0
  ) {
    return "maintenance_replay_pressure";
  }
  if (
    (input.queueHealth?.extendedRecentQueueDepth ?? 0) > 0 &&
    (input.queueHealth?.extendedRecentLeasedPartitions ?? 0) === 0 &&
    (input.queueHealth?.coreLeasedPartitions ?? 0) > 0
  ) {
    return "core_starvation";
  }
  if (
    (input.queueHealth?.extendedQueueDepth ?? 0) > 0 &&
    (input.queueHealth?.extendedLeasedPartitions ?? 0) === 0
  ) {
    return "queue_exists_without_eligible_lease";
  }
  return null;
}

export function shouldLeaseGoogleAdsRecentRepair(input: {
  policy:
    | ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>
    | null
    | undefined;
  queueHealth?: Awaited<ReturnType<typeof getGoogleAdsQueueHealth>> | null;
}) {
  if (!input.policy || input.policy.lanePolicy.extendedRecent === "suspended")
    return false;
  if ((input.queueHealth?.extendedRecentQueueDepth ?? 0) <= 0) return false;
  return true;
}

function getGoogleAdsRecentRepairLeaseLimit(input: {
  policy:
    | ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>
    | null
    | undefined;
}) {
  if (!input.policy) return 0;
  const baseLimit =
    input.policy.extendedCanaryEligible &&
    !GOOGLE_ADS_EXTENDED_REOPEN_GENERAL_ENABLED
      ? GOOGLE_ADS_EXTENDED_CANARY_BURST_WORKER_LIMIT
      : GOOGLE_ADS_RECENT_REPAIR_WORKER_LIMIT;
  return Math.max(1, baseLimit);
}

function getGoogleAdsHistoricalLeaseLimit(input: {
  policy:
    | ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>
    | null
    | undefined;
}) {
  if (!input.policy) return 0;
  const baseLimit =
    input.policy.extendedCanaryEligible &&
    !GOOGLE_ADS_EXTENDED_REOPEN_GENERAL_ENABLED
      ? GOOGLE_ADS_EXTENDED_CANARY_BURST_WORKER_LIMIT
      : GOOGLE_ADS_EXTENDED_WORKER_LIMIT;
  return Math.max(1, baseLimit);
}

export function getGoogleAdsHistoricalFairnessLeaseLimit(input: {
  policy:
    | ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>
    | null
    | undefined;
  queueHealth?: GoogleAdsQueueHealth | null;
  progressEvidence?: ProviderProgressEvidence | null;
  nowMs?: number;
}) {
  if (
    !input.policy ||
    input.policy.lanePolicy.extendedHistorical === "suspended"
  )
    return 0;
  const queueHealth = input.queueHealth ?? null;
  const backlogExists =
    (queueHealth?.extendedHistoricalQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedHistoricalLeasedPartitions ?? 0) > 0;
  if (!backlogExists) return 0;

  const maxLeaseLimit = getGoogleAdsHistoricalLeaseLimit({
    policy: input.policy,
  });
  const hasRecentAdvancement = hasRecentProviderAdvancement({
    progressEvidence: input.progressEvidence ?? null,
    fallbackLatestPartitionActivityAt:
      queueHealth?.latestExtendedActivityAt ?? null,
    nowMs: input.nowMs,
  });
  return hasRecentAdvancement
    ? Math.max(1, Math.min(1, maxLeaseLimit))
    : Math.max(1, Math.min(2, maxLeaseLimit));
}

export function buildGoogleAdsPrimaryLeasePlan(input: {
  policy:
    | ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>
    | null
    | undefined;
  queueHealth?: GoogleAdsQueueHealth | null;
  fullSyncPriorityRequired: boolean;
  fullSyncPriorityTargetScopes: GoogleAdsWarehouseScope[];
  blockHistoricalExtendedWork: boolean;
  progressEvidence?: Partial<GoogleAdsLaneEvidence> | null;
  nowMs?: number;
}): GoogleAdsPrimaryLeasePlan {
  const allowHistoricalExtended =
    !input.blockHistoricalExtendedWork &&
    input.policy?.lanePolicy.extendedHistorical !== "suspended";
  return {
    historicalFairnessLimit: allowHistoricalExtended
      ? getGoogleAdsHistoricalFairnessLeaseLimit({
          policy: input.policy,
          queueHealth: input.queueHealth,
          progressEvidence: input.progressEvidence?.extended_historical ?? null,
          nowMs: input.nowMs,
        })
      : 0,
    recentRepairLimit: shouldLeaseGoogleAdsRecentRepair({
      policy: input.policy,
      queueHealth: input.queueHealth,
    })
      ? getGoogleAdsRecentRepairLeaseLimit({ policy: input.policy })
      : 0,
    fullSyncPriorityLimit:
      input.fullSyncPriorityRequired &&
      input.fullSyncPriorityTargetScopes.length > 0 &&
      allowHistoricalExtended
        ? Math.max(
            1,
            Math.min(
              GOOGLE_ADS_EXTENDED_FULL_SYNC_PRIORITY_LIMIT,
              getGoogleAdsHistoricalLeaseLimit({ policy: input.policy }),
            ),
          )
        : 0,
  };
}

export function buildGoogleAdsMaintenanceLeasePlan(input: {
  policy:
    | ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>
    | null
    | undefined;
  fullSyncPriorityRequired: boolean;
}): GoogleAdsMaintenanceLeasePlan {
  const maintenanceLimit = input.fullSyncPriorityRequired
    ? Math.min(1, GOOGLE_ADS_MAINTENANCE_WORKER_LIMIT)
    : GOOGLE_ADS_MAINTENANCE_WORKER_LIMIT;
  return {
    maintenanceLimit:
      maintenanceLimit > 0 &&
      input.policy?.lanePolicy.maintenance !== "suspended"
        ? maintenanceLimit
        : 0,
  };
}

export function buildGoogleAdsFallbackExtendedLeasePlan(input: {
  policy:
    | ReturnType<typeof buildGoogleAdsLaneAdmissionPolicy>
    | null
    | undefined;
  fullSyncPriorityRequired: boolean;
  fullSyncPriorityTargetScopes: GoogleAdsWarehouseScope[];
  fullSyncPriorityYesterday: string | null;
  blockHistoricalExtendedWork: boolean;
  historicalLeaseStartDate: string | null;
}): GoogleAdsFallbackExtendedLeasePlan | null {
  const policy = input.policy;
  if (!policy || policy.suspendExtended) return null;
  const sourceFilter = input.blockHistoricalExtendedWork
    ? "recent_only"
    : input.fullSyncPriorityRequired
      ? "historical_only"
      : policy.lanePolicy.extendedHistorical === "suspended"
        ? "recent_only"
        : "all";

  return {
    sourceFilter,
    limit:
      sourceFilter === "recent_only"
        ? getGoogleAdsRecentRepairLeaseLimit({ policy })
        : getGoogleAdsHistoricalLeaseLimit({ policy }),
    scopeFilter:
      input.fullSyncPriorityRequired && !input.blockHistoricalExtendedWork
        ? input.fullSyncPriorityTargetScopes
        : undefined,
    startDate:
      !input.blockHistoricalExtendedWork &&
      (input.fullSyncPriorityRequired ||
        policy.lanePolicy.extendedHistorical !== "suspended")
        ? input.historicalLeaseStartDate
        : null,
    endDate:
      !input.blockHistoricalExtendedWork &&
      (input.fullSyncPriorityRequired ||
        policy.lanePolicy.extendedHistorical !== "suspended")
        ? input.fullSyncPriorityYesterday
        : null,
    onlyIfNoLease: true,
  };
}

function getGoogleAdsActionRequiredLeaseExcludedScopes(
  queueHealth: Awaited<ReturnType<typeof getGoogleAdsQueueHealth>> | null | undefined,
) {
  const scopes = [
    ...(queueHealth?.actionRequiredBlockingDeadLetterScopes ?? []),
    ...(queueHealth?.actionRequiredDeadLetterScopes ?? []),
  ];
  return Array.from(
    new Set(
      scopes
        .map((scope) => String(scope ?? "").trim())
        .filter(Boolean),
    ),
  ).sort() as GoogleAdsWarehouseScope[];
}

export function resolveGoogleAdsWorkerRequestedLimit(input: {
  leaseLimit: number;
  queueHealth?: Awaited<ReturnType<typeof getGoogleAdsQueueHealth>> | null;
  fullSyncPriorityRequired?: boolean;
  progressEvidence?: Partial<GoogleAdsLaneEvidence> | null;
  nowMs?: number;
}) {
  const baseLimit = Math.max(1, input.leaseLimit);
  const queueHealth = input.queueHealth ?? null;
  if (!queueHealth || (queueHealth.queueDepth ?? 0) <= 0) return baseLimit;
  if ((queueHealth.deadLetterPartitions ?? 0) > 0) return baseLimit;

  const hasPriorityBacklog =
    Boolean(input.fullSyncPriorityRequired) ||
    (queueHealth.coreQueueDepth ?? 0) > 0 ||
    (queueHealth.extendedHistoricalQueueDepth ?? 0) > 0;
  const hasForwardProgress =
    hasRecentProviderAdvancement({
      progressEvidence: input.progressEvidence?.core ?? null,
      fallbackLatestPartitionActivityAt: queueHealth.latestCoreActivityAt ?? null,
      nowMs: input.nowMs,
    }) ||
    hasRecentProviderAdvancement({
      progressEvidence: input.progressEvidence?.extended_historical ?? null,
      fallbackLatestPartitionActivityAt:
        queueHealth.latestExtendedActivityAt ?? null,
      nowMs: input.nowMs,
    }) ||
    hasRecentProviderAdvancement({
      progressEvidence: input.progressEvidence?.maintenance ?? null,
      fallbackLatestPartitionActivityAt:
        queueHealth.latestMaintenanceActivityAt ?? null,
      nowMs: input.nowMs,
    });

  if (hasPriorityBacklog && hasForwardProgress) {
    return Math.max(baseLimit, GOOGLE_ADS_PRODUCTIVE_LEASE_LIMIT);
  }
  if (hasPriorityBacklog) {
    return Math.max(
      baseLimit,
      Math.min(
        GOOGLE_ADS_PRODUCTIVE_LEASE_LIMIT,
        GOOGLE_ADS_PRIORITY_BACKLOG_LEASE_LIMIT,
      ),
    );
  }
  if (hasForwardProgress) {
    return Math.max(
      baseLimit,
      Math.min(
        GOOGLE_ADS_PRODUCTIVE_LEASE_LIMIT,
        GOOGLE_ADS_FORWARD_PROGRESS_LEASE_LIMIT,
      ),
    );
  }
  return baseLimit;
}

export async function buildGoogleAdsWorkerLeasePlan(input: {
  businessId: string;
  leaseLimit: number;
}): Promise<ProviderLeasePlan> {
  const queueHealth = await getGoogleAdsQueueHealth({
    businessId: input.businessId,
  }).catch(() => null);
  const recent90State = await getGoogleAdsRecent90CompletionState({
    businessId: input.businessId,
  }).catch(() => null);
  const fullSyncPriority = await getGoogleAdsFullSyncPriorityState({
    businessId: input.businessId,
  }).catch(() => ({
    required: false,
    targetScopes: [] as GoogleAdsWarehouseScope[],
    totalDays: 0,
    historicalStart: null,
    yesterday: null,
  }));
  const incidentPolicy = await getGoogleAdsIncidentPolicy({
    businessId: input.businessId,
    queueHealth,
  }).catch(() => null);
  const effectivePolicy = applyGoogleAdsFullSyncPriorityPolicyOverride({
    policy: incidentPolicy,
    fullSyncPriorityRequired: fullSyncPriority.required,
  });
  const allowPriorityHistoricalReplay =
    shouldAllowGoogleAdsPriorityHistoricalReplay({
      fullSyncPriorityRequired: fullSyncPriority.required,
      fullSyncPriorityTargetScopes: fullSyncPriority.targetScopes,
    });
  const blockHistoricalExtendedWork =
    shouldBlockGoogleAdsHistoricalExtendedWork({
      recent90Complete: recent90State?.complete ?? true,
      allowPriorityHistorical: allowPriorityHistoricalReplay,
    });
  const historicalLeaseStartDate = resolveGoogleAdsHistoricalReplayStart({
    historicalStart: fullSyncPriority.historicalStart,
    recent90Start: recent90State?.recent90Start ?? null,
    recent90Complete: recent90State?.complete ?? true,
    fullSyncPriorityRequired: fullSyncPriority.required,
    allowPriorityHistorical: allowPriorityHistoricalReplay,
  });
  const laneProgressEvidence = buildGoogleAdsLaneProgressEvidence({
    queueHealth,
  });
  const actionRequiredExcludedScopes =
    getGoogleAdsActionRequiredLeaseExcludedScopes(queueHealth);
  const primaryLeasePlan = buildGoogleAdsPrimaryLeasePlan({
    policy: effectivePolicy,
    queueHealth,
    fullSyncPriorityRequired: fullSyncPriority.required,
    fullSyncPriorityTargetScopes: fullSyncPriority.targetScopes,
    blockHistoricalExtendedWork,
    progressEvidence: laneProgressEvidence,
  });
  const maintenanceLeasePlan = buildGoogleAdsMaintenanceLeasePlan({
    policy: effectivePolicy,
    fullSyncPriorityRequired: fullSyncPriority.required,
  });
  const fallbackLeasePlan = buildGoogleAdsFallbackExtendedLeasePlan({
    policy: effectivePolicy,
    fullSyncPriorityRequired: fullSyncPriority.required,
    fullSyncPriorityTargetScopes: fullSyncPriority.targetScopes,
    fullSyncPriorityYesterday: fullSyncPriority.yesterday,
    blockHistoricalExtendedWork,
    historicalLeaseStartDate,
  });
  const latestPartitionActivityAt =
    queueHealth?.latestCoreActivityAt ??
    queueHealth?.latestExtendedActivityAt ??
    queueHealth?.latestMaintenanceActivityAt ??
    null;
  const steps: ProviderLeasePlan["steps"] = [
    {
      key: "core",
      lane: "core",
      limit: GOOGLE_ADS_CORE_WORKER_LIMIT,
      startDate: historicalLeaseStartDate,
      endDate: fullSyncPriority.yesterday,
      excludedScopeFilter: actionRequiredExcludedScopes,
    },
    {
      key: "historical_fairness",
      lane: "extended",
      limit: primaryLeasePlan.historicalFairnessLimit,
      sourceFilter: "historical_only" as const,
      scopeFilter: fullSyncPriority.required
        ? fullSyncPriority.targetScopes
        : undefined,
      startDate: historicalLeaseStartDate,
      endDate: fullSyncPriority.yesterday,
      excludedScopeFilter: actionRequiredExcludedScopes,
    },
    {
      key: "recent_repair",
      lane: "extended",
      limit: primaryLeasePlan.recentRepairLimit,
      sourceFilter: "recent_only" as const,
      excludedScopeFilter: actionRequiredExcludedScopes,
    },
    {
      key: "full_sync_priority",
      lane: "extended",
      limit: primaryLeasePlan.fullSyncPriorityLimit,
      sourceFilter: "historical_only" as const,
      scopeFilter: fullSyncPriority.targetScopes,
      startDate: historicalLeaseStartDate,
      endDate: fullSyncPriority.yesterday,
      excludedScopeFilter: actionRequiredExcludedScopes,
    },
    {
      key: "maintenance",
      lane: "maintenance",
      limit: maintenanceLeasePlan.maintenanceLimit,
      excludedScopeFilter: actionRequiredExcludedScopes,
    },
  ].filter((step) => step.limit > 0);
  if (fallbackLeasePlan && fallbackLeasePlan.limit > 0) {
    steps.push({
      key: "fallback_extended",
      lane: "extended",
      limit: fallbackLeasePlan.limit,
      sourceFilter: fallbackLeasePlan.sourceFilter,
      scopeFilter: fallbackLeasePlan.scopeFilter,
      startDate: fallbackLeasePlan.startDate,
      endDate: fallbackLeasePlan.endDate,
      onlyIfNoLease: fallbackLeasePlan.onlyIfNoLease,
      excludedScopeFilter: actionRequiredExcludedScopes,
    });
  }

  return {
    kind: "google_ads_policy_lease_plan",
    requestedLimit: resolveGoogleAdsWorkerRequestedLimit({
      leaseLimit: input.leaseLimit,
      queueHealth,
      fullSyncPriorityRequired: fullSyncPriority.required,
      progressEvidence: laneProgressEvidence,
    }),
    steps,
    maintenancePlan: {
      autoHealEnabled: true,
      enqueueScheduledWork: false,
    },
    fairnessInputs: {
      historicalFairnessLimit: primaryLeasePlan.historicalFairnessLimit,
      recentRepairLimit: primaryLeasePlan.recentRepairLimit,
      fullSyncPriorityLimit: primaryLeasePlan.fullSyncPriorityLimit,
      maintenanceLimit: maintenanceLeasePlan.maintenanceLimit,
      blockHistoricalExtendedWork,
      fullSyncPriorityRequired: fullSyncPriority.required,
    },
    progressEvidence: laneProgressEvidence.extended_historical,
    latestPartitionActivityAt,
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    hasRepairableBacklog: (queueHealth?.deadLetterPartitions ?? 0) > 0,
    staleRunPressure: 0,
    stallFingerprints: deriveProviderStallFingerprints({
      queueDepth: queueHealth?.queueDepth ?? 0,
      leasedPartitions: queueHealth?.leasedPartitions ?? 0,
      checkpointLagMinutes: null,
      latestPartitionActivityAt,
      blocked: (queueHealth?.deadLetterPartitions ?? 0) > 0,
      progressEvidence: laneProgressEvidence.extended_historical,
      historicalBacklogDepth:
        (queueHealth?.extendedHistoricalQueueDepth ?? 0) +
        (queueHealth?.extendedHistoricalLeasedPartitions ?? 0),
      blockedReasonCodes:
        (queueHealth?.deadLetterPartitions ?? 0) > 0
          ? ["required_dead_letter_partitions"]
          : [],
    }),
  };
}

function applyGoogleAdsFullSyncPriorityPolicyOverride(input: {
  policy: Awaited<ReturnType<typeof getGoogleAdsIncidentPolicy>> | null;
  fullSyncPriorityRequired: boolean;
}) {
  const policy = input.policy;
  if (
    !policy ||
    !input.fullSyncPriorityRequired ||
    policy.safeModeEnabled ||
    policy.breakerOpen
  ) {
    return policy;
  }

  return {
    ...policy,
    lanePolicy: {
      ...policy.lanePolicy,
      extended: "admit" as const,
      extendedHistorical: "admit" as const,
    },
    suspendExtended: false,
    suspendExtendedHistorical: false,
    executionMode:
      policy.executionMode === "core_only"
        ? ("extended_recovery" as const)
        : policy.executionMode,
  };
}

function isGoogleAdsRecentExtendedSource(source: string | null | undefined) {
  return (
    source === "today" ||
    source === "recent" ||
    source === "selected_range" ||
    source === "core_success" ||
    source === "recent_recovery"
  );
}

function isGoogleAdsHistoricalExtendedSource(
  source: string | null | undefined,
) {
  return source === "historical" || source === "historical_recovery";
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function nullIfEmpty(value: unknown) {
  if (value == null) return null;
  const text = String(value).trim();
  return text.length > 0 ? text : null;
}

function chunkRows<T>(rows: T[], size: number) {
  const chunks: T[][] = [];
  for (let index = 0; index < rows.length; index += Math.max(1, size)) {
    chunks.push(rows.slice(index, index + Math.max(1, size)));
  }
  return chunks;
}

function uniqueSnapshotIds(snapshotIds: Array<string | null | undefined>) {
  return Array.from(
    new Set(snapshotIds.filter((value): value is string => Boolean(value))),
  );
}

export function shouldCountGoogleAdsReplayChunkAsFetched(input: {
  pageIndex: number;
  checkpointPageIndex: number | null | undefined;
  replayingPersistedChunk: boolean;
}) {
  if (!input.replayingPersistedChunk) return true;
  return input.pageIndex > (input.checkpointPageIndex ?? -1);
}

export function buildGoogleAdsWarehouseFetchPlan(
  scopes: Iterable<GoogleAdsWarehouseScope>,
) {
  const requestedScopes = new Set(scopes);
  const wants = (scope: GoogleAdsWarehouseScope) => requestedScopes.has(scope);
  return {
    campaigns: wants("account_daily") || wants("campaign_daily"),
    searchIntelligence: wants("search_term_daily") || wants("ad_group_daily"),
    keywords: wants("keyword_daily") || wants("ad_group_daily"),
    ads: wants("ad_daily") || wants("ad_group_daily"),
    assets: wants("asset_daily"),
    assetGroups: wants("asset_group_daily"),
    audiences: wants("audience_daily"),
    geo: wants("geo_daily"),
    devices: wants("device_daily"),
    products: wants("product_daily"),
  };
}

function resolvePrimaryGoogleAdsSyncScope(
  scopes: Set<GoogleAdsWarehouseScope>,
) {
  if (scopes.has("campaign_daily")) return "campaign_daily";
  if (scopes.has("account_daily")) return "account_daily";
  return Array.from(scopes)[0] ?? "account_daily";
}

function extractSnapshotRows(payload: unknown): GenericRow[] {
  return Array.isArray(payload) ? (payload as GenericRow[]) : [];
}

async function isGoogleAdsWorkerHealthyForScheduling() {
  if (process.env.SYNC_WORKER_MODE === "1") return true;
  return false;
}

export function evaluateGoogleAdsWorkerSchedulingState(input: {
  onlineWorkers: number;
  lastHeartbeatAt: string | null;
  runnerLeaseActive: boolean;
  staleThresholdMs?: number;
  nowMs?: number;
}) {
  const staleThresholdMs = Math.max(
    1,
    input.staleThresholdMs ?? GOOGLE_ADS_WORKER_STALE_THRESHOLD_MS,
  );
  const nowMs = input.nowMs ?? Date.now();
  const heartbeatAgeMs =
    input.lastHeartbeatAt != null
      ? Math.max(0, nowMs - new Date(input.lastHeartbeatAt).getTime())
      : null;
  const hasFreshHeartbeat =
    input.onlineWorkers > 0 ||
    (heartbeatAgeMs != null && heartbeatAgeMs <= staleThresholdMs);
  return {
    healthy: hasFreshHeartbeat || input.runnerLeaseActive,
    heartbeatAgeMs,
    hasFreshHeartbeat,
    runnerLeaseActive: input.runnerLeaseActive,
  };
}

export async function getGoogleAdsWorkerSchedulingState(input: {
  businessId: string;
}) {
  if (process.env.SYNC_WORKER_MODE === "1") {
    return {
      healthy: true,
      heartbeatAgeMs: 0,
      hasFreshHeartbeat: true,
      runnerLeaseActive: true,
      lastHeartbeatAt: new Date().toISOString(),
      latestLeaseUpdatedAt: new Date().toISOString(),
      ownerWorkerId: process.env.WORKER_INSTANCE_ID?.trim() ?? null,
      workerFreshnessState: "online" as const,
      currentBusinessId: null,
      lastConsumedBusinessId: null,
      consumeStage: null,
      batchBusinessIds: [] as string[],
      workerMeta: null,
    };
  }
  const state = await getProviderWorkerHealthState({
    businessId: input.businessId,
    providerScope: "google_ads",
    staleThresholdMs: GOOGLE_ADS_WORKER_STALE_THRESHOLD_MS,
  }).catch(() => null);
  return {
    healthy: state?.workerHealthy ?? false,
    heartbeatAgeMs: state?.heartbeatAgeMs ?? null,
    hasFreshHeartbeat: state?.hasFreshHeartbeat ?? false,
    runnerLeaseActive: state?.runnerLeaseActive ?? false,
    lastHeartbeatAt: state?.lastHeartbeatAt ?? null,
    latestLeaseUpdatedAt: state?.latestLeaseUpdatedAt ?? null,
    ownerWorkerId: state?.ownerWorkerId ?? null,
    workerFreshnessState: state?.workerFreshnessState ?? null,
    currentBusinessId: state?.currentBusinessId ?? null,
    lastConsumedBusinessId: state?.lastConsumedBusinessId ?? null,
    consumeStage: state?.consumeStage ?? null,
    batchBusinessIds: state?.batchBusinessIds ?? [],
    workerMeta: state?.workerMeta ?? null,
  };
}

export async function getGoogleAdsIncidentPolicy(input: {
  businessId: string;
  queueHealth?: Awaited<ReturnType<typeof getGoogleAdsQueueHealth>> | null;
}) {
  const [breaker, workerState, queueHealth, budgetState, recoveryMode] =
    await Promise.all([
      getProviderGlobalCircuitBreaker({
        provider: "google",
        businessId: input.businessId,
      }).catch(() => null),
      getGoogleAdsWorkerSchedulingState({ businessId: input.businessId }).catch(
        () => ({
          healthy: false,
          heartbeatAgeMs: null,
          hasFreshHeartbeat: false,
          runnerLeaseActive: false,
          lastHeartbeatAt: null,
          latestLeaseUpdatedAt: null,
          workerFreshnessState: null,
          currentBusinessId: null,
          lastConsumedBusinessId: null,
          consumeStage: null,
          batchBusinessIds: [] as string[],
        }),
      ),
      input.queueHealth
        ? Promise.resolve(input.queueHealth)
        : getGoogleAdsQueueHealth({ businessId: input.businessId }).catch(
            () => null,
          ),
      getProviderQuotaBudgetState({
        provider: "google",
        businessId: input.businessId,
      }).catch(() => null),
      getProviderCircuitBreakerRecoveryState({
        provider: "google",
        businessId: input.businessId,
      }).catch(() => "closed" as const),
    ]);
  const workerHealthy = workerState.healthy;
  const workerCapacityAvailable =
    workerHealthy &&
    (queueHealth?.leasedPartitions ?? 0) <
      Math.max(
        GOOGLE_ADS_CORE_WORKER_LIMIT +
          GOOGLE_ADS_MAINTENANCE_WORKER_LIMIT +
          GOOGLE_ADS_EXTENDED_WORKER_LIMIT,
        1,
      );
  const extendedCanaryEligible = true;

  const policy = buildGoogleAdsLaneAdmissionPolicy({
    safeModeEnabled: isGoogleAdsIncidentSafeModeEnabled(),
    workerHealthy,
    workerCapacityAvailable,
    breakerOpen: Boolean(breaker),
    queueDepth: queueHealth?.queueDepth ?? 0,
    extendedQueueDepth: queueHealth?.extendedQueueDepth ?? 0,
    maintenanceQueueDepth: queueHealth?.maintenanceQueueDepth ?? 0,
    quotaPressure: budgetState?.pressure ?? 0,
    maintenanceBudgetAllowed: budgetState?.maintenanceAllowed ?? true,
    extendedBudgetAllowed: budgetState?.extendedAllowed ?? false,
    extendedCanaryEligible,
    recoveryMode,
  });

  return {
    ...policy,
    workerHealthState: workerState,
    breaker,
    queueHealth,
    budgetState,
    recoveryMode,
  };
}

async function compactGoogleAdsIncidentBacklog(input: {
  businessId: string;
  policy: Awaited<ReturnType<typeof getGoogleAdsIncidentPolicy>>;
}) {
  if (
    !input.policy.breakerOpen &&
    !input.policy.safeModeEnabled &&
    input.policy.workerHealthState?.hasFreshHeartbeat &&
    input.policy.workerHealthState?.runnerLeaseActive &&
    input.policy.extendedCanaryEligible
  ) {
    return {
      compactedCount: 0,
    };
  }
  if (!input.policy.suspendExtended) {
    return {
      compactedCount: 0,
    };
  }

  const reason = input.policy.breakerOpen
    ? "google_ads_incident_suppressed:circuit_breaker"
    : input.policy.safeModeEnabled
      ? "google_ads_incident_suppressed:safe_mode"
      : "google_ads_incident_suppressed:worker_unhealthy";
  return compactGoogleAdsExtendedBacklog({
    businessId: input.businessId,
    reason,
    keepLatestPerScope: 0,
  }).catch(() => ({
    compactedCount: 0,
  }));
}

async function enqueueExtendedRecoveryPartitions(input: {
  businessId: string;
  policy: Awaited<ReturnType<typeof getGoogleAdsIncidentPolicy>>;
  scopes?: GoogleAdsWarehouseScope[];
  recent90Complete?: boolean;
  allowPriorityHistorical?: boolean;
}) {
  if (
    input.policy.lanePolicy.extendedHistorical === "suspended" ||
    shouldBlockGoogleAdsHistoricalExtendedWork({
      recent90Complete: input.recent90Complete ?? true,
      allowPriorityHistorical: input.allowPriorityHistorical,
    })
  ) {
    return {
      queuedHistorical: 0,
    };
  }

  const accountIds = await getConnectedAssignedGoogleAccounts(input.businessId).catch(
    () => [],
  );
  if (accountIds.length === 0) {
    return {
      queuedHistorical: 0,
    };
  }

  const { historicalStart, yesterday } = await computeHistoricalTargets(
    input.businessId,
  );
  const recent90State = await getGoogleAdsRecent90CompletionState({
    businessId: input.businessId,
  }).catch(() => null);
  const frontierStart = resolveGoogleAdsHistoricalReplayStart({
    historicalStart,
    recent90Start: recent90State?.recent90Start ?? null,
    recent90Complete: recent90State?.complete ?? true,
    allowPriorityHistorical: input.allowPriorityHistorical,
  });
  if (!frontierStart) {
    return {
      queuedHistorical: 0,
    };
  }
  const recentStart = addDaysToIsoDate(
    yesterday,
    -(GOOGLE_ADS_RECENT_EXTENDED_RECOVERY_DAYS - 1),
  );
  const historicalReplayEnd = addDaysToIsoDate(recentStart, -1);
  let queuedHistorical = 0;
  const scopes = input.scopes?.length
    ? input.scopes
    : GOOGLE_ADS_EXTENDED_SCOPES;

  for (const providerAccountId of accountIds) {
    for (const scope of scopes) {
      if (historicalReplayEnd >= frontierStart) {
        const [coveredDates, activeDates] = await Promise.all([
          getGoogleAdsCoveredDates({
            scope,
            businessId: input.businessId,
            providerAccountId,
            startDate: frontierStart,
            endDate: historicalReplayEnd,
          }).catch(() => []),
          getGoogleAdsPartitionDates({
            businessId: input.businessId,
            providerAccountId,
            lane: "extended",
            scope,
            startDate: frontierStart,
            endDate: historicalReplayEnd,
            statuses: [...getGoogleAdsGapPlannerBlockingStatuses()],
          }).catch(() => []),
        ]);
        const blocked = new Set([...coveredDates, ...activeDates]);
        const dates = enumerateDays(frontierStart, historicalReplayEnd, true)
          .filter((date) => !blocked.has(date))
          .slice(0, GOOGLE_ADS_EXTENDED_HISTORICAL_BATCH_DAYS);
        for (const date of dates) {
          const row = await queueGoogleAdsSyncPartition({
            businessId: input.businessId,
            providerAccountId,
            lane: "extended",
            scope,
            partitionDate: date,
            status: "queued",
            priority: -15,
            source: "historical_recovery",
            attemptCount: 0,
          }).catch(() => null);
          if (row?.id) queuedHistorical++;
        }
      }
    }
  }

  return {
    queuedHistorical,
  };
}

async function cancelHistoricalExtendedBacklog(input: {
  businessId: string;
  recent90Complete: boolean;
  scopeFilter?: GoogleAdsWarehouseScope[];
  allowPriorityHistorical?: boolean;
}) {
  if (
    !shouldBlockGoogleAdsHistoricalExtendedWork({
      recent90Complete: input.recent90Complete,
      allowPriorityHistorical: input.allowPriorityHistorical,
    })
  ) {
    return 0;
  }

  return cancelGoogleAdsPartitionsBySource({
    businessId: input.businessId,
    lane: "extended",
    sources: ["historical", "historical_recovery"],
    statuses: ["queued", "leased", "running"],
    scopeFilter: input.scopeFilter,
  }).catch(() => 0);
}

export async function getGoogleAdsFullSyncPriorityState(input: {
  businessId: string;
}) {
  const { historicalStart, yesterday } = await computeHistoricalTargets(
    input.businessId,
  );
  const totalDays = dayCountInclusive(historicalStart, yesterday);
  const coverageRows = await Promise.all(
    [
      ...GOOGLE_ADS_ADVISOR_PRIMARY_PRIORITY_SCOPES,
      ...GOOGLE_ADS_ADVISOR_SUPPORTIVE_PRIORITY_SCOPES,
    ].map(async (scope) => ({
      scope,
      coverage: await getGoogleAdsDailyCoverage({
        scope,
        businessId: input.businessId,
        providerAccountId: null,
        startDate: historicalStart,
        endDate: yesterday,
      }).catch(() => null),
    })),
  );
  const targetScopes = coverageRows
    .filter((entry) => Number(entry.coverage?.completed_days ?? 0) < totalDays)
    .map((entry) => entry.scope);
  const required = targetScopes.some((scope) =>
    GOOGLE_ADS_ADVISOR_PRIMARY_PRIORITY_SCOPES.includes(scope),
  );
  return {
    required,
    targetScopes,
    totalDays,
    historicalStart,
    yesterday,
  };
}

async function enqueueGoogleAdsRecentRepairPartitions(input: {
  businessId: string;
  policy: Awaited<ReturnType<typeof getGoogleAdsIncidentPolicy>>;
}) {
  const emptyGapCounts = Object.fromEntries(
    GOOGLE_ADS_RECENT_SELF_HEAL_SCOPES.map((scope) => [scope, 0]),
  ) as Record<GoogleAdsWarehouseScope, number>;

  if (input.policy.lanePolicy.extendedRecent === "suspended") {
    return {
      queuedRecent: 0,
      gapCountsByScope: emptyGapCounts,
    };
  }

  const accountIds = await getConnectedAssignedGoogleAccounts(input.businessId).catch(
    () => [],
  );
  if (accountIds.length === 0) {
    return {
      queuedRecent: 0,
      gapCountsByScope: emptyGapCounts,
    };
  }

  const { yesterday } = await computeHistoricalTargets(input.businessId);
  const recentStart = addDaysToIsoDate(
    yesterday,
    -(GOOGLE_ADS_RECENT_EXTENDED_RECOVERY_DAYS - 1),
  );
  const gapCountsByScope = { ...emptyGapCounts };
  let queuedRecent = 0;

  for (const providerAccountId of accountIds) {
    for (const scope of GOOGLE_ADS_RECENT_SELF_HEAL_SCOPES) {
      const [coveredDates, activeDates] = await Promise.all([
        getGoogleAdsCoveredDates({
          scope,
          businessId: input.businessId,
          providerAccountId,
          startDate: recentStart,
          endDate: yesterday,
        }).catch(() => []),
        getGoogleAdsPartitionDates({
          businessId: input.businessId,
          providerAccountId,
          lane: "extended",
          scope,
          startDate: recentStart,
          endDate: yesterday,
          statuses: [...getGoogleAdsGapPlannerBlockingStatuses()],
        }).catch(() => []),
      ]);
      const blocked = new Set([...coveredDates, ...activeDates]);
      const missingDates = enumerateDays(recentStart, yesterday, true).filter(
        (date) => !blocked.has(date),
      );
      gapCountsByScope[scope] += missingDates.length;

      for (const date of missingDates.slice(
        0,
        GOOGLE_ADS_EXTENDED_RECENT_BATCH_DAYS,
      )) {
        const row = await queueGoogleAdsSyncPartition({
          businessId: input.businessId,
          providerAccountId,
          lane: "extended",
          scope,
          partitionDate: date,
          status: "queued",
          priority: 25,
          source: "recent_recovery",
          attemptCount: 0,
        }).catch(() => null);
        if (row?.id) queuedRecent++;
      }
    }
  }

  return {
    queuedRecent,
    gapCountsByScope,
  };
}

function isGoogleAdsRecentRepairScope(scope: GoogleAdsWarehouseScope) {
  return GOOGLE_ADS_RECENT_SELF_HEAL_SCOPES.includes(scope);
}

async function openGoogleAdsQuotaCircuitBreaker(input: {
  businessId: string;
  message: string;
  status?: number;
}) {
  const existing = await getProviderGlobalCircuitBreaker({
    provider: "google",
    businessId: input.businessId,
  }).catch(() => null);
  const cooldownMs =
    existing != null
      ? GOOGLE_ADS_CIRCUIT_BREAKER_REPEAT_MINUTES * 60_000
      : GOOGLE_ADS_CIRCUIT_BREAKER_BASE_MINUTES * 60_000;

  return openProviderGlobalCircuitBreaker({
    provider: "google",
    businessId: input.businessId,
    message: input.message,
    status: input.status ?? 429,
    cooldownMs,
  }).catch(() => null);
}

export function resolveGoogleReplayReasonCode(input: {
  checkpointStatus?: string | null;
  checkpointPhase?: string | null;
  poisonedAt?: string | null;
  retryAfterAt?: string | null;
}): ProviderReplayReasonCode {
  if (input.poisonedAt) return "quarantine_release";
  if (
    input.checkpointStatus === "failed" &&
    input.checkpointPhase === "transform"
  ) {
    return "transform_failure_replay";
  }
  if (
    input.checkpointStatus === "failed" &&
    input.checkpointPhase === "bulk_upsert"
  ) {
    return "flush_verification_mismatch";
  }
  if (input.retryAfterAt) return "quota_retry";
  return "reclaim_replay";
}

export function resolvePhaseAwareReplayDecision(input: {
  checkpoint: Awaited<ReturnType<typeof getGoogleAdsSyncCheckpoint>> | null;
  existingSnapshots: Array<{
    id: string;
    page_index: number | null;
    payload_json: unknown;
  }>;
  totalChunks: number;
}) {
  const checkpoint = input.checkpoint;
  const storedSnapshotIds = uniqueSnapshotIds(
    input.existingSnapshots.map((row) => row.id),
  );
  const lineageIds = uniqueSnapshotIds(checkpoint?.rawSnapshotIds ?? []);
  const continuityBroken = lineageIds.some(
    (id) => !storedSnapshotIds.includes(id),
  );
  const completenessBroken =
    checkpoint != null &&
    checkpoint.phase === "finalize" &&
    input.totalChunks > 0 &&
    storedSnapshotIds.length < input.totalChunks;

  if (!checkpoint) {
    return {
      startChunkIndex: 0,
      finalizeOnly: false,
      replayReasonCode: null as ProviderReplayReasonCode | null,
      replayDetail: null as string | null,
      continuityBroken: false,
    };
  }

  if (checkpoint.status === "succeeded" && checkpoint.phase === "finalize") {
    return {
      startChunkIndex: input.totalChunks,
      finalizeOnly: false,
      replayReasonCode: null as ProviderReplayReasonCode | null,
      replayDetail: null as string | null,
      continuityBroken: false,
    };
  }

  if (checkpoint.phase === "finalize" && checkpoint.status !== "succeeded") {
    const canFinalizeOnly =
      !continuityBroken &&
      !completenessBroken &&
      (checkpoint.rowsFetched ?? 0) >= (checkpoint.rowsWritten ?? 0);
    return {
      startChunkIndex: canFinalizeOnly
        ? input.totalChunks
        : Math.max(0, checkpoint.pageIndex ?? 0),
      finalizeOnly: canFinalizeOnly,
      replayReasonCode: resolveGoogleReplayReasonCode({
        checkpointStatus: checkpoint.status,
        checkpointPhase: checkpoint.phase,
        poisonedAt: checkpoint.poisonedAt,
        retryAfterAt: checkpoint.retryAfterAt,
      }),
      replayDetail: canFinalizeOnly
        ? "Finalize replay resumed after checkpoint verification succeeded."
        : "Finalize replay requires chunk replay because checkpoint verification was incomplete.",
      continuityBroken,
    };
  }

  return {
    startChunkIndex: Math.max(0, checkpoint.pageIndex ?? 0),
    finalizeOnly: false,
    replayReasonCode: resolveGoogleReplayReasonCode({
      checkpointStatus: checkpoint.status,
      checkpointPhase: checkpoint.phase,
      poisonedAt: checkpoint.poisonedAt,
      retryAfterAt: checkpoint.retryAfterAt,
    }),
    replayDetail: checkpoint.phase
      ? `Resuming Google Ads sync from ${checkpoint.phase} phase at chunk ${checkpoint.pageIndex ?? 0}.`
      : null,
    continuityBroken,
  };
}

export function validateGoogleReplayCompleteness(input: {
  totalChunks: number;
  replayWindowStartChunk?: number;
  finalRawSnapshotIds?: string[];
  storedSnapshotIds?: string[];
  storedSnapshotPages?: number[];
  rowsFetched: number;
  rowsWritten: number;
}) {
  const replayWindowStartChunk = Math.max(
    0,
    Math.min(input.totalChunks, input.replayWindowStartChunk ?? 0),
  );
  const storedSnapshotSet = new Set(input.storedSnapshotIds ?? []);
  const storedSnapshotPageSet = new Set(
    (input.storedSnapshotPages ?? []).map((pageIndex) =>
      Math.max(0, Number(pageIndex)),
    ),
  );
  const lineageBroken =
    storedSnapshotPageSet.size > 0
      ? false
      : (input.finalRawSnapshotIds ?? []).some(
          (snapshotId) => !storedSnapshotSet.has(snapshotId),
        );
  const snapshotCoverageBroken =
    storedSnapshotPageSet.size > 0
      ? Array.from(
          { length: Math.max(0, input.totalChunks - replayWindowStartChunk) },
          (_, offset) => replayWindowStartChunk + offset,
        ).some((pageIndex) => !storedSnapshotPageSet.has(pageIndex))
      : input.totalChunks > 0 && storedSnapshotSet.size < input.totalChunks;
  const rowCountBroken = input.rowsWritten > 0 && input.rowsFetched <= 0;

  return {
    lineageBroken,
    snapshotCoverageBroken,
    rowCountBroken,
    ok: !lineageBroken && !snapshotCoverageBroken && !rowCountBroken,
  };
}

function computeDerivedMetrics(input: {
  spend: number;
  revenue: number;
  conversions: number;
  impressions: number;
  clicks: number;
  conversionRate?: number | null;
  interactionRate?: number | null;
}) {
  return {
    ctr:
      input.impressions > 0
        ? Number(((input.clicks / input.impressions) * 100).toFixed(2))
        : null,
    cpc:
      input.clicks > 0 ? Number((input.spend / input.clicks).toFixed(2)) : null,
    cpa:
      input.conversions > 0
        ? Number((input.spend / input.conversions).toFixed(2))
        : null,
    roas:
      input.spend > 0 ? Number((input.revenue / input.spend).toFixed(2)) : 0,
    conversionRate:
      input.conversionRate ??
      (input.clicks > 0
        ? Number(((input.conversions / input.clicks) * 100).toFixed(2))
        : null),
    interactionRate: input.interactionRate ?? null,
  };
}

function buildWarehouseRow(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  entityKey: string;
  entityLabel?: string | null;
  campaignId?: string | null;
  campaignName?: string | null;
  adGroupId?: string | null;
  adGroupName?: string | null;
  status?: string | null;
  channel?: string | null;
  classification?: string | null;
  spend?: number;
  revenue?: number;
  conversions?: number;
  impressions?: number;
  clicks?: number;
  conversionRate?: number | null;
  interactionRate?: number | null;
  payloadJson?: unknown;
  sourceSnapshotId: string | null;
}): GoogleAdsWarehouseDailyRow {
  const spend = input.spend ?? 0;
  const revenue = input.revenue ?? 0;
  const conversions = input.conversions ?? 0;
  const impressions = input.impressions ?? 0;
  const clicks = input.clicks ?? 0;
  const derived = computeDerivedMetrics({
    spend,
    revenue,
    conversions,
    impressions,
    clicks,
    conversionRate: input.conversionRate,
    interactionRate: input.interactionRate,
  });
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    date: input.date,
    accountTimezone: input.accountTimezone,
    accountCurrency: input.accountCurrency,
    entityKey: input.entityKey,
    entityLabel: input.entityLabel ?? null,
    campaignId: input.campaignId ?? null,
    campaignName: input.campaignName ?? null,
    adGroupId: input.adGroupId ?? null,
    adGroupName: input.adGroupName ?? null,
    status: input.status ?? null,
    channel: input.channel ?? null,
    classification: input.classification ?? null,
    payloadJson: input.payloadJson ?? {},
    spend,
    revenue,
    conversions,
    impressions,
    clicks,
    ctr: derived.ctr,
    cpc: derived.cpc,
    cpa: derived.cpa,
    roas: derived.roas,
    conversionRate: derived.conversionRate,
    interactionRate: derived.interactionRate,
    sourceSnapshotId: input.sourceSnapshotId,
  };
}

async function createScopeSyncJob(input: {
  businessId: string;
  providerAccountId: string;
  startDate: string;
  endDate: string;
  scope: GoogleAdsWarehouseScope;
  syncType: GoogleAdsSyncType;
  triggerSource: string;
}) {
  return createGoogleAdsSyncJob({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    scope: input.scope,
    syncType: input.syncType,
    startDate: input.startDate,
    endDate: input.endDate,
    status: "running",
    progressPercent: 0,
    triggerSource: input.triggerSource,
    retryCount: 0,
    lastError: null,
    startedAt: new Date().toISOString(),
  });
}

function getScopeProfile(
  snapshot: Awaited<ReturnType<typeof readProviderAccountSnapshot>>,
  accountId: string,
) {
  const account = snapshot?.accounts.find((item) => item.id === accountId);
  return {
    timezone: account?.timezone ?? "UTC",
    currency: account?.currency ?? "USD",
  };
}

async function persistScopeRows(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  endpointName: string;
  scope: GoogleAdsWarehouseScope;
  rows: GenericRow[];
  requestContext: Record<string, unknown>;
  mapRow: (
    row: GenericRow,
    snapshotId: string | null,
  ) => GoogleAdsWarehouseDailyRow | null;
  partitionId?: string;
  workerId?: string;
  leaseEpoch?: number;
  attemptCount?: number;
}) {
  const chunkSize = getGoogleAdsScopeCheckpointChunkSize(input.scope);
  if (!input.partitionId) {
    const rowChunks = chunkRows(input.rows, chunkSize);
    let latestSnapshotId: string | null = null;
    let rowCount = 0;

    for (let pageIndex = 0; pageIndex < rowChunks.length; pageIndex += 1) {
      const chunk = rowChunks[pageIndex] ?? [];
      const chunkStartedAtMs = Date.now();
      const hashStartedAtMs = Date.now();
      const payloadHash = buildGoogleAdsRawSnapshotHash({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        endpointName: input.endpointName,
        startDate: input.date,
        endDate: input.date,
        payload: chunk,
      });
      const hashMs = Date.now() - hashStartedAtMs;
      const rawSnapshotStartedAtMs = Date.now();
      latestSnapshotId = await persistGoogleAdsRawSnapshot({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        endpointName: input.endpointName,
        entityScope: input.scope,
        pageIndex,
        providerCursor: String(pageIndex),
        startDate: input.date,
        endDate: input.date,
        accountTimezone: input.accountTimezone,
        accountCurrency: input.accountCurrency,
        payloadJson: chunk,
        payloadHash,
        requestContext: {
          ...input.requestContext,
          pageIndex,
          chunkSize: chunk.length,
        },
        providerHttpStatus: 200,
        responseHeaders: {
          pageIndex,
          chunkSize: chunk.length,
        },
        status: "fetched",
      });
      const rawSnapshotMs = Date.now() - rawSnapshotStartedAtMs;

      const transformStartedAtMs = Date.now();
      const warehouseRows = chunk
        .map((row) => input.mapRow(row, latestSnapshotId))
        .filter((row): row is GoogleAdsWarehouseDailyRow => Boolean(row));
      const transformMs = Date.now() - transformStartedAtMs;
      const warehouseUpsertStartedAtMs = Date.now();
      await upsertGoogleAdsDailyRows(input.scope, warehouseRows);
      const warehouseUpsertMs = Date.now() - warehouseUpsertStartedAtMs;
      logGoogleAdsPersistChunkTelemetry({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        date: input.date,
        scope: input.scope,
        partitionId: null,
        pageIndex,
        rowCount: warehouseRows.length,
        hashMs,
        checkpointMs: 0,
        rawSnapshotMs,
        transformMs,
        warehouseUpsertMs,
        totalMs: Date.now() - chunkStartedAtMs,
      });
      rowCount += warehouseRows.length;
    }

    return { snapshotId: latestSnapshotId, rowCount };
  }

  const checkpointScope = input.scope;
  const existingCheckpoint = await getGoogleAdsSyncCheckpoint({
    partitionId: input.partitionId,
    checkpointScope,
  }).catch(() => null);
  const existingSnapshots = await listGoogleAdsRawSnapshotsForPartition({
    partitionId: input.partitionId,
    endpointName: input.endpointName,
  }).catch(() => []);
  const existingSnapshotPages = new Map(
    existingSnapshots.map((row) => [Number(row.page_index ?? 0), row] as const),
  );
  const rowChunks = chunkRows(input.rows, chunkSize);
  const replayDecision = resolvePhaseAwareReplayDecision({
    checkpoint: existingCheckpoint,
    existingSnapshots,
    totalChunks: rowChunks.length,
  });
  const startChunkIndex = replayDecision.startChunkIndex;
  let rowsFetched = existingCheckpoint?.rowsFetched ?? 0;
  let rowsWritten = existingCheckpoint?.rowsWritten ?? 0;
  let latestSnapshotId: string | null = null;
  let replayedSnapshotCount = 0;
  let accumulatedRawSnapshotIds = uniqueSnapshotIds(
    existingCheckpoint?.rawSnapshotIds ?? [],
  );
  let storedSnapshotIds = uniqueSnapshotIds(
    existingSnapshots.map((row) => row.id),
  );
  let storedSnapshotPages = Array.from(
    new Set(
      existingSnapshots.map((row) => Math.max(0, Number(row.page_index ?? 0))),
    ),
  );

  for (
    let pageIndex = startChunkIndex;
    pageIndex < rowChunks.length;
    pageIndex += 1
  ) {
    const checkpointChunk = rowChunks[pageIndex] ?? [];
    const chunkStartedAtMs = Date.now();
    let checkpointMs = 0;
    let hashMs = 0;
    let rawSnapshotMs = 0;
    if (input.workerId) {
      const leaseHealthy = await heartbeatGoogleAdsPartitionLease({
        partitionId: input.partitionId,
        workerId: input.workerId,
        leaseEpoch: input.leaseEpoch ?? 0,
        leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
      }).catch(() => false);
      if (!leaseHealthy) {
        throw new Error("lease_conflict:partition_lease_heartbeat_rejected");
      }
    }

    const fetchCheckpointStartedAtMs = Date.now();
    const checkpointId = await upsertGoogleAdsCheckpointOrThrow({
      partitionId: input.partitionId,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      checkpointScope,
      isPaginated: false,
      phase: "fetch_raw",
      status: "running",
      pageIndex,
      nextPageToken:
        pageIndex + 1 < rowChunks.length ? String(pageIndex + 1) : null,
      providerCursor:
        pageIndex + 1 < rowChunks.length ? String(pageIndex + 1) : null,
      rowsFetched,
      rowsWritten,
      attemptCount: input.attemptCount ?? 0,
      rawSnapshotIds: accumulatedRawSnapshotIds,
      progressHeartbeatAt: new Date().toISOString(),
      replayReasonCode: replayDecision.replayReasonCode,
      replayDetail: replayDecision.replayDetail,
      leaseOwner: input.workerId ?? null,
      leaseEpoch: input.leaseEpoch ?? null,
      startedAt: existingCheckpoint?.startedAt ?? new Date().toISOString(),
    });
    checkpointMs += Date.now() - fetchCheckpointStartedAtMs;

    const existingSnapshot = existingSnapshotPages.get(pageIndex);
    latestSnapshotId = existingSnapshot?.id ?? null;
    if (!latestSnapshotId) {
      const hashStartedAtMs = Date.now();
      const payloadHash = buildGoogleAdsRawSnapshotHash({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        endpointName: input.endpointName,
        startDate: input.date,
        endDate: input.date,
        payload: checkpointChunk,
      });
      hashMs = Date.now() - hashStartedAtMs;
      const rawSnapshotStartedAtMs = Date.now();
      latestSnapshotId = await persistGoogleAdsRawSnapshot({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        partitionId: input.partitionId,
        checkpointId,
        endpointName: input.endpointName,
        entityScope: input.scope,
        pageIndex,
        providerCursor: String(pageIndex),
        startDate: input.date,
        endDate: input.date,
        accountTimezone: input.accountTimezone,
        accountCurrency: input.accountCurrency,
        payloadJson: checkpointChunk,
        payloadHash,
        requestContext: {
          ...input.requestContext,
          partitionId: input.partitionId,
          checkpointScope,
          pageIndex,
        },
        responseHeaders: {
          checkpointScope,
          pageIndex,
          chunkSize: checkpointChunk.length,
        },
        providerHttpStatus: 200,
        status: "fetched",
      });
      rawSnapshotMs = Date.now() - rawSnapshotStartedAtMs;
    } else if (replayDecision.replayReasonCode) {
      replayedSnapshotCount += 1;
    }

    const sourceChunk = existingSnapshot
      ? extractSnapshotRows(existingSnapshot.payload_json)
      : checkpointChunk;
    accumulatedRawSnapshotIds = uniqueSnapshotIds([
      ...accumulatedRawSnapshotIds,
      latestSnapshotId,
    ]);
    storedSnapshotIds = uniqueSnapshotIds([
      ...storedSnapshotIds,
      latestSnapshotId,
    ]);
    storedSnapshotPages = Array.from(
      new Set([...storedSnapshotPages, pageIndex]),
    );
    const replayingPersistedChunk =
      Boolean(existingSnapshot) &&
      Boolean(replayDecision.replayReasonCode) &&
      existingCheckpoint != null &&
      existingCheckpoint.phase !== "fetch_raw";

    const shouldCountChunkAsFetched = shouldCountGoogleAdsReplayChunkAsFetched({
      pageIndex,
      checkpointPageIndex: existingCheckpoint?.pageIndex,
      replayingPersistedChunk,
    });
    rowsFetched += shouldCountChunkAsFetched ? sourceChunk.length : 0;

    const transformCheckpointStartedAtMs = Date.now();
    await upsertGoogleAdsCheckpointOrThrow({
      partitionId: input.partitionId,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      checkpointScope,
      isPaginated: false,
      phase: "transform",
      status: "running",
      pageIndex,
      nextPageToken:
        pageIndex + 1 < rowChunks.length ? String(pageIndex + 1) : null,
      providerCursor:
        pageIndex + 1 < rowChunks.length ? String(pageIndex + 1) : null,
      rowsFetched,
      rowsWritten,
      attemptCount: input.attemptCount ?? 0,
      rawSnapshotIds: accumulatedRawSnapshotIds,
      progressHeartbeatAt: new Date().toISOString(),
      replayReasonCode: replayDecision.replayReasonCode,
      replayDetail:
        existingSnapshot && replayDecision.replayReasonCode
          ? `${replayDecision.replayDetail ?? "Checkpoint replay active."} Replaying persisted raw snapshot for chunk ${pageIndex}.`
          : replayDecision.replayDetail,
      leaseOwner: input.workerId ?? null,
      leaseEpoch: input.leaseEpoch ?? null,
      startedAt: existingCheckpoint?.startedAt ?? new Date().toISOString(),
    });
    checkpointMs += Date.now() - transformCheckpointStartedAtMs;

    const transformStartedAtMs = Date.now();
    const warehouseRows = sourceChunk
      .map((row) => input.mapRow(row, latestSnapshotId))
      .filter((row): row is GoogleAdsWarehouseDailyRow => Boolean(row));
    const transformMs = Date.now() - transformStartedAtMs;

    const bulkCheckpointStartedAtMs = Date.now();
    await upsertGoogleAdsCheckpointOrThrow({
      partitionId: input.partitionId,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      checkpointScope,
      isPaginated: false,
      phase: "bulk_upsert",
      status: "running",
      pageIndex,
      nextPageToken:
        pageIndex + 1 < rowChunks.length ? String(pageIndex + 1) : null,
      providerCursor:
        pageIndex + 1 < rowChunks.length ? String(pageIndex + 1) : null,
      rowsFetched,
      rowsWritten,
      attemptCount: input.attemptCount ?? 0,
      rawSnapshotIds: accumulatedRawSnapshotIds,
      progressHeartbeatAt: new Date().toISOString(),
      replayReasonCode: replayDecision.replayReasonCode,
      replayDetail: replayDecision.replayDetail,
      leaseOwner: input.workerId ?? null,
      leaseEpoch: input.leaseEpoch ?? null,
      lastSuccessfulEntityKey:
        warehouseRows.length > 0
          ? (warehouseRows[warehouseRows.length - 1]?.entityKey ?? null)
          : null,
      startedAt: existingCheckpoint?.startedAt ?? new Date().toISOString(),
    });
    checkpointMs += Date.now() - bulkCheckpointStartedAtMs;

    const warehouseUpsertStartedAtMs = Date.now();
    await upsertGoogleAdsDailyRows(input.scope, warehouseRows);
    const warehouseUpsertMs = Date.now() - warehouseUpsertStartedAtMs;
    logGoogleAdsPersistChunkTelemetry({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      date: input.date,
      scope: input.scope,
      partitionId: input.partitionId,
      pageIndex,
      rowCount: warehouseRows.length,
      hashMs,
      checkpointMs,
      rawSnapshotMs,
      transformMs,
      warehouseUpsertMs,
      totalMs: Date.now() - chunkStartedAtMs,
    });
    rowsWritten += warehouseRows.length;
  }

  const finalRawSnapshotIds = uniqueSnapshotIds([
    ...accumulatedRawSnapshotIds,
    ...existingSnapshots.map((row) => row.id),
    latestSnapshotId,
  ]);
  const completeness = validateGoogleReplayCompleteness({
    totalChunks: rowChunks.length,
    replayWindowStartChunk: startChunkIndex,
    finalRawSnapshotIds,
    storedSnapshotIds,
    storedSnapshotPages,
    rowsFetched,
    rowsWritten,
  });

  if (!completeness.ok) {
    const replayDetail = [
      completeness.lineageBroken ? "raw snapshot lineage is incomplete" : null,
      completeness.snapshotCoverageBroken
        ? "stored raw snapshot count is lower than expected chunk count"
        : null,
      completeness.rowCountBroken ? "rowsWritten exceeded rowsFetched" : null,
    ]
      .filter(Boolean)
      .join("; ");
    await upsertGoogleAdsCheckpointOrThrow({
      partitionId: input.partitionId,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      checkpointScope,
      isPaginated: false,
      phase: "finalize",
      status: "failed",
      pageIndex: Math.max(0, rowChunks.length - 1),
      nextPageToken: null,
      providerCursor: null,
      rowsFetched,
      rowsWritten,
      attemptCount: input.attemptCount ?? 0,
      rawSnapshotIds: finalRawSnapshotIds,
      progressHeartbeatAt: new Date().toISOString(),
      replayReasonCode: "flush_verification_mismatch",
      replayDetail,
      leaseOwner: input.workerId ?? null,
      leaseEpoch: input.leaseEpoch ?? null,
      startedAt: existingCheckpoint?.startedAt ?? new Date().toISOString(),
      finishedAt: new Date().toISOString(),
    });
    throw new Error(
      `Google Ads finalize guard failed for ${input.scope}: ${replayDetail}`,
    );
  }

  await upsertGoogleAdsCheckpointOrThrow({
    partitionId: input.partitionId,
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    checkpointScope,
    isPaginated: false,
    phase: "finalize",
    status: "succeeded",
    pageIndex: Math.max(0, rowChunks.length - 1),
    nextPageToken: null,
    providerCursor: null,
    rowsFetched,
    rowsWritten,
    attemptCount: input.attemptCount ?? 0,
    rawSnapshotIds: finalRawSnapshotIds,
    progressHeartbeatAt: new Date().toISOString(),
    replayReasonCode: replayDecision.replayReasonCode,
    replayDetail:
      replayDecision.replayReasonCode && replayedSnapshotCount > 0
        ? `${replayDecision.replayDetail ?? "Replay completed."} Reused ${replayedSnapshotCount} persisted chunk snapshot(s).`
        : replayDecision.replayDetail,
    leaseOwner: input.workerId ?? null,
    leaseEpoch: input.leaseEpoch ?? null,
    finishedAt: new Date().toISOString(),
    startedAt: existingCheckpoint?.startedAt ?? new Date().toISOString(),
  });

  return { snapshotId: latestSnapshotId, rowCount: rowsWritten };
}

function aggregateAdGroupRows(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  accountTimezone: string;
  accountCurrency: string;
  sourceSnapshotId: string | null;
  rows: GenericRow[];
}): GoogleAdsWarehouseDailyRow[] {
  const byKey = new Map<string, GenericRow>();
  for (const row of input.rows) {
    const adGroupId = nullIfEmpty(row.adGroupId);
    const adGroupName =
      nullIfEmpty(row.adGroupName) ?? nullIfEmpty(row.adGroup);
    const key = adGroupId ?? adGroupName;
    if (!key) continue;
    const current = byKey.get(key) ?? {
      adGroupId,
      adGroupName,
      campaignId: nullIfEmpty(row.campaignId),
      campaignName: nullIfEmpty(row.campaignName) ?? nullIfEmpty(row.campaign),
      status: nullIfEmpty(row.status),
      channel: nullIfEmpty(row.channel),
      spend: 0,
      revenue: 0,
      conversions: 0,
      impressions: 0,
      clicks: 0,
    };
    current.spend = toNumber(current.spend) + toNumber(row.spend);
    current.revenue = toNumber(current.revenue) + toNumber(row.revenue);
    current.conversions =
      toNumber(current.conversions) + toNumber(row.conversions);
    current.impressions =
      toNumber(current.impressions) + toNumber(row.impressions);
    current.clicks = toNumber(current.clicks) + toNumber(row.clicks);
    byKey.set(key, current);
  }

  return Array.from(byKey.entries()).map(([key, row]) =>
    buildWarehouseRow({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      date: input.date,
      accountTimezone: input.accountTimezone,
      accountCurrency: input.accountCurrency,
      entityKey: key,
      entityLabel: nullIfEmpty(row.adGroupName),
      campaignId: nullIfEmpty(row.campaignId),
      campaignName: nullIfEmpty(row.campaignName),
      adGroupId: nullIfEmpty(row.adGroupId),
      adGroupName: nullIfEmpty(row.adGroupName),
      status: nullIfEmpty(row.status),
      channel: nullIfEmpty(row.channel),
      spend: toNumber(row.spend),
      revenue: toNumber(row.revenue),
      conversions: toNumber(row.conversions),
      impressions: toNumber(row.impressions),
      clicks: toNumber(row.clicks),
      payloadJson: row,
      sourceSnapshotId: input.sourceSnapshotId,
    }),
  );
}

function aggregateAccountMetrics(rows: GenericRow[]) {
  return rows.reduce<{
    spend: number;
    revenue: number;
    conversions: number;
    impressions: number;
    clicks: number;
  }>(
    (acc, row) => {
      acc.spend += toNumber(row.spend);
      acc.revenue += toNumber(row.revenue);
      acc.conversions += toNumber(row.conversions);
      acc.impressions += toNumber(row.impressions);
      acc.clicks += toNumber(row.clicks);
      return acc;
    },
    {
      spend: 0,
      revenue: 0,
      conversions: 0,
      impressions: 0,
      clicks: 0,
    },
  );
}

function extractGoogleAdsOverviewMetrics(rows: GenericRow[]) {
  const kpis = aggregateOverviewKpis(rows as never);
  return {
    spend: toNumber(kpis.spend),
    revenue: toNumber(kpis.revenue),
    conversions: toNumber(kpis.conversions),
    impressions: Math.round(toNumber(kpis.impressions)),
    clicks: Math.round(toNumber(kpis.clicks)),
  };
}

function withinGoogleAdsVerificationTolerance(expected: number, actual: number) {
  return Math.abs(expected - actual) <= Math.max(0.01, Math.abs(expected) * 0.001);
}

export function buildGoogleAdsAccountDailyAuditPayload(input: {
  canonicalMetrics: {
    spend: number;
    revenue: number;
    conversions: number;
    impressions: number;
    clicks: number;
  };
  referenceOverview?: {
    spend: number;
    revenue: number;
    conversions: number;
    impressions: number;
    clicks: number;
  } | null;
  campaignRowCount: number;
}) {
  const reference = input.referenceOverview ?? null;
  const overviewDelta = {
    spend: reference
      ? Number((input.canonicalMetrics.spend - reference.spend).toFixed(2))
      : null,
    revenue: reference
      ? Number((input.canonicalMetrics.revenue - reference.revenue).toFixed(2))
      : null,
    conversions: reference
      ? Number((input.canonicalMetrics.conversions - reference.conversions).toFixed(2))
      : null,
    impressions: reference
      ? Number((input.canonicalMetrics.impressions - reference.impressions).toFixed(2))
      : null,
    clicks: reference
      ? Number((input.canonicalMetrics.clicks - reference.clicks).toFixed(2))
      : null,
  };
  const integrityStatus =
    !reference
      ? "unverified"
      : withinGoogleAdsVerificationTolerance(
            input.canonicalMetrics.spend,
            reference.spend,
          ) &&
          withinGoogleAdsVerificationTolerance(
            input.canonicalMetrics.impressions,
            reference.impressions,
          ) &&
          withinGoogleAdsVerificationTolerance(
            input.canonicalMetrics.clicks,
            reference.clicks,
          )
        ? "verified"
        : "mismatch";

  return {
    canonicalSource: "campaign_rollup" as const,
    campaignRowCount: input.campaignRowCount,
    rawOverview: reference,
    overviewDelta,
    integrityStatus,
  };
}

export function summarizeGoogleAdsIntegrityIncidents(
  incidents: Array<{
    providerAccountId: string;
    date: string;
  }>,
) {
  const mismatchDates = Array.from(
    new Set(incidents.map((incident) => incident.date)),
  ).sort();
  const providerAccountIds = Array.from(
    new Set(incidents.map((incident) => incident.providerAccountId)),
  ).sort();
  return {
    incidentCount: incidents.length,
    mismatchDates,
    providerAccountIds,
  };
}

export function shouldRetryGoogleAdsEmptyCampaignDaily(input: {
  overview:
    | {
        spend: number;
        revenue: number;
        conversions: number;
        impressions: number;
        clicks: number;
      }
    | null
    | undefined;
  campaignRowCount: number;
}) {
  if (!input.overview || input.campaignRowCount > 0) return false;
  return (
    input.overview.spend > 0 ||
    input.overview.revenue > 0 ||
    input.overview.conversions > 0 ||
    input.overview.impressions > 0 ||
    input.overview.clicks > 0
  );
}

function isGoogleAdsFallbackCompatibleProductFailure(
  failure: GoogleAdsReportMeta["failed_queries"][number],
  meta: GoogleAdsWarehouseReportLike["meta"],
) {
  if (failure.query !== "product_performance") return false;
  if (!meta?.query_names?.includes("product_performance_legacy")) return false;
  return (
    failure.category === "unsupported_query_shape" ||
    failure.category === "unavailable_metric" ||
    failure.category === "bad_query_shape"
  );
}

function isGoogleAdsOptionalMetricFailure(
  failure: GoogleAdsReportMeta["failed_queries"][number],
) {
  return (
    failure.severity === "optional" &&
    (failure.category === "unsupported_query_shape" ||
      failure.category === "unavailable_metric" ||
      failure.category === "bad_query_shape")
  );
}

export function getGoogleAdsWarehouseFetchFailureReason(input: {
  scope: GoogleAdsWarehouseScope;
  report: GoogleAdsWarehouseReportLike | null | undefined;
}) {
  const failures = input.report?.meta?.failed_queries ?? [];
  if (failures.length === 0) return null;
  const rowCount = Array.isArray(input.report?.rows)
    ? input.report.rows.length
    : 0;
  const blockingFailures = failures.filter((failure) => {
    if (
      input.scope === "product_daily" &&
      isGoogleAdsFallbackCompatibleProductFailure(failure, input.report?.meta)
    ) {
      return false;
    }
    if (rowCount > 0 && isGoogleAdsOptionalMetricFailure(failure)) {
      return false;
    }
    return true;
  });
  if (blockingFailures.length === 0) return null;
  const first = blockingFailures[0];
  return [
    `google_ads_${input.scope}_fetch_failed`,
    first?.query ? `query=${first.query}` : null,
    first?.apiStatus ? `apiStatus=${first.apiStatus}` : null,
    first?.apiErrorCode ? `apiErrorCode=${first.apiErrorCode}` : null,
    first?.message ? `message=${first.message}` : null,
  ]
    .filter(Boolean)
    .join(": ");
}

function assertGoogleAdsWarehouseFetchSucceeded(input: {
  scope: GoogleAdsWarehouseScope;
  report: GoogleAdsWarehouseReportLike | null | undefined;
}) {
  const reason = getGoogleAdsWarehouseFetchFailureReason(input);
  if (!reason) return;
  throw new GoogleAdsRetryableSyncError(reason);
}

async function resolveGoogleAdsCurrentDate(
  businessId: string,
  providerAccountId?: string | null,
) {
  return getProviderPlatformCurrentDate({
    provider: "google",
    businessId,
    providerAccountId,
  });
}

async function getMissingDatesForScope(input: {
  businessId: string;
  scope: GoogleAdsWarehouseScope;
  startDate: string;
  endDate: string;
  recentFirst?: boolean;
}) {
  const coveredDates = new Set(
    await getGoogleAdsCoveredDates({
      scope: input.scope,
      businessId: input.businessId,
      providerAccountId: null,
      startDate: input.startDate,
      endDate: input.endDate,
    }).catch(() => []),
  );
  return enumerateDays(
    input.startDate,
    input.endDate,
    input.recentFirst ?? false,
  ).filter((date) => !coveredDates.has(date));
}

function getGoogleAdsWorkerId() {
  const overridden = process.env.GOOGLE_ADS_WORKER_ID?.trim();
  if (overridden) return overridden;
  const sharedWorkerId = process.env.WORKER_INSTANCE_ID?.trim();
  if (sharedWorkerId) return sharedWorkerId;
  return `worker:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
}

async function computeHistoricalTargets(
  businessId: string,
  providerAccountId?: string | null,
) {
  const today = await resolveGoogleAdsCurrentDate(
    businessId,
    providerAccountId,
  ).catch(() =>
    new Date().toISOString().slice(0, 10),
  );
  const yesterday = addDaysToIsoDate(today, -1);
  const historicalStart = getHistoricalWindowStart(
    yesterday,
    GOOGLE_ADS_WAREHOUSE_HISTORY_DAYS,
  );
  return {
    today,
    yesterday,
    historicalStart,
  };
}

async function queueGoogleAdsD1FinalizePartitions(input: {
  businessId: string;
  providerAccountId: string;
  targetDate: string;
}) {
  await assertDbSchemaReady({
    tables: ["google_ads_sync_partitions"],
    context: "google_ads_sync:queue_d1_finalize",
  });
  const sql = getDb();
  const businessRefId =
    (await resolveBusinessReferenceIds([input.businessId])).get(input.businessId) ??
    null;
  const providerAccountRefId =
    (
      await ensureProviderAccountReferenceIds({
        provider: "google",
        accounts: [{ externalAccountId: input.providerAccountId }],
      })
    ).get(input.providerAccountId) ?? null;
  const [accountRows, campaignRows] = await Promise.all([
    getGoogleAdsCoveredDates({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      scope: "account_daily",
      startDate: input.targetDate,
      endDate: input.targetDate,
    }).catch(() => [] as string[]),
    getGoogleAdsCoveredDates({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      scope: "campaign_daily",
      startDate: input.targetDate,
      endDate: input.targetDate,
    }).catch(() => [] as string[]),
  ]);
  const scopesToQueue = getGoogleAdsD1FinalizeScopesToQueue({
    accountDailyCovered: accountRows.includes(input.targetDate),
    campaignDailyCovered: campaignRows.includes(input.targetDate),
  });
  if (scopesToQueue.length === 0) {
    return 0;
  }
  await sql`
    UPDATE google_ads_sync_partitions
    SET
      source = 'finalize_day',
      priority = GREATEST(priority, ${GOOGLE_ADS_D1_FINALIZE_PRIORITY}),
      business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
      provider_account_ref_id = COALESCE(
        provider_account_ref_id,
        ${providerAccountRefId}
      ),
      updated_at = now()
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND lane = 'maintenance'
      AND scope = ANY(${scopesToQueue}::text[])
      AND partition_date = ${input.targetDate}::date
      AND source IN ('today', 'recent')
      AND status IN ('queued', 'leased', 'running')
  `;
  let queued = 0;
  for (const scope of scopesToQueue) {
    const row = await queueGoogleAdsSyncPartition({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      lane: "maintenance",
      scope,
      partitionDate: input.targetDate,
      status: "queued",
      priority: GOOGLE_ADS_D1_FINALIZE_PRIORITY,
      source: "finalize_day",
      attemptCount: 0,
    }).catch(() => null);
    if (row?.id) queued += 1;
  }
  if (queued > 0) {
    await markProviderDayRolloverFinalizeStarted({
      provider: "google_ads",
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      targetDate: input.targetDate,
    }).catch(() => null);
  }
  return queued;
}

export async function recoverGoogleAdsD1FinalizePartitions(input: {
  businessId: string;
  staleLeaseMinutes?: number;
  finalizeSlaMinutes?: number;
}) {
  await assertDbSchemaReady({
    tables: ["google_ads_sync_partitions"],
    context: "google_ads_sync:recover_d1_finalize",
  });
  const sql = getDb();
  const staleThresholdMs = Math.max(1, input.staleLeaseMinutes ?? 8) * 60_000;
  const finalizeSlaMs = Math.max(1, input.finalizeSlaMinutes ?? 20) * 60_000;
  const businessRefId =
    (await resolveBusinessReferenceIds([input.businessId])).get(input.businessId) ??
    null;
  const accounts = await syncProviderDayRolloverState({
    provider: "google_ads",
    businessId: input.businessId,
  }).catch(() => []);
  if (accounts.length === 0) {
    return {
      businessId: input.businessId,
      candidateCount: 0,
      aliveSlowCount: 0,
      stalledReclaimableCount: 0,
      reclaimedPartitionIds: [] as string[],
      d1FinalizeRecoveryQueued: false,
      d1FinalizeRecoveredCount: 0,
      d1FinalizeForceReclaimedCount: 0,
      queuedFinalizePartitions: 0,
    };
  }
  const providerAccountRefIds = await ensureProviderAccountReferenceIds({
    provider: "google",
    accounts: accounts.map((account) => ({
      externalAccountId: account.providerAccountId,
    })),
  });

  const candidates = (await sql`
    SELECT
      partition.id,
      partition.provider_account_id,
      partition.partition_date,
      partition.lane,
      partition.scope,
      partition.source,
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
          AND lease.provider_scope = 'google_ads'
          AND lease.lease_owner = partition.lease_owner
          AND lease.lease_expires_at > now()
      ) OR EXISTS (
        SELECT 1
        FROM google_ads_runner_leases lease
        WHERE lease.business_id = partition.business_id
          AND lease.lane = partition.lane
          AND lease.lease_owner = partition.lease_owner
          AND lease.lease_expires_at > now()
      ) AS has_matching_runner_lease
    FROM google_ads_sync_partitions partition
    LEFT JOIN LATERAL (
      SELECT checkpoint.updated_at
      FROM google_ads_sync_checkpoints checkpoint
      WHERE checkpoint.partition_id = partition.id
        AND COALESCE(checkpoint.lease_epoch, 0) = COALESCE(partition.lease_epoch, 0)
      ORDER BY COALESCE(checkpoint.progress_heartbeat_at, checkpoint.updated_at) DESC
      LIMIT 1
    ) checkpoint ON TRUE
    LEFT JOIN LATERAL (
      SELECT run.status
      FROM google_ads_sync_runs run
      WHERE run.partition_id = partition.id
      ORDER BY run.created_at DESC
      LIMIT 1
    ) run ON TRUE
    WHERE partition.business_id = ${input.businessId}
      AND partition.scope = ANY(${GOOGLE_ADS_D1_FINALIZE_SCOPES}::text[])
      AND partition.status IN ('queued', 'leased', 'running')
      AND partition.source IN ('today', 'recent', 'historical', 'finalize_day')
  `) as Array<{
    id: string;
    provider_account_id: string;
    partition_date: string | Date;
    lane: GoogleAdsSyncLane;
    scope: GoogleAdsWarehouseScope;
    source: string;
    status: string;
    updated_at: string | Date | null;
    lease_owner: string | null;
    lease_expires_at: string | Date | null;
    checkpoint_updated_at: string | Date | null;
    run_status: string | null;
    has_matching_runner_lease: boolean;
  }>;

  const targetByAccount = new Map(
    accounts.map((account) => [account.providerAccountId, account.currentD1TargetDate] as const),
  );
  const matchingCandidates = candidates.filter((row) => {
    const targetDate = targetByAccount.get(String(row.provider_account_id));
    return targetDate != null && String(row.partition_date).slice(0, 10) === targetDate;
  });

  const nowMs = Date.now();
  const aliveSlowPartitionIds: string[] = [];
  const stalledPartitionIds: string[] = [];

  for (const row of matchingCandidates) {
    const progressMs = parseTimestampMs(row.checkpoint_updated_at);
    const updatedMs = parseTimestampMs(row.updated_at);
    const hasRecentProgress = progressMs != null && nowMs - progressMs <= staleThresholdMs;
    const hasMatchingRunnerLease = Boolean(row.has_matching_runner_lease);
    const finalizeSlaExceeded = updatedMs != null && nowMs - updatedMs > finalizeSlaMs;
    const latestRunSucceeded = row.run_status === "succeeded";
    if (latestRunSucceeded) {
      stalledPartitionIds.push(String(row.id));
      continue;
    }
    if (hasRecentProgress || hasMatchingRunnerLease) {
      aliveSlowPartitionIds.push(String(row.id));
      continue;
    }
    if (row.status === "queued" || finalizeSlaExceeded) {
      stalledPartitionIds.push(String(row.id));
      continue;
    }
    stalledPartitionIds.push(String(row.id));
  }

  if (stalledPartitionIds.length > 0) {
    await sql`
      UPDATE google_ads_sync_partitions
      SET
        status = 'cancelled',
        lease_owner = NULL,
        lease_expires_at = NULL,
        finished_at = COALESCE(finished_at, now()),
        business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
        last_error = COALESCE(last_error, 'stale D-1 finalize ownership reclaimed automatically'),
        updated_at = now()
      WHERE id = ANY(${stalledPartitionIds}::uuid[])
    `;
    if (providerAccountRefIds.size > 0) {
      await sql`
        UPDATE google_ads_sync_partitions AS partition
        SET provider_account_ref_id = provider_account.id
        FROM provider_accounts AS provider_account
        WHERE partition.id = ANY(${stalledPartitionIds}::uuid[])
          AND partition.provider_account_ref_id IS NULL
          AND provider_account.provider = 'google'
          AND provider_account.external_account_id = partition.provider_account_id
      `;
    }
    await recordSyncReclaimEvents({
      providerScope: "google_ads",
      businessId: input.businessId,
      partitionIds: stalledPartitionIds,
      eventType: "reclaimed",
      disposition: "stalled_reclaimable",
      reasonCode: "lease_expired_no_progress",
      detail: "Stale Google Ads D-1 finalize ownership reclaimed automatically.",
    }).catch(() => null);
  }

  let queuedFinalizePartitions = 0;
  for (const account of accounts) {
    const targetDate = account.currentD1TargetDate;
    const [accountRows, campaignRows, activeAccountRows, activeCampaignRows] = await Promise.all([
      getGoogleAdsCoveredDates({
        businessId: input.businessId,
        providerAccountId: account.providerAccountId,
        scope: "account_daily",
        startDate: targetDate,
        endDate: targetDate,
      }).catch(() => [] as string[]),
      getGoogleAdsCoveredDates({
        businessId: input.businessId,
        providerAccountId: account.providerAccountId,
        scope: "campaign_daily",
        startDate: targetDate,
        endDate: targetDate,
      }).catch(() => [] as string[]),
      getGoogleAdsPartitionDates({
        businessId: input.businessId,
        providerAccountId: account.providerAccountId,
        scope: "account_daily",
        lane: "maintenance",
        startDate: targetDate,
        endDate: targetDate,
        statuses: [...getGoogleAdsGapPlannerBlockingStatuses()],
      }).catch(() => [] as string[]),
      getGoogleAdsPartitionDates({
        businessId: input.businessId,
        providerAccountId: account.providerAccountId,
        scope: "campaign_daily",
        startDate: targetDate,
        endDate: targetDate,
        statuses: [...getGoogleAdsGapPlannerBlockingStatuses()],
      }).catch(() => [] as string[]),
    ]);

    const covered =
      accountRows.includes(targetDate) && campaignRows.includes(targetDate);
    if (covered && activeAccountRows.length === 0 && activeCampaignRows.length === 0) {
      await markProviderDayRolloverFinalizeCompleted({
        provider: "google_ads",
        businessId: input.businessId,
        providerAccountId: account.providerAccountId,
        targetDate,
      }).catch(() => null);
      continue;
    }
    if (covered) continue;

    const matchingRows = matchingCandidates.filter(
      (row) =>
        row.provider_account_id === account.providerAccountId &&
        String(row.partition_date).slice(0, 10) === targetDate &&
        row.status !== "cancelled",
    );
    if (covered) {
      const coveredResolution = resolveGoogleAdsCoveredD1FinalizeResolution({
        matchingRows: matchingRows.map((row) => ({
          id: String(row.id),
          source: String(row.source),
          status: String(row.status),
        })),
      });
      if (coveredResolution.queuedFinalizePartitionIds.length > 0) {
        await sql`
          UPDATE google_ads_sync_partitions
          SET
            status = 'cancelled',
            lease_owner = NULL,
            lease_expires_at = NULL,
            finished_at = COALESCE(finished_at, now()),
            business_ref_id = COALESCE(business_ref_id, ${businessRefId}),
            last_error = COALESCE(last_error, 'covered D-1 finalize partition superseded by canonical warehouse coverage'),
            updated_at = now()
          WHERE id = ANY(${coveredResolution.queuedFinalizePartitionIds}::uuid[])
        `;
      }
      if (coveredResolution.shouldMarkCompleted) {
        await markProviderDayRolloverFinalizeCompleted({
          provider: "google_ads",
          businessId: input.businessId,
          providerAccountId: account.providerAccountId,
          targetDate,
        }).catch(() => null);
      }
      continue;
    }
    const hasActiveAuthoritativeRow = matchingRows.some(
      (row) => row.source === "finalize_day" && !stalledPartitionIds.includes(String(row.id)),
    );
    if (!hasActiveAuthoritativeRow) {
      queuedFinalizePartitions += await queueGoogleAdsD1FinalizePartitions({
        businessId: input.businessId,
        providerAccountId: account.providerAccountId,
        targetDate,
      }).catch(() => 0);
    }
    if (stalledPartitionIds.length > 0) {
      await markProviderDayRolloverRecovered({
        provider: "google_ads",
        businessId: input.businessId,
        providerAccountId: account.providerAccountId,
        targetDate,
      }).catch(() => null);
    }
  }

  return {
    businessId: input.businessId,
    candidateCount: matchingCandidates.length,
    aliveSlowCount: aliveSlowPartitionIds.length,
    stalledReclaimableCount: stalledPartitionIds.length,
    reclaimedPartitionIds: stalledPartitionIds,
    d1FinalizeRecoveryQueued: queuedFinalizePartitions > 0,
    d1FinalizeRecoveredCount: stalledPartitionIds.length,
    d1FinalizeForceReclaimedCount: stalledPartitionIds.length,
    queuedFinalizePartitions,
  };
}

export function decideGoogleAdsHistoricalFrontier(input: {
  historicalStart: string;
  recent90Start: string;
  recent90Complete: boolean;
}) {
  return input.recent90Complete ? input.historicalStart : input.recent90Start;
}

export function resolveGoogleAdsHistoricalReplayStart(input: {
  historicalStart: string | null;
  recent90Start?: string | null;
  recent90Complete?: boolean;
  fullSyncPriorityRequired?: boolean;
  allowPriorityHistorical?: boolean;
}) {
  if (!input.historicalStart) return null;
  if (input.fullSyncPriorityRequired || input.allowPriorityHistorical) {
    return input.historicalStart;
  }
  if (!input.recent90Start) return input.historicalStart;
  return decideGoogleAdsHistoricalFrontier({
    historicalStart: input.historicalStart,
    recent90Start: input.recent90Start,
    recent90Complete: input.recent90Complete ?? true,
  });
}

export function shouldBlockGoogleAdsHistoricalExtendedWork(input: {
  recent90Complete: boolean;
  allowPriorityHistorical?: boolean;
}) {
  return !input.recent90Complete && !input.allowPriorityHistorical;
}

export function shouldAllowGoogleAdsPriorityHistoricalReplay(input: {
  fullSyncPriorityRequired: boolean;
  fullSyncPriorityTargetScopes: GoogleAdsWarehouseScope[];
}) {
  return (
    input.fullSyncPriorityRequired &&
    input.fullSyncPriorityTargetScopes.length > 0
  );
}

export function planGoogleAdsRecentMaintenanceDates(input: {
  recentDates: string[];
  coveredDates: string[];
  activeDates: string[];
  skipDates?: string[];
}) {
  const blockedDates = new Set([
    ...input.coveredDates,
    ...input.activeDates,
    ...(input.skipDates ?? []),
  ]);
  return input.recentDates.filter((date) => !blockedDates.has(date));
}

export function getGoogleAdsCoveredRecentMaintenanceDatesToCancel(input: {
  coveredDates: string[];
  protectedDates?: string[];
}) {
  const protectedDates = new Set(input.protectedDates ?? []);
  return input.coveredDates.filter((date) => !protectedDates.has(date));
}

export function getGoogleAdsD1FinalizeScopesToQueue(input: {
  accountDailyCovered: boolean;
  campaignDailyCovered: boolean;
}) {
  const scopes: GoogleAdsWarehouseScope[] = [];
  if (!input.accountDailyCovered) scopes.push("account_daily");
  if (!input.campaignDailyCovered) scopes.push("campaign_daily");
  return scopes;
}

export function resolveGoogleAdsCoveredD1FinalizeResolution(input: {
  matchingRows: Array<{
    id: string;
    source: string;
    status: string;
  }>;
}) {
  const finalizeRows = input.matchingRows.filter(
    (row) => row.source === "finalize_day",
  );
  const queuedFinalizePartitionIds = finalizeRows
    .filter((row) => row.status === "queued")
    .map((row) => row.id);
  const hasLiveFinalizeLeaseOrRun = finalizeRows.some(
    (row) => row.status === "leased" || row.status === "running",
  );
  return {
    queuedFinalizePartitionIds,
    hasLiveFinalizeLeaseOrRun,
    shouldMarkCompleted: !hasLiveFinalizeLeaseOrRun,
  };
}

export async function getGoogleAdsRecent90CompletionState(input: {
  businessId: string;
}) {
  const { historicalStart, yesterday } = await computeHistoricalTargets(
    input.businessId,
  );
  const recent90Start = addDaysToIsoDate(yesterday, -89);
  const frontierStart =
    recent90Start > historicalStart ? recent90Start : historicalStart;
  const totalDays = dayCountInclusive(frontierStart, yesterday);
  const coverageRows = await Promise.all(
    GOOGLE_ADS_RECENT_90_FRONTIER_SCOPES.map(async (scope) => ({
      scope,
      coverage: await getGoogleAdsDailyCoverage({
        scope,
        businessId: input.businessId,
        providerAccountId: null,
        startDate: frontierStart,
        endDate: yesterday,
      }).catch(() => null),
    })),
  );

  const incompleteScopes = coverageRows
    .filter((entry) => Number(entry.coverage?.completed_days ?? 0) < totalDays)
    .map((entry) => entry.scope);

  return {
    recent90Start: frontierStart,
    yesterday,
    totalDays,
    complete: incompleteScopes.length === 0,
    incompleteScopes,
  };
}

async function enqueueHistoricalCorePartitions(businessId: string) {
  const accountIds = await getConnectedAssignedGoogleAccounts(businessId).catch(
    () => [],
  );
  if (accountIds.length === 0) return 0;
  let queued = 0;
  for (const providerAccountId of accountIds) {
    const { historicalStart, yesterday } = await computeHistoricalTargets(
      businessId,
      providerAccountId,
    );
    const recent90Start = addDaysToIsoDate(yesterday, -89);
    const frontierStart =
      recent90Start > historicalStart ? recent90Start : historicalStart;
    for (const scope of GOOGLE_ADS_D1_FINALIZE_SCOPES) {
      const [recentCoveredDates, recentActivePartitionDates] = await Promise.all([
        getGoogleAdsCoveredDates({
          scope,
          businessId,
          providerAccountId,
          startDate: frontierStart,
          endDate: yesterday,
        }).catch(() => []),
        getGoogleAdsPartitionDates({
          businessId,
          providerAccountId,
          lane: "core",
          scope,
          startDate: frontierStart,
          endDate: yesterday,
          statuses: [...getGoogleAdsGapPlannerBlockingStatuses()],
        }).catch(() => []),
      ]);
      const recentBlockedDates = new Set([
        ...recentCoveredDates,
        ...recentActivePartitionDates,
      ]);
      const recentMissingDates = enumerateDays(frontierStart, yesterday, true)
        .filter((date) => date !== yesterday)
        .filter((date) => !recentBlockedDates.has(date));
      const targetStart =
        recentMissingDates.length > 0 ? frontierStart : historicalStart;
      const [coveredDates, activePartitionDates] =
        targetStart === frontierStart
          ? [recentCoveredDates, recentActivePartitionDates]
          : await Promise.all([
              getGoogleAdsCoveredDates({
                scope,
                businessId,
                providerAccountId,
                startDate: targetStart,
                endDate: yesterday,
              }).catch(() => []),
              getGoogleAdsPartitionDates({
                businessId,
                providerAccountId,
                lane: "core",
                scope,
                startDate: targetStart,
                endDate: yesterday,
                statuses: [...getGoogleAdsGapPlannerBlockingStatuses()],
              }).catch(() => []),
            ]);
      const blockedDates = new Set([...coveredDates, ...activePartitionDates]);
      const dates = enumerateDays(targetStart, yesterday, true)
        .filter((date) => date !== yesterday)
        .filter((date) => !blockedDates.has(date))
        .slice(0, GOOGLE_ADS_BOOTSTRAP_BATCH_DAYS);

      for (const date of dates) {
        const row = await queueGoogleAdsSyncPartition({
          businessId,
          providerAccountId,
          lane: "core",
          scope,
          partitionDate: date,
          status: "queued",
          priority: 0,
          source: "historical",
          attemptCount: 0,
        }).catch(() => null);
        if (row?.id) queued++;
      }
    }
  }
  return queued;
}

async function enqueueMaintenancePartitions(businessId: string) {
  const sql = getDb();
  const accountIds = await getConnectedAssignedGoogleAccounts(businessId).catch(
    () => [],
  );
  if (accountIds.length === 0) return;
  for (const providerAccountId of accountIds) {
    const { today, yesterday } = await computeHistoricalTargets(
      businessId,
      providerAccountId,
    );
    const recentStartDate = addDaysToIsoDate(
      yesterday,
      -(GOOGLE_ADS_RECENT_MAINTENANCE_DAYS - 1),
    );
    const recentDates = enumerateDays(
      recentStartDate,
      yesterday,
      true,
    );
    const [coveredRecentDates, activeRecentDates] = await Promise.all([
      getGoogleAdsCoveredDates({
        businessId,
        providerAccountId,
        scope: "campaign_daily",
        startDate: recentStartDate,
        endDate: today,
      }).catch(() => [] as string[]),
      getGoogleAdsPartitionDates({
        businessId,
        providerAccountId,
        lane: "maintenance",
        scope: "campaign_daily",
        startDate: recentStartDate,
        endDate: today,
        statuses: [...getGoogleAdsGapPlannerBlockingStatuses()],
      }).catch(() => [] as string[]),
    ]);
    const blockedRecentDates = new Set([
      ...coveredRecentDates,
      ...activeRecentDates,
    ]);
    const coveredRecentDatesToCancel =
      getGoogleAdsCoveredRecentMaintenanceDatesToCancel({
        coveredDates: coveredRecentDates,
        protectedDates: [today, yesterday],
      });
    if (coveredRecentDatesToCancel.length > 0) {
      await sql`
        UPDATE google_ads_sync_partitions
        SET
          status = 'cancelled',
          lease_owner = NULL,
          lease_expires_at = NULL,
          finished_at = COALESCE(finished_at, now()),
          last_error = COALESCE(last_error, 'covered recent maintenance partition superseded by canonical warehouse coverage'),
          updated_at = now()
        WHERE business_id = ${businessId}
          AND provider_account_id = ${providerAccountId}
          AND lane = 'maintenance'
          AND scope = 'campaign_daily'
          AND source = 'recent'
          AND status = 'queued'
          AND partition_date = ANY(${coveredRecentDatesToCancel}::date[])
      `;
    }
    const recentDatesToQueue = planGoogleAdsRecentMaintenanceDates({
      recentDates,
      coveredDates: coveredRecentDates,
      activeDates: activeRecentDates,
      skipDates: [yesterday],
    });
    for (const date of recentDatesToQueue) {
      await queueGoogleAdsSyncPartition({
        businessId,
        providerAccountId,
        lane: "maintenance",
        scope: "campaign_daily",
        partitionDate: date,
        status: "queued",
        priority: -10,
        source: "recent",
        attemptCount: 0,
      }).catch(() => null);
    }
    await queueGoogleAdsD1FinalizePartitions({
      businessId,
      providerAccountId,
      targetDate: yesterday,
    }).catch(() => 0);
    if (blockedRecentDates.has(today)) continue;
    await queueGoogleAdsSyncPartition({
      businessId,
      providerAccountId,
      lane: "maintenance",
      scope: "campaign_daily",
      partitionDate: today,
      status: "queued",
      priority: 10,
      source: "today",
      attemptCount: 0,
    }).catch(() => null);
  }
}

export async function enqueueGoogleAdsScheduledWork(businessId: string) {
  await refreshGoogleAdsSyncStateForBusiness({ businessId }).catch(() => null);
  const d1Recovery = await recoverGoogleAdsD1FinalizePartitions({
    businessId,
  }).catch(() => null);
  const queuedCore = await enqueueHistoricalCorePartitions(businessId).catch(
    () => 0,
  );
  await enqueueMaintenancePartitions(businessId).catch(() => null);
  const queueHealth = await getGoogleAdsQueueHealth({ businessId }).catch(
    () => null,
  );
  return {
    businessId,
    d1Recovery,
    queuedCore,
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
  };
}

export async function refreshGoogleAdsSyncStateForBusiness(input: {
  businessId: string;
  scopes?: GoogleAdsWarehouseScope[];
}) {
  const accountIds = await getConnectedAssignedGoogleAccounts(input.businessId).catch(
    () => [],
  );
  if (accountIds.length === 0) return;
  const scopes = input.scopes ?? GOOGLE_ADS_STATE_SCOPES;
  for (const providerAccountId of accountIds) {
    for (const scope of scopes) {
      try {
        await refreshGoogleAdsSyncStateForPartition({
          businessId: input.businessId,
          providerAccountId,
          scope,
        });
      } catch (error) {
        console.warn("[google-ads-sync] scope_state_refresh_failed", {
          businessId: input.businessId,
          providerAccountId,
          scope,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }
}

async function computeContiguousReadyThroughDate(input: {
  businessId: string;
  providerAccountId: string;
  scope: GoogleAdsWarehouseScope;
  targetStart: string;
  targetEnd: string;
}) {
  const covered = new Set(
    await getGoogleAdsCoveredDates({
      scope: input.scope,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      startDate: input.targetStart,
      endDate: input.targetEnd,
    }).catch(() => []),
  );
  const descending = enumerateDays(input.targetStart, input.targetEnd, true);
  let readyThroughDate: string | null = null;
  for (const date of descending) {
    if (!covered.has(date)) break;
    readyThroughDate = date;
  }
  return readyThroughDate;
}

export function scheduleGoogleAdsBackgroundSync(input: {
  businessId: string;
  delayMs?: number;
}) {
  if (!canUseInProcessBackgroundScheduling()) {
    if (
      process.env.NODE_ENV !== "production" &&
      process.env.SYNC_WORKER_MODE === "1" &&
      GOOGLE_ADS_IN_PROCESS_RUNTIME_ENABLED &&
      !hasGoogleAdsInProcessBackgroundWorkerIdentity()
    ) {
      logRuntimeInfo("google-ads-sync", "background_sync_skipped_missing_worker_identity", {
        businessId: input.businessId,
      });
    }
    return false;
  }
  const timers = getBackgroundWorkerTimers();
  if (timers.has(input.businessId)) return false;

  const timer = setTimeout(
    async () => {
      timers.delete(input.businessId);
      try {
        const runtimeWorkerId =
          process.env.GOOGLE_ADS_WORKER_ID?.trim() ||
          process.env.WORKER_INSTANCE_ID?.trim() ||
          undefined;
        await syncGoogleAdsReports(
          input.businessId,
          runtimeWorkerId ? { runtimeWorkerId } : undefined,
        );
      } catch (error) {
        console.error("[google-ads-sync] background_loop_failed", {
          businessId: input.businessId,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    },
    Math.max(0, input.delayMs ?? GOOGLE_ADS_BACKGROUND_LOOP_DELAY_MS),
  );

  timers.set(input.businessId, timer);
  return true;
}

async function syncGoogleAdsDates(input: {
  businessId: string;
  dates: string[];
  syncType: GoogleAdsSyncType;
  triggerSource: string;
  scopes?: GoogleAdsWarehouseScope[];
}) {
  await expireStaleGoogleAdsSyncJobs({ businessId: input.businessId }).catch(
    () => null,
  );
  const accountIds = await getConnectedAssignedGoogleAccounts(input.businessId).catch(
    () => [],
  );
  if (accountIds.length === 0 || input.dates.length === 0) {
    return {
      businessId: input.businessId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
    };
  }

  let succeeded = 0;
  let failed = 0;
  let skipped = 0;
  for (const date of input.dates) {
    for (const providerAccountId of accountIds) {
      try {
        const synced = await syncGoogleAdsAccountDay({
          businessId: input.businessId,
          providerAccountId,
          date,
          syncType: input.syncType,
          triggerSource: input.triggerSource,
          scopes: input.scopes,
        });
        if (synced) succeeded++;
        else skipped++;
      } catch (error) {
        failed++;
        console.warn("[google-ads-sync] day_failed", {
          businessId: input.businessId,
          providerAccountId,
          date,
          message: error instanceof Error ? error.message : String(error),
        });
      }
    }
  }

  return {
    businessId: input.businessId,
    attempted: input.dates.length * accountIds.length,
    succeeded,
    failed,
    skipped: skipped > 0 && succeeded === 0 && failed === 0,
  };
}

async function syncGoogleAdsAccountDay(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
  syncType: GoogleAdsSyncType;
  triggerSource: string;
  scopes?: GoogleAdsWarehouseScope[];
  partitionOwned?: boolean;
  partitionId?: string;
  workerId?: string;
  leaseEpoch?: number;
  attemptCount?: number;
}) {
  const scopes = new Set<GoogleAdsWarehouseScope>(
    input.scopes ?? [
      "account_daily",
      "campaign_daily",
      "ad_group_daily",
      "ad_daily",
      "keyword_daily",
      "search_term_daily",
      "asset_group_daily",
      "asset_daily",
      "audience_daily",
      "geo_daily",
      "device_daily",
      "product_daily",
    ],
  );
  const wants = (scope: GoogleAdsWarehouseScope) => scopes.has(scope);
  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: "google",
  }).catch(() => null);
  const profile = getScopeProfile(snapshot, input.providerAccountId);
  const fetchPlan = buildGoogleAdsWarehouseFetchPlan(scopes);
  const baseParams = {
    businessId: input.businessId,
    accountId: input.providerAccountId,
    dateRange: "custom" as const,
    customStart: input.date,
    customEnd: input.date,
    debug: false,
  };

  const primaryScope = resolvePrimaryGoogleAdsSyncScope(scopes);
  const shouldWriteLegacyJobs = !input.partitionOwned;
  let jobIds: string[] = [];
  const syncStartedAtMs = Date.now();
  let fetchCompletedAtMs = syncStartedAtMs;
  let transformAccumulatedMs = 0;
  let persistAccumulatedMs = 0;
  const scopeMetrics: GoogleAdsPhaseTelemetry["scopeMetrics"] = [];

  const recordPersistMetric = async <T>(
    scope: GoogleAdsWarehouseScope,
    rowCount: number,
    operation: () => Promise<T>,
  ) => {
    const startedAtMs = Date.now();
    const result = await operation();
    const durationMs = Date.now() - startedAtMs;
    persistAccumulatedMs += durationMs;
    scopeMetrics.push({
      scope,
      rowCount,
      batchCount: Math.max(
        1,
        Math.ceil(rowCount / getGoogleAdsScopeCheckpointChunkSize(scope)),
      ),
      chunkSize: getGoogleAdsScopeCheckpointChunkSize(scope),
      persistedRowCount:
        result &&
        typeof result === "object" &&
        "rowCount" in result &&
        typeof (result as { rowCount?: unknown }).rowCount === "number"
          ? (result as { rowCount: number }).rowCount
          : rowCount,
      durationMs,
    });
    return result;
  };

  if (shouldWriteLegacyJobs) {
    const primaryJob = await createScopeSyncJob({
      ...input,
      startDate: input.date,
      endDate: input.date,
      scope: primaryScope,
    });
    if (!primaryJob?.id) return false;
    if (
      !primaryJob.created &&
      !canReuseExistingGoogleAdsSyncJob({
        syncType: input.syncType,
        triggerSource: input.triggerSource,
      })
    ) {
      return false;
    }

    const secondaryScopes = Array.from(scopes).filter(
      (scope) => scope !== primaryScope,
    );
    const secondaryJobs = await Promise.all(
      secondaryScopes.map((scope) =>
        createScopeSyncJob({
          ...input,
          startDate: input.date,
          endDate: input.date,
          scope,
        }),
      ),
    );
    const jobs = [primaryJob, ...secondaryJobs];
    jobIds = jobs
      .map((job) => job?.id)
      .filter((value): value is string => Boolean(value));
  }

  try {
    const campaigns = fetchPlan.campaigns
      ? await getGoogleAdsCampaignsReport({
          ...baseParams,
          compareMode: "none",
          source: "google_ads_warehouse_sync",
        })
      : null;
    const campaignRows = (campaigns?.rows as GenericRow[] | undefined) ?? [];
    if (
      fetchPlan.campaigns &&
      campaignRows.length >= GOOGLE_ADS_CAMPAIGN_CORE_LIMIT
    ) {
      console.warn("[google-ads-sync] google_ads_campaign_daily_hard_cap_hit", {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        date: input.date,
        partitionId: input.partitionId ?? null,
        rowCount: campaignRows.length,
        hardCap: GOOGLE_ADS_CAMPAIGN_CORE_LIMIT,
      });
      throw new Error(
        `${GOOGLE_ADS_CAMPAIGN_CORE_LIMIT_ERROR_CODE}: campaign_daily returned ${campaignRows.length} rows, hitting hard cap ${GOOGLE_ADS_CAMPAIGN_CORE_LIMIT}`,
      );
    }
    const rawOverviewResult = wants("account_daily")
      ? await (async () => {
          const resolved = await resolveContext({
            ...baseParams,
            source: "google_ads_warehouse_sync_overview",
          });
          if (!resolved.ok) return null;
          const execution = await runNamedQuery(
            resolved.context,
            buildCustomerSummaryQuery(resolved.startDate, resolved.endDate),
          );
          return {
            rows: execution.rows as GenericRow[],
            failures: execution.failures,
            metrics: extractGoogleAdsOverviewMetrics(
              execution.rows as GenericRow[],
            ),
          };
        })().catch(() => null)
      : null;
    const overview = fetchPlan.campaigns
      ? aggregateAccountMetrics(campaignRows)
      : null;
    const rawOverviewMetrics = rawOverviewResult?.metrics ?? null;
    if (
      fetchPlan.campaigns &&
      shouldRetryGoogleAdsEmptyCampaignDaily({
        overview: rawOverviewMetrics ?? overview,
        campaignRowCount: campaignRows.length,
      })
    ) {
      throw new GoogleAdsRetryableSyncError(
        "account_daily has activity but campaign_daily returned zero rows - retry required",
      );
    }
    const searchIntelligence = fetchPlan.searchIntelligence
      ? await getGoogleAdsSearchIntelligenceReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
          executionMode: "warehouse_sync",
        })
      : null;
    const keywords = fetchPlan.keywords
      ? await getGoogleAdsKeywordsReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
        })
      : null;
    const ads = fetchPlan.ads
      ? await getGoogleAdsAdsReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
        })
      : null;
    const assets = fetchPlan.assets
      ? await getGoogleAdsAssetsReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
          executionMode: "warehouse_sync",
        })
      : null;
    const assetGroups = fetchPlan.assetGroups
      ? await getGoogleAdsAssetGroupsReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
        })
      : null;
    const audiences = fetchPlan.audiences
      ? await getGoogleAdsAudiencesReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
        })
      : null;
    const geo = fetchPlan.geo
      ? await getGoogleAdsGeoReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
        })
      : null;
    const devices = fetchPlan.devices
      ? await getGoogleAdsDevicesReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
        })
      : null;
    const products = fetchPlan.products
      ? await getGoogleAdsProductsReport({
          ...baseParams,
          source: "google_ads_warehouse_sync",
          executionMode: "warehouse_sync",
        })
      : null;
    fetchCompletedAtMs = Date.now();

    if (wants("campaign_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "campaign_daily",
        report: campaigns,
      });
    }
    if (wants("search_term_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "search_term_daily",
        report: searchIntelligence,
      });
    }
    if (wants("keyword_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "keyword_daily",
        report: keywords,
      });
    }
    if (wants("ad_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "ad_daily",
        report: ads,
      });
    }
    if (wants("asset_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "asset_daily",
        report: assets,
      });
    }
    if (wants("asset_group_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "asset_group_daily",
        report: assetGroups,
      });
    }
    if (wants("audience_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "audience_daily",
        report: audiences,
      });
    }
    if (wants("geo_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "geo_daily",
        report: geo,
      });
    }
    if (wants("device_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "device_daily",
        report: devices,
      });
    }
    if (wants("product_daily")) {
      assertGoogleAdsWarehouseFetchSucceeded({
        scope: "product_daily",
        report: products,
      });
    }

    if (wants("account_daily") && overview) {
      const transformStartedAtMs = Date.now();
      const rawOverviewPayload =
        rawOverviewResult == null
          ? null
          : {
              rows: rawOverviewResult.rows,
              failures: rawOverviewResult.failures,
              metrics: rawOverviewResult.metrics,
            };
      const rawOverviewSnapshotId = rawOverviewPayload
        ? await persistGoogleAdsRawSnapshot({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            partitionId: input.partitionId,
            endpointName: "overview",
            entityScope: "account",
            pageIndex: 0,
            providerCursor: null,
            startDate: input.date,
            endDate: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            payloadJson: rawOverviewPayload,
            payloadHash: buildGoogleAdsRawSnapshotHash({
              businessId: input.businessId,
              providerAccountId: input.providerAccountId,
              endpointName: "overview",
              startDate: input.date,
              endDate: input.date,
              payload: rawOverviewPayload,
            }),
            requestContext: {
              source: "sync",
              report: "overview",
              rawProviderOverview: true,
            },
            responseHeaders: {
              rowCount: rawOverviewResult?.rows.length ?? 0,
              failureCount: rawOverviewResult?.failures.length ?? 0,
            },
            providerHttpStatus: 200,
            status:
              (rawOverviewResult?.failures.length ?? 0) > 0
                ? "partial"
                : "fetched",
          }).catch(() => null)
        : null;
      const accountAuditPayload = buildGoogleAdsAccountDailyAuditPayload({
        canonicalMetrics: overview,
        referenceOverview: rawOverviewMetrics,
        campaignRowCount: campaignRows.length,
      });
      const accountRows = [
        {
          id: input.providerAccountId,
          name: input.providerAccountId,
          ...overview,
          convRate:
            overview.clicks > 0
              ? Number(
                  ((overview.conversions / overview.clicks) * 100).toFixed(2),
                )
              : 0,
        },
      ];
      transformAccumulatedMs += Date.now() - transformStartedAtMs;
      await recordPersistMetric("account_daily", accountRows.length, () =>
        persistScopeRows({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          date: input.date,
          accountTimezone: profile.timezone,
          accountCurrency: profile.currency,
          endpointName: "account_daily_rollup",
          scope: "account_daily",
          rows: accountRows,
          requestContext: {
            source: "sync",
            report: "account_daily_rollup",
          },
          partitionId: input.partitionId,
          workerId: input.workerId,
          leaseEpoch: input.leaseEpoch,
          attemptCount: input.attemptCount,
          mapRow: (row, snapshotId) =>
            buildWarehouseRow({
              businessId: input.businessId,
              providerAccountId: input.providerAccountId,
              date: input.date,
              accountTimezone: profile.timezone,
              accountCurrency: profile.currency,
              entityKey: input.providerAccountId,
              entityLabel: nullIfEmpty(row.name),
              spend: toNumber(row.spend),
              revenue: toNumber(row.revenue),
              conversions: toNumber(row.conversions),
              impressions: toNumber(row.impressions),
              clicks: toNumber(row.clicks),
              conversionRate:
                row.convRate == null ? null : toNumber(row.convRate),
              interactionRate:
                row.interactionRate == null
                  ? null
                  : toNumber(row.interactionRate),
              payloadJson: {
                ...row,
                ...accountAuditPayload,
                rawOverviewSnapshotId,
              },
              sourceSnapshotId: snapshotId,
            }),
        }),
      );
    }

    if (wants("campaign_daily") && campaigns) {
      await recordPersistMetric("campaign_daily", campaignRows.length, () =>
        persistScopeRows({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          date: input.date,
          accountTimezone: profile.timezone,
          accountCurrency: profile.currency,
          endpointName: "campaigns",
          scope: "campaign_daily",
          rows: campaigns.rows as GenericRow[],
          requestContext: { source: "sync", report: "campaigns" },
          partitionId: input.partitionId,
          workerId: input.workerId,
          leaseEpoch: input.leaseEpoch,
          attemptCount: input.attemptCount,
          mapRow: (row, snapshotId) =>
            buildWarehouseRow({
              businessId: input.businessId,
              providerAccountId: input.providerAccountId,
              date: input.date,
              accountTimezone: profile.timezone,
              accountCurrency: profile.currency,
              entityKey: String(row.id),
              entityLabel: nullIfEmpty(row.name),
              campaignId: String(row.id),
              campaignName: nullIfEmpty(row.name),
              status: nullIfEmpty(row.status),
              channel: nullIfEmpty(row.channel),
              spend: toNumber(row.spend),
              revenue: toNumber(row.revenue),
              conversions: toNumber(row.conversions),
              impressions: toNumber(row.impressions),
              clicks: toNumber(row.clicks),
              conversionRate:
                row.conversionRate == null
                  ? null
                  : toNumber(row.conversionRate),
              payloadJson: row,
              sourceSnapshotId: snapshotId,
            }),
        }),
      );
    }

    const searchSnapshot =
      wants("search_term_daily") && searchIntelligence
        ? await recordPersistMetric(
            "search_term_daily",
            (searchIntelligence.rows as GenericRow[]).length,
            () =>
              persistScopeRows({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                endpointName: "search_intelligence",
                scope: "search_term_daily",
                rows: searchIntelligence.rows as GenericRow[],
                requestContext: {
                  source: "sync",
                  report: "search_intelligence",
                },
                partitionId: input.partitionId,
                workerId: input.workerId,
                leaseEpoch: input.leaseEpoch,
                attemptCount: input.attemptCount,
                mapRow: (row, snapshotId) =>
                  buildWarehouseRow({
                    businessId: input.businessId,
                    providerAccountId: input.providerAccountId,
                    date: input.date,
                    accountTimezone: profile.timezone,
                    accountCurrency: profile.currency,
                    entityKey: [
                      nullIfEmpty(row.searchTerm),
                      nullIfEmpty(row.campaignId),
                      nullIfEmpty(row.adGroupId),
                    ]
                      .filter(Boolean)
                      .join(":"),
                    entityLabel: nullIfEmpty(row.searchTerm),
                    campaignId: nullIfEmpty(row.campaignId),
                    campaignName:
                      nullIfEmpty(row.campaignName) ??
                      nullIfEmpty(row.campaign),
                    adGroupId: nullIfEmpty(row.adGroupId),
                    adGroupName:
                      nullIfEmpty(row.adGroupName) ?? nullIfEmpty(row.adGroup),
                    classification:
                      nullIfEmpty(row.classification) ??
                      nullIfEmpty(row.intentClass),
                    spend: toNumber(row.spend),
                    revenue: toNumber(row.revenue),
                    conversions: toNumber(row.conversions),
                    impressions: toNumber(row.impressions),
                    clicks: toNumber(row.clicks),
                    payloadJson: {
                      ...row,
                      queryHash: buildGoogleAdsQueryHash(String(row.searchTerm ?? "")),
                      normalizedQuery: normalizeGoogleAdsQueryText(String(row.searchTerm ?? "")),
                      clusterKey:
                        String(row.clusterId ?? "").trim() ||
                        `query:${buildGoogleAdsQueryHash(String(row.searchTerm ?? "")).slice(0, 16)}`,
                    },
                    sourceSnapshotId: snapshotId,
                  }),
              }),
          )
        : null;

    if (wants("search_term_daily") && searchIntelligence) {
      await persistGoogleAdsSearchIntelligenceFoundation({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        date: input.date,
        accountTimezone: profile.timezone,
        accountCurrency: profile.currency,
        rows: searchIntelligence.rows as Array<Record<string, unknown>>,
        sourceSnapshotId: searchSnapshot?.snapshotId ?? null,
      });
    }

    if (wants("keyword_daily") && keywords) {
      await recordPersistMetric(
        "keyword_daily",
        (keywords.rows as GenericRow[]).length,
        () =>
          persistScopeRows({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            date: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            endpointName: "keywords",
            scope: "keyword_daily",
            rows: keywords.rows as GenericRow[],
            requestContext: { source: "sync", report: "keywords" },
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            attemptCount: input.attemptCount,
            mapRow: (row, snapshotId) =>
              buildWarehouseRow({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                entityKey:
                  nullIfEmpty(row.criterionId) ??
                  `${nullIfEmpty(row.keywordText)}:${nullIfEmpty(row.adGroupId)}`,
                entityLabel: nullIfEmpty(row.keywordText),
                campaignId: nullIfEmpty(row.campaignId),
                campaignName:
                  nullIfEmpty(row.campaignName) ?? nullIfEmpty(row.campaign),
                adGroupId: nullIfEmpty(row.adGroupId),
                adGroupName:
                  nullIfEmpty(row.adGroupName) ?? nullIfEmpty(row.adGroup),
                classification: nullIfEmpty(row.keywordState),
                spend: toNumber(row.spend),
                revenue: toNumber(row.revenue),
                conversions: toNumber(row.conversions),
                impressions: toNumber(row.impressions),
                clicks: toNumber(row.clicks),
                payloadJson: row,
                sourceSnapshotId: snapshotId,
              }),
          }),
      );
    }

    const adsSnapshot =
      wants("ad_daily") && ads
        ? await recordPersistMetric(
            "ad_daily",
            (ads.rows as GenericRow[]).length,
            () =>
              persistScopeRows({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                endpointName: "ads",
                scope: "ad_daily",
                rows: ads.rows as GenericRow[],
                requestContext: { source: "sync", report: "ads" },
                partitionId: input.partitionId,
                workerId: input.workerId,
                leaseEpoch: input.leaseEpoch,
                attemptCount: input.attemptCount,
                mapRow: (row, snapshotId) =>
                  buildWarehouseRow({
                    businessId: input.businessId,
                    providerAccountId: input.providerAccountId,
                    date: input.date,
                    accountTimezone: profile.timezone,
                    accountCurrency: profile.currency,
                    entityKey:
                      nullIfEmpty(row.adId) ?? nullIfEmpty(row.id) ?? "",
                    entityLabel:
                      nullIfEmpty(row.assetName) ??
                      nullIfEmpty(row.headline) ??
                      nullIfEmpty(row.id),
                    campaignId: nullIfEmpty(row.campaignId),
                    campaignName:
                      nullIfEmpty(row.campaignName) ??
                      nullIfEmpty(row.campaign),
                    adGroupId: nullIfEmpty(row.adGroupId),
                    adGroupName:
                      nullIfEmpty(row.adGroupName) ?? nullIfEmpty(row.adGroup),
                    status: nullIfEmpty(row.status),
                    channel: nullIfEmpty(row.channel),
                    spend: toNumber(row.spend),
                    revenue: toNumber(row.revenue),
                    conversions: toNumber(row.conversions),
                    impressions: toNumber(row.impressions),
                    clicks: toNumber(row.clicks),
                    payloadJson: row,
                    sourceSnapshotId: snapshotId,
                  }),
              }),
          )
        : null;

    if (wants("ad_group_daily")) {
      const transformStartedAtMs = Date.now();
      const adGroupRows = aggregateAdGroupRows({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        date: input.date,
        accountTimezone: profile.timezone,
        accountCurrency: profile.currency,
        sourceSnapshotId:
          adsSnapshot?.snapshotId ?? searchSnapshot?.snapshotId ?? null,
        rows: [
          ...((ads?.rows as GenericRow[] | undefined) ?? []),
          ...((keywords?.rows as GenericRow[] | undefined) ?? []),
          ...((searchIntelligence?.rows as GenericRow[] | undefined) ?? []),
        ],
      });
      transformAccumulatedMs += Date.now() - transformStartedAtMs;
      if (input.partitionId) {
        const checkpointScope = "ad_group_daily";
        const existingCheckpoint = await getGoogleAdsSyncCheckpoint({
          partitionId: input.partitionId,
          checkpointScope,
        }).catch(() => null);
        const chunks = chunkRows(
          adGroupRows,
          getGoogleAdsScopeCheckpointChunkSize("ad_group_daily"),
        );
        const adGroupPersistStartedAtMs = Date.now();
        const startChunkIndex =
          existingCheckpoint?.status === "succeeded" &&
          existingCheckpoint.phase === "finalize"
            ? chunks.length
            : Math.max(0, existingCheckpoint?.pageIndex ?? 0);
        let rowsWritten = existingCheckpoint?.rowsWritten ?? 0;
        for (
          let pageIndex = startChunkIndex;
          pageIndex < chunks.length;
          pageIndex += 1
        ) {
          if (input.workerId) {
            await heartbeatGoogleAdsPartitionLease({
              partitionId: input.partitionId,
              workerId: input.workerId,
              leaseEpoch: input.leaseEpoch ?? 0,
              leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
            });
          }
          await upsertGoogleAdsCheckpointOrThrow({
            partitionId: input.partitionId,
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            checkpointScope,
            isPaginated: false,
            phase: "bulk_upsert",
            status: "running",
            pageIndex,
            nextPageToken:
              pageIndex + 1 < chunks.length ? String(pageIndex + 1) : null,
            providerCursor:
              pageIndex + 1 < chunks.length ? String(pageIndex + 1) : null,
            rowsFetched: adGroupRows.length,
            rowsWritten,
            attemptCount: input.attemptCount ?? 0,
            rawSnapshotIds: [
              ...(existingCheckpoint?.rawSnapshotIds ?? []),
              ...(adsSnapshot?.snapshotId ? [adsSnapshot.snapshotId] : []),
              ...(searchSnapshot?.snapshotId
                ? [searchSnapshot.snapshotId]
                : []),
            ],
            progressHeartbeatAt: new Date().toISOString(),
            leaseOwner: input.workerId ?? null,
            leaseEpoch: input.leaseEpoch ?? null,
            lastSuccessfulEntityKey:
              chunks[pageIndex]?.[chunks[pageIndex].length - 1]?.entityKey ??
              null,
            startedAt:
              existingCheckpoint?.startedAt ?? new Date().toISOString(),
          });
          await upsertGoogleAdsDailyRows(
            "ad_group_daily",
            chunks[pageIndex] ?? [],
          );
          rowsWritten += (chunks[pageIndex] ?? []).length;
        }
        await upsertGoogleAdsCheckpointOrThrow({
          partitionId: input.partitionId,
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          checkpointScope,
          isPaginated: false,
          phase: "finalize",
          status: "succeeded",
          pageIndex: Math.max(0, chunks.length - 1),
          nextPageToken: null,
          providerCursor: null,
          rowsFetched: adGroupRows.length,
          rowsWritten,
          attemptCount: input.attemptCount ?? 0,
          rawSnapshotIds: [
            ...(existingCheckpoint?.rawSnapshotIds ?? []),
            ...(adsSnapshot?.snapshotId ? [adsSnapshot.snapshotId] : []),
            ...(searchSnapshot?.snapshotId ? [searchSnapshot.snapshotId] : []),
          ],
          progressHeartbeatAt: new Date().toISOString(),
          leaseOwner: input.workerId ?? null,
          leaseEpoch: input.leaseEpoch ?? null,
          finishedAt: new Date().toISOString(),
          startedAt: existingCheckpoint?.startedAt ?? new Date().toISOString(),
        });
        const durationMs = Date.now() - adGroupPersistStartedAtMs;
        persistAccumulatedMs += durationMs;
        scopeMetrics.push({
          scope: "ad_group_daily",
          rowCount: adGroupRows.length,
          batchCount: Math.max(1, chunks.length),
          chunkSize: getGoogleAdsScopeCheckpointChunkSize("ad_group_daily"),
          persistedRowCount: rowsWritten,
          durationMs,
        });
      } else {
        const adGroupPersistStartedAtMs = Date.now();
        await upsertGoogleAdsDailyRows("ad_group_daily", adGroupRows);
        const durationMs = Date.now() - adGroupPersistStartedAtMs;
        persistAccumulatedMs += durationMs;
        scopeMetrics.push({
          scope: "ad_group_daily",
          rowCount: adGroupRows.length,
          batchCount: Math.max(
            1,
            Math.ceil(
              adGroupRows.length /
                getGoogleAdsScopeCheckpointChunkSize("ad_group_daily"),
            ),
          ),
          chunkSize: getGoogleAdsScopeCheckpointChunkSize("ad_group_daily"),
          persistedRowCount: adGroupRows.length,
          durationMs,
        });
      }
    }

    if (wants("asset_daily") && assets) {
      await recordPersistMetric(
        "asset_daily",
        (assets.rows as GenericRow[]).length,
        () =>
          persistScopeRows({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            date: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            endpointName: "assets",
            scope: "asset_daily",
            rows: assets.rows as GenericRow[],
            requestContext: { source: "sync", report: "assets" },
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            attemptCount: input.attemptCount,
            mapRow: (row, snapshotId) =>
              buildWarehouseRow({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                entityKey:
                  nullIfEmpty(row.assetId) ?? nullIfEmpty(row.id) ?? "",
                entityLabel:
                  nullIfEmpty(row.assetName) ?? nullIfEmpty(row.assetText),
                campaignId: nullIfEmpty(row.campaignId),
                campaignName:
                  nullIfEmpty(row.campaignName) ?? nullIfEmpty(row.campaign),
                adGroupId: nullIfEmpty(row.assetGroupId),
                adGroupName:
                  nullIfEmpty(row.assetGroupName) ??
                  nullIfEmpty(row.assetGroup),
                classification: nullIfEmpty(row.assetState),
                spend: toNumber(row.spend),
                revenue: toNumber(row.revenue),
                conversions: toNumber(row.conversions),
                impressions: toNumber(row.impressions),
                clicks: toNumber(row.clicks),
                interactionRate:
                  row.interactionRate == null
                    ? null
                    : toNumber(row.interactionRate),
                payloadJson: row,
                sourceSnapshotId: snapshotId,
              }),
          }),
      );
    }

    if (wants("asset_group_daily") && assetGroups) {
      await recordPersistMetric(
        "asset_group_daily",
        (assetGroups.rows as GenericRow[]).length,
        () =>
          persistScopeRows({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            date: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            endpointName: "asset_groups",
            scope: "asset_group_daily",
            rows: assetGroups.rows as GenericRow[],
            requestContext: { source: "sync", report: "asset_groups" },
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            attemptCount: input.attemptCount,
            mapRow: (row, snapshotId) =>
              buildWarehouseRow({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                entityKey:
                  nullIfEmpty(row.assetGroupId) ?? nullIfEmpty(row.id) ?? "",
                entityLabel:
                  nullIfEmpty(row.assetGroupName) ?? nullIfEmpty(row.name),
                campaignId: nullIfEmpty(row.campaignId),
                campaignName:
                  nullIfEmpty(row.campaignName) ?? nullIfEmpty(row.campaign),
                status: nullIfEmpty(row.status),
                classification: nullIfEmpty(row.classification),
                spend: toNumber(row.spend),
                revenue: toNumber(row.revenue),
                conversions: toNumber(row.conversions),
                impressions: toNumber(row.impressions),
                clicks: toNumber(row.clicks),
                conversionRate:
                  row.conversionRate == null
                    ? null
                    : toNumber(row.conversionRate),
                payloadJson: row,
                sourceSnapshotId: snapshotId,
              }),
          }),
      );
    }

    if (wants("audience_daily") && audiences) {
      await recordPersistMetric(
        "audience_daily",
        (audiences.rows as GenericRow[]).length,
        () =>
          persistScopeRows({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            date: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            endpointName: "audiences",
            scope: "audience_daily",
            rows: audiences.rows as GenericRow[],
            requestContext: { source: "sync", report: "audiences" },
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            attemptCount: input.attemptCount,
            mapRow: (row, snapshotId) =>
              buildWarehouseRow({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                entityKey:
                  nullIfEmpty(row.audienceKey) ??
                  `${nullIfEmpty(row.audienceType)}:${nullIfEmpty(row.adGroupId)}`,
                entityLabel:
                  nullIfEmpty(row.audienceNameBestEffort) ??
                  nullIfEmpty(row.type),
                campaignId: nullIfEmpty(row.campaignId),
                campaignName:
                  nullIfEmpty(row.campaignName) ?? nullIfEmpty(row.campaign),
                adGroupId: nullIfEmpty(row.adGroupId),
                adGroupName:
                  nullIfEmpty(row.adGroupName) ?? nullIfEmpty(row.adGroup),
                classification: nullIfEmpty(row.audienceState),
                spend: toNumber(row.spend),
                revenue: toNumber(row.revenue),
                conversions: toNumber(row.conversions),
                impressions: toNumber(row.impressions),
                clicks: toNumber(row.clicks),
                payloadJson: row,
                sourceSnapshotId: snapshotId,
              }),
          }),
      );
    }

    if (wants("geo_daily") && geo) {
      await recordPersistMetric(
        "geo_daily",
        (geo.rows as GenericRow[]).length,
        () =>
          persistScopeRows({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            date: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            endpointName: "geo",
            scope: "geo_daily",
            rows: geo.rows as GenericRow[],
            requestContext: { source: "sync", report: "geo" },
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            attemptCount: input.attemptCount,
            mapRow: (row, snapshotId) =>
              buildWarehouseRow({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                entityKey:
                  nullIfEmpty(row.geoId) ??
                  nullIfEmpty(row.country) ??
                  nullIfEmpty(row.geoName) ??
                  "",
                entityLabel:
                  nullIfEmpty(row.geoName) ?? nullIfEmpty(row.country),
                classification: nullIfEmpty(row.geoState),
                spend: toNumber(row.spend),
                revenue: toNumber(row.revenue),
                conversions: toNumber(row.conversions),
                impressions: toNumber(row.impressions),
                clicks: toNumber(row.clicks),
                payloadJson: row,
                sourceSnapshotId: snapshotId,
              }),
          }),
      );
    }

    if (wants("device_daily") && devices) {
      await recordPersistMetric(
        "device_daily",
        (devices.rows as GenericRow[]).length,
        () =>
          persistScopeRows({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            date: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            endpointName: "devices",
            scope: "device_daily",
            rows: devices.rows as GenericRow[],
            requestContext: { source: "sync", report: "devices" },
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            attemptCount: input.attemptCount,
            mapRow: (row, snapshotId) =>
              buildWarehouseRow({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                entityKey: nullIfEmpty(row.device) ?? "",
                entityLabel: nullIfEmpty(row.device),
                classification: nullIfEmpty(row.deviceState),
                spend: toNumber(row.spend),
                revenue: toNumber(row.revenue),
                conversions: toNumber(row.conversions),
                impressions: toNumber(row.impressions),
                clicks: toNumber(row.clicks),
                payloadJson: row,
                sourceSnapshotId: snapshotId,
              }),
          }),
      );
    }

    if (wants("product_daily") && products) {
      await recordPersistMetric(
        "product_daily",
        (products.rows as GenericRow[]).length,
        () =>
          persistScopeRows({
            businessId: input.businessId,
            providerAccountId: input.providerAccountId,
            date: input.date,
            accountTimezone: profile.timezone,
            accountCurrency: profile.currency,
            endpointName: "products",
            scope: "product_daily",
            rows: products.rows as GenericRow[],
            requestContext: { source: "sync", report: "products" },
            partitionId: input.partitionId,
            workerId: input.workerId,
            leaseEpoch: input.leaseEpoch,
            attemptCount: input.attemptCount,
            mapRow: (row, snapshotId) =>
              buildWarehouseRow({
                businessId: input.businessId,
                providerAccountId: input.providerAccountId,
                date: input.date,
                accountTimezone: profile.timezone,
                accountCurrency: profile.currency,
                entityKey:
                  nullIfEmpty(row.productItemId) ??
                  nullIfEmpty(row.itemId) ??
                  "",
                entityLabel:
                  nullIfEmpty(row.productTitle) ?? nullIfEmpty(row.title),
                classification:
                  nullIfEmpty(row.scaleState) ??
                  nullIfEmpty(row.underperformingState),
                spend: toNumber(row.spend),
                revenue: toNumber(row.revenue),
                conversions: toNumber(row.conversions),
                impressions: toNumber(row.impressions),
                clicks: toNumber(row.clicks),
                payloadJson: row,
                sourceSnapshotId: snapshotId,
              }),
          }),
      );
    }

    await Promise.all(
      jobIds.map((id) =>
        updateGoogleAdsSyncJob({
          id,
          status: "succeeded",
          progressPercent: 100,
          finishedAt: new Date().toISOString(),
        }),
      ),
    );
    const totalMs = Date.now() - syncStartedAtMs;
    const fetchMs = fetchCompletedAtMs - syncStartedAtMs;
    const finalizeMs = Math.max(
      0,
      totalMs - fetchMs - transformAccumulatedMs - persistAccumulatedMs,
    );
    logGoogleAdsPhaseTelemetry({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      date: input.date,
      primaryScope,
      fetchMs,
      transformMs: transformAccumulatedMs,
      persistMs: persistAccumulatedMs,
      finalizeMs,
      totalMs,
      scopeMetrics,
    });
    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await Promise.all(
      jobIds.map((id) =>
        updateGoogleAdsSyncJob({
          id,
          status: "failed",
          lastError: message,
          finishedAt: new Date().toISOString(),
        }),
      ),
    );
    throw error;
  }
}

function classifyGoogleAdsSyncError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  if (error instanceof GoogleAdsRetryableSyncError) {
    return classifyGoogleAdsSyncFailure({
      errorClass: "transient",
      message,
    });
  }
  if (isGoogleAdsCampaignCoreLimitError(error)) {
    return classifyGoogleAdsSyncFailure({
      errorClass: "application",
      message,
    });
  }
  return classifyGoogleAdsSyncFailure({ error, message });
}

function isAmbiguousGoogleAdsFetchFailureForActionRequiredScope(message: string) {
  const lower = message.toLowerCase();
  return (
    lower.includes("google ads query failed without a captured error") ||
    lower.includes("google ads query failed without captured error")
  );
}

function buildGoogleAdsScopeActionRequiredClassification() {
  return classifyGoogleAdsSyncFailure({
    errorClass: "scope_action_required",
    message:
      "google_ads_scope_action_required: same account and scope has a recent terminal Google Ads access failure",
  });
}

function isGoogleAdsCampaignCoreLimitError(error: unknown) {
  const message = error instanceof Error ? error.message : String(error);
  return message.startsWith(`${GOOGLE_ADS_CAMPAIGN_CORE_LIMIT_ERROR_CODE}:`);
}

function computePartitionRetryDelayMinutes(
  attemptCount: number,
  errorClass: string,
) {
  const base =
    errorClass === "quota"
      ? GOOGLE_ADS_QUOTA_RETRY_BASE_MINUTES
      : GOOGLE_ADS_TRANSIENT_RETRY_BASE_MINUTES;
  const exp = Math.min(attemptCount, 5);
  const jitter = Math.floor(Math.random() * 3);
  return Math.min(60, base * 2 ** Math.max(0, exp - 1) + jitter);
}

async function enqueueExtendedPartitionsForDate(input: {
  businessId: string;
  providerAccountId: string;
  date: string;
}) {
  const incidentPolicy = await getGoogleAdsIncidentPolicy({
    businessId: input.businessId,
  }).catch(() => null);
  if (incidentPolicy?.suspendExtended) {
    return;
  }
  await Promise.all(
    GOOGLE_ADS_EXTENDED_SCOPES.map((scope) =>
      queueGoogleAdsSyncPartition({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        lane: "extended",
        scope,
        partitionDate: input.date,
        status: "queued",
        priority: -5,
        source: "core_success",
        attemptCount: 0,
      }).catch(() => null),
    ),
  );
}

async function refreshGoogleAdsSyncStateForPartition(input: {
  businessId: string;
  providerAccountId: string;
  scope: GoogleAdsWarehouseScope;
}) {
  const { historicalStart, yesterday } = await computeHistoricalTargets(
    input.businessId,
    input.providerAccountId,
  );
  const laneForScope: GoogleAdsSyncLane =
    input.scope === "account_daily" || input.scope === "campaign_daily"
      ? "core"
      : "extended";
  const [coverage, partitionHealth, readyThroughDate] = await Promise.all([
    getGoogleAdsDailyCoverage({
      scope: input.scope,
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      startDate: historicalStart,
      endDate: yesterday,
      includeMetadata: true,
    }).catch(() => null),
    getGoogleAdsPartitionHealth({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      scope: input.scope,
      lane: laneForScope,
    }).catch(() => null),
    computeContiguousReadyThroughDate({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      scope: input.scope,
      targetStart: historicalStart,
      targetEnd: yesterday,
    }).catch(() => null),
  ]);
  await upsertGoogleAdsSyncState({
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    scope: input.scope,
    historicalTargetStart: historicalStart,
    historicalTargetEnd: yesterday,
    effectiveTargetStart: historicalStart,
    effectiveTargetEnd: yesterday,
    readyThroughDate,
    lastSuccessfulPartitionDate: coverage?.ready_through_date ?? null,
    latestBackgroundActivityAt: partitionHealth?.latestActivityAt ?? null,
    latestSuccessfulSyncAt: coverage?.latest_updated_at ?? null,
    completedDays: coverage?.completed_days ?? 0,
    deadLetterCount: partitionHealth?.deadLetterPartitions ?? 0,
  });
}

async function processGoogleAdsPartition(input: {
  partition: {
    id?: string;
    businessId: string;
    providerAccountId: string;
    lane: GoogleAdsSyncLane;
    scope: GoogleAdsWarehouseScope;
    partitionDate: string;
    attemptCount: number;
    source: string;
    leaseEpoch?: number | null;
  };
  workerId: string;
}) {
  const partitionId = input.partition.id;
  if (!partitionId) return false;
  const markRunningOk = await markGoogleAdsPartitionRunning({
    partitionId,
    workerId: input.workerId,
    leaseEpoch: input.partition.leaseEpoch ?? 0,
    leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
  }).catch(() => false);
  if (!markRunningOk) {
    console.warn("[google-ads-sync] partition_lost_ownership_before_run", {
      businessId: input.partition.businessId,
      partitionId,
      workerId: input.workerId,
      scope: input.partition.scope,
      partitionDate: input.partition.partitionDate,
    });
    return false;
  }
  const createdRunId = await createGoogleAdsSyncRun({
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
      leaseEpoch: input.partition.leaseEpoch ?? null,
    },
  }).catch(() => null);
  let runId = createdRunId;
  let recoveredRunId: string | null = null;
  if (!runId) {
    recoveredRunId = await getLatestRunningGoogleAdsSyncRunIdForPartition({
      partitionId,
    }).catch(() => null);
    runId = recoveredRunId;
  }

  const startedAt = Date.now();
  try {
    const scopeAlreadyActionRequired =
      await hasRecentGoogleAdsTerminalActionRequiredDeadLetter({
        businessId: input.partition.businessId,
        providerAccountId: input.partition.providerAccountId,
        scope: input.partition.scope,
      }).catch(() => false);
    if (scopeAlreadyActionRequired) {
      throw new GoogleAdsScopeActionRequiredError({
        scope: input.partition.scope,
      });
    }

    const scopes =
      input.partition.lane === "core" || input.partition.lane === "maintenance"
        ? (["account_daily", "campaign_daily"] as GoogleAdsWarehouseScope[])
        : ([input.partition.scope] as GoogleAdsWarehouseScope[]);

    const synced = await syncGoogleAdsAccountDay({
      businessId: input.partition.businessId,
      providerAccountId: input.partition.providerAccountId,
      date: input.partition.partitionDate,
      syncType:
        input.partition.lane === "maintenance"
          ? input.partition.partitionDate ===
            (await resolveGoogleAdsCurrentDate(
              input.partition.businessId,
            ).catch(() => input.partition.partitionDate))
            ? "today_refresh"
            : "incremental_recent"
          : "initial_backfill",
      triggerSource:
        input.partition.lane === "core"
          ? "background_initial"
          : input.partition.lane === "extended"
            ? input.partition.source === "recent_recovery" &&
              isGoogleAdsRecentRepairScope(input.partition.scope)
              ? `auto_recent_repair:${input.partition.scope}`
              : "background_repair"
            : "background_recent",
      scopes,
      partitionOwned: true,
      partitionId,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch ?? 0,
      attemptCount: input.partition.attemptCount + 1,
    });

    if (!synced) {
      const completionHeartbeat =
        await heartbeatGoogleAdsPartitionBeforeCompletion({
          partitionId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch ?? 0,
          leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
        });
      if (!completionHeartbeat.ok) {
        const denialSnapshot = await logGoogleAdsCompletionDenied({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch ?? 0,
          lane: input.partition.lane,
          scope: input.partition.scope,
          partitionStatus: "failed",
          runStatus: "failed",
          reason: "lease_conflict",
        });
        if (denialSnapshot?.denialClassification === "already_terminal") {
          await backfillGoogleAdsDeniedTerminalChildren({
            partitionId,
            runId,
            recoveredRunId,
            workerId: input.workerId,
            leaseEpoch: input.partition.leaseEpoch ?? null,
            lane: input.partition.lane,
            scope: input.partition.scope,
            pathKind: "primary",
          });
        }
        if (runId) {
          await updateGoogleAdsSyncRun({
            id: runId,
            status: "failed",
            errorClass: "lease_conflict",
            errorMessage: "partition lost ownership before failure completion",
            durationMs: Date.now() - startedAt,
            finishedAt: new Date().toISOString(),
            onlyIfCurrentStatus: "running",
          }).catch(() => null);
        }
        return false;
      }
      const completed = await completeGoogleAdsPartitionAttempt({
        partitionId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch ?? 0,
        runId,
        recoveredRunId,
        partitionStatus: "failed",
        runStatus: "failed",
        durationMs: Date.now() - startedAt,
        errorClass: "lease_conflict",
        errorMessage:
          "partition skipped because another worker already owns this date",
        finishedAt: new Date().toISOString(),
        lastError:
          "partition skipped because another worker already owns this date",
        retryDelayMinutes: 5,
      });
      logGoogleAdsCompletionOutcome({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: "failed",
        outcome: completed,
      });
      if (!completed.ok) {
        const denialSnapshot = await logGoogleAdsCompletionDenied({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch ?? 0,
          lane: input.partition.lane,
          scope: input.partition.scope,
          partitionStatus: "failed",
          runStatus: "failed",
          reason: "lease_conflict",
        });
        logGoogleAdsCompletionOutcome({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch ?? 0,
          lane: input.partition.lane,
          scope: input.partition.scope,
          partitionStatus: "failed",
          outcome: completed,
          denialClassification: denialSnapshot?.denialClassification ?? null,
        });
        if (denialSnapshot?.denialClassification === "already_terminal") {
          await backfillGoogleAdsDeniedTerminalChildren({
            partitionId,
            runId,
            recoveredRunId,
            workerId: input.workerId,
            leaseEpoch: input.partition.leaseEpoch ?? null,
            lane: input.partition.lane,
            scope: input.partition.scope,
            pathKind: "primary",
          });
        }
        if (runId) {
          await updateGoogleAdsSyncRun({
            id: runId,
            status: "failed",
            errorClass: "lease_conflict",
            errorMessage: "partition lost ownership before failure completion",
            durationMs: Date.now() - startedAt,
            finishedAt: new Date().toISOString(),
            onlyIfCurrentStatus: "running",
          }).catch(() => null);
        }
      }
      return false;
    }

    const completionHeartbeat =
      await heartbeatGoogleAdsPartitionBeforeCompletion({
        partitionId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch ?? 0,
        leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
      });
    if (!completionHeartbeat.ok) {
      const denialSnapshot = await logGoogleAdsCompletionDenied({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch ?? 0,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: "succeeded",
        runStatus: "succeeded",
        reason: "lease_conflict",
      });
      if (denialSnapshot?.denialClassification === "already_terminal") {
        await backfillGoogleAdsDeniedTerminalChildren({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch ?? null,
          lane: input.partition.lane,
          scope: input.partition.scope,
          pathKind: "primary",
        });
      }
      if (isGoogleAdsTerminalSuccessDenial(denialSnapshot)) {
        if (runId) {
          await updateGoogleAdsSyncRun({
            id: runId,
            status: "succeeded",
            durationMs: Date.now() - startedAt,
            finishedAt: new Date().toISOString(),
            onlyIfCurrentStatus: "running",
          }).catch(() => null);
        }
        return true;
      }
      if (runId) {
        await updateGoogleAdsSyncRun({
          id: runId,
          status: "failed",
          errorClass: "lease_conflict",
          errorMessage: "partition lost ownership before success completion",
          durationMs: Date.now() - startedAt,
          finishedAt: new Date().toISOString(),
          onlyIfCurrentStatus: "running",
        }).catch(() => null);
      }
      return false;
    }
    const completed = await completeGoogleAdsPartitionAttempt({
      partitionId,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch ?? 0,
      runId,
      recoveredRunId,
      partitionStatus: "succeeded",
      runStatus: "succeeded",
      durationMs: Date.now() - startedAt,
      finishedAt: new Date().toISOString(),
      lastError: null,
    });
    logGoogleAdsCompletionOutcome({
      partitionId,
      runId,
      recoveredRunId,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch ?? null,
      lane: input.partition.lane,
      scope: input.partition.scope,
      partitionStatus: "succeeded",
      outcome: completed,
    });
    if (!completed.ok) {
      const denialSnapshot = await logGoogleAdsCompletionDenied({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch ?? 0,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: "succeeded",
        runStatus: "succeeded",
        reason: "lease_conflict",
      });
      logGoogleAdsCompletionOutcome({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: "succeeded",
        outcome: completed,
        denialClassification: denialSnapshot?.denialClassification ?? null,
      });
      if (denialSnapshot?.denialClassification === "already_terminal") {
        await backfillGoogleAdsDeniedTerminalChildren({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          lane: input.partition.lane,
          scope: input.partition.scope,
          pathKind: "primary",
        });
      }
      if (isGoogleAdsTerminalSuccessDenial(denialSnapshot)) {
        if (runId) {
          await updateGoogleAdsSyncRun({
            id: runId,
            status: "succeeded",
            durationMs: Date.now() - startedAt,
            finishedAt: new Date().toISOString(),
            onlyIfCurrentStatus: "running",
          }).catch(() => null);
        }
        return true;
      }
      if (runId) {
        await updateGoogleAdsSyncRun({
          id: runId,
          status: "failed",
          errorClass: "lease_conflict",
          errorMessage: "partition lost ownership before success completion",
          durationMs: Date.now() - startedAt,
          finishedAt: new Date().toISOString(),
          onlyIfCurrentStatus: "running",
        }).catch(() => null);
      }
      return false;
    }
    await maybeBackfillGoogleAdsCompletionSuccess({
      partitionId,
      runId,
      recoveredRunId,
      workerId: input.workerId,
      lane: input.partition.lane,
      scope: input.partition.scope,
      completionResult: completed,
    });

    try {
      if (
        input.partition.lane === "core" ||
        input.partition.lane === "maintenance"
      ) {
        await refreshGoogleAdsSyncStateForPartition({
          businessId: input.partition.businessId,
          providerAccountId: input.partition.providerAccountId,
          scope: "campaign_daily",
        });
        await refreshGoogleAdsSyncStateForPartition({
          businessId: input.partition.businessId,
          providerAccountId: input.partition.providerAccountId,
          scope: "account_daily",
        });
      } else {
        await refreshGoogleAdsSyncStateForPartition({
          businessId: input.partition.businessId,
          providerAccountId: input.partition.providerAccountId,
          scope: input.partition.scope,
        });
      }

      if (input.partition.lane === "core") {
        await enqueueExtendedPartitionsForDate({
          businessId: input.partition.businessId,
          providerAccountId: input.partition.providerAccountId,
          date: input.partition.partitionDate,
        });
      }

      if (input.partition.lane === "core") {
        await clearProviderGlobalCircuitBreaker({
          provider: "google",
          businessId: input.partition.businessId,
        }).catch(() => null);
        await clearProviderGlobalCircuitBreakerRecoveryState({
          provider: "google",
          businessId: input.partition.businessId,
        }).catch(() => null);
      } else if (input.partition.lane === "maintenance") {
        await clearProviderGlobalCircuitBreaker({
          provider: "google",
          businessId: input.partition.businessId,
        }).catch(() => null);
      }
    } catch (sideEffectError) {
      console.warn(
        "[google-ads-sync] partition_post_completion_side_effect_failed",
        {
          partitionId,
          workerId: input.workerId,
          lane: input.partition.lane,
          scope: input.partition.scope,
          message:
            sideEffectError instanceof Error
              ? sideEffectError.message
              : String(sideEffectError),
        },
      );
    }

    return true;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    let failureClassification = classifyGoogleAdsSyncError(error);
    if (
      !failureClassification.actionRequired &&
      isAmbiguousGoogleAdsFetchFailureForActionRequiredScope(message)
    ) {
      const scopeAlreadyActionRequired =
        await hasRecentGoogleAdsTerminalActionRequiredDeadLetter({
          businessId: input.partition.businessId,
          providerAccountId: input.partition.providerAccountId,
          scope: input.partition.scope,
        }).catch(() => false);
      if (scopeAlreadyActionRequired) {
        failureClassification = buildGoogleAdsScopeActionRequiredClassification();
      }
    }
    const errorClass = failureClassification.errorClass;
    const hardCapExceeded = isGoogleAdsCampaignCoreLimitError(error);
    if (errorClass === "quota") {
      if (
        input.partition.lane === "extended" &&
        isGoogleAdsHistoricalExtendedSource(input.partition.source)
      ) {
        await enterProviderGlobalCircuitBreakerRecoveryState({
          provider: "google",
          businessId: input.partition.businessId,
          message:
            "Historical extended replay hit quota pressure and was downgraded to recovery mode.",
          cooldownMs: GOOGLE_ADS_CIRCUIT_BREAKER_BASE_MINUTES * 60_000,
        }).catch(() => null);
      } else {
        await openGoogleAdsQuotaCircuitBreaker({
          businessId: input.partition.businessId,
          message,
          status:
            error instanceof ProviderRequestCooldownError ? error.status : 429,
        }).catch(() => null);
      }
    }
    const nextAttempt = input.partition.attemptCount + 1;
    const activeCheckpoint = await getGoogleAdsSyncCheckpoint({
      partitionId,
      checkpointScope: input.partition.scope,
    }).catch(() => null);
    const shouldDeadLetter =
      hardCapExceeded ||
      shouldDeadLetterGoogleAdsFailure({
        errorClass,
        terminal: failureClassification.terminal,
        attemptCount: input.partition.attemptCount,
        maxAttempts: GOOGLE_ADS_PARTITION_MAX_ATTEMPTS,
      });
    const shouldPoisonCheckpoint =
      shouldDeadLetter && !failureClassification.actionRequired;
    const status = shouldDeadLetter ? "dead_letter" : "failed";
    await upsertGoogleAdsCheckpointOrThrow({
      partitionId,
      businessId: input.partition.businessId,
      providerAccountId: input.partition.providerAccountId,
      checkpointScope: input.partition.scope,
      isPaginated: activeCheckpoint?.isPaginated ?? false,
      phase: activeCheckpoint?.phase ?? "bulk_upsert",
      status: "failed",
      pageIndex: activeCheckpoint?.pageIndex ?? 0,
      nextPageToken: activeCheckpoint?.nextPageToken ?? null,
      providerCursor: activeCheckpoint?.providerCursor ?? null,
      rawSnapshotIds: activeCheckpoint?.rawSnapshotIds ?? [],
      rowsFetched: activeCheckpoint?.rowsFetched ?? 0,
      rowsWritten: activeCheckpoint?.rowsWritten ?? 0,
      lastSuccessfulEntityKey:
        activeCheckpoint?.lastSuccessfulEntityKey ?? null,
      lastResponseHeaders: activeCheckpoint?.lastResponseHeaders ?? {},
      attemptCount: nextAttempt,
      progressHeartbeatAt: new Date().toISOString(),
      leaseOwner: input.workerId,
      leaseEpoch: input.partition.leaseEpoch ?? null,
      poisonedAt: shouldPoisonCheckpoint ? new Date().toISOString() : null,
      poisonReason: shouldPoisonCheckpoint
        ? hardCapExceeded
          ? message
          : `Repeated failure on checkpoint page ${activeCheckpoint?.pageIndex ?? 0}: ${message}`
        : null,
      replayReasonCode: shouldPoisonCheckpoint
        ? "quarantine_release"
        : resolveGoogleReplayReasonCode({
            checkpointStatus: activeCheckpoint?.status ?? "failed",
            checkpointPhase: activeCheckpoint?.phase ?? "bulk_upsert",
            poisonedAt: activeCheckpoint?.poisonedAt,
            retryAfterAt: activeCheckpoint?.retryAfterAt,
          }),
      replayDetail: `Partition failure captured during ${activeCheckpoint?.phase ?? "bulk_upsert"} phase: ${message}`,
      retryAfterAt: shouldDeadLetter
        ? null
        : new Date(
            Date.now() +
              computePartitionRetryDelayMinutes(nextAttempt, errorClass) *
                60_000,
          ).toISOString(),
      startedAt: activeCheckpoint?.startedAt ?? null,
      finishedAt: new Date().toISOString(),
    }).catch(() => null);
    if (shouldPoisonCheckpoint) {
      await recordSyncReclaimEvents({
        providerScope: "google_ads",
        businessId: input.partition.businessId,
        partitionIds: [partitionId],
        checkpointScope: input.partition.scope,
        eventType: "poisoned",
        disposition: "poison_candidate",
        reasonCode: "same_phase_reentry_limit",
        detail: hardCapExceeded
          ? message
          : `Repeated failure on phase ${activeCheckpoint?.phase ?? "unknown"} page ${activeCheckpoint?.pageIndex ?? 0}: ${message}`,
      }).catch(() => null);
    }

    const completionHeartbeat =
      await heartbeatGoogleAdsPartitionBeforeCompletion({
        partitionId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch ?? 0,
        leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
      });
    if (!completionHeartbeat.ok) {
      const denialSnapshot = await logGoogleAdsCompletionDenied({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch ?? 0,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: status,
        runStatus: "failed",
        reason: "lease_conflict",
      });
      if (denialSnapshot?.denialClassification === "already_terminal") {
        await backfillGoogleAdsDeniedTerminalChildren({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch ?? null,
          lane: input.partition.lane,
          scope: input.partition.scope,
          pathKind: "primary",
        });
      }
      if (runId) {
        await updateGoogleAdsSyncRun({
          id: runId,
          status: "failed",
          errorClass: "lease_conflict",
          errorMessage: "partition lost ownership before failure completion",
          durationMs: Date.now() - startedAt,
          finishedAt: new Date().toISOString(),
          onlyIfCurrentStatus: "running",
        }).catch(() => null);
      }
      return false;
    }

    const completed = await completeGoogleAdsPartitionAttempt({
      partitionId,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch ?? 0,
      runId,
      recoveredRunId,
      partitionStatus: status,
      runStatus: "failed",
      durationMs: Date.now() - startedAt,
      errorClass,
      errorMessage: message,
      finishedAt: new Date().toISOString(),
      lastError: message,
      retryDelayMinutes: shouldDeadLetter
        ? undefined
        : computePartitionRetryDelayMinutes(nextAttempt, errorClass),
    });
    logGoogleAdsCompletionOutcome({
      partitionId,
      runId,
      recoveredRunId,
      workerId: input.workerId,
      leaseEpoch: input.partition.leaseEpoch ?? null,
      lane: input.partition.lane,
      scope: input.partition.scope,
      partitionStatus: status,
      outcome: completed,
    });
    if (!completed.ok) {
      const denialSnapshot = await logGoogleAdsCompletionDenied({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        leaseEpoch: input.partition.leaseEpoch ?? 0,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: status,
        runStatus: "failed",
        reason: "lease_conflict",
      });
      logGoogleAdsCompletionOutcome({
        partitionId,
        runId,
        recoveredRunId,
        workerId: input.workerId,
        lane: input.partition.lane,
        scope: input.partition.scope,
        partitionStatus: status,
        outcome: completed,
        denialClassification: denialSnapshot?.denialClassification ?? null,
      });
      if (denialSnapshot?.denialClassification === "already_terminal") {
        await backfillGoogleAdsDeniedTerminalChildren({
          partitionId,
          runId,
          recoveredRunId,
          workerId: input.workerId,
          leaseEpoch: input.partition.leaseEpoch ?? null,
          lane: input.partition.lane,
          scope: input.partition.scope,
          pathKind: "primary",
        });
      }
      if (runId) {
        await updateGoogleAdsSyncRun({
          id: runId,
          status: "failed",
          errorClass: "lease_conflict",
          errorMessage: "partition lost ownership before failure completion",
          durationMs: Date.now() - startedAt,
          finishedAt: new Date().toISOString(),
          onlyIfCurrentStatus: "running",
        }).catch(() => null);
      }
    }
    return false;
  }
}

export async function processGoogleAdsLifecyclePartition(input: {
  partition: {
    id?: string;
    businessId: string;
    providerAccountId: string;
    lane: GoogleAdsSyncLane;
    scope: GoogleAdsWarehouseScope;
    partitionDate: string;
    attemptCount: number;
    source: string;
    leaseEpoch?: number | null;
  };
  workerId: string;
}) {
  return processGoogleAdsPartition(input);
}

export interface GoogleAdsSyncResult {
  businessId: string;
  attempted: number;
  succeeded: number;
  failed: number;
  skipped: boolean;
  outcome?:
    | "skipped_non_worker_mode"
    | "skipped_existing_background_lock"
    | "skipped_no_partitions"
    | "skipped_worker_state_guard"
    | "consume_failed_before_leasing"
    | "consume_failed_after_leasing"
    | "consume_completed_without_progress"
    | "consume_completed_with_progress";
  failureReason?: string | null;
}

export interface GoogleAdsTargetedRepairResult {
  businessId: string;
  scope: GoogleAdsWarehouseScope;
  startDate: string;
  endDate: string;
  syncResult: GoogleAdsSyncResult;
  beforeCoverage: {
    completedDays: number;
    totalDays: number;
    readyThroughDate: string | null;
  };
  afterCoverage: {
    completedDays: number;
    totalDays: number;
    readyThroughDate: string | null;
  };
  outcome: "coverage_increased" | "no_data" | "failed" | "skipped";
  coverageDelta: number;
  beforeVerification: {
    incidentCount: number;
    mismatchDates: string[];
    providerAccountIds: string[];
  };
  afterVerification: {
    incidentCount: number;
    mismatchDates: string[];
    providerAccountIds: string[];
  };
  remainingMismatchDates: string[];
  verificationOutcome: "consistent" | "still_inconsistent" | "not_applicable";
}

export async function syncGoogleAdsRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
  syncType?: GoogleAdsSyncType;
  triggerSource?: string;
  scopes?: GoogleAdsWarehouseScope[];
}): Promise<GoogleAdsSyncResult> {
  const days = enumerateDays(
    input.startDate,
    input.endDate,
    input.syncType !== "initial_backfill",
  );
  return syncGoogleAdsDates({
    businessId: input.businessId,
    dates: days,
    syncType: input.syncType ?? "incremental_recent",
    triggerSource: input.triggerSource ?? "system",
    scopes: input.scopes,
  });
}

export async function runGoogleAdsTargetedRepair(input: {
  businessId: string;
  scope: GoogleAdsWarehouseScope;
  startDate: string;
  endDate: string;
}): Promise<GoogleAdsTargetedRepairResult> {
  const integrityScopeRelevant =
    input.scope === "account_daily" || input.scope === "campaign_daily";
  const beforeIncidents = integrityScopeRelevant
    ? await getGoogleAdsWarehouseIntegrityIncidents({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
      }).catch(() => [])
    : [];
  const beforeVerification = summarizeGoogleAdsIntegrityIncidents(
    beforeIncidents,
  );
  const beforeCoverageRaw = await getGoogleAdsDailyCoverage({
    scope: input.scope,
    businessId: input.businessId,
    providerAccountId: null,
    startDate: input.startDate,
    endDate: input.endDate,
  }).catch(() => null);

  const beforeCoverage = {
    completedDays: Number(beforeCoverageRaw?.completed_days ?? 0),
    totalDays: 0,
    readyThroughDate: beforeCoverageRaw?.ready_through_date
      ? String(beforeCoverageRaw.ready_through_date).slice(0, 10)
      : null,
  };

  await cleanupGoogleAdsObsoleteSyncJobs({
    businessId: input.businessId,
  }).catch(() => null);
  await expireStaleGoogleAdsSyncJobs({
    businessId: input.businessId,
  }).catch(() => null);
  await cleanupGoogleAdsPartitionOrchestration({
    businessId: input.businessId,
    staleRunMinutesByLane: {
      core: GOOGLE_ADS_STALE_RUN_CORE_MINUTES,
      maintenance: GOOGLE_ADS_STALE_RUN_MAINTENANCE_MINUTES,
      extended: GOOGLE_ADS_STALE_RUN_EXTENDED_MINUTES,
    },
    runProgressGraceMinutes: GOOGLE_ADS_RUN_PROGRESS_GRACE_MINUTES,
  }).catch(() => null);
  await recoverGoogleAdsD1FinalizePartitions({
    businessId: input.businessId,
  }).catch(() => null);

  const syncResult = await syncGoogleAdsRange({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    syncType: "repair_window",
    triggerSource: `manual_targeted_repair:${input.scope}`,
    scopes: [input.scope],
  });

  await refreshGoogleAdsSyncStateForBusiness({
    businessId: input.businessId,
    scopes: [input.scope],
  });

  const afterIncidents = integrityScopeRelevant
    ? await getGoogleAdsWarehouseIntegrityIncidents({
        businessId: input.businessId,
        startDate: input.startDate,
        endDate: input.endDate,
      }).catch(() => [])
    : [];
  const afterVerification = summarizeGoogleAdsIntegrityIncidents(afterIncidents);

  const afterCoverageRaw = await getGoogleAdsDailyCoverage({
    scope: input.scope,
    businessId: input.businessId,
    providerAccountId: null,
    startDate: input.startDate,
    endDate: input.endDate,
  }).catch(() => null);

  const afterCoverage = {
    completedDays: Number(afterCoverageRaw?.completed_days ?? 0),
    totalDays: 0,
    readyThroughDate: afterCoverageRaw?.ready_through_date
      ? String(afterCoverageRaw.ready_through_date).slice(0, 10)
      : null,
  };

  const coverageDelta =
    afterCoverage.completedDays - beforeCoverage.completedDays;
  const outcome =
    syncResult.failed > 0
      ? "failed"
      : syncResult.skipped
        ? "skipped"
        : coverageDelta > 0 ||
            afterCoverage.readyThroughDate !== beforeCoverage.readyThroughDate
          ? "coverage_increased"
          : "no_data";
  const remainingMismatchDates = afterVerification.mismatchDates;
  const verificationOutcome = !integrityScopeRelevant
    ? "not_applicable"
    : remainingMismatchDates.length === 0
      ? "consistent"
      : "still_inconsistent";

  return {
    businessId: input.businessId,
    scope: input.scope,
    startDate: input.startDate,
    endDate: input.endDate,
    syncResult,
    beforeCoverage,
    afterCoverage,
    outcome,
    coverageDelta,
    beforeVerification,
    afterVerification,
    remainingMismatchDates,
    verificationOutcome,
  };
}

export async function syncGoogleAdsRecent(businessId: string) {
  const today = await resolveGoogleAdsCurrentDate(businessId).catch(() =>
    new Date().toISOString().slice(0, 10),
  );
  const endDate = addDaysToIsoDate(today, -1);
  const dates = enumerateDays(
    addDaysToIsoDate(endDate, -(GOOGLE_ADS_RECENT_MAINTENANCE_DAYS - 1)),
    endDate,
    true,
  );
  return syncGoogleAdsDates({
    businessId,
    dates,
    syncType: "incremental_recent",
    triggerSource: "background_recent",
  });
}

export async function syncGoogleAdsToday(businessId: string) {
  const today = await resolveGoogleAdsCurrentDate(businessId).catch(() =>
    new Date().toISOString().slice(0, 10),
  );
  return syncGoogleAdsDates({
    businessId,
    dates: [today],
    syncType: "today_refresh",
    triggerSource: "background_today",
  });
}

export async function syncGoogleAdsInitial(businessId: string) {
  const today = await resolveGoogleAdsCurrentDate(businessId).catch(() =>
    new Date().toISOString().slice(0, 10),
  );
  const yesterday = addDaysToIsoDate(today, -1);
  const dates = enumerateDays(
    getHistoricalWindowStart(yesterday, GOOGLE_ADS_WAREHOUSE_HISTORY_DAYS),
    yesterday,
    true,
  ).slice(0, GOOGLE_ADS_BOOTSTRAP_BATCH_DAYS);
  return syncGoogleAdsDates({
    businessId,
    dates,
    syncType: "initial_backfill",
    triggerSource: "background_initial",
    scopes: ["account_daily", "campaign_daily"],
  });
}

export async function syncGoogleAdsRepairRange(input: {
  businessId: string;
  startDate: string;
  endDate: string;
}) {
  return syncGoogleAdsRange({
    businessId: input.businessId,
    startDate: input.startDate,
    endDate: input.endDate,
    syncType: "repair_window",
    triggerSource: "background_repair",
  });
}

export async function ensureGoogleAdsWarehouseRangeFilled(input: {
  businessId: string;
  scope?: GoogleAdsWarehouseScope;
  startDate: string;
  endDate: string;
}) {
  await enqueueGoogleAdsScheduledWork(input.businessId).catch(() => null);
}

export async function syncGoogleAdsReports(
  businessId: string,
  input?: {
    runtimeLeaseGuard?: RunnerLeaseGuard;
    runtimeWorkerId?: string;
  },
): Promise<GoogleAdsSyncResult> {
  if (process.env.SYNC_WORKER_MODE !== "1") {
    await enqueueGoogleAdsScheduledWork(businessId).catch(() => null);
    return {
      businessId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
      outcome: "skipped_non_worker_mode",
      failureReason: null,
    };
  }
  await cleanupGoogleAdsObsoleteSyncJobs({ businessId }).catch(() => null);
  await expireStaleGoogleAdsSyncJobs({ businessId }).catch(() => null);
  await cleanupGoogleAdsPartitionOrchestration({
    businessId,
    staleRunMinutesByLane: {
      core: GOOGLE_ADS_STALE_RUN_CORE_MINUTES,
      maintenance: GOOGLE_ADS_STALE_RUN_MAINTENANCE_MINUTES,
      extended: GOOGLE_ADS_STALE_RUN_EXTENDED_MINUTES,
    },
    runProgressGraceMinutes: GOOGLE_ADS_RUN_PROGRESS_GRACE_MINUTES,
  }).catch(() => null);
  await recoverGoogleAdsD1FinalizePartitions({
    businessId,
  }).catch(() => null);
  const fullSyncPriority = await getGoogleAdsFullSyncPriorityState({
    businessId,
  }).catch(() => ({
    required: false,
    targetScopes: [] as GoogleAdsWarehouseScope[],
    totalDays: 0,
    historicalStart: null,
    yesterday: null,
  }));
  const recent90State = await getGoogleAdsRecent90CompletionState({
    businessId,
  }).catch(() => null);
  const allowPriorityHistoricalReplay =
    shouldAllowGoogleAdsPriorityHistoricalReplay({
      fullSyncPriorityRequired: fullSyncPriority.required,
      fullSyncPriorityTargetScopes: fullSyncPriority.targetScopes,
    });
  const historicalLeaseStartDate = resolveGoogleAdsHistoricalReplayStart({
    historicalStart: fullSyncPriority.historicalStart,
    recent90Start: recent90State?.recent90Start ?? null,
    recent90Complete: recent90State?.complete ?? true,
    fullSyncPriorityRequired: fullSyncPriority.required,
    allowPriorityHistorical: allowPriorityHistoricalReplay,
  });
  const initialQueueHealth = await getGoogleAdsQueueHealth({
    businessId,
  }).catch(() => null);
  const initialIncidentPolicy = await getGoogleAdsIncidentPolicy({
    businessId,
    queueHealth: initialQueueHealth,
  }).catch(() => null);
  const effectiveInitialIncidentPolicy =
    applyGoogleAdsFullSyncPriorityPolicyOverride({
      policy: initialIncidentPolicy,
      fullSyncPriorityRequired: fullSyncPriority.required,
    });
  const blockHistoricalExtendedWork =
    shouldBlockGoogleAdsHistoricalExtendedWork({
      recent90Complete: recent90State?.complete ?? true,
      allowPriorityHistorical: allowPriorityHistoricalReplay,
    });
  if (effectiveInitialIncidentPolicy) {
    await compactGoogleAdsIncidentBacklog({
      businessId,
      policy: effectiveInitialIncidentPolicy,
    }).catch(() => null);
  }
  await cancelHistoricalExtendedBacklog({
    businessId,
    recent90Complete: recent90State?.complete ?? true,
    scopeFilter: fullSyncPriority.required
      ? fullSyncPriority.targetScopes
      : undefined,
    allowPriorityHistorical: allowPriorityHistoricalReplay,
  }).catch(() => 0);

  const backgroundSyncKeys = getBackgroundSyncKeys();
  const lockKey = `background:${businessId}`;
  if (canUseInProcessBackgroundScheduling()) {
    const workerState = await getGoogleAdsWorkerSchedulingState({
      businessId,
    }).catch(() => null);
    if (workerState?.hasFreshHeartbeat && workerState.runnerLeaseActive) {
      return {
        businessId,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: true,
        outcome: "skipped_worker_state_guard",
        failureReason: null,
      };
    }
  }
  if (backgroundSyncKeys.has(lockKey)) {
    return {
      businessId,
      attempted: 0,
      succeeded: 0,
      failed: 0,
      skipped: true,
      outcome: "skipped_existing_background_lock",
      failureReason: null,
    };
  }

  backgroundSyncKeys.add(lockKey);
  const workerId = input?.runtimeWorkerId ?? getGoogleAdsWorkerId();
  let hasReachedLeasing = false;
  try {
    const leaseConflictReason = () =>
      input?.runtimeLeaseGuard?.getLeaseLossReason() ?? "runner_lease_conflict";
    const hasLeaseConflict = () =>
      input?.runtimeLeaseGuard?.isLeaseLost() ?? false;
    await enqueueGoogleAdsScheduledWork(businessId).catch(() => null);
    await refreshGoogleAdsSyncStateForBusiness({ businessId }).catch(
      (error) => {
        console.warn("[google-ads-sync] state_refresh_before_run_failed", {
          businessId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    const queueHealthAfterPlanning = await getGoogleAdsQueueHealth({
      businessId,
    }).catch(() => null);
    const stateRowsByScope = await Promise.all(
      GOOGLE_ADS_STATE_SCOPES.map((scope) =>
        getGoogleAdsSyncState({ businessId, scope }).catch(() => []),
      ),
    ).catch(() => GOOGLE_ADS_STATE_SCOPES.map(() => []));
    const statesByScope = Object.fromEntries(
      GOOGLE_ADS_STATE_SCOPES.map((scope, index) => [
        scope,
        stateRowsByScope[index] ?? [],
      ]),
    ) as GoogleAdsStatesByScope;
    const laneProgressEvidence = buildGoogleAdsLaneProgressEvidence({
      statesByScope,
      queueHealth: queueHealthAfterPlanning,
    });
    const policyBeforeRecentRepair = await getGoogleAdsIncidentPolicy({
      businessId,
      queueHealth: queueHealthAfterPlanning,
    }).catch(() => null);
    const effectivePolicyBeforeRecentRepair =
      applyGoogleAdsFullSyncPriorityPolicyOverride({
        policy: policyBeforeRecentRepair,
        fullSyncPriorityRequired: fullSyncPriority.required,
      });
    const recentRepairPlan = policyBeforeRecentRepair
      ? await enqueueGoogleAdsRecentRepairPartitions({
          businessId,
          policy: effectivePolicyBeforeRecentRepair ?? policyBeforeRecentRepair,
        }).catch(() => ({
          queuedRecent: 0,
          gapCountsByScope: Object.fromEntries(
            GOOGLE_ADS_RECENT_SELF_HEAL_SCOPES.map((scope) => [scope, 0]),
          ) as Record<GoogleAdsWarehouseScope, number>,
        }))
      : {
          queuedRecent: 0,
          gapCountsByScope: Object.fromEntries(
            GOOGLE_ADS_RECENT_SELF_HEAL_SCOPES.map((scope) => [scope, 0]),
          ) as Record<GoogleAdsWarehouseScope, number>,
        };
    void recentRepairPlan;
    const queueHealthAfterRecentPlanning = await getGoogleAdsQueueHealth({
      businessId,
    }).catch(() => null);
    const actionRequiredExcludedScopes =
      getGoogleAdsActionRequiredLeaseExcludedScopes(
        queueHealthAfterRecentPlanning ?? queueHealthAfterPlanning,
      );
    const policyBeforeHistoricalRecovery = await getGoogleAdsIncidentPolicy({
      businessId,
      queueHealth: queueHealthAfterRecentPlanning,
    }).catch(() => null);
    const effectivePolicyBeforeHistoricalRecovery =
      applyGoogleAdsFullSyncPriorityPolicyOverride({
        policy: policyBeforeHistoricalRecovery,
        fullSyncPriorityRequired: fullSyncPriority.required,
      });
    if (effectivePolicyBeforeHistoricalRecovery) {
      await enqueueExtendedRecoveryPartitions({
        businessId,
        policy: effectivePolicyBeforeHistoricalRecovery,
        recent90Complete: recent90State?.complete ?? true,
        scopes: fullSyncPriority.required
          ? fullSyncPriority.targetScopes
          : undefined,
        allowPriorityHistorical: allowPriorityHistoricalReplay,
      }).catch(() => ({ queuedHistorical: 0 }));
    }

    hasReachedLeasing = true;
    if (hasLeaseConflict()) {
      return {
        businessId,
        attempted: 0,
        succeeded: 0,
        failed: 1,
        skipped: false,
        outcome: "consume_failed_before_leasing",
        failureReason: leaseConflictReason(),
      };
    }

    let partitions = await leaseGoogleAdsSyncPartitions({
      businessId,
      lane: "core",
      workerId,
      limit: GOOGLE_ADS_CORE_WORKER_LIMIT,
      leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
      startDate: historicalLeaseStartDate,
      endDate: fullSyncPriority.yesterday,
      excludedScopeFilter: actionRequiredExcludedScopes,
    }).catch(() => []);
    const queueHealthAfterCore = await getGoogleAdsQueueHealth({
      businessId,
    }).catch(() => null);
    const livePolicyAfterCore = await getGoogleAdsIncidentPolicy({
      businessId,
      queueHealth: queueHealthAfterCore,
    }).catch(() => null);
    const effectiveLivePolicyAfterCore =
      applyGoogleAdsFullSyncPriorityPolicyOverride({
        policy: livePolicyAfterCore,
        fullSyncPriorityRequired: fullSyncPriority.required,
      });
    logGoogleAdsLeaseStepResult({
      businessId,
      step: "core",
      limit: GOOGLE_ADS_CORE_WORKER_LIMIT,
      lane: "core",
      startDate: historicalLeaseStartDate,
      endDate: fullSyncPriority.yesterday,
      excludedScopeFilter: actionRequiredExcludedScopes,
      leasedCount: partitions.length,
      queueHealth: queueHealthAfterCore,
      fullSyncPriorityRequired: fullSyncPriority.required,
      historicalLeaseStartDate,
      policy: effectiveLivePolicyAfterCore,
      budgetState: effectiveLivePolicyAfterCore?.budgetState ?? null,
    });
    const primaryLeasePlan = buildGoogleAdsPrimaryLeasePlan({
      policy: effectiveLivePolicyAfterCore,
      queueHealth: queueHealthAfterCore,
      fullSyncPriorityRequired: fullSyncPriority.required,
      fullSyncPriorityTargetScopes: fullSyncPriority.targetScopes,
      blockHistoricalExtendedWork,
      progressEvidence: laneProgressEvidence,
    });
    const historicalFairnessPartitions =
      primaryLeasePlan.historicalFairnessLimit > 0
        ? await leaseGoogleAdsSyncPartitions({
            businessId,
            lane: "extended",
            workerId,
            limit: primaryLeasePlan.historicalFairnessLimit,
            leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
            sourceFilter: "historical_only",
            scopeFilter: fullSyncPriority.required
              ? fullSyncPriority.targetScopes
              : undefined,
            startDate: historicalLeaseStartDate,
            endDate: fullSyncPriority.yesterday,
            excludedScopeFilter: actionRequiredExcludedScopes,
          }).catch(() => [])
        : [];
    logGoogleAdsLeaseStepResult({
      businessId,
      step: "historical_fairness",
      limit: primaryLeasePlan.historicalFairnessLimit,
      lane: "extended",
      sourceFilter: "historical_only",
      scopeFilter: fullSyncPriority.required
        ? fullSyncPriority.targetScopes
        : undefined,
      startDate: historicalLeaseStartDate,
      endDate: fullSyncPriority.yesterday,
      excludedScopeFilter: actionRequiredExcludedScopes,
      leasedCount: historicalFairnessPartitions.length,
      queueHealth: queueHealthAfterCore,
      fullSyncPriorityRequired: fullSyncPriority.required,
      historicalLeaseStartDate,
      policy: effectiveLivePolicyAfterCore,
      budgetState: effectiveLivePolicyAfterCore?.budgetState ?? null,
    });
    partitions = [...partitions, ...historicalFairnessPartitions];
    const recentExtendedPartitions =
      primaryLeasePlan.recentRepairLimit > 0
        ? await leaseGoogleAdsSyncPartitions({
            businessId,
            lane: "extended",
            workerId,
            limit: primaryLeasePlan.recentRepairLimit,
            leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
            sourceFilter: "recent_only",
            excludedScopeFilter: actionRequiredExcludedScopes,
          }).catch(() => [])
        : [];
    logGoogleAdsLeaseStepResult({
      businessId,
      step: "recent_repair",
      limit: primaryLeasePlan.recentRepairLimit,
      lane: "extended",
      sourceFilter: "recent_only",
      excludedScopeFilter: actionRequiredExcludedScopes,
      leasedCount: recentExtendedPartitions.length,
      queueHealth: queueHealthAfterCore,
      fullSyncPriorityRequired: fullSyncPriority.required,
      historicalLeaseStartDate,
      policy: effectiveLivePolicyAfterCore,
      budgetState: effectiveLivePolicyAfterCore?.budgetState ?? null,
    });
    partitions = [...partitions, ...recentExtendedPartitions];

    const fullSyncPriorityPartitions =
      primaryLeasePlan.fullSyncPriorityLimit > 0
        ? await leaseGoogleAdsSyncPartitions({
            businessId,
            lane: "extended",
            workerId,
            limit: primaryLeasePlan.fullSyncPriorityLimit,
            leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
            sourceFilter: "historical_only",
            scopeFilter: fullSyncPriority.targetScopes,
            startDate: historicalLeaseStartDate,
            endDate: fullSyncPriority.yesterday,
            excludedScopeFilter: actionRequiredExcludedScopes,
          }).catch(() => [])
        : [];
    logGoogleAdsLeaseStepResult({
      businessId,
      step: "full_sync_priority",
      limit: primaryLeasePlan.fullSyncPriorityLimit,
      lane: "extended",
      sourceFilter: "historical_only",
      scopeFilter: fullSyncPriority.targetScopes,
      startDate: historicalLeaseStartDate,
      endDate: fullSyncPriority.yesterday,
      excludedScopeFilter: actionRequiredExcludedScopes,
      leasedCount: fullSyncPriorityPartitions.length,
      queueHealth: queueHealthAfterCore,
      fullSyncPriorityRequired: fullSyncPriority.required,
      historicalLeaseStartDate,
      policy: effectiveLivePolicyAfterCore,
      budgetState: effectiveLivePolicyAfterCore?.budgetState ?? null,
    });
    partitions = [...partitions, ...fullSyncPriorityPartitions];

    const queueHealthAfterRecentLease = await getGoogleAdsQueueHealth({
      businessId,
    }).catch(() => null);
    const livePolicyAfterRecentLease = await getGoogleAdsIncidentPolicy({
      businessId,
      queueHealth: queueHealthAfterRecentLease,
    }).catch(() => null);
    const effectiveLivePolicyAfterRecentLease =
      applyGoogleAdsFullSyncPriorityPolicyOverride({
        policy: livePolicyAfterRecentLease,
        fullSyncPriorityRequired: fullSyncPriority.required,
      });
    const maintenanceLeasePlan = buildGoogleAdsMaintenanceLeasePlan({
      policy: effectiveLivePolicyAfterRecentLease,
      fullSyncPriorityRequired: fullSyncPriority.required,
    });
    const maintenancePartitions =
      maintenanceLeasePlan.maintenanceLimit > 0
        ? await leaseGoogleAdsSyncPartitions({
            businessId,
            lane: "maintenance",
            workerId,
            limit: maintenanceLeasePlan.maintenanceLimit,
            leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
            excludedScopeFilter: actionRequiredExcludedScopes,
          }).catch(() => [])
        : [];
    logGoogleAdsLeaseStepResult({
      businessId,
      step: "maintenance",
      limit: maintenanceLeasePlan.maintenanceLimit,
      lane: "maintenance",
      excludedScopeFilter: actionRequiredExcludedScopes,
      leasedCount: maintenancePartitions.length,
      queueHealth: queueHealthAfterRecentLease,
      fullSyncPriorityRequired: fullSyncPriority.required,
      historicalLeaseStartDate,
      policy: effectiveLivePolicyAfterRecentLease,
      budgetState: effectiveLivePolicyAfterRecentLease?.budgetState ?? null,
    });
    partitions = [...partitions, ...maintenancePartitions];
    const queueHealthAfterMaintenance = await getGoogleAdsQueueHealth({
      businessId,
    }).catch(() => null);
    const livePolicyAfterMaintenance = await getGoogleAdsIncidentPolicy({
      businessId,
      queueHealth: queueHealthAfterMaintenance,
    }).catch(() => null);
    const effectiveLivePolicyAfterMaintenance =
      applyGoogleAdsFullSyncPriorityPolicyOverride({
        policy: livePolicyAfterMaintenance,
        fullSyncPriorityRequired: fullSyncPriority.required,
      });

    if (partitions.length === 0) {
      const queueHealth = queueHealthAfterMaintenance;
      const livePolicy = effectiveLivePolicyAfterMaintenance;
      const fallbackLeasePlan = buildGoogleAdsFallbackExtendedLeasePlan({
        policy: livePolicy,
        fullSyncPriorityRequired: fullSyncPriority.required,
        fullSyncPriorityTargetScopes: fullSyncPriority.targetScopes,
        fullSyncPriorityYesterday: fullSyncPriority.yesterday,
        blockHistoricalExtendedWork,
        historicalLeaseStartDate,
      });
      if (fallbackLeasePlan) {
        partitions = await leaseGoogleAdsSyncPartitions({
          businessId,
          lane: "extended",
          workerId,
          limit: fallbackLeasePlan.limit,
          leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
          sourceFilter: fallbackLeasePlan.sourceFilter,
          scopeFilter: fallbackLeasePlan.scopeFilter,
          startDate: fallbackLeasePlan.startDate,
          endDate: fallbackLeasePlan.endDate,
          excludedScopeFilter: actionRequiredExcludedScopes,
        }).catch(() => []);
        logGoogleAdsLeaseStepResult({
          businessId,
          step: "fallback_extended",
          limit: fallbackLeasePlan.limit,
          lane: "extended",
          sourceFilter: fallbackLeasePlan.sourceFilter,
          scopeFilter: fallbackLeasePlan.scopeFilter,
          startDate: fallbackLeasePlan.startDate,
          endDate: fallbackLeasePlan.endDate,
          excludedScopeFilter: actionRequiredExcludedScopes,
          leasedCount: partitions.length,
          queueHealth,
          fullSyncPriorityRequired: fullSyncPriority.required,
          historicalLeaseStartDate,
          policy: livePolicy,
          budgetState: livePolicy?.budgetState ?? null,
        });
        if (partitions.length > 0 && livePolicy?.recoveryMode === "closed") {
          await enterProviderGlobalCircuitBreakerRecoveryState({
            provider: "google",
            businessId,
            message:
              "Google Ads extended sync is reopening in global half-open mode.",
            cooldownMs: GOOGLE_ADS_CIRCUIT_BREAKER_BASE_MINUTES * 60_000,
          }).catch(() => null);
        }
      }
    }
    if (partitions.length === 0) {
      return {
        businessId,
        attempted: 0,
        succeeded: 0,
        failed: 0,
        skipped: true,
        outcome: "skipped_no_partitions",
        failureReason: null,
      };
    }

    let attempted = partitions.length;
    let succeeded = 0;
    let failed = 0;
    for (const partition of partitions) {
      if (hasLeaseConflict()) {
        failed += 1;
        break;
      }
      const ok = await processGoogleAdsPartition({
        partition: {
          id: partition.id,
          businessId: partition.businessId,
          providerAccountId: partition.providerAccountId,
          lane: partition.lane,
          scope: partition.scope,
          partitionDate: partition.partitionDate,
          attemptCount: partition.attemptCount,
          leaseEpoch: partition.leaseEpoch,
          source: partition.source,
        },
        workerId,
      });
      if (ok) succeeded++;
      else failed++;
    }

    let postBatchQueueHealth = await getGoogleAdsQueueHealth({
      businessId,
    }).catch(() => null);
    let livePolicyAfterBatch = await getGoogleAdsIncidentPolicy({
      businessId,
      queueHealth: postBatchQueueHealth,
    }).catch(() => null);
    livePolicyAfterBatch = applyGoogleAdsFullSyncPriorityPolicyOverride({
      policy: livePolicyAfterBatch,
      fullSyncPriorityRequired: fullSyncPriority.required,
    });
    const shouldBurstExtended =
      !hasLeaseConflict() &&
      partitions.every((partition) => partition.lane !== "extended") &&
      (postBatchQueueHealth?.extendedQueueDepth ?? 0) > 0 &&
      (postBatchQueueHealth?.coreQueueDepth ?? 0) <=
        GOOGLE_ADS_EXTENDED_CORE_BACKLOG_THRESHOLD &&
      (postBatchQueueHealth?.maintenanceLeasedPartitions ?? 0) === 0 &&
      !livePolicyAfterBatch?.suspendExtended;

    if (shouldBurstExtended) {
      const burstSourceFilter =
        blockHistoricalExtendedWork ||
        shouldLeaseGoogleAdsRecentRepair({
          policy: livePolicyAfterBatch,
          queueHealth: postBatchQueueHealth,
        }) ||
        livePolicyAfterBatch?.lanePolicy.extendedHistorical === "suspended"
          ? "recent_only"
          : "all";
      const extendedPartitions = await leaseGoogleAdsSyncPartitions({
        businessId,
        lane: "extended",
        workerId,
        limit:
          fullSyncPriority.required && !blockHistoricalExtendedWork
            ? Math.max(
                1,
                Math.min(
                  GOOGLE_ADS_EXTENDED_FULL_SYNC_PRIORITY_LIMIT,
                  getGoogleAdsHistoricalLeaseLimit({
                    policy: livePolicyAfterBatch,
                  }),
                ),
              )
            : burstSourceFilter === "recent_only"
              ? getGoogleAdsRecentRepairLeaseLimit({
                  policy: livePolicyAfterBatch,
                })
              : GOOGLE_ADS_EXTENDED_BURST_WORKER_LIMIT,
        leaseMinutes: GOOGLE_ADS_PARTITION_LEASE_MINUTES,
        sourceFilter: blockHistoricalExtendedWork
          ? "recent_only"
          : fullSyncPriority.required
            ? "historical_only"
            : burstSourceFilter,
        scopeFilter:
          fullSyncPriority.required && !blockHistoricalExtendedWork
            ? fullSyncPriority.targetScopes
            : undefined,
        startDate:
          !blockHistoricalExtendedWork &&
          (fullSyncPriority.required || burstSourceFilter !== "recent_only")
            ? historicalLeaseStartDate
            : null,
        endDate:
          !blockHistoricalExtendedWork &&
          (fullSyncPriority.required || burstSourceFilter !== "recent_only")
            ? fullSyncPriority.yesterday
            : null,
        excludedScopeFilter: actionRequiredExcludedScopes,
      }).catch(() => []);

      attempted += extendedPartitions.length;
      for (const partition of extendedPartitions) {
        if (hasLeaseConflict()) {
          failed += 1;
          break;
        }
        const ok = await processGoogleAdsPartition({
          partition: {
            id: partition.id,
            businessId: partition.businessId,
            providerAccountId: partition.providerAccountId,
            lane: partition.lane,
            scope: partition.scope,
            partitionDate: partition.partitionDate,
            attemptCount: partition.attemptCount,
            leaseEpoch: partition.leaseEpoch,
            source: partition.source,
          },
          workerId,
        });
        if (ok) succeeded++;
        else failed++;
      }

      postBatchQueueHealth = await getGoogleAdsQueueHealth({
        businessId,
      }).catch(() => null);
      livePolicyAfterBatch = await getGoogleAdsIncidentPolicy({
        businessId,
        queueHealth: postBatchQueueHealth,
      }).catch(() => null);
    }

    await refreshGoogleAdsSyncStateForBusiness({ businessId }).catch(
      (error) => {
        console.warn("[google-ads-sync] state_refresh_after_run_failed", {
          businessId,
          message: error instanceof Error ? error.message : String(error),
        });
      },
    );
    return {
      businessId,
      attempted,
      succeeded,
      failed,
      skipped: attempted === 0,
      outcome:
        attempted === 0
          ? "skipped_no_partitions"
          : hasLeaseConflict() && succeeded === 0
            ? "consume_failed_after_leasing"
            : succeeded > 0
              ? "consume_completed_with_progress"
              : "consume_completed_without_progress",
      failureReason:
        hasLeaseConflict() && succeeded === 0
          ? leaseConflictReason()
          : failed > 0 && succeeded === 0
            ? "all_partition_attempts_failed"
            : null,
    };
  } catch (error) {
    return {
      businessId,
      attempted: 0,
      succeeded: 0,
      failed: 1,
      skipped: false,
      outcome: hasReachedLeasing
        ? "consume_failed_after_leasing"
        : "consume_failed_before_leasing",
      failureReason: error instanceof Error ? error.message : String(error),
    };
  } finally {
    await releaseGoogleAdsLeasedPartitionsForWorker({
      businessId,
      workerId,
      lastError: "leased partition released automatically after syncGoogleAdsReports returned",
    }).catch(() => null);
    backgroundSyncKeys.delete(lockKey);
  }
}
