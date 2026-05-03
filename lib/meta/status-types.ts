import type {
  ProviderCheckpointHealth,
  ProviderDomainReadiness,
  ProviderReadinessLevel,
  ProviderSurfaceSummary,
} from "@/lib/provider-readiness";
import type {
  MetaDirtyRecentReason,
  MetaSyncPhaseTimingSummary,
  MetaSelectedRangeTruthReadiness,
} from "@/lib/meta/warehouse-types";
import type {
  ProviderActivityState,
  ProviderBlockingReason,
  ProviderProgressEvidence,
  ProviderRepairableAction,
  ProviderRequiredCoverage,
  ProviderSecondaryReadiness,
  SyncBlockerClass,
  SyncTruthState,
  ProviderStallFingerprint,
} from "@/lib/sync/provider-status-truth";
import type { RuntimeContract, RuntimeRegistryStatus } from "@/lib/sync/runtime-contract";
import type { SyncGateRecord } from "@/lib/sync/release-gates";
import type { SyncRepairPlanRecord } from "@/lib/sync/repair-planner";
import type { SyncRepairExecutionRecord, SyncRepairExecutionSummary } from "@/lib/sync/remediation-executions";
import type { SyncLagMetrics } from "@/lib/sync/lag-metrics";
import type { SyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import type { SyncControlPlanePersistenceStatus } from "@/lib/sync/control-plane-persistence";

export interface MetaSyncDetails {
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

export type MetaPageReadinessState =
  | "ready"
  | "partial"
  | "syncing"
  | "blocked"
  | "not_connected";

export type MetaPageSelectedRangeMode =
  | "current_day_live"
  | "historical_warehouse"
  | "historical_live_fallback";

export type MetaPageSurfaceTruthClass =
  | "historical_warehouse"
  | "historical_live_fallback"
  | "current_day_live"
  | "conditional_drilldown"
  | "deterministic_decision_engine";

export type MetaPageSurfaceKey =
  | "summary"
  | "campaigns"
  | "breakdowns.age"
  | "breakdowns.location"
  | "breakdowns.placement"
  | "adsets"
  | "recommendations"
  | "operating_mode"
  | "decision_os";

export type MetaCoreSurfaceKey = "summary" | "campaigns";
export type MetaExtendedSurfaceKey =
  | "breakdowns.age"
  | "breakdowns.location"
  | "breakdowns.placement";

export interface MetaSurfaceReadiness {
  state: MetaPageReadinessState;
  blocking: boolean;
  countsForPageCompleteness: boolean;
  truthClass: MetaPageSurfaceTruthClass;
  reason: string | null;
}

export interface MetaPageReadiness {
  state: MetaPageReadinessState;
  usable: boolean;
  complete: boolean;
  selectedRangeMode: MetaPageSelectedRangeMode;
  reason: string | null;
  missingRequiredSurfaces: MetaPageSurfaceKey[];
  requiredSurfaces: Record<
    "summary" | "campaigns" | "breakdowns.age" | "breakdowns.location" | "breakdowns.placement",
    MetaSurfaceReadiness
  >;
  optionalSurfaces: Record<
    "adsets" | "recommendations" | "operating_mode" | "decision_os",
    MetaSurfaceReadiness
  >;
}

export interface MetaCoreReadiness {
  state: MetaPageReadinessState;
  usable: boolean;
  complete: boolean;
  percent: number;
  reason: string | null;
  summary: string | null;
  missingSurfaces: MetaCoreSurfaceKey[];
  blockedSurfaces: MetaCoreSurfaceKey[];
  surfaces: Record<MetaCoreSurfaceKey, MetaSurfaceReadiness>;
}

export interface MetaExtendedCompleteness {
  state: MetaPageReadinessState;
  complete: boolean;
  percent: number | null;
  reason: string | null;
  summary: string | null;
  missingSurfaces: MetaExtendedSurfaceKey[];
  blockedSurfaces: MetaExtendedSurfaceKey[];
  surfaces: Record<MetaExtendedSurfaceKey, MetaSurfaceReadiness>;
}

export type MetaIntegrationSummaryState =
  | "ready"
  | "working"
  | "waiting"
  | "blocked";

export type MetaIntegrationSummaryScope =
  | "recent_window"
  | "selected_range"
  | "current_day"
  | "not_applicable";

export type MetaIntegrationSummaryStageKey =
  | "connection"
  | "queue_worker"
  | "core_data"
  | "priority_window"
  | "extended_surfaces"
  | "attention";

export type MetaIntegrationSummaryStageCode =
  | "connected"
  | "queue_clear"
  | "queue_active"
  | "queue_waiting"
  | "queue_blocked"
  | "queue_stale"
  | "core_ready"
  | "core_preparing"
  | "core_waiting"
  | "core_blocked"
  | "recent_window_ready"
  | "recent_window_preparing"
  | "recent_window_waiting"
  | "selected_range_ready"
  | "selected_range_preparing"
  | "selected_range_waiting"
  | "selected_range_blocked"
  | "current_day_ready"
  | "current_day_preparing"
  | "current_day_waiting"
  | "current_day_blocked"
  | "extended_ready"
  | "breakdowns_preparing"
  | "recent_extended_preparing"
  | "historical_extended_preparing"
  | "extended_waiting"
  | "extended_blocked"
  | "attention_needed"
  | "recovery_running"
  | "recovery_available"
  | "progress_stale";

export interface MetaIntegrationSummaryStageEvidence {
  assignedAccountCount?: number;
  primaryTimezone?: string | null;
  queueDepth?: number;
  leasedPartitions?: number;
  retryableFailedPartitions?: number;
  deadLetterPartitions?: number;
  readyThroughDate?: string | null;
  oldestStoredDate?: string | null;
  completedDays?: number;
  totalDays?: number;
  pendingSurfaceCount?: number;
  pendingSurfaces?: string[];
  blockerCount?: number;
  blockerCodes?: string[];
  repairSignalCount?: number;
  repairActionKinds?: string[];
  stallFingerprintCount?: number;
}

export interface MetaIntegrationSummaryStage {
  key: MetaIntegrationSummaryStageKey;
  state: MetaIntegrationSummaryState;
  percent: number | null;
  code: MetaIntegrationSummaryStageCode;
  evidence: MetaIntegrationSummaryStageEvidence | null;
}

export interface MetaIntegrationSummary {
  visible: boolean;
  state: MetaIntegrationSummaryState;
  scope: MetaIntegrationSummaryScope;
  attentionNeeded: boolean;
  stages: MetaIntegrationSummaryStage[];
}

export interface MetaStatusResponse {
  state:
    | "not_connected"
    | "connected_no_assignment"
    | "syncing"
    | "partial"
    | "stale"
    | "paused"
    | "action_required"
    | "ready";
  connected: boolean;
  readinessLevel?: ProviderReadinessLevel;
  surfaces?: ProviderSurfaceSummary;
  checkpointHealth?: ProviderCheckpointHealth | null;
  phaseTimings?: {
    windowHours: number;
    phases: MetaSyncPhaseTimingSummary[];
  } | null;
  runtimeContract?: RuntimeContract | null;
  runtimeRegistry?: RuntimeRegistryStatus | null;
  controlPlaneIdentity?: SyncControlPlaneKey | null;
  controlPlanePersistence?: SyncControlPlanePersistenceStatus | null;
  controlPlaneErrors?: {
    syncGates: string | null;
    repairPlan: string | null;
    controlPlanePersistence: string | null;
    syncIncidents: string | null;
  } | null;
  deployGate?: SyncGateRecord | null;
  releaseGate?: SyncGateRecord | null;
  repairPlan?: SyncRepairPlanRecord | null;
  remediationSummary?: SyncRepairExecutionSummary | null;
  latestRemediationExecution?: SyncRepairExecutionRecord | null;
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
  domainReadiness?: ProviderDomainReadiness | null;
  assignedAccountIds: string[];
  primaryAccountTimezone?: string | null;
  currentDateInTimezone?: string | null;
  d1TargetDate?: string | null;
  d1FinalizeState?: "ready" | "processing" | "blocked" | null;
  d1BlockedReason?: string | null;
  dataContract?: {
    todayMode: "live_only";
    historicalInsideHorizon: "published_verified_truth";
    historicalOutsideCoreHorizon: "live_fallback";
    breakdownOutsideHorizon: "unsupported_degraded";
  };
  platformDateBoundary?: {
    primaryAccountId: string | null;
    primaryAccountTimezone: string | null;
    currentDateInTimezone: string | null;
    previousDateInTimezone: string | null;
    selectedRangeMode:
      | "current_day_live"
      | "historical_warehouse"
      | "historical_live_fallback";
    mixedCurrentDates: boolean;
    accounts: Array<{
      provider: "meta";
      businessId: string;
      providerAccountId: string | null;
      timeZone: string;
      currentDate: string;
      previousDate: string;
      isPrimary: boolean;
    }>;
  };
  completionBasis?: {
    requiredScopes: string[];
    excludedScopes: string[];
    percent: number;
    complete: boolean;
  };
  completionBlockers?: string[];
  requiredScopeCompletion?: ProviderRequiredCoverage | null;
  currentCoreProgressPercent?: number;
  historicalArchiveProgressPercent?: number;
  currentCoreUsable?: boolean;
  historicalArchiveComplete?: boolean;
  coreReadiness?: MetaCoreReadiness | null;
  extendedCompleteness?: MetaExtendedCompleteness | null;
  needsBootstrap?: boolean;
  operatorTruth?: {
    rolloutModel: "global";
    reviewWorkflow?: GlobalOperatorReviewWorkflow;
    execution: {
      authoritativeFinalization: {
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
        | "repair_required"
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
      repairRequired: boolean;
      summary: string;
    };
    protectedPublishedTruth?: {
      state:
        | "present"
        | "publication_missing"
        | "rebuild_incomplete"
        | "none_visible"
        | "unavailable";
      hasNonZeroProtectedPublishedRows: boolean;
      protectedPublishedRows: number;
      activePublicationPointerRows: number;
      summary: string;
    };
  } | null;
  warehouse?: {
    rowCount: number;
    firstDate: string | null;
    lastDate: string | null;
    coverage?: {
      historical?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        oldestStoredDate?: string | null;
      } | null;
      selectedRange?: {
        startDate: string;
        endDate: string;
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        isComplete: boolean;
        oldestStoredDate?: string | null;
      } | null;
      scopes?: Array<{
        scope: string;
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        oldestStoredDate?: string | null;
        latestBackgroundActivityAt: string | null;
        deadLetterCount: number;
      }>;
      accountDaily?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        oldestStoredDate?: string | null;
      } | null;
      campaignDaily?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        oldestStoredDate?: string | null;
      } | null;
      adsetDaily?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        oldestStoredDate?: string | null;
      } | null;
      breakdowns?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        oldestStoredDate?: string | null;
      } | null;
      breakdownsBySurface?: {
        age: {
          completedDays: number;
          totalDays: number;
          readyThroughDate: string | null;
          oldestStoredDate?: string | null;
          isComplete: boolean;
          supportStartDate?: string | null;
          isBlocked?: boolean;
        };
        location: {
          completedDays: number;
          totalDays: number;
          readyThroughDate: string | null;
          oldestStoredDate?: string | null;
          isComplete: boolean;
          supportStartDate?: string | null;
          isBlocked?: boolean;
        };
        placement: {
          completedDays: number;
          totalDays: number;
          readyThroughDate: string | null;
          oldestStoredDate?: string | null;
          isComplete: boolean;
          supportStartDate?: string | null;
          isBlocked?: boolean;
        };
      } | null;
      creatives?: {
        completedDays: number;
        totalDays: number;
        readyThroughDate: string | null;
        oldestStoredDate?: string | null;
        previewReadyRows?: number;
        totalRows?: number;
        previewReadyPercent?: number;
      } | null;
      pendingSurfaces?: string[];
    } | null;
  } | null;
  jobHealth?: {
    runningJobs: number;
    staleRunningJobs: number;
    queueDepth?: number;
    leasedPartitions?: number;
    retryableFailedPartitions?: number;
    deadLetterPartitions?: number;
    oldestQueuedPartition?: string | null;
    latestCoreActivityAt?: string | null;
    latestExtendedActivityAt?: string | null;
    latestMaintenanceActivityAt?: string | null;
    historicalCoreQueueDepth?: number;
    historicalCoreLeasedPartitions?: number;
    extendedRecentQueueDepth?: number;
    extendedRecentLeasedPartitions?: number;
    extendedHistoricalQueueDepth?: number;
    extendedHistoricalLeasedPartitions?: number;
  } | null;
  operations?: {
    workerHealthy?: boolean;
    heartbeatAgeMs?: number | null;
    runnerLeaseActive?: boolean;
    ownerWorkerId?: string | null;
    consumeStage?: string | null;
    staleRunPressure?: number;
    blockReason?: string | null;
    progressState?: "ready" | "syncing" | "partial_progressing" | "partial_stuck" | "blocked";
    activityState?: ProviderActivityState;
    syncTruthState?: SyncTruthState | null;
    blockerClass?: SyncBlockerClass | null;
    progressEvidence?: ProviderProgressEvidence | null;
    blockingReasons?: ProviderBlockingReason[];
    repairableActions?: ProviderRepairableAction[];
    requiredCoverage?: ProviderRequiredCoverage | null;
    secondaryReadiness?: ProviderSecondaryReadiness[];
    stallFingerprints?: ProviderStallFingerprint[];
    queueSummary?: {
      historicalCoreQueued: number;
      maintenanceQueued: number;
      extendedRecentQueued: number;
      extendedHistoricalQueued: number;
    } | null;
    providerWorker?: {
      workerId: string | null;
      freshnessState: "online" | "stale" | "stopped" | null;
      lastHeartbeatAt: string | null;
    } | null;
    businessWorker?: {
      workerId: string | null;
      freshnessState: "online" | "stale" | "stopped" | null;
      lastHeartbeatAt: string | null;
      currentBusinessId: string | null;
    } | null;
    lagMetrics?: SyncLagMetrics | null;
    retentionRuntimeAvailable?: boolean;
    retentionExecutionEnabled?: boolean;
    retentionMode?: "dry_run" | "execute";
    retentionGateReason?: string | null;
    retentionDefaultExecutionDisabled?: boolean;
    latestRetentionRunAt?: string | null;
    latestRetentionRunMode?: "dry_run" | "execute" | null;
    retentionLatestRunObserved?: boolean;
  } | null;
  retention?: {
    runtimeAvailable: boolean;
    executionEnabled: boolean;
    defaultExecutionDisabled: boolean;
    mode: "dry_run" | "execute";
    gateReason: string;
    policy: {
      coreDailyAuthoritativeDays: number;
      breakdownDailyAuthoritativeDays: number;
      currentDay: "live_only";
      historicalInsideHorizon: "published_verified_truth_only";
      historicalOutsideCoreHorizon: "live_fallback_unchanged";
      breakdownOutsideHorizon: "unsupported_degraded";
    };
    latestRun: {
      id: string;
      finishedAt: string | null;
      executionMode: "dry_run" | "execute";
      skippedDueToActiveLease: boolean;
      totalDeletedRows: number;
      errorMessage: string | null;
    } | null;
    summary: {
      observedTables: number;
      tablesWithDeletableRows: number;
      tablesWithProtectedRows: number;
      deletableRows: number;
      retainedRows: number;
      protectedRows: number;
    } | null;
    tables: Array<{
      tier: "core_authoritative" | "breakdown_authoritative";
      label: string;
      tableName: string;
      summaryKey: string;
      retentionDays: number;
      cutoffDate: string;
      surfaceFilter: Array<
        "account_daily" | "campaign_daily" | "adset_daily" | "ad_daily" | "breakdown_daily"
      > | null;
      observed: boolean;
      deletableRows: number | null;
      deletableDistinctDays: number | null;
      oldestDeletableValue: string | null;
      newestDeletableValue: string | null;
      retainedRows: number | null;
      latestRetainedValue: string | null;
      protectedRows: number | null;
      protectedDistinctDays: number | null;
      latestProtectedValue: string | null;
      deletedRows: number;
    }>;
  } | null;
  protectedPublishedTruth?: {
    state:
      | "present"
      | "publication_missing"
      | "rebuild_incomplete"
      | "none_visible"
      | "unavailable";
    runtimeAvailable: boolean;
    asOfDate: string | null;
    hasNonZeroProtectedPublishedRows: boolean;
    protectedPublishedRows: number;
    activePublicationPointerRows: number;
    protectedTruthClassesPresent: Array<
      | "core_daily_rows"
      | "breakdown_daily_rows"
      | "active_publication_pointers"
      | "active_published_slice_versions"
      | "active_source_manifests"
      | "published_day_state"
    >;
    protectedTruthClassesAbsent: Array<
      | "core_daily_rows"
      | "breakdown_daily_rows"
      | "active_publication_pointers"
      | "active_published_slice_versions"
      | "active_source_manifests"
      | "published_day_state"
    >;
    summary: string;
    classes: Array<{
      key:
        | "core_daily_rows"
        | "breakdown_daily_rows"
        | "active_publication_pointers"
        | "active_published_slice_versions"
        | "active_source_manifests"
        | "published_day_state";
      label: string;
      present: boolean;
      observed: boolean;
      protectedRows: number;
      latestProtectedValue: string | null;
    }>;
  } | null;
  extendedRecoveryState?: "core_only" | "extended_recovery" | "extended_normal" | null;
  recentExtendedReady?: boolean;
  historicalExtendedReady?: boolean;
  recentExtendedUsable?: boolean;
  rangeCompletionBySurface?: Record<
    "account_daily" | "campaign_daily" | "adset_daily" | "creative_daily" | "ad_daily",
    {
      recentCompletedDays: number;
      recentTotalDays: number;
      historicalCompletedDays: number;
      historicalTotalDays: number;
      readyThroughDate: string | null;
      oldestStoredDate?: string | null;
    }
  >;
  priorityWindow?: {
    startDate: string;
    endDate: string;
    completedDays: number;
    totalDays: number;
    isActive: boolean;
  } | null;
  selectedRangeTruth?: MetaSelectedRangeTruthReadiness & {
    blockingReasons: MetaDirtyRecentReason[];
  } | null;
  latestSync?: MetaSyncDetails | null;
  currentDayLive?: {
    summaryAvailable: boolean;
    campaignsAvailable: boolean;
  } | null;
  pageReadiness?: MetaPageReadiness | null;
  integrationSummary?: MetaIntegrationSummary | null;
}
import type { GlobalOperatorReviewWorkflow } from "@/lib/global-operator-review";
