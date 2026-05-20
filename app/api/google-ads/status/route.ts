import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getDb } from "@/lib/db";
import { getDbSchemaReadiness } from "@/lib/db-schema-readiness";
import { getIntegrationMetadata } from "@/lib/integrations";
import {
  PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES,
  readProviderAccountSnapshot,
} from "@/lib/provider-account-snapshots";
import {
  PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
  getProviderAccountAssignments,
} from "@/lib/provider-account-assignments";
import {
  GOOGLE_ADS_WAREHOUSE_HISTORY_DAYS,
  addDaysToIsoDate,
  dayCountInclusive,
  getHistoricalWindowStart,
} from "@/lib/google-ads/history";
import { buildGoogleAdsCoreReadiness } from "@/lib/google-ads/core-readiness";
import {
  getGoogleAdsCheckpointHealth,
  getGoogleAdsCoveredDates,
  getGoogleAdsDailyCoverage,
  getGoogleAdsAdvisorSurfacePartitionStates,
  getGoogleAdsAdvisorQueueHealth,
  getGoogleAdsQueueHealth,
  getGoogleAdsSyncState,
  getLatestGoogleAdsSyncHealth,
} from "@/lib/google-ads/warehouse";
import {
  decideGoogleAdsAdvisorReadiness,
  decideGoogleAdsFullSyncPriority,
  decideGoogleAdsStatusState,
} from "@/lib/google-ads/status-machine";
import { countInclusiveDays } from "@/lib/google-ads/advisor-windows";
import {
  getLatestGoogleAdsAdvisorSnapshot,
  isGoogleAdsAdvisorSnapshotFresh,
} from "@/lib/google-ads/advisor-snapshots";
import {
  getGoogleAdsAutomationConfig,
  getGoogleAdsAdvisorAiStructuredAssistBoundaryState,
  getGoogleAdsAutonomyBoundaryState,
  getGoogleAdsDecisionEngineConfig,
} from "@/lib/google-ads/decision-engine-config";
import {
  getGoogleAdsRetentionRunRows,
  getGoogleAdsRetentionRuntimeStatus,
  getLatestGoogleAdsRetentionRun,
} from "@/lib/google-ads/warehouse-retention";
import { buildGoogleAdsAdvisorProgress } from "@/lib/google-ads/advisor-progress";
import {
  GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS,
  GOOGLE_ADS_ADVISOR_REQUIRED_SURFACES,
  isGoogleAdsAdvisorWindowReady,
} from "@/lib/google-ads/advisor-readiness";
import { buildGoogleAdsReleaseReadinessCandidate } from "@/lib/google-ads/control-plane";
import { resolveGoogleAdsControlPlaneSyncTruth } from "@/lib/google-ads/control-plane-runtime";
import { GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS } from "@/lib/google-ads/google-contract";
import { readGoogleAdsSearchIntelligenceCoverage } from "@/lib/google-ads/search-intelligence-storage";
import {
  buildProviderStateContract,
  buildProviderSurfaces,
  decideProviderReadinessLevel,
} from "@/lib/provider-readiness";
import { addDaysToIsoDateUtc, getProviderPlatformDateBoundaries } from "@/lib/provider-platform-date";
import {
  getProviderCircuitBreakerRecoveryState,
  getProviderQuotaBudgetState,
} from "@/lib/provider-request-governance";
import { getCurrentRuntimeBuildId } from "@/lib/build-runtime";
import { GLOBAL_OPERATOR_REVIEW_WORKFLOW } from "@/lib/global-operator-review";
import {
  buildGoogleAdsLaneAdmissionPolicy,
  getGoogleAdsExtendedRecoveryBlockReason,
  getGoogleAdsWorkerSchedulingState,
  isGoogleAdsIncidentSafeModeEnabled,
} from "@/lib/sync/google-ads-sync";
import { getLatestSyncGateRecords } from "@/lib/sync/release-gates";
import {
  getLatestSyncRepairPlan,
} from "@/lib/sync/repair-planner";
import { resolveSyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import { getSyncControlPlanePersistenceStatus } from "@/lib/sync/control-plane-persistence";
import {
  buildBlockingReason,
  deriveProviderActivityState,
  buildProviderProgressEvidence,
  buildRepairableAction,
  buildRequiredCoverage,
  compactBlockingReasons,
  compactRepairableActions,
  deriveProviderStallFingerprints,
  deriveProviderProgressState,
  deriveUnifiedSyncTruth,
} from "@/lib/sync/provider-status-truth";
import { logRuntimeDebug } from "@/lib/runtime-logging";
import {
  deriveOperationalSyncState,
  getSyncIncidentSummary,
} from "@/lib/sync/incidents";
import { deriveGoogleUserVisibleSyncState } from "@/lib/sync/user-visible-sync";
import type {
  GoogleAdsExtendedRangeCompletion,
  GoogleAdsPanelRecoveryMode,
  GoogleAdsPanelSurfaceState,
  GoogleAdsStatusResponse,
  GoogleAdsStatusDomainSummary,
} from "@/lib/google-ads/status-types";

function isGeneralReopenEnabled() {
  const raw = process.env.GOOGLE_ADS_EXTENDED_GENERAL_REOPEN?.trim().toLowerCase();
  return raw === "1" || raw === "true";
}

function decidePanelRecoveryMode(): GoogleAdsPanelRecoveryMode {
  if (isGoogleAdsIncidentSafeModeEnabled()) return "safe_mode";
  if (isGeneralReopenEnabled()) return "global_reopen";
  return "global_backfill";
}

function buildPanelSurfaceState(input: {
  scope: string;
  label: string;
  completedDays: number;
  totalDays: number;
  readyThroughDate: string | null;
  latestBackgroundActivityAt: string | null;
  currentMode: GoogleAdsPanelRecoveryMode;
}): GoogleAdsPanelSurfaceState {
  const totalDays = Math.max(1, input.totalDays);
  const completedDays = Math.max(0, Math.min(input.completedDays, totalDays));
  if (completedDays >= totalDays) {
    return {
      scope: input.scope,
      label: input.label,
      state: "ready",
      completedDays,
      totalDays,
      readyThroughDate: input.readyThroughDate,
      latestBackgroundActivityAt: input.latestBackgroundActivityAt,
      message: `${input.label} is fully available for this range.`,
    };
  }

  const base = {
    scope: input.scope,
    label: input.label,
    completedDays,
    totalDays,
    readyThroughDate: input.readyThroughDate,
    latestBackgroundActivityAt: input.latestBackgroundActivityAt,
  };
  const coverageLabel = `${completedDays}/${totalDays} days`;
  if (input.currentMode === "safe_mode" || input.currentMode === "global_backfill") {
    return {
      ...base,
      state: "extended_limited",
      message:
        input.currentMode === "safe_mode"
          ? `${input.label} is limited while safe mode protects core metrics. Coverage: ${coverageLabel}.`
          : `${input.label} is rebuilding under the current global execution posture. Coverage: ${coverageLabel}.`,
    };
  }

  return {
    ...base,
    state: "extended_backfilling",
    message: input.readyThroughDate
      ? `${input.label} is backfilling in the background. Ready through ${input.readyThroughDate}. Coverage: ${coverageLabel}.`
      : `${input.label} is backfilling in the background. Coverage: ${coverageLabel}.`,
  };
}

function toRangeCompletion(input: {
  completedDays: number;
  totalDays: number;
  readyThroughDate: string | null;
}): GoogleAdsExtendedRangeCompletion {
  const totalDays = Math.max(0, input.totalDays);
  const completedDays = Math.max(0, Math.min(input.completedDays, totalDays));
  return {
    completedDays,
    totalDays,
    readyThroughDate: input.readyThroughDate,
    ready: totalDays > 0 && completedDays >= totalDays,
  };
}

function clampGoogleAdsCoverageToHotWindow<
  T extends {
    completed_days?: number | null;
    ready_through_date?: string | null;
    latest_updated_at?: string | null;
    total_rows?: number | null;
  } | null
>(input: {
  coverage: T;
  startDate: string;
  endDate: string;
  supportStartDate: string;
}) {
  if (!input.coverage) return input.coverage;
  const supportedTotalDays =
    input.endDate < input.supportStartDate
      ? 0
      : dayCountInclusive(
          input.startDate < input.supportStartDate
            ? input.supportStartDate
            : input.startDate,
          input.endDate,
        );
  return {
    ...input.coverage,
    completed_days: Math.min(
      Math.max(0, Number(input.coverage.completed_days ?? 0)),
      supportedTotalDays,
    ),
    ready_through_date:
      input.coverage.ready_through_date &&
      String(input.coverage.ready_through_date) >= input.supportStartDate
        ? String(input.coverage.ready_through_date).slice(0, 10)
        : null,
  };
}

async function readGoogleAdsStatusCoverage(input: {
  businessId: string;
  scope: string;
  providerAccountId?: string | null;
  startDate: string;
  endDate: string;
  timeoutMs?: number;
}) {
  if (input.scope === "search_term_daily") {
    const queryStartedAt = Date.now();
    try {
      const coverage = await readGoogleAdsSearchIntelligenceCoverage({
        businessId: input.businessId,
        providerAccountId: input.providerAccountId ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
      });
      return {
        completed_days: coverage.completedDays,
        ready_through_date: coverage.readyThroughDate,
        latest_updated_at: coverage.latestUpdatedAt,
        total_rows: coverage.totalRows,
      };
    } catch (error) {
      console.warn("[google-ads-status] search-intelligence-coverage-failed", {
        startDate: input.startDate,
        endDate: input.endDate,
        durationMs: Date.now() - queryStartedAt,
        error: error instanceof Error ? error.message : String(error),
      });
      return null;
    }
  }

  const queryStartedAt = Date.now();
  try {
    return await getGoogleAdsDailyCoverage({
      scope: input.scope as Parameters<typeof getGoogleAdsDailyCoverage>[0]["scope"],
      businessId: input.businessId,
      providerAccountId: input.providerAccountId ?? null,
      startDate: input.startDate,
      endDate: input.endDate,
      timeoutMs: input.timeoutMs,
    });
  } catch (error) {
    const primaryMessage = error instanceof Error ? error.message : String(error);
    console.warn("[google-ads-status] coverage-primary-failed", {
      scope: input.scope,
      startDate: input.startDate,
      endDate: input.endDate,
      durationMs: Date.now() - queryStartedAt,
      error: primaryMessage,
    });

    const fallbackStartedAt = Date.now();
    try {
      const dates = await getGoogleAdsCoveredDates({
        scope: input.scope as Parameters<typeof getGoogleAdsCoveredDates>[0]["scope"],
        businessId: input.businessId,
        providerAccountId: input.providerAccountId ?? null,
        startDate: input.startDate,
        endDate: input.endDate,
        timeoutMs: input.timeoutMs,
      });
      const lastReadyDate = [...dates].sort((a, b) => a.localeCompare(b)).at(-1) ?? null;
      console.warn("[google-ads-status] coverage-fallback-succeeded", {
        scope: input.scope,
        startDate: input.startDate,
        endDate: input.endDate,
        durationMs: Date.now() - fallbackStartedAt,
        completedDays: dates.length,
        primaryError: primaryMessage,
      });
      return {
        completed_days: dates.length,
        ready_through_date: lastReadyDate,
        latest_updated_at: null,
        total_rows: 0,
      };
    } catch (fallbackError) {
      console.warn("[google-ads-status] coverage-fallback-failed", {
        scope: input.scope,
        startDate: input.startDate,
        endDate: input.endDate,
        durationMs: Date.now() - fallbackStartedAt,
        primaryError: primaryMessage,
        fallbackError:
          fallbackError instanceof Error ? fallbackError.message : String(fallbackError),
      });
      return null;
    }
  }
}

function buildGoogleDomainReadiness(input: {
  availableSurfaces: string[];
  missingSurfaces: string[];
  advisorMissingSurfaces: string[];
}) {
  const coreSurfacesReady = ["account_daily", "campaign_daily"].filter((surface) =>
    input.availableSurfaces.includes(surface)
  );
  const deepSurfacesPending = Array.from(
    new Set(
      input.missingSurfaces.filter((surface) => !["account_daily", "campaign_daily"].includes(surface))
    )
  );
  const blockingSurfaces = ["account_daily", "campaign_daily"].filter((surface) =>
    input.missingSurfaces.includes(surface)
  );
  const summary =
    blockingSurfaces.length > 0
      ? "Core spend and campaign summary are still syncing."
      : deepSurfacesPending.length > 0 || input.advisorMissingSurfaces.length > 0
        ? "Core spend and campaign summary are ready. Advisor and deeper coverage are still syncing."
        : "Google Ads core and deep reporting surfaces are ready.";
  return {
    coreSurfacesReady,
    deepSurfacesPending,
    blockingSurfaces,
    summary,
  };
}

function getTodayIsoForTimeZoneServer(timeZone: string) {
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

function summarizeStatusDegradedReason(reasons: string[]) {
  if (reasons.length === 0) return null;
  if (reasons.length === 1) return `Analysis status is degraded: ${reasons[0]}.`;
  return `Analysis status is degraded: ${reasons.slice(0, 2).join("; ")}.`;
}

function latestIsoTimestamp(values: Array<string | null | undefined>) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .map((value) => new Date(value).getTime())
      .filter((value) => Number.isFinite(value))
      .sort((left, right) => right - left)
      .map((value) => new Date(value).toISOString())[0] ?? null
  );
}

