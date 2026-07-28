"use client";

import { useEffect, useState } from "react";
import Link from "next/link";
import { RefreshCw } from "lucide-react";
import { InlineHelp } from "@/components/admin/inline-help";
import { formatMetaDateTime } from "@/lib/meta/ui";
import { getSyncRunbook } from "@/lib/sync/runbooks";
import type { GlobalRebuildTruthReview } from "@/lib/rebuild-truth-review";
import type { SyncEffectivenessReview } from "@/lib/sync-effectiveness-review";

interface SyncIssueRow {
  businessId: string;
  businessName: string;
  provider: "google_ads" | "meta" | "ga4" | "search_console";
  reportType: string;
  severity?: "critical" | "high" | "medium";
  runbookKey?: string | null;
  status: "failed" | "running" | "cooldown";
  detail: string;
  triggeredAt: string | null;
  completedAt: string | null;
}

/**
 * Mirrors `GoogleAdsFreshnessSummary` from `@/lib/google-ads/freshness-read`,
 * declared locally in the file's existing style so a client component never
 * reaches into a server module. The states are deliberately the same five: this
 * page must render the verdict the scheduler acted on, not its own reading of
 * the same numbers.
 */
interface GoogleAdsFreshnessScopeSummaryView {
  scope: string;
  state: "unknown" | "missing" | "provisional" | "converging" | "settled";
  label: string;
  percent: number;
  complete: boolean;
  mayStopPolling: boolean;
  detail: string;
  coveredDays: number;
  postCloseObservedDays: number;
  lookbackExhaustedDays: number;
  dueNowDays: number;
  oldestObservationAt: string | null;
  latestObservationAt: string | null;
}

interface GoogleAdsFreshnessSummaryView {
  evidenceAvailable: boolean;
  unavailableReason: string | null;
  state: "unknown" | "missing" | "provisional" | "converging" | "settled";
  label: string;
  percent: number;
  complete: boolean;
  mayStopPolling: boolean;
  detail: string;
  startDate: string;
  endDate: string;
  totalDays: number;
  includesOpenDay: boolean;
  timeZoneSource: "account" | "default";
  conversionLookbackDays: number;
  scopes: GoogleAdsFreshnessScopeSummaryView[];
}

interface SyncHealthPayload {
  globalRebuildReview?: GlobalRebuildTruthReview;
  syncEffectivenessReview?: SyncEffectivenessReview;
  runtimeContract?: {
    buildId: string;
    dbFingerprint: string;
    configFingerprint: string;
    validation: {
      pass: boolean;
      issues: Array<{
        code: string;
        severity: "error" | "warning";
        message: string;
      }>;
    };
  } | null;
  runtimeRegistry?: {
    contractValid: boolean;
    webPresent: boolean;
    workerPresent: boolean;
    dbFingerprintMatch: boolean;
    configFingerprintMatch: boolean;
    issues: string[];
  } | null;
  deployGate?: {
    verdict: "pass" | "fail" | "misconfigured" | "measure_only" | "warn_only" | "blocked";
    mode: "measure_only" | "warn_only" | "block";
    breakGlass: boolean;
    overrideReason: string | null;
    summary: string;
    gateScope?: "runtime_contract" | "service_liveness" | "release_readiness";
  } | null;
  releaseGate?: {
    verdict: "pass" | "fail" | "misconfigured" | "measure_only" | "warn_only" | "blocked";
    mode: "measure_only" | "warn_only" | "block";
    breakGlass: boolean;
    overrideReason: string | null;
    summary: string;
    gateScope?: "runtime_contract" | "service_liveness" | "release_readiness";
  } | null;
  repairPlan?: {
    id?: string | null;
    eligible: boolean;
    blockedReason: string | null;
    breakGlass: boolean;
    summary: string;
    recommendations: Array<{
      businessId: string;
      businessName: string | null;
      recommendedAction: string;
      safetyClassification: "safe_idempotent" | "safe_guarded" | "blocked";
    }>;
  } | null;
  remediationSummary?: {
    latestStartedAt: string | null;
    latestFinishedAt: string | null;
    improvedAny: boolean;
    businessCount: number;
    counts: {
      cleared: number;
      improving_not_cleared: number;
      no_change: number;
      worse: number;
      manual_follow_up_required: number;
      locked: number;
    };
  } | null;
  googleAdsHealthStatus?: "ok" | "degraded" | "failed";
  googleAdsHealthError?: string | null;
  dbDiagnostics?: {
    sampledAt: string;
    web: {
      runtime: "web" | "worker";
      applicationName: string;
      settings: {
        poolMax: number;
        queryTimeoutMs: number;
        connectionTimeoutMs: number;
        idleTimeoutMs: number;
        maxLifetimeSeconds: number | null;
        retryAttempts: number;
        retryBackoffMs: number;
        retryMaxBackoffMs: number;
      };
      pool: {
        totalCount: number;
        idleCount: number;
        waitingCount: number;
        utilizationPercent: number;
        saturationState: "idle" | "busy" | "saturated";
        maxObservedWaitingCount: number;
      };
      counters: {
        timeoutCount: number;
        retryableErrorCount: number;
        connectionErrorCount: number;
      };
      lastError: {
        at: string;
        code: string | null;
        message: string;
      } | null;
    } | null;
    workers: Array<{
      workerId?: string | null;
      providerScope?: string | null;
      workerStatus?: string | null;
      lastHeartbeatAt?: string | null;
      applicationName: string;
      settings: {
        poolMax: number;
        queryTimeoutMs: number;
        connectionTimeoutMs: number;
        idleTimeoutMs: number;
        maxLifetimeSeconds: number | null;
        retryAttempts: number;
        retryBackoffMs: number;
        retryMaxBackoffMs: number;
      };
      pool: {
        totalCount: number;
        idleCount: number;
        waitingCount: number;
        utilizationPercent: number;
        saturationState: "idle" | "busy" | "saturated";
        maxObservedWaitingCount: number;
      };
      counters: {
        timeoutCount: number;
        retryableErrorCount: number;
        connectionErrorCount: number;
      };
      lastError: {
        at: string;
        code: string | null;
        message: string;
      } | null;
    }>;
    summary: {
      webPressureState: "healthy" | "elevated" | "saturated" | "unknown";
      workerPressureState: "healthy" | "elevated" | "saturated" | "unknown";
      metaBacklogState: "clear" | "draining" | "stalled";
      likelyPrimaryConstraint:
        | "none"
        | "db"
        | "worker_unavailable"
        | "scheduler_or_queue"
        | "mixed"
        | "unknown";
      headline: string;
      evidence: string[];
      workerCount: number;
      metaQueueDepth: number;
      metaLeasedPartitions: number;
      workerCurrentPoolWaiters: number;
      workerMaxObservedPoolWaiters: number;
      workerTimeoutCount: number;
      workerRetryableErrorCount: number;
      workerConnectionErrorCount: number;
    };
  };
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
    googleAdsIntegrityIncidentCount?: number;
    googleAdsIntegrityBlockedCount?: number;
    metaIntegrityIncidentCount?: number;
    metaIntegrityBlockedCount?: number;
    metaD1FinalizeNonTerminalCount?: number;
    syncTruthState?: string | null;
    blockerClass?: string | null;
    googleAdsFreshnessState?: GoogleAdsFreshnessSummaryView["state"];
    googleAdsFreshnessLabel?: string;
    googleAdsFreshnessPercent?: number;
    googleAdsFreshnessComplete?: boolean;
    googleAdsFreshnessMayStopPolling?: boolean;
    googleAdsFreshnessDetail?: string;
    googleAdsFreshnessEvidenceAvailable?: boolean;
    googleAdsFreshnessRetryable?: boolean;
    googleAdsFreshnessBusinessesNotSettled?: number;
  };
  issues: SyncIssueRow[];
  workerHealth?: {
    onlineWorkers: number;
    workerInstances: number;
    lastHeartbeatAt: string | null;
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
      lastConsumeOutcome?: string | null;
      lastConsumeFinishedAt?: string | null;
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
    skippedActiveLeaseRecoveries?: number;
    leaseConflictRuns24h?: number;
    lastReclaimReason?: string | null;
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
    integrityIncidentCount?: number;
    integrityBlockedCount?: number;
    googleAdsFreshness?: GoogleAdsFreshnessSummaryView;
  }>;
  metaBusinesses?: Array<{
    businessId: string;
    businessName: string;
    queueDepth: number;
    leasedPartitions: number;
    retryableFailedPartitions: number;
    deadLetterPartitions: number;
    replayableDeadLetterPartitions?: number;
    terminalActionRequiredDeadLetterPartitions?: number;
    unknownDeadLetterPartitions?: number;
    deadLetterRecovery?: {
      total: number;
      replayableTransient: number;
      terminalActionRequired: number;
      unknown: number;
      latest: Array<{
        id: string;
        businessId: string;
        lane: string;
        scope: string;
        source: string | null;
        partitionDate: string;
        lastError: string | null;
        errorClass: string | null;
        recoveryKind: "replayable_transient" | "terminal_action_required" | "unknown";
        actionRequired: boolean;
        reasonCode: string;
      }>;
    } | null;
    staleLeasePartitions: number;
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
    skippedActiveLeaseRecoveries?: number;
    staleRunCount24h?: number;
    lastReclaimReason?: string | null;
    effectiveMode?: "core_only" | "extended_recovery" | "extended_normal";
    recentAccountCompletedDays?: number;
    recentAdsetCompletedDays?: number;
    recentCreativeCompletedDays?: number;
    recentAdCompletedDays?: number;
    recentRangeTotalDays?: number;
    recentExtendedReady?: boolean;
    historicalExtendedReady?: boolean;
    progressState?: "ready" | "syncing" | "partial_progressing" | "partial_stuck" | "blocked";
    activityState?: "ready" | "busy" | "waiting" | "stalled" | "blocked";
    progressEvidence?: {
      lastCheckpointAdvancedAt: string | null;
      lastReadyThroughAdvancedAt: string | null;
      lastCompletedAt: string | null;
      backlogDelta: number | null;
      completedPartitionDelta: number | null;
      lastReplayAt: string | null;
      lastReclaimAt: string | null;
      recentActivityWindowMinutes?: number;
    } | null;
    workerOnline?: boolean;
    workerLastHeartbeatAt?: string | null;
    workerFreshnessState?: "online" | "stale" | "stopped" | null;
    workerId?: string | null;
    workerConsumeStage?: string | null;
    integrityIncidentCount?: number;
    integrityBlockedCount?: number;
    d1FinalizeNonTerminalCount?: number;
    validationFailures24h?: number;
    phaseTimings?: {
      windowHours: number;
      phases: Array<{
        phase: "fetch_raw" | "transform" | "bulk_upsert" | "finalize" | "publish";
        runCount: number;
        timingScope: string | null;
        latestFinishedAt: string | null;
        latestDurationMs: number | null;
        avgDurationMs: number | null;
        p50DurationMs: number | null;
        p95DurationMs: number | null;
        maxDurationMs: number | null;
        throughputBasis: "rows_fetched" | "rows_written";
        latestRowsFetched: number;
        latestRowsWritten: number;
        latestRowsPerSecond: number | null;
        p50RowsPerSecond: number | null;
      }>;
    } | null;
    latestRemediationExecution?: {
      sourceReleaseGateId?: string | null;
      sourceRepairPlanId?: string | null;
      postRunReleaseGateId?: string | null;
      postRunRepairPlanId?: string | null;
      recommendedAction: string | null;
      executedAction: string | null;
      status: "running" | "completed" | "failed" | "locked";
      outcomeClassification:
        | "cleared"
        | "improving_not_cleared"
        | "no_change"
        | "worse"
        | "manual_follow_up_required"
        | "locked"
        | null;
      expectedOutcomeMet: boolean | null;
      startedAt: string;
      finishedAt: string | null;
      beforeEvidence: {
        queueDepth?: number;
        truthReady?: boolean | null;
        activityState?: string | null;
        lastSuccessfulPublishAt?: string | null;
        recentSelectedRangePercent?: number;
        priorityWindowPercent?: number;
      };
      afterEvidence: {
        queueDepth?: number;
        truthReady?: boolean | null;
        activityState?: string | null;
        lastSuccessfulPublishAt?: string | null;
        recentSelectedRangePercent?: number;
        priorityWindowPercent?: number;
      };
    } | null;
  }>;
}

