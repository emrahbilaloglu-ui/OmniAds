import type {
  ProviderCheckpointHealth,
  ProviderDomainReadiness,
  ProviderReadinessLevel,
  ProviderSurfaceSummary,
} from "@/lib/provider-readiness";
import type {
  ProviderActivityState,
  ProviderBlockingReason,
  ProviderRepairableAction,
  ProviderRequiredCoverage,
  ProviderSecondaryReadiness,
  ProviderStallFingerprint,
  SyncBlockerClass,
  SyncTruthState,
} from "@/lib/sync/provider-status-truth";
import type { GlobalOperatorReviewWorkflow } from "@/lib/global-operator-review";
import type { SyncGateRecord } from "@/lib/sync/release-gates";
import type { SyncRepairPlanRecord } from "@/lib/sync/repair-planner";
import type { SyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import type { SyncControlPlanePersistenceStatus } from "@/lib/sync/control-plane-persistence";
import type { GoogleAdsFreshnessSummary } from "@/lib/google-ads/freshness-read";

export interface GoogleAdsSyncDetails {
  id?: string | null;
  status?: string;
  syncType?: string | null;
  scope?: string | null;
  startDate?: string | null;
  endDate?: string | null;
  triggerSource?: string | null;
  triggeredAt?: string | null;
  startedAt?: string | null;
  finishedAt?: string | null;
  lastError?: string | null;
  progressPercent?: number | null;
  completedDays?: number | null;
  totalDays?: number | null;
  readyThroughDate?: string | null;
  phaseLabel?: string | null;
}

export type GoogleAdsPanelRecoveryMode =
  | "safe_mode"
  | "global_backfill"
  | "global_reopen";

export type GoogleAdsPanelSurfaceStateKind =
  | "core_live"
  | "extended_backfilling"
  | "extended_limited"
  | "ready";

export interface GoogleAdsPanelSurfaceState {
  scope: string;
  label: string;
  state: GoogleAdsPanelSurfaceStateKind;
  completedDays: number;
  totalDays: number;
  readyThroughDate: string | null;
  latestBackgroundActivityAt: string | null;
  message: string;
}

export interface GoogleAdsExtendedRangeCompletion {
  completedDays: number;
  totalDays: number;
  readyThroughDate: string | null;
  ready: boolean;
}

export interface GoogleAdsProgressState {
  percent: number;
  visible: boolean;
  summary: string;
}

export interface GoogleAdsRuntimeProgressState {
  meaningfulProgressRecent: boolean;
  heartbeatOnly: boolean;
  latestMeaningfulProgressAt: string | null;
  latestCheckpointUpdatedAt: string | null;
  latestSuccessfulScopeSyncAt: string | null;
  latestPartitionActivityAt: string | null;
  queueDepth: number;
  leasedPartitions: number;
  observationWindowMinutes: number;
}

export interface GoogleAdsBackgroundBackfillState {
  state:
    | "ready"
    | "active"
    | "waiting"
    | "stalled"
    | "quota_limited"
    | "blocked";
  percent: number;
  incomplete: boolean;
  pendingScopes: string[];
  readyThroughDate: string | null;
  latestProgressAt: string | null;
  reason: string | null;
}

export interface GoogleAdsGlobalSyncProgressState {
  kind: "advisor" | "historical";
  percent: number;
  visible: boolean;
  label: string;
  summary: string;
}

export interface GoogleAdsCurrentDayLiveStatus {
  active: boolean;
  usingLiveOverlay: boolean;
  coreUsable: boolean;
  currentDate: string | null;
  warehouseSegmentEndDate: string | null;
  liveSegmentStartDate: string | null;
}

export interface GoogleAdsStatusDomainSummary {
  state: "syncing" | "partial" | "ready" | "advisor_not_ready";
  label: string;
  detail: string;
}

export interface GoogleAdsReleaseReadinessCandidate {
  pass: boolean;
  blockerClass: SyncBlockerClass;
  evidence: Record<string, unknown>;
}

export interface GoogleAdsStatusResponse {
  state:
    | "not_connected"
    | "connected_no_assignment"
    | "syncing"
    | "paused"
    | "partial"
    | "advisor_not_ready"
    | "stale"
    | "action_required"
    | "ready";
  connected: boolean;
  controlPlaneIdentity?: SyncControlPlaneKey | null;
  controlPlanePersistence?: SyncControlPlanePersistenceStatus | null;
  controlPlaneErrors?: {
    syncGates: string | null;
    repairPlan: string | null;
    controlPlanePersistence: string | null;
    syncIncidents?: string | null;
  } | null;
  releaseReadinessCandidate?: GoogleAdsReleaseReadinessCandidate | null;
  deployGate?: SyncGateRecord | null;
  releaseGate?: SyncGateRecord | null;
  repairPlan?: SyncRepairPlanRecord | null;
  actionRequired?: {
    reconnectCta: boolean;
    partitions: number;
    blockingPartitions: number;
    scopes: string[];
    blockingScopes: string[];
  } | null;
  syncTruthState?: SyncTruthState | null;
  blockerClass?: SyncBlockerClass | null;
  userVisibleSyncState?: {
    kind:
      | "healthy"
      | "refreshing_in_background"
      | "using_latest_available_data"
      | "setup_required"
      | "reconnect_required"
      | "data_unavailable";
    label: string;
    suppressRecoverableAttention: boolean;
    degradedServing: boolean;
  } | null;
  operationalSyncState?:
    | "healthy"
    | "detected"
    | "eligible"
    | "repairing"
    | "cooldown"
    | "half_open"
    | "cleared"
    | "quarantined"
    | "exhausted"
    | "manual_required"
    | null;
  degradedServing?: boolean;
  openIncidents?: number | null;
  readinessLevel?: ProviderReadinessLevel;
  surfaces?: ProviderSurfaceSummary;
  checkpointHealth?: ProviderCheckpointHealth | null;
  domainReadiness?: ProviderDomainReadiness | null;
  assignedAccountIds: string[];
  primaryAccountTimezone?: string | null;
  currentDateInTimezone?: string | null;
  d1TargetDate?: string | null;
  d1FinalizeState?: "ready" | "processing" | "blocked" | null;
  d1BlockedReason?: string | null;
  dataContract?: {
    todayMode: "live_overlay";
    historicalMode: "warehouse_only";
  };
  platformDateBoundary?: {
    primaryAccountId: string | null;
    primaryAccountTimezone: string | null;
    currentDateInTimezone: string | null;
    previousDateInTimezone: string | null;
    selectedRangeMode: "current_day_live" | "historical_warehouse";
    mixedCurrentDates: boolean;
    accounts: Array<{
      provider: "google";
      businessId: string;
      providerAccountId: string | null;
      timeZone: string;
      currentDate: string;
      previousDate: string;
      isPrimary: boolean;
    }>;
  };
  /**
   * The authoritative freshness verdict for the selected range.
   *
   * Every other completion-shaped field on this response is derived from the
   * same snapshot. When `evidenceAvailable` is false the state is `unknown`:
   * not green, not failed, and still polling.
   */
  freshness?: GoogleAdsFreshnessSummary | null;
  completionBasis?: {
    requiredScopes: string[];
    excludedScopes: string[];
    percent: number;
    complete: boolean;
    /** Mirrors `freshness.state` so no consumer can read one without the other. */
    state?: GoogleAdsFreshnessSummary["state"];
    evidenceAvailable?: boolean;
  };
  completionBlockers?: string[];
  runtimeProgress?: GoogleAdsRuntimeProgressState | null;
  backgroundBackfill?: GoogleAdsBackgroundBackfillState | null;
  globalSyncProgress?: GoogleAdsGlobalSyncProgressState | null;
  currentDayLiveStatus?: GoogleAdsCurrentDayLiveStatus | null;
  selectedRangeReadinessBasis?: {
    mode: "current_day_live" | "historical_warehouse";
    warehouseCoverageIgnored: boolean;
    liveOverlayEligible: boolean;
  } | null;
  requiredScopeCompletion?: ProviderRequiredCoverage | null;
  needsBootstrap?: boolean;
  warehouse?: {
    rowCount: number;
    firstDate: string | null;
    lastDate: string | null;
    coverage?: {
      historical?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
      } | null;
      selectedRange?: {
        startDate: string;
        endDate: string;
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        isComplete: boolean;
      } | null;
      accountDaily?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
      } | null;
      campaignDaily?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
      } | null;
      scopes?: Array<{
        scope: string;
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        latestBackgroundActivityAt: string | null;
        deadLetterCount: number;
      }> | null;
      pendingSurfaces?: string[];
    } | null;
  } | null;
  advisor?: {
    ready: boolean;
    readinessModel?: string;
    readinessWindowDays?: number;
    snapshotReady?: boolean;
    snapshotAsOfDate?: string | null;
    snapshotFresh?: boolean;
    snapshotBlockedReason?: string | null;
    requiredSurfaces: string[];
    availableSurfaces: string[];
    missingSurfaces: string[];
    readyRangeStart: string | null;
    readyRangeEnd: string | null;
    blockingMessage?: string | null;
    selectedWindow?: {
      label: string;
      ready: boolean;
      startDate: string | null;
      endDate: string | null;
      totalDays: number | null;
      missingSurfaces: string[];
    } | null;
    supportWindows?: Array<{
      key: string;
      label: string;
      ready: boolean;
      startDate: string;
      endDate: string;
      totalDays: number;
      missingSurfaces: string[];
    }> | null;
    decisionEngineV2Enabled?: boolean;
    writebackEnabled?: boolean;
    actionContract?: {
      version: string | null;
      source: "native" | "compatibility_derived" | null;
    } | null;
    aggregateIntelligence?: {
      topQueryWeeklyAvailable: boolean;
      clusterDailyAvailable: boolean;
      queryWeeklyRows: number;
      clusterDailyRows: number;
      supportWindowStart: string | null;
      supportWindowEnd: string | null;
      note: string | null;
    } | null;
    aiAssist?: {
      gateEnabled: boolean;
      businessScoped: boolean;
      businessAllowed: boolean;
      appliedCount: number;
      rejectedCount: number;
      failedCount: number;
      skippedCount: number;
      eligibleCount: number;
      promptVersion: string | null;
      blockedReasons: string[];
    } | null;
  } | null;
  jobHealth?: {
    runningJobs: number;
    staleRunningJobs: number;
    backgroundRunningJobs?: number;
    priorityRunningJobs?: number;
    legacyRuntimeJobs?: number;
    queueDepth?: number;
    leasedPartitions?: number;
    coreQueueDepth?: number;
    coreLeasedPartitions?: number;
    extendedQueueDepth?: number;
    extendedLeasedPartitions?: number;
    extendedRecentQueueDepth?: number;
    extendedRecentLeasedPartitions?: number;
    extendedHistoricalQueueDepth?: number;
    extendedHistoricalLeasedPartitions?: number;
    maintenanceQueueDepth?: number;
    maintenanceLeasedPartitions?: number;
    deadLetterPartitions?: number;
    actionRequiredDeadLetterPartitions?: number;
    actionRequiredBlockingDeadLetterPartitions?: number;
    actionRequiredDeadLetterScopes?: string[];
    actionRequiredBlockingDeadLetterScopes?: string[];
    advisorRelevantDeadLetterPartitions?: number;
    historicalDeadLetterPartitions?: number;
    advisorRelevantFailedPartitions?: number;
    advisorRelevantLeasedPartitions?: number;
    oldestQueuedPartition?: string | null;
  } | null;
  priorityWindow?: {
    startDate: string;
    endDate: string;
    completedDays: number;
    totalDays: number;
    isActive: boolean;
  } | null;
  operatorTruth?: {
    rolloutModel: "global";
    reviewWorkflow?: GlobalOperatorReviewWorkflow;
    execution: {
      sync: {
        state: "disabled" | "globally_enabled";
        summary: string;
      };
      retention: {
        state: "dry_run" | "globally_enabled";
        summary: string;
      };
    };
    rebuild: {
      state:
        | "blocked"
        | "quota_limited"
        | "cold_bootstrap"
        | "backfill_in_progress"
        | "partial_upstream_coverage"
        | "ready";
      coldBootstrap: boolean;
      backfillInProgress: boolean;
      quotaLimited: boolean;
      partialUpstreamCoverage: boolean;
      blocked: boolean;
      summary: string;
    };
  } | null;
  operations?: {
    currentMode: GoogleAdsPanelRecoveryMode;
    globalExtendedExecutionEnabled: boolean;
    quotaPressure: number;
    breakerState: "open" | "half_open" | "closed";
    decisionEngineV2Enabled?: boolean;
    writebackEnabled?: boolean;
    statusDegraded?: boolean;
    statusDegradedReason?: string | null;
    extendedRecoveryBlockReason?: string | null;
    googleWorkerHealthy?: boolean;
    googleHeartbeatAgeMs?: number | null;
    googleRunnerLeaseActive?: boolean;
    fullSyncPriorityRequired?: boolean;
    fullSyncPriorityReason?: string | null;
    advisorReadinessModel?: string;
    advisorReadinessWindowDays?: number;
    advisorSnapshotReady?: boolean;
    advisorSnapshotAsOfDate?: string | null;
    advisorSnapshotFresh?: boolean;
    advisorSnapshotBlockedReason?: string | null;
    advisorSurfacePartitionStates?: Array<{
      surface: string;
      totalPartitions: number;
      queuedPartitions: number;
      leasedPartitions: number;
      runningPartitions: number;
      succeededPartitions: number;
      failedPartitions: number;
      deadLetterPartitions: number;
      cancelledPartitions: number;
      succeededEmptyPartitions: number;
      latestUpdatedAt: string | null;
      latestError: string | null;
    }>;
    advisorActionContractVersion?: string | null;
    advisorActionContractSource?: "native" | "compatibility_derived" | null;
    advisorAggregateTopQueryWeeklyAvailable?: boolean;
    advisorAggregateClusterDailyAvailable?: boolean;
    advisorAggregateQueryWeeklyRows?: number | null;
    advisorAggregateClusterDailyRows?: number | null;
    retentionRuntimeAvailable?: boolean;
    retentionExecutionEnabled?: boolean;
    retentionMode?: "dry_run" | "execute";
    retentionGateReason?: string | null;
    lastRetentionRunAt?: string | null;
    lastRetentionRunMode?: "dry_run" | "execute" | null;
    lastRetentionRunDeletedRows?: number | null;
    writebackPilotEnabled?: boolean;
    semiAutonomousBundlesEnabled?: boolean;
    controlledAutonomyEnabled?: boolean;
    autonomyKillSwitchActive?: boolean;
    manualApprovalRequired?: boolean;
    operatorOverrideEnabled?: boolean;
    autonomyAllowlist?: string[];
    autonomyBusinessAllowlist?: string[];
    autonomyAccountAllowlist?: string[];
    autonomyBusinessAllowed?: boolean;
    autonomyAccountAllowed?: boolean;
    semiAutonomousEligible?: boolean;
    controlledAutonomyEligible?: boolean;
    autonomyBlockedReasons?: string[];
    bundleCooldownHours?: number | null;
    activityState?: ProviderActivityState;
    staleRunPressure?: number;
    progressState?: "ready" | "syncing" | "partial_progressing" | "partial_stuck" | "blocked";
    extendedSuppressionDecisionTrace?: Record<string, unknown> | null;
    lastTargetedRepair?: {
      scope: string | null;
      triggerSource: string | null;
      finishedAt: string | null;
      status: string | null;
      lastError: string | null;
    } | null;
    lastAutoRepair?: {
      scope: string | null;
      triggerSource: string | null;
      finishedAt: string | null;
      status: string | null;
      lastError: string | null;
    } | null;
    lastAutoRepairOutcome?: "completed" | "failed" | "running" | "queued" | "unknown" | null;
    lastAutoRepairTriggerSource?: string | null;
    recentGapCountByScope?: Record<string, number>;
    recentGapRepairingByScope?: Record<string, boolean>;
    recentGapLastAttemptAtByScope?: Record<string, string | null>;
    recentGapQueuedByScope?: Record<string, number>;
    recentGapLeasedByScope?: Record<string, number>;
    recentGapSucceededByScope?: Record<string, number>;
    recentGapFailedByScope?: Record<string, number>;
    lastAutoRepairAttemptByScope?: Record<string, string | null>;
    autoRepairExecutionStage?: "not_planned" | "planned_not_leased" | "leased_not_completed" | "completed_state_stale" | "completed" | "runtime_waiting" | "failed" | null;
    blockingReasons?: ProviderBlockingReason[];
    repairableActions?: ProviderRepairableAction[];
    requiredCoverage?: ProviderRequiredCoverage | null;
    runtimeProgress?: GoogleAdsRuntimeProgressState | null;
    backgroundBackfill?: GoogleAdsBackgroundBackfillState | null;
    secondaryReadiness?: ProviderSecondaryReadiness[];
    stallFingerprints?: ProviderStallFingerprint[];
    workerBuildId?: string | null;
    workerStartedAt?: string | null;
    lastWorkerHeartbeatAt?: string | null;
    workerFreshnessState?: "online" | "stale" | "stopped" | "staged" | null;
    currentWorkerBusinessId?: string | null;
    workerBatchBusinessIds?: string[];
    currentConsumeStage?: string | null;
    lastConsumedBusinessId?: string | null;
    lastConsumeFinishedAt?: string | null;
    runtimeMismatchDetected?: boolean;
    lastConsumeAttemptAt?: string | null;
    lastConsumeOutcome?: string | null;
    lastLeaseAcquiredAt?: string | null;
    lastProgressAt?: string | null;
    lastFailureReason?: string | null;
  } | null;
  panel?: {
    coreUsable: boolean;
    extendedLimited: boolean;
    recentExtendedUsable?: boolean;
    headline: string;
    detail: string;
    surfaceStates: GoogleAdsPanelSurfaceState[];
  } | null;
  domains?: {
    core: GoogleAdsStatusDomainSummary;
    selectedRange: GoogleAdsStatusDomainSummary;
    advisor: GoogleAdsStatusDomainSummary;
  } | null;
  extendedRecoveryState?: "core_only" | "extended_recovery" | "extended_normal" | null;
  recentExtendedReady?: boolean;
  historicalExtendedReady?: boolean;
  extendedRecentReadyThroughDate?: string | null;
  rangeCompletionBySurface?: Record<
    string,
    {
      selectedRange: GoogleAdsExtendedRangeCompletion;
      historical: GoogleAdsExtendedRangeCompletion;
    }
  > | null;
  advisorProgress?: GoogleAdsProgressState | null;
  historicalProgress?: GoogleAdsProgressState | null;
  latestSync?: GoogleAdsSyncDetails | null;
}