function buildAdvisorBlockingMessage(input: {
  connected: boolean;
  assignedAccountCount: number;
  advisorRelevantDeadLetterPartitions: number;
  advisorRelevantFailedPartitions: number;
  advisorRelevantUnhealthyLeases: number;
  recent84MissingSurfaces: string[];
  snapshotAvailable: boolean;
  snapshotFresh: boolean;
}) {
  if (!input.connected) return "Connect a Google Ads account to enable advisor analysis.";
  if (input.assignedAccountCount === 0) return "Assign a Google Ads account to prepare advisor inputs.";
  if (input.snapshotAvailable) {
    return input.snapshotFresh
      ? "Decision snapshot is ready."
      : "Decision snapshot is available but waiting for its next backend refresh.";
  }
  if (
    input.advisorRelevantDeadLetterPartitions > 0 ||
    input.advisorRelevantFailedPartitions > 0
  ) {
    return "Resolve Google Ads dead-letter partitions before generating the decision snapshot.";
  }
  if (input.advisorRelevantUnhealthyLeases > 0) {
    return "Recent Google Ads recovery work is still active. Analysis will unlock automatically once it settles.";
  }
  if (input.recent84MissingSurfaces.length > 0) {
    return `Waiting for recent analysis coverage in ${input.recent84MissingSurfaces.join(", ")} before generating the decision snapshot.`;
  }
  return "Decision snapshot can be generated as soon as you request a refresh.";
}

function buildGoogleAdsStatusDomains(input: {
  coreUsable: boolean;
  selectedRangeCoreIncomplete: boolean;
  selectedRangePendingSurfaces: string[];
  selectedRangeMode: "current_day_live" | "historical_warehouse";
  advisorReady: boolean;
  advisorNotReady: boolean;
  connected: boolean;
  assignedAccountCount: number;
}): {
  core: GoogleAdsStatusDomainSummary;
  selectedRange: GoogleAdsStatusDomainSummary;
  advisor: GoogleAdsStatusDomainSummary;
} {
  const core =
    !input.connected
      ? {
          state: "syncing" as const,
          label: "Not connected",
          detail: "Connect Google Ads to unlock reporting.",
        }
      : input.assignedAccountCount === 0
        ? {
            state: "syncing" as const,
            label: "Assignment required",
            detail: "Assign a Google Ads account before reporting can become usable.",
          }
        : input.coreUsable
          ? {
              state: "ready" as const,
              label: "Core reporting usable",
              detail: "Campaign spend and reporting coverage are ready to use.",
            }
          : {
              state: "syncing" as const,
              label: "Core reporting syncing",
              detail: "Campaign spend and reporting coverage are still preparing.",
            };

  const selectedRange =
    !input.coreUsable || input.selectedRangeCoreIncomplete
      ? {
          state: "syncing" as const,
          label: "Visible coverage syncing",
          detail: "Visible campaign coverage is still preparing.",
        }
      : input.selectedRangeMode === "current_day_live"
        ? {
            state: "ready" as const,
            label: "Visible coverage live",
            detail: "Current-day core coverage is served from the live overlay.",
          }
      : input.selectedRangePendingSurfaces.length > 0
        ? {
            state: "partial" as const,
            label: "Visible coverage partial",
            detail: `Extended visible coverage is still preparing for ${input.selectedRangePendingSurfaces.join(", ")}.`,
          }
        : {
            state: "ready" as const,
            label: "Visible coverage ready",
            detail: "Visible reporting surfaces are ready.",
          };

  const advisor =
    !input.connected || input.assignedAccountCount === 0
      ? {
          state: "syncing" as const,
          label: "Advisor unavailable",
          detail: "Connect and assign Google Ads before advisor analysis can prepare.",
        }
      : input.advisorReady
        ? {
            state: "ready" as const,
            label: "Advisor ready",
            detail: "Multi-window analysis coverage is ready.",
          }
        : input.advisorNotReady
          ? {
              state: "advisor_not_ready" as const,
              label: "Advisor preparing",
              detail: "Multi-window analysis coverage is still syncing.",
            }
          : {
              state: "syncing" as const,
              label: "Advisor syncing",
              detail: "Advisor readiness is still being evaluated.",
            };

  return {
    core,
    selectedRange,
    advisor,
  };
}