function providerLabel(provider: SyncIssueRow["provider"]) {
  if (provider === "google_ads") return "Google Ads";
  if (provider === "meta") return "Meta";
  if (provider === "search_console") return "Search Console";
  return "GA4";
}

function formatRemediationOutcome(
  outcome:
    | "cleared"
    | "improving_not_cleared"
    | "no_change"
    | "worse"
    | "manual_follow_up_required"
    | "locked"
    | null
    | undefined,
) {
  if (!outcome) return "not_run";
  return outcome.replaceAll("_", " ");
}

function formatDateTime(value: string | null) {
  return formatMetaDateTime(value, "tr") ?? "—";
}

function formatDurationCompact(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "—";
  if (value >= 60_000) return `${(value / 60_000).toFixed(1)}m`;
  if (value >= 1_000) return `${(value / 1_000).toFixed(1)}s`;
  return `${Math.round(value)}ms`;
}

function formatRowsPerSecond(value: number | null | undefined) {
  if (value == null || !Number.isFinite(value) || value <= 0) return "—";
  if (value >= 1000) return `${(value / 1000).toFixed(1)}k/s`;
  return `${Math.round(value)}/s`;
}

function formatPhaseTimingLabel(
  timing: NonNullable<NonNullable<SyncHealthPayload["metaBusinesses"]>[number]["phaseTimings"]>["phases"][number]
) {
  const label =
    timing.phase === "fetch_raw"
      ? "fetch"
      : timing.phase === "bulk_upsert"
        ? "upsert"
        : timing.phase;
  const latestRows =
    timing.throughputBasis === "rows_fetched"
      ? timing.latestRowsFetched
      : timing.latestRowsWritten;
  return `${label} p50 ${formatDurationCompact(timing.p50DurationMs)} • latest ${formatDurationCompact(
    timing.latestDurationMs,
  )} • ${latestRows} rows @ ${formatRowsPerSecond(timing.latestRowsPerSecond)}`;
}

function getMetaBusinessSignals(business: NonNullable<SyncHealthPayload["metaBusinesses"]>[number]) {
  const signals: string[] = [];
  if (business.deadLetterPartitions > 0) signals.push("Dead letter present");
  if (business.retryableFailedPartitions > 0) signals.push("Retryable failed backlog");
  if (business.queueDepth > 0 && business.leasedPartitions === 0) {
    signals.push(
      business.workerOnline === false ? "Worker unavailable" : "Queue waiting for worker"
    );
  }
  if (business.staleLeasePartitions > 0) signals.push("Stale lease detected");
  if ((business.reclaimCandidateCount ?? 0) > 0) signals.push("Recent reclaim activity");
  if ((business.activeSlowPartitions ?? 0) > 0) signals.push("Active slow leases");
  if ((business.checkpointLagMinutes ?? 0) > 20) signals.push("Stale checkpoint");
  if (business.todayAccountRows === 0 || business.todayAdsetRows === 0) signals.push("Current day missing");
  if ((business.integrityBlockedCount ?? 0) > 0) signals.push("Canonical integrity blocked");
  if ((business.d1FinalizeNonTerminalCount ?? 0) > 0) signals.push("D-1 finalize incomplete");
  if (!business.recentExtendedReady) signals.push("Recent extended backfilling");
  if (business.stateRowCount === 0 && (business.queueDepth > 0 || business.leasedPartitions > 0 || business.deadLetterPartitions > 0)) {
    signals.push("State missing");
  }
  return signals;
}

function formatIssueType(issue: SyncIssueRow) {
  if (issue.provider !== "meta") return issue.reportType;
  if (issue.reportType === "queue_waiting_worker") return "queue waiting worker";
  if (issue.reportType === "stale_lease") return "stale lease";
  if (issue.reportType === "queue_dead_letter") return "dead letter present";
  if (issue.reportType === "state_missing") return "state missing";
  if (issue.reportType === "current_day_missing") return "current day missing";
  if (issue.reportType === "retryable_failed_backlog") return "retryable failed backlog";
  if (issue.reportType === "stale_checkpoint") return "stale checkpoint";
  if (issue.reportType === "integrity_blocked") return "integrity blocked";
  if (issue.reportType === "d1_finalize_nonterminal") return "D-1 finalize incomplete";
  return issue.reportType;
}

/**
 * The freshness verdict, rendered so only `settled` can look green.
 *
 * `unknown` gets amber, never red and never green: it means the evidence could
 * not be read, which is a reason to keep asking, not a completed sync and not a
 * permanent failure.
 */
