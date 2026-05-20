export interface ProviderRequiredCoverage {
  completedDays: number;
  totalDays: number;
  percent: number;
  readyThroughDate: string | null;
  complete: boolean;
}

export type ProviderProgressState =
  | "ready"
  | "syncing"
  | "partial_progressing"
  | "partial_stuck"
  | "blocked";

export type ProviderActivityState =
  | "ready"
  | "busy"
  | "waiting"
  | "stalled"
  | "blocked";

export type SyncTruthState =
  | ProviderActivityState
  | "worker_unavailable"
  | "not_release_ready";

export type SyncBlockerClass =
  | "none"
  | "worker_unavailable"
  | "queue_blocked"
  | "stalled"
  | "not_release_ready"
  | "runtime_contract_invalid"
  | "misconfigured"
  | "unknown";

export type ProviderStallFingerprint =
  | "historical_starvation"
  | "dead_letter_blocking_completion"
  | "checkpoint_not_advancing"
  | "activity_without_coverage_progress"
  | "repair_loop_without_progress"
  | "worker_unavailable";

export interface ProviderProgressEvidence {
  lastCheckpointAdvancedAt: string | null;
  lastReadyThroughAdvancedAt: string | null;
  lastCompletedAt: string | null;
  backlogDelta: number | null;
  completedPartitionDelta: number | null;
  lastReplayAt: string | null;
  lastReclaimAt: string | null;
  recentActivityWindowMinutes?: number;
}

export interface ProviderProgressEvidenceStateRow {
  completedDays?: number | null;
  readyThroughDate?: string | null;
  latestBackgroundActivityAt?: string | null;
  latestSuccessfulSyncAt?: string | null;
  updatedAt?: string | null;
}

export interface ProviderFairnessInputs {
  maintenanceLimit?: number | null;
  coreFairnessLimit?: number | null;
  historicalFairnessLimit?: number | null;
  extendedHistoricalFairnessLimit?: number | null;
  extendedRecentLimit?: number | null;
  recentRepairLimit?: number | null;
  fullSyncPriorityLimit?: number | null;
  blockHistoricalExtendedWork?: boolean | null;
  fullSyncPriorityRequired?: boolean | null;
  fullSyncPriorityLeaseRequired?: boolean | null;
  actionRequiredExcludedScopes?: string[] | null;
  fullSyncPriorityTargetScopes?: string[] | null;
  fullSyncPriorityEffectiveTargetScopes?: string[] | null;
  fullSyncPriorityBlockedScopes?: string[] | null;
  priorityTargetActionRequired?: boolean | null;
}

export interface ProviderMaintenancePlan {
  autoHealEnabled: boolean;
  enqueueScheduledWork: boolean;
}

export interface ProviderLeasePlanStep {
  key: string;
  lane?: string;
  limit: number;
  onlyIfNoLease?: boolean;
  sources?: string[] | null;
  sourceFilter?: "all" | "recent_only" | "historical_only";
  scopeFilter?: string[];
  excludedScopeFilter?: string[];
  startDate?: string | null;
  endDate?: string | null;
}

export interface ProviderLeasePlan {
  kind: string;
  requestedLimit: number;
  steps: ProviderLeasePlanStep[];
  maintenancePlan?: ProviderMaintenancePlan | null;
  fairnessInputs?: ProviderFairnessInputs | null;
  progressEvidence?: ProviderProgressEvidence | null;
  latestPartitionActivityAt?: string | null;
  queueDepth?: number;
  leasedPartitions?: number;
  hasRepairableBacklog?: boolean;
  staleRunPressure?: number;
  blockedReasonCodes?: string[];
  stallFingerprints?: ProviderStallFingerprint[];
}

const ACTIVE_PARTITION_BLOCKING_STATUSES = ["queued", "leased", "running"] as const;
const RETRYABLE_PARTITION_STATUSES = ["failed"] as const;
const REPLAYABLE_PARTITION_STATUSES = ["dead_letter"] as const;

export interface ProviderSecondaryReadiness {
  key: string;
  state: "ready" | "building" | "blocked";
  detail: string;
}

export interface ProviderBlockingReason {
  code: string;
  detail: string;
  repairable: boolean;
}

export interface ProviderRepairableAction {
  kind: string;
  detail: string;
  available: boolean;
}

export interface ProviderAutoHealResult {
  reclaimed: number;
  replayed: number;
  requeued: number;
  blocked: boolean;
  blockingReasons: ProviderBlockingReason[];
  repairableActions: ProviderRepairableAction[];
  meta?: Record<string, unknown>;
}

