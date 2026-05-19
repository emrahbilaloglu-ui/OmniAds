import {
  getDb,
  getDbRuntimeDiagnostics,
  getDbWithTimeout,
  type DbRuntimeDiagnostics,
} from "@/lib/db";
import {
  buildAdminDbDiagnostics,
  buildWorkerDbProcessDiagnostics,
  type AdminDbDiagnosticsPayload,
} from "@/lib/admin-db-diagnostics";
import {
  getMetaAuthoritativeBusinessOpsSnapshot,
  getMetaDeadLetterRecoverySummary,
  getMetaReclaimClassificationSummary,
  listMetaSyncPhaseTimingSummariesByBusiness,
  getMetaWarehouseIntegrityIncidents,
  type MetaDeadLetterRecoverySummary,
} from "@/lib/meta/warehouse";
import {
  getGoogleAdsQueueHealth,
  getGoogleAdsReclaimClassificationSummary,
  getGoogleAdsWarehouseIntegrityIncidents,
} from "@/lib/google-ads/warehouse";
import {
  getProviderBusinessWorkerObservation,
  getProviderScopeWorkerObservation,
  getSyncWorkerHealthSummary,
} from "@/lib/sync/worker-health";
import {
  assertRuntimeContractStartup,
  getRuntimeRegistryStatus,
  upsertRuntimeContractInstance,
} from "@/lib/sync/runtime-contract";
import {
  buildGlobalRebuildTruthReview,
  deriveProviderQuotaLimitedBusinessIds,
  type GlobalRebuildTruthReview,
} from "@/lib/rebuild-truth-review";
import {
  buildSyncEffectivenessReview,
  type SyncEffectivenessReview,
} from "@/lib/sync-effectiveness-review";
import { isMetaAuthoritativeFinalizationV2Enabled } from "@/lib/meta/authoritative-finalization-config";
import {
  getMetaProtectedPublishedTruthReview,
  getMetaRetentionRuntimeStatus,
} from "@/lib/meta/warehouse-retention";
import { getGoogleAdsRetentionRuntimeStatus } from "@/lib/google-ads/warehouse-retention";
import { META_CREATIVE_WAREHOUSE_HISTORY_DAYS } from "@/lib/meta/history";
import {
  deriveProviderActivityState,
  buildProviderProgressEvidence,
  deriveProviderStallFingerprints,
  deriveProviderProgressState,
  deriveUnifiedSyncTruth,
  type ProviderActivityState,
  type ProviderProgressEvidence,
  type ProviderProgressState,
  type ProviderStallFingerprint,
  type SyncBlockerClass,
  type SyncTruthState,
} from "@/lib/sync/provider-status-truth";
import type {
  MetaAuthoritativeBusinessOpsSnapshot,
  MetaSyncPhaseTimingSummary,
} from "@/lib/meta/warehouse-types";
import type { RuntimeContract, RuntimeRegistryStatus } from "@/lib/sync/runtime-contract";
import {
  getLatestSyncGateRecords,
  type SyncGateRecord,
} from "@/lib/sync/release-gates";
import {
  getLatestSyncRepairPlan,
  type SyncRepairPlanRecord,
} from "@/lib/sync/repair-planner";
import {
  getLatestSyncRepairExecutionSummary,
  getLatestSyncRepairExecutions,
  type SyncRepairExecutionRecord,
  type SyncRepairExecutionSummary,
} from "@/lib/sync/remediation-executions";
import { resolveSyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import { buildSyncLagMetrics, type SyncLagMetrics } from "@/lib/sync/lag-metrics";

type AuthProvider = "meta" | "google" | "search_console" | "ga4" | "shopify";
type SyncProvider = "google_ads" | "meta" | "ga4" | "search_console";
type AdminGoogleAdsQueueHealth = Awaited<ReturnType<typeof getGoogleAdsQueueHealth>>;

export interface AdminAuthIssueRow {
  businessId: string;
  businessName: string;
  provider: AuthProvider;
  issueType: string;
  detail: string;
  tokenExpiresAt: string | null;
  updatedAt: string;
}

export interface AdminAuthHealthPayload {
  summary: {
    affectedBusinesses: number;
    connectedIntegrations: number;
    expiredTokens: number;
    expiringSoon: number;
    missingRefreshTokens: number;
    missingScopes: number;
    integrationErrors: number;
    topIssue: string | null;
  };
  issues: AdminAuthIssueRow[];
}

export interface AdminSyncIssueRow {
  businessId: string;
  businessName: string;
  provider: SyncProvider;
  reportType: string;
  severity?: "critical" | "high" | "medium";
  runbookKey?: string | null;
  status: "failed" | "running" | "cooldown";
  detail: string;
  triggeredAt: string | null;
  completedAt: string | null;
}

export interface AdminSyncHealthPayload {
  globalRebuildReview?: GlobalRebuildTruthReview;
  syncEffectivenessReview?: SyncEffectivenessReview;
  runtimeContract?: RuntimeContract | null;
  runtimeRegistry?: RuntimeRegistryStatus | null;
  deployGate?: SyncGateRecord | null;
  releaseGate?: SyncGateRecord | null;
  repairPlan?: SyncRepairPlanRecord | null;
  remediationSummary?: SyncRepairExecutionSummary | null;
  googleAdsHealthStatus?: "ok" | "degraded" | "failed";
  googleAdsHealthError?: string | null;
  dbDiagnostics?: AdminDbDiagnosticsPayload;
  summary: {
    impactedBusinesses: number;
    runningJobs: number;
    stuckJobs: number;
    failedJobs24h: number;
    activeCooldowns: number;
    successJobs24h: number;
    topIssue: string | null;
    googleAdsQueueDepth?: number;
    googleAdsLeasedPartitions?: number;
    googleAdsDeadLetterPartitions?: number;
    googleAdsActionRequiredBusinessCount?: number;
    googleAdsActionRequiredPartitions?: number;
    googleAdsActionRequiredBlockingPartitions?: number;
    googleAdsActionRequiredScopes?: string[];
    googleAdsActionRequiredBlockingScopes?: string[];
    googleAdsOldestQueuedPartition?: string | null;
    metaQueueDepth?: number;
    metaLeasedPartitions?: number;
    metaDeadLetterPartitions?: number;
    metaOldestQueuedPartition?: string | null;
    metaSourceManifestCount?: number;
    metaPublishedProgression?: number;
    metaValidationFailures24h?: number;
    metaRepairBacklog?: number;
    metaStaleLeasePartitions?: number;
    metaLastSuccessfulPublishAt?: string | null;
    metaD1FinalizeSlaBreaches?: number;
    workerOnline?: boolean;
    workerInstances?: number;
    workerLastHeartbeatAt?: string | null;
    workerLastProgressHeartbeatAt?: string | null;
    googleAdsSafeModeActive?: boolean;
    googleAdsCircuitBreakerBusinesses?: number;
    googleAdsCompactedPartitions?: number;
    googleAdsBudgetPressureMax?: number;
    googleAdsRecoveryBusinesses?: number;
    googleAdsGlobalReopenEnabled?: boolean;
    googleAdsSkippedActiveLeaseRecoveries?: number;
    googleAdsLeaseConflictRuns24h?: number;
    googleAdsIntegrityIncidentCount?: number;
    googleAdsIntegrityBlockedCount?: number;
    metaSkippedActiveLeaseRecoveries?: number;
    metaStaleRunCount24h?: number;
    metaIntegrityIncidentCount?: number;
    metaIntegrityBlockedCount?: number;
    metaD1FinalizeNonTerminalCount?: number;
    syncTruthState?: SyncTruthState | null;
    blockerClass?: SyncBlockerClass | null;
  };
  issues: AdminSyncIssueRow[];
  workerHealth?: {
    onlineWorkers: number;
    workerInstances: number;
    lastHeartbeatAt: string | null;
    lastProgressHeartbeatAt?: string | null;
    workers: Array<{
      workerId: string;
      instanceType: string;
      providerScope: string;
      workerFreshnessState?: "online" | "stale" | "stopped";
      status: string;
      lastHeartbeatAt: string | null;
      lastBusinessId: string | null;
      lastPartitionId: string | null;
      lastConsumedBusinessId?: string | null;
      metaJson?: Record<string, unknown> | null;
    }>;
  };
  googleAdsBusinesses?: Array<{
    businessId: string;
    businessName: string;
    queueDepth: number;
    leasedPartitions: number;
    deadLetterPartitions: number;
    actionRequiredDeadLetterPartitions?: number;
    actionRequiredBlockingDeadLetterPartitions?: number;
    actionRequiredDeadLetterScopes?: string[];
    actionRequiredBlockingDeadLetterScopes?: string[];
    oldestQueuedPartition: string | null;
    latestPartitionActivityAt: string | null;
    campaignCompletedDays: number;
    searchTermCompletedDays: number;
    productCompletedDays: number;
    assetCompletedDays?: number;
    latestCheckpointPhase?: string | null;
    latestCheckpointUpdatedAt?: string | null;
    lastProgressHeartbeatAt?: string | null;
    checkpointLagMinutes?: number | null;
    lastSuccessfulPageIndex?: number | null;
    resumeCapable?: boolean;
    checkpointFailures?: number;
    poisonedCheckpointCount?: number;
    activeSlowPartitions?: number;
    reclaimCandidateCount?: number;
    lastReclaimReason?: string | null;
    skippedActiveLeaseRecoveries?: number;
    leaseConflictRuns24h?: number;
    latestPoisonReason?: string | null;
    latestPoisonedAt?: string | null;
    safeModeActive?: boolean;
    circuitBreakerOpen?: boolean;
    compactedPartitions?: number;
    quotaCallCount?: number;
    quotaErrorCount?: number;
    quotaBudget?: number;
    quotaPressure?: number;
    recoveryMode?: "open" | "half_open" | "closed";
    effectiveMode?: "safe_mode" | "global_backfill" | "global_reopen";
    recentSearchTermCompletedDays?: number;
    recentProductCompletedDays?: number;
    recentAssetCompletedDays?: number;
    recentRangeTotalDays?: number;
    recentExtendedReady?: boolean;
    historicalExtendedReady?: boolean;
    extendedRecentQueueDepth?: number;
    extendedRecentLeasedPartitions?: number;
    extendedHistoricalQueueDepth?: number;
    extendedHistoricalLeasedPartitions?: number;
    extendedRecoveryBlockReason?: string | null;
    extendedRecentReadyThroughDate?: string | null;
    googleWorkerHealthy?: boolean;
    googleHeartbeatAgeMs?: number | null;
    googleRunnerLeaseActive?: boolean;
    staleRunPressure?: number;
    integrityIncidentCount?: number;
    integrityBlockedCount?: number;
    progressState?: "ready" | "syncing" | "partial_progressing" | "partial_stuck" | "blocked";
    stallFingerprints?: ProviderStallFingerprint[];
    quotaLimitedEvidence?: boolean;
    campaignReadyThroughDate?: string | null;
    searchTermReadyThroughDate?: string | null;
    productReadyThroughDate?: string | null;
    assetReadyThroughDate?: string | null;
  }>;
  metaBusinesses?: Array<{
    businessId: string;
    businessName: string;
    queueDepth: number;
    leasedPartitions: number;
    retryableFailedPartitions: number;
    staleLeasePartitions: number;
    deadLetterPartitions: number;
    replayableDeadLetterPartitions?: number;
    terminalActionRequiredDeadLetterPartitions?: number;
    unknownDeadLetterPartitions?: number;
    deadLetterRecovery?: MetaDeadLetterRecoverySummary | null;
    stateRowCount: number;
    todayAccountRows: number;
    todayAdsetRows: number;
    currentDayReference: string | null;
    oldestQueuedPartition: string | null;
    latestPartitionActivityAt: string | null;
    accountCompletedDays: number;
    adsetCompletedDays: number;
    creativeCompletedDays: number;
    latestCheckpointScope?: string | null;
    latestCheckpointPhase?: string | null;
    latestCheckpointUpdatedAt?: string | null;
    lastProgressHeartbeatAt?: string | null;
    checkpointLagMinutes?: number | null;
    lastSuccessfulPageIndex?: number | null;
    resumeCapable?: boolean;
    checkpointFailures?: number;
    activeSlowPartitions?: number;
    reclaimCandidateCount?: number;
    lastReclaimReason?: string | null;
    skippedActiveLeaseRecoveries?: number;
    staleRunCount24h?: number;
    effectiveMode?: "core_only" | "extended_recovery" | "extended_normal";
    recentAccountCompletedDays?: number;
    recentAdsetCompletedDays?: number;
    recentCreativeCompletedDays?: number;
    recentAdCompletedDays?: number;
    recentRangeTotalDays?: number;
    recentExtendedReady?: boolean;
    historicalExtendedReady?: boolean;
    progressState?: "ready" | "syncing" | "partial_progressing" | "partial_stuck" | "blocked";
    activityState?: ProviderActivityState;
    syncTruthState?: SyncTruthState | null;
    blockerClass?: SyncBlockerClass | null;
    progressEvidence?: ProviderProgressEvidence | null;
    stallFingerprints?: ProviderStallFingerprint[];
    workerOnline?: boolean;
    workerLastHeartbeatAt?: string | null;
    workerFreshnessState?: "online" | "stale" | "stopped" | null;
    workerId?: string | null;
    workerConsumeStage?: string | null;
    sourceManifestCounts?: MetaAuthoritativeBusinessOpsSnapshot["manifestCounts"];
    latestAuthoritativePublishes?: MetaAuthoritativeBusinessOpsSnapshot["latestPublishes"];
    d1FinalizeSla?: MetaAuthoritativeBusinessOpsSnapshot["d1FinalizeSla"];
    validationFailures24h?: number;
    recentFailures?: MetaAuthoritativeBusinessOpsSnapshot["recentFailures"];
    repairBacklog?: number;
    queuedVsLeasedVsPublished?: MetaAuthoritativeBusinessOpsSnapshot["progression"];
    lastSuccessfulPublishAt?: string | null;
    integrityIncidentCount?: number;
    integrityBlockedCount?: number;
    d1FinalizeNonTerminalCount?: number;
    quotaLimitedEvidence?: boolean;
    accountReadyThroughDate?: string | null;
    adsetReadyThroughDate?: string | null;
    creativeReadyThroughDate?: string | null;
    adReadyThroughDate?: string | null;
    phaseTimings?: {
      windowHours: number;
      phases: MetaSyncPhaseTimingSummary[];
    } | null;
    lagMetrics?: SyncLagMetrics | null;
    latestRemediationExecution?: SyncRepairExecutionRecord | null;
  }>;
}

interface GoogleAdsHealthSummaryRow {
  queueDepth: number;
  leasedPartitions: number;
  deadLetterPartitions: number;
  oldestQueuedPartition: string | null;
}

interface AdminReclaimSummary {
  activeSlowPartitions: number;
  reclaimCandidateCount: number;
  poisonCandidateCount?: number;
}

interface AdminIntegritySummary {
  incidentCount: number;
  blockedCount: number;
}

export interface AdminRevenueRiskWorkspaceRow {
  businessId: string;
  businessName: string;
  ownerName: string | null;
  ownerEmail: string | null;
  createdAt: string;
  connectedIntegrations: number;
  reason: string;
}

export interface AdminRevenueRiskSubscriptionRow {
  businessId: string | null;
  businessName: string | null;
  ownerName: string | null;
  ownerEmail: string | null;
  planId: string;
  status: string;
  updatedAt: string;
}

export interface AdminRevenueRiskPayload {
  summary: {
    atRiskBusinesses: number;
    activeSubscriptions: number;
    nonActiveSubscriptions: number;
    unsubscribedBusinesses: number;
    topIssue: string | null;
  };
  unsubscribedBusinesses: AdminRevenueRiskWorkspaceRow[];
  subscriptionIssues: AdminRevenueRiskSubscriptionRow[];
  statusBreakdown: Array<{ status: string; count: number }>;
}

export interface AdminOperationsSummary {
  authHealth: AdminAuthHealthPayload["summary"];
  syncHealth: AdminSyncHealthPayload["summary"];
  revenueRisk: AdminRevenueRiskPayload["summary"];
}

interface RawAuthIntegrationRow {
  business_id: string;
  business_name: string;
  provider: AuthProvider;
  status: string;
  refresh_token: string | null;
  token_expires_at: string | null;
  scopes: string | null;
  error_message: string | null;
  updated_at: string;
}

interface RawSyncJobRow {
  business_id: string;
  business_name: string;
  provider: SyncProvider;
  report_type: string;
  status: string;
  error_message: string | null;
  triggered_at: string;
  started_at: string | null;
  completed_at: string | null;
}

interface RawCooldownRow {
  business_id: string;
  business_name: string;
  provider: SyncProvider;
  request_type: string;
  error_message: string | null;
  cooldown_until: string;
  updated_at: string;
}

function classifyGoogleAdsProgressState(input: {
  queueDepth: number;
  leasedPartitions: number;
  deadLetterPartitions: number;
  checkpointLagMinutes: number | null;
  latestCheckpointUpdatedAt: string | null;
  reclaimCandidateCount: number;
  leaseConflictRuns24h: number;
  poisonedCheckpointCount: number;
  staleRunPressure: number;
  recentExtendedReady: boolean;
  historicalExtendedReady: boolean;
  latestPartitionActivityAt: string | null;
}) : ProviderProgressState {
  return deriveProviderProgressState({
    queueDepth: input.queueDepth,
    leasedPartitions: input.leasedPartitions,
    checkpointLagMinutes: input.checkpointLagMinutes,
    latestPartitionActivityAt: input.latestPartitionActivityAt,
    blocked:
      input.deadLetterPartitions > 0 ||
      input.reclaimCandidateCount > 0 ||
      input.leaseConflictRuns24h > 0 ||
      input.poisonedCheckpointCount > 0,
    fullyReady: input.recentExtendedReady && input.historicalExtendedReady,
    staleRunPressure: input.staleRunPressure,
    progressEvidence: buildProviderProgressEvidence({
      checkpointUpdatedAt: input.latestCheckpointUpdatedAt,
      recentActivityWindowMinutes: 20,
      aggregation: "latest",
    }),
  });
}

function classifyMetaProgressState(input: {
  queueDepth: number;
  leasedPartitions: number;
  deadLetterPartitions: number;
  retryableFailedPartitions: number;
  staleLeasePartitions: number;
  checkpointLagMinutes: number | null;
  latestCheckpointUpdatedAt: string | null;
  reclaimCandidateCount: number;
  staleRunCount24h: number;
  recentExtendedReady: boolean;
  historicalExtendedReady: boolean;
  latestPartitionActivityAt: string | null;
}) : ProviderProgressState {
  return deriveProviderProgressState({
    queueDepth: input.queueDepth,
    leasedPartitions: input.leasedPartitions,
    checkpointLagMinutes: input.checkpointLagMinutes,
    latestPartitionActivityAt: input.latestPartitionActivityAt,
    blocked:
      input.deadLetterPartitions > 0 ||
      input.staleLeasePartitions > 0 ||
      input.reclaimCandidateCount > 0,
    fullyReady:
      input.recentExtendedReady &&
      input.historicalExtendedReady &&
      input.retryableFailedPartitions === 0,
    hasRepairableBacklog: input.retryableFailedPartitions > 0,
    staleRunPressure: input.staleRunCount24h,
    progressEvidence: buildProviderProgressEvidence({
      checkpointUpdatedAt: input.latestCheckpointUpdatedAt,
      recentActivityWindowMinutes: 20,
      aggregation: "latest",
    }),
  });
}

function buildAdminMetaProgressEvidence(input: {
  accountCompletedDays: number;
  accountReadyThroughDate?: string | null;
  adsetCompletedDays: number;
  adsetReadyThroughDate?: string | null;
  creativeCompletedDays: number;
  creativeReadyThroughDate?: string | null;
  adCompletedDays: number;
  adReadyThroughDate?: string | null;
  latestPartitionActivityAt?: string | null;
  latestProgressHeartbeatAt?: string | null;
  latestCheckpointUpdatedAt?: string | null;
}) {
  const latestObservedAt =
    input.latestProgressHeartbeatAt ??
    input.latestCheckpointUpdatedAt ??
    input.latestPartitionActivityAt ??
    null;
  return buildProviderProgressEvidence({
    states: [
      {
        completedDays: input.accountCompletedDays,
        readyThroughDate: input.accountReadyThroughDate ?? null,
        latestBackgroundActivityAt: input.latestPartitionActivityAt ?? null,
        latestSuccessfulSyncAt: latestObservedAt,
        updatedAt: latestObservedAt,
      },
      {
        completedDays: input.adsetCompletedDays,
        readyThroughDate: input.adsetReadyThroughDate ?? null,
        latestBackgroundActivityAt: input.latestPartitionActivityAt ?? null,
        latestSuccessfulSyncAt: latestObservedAt,
        updatedAt: latestObservedAt,
      },
      {
        completedDays: input.creativeCompletedDays,
        readyThroughDate: input.creativeReadyThroughDate ?? null,
        latestBackgroundActivityAt: input.latestPartitionActivityAt ?? null,
        latestSuccessfulSyncAt: latestObservedAt,
        updatedAt: latestObservedAt,
      },
      {
        completedDays: input.adCompletedDays,
        readyThroughDate: input.adReadyThroughDate ?? null,
        latestBackgroundActivityAt: input.latestPartitionActivityAt ?? null,
        latestSuccessfulSyncAt: latestObservedAt,
        updatedAt: latestObservedAt,
      },
    ],
    checkpointUpdatedAt: input.latestCheckpointUpdatedAt ?? null,
    recentActivityWindowMinutes: 20,
    aggregation: "bottleneck",
  });
}

interface RawGoogleAdsHealthRow {
  business_id: string;
  business_name: string;
  queue_depth: number | string;
  leased_partitions: number | string;
  dead_letter_partitions: number | string;
  oldest_queued_partition: string | null;
  latest_partition_activity_at: string | null;
  campaign_completed_days: number | string | null;
  campaign_dead_letter_count: number | string | null;
  campaign_ready_through_date?: string | null;
  search_term_completed_days: number | string | null;
  search_term_ready_through_date?: string | null;
  product_completed_days: number | string | null;
  product_ready_through_date?: string | null;
  asset_completed_days?: number | string | null;
  asset_ready_through_date?: string | null;
  latest_checkpoint_phase?: string | null;
  latest_checkpoint_updated_at?: string | null;
  latest_progress_heartbeat_at?: string | null;
  last_successful_page_index?: number | string | null;
  checkpoint_failures?: number | string | null;
  poisoned_checkpoint_count?: number | string | null;
  reclaim_candidate_count?: number | string | null;
  last_reclaim_reason?: string | null;
  skipped_active_lease_recoveries?: number | string | null;
  lease_conflict_runs_24h?: number | string | null;
  latest_poison_reason?: string | null;
  latest_poisoned_at?: string | null;
  active_circuit_breakers?: number | string | null;
  compacted_partitions?: number | string | null;
  quota_call_count?: number | string | null;
  quota_error_count?: number | string | null;
  quota_budget?: number | string | null;
  quota_pressure?: number | string | null;
  recovery_half_open?: number | string | null;
  canary_enabled?: boolean | null;
  recent_search_term_completed_days?: number | string | null;
  recent_product_completed_days?: number | string | null;
  recent_asset_completed_days?: number | string | null;
  recent_range_total_days?: number | string | null;
  extended_recent_queue_depth?: number | string | null;
  extended_recent_leased_partitions?: number | string | null;
  extended_historical_queue_depth?: number | string | null;
  extended_historical_leased_partitions?: number | string | null;
  extended_recent_ready_through_date?: string | null;
  google_worker_healthy?: boolean | null;
  google_heartbeat_age_ms?: number | string | null;
  google_runner_lease_active?: boolean | null;
  stale_run_pressure?: number | string | null;
}

interface RawMetaHealthRow {
  business_id: string;
  business_name: string;
  queue_depth: number | string;
  leased_partitions: number | string;
  retryable_failed_partitions: number | string;
  stale_lease_partitions: number | string;
  dead_letter_partitions: number | string;
  state_row_count: number | string;
  current_day_reference: string | null;
  oldest_queued_partition: string | null;
  latest_partition_activity_at: string | null;
  latest_checkpoint_scope: string | null;
  latest_checkpoint_phase: string | null;
  latest_checkpoint_updated_at: string | null;
  latest_progress_heartbeat_at: string | null;
  last_successful_page_index: number | string | null;
  checkpoint_failures: number | string | null;
  reclaim_candidate_count?: number | string | null;
  last_reclaim_reason?: string | null;
  skipped_active_lease_recoveries?: number | string | null;
  stale_run_count_24h?: number | string | null;
  today_account_rows: number | string;
  today_adset_rows: number | string;
  account_completed_days: number | string | null;
  account_ready_through_date?: string | null;
  adset_completed_days: number | string | null;
  adset_ready_through_date?: string | null;
  creative_completed_days: number | string | null;
  creative_ready_through_date?: string | null;
  ad_completed_days?: number | string | null;
  ad_ready_through_date?: string | null;
  recent_account_completed_days?: number | string | null;
  recent_adset_completed_days?: number | string | null;
  recent_creative_completed_days?: number | string | null;
  recent_ad_completed_days?: number | string | null;
  recent_range_total_days?: number | string | null;
}

interface RawRevenueWorkspaceRow {
  business_id: string;
  business_name: string;
  owner_name: string | null;
  owner_email: string | null;
  created_at: string;
  connected_integrations: number | string;
  has_active_subscription: boolean;
}

interface RawRevenueSubscriptionRow {
  business_id: string | null;
  business_name: string | null;
  owner_name: string | null;
  owner_email: string | null;
  plan_id: string;
  status: string;
  updated_at: string;
}

function getTopIssue(entries: string[]) {
  if (entries.length === 0) return null;
  const counts = new Map<string, number>();
  for (const entry of entries) {
    counts.set(entry, (counts.get(entry) ?? 0) + 1);
  }
  return Array.from(counts.entries()).sort((a, b) => b[1] - a[1])[0]?.[0] ?? null;
}

function getSyncIssueSeverity(issue: Pick<AdminSyncIssueRow, "reportType" | "status">) {
  if (
    issue.reportType === "worker_offline_with_leased_partitions" ||
    issue.reportType === "queue_dead_letter" ||
    issue.reportType === "lease_conflict_runs" ||
    issue.reportType === "stale_runs" ||
    issue.reportType === "integrity_blocked"
  ) {
    return "critical" as const;
  }
  if (
    issue.reportType === "stale_checkpoint" ||
    issue.reportType === "stalled_reclaimable" ||
    issue.reportType === "stale_lease" ||
    issue.reportType === "queue_waiting_worker" ||
    issue.reportType === "state_missing" ||
    issue.reportType === "poisoned_checkpoint" ||
    issue.reportType === "d1_finalize_nonterminal"
  ) {
    return "high" as const;
  }
  return "medium" as const;
}

function getSyncIssueRunbookKey(issue: Pick<AdminSyncIssueRow, "provider" | "reportType">) {
  switch (issue.reportType) {
    case "queue_dead_letter":
      return `${issue.provider}:dead_letter_recovery`;
    case "stale_checkpoint":
      return `${issue.provider}:checkpoint_stall`;
    case "stalled_reclaimable":
      return `${issue.provider}:stale_reclaim`;
    case "skipped_active_lease":
      return `${issue.provider}:active_lease_recovery_skip`;
    case "lease_conflict_runs":
      return "google_ads:lease_conflict";
    case "stale_runs":
      return "meta:stale_run";
    case "worker_offline_with_leased_partitions":
      return `${issue.provider}:worker_recovery`;
    case "queue_waiting_worker":
      return `${issue.provider}:worker_backlog`;
    case "stale_lease":
      return "meta:stale_lease";
    case "integrity_blocked":
      return `${issue.provider}:stale_reclaim`;
    case "d1_finalize_nonterminal":
      return "meta:stale_lease";
    default:
      return null;
  }
}

function computeLagMinutes(value: string | null) {
  if (!value) return null;
  const ms = new Date(value).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.max(0, Math.round((Date.now() - ms) / 60_000));
}

function isLagOverWindow(value: string | null, windowMinutes: number) {
  const lag = computeLagMinutes(value);
  return lag != null && lag > windowMinutes;
}

function parseScopes(value: string | null) {
  return new Set((value ?? "").split(/\s+/).filter(Boolean));
}

function providerRequiresRefreshToken(provider: AuthProvider) {
  return provider === "google" || provider === "search_console" || provider === "ga4";
}

function providerCanAutoRefresh(provider: AuthProvider, refreshToken: string | null) {
  return providerRequiresRefreshToken(provider) && Boolean(refreshToken);
}

function hasRequiredScope(provider: AuthProvider, scopes: Set<string>) {
  if (provider === "google") {
    return scopes.has("https://www.googleapis.com/auth/adwords");
  }
  if (provider === "search_console") {
    return (
      scopes.has("https://www.googleapis.com/auth/webmasters.readonly") ||
      scopes.has("https://www.googleapis.com/auth/webmasters")
    );
  }
  if (provider === "ga4") {
    return (
      scopes.has("https://www.googleapis.com/auth/analytics.readonly") ||
      scopes.has("https://www.googleapis.com/auth/analytics")
    );
  }
  return true;
}

export function buildAdminAuthHealth(rows: RawAuthIntegrationRow[]): AdminAuthHealthPayload {
  const issues: AdminAuthIssueRow[] = [];
  const affectedBusinesses = new Set<string>();
  let connectedIntegrations = 0;
  let expiredTokens = 0;
  let expiringSoon = 0;
  let missingRefreshTokens = 0;
  let missingScopes = 0;
  let integrationErrors = 0;
  const issueTypes: string[] = [];

  for (const row of rows) {
    const scopes = parseScopes(row.scopes);
    const isConnected = row.status === "connected";
    const expiresAtMs = row.token_expires_at ? new Date(row.token_expires_at).getTime() : NaN;

    if (isConnected) connectedIntegrations++;

    if (row.status === "error" || row.error_message) {
      integrationErrors++;
      issueTypes.push("Integration error");
      affectedBusinesses.add(row.business_id);
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: row.provider,
        issueType: "Integration error",
        detail: row.error_message ?? "The integration is in an error state.",
        tokenExpiresAt: row.token_expires_at,
        updatedAt: row.updated_at,
      });
    }

    if (isConnected && Number.isFinite(expiresAtMs)) {
      if (expiresAtMs <= Date.now()) {
        if (!providerCanAutoRefresh(row.provider, row.refresh_token)) {
          expiredTokens++;
          issueTypes.push("Token expired");
          affectedBusinesses.add(row.business_id);
          issues.push({
            businessId: row.business_id,
            businessName: row.business_name,
            provider: row.provider,
            issueType: "Token expired",
            detail: "The stored access token has already expired and this connection cannot auto-refresh itself.",
            tokenExpiresAt: row.token_expires_at,
            updatedAt: row.updated_at,
          });
        }
      } else if (expiresAtMs - Date.now() <= 72 * 60 * 60_000) {
        expiringSoon++;
      }
    }

    if (isConnected && providerRequiresRefreshToken(row.provider) && !row.refresh_token) {
      missingRefreshTokens++;
    }

    if (isConnected && !hasRequiredScope(row.provider, scopes)) {
      missingScopes++;
      issueTypes.push("Missing required scope");
      affectedBusinesses.add(row.business_id);
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: row.provider,
        issueType: "Missing required scope",
        detail: "The connected integration is missing one or more required OAuth scopes.",
        tokenExpiresAt: row.token_expires_at,
        updatedAt: row.updated_at,
      });
    }
  }

  return {
    summary: {
      affectedBusinesses: affectedBusinesses.size,
      connectedIntegrations,
      expiredTokens,
      expiringSoon,
      missingRefreshTokens,
      missingScopes,
      integrationErrors,
      topIssue: getTopIssue(issueTypes),
    },
    issues: issues.sort((a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()),
  };
}