function GoogleAdsFreshnessBadge({
  freshness,
}: {
  freshness: GoogleAdsFreshnessSummaryView | undefined;
}) {
  const state = freshness?.state ?? "unknown";
  const label = freshness?.label ?? "Unknown";
  const className =
    state === "settled"
      ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
      : state === "missing"
        ? "border border-red-200 bg-red-50 text-red-700"
        : "border border-amber-200 bg-amber-50 text-amber-800";
  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${className}`}>
      {label} {freshness ? `${freshness.percent}%` : ""}
    </span>
  );
}

function getGoogleAdsBusinessSignals(
  business: NonNullable<SyncHealthPayload["googleAdsBusinesses"]>[number]
) {
  const signals: string[] = [];
  // Freshness first: a business can have an empty queue, no dead letters and a
  // green worker while every day in the recent window was last read while it
  // was still open.
  const freshness = business.googleAdsFreshness;
  if (!freshness || !freshness.evidenceAvailable) {
    signals.push("Freshness unknown (retry)");
  } else if (!freshness.complete) {
    signals.push(`Not settled: ${freshness.label}`);
  }
  if ((business.actionRequiredDeadLetterPartitions ?? 0) > 0) {
    signals.push(
      `Reconnect required: ${(business.actionRequiredBlockingDeadLetterScopes?.length ? business.actionRequiredBlockingDeadLetterScopes : business.actionRequiredDeadLetterScopes ?? []).join(", ") || "Google Ads"}`
    );
  }
  if (business.circuitBreakerOpen) signals.push("Circuit breaker open");
  if ((business.extendedRecentQueueDepth ?? 0) > 0 && (business.extendedRecentLeasedPartitions ?? 0) === 0) {
    signals.push("Recent extended not leasing");
  }
  if ((business.extendedHistoricalQueueDepth ?? 0) > 0 && business.recoveryMode !== "closed") {
    signals.push("Historical recovery suspended");
  }
  if (business.extendedRecoveryBlockReason) signals.push(`Block: ${business.extendedRecoveryBlockReason}`);
  if ((business.integrityBlockedCount ?? 0) > 0) signals.push("Integrity blocked");
  if ((business.activeSlowPartitions ?? 0) > 0) signals.push("Active slow leases");
  return signals;
}

function formatDbConstraint(value: NonNullable<SyncHealthPayload["dbDiagnostics"]>["summary"]["likelyPrimaryConstraint"]) {
  if (value === "db") return "db ceiling";
  if (value === "worker_unavailable") return "worker unavailable";
  if (value === "scheduler_or_queue") return "scheduler/queue";
  if (value === "mixed") return "mixed";
  if (value === "none") return "none";
  return "unknown";
}

function formatDbSettingsCompact(settings: {
  poolMax: number;
  queryTimeoutMs: number;
  connectionTimeoutMs: number;
  idleTimeoutMs: number;
  maxLifetimeSeconds: number | null;
  retryAttempts: number;
}) {
  return `pool ${settings.poolMax} • query ${settings.queryTimeoutMs}ms • connect ${settings.connectionTimeoutMs}ms • idle ${settings.idleTimeoutMs}ms • life ${settings.maxLifetimeSeconds ?? "off"}s • retry ${settings.retryAttempts}`;
}

const SYNC_HELP: Record<string, string> = {
  "Failed 24h":
    "Background sync jobs that failed during the last 24 hours and need system-side attention.",
  Stuck:
    "Jobs still marked as running after the normal execution window, which usually means the sync is stuck.",
  Running:
    "Jobs currently executing right now. This is not an error by itself.",
  Cooldowns:
    "Provider requests temporarily paused after confirmed failures, rate limits, or repeated retries.",
};

export default function AdminSyncHealthPage() {
  const [payload, setPayload] = useState<SyncHealthPayload | null>(null);
  const [loading, setLoading] = useState(true);
  const [loadError, setLoadError] = useState<string | null>(null);
  const [actionState, setActionState] = useState<{
    businessId: string | null;
    action: string | null;
    message: string | null;
    error: string | null;
  }>({
    businessId: null,
    action: null,
    message: null,
    error: null,
  });

  useEffect(() => {
    let cancelled = false;
    fetch("/api/admin/sync-health")
      .then(async (response) => {
        const nextPayload = await response.json().catch(() => null);
        if (!response.ok) {
          throw new Error(
            (nextPayload as { message?: string } | null)?.message ??
              "Sync health could not be loaded."
          );
        }
        return nextPayload as SyncHealthPayload;
      })
      .then((nextPayload) => {
        if (cancelled) return;
        setPayload(nextPayload);
        setLoadError(null);
      })
      .catch((error: unknown) => {
        if (cancelled) return;
        setPayload(null);
        setLoadError(error instanceof Error ? error.message : "Sync health could not be loaded.");
      })
      .finally(() => {
        if (!cancelled) setLoading(false);
      });

    return () => {
      cancelled = true;
    };
  }, []);

  if (loading) {
    return <div className="rounded-xl border border-gray-200 bg-white px-5 py-10 text-sm text-gray-400">Yükleniyor...</div>;
  }

  if (loadError) {
    return <div className="rounded-xl border border-red-200 bg-red-50 px-5 py-4 text-sm text-red-700">{loadError}</div>;
  }

  const summary = payload?.summary ?? {
    impactedBusinesses: 0,
    runningJobs: 0,
    stuckJobs: 0,
    failedJobs24h: 0,
    activeCooldowns: 0,
    successJobs24h: 0,
    topIssue: null,
    googleAdsQueueDepth: undefined,
    googleAdsLeasedPartitions: undefined,
    googleAdsDeadLetterPartitions: undefined,
    googleAdsActionRequiredBusinessCount: 0,
    googleAdsActionRequiredPartitions: 0,
    googleAdsActionRequiredBlockingPartitions: 0,
    googleAdsActionRequiredScopes: [],
    googleAdsActionRequiredBlockingScopes: [],
    googleAdsOldestQueuedPartition: null,
    metaQueueDepth: 0,
    metaLeasedPartitions: 0,
    metaDeadLetterPartitions: 0,
    metaOldestQueuedPartition: null,
    workerOnline: false,
    workerInstances: 0,
    workerLastHeartbeatAt: null,
    workerLastProgressHeartbeatAt: null,
    googleAdsSafeModeActive: undefined,
    googleAdsCircuitBreakerBusinesses: undefined,
    googleAdsCompactedPartitions: undefined,
    googleAdsBudgetPressureMax: undefined,
    googleAdsRecoveryBusinesses: undefined,
    googleAdsGlobalReopenEnabled: undefined,
    googleAdsIntegrityIncidentCount: undefined,
    googleAdsIntegrityBlockedCount: undefined,
    metaIntegrityIncidentCount: undefined,
    metaIntegrityBlockedCount: undefined,
    metaD1FinalizeNonTerminalCount: undefined,
  };
  const issues = payload?.issues ?? [];
  const googleAdsBusinesses = payload?.googleAdsBusinesses ?? [];
  const metaBusinesses = payload?.metaBusinesses ?? [];
  const googleAdsHealthStatus = payload?.googleAdsHealthStatus ?? "ok";
  const googleAdsHealthError = payload?.googleAdsHealthError ?? null;
  const googleAdsActionRequiredScopes =
    summary.googleAdsActionRequiredBlockingScopes?.length
      ? summary.googleAdsActionRequiredBlockingScopes
      : summary.googleAdsActionRequiredScopes ?? [];
  const dbDiagnostics = payload?.dbDiagnostics ?? null;
  const globalRebuildReview = payload?.globalRebuildReview ?? null;
  const syncEffectivenessReview = payload?.syncEffectivenessReview ?? null;

  async function runProviderAction(
    businessId: string,
    provider: "google_ads" | "meta",
    action:
      | "cleanup"
      | "replay_dead_letter"
      | "reschedule"
      | "refresh_state"
      | "release_quarantine"
      | "force_manual_replay"
      | "repair_cycle"
      | "repair_integrity_windows"
  ) {
    setActionState({
      businessId,
      action,
      message: null,
      error: null,
    });
    try {
      const response = await fetch("/api/admin/sync-health", {
        method: "POST",
        headers: {
          "content-type": "application/json",
        },
        body: JSON.stringify({
          provider,
          action,
          businessId,
        }),
      });
      const body = await response.json().catch(() => null);
      if (!response.ok) {
        throw new Error(
          (body as { message?: string } | null)?.message ??
            "Google Ads recovery action failed."
        );
      }
      setActionState({
        businessId,
        action,
        message: `${action} completed successfully.`,
        error: null,
      });
      const refreshed = await fetch("/api/admin/sync-health").then((res) => res.json());
      setPayload(refreshed as SyncHealthPayload);
    } catch (error) {
      setActionState({
        businessId,
        action,
        message: null,
        error:
          error instanceof Error ? error.message : "Google Ads recovery action failed.",
      });
    }
  }

  return (
    <div className="space-y-6">
      <div className="flex items-start justify-between gap-4">
        <div className="flex items-center gap-3">
          <div className="p-2 rounded-lg bg-sky-50">
            <RefreshCw className="w-5 h-5 text-sky-600" />
          </div>
          <div>
            <h1 className="text-2xl font-bold text-gray-900">Sync Health</h1>
            <p className="text-sm text-gray-500 mt-1">Yalnızca gerçekten takılan veya başarısız olan arka plan sync olaylarını gösterir</p>
          </div>
        </div>
        <Link href="/admin" className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-sm text-gray-600 hover:bg-gray-50">
          Dashboard&apos;a dön
        </Link>
      </div>

      <div className="grid grid-cols-2 lg:grid-cols-4 gap-4">
        <MetricCard label="Failed 24h" value={summary.failedJobs24h} help={SYNC_HELP["Failed 24h"]} />
        <MetricCard label="Stuck" value={summary.stuckJobs} help={SYNC_HELP.Stuck} />
        <MetricCard label="Running" value={summary.runningJobs} help={SYNC_HELP.Running} />
        <MetricCard label="Cooldowns" value={summary.activeCooldowns} help={SYNC_HELP.Cooldowns} />
        <MetricCard label="GAds Queue" value={summary.googleAdsQueueDepth} help="Google Ads partition queue depth across all businesses." />
        <MetricCard label="GAds Leased" value={summary.googleAdsLeasedPartitions} help="Google Ads partitions currently leased or running." />
        <MetricCard label="GAds Dead" value={summary.googleAdsDeadLetterPartitions} help="Google Ads dead-letter partitions that require intervention." />
        <MetricCard label="GAds Breaker" value={summary.googleAdsCircuitBreakerBusinesses} help="Businesses currently blocked by the Google Ads circuit breaker." />
        <MetricCard label="GAds Compact" value={summary.googleAdsCompactedPartitions} help="Extended Google Ads partitions compacted or suppressed during incident containment." />
        <MetricCard label="GAds Recovery" value={summary.googleAdsRecoveryBusinesses} help="Businesses currently in Google Ads half-open recovery mode." />
        <MetricCard label="GAds Global" value={summary.googleAdsGlobalReopenEnabled ? "on" : "off"} help="Global extended-lane execution posture for Google Ads rebuild work." />
        <MetricCard
          label="GAds Freshness"
          value={
            summary.googleAdsFreshnessLabel
              ? `${summary.googleAdsFreshnessLabel} ${summary.googleAdsFreshnessPercent ?? 0}%`
              : null
          }
          help="Weakest Google Ads freshness verdict across all businesses. Only 'Policy-settled' means every day in the window was re-read after it closed and is past the conversion lookback; 'Unknown' means the evidence could not be read and must be retried, never that the sync is healthy or failed."
        />
        <MetricCard
          label="GAds Not Settled"
          value={summary.googleAdsFreshnessBusinessesNotSettled}
          help="Businesses whose Google Ads recent window is not policy-settled. Non-zero means the scheduler still has re-reads outstanding, regardless of queue depth."
        />
        <MetricCard label="Meta Queue" value={summary.metaQueueDepth ?? 0} help="Meta partition queue depth across all businesses." />
        <MetricCard label="Meta Leased" value={summary.metaLeasedPartitions ?? 0} help="Meta partitions currently leased or running." />
        <MetricCard label="Meta Dead" value={summary.metaDeadLetterPartitions ?? 0} help="Meta dead-letter partitions that require intervention." />
      </div>

      {(payload?.runtimeContract || payload?.runtimeRegistry || payload?.deployGate || payload?.releaseGate) ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-900">Control plane</p>
              <p className="mt-1 text-sm text-gray-500">
                Runtime contract drift, synthetic deploy gate, and release readiness now come from the same backend control system. Product-ready signoff requires deploy gate pass, release gate pass, an empty repair plan, and block-mode gates.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              {summary.syncTruthState ? <StateBadge state={summary.syncTruthState} /> : null}
              {payload?.deployGate ? <StateBadge state={payload.deployGate.verdict} /> : null}
              {payload?.releaseGate ? <StateBadge state={payload.releaseGate.verdict} /> : null}
              {summary.blockerClass ? <MetricPill label="Blocker" value={summary.blockerClass} /> : null}
            </div>
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-4">
            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Runtime contract</p>
              <p className="mt-2 text-sm text-slate-700">
                build <span className="font-mono">{payload?.runtimeContract?.buildId ?? "unknown"}</span>
              </p>
              <p className="mt-1 text-sm text-slate-700">
                db {payload?.runtimeRegistry?.dbFingerprintMatch ? "matched" : "drifted"} • config {payload?.runtimeRegistry?.configFingerprintMatch ? "matched" : "drifted"}
              </p>
              <p className="mt-1 text-sm text-slate-700">
                web {payload?.runtimeRegistry?.webPresent ? "fresh" : "missing"} • worker {payload?.runtimeRegistry?.workerPresent ? "fresh" : "missing"}
              </p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Deploy gate</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {payload?.deployGate ? <StateBadge state={payload.deployGate.verdict} /> : <StateBadge state="unknown" />}
                {payload?.deployGate ? <MetricPill label="Mode" value={payload.deployGate.mode} /> : null}
                {payload?.deployGate?.gateScope ? <MetricPill label="Scope" value={payload.deployGate.gateScope} /> : null}
              </div>
              <p className="mt-2 text-sm text-slate-700">{payload?.deployGate?.summary ?? "No deploy gate verdict recorded for this build."}</p>
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Release gate</p>
              <div className="mt-2 flex flex-wrap gap-2">
                {payload?.releaseGate ? <StateBadge state={payload.releaseGate.verdict} /> : <StateBadge state="unknown" />}
                {payload?.releaseGate ? <MetricPill label="Mode" value={payload.releaseGate.mode} /> : null}
                {payload?.releaseGate?.gateScope ? <MetricPill label="Scope" value={payload.releaseGate.gateScope} /> : null}
                {payload?.releaseGate?.breakGlass ? <MetricPill label="Break glass" value="active" /> : null}
              </div>
              <p className="mt-2 text-sm text-slate-700">{payload?.releaseGate?.summary ?? "No release gate verdict recorded for this build."}</p>
              {payload?.releaseGate && payload.releaseGate.mode !== "block" ? (
                <p className="mt-1 text-xs text-amber-700">
                  Product-ready signoff is still pending while release gate mode stays <span className="font-mono">{payload.releaseGate.mode}</span>.
                </p>
              ) : null}
              {payload?.releaseGate?.overrideReason ? (
                <p className="mt-1 text-xs text-slate-500">override reason: {payload.releaseGate.overrideReason}</p>
              ) : null}
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Repair plan</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <StateBadge state={payload?.repairPlan?.eligible ? "ready" : "blocked"} />
                {payload?.repairPlan?.blockedReason ? (
                  <MetricPill label="Blocked" value={payload.repairPlan.blockedReason} />
                ) : null}
                {payload?.repairPlan?.breakGlass ? <MetricPill label="Break glass" value="active" /> : null}
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {payload?.repairPlan?.summary ?? "No dry-run repair plan recorded for this build."}
              </p>
              {payload?.repairPlan?.recommendations?.length ? (
                <p className="mt-1 text-xs text-slate-500">
                  top action: {payload.repairPlan.recommendations[0]?.recommendedAction} • count {payload.repairPlan.recommendations.length}
                </p>
              ) : (
                <p className="mt-1 text-xs text-slate-500">
                  Product-ready signoff also requires this recommendation list to stay empty.
                </p>
              )}
            </div>

            <div className="rounded-xl border border-slate-200 bg-slate-50 p-4">
              <p className="text-xs font-semibold uppercase tracking-wide text-slate-500">Remediation</p>
              <div className="mt-2 flex flex-wrap gap-2">
                <StateBadge state={payload?.remediationSummary?.improvedAny ? "busy" : "waiting"} />
                <MetricPill label="Businesses" value={payload?.remediationSummary?.businessCount ?? 0} />
                <MetricPill label="Cleared" value={payload?.remediationSummary?.counts.cleared ?? 0} />
                <MetricPill
                  label="Improving"
                  value={payload?.remediationSummary?.counts.improving_not_cleared ?? 0}
                />
              </div>
              <p className="mt-2 text-sm text-slate-700">
                {payload?.remediationSummary
                  ? `Latest remediation ${formatDateTime(payload.remediationSummary.latestFinishedAt ?? payload.remediationSummary.latestStartedAt)} • no change ${payload.remediationSummary.counts.no_change} • manual follow-up ${payload.remediationSummary.counts.manual_follow_up_required} • locked ${payload.remediationSummary.counts.locked}`
                  : "No live remediation execution recorded for this build."}
              </p>
            </div>
          </div>

          {payload?.runtimeRegistry?.issues?.length ? (
            <div className="mt-4 flex flex-wrap gap-2">
              {payload.runtimeRegistry.issues.map((issue: string) => (
                <MetricPill key={issue} label="Contract issue" value={issue} />
              ))}
            </div>
          ) : null}
        </div>
      ) : null}

      {dbDiagnostics ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-900">DB pressure</p>
              <p className="mt-1 text-sm text-gray-500">
                Current web and worker pool pressure, timeout or retry evidence, and the matching Meta backlog posture for self-hosted Postgres.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <StateBadge state={dbDiagnostics.summary.workerPressureState} />
              <StateBadge state={dbDiagnostics.summary.metaBacklogState} />
              <MetricPill
                label="Constraint"
                value={formatDbConstraint(dbDiagnostics.summary.likelyPrimaryConstraint)}
              />
            </div>
          </div>
          <p className="mt-3 text-sm text-gray-600">{dbDiagnostics.summary.headline}</p>
          <div className="mt-3 flex flex-wrap gap-2">
            <MetricPill label="Meta queue" value={dbDiagnostics.summary.metaQueueDepth} />
            <MetricPill label="Meta leased" value={dbDiagnostics.summary.metaLeasedPartitions} />
            <MetricPill label="Worker waiters" value={dbDiagnostics.summary.workerCurrentPoolWaiters} />
            <MetricPill label="Max waiters" value={dbDiagnostics.summary.workerMaxObservedPoolWaiters} />
            <MetricPill label="Timeouts" value={dbDiagnostics.summary.workerTimeoutCount} />
            <MetricPill label="Retryable" value={dbDiagnostics.summary.workerRetryableErrorCount} />
            <MetricPill label="Conn errs" value={dbDiagnostics.summary.workerConnectionErrorCount} />
          </div>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-gray-900">Web process</p>
                <StateBadge state={dbDiagnostics.summary.webPressureState} />
              </div>
              {dbDiagnostics.web ? (
                <>
                  <p className="mt-2 text-xs text-gray-500">
                    {dbDiagnostics.web.applicationName} • {formatDbSettingsCompact(dbDiagnostics.web.settings)}
                  </p>
                  <div className="mt-3 flex flex-wrap gap-2">
                    <MetricPill label="Pool" value={`${dbDiagnostics.web.pool.totalCount}/${dbDiagnostics.web.settings.poolMax}`} />
                    <MetricPill label="Idle" value={dbDiagnostics.web.pool.idleCount} />
                    <MetricPill label="Wait" value={dbDiagnostics.web.pool.waitingCount} />
                    <MetricPill label="Util" value={`${dbDiagnostics.web.pool.utilizationPercent}%`} />
                    <MetricPill label="State" value={dbDiagnostics.web.pool.saturationState} />
                  </div>
                  {dbDiagnostics.web.lastError ? (
                    <p className="mt-3 text-xs text-amber-700">
                      Last error {formatDateTime(dbDiagnostics.web.lastError.at)} • {dbDiagnostics.web.lastError.message}
                    </p>
                  ) : (
                    <p className="mt-3 text-xs text-gray-500">No recent web DB error captured.</p>
                  )}
                </>
              ) : (
                <p className="mt-2 text-sm text-gray-500">Web DB diagnostics unavailable.</p>
              )}
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-gray-900">Worker processes</p>
                <MetricPill label="Workers" value={dbDiagnostics.summary.workerCount} />
              </div>
              {dbDiagnostics.workers.length ? (
                <div className="mt-3 space-y-2">
                  {dbDiagnostics.workers.slice(0, 4).map((worker) => (
                    <div
                      key={`${worker.workerId ?? worker.applicationName}:${worker.providerScope ?? "all"}`}
                      className="rounded-lg border border-white bg-white px-3 py-2 text-xs text-gray-600"
                    >
                      <div className="flex flex-wrap items-center gap-2">
                        <span className="font-medium text-gray-800">{worker.workerId ?? worker.applicationName}</span>
                        <span>{worker.providerScope ?? "all"}</span>
                        <span>{worker.workerStatus ?? "unknown"}</span>
                        <span>{formatDateTime(worker.lastHeartbeatAt ?? null)}</span>
                      </div>
                      <p className="mt-1 text-gray-500">{formatDbSettingsCompact(worker.settings)}</p>
                      <div className="mt-2 flex flex-wrap gap-2">
                        <MetricPill label="Pool" value={`${worker.pool.totalCount}/${worker.settings.poolMax}`} />
                        <MetricPill label="Wait" value={worker.pool.waitingCount} />
                        <MetricPill label="Max wait" value={worker.pool.maxObservedWaitingCount} />
                        <MetricPill label="Util" value={`${worker.pool.utilizationPercent}%`} />
                        <MetricPill label="Timeouts" value={worker.counters.timeoutCount} />
                        <MetricPill label="Retryable" value={worker.counters.retryableErrorCount} />
                      </div>
                    </div>
                  ))}
                </div>
              ) : (
                <p className="mt-2 text-sm text-gray-500">
                  No worker heartbeat has published DB diagnostics yet.
                </p>
              )}
            </div>
          </div>

          <ul className="mt-4 space-y-2 text-sm text-gray-600">
            {dbDiagnostics.summary.evidence.map((item) => (
              <li key={item}>{item}</li>
            ))}
          </ul>
        </div>
      ) : null}

      {globalRebuildReview ? (
        <div className="rounded-xl border border-gray-200 bg-white p-5">
          <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
            <div>
              <p className="text-sm font-semibold text-gray-900">Global rebuild truth review</p>
              <p className="mt-1 text-sm text-gray-500">
                One global operator contract across all businesses. Review provider posture here before trusting sparse rebuild coverage. Ready means evidence only and never auto-enables Google or Meta execution-sensitive behavior.
              </p>
            </div>
            <div className="flex flex-wrap gap-2">
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700">
                Workflow {globalRebuildReview.workflow.adminSurface}
              </span>
              <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700">
                Review {globalRebuildReview.workflow.executionReviewCommand}
              </span>
            </div>
          </div>
          <p className="mt-3 text-xs text-gray-500">
            Provider status drilldown remains explanatory only. Use the shared admin surface or review command to decide posture globally.
          </p>

          <div className="mt-4 grid gap-4 lg:grid-cols-2">
            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 lg:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Explicit execution posture review</p>
                  <p className="mt-1 text-sm text-gray-600">
                    Conservative operator decision derived from the shared global gate and rebuild-truth evidence.
                  </p>
                </div>
                <StateBadge state={globalRebuildReview.executionPostureReview.decision} />
              </div>
              <p className="mt-3 text-sm text-gray-600">
                {globalRebuildReview.executionPostureReview.summary}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <MetricPill label="Gate" value={globalRebuildReview.executionPostureReview.gateState} />
                <MetricPill
                  label="Justified"
                  value={globalRebuildReview.executionPostureReview.strongerPostureJustified ? "yes" : "no"}
                />
                <MetricPill
                  label="Auto-enable"
                  value={globalRebuildReview.executionPostureReview.automaticEnablement ? "on" : "off"}
                />
                <MetricPill
                  label="GAds sync"
                  value={globalRebuildReview.executionPostureReview.currentPosture.googleAds.sync.state}
                />
                <MetricPill
                  label="GAds retention"
                  value={globalRebuildReview.executionPostureReview.currentPosture.googleAds.retention.state}
                />
                <MetricPill
                  label="Meta finalize"
                  value={
                    globalRebuildReview.executionPostureReview.currentPosture.meta.authoritativeFinalization
                      .state
                  }
                />
                <MetricPill
                  label="Meta retention"
                  value={globalRebuildReview.executionPostureReview.currentPosture.meta.retention.state}
                />
              </div>
              <p className="mt-3 text-sm text-gray-600">
                {globalRebuildReview.executionPostureReview.allowedNextStep}
              </p>
              <div className="mt-4 grid gap-4 lg:grid-cols-2">
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Must remain manual
                  </p>
                  <ul className="mt-2 space-y-2 text-sm text-gray-600">
                    {globalRebuildReview.executionPostureReview.mustRemainManual.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
                <div>
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Forbidden even if ready
                  </p>
                  <ul className="mt-2 space-y-2 text-sm text-gray-600">
                    {globalRebuildReview.executionPostureReview.forbiddenEvenIfReady.map((item) => (
                      <li key={item}>{item}</li>
                    ))}
                  </ul>
                </div>
              </div>
            </div>

            <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 lg:col-span-2">
              <div className="flex items-center justify-between gap-3">
                <div>
                  <p className="text-sm font-semibold text-gray-900">Global execution readiness gate</p>
                  <p className="mt-1 text-sm text-gray-600">
                    One global decision for stronger execution or stronger warehouse trust across all businesses.
                  </p>
                </div>
                <StateBadge state={globalRebuildReview.executionReadiness.state} />
              </div>
              <p className="mt-3 text-sm text-gray-600">
                {globalRebuildReview.executionReadiness.summary}
              </p>
              <div className="mt-3 flex flex-wrap gap-2">
                <MetricPill
                  label="Justified"
                  value={globalRebuildReview.executionReadiness.strongerPostureJustified ? "yes" : "no"}
                />
                <MetricPill
                  label="Holding"
                  value={formatHoldingProviders(globalRebuildReview.executionReadiness.holdingProviders)}
                />
                <MetricPill
                  label="Auto-enable"
                  value={globalRebuildReview.executionReadiness.automaticEnablement ? "on" : "off"}
                />
              </div>
              <p className="mt-3 text-xs text-gray-500">
                This gate never enables execution automatically. Stronger execution remains an explicit operator decision.
              </p>

              {globalRebuildReview.executionReadiness.dominantBlockers.length > 0 ? (
                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Dominant blockers
                    </p>
                    <ul className="mt-2 space-y-2 text-sm text-gray-600">
                      {globalRebuildReview.executionReadiness.dominantBlockers.map((blocker) => (
                        <li key={`${blocker.provider}-${blocker.code}`}>
                          <span className="font-medium text-gray-900">
                            {formatExecutionProvider(blocker.provider)}:
                          </span>{" "}
                          {blocker.summary}
                          <span className="block text-xs text-gray-500">{blocker.evidence}</span>
                        </li>
                      ))}
                    </ul>
                  </div>
                  <div>
                    <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                      Evidence still missing
                    </p>
                    <ul className="mt-2 space-y-2 text-sm text-gray-600">
                      {globalRebuildReview.executionReadiness.evidenceStillMissing.map((item) => (
                        <li key={item}>{item}</li>
                      ))}
                    </ul>
                  </div>
                </div>
              ) : (
                <p className="mt-4 text-sm text-gray-600">
                  No dominant blockers are currently reported by the shared gate.
                </p>
              )}
            </div>

            {syncEffectivenessReview ? (
              <div className="rounded-lg border border-slate-200 bg-slate-50 p-4 lg:col-span-2">
                <div className="flex flex-col gap-2 lg:flex-row lg:items-start lg:justify-between">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">Global sync effectiveness review</p>
                    <p className="mt-1 text-sm text-gray-600">
                      Current rebuild evidence for whether Google and Meta are actually catching up, stalled, or still too sparse to trust.
                    </p>
                  </div>
                  <span className="rounded-full border border-slate-200 bg-white px-2.5 py-1 text-[11px] font-medium text-slate-700">
                    Review {syncEffectivenessReview.workflow.reviewCommand}
                  </span>
                </div>

                <div className="mt-4 grid gap-4 lg:grid-cols-2">
                  {[
                    {
                      key: "google",
                      label: "Google Ads",
                      review: syncEffectivenessReview.googleAds,
                    },
                    {
                      key: "meta",
                      label: "Meta",
                      review: syncEffectivenessReview.meta,
                    },
                  ].map(({ key, label, review }) => (
                    <div key={key} className="rounded-lg border border-white bg-white p-4">
                      <div className="flex items-center justify-between gap-3">
                        <p className="text-sm font-semibold text-gray-900">{label}</p>
                        <StateBadge state={review.summaryState} />
                      </div>
                      <p className="mt-2 text-sm text-gray-600">{review.summary}</p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricPill
                          label="Trusted"
                          value={review.freshness.mostRecentTrustedDay ?? "none"}
                        />
                        <MetricPill
                          label="Lag"
                          value={formatLagDays(review.freshness.lagDays)}
                        />
                        <MetricPill
                          label="Warehouse"
                          value={review.freshness.warehouseReadyThroughDay ?? "none"}
                        />
                        <MetricPill
                          label="Moved"
                          value={review.freshness.progressMovedRecently ? "recently" : "not recently"}
                        />
                        <MetricPill
                          label="Progressing"
                          value={`${review.coverage.progressingBusinesses}/${review.coverage.totalBusinesses}`}
                        />
                        <MetricPill
                          label="Stalled"
                          value={review.coverage.stalledBusinesses}
                        />
                        <MetricPill
                          label="Quota"
                          value={review.quota.quotaLimitedBusinesses}
                        />
                        {review.provider === "google_ads" ? (
                          <MetricPill
                            label="Hot window"
                            value={`${review.truthHealth.currentHotWindowSupportBusinesses}/${review.coverage.totalBusinesses}`}
                          />
                        ) : (
                          <MetricPill
                            label="Published truth"
                            value={review.truthHealth.protectedPublishedTruthState}
                          />
                        )}
                      </div>
                      <ul className="mt-4 space-y-2 text-sm text-gray-600">
                        {review.topSignals.map((signal) => (
                          <li key={signal}>{signal}</li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              </div>
            ) : null}

            <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-gray-900">Google Ads</p>
                <StateBadge state={globalRebuildReview.googleAds.rebuild.state} />
              </div>
              <p className="mt-2 text-sm text-gray-600">{globalRebuildReview.googleAds.rebuild.summary}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <MetricPill label="Exec" value={globalRebuildReview.googleAds.execution.sync.state} />
                <MetricPill label="Retention" value={globalRebuildReview.googleAds.execution.retention.state} />
                <MetricPill label="Blocked" value={globalRebuildReview.googleAds.rebuild.evidence.blockedBusinesses} />
                <MetricPill label="Quota" value={globalRebuildReview.googleAds.rebuild.evidence.quotaLimitedBusinesses} />
                <MetricPill label="Cold" value={globalRebuildReview.googleAds.rebuild.evidence.coldBootstrapBusinesses} />
                <MetricPill label="Backfill" value={globalRebuildReview.googleAds.rebuild.evidence.backfillInProgressBusinesses} />
                <MetricPill label="Partial" value={globalRebuildReview.googleAds.rebuild.evidence.partialUpstreamCoverageBusinesses} />
                <MetricPill label="Ready" value={globalRebuildReview.googleAds.rebuild.evidence.readyBusinesses} />
              </div>
              <p className="mt-3 text-xs text-gray-500">
                Drilldown: {globalRebuildReview.workflow.googleStatus}
              </p>
            </div>

            <div className="rounded-lg border border-gray-100 bg-gray-50 p-4">
              <div className="flex items-center justify-between gap-3">
                <p className="text-sm font-semibold text-gray-900">Meta</p>
                <StateBadge state={globalRebuildReview.meta.rebuild.state} />
              </div>
              <p className="mt-2 text-sm text-gray-600">{globalRebuildReview.meta.rebuild.summary}</p>
              <div className="mt-3 flex flex-wrap gap-2">
                <MetricPill label="Finalize" value={globalRebuildReview.meta.execution.authoritativeFinalization.state} />
                <MetricPill label="Retention" value={globalRebuildReview.meta.execution.retention.state} />
                <MetricPill label="Blocked" value={globalRebuildReview.meta.rebuild.evidence.blockedBusinesses} />
                <MetricPill label="Repair" value={globalRebuildReview.meta.rebuild.evidence.repairRequiredBusinesses} />
                <MetricPill label="Quota" value={globalRebuildReview.meta.rebuild.evidence.quotaLimitedBusinesses} />
                <MetricPill label="Cold" value={globalRebuildReview.meta.rebuild.evidence.coldBootstrapBusinesses} />
                <MetricPill label="Backfill" value={globalRebuildReview.meta.rebuild.evidence.backfillInProgressBusinesses} />
                <MetricPill label="Partial" value={globalRebuildReview.meta.rebuild.evidence.partialUpstreamCoverageBusinesses} />
                <MetricPill label="Ready" value={globalRebuildReview.meta.rebuild.evidence.readyBusinesses} />
              </div>
              <div className="mt-3 rounded-lg border border-white bg-white p-3">
                <div className="flex items-center justify-between gap-3">
                  <p className="text-xs font-semibold uppercase tracking-wide text-gray-500">
                    Protected published truth
                  </p>
                  <StateBadge state={globalRebuildReview.meta.protectedPublishedTruth.state} />
                </div>
                <p className="mt-2 text-sm text-gray-600">
                  {globalRebuildReview.meta.protectedPublishedTruth.summary}
                </p>
                <div className="mt-3 flex flex-wrap gap-2">
                  <MetricPill label="Rows" value={globalRebuildReview.meta.protectedPublishedTruth.protectedPublishedRows} />
                  <MetricPill label="Pointers" value={globalRebuildReview.meta.protectedPublishedTruth.activePublicationPointerRows} />
                  <MetricPill label="Classes" value={globalRebuildReview.meta.protectedPublishedTruth.protectedTruthClassesPresent.length} />
                </div>
                <p className="mt-3 text-xs text-gray-500">
                  Present classes {globalRebuildReview.meta.protectedPublishedTruth.protectedTruthClassesPresent.join(", ") || "none"}
                </p>
              </div>
              <p className="mt-3 text-xs text-gray-500">
                Drilldown: {globalRebuildReview.workflow.metaStatus}
              </p>
            </div>
          </div>
        </div>
      ) : null}

      {googleAdsHealthStatus !== "ok" ? (
        <div
          className={`rounded-xl border px-5 py-4 text-sm ${
            googleAdsHealthStatus === "failed"
              ? "border-red-200 bg-red-50 text-red-700"
              : "border-amber-200 bg-amber-50 text-amber-800"
          }`}
        >
          <p className="font-medium">
            {googleAdsHealthStatus === "failed"
              ? "Google Ads Sync Health is currently unavailable."
              : "Google Ads Sync Health is degraded."}
          </p>
          <p className="mt-1">
            {googleAdsHealthError ??
              "Google Ads queue details could not be loaded, but lightweight summary counts are still shown where available."}
          </p>
        </div>
      ) : null}

      {(summary.googleAdsActionRequiredBusinessCount ?? 0) > 0 ? (
        <div className="rounded-xl border border-amber-200 bg-amber-50 px-5 py-4 text-sm text-amber-900">
          <p className="font-medium">Reconnect Google Ads for affected accounts.</p>
          <p className="mt-1">
            {summary.googleAdsActionRequiredBusinessCount} business(es) have terminal
            action-required Google Ads partitions. Blocked scopes:{" "}
            <span className="font-medium">
              {googleAdsActionRequiredScopes.length
                ? googleAdsActionRequiredScopes.join(", ")
                : "unknown"}
            </span>
            .
          </p>
        </div>
      ) : null}

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <div className="flex flex-col gap-3 lg:flex-row lg:items-start lg:justify-between">
          <div>
            <p className="text-sm font-semibold text-gray-900">Worker runtime</p>
            <p className="mt-1 text-sm text-gray-500">
              Durable worker heartbeat and queue ownership visibility for Meta and Google Ads.
            </p>
          </div>
          <div className="flex flex-wrap gap-2">
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                summary.workerOnline
                  ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
                  : "border border-amber-200 bg-amber-50 text-amber-800"
              }`}
            >
              {summary.workerOnline ? "Worker online" : "Worker offline"}
            </span>
            <span
              className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${
                summary.googleAdsSafeModeActive
                  ? "border border-amber-200 bg-amber-50 text-amber-800"
                  : "border border-gray-200 bg-gray-50 text-gray-600"
              }`}
            >
              {summary.googleAdsSafeModeActive ? "GAds safe mode active" : "GAds safe mode off"}
            </span>
            <MetricPill label="Instances" value={summary.workerInstances ?? 0} />
          </div>
        </div>
        <div className="mt-4 grid gap-3 md:grid-cols-2">
          <p className="text-xs text-gray-500">
            Last heartbeat <span className="font-medium text-gray-700">{formatDateTime(summary.workerLastHeartbeatAt ?? null)}</span>
          </p>
          <p className="text-xs text-gray-500">
            Online workers <span className="font-medium text-gray-700">{payload?.workerHealth?.onlineWorkers ?? 0}</span>
          </p>
          <p className="text-xs text-gray-500">
            Last progress heartbeat <span className="font-medium text-gray-700">{formatDateTime(summary.workerLastProgressHeartbeatAt ?? null)}</span>
          </p>
          <p className="text-xs text-gray-500">
            Max GAds budget pressure <span className="font-medium text-gray-700">{`${Math.round((summary.googleAdsBudgetPressureMax ?? 0) * 100)}%`}</span>
          </p>
        </div>
        {payload?.workerHealth?.workers?.length ? (
          <div className="mt-4 space-y-2">
            {payload.workerHealth.workers.slice(0, 4).map((worker) => (
              <div
                key={worker.workerId}
                className="flex flex-col gap-1 rounded-lg border border-gray-100 bg-gray-50 px-3 py-2 text-xs text-gray-600 md:flex-row md:items-center md:justify-between"
              >
                <div>
                  <span className="font-medium text-gray-800">{worker.workerId}</span>
                  <span className="ml-2">{worker.providerScope}</span>
                  <span className="ml-2">{worker.status}</span>
                  <span className="ml-2">{worker.workerFreshnessState ?? "stale"}</span>
                </div>
                <div className="text-gray-500">
                  Heartbeat {formatDateTime(worker.lastHeartbeatAt)} • Current {typeof worker.metaJson?.currentBusinessId === "string" ? worker.metaJson.currentBusinessId : worker.lastConsumedBusinessId ?? worker.lastBusinessId ?? "—"} • Outcome {worker.lastConsumeOutcome ?? (typeof worker.metaJson?.consumeOutcome === "string" ? worker.metaJson.consumeOutcome : "—")}
                </div>
                <div className="text-gray-500">
                  Stage {typeof worker.metaJson?.consumeStage === "string" ? worker.metaJson.consumeStage : "—"} • Lease {typeof worker.metaJson?.lastLeaseAcquiredAt === "string" ? formatDateTime(worker.metaJson.lastLeaseAcquiredAt) : "—"} • Finished {formatDateTime(worker.lastConsumeFinishedAt ?? (typeof worker.metaJson?.consumeFinishedAt === "string" ? worker.metaJson.consumeFinishedAt : null))}
                </div>
              </div>
            ))}
          </div>
        ) : null}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white p-5">
        <p className="text-sm font-semibold text-gray-900">Özet</p>
        <div className="mt-3 space-y-3 text-sm text-gray-500">
          <p>
            {summary.successJobs24h} başarılı job son 24 saatte tamamlandı. En yaygın problem:{" "}
            <span className="font-medium text-gray-700">{summary.topIssue ?? "Sorun yok"}</span>
          </p>
          <div className="grid gap-2 md:grid-cols-2">
            <p>
              Google Ads kuyruk sağlığı:
              <span className="ml-1 font-medium text-gray-700">
                en eski queued {formatDateTime(summary.googleAdsOldestQueuedPartition ?? null)}
              </span>
            </p>
            <p>
              Meta kuyruk sağlığı:
              <span className="ml-1 font-medium text-gray-700">
                en eski queued {formatDateTime(summary.metaOldestQueuedPartition ?? null)}
              </span>
            </p>
            <p>
              Google Ads integrity:
              <span className="ml-1 font-medium text-gray-700">
                incidents {summary.googleAdsIntegrityIncidentCount ?? 0} • blocked {summary.googleAdsIntegrityBlockedCount ?? 0}
              </span>
            </p>
            <p>
              Meta integrity:
              <span className="ml-1 font-medium text-gray-700">
                incidents {summary.metaIntegrityIncidentCount ?? 0} • blocked {summary.metaIntegrityBlockedCount ?? 0} • D-1 nonterminal {summary.metaD1FinalizeNonTerminalCount ?? 0}
              </span>
            </p>
          </div>
        </div>
        <p className="text-sm text-gray-500 mt-3">
          Recovery actions are available below for cleanup, dead-letter replay, reschedule, and state refresh.
        </p>
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Google Ads queue recovery</h2>
          <p className="mt-1 text-sm text-gray-500">
            Use these controls instead of manual SQL when a business queue is stuck.
          </p>
          <p className="mt-2 text-xs text-gray-500">
            Global posture: safe mode only during incidents, keep extended execution globally disabled while rebuild truth is incomplete, and enable global reopen only after the recent frontier drains cleanly with no breaker flapping.
          </p>
        </div>
        {googleAdsBusinesses.length === 0 ? (
          <div className="px-5 py-10 text-sm text-gray-400">
            {googleAdsHealthStatus === "ok"
              ? "Google Ads queue verisi yok."
              : "Google Ads queue detaylari simdilik kullanilamiyor."}
          </div>
        ) : (
          <div className="divide-y divide-gray-100">
            {googleAdsBusinesses.map((business) => {
              const isBusy = actionState.businessId === business.businessId;
              return (
                <div key={business.businessId} className="px-5 py-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{business.businessName}</p>
                      {getGoogleAdsBusinessSignals(business).length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {getGoogleAdsBusinessSignals(business).map((signal) => (
                            <span
                              key={signal}
                              className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800"
                            >
                              {signal}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <p className="mt-1 text-xs text-gray-500">
                        Queue {business.queueDepth} • Leased {business.leasedPartitions} • Dead-letter {business.deadLetterPartitions}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Extended recent queued {business.extendedRecentQueueDepth ?? 0} • leased {business.extendedRecentLeasedPartitions ?? 0} • historical queued {business.extendedHistoricalQueueDepth ?? 0} • leased {business.extendedHistoricalLeasedPartitions ?? 0}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Campaign {business.campaignCompletedDays} • Search intelligence {business.searchTermCompletedDays} • Products {business.productCompletedDays} • Assets {business.assetCompletedDays ?? 0}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Recent frontier: Search intelligence {business.recentSearchTermCompletedDays ?? 0}/{business.recentRangeTotalDays ?? 14} • Products {business.recentProductCompletedDays ?? 0}/{business.recentRangeTotalDays ?? 14} • Assets {business.recentAssetCompletedDays ?? 0}/{business.recentRangeTotalDays ?? 14}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Recent window ready-through {formatDateTime(business.extendedRecentReadyThroughDate ?? null)} • Block reason {business.extendedRecoveryBlockReason ?? "—"}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Checkpoint {business.latestCheckpointPhase ?? "—"} • Last page {business.lastSuccessfulPageIndex ?? "—"} • Resume {business.resumeCapable ? "yes" : "no"}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Oldest remaining queued {formatDateTime(business.oldestQueuedPartition)} • Latest activity {formatDateTime(business.latestPartitionActivityAt)} • Checkpoint {formatDateTime(business.latestCheckpointUpdatedAt ?? null)} • Progress {formatDateTime(business.lastProgressHeartbeatAt ?? null)}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Active slow {business.activeSlowPartitions ?? 0} • Reclaim candidates {business.reclaimCandidateCount ?? 0} • Poison {business.poisonedCheckpointCount ?? 0} • Last reclaim reason {business.lastReclaimReason ?? "—"}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Integrity incidents {business.integrityIncidentCount ?? 0} • Blocked {business.integrityBlockedCount ?? 0} • Lease conflicts {business.leaseConflictRuns24h ?? 0} • Skipped active lease recoveries {business.skippedActiveLeaseRecoveries ?? 0}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Mode {business.effectiveMode ?? "global_backfill"} • Safe mode {business.safeModeActive ? "on" : "off"} • Breaker {business.circuitBreakerOpen ? "open" : "closed"} • Recovery {business.recoveryMode ?? "closed"} • Global extended {business.effectiveMode === "global_reopen" ? "on" : "off"} • Compacted {business.compactedPartitions ?? 0}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Quota calls {business.quotaCallCount ?? 0} • Quota errors {business.quotaErrorCount ?? 0} • Budget {business.quotaBudget ?? 0} • Pressure {Math.round((business.quotaPressure ?? 0) * 100)}%
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Recent ready {business.recentExtendedReady ? "yes" : "no"} • Historical ready {business.historicalExtendedReady ? "yes" : "no"} • Scheduling runs in normal queue order
                      </p>
                      <div className="mt-2 flex flex-wrap items-center gap-2">
                        <GoogleAdsFreshnessBadge freshness={business.googleAdsFreshness} />
                        <span className="text-xs text-gray-500">
                          {business.googleAdsFreshness
                            ? `${business.googleAdsFreshness.startDate} → ${business.googleAdsFreshness.endDate} • observed post-close ${
                                business.googleAdsFreshness.scopes.length > 0
                                  ? Math.min(
                                      ...business.googleAdsFreshness.scopes.map(
                                        (scope) => scope.postCloseObservedDays,
                                      ),
                                    )
                                  : 0
                              }/${business.googleAdsFreshness.totalDays} • due now ${
                                business.googleAdsFreshness.scopes.length > 0
                                  ? Math.max(
                                      ...business.googleAdsFreshness.scopes.map(
                                        (scope) => scope.dueNowDays,
                                      ),
                                    )
                                  : business.googleAdsFreshness.totalDays
                              } • lookback ${business.googleAdsFreshness.conversionLookbackDays}d`
                            : "Freshness evidence has not been published for this business."}
                        </span>
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        {business.googleAdsFreshness?.detail ??
                          "Google Ads freshness evidence could not be read; keep polling."}
                        {business.googleAdsFreshness &&
                        !business.googleAdsFreshness.evidenceAvailable
                          ? ` (${business.googleAdsFreshness.unavailableReason ?? "evidence unavailable"} — retryable)`
                          : ""}
                      </p>
                      {business.latestPoisonReason ? (
                        <p className="mt-1 text-xs text-amber-700">
                          Poison reason {business.latestPoisonReason} • Quarantined {formatDateTime(business.latestPoisonedAt ?? null)}
                        </p>
                      ) : null}
                      {actionState.businessId === business.businessId && actionState.message ? (
                        <p className="mt-2 text-xs text-emerald-700">{actionState.message}</p>
                      ) : null}
                      {actionState.businessId === business.businessId && actionState.error ? (
                        <p className="mt-2 text-xs text-red-700">{actionState.error}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton
                        label="Cleanup"
                        busy={isBusy && actionState.action === "cleanup"}
                        onClick={() => runProviderAction(business.businessId, "google_ads", "cleanup")}
                      />
                      <ActionButton
                        label="Replay Dead Letter"
                        busy={isBusy && actionState.action === "replay_dead_letter"}
                        onClick={() => runProviderAction(business.businessId, "google_ads", "replay_dead_letter")}
                      />
                      <ActionButton
                        label="Reschedule"
                        busy={isBusy && actionState.action === "reschedule"}
                        onClick={() => runProviderAction(business.businessId, "google_ads", "reschedule")}
                      />
                      {(business.poisonedCheckpointCount ?? 0) > 0 ? (
                        <ActionButton
                          label="Release Quarantine"
                          busy={isBusy && actionState.action === "release_quarantine"}
                          onClick={() => runProviderAction(business.businessId, "google_ads", "release_quarantine")}
                        />
                      ) : null}
                      {(business.poisonedCheckpointCount ?? 0) > 0 ? (
                        <ActionButton
                          label="Force Manual Replay"
                          busy={isBusy && actionState.action === "force_manual_replay"}
                          onClick={() => runProviderAction(business.businessId, "google_ads", "force_manual_replay")}
                        />
                      ) : null}
                      <ActionButton
                        label="Refresh State"
                        busy={isBusy && actionState.action === "refresh_state"}
                        onClick={() => runProviderAction(business.businessId, "google_ads", "refresh_state")}
                      />
                      <ActionButton
                        label="Repair Cycle"
                        busy={isBusy && actionState.action === "repair_cycle"}
                        onClick={() => runProviderAction(business.businessId, "google_ads", "repair_cycle")}
                      />
                      <ActionButton
                        label="Repair Integrity"
                        busy={isBusy && actionState.action === "repair_integrity_windows"}
                        onClick={() => runProviderAction(business.businessId, "google_ads", "repair_integrity_windows")}
                      />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Meta queue recovery</h2>
          <p className="mt-1 text-sm text-gray-500">
            Use these controls instead of manual SQL when a Meta queue is stuck.
          </p>
        </div>
        {metaBusinesses.length === 0 ? (
          <div className="px-5 py-10 text-sm text-gray-400">Meta queue verisi yok.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {metaBusinesses.map((business) => {
              const isBusy = actionState.businessId === business.businessId;
              const replayableDeadLetters = business.replayableDeadLetterPartitions ?? 0;
              const terminalActionRequiredDeadLetters =
                business.terminalActionRequiredDeadLetterPartitions ?? 0;
              const unknownDeadLetters = business.unknownDeadLetterPartitions ?? 0;
              const canReplayMetaDeadLetters =
                replayableDeadLetters > 0 && terminalActionRequiredDeadLetters === 0;
              return (
                <div key={business.businessId} className="px-5 py-4">
                  <div className="flex flex-col gap-4 lg:flex-row lg:items-start lg:justify-between">
                    <div className="min-w-0">
                      <p className="text-sm font-semibold text-gray-900">{business.businessName}</p>
                      {getMetaBusinessSignals(business).length > 0 ? (
                        <div className="mt-3 flex flex-wrap gap-2">
                          {getMetaBusinessSignals(business).map((signal) => (
                            <span
                              key={signal}
                              className="rounded-full border border-amber-200 bg-amber-50 px-2.5 py-1 text-[11px] font-medium text-amber-800"
                            >
                              {signal}
                            </span>
                          ))}
                        </div>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricPill label="Queue" value={business.queueDepth} />
                        <MetricPill label="Leased" value={business.leasedPartitions} />
                        <MetricPill label="Retryable failed" value={business.retryableFailedPartitions} />
                        <MetricPill label="Dead letter" value={business.deadLetterPartitions} />
                        <MetricPill label="Replayable dead" value={replayableDeadLetters} />
                        <MetricPill label="Action required" value={terminalActionRequiredDeadLetters} />
                        <MetricPill label="Unknown dead" value={unknownDeadLetters} />
                        <MetricPill label="Stale lease" value={business.staleLeasePartitions} />
                        <MetricPill label="State rows" value={business.stateRowCount} />
                      </div>
                      {terminalActionRequiredDeadLetters > 0 ? (
                        <p className="mt-2 text-xs text-amber-700">
                          Meta account action required. Reconnect or complete the Facebook login checkpoint before replaying this business.
                        </p>
                      ) : null}
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricPill label="Today account" value={business.todayAccountRows} />
                        <MetricPill label="Today adset" value={business.todayAdsetRows} />
                      </div>
                      <p className="mt-3 text-xs text-gray-500">
                        Current day reference {business.currentDayReference ?? "—"}
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricPill label="Account days" value={business.accountCompletedDays} />
                        <MetricPill label="Adset days" value={business.adsetCompletedDays} />
                        <MetricPill label="Creative days" value={business.creativeCompletedDays} />
                      </div>
                      <p className="mt-3 text-xs text-gray-500">
                        Recovery {business.effectiveMode ?? "core_only"} • Recent ready {business.recentExtendedReady ? "yes" : "no"} • Historical ready {business.historicalExtendedReady ? "yes" : "no"} • Scheduling runs in normal queue order
                      </p>
                      <div className="mt-3 flex flex-wrap gap-2">
                        <MetricPill label="Progress" value={business.progressState ?? "unknown"} />
                        <MetricPill label="Activity" value={business.activityState ?? "waiting"} />
                      </div>
                      <p className="mt-1 text-xs text-gray-500">
                        Worker {business.workerOnline == null ? "unknown" : business.workerOnline ? "online" : "offline"} • Heartbeat {formatDateTime(business.workerLastHeartbeatAt ?? null)} • Matched worker {business.workerId ?? "—"} • Stage {business.workerConsumeStage ?? "—"}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Recent window {business.recentRangeTotalDays ?? 14}d • Account {business.recentAccountCompletedDays ?? 0} • Adset {business.recentAdsetCompletedDays ?? 0} • Creative {business.recentCreativeCompletedDays ?? 0} • Ad {business.recentAdCompletedDays ?? 0}
                      </p>
                      <p className="mt-3 text-xs text-gray-500">
                        Oldest remaining queued {formatDateTime(business.oldestQueuedPartition)} • Latest activity {formatDateTime(business.latestPartitionActivityAt)}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Last completed {formatDateTime(business.progressEvidence?.lastCompletedAt ?? null)} • Ready-through advance {formatDateTime(business.progressEvidence?.lastReadyThroughAdvancedAt ?? null)} • Checkpoint advance {formatDateTime(business.progressEvidence?.lastCheckpointAdvancedAt ?? null)}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Checkpoint {business.latestCheckpointScope ?? "—"} / {business.latestCheckpointPhase ?? "—"} • Last page {business.lastSuccessfulPageIndex ?? "—"} • Updated {formatDateTime(business.latestCheckpointUpdatedAt ?? null)} • Progress {formatDateTime(business.lastProgressHeartbeatAt ?? null)}
                      </p>
                      {business.phaseTimings?.phases?.length ? (
                        <p className="mt-1 text-xs text-gray-500">
                          Phase timings ({business.phaseTimings.windowHours}h){" "}
                          {business.phaseTimings.phases.map((timing) => formatPhaseTimingLabel(timing)).join(" • ")}
                        </p>
                      ) : null}
                      <p className="mt-1 text-xs text-gray-500">
                        Active slow {business.activeSlowPartitions ?? 0} • Reclaim candidates {business.reclaimCandidateCount ?? 0} • Last reclaim reason {business.lastReclaimReason ?? "—"}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Integrity incidents {business.integrityIncidentCount ?? 0} • Blocked {business.integrityBlockedCount ?? 0} • D-1 nonterminal {business.d1FinalizeNonTerminalCount ?? 0} • Validation failures 24h {business.validationFailures24h ?? 0}
                      </p>
                      <p className="mt-1 text-xs text-gray-500">
                        Skipped active lease recoveries {business.skippedActiveLeaseRecoveries ?? 0} • Stale runs 24h {business.staleRunCount24h ?? 0}
                      </p>
                      {business.latestRemediationExecution ? (
                        <>
                          <p className="mt-1 text-xs text-gray-500">
                            Latest remediation {formatRemediationOutcome(business.latestRemediationExecution.outcomeClassification)} • recommended {business.latestRemediationExecution.recommendedAction ?? "—"} • executed {business.latestRemediationExecution.executedAction ?? "—"} • queue {business.latestRemediationExecution.beforeEvidence.queueDepth ?? "—"}→{business.latestRemediationExecution.afterEvidence.queueDepth ?? "—"} • truth {String(business.latestRemediationExecution.beforeEvidence.truthReady ?? "—")}→{String(business.latestRemediationExecution.afterEvidence.truthReady ?? "—")} • activity {business.latestRemediationExecution.beforeEvidence.activityState ?? "—"}→{business.latestRemediationExecution.afterEvidence.activityState ?? "—"}
                          </p>
                          <p className="mt-1 text-xs text-gray-500">
                            Gate/plan ids source {business.latestRemediationExecution.sourceReleaseGateId ?? "—"} / {business.latestRemediationExecution.sourceRepairPlanId ?? "—"} → post {business.latestRemediationExecution.postRunReleaseGateId ?? "—"} / {business.latestRemediationExecution.postRunRepairPlanId ?? "—"}
                          </p>
                        </>
                      ) : null}
                      {actionState.businessId === business.businessId && actionState.message ? (
                        <p className="mt-2 text-xs text-emerald-700">{actionState.message}</p>
                      ) : null}
                      {actionState.businessId === business.businessId && actionState.error ? (
                        <p className="mt-2 text-xs text-red-700">{actionState.error}</p>
                      ) : null}
                    </div>
                    <div className="flex flex-wrap gap-2">
                      <ActionButton label="Cleanup" busy={isBusy && actionState.action === "cleanup"} onClick={() => runProviderAction(business.businessId, "meta", "cleanup")} />
                      <ActionButton
                        label={
                          terminalActionRequiredDeadLetters > 0
                            ? "Meta Login Required"
                            : "Replay Transient Dead Letter"
                        }
                        busy={isBusy && actionState.action === "replay_dead_letter"}
                        disabled={!canReplayMetaDeadLetters}
                        onClick={() => runProviderAction(business.businessId, "meta", "replay_dead_letter")}
                      />
                      <ActionButton label="Reschedule" busy={isBusy && actionState.action === "reschedule"} onClick={() => runProviderAction(business.businessId, "meta", "reschedule")} />
                      <ActionButton label="Refresh State" busy={isBusy && actionState.action === "refresh_state"} onClick={() => runProviderAction(business.businessId, "meta", "refresh_state")} />
                      <ActionButton label="Repair Cycle" busy={isBusy && actionState.action === "repair_cycle"} onClick={() => runProviderAction(business.businessId, "meta", "repair_cycle")} />
                      <ActionButton label="Repair Integrity" busy={isBusy && actionState.action === "repair_integrity_windows"} onClick={() => runProviderAction(business.businessId, "meta", "repair_integrity_windows")} />
                    </div>
                  </div>
                </div>
              );
            })}
          </div>
        )}
      </div>

      <div className="rounded-xl border border-gray-200 bg-white overflow-hidden">
        <div className="px-5 py-4 border-b border-gray-100">
          <h2 className="text-sm font-semibold text-gray-900">Problemli sync olayları</h2>
        </div>
        {issues.length === 0 ? (
          <div className="px-5 py-10 text-sm text-gray-400">Aktif sync problemi yok.</div>
        ) : (
          <div className="divide-y divide-gray-100">
            {issues.map((issue) => (
              <div key={`${issue.businessId}:${issue.provider}:${issue.reportType}:${issue.triggeredAt}:${issue.status}`} className="px-5 py-4">
                <div className="flex items-start justify-between gap-4">
                  <div>
                    <p className="text-sm font-semibold text-gray-900">{issue.businessName}</p>
                    <p className="text-xs text-gray-500 mt-1">
                      {providerLabel(issue.provider)} • {formatIssueType(issue)} • {issue.status}
                    </p>
                    <div className="mt-2 flex flex-wrap gap-2">
                      {issue.severity ? <IssueSeverityBadge severity={issue.severity} /> : null}
                      {issue.runbookKey ? (
                        <span className="rounded-full border border-slate-200 bg-slate-50 px-2 py-0.5 text-[11px] font-medium text-slate-700">
                          {getSyncRunbook(issue.runbookKey)?.title ?? issue.runbookKey}
                        </span>
                      ) : null}
                    </div>
                    <p className="text-sm text-gray-600 mt-3">{issue.detail}</p>
                  </div>
                  <div className="text-right text-xs text-gray-400">
                    <p>Triggered: {formatDateTime(issue.triggeredAt)}</p>
                    <p className="mt-1">Oldest remaining queued: {formatDateTime(issue.completedAt)}</p>
                  </div>
                </div>
              </div>
            ))}
          </div>
        )}
      </div>
    </div>
  );
}

function IssueSeverityBadge({
  severity,
}: {
  severity: NonNullable<SyncIssueRow["severity"]>;
}) {
  const className =
    severity === "critical"
      ? "border-red-200 bg-red-50 text-red-700"
      : severity === "high"
        ? "border-amber-200 bg-amber-50 text-amber-700"
        : "border-sky-200 bg-sky-50 text-sky-700";

  return (
    <span
      className={`rounded-full border px-2 py-0.5 text-[11px] font-medium uppercase tracking-wide ${className}`}
    >
      {severity}
    </span>
  );
}

function MetricPill({
  label,
  value,
}: {
  label: string;
  value: number | string;
}) {
  return (
    <span className="rounded-full border border-slate-200 bg-slate-50 px-2.5 py-1 text-[11px] font-medium text-slate-700">
      {label} {value}
    </span>
  );
}

function StateBadge({ state }: { state: string }) {
  const className =
    state === "ready" ||
    state === "healthy" ||
    state === "clear" ||
    state === "present" ||
    state === "pass" ||
    state === "eligible_for_explicit_review" ||
    state === "improving" ||
    state === "ready_with_current_support"
      ? "border border-emerald-200 bg-emerald-50 text-emerald-700"
      : state === "not_ready" ||
          state === "saturated" ||
          state === "stalled" ||
          state === "blocked" ||
          state === "fail" ||
          state === "misconfigured" ||
          state === "worker_unavailable" ||
          state === "not_release_ready" ||
          state === "publication_missing" ||
          state === "no_go" ||
          state === "blocked_repair_needed"
        ? "border border-red-200 bg-red-50 text-red-700"
      : state === "conditionally_ready" ||
            state === "elevated" ||
            state === "draining" ||
            state === "hold_manual" ||
            state === "warn_only" ||
            state === "measure_only" ||
            state === "repair_required" ||
            state === "quota_limited" ||
            state === "cold_bootstrap" ||
            state === "backfill_in_progress" ||
            state === "partial_upstream_coverage" ||
            state === "rebuild_incomplete" ||
            state === "stable_but_incomplete" ||
            state === "stalled_by_quota" ||
            state === "sparse_due_to_rebuild"
          ? "border border-amber-200 bg-amber-50 text-amber-800"
          : "border border-slate-200 bg-slate-50 text-slate-700";

  return (
    <span className={`rounded-full px-2.5 py-1 text-[11px] font-medium ${className}`}>
      {state}
    </span>
  );
}

function formatExecutionProvider(provider: string) {
  return provider === "google_ads" ? "Google Ads" : provider === "meta" ? "Meta" : provider;
}

function formatHoldingProviders(providers: string[]) {
  if (providers.length === 0) return "none";
  return providers.map((provider) => formatExecutionProvider(provider)).join(", ");
}

function formatLagDays(value: number | null) {
  if (value == null) return "n/a";
  return `${value}d`;
}

function MetricCard({
  label,
  value,
  help,
}: {
  label: string;
  value: number | string | null | undefined;
  help?: string;
}) {
  return (
    <div className="rounded-xl border border-gray-200 bg-white px-5 py-4">
      <div className="flex items-center gap-1.5">
        <p className="text-xs font-medium uppercase tracking-wide text-gray-400">{label}</p>
        {help ? <InlineHelp text={help} /> : null}
      </div>
      <p className="text-3xl font-bold text-gray-900 mt-2">
        {value == null ? "—" : value}
      </p>
    </div>
  );
}

function ActionButton({
  label,
  busy,
  disabled = false,
  onClick,
}: {
  label: string;
  busy: boolean;
  disabled?: boolean;
  onClick: () => void;
}) {
  return (
    <button
      type="button"
      onClick={onClick}
      disabled={busy || disabled}
      className="rounded-lg border border-gray-200 bg-white px-3 py-2 text-xs font-medium text-gray-700 transition hover:bg-gray-50 disabled:cursor-not-allowed disabled:opacity-60"
    >
      {busy ? "Working..." : label}
    </button>
  );
}