export async function GET(request: NextRequest) {
  const decisionEngineConfig = getGoogleAdsDecisionEngineConfig();
  const automationConfig = getGoogleAdsAutomationConfig();
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const selectedStartDate = url.searchParams.get("startDate");
  const selectedEndDate = url.searchParams.get("endDate");

  const access = await requireBusinessAccess({ request, businessId });
  if ("error" in access) return access.error;

  const sql = getDb();
  const currentRuntimeBuildId = getCurrentRuntimeBuildId();
  const controlPlaneIdentity = resolveSyncControlPlaneKey({
    buildId: currentRuntimeBuildId,
    providerScope: "google_ads",
  });
  const statusDegradedReasons: string[] = [];
  const statusSchemaReadiness = await getDbSchemaReadiness({
    tables: [
      ...PROVIDER_ACCOUNT_ASSIGNMENT_REQUIRED_TABLES,
      ...PROVIDER_ACCOUNT_SNAPSHOT_REQUIRED_TABLES,
      "provider_quota_usage",
      "provider_cooldown_state",
      "google_ads_sync_runs",
      "google_ads_sync_partitions",
      "google_ads_sync_checkpoints",
      "google_ads_sync_state",
    ],
  }).catch(() => null);
  if (statusSchemaReadiness && !statusSchemaReadiness.ready) {
    statusDegradedReasons.push(
      `schema not ready for ${statusSchemaReadiness.missingTables.join(", ")}`,
    );
  }
  const captureOptional = async <T,>(
    label: string,
    promise: Promise<T>,
    fallback: T
  ): Promise<T> => {
    try {
      return await promise;
    } catch (error) {
      statusDegradedReasons.push(
        `${label}: ${error instanceof Error ? error.message : String(error)}`
      );
      return fallback;
    }
  };

  const staleRunPressurePromise = sql`
    SELECT COUNT(*)::int AS stale_run_pressure
    FROM google_ads_sync_runs run
    WHERE run.business_id = ${businessId!}
      AND run.error_class = 'stale_run'
      AND run.updated_at > now() - interval '24 hours'
  ` as Promise<Array<{ stale_run_pressure?: number | string | null }>>;
  const recentRepairRowsPromise = sql`
    SELECT
      scope,
      COUNT(*) FILTER (WHERE status = 'queued')::int AS queued_count,
      COUNT(*) FILTER (WHERE status = 'leased')::int AS leased_count,
      COUNT(*) FILTER (WHERE status = 'running')::int AS running_count,
      COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_count,
      COUNT(*) FILTER (WHERE status = 'failed')::int AS failed_count,
      COUNT(*) FILTER (WHERE status = 'cancelled')::int AS cancelled_count,
      MAX(updated_at)::text AS latest_attempt_at
    FROM google_ads_sync_partitions
    WHERE business_id = ${businessId!}
      AND lane = 'extended'
      AND source = 'recent_recovery'
      AND scope IN ('search_term_daily', 'product_daily', 'asset_daily')
    GROUP BY scope
  ` as Promise<Array<{
    scope?: string | null;
    queued_count?: number | string | null;
    leased_count?: number | string | null;
    running_count?: number | string | null;
    succeeded_count?: number | string | null;
    failed_count?: number | string | null;
    cancelled_count?: number | string | null;
    latest_attempt_at?: string | null;
  }>>;
  const recentRepairAttemptRowsPromise = sql`
    SELECT DISTINCT ON (scope)
      scope,
      source AS trigger_source,
      status,
      last_error AS error_message,
      finished_at,
      updated_at
    FROM google_ads_sync_partitions
    WHERE business_id = ${businessId!}
      AND source = 'recent_recovery'
      AND scope IN ('search_term_daily', 'product_daily', 'asset_daily')
    ORDER BY scope, updated_at DESC
  ` as Promise<Array<{
    scope?: string | null;
    trigger_source?: string | null;
    status?: string | null;
    error_message?: string | null;
    finished_at?: string | null;
    updated_at?: string | null;
  }>>;

  const [integration, assignments, latestSync, checkpointHealth, workerSchedulingState, gateResult, repairPlanResult, persistenceResult, incidentSummaryResult, staleRunRows, recentRepairRows, recentRepairAttemptRows] =
    await Promise.all([
    captureOptional("integration", getIntegrationMetadata(businessId!, "google"), null),
    captureOptional(
      "provider_account_membership",
      getProviderAccountAssignments(businessId!, "google"),
      null
    ),
    captureOptional(
      "latest_sync_health",
      getLatestGoogleAdsSyncHealth({ businessId: businessId!, providerAccountId: null }),
      null
    ),
    captureOptional(
      "checkpoint_health",
      getGoogleAdsCheckpointHealth({ businessId: businessId!, providerAccountId: null }),
      null
    ),
    captureOptional(
      "worker_scheduling_state",
      getGoogleAdsWorkerSchedulingState({ businessId: businessId! }),
      null
    ),
    getLatestSyncGateRecords({
      buildId: controlPlaneIdentity.buildId,
      environment: controlPlaneIdentity.environment,
      providerScope: controlPlaneIdentity.providerScope,
    })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({
        value: { deployGate: null, releaseGate: null },
        error: error instanceof Error ? error.message : String(error),
      })),
    getLatestSyncRepairPlan({
      ...controlPlaneIdentity,
    })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({
        value: null,
        error: error instanceof Error ? error.message : String(error),
      })),
    getSyncControlPlanePersistenceStatus({
      ...controlPlaneIdentity,
    })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({
        value: null,
        error: error instanceof Error ? error.message : String(error),
      })),
    getSyncIncidentSummary({
      ...controlPlaneIdentity,
      businessId: businessId!,
    })
      .then((value) => ({ value, error: null }))
      .catch((error) => ({
        value: null,
        error: error instanceof Error ? error.message : String(error),
      })),
    staleRunPressurePromise.catch(() => []),
    recentRepairRowsPromise.catch(() => []),
    recentRepairAttemptRowsPromise.catch(() => []),
  ]);
  const gateRecords = gateResult.value;
  let repairPlan = repairPlanResult.value;
  let repairPlanError = repairPlanResult.error;
  let controlPlanePersistence = persistenceResult.value;
  let controlPlanePersistenceError = persistenceResult.error;
  const incidentSummary = incidentSummaryResult.value;
  const controlPlaneErrors = {
    syncGates: gateResult.error,
    repairPlan: repairPlanError,
    controlPlanePersistence: controlPlanePersistenceError,
    syncIncidents: incidentSummaryResult.error,
  };
  const currentMode = decidePanelRecoveryMode();
  const globalExtendedExecutionEnabled = currentMode !== "safe_mode";
  const effectiveLatestSync = latestSync;
  const lastTargetedRepair =
    effectiveLatestSync?.trigger_source &&
    String(effectiveLatestSync.trigger_source).startsWith("manual_targeted_repair:")
      ? {
          scope: effectiveLatestSync.scope ? String(effectiveLatestSync.scope) : null,
          triggerSource: String(effectiveLatestSync.trigger_source),
          finishedAt: effectiveLatestSync.finished_at ? String(effectiveLatestSync.finished_at) : null,
          status: effectiveLatestSync.status ? String(effectiveLatestSync.status) : null,
          lastError: effectiveLatestSync.last_error ? String(effectiveLatestSync.last_error) : null,
        }
      : null;
  const lastAutoRepair =
    effectiveLatestSync?.trigger_source &&
    String(effectiveLatestSync.trigger_source).startsWith("auto_recent_repair:")
      ? {
          scope: effectiveLatestSync.scope ? String(effectiveLatestSync.scope) : null,
          triggerSource: String(effectiveLatestSync.trigger_source),
          finishedAt: effectiveLatestSync.finished_at ? String(effectiveLatestSync.finished_at) : null,
          status: effectiveLatestSync.status ? String(effectiveLatestSync.status) : null,
          lastError: effectiveLatestSync.last_error ? String(effectiveLatestSync.last_error) : null,
        }
      : null;
  const workerBuildId =
    workerSchedulingState?.workerMeta?.workerBuildId != null
      ? String(workerSchedulingState.workerMeta.workerBuildId)
      : null;
  const workerStartedAt =
    workerSchedulingState?.workerMeta?.workerStartedAt != null
      ? String(workerSchedulingState.workerMeta.workerStartedAt)
      : null;
  const workerFreshnessState = workerSchedulingState?.workerFreshnessState ?? null;
  const currentWorkerBusinessId = workerSchedulingState?.currentBusinessId ?? null;
  const workerBatchBusinessIds = Array.isArray(workerSchedulingState?.batchBusinessIds)
    ? workerSchedulingState.batchBusinessIds.map((value) => String(value))
    : [];
  const currentConsumeStage = workerSchedulingState?.consumeStage ?? null;
  const lastConsumedBusinessId = workerSchedulingState?.lastConsumedBusinessId ?? null;
  const runtimeMismatchDetected =
    workerBuildId != null && workerBuildId !== currentRuntimeBuildId;
  const lastConsumeAttemptAt =
    workerSchedulingState?.workerMeta?.consumeStartedAt != null
      ? String(workerSchedulingState.workerMeta.consumeStartedAt)
      : null;
  const lastConsumeOutcome =
    workerSchedulingState?.workerMeta?.consumeOutcome != null
      ? String(workerSchedulingState.workerMeta.consumeOutcome)
      : null;
  const lastLeaseAcquiredAt =
    workerSchedulingState?.workerMeta?.lastLeaseAcquiredAt != null
      ? String(workerSchedulingState.workerMeta.lastLeaseAcquiredAt)
      : null;
  const lastProgressAt =
    workerSchedulingState?.workerMeta?.consumeFinishedAt != null
      ? String(workerSchedulingState.workerMeta.consumeFinishedAt)
      : null;
  const lastConsumeFinishedAt = lastProgressAt;
  const lastFailureReason =
    workerSchedulingState?.workerMeta?.consumeReason != null
      ? String(workerSchedulingState.workerMeta.consumeReason)
      : null;

  const accountIds = assignments?.account_ids ?? [];
  const connected = Boolean(integration?.status === "connected");

  const [warehouseStatsRows] = (await Promise.all([
    sql`
      SELECT
        COUNT(*) AS row_count,
        MIN(date) AS first_date,
        MAX(date) AS last_date,
        COALESCE(MAX(account_timezone), 'UTC') AS primary_account_timezone
      FROM google_ads_account_daily
      WHERE business_id = ${businessId!}
        AND (${accountIds.length > 0 ? accountIds : null}::text[] IS NULL OR provider_account_id = ANY(${accountIds.length > 0 ? accountIds : null}::text[]))
    `,
  ])) as [Array<Record<string, unknown>>];
  const warehouseStats = warehouseStatsRows[0] as
    | {
        row_count?: string | number | null;
        first_date?: string | null;
        last_date?: string | null;
        primary_account_timezone?: string | null;
      }
    | undefined;
  const snapshot = await captureOptional(
    "provider_account_snapshot",
    readProviderAccountSnapshot({
      businessId: businessId!,
      provider: "google",
    }),
    null
  );
  const primaryAccountTimezone =
    snapshot?.accounts.find((account) => account.id === accountIds[0])?.timezone ??
    warehouseStats?.primary_account_timezone ??
    "UTC";
  const currentDateInTimezone = getTodayIsoForTimeZoneServer(primaryAccountTimezone);
  const googleAdsSearchHotWindowStart = addDaysToIsoDate(
    currentDateInTimezone,
    -(GOOGLE_ADS_SEARCH_TERM_DAILY_RETENTION_DAYS - 1),
  );
  const platformDateBoundaryAccounts = await getProviderPlatformDateBoundaries({
    provider: "google",
    businessId: businessId!,
    providerAccountIds: accountIds,
    snapshot,
  }).catch(() => []);
  const selectedRangeIsToday =
    Boolean(selectedStartDate && selectedEndDate) &&
    selectedStartDate === selectedEndDate &&
    selectedStartDate === currentDateInTimezone;
  const initialBackfillEnd = addDaysToIsoDate(currentDateInTimezone, -1);
  const initialBackfillStart = getHistoricalWindowStart(
    initialBackfillEnd,
    GOOGLE_ADS_WAREHOUSE_HISTORY_DAYS
  );
  const totalDays = dayCountInclusive(initialBackfillStart, initialBackfillEnd);

  const [accountCoverage, campaignCoverage] =
      await Promise.all([
          readGoogleAdsStatusCoverage({
            scope: "account_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: initialBackfillStart,
            endDate: initialBackfillEnd,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "campaign_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: initialBackfillStart,
            endDate: initialBackfillEnd,
            timeoutMs: 30_000,
          }),
        ]);
  const [
    rawSelectedSearchTermCoverage,
    selectedProductCoverage,
    selectedAssetCoverage,
    selectedAssetGroupCoverage,
    selectedGeoCoverage,
    selectedDeviceCoverage,
    selectedAudienceCoverage,
  ] =
    selectedStartDate && selectedEndDate
      ? await Promise.all([
          readGoogleAdsStatusCoverage({
            scope: "search_term_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: selectedStartDate,
            endDate: selectedEndDate,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "product_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: selectedStartDate,
            endDate: selectedEndDate,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "asset_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: selectedStartDate,
            endDate: selectedEndDate,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "asset_group_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: selectedStartDate,
            endDate: selectedEndDate,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "geo_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: selectedStartDate,
            endDate: selectedEndDate,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "device_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: selectedStartDate,
            endDate: selectedEndDate,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "audience_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: selectedStartDate,
            endDate: selectedEndDate,
            timeoutMs: 30_000,
          }),
        ])
      : [null, null, null, null, null, null, null];
  const selectedSearchTermCoverage =
    selectedStartDate && selectedEndDate
      ? clampGoogleAdsCoverageToHotWindow({
          coverage: rawSelectedSearchTermCoverage,
          startDate: selectedStartDate,
          endDate: selectedEndDate,
          supportStartDate: googleAdsSearchHotWindowStart,
        })
      : rawSelectedSearchTermCoverage;
  const allStateScopes = [
    "account_daily",
    "campaign_daily",
    "search_term_daily",
    "product_daily",
    "asset_group_daily",
    "asset_daily",
    "geo_daily",
    "device_daily",
    "audience_daily",
  ] as const;
  const [queueHealth, ...scopeStates] =
      await Promise.all([
          captureOptional(
            "queue_health",
            getGoogleAdsQueueHealth({ businessId: businessId! }),
            null
          ),
          ...allStateScopes.map((scope) =>
            captureOptional(
              `sync_state:${scope}`,
              getGoogleAdsSyncState({
                businessId: businessId!,
                scope,
              }),
              []
            )
          ),
        ]);
  const [quotaBudgetState, breakerState] = await Promise.all([
    captureOptional(
      "quota_budget_state",
      getProviderQuotaBudgetState({
        provider: "google",
        businessId: businessId!,
      }),
      null
    ),
    captureOptional(
      "circuit_breaker_state",
      getProviderCircuitBreakerRecoveryState({
        provider: "google",
        businessId: businessId!,
      }),
      "closed" as const
    ),
  ]);
  const statesByScope = Object.fromEntries(
    allStateScopes.map((scope, index) => [scope, scopeStates[index] ?? []])
  ) as Record<
    typeof allStateScopes[number],
    Awaited<ReturnType<typeof getGoogleAdsSyncState>>
  >;
  const extendedStateScopes = allStateScopes.filter(
    (scope) => scope !== "account_daily" && scope !== "campaign_daily"
  );
  const extendedCoverageRows =
      await Promise.all(
          extendedStateScopes.map(async (scope) => ({
            scope,
            coverage: await readGoogleAdsStatusCoverage({
              scope,
              businessId: businessId!,
              providerAccountId: null,
              startDate: initialBackfillStart,
              endDate: initialBackfillEnd,
              timeoutMs: 30_000,
            }),
          }))
        );
  const extendedCoverageByScope = new Map(
    extendedCoverageRows.map((entry) => [entry.scope, entry.coverage] as const)
  );
  const selectedRangeCoverage =
    selectedStartDate && selectedEndDate
      ? await readGoogleAdsStatusCoverage({
          scope: "campaign_daily",
          businessId: businessId!,
          providerAccountId: null,
          startDate: selectedStartDate,
          endDate: selectedEndDate,
          timeoutMs: 30_000,
        })
      : null;

  const accountCoverageDays = accountCoverage?.completed_days ?? 0;
  const campaignCoverageDays = campaignCoverage?.completed_days ?? 0;
  const relevantAccountStates = statesByScope.account_daily.filter((row) =>
    accountIds.length === 0 ? true : accountIds.includes(row.providerAccountId)
  );
  const coreReadiness = buildGoogleAdsCoreReadiness({
    connected,
    assignedAccountCount: accountIds.length,
    totalDays,
    accountCoverageDays,
    campaignCoverageDays,
    campaignReadyThroughDate: campaignCoverage?.ready_through_date ?? null,
  });
  const effectiveHistoricalTotalDays = coreReadiness.effectiveHistoricalTotalDays;
  const overallCompletedDays = coreReadiness.overallCompletedDays;
  const overallAccountCompletedDays = coreReadiness.overallAccountCompletedDays;
  const historicalReadyThroughDate = coreReadiness.historicalReadyThroughDate;
  const requiredScopeReadyThroughDate =
    [
      relevantAccountStates
        .map((row) => row.readyThroughDate)
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => a.localeCompare(b))[0] ?? null,
      historicalReadyThroughDate,
    ]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right))[0] ?? null;
  const requiredScopeCompletion = buildRequiredCoverage({
    completedDays: Math.min(overallAccountCompletedDays, overallCompletedDays),
    totalDays: effectiveHistoricalTotalDays,
    readyThroughDate: requiredScopeReadyThroughDate,
  });
  const extendedScopeSummaries = allStateScopes
    .filter((scope) => scope !== "account_daily" && scope !== "campaign_daily")
    .map((scope) => {
      const relevantStates = statesByScope[scope].filter((row) =>
        accountIds.length === 0 ? true : accountIds.includes(row.providerAccountId)
      );
      const warehouseCoverage = extendedCoverageByScope.get(scope);
      const unclampedTotalDaysForScope =
        relevantStates.length > 0
          ? Math.max(
              1,
              Math.min(
                ...relevantStates.map((row) =>
                  dayCountInclusive(row.effectiveTargetStart, row.effectiveTargetEnd)
                )
              )
            )
          : effectiveHistoricalTotalDays;
      const totalDaysForScope =
        scope === "search_term_daily"
          ? Math.min(
              unclampedTotalDaysForScope,
              dayCountInclusive(
                googleAdsSearchHotWindowStart,
                currentDateInTimezone,
              ),
            )
          : unclampedTotalDaysForScope;
      const completedDays = Number(
        warehouseCoverage?.completed_days ??
          (relevantStates.length > 0
            ? Math.min(...relevantStates.map((row) => row.completedDays))
            : 0)
      );
      const readyThroughDate = warehouseCoverage?.ready_through_date
        ? String(warehouseCoverage.ready_through_date).slice(0, 10)
        : relevantStates
            .map((row) => row.readyThroughDate)
            .filter((value): value is string => Boolean(value))
            .sort((a, b) => a.localeCompare(b))[0] ?? null;
      return {
        scope,
        completedDays:
          scope === "search_term_daily"
            ? Math.min(completedDays, totalDaysForScope)
            : completedDays,
        totalDays: totalDaysForScope,
        readyThroughDate:
          scope === "search_term_daily" &&
          readyThroughDate &&
          readyThroughDate < googleAdsSearchHotWindowStart
            ? null
            : readyThroughDate,
        latestBackgroundActivityAt:
          relevantStates
            .map((row) => row.latestBackgroundActivityAt)
            .filter((value): value is string => Boolean(value))
            .sort((a, b) => b.localeCompare(a))[0] ?? null,
        deadLetterCount:
          relevantStates.length > 0
            ? Math.max(...relevantStates.map((row) => row.deadLetterCount))
            : 0,
      };
    });
  const extendedPendingSurfaces = extendedScopeSummaries
    .filter((summary) => summary.completedDays < summary.totalDays)
    .map((summary) => summary.scope);
  const productPendingSurfaces = coreReadiness.productPendingSurfaces;
  const needsBootstrap = coreReadiness.needsBootstrap;
  const historicalProgressPercent = coreReadiness.historicalProgressPercent;
  const selectedRangeTotalDays =
    selectedStartDate && selectedEndDate
      ? dayCountInclusive(selectedStartDate, selectedEndDate)
      : null;
  const selectedRangeCompletedDays = selectedRangeCoverage?.completed_days ?? 0;
  const selectedRangeCoreIncomplete =
    !selectedRangeIsToday &&
    Boolean(selectedRangeTotalDays) &&
    selectedRangeCompletedDays < (selectedRangeTotalDays ?? 0);
  const backgroundRunningJobs = Number(queueHealth?.leasedPartitions ?? 0);
  const priorityRunningJobs = 0;
  const staleBackgroundJobs = 0;
  const stalePriorityJobs = 0;
  const legacyRuntimeJobs = 0;
  const latestBackgroundActivityAt = queueHealth?.latestCoreActivityAt ?? null;
  const latestPriorityActivityAt = null;
  const runningJobs = backgroundRunningJobs;
  const staleRunningJobs = 0;
  const latestBackgroundActivityMs = latestBackgroundActivityAt
    ? new Date(String(latestBackgroundActivityAt)).getTime()
    : null;
  const backgroundRecentlyActive =
    latestBackgroundActivityMs != null &&
    Number.isFinite(latestBackgroundActivityMs) &&
    Date.now() - latestBackgroundActivityMs < 20 * 60 * 1000;
  const historicalQueuePaused =
    connected &&
    accountIds.length > 0 &&
    overallCompletedDays < effectiveHistoricalTotalDays &&
    backgroundRunningJobs === 0 &&
    !backgroundRecentlyActive;
  const priorityWindow =
    selectedStartDate && selectedEndDate && selectedRangeTotalDays
      ? {
          startDate: selectedStartDate,
          endDate: selectedEndDate,
          completedDays: selectedRangeCompletedDays,
          totalDays: selectedRangeTotalDays,
          isActive:
            selectedRangeCoreIncomplete &&
            (priorityRunningJobs > 0 ||
              (latestPriorityActivityAt != null &&
                Date.now() - new Date(String(latestPriorityActivityAt)).getTime() < 10 * 60 * 1000)),
        }
      : null;
  const phaseLabel = historicalQueuePaused
      ? "Historical sync is paused"
    : overallCompletedDays < effectiveHistoricalTotalDays
      ? "Backfilling historical data"
      : effectiveLatestSync?.sync_type === "incremental_recent" ||
          effectiveLatestSync?.sync_type === "today_refresh"
        ? "Syncing recent history"
        : "Ready";
  const latestError = effectiveLatestSync?.last_error ? String(effectiveLatestSync.last_error) : null;

  const recent84Start = addDaysToIsoDate(initialBackfillEnd, -(GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS - 1));
  const [
    recent84CampaignCoverage,
    recent84SearchTermCoverage,
    recent84ProductCoverage,
    latestAdvisorSnapshot,
    advisorQueueHealth,
    advisorSurfacePartitionStates,
  ] =
      await Promise.all([
          readGoogleAdsStatusCoverage({
            scope: "campaign_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: recent84Start,
            endDate: initialBackfillEnd,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "search_term_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: recent84Start,
            endDate: initialBackfillEnd,
            timeoutMs: 30_000,
          }),
          readGoogleAdsStatusCoverage({
            scope: "product_daily",
            businessId: businessId!,
            providerAccountId: null,
            startDate: recent84Start,
            endDate: initialBackfillEnd,
            timeoutMs: 30_000,
          }),
          captureOptional(
            "latest_advisor_snapshot",
            getLatestGoogleAdsAdvisorSnapshot({
              businessId: businessId!,
              accountId: accountIds.length === 1 ? accountIds[0] : null,
            }),
            null
          ),
          captureOptional(
            "advisor_queue_health",
            getGoogleAdsAdvisorQueueHealth({
              businessId: businessId!,
              startDate: recent84Start,
              endDate: initialBackfillEnd,
            }),
            null
          ),
          captureOptional(
            "advisor_surface_partition_states",
            getGoogleAdsAdvisorSurfacePartitionStates({
              businessId: businessId!,
              providerAccountId: accountIds.length === 1 ? accountIds[0] : null,
              startDate: recent84Start,
              endDate: initialBackfillEnd,
            }),
            []
          ),
        ]);
  const advisorRequiredSurfaces = [
    {
      name: GOOGLE_ADS_ADVISOR_REQUIRED_SURFACES[0],
      coverage: recent84CampaignCoverage,
    },
    {
      name: GOOGLE_ADS_ADVISOR_REQUIRED_SURFACES[1],
      coverage: recent84SearchTermCoverage,
    },
    {
      name: GOOGLE_ADS_ADVISOR_REQUIRED_SURFACES[2],
      coverage: recent84ProductCoverage,
    },
  ];
  const advisorOptionalSurfaces = [
    {
      name: "asset_daily",
      coverage: selectedAssetCoverage,
    },
    {
      name: "asset_group_daily",
      coverage: selectedAssetGroupCoverage,
    },
    {
      name: "geo_daily",
      coverage: selectedGeoCoverage,
    },
    {
      name: "device_daily",
      coverage: selectedDeviceCoverage,
    },
    {
      name: "audience_daily",
      coverage: selectedAudienceCoverage,
    },
  ];
  const advisorAvailableSurfaces = [
    ...advisorRequiredSurfaces,
    ...advisorOptionalSurfaces,
  ]
    .filter(
      (entry) =>
        isGoogleAdsAdvisorWindowReady(entry.coverage?.completed_days ?? 0)
    )
    .map((entry) => entry.name);
  const advisorMissingSurfaces = advisorRequiredSurfaces
    .filter(
      (entry) =>
        !isGoogleAdsAdvisorWindowReady(entry.coverage?.completed_days ?? 0)
    )
    .map((entry) => entry.name);
  const advisorCoverageUnavailableCount = advisorRequiredSurfaces.filter(
    (entry) => entry.coverage == null
  ).length;
  const snapshotAvailable = Boolean(latestAdvisorSnapshot);
  const snapshotFresh = isGoogleAdsAdvisorSnapshotFresh(latestAdvisorSnapshot);
  const latestAdvisorActionContract =
    latestAdvisorSnapshot?.advisorPayload?.metadata?.actionContract ?? null;
  const latestAdvisorAggregateIntelligence =
    latestAdvisorSnapshot?.advisorPayload?.metadata?.aggregateIntelligence ?? null;
  const latestAdvisorAiAssist =
    latestAdvisorSnapshot?.advisorPayload?.metadata?.aiAssist ?? null;
  const advisorAiAssistBoundary = getGoogleAdsAdvisorAiStructuredAssistBoundaryState({
    businessId,
  });
  const autonomyBoundary = getGoogleAdsAutonomyBoundaryState({
    businessId,
    accountId: null,
  });
  const retentionRuntime = getGoogleAdsRetentionRuntimeStatus();
  const latestRetentionRun =
    retentionRuntime.runtimeAvailable
      ? await getLatestGoogleAdsRetentionRun().catch(() => null)
      : null;
  const latestRetentionRunRows = getGoogleAdsRetentionRunRows(latestRetentionRun);
  const latestRawHotRetentionRows = latestRetentionRunRows.filter((row) =>
    [
      "google_ads_search_query_hot_daily",
      "google_ads_search_term_daily",
    ].includes(row.tableName)
  );
  const advisorRelevantDeadLetterPartitions =
    advisorQueueHealth?.advisorRelevantDeadLetterPartitions ?? 0;
  const advisorRelevantFailedPartitions =
    advisorQueueHealth?.advisorRelevantFailedPartitions ?? 0;
  const advisorRelevantLeasedPartitions =
    advisorQueueHealth?.advisorRelevantLeasedPartitions ?? 0;
  const historicalDeadLetterPartitions =
    advisorQueueHealth?.historicalDeadLetterPartitions ??
    Math.max(
      0,
      (queueHealth?.deadLetterPartitions ?? 0) - advisorRelevantDeadLetterPartitions
    );
  const advisorRelevantUnhealthyLeases =
    (workerSchedulingState?.healthy ?? false) ? 0 : advisorRelevantLeasedPartitions;
  const advisorDecision = decideGoogleAdsAdvisorReadiness({
    connected,
    assignedAccountCount: accountIds.length,
    deadLetterPartitions: queueHealth?.deadLetterPartitions ?? 0,
    recentSupportReady:
      advisorMissingSurfaces.length === 0 && advisorCoverageUnavailableCount === 0,
    snapshotAvailable,
  });
  const advisorReady = advisorDecision.ready;
  const advisorNotReady = advisorDecision.notReady;
  const advisorSnapshotBlockedReason =
    snapshotAvailable
      ? null
      : advisorMissingSurfaces.length > 0
        ? "missing_recent_required_surfaces"
        : advisorRelevantDeadLetterPartitions > 0
          ? "recent_required_dead_letter_partitions"
          : advisorRelevantFailedPartitions > 0
            ? "recent_required_failed_partitions"
            : advisorRelevantUnhealthyLeases > 0
              ? "recent_required_unhealthy_leases"
              : null;
  const googleBlockingReasons = compactBlockingReasons([
    advisorMissingSurfaces.length > 0
      ? buildBlockingReason(
          "missing_required_recent_surfaces",
          `Recent required surfaces are still missing: ${advisorMissingSurfaces.join(", ")}.`,
        )
      : null,
    advisorRelevantDeadLetterPartitions > 0
      ? buildBlockingReason(
          "recent_required_dead_letter_partitions",
          `${advisorRelevantDeadLetterPartitions} required recent Google Ads partition(s) are dead-lettered.`,
          { repairable: true }
        )
      : null,
    advisorRelevantFailedPartitions > 0
      ? buildBlockingReason(
          "recent_required_failed_partitions",
          `${advisorRelevantFailedPartitions} required recent Google Ads partition(s) are waiting for retry or replay.`,
          { repairable: true }
        )
      : null,
    advisorRelevantUnhealthyLeases > 0
      ? buildBlockingReason(
          "recent_required_unhealthy_leases",
          `${advisorRelevantUnhealthyLeases} required recent Google Ads partition lease(s) look unhealthy.`,
          { repairable: true }
        )
      : null,
  ]);
  const googleRepairableActions = compactRepairableActions([
    buildRepairableAction(
      "refresh_queue",
      "Run targeted queue repair and re-plan missing required Google Ads partitions.",
      { available: (queueHealth?.queueDepth ?? 0) > 0 || (queueHealth?.leasedPartitions ?? 0) > 0 }
    ),
    advisorRelevantDeadLetterPartitions > 0
      ? buildRepairableAction(
          "replay_dead_letters",
          "Replay required recent dead-letter partitions into the queue."
        )
      : null,
    advisorRelevantFailedPartitions > 0
      ? buildRepairableAction(
          "requeue_failed",
          "Requeue retryable required recent failed partitions."
        )
      : null,
  ]);
  const googleRequiredCoverage = buildRequiredCoverage({
    completedDays: Math.min(
      Number(recent84CampaignCoverage?.completed_days ?? 0),
      Number(recent84SearchTermCoverage?.completed_days ?? 0),
      Number(recent84ProductCoverage?.completed_days ?? 0)
    ),
    totalDays: GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS,
    readyThroughDate: [
      recent84CampaignCoverage?.ready_through_date ?? null,
      recent84SearchTermCoverage?.ready_through_date ?? null,
      recent84ProductCoverage?.ready_through_date ?? null,
    ]
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right))[0] ?? null,
  });
  logRuntimeDebug("google-ads-status", "advisor_snapshot_gate", {
    businessId: businessId!,
    advisorWindowStart: recent84Start,
    advisorWindowEnd: initialBackfillEnd,
    recent84MissingSurfaces: advisorMissingSurfaces,
    advisorRelevantDeadLetterPartitions,
    advisorRelevantFailedPartitions,
    advisorRelevantUnhealthyLeases,
    historicalDeadLetterPartitions,
    snapshotAvailable,
    snapshotBlockedReason: advisorSnapshotBlockedReason,
  });
  const fullSyncPriority = decideGoogleAdsFullSyncPriority({
    advisorReady,
    advisorMissingSurfaces,
  });
  const availableSurfaces = [
    overallAccountCompletedDays >= effectiveHistoricalTotalDays ? "account_daily" : null,
    overallCompletedDays >= effectiveHistoricalTotalDays ? "campaign_daily" : null,
    ...extendedScopeSummaries
      .filter((summary) => summary.completedDays >= summary.totalDays)
      .map((summary) => summary.scope),
  ].filter((value): value is string => Boolean(value));
  const surfaces = buildProviderSurfaces({
    required: [
      "account_daily",
      "campaign_daily",
      "search_term_daily",
      "product_daily",
      "asset_daily",
      "asset_group_daily",
      "geo_daily",
      "device_daily",
      "audience_daily",
    ],
    available: availableSurfaces,
  });
  const surfaceReadinessLevel = decideProviderReadinessLevel({
    required: surfaces.required,
    available: surfaces.available,
    usable: ["account_daily", "campaign_daily"],
  });
  const domainReadiness = buildGoogleDomainReadiness({
    availableSurfaces,
    missingSurfaces: surfaces.missing,
    advisorMissingSurfaces,
  });
  const coreUsable = coreReadiness.coreUsable;
  const selectedCoverageByScope = {
    search_term_daily: selectedSearchTermCoverage,
    product_daily: selectedProductCoverage,
    asset_daily: selectedAssetCoverage,
    asset_group_daily: selectedAssetGroupCoverage,
    geo_daily: selectedGeoCoverage,
    device_daily: selectedDeviceCoverage,
    audience_daily: selectedAudienceCoverage,
  } as const;
  const rangeCompletionBySurface = Object.fromEntries(
    (Object.keys(selectedCoverageByScope) as Array<keyof typeof selectedCoverageByScope>).map(
      (scope) => {
        const historicalSummary = extendedScopeSummaries.find(
          (summary) => summary.scope === scope
        );
        return [
          scope,
          {
            selectedRange: toRangeCompletion({
              completedDays: selectedCoverageByScope[scope]?.completed_days ?? 0,
              totalDays: selectedRangeTotalDays ?? 0,
              readyThroughDate: selectedCoverageByScope[scope]?.ready_through_date ?? null,
            }),
            historical: toRangeCompletion({
              completedDays: historicalSummary?.completedDays ?? 0,
              totalDays: historicalSummary?.totalDays ?? effectiveHistoricalTotalDays,
              readyThroughDate: historicalSummary?.readyThroughDate ?? null,
            }),
          },
        ];
      }
    )
  ) as Record<
    keyof typeof selectedCoverageByScope,
    {
      selectedRange: GoogleAdsExtendedRangeCompletion;
      historical: GoogleAdsExtendedRangeCompletion;
    }
  >;
  const recentGapCountByScope = Object.fromEntries(
    Object.entries(rangeCompletionBySurface).map(([scope, surface]) => [
      scope,
      Math.max(0, surface.selectedRange.totalDays - surface.selectedRange.completedDays),
    ])
  );
  const recentRepairRowsByScope = new Map(
    recentRepairRows.map((row) => [String(row.scope ?? ""), row] as const)
  );
  const recentGapRepairingByScope = Object.fromEntries(
    Object.keys(rangeCompletionBySurface).map((scope) => [
      scope,
      Number(recentRepairRowsByScope.get(scope)?.queued_count ?? 0) > 0 ||
        Number(recentRepairRowsByScope.get(scope)?.leased_count ?? 0) > 0 ||
        Number(recentRepairRowsByScope.get(scope)?.running_count ?? 0) > 0,
    ])
  );
  const recentGapLastAttemptAtByScope = Object.fromEntries(
    Object.keys(rangeCompletionBySurface).map((scope) => [
      scope,
      recentRepairRowsByScope.get(scope)?.latest_attempt_at
        ? String(recentRepairRowsByScope.get(scope)?.latest_attempt_at)
        : null,
    ])
  );
  const recentGapQueuedByScope = Object.fromEntries(
    Object.keys(rangeCompletionBySurface).map((scope) => [
      scope,
      Number(recentRepairRowsByScope.get(scope)?.queued_count ?? 0),
    ])
  );
  const recentGapLeasedByScope = Object.fromEntries(
    Object.keys(rangeCompletionBySurface).map((scope) => [
      scope,
      Number(recentRepairRowsByScope.get(scope)?.leased_count ?? 0) +
        Number(recentRepairRowsByScope.get(scope)?.running_count ?? 0),
    ])
  );
  const recentGapSucceededByScope = Object.fromEntries(
    Object.keys(rangeCompletionBySurface).map((scope) => [
      scope,
      Number(recentRepairRowsByScope.get(scope)?.succeeded_count ?? 0),
    ])
  );
  const recentGapFailedByScope = Object.fromEntries(
    Object.keys(rangeCompletionBySurface).map((scope) => [
      scope,
      Number(recentRepairRowsByScope.get(scope)?.failed_count ?? 0) +
        Number(recentRepairRowsByScope.get(scope)?.cancelled_count ?? 0),
    ])
  );
  const hasRecentGap = Object.values(recentGapCountByScope).some((count) => Number(count) > 0);
  const hasRecentRepairQueued = Object.values(recentGapQueuedByScope).some(
    (count) => Number(count) > 0
  );
  const hasRecentRepairLeased = Object.values(recentGapLeasedByScope).some(
    (count) => Number(count) > 0
  );
  const hasRecentRepairSucceeded = Object.values(recentGapSucceededByScope).some(
    (count) => Number(count) > 0
  );
  const hasRecentRepairFailed = Object.values(recentGapFailedByScope).some(
    (count) => Number(count) > 0
  );
  const recentRepairAttemptsByScope = new Map(
    recentRepairAttemptRows.map((row) => [String(row.scope ?? ""), row] as const)
  );
  const lastAutoRepairAttemptByScope = Object.fromEntries(
    Object.keys(rangeCompletionBySurface).map((scope) => [
      scope,
      recentRepairAttemptsByScope.get(scope)?.updated_at
        ? String(recentRepairAttemptsByScope.get(scope)?.updated_at)
        : null,
    ])
  );
  const recentExtendedReady = Object.values(rangeCompletionBySurface).every(
    (surface) => surface.selectedRange.ready
  );
  const historicalExtendedReady = Object.values(rangeCompletionBySurface).every(
    (surface) => surface.historical.ready
  );
  const advisorProgress = buildGoogleAdsAdvisorProgress({
    connected,
    assignedAccountCount: accountIds.length,
    coreUsable,
    advisorReady,
    coverages: advisorRequiredSurfaces.map((surface) => ({
      completedDays: surface.coverage?.completed_days ?? null,
    })),
    coverageUnavailableCount: advisorCoverageUnavailableCount,
  });
  const selectedRangePendingSurfaces = selectedRangeIsToday
    ? []
    : Object.entries(rangeCompletionBySurface)
        .filter(([, surface]) => !surface.selectedRange.ready)
        .map(([scope]) => scope);
  const globalSyncProgress = advisorProgress.visible
    ? {
        kind: "advisor" as const,
        percent: advisorProgress.percent,
        visible: advisorProgress.visible,
        label: `Preparing ${GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS}-day support`,
        summary: advisorProgress.summary,
      }
    : connected &&
        accountIds.length > 0 &&
        !selectedRangeIsToday &&
        !requiredScopeCompletion.complete
      ? {
          kind: "historical" as const,
          percent: historicalProgressPercent,
          visible: true,
          label: "Extended sync",
          summary: "Required Google Ads warehouse sync continues in the background.",
        }
      : null;
  const currentDayLiveStatus = {
    active: selectedRangeIsToday,
    usingLiveOverlay: selectedRangeIsToday && coreUsable,
    coreUsable: selectedRangeIsToday && coreUsable,
    currentDate: selectedRangeIsToday ? currentDateInTimezone : null,
    warehouseSegmentEndDate: selectedRangeIsToday
      ? addDaysToIsoDateUtc(currentDateInTimezone, -1)
      : null,
    liveSegmentStartDate: selectedRangeIsToday ? currentDateInTimezone : null,
  };
  const selectedRangeReadinessBasis = {
    mode: selectedRangeIsToday ? "current_day_live" : "historical_warehouse",
    warehouseCoverageIgnored: selectedRangeIsToday,
    liveOverlayEligible: selectedRangeIsToday && coreUsable,
  } as const;
  const historicalBackfillPercent = requiredScopeCompletion.percent;
  const historicalProgressSummary =
    "Required Google Ads warehouse sync continues in the background.";
  const surfaceLabels: Record<keyof typeof selectedCoverageByScope, string> = {
    search_term_daily: "Search intelligence",
    product_daily: "Product performance",
    asset_daily: "Asset performance",
    asset_group_daily: "Asset group coverage",
    geo_daily: "Geo performance",
    device_daily: "Device performance",
    audience_daily: "Audience performance",
  };
  const majorSurfaceStates = (
    Object.keys(selectedCoverageByScope) as Array<keyof typeof selectedCoverageByScope>
  ).map((scope) =>
    buildPanelSurfaceState({
      scope,
      label: surfaceLabels[scope],
      completedDays:
        selectedCoverageByScope[scope]?.completed_days ??
        extendedScopeSummaries.find((summary) => summary.scope === scope)?.completedDays ??
        0,
      totalDays:
        selectedRangeTotalDays ??
        extendedScopeSummaries.find((summary) => summary.scope === scope)?.totalDays ??
        effectiveHistoricalTotalDays,
      readyThroughDate:
        selectedCoverageByScope[scope]?.ready_through_date ??
        extendedScopeSummaries.find((summary) => summary.scope === scope)?.readyThroughDate ??
        null,
      latestBackgroundActivityAt:
        extendedScopeSummaries.find((summary) => summary.scope === scope)
          ?.latestBackgroundActivityAt ?? null,
      currentMode,
    })
  );
  const extendedLimited = majorSurfaceStates.some((surface) => surface.state !== "ready");
  const panelHeadline =
    coreUsable && extendedLimited
      ? "Core metrics are live. Extended intelligence is backfilling."
      : coreUsable
        ? "Google Ads core metrics are live."
        : connected
          ? "Google Ads core metrics are still preparing."
          : "Connect Google Ads to start loading panel data.";
  const panelDetail =
    coreUsable && extendedLimited
      ? "Search, product, and asset insights may be partial while recovery is in progress."
      : coreUsable
        ? "Campaign and advisor surfaces are ready to use."
        : "Core spend and campaign coverage must be ready before the full panel feels complete.";
  const extendedRecoveryState =
    currentMode === "safe_mode" || breakerState === "open"
      ? "core_only"
      : historicalExtendedReady
        ? "extended_normal"
        : "extended_recovery";
  const extendedRecentReadyThroughDate = Object.values(rangeCompletionBySurface)
    .map((surface) => surface.selectedRange.readyThroughDate)
    .filter((value): value is string => Boolean(value))
    .sort((a, b) => a.localeCompare(b))[0] ?? null;
  const extendedRecoveryBlockReason = getGoogleAdsExtendedRecoveryBlockReason({
    policy: buildGoogleAdsLaneAdmissionPolicy({
      safeModeEnabled: currentMode === "safe_mode",
      workerHealthy:
        runningJobs > 0 ||
        (queueHealth?.leasedPartitions ?? 0) > 0 ||
        (queueHealth?.extendedRecentLeasedPartitions ?? 0) > 0,
      workerCapacityAvailable: true,
      breakerOpen: breakerState === "open",
      queueDepth: queueHealth?.queueDepth ?? 0,
      extendedQueueDepth: queueHealth?.extendedQueueDepth ?? 0,
      maintenanceQueueDepth: queueHealth?.maintenanceQueueDepth ?? 0,
      quotaPressure: quotaBudgetState?.pressure ?? 0,
      maintenanceBudgetAllowed: quotaBudgetState?.maintenanceAllowed ?? true,
      extendedBudgetAllowed: quotaBudgetState?.extendedAllowed ?? false,
      extendedCanaryEligible: globalExtendedExecutionEnabled,
      recoveryMode: breakerState,
    }),
    queueHealth,
  });
  const staleRunPressure = Number(staleRunRows[0]?.stale_run_pressure ?? 0);
  const autoRepairExecutionStage = (() => {
    if (runtimeMismatchDetected && hasRecentGap) return "runtime_waiting" as const;
    if (!hasRecentGap && !hasRecentRepairQueued && !hasRecentRepairLeased) {
      return hasRecentRepairSucceeded ? ("completed" as const) : null;
    }
    const hasAttempt = Object.values(lastAutoRepairAttemptByScope).some(Boolean);
    if (hasRecentRepairFailed && !hasRecentRepairQueued && !hasRecentRepairLeased && hasRecentGap) {
      return "failed" as const;
    }
    if (hasRecentGap && !hasAttempt && !hasRecentRepairQueued && !hasRecentRepairLeased) {
      return "not_planned" as const;
    }
    if (hasRecentRepairQueued && !hasRecentRepairLeased) return "planned_not_leased" as const;
    if (hasRecentRepairLeased) return "leased_not_completed" as const;
    if (hasRecentRepairSucceeded && hasRecentGap) return "completed_state_stale" as const;
    if (hasRecentRepairSucceeded) return "completed" as const;
    return null;
  })();
  const lastAutoRepairOutcome =
    autoRepairExecutionStage === "completed"
      ? "completed"
      : autoRepairExecutionStage === "failed"
        ? "failed"
        : autoRepairExecutionStage === "leased_not_completed"
          ? "running"
          : autoRepairExecutionStage === "planned_not_leased"
            ? "queued"
            : autoRepairExecutionStage === "completed_state_stale"
              ? "completed"
              : "unknown";
  const extendedSuppressionDecisionTrace =
    extendedRecoveryBlockReason === "worker_unhealthy"
      ? {
          decisionCaller: "compactGoogleAdsIncidentBacklog",
          providerScopeSeen: "google_ads",
          heartbeatAgeMs: workerSchedulingState?.heartbeatAgeMs ?? null,
          runnerLeaseSeen: workerSchedulingState?.runnerLeaseActive ?? false,
          breakerState,
          recoveryMode: breakerState,
          globalExtendedExecutionEnabled,
          quotaPressure: quotaBudgetState?.pressure ?? 0,
          queueDepthSnapshot: queueHealth?.queueDepth ?? 0,
          extendedQueueDepthSnapshot: queueHealth?.extendedQueueDepth ?? 0,
        }
      : null;

  const actionRequiredState = {
    reconnectCta: (queueHealth?.actionRequiredDeadLetterPartitions ?? 0) > 0,
    partitions: queueHealth?.actionRequiredDeadLetterPartitions ?? 0,
    blockingPartitions:
      queueHealth?.actionRequiredBlockingDeadLetterPartitions ?? 0,
    scopes: queueHealth?.actionRequiredDeadLetterScopes ?? [],
    blockingScopes: queueHealth?.actionRequiredBlockingDeadLetterScopes ?? [],
  };
  const decidedOverallState = decideGoogleAdsStatusState({
      connected,
      assignedAccountCount: accountIds.length,
      coreUsable,
      historicalQueuePaused,
      deadLetterPartitions: queueHealth?.deadLetterPartitions ?? 0,
      advisorRelevantDeadLetterPartitions,
      advisorRelevantFailedPartitions,
      advisorRelevantUnhealthyLeases,
      latestSyncStatus: effectiveLatestSync?.status ? String(effectiveLatestSync.status) : null,
      runningJobs,
      staleRunningJobs,
      selectedRangeCoreIncomplete,
      visibleSelectedRangePendingSurfaces: selectedRangePendingSurfaces,
      historicalProgressPercent,
      needsBootstrap,
      productPendingSurfaces,
      selectedRangeTotalDays,
      advisorMissingSurfaces,
      advisorNotReady,
    });
  const overallState = actionRequiredState.reconnectCta
    ? "action_required"
    : decidedOverallState;
  const domains = buildGoogleAdsStatusDomains({
    coreUsable,
    selectedRangeCoreIncomplete,
    selectedRangePendingSurfaces,
    selectedRangeMode: selectedRangeIsToday ? "current_day_live" : "historical_warehouse",
    advisorReady,
    advisorNotReady,
    connected,
    assignedAccountCount: accountIds.length,
  });
  const latestGoogleActivityAt =
    queueHealth?.latestCoreActivityAt ??
    queueHealth?.latestExtendedActivityAt ??
    queueHealth?.latestMaintenanceActivityAt ??
    null;
  const googleProgressEvidence = buildProviderProgressEvidence({
    states: allStateScopes.flatMap((scope) =>
      statesByScope[scope].filter((row) =>
        accountIds.length === 0 ? true : accountIds.includes(row.providerAccountId)
      )
    ),
    checkpointUpdatedAt: checkpointHealth?.latestCheckpointUpdatedAt ?? null,
    recentActivityWindowMinutes: 20,
    aggregation: "latest",
  });
  const googleProgressState = deriveProviderProgressState({
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
    latestPartitionActivityAt: latestGoogleActivityAt,
    blocked: overallState === "action_required",
    fullyReady: overallState === "ready",
    staleRunPressure,
    progressEvidence: googleProgressEvidence,
  });
  const googleActivityState =
    !connected || accountIds.length === 0
      ? ("waiting" as const)
      : deriveProviderActivityState({
          progressState: googleProgressState,
          queueDepth: queueHealth?.queueDepth ?? 0,
          leasedPartitions: queueHealth?.leasedPartitions ?? 0,
          blocked: overallState === "action_required",
        });
  const googleStallFingerprints = deriveProviderStallFingerprints({
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
    latestPartitionActivityAt: latestGoogleActivityAt,
    blocked: overallState === "action_required",
    staleRunPressure,
    progressEvidence: googleProgressEvidence,
    blockedReasonCodes: googleBlockingReasons.map((reason) => reason.code),
    historicalBacklogDepth:
      (queueHealth?.extendedHistoricalQueueDepth ?? 0) +
      (queueHealth?.extendedHistoricalLeasedPartitions ?? 0),
  });
  const quotaLimited =
    Boolean(
      quotaBudgetState &&
        (!quotaBudgetState.withinDailyBudget ||
          !quotaBudgetState.maintenanceAllowed ||
          !quotaBudgetState.extendedAllowed ||
          quotaBudgetState.errorCount > 0),
    ) || extendedRecoveryBlockReason === "extended_budget_denied";
  const latestSuccessfulScopeSyncAt = latestIsoTimestamp(
    allStateScopes.flatMap((scope) =>
      statesByScope[scope]
        .filter((row) =>
          accountIds.length === 0 ? true : accountIds.includes(row.providerAccountId),
        )
        .map((row) => row.latestSuccessfulSyncAt ?? null),
    ),
  );
  const latestMeaningfulProgressAt = latestIsoTimestamp([
    checkpointHealth?.latestCheckpointUpdatedAt ?? null,
    latestGoogleActivityAt,
    latestSuccessfulScopeSyncAt,
  ]);
  const runtimeObservationWindowMinutes = 30;
  const latestMeaningfulProgressMs = latestMeaningfulProgressAt
    ? new Date(latestMeaningfulProgressAt).getTime()
    : null;
  const meaningfulProgressRecent =
    latestMeaningfulProgressMs != null &&
    Number.isFinite(latestMeaningfulProgressMs) &&
    Date.now() - latestMeaningfulProgressMs <=
      runtimeObservationWindowMinutes * 60 * 1000;
  const backgroundBackfillPendingScopes = Array.from(
    new Set([
      ...(!requiredScopeCompletion.complete ? ["account_daily", "campaign_daily"] : []),
      ...extendedPendingSurfaces,
      ...productPendingSurfaces,
      ...advisorMissingSurfaces,
    ]),
  );
  const backgroundBackfillIncomplete =
    connected && accountIds.length > 0 && backgroundBackfillPendingScopes.length > 0;
  const activeBackfillWork =
    (queueHealth?.queueDepth ?? 0) > 0 || (queueHealth?.leasedPartitions ?? 0) > 0;
  const backgroundBackfillStalled =
    backgroundBackfillIncomplete &&
    !activeBackfillWork &&
    !meaningfulProgressRecent &&
    !quotaLimited &&
    breakerState === "closed" &&
    overallState !== "action_required";
  const heartbeatOnly =
    Boolean(workerSchedulingState?.hasFreshHeartbeat) &&
    backgroundBackfillIncomplete &&
    !meaningfulProgressRecent;
  const runtimeProgress = {
    meaningfulProgressRecent,
    heartbeatOnly,
    latestMeaningfulProgressAt,
    latestCheckpointUpdatedAt: checkpointHealth?.latestCheckpointUpdatedAt ?? null,
    latestSuccessfulScopeSyncAt,
    latestPartitionActivityAt: latestGoogleActivityAt,
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    observationWindowMinutes: runtimeObservationWindowMinutes,
  };
  const backgroundBackfill = {
    state: !backgroundBackfillIncomplete
      ? ("ready" as const)
      : overallState === "action_required" || breakerState === "open"
        ? ("blocked" as const)
        : quotaLimited
          ? ("quota_limited" as const)
          : activeBackfillWork
            ? ("active" as const)
            : backgroundBackfillStalled
              ? ("stalled" as const)
              : ("waiting" as const),
    percent: requiredScopeCompletion.percent,
    incomplete: backgroundBackfillIncomplete,
    pendingScopes: backgroundBackfillPendingScopes,
    readyThroughDate: requiredScopeCompletion.readyThroughDate ?? historicalReadyThroughDate,
    latestProgressAt: latestMeaningfulProgressAt,
    reason: !backgroundBackfillIncomplete
      ? null
      : overallState === "action_required" || breakerState === "open"
        ? "Google Ads backfill is blocked by operational recovery state."
        : quotaLimited
          ? "Google Ads quota or breaker budget is limiting backfill."
          : activeBackfillWork
            ? "Google Ads backfill work is queued or leased."
            : backgroundBackfillStalled
              ? "No queue drain, lease, checkpoint, publish, or successful scope movement was observed in the backfill window."
              : "Google Ads backfill is waiting for the next worker scheduling window.",
  };
  const effectiveGoogleStallFingerprints = Array.from(
    new Set([
      ...googleStallFingerprints,
      ...(backgroundBackfillStalled
        ? (["historical_starvation", "checkpoint_not_advancing"] as const)
        : []),
    ]),
  );
  const googleUnifiedTruth =
    !connected || accountIds.length === 0
      ? {
          syncTruthState: "waiting" as const,
          blockerClass: "none" as const,
        }
      : deriveUnifiedSyncTruth({
          activityState: googleActivityState,
          progressState: googleProgressState,
          workerOnline: workerSchedulingState?.healthy ?? null,
          queueDepth: queueHealth?.queueDepth ?? 0,
          leasedPartitions: queueHealth?.leasedPartitions ?? 0,
        });
  const googleControlPlaneSyncTruth = resolveGoogleAdsControlPlaneSyncTruth({
    latestSyncStatus: effectiveLatestSync?.status ? String(effectiveLatestSync.status) : null,
    latestSyncScope:
      typeof effectiveLatestSync?.scope === "string" ? effectiveLatestSync.scope : null,
    queueDepth: queueHealth?.coreQueueDepth ?? 0,
    deadLetterPartitions:
      queueHealth?.coreBlockingDeadLetterPartitions ??
      queueHealth?.blockingDeadLetterPartitions ??
      queueHealth?.deadLetterPartitions ??
      0,
    scopeStates: Object.values(statesByScope).flat(),
  });
  const googleStatusRouteTruthReady =
    googleControlPlaneSyncTruth.servingReady ||
    (coreUsable &&
      (queueHealth?.coreBlockingDeadLetterPartitions ??
        queueHealth?.blockingDeadLetterPartitions ??
        queueHealth?.deadLetterPartitions ??
        0) === 0 &&
      (effectiveLatestSync?.status !== "failed" ||
        !["account_daily", "campaign_daily"].includes(
          typeof effectiveLatestSync?.scope === "string" ? effectiveLatestSync.scope : "",
        )));
  const googleReleaseReadinessCandidate =
    buildGoogleAdsReleaseReadinessCandidate({
      connected,
      assignedAccountCount: accountIds.length,
      activityState: googleActivityState,
      progressState: googleProgressState,
      workerOnline: workerSchedulingState?.healthy ?? null,
      queueDepth: queueHealth?.coreQueueDepth ?? 0,
      totalQueueDepth: queueHealth?.queueDepth ?? 0,
      leasedPartitions: queueHealth?.coreLeasedPartitions ?? 0,
      retryableFailedPartitions: advisorRelevantFailedPartitions,
      deadLetterPartitions:
        queueHealth?.coreBlockingDeadLetterPartitions ??
        queueHealth?.blockingDeadLetterPartitions ??
        queueHealth?.deadLetterPartitions ??
        0,
      staleLeasePartitions: advisorRelevantUnhealthyLeases,
      syncTruthState: googleUnifiedTruth.syncTruthState,
      truthReady: googleStatusRouteTruthReady,
      stallFingerprints: effectiveGoogleStallFingerprints,
    });
  const providerState = buildProviderStateContract({
    credentialState: connected ? "connected" : "not_connected",
    hasAssignedAccounts: accountIds.length > 0,
    warehouseRowCount: Number(warehouseStats?.row_count ?? 0),
    warehousePartial:
      selectedRangeTotalDays != null
        ? Boolean(selectedRangeCoreIncomplete)
        : overallCompletedDays < effectiveHistoricalTotalDays,
    syncState: overallState,
    selectedCurrentDay: selectedRangeIsToday,
    notReadyReason: summarizeStatusDegradedReason(statusDegradedReasons),
  });
  const dataContract = {
    todayMode: "live_overlay",
    historicalMode: "warehouse_only",
  } as const;
  const completionBasis = {
    requiredScopes: ["account_daily", "campaign_daily"],
    excludedScopes: allStateScopes.filter(
      (scope) => !["account_daily", "campaign_daily"].includes(scope)
    ),
    percent: requiredScopeCompletion.percent,
    complete: requiredScopeCompletion.complete,
  };
  const completionBlockers = [
    ...(!requiredScopeCompletion.complete ? ["missing_required_warehouse_coverage"] : []),
    ...googleBlockingReasons
      .map((reason) => reason.code)
      .filter(
        (code) =>
          code !== "missing_required_recent_surfaces" &&
          !code.startsWith("recent_required_")
      ),
  ];
  const platformDateBoundary = {
    primaryAccountId: accountIds[0] ?? null,
    primaryAccountTimezone,
    currentDateInTimezone,
    previousDateInTimezone: addDaysToIsoDateUtc(currentDateInTimezone, -1),
    selectedRangeMode: selectedRangeIsToday ? "current_day_live" : "historical_warehouse",
    mixedCurrentDates:
      new Set(platformDateBoundaryAccounts.map((account) => account.currentDate)).size > 1,
    accounts: platformDateBoundaryAccounts,
  };
  const primaryBoundary =
    platformDateBoundaryAccounts.find((account) => account.isPrimary) ??
    platformDateBoundaryAccounts[0] ??
    null;
  const d1TargetDate = primaryBoundary?.previousDate ?? null;
  const [d1AccountCoverage, d1CampaignCoverage, d1ActiveRowsRaw] =
    primaryBoundary && primaryBoundary.providerAccountId
      ? await Promise.all([
          getGoogleAdsCoveredDates({
            businessId: businessId!,
            providerAccountId: primaryBoundary.providerAccountId,
            scope: "account_daily",
            startDate: primaryBoundary.previousDate,
            endDate: primaryBoundary.previousDate,
          }).catch(() => [] as string[]),
          getGoogleAdsCoveredDates({
            businessId: businessId!,
            providerAccountId: primaryBoundary.providerAccountId,
            scope: "campaign_daily",
            startDate: primaryBoundary.previousDate,
            endDate: primaryBoundary.previousDate,
          }).catch(() => [] as string[]),
          sql`
            SELECT COUNT(*)::int AS active_count
            FROM google_ads_sync_partitions
            WHERE business_id = ${businessId!}
              AND provider_account_id = ${primaryBoundary.providerAccountId}
              AND partition_date = ${primaryBoundary.previousDate}::date
              AND lane IN ('core', 'maintenance')
              AND scope IN ('account_daily', 'campaign_daily')
              AND status IN ('queued', 'leased', 'running')
          `.catch(() => [{ active_count: 0 }]),
        ])
      : [[], [], [{ active_count: 0 }]];
  const d1ActiveRows = d1ActiveRowsRaw as Array<{
    active_count: number | string | null;
  }>;
  const d1Covered =
    d1TargetDate != null &&
    d1AccountCoverage.includes(d1TargetDate) &&
    d1CampaignCoverage.includes(d1TargetDate);
  const d1ActiveCount = Number(d1ActiveRows[0]?.active_count ?? 0);
  const d1FinalizeState =
    d1TargetDate == null
      ? null
      : d1Covered && d1ActiveCount === 0
        ? "ready"
        : d1ActiveCount > 0
          ? "processing"
          : "blocked";
  const d1BlockedReason =
    d1FinalizeState === "processing"
      ? "active_partitions"
      : d1FinalizeState === "blocked"
        ? "missing_warehouse_coverage"
        : null;
  const coldBootstrap =
    connected &&
    accountIds.length > 0 &&
    Number(warehouseStats?.row_count ?? 0) === 0 &&
    overallCompletedDays === 0;
  const backfillInProgress =
    connected &&
    accountIds.length > 0 &&
    (needsBootstrap ||
      overallCompletedDays < effectiveHistoricalTotalDays ||
      Boolean(selectedRangeCoreIncomplete) ||
      runningJobs > 0 ||
      (queueHealth?.queueDepth ?? 0) > 0 ||
      (queueHealth?.leasedPartitions ?? 0) > 0);
  const partialUpstreamCoverage =
    !selectedRangeCoreIncomplete &&
    (selectedRangePendingSurfaces.length > 0 ||
      productPendingSurfaces.length > 0 ||
      advisorMissingSurfaces.length > 0);
  const rebuildState =
    overallState === "action_required"
      ? "blocked"
      : quotaLimited
        ? "quota_limited"
        : coldBootstrap
          ? "cold_bootstrap"
          : backfillInProgress
            ? "backfill_in_progress"
            : partialUpstreamCoverage
              ? "partial_upstream_coverage"
              : "ready";
  const readinessLevel =
    rebuildState === "ready"
      ? surfaceReadinessLevel
      : surfaceReadinessLevel === "ready"
        ? availableSurfaces.includes("account_daily") &&
          availableSurfaces.includes("campaign_daily")
          ? "usable"
          : "partial"
        : surfaceReadinessLevel;
  const syncExecutionPosture =
    currentMode === "safe_mode"
      ? {
          state: "disabled" as const,
          summary:
            "Extended Google Ads rebuild execution is globally limited by safe mode while core metrics remain protected.",
        }
      : globalExtendedExecutionEnabled
        ? {
            state: "globally_enabled" as const,
            summary:
              currentMode === "global_reopen"
                ? "Extended Google Ads rebuild execution is globally enabled under explicit operator posture, subject to quota, breaker, and worker-safety guards."
                : "Extended Google Ads rebuild execution is enabled under bounded backfill posture, subject to quota, breaker, worker-safety, and priority guards.",
          }
        : {
            state: "disabled" as const,
            summary:
              "Extended Google Ads rebuild execution is globally disabled while the warehouse rebuild remains core-first and manual posture stays in force.",
          };
  const retentionExecutionPosture = retentionRuntime.executionEnabled
    ? {
        state: "globally_enabled" as const,
        summary: retentionRuntime.gateReason,
      }
    : {
        state: "dry_run" as const,
        summary: retentionRuntime.gateReason,
      };

  const payload = {
    state: overallState,
    controlPlaneIdentity,
    controlPlanePersistence,
    controlPlaneErrors,
    releaseReadinessCandidate: googleReleaseReadinessCandidate,
    deployGate: gateRecords?.deployGate ?? null,
    releaseGate: gateRecords?.releaseGate ?? null,
    repairPlan: repairPlan ?? null,
    actionRequired: actionRequiredState,
    syncTruthState: googleUnifiedTruth.syncTruthState,
    blockerClass: googleUnifiedTruth.blockerClass,
    credentialState: providerState.credentialState,
    assignmentState: providerState.assignmentState,
    warehouseState: providerState.warehouseState,
    syncState: providerState.syncState,
    servingMode: providerState.servingMode,
    isPartial: providerState.isPartial,
    notReadyReason: providerState.notReadyReason,
    dataContract,
    platformDateBoundary,
    completionBasis,
    completionBlockers,
    runtimeProgress,
    backgroundBackfill,
    globalSyncProgress,
    currentDayLiveStatus,
    selectedRangeReadinessBasis,
    requiredScopeCompletion,
    connected,
    d1TargetDate,
    d1FinalizeState,
    d1BlockedReason,
    operatorTruth: {
      rolloutModel: "global",
      reviewWorkflow: GLOBAL_OPERATOR_REVIEW_WORKFLOW,
      execution: {
        sync: syncExecutionPosture,
        retention: retentionExecutionPosture,
      },
      rebuild: {
        state: rebuildState,
        coldBootstrap,
        backfillInProgress,
        quotaLimited,
        partialUpstreamCoverage,
        blocked: overallState === "action_required",
        summary:
          rebuildState === "blocked"
            ? "Google Ads is blocked on verified warehouse or repair evidence."
            : rebuildState === "quota_limited"
              ? "Google Ads rebuild is constrained by quota or rate-limit pressure."
              : rebuildState === "cold_bootstrap"
                ? "Google Ads is rebuilding from provider APIs on a cold warehouse."
                : rebuildState === "backfill_in_progress"
                  ? "Google Ads historical truth is still backfilling."
                  : rebuildState === "partial_upstream_coverage"
                    ? "Google Ads has partial upstream coverage; deeper surfaces remain incomplete."
                    : "Google Ads rebuild truth is ready for the current contract. Ready means evidence only and does not auto-enable stronger execution or retention.",
      },
    },
    readinessLevel,
    surfaces,
    checkpointHealth: checkpointHealth ?? null,
    domainReadiness,
    assignedAccountIds: accountIds,
    primaryAccountTimezone,
    currentDateInTimezone,
    needsBootstrap,
    warehouse: {
      rowCount: Number(warehouseStats?.row_count ?? 0),
      firstDate: warehouseStats?.first_date ?? null,
      lastDate: warehouseStats?.last_date ?? null,
      coverage: {
        historical: {
          completedDays: overallCompletedDays,
          totalDays: effectiveHistoricalTotalDays,
          readyThroughDate: historicalReadyThroughDate,
        },
        selectedRange:
          selectedStartDate && selectedEndDate && selectedRangeTotalDays
            ? {
                startDate: selectedStartDate,
                endDate: selectedEndDate,
                completedDays: selectedRangeCompletedDays,
                totalDays: selectedRangeTotalDays,
                readyThroughDate: selectedRangeCoverage?.ready_through_date ?? null,
                isComplete: !selectedRangeCoreIncomplete,
              }
            : null,
        accountDaily: {
          completedDays: overallAccountCompletedDays,
          totalDays: effectiveHistoricalTotalDays,
          readyThroughDate:
            relevantAccountStates
              .map((row) => row.readyThroughDate)
              .filter((value): value is string => Boolean(value))
              .sort((a, b) => a.localeCompare(b))[0] ?? accountCoverage?.ready_through_date ?? null,
        },
        campaignDaily: {
          completedDays: overallCompletedDays,
          totalDays: effectiveHistoricalTotalDays,
          readyThroughDate: historicalReadyThroughDate,
        },
        scopes: extendedScopeSummaries,
        pendingSurfaces: productPendingSurfaces,
      },
    },
    advisor: {
      ready: advisorReady,
      readinessModel: advisorDecision.readinessModel,
      readinessWindowDays: GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS,
      snapshotReady: snapshotAvailable,
      snapshotAsOfDate: latestAdvisorSnapshot?.asOfDate ?? null,
      snapshotFresh,
      snapshotBlockedReason: advisorSnapshotBlockedReason,
      requiredSurfaces: advisorRequiredSurfaces.map((entry) => entry.name),
      availableSurfaces: advisorAvailableSurfaces,
      missingSurfaces: advisorMissingSurfaces,
      readyRangeStart: advisorReady ? recent84Start : null,
      readyRangeEnd: advisorReady ? initialBackfillEnd : null,
      blockingMessage:
        fullSyncPriority.reason ??
        buildAdvisorBlockingMessage({
          connected,
          assignedAccountCount: accountIds.length,
          advisorRelevantDeadLetterPartitions,
          advisorRelevantFailedPartitions,
          advisorRelevantUnhealthyLeases,
          recent84MissingSurfaces: advisorMissingSurfaces,
          snapshotAvailable,
          snapshotFresh,
        }),
      selectedWindow:
        selectedStartDate && selectedEndDate
          ? {
              label: `selected ${countInclusiveDays(selectedStartDate, selectedEndDate)}d`,
              ready:
                selectedRangeIsToday
                  ? coreUsable
                  : selectedRangeTotalDays != null &&
                    [
                      selectedRangeCoverage,
                      selectedSearchTermCoverage,
                      selectedProductCoverage,
                    ].every(
                      (coverage) =>
                        Number(coverage?.completed_days ?? 0) >= selectedRangeTotalDays
                    ),
              startDate: selectedStartDate,
              endDate: selectedEndDate,
              totalDays: countInclusiveDays(selectedStartDate, selectedEndDate),
              missingSurfaces:
                selectedRangeIsToday
                  ? []
                  : selectedRangeTotalDays != null
                  ? [
                      { name: "campaign_daily", coverage: selectedRangeCoverage },
                      { name: "search_term_daily", coverage: selectedSearchTermCoverage },
                      { name: "product_daily", coverage: selectedProductCoverage },
                    ]
                      .filter((entry) => Number(entry.coverage?.completed_days ?? 0) < selectedRangeTotalDays)
                      .map((entry) => entry.name)
                  : [],
            }
          : null,
      supportWindows: null,
      decisionEngineV2Enabled: decisionEngineConfig.decisionEngineV2Enabled,
      writebackEnabled: decisionEngineConfig.writebackEnabled,
      actionContract: latestAdvisorActionContract
        ? {
            version: latestAdvisorActionContract.version ?? null,
            source: latestAdvisorActionContract.source ?? null,
          }
        : null,
      aggregateIntelligence: latestAdvisorAggregateIntelligence
        ? {
            topQueryWeeklyAvailable: Boolean(
              latestAdvisorAggregateIntelligence.topQueryWeeklyAvailable
            ),
            clusterDailyAvailable: Boolean(
              latestAdvisorAggregateIntelligence.clusterDailyAvailable
            ),
            queryWeeklyRows: Number(latestAdvisorAggregateIntelligence.queryWeeklyRows ?? 0),
            clusterDailyRows: Number(latestAdvisorAggregateIntelligence.clusterDailyRows ?? 0),
            supportWindowStart:
              latestAdvisorAggregateIntelligence.supportWindowStart ?? null,
            supportWindowEnd: latestAdvisorAggregateIntelligence.supportWindowEnd ?? null,
            note: latestAdvisorAggregateIntelligence.note ?? null,
          }
        : null,
      aiAssist: {
        gateEnabled: advisorAiAssistBoundary.enabled,
        businessScoped: advisorAiAssistBoundary.businessScoped,
        businessAllowed: advisorAiAssistBoundary.businessAllowed,
        appliedCount: Number(latestAdvisorAiAssist?.appliedCount ?? 0),
        rejectedCount: Number(latestAdvisorAiAssist?.rejectedCount ?? 0),
        failedCount: Number(latestAdvisorAiAssist?.failedCount ?? 0),
        skippedCount: Number(latestAdvisorAiAssist?.skippedCount ?? 0),
        eligibleCount: Number(latestAdvisorAiAssist?.eligibleCount ?? 0),
        promptVersion: latestAdvisorAiAssist?.promptVersion ?? null,
        blockedReasons: advisorAiAssistBoundary.blockedReasons,
      },
    },
    jobHealth: {
      runningJobs,
      staleRunningJobs,
      backgroundRunningJobs,
      priorityRunningJobs,
      legacyRuntimeJobs,
      queueDepth: queueHealth?.queueDepth ?? 0,
      leasedPartitions: queueHealth?.leasedPartitions ?? 0,
      coreQueueDepth: queueHealth?.coreQueueDepth ?? 0,
      coreLeasedPartitions: queueHealth?.coreLeasedPartitions ?? 0,
      extendedQueueDepth: queueHealth?.extendedQueueDepth ?? 0,
      extendedLeasedPartitions: queueHealth?.extendedLeasedPartitions ?? 0,
      extendedRecentQueueDepth: queueHealth?.extendedRecentQueueDepth ?? 0,
      extendedRecentLeasedPartitions: queueHealth?.extendedRecentLeasedPartitions ?? 0,
      extendedHistoricalQueueDepth: queueHealth?.extendedHistoricalQueueDepth ?? 0,
      extendedHistoricalLeasedPartitions: queueHealth?.extendedHistoricalLeasedPartitions ?? 0,
      maintenanceQueueDepth: queueHealth?.maintenanceQueueDepth ?? 0,
      maintenanceLeasedPartitions: queueHealth?.maintenanceLeasedPartitions ?? 0,
      deadLetterPartitions: queueHealth?.deadLetterPartitions ?? 0,
      actionRequiredDeadLetterPartitions:
        queueHealth?.actionRequiredDeadLetterPartitions ?? 0,
      actionRequiredBlockingDeadLetterPartitions:
        queueHealth?.actionRequiredBlockingDeadLetterPartitions ?? 0,
      actionRequiredDeadLetterScopes:
        queueHealth?.actionRequiredDeadLetterScopes ?? [],
      actionRequiredBlockingDeadLetterScopes:
        queueHealth?.actionRequiredBlockingDeadLetterScopes ?? [],
      advisorRelevantDeadLetterPartitions,
      historicalDeadLetterPartitions,
      advisorRelevantFailedPartitions,
      advisorRelevantLeasedPartitions,
      oldestQueuedPartition: queueHealth?.oldestQueuedPartition ?? null,
    },
    priorityWindow,
    retention: {
      runtimeAvailable: retentionRuntime.runtimeAvailable,
      executionEnabled: retentionRuntime.executionEnabled,
      defaultExecutionDisabled: !retentionRuntime.executionEnabled,
      mode: retentionRuntime.mode,
      gateReason: retentionRuntime.gateReason,
      verification: {
        available: true,
        command: `npm run google:ads:retention-canary -- ${businessId!}`,
        description:
          "Explicit non-destructive verification that historical search intelligence stays aggregate-backed when raw search-term rows older than 120 days are absent.",
      },
      latestRun: latestRetentionRun
        ? {
            id: latestRetentionRun.id,
            finishedAt: latestRetentionRun.finishedAt,
            executionMode: latestRetentionRun.executionMode,
            skippedDueToActiveLease: latestRetentionRun.skippedDueToActiveLease,
            totalDeletedRows: latestRetentionRun.totalDeletedRows,
            errorMessage: latestRetentionRun.errorMessage,
          }
        : null,
      rawHotTables: latestRawHotRetentionRows.map((row) => ({
        tableName: row.tableName,
        observed: row.observed,
        cutoffDate: row.cutoffDate,
        eligibleRows: row.eligibleRows,
        oldestEligibleValue: row.oldestEligibleValue,
        newestEligibleValue: row.newestEligibleValue,
        retainedRows: row.retainedRows,
        latestRetainedValue: row.latestRetainedValue,
      })),
    },
    operations: {
      currentMode,
      globalExtendedExecutionEnabled,
      quotaPressure: quotaBudgetState?.pressure ?? 0,
      breakerState,
      decisionEngineV2Enabled: decisionEngineConfig.decisionEngineV2Enabled,
      writebackEnabled: decisionEngineConfig.writebackEnabled,
      statusDegraded: statusDegradedReasons.length > 0,
      statusDegradedReason: summarizeStatusDegradedReason(statusDegradedReasons),
      extendedRecoveryBlockReason,
      googleWorkerHealthy: workerSchedulingState?.healthy ?? false,
      googleHeartbeatAgeMs: workerSchedulingState?.heartbeatAgeMs ?? null,
      googleRunnerLeaseActive: workerSchedulingState?.runnerLeaseActive ?? false,
      fullSyncPriorityRequired: fullSyncPriority.required,
      fullSyncPriorityReason: fullSyncPriority.reason,
      advisorReadinessModel: advisorDecision.readinessModel,
      advisorReadinessWindowDays: GOOGLE_ADS_ADVISOR_READY_WINDOW_DAYS,
      advisorSnapshotReady: snapshotAvailable,
      advisorSnapshotAsOfDate: latestAdvisorSnapshot?.asOfDate ?? null,
      advisorSnapshotFresh: snapshotFresh,
      advisorSnapshotBlockedReason,
      advisorSurfacePartitionStates,
      advisorActionContractVersion: latestAdvisorActionContract?.version ?? null,
      advisorActionContractSource: latestAdvisorActionContract?.source ?? null,
      advisorAggregateTopQueryWeeklyAvailable:
        latestAdvisorAggregateIntelligence?.topQueryWeeklyAvailable ?? false,
      advisorAggregateClusterDailyAvailable:
        latestAdvisorAggregateIntelligence?.clusterDailyAvailable ?? false,
      advisorAggregateQueryWeeklyRows:
        latestAdvisorAggregateIntelligence?.queryWeeklyRows ?? null,
      advisorAggregateClusterDailyRows:
        latestAdvisorAggregateIntelligence?.clusterDailyRows ?? null,
      retentionRuntimeAvailable: retentionRuntime.runtimeAvailable,
      retentionExecutionEnabled: retentionRuntime.executionEnabled,
      retentionMode: retentionRuntime.mode,
      retentionGateReason: retentionRuntime.gateReason,
      retentionDefaultExecutionDisabled: !retentionRuntime.executionEnabled,
      retentionVerificationCommand: `npm run google:ads:retention-canary -- ${businessId!}`,
      retentionLatestRunObserved:
        latestRawHotRetentionRows.length > 0 &&
        latestRawHotRetentionRows.every((row) => row.observed),
      lastRetentionRunAt: latestRetentionRun?.finishedAt ?? null,
      lastRetentionRunMode: latestRetentionRun?.executionMode ?? null,
      lastRetentionRunDeletedRows: latestRetentionRun?.totalDeletedRows ?? null,
      writebackPilotEnabled: automationConfig.writebackPilotEnabled,
      semiAutonomousBundlesEnabled: automationConfig.semiAutonomousBundlesEnabled,
      controlledAutonomyEnabled: automationConfig.controlledAutonomyEnabled,
      autonomyKillSwitchActive: automationConfig.autonomyKillSwitchActive,
      manualApprovalRequired: automationConfig.manualApprovalRequired,
      operatorOverrideEnabled: automationConfig.operatorOverrideEnabled,
      autonomyAllowlist: automationConfig.actionAllowlist,
      autonomyBusinessAllowlist: automationConfig.businessAllowlist,
      autonomyAccountAllowlist: automationConfig.accountAllowlist,
      autonomyBusinessAllowed: autonomyBoundary.businessAllowed,
      autonomyAccountAllowed: autonomyBoundary.accountAllowed,
      semiAutonomousEligible: autonomyBoundary.semiAutonomousEligible,
      controlledAutonomyEligible: autonomyBoundary.controlledAutonomyEligible,
      autonomyBlockedReasons: autonomyBoundary.blockedReasons,
      bundleCooldownHours: automationConfig.bundleCooldownHours,
      activityState: googleActivityState,
      blockingReasons: googleBlockingReasons,
      repairableActions: googleRepairableActions,
      requiredCoverage: googleRequiredCoverage,
      stallFingerprints: effectiveGoogleStallFingerprints,
      runtimeProgress,
      backgroundBackfill,
      secondaryReadiness: [
        {
          key: "analysis",
          state: snapshotAvailable ? "ready" : advisorSnapshotBlockedReason ? "blocked" : "building",
          detail: snapshotAvailable
            ? "Google Ads decision snapshot is ready."
            : advisorSnapshotBlockedReason
              ? `Google Ads analysis is blocked by ${advisorSnapshotBlockedReason}.`
              : "Google Ads multi-window analysis is still building after required coverage completed.",
        },
      ],
      workerBuildId,
      workerStartedAt,
      lastWorkerHeartbeatAt: workerSchedulingState?.lastHeartbeatAt ?? null,
      workerFreshnessState,
      currentWorkerBusinessId,
      workerBatchBusinessIds,
      currentConsumeStage,
      lastConsumedBusinessId,
      runtimeMismatchDetected,
      lastConsumeAttemptAt,
      lastConsumeOutcome,
      lastLeaseAcquiredAt,
      lastProgressAt,
      lastConsumeFinishedAt,
      lastFailureReason,
      staleRunPressure,
      progressState: googleProgressState,
      extendedSuppressionDecisionTrace,
      lastTargetedRepair,
      lastAutoRepair,
      lastAutoRepairOutcome,
      lastAutoRepairTriggerSource: lastAutoRepair?.triggerSource ?? null,
      recentGapCountByScope,
      recentGapRepairingByScope,
      recentGapLastAttemptAtByScope,
      recentGapQueuedByScope,
      recentGapLeasedByScope,
      recentGapSucceededByScope,
      recentGapFailedByScope,
      lastAutoRepairAttemptByScope,
      autoRepairExecutionStage,
    },
    panel: {
      coreUsable,
      extendedLimited,
      recentExtendedUsable: recentExtendedReady,
      headline: panelHeadline,
      detail: panelDetail,
      surfaceStates: majorSurfaceStates,
    },
    domains,
    extendedRecoveryState,
    recentExtendedReady,
    historicalExtendedReady,
    extendedRecentReadyThroughDate,
    rangeCompletionBySurface,
    advisorProgress,
    historicalProgress: {
      percent: historicalBackfillPercent,
      visible:
        connected &&
        accountIds.length > 0 &&
        !selectedRangeIsToday &&
        !requiredScopeCompletion.complete,
      summary: historicalProgressSummary,
    },
    latestSync: effectiveLatestSync
      ? {
          id: effectiveLatestSync.id ? String(effectiveLatestSync.id) : null,
          status: effectiveLatestSync.status ? String(effectiveLatestSync.status) : undefined,
          syncType: effectiveLatestSync.sync_type ? String(effectiveLatestSync.sync_type) : null,
          scope: effectiveLatestSync.scope ? String(effectiveLatestSync.scope) : null,
          startDate: effectiveLatestSync.start_date ? String(effectiveLatestSync.start_date).slice(0, 10) : null,
          endDate: effectiveLatestSync.end_date ? String(effectiveLatestSync.end_date).slice(0, 10) : null,
          triggerSource: effectiveLatestSync.trigger_source ? String(effectiveLatestSync.trigger_source) : null,
          triggeredAt: effectiveLatestSync.triggered_at ? String(effectiveLatestSync.triggered_at) : null,
          startedAt: effectiveLatestSync.started_at ? String(effectiveLatestSync.started_at) : null,
          finishedAt: effectiveLatestSync.finished_at ? String(effectiveLatestSync.finished_at) : null,
          lastError: latestError,
          progressPercent: historicalProgressPercent,
          completedDays: overallCompletedDays,
          totalDays: effectiveHistoricalTotalDays,
          readyThroughDate: historicalReadyThroughDate,
          phaseLabel: phaseLabel === "Ready" ? null : phaseLabel,
        }
      : {
          progressPercent: historicalProgressPercent,
          completedDays: overallCompletedDays,
          totalDays: effectiveHistoricalTotalDays,
          readyThroughDate: historicalReadyThroughDate,
          phaseLabel: phaseLabel === "Ready" ? null : phaseLabel,
        },
  };
  const userVisibleSyncState = deriveGoogleUserVisibleSyncState(
    payload as GoogleAdsStatusResponse,
  );

  return NextResponse.json({
    ...payload,
    userVisibleSyncState,
    operationalSyncState: deriveOperationalSyncState({
      releaseGateVerdict: payload.releaseGate?.verdict ?? null,
      incidentSummary,
      recommendationCount: payload.repairPlan?.recommendations.length ?? 0,
    }),
    degradedServing: incidentSummary?.degradedServing ?? userVisibleSyncState.degradedServing,
    openIncidents: incidentSummary?.openCount ?? payload.repairPlan?.recommendations.length ?? 0,
  });
}