export interface MetaReleaseGateBusinessHealthSnapshot {
  businessId: string;
  businessName: string | null;
  currentDayReference: string | null;
  latestCheckpointUpdatedAt: string | null;
  accountReadyThroughDate: string | null;
  adsetReadyThroughDate: string | null;
  creativeReadyThroughDate: string | null;
  adReadyThroughDate: string | null;
  progressState: ProviderProgressState | null;
  activityState: ProviderActivityState | null;
  stallFingerprints: ProviderStallFingerprint[];
  staleLeasePartitions: number;
  repairBacklog: number;
  validationFailures24h: number;
  reclaimCandidateCount: number;
  staleRunCount24h: number;
  lastSuccessfulPublishAt: string | null;
  d1FinalizeNonTerminalCount: number;
  workerOnline: boolean | null;
  workerLastHeartbeatAt: string | null;
  dbConstraint: string | null;
  dbBacklogState: string | null;
  latestPartitionActivityAt: string | null;
}

export function buildAdminSyncHealth(input: {
  jobs: RawSyncJobRow[];
  cooldowns: RawCooldownRow[];
  googleAdsHealth?: RawGoogleAdsHealthRow[];
  googleAdsHealthStatus?: "ok" | "degraded" | "failed";
  googleAdsHealthError?: string | null;
  googleAdsHealthSummary?: GoogleAdsHealthSummaryRow | null;
  googleAdsQueueHealthByBusiness?: Record<string, AdminGoogleAdsQueueHealth | null>;
  googleAdsReclaimSummaries?: Record<string, AdminReclaimSummary>;
  googleAdsIntegritySummaries?: Record<string, AdminIntegritySummary>;
  metaHealth?: RawMetaHealthRow[];
  metaAuthoritativeSnapshots?: MetaAuthoritativeBusinessOpsSnapshot[];
  metaPhaseTimingSummariesByBusiness?: Record<string, MetaSyncPhaseTimingSummary[]>;
  metaPhaseTimingWindowHours?: number;
  metaReclaimSummaries?: Record<string, AdminReclaimSummary>;
  metaIntegritySummaries?: Record<string, AdminIntegritySummary>;
  metaD1FinalizeNonTerminalCounts?: Record<string, number>;
  metaDeadLetterSummaries?: Record<string, MetaDeadLetterRecoverySummary>;
  workerHealth?: Awaited<ReturnType<typeof getSyncWorkerHealthSummary>>;
  webDbDiagnostics?: DbRuntimeDiagnostics | null;
  runtimeContract?: RuntimeContract | null;
  runtimeRegistry?: RuntimeRegistryStatus | null;
  deployGate?: SyncGateRecord | null;
  releaseGate?: SyncGateRecord | null;
  repairPlan?: SyncRepairPlanRecord | null;
  remediationSummary?: SyncRepairExecutionSummary | null;
  latestRepairExecutionsByBusiness?: Record<string, SyncRepairExecutionRecord | null>;
}): AdminSyncHealthPayload {
  const issues: AdminSyncIssueRow[] = [];
  const impactedBusinesses = new Set<string>();
  let runningJobs = 0;
  let stuckJobs = 0;
  let failedJobs24h = 0;
  let activeCooldowns = input.cooldowns.length;
  let successJobs24h = 0;
  const issueTypes: string[] = [];
  let googleAdsQueueDepth = 0;
  let googleAdsLeasedPartitions = 0;
  let googleAdsDeadLetterPartitions = 0;
  let googleAdsActionRequiredBusinessCount = 0;
  let googleAdsActionRequiredPartitions = 0;
  let googleAdsActionRequiredBlockingPartitions = 0;
  const googleAdsActionRequiredScopes = new Set<string>();
  const googleAdsActionRequiredBlockingScopes = new Set<string>();
  let googleAdsOldestQueuedPartition: string | null = null;
  let metaQueueDepth = 0;
  let metaLeasedPartitions = 0;
  let metaDeadLetterPartitions = 0;
  let metaOldestQueuedPartition: string | null = null;
  let metaSourceManifestCount = 0;
  let metaPublishedProgression = 0;
  let metaValidationFailures24h = 0;
  let metaRepairBacklog = 0;
  let metaStaleLeasePartitions = 0;
  let metaLastSuccessfulPublishAt: string | null = null;
  let metaD1FinalizeSlaBreaches = 0;
  let googleAdsCircuitBreakerBusinesses = 0;
  let googleAdsCompactedPartitions = 0;
  let googleAdsBudgetPressureMax = 0;
  let googleAdsRecoveryBusinesses = 0;
  const googleAdsGlobalReopenEnabled =
    (process.env.GOOGLE_ADS_EXTENDED_GENERAL_REOPEN?.trim().toLowerCase() ?? "") === "1" ||
    (process.env.GOOGLE_ADS_EXTENDED_GENERAL_REOPEN?.trim().toLowerCase() ?? "") === "true";
  let googleAdsSkippedActiveLeaseRecoveries = 0;
  let googleAdsLeaseConflictRuns24h = 0;
  let googleAdsIntegrityIncidentCount = 0;
  let googleAdsIntegrityBlockedCount = 0;
  let metaSkippedActiveLeaseRecoveries = 0;
  let metaStaleRunCount24h = 0;
  let metaIntegrityIncidentCount = 0;
  let metaIntegrityBlockedCount = 0;
  let metaD1FinalizeNonTerminalCount = 0;
  const googleAdsBusinesses: NonNullable<AdminSyncHealthPayload["googleAdsBusinesses"]> = [];
  const metaBusinesses: NonNullable<AdminSyncHealthPayload["metaBusinesses"]> = [];
  const metaProviderWorkerObservation = getProviderScopeWorkerObservation({
    providerScope: "meta",
    workers: input.workerHealth?.workers,
    staleThresholdMs: 3 * 60_000,
  });
  const runtimeContractValid =
    input.runtimeRegistry?.contractValid ?? input.runtimeContract?.validation.pass ?? null;
  let latestProgressHeartbeatAt: string | null = null;
  const metaSnapshotsByBusiness = new Map(
    (input.metaAuthoritativeSnapshots ?? [])
      .filter((snapshot): snapshot is MetaAuthoritativeBusinessOpsSnapshot => Boolean(snapshot))
      .map((snapshot) => [snapshot.businessId, snapshot]),
  );
  const metaPhaseTimingSummariesByBusiness = input.metaPhaseTimingSummariesByBusiness ?? {};
  const metaPhaseTimingWindowHours = Math.max(1, input.metaPhaseTimingWindowHours ?? 24);
  const googleQuotaLimitedBusinessIds = new Set(
    deriveProviderQuotaLimitedBusinessIds({
      provider: "google_ads",
      jobs: input.jobs,
      cooldowns: input.cooldowns,
    }),
  );
  const metaQuotaLimitedBusinessIds = new Set(
    deriveProviderQuotaLimitedBusinessIds({
      provider: "meta",
      jobs: input.jobs,
      cooldowns: input.cooldowns,
    }),
  );

  for (const row of input.jobs) {
    const triggeredMs = new Date(row.triggered_at).getTime();
    const within24h = Number.isFinite(triggeredMs) && Date.now() - triggeredMs <= 24 * 60 * 60_000;
    const isRunning = row.status === "running";
    const isStuck = isRunning && Date.now() - triggeredMs > 15 * 60_000;
    const providerUsesClassifier =
      row.provider === "google_ads" || row.provider === "meta";
    const isFailed = row.status === "failed" && within24h;
    const isDone = row.status === "done" && within24h;

    if (isRunning) runningJobs++;
    if (isStuck && !providerUsesClassifier) {
      stuckJobs++;
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Stuck sync jobs");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: row.provider,
        reportType: row.report_type,
        status: "running",
        detail: "This sync job has been running for more than 15 minutes.",
        triggeredAt: row.triggered_at,
        completedAt: row.completed_at,
      });
    }
    if (isFailed) {
      failedJobs24h++;
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Failed sync jobs");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: row.provider,
        reportType: row.report_type,
        status: "failed",
        detail: row.error_message ?? "The sync job failed without a persisted error message.",
        triggeredAt: row.triggered_at,
        completedAt: row.completed_at,
      });
    }
    if (isDone) successJobs24h++;
  }

  for (const row of input.cooldowns) {
    impactedBusinesses.add(row.business_id);
    issueTypes.push("Active cooldowns");
    issues.push({
      businessId: row.business_id,
      businessName: row.business_name,
      provider: row.provider,
      reportType: row.request_type,
      status: "cooldown",
      detail: row.error_message ?? "Provider request is currently in cooldown.",
      triggeredAt: row.updated_at,
      completedAt: row.cooldown_until,
    });
  }

  for (const row of input.googleAdsHealth ?? []) {
    const queueDepth = Number(row.queue_depth ?? 0);
    const leasedPartitions = Number(row.leased_partitions ?? 0);
    const deadLetterPartitions = Number(row.dead_letter_partitions ?? 0);
    const queueHealth = input.googleAdsQueueHealthByBusiness?.[row.business_id] ?? null;
    const actionRequiredDeadLetterPartitions = Number(
      queueHealth?.actionRequiredDeadLetterPartitions ?? 0,
    );
    const actionRequiredBlockingDeadLetterPartitions = Number(
      queueHealth?.actionRequiredBlockingDeadLetterPartitions ?? 0,
    );
    const actionRequiredDeadLetterScopes = queueHealth?.actionRequiredDeadLetterScopes ?? [];
    const actionRequiredBlockingDeadLetterScopes =
      queueHealth?.actionRequiredBlockingDeadLetterScopes ?? [];
    const campaignCompletedDays = Number(row.campaign_completed_days ?? 0);
    const searchTermCompletedDays = Number(row.search_term_completed_days ?? 0);
    const productCompletedDays = Number(row.product_completed_days ?? 0);
    const assetCompletedDays = Number(row.asset_completed_days ?? 0);
    const circuitBreakerOpen = Number(row.active_circuit_breakers ?? 0) > 0;
    const compactedPartitions = Number(row.compacted_partitions ?? 0);
    const quotaCallCount = Number(row.quota_call_count ?? 0);
    const quotaErrorCount = Number(row.quota_error_count ?? 0);
    const quotaBudget = Number(row.quota_budget ?? 0);
    const quotaPressure = Number(row.quota_pressure ?? 0);
    const recentRangeTotalDays = Math.max(1, Number(row.recent_range_total_days ?? 14));
    const recentSearchTermCompletedDays = Number(row.recent_search_term_completed_days ?? 0);
    const recentProductCompletedDays = Number(row.recent_product_completed_days ?? 0);
    const recentAssetCompletedDays = Number(row.recent_asset_completed_days ?? 0);
    const extendedRecentQueueDepth = Number(row.extended_recent_queue_depth ?? 0);
    const extendedRecentLeasedPartitions = Number(row.extended_recent_leased_partitions ?? 0);
    const extendedHistoricalQueueDepth = Number(row.extended_historical_queue_depth ?? 0);
    const extendedHistoricalLeasedPartitions = Number(row.extended_historical_leased_partitions ?? 0);
    const googleWorkerHealthy = Boolean(row.google_worker_healthy);
    const googleHeartbeatAgeMs =
      row.google_heartbeat_age_ms == null ? null : Number(row.google_heartbeat_age_ms);
    const googleRunnerLeaseActive = Boolean(row.google_runner_lease_active);
    const staleRunPressure = Number(row.stale_run_pressure ?? 0);
    const recoveryMode =
      circuitBreakerOpen
        ? "open"
        : Number(row.recovery_half_open ?? 0) > 0
        ? "half_open"
        : "closed";
    const safeModeActive =
      (process.env.GOOGLE_ADS_INCIDENT_SAFE_MODE?.trim().toLowerCase() ?? "") === "1" ||
      (process.env.GOOGLE_ADS_INCIDENT_SAFE_MODE?.trim().toLowerCase() ?? "") === "true";
    const effectiveMode =
      safeModeActive
        ? "safe_mode"
        : googleAdsGlobalReopenEnabled
          ? "global_reopen"
          : "global_backfill";
    const recentExtendedReady =
      recentSearchTermCompletedDays >= recentRangeTotalDays &&
      recentProductCompletedDays >= recentRangeTotalDays &&
      recentAssetCompletedDays >= recentRangeTotalDays;
    const historicalExtendedReady =
      searchTermCompletedDays >= 365 &&
      productCompletedDays >= 365 &&
      assetCompletedDays >= 365;
    const googleProgressHeartbeat =
      row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at ?? null;
    const extendedRecoveryBlockReason =
      circuitBreakerOpen
        ? "circuit_breaker_open"
        : extendedRecentQueueDepth > 0 && extendedRecentLeasedPartitions === 0 && queueDepth > 0
          ? "recent_extended_not_leasing"
          : extendedHistoricalQueueDepth > 0 && recoveryMode !== "closed"
            ? "historical_recovery_suspended"
            : null;
    const googleProgressEvidence = buildProviderProgressEvidence({
      checkpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
      recentActivityWindowMinutes: 20,
      aggregation: "latest",
    });
    const googleReclaimSummary = input.googleAdsReclaimSummaries?.[row.business_id] ?? {
      activeSlowPartitions: Math.max(
        0,
        leasedPartitions - Number(row.reclaim_candidate_count ?? 0),
      ),
      reclaimCandidateCount: Number(row.reclaim_candidate_count ?? 0),
      poisonCandidateCount: Number(row.poisoned_checkpoint_count ?? 0),
    };
    const googleIntegritySummary = input.googleAdsIntegritySummaries?.[row.business_id] ?? {
      incidentCount: 0,
      blockedCount: 0,
    };
    const googlePoisonCandidateCount =
      googleReclaimSummary.poisonCandidateCount ??
      Number(row.poisoned_checkpoint_count ?? 0);
    const googleCheckpointLagMinutes = computeLagMinutes(googleProgressHeartbeat);
    const quotaLimitedEvidence =
      googleQuotaLimitedBusinessIds.has(row.business_id) ||
      circuitBreakerOpen ||
      recoveryMode !== "closed" ||
      quotaPressure >= 0.85 ||
      quotaErrorCount > 0;

    const progressState = classifyGoogleAdsProgressState({
      queueDepth,
      leasedPartitions,
      deadLetterPartitions,
      checkpointLagMinutes: googleCheckpointLagMinutes,
      latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
      reclaimCandidateCount: googleReclaimSummary.reclaimCandidateCount,
      leaseConflictRuns24h: Number(row.lease_conflict_runs_24h ?? 0),
      poisonedCheckpointCount: googlePoisonCandidateCount,
      staleRunPressure,
      recentExtendedReady,
      historicalExtendedReady,
      latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
    });
    const stallFingerprints = deriveProviderStallFingerprints({
      queueDepth,
      leasedPartitions,
      checkpointLagMinutes: googleCheckpointLagMinutes,
      latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
      blocked:
        deadLetterPartitions > 0 ||
        googleReclaimSummary.reclaimCandidateCount > 0 ||
        Number(row.lease_conflict_runs_24h ?? 0) > 0 ||
        googlePoisonCandidateCount > 0,
      staleRunPressure,
      progressEvidence: googleProgressEvidence,
      blockedReasonCodes: deadLetterPartitions > 0 ? ["required_dead_letter_partitions"] : [],
      historicalBacklogDepth:
        extendedHistoricalQueueDepth + extendedHistoricalLeasedPartitions,
    });

    googleAdsBusinesses.push({
      businessId: row.business_id,
      businessName: row.business_name,
      queueDepth,
      leasedPartitions,
      deadLetterPartitions,
      actionRequiredDeadLetterPartitions,
      actionRequiredBlockingDeadLetterPartitions,
      actionRequiredDeadLetterScopes,
      actionRequiredBlockingDeadLetterScopes,
      oldestQueuedPartition: row.oldest_queued_partition,
      latestPartitionActivityAt: row.latest_partition_activity_at,
      campaignCompletedDays,
      searchTermCompletedDays,
      productCompletedDays,
      assetCompletedDays,
      latestCheckpointPhase: row.latest_checkpoint_phase ?? null,
      latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
      lastProgressHeartbeatAt: row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at ?? null,
      checkpointLagMinutes: googleCheckpointLagMinutes,
      lastSuccessfulPageIndex:
        row.last_successful_page_index == null ? null : Number(row.last_successful_page_index),
      resumeCapable:
        Boolean(row.latest_checkpoint_updated_at) &&
        googlePoisonCandidateCount === 0,
      checkpointFailures: Number(row.checkpoint_failures ?? 0),
      poisonedCheckpointCount: googlePoisonCandidateCount,
      activeSlowPartitions: googleReclaimSummary.activeSlowPartitions,
      reclaimCandidateCount: googleReclaimSummary.reclaimCandidateCount,
      skippedActiveLeaseRecoveries: Number(row.skipped_active_lease_recoveries ?? 0),
      lastReclaimReason: row.last_reclaim_reason ?? null,
      leaseConflictRuns24h: Number(row.lease_conflict_runs_24h ?? 0),
      latestPoisonReason: row.latest_poison_reason ?? null,
      latestPoisonedAt: row.latest_poisoned_at ?? null,
      safeModeActive,
      circuitBreakerOpen,
      compactedPartitions,
      quotaCallCount,
      quotaErrorCount,
      quotaBudget,
      quotaPressure,
      recoveryMode,
      effectiveMode,
      recentSearchTermCompletedDays,
      recentProductCompletedDays,
      recentAssetCompletedDays,
      recentRangeTotalDays,
      recentExtendedReady,
      historicalExtendedReady,
      extendedRecentQueueDepth,
      extendedRecentLeasedPartitions,
      extendedHistoricalQueueDepth,
      extendedHistoricalLeasedPartitions,
      extendedRecoveryBlockReason,
      extendedRecentReadyThroughDate: row.extended_recent_ready_through_date ?? null,
      googleWorkerHealthy,
      googleHeartbeatAgeMs,
      googleRunnerLeaseActive,
      staleRunPressure,
      integrityIncidentCount: googleIntegritySummary.incidentCount,
      integrityBlockedCount: googleIntegritySummary.blockedCount,
      progressState,
      stallFingerprints,
      quotaLimitedEvidence,
      campaignReadyThroughDate: row.campaign_ready_through_date ?? null,
      searchTermReadyThroughDate: row.search_term_ready_through_date ?? null,
      productReadyThroughDate: row.product_ready_through_date ?? null,
      assetReadyThroughDate: row.asset_ready_through_date ?? null,
    });

    if (
      (row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at) &&
      (!latestProgressHeartbeatAt ||
        new Date(String(row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at)).getTime() >
          new Date(latestProgressHeartbeatAt).getTime())
    ) {
      latestProgressHeartbeatAt = String(
        row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at
      );
    }

    googleAdsQueueDepth += queueDepth;
    googleAdsLeasedPartitions += leasedPartitions;
    googleAdsDeadLetterPartitions += deadLetterPartitions;
    googleAdsActionRequiredPartitions += actionRequiredDeadLetterPartitions;
    googleAdsActionRequiredBlockingPartitions += actionRequiredBlockingDeadLetterPartitions;
    for (const scope of actionRequiredDeadLetterScopes) {
      googleAdsActionRequiredScopes.add(scope);
    }
    for (const scope of actionRequiredBlockingDeadLetterScopes) {
      googleAdsActionRequiredBlockingScopes.add(scope);
    }
    if (actionRequiredDeadLetterPartitions > 0) {
      googleAdsActionRequiredBusinessCount += 1;
    }
    googleAdsCompactedPartitions += compactedPartitions;
    googleAdsSkippedActiveLeaseRecoveries += Number(row.skipped_active_lease_recoveries ?? 0);
    googleAdsLeaseConflictRuns24h += Number(row.lease_conflict_runs_24h ?? 0);
    googleAdsIntegrityIncidentCount += googleIntegritySummary.incidentCount;
    googleAdsIntegrityBlockedCount += googleIntegritySummary.blockedCount;
    stuckJobs += googleReclaimSummary.reclaimCandidateCount;
    if (circuitBreakerOpen) googleAdsCircuitBreakerBusinesses += 1;
    if (recoveryMode === "half_open") googleAdsRecoveryBusinesses += 1;
    googleAdsBudgetPressureMax = Math.max(googleAdsBudgetPressureMax, quotaPressure);
    if (
      row.oldest_queued_partition &&
      (!googleAdsOldestQueuedPartition ||
        new Date(row.oldest_queued_partition).getTime() <
          new Date(googleAdsOldestQueuedPartition).getTime())
    ) {
      googleAdsOldestQueuedPartition = row.oldest_queued_partition;
    }

    if (deadLetterPartitions > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads dead-letter partitions");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "queue_dead_letter",
        status: "failed",
        detail: `${deadLetterPartitions} Google Ads partition dead-letter durumunda.`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (actionRequiredDeadLetterPartitions > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads action required");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "account_action_required",
        severity: "critical",
        status: "failed",
        detail: `${actionRequiredDeadLetterPartitions} Google Ads partition requires reconnect or account access action. scopes=${actionRequiredDeadLetterScopes.join(", ") || "unknown"}.`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (queueDepth > 0 && leasedPartitions === 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads queue backlog");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "queue_backlog",
        status: "running",
        detail: `Google Ads queue backlog aktif. queued=${queueDepth}, campaign=${campaignCompletedDays}, search_terms=${searchTermCompletedDays}, products=${productCompletedDays}`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (
      googleProgressHeartbeat &&
      googleCheckpointLagMinutes != null &&
      googleCheckpointLagMinutes > 20 &&
      isLagOverWindow(row.latest_partition_activity_at ?? null, 20)
    ) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads stale checkpoints");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "stale_checkpoint",
        status: leasedPartitions > 0 ? "running" : "failed",
        detail: `Google Ads checkpoint progress has not moved recently. phase=${row.latest_checkpoint_phase ?? "unknown"}, lag=${googleCheckpointLagMinutes}m, page=${Number(row.last_successful_page_index ?? 0)}`,
        triggeredAt: googleProgressHeartbeat,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (
      leasedPartitions > 0 &&
      googleProgressHeartbeat &&
      (googleCheckpointLagMinutes ?? 0) > 8 &&
      (googleCheckpointLagMinutes ?? 0) <= 20
    ) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads alive-slow partitions");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "alive_slow",
        status: "running",
        detail: `Google Ads sync is still leased but progressing slowly. phase=${row.latest_checkpoint_phase ?? "unknown"}, lag=${googleCheckpointLagMinutes}m.`,
        triggeredAt: googleProgressHeartbeat,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (googlePoisonCandidateCount > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads poisoned checkpoints");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "poisoned_checkpoint",
        status: "failed",
        detail: `${googlePoisonCandidateCount} Google Ads checkpoints are marked as poison candidates and need review.`,
        triggeredAt:
          row.latest_poisoned_at ??
          row.latest_checkpoint_updated_at ??
          row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (googleReclaimSummary.reclaimCandidateCount > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads stalled reclaim candidates");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "stalled_reclaimable",
        status: "failed",
        detail: `${googleReclaimSummary.reclaimCandidateCount} active Google Ads reclaim candidate(s) detected and should be recovered.`,
        triggeredAt: row.latest_checkpoint_updated_at ?? row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (googleIntegritySummary.blockedCount > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads integrity blocked");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "integrity_blocked",
        status: "failed",
        detail: `${googleIntegritySummary.blockedCount} Google Ads integrity blocker(s) remain. account_daily must reconcile to campaign rollups before this business is considered healthy.`,
        triggeredAt:
          row.latest_progress_heartbeat_at ??
          row.latest_checkpoint_updated_at ??
          row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (Number(row.skipped_active_lease_recoveries ?? 0) > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads active-lease recovery skips");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "skipped_active_lease",
        status: "running",
        detail: `${Number(row.skipped_active_lease_recoveries ?? 0)} Google Ads recovery attempts were skipped because work was still actively leased in the last 24 hours.`,
        triggeredAt: row.latest_partition_activity_at ?? row.latest_checkpoint_updated_at ?? null,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (Number(row.lease_conflict_runs_24h ?? 0) > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads lease conflicts");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "lease_conflict_runs",
        status: "failed",
        detail: `${Number(row.lease_conflict_runs_24h ?? 0)} Google Ads runs lost partition ownership in the last 24 hours.`,
        triggeredAt: row.latest_partition_activity_at ?? row.latest_checkpoint_updated_at ?? null,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (circuitBreakerOpen) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Google Ads circuit breaker");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "google_ads",
        reportType: "google_ads_circuit_breaker",
        status: "cooldown",
        detail: "Google Ads circuit breaker is open; extended sync is suppressed for this business.",
        triggeredAt: row.latest_partition_activity_at,
        completedAt: null,
      });
    }
  }

  if ((input.googleAdsHealthStatus ?? "ok") !== "ok") {
    issueTypes.push("Google Ads health unavailable");
    if ((input.googleAdsHealth?.length ?? 0) === 0) {
      googleAdsQueueDepth =
        input.googleAdsHealthSummary?.queueDepth ?? googleAdsQueueDepth;
      googleAdsLeasedPartitions =
        input.googleAdsHealthSummary?.leasedPartitions ?? googleAdsLeasedPartitions;
      googleAdsDeadLetterPartitions =
        input.googleAdsHealthSummary?.deadLetterPartitions ?? googleAdsDeadLetterPartitions;
      googleAdsOldestQueuedPartition =
        input.googleAdsHealthSummary?.oldestQueuedPartition ?? googleAdsOldestQueuedPartition;
    }
  }

  for (const row of input.metaHealth ?? []) {
    const queueDepth = Number(row.queue_depth ?? 0);
    const leasedPartitions = Number(row.leased_partitions ?? 0);
    const retryableFailedPartitions = Number(row.retryable_failed_partitions ?? 0);
    const staleLeasePartitions = Number(row.stale_lease_partitions ?? 0);
    const deadLetterPartitions = Number(row.dead_letter_partitions ?? 0);
    const deadLetterRecovery = input.metaDeadLetterSummaries?.[row.business_id] ?? {
      total: deadLetterPartitions,
      replayableTransient: deadLetterPartitions,
      terminalActionRequired: 0,
      unknown: 0,
      latest: [],
    };
    const replayableDeadLetterPartitions = deadLetterRecovery.replayableTransient;
    const terminalActionRequiredDeadLetterPartitions = deadLetterRecovery.terminalActionRequired;
    const unknownDeadLetterPartitions = deadLetterRecovery.unknown;
    const stateRowCount = Number(row.state_row_count ?? 0);
    const todayAccountRows = Number(row.today_account_rows ?? 0);
    const todayAdsetRows = Number(row.today_adset_rows ?? 0);
    const accountCompletedDays = Number(row.account_completed_days ?? 0);
    const adsetCompletedDays = Number(row.adset_completed_days ?? 0);
    const creativeCompletedDays = Number(row.creative_completed_days ?? 0);
    const adCompletedDays = Number(row.ad_completed_days ?? 0);
    const recentRangeTotalDays = Math.max(1, Number(row.recent_range_total_days ?? 14));
    const recentAccountCompletedDays = Number(row.recent_account_completed_days ?? 0);
    const recentAdsetCompletedDays = Number(row.recent_adset_completed_days ?? 0);
    const recentCreativeCompletedDays = Number(row.recent_creative_completed_days ?? 0);
    const recentAdCompletedDays = Number(row.recent_ad_completed_days ?? 0);
    const recentExtendedReady =
      recentCreativeCompletedDays >= recentRangeTotalDays &&
      recentAdCompletedDays >= recentRangeTotalDays;
    const historicalExtendedReady =
      creativeCompletedDays >= META_CREATIVE_WAREHOUSE_HISTORY_DAYS &&
      adCompletedDays >= 365;
    const metaProgressHeartbeat =
      row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at ?? null;
    const effectiveMode =
      !recentExtendedReady ? "core_only" : historicalExtendedReady ? "extended_normal" : "extended_recovery";
    const metaProgressEvidence = buildAdminMetaProgressEvidence({
      accountCompletedDays,
      accountReadyThroughDate: row.account_ready_through_date ?? null,
      adsetCompletedDays,
      adsetReadyThroughDate: row.adset_ready_through_date ?? null,
      creativeCompletedDays,
      creativeReadyThroughDate: row.creative_ready_through_date ?? null,
      adCompletedDays,
      adReadyThroughDate: row.ad_ready_through_date ?? null,
      latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
      latestProgressHeartbeatAt: row.latest_progress_heartbeat_at ?? null,
      latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
    });
    const metaReclaimSummary = input.metaReclaimSummaries?.[row.business_id] ?? {
      activeSlowPartitions: Math.max(
        0,
        leasedPartitions - Number(row.reclaim_candidate_count ?? 0),
      ),
      reclaimCandidateCount: Number(row.reclaim_candidate_count ?? 0),
    };
    const metaIntegritySummary = input.metaIntegritySummaries?.[row.business_id] ?? {
      incidentCount: 0,
      blockedCount: 0,
    };
    const d1FinalizeNonTerminalCount =
      metaSnapshotsByBusiness.get(row.business_id)?.d1FinalizeSla?.breachedAccounts ??
      input.metaD1FinalizeNonTerminalCounts?.[row.business_id] ??
      0;
    const quotaLimitedEvidence = metaQuotaLimitedBusinessIds.has(row.business_id);
    const metaWorkerObservation = getProviderBusinessWorkerObservation({
      businessId: row.business_id,
      workers: input.workerHealth?.workers,
      staleThresholdMs: 3 * 60_000,
    });
    const metaWorkerHealthy =
      metaProviderWorkerObservation.hasFreshHeartbeat || leasedPartitions > 0;
    const metaCheckpointLagMinutes = computeLagMinutes(metaProgressHeartbeat);
    const progressState = classifyMetaProgressState({
      queueDepth,
      leasedPartitions,
      deadLetterPartitions,
      retryableFailedPartitions,
      staleLeasePartitions,
      checkpointLagMinutes: metaCheckpointLagMinutes,
      latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
      reclaimCandidateCount: metaReclaimSummary.reclaimCandidateCount,
      staleRunCount24h: Number(row.stale_run_count_24h ?? 0),
      recentExtendedReady,
      historicalExtendedReady,
      latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
    });
    const stallFingerprints = deriveProviderStallFingerprints({
      queueDepth,
      leasedPartitions,
      checkpointLagMinutes: metaCheckpointLagMinutes,
      latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
      blocked:
        deadLetterPartitions > 0 ||
        staleLeasePartitions > 0 ||
        metaReclaimSummary.reclaimCandidateCount > 0,
      hasRepairableBacklog: retryableFailedPartitions > 0,
      staleRunPressure: Number(row.stale_run_count_24h ?? 0),
      progressEvidence: metaProgressEvidence,
      blockedReasonCodes:
        terminalActionRequiredDeadLetterPartitions > 0
          ? ["account_action_required"]
          : deadLetterPartitions > 0
            ? ["required_dead_letter_partitions"]
            : [],
      historicalBacklogDepth: queueDepth,
      workerHealthy: metaWorkerHealthy,
    });
    const activityState = deriveProviderActivityState({
      progressState,
      queueDepth,
      leasedPartitions,
      blocked:
        deadLetterPartitions > 0 ||
        staleLeasePartitions > 0 ||
        metaReclaimSummary.reclaimCandidateCount > 0,
    });
    const lagMetrics = buildSyncLagMetrics(
      metaSnapshotsByBusiness.get(row.business_id)?.latestPublishes?.[0] ?? null,
    );
    const unifiedTruth = deriveUnifiedSyncTruth({
      activityState,
      progressState,
      workerOnline: metaProviderWorkerObservation.hasFreshHeartbeat,
      queueDepth,
      leasedPartitions,
      releaseGateVerdict: input.releaseGate?.verdict ?? null,
      runtimeContractValid,
    });

    metaBusinesses.push({
      businessId: row.business_id,
      businessName: row.business_name,
      queueDepth,
      leasedPartitions,
      retryableFailedPartitions,
      staleLeasePartitions,
      deadLetterPartitions,
      replayableDeadLetterPartitions,
      terminalActionRequiredDeadLetterPartitions,
      unknownDeadLetterPartitions,
      deadLetterRecovery,
      stateRowCount,
      todayAccountRows,
      todayAdsetRows,
      currentDayReference: row.current_day_reference,
      oldestQueuedPartition: row.oldest_queued_partition,
      latestPartitionActivityAt: row.latest_partition_activity_at,
      accountCompletedDays,
      adsetCompletedDays,
      creativeCompletedDays,
      effectiveMode,
      latestCheckpointScope: row.latest_checkpoint_scope,
      latestCheckpointPhase: row.latest_checkpoint_phase,
      latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at,
      lastProgressHeartbeatAt: row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at,
      checkpointLagMinutes: metaCheckpointLagMinutes,
      lastSuccessfulPageIndex:
        row.last_successful_page_index == null ? null : Number(row.last_successful_page_index),
      resumeCapable: Boolean(row.latest_checkpoint_updated_at),
      checkpointFailures: Number(row.checkpoint_failures ?? 0),
      activeSlowPartitions: metaReclaimSummary.activeSlowPartitions,
      reclaimCandidateCount: metaReclaimSummary.reclaimCandidateCount,
      skippedActiveLeaseRecoveries: Number(row.skipped_active_lease_recoveries ?? 0),
      lastReclaimReason: row.last_reclaim_reason ?? null,
      staleRunCount24h: Number(row.stale_run_count_24h ?? 0),
      recentAccountCompletedDays,
      recentAdsetCompletedDays,
      recentCreativeCompletedDays,
      recentAdCompletedDays,
      recentRangeTotalDays,
      recentExtendedReady,
      historicalExtendedReady,
      progressState,
      activityState,
      syncTruthState: unifiedTruth.syncTruthState,
      blockerClass: unifiedTruth.blockerClass === "none" ? null : unifiedTruth.blockerClass,
      progressEvidence: metaProgressEvidence,
      stallFingerprints,
      workerOnline: metaProviderWorkerObservation.hasFreshHeartbeat,
      workerLastHeartbeatAt:
        metaProviderWorkerObservation.lastHeartbeatAt ?? metaWorkerObservation.lastHeartbeatAt,
      workerFreshnessState: metaWorkerObservation.workerFreshnessState,
      workerId: metaWorkerObservation.workerId,
      workerConsumeStage: metaWorkerObservation.consumeStage,
      sourceManifestCounts: metaSnapshotsByBusiness.get(row.business_id)?.manifestCounts,
      latestAuthoritativePublishes: metaSnapshotsByBusiness.get(row.business_id)?.latestPublishes ?? [],
      d1FinalizeSla: metaSnapshotsByBusiness.get(row.business_id)?.d1FinalizeSla,
      validationFailures24h: metaSnapshotsByBusiness.get(row.business_id)?.validationFailures24h ?? 0,
      recentFailures: metaSnapshotsByBusiness.get(row.business_id)?.recentFailures ?? [],
      repairBacklog: metaSnapshotsByBusiness.get(row.business_id)?.progression.repairBacklog ?? 0,
      queuedVsLeasedVsPublished: metaSnapshotsByBusiness.get(row.business_id)?.progression,
      lastSuccessfulPublishAt:
        metaSnapshotsByBusiness.get(row.business_id)?.lastSuccessfulPublishAt ?? null,
      integrityIncidentCount: metaIntegritySummary.incidentCount,
      integrityBlockedCount: metaIntegritySummary.blockedCount,
      d1FinalizeNonTerminalCount,
      quotaLimitedEvidence,
      accountReadyThroughDate: row.account_ready_through_date ?? null,
      adsetReadyThroughDate: row.adset_ready_through_date ?? null,
      creativeReadyThroughDate: row.creative_ready_through_date ?? null,
      adReadyThroughDate: row.ad_ready_through_date ?? null,
      phaseTimings:
        (metaPhaseTimingSummariesByBusiness[row.business_id]?.length ?? 0) > 0
          ? {
              windowHours: metaPhaseTimingWindowHours,
              phases: metaPhaseTimingSummariesByBusiness[row.business_id] ?? [],
            }
          : null,
      lagMetrics,
      latestRemediationExecution:
        input.latestRepairExecutionsByBusiness?.[row.business_id] ?? null,
    });

    if (
      (row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at) &&
      (!latestProgressHeartbeatAt ||
        new Date(String(row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at)).getTime() >
          new Date(latestProgressHeartbeatAt).getTime())
    ) {
      latestProgressHeartbeatAt = String(
        row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at
      );
    }

    metaQueueDepth += queueDepth;
    metaLeasedPartitions += leasedPartitions;
    metaDeadLetterPartitions += deadLetterPartitions;
    metaSourceManifestCount += metaSnapshotsByBusiness.get(row.business_id)?.manifestCounts.total ?? 0;
    metaPublishedProgression += metaSnapshotsByBusiness.get(row.business_id)?.progression.published ?? 0;
    metaValidationFailures24h += metaSnapshotsByBusiness.get(row.business_id)?.validationFailures24h ?? 0;
    metaRepairBacklog += metaSnapshotsByBusiness.get(row.business_id)?.progression.repairBacklog ?? 0;
    metaStaleLeasePartitions += metaSnapshotsByBusiness.get(row.business_id)?.progression.staleLeases ?? 0;
    metaD1FinalizeSlaBreaches += metaSnapshotsByBusiness.get(row.business_id)?.d1FinalizeSla.breachedAccounts ?? 0;
    metaIntegrityIncidentCount += metaIntegritySummary.incidentCount;
    metaIntegrityBlockedCount += metaIntegritySummary.blockedCount;
    metaD1FinalizeNonTerminalCount += d1FinalizeNonTerminalCount;
    stuckJobs += metaReclaimSummary.reclaimCandidateCount;
    const snapshotPublishAt = metaSnapshotsByBusiness.get(row.business_id)?.lastSuccessfulPublishAt ?? null;
    if (
      snapshotPublishAt &&
      (!metaLastSuccessfulPublishAt ||
        snapshotPublishAt.localeCompare(metaLastSuccessfulPublishAt) > 0)
    ) {
      metaLastSuccessfulPublishAt = snapshotPublishAt;
    }
    if (
      row.oldest_queued_partition &&
      (!metaOldestQueuedPartition ||
        new Date(row.oldest_queued_partition).getTime() <
          new Date(metaOldestQueuedPartition).getTime())
    ) {
      metaOldestQueuedPartition = row.oldest_queued_partition;
    }
    metaSkippedActiveLeaseRecoveries += Number(row.skipped_active_lease_recoveries ?? 0);
    metaStaleRunCount24h += Number(row.stale_run_count_24h ?? 0);

    if (deadLetterPartitions > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push(
        terminalActionRequiredDeadLetterPartitions > 0
          ? "Meta account action required"
          : "Meta dead-letter partitions",
      );
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType:
          terminalActionRequiredDeadLetterPartitions > 0
            ? "account_action_required"
            : "queue_dead_letter",
        status: "failed",
        detail:
          terminalActionRequiredDeadLetterPartitions > 0
            ? `${terminalActionRequiredDeadLetterPartitions} Meta partition requires Facebook/Meta login or reconnect. replayable=${replayableDeadLetterPartitions}, unknown=${unknownDeadLetterPartitions}.`
            : `${deadLetterPartitions} Meta partition dead-letter durumunda. replayable=${replayableDeadLetterPartitions}, unknown=${unknownDeadLetterPartitions}.`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (stateRowCount === 0 && (queueDepth > 0 || leasedPartitions > 0 || deadLetterPartitions > 0)) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta state missing");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "state_missing",
        status: "failed",
        detail: `Meta sync state rows are missing. queue=${queueDepth}, leased=${leasedPartitions}, dead=${deadLetterPartitions}`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (staleLeasePartitions > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta stale leases");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "stale_lease",
        status: "running",
        detail: `${staleLeasePartitions} Meta partitions look stuck in leased/running state and may need cleanup.`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (
      row.latest_checkpoint_updated_at &&
      metaCheckpointLagMinutes != null &&
      metaCheckpointLagMinutes > 20 &&
      isLagOverWindow(row.latest_partition_activity_at ?? null, 20)
    ) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta stale checkpoints");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "stale_checkpoint",
        status: leasedPartitions > 0 ? "running" : "failed",
        detail: `Meta checkpoint progress has not moved recently. phase=${row.latest_checkpoint_phase ?? "unknown"}, lag=${metaCheckpointLagMinutes}m, page=${Number(row.last_successful_page_index ?? 0)}`,
        triggeredAt: row.latest_checkpoint_updated_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (retryableFailedPartitions > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta retryable failed backlog");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "retryable_failed_backlog",
        status: leasedPartitions > 0 ? "running" : "failed",
        detail: `${retryableFailedPartitions} Meta partitions failed but are still retryable and should be re-queued automatically.`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (queueDepth > 0 && leasedPartitions === 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta queue backlog");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "queue_backlog",
        status: "running",
        detail: `Meta queue backlog aktif. queued=${queueDepth}, account=${accountCompletedDays}, adsets=${adsetCompletedDays}, creatives=${creativeCompletedDays}`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
      if (!row.latest_partition_activity_at || Date.now() - new Date(row.latest_partition_activity_at).getTime() > 15 * 60 * 1000) {
        issueTypes.push(
          metaProviderWorkerObservation.hasFreshHeartbeat
            ? "Meta queue not leasing despite fresh worker heartbeat"
            : "Meta worker unavailable"
        );
        issues.push({
          businessId: row.business_id,
          businessName: row.business_name,
          provider: "meta",
          reportType: "queue_waiting_worker",
          status: "running",
          detail: metaProviderWorkerObservation.hasFreshHeartbeat
            ? `Meta queue has items but this business is not acquiring a lease despite fresh Meta worker availability. queued=${queueDepth}, leased=${leasedPartitions}, provider_heartbeat=${metaProviderWorkerObservation.lastHeartbeatAt ?? "none"}, matched_worker=${metaWorkerObservation.workerId ?? "none"}, matched_heartbeat=${metaWorkerObservation.lastHeartbeatAt ?? "none"}, stage=${metaWorkerObservation.consumeStage ?? "unknown"}, latest_activity=${row.latest_partition_activity_at ?? "none"}`
            : `Meta queue has items but no fresh Meta worker heartbeat or runner lease is visible for this business. queued=${queueDepth}, leased=${leasedPartitions}, matched_worker=${metaWorkerObservation.workerId ?? "none"}, matched_heartbeat=${metaWorkerObservation.lastHeartbeatAt ?? "none"}, latest_activity=${row.latest_partition_activity_at ?? "none"}`,
          triggeredAt: row.latest_partition_activity_at,
          completedAt: row.oldest_queued_partition,
        });
      }
    }

    if (
      row.current_day_reference &&
      (todayAccountRows === 0 || todayAdsetRows === 0) &&
      queueDepth > 0
    ) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta current day missing");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "current_day_missing",
        status: leasedPartitions > 0 ? "running" : "failed",
        detail: `Meta current-day warehouse rows are missing. reference_day=${row.current_day_reference ?? "unknown"}, today_account_rows=${todayAccountRows}, today_adset_rows=${todayAdsetRows}, queue=${queueDepth}, leased=${leasedPartitions}`,
        triggeredAt: row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (
      leasedPartitions > 0 &&
      metaProgressHeartbeat &&
      (metaCheckpointLagMinutes ?? 0) > 8 &&
      (metaCheckpointLagMinutes ?? 0) <= 20
    ) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta alive-slow partitions");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "alive_slow",
        status: "running",
        detail: `Meta sync is still leased but progressing slowly. phase=${row.latest_checkpoint_phase ?? "unknown"}, lag=${metaCheckpointLagMinutes}m.`,
        triggeredAt: metaProgressHeartbeat,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (metaReclaimSummary.reclaimCandidateCount > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta stalled reclaim candidates");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "stalled_reclaimable",
        status: "failed",
        detail: `${metaReclaimSummary.reclaimCandidateCount} active Meta reclaim candidate(s) detected and should be recovered.`,
        triggeredAt: row.latest_checkpoint_updated_at ?? row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (Number(row.skipped_active_lease_recoveries ?? 0) > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta active-lease recovery skips");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "skipped_active_lease",
        status: "running",
        detail: `${Number(row.skipped_active_lease_recoveries ?? 0)} Meta recovery attempts were skipped because work was still actively leased in the last 24 hours.`,
        triggeredAt: row.latest_partition_activity_at ?? row.latest_checkpoint_updated_at ?? null,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (Number(row.stale_run_count_24h ?? 0) > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta stale runs");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "stale_runs",
        status: "failed",
        detail: `${Number(row.stale_run_count_24h ?? 0)} Meta runs were auto-closed as stale in the last 24 hours.`,
        triggeredAt: row.latest_partition_activity_at ?? row.latest_checkpoint_updated_at ?? null,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (metaIntegritySummary.blockedCount > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta integrity blocked");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "integrity_blocked",
        status: "failed",
        detail: `${metaIntegritySummary.blockedCount} Meta canonical integrity blocker(s) remain. Finalized account truth is publishing, but repeated drift still requires manual resolution.`,
        triggeredAt:
          row.latest_progress_heartbeat_at ??
          row.latest_checkpoint_updated_at ??
          row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }

    if (d1FinalizeNonTerminalCount > 0) {
      impactedBusinesses.add(row.business_id);
      issueTypes.push("Meta D-1 finalize nonterminal");
      issues.push({
        businessId: row.business_id,
        businessName: row.business_name,
        provider: "meta",
        reportType: "d1_finalize_nonterminal",
        status: leasedPartitions > 0 ? "running" : "failed",
        detail: `${d1FinalizeNonTerminalCount} Meta D-1 finalize_day partition(s) are still nonterminal and should be recovered before the business is considered fully healthy.`,
        triggeredAt:
          row.latest_progress_heartbeat_at ??
          row.latest_checkpoint_updated_at ??
          row.latest_partition_activity_at,
        completedAt: row.oldest_queued_partition,
      });
    }
  }

  if ((input.workerHealth?.onlineWorkers ?? 0) === 0) {
    for (const row of [...googleAdsBusinesses, ...metaBusinesses]) {
      if ((row.leasedPartitions ?? 0) > 0) {
        impactedBusinesses.add(row.businessId);
        issueTypes.push("Worker offline with leased partitions");
        issues.push({
          businessId: row.businessId,
          businessName: row.businessName,
          provider: "latestCheckpointScope" in row ? "meta" : "google_ads",
          reportType: "worker_offline_with_leased_partitions",
          status: "failed",
          detail: "No worker heartbeat is active while partitions remain leased.",
          triggeredAt: row.latestPartitionActivityAt,
          completedAt: row.oldestQueuedPartition,
        });
      }
    }
  }

  const normalizedIssues = issues
    .map((issue) => ({
      ...issue,
      severity: getSyncIssueSeverity(issue),
      runbookKey: getSyncIssueRunbookKey(issue),
    }))
    .sort((a, b) => {
      const severityRank = { critical: 3, high: 2, medium: 1 } as const;
      const severityDiff = severityRank[b.severity] - severityRank[a.severity];
      if (severityDiff !== 0) return severityDiff;
      const left = a.triggeredAt ? new Date(a.triggeredAt).getTime() : 0;
      const right = b.triggeredAt ? new Date(b.triggeredAt).getTime() : 0;
      return right - left;
    });

  const dbDiagnostics = buildAdminDbDiagnostics({
    web: input.webDbDiagnostics ?? null,
    workers: buildWorkerDbProcessDiagnostics(
      (input.workerHealth?.workers ?? []).map((worker) => ({
        workerId: worker.workerId,
        providerScope: worker.providerScope,
        status: worker.status,
        lastHeartbeatAt: worker.lastHeartbeatAt,
        metaJson: worker.metaJson ?? null,
      })),
    ),
    metaQueueDepth,
    metaLeasedPartitions,
    metaBusinesses,
  });
  const summaryTruth = deriveUnifiedSyncTruth({
    activityState:
      metaBusinesses.some((business) => business.activityState === "blocked")
        ? "blocked"
        : metaBusinesses.some((business) => business.activityState === "stalled")
          ? "stalled"
          : metaBusinesses.some((business) => business.activityState === "busy")
            ? "busy"
            : metaBusinesses.some((business) => business.activityState === "waiting")
              ? "waiting"
              : "ready",
    progressState:
      metaBusinesses.some((business) => business.progressState === "blocked")
        ? "blocked"
        : metaBusinesses.some((business) => business.progressState === "partial_stuck")
          ? "partial_stuck"
          : metaBusinesses.some((business) => business.progressState === "syncing")
            ? "syncing"
            : metaBusinesses.some((business) => business.progressState === "partial_progressing")
              ? "partial_progressing"
              : "ready",
    workerOnline: (input.workerHealth?.onlineWorkers ?? 0) > 0,
    queueDepth: metaQueueDepth,
    leasedPartitions: metaLeasedPartitions,
    releaseGateVerdict: input.releaseGate?.verdict ?? null,
    runtimeContractValid,
  });
  const effectiveGoogleAdsHealthStatus =
    (input.googleAdsHealthStatus ?? "ok") === "ok" &&
    googleAdsActionRequiredBusinessCount > 0
      ? "degraded"
      : input.googleAdsHealthStatus ?? "ok";
  const sortedGoogleAdsActionRequiredScopes = Array.from(
    googleAdsActionRequiredScopes,
  ).sort();
  const sortedGoogleAdsActionRequiredBlockingScopes = Array.from(
    googleAdsActionRequiredBlockingScopes,
  ).sort();

  return {
    runtimeContract: input.runtimeContract ?? null,
    runtimeRegistry: input.runtimeRegistry ?? null,
    deployGate: input.deployGate ?? null,
    releaseGate: input.releaseGate ?? null,
    repairPlan: input.repairPlan ?? null,
    remediationSummary: input.remediationSummary ?? null,
    googleAdsHealthStatus: effectiveGoogleAdsHealthStatus,
    googleAdsHealthError: input.googleAdsHealthError ?? null,
    dbDiagnostics,
    summary: {
      impactedBusinesses: impactedBusinesses.size,
      runningJobs,
      stuckJobs,
      failedJobs24h,
      activeCooldowns,
      successJobs24h,
      topIssue: getTopIssue(issueTypes),
      googleAdsQueueDepth,
      googleAdsLeasedPartitions,
      googleAdsDeadLetterPartitions,
      googleAdsActionRequiredBusinessCount,
      googleAdsActionRequiredPartitions,
      googleAdsActionRequiredBlockingPartitions,
      googleAdsActionRequiredScopes: sortedGoogleAdsActionRequiredScopes,
      googleAdsActionRequiredBlockingScopes:
        sortedGoogleAdsActionRequiredBlockingScopes,
      googleAdsOldestQueuedPartition,
      metaQueueDepth,
      metaLeasedPartitions,
      metaDeadLetterPartitions,
      metaOldestQueuedPartition,
      metaSourceManifestCount,
      metaPublishedProgression,
      metaValidationFailures24h,
      metaRepairBacklog,
      metaStaleLeasePartitions,
      metaLastSuccessfulPublishAt,
      metaD1FinalizeSlaBreaches,
      workerOnline: (input.workerHealth?.onlineWorkers ?? 0) > 0,
      workerInstances: input.workerHealth?.workerInstances ?? 0,
      workerLastHeartbeatAt: input.workerHealth?.lastHeartbeatAt ?? null,
      workerLastProgressHeartbeatAt: latestProgressHeartbeatAt,
      googleAdsSafeModeActive:
        (process.env.GOOGLE_ADS_INCIDENT_SAFE_MODE?.trim().toLowerCase() ?? "") === "1" ||
        (process.env.GOOGLE_ADS_INCIDENT_SAFE_MODE?.trim().toLowerCase() ?? "") === "true",
      googleAdsCircuitBreakerBusinesses,
      googleAdsCompactedPartitions,
      googleAdsBudgetPressureMax,
      googleAdsRecoveryBusinesses,
      googleAdsGlobalReopenEnabled,
      googleAdsSkippedActiveLeaseRecoveries,
      googleAdsLeaseConflictRuns24h,
      googleAdsIntegrityIncidentCount,
      googleAdsIntegrityBlockedCount,
      metaSkippedActiveLeaseRecoveries,
      metaStaleRunCount24h,
      metaIntegrityIncidentCount,
      metaIntegrityBlockedCount,
      metaD1FinalizeNonTerminalCount,
      syncTruthState: summaryTruth.syncTruthState,
      blockerClass: summaryTruth.blockerClass === "none" ? null : summaryTruth.blockerClass,
    },
    issues: normalizedIssues,
    workerHealth: input.workerHealth,
    googleAdsBusinesses: googleAdsBusinesses.sort((a, b) => {
      if (b.deadLetterPartitions !== a.deadLetterPartitions) {
        return b.deadLetterPartitions - a.deadLetterPartitions;
      }
      if (b.queueDepth !== a.queueDepth) {
        return b.queueDepth - a.queueDepth;
      }
      return a.businessName.localeCompare(b.businessName);
    }),
    metaBusinesses: metaBusinesses.sort((a, b) => {
      if (b.deadLetterPartitions !== a.deadLetterPartitions) {
        return b.deadLetterPartitions - a.deadLetterPartitions;
      }
      if (b.queueDepth !== a.queueDepth) {
        return b.queueDepth - a.queueDepth;
      }
      return a.businessName.localeCompare(b.businessName);
    }),
  };
}

export function buildAdminRevenueRisk(input: {
  workspaces: RawRevenueWorkspaceRow[];
  subscriptions: RawRevenueSubscriptionRow[];
}): AdminRevenueRiskPayload {
  const unsubscribedBusinesses = input.workspaces
    .filter((row) => {
      const createdAtMs = new Date(row.created_at).getTime();
      return Number.isFinite(createdAtMs) &&
        createdAtMs <= Date.now() - 7 * 24 * 60 * 60_000 &&
        !row.has_active_subscription;
    })
    .map((row) => ({
      businessId: row.business_id,
      businessName: row.business_name,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      createdAt: row.created_at,
      connectedIntegrations: Number(row.connected_integrations ?? 0),
      reason: "No active subscription",
    }));

  const subscriptionIssues = input.subscriptions
    .filter((row) => row.status !== "active")
    .map((row) => ({
      businessId: row.business_id,
      businessName: row.business_name,
      ownerName: row.owner_name,
      ownerEmail: row.owner_email,
      planId: row.plan_id,
      status: row.status,
      updatedAt: row.updated_at,
    }));

  const statusCounts = new Map<string, number>();
  let activeSubscriptions = 0;
  for (const row of input.subscriptions) {
    statusCounts.set(row.status, (statusCounts.get(row.status) ?? 0) + 1);
    if (row.status === "active") activeSubscriptions++;
  }

  const nonActiveSubscriptions = subscriptionIssues.length;
  const atRiskBusinesses = new Set([
    ...unsubscribedBusinesses.map((row) => row.businessId),
    ...subscriptionIssues.map((row) => row.businessId).filter(Boolean) as string[],
  ]).size;

  const issueTypes = [
    ...unsubscribedBusinesses.map(() => "No active subscription"),
    ...subscriptionIssues.map((row) => `Subscription ${row.status}`),
  ];

  return {
    summary: {
      atRiskBusinesses,
      activeSubscriptions,
      nonActiveSubscriptions,
      unsubscribedBusinesses: unsubscribedBusinesses.length,
      topIssue: getTopIssue(issueTypes),
    },
    unsubscribedBusinesses: unsubscribedBusinesses.sort(
      (a, b) => b.connectedIntegrations - a.connectedIntegrations
    ),
    subscriptionIssues: subscriptionIssues.sort(
      (a, b) => new Date(b.updatedAt).getTime() - new Date(a.updatedAt).getTime()
    ),
    statusBreakdown: Array.from(statusCounts.entries())
      .map(([status, count]) => ({ status, count }))
      .sort((a, b) => b.count - a.count),
  };
}

async function readAuthRows() {
  const sql = getDb();
  return (await sql`
    SELECT
      pc.business_id,
      b.name AS business_name,
      pc.provider,
      pc.status,
      ic.refresh_token,
      ic.token_expires_at,
      ic.scopes,
      ic.error_message,
      pc.updated_at
    FROM provider_connections pc
    LEFT JOIN integration_credentials ic
      ON ic.provider_connection_id = pc.id
    JOIN businesses b ON b.id::text = pc.business_id
    WHERE pc.provider IN ('meta', 'google', 'search_console', 'ga4', 'shopify')
      AND pc.status <> 'disconnected'
  `) as RawAuthIntegrationRow[];
}

async function readSyncJobs() {
  const sql = getDb();
  return (await sql`
    SELECT
      j.business_id,
      b.name AS business_name,
      j.provider,
      j.report_type,
      j.status,
      j.error_message,
      j.triggered_at,
      j.started_at,
      j.completed_at
    FROM provider_sync_jobs j
    JOIN businesses b ON b.id::text = j.business_id
    WHERE j.provider IN ('google_ads', 'ga4', 'search_console')
      AND j.triggered_at > now() - interval '7 days'
  `) as RawSyncJobRow[];
}

async function readActiveCooldowns() {
  const sql = getDb();
  return (await sql`
    SELECT
      c.business_id,
      b.name AS business_name,
      CASE WHEN c.provider = 'google' THEN 'google_ads' ELSE c.provider END AS provider,
      c.request_type,
      c.error_message,
      c.cooldown_until,
      c.updated_at
    FROM provider_cooldown_state c
    JOIN businesses b ON b.id::text = c.business_id
    WHERE c.provider IN ('google', 'google_ads', 'ga4', 'search_console')
      AND c.cooldown_until > now()
  `) as RawCooldownRow[];
}

async function readGoogleAdsHealthRows() {
  const sql = getDbWithTimeout(30_000);
  return (await sql`
    WITH partition_stats AS (
      SELECT
        business_id,
        COUNT(*) FILTER (WHERE status = 'queued') AS queue_depth,
        COUNT(*) FILTER (WHERE status IN ('leased', 'running')) AS leased_partitions,
        COUNT(*) FILTER (
          WHERE status IN ('leased', 'running')
            AND updated_at < now() - interval '15 minutes'
        ) AS stale_lease_partitions,
        COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_partitions,
        MIN(partition_date) FILTER (WHERE status = 'queued') AS oldest_queued_partition,
        MAX(updated_at) AS latest_partition_activity_at,
        COUNT(*) FILTER (
          WHERE lane = 'extended'
            AND status = 'cancelled'
            AND last_error LIKE 'google_ads_incident_suppressed:%'
        ) AS compacted_partitions,
        COUNT(*) FILTER (
          WHERE lane = 'extended'
            AND (
              source IN ('selected_range', 'today', 'recent', 'recent_recovery')
              OR (
                source = 'core_success'
                AND partition_date >= CURRENT_DATE - interval '13 days'
              )
            )
            AND status = 'queued'
        ) AS extended_recent_queue_depth,
        COUNT(*) FILTER (
          WHERE lane = 'extended'
            AND (
              source IN ('selected_range', 'today', 'recent', 'recent_recovery')
              OR (
                source = 'core_success'
                AND partition_date >= CURRENT_DATE - interval '13 days'
              )
            )
            AND status IN ('leased', 'running')
        ) AS extended_recent_leased_partitions,
        COUNT(*) FILTER (
          WHERE lane = 'extended'
            AND (
              source IN ('historical', 'historical_recovery')
              OR (
                source = 'core_success'
                AND partition_date < CURRENT_DATE - interval '13 days'
              )
            )
            AND status = 'queued'
        ) AS extended_historical_queue_depth,
        COUNT(*) FILTER (
          WHERE lane = 'extended'
            AND (
              source IN ('historical', 'historical_recovery')
              OR (
                source = 'core_success'
                AND partition_date < CURRENT_DATE - interval '13 days'
              )
            )
            AND status IN ('leased', 'running')
        ) AS extended_historical_leased_partitions
      FROM google_ads_sync_partitions
      GROUP BY business_id
    ),
    state_stats AS (
      SELECT
        business_id,
        COUNT(DISTINCT CONCAT(provider_account_id, ':', scope)) AS state_row_count,
        MAX(completed_days) FILTER (WHERE scope = 'campaign_daily') AS campaign_completed_days,
        MAX(dead_letter_count) FILTER (WHERE scope = 'campaign_daily') AS campaign_dead_letter_count,
        (MIN(ready_through_date) FILTER (WHERE scope = 'campaign_daily'))::text AS campaign_ready_through_date,
        MAX(completed_days) FILTER (WHERE scope = 'search_term_daily') AS search_term_completed_days,
        (MIN(ready_through_date) FILTER (WHERE scope = 'search_term_daily'))::text AS search_term_ready_through_date,
        MAX(completed_days) FILTER (WHERE scope = 'product_daily') AS product_completed_days,
        (MIN(ready_through_date) FILTER (WHERE scope = 'product_daily'))::text AS product_ready_through_date,
        MAX(completed_days) FILTER (WHERE scope = 'asset_daily') AS asset_completed_days,
        (MIN(ready_through_date) FILTER (WHERE scope = 'asset_daily'))::text AS asset_ready_through_date
      FROM google_ads_sync_state
      GROUP BY business_id
    ),
    recent_search_days AS (
      SELECT business_id, date
      FROM google_ads_search_query_hot_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
      GROUP BY business_id, date
      UNION
      SELECT business_id, date
      FROM google_ads_search_cluster_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
      GROUP BY business_id, date
    ),
    recent_search AS (
      SELECT business_id, COUNT(*) AS recent_search_term_completed_days
      FROM recent_search_days
      GROUP BY business_id
    ),
    recent_product AS (
      SELECT business_id, COUNT(DISTINCT date) AS recent_product_completed_days
      FROM google_ads_product_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
      GROUP BY business_id
    ),
    recent_asset AS (
      SELECT business_id, COUNT(DISTINCT date) AS recent_asset_completed_days
      FROM google_ads_asset_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
      GROUP BY business_id
    ),
    recent_ready AS (
      SELECT business_id, MIN(date)::text AS extended_recent_ready_through_date
      FROM (
        SELECT business_id, date
        FROM recent_search_days
        UNION ALL
        SELECT business_id, date
        FROM google_ads_product_daily
        WHERE date >= CURRENT_DATE - interval '13 days'
        UNION ALL
        SELECT business_id, date
        FROM google_ads_asset_daily
        WHERE date >= CURRENT_DATE - interval '13 days'
      ) recent_rows
      GROUP BY business_id
    ),
    active_checkpoint_latest AS (
      SELECT DISTINCT ON (partition.business_id, checkpoint.partition_id)
        partition.business_id,
        checkpoint.partition_id,
        checkpoint.phase,
        COALESCE(checkpoint.progress_heartbeat_at, checkpoint.updated_at) AS latest_checkpoint_updated_at,
        COALESCE(checkpoint.progress_heartbeat_at, checkpoint.updated_at) AS latest_progress_heartbeat_at,
        checkpoint.page_index AS last_successful_page_index,
        checkpoint.status,
        checkpoint.poisoned_at,
        checkpoint.poison_reason,
        checkpoint.updated_at
      FROM google_ads_sync_partitions partition
      JOIN google_ads_sync_checkpoints checkpoint ON checkpoint.partition_id = partition.id
      WHERE partition.status IN ('queued', 'leased', 'running', 'dead_letter')
      ORDER BY partition.business_id, checkpoint.partition_id, checkpoint.updated_at DESC
    ),
    checkpoint_latest AS (
      SELECT DISTINCT ON (business_id)
        business_id,
        phase AS latest_checkpoint_phase,
        latest_checkpoint_updated_at,
        latest_progress_heartbeat_at,
        last_successful_page_index
      FROM active_checkpoint_latest
      ORDER BY business_id, updated_at DESC NULLS LAST
    ),
    checkpoint_rollup AS (
      SELECT
        business_id,
        COUNT(*) FILTER (WHERE status = 'failed') AS checkpoint_failures,
        COUNT(*) FILTER (WHERE poisoned_at IS NOT NULL) AS poisoned_checkpoint_count
      FROM active_checkpoint_latest
      GROUP BY business_id
    ),
    checkpoint_poison AS (
      SELECT DISTINCT ON (business_id)
        business_id,
        poison_reason AS latest_poison_reason,
        poisoned_at AS latest_poisoned_at
      FROM active_checkpoint_latest
      WHERE poisoned_at IS NOT NULL
      ORDER BY business_id, poisoned_at DESC
    ),
    breaker_stats AS (
      SELECT
        business_id,
        COUNT(*) FILTER (
          WHERE provider = 'google'
            AND request_type = '__global_circuit_breaker__'
            AND cooldown_until > now()
        ) AS active_circuit_breakers,
        COUNT(*) FILTER (
          WHERE provider = 'google'
            AND request_type = '__global_circuit_breaker_recovery__'
            AND cooldown_until > now()
        ) AS recovery_half_open
      FROM provider_cooldown_state
      GROUP BY business_id
    ),
    quota_stats AS (
      SELECT business_id, call_count, error_count
      FROM provider_quota_usage
      WHERE provider = 'google'
        AND quota_date = CURRENT_DATE
    ),
    runner_lease_stats AS (
      SELECT business_id, TRUE AS google_runner_lease_active
      FROM google_ads_runner_leases
      WHERE lease_expires_at > now()
      GROUP BY business_id
    ),
    stale_run_stats AS (
      SELECT
        business_id,
        COUNT(*) FILTER (WHERE error_class = 'stale_run') AS stale_run_pressure,
        COUNT(*) FILTER (
          WHERE error_class = 'lease_conflict'
            AND updated_at > now() - interval '24 hours'
        ) AS lease_conflict_runs_24h
      FROM google_ads_sync_runs
      WHERE error_class IN ('stale_run', 'lease_conflict')
        AND updated_at > now() - interval '24 hours'
      GROUP BY business_id
    ),
    reclaim_stats AS (
      SELECT
        business_id,
        COUNT(*) FILTER (
          WHERE event_type = 'reclaimed'
            AND created_at > now() - interval '24 hours'
        ) AS reclaim_candidate_count,
        COUNT(*) FILTER (
          WHERE event_type = 'skipped_active_lease'
            AND created_at > now() - interval '24 hours'
        ) AS skipped_active_lease_recoveries
      FROM sync_reclaim_events
      WHERE provider_scope = 'google_ads'
      GROUP BY business_id
    ),
    reclaim_reason AS (
      SELECT DISTINCT ON (business_id)
        business_id,
        reason_code AS last_reclaim_reason
      FROM sync_reclaim_events
      WHERE provider_scope = 'google_ads'
      ORDER BY business_id, created_at DESC
    ),
    worker_stats AS (
      SELECT
        (
          COUNT(*) FILTER (
            WHERE provider_scope IN ('google_ads', 'all')
              AND last_heartbeat_at > now() - interval '5 minutes'
          ) > 0
        ) AS google_worker_healthy,
        MIN(
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - last_heartbeat_at)) * 1000))::bigint
        ) FILTER (WHERE provider_scope IN ('google_ads', 'all')) AS google_heartbeat_age_ms
      FROM sync_worker_heartbeats
    )
    SELECT
      partition.business_id,
      b.name AS business_name,
      partition.queue_depth,
      partition.leased_partitions,
      partition.stale_lease_partitions,
      partition.dead_letter_partitions,
      COALESCE(state.state_row_count, 0) AS state_row_count,
      partition.oldest_queued_partition,
      partition.latest_partition_activity_at,
      COALESCE(state.campaign_completed_days, 0) AS campaign_completed_days,
      COALESCE(state.campaign_dead_letter_count, 0) AS campaign_dead_letter_count,
      state.campaign_ready_through_date,
      COALESCE(state.search_term_completed_days, 0) AS search_term_completed_days,
      state.search_term_ready_through_date,
      COALESCE(state.product_completed_days, 0) AS product_completed_days,
      state.product_ready_through_date,
      COALESCE(state.asset_completed_days, 0) AS asset_completed_days,
      state.asset_ready_through_date,
      checkpoint_latest.latest_checkpoint_phase,
      checkpoint_latest.latest_checkpoint_updated_at,
      checkpoint_latest.latest_progress_heartbeat_at,
      checkpoint_latest.last_successful_page_index,
      COALESCE(checkpoint_rollup.checkpoint_failures, 0) AS checkpoint_failures,
      COALESCE(checkpoint_rollup.poisoned_checkpoint_count, 0) AS poisoned_checkpoint_count,
      checkpoint_poison.latest_poison_reason,
      checkpoint_poison.latest_poisoned_at,
      COALESCE(breaker_stats.active_circuit_breakers, 0) AS active_circuit_breakers,
      COALESCE(breaker_stats.recovery_half_open, 0) AS recovery_half_open,
      partition.compacted_partitions,
      COALESCE(quota_stats.call_count, 0) AS quota_call_count,
      COALESCE(quota_stats.error_count, 0) AS quota_error_count,
      ${Math.max(1, Number(process.env.GOOGLE_ADS_DAILY_REQUEST_BUDGET_PER_BUSINESS) || 5000)}::int AS quota_budget,
      CASE
        WHEN ${Math.max(1, Number(process.env.GOOGLE_ADS_DAILY_REQUEST_BUDGET_PER_BUSINESS) || 5000)}::numeric > 0
          THEN COALESCE(quota_stats.call_count, 0)::numeric / ${Math.max(1, Number(process.env.GOOGLE_ADS_DAILY_REQUEST_BUDGET_PER_BUSINESS) || 5000)}::numeric
        ELSE 0
      END AS quota_pressure,
      COALESCE(recent_search.recent_search_term_completed_days, 0) AS recent_search_term_completed_days,
      COALESCE(recent_product.recent_product_completed_days, 0) AS recent_product_completed_days,
      COALESCE(recent_asset.recent_asset_completed_days, 0) AS recent_asset_completed_days,
      14::int AS recent_range_total_days,
      partition.extended_recent_queue_depth,
      partition.extended_recent_leased_partitions,
      partition.extended_historical_queue_depth,
      partition.extended_historical_leased_partitions,
      recent_ready.extended_recent_ready_through_date,
      worker_stats.google_worker_healthy,
      worker_stats.google_heartbeat_age_ms,
      COALESCE(runner_lease_stats.google_runner_lease_active, FALSE) AS google_runner_lease_active,
      COALESCE(stale_run_stats.stale_run_pressure, 0) AS stale_run_pressure,
      COALESCE(stale_run_stats.lease_conflict_runs_24h, 0) AS lease_conflict_runs_24h,
      COALESCE(reclaim_stats.reclaim_candidate_count, 0) AS reclaim_candidate_count,
      COALESCE(reclaim_stats.skipped_active_lease_recoveries, 0) AS skipped_active_lease_recoveries,
      reclaim_reason.last_reclaim_reason
    FROM partition_stats partition
    JOIN businesses b ON b.id::text = partition.business_id
    LEFT JOIN state_stats state ON state.business_id = partition.business_id
    LEFT JOIN recent_search ON recent_search.business_id = partition.business_id
    LEFT JOIN recent_product ON recent_product.business_id = partition.business_id
    LEFT JOIN recent_asset ON recent_asset.business_id = partition.business_id
    LEFT JOIN recent_ready ON recent_ready.business_id = partition.business_id
    LEFT JOIN checkpoint_latest ON checkpoint_latest.business_id = partition.business_id
    LEFT JOIN checkpoint_rollup ON checkpoint_rollup.business_id = partition.business_id
    LEFT JOIN checkpoint_poison ON checkpoint_poison.business_id = partition.business_id
    LEFT JOIN breaker_stats ON breaker_stats.business_id = partition.business_id
    LEFT JOIN quota_stats ON quota_stats.business_id = partition.business_id
    LEFT JOIN runner_lease_stats ON runner_lease_stats.business_id = partition.business_id
    LEFT JOIN stale_run_stats ON stale_run_stats.business_id = partition.business_id
    LEFT JOIN reclaim_stats ON reclaim_stats.business_id = partition.business_id
    LEFT JOIN reclaim_reason ON reclaim_reason.business_id = partition.business_id
    CROSS JOIN worker_stats
    ORDER BY partition.dead_letter_partitions DESC, partition.queue_depth DESC, partition.latest_partition_activity_at DESC
  `) as RawGoogleAdsHealthRow[];
}

async function readGoogleAdsHealthSummaryRow() {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      COUNT(*) FILTER (WHERE status = 'queued') AS queue_depth,
      COUNT(*) FILTER (WHERE status IN ('leased', 'running')) AS leased_partitions,
      COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_partitions,
      MIN(partition_date) FILTER (WHERE status = 'queued') AS oldest_queued_partition
    FROM google_ads_sync_partitions
  `) as Array<Record<string, unknown>>;
  const row = rows[0] ?? {};
  return {
    queueDepth: Number(row.queue_depth ?? 0),
    leasedPartitions: Number(row.leased_partitions ?? 0),
    deadLetterPartitions: Number(row.dead_letter_partitions ?? 0),
    oldestQueuedPartition:
      typeof row.oldest_queued_partition === "string"
        ? row.oldest_queued_partition
        : row.oldest_queued_partition instanceof Date
          ? row.oldest_queued_partition.toISOString()
          : null,
  } satisfies GoogleAdsHealthSummaryRow;
}

async function readMetaHealthRows(input?: {
  businessId?: string | null;
  timeoutMs?: number;
}) {
  const sql = getDbWithTimeout(input?.timeoutMs ?? 30_000);
  const businessId = input?.businessId ?? null;
  return (await sql`
    WITH partition_stats AS (
      SELECT
        business_id::text AS business_id,
        COUNT(*) FILTER (WHERE status = 'queued') AS queue_depth,
        COUNT(*) FILTER (WHERE status IN ('leased', 'running')) AS leased_partitions,
        COUNT(*) FILTER (WHERE status = 'failed') AS retryable_failed_partitions,
        COUNT(*) FILTER (
          WHERE status IN ('leased', 'running')
            AND updated_at < now() - interval '15 minutes'
        ) AS stale_lease_partitions,
        COUNT(*) FILTER (WHERE status = 'dead_letter') AS dead_letter_partitions,
        MIN(partition_date) FILTER (WHERE status = 'queued') AS oldest_queued_partition,
        MAX(updated_at) AS latest_partition_activity_at,
        MAX(partition_date) FILTER (WHERE source = 'today') AS current_day_reference
      FROM meta_sync_partitions
      WHERE (${businessId}::text IS NULL OR business_id::text = ${businessId})
      GROUP BY business_id::text
    ),
    state_stats AS (
      SELECT
        business_id::text AS business_id,
        COUNT(DISTINCT CONCAT(provider_account_id, ':', scope)) AS state_row_count,
        MAX(completed_days) FILTER (WHERE scope = 'account_daily') AS account_completed_days,
        (MIN(ready_through_date) FILTER (WHERE scope = 'account_daily'))::text AS account_ready_through_date,
        MAX(completed_days) FILTER (WHERE scope = 'adset_daily') AS adset_completed_days,
        (MIN(ready_through_date) FILTER (WHERE scope = 'adset_daily'))::text AS adset_ready_through_date,
        MAX(completed_days) FILTER (WHERE scope = 'creative_daily') AS creative_completed_days,
        (MIN(ready_through_date) FILTER (WHERE scope = 'creative_daily'))::text AS creative_ready_through_date,
        MAX(completed_days) FILTER (WHERE scope = 'ad_daily') AS ad_completed_days,
        (MIN(ready_through_date) FILTER (WHERE scope = 'ad_daily'))::text AS ad_ready_through_date
      FROM meta_sync_state
      WHERE (${businessId}::text IS NULL OR business_id::text = ${businessId})
      GROUP BY business_id::text
    ),
    checkpoint_latest AS (
      SELECT DISTINCT ON (business_id)
        business_id::text AS business_id,
        checkpoint_scope AS latest_checkpoint_scope,
        phase AS latest_checkpoint_phase,
        updated_at AS latest_checkpoint_updated_at,
        updated_at AS latest_progress_heartbeat_at,
        page_index AS last_successful_page_index
      FROM meta_sync_checkpoints
      WHERE (${businessId}::text IS NULL OR business_id::text = ${businessId})
      ORDER BY business_id, updated_at DESC
    ),
    checkpoint_failures AS (
      SELECT
        business_id::text AS business_id,
        COUNT(*)::int AS checkpoint_failures
      FROM meta_sync_checkpoints
      WHERE status = 'failed'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
      GROUP BY business_id::text
    ),
    recent_rows AS (
      SELECT business_id::text AS business_id, date, 'account_daily'::text AS scope
      FROM meta_account_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
      UNION ALL
      SELECT business_id::text AS business_id, date, 'adset_daily'::text AS scope
      FROM meta_adset_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
      UNION ALL
      SELECT business_id::text AS business_id, date, 'creative_daily'::text AS scope
      FROM meta_creative_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
      UNION ALL
      SELECT business_id::text AS business_id, date, 'ad_daily'::text AS scope
      FROM meta_ad_daily
      WHERE date >= CURRENT_DATE - interval '13 days'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
    ),
    recent_stats AS (
      SELECT
        business_id,
        COUNT(DISTINCT date) FILTER (WHERE scope = 'account_daily') AS recent_account_completed_days,
        COUNT(DISTINCT date) FILTER (WHERE scope = 'adset_daily') AS recent_adset_completed_days,
        COUNT(DISTINCT date) FILTER (WHERE scope = 'creative_daily') AS recent_creative_completed_days,
        COUNT(DISTINCT date) FILTER (WHERE scope = 'ad_daily') AS recent_ad_completed_days,
        14::int AS recent_range_total_days
      FROM recent_rows
      GROUP BY business_id
    ),
    today_account_rows AS (
      SELECT
        account_daily.business_id::text AS business_id,
        COUNT(*)::int AS today_account_rows
      FROM meta_account_daily account_daily
      JOIN partition_stats partition
        ON partition.business_id = account_daily.business_id::text
       AND partition.current_day_reference IS NOT NULL
       AND account_daily.date = partition.current_day_reference
      GROUP BY account_daily.business_id::text
    ),
    today_adset_rows AS (
      SELECT
        adset_daily.business_id::text AS business_id,
        COUNT(*)::int AS today_adset_rows
      FROM meta_adset_daily adset_daily
      JOIN partition_stats partition
        ON partition.business_id = adset_daily.business_id::text
       AND partition.current_day_reference IS NOT NULL
       AND adset_daily.date = partition.current_day_reference
      GROUP BY adset_daily.business_id::text
    ),
    reclaim_stats AS (
      SELECT
        business_id::text AS business_id,
        COUNT(*) FILTER (
          WHERE event_type = 'reclaimed'
            AND created_at > now() - interval '24 hours'
        )::int AS reclaim_candidate_count,
        COUNT(*) FILTER (
          WHERE event_type = 'skipped_active_lease'
            AND created_at > now() - interval '24 hours'
        )::int AS skipped_active_lease_recoveries
      FROM sync_reclaim_events
      WHERE provider_scope = 'meta'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
      GROUP BY business_id::text
    ),
    latest_reclaim AS (
      SELECT DISTINCT ON (business_id)
        business_id::text AS business_id,
        reason_code AS last_reclaim_reason
      FROM sync_reclaim_events
      WHERE provider_scope = 'meta'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
      ORDER BY business_id, created_at DESC
    ),
    stale_runs AS (
      SELECT
        business_id::text AS business_id,
        COUNT(*)::int AS stale_run_count_24h
      FROM meta_sync_runs
      WHERE error_class = 'stale_run'
        AND updated_at > now() - interval '24 hours'
        AND (${businessId}::text IS NULL OR business_id::text = ${businessId})
      GROUP BY business_id::text
    )
    SELECT
      partition.business_id,
      b.name AS business_name,
      partition.queue_depth,
      partition.leased_partitions,
      partition.retryable_failed_partitions,
      partition.stale_lease_partitions,
      partition.dead_letter_partitions,
      COALESCE(state.state_row_count, 0) AS state_row_count,
      partition.oldest_queued_partition,
      partition.latest_partition_activity_at,
      checkpoint.latest_checkpoint_scope,
      checkpoint.latest_checkpoint_phase,
      checkpoint.latest_checkpoint_updated_at,
      checkpoint.latest_progress_heartbeat_at,
      checkpoint.last_successful_page_index,
      COALESCE(checkpoint_failures.checkpoint_failures, 0) AS checkpoint_failures,
      COALESCE(reclaim.reclaim_candidate_count, 0) AS reclaim_candidate_count,
      latest_reclaim.last_reclaim_reason,
      partition.current_day_reference,
      COALESCE(today_account_rows.today_account_rows, 0) AS today_account_rows,
      COALESCE(today_adset_rows.today_adset_rows, 0) AS today_adset_rows,
      COALESCE(state.account_completed_days, 0) AS account_completed_days,
      state.account_ready_through_date,
      COALESCE(state.adset_completed_days, 0) AS adset_completed_days,
      state.adset_ready_through_date,
      COALESCE(state.creative_completed_days, 0) AS creative_completed_days,
      state.creative_ready_through_date,
      COALESCE(state.ad_completed_days, 0) AS ad_completed_days,
      state.ad_ready_through_date,
      COALESCE(recent.recent_account_completed_days, 0) AS recent_account_completed_days,
      COALESCE(recent.recent_adset_completed_days, 0) AS recent_adset_completed_days,
      COALESCE(recent.recent_creative_completed_days, 0) AS recent_creative_completed_days,
      COALESCE(recent.recent_ad_completed_days, 0) AS recent_ad_completed_days,
      COALESCE(recent.recent_range_total_days, 14) AS recent_range_total_days,
      COALESCE(reclaim.skipped_active_lease_recoveries, 0) AS skipped_active_lease_recoveries,
      COALESCE(stale_runs.stale_run_count_24h, 0) AS stale_run_count_24h
    FROM partition_stats partition
    JOIN businesses b ON b.id::text = partition.business_id
    LEFT JOIN state_stats state
      ON state.business_id = partition.business_id
    LEFT JOIN checkpoint_latest checkpoint
      ON checkpoint.business_id = partition.business_id
    LEFT JOIN checkpoint_failures
      ON checkpoint_failures.business_id = partition.business_id
    LEFT JOIN recent_stats recent
      ON recent.business_id = partition.business_id
    LEFT JOIN today_account_rows
      ON today_account_rows.business_id = partition.business_id
    LEFT JOIN today_adset_rows
      ON today_adset_rows.business_id = partition.business_id
    LEFT JOIN reclaim_stats reclaim
      ON reclaim.business_id = partition.business_id
    LEFT JOIN latest_reclaim
      ON latest_reclaim.business_id = partition.business_id
    LEFT JOIN stale_runs
      ON stale_runs.business_id = partition.business_id
    GROUP BY
      partition.business_id,
      b.name,
      partition.queue_depth,
      partition.leased_partitions,
      partition.retryable_failed_partitions,
      partition.stale_lease_partitions,
      partition.dead_letter_partitions,
      state.state_row_count,
      partition.oldest_queued_partition,
      partition.latest_partition_activity_at,
      checkpoint.latest_checkpoint_scope,
      checkpoint.latest_checkpoint_phase,
      checkpoint.latest_checkpoint_updated_at,
      checkpoint.latest_progress_heartbeat_at,
      checkpoint.last_successful_page_index,
      checkpoint_failures.checkpoint_failures,
      reclaim.reclaim_candidate_count,
      reclaim.skipped_active_lease_recoveries,
      latest_reclaim.last_reclaim_reason,
      stale_runs.stale_run_count_24h,
      partition.current_day_reference,
      today_account_rows.today_account_rows,
      today_adset_rows.today_adset_rows,
      state.account_completed_days,
      state.account_ready_through_date,
      state.adset_completed_days,
      state.adset_ready_through_date,
      state.creative_completed_days,
      state.creative_ready_through_date,
      state.ad_completed_days,
      state.ad_ready_through_date,
      recent.recent_account_completed_days,
      recent.recent_adset_completed_days,
      recent.recent_creative_completed_days,
      recent.recent_ad_completed_days,
      recent.recent_range_total_days
    ORDER BY dead_letter_partitions DESC, queue_depth DESC, latest_partition_activity_at DESC
  `) as RawMetaHealthRow[];
}

export async function getMetaReleaseGateBusinessHealthSnapshot(input: {
  businessId: string;
  timeoutMs?: number;
}): Promise<MetaReleaseGateBusinessHealthSnapshot | null> {
  const [row, workerHealth, reclaimSummary] = await Promise.all([
    readMetaHealthRows({
      businessId: input.businessId,
      timeoutMs: input.timeoutMs,
    }).then((rows) => rows[0] ?? null),
    getSyncWorkerHealthSummary().catch(() => ({
      onlineWorkers: 0,
      workerInstances: 0,
      lastHeartbeatAt: null,
      lastProgressHeartbeatAt: null,
      workers: [],
    })),
    getMetaReclaimClassificationSummary({
      businessId: input.businessId,
      timeoutMs: input.timeoutMs,
    }).catch(() => null),
  ]);

  if (!row) return null;

  const queueDepth = Number(row.queue_depth ?? 0);
  const leasedPartitions = Number(row.leased_partitions ?? 0);
  const retryableFailedPartitions = Number(row.retryable_failed_partitions ?? 0);
  const staleLeasePartitions = Number(row.stale_lease_partitions ?? 0);
  const deadLetterPartitions = Number(row.dead_letter_partitions ?? 0);
  const accountCompletedDays = Number(row.account_completed_days ?? 0);
  const adsetCompletedDays = Number(row.adset_completed_days ?? 0);
  const creativeCompletedDays = Number(row.creative_completed_days ?? 0);
  const adCompletedDays = Number(row.ad_completed_days ?? 0);
  const recentRangeTotalDays = Math.max(1, Number(row.recent_range_total_days ?? 14));
  const recentCreativeCompletedDays = Number(row.recent_creative_completed_days ?? 0);
  const recentAdCompletedDays = Number(row.recent_ad_completed_days ?? 0);
  const recentExtendedReady =
    recentCreativeCompletedDays >= recentRangeTotalDays &&
    recentAdCompletedDays >= recentRangeTotalDays;
  const historicalExtendedReady =
    creativeCompletedDays >= META_CREATIVE_WAREHOUSE_HISTORY_DAYS &&
    adCompletedDays >= 365;
  const metaProgressHeartbeat =
    row.latest_progress_heartbeat_at ?? row.latest_checkpoint_updated_at ?? null;
  const metaProviderWorkerObservation = getProviderScopeWorkerObservation({
    providerScope: "meta",
    workers: workerHealth.workers,
    staleThresholdMs: 3 * 60_000,
  });
  const metaWorkerObservation = getProviderBusinessWorkerObservation({
    businessId: row.business_id,
    workers: workerHealth.workers,
    staleThresholdMs: 3 * 60_000,
  });
  const metaProgressEvidence = buildAdminMetaProgressEvidence({
    accountCompletedDays,
    accountReadyThroughDate: row.account_ready_through_date ?? null,
    adsetCompletedDays,
    adsetReadyThroughDate: row.adset_ready_through_date ?? null,
    creativeCompletedDays,
    creativeReadyThroughDate: row.creative_ready_through_date ?? null,
    adCompletedDays,
    adReadyThroughDate: row.ad_ready_through_date ?? null,
    latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
    latestProgressHeartbeatAt: row.latest_progress_heartbeat_at ?? null,
    latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
  });
  const metaCheckpointLagMinutes = computeLagMinutes(metaProgressHeartbeat);
  const reclaimCandidateCount =
    reclaimSummary?.reclaimCandidateCount ?? Number(row.reclaim_candidate_count ?? 0);
  const metaWorkerHealthy =
    metaProviderWorkerObservation.hasFreshHeartbeat || leasedPartitions > 0;
  const progressState = classifyMetaProgressState({
    queueDepth,
    leasedPartitions,
    deadLetterPartitions,
    retryableFailedPartitions,
    staleLeasePartitions,
    checkpointLagMinutes: metaCheckpointLagMinutes,
    latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
    reclaimCandidateCount,
    staleRunCount24h: Number(row.stale_run_count_24h ?? 0),
    recentExtendedReady,
    historicalExtendedReady,
    latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
  });
  const stallFingerprints = deriveProviderStallFingerprints({
    queueDepth,
    leasedPartitions,
    checkpointLagMinutes: metaCheckpointLagMinutes,
    latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
    blocked:
      deadLetterPartitions > 0 ||
      staleLeasePartitions > 0 ||
      reclaimCandidateCount > 0,
    hasRepairableBacklog: retryableFailedPartitions > 0,
    staleRunPressure: Number(row.stale_run_count_24h ?? 0),
    progressEvidence: metaProgressEvidence,
    blockedReasonCodes: deadLetterPartitions > 0 ? ["required_dead_letter_partitions"] : [],
    historicalBacklogDepth: queueDepth,
    workerHealthy: metaWorkerHealthy,
  });
  const activityState = deriveProviderActivityState({
    progressState,
    queueDepth,
    leasedPartitions,
    blocked:
      deadLetterPartitions > 0 ||
      staleLeasePartitions > 0 ||
      reclaimCandidateCount > 0,
  });
  const dbDiagnostics = buildAdminDbDiagnostics({
    web: getDbRuntimeDiagnostics(),
    workers: buildWorkerDbProcessDiagnostics(
      workerHealth.workers.map((worker) => ({
        workerId: worker.workerId,
        providerScope: worker.providerScope,
        status: worker.status,
        lastHeartbeatAt: worker.lastHeartbeatAt,
        metaJson: worker.metaJson ?? null,
      })),
    ),
    metaQueueDepth: queueDepth,
    metaLeasedPartitions: leasedPartitions,
    metaBusinesses: [
      {
        queueDepth,
        leasedPartitions,
        progressState,
        activityState,
        workerOnline: metaProviderWorkerObservation.hasFreshHeartbeat,
      },
    ],
  });

  return {
    businessId: row.business_id,
    businessName: row.business_name ?? null,
    currentDayReference: row.current_day_reference ?? null,
    latestCheckpointUpdatedAt: row.latest_checkpoint_updated_at ?? null,
    accountReadyThroughDate: row.account_ready_through_date ?? null,
    adsetReadyThroughDate: row.adset_ready_through_date ?? null,
    creativeReadyThroughDate: row.creative_ready_through_date ?? null,
    adReadyThroughDate: row.ad_ready_through_date ?? null,
    progressState,
    activityState,
    stallFingerprints,
    staleLeasePartitions,
    repairBacklog: 0,
    validationFailures24h: 0,
    reclaimCandidateCount,
    staleRunCount24h: Number(row.stale_run_count_24h ?? 0),
    lastSuccessfulPublishAt: null,
    d1FinalizeNonTerminalCount: 0,
    workerOnline: metaProviderWorkerObservation.hasFreshHeartbeat,
    workerLastHeartbeatAt:
      metaProviderWorkerObservation.lastHeartbeatAt ??
      metaWorkerObservation.lastHeartbeatAt ??
      null,
    dbConstraint: dbDiagnostics.summary.likelyPrimaryConstraint,
    dbBacklogState: dbDiagnostics.summary.metaBacklogState,
    latestPartitionActivityAt: row.latest_partition_activity_at ?? null,
  };
}

async function readRevenueWorkspaces() {
  const sql = getDb();
  return (await sql`
    SELECT
      b.id::text AS business_id,
      b.name AS business_name,
      u.name AS owner_name,
      u.email AS owner_email,
      b.created_at,
      COUNT(DISTINCT pc.id) FILTER (WHERE pc.status = 'connected') AS connected_integrations,
      BOOL_OR(ss.status = 'active') AS has_active_subscription
    FROM businesses b
    JOIN users u ON u.id = b.owner_id
    LEFT JOIN provider_connections pc ON pc.business_id = b.id::text
    LEFT JOIN shopify_subscriptions ss ON ss.business_id = b.id
    WHERE COALESCE(b.is_demo_business, false) = false
    GROUP BY b.id, u.id
  `) as RawRevenueWorkspaceRow[];
}

async function readRevenueSubscriptions() {
  const sql = getDb();
  return (await sql`
    SELECT
      ss.business_id::text AS business_id,
      b.name AS business_name,
      u.name AS owner_name,
      u.email AS owner_email,
      ss.plan_id,
      ss.status,
      ss.updated_at
    FROM shopify_subscriptions ss
    LEFT JOIN businesses b ON b.id = ss.business_id
    LEFT JOIN users u ON u.id = ss.user_id
  `) as RawRevenueSubscriptionRow[];
}

export async function getAdminOperationsHealth() {
  const runtimeContract = assertRuntimeContractStartup({ service: "web" });
  const controlPlaneIdentity = resolveSyncControlPlaneKey({
    buildId: runtimeContract.buildId,
    providerScope: "meta",
  });
  await upsertRuntimeContractInstance({
    contract: runtimeContract,
  }).catch(() => null);
  const sql = getDb();
  const [
    authRows,
    syncJobs,
    cooldowns,
    googleAdsHealthResult,
    metaHealth,
    revenueWorkspaces,
    revenueSubscriptions,
    workerHealth,
    runtimeRegistry,
    gateRecords,
    repairPlan,
    remediationSummary,
  ] =
    await Promise.all([
      readAuthRows().catch(() => []),
      readSyncJobs().catch(() => []),
      readActiveCooldowns().catch(() => []),
      (async () => {
        try {
          const rows = await readGoogleAdsHealthRows();
          return {
            status: "ok" as const,
            error: null,
            rows,
            summary: null,
          };
        } catch (error) {
          const message = error instanceof Error ? error.message : String(error);
          const summary = await readGoogleAdsHealthSummaryRow().catch(() => null);
          return {
            status: summary ? ("degraded" as const) : ("failed" as const),
            error: message,
            rows: [] as RawGoogleAdsHealthRow[],
            summary,
          };
        }
      })(),
      readMetaHealthRows().catch(() => []),
      readRevenueWorkspaces().catch(() => []),
      readRevenueSubscriptions().catch(() => []),
      getSyncWorkerHealthSummary().catch(() => ({
        onlineWorkers: 0,
        workerInstances: 0,
        lastHeartbeatAt: null,
        lastProgressHeartbeatAt: null,
        workers: [],
      })),
      getRuntimeRegistryStatus({
        buildId: runtimeContract.buildId,
      }).catch(() => null),
      getLatestSyncGateRecords({
        buildId: controlPlaneIdentity.buildId,
        environment: controlPlaneIdentity.environment,
      }).catch(() => ({
        deployGate: null,
        releaseGate: null,
      })),
      getLatestSyncRepairPlan({
        ...controlPlaneIdentity,
      }).catch(() => null),
      getLatestSyncRepairExecutionSummary({
        ...controlPlaneIdentity,
      }).catch(() => null),
    ]);
  const latestMetaRepairExecutions = await getLatestSyncRepairExecutions({
    ...controlPlaneIdentity,
    businessIds: metaHealth.map((row) => row.business_id),
  }).catch(() => []);
  const latestRepairExecutionsByBusiness = Object.fromEntries(
    latestMetaRepairExecutions.map((execution) => [execution.businessId, execution]),
  ) as Record<string, SyncRepairExecutionRecord | null>;
  const metaD1FinalizeNonTerminalCounts = Object.fromEntries(
    (
      (await sql`
        SELECT
          business_id::text AS business_id,
          COUNT(*)::int AS nonterminal_count
        FROM meta_sync_partitions
        WHERE partition_date = CURRENT_DATE - INTERVAL '1 day'
          AND lane = 'maintenance'
          AND scope = 'account_daily'
          AND source = 'finalize_day'
          AND status NOT IN ('succeeded', 'failed', 'cancelled', 'dead_letter')
        GROUP BY business_id::text
      `) as Array<{ business_id: string; nonterminal_count: number | string | null }>
    ).map((row) => [
      row.business_id,
      Number(row.nonterminal_count ?? 0),
    ]),
  ) as Record<string, number>;
  const metaAuthoritativeSnapshots = await Promise.all(
    metaHealth.map((row) =>
      getMetaAuthoritativeBusinessOpsSnapshot({ businessId: row.business_id }).catch(() => null),
    ),
  );
  const metaPhaseTimingWindowHours = 24;
  const integrityEndDate = new Date().toISOString().slice(0, 10);
  const integrityStartDate = (() => {
    const date = new Date(`${integrityEndDate}T00:00:00Z`);
    date.setUTCDate(date.getUTCDate() - 45);
    return date.toISOString().slice(0, 10);
  })();
  const [
    googleAdsQueueHealthByBusiness,
    googleAdsReclaimSummaries,
    googleAdsIntegritySummaries,
    metaReclaimSummaries,
    metaIntegritySummaries,
    metaPhaseTimingSummariesByBusiness,
    metaDeadLetterSummaries,
  ] =
    await Promise.all([
      Promise.all(
        googleAdsHealthResult.rows.map(async (row) => {
          const summary = await getGoogleAdsQueueHealth({
            businessId: row.business_id,
          }).catch(() => null);
          return [row.business_id, summary] as const;
        }),
      ).then((entries) => Object.fromEntries(entries)),
      Promise.all(
        googleAdsHealthResult.rows.map(async (row) => {
          const summary = await getGoogleAdsReclaimClassificationSummary({
            businessId: row.business_id,
          }).catch(() => null);
          return [row.business_id, summary] as const;
        }),
      ).then((entries) =>
        Object.fromEntries(
          entries
            .filter((entry): entry is readonly [string, NonNullable<(typeof entries)[number][1]>] =>
              Boolean(entry[1]),
            )
            .map(([businessId, summary]) => [
              businessId,
              {
                activeSlowPartitions: summary.aliveSlowCount,
                reclaimCandidateCount: summary.reclaimCandidateCount,
                poisonCandidateCount: summary.poisonCandidateCount,
              },
            ]),
        ),
      ),
      Promise.all(
        googleAdsHealthResult.rows.map(async (row) => {
          const incidents = await getGoogleAdsWarehouseIntegrityIncidents({
            businessId: row.business_id,
            startDate: integrityStartDate,
            endDate: integrityEndDate,
          }).catch(() => []);
          return [
            row.business_id,
            {
              incidentCount: incidents.length,
              blockedCount: incidents.filter(
                (incident) => incident.severity === "error" && incident.repairRecommended,
              ).length,
            },
          ] as const;
        }),
      ).then((entries) => Object.fromEntries(entries)),
      Promise.all(
        metaHealth.map(async (row) => {
          const summary = await getMetaReclaimClassificationSummary({
            businessId: row.business_id,
          }).catch(() => null);
          return [row.business_id, summary] as const;
        }),
      ).then((entries) =>
        Object.fromEntries(
          entries
            .filter((entry): entry is readonly [string, NonNullable<(typeof entries)[number][1]>] =>
              Boolean(entry[1]),
            )
            .map(([businessId, summary]) => [
              businessId,
              {
                activeSlowPartitions: summary.aliveSlowCount,
                reclaimCandidateCount: summary.reclaimCandidateCount,
              },
            ]),
        ),
      ),
      Promise.all(
        metaHealth.map(async (row) => {
          const incidents = await getMetaWarehouseIntegrityIncidents({
            businessId: row.business_id,
            startDate: integrityStartDate,
            endDate: integrityEndDate,
            persistReconciliationEvents: false,
          }).catch(() => []);
          return [
            row.business_id,
            {
              incidentCount: incidents.length,
              blockedCount: incidents.filter(
                (incident) => incident.severity === "error" && incident.repairRecommended,
              ).length,
            },
          ] as const;
        }),
      ).then((entries) => Object.fromEntries(entries)),
      listMetaSyncPhaseTimingSummariesByBusiness({
        businessIds: metaHealth.map((row) => row.business_id),
        windowHours: metaPhaseTimingWindowHours,
      }).catch(() => ({})),
      Promise.all(
        metaHealth.map(async (row) => {
          const summary = await getMetaDeadLetterRecoverySummary({
            businessId: row.business_id,
          }).catch(() => null);
          return [row.business_id, summary] as const;
        }),
      ).then((entries) =>
        Object.fromEntries(
          entries.filter(
            (entry): entry is readonly [string, MetaDeadLetterRecoverySummary] =>
              Boolean(entry[1]),
          ),
        ),
      ),
    ]);
  const googleRetentionRuntime = getGoogleAdsRetentionRuntimeStatus();
  const metaRetentionRuntime = getMetaRetentionRuntimeStatus();
  const webDbDiagnostics = getDbRuntimeDiagnostics();
  const metaProtectedPublishedTruth =
    (await getMetaProtectedPublishedTruthReview().catch(() => null)) ?? {
      runtimeAvailable: false,
      asOfDate: new Date().toISOString().slice(0, 10),
      scope: {
        kind: "all_businesses" as const,
        businessIds: null,
      },
      hasNonZeroProtectedPublishedRows: false,
      protectedPublishedRows: 0,
      activePublicationPointerRows: 0,
      protectedTruthClassesPresent: [],
      protectedTruthClassesAbsent: [],
      classes: [],
    };

  const authHealth = buildAdminAuthHealth(authRows);
  const syncHealth = buildAdminSyncHealth({
    jobs: syncJobs,
    cooldowns,
    googleAdsHealth: googleAdsHealthResult.rows,
    googleAdsHealthStatus: googleAdsHealthResult.status,
    googleAdsHealthError: googleAdsHealthResult.error,
    googleAdsHealthSummary: googleAdsHealthResult.summary,
    googleAdsQueueHealthByBusiness,
    googleAdsReclaimSummaries,
    googleAdsIntegritySummaries,
    metaHealth,
    metaAuthoritativeSnapshots: metaAuthoritativeSnapshots.filter(
      (snapshot): snapshot is MetaAuthoritativeBusinessOpsSnapshot => Boolean(snapshot),
    ),
    metaPhaseTimingSummariesByBusiness,
    metaPhaseTimingWindowHours,
    metaReclaimSummaries,
    metaIntegritySummaries,
    metaD1FinalizeNonTerminalCounts,
    metaDeadLetterSummaries,
    workerHealth,
    webDbDiagnostics,
    runtimeContract,
    runtimeRegistry,
    deployGate: gateRecords.deployGate,
    releaseGate: gateRecords.releaseGate,
    repairPlan,
    remediationSummary,
    latestRepairExecutionsByBusiness,
  });
  syncHealth.globalRebuildReview = buildGlobalRebuildTruthReview({
    googleBusinesses: syncHealth.googleAdsBusinesses ?? [],
    metaBusinesses: syncHealth.metaBusinesses ?? [],
    googleExecution: {
      sync:
        syncHealth.summary.googleAdsSafeModeActive === true
          ? "safe_mode"
          : syncHealth.summary.googleAdsGlobalReopenEnabled === true
            ? "global_reopen"
            : "global_backfill",
      retentionEnabled: googleRetentionRuntime.executionEnabled,
    },
    metaExecution: {
      authoritativeFinalizationEnabled: isMetaAuthoritativeFinalizationV2Enabled(),
      retentionEnabled: metaRetentionRuntime.executionEnabled,
    },
    metaProtectedPublishedTruth,
  });
  syncHealth.syncEffectivenessReview = buildSyncEffectivenessReview({
    globalRebuildReview: syncHealth.globalRebuildReview,
    googleBusinesses: syncHealth.googleAdsBusinesses ?? [],
    metaBusinesses: syncHealth.metaBusinesses ?? [],
  });
  const revenueRisk = buildAdminRevenueRisk({
    workspaces: revenueWorkspaces,
    subscriptions: revenueSubscriptions,
  });

  return {
    authHealth,
    syncHealth,
    revenueRisk,
  };
}