export function buildRequiredCoverage(input: {
  completedDays: number;
  totalDays: number;
  readyThroughDate: string | null;
}): ProviderRequiredCoverage {
  const totalDays = Math.max(0, input.totalDays);
  const completedDays = Math.max(0, Math.min(input.completedDays, totalDays));
  const complete = totalDays > 0 && completedDays >= totalDays;
  const percent =
    totalDays > 0
      ? complete
        ? 100
        : Math.max(0, Math.min(99, Math.floor((completedDays / totalDays) * 100)))
      : 0;
  return {
    completedDays,
    totalDays,
    percent,
    readyThroughDate: input.readyThroughDate,
    complete,
  };
}

export function buildBlockingReason(
  code: string,
  detail: string,
  options?: { repairable?: boolean }
): ProviderBlockingReason {
  return {
    code,
    detail,
    repairable: options?.repairable ?? false,
  };
}

export function buildRepairableAction(
  kind: string,
  detail: string,
  options?: { available?: boolean }
): ProviderRepairableAction {
  return {
    kind,
    detail,
    available: options?.available ?? true,
  };
}

export function compactBlockingReasons(
  reasons: Array<ProviderBlockingReason | null | false | undefined>
): ProviderBlockingReason[] {
  const seen = new Set<string>();
  const rows: ProviderBlockingReason[] = [];
  for (const reason of reasons) {
    if (!reason) continue;
    const key = `${reason.code}:${reason.detail}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(reason);
  }
  return rows;
}

export function compactRepairableActions(
  actions: Array<ProviderRepairableAction | null | false | undefined>
): ProviderRepairableAction[] {
  const seen = new Set<string>();
  const rows: ProviderRepairableAction[] = [];
  for (const action of actions) {
    if (!action) continue;
    const key = `${action.kind}:${action.detail}:${action.available}`;
    if (seen.has(key)) continue;
    seen.add(key);
    rows.push(action);
  }
  return rows;
}

export function getActivePartitionBlockingStatuses() {
  return [...ACTIVE_PARTITION_BLOCKING_STATUSES];
}

export function getRetryablePartitionStatuses() {
  return [...RETRYABLE_PARTITION_STATUSES];
}

export function getReplayablePartitionStatuses() {
  return [...REPLAYABLE_PARTITION_STATUSES];
}

export function isActivePartitionBlockingStatus(status: string | null | undefined) {
  return ACTIVE_PARTITION_BLOCKING_STATUSES.includes(String(status ?? "") as (typeof ACTIVE_PARTITION_BLOCKING_STATUSES)[number]);
}

export function isRetryablePartitionStatus(status: string | null | undefined) {
  return RETRYABLE_PARTITION_STATUSES.includes(String(status ?? "") as (typeof RETRYABLE_PARTITION_STATUSES)[number]);
}

export function isReplayablePartitionStatus(status: string | null | undefined) {
  return REPLAYABLE_PARTITION_STATUSES.includes(String(status ?? "") as (typeof REPLAYABLE_PARTITION_STATUSES)[number]);
}

function normalizeEvidenceTimestamp(value: string | null | undefined) {
  if (!value) return null;
  const parsed = new Date(value);
  if (!Number.isFinite(parsed.getTime())) return null;
  return parsed.toISOString();
}

function selectEvidenceTimestamp(
  values: Array<string | null | undefined>,
  aggregation: "latest" | "bottleneck"
) {
  const normalized = values
    .map((value) => normalizeEvidenceTimestamp(value))
    .filter((value): value is string => Boolean(value));
  if (normalized.length === 0) return null;
  return aggregation === "latest"
    ? normalized.sort().at(-1) ?? null
    : normalized.sort()[0] ?? null;
}

export function buildProviderProgressEvidence(input: {
  states?: ProviderProgressEvidenceStateRow[];
  checkpointUpdatedAt?: string | null;
  backlogDelta?: number | null;
  completedPartitionDelta?: number | null;
  lastReplayAt?: string | null;
  lastReclaimAt?: string | null;
  recentActivityWindowMinutes?: number;
  aggregation?: "latest" | "bottleneck";
}): ProviderProgressEvidence {
  const states = input.states ?? [];
  const aggregation = input.aggregation ?? "bottleneck";
  const completionTimestamps = states.map(
    (row) => row.latestSuccessfulSyncAt ?? row.updatedAt ?? row.latestBackgroundActivityAt ?? null
  );
  const readyThroughTimestamps = states
    .filter((row) => Boolean(row.readyThroughDate))
    .map((row) => row.latestSuccessfulSyncAt ?? row.updatedAt ?? row.latestBackgroundActivityAt ?? null);

  return {
    lastCheckpointAdvancedAt: normalizeEvidenceTimestamp(input.checkpointUpdatedAt ?? null),
    lastReadyThroughAdvancedAt: selectEvidenceTimestamp(readyThroughTimestamps, aggregation),
    lastCompletedAt: selectEvidenceTimestamp(completionTimestamps, aggregation),
    backlogDelta: input.backlogDelta ?? null,
    completedPartitionDelta: input.completedPartitionDelta ?? null,
    lastReplayAt: normalizeEvidenceTimestamp(input.lastReplayAt ?? null),
    lastReclaimAt: normalizeEvidenceTimestamp(input.lastReclaimAt ?? null),
    recentActivityWindowMinutes: input.recentActivityWindowMinutes,
  };
}

export function deriveUnifiedSyncTruth(input: {
  activityState: ProviderActivityState | null | undefined;
  progressState: ProviderProgressState | null | undefined;
  workerOnline?: boolean | null;
  queueDepth?: number | null;
  leasedPartitions?: number | null;
  releaseGateVerdict?:
    | "pass"
    | "fail"
    | "misconfigured"
    | "measure_only"
    | "warn_only"
    | "blocked"
    | null;
  runtimeContractValid?: boolean | null;
}) {
  const queueDepth = Math.max(0, Number(input.queueDepth ?? 0));
  const leasedPartitions = Math.max(0, Number(input.leasedPartitions ?? 0));
  const releaseGateVerdict = input.releaseGateVerdict ?? null;

  if (input.runtimeContractValid === false) {
    return {
      syncTruthState: "blocked" as SyncTruthState,
      blockerClass: "runtime_contract_invalid" as SyncBlockerClass,
    };
  }

  if (input.workerOnline === false && (queueDepth > 0 || leasedPartitions > 0)) {
    return {
      syncTruthState: "worker_unavailable" as SyncTruthState,
      blockerClass: "worker_unavailable" as SyncBlockerClass,
    };
  }

  if (releaseGateVerdict && releaseGateVerdict !== "pass") {
    return {
      syncTruthState: "not_release_ready" as SyncTruthState,
      blockerClass:
        releaseGateVerdict === "misconfigured"
          ? ("misconfigured" as SyncBlockerClass)
          : ("not_release_ready" as SyncBlockerClass),
    };
  }

  if (input.activityState === "blocked" || input.progressState === "blocked") {
    return {
      syncTruthState: "blocked" as SyncTruthState,
      blockerClass: "queue_blocked" as SyncBlockerClass,
    };
  }

  if (input.activityState === "stalled" || input.progressState === "partial_stuck") {
    return {
      syncTruthState: "stalled" as SyncTruthState,
      blockerClass: "stalled" as SyncBlockerClass,
    };
  }

  return {
    syncTruthState: (input.activityState ?? "waiting") as SyncTruthState,
    blockerClass: "none" as SyncBlockerClass,
  };
}

export function hasRecentProviderAdvancement(input: {
  progressEvidence?: ProviderProgressEvidence | null;
  fallbackLatestPartitionActivityAt?: string | null;
  nowMs?: number;
}) {
  const evidence = input.progressEvidence;
  if (!evidence) return false;
  if ((evidence.completedPartitionDelta ?? 0) > 0) return true;
  if ((evidence.backlogDelta ?? 0) < 0) return true;
  const cutoffMs = Math.max(1, evidence.recentActivityWindowMinutes ?? 15) * 60_000;
  const nowMs = input.nowMs ?? Date.now();
  const timestamps = [
    evidence.lastCheckpointAdvancedAt,
    evidence.lastReadyThroughAdvancedAt,
    evidence.lastCompletedAt,
    evidence.lastReplayAt,
    evidence.lastReclaimAt,
    input.fallbackLatestPartitionActivityAt ?? null,
  ]
    .map((value) => normalizeEvidenceTimestamp(value))
    .filter((value): value is string => Boolean(value))
    .map((value) => new Date(value).getTime())
    .filter((value) => Number.isFinite(value));
  if (timestamps.length === 0) return false;
  const latestEvidenceMs = Math.max(...timestamps);
  return nowMs - latestEvidenceMs <= cutoffMs;
}

export function deriveProviderProgressState(input: {
  queueDepth: number;
  leasedPartitions: number;
  checkpointLagMinutes: number | null;
  latestPartitionActivityAt: string | null;
  blocked: boolean;
  fullyReady: boolean;
  hasRepairableBacklog?: boolean;
  staleRunPressure?: number;
  progressEvidence?: ProviderProgressEvidence | null;
}): ProviderProgressState {
  if (input.blocked) return "blocked";
  if (input.fullyReady && input.queueDepth === 0 && input.leasedPartitions === 0) return "ready";
  if (
    input.leasedPartitions > 0 &&
    (input.checkpointLagMinutes == null || input.checkpointLagMinutes <= 20)
  ) {
    return "syncing";
  }

  const recentWindowMinutes = Math.max(1, input.progressEvidence?.recentActivityWindowMinutes ?? 15);
  const hasRecentAdvancement = hasRecentProviderAdvancement({
    progressEvidence: {
      backlogDelta: input.progressEvidence?.backlogDelta ?? null,
      completedPartitionDelta: input.progressEvidence?.completedPartitionDelta ?? null,
      lastCheckpointAdvancedAt: input.progressEvidence?.lastCheckpointAdvancedAt ?? null,
      lastReadyThroughAdvancedAt: input.progressEvidence?.lastReadyThroughAdvancedAt ?? null,
      lastCompletedAt: input.progressEvidence?.lastCompletedAt ?? null,
      lastReplayAt: input.progressEvidence?.lastReplayAt ?? null,
      lastReclaimAt: input.progressEvidence?.lastReclaimAt ?? null,
      recentActivityWindowMinutes: recentWindowMinutes,
    },
    fallbackLatestPartitionActivityAt: input.latestPartitionActivityAt,
  });

  if (
    (input.queueDepth > 0 || input.hasRepairableBacklog || (input.staleRunPressure ?? 0) > 0) &&
    hasRecentAdvancement &&
    (input.checkpointLagMinutes == null || input.checkpointLagMinutes <= 20)
  ) {
    return "partial_progressing";
  }

  if (input.queueDepth > 0 || input.hasRepairableBacklog || (input.staleRunPressure ?? 0) > 0) {
    return "partial_stuck";
  }

  return input.fullyReady ? "ready" : "partial_stuck";
}

export function deriveProviderActivityState(input: {
  progressState: ProviderProgressState;
  queueDepth: number;
  leasedPartitions: number;
  blocked?: boolean;
}) : ProviderActivityState {
  if (input.blocked || input.progressState === "blocked") return "blocked";
  if (input.progressState === "ready" && input.queueDepth === 0 && input.leasedPartitions === 0) {
    return "ready";
  }
  if (
    input.leasedPartitions > 0 ||
    input.progressState === "syncing" ||
    input.progressState === "partial_progressing"
  ) {
    return "busy";
  }
  if (input.queueDepth > 0) {
    return input.progressState === "partial_stuck" ? "stalled" : "waiting";
  }
  return input.progressState === "partial_stuck" ? "stalled" : "waiting";
}

export function deriveProviderStallFingerprints(input: {
  queueDepth: number;
  leasedPartitions: number;
  checkpointLagMinutes: number | null;
  latestPartitionActivityAt: string | null;
  blocked: boolean;
  workerHealthy?: boolean | null;
  hasRepairableBacklog?: boolean;
  staleRunPressure?: number;
  progressEvidence?: ProviderProgressEvidence | null;
  blockedReasonCodes?: string[];
  historicalBacklogDepth?: number;
  nowMs?: number;
}): ProviderStallFingerprint[] {
  const rows = new Set<ProviderStallFingerprint>();
  const blockedReasonCodes = new Set(input.blockedReasonCodes ?? []);
  const hasRecentAdvancement = hasRecentProviderAdvancement({
    progressEvidence: input.progressEvidence,
    fallbackLatestPartitionActivityAt: input.latestPartitionActivityAt,
    nowMs: input.nowMs,
  });

  if (
    blockedReasonCodes.has("required_dead_letter_partitions") ||
    blockedReasonCodes.has("dead_letter_partitions")
  ) {
    rows.add("dead_letter_blocking_completion");
  }

  if (
    (input.historicalBacklogDepth ?? 0) > 0 &&
    !hasRecentAdvancement &&
    input.queueDepth > 0
  ) {
    rows.add("historical_starvation");
  }

  if (
    input.queueDepth > 0 &&
    input.leasedPartitions === 0 &&
    input.workerHealthy === false
  ) {
    rows.add("worker_unavailable");
  }

  if (
    input.queueDepth > 0 &&
    (input.checkpointLagMinutes == null || input.checkpointLagMinutes > 20) &&
    !hasRecentAdvancement
  ) {
    rows.add("checkpoint_not_advancing");
  }

  if (input.leasedPartitions > 0 && input.queueDepth > 0 && !hasRecentAdvancement) {
    rows.add("activity_without_coverage_progress");
  }

  if (
    (input.hasRepairableBacklog || input.blocked) &&
    !hasRecentAdvancement &&
    Boolean(input.progressEvidence?.lastReplayAt || input.progressEvidence?.lastReclaimAt)
  ) {
    rows.add("repair_loop_without_progress");
  }

  if ((input.staleRunPressure ?? 0) > 0 && !hasRecentAdvancement && input.queueDepth > 0) {
    rows.add("checkpoint_not_advancing");
  }

  return [...rows];
}
