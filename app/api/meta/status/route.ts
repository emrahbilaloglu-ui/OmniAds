import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getIntegrationMetadata } from "@/lib/integrations";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import {
  META_PRODUCT_CORE_COVERAGE_SCOPES,
  META_RUNTIME_STATE_SCOPES,
  META_SECONDARY_REPORTING_SCOPES,
} from "@/lib/meta/core-config";
import {
  buildMetaCoreReadiness,
  buildMetaExtendedCompleteness,
  rollupMetaPageReadiness,
} from "@/lib/meta/page-readiness";
import { buildMetaIntegrationSummary } from "@/lib/meta/integration-summary";
import { getMetaCurrentDayLiveAvailability } from "@/lib/meta/live";
import {
  getLatestMetaSyncHealth,
  getMetaAccountDailyCoverage,
  getMetaCampaignDailyCoverage,
  getMetaAccountDailyStats,
  getMetaAdDailyCoverage,
  getMetaAdSetDailyCoverage,
  getMetaCheckpointHealth,
  getMetaSyncPhaseTimingSummaries,
  getMetaCreativeDailyCoverage,
  getMetaCreativeMediaPreviewCoverage,
  getMetaAuthoritativeDayVerification,
  getMetaAuthoritativeBusinessOpsSnapshot,
  getMetaQueueComposition,
  getMetaQueueHealth,
  getMetaRawSnapshotCoverageByEndpoint,
  getMetaSyncJobHealth,
  getMetaSyncState,
} from "@/lib/meta/warehouse";
import {
  META_CREATIVE_WAREHOUSE_HISTORY_DAYS,
  META_WAREHOUSE_HISTORY_DAYS,
  dayCountInclusive,
} from "@/lib/meta/history";
import { getMetaBreakdownSupportedStart, META_BREAKDOWN_MAX_HISTORY_DAYS } from "@/lib/meta/constraints";
import {
  getMetaHistoricalVerificationReason,
  isMetaHistoricalVerificationActionRequired,
} from "@/lib/meta/historical-verification";
import {
  META_AUTHORITATIVE_HISTORY_DAYS,
  META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
  isMetaRangeWithinAuthoritativeHistory,
  isMetaRangeWithinBreakdownHistory,
} from "@/lib/meta/contract";
import { isMetaAuthoritativeFinalizationV2Enabled } from "@/lib/meta/authoritative-finalization-config";
import {
  buildProviderStateContract,
  buildProviderSurfaces,
} from "@/lib/provider-readiness";
import { addDaysToIsoDateUtc, getProviderPlatformDateBoundaries } from "@/lib/provider-platform-date";
import { isDemoBusinessId, getDemoMetaStatus } from "@/lib/demo-business";
import { getProviderWorkerHealthState } from "@/lib/sync/worker-health";
import {
  assertRuntimeContractStartup,
  getRuntimeRegistryStatus,
  upsertRuntimeContractInstance,
} from "@/lib/sync/runtime-contract";
import { deriveMetaOperationsBlockReason } from "@/lib/meta/status-operations";
import { GLOBAL_OPERATOR_REVIEW_WORKFLOW } from "@/lib/global-operator-review";
import {
  deriveOperationalSyncState,
  getSyncIncidentSummary,
} from "@/lib/sync/incidents";
import { deriveMetaUserVisibleSyncState } from "@/lib/sync/user-visible-sync";
import {
  getMetaRetentionCanaryRuntimeStatus,
  getMetaRetentionDeleteScope,
  getMetaProtectedPublishedTruthReview,
  getMetaRetentionRunMetadata,
  getMetaRetentionRunRows,
  getLatestMetaRetentionCanaryRun,
  getLatestMetaRetentionRun,
  getMetaRetentionRuntimeStatus,
  summarizeMetaRetentionRunRows,
} from "@/lib/meta/warehouse-retention";
import { getMetaSelectedRangeTruthReadiness } from "@/lib/sync/meta-sync";
import { isMetaDecisionOsV1EnabledForBusiness } from "@/lib/meta/decision-os-config";
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
import { getLatestSyncGateRecords } from "@/lib/sync/release-gates";
import { getLatestSyncRepairPlan } from "@/lib/sync/repair-planner";
import { getLatestSyncRepairExecution } from "@/lib/sync/remediation-executions";
import { resolveSyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import { getSyncControlPlanePersistenceStatus } from "@/lib/sync/control-plane-persistence";
import { buildSyncLagMetrics } from "@/lib/sync/lag-metrics";
import { readThroughCache } from "@/lib/server-cache";
import type {
  MetaCoreSurfaceKey,
  MetaStatusResponse,
  MetaSurfaceReadiness,
} from "@/lib/meta/status-types";

function buildMetaDomainReadiness(input: {
  availableSurfaces: string[];
  missingSurfaces: string[];
}) {
  const coreSurfacesReady = [...META_PRODUCT_CORE_COVERAGE_SCOPES].filter((surface) =>
    input.availableSurfaces.includes(surface)
  );
  const deepSurfacesPending = Array.from(
    new Set(
      input.missingSurfaces.filter((surface) => !META_PRODUCT_CORE_COVERAGE_SCOPES.includes(surface as never))
    )
  );
  const blockingSurfaces = [...META_PRODUCT_CORE_COVERAGE_SCOPES].filter((surface) =>
    input.missingSurfaces.includes(surface)
  );
  const summary =
    blockingSurfaces.length > 0
      ? "Core spend and campaign summary are still syncing."
      : null;
  return {
    coreSurfacesReady,
    deepSurfacesPending,
    blockingSurfaces,
    summary,
  };
}

const META_BREAKDOWN_ENDPOINTS = [
  "breakdown_age",
  "breakdown_country",
  "breakdown_publisher_platform,platform_position,impression_device",
] as const;

const META_BREAKDOWN_SURFACES = [
  {
    surfaceKey: "breakdowns.age",
    coverageKey: "age",
    endpointName: "breakdown_age",
    label: "Age",
  },
  {
    surfaceKey: "breakdowns.location",
    coverageKey: "location",
    endpointName: "breakdown_country",
    label: "Country",
  },
  {
    surfaceKey: "breakdowns.placement",
    coverageKey: "placement",
    endpointName: "breakdown_publisher_platform,platform_position,impression_device",
    label: "Placement",
  },
] as const;

const META_STATE_SCOPES = [...META_RUNTIME_STATE_SCOPES] as const;
const META_CORE_REQUIRED_SURFACES = [...META_PRODUCT_CORE_COVERAGE_SCOPES] as const;
const META_SECONDARY_SURFACES = [...META_SECONDARY_REPORTING_SCOPES, "ad_daily"] as const;
const META_DEEP_SURFACES = ["breakdowns"] as const;
const META_RECENT_RECOVERY_DAYS = Math.max(
  1,
  Number(process.env.META_RECENT_RECOVERY_DAYS ?? 14) || 14
);
const META_STATUS_CACHE_TTL_MS = Math.max(
  1_000,
  Number(process.env.META_STATUS_CACHE_TTL_MS ?? 5_000) || 5_000
);

function shouldBypassMetaStatusCache() {
  return process.env.NODE_ENV === "test" || process.env.VITEST === "true";
}

function buildMetaStatusCacheKey(input: {
  buildId: string;
  businessId: string;
  startDate: string | null;
  endDate: string | null;
  diagnostics: boolean;
}) {
  return [
    "meta-status:v1",
    input.buildId,
    input.businessId,
    input.startDate ?? "recent",
    input.endDate ?? "recent",
    input.diagnostics ? "diagnostics" : "default",
  ].join(":");
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

function addDays(date: Date, days: number) {
  const next = new Date(date);
  next.setUTCDate(next.getUTCDate() + days);
  return next;
}

function minCompletedDays(
  values: Array<number | null | undefined>,
  totalDays: number | null | undefined
) {
  const finiteValues = values.filter((value): value is number => Number.isFinite(value));
  if (finiteValues.length === 0) return 0;
  const minValue = Math.min(...finiteValues);
  if (!Number.isFinite(totalDays) || (totalDays ?? 0) <= 0) return minValue;
  return Math.min(minValue, totalDays ?? 0);
}

function clampPercent(value: number | null | undefined) {
  if (!Number.isFinite(value)) return 0;
  return Math.max(0, Math.min(100, Math.round(value ?? 0)));
}

function earliestReadyThroughDate(values: Array<string | null | undefined>) {
  return (
    values
      .filter((value): value is string => Boolean(value))
      .sort((left, right) => left.localeCompare(right))[0] ?? null
  );
}

function buildPhaseLabel(input: {
  selectedRangeIncomplete: boolean;
  selectedRangeIsToday: boolean;
  defaultCoverageReady: boolean;
  historicalQueuePaused: boolean;
  staleLeasedQueue: boolean;
  stateMissingWhileQueued: boolean;
  overallCompletedDays: number;
  totalDays: number;
  latestSyncType?: string | null;
}) {
  if (input.staleLeasedQueue) return "Meta sync is catching up";
  if (input.stateMissingWhileQueued) return "Meta queue is waiting for a worker";
  if (input.selectedRangeIncomplete && input.selectedRangeIsToday) return "Preparing today's data";
  if (input.selectedRangeIncomplete) return "Preparing selected dates";
  if (input.historicalQueuePaused) return "Historical sync is paused";
  if (input.defaultCoverageReady) return "Ready";
  if (input.overallCompletedDays < input.totalDays) return "Backfilling historical data";
  if (input.totalDays <= 0 || input.overallCompletedDays >= input.totalDays) {
    return "Ready";
  }
  if (input.latestSyncType === "incremental_recent" || input.latestSyncType === "today_refresh") {
    return "Syncing recent history";
  }
  return "Ready";
}

function buildPageSurfaceState(input: {
  connected: boolean;
  hasAssignedAccounts: boolean;
  ready: boolean;
  activeProgress: boolean;
  blockedReason?: string | null;
  syncingReason: string;
  blockedFallbackReason: string;
}): MetaSurfaceReadiness["state"] {
  if (!input.connected || !input.hasAssignedAccounts) return "not_connected";
  if (input.blockedReason) return "blocked";
  if (input.ready) return "ready";
  if (input.activeProgress) return "syncing";
  return "partial";
}

function buildMetaRetentionTableEvidence(
  rows: ReturnType<typeof getMetaRetentionRunRows>,
) {
  return rows.map((row) => ({
    tier: row.tier,
    label: row.label,
    tableName: row.tableName,
    summaryKey: row.summaryKey,
    deleteScope: getMetaRetentionDeleteScope(row),
    retentionDays: row.retentionDays,
    cutoffDate: row.cutoffDate,
    surfaceFilter: row.surfaceFilter ?? null,
    observed: row.observed,
    deletableRows: row.eligibleRows,
    deletableDistinctDays: row.eligibleDistinctDays,
    oldestDeletableValue: row.oldestEligibleValue,
    newestDeletableValue: row.newestEligibleValue,
    retainedRows: row.retainedRows,
    latestRetainedValue: row.latestRetainedValue,
    protectedRows: row.protectedRows,
    protectedDistinctDays: row.protectedDistinctDays,
    latestProtectedValue: row.latestProtectedValue,
    deletedRows: row.deletedRows,
  }));
}

export async function GET(request: NextRequest) {
  const url = new URL(request.url);
  const businessId = url.searchParams.get("businessId");
  const selectedStartDate = url.searchParams.get("startDate");
  const selectedEndDate = url.searchParams.get("endDate");
  const includeDiagnostics = url.searchParams.get("diagnostics") === "1";
  const runtimeContract = assertRuntimeContractStartup({ service: "web" });
  const controlPlaneIdentity = resolveSyncControlPlaneKey({
    buildId: runtimeContract.buildId,
    providerScope: "meta",
  });
  await upsertRuntimeContractInstance({
    contract: runtimeContract,
  }).catch(() => null);

  const access = await requireBusinessAccess({ request, businessId });
  if ("error" in access) return access.error;

  if (isDemoBusinessId(businessId)) {
    return NextResponse.json(getDemoMetaStatus(), { headers: { "Cache-Control": "no-store" } });
  }
  const buildResponse = async () => {
  const [
    integration,
    assignments,
    latestSync,
    accountStats,
    accountSnapshot,
    legacyJobHealth,
    workerHealth,
    phaseTimings,
    latestRetentionRun,
    latestRetentionCanaryRun,
    protectedPublishedTruthReview,
    authoritativeSnapshot,
    runtimeRegistry,
    gateResult,
    repairPlanResult,
    latestRemediationExecution,
    persistenceResult,
    incidentSummaryResult,
  ] =
    await Promise.all([
      getIntegrationMetadata(businessId!, "meta").catch(() => null),
      getProviderAccountAssignments(businessId!, "meta").catch(() => null),
      getLatestMetaSyncHealth({ businessId: businessId!, providerAccountId: null }).catch(() => null),
      getMetaAccountDailyStats({ businessId: businessId!, providerAccountId: null }).catch(() => null),
      readProviderAccountSnapshot({ businessId: businessId!, provider: "meta" }).catch(() => null),
      getMetaSyncJobHealth({ businessId: businessId! }).catch(() => null),
      getProviderWorkerHealthState({
        businessId: businessId!,
        providerScope: "meta",
        staleThresholdMs: 3 * 60_000,
      }).catch(() => null),
      getMetaSyncPhaseTimingSummaries({
        businessId: businessId!,
        providerAccountId: null,
        windowHours: 24,
      }).catch(() => []),
      getLatestMetaRetentionRun().catch(() => null),
      getLatestMetaRetentionCanaryRun(businessId!).catch(() => null),
      includeDiagnostics
        ? getMetaProtectedPublishedTruthReview({ businessIds: [businessId!] }).catch(() => null)
        : Promise.resolve(null),
      getMetaAuthoritativeBusinessOpsSnapshot({ businessId: businessId! }).catch(() => null),
      getRuntimeRegistryStatus({
        buildId: runtimeContract.buildId,
      }).catch(() => null),
      getLatestSyncGateRecords({
        buildId: controlPlaneIdentity.buildId,
        environment: controlPlaneIdentity.environment,
      })
        .then((value) => ({ value, error: null }))
        .catch((error) => ({
          value: {
            deployGate: null,
            releaseGate: null,
          },
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
      getLatestSyncRepairExecution({
        ...controlPlaneIdentity,
        businessId: businessId!,
      }).catch(() => null),
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
    ]);
  const gateRecords = gateResult.value;
  const repairPlan = repairPlanResult.value;
  const controlPlanePersistence = persistenceResult.value;
  const incidentSummary = incidentSummaryResult.value;
  const controlPlaneErrors = {
    syncGates: gateResult.error,
    repairPlan: repairPlanResult.error,
    controlPlanePersistence: persistenceResult.error,
    syncIncidents: incidentSummaryResult.error,
  };
  const retentionRuntime = getMetaRetentionRuntimeStatus();
  const retentionCanaryRuntime = getMetaRetentionCanaryRuntimeStatus({
    businessId: businessId!,
  });
  const latestRetentionRows = getMetaRetentionRunRows(latestRetentionRun);
  const latestRetentionMetadata = getMetaRetentionRunMetadata(latestRetentionRun);
  const latestRetentionSummary =
    latestRetentionRows.length > 0
      ? summarizeMetaRetentionRunRows(latestRetentionRows)
      : null;
  const latestRetentionTables = buildMetaRetentionTableEvidence(latestRetentionRows);
  const latestRetentionCanaryRows = getMetaRetentionRunRows(latestRetentionCanaryRun);
  const latestRetentionCanaryMetadata = getMetaRetentionRunMetadata(
    latestRetentionCanaryRun,
  );
  const latestRetentionCanarySummary =
    latestRetentionCanaryRows.length > 0
      ? summarizeMetaRetentionRunRows(latestRetentionCanaryRows)
      : null;
  const latestRetentionCanaryTables = buildMetaRetentionTableEvidence(
    latestRetentionCanaryRows,
  );

  const accountIds = assignments?.account_ids ?? [];
  const connected = Boolean(integration?.status === "connected");
  const primaryAccountId = accountIds[0] ?? null;
  const primaryAccountTimezone =
    accountSnapshot?.accounts.find((account) => account.id === primaryAccountId)?.timezone ??
    accountSnapshot?.accounts[0]?.timezone ??
    "UTC";
  const platformDateBoundaryAccounts = await getProviderPlatformDateBoundaries({
    provider: "meta",
    businessId: businessId!,
    providerAccountIds: accountIds,
    snapshot: accountSnapshot,
  }).catch(() => []);
  const currentDateInTimezone = getTodayIsoForTimeZoneServer(primaryAccountTimezone);

  const initialBackfillEnd = addDays(
    new Date(`${currentDateInTimezone ?? new Date().toISOString().slice(0, 10)}T00:00:00Z`),
    -1
  )
    .toISOString()
    .slice(0, 10);
  const initialBackfillStart = addDays(
    new Date(`${initialBackfillEnd}T00:00:00Z`),
    -(META_WAREHOUSE_HISTORY_DAYS - 1)
  )
    .toISOString()
    .slice(0, 10);
  const historicalTotalDays = dayCountInclusive(initialBackfillStart, initialBackfillEnd);
  const creativeBackfillStart = addDays(
    new Date(`${initialBackfillEnd}T00:00:00Z`),
    -(META_CREATIVE_WAREHOUSE_HISTORY_DAYS - 1)
  )
    .toISOString()
    .slice(0, 10);
  const creativeHistoricalTotalDays = dayCountInclusive(creativeBackfillStart, initialBackfillEnd);
  const breakdownHistoricalStart =
    initialBackfillStart > getMetaBreakdownSupportedStart(initialBackfillEnd)
      ? initialBackfillStart
      : getMetaBreakdownSupportedStart(initialBackfillEnd);
  const effectiveHistoricalTotalDays = Math.min(
    historicalTotalDays,
    dayCountInclusive(breakdownHistoricalStart, initialBackfillEnd)
  );
  const recentWindowStart = addDays(
    new Date(`${initialBackfillEnd}T00:00:00Z`),
    -(Math.min(META_RECENT_RECOVERY_DAYS, historicalTotalDays) - 1)
  )
    .toISOString()
    .slice(0, 10);
  const recentWindowTotalDays = Math.min(
    META_RECENT_RECOVERY_DAYS,
    dayCountInclusive(recentWindowStart, initialBackfillEnd)
  );

  const [accountCoverage, campaignCoverage, adsetCoverage, adDailyCoverage, creativeCoverage, creativePreviewCoverage, breakdownCoverageByEndpoint, queueHealth, queueComposition, checkpointHealth, recentAccountCoverage, recentCampaignCoverage, recentAdsetCoverage, recentCreativeCoverage, recentAdCoverage, ...stateRows] =
      await Promise.all([
          getMetaAccountDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: initialBackfillStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaCampaignDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: initialBackfillStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaAdSetDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: initialBackfillStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaAdDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: initialBackfillStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaCreativeDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: creativeBackfillStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaCreativeMediaPreviewCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: creativeBackfillStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaRawSnapshotCoverageByEndpoint({
            businessId: businessId!,
            providerAccountId: null,
            endpointNames: [...META_BREAKDOWN_ENDPOINTS],
            startDate: breakdownHistoricalStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaQueueHealth({ businessId: businessId! }).catch(() => null),
          getMetaQueueComposition({ businessId: businessId! }).catch(() => null),
          getMetaCheckpointHealth({ businessId: businessId! }).catch(() => null),
          getMetaAccountDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: recentWindowStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaCampaignDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: recentWindowStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaAdSetDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: recentWindowStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaCreativeDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: recentWindowStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          getMetaAdDailyCoverage({
            businessId: businessId!,
            providerAccountId: null,
            startDate: recentWindowStart,
            endDate: initialBackfillEnd,
          }).catch(() => null),
          ...META_STATE_SCOPES.map((scope) =>
            getMetaSyncState({ businessId: businessId!, scope }).catch(() => [])
          ),
        ]);

  const statesByScope = Object.fromEntries(
    META_STATE_SCOPES.map((scope, index) => [scope, stateRows[index] ?? []])
  ) as Record<(typeof META_STATE_SCOPES)[number], Awaited<ReturnType<typeof getMetaSyncState>>>;

  const latestMetaQueueActivityAt =
    queueHealth?.latestMaintenanceActivityAt ??
    queueHealth?.latestExtendedActivityAt ??
    queueHealth?.latestCoreActivityAt ??
    null;
  const operationsBlockReason = workerHealth
    ? deriveMetaOperationsBlockReason({
        workerHealthy: workerHealth.workerHealthy,
        queueDepth: queueHealth?.queueDepth ?? 0,
        leasedPartitions: queueHealth?.leasedPartitions ?? 0,
        consumeStage: workerHealth.consumeStage,
        heartbeatAgeMs: workerHealth.heartbeatAgeMs,
        latestActivityAt: latestMetaQueueActivityAt,
        historicalCoreQueued: queueComposition?.summary.historicalCoreQueued ?? 0,
        extendedHistoricalQueued: queueComposition?.summary.extendedHistoricalQueued ?? 0,
        maintenanceQueued: queueComposition?.summary.maintenanceQueued ?? 0,
      })
    : null;

  const relevantStates = (scope: (typeof META_STATE_SCOPES)[number]) =>
    (statesByScope[scope] ?? []).filter((row) =>
      accountIds.length === 0 ? true : accountIds.includes(row.providerAccountId)
    );

  const accountDailyStates = relevantStates("account_daily");
  const campaignDailyStates = relevantStates("campaign_daily");
  const adsetDailyStates = relevantStates("adset_daily");
  const creativeDailyStates = relevantStates("creative_daily");
  const adDailyStates = relevantStates("ad_daily");

  const breakdownCoverageDays = Math.min(
    ...META_BREAKDOWN_ENDPOINTS.map(
      (endpointName) => breakdownCoverageByEndpoint?.get(endpointName)?.completed_days ?? 0
    )
  );
  const breakdownReadyThroughDate =
    META_BREAKDOWN_ENDPOINTS.map(
      (endpointName) => breakdownCoverageByEndpoint?.get(endpointName)?.ready_through_date ?? null
    )
      .filter((value): value is string => Boolean(value))
      .sort((a, b) => a.localeCompare(b))[0] ?? null;

  const historicalArchiveCompletedDays = minCompletedDays(
    [
      accountDailyStates.length > 0
        ? Math.min(...accountDailyStates.map((row) => row.completedDays))
        : accountCoverage?.completed_days ?? 0,
      campaignDailyStates.length > 0
        ? Math.min(...campaignDailyStates.map((row) => row.completedDays))
        : campaignCoverage?.completed_days ?? 0,
    ],
    historicalTotalDays
  );
  const historicalArchiveReadyThroughDate = earliestReadyThroughDate([
    accountDailyStates.length > 0
      ? earliestReadyThroughDate(accountDailyStates.map((row) => row.readyThroughDate))
      : accountCoverage?.ready_through_date ?? null,
    campaignDailyStates.length > 0
      ? earliestReadyThroughDate(campaignDailyStates.map((row) => row.readyThroughDate))
      : campaignCoverage?.ready_through_date ?? null,
  ]);

  const selectedRangeCoverage =
    selectedStartDate && selectedEndDate
      ? await getMetaAccountDailyCoverage({
          businessId: businessId!,
          providerAccountId: null,
          startDate: selectedStartDate,
          endDate: selectedEndDate,
        }).catch(() => null)
      : null;
  const selectedRangeCampaignCoverage =
    selectedStartDate && selectedEndDate
      ? await getMetaCampaignDailyCoverage({
          businessId: businessId!,
          providerAccountId: null,
          startDate: selectedStartDate,
          endDate: selectedEndDate,
        }).catch(() => null)
      : null;
  const selectedRangeAdsetCoverage =
    selectedStartDate && selectedEndDate
      ? await getMetaAdSetDailyCoverage({
          businessId: businessId!,
          providerAccountId: null,
          startDate: selectedStartDate,
          endDate: selectedEndDate,
        }).catch(() => null)
      : null;
  const selectedRangeTotalDays =
    selectedStartDate && selectedEndDate ? dayCountInclusive(selectedStartDate, selectedEndDate) : null;
  const selectedRangeRequested = Boolean(selectedStartDate && selectedEndDate && selectedRangeTotalDays);
  const selectedRangeWithinAuthoritativeHistory =
    selectedRangeRequested && selectedStartDate
      ? isMetaRangeWithinAuthoritativeHistory({
          startDate: selectedStartDate,
          referenceToday: currentDateInTimezone,
        })
      : true;
  const selectedRangeWithinBreakdownHistory =
    selectedRangeRequested && selectedStartDate
      ? isMetaRangeWithinBreakdownHistory({
          startDate: selectedStartDate,
          referenceToday: currentDateInTimezone,
        })
      : true;
  const selectedRangeIsToday =
    Boolean(selectedStartDate && selectedEndDate && currentDateInTimezone) &&
    selectedStartDate === selectedEndDate &&
    selectedStartDate === currentDateInTimezone;
  const selectedRangeIncludesCurrentDay =
    Boolean(
      selectedRangeRequested &&
        !selectedRangeIsToday &&
        selectedEndDate &&
        currentDateInTimezone &&
        selectedEndDate === currentDateInTimezone
    );
  const selectedRangeHistoricalEndDate =
    selectedRangeIncludesCurrentDay && selectedEndDate
      ? addDaysToIsoDateUtc(selectedEndDate, -1)
      : selectedEndDate;
  const selectedRangeTruthEndDate =
    selectedRangeIncludesCurrentDay ? selectedRangeHistoricalEndDate : selectedEndDate;
  const selectedRangeBreakdownCoverageByEndpoint =
    selectedRangeRequested &&
    selectedStartDate &&
    selectedRangeTruthEndDate &&
    selectedStartDate <= selectedRangeTruthEndDate
      ? await getMetaRawSnapshotCoverageByEndpoint({
          businessId: businessId!,
          providerAccountId: null,
          endpointNames: [...META_BREAKDOWN_ENDPOINTS],
          startDate: selectedStartDate,
          endDate: selectedRangeTruthEndDate,
        }).catch(() => null)
      : null;
  const selectedRangeTruth =
    selectedRangeRequested &&
    selectedStartDate &&
    selectedRangeTruthEndDate &&
    !selectedRangeIsToday &&
    selectedRangeWithinAuthoritativeHistory
      ? await getMetaSelectedRangeTruthReadiness({
          businessId: businessId!,
          startDate: selectedStartDate,
          endDate: selectedRangeTruthEndDate,
        }).catch(() => null)
      : null;
  const selectedRangeTruthSuggestsCurrentDayLive = Boolean(
    selectedRangeRequested &&
      !selectedRangeIsToday &&
      !selectedRangeIncludesCurrentDay &&
      (selectedRangeTruth?.detectorReasonCodes?.includes("current_day_live") ||
        Number(selectedRangeTruth?.reasonCounts?.current_day_live ?? 0) > 0)
  );
  const selectedRangeNeedsCurrentDayFallback =
    selectedRangeIncludesCurrentDay || selectedRangeTruthSuggestsCurrentDayLive;
  const selectedRangeEffectiveHistoricalEndDate =
    selectedRangeNeedsCurrentDayFallback && selectedEndDate
      ? addDaysToIsoDateUtc(selectedEndDate, -1)
      : selectedRangeHistoricalEndDate;
  const selectedRangeHistoricalTotalDays =
    selectedRangeRequested &&
    selectedStartDate &&
    selectedRangeEffectiveHistoricalEndDate &&
    selectedStartDate <= selectedRangeEffectiveHistoricalEndDate
      ? dayCountInclusive(selectedStartDate, selectedRangeEffectiveHistoricalEndDate)
      : 0;
  const selectedRangeUsesLiveFallback = Boolean(
    selectedRangeRequested &&
      !selectedRangeIsToday &&
      !selectedRangeWithinAuthoritativeHistory
  );
  const selectedRangeRequiresPublishedTruth = Boolean(
    selectedRangeRequested &&
      !selectedRangeIsToday &&
      selectedRangeWithinAuthoritativeHistory
  );
  const selectedRangeCoreCoverageCompletedDays = minCompletedDays(
    [
      selectedRangeCoverage?.completed_days ?? 0,
      selectedRangeCampaignCoverage?.completed_days ?? 0,
    ],
    selectedRangeTotalDays,
  );
  const selectedRangeCoreCompletedDays = minCompletedDays(
    selectedRangeUsesLiveFallback
      ? [selectedRangeTotalDays ?? 0]
      : [selectedRangeCoreCoverageCompletedDays],
    selectedRangeTotalDays,
  );
  const selectedRangeHistoricalCompletedDays = selectedRangeNeedsCurrentDayFallback
    ? Math.min(selectedRangeHistoricalTotalDays, selectedRangeCoreCoverageCompletedDays)
    : selectedRangeCoreCompletedDays;
  const selectedRangeHistoricalReady =
    selectedRangeHistoricalTotalDays > 0 &&
    selectedRangeHistoricalCompletedDays >= selectedRangeHistoricalTotalDays;
  const selectedRangeMode = selectedRangeIsToday
    ? "current_day_live"
    : selectedRangeUsesLiveFallback || selectedRangeNeedsCurrentDayFallback
      ? "historical_live_fallback"
      : "historical_warehouse";
  const currentDayLive =
    (selectedRangeIsToday || selectedRangeNeedsCurrentDayFallback) &&
    connected &&
    accountIds.length > 0 &&
    selectedEndDate
      ? await getMetaCurrentDayLiveAvailability({
          businessId: businessId!,
          startDate: selectedEndDate,
          endDate: selectedEndDate,
          providerAccountIds: accountIds,
        }).catch(() => ({
          summaryAvailable: false,
          campaignsAvailable: false,
        }))
      : null;
  const selectedRangeReadyTargetDays =
    selectedRangeIsToday
      ? selectedRangeTotalDays ?? 0
      : selectedRangeNeedsCurrentDayFallback
        ? selectedRangeHistoricalTotalDays
        : selectedRangeTotalDays ?? 0;
  const selectedRangeCurrentDayLiveReady =
    currentDayLive?.summaryAvailable === true &&
    currentDayLive?.campaignsAvailable === true;
  const selectedRangeHybridCoreCompletedDays =
    selectedRangeNeedsCurrentDayFallback && selectedRangeTotalDays
      ? Math.min(
          selectedRangeReadyTargetDays,
          selectedRangeHistoricalCompletedDays +
            (selectedRangeCurrentDayLiveReady ? 1 : 0),
        )
      : selectedRangeCoreCompletedDays;
  const selectedRangeEffectiveCompletedDays = selectedRangeUsesLiveFallback
    ? selectedRangeReadyTargetDays
    : selectedRangeNeedsCurrentDayFallback && !selectedRangeIsToday
      ? Math.min(selectedRangeReadyTargetDays, selectedRangeHistoricalCompletedDays)
      : selectedRangeHybridCoreCompletedDays;
  const selectedRangeEffectiveReady =
    selectedRangeReadyTargetDays > 0 &&
    selectedRangeEffectiveCompletedDays >= selectedRangeReadyTargetDays;
  const selectedRangeIncomplete =
    selectedRangeRequested
      ? selectedRangeUsesLiveFallback
        ? false
        : !selectedRangeEffectiveReady
      : false;
  const selectedRangeCoreReadyThroughDate = selectedRangeUsesLiveFallback
    ? selectedEndDate ?? null
    : selectedRangeNeedsCurrentDayFallback && selectedRangeEffectiveReady
      ? selectedRangeEffectiveHistoricalEndDate ?? null
      : earliestReadyThroughDate([
          selectedRangeCoverage?.ready_through_date ?? null,
          selectedRangeCampaignCoverage?.ready_through_date ?? null,
        ]);
  const selectedRangeBreakdownReadyThroughDate =
    selectedRangeRequested
      ? META_BREAKDOWN_ENDPOINTS.map(
          (endpointName) => selectedRangeBreakdownCoverageByEndpoint?.get(endpointName)?.ready_through_date ?? null
        )
          .filter((value): value is string => Boolean(value))
          .sort((a, b) => a.localeCompare(b))[0] ?? null
      : null;
  const selectedRangeBreakdownGuardrailBlocked =
    selectedRangeRequested && !selectedRangeWithinBreakdownHistory;
  const selectedRangeBreakdownCoverageMissing =
    selectedRangeRequested &&
    META_BREAKDOWN_ENDPOINTS.every((endpointName) => {
      const coverage = selectedRangeBreakdownCoverageByEndpoint?.get(endpointName) ?? null;
      return (coverage?.completed_days ?? 0) === 0 && !coverage?.ready_through_date;
    });
  const selectedRangePublishedBreakdownsReady = Boolean(
    selectedRangeRequested &&
      selectedRangeRequiresPublishedTruth &&
      !selectedRangeBreakdownGuardrailBlocked &&
      selectedRangeBreakdownCoverageMissing &&
      selectedRangeTruth?.truthReady
  );
  const scopeSummaries = [
    {
      scope: "account_daily",
      states: accountDailyStates,
      fallbackCompletedDays: accountCoverage?.completed_days ?? 0,
      fallbackReadyThroughDate: accountCoverage?.ready_through_date ?? null,
      totalDays: historicalTotalDays,
    },
    {
      scope: "campaign_daily",
      states: campaignDailyStates,
      fallbackCompletedDays: campaignCoverage?.completed_days ?? 0,
      fallbackReadyThroughDate: campaignCoverage?.ready_through_date ?? null,
      totalDays: historicalTotalDays,
    },
    {
      scope: "adset_daily",
      states: adsetDailyStates,
      fallbackCompletedDays: adsetCoverage?.completed_days ?? 0,
      fallbackReadyThroughDate: adsetCoverage?.ready_through_date ?? null,
      totalDays: historicalTotalDays,
    },
    {
      scope: "creative_daily",
      states: creativeDailyStates,
      fallbackCompletedDays: creativeCoverage?.completed_days ?? 0,
      fallbackReadyThroughDate: creativeCoverage?.ready_through_date ?? null,
      totalDays: creativeHistoricalTotalDays,
    },
    {
      scope: "ad_daily",
      states: adDailyStates,
      fallbackCompletedDays: adDailyCoverage?.completed_days ?? 0,
      fallbackReadyThroughDate: adDailyCoverage?.ready_through_date ?? null,
      totalDays: historicalTotalDays,
    },
  ].map((entry) => ({
    scope: entry.scope,
    completedDays:
      entry.states.length > 0
        ? Math.min(...entry.states.map((row) => row.completedDays))
        : entry.fallbackCompletedDays,
    totalDays: entry.totalDays,
    readyThroughDate:
      entry.states
        .map((row) => row.readyThroughDate)
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => a.localeCompare(b))[0] ?? entry.fallbackReadyThroughDate,
    latestBackgroundActivityAt:
      entry.states
        .map((row) => row.latestBackgroundActivityAt)
        .filter((value): value is string => Boolean(value))
        .sort((a, b) => b.localeCompare(a))[0] ?? null,
    deadLetterCount:
      entry.states.length > 0 ? Math.max(...entry.states.map((row) => row.deadLetterCount)) : 0,
  }));

  const historicalArchiveProgressPercent =
    historicalTotalDays > 0
      ? Math.min(100, Math.round((historicalArchiveCompletedDays / historicalTotalDays) * 100))
      : 0;
  const currentCoreProgressPercent =
    selectedRangeRequested && selectedRangeTotalDays
      ? Math.min(
          100,
          Math.round(
            (selectedRangeEffectiveCompletedDays / Math.max(1, selectedRangeReadyTargetDays)) * 100
          )
        )
      : recentWindowTotalDays > 0
        ? Math.min(
            100,
            Math.round(
              (minCompletedDays(
                [recentAccountCoverage?.completed_days ?? 0, recentCampaignCoverage?.completed_days ?? 0],
                recentWindowTotalDays
              ) /
                recentWindowTotalDays) *
                100
            )
          )
        : 0;
  const historicalArchiveComplete = historicalArchiveCompletedDays >= historicalTotalDays;
  const latestBackgroundActivityAt =
    queueHealth?.latestCoreActivityAt ??
    queueHealth?.latestMaintenanceActivityAt ??
    queueHealth?.latestExtendedActivityAt ??
    null;
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
    historicalArchiveCompletedDays < historicalTotalDays &&
    (queueHealth?.leasedPartitions ?? 0) === 0 &&
    (queueHealth?.queueDepth ?? 0) > 0 &&
    !backgroundRecentlyActive;
  const staleLeasedQueue =
    connected &&
    accountIds.length > 0 &&
    (queueHealth?.leasedPartitions ?? 0) > 0 &&
    !backgroundRecentlyActive;
  const stateMissingWhileQueued =
    connected &&
    accountIds.length > 0 &&
    (queueHealth?.queueDepth ?? 0) > 0 &&
    (queueHealth?.leasedPartitions ?? 0) === 0 &&
    scopeSummaries.every((summary) => summary.completedDays === 0);
  const defaultBreakdownCoverageReadyForPhase =
    recentWindowTotalDays > 0 &&
    META_BREAKDOWN_ENDPOINTS.every((endpointName) => {
      const coverage = breakdownCoverageByEndpoint?.get(endpointName) ?? null;
      return Math.min(recentWindowTotalDays, coverage?.completed_days ?? 0) >= recentWindowTotalDays;
    });
  const selectedRangeVerificationState =
    selectedRangeTruth?.verificationState ?? selectedRangeTruth?.state ?? null;
  const selectedRangeActionRequired =
    !selectedRangeIsToday &&
    selectedRangeRequested &&
    isMetaHistoricalVerificationActionRequired(selectedRangeVerificationState);

  const selectedRangeRecentCoreQueueDepth = Math.max(
    0,
    (queueHealth?.coreQueueDepth ?? 0) - (queueHealth?.historicalCoreQueueDepth ?? 0),
  );
  const selectedRangeRecentCoreLeasedPartitions = Math.max(
    0,
    (queueHealth?.coreLeasedPartitions ?? 0) -
      (queueHealth?.historicalCoreLeasedPartitions ?? 0),
  );
  const selectedRangeQueueActive =
    selectedRangeRecentCoreQueueDepth > 0 ||
    selectedRangeRecentCoreLeasedPartitions > 0 ||
    (queueHealth?.extendedRecentQueueDepth ?? 0) > 0 ||
    (queueHealth?.extendedRecentLeasedPartitions ?? 0) > 0 ||
    (queueHealth?.maintenanceQueueDepth ?? 0) > 0 ||
    (queueHealth?.maintenanceLeasedPartitions ?? 0) > 0;
  const selectedRangeStillPreparing = Boolean(selectedRangeRequested && selectedRangeIncomplete);
  const overallSyncActive =
    connected &&
    accountIds.length > 0 &&
    (selectedRangeRequested
      ? selectedRangeQueueActive || selectedRangeVerificationState === "processing"
      : historicalArchiveCompletedDays < historicalTotalDays ||
        (queueHealth?.leasedPartitions ?? 0) > 0 ||
        (queueHealth?.queueDepth ?? 0) > 0 ||
        (queueHealth?.retryableFailedPartitions ?? 0) > 0);
  const shouldReportSelectedRangeProgress = Boolean(selectedRangeRequested && selectedRangeTotalDays);
  const responseProgressPercent =
    shouldReportSelectedRangeProgress && selectedRangeTotalDays
      ? Math.min(
          100,
          Math.round((selectedRangeEffectiveCompletedDays / selectedRangeTotalDays) * 100),
        )
      : historicalArchiveProgressPercent;
  const responseCompletedDays = shouldReportSelectedRangeProgress
    ? selectedRangeEffectiveCompletedDays
    : historicalArchiveCompletedDays;
  const responseTotalDays = shouldReportSelectedRangeProgress
    ? selectedRangeTotalDays
    : historicalTotalDays;
  const responseReadyThroughDate = shouldReportSelectedRangeProgress
    ? selectedRangeCoreReadyThroughDate
    : historicalArchiveReadyThroughDate;
  const selectedRangeReportReady = Boolean(selectedRangeRequested && !selectedRangeIncomplete);
  const breakdownSupportStartDate = currentDateInTimezone
    ? getMetaBreakdownSupportedStart(currentDateInTimezone)
    : null;
  const selectedRangeBreakdownExpectedTotalDays =
    selectedRangeRequested
      ? Math.max(0, (selectedRangeTotalDays ?? 0) - (selectedRangeNeedsCurrentDayFallback ? 1 : 0))
      : 0;
  const selectedRangeBreakdownsBySurface = Object.fromEntries(
    META_BREAKDOWN_SURFACES.map((surface) => {
      const coverage = selectedRangeBreakdownCoverageByEndpoint?.get(surface.endpointName) ?? null;
      const totalDays = selectedRangeBreakdownExpectedTotalDays;
      const completedDays = selectedRangeRequested
        ? Math.min(
            totalDays,
            Math.max(
              coverage?.completed_days ?? 0,
              selectedRangePublishedBreakdownsReady ? totalDays : 0,
            ),
          )
        : 0;
      const readyThroughDate = selectedRangeRequested
        ? coverage?.ready_through_date ??
          (selectedRangePublishedBreakdownsReady
            ? selectedRangeEffectiveHistoricalEndDate ?? null
            : null)
        : null;
      const isBlocked = Boolean(selectedRangeBreakdownGuardrailBlocked);
      return [
        surface.coverageKey,
        {
          completedDays,
          totalDays,
          readyThroughDate,
          isComplete:
            Boolean(selectedRangeRequested) &&
            (selectedRangePublishedBreakdownsReady || completedDays >= totalDays),
          supportStartDate: breakdownSupportStartDate,
          isBlocked,
        },
      ];
    })
  ) as {
    age: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
    location: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
    placement: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
  };
  const recentBreakdownsBySurface = Object.fromEntries(
    META_BREAKDOWN_SURFACES.map((surface) => {
      const coverage = breakdownCoverageByEndpoint?.get(surface.endpointName) ?? null;
      const totalDays = recentWindowTotalDays;
      const completedDays = Math.min(totalDays, coverage?.completed_days ?? 0);
      return [
        surface.coverageKey,
        {
          completedDays,
          totalDays,
          readyThroughDate: coverage?.ready_through_date ?? null,
          isComplete: totalDays > 0 && completedDays >= totalDays,
          supportStartDate: breakdownSupportStartDate,
          isBlocked: false,
        },
      ];
    })
  ) as {
    age: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
    location: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
    placement: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
  };
  const historicalBreakdownTotalDays = Math.min(
    historicalTotalDays,
    META_BREAKDOWN_MAX_HISTORY_DAYS
  );
  const historicalBreakdownsBySurface = Object.fromEntries(
    META_BREAKDOWN_SURFACES.map((surface) => {
      const coverage = breakdownCoverageByEndpoint?.get(surface.endpointName) ?? null;
      const totalDays = historicalBreakdownTotalDays;
      const completedDays = Math.min(totalDays, coverage?.completed_days ?? 0);
      return [
        surface.coverageKey,
        {
          completedDays,
          totalDays,
          readyThroughDate: coverage?.ready_through_date ?? null,
          isComplete: totalDays > 0 && completedDays >= totalDays,
          supportStartDate: breakdownSupportStartDate,
          isBlocked: false,
        },
      ];
    })
  ) as {
    age: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
    location: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
    placement: {
      completedDays: number;
      totalDays: number;
      readyThroughDate: string | null;
      isComplete: boolean;
      supportStartDate: string | null;
      isBlocked: boolean;
    };
  };
  const defaultBreakdownCompletedDays = Math.min(
    recentBreakdownsBySurface.age.completedDays,
    recentBreakdownsBySurface.location.completedDays,
    recentBreakdownsBySurface.placement.completedDays
  );
  const selectedRangeBreakdownCompletedDays =
    selectedRangeRequested
      ? Math.min(
          selectedRangeBreakdownsBySurface.age.completedDays,
          selectedRangeBreakdownsBySurface.location.completedDays,
          selectedRangeBreakdownsBySurface.placement.completedDays
        )
      : 0;
  const summaryReady =
    !selectedRangeRequested
      ? connected && accountIds.length > 0 && (accountCoverage?.completed_days ?? 0) > 0
      : selectedRangeIsToday
      ? currentDayLive?.summaryAvailable === true
      : selectedRangeUsesLiveFallback
        ? connected && accountIds.length > 0
      : selectedRangeNeedsCurrentDayFallback
        ? connected && accountIds.length > 0 && selectedRangeHistoricalReady
        : selectedRangeEffectiveReady;
  const campaignsReady =
    !selectedRangeRequested
      ? connected && accountIds.length > 0 && (campaignCoverage?.completed_days ?? 0) > 0
      : selectedRangeIsToday
      ? currentDayLive?.campaignsAvailable === true
      : selectedRangeUsesLiveFallback
        ? connected && accountIds.length > 0
      : selectedRangeNeedsCurrentDayFallback
        ? connected && accountIds.length > 0 && selectedRangeHistoricalReady
        : selectedRangeEffectiveReady;
  const defaultCoreSurfacesReady =
    !selectedRangeRequested && summaryReady && campaignsReady;
  const defaultCoverageReadyForPhase =
    !selectedRangeRequested &&
    connected &&
    accountIds.length > 0 &&
    defaultCoreSurfacesReady &&
    defaultBreakdownCoverageReadyForPhase;
  const phaseLabel = buildPhaseLabel({
    selectedRangeIncomplete: Boolean(selectedRangeIncomplete),
    selectedRangeIsToday,
    defaultCoverageReady: defaultCoverageReadyForPhase,
    historicalQueuePaused,
    staleLeasedQueue,
    stateMissingWhileQueued,
    overallCompletedDays: historicalArchiveCompletedDays,
    totalDays: historicalTotalDays,
    latestSyncType: latestSync?.sync_type ? String(latestSync.sync_type) : null,
  });
  const effectiveCurrentCoreProgressPercent =
    defaultCoreSurfacesReady ? 100 : currentCoreProgressPercent;
  const currentCoreUsable = selectedRangeRequested
    ? Boolean(selectedRangeReadyTargetDays) &&
      selectedRangeEffectiveCompletedDays >= selectedRangeReadyTargetDays
    : defaultCoreSurfacesReady;
  const summarySurfaceReason = !connected
    ? "Meta integration is not connected."
    : accountIds.length === 0
      ? "No Meta ad account is assigned to this workspace."
      : summaryReady
        ? null
        : !selectedRangeRequested
          ? "Summary data is still being prepared for Meta's primary reporting surfaces."
        : selectedRangeIsToday
        ? "Summary data for the current Meta account day is still preparing."
        : selectedRangeNeedsCurrentDayFallback
          ? "Current-day summary data is still preparing for the selected range."
        : getMetaHistoricalVerificationReason({
              verificationState: selectedRangeVerificationState,
              fallbackReason: "Summary warehouse data is still being prepared for the selected range.",
            });
  const summarySurfaceBlockedReason = selectedRangeActionRequired
    ? summarySurfaceReason
    : null;
  const campaignsSurfaceReason = !connected
    ? "Meta integration is not connected."
    : accountIds.length === 0
      ? "No Meta ad account is assigned to this workspace."
      : campaignsReady
        ? null
        : !selectedRangeRequested
          ? "Campaign data is still being prepared for Meta's primary reporting surfaces."
        : selectedRangeIsToday
        ? "Campaign data for the current Meta account day is still preparing."
        : selectedRangeNeedsCurrentDayFallback
          ? "Current-day campaign data is still preparing for the selected range."
        : getMetaHistoricalVerificationReason({
              verificationState: selectedRangeVerificationState,
              fallbackReason: "Campaign warehouse data is still being prepared for the selected range.",
            });
  const campaignsSurfaceBlockedReason = selectedRangeActionRequired
    ? campaignsSurfaceReason
    : null;
  const defaultBreakdownSurfaceCoverage = recentBreakdownsBySurface;
  const breakdownRequiredSurfaces = Object.fromEntries(
    META_BREAKDOWN_SURFACES.map((surface) => {
      const coverage = selectedRangeRequested
        ? selectedRangeBreakdownsBySurface[surface.coverageKey]
        : defaultBreakdownSurfaceCoverage[surface.coverageKey];
      const ready = selectedRangeRequested
        ? coverage.isComplete || selectedRangePublishedBreakdownsReady
        : coverage.isComplete;
      const blockedReason =
        coverage.isBlocked && coverage.supportStartDate
          ? `${surface.label} breakdown data is only supported from ${coverage.supportStartDate} onward for the selected range.`
          : selectedRangeActionRequired
            ? getMetaHistoricalVerificationReason({
                verificationState: selectedRangeVerificationState,
                fallbackReason: `${surface.label} breakdown data is still being prepared for the selected range.`,
              })
          : null;
      const reason = !connected
        ? "Meta integration is not connected."
        : accountIds.length === 0
          ? "No Meta ad account is assigned to this workspace."
          : blockedReason
            ? blockedReason
            : ready
              ? null
              : selectedRangeRequested
                ? selectedRangeIsToday
                  ? `${surface.label} breakdown data for the current Meta account day is still preparing.`
                  : `${surface.label} breakdown data is still being prepared for the selected range.`
                : `${surface.label} breakdown data is still being prepared for the default Meta coverage window.`;
      const state = buildPageSurfaceState({
        connected,
        hasAssignedAccounts: accountIds.length > 0,
        ready,
        activeProgress: overallSyncActive,
        blockedReason,
        syncingReason: reason ?? `${surface.label} breakdown data is still preparing.`,
        blockedFallbackReason:
          reason ?? `${surface.label} breakdown data is unavailable for the selected range.`,
      });
      return [
        surface.surfaceKey,
        {
          state,
          blocking: !coverage.isBlocked && state !== "ready",
          countsForPageCompleteness: !coverage.isBlocked,
          truthClass: selectedRangeIsToday ? "current_day_live" : "historical_warehouse",
          reason,
        },
      ];
    })
  ) as Pick<
    ReturnType<typeof rollupMetaPageReadiness>["requiredSurfaces"],
    "breakdowns.age" | "breakdowns.location" | "breakdowns.placement"
  >;
  const pageRequiredSurfaces = {
    summary: {
      state: buildPageSurfaceState({
        connected,
        hasAssignedAccounts: accountIds.length > 0,
        ready: summaryReady,
        activeProgress: overallSyncActive,
        blockedReason: summarySurfaceBlockedReason,
        syncingReason: summarySurfaceReason ?? "Summary data is still preparing.",
        blockedFallbackReason: summarySurfaceReason ?? "Summary data is unavailable.",
      }),
      blocking: !summaryReady,
      countsForPageCompleteness: true,
      truthClass: selectedRangeIsToday
        ? "current_day_live"
        : selectedRangeUsesLiveFallback || selectedRangeIncludesCurrentDay
          ? "historical_live_fallback"
          : "historical_warehouse",
      reason: summarySurfaceReason,
    },
    campaigns: {
      state: buildPageSurfaceState({
        connected,
        hasAssignedAccounts: accountIds.length > 0,
        ready: campaignsReady,
        activeProgress: overallSyncActive,
        blockedReason: campaignsSurfaceBlockedReason,
        syncingReason: campaignsSurfaceReason ?? "Campaign data is still preparing.",
        blockedFallbackReason: campaignsSurfaceReason ?? "Campaign data is unavailable.",
      }),
      blocking: !campaignsReady,
      countsForPageCompleteness: true,
      truthClass: selectedRangeIsToday
        ? "current_day_live"
        : selectedRangeUsesLiveFallback || selectedRangeIncludesCurrentDay
          ? "historical_live_fallback"
          : "historical_warehouse",
      reason: campaignsSurfaceReason,
    },
    ...breakdownRequiredSurfaces,
  } as const;
  const adsetsReady =
    selectedRangeIsToday
      ? connected && accountIds.length > 0
      : selectedRangeUsesLiveFallback
        ? connected && accountIds.length > 0
      : Boolean(selectedRangeTotalDays) &&
        (selectedRangeAdsetCoverage?.completed_days ?? 0) >=
          (selectedRangeTotalDays ?? 0);
  const decisionOsEnabled = isMetaDecisionOsV1EnabledForBusiness(businessId);
  const pageOptionalSurfaces = {
    adsets: {
      state: !connected
        ? "not_connected"
        : adsetsReady
          ? "ready"
          : overallSyncActive
            ? "syncing"
            : "partial",
      blocking: false,
      countsForPageCompleteness: false,
      truthClass: "conditional_drilldown",
      reason: !connected
        ? "Meta integration is not connected."
        : accountIds.length === 0
          ? "No Meta ad account is assigned to this workspace."
          : adsetsReady
            ? "Ad set drilldown is available when a campaign is selected."
            : "Ad set drilldown becomes available when a campaign is selected and the selected range is prepared.",
    },
    recommendations: {
      state: !connected
        ? "not_connected"
        : pageRequiredSurfaces.summary.state === "ready" &&
            pageRequiredSurfaces.campaigns.state === "ready"
          ? "ready"
          : overallSyncActive
            ? "syncing"
            : "partial",
      blocking: false,
      countsForPageCompleteness: false,
      truthClass: "deterministic_decision_engine",
      reason: !connected
        ? "Meta integration is not connected."
        : pageRequiredSurfaces.summary.state === "ready" &&
            pageRequiredSurfaces.campaigns.state === "ready"
          ? "Deterministic recommendations are available when the selected-range core surfaces are ready."
          : "Recommendations remain optional while selected-range core surfaces are still preparing.",
    },
    operating_mode: {
      state: !connected
        ? "not_connected"
        : pageRequiredSurfaces.summary.state === "ready" &&
            pageRequiredSurfaces.campaigns.state === "ready"
          ? "ready"
          : overallSyncActive
            ? "syncing"
            : "partial",
      blocking: false,
      countsForPageCompleteness: false,
      truthClass: "deterministic_decision_engine",
      reason: !connected
        ? "Meta integration is not connected."
        : pageRequiredSurfaces.summary.state === "ready" &&
            pageRequiredSurfaces.campaigns.state === "ready"
          ? "Deterministic operating mode is available as an optional commercial-truth overlay."
          : "Operating mode remains optional while the selected-range core surfaces are still preparing.",
    },
    decision_os: {
      state: !connected
        ? "not_connected"
        : !decisionOsEnabled
          ? "partial"
          : pageRequiredSurfaces.summary.state === "ready" &&
              pageRequiredSurfaces.campaigns.state === "ready"
            ? "ready"
            : overallSyncActive
              ? "syncing"
              : "partial",
      blocking: false,
      countsForPageCompleteness: false,
      truthClass: "deterministic_decision_engine",
      reason: !connected
        ? "Meta integration is not connected."
        : !decisionOsEnabled
          ? "Meta Decision OS is feature-gated for this workspace."
          : pageRequiredSurfaces.summary.state === "ready" &&
              pageRequiredSurfaces.campaigns.state === "ready"
            ? "Meta Decision OS is available as the structured operator decision center."
            : "Meta Decision OS remains optional while the selected-range core surfaces are still preparing.",
    },
  } as const;
  const pageReadiness = rollupMetaPageReadiness({
    connected,
    hasAssignedAccounts: accountIds.length > 0,
    selectedRangeMode,
    requiredSurfaces: pageRequiredSurfaces,
    optionalSurfaces: pageOptionalSurfaces,
  });
  const providerCoreSurfaces: Record<MetaCoreSurfaceKey, MetaSurfaceReadiness> = selectedRangeRequested
    ? {
        summary: { ...pageRequiredSurfaces.summary },
        campaigns: { ...pageRequiredSurfaces.campaigns },
      }
    : {
        summary: {
          state: buildPageSurfaceState({
            connected,
            hasAssignedAccounts: accountIds.length > 0,
            ready: summaryReady,
            activeProgress: overallSyncActive,
            blockedReason: null,
            syncingReason:
              summaryReady
                ? "Summary data is ready on Meta's primary reporting surfaces."
                : "Summary data is still being prepared for Meta's primary reporting surfaces.",
            blockedFallbackReason: "Summary data is unavailable on Meta's primary reporting surfaces.",
          }),
          blocking: !summaryReady,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: !connected
            ? "Meta integration is not connected."
            : accountIds.length === 0
              ? "No Meta ad account is assigned to this workspace."
              : summaryReady
                ? null
                : "Summary data is still being prepared for Meta's primary reporting surfaces.",
        },
        campaigns: {
          state: buildPageSurfaceState({
            connected,
            hasAssignedAccounts: accountIds.length > 0,
            ready: campaignsReady,
            activeProgress: overallSyncActive,
            blockedReason: null,
            syncingReason:
              campaignsReady
                ? "Campaign data is ready on Meta's primary reporting surfaces."
                : "Campaign data is still being prepared for Meta's primary reporting surfaces.",
            blockedFallbackReason: "Campaign data is unavailable on Meta's primary reporting surfaces.",
          }),
          blocking: !campaignsReady,
          countsForPageCompleteness: true,
          truthClass: "historical_warehouse",
          reason: !connected
            ? "Meta integration is not connected."
            : accountIds.length === 0
              ? "No Meta ad account is assigned to this workspace."
              : campaignsReady
                ? null
                : "Campaign data is still being prepared for Meta's primary reporting surfaces.",
        },
      };
  const extendedSurfaceReadiness = Object.fromEntries(
    META_BREAKDOWN_SURFACES.map((surface) => {
      const selectedRangeCoverage = selectedRangeBreakdownsBySurface[surface.coverageKey];
      const defaultCoverage = defaultBreakdownSurfaceCoverage[surface.coverageKey];
      const totalDays = selectedRangeRequested
        ? selectedRangeCoverage.totalDays
        : defaultCoverage.totalDays;
      const completedDays = selectedRangeRequested
        ? selectedRangeCoverage.completedDays
        : defaultCoverage.completedDays;
      const ready = selectedRangeRequested
        ? selectedRangeCoverage.isComplete
        : defaultCoverage.isComplete;
      const blockedReason = selectedRangeRequested
        ? selectedRangeCoverage.isBlocked && selectedRangeCoverage.supportStartDate
          ? `${surface.label} breakdown data is only supported from ${selectedRangeCoverage.supportStartDate} onward for the selected range.`
          : selectedRangeActionRequired
            ? getMetaHistoricalVerificationReason({
                verificationState: selectedRangeVerificationState,
                fallbackReason: `${surface.label} breakdown data is still being prepared for the selected range.`,
              })
            : null
        : null;
      const reason = !connected
        ? "Meta integration is not connected."
        : accountIds.length === 0
          ? "No Meta ad account is assigned to this workspace."
          : blockedReason
            ? blockedReason
            : ready
              ? null
              : selectedRangeRequested
                ? selectedRangeIsToday
              ? `${surface.label} breakdown data for the current Meta account day is still preparing.`
                  : `${surface.label} breakdown data is still being prepared for the selected range.`
                : `${surface.label} breakdown data is still being prepared for Meta's default coverage window.`;
      return [
        surface.surfaceKey,
        {
          state: buildPageSurfaceState({
            connected,
            hasAssignedAccounts: accountIds.length > 0,
            ready,
            activeProgress: overallSyncActive,
            blockedReason,
            syncingReason: reason ?? `${surface.label} breakdown data is still preparing.`,
            blockedFallbackReason:
              reason ?? `${surface.label} breakdown data is unavailable for the current contract.`,
          }),
          blocking: connected && accountIds.length > 0 && !ready,
          countsForPageCompleteness: true,
          truthClass: selectedRangeIsToday
            ? "current_day_live"
            : "historical_warehouse",
          reason,
        },
      ];
    })
  ) as {
    "breakdowns.age": MetaSurfaceReadiness;
    "breakdowns.location": MetaSurfaceReadiness;
    "breakdowns.placement": MetaSurfaceReadiness;
  };
  const coreReadiness = buildMetaCoreReadiness({
    connected,
    hasAssignedAccounts: accountIds.length > 0,
    percent: clampPercent(effectiveCurrentCoreProgressPercent),
    summary: null,
    surfaces: providerCoreSurfaces,
  });
  if (coreReadiness.complete) {
    coreReadiness.percent = 100;
  }
  coreReadiness.summary =
    coreReadiness.reason ??
    (!connected
      ? "Meta integration is not connected."
      : accountIds.length === 0
        ? "No Meta ad account is assigned to this workspace."
        : coreReadiness.complete
          ? selectedRangeRequested
            ? selectedRangeIsToday
              ? "Summary and campaign data for the current Meta account day are ready."
              : "Summary and campaign data are ready for the selected range."
            : "Summary and campaign data are ready for Meta's primary reporting surfaces."
          : selectedRangeRequested
            ? selectedRangeIsToday
              ? "Summary and campaign data for the current Meta account day are still preparing."
              : "Summary and campaign data are still being prepared for the selected range."
            : "Summary and campaign data are still being prepared for Meta's primary reporting surfaces.");
  const extendedPercent =
    selectedRangeRequested && selectedRangeBreakdownGuardrailBlocked
      ? null
      : clampPercent(
          selectedRangeRequested && selectedRangeBreakdownExpectedTotalDays > 0
            ? (selectedRangeBreakdownCompletedDays /
                Math.max(1, selectedRangeBreakdownExpectedTotalDays)) *
                100
            : recentWindowTotalDays > 0
              ? (defaultBreakdownCompletedDays / recentWindowTotalDays) * 100
              : null
        );
  const extendedCompleteness = buildMetaExtendedCompleteness({
    connected,
    hasAssignedAccounts: accountIds.length > 0,
    percent: extendedPercent,
    summary: null,
    surfaces: extendedSurfaceReadiness,
  });
  extendedCompleteness.summary =
    extendedCompleteness.reason ??
    (!connected
      ? "Meta integration is not connected."
      : accountIds.length === 0
        ? "No Meta ad account is assigned to this workspace."
        : extendedCompleteness.complete
          ? selectedRangeRequested
            ? selectedRangeIsToday
              ? "Current-day Meta breakdowns are ready."
              : "Breakdown data is ready for the selected range."
            : "Breakdown data is ready for Meta's default coverage window."
          : selectedRangeRequested
            ? selectedRangeIsToday
              ? "Current-day Meta breakdowns are still preparing."
              : selectedRangeBreakdownGuardrailBlocked
                ? "Some Meta breakdowns are unavailable for the selected range."
                : "Breakdown data is still being prepared for the selected range."
            : "Breakdown data is still being prepared for Meta's default coverage window.");

  const recentExtendedReady =
    recentBreakdownsBySurface.age.isComplete &&
    recentBreakdownsBySurface.location.isComplete &&
    recentBreakdownsBySurface.placement.isComplete;
  const defaultCoverageReady =
    !selectedRangeRequested &&
    currentCoreUsable &&
    recentExtendedReady;
  const state: MetaStatusResponse["state"] = !connected
    ? "not_connected"
    : accountIds.length === 0
      ? "connected_no_assignment"
      : selectedRangeActionRequired
        ? "action_required"
        : (queueHealth?.deadLetterPartitions ?? 0) > 0
          ? "action_required"
        : !selectedRangeRequested && defaultCoverageReady
          ? "ready"
        : staleLeasedQueue
          ? "stale"
        : stateMissingWhileQueued
          ? "paused"
        : historicalQueuePaused
          ? "paused"
        : selectedRangeReportReady
          ? "ready"
        : (legacyJobHealth?.staleRunningJobs ?? 0) > 0
            ? "stale"
            : (queueHealth?.retryableFailedPartitions ?? 0) > 0
              ? "stale"
            : overallSyncActive
              ? "syncing"
              : !selectedRangeIncomplete && historicalArchiveProgressPercent >= 100
                  ? "ready"
                  : "partial";
  const latestMetaActivityAt =
    queueHealth?.latestCoreActivityAt ??
    queueHealth?.latestExtendedActivityAt ??
    queueHealth?.latestMaintenanceActivityAt ??
    null;
  const metaProgressEvidence = buildProviderProgressEvidence({
    states: META_STATE_SCOPES.flatMap((scope) => relevantStates(scope)),
    checkpointUpdatedAt: checkpointHealth?.latestCheckpointUpdatedAt ?? null,
    recentActivityWindowMinutes: 20,
    aggregation: "latest",
  });
  const metaProgressState = deriveProviderProgressState({
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
    latestPartitionActivityAt: latestMetaActivityAt,
    blocked: state === "action_required",
    fullyReady: state === "ready",
    hasRepairableBacklog: (queueHealth?.retryableFailedPartitions ?? 0) > 0,
    staleRunPressure: legacyJobHealth?.staleRunningJobs ?? 0,
    progressEvidence: metaProgressEvidence,
  });
  const metaActivityState = deriveProviderActivityState({
    progressState: metaProgressState,
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    blocked: state === "action_required",
  });
  const lagMetrics = buildSyncLagMetrics(authoritativeSnapshot?.latestPublishes?.[0] ?? null);
  const unifiedTruth = deriveUnifiedSyncTruth({
    activityState: metaActivityState,
    progressState: metaProgressState,
    workerOnline: workerHealth?.hasFreshHeartbeat ?? null,
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    releaseGateVerdict: gateRecords.releaseGate?.verdict ?? null,
    runtimeContractValid: runtimeRegistry?.contractValid ?? runtimeContract.validation.pass,
  });
  const metaBlockingReasons = compactBlockingReasons([
    selectedRangeActionRequired
      ? buildBlockingReason(
          selectedRangeVerificationState === "blocked"
            ? "blocked_publication_mismatch"
            : selectedRangeVerificationState === "repair_required"
              ? "repair_required_authoritative_retry"
              : "historical_verification_failed",
          getMetaHistoricalVerificationReason({
            verificationState: selectedRangeVerificationState,
            fallbackReason:
              "Historical Meta selected-range truth is not yet published.",
          }),
          { repairable: selectedRangeVerificationState !== "blocked" }
        )
      : null,
    (queueHealth?.deadLetterPartitions ?? 0) > 0
      ? buildBlockingReason(
          "required_dead_letter_partitions",
          `${queueHealth?.deadLetterPartitions ?? 0} Meta partition(s) are dead-lettered.`,
          { repairable: true }
        )
      : null,
    (queueHealth?.retryableFailedPartitions ?? 0) > 0
      ? buildBlockingReason(
          "retryable_failed_partitions",
          `${queueHealth?.retryableFailedPartitions ?? 0} Meta partition(s) are waiting for retry.`,
          { repairable: true }
        )
      : null,
    operationsBlockReason
      ? buildBlockingReason(
          `operations_${operationsBlockReason}`,
          `Meta sync operations are currently limited by ${operationsBlockReason}.`,
        )
      : null,
  ]);
  const metaRepairableActions = compactRepairableActions([
    buildRepairableAction(
      "refresh_queue",
      "Run targeted queue repair and re-plan missing Meta partitions.",
      { available: (queueHealth?.queueDepth ?? 0) > 0 || (queueHealth?.leasedPartitions ?? 0) > 0 }
    ),
    selectedRangeVerificationState === "blocked"
      ? buildRepairableAction(
          "inspect_blocked_publication_mismatch",
          "Inspect Meta verify-day and publish verification output before replaying blocked publication mismatches."
        )
      : null,
    selectedRangeVerificationState === "failed" ||
    selectedRangeVerificationState === "repair_required"
      ? buildRepairableAction(
          "retry_authoritative_refresh",
          "Queue a fresh authoritative Meta retry once state is refreshed."
        )
      : null,
    staleLeasedQueue
      ? buildRepairableAction(
          "inspect_stale_leases",
          "Confirm stale Meta leases show no progress before cleanup or reclaim."
        )
      : null,
    (queueHealth?.deadLetterPartitions ?? 0) > 0
      ? buildRepairableAction(
          "replay_dead_letters",
          "Replay Meta dead-letter partitions back into the queue."
        )
      : null,
    (queueHealth?.retryableFailedPartitions ?? 0) > 0
      ? buildRepairableAction(
          "requeue_failed",
          "Requeue retryable Meta failed partitions."
        )
      : null,
  ]);
  const metaRequiredCoverage = buildRequiredCoverage({
    completedDays: historicalArchiveCompletedDays,
    totalDays: historicalTotalDays,
    readyThroughDate: historicalArchiveReadyThroughDate,
  });
  const metaStallFingerprints = deriveProviderStallFingerprints({
    queueDepth: queueHealth?.queueDepth ?? 0,
    leasedPartitions: queueHealth?.leasedPartitions ?? 0,
    checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
    latestPartitionActivityAt: latestMetaActivityAt,
    blocked: state === "action_required",
    workerHealthy: workerHealth?.workerHealthy ?? null,
    hasRepairableBacklog: (queueHealth?.retryableFailedPartitions ?? 0) > 0,
    staleRunPressure: legacyJobHealth?.staleRunningJobs ?? 0,
    progressEvidence: metaProgressEvidence,
    blockedReasonCodes: metaBlockingReasons.map((reason) => reason.code),
    historicalBacklogDepth:
      (queueHealth?.historicalCoreQueueDepth ?? 0) +
      (queueHealth?.historicalCoreLeasedPartitions ?? 0) +
      (queueHealth?.extendedHistoricalQueueDepth ?? 0) +
      (queueHealth?.extendedHistoricalLeasedPartitions ?? 0),
  });
  const providerState = buildProviderStateContract({
    credentialState: connected ? "connected" : "not_connected",
    hasAssignedAccounts: accountIds.length > 0,
    warehouseRowCount: Number(accountStats?.row_count ?? 0),
    warehousePartial: selectedRangeRequested
      ? Boolean(selectedRangeIncomplete)
      : historicalArchiveCompletedDays < historicalTotalDays,
    syncState: state,
    selectedCurrentDay: selectedRangeIsToday,
    notReadyReason: phaseLabel === "Ready" ? null : phaseLabel,
  });
  const dataContract = {
    todayMode: "live_only",
    historicalInsideHorizon: "published_verified_truth",
    historicalOutsideCoreHorizon: "live_fallback",
    breakdownOutsideHorizon: "unsupported_degraded",
  } as const;
  const completionBasis = {
    requiredScopes: ["account_daily", "campaign_daily"],
    excludedScopes: ["adset_daily", "ad_daily", "breakdowns"],
    percent: metaRequiredCoverage.percent,
    complete: metaRequiredCoverage.complete,
  };
  const completionBlockers = metaBlockingReasons.map((reason) => reason.code);
  const platformDateBoundary = {
    primaryAccountId,
    primaryAccountTimezone,
    currentDateInTimezone,
    previousDateInTimezone: addDaysToIsoDateUtc(currentDateInTimezone, -1),
    selectedRangeMode,
    mixedCurrentDates:
      new Set(platformDateBoundaryAccounts.map((account) => account.currentDate)).size > 1,
    accounts: platformDateBoundaryAccounts,
  };
  const primaryBoundary =
    platformDateBoundaryAccounts.find((account) => account.isPrimary) ??
    platformDateBoundaryAccounts[0] ??
    null;
  const d1TargetDate = primaryBoundary?.previousDate ?? null;
  const d1Verification =
    primaryBoundary?.providerAccountId && d1TargetDate
      ? await getMetaAuthoritativeDayVerification({
          businessId: businessId!,
          providerAccountId: primaryBoundary.providerAccountId,
          day: d1TargetDate,
        }).catch(() => null)
      : null;
  const d1FinalizeState =
    d1TargetDate == null
      ? null
      : d1Verification?.verificationState === "finalized_verified"
        ? "ready"
        : d1Verification
          ? d1Verification.verificationState === "blocked" ||
              d1Verification.verificationState === "failed" ||
              d1Verification.verificationState === "repair_required"
            ? "blocked"
            : "processing"
          : null;
  const d1BlockedReason =
    d1FinalizeState !== "ready" && d1Verification
      ? d1Verification.verificationState === "blocked"
        ? d1Verification.detectorReasonCodes?.[0] ??
          "publication_pointer_missing_after_finalize"
        : d1Verification.verificationState === "repair_required"
          ? "repair_required_authoritative_retry"
          : d1Verification.verificationState === "failed"
            ? "authoritative_finalize_failed"
            : d1Verification.staleLeases > 0
              ? "stale_lease_pending_proof"
              : d1Verification.leasedPartitions > 0
                ? "active_finalize_day_partition"
                : d1Verification.queuedPartitions > 0 ||
                    d1Verification.repairBacklog > 0
                  ? "queued_finalize_day_partition"
                  : "awaiting_authoritative_publication"
      : d1FinalizeState === "processing"
        ? "awaiting_authoritative_publication"
        : null;

  const accountSurfaceReady = (accountCoverage?.completed_days ?? 0) >= historicalTotalDays;
  const campaignSurfaceReady = (campaignCoverage?.completed_days ?? 0) >= historicalTotalDays;
  const availableSurfaces = [
    currentCoreUsable ? "account_daily" : null,
    currentCoreUsable ? "campaign_daily" : null,
    (adsetCoverage?.completed_days ?? 0) >= effectiveHistoricalTotalDays ? "adset_daily" : null,
    (adDailyCoverage?.completed_days ?? 0) >= effectiveHistoricalTotalDays ? "ad_daily" : null,
    breakdownCoverageDays >= Math.min(historicalTotalDays, META_BREAKDOWN_MAX_HISTORY_DAYS) ? "breakdowns" : null,
  ].filter((value): value is string => Boolean(value));
  const surfaces = buildProviderSurfaces({
    required: [...META_CORE_REQUIRED_SURFACES, ...META_SECONDARY_SURFACES, ...META_DEEP_SURFACES],
    available: availableSurfaces,
  });
  const readinessLevel: "usable" | "partial" | "ready" =
    selectedRangeReportReady || defaultCoverageReady
      ? "ready"
      : accountSurfaceReady && campaignSurfaceReady
      ? "ready"
      : currentCoreUsable
        ? "usable"
        : "partial";
  const domainReadiness = buildMetaDomainReadiness({
    availableSurfaces,
    missingSurfaces: surfaces.missing,
  });

  const rangeCompletionBySurface = {
    account_daily: {
      recentCompletedDays: Math.min(recentWindowTotalDays, recentAccountCoverage?.completed_days ?? 0),
      recentTotalDays: recentWindowTotalDays,
      historicalCompletedDays: Math.min(historicalTotalDays, accountCoverage?.completed_days ?? 0),
      historicalTotalDays,
      readyThroughDate: accountCoverage?.ready_through_date ?? null,
    },
    campaign_daily: {
      recentCompletedDays: Math.min(recentWindowTotalDays, recentCampaignCoverage?.completed_days ?? 0),
      recentTotalDays: recentWindowTotalDays,
      historicalCompletedDays: Math.min(historicalTotalDays, campaignCoverage?.completed_days ?? 0),
      historicalTotalDays,
      readyThroughDate: campaignCoverage?.ready_through_date ?? null,
    },
    adset_daily: {
      recentCompletedDays: Math.min(recentWindowTotalDays, recentAdsetCoverage?.completed_days ?? 0),
      recentTotalDays: recentWindowTotalDays,
      historicalCompletedDays: Math.min(historicalTotalDays, adsetCoverage?.completed_days ?? 0),
      historicalTotalDays,
      readyThroughDate: adsetCoverage?.ready_through_date ?? null,
    },
    creative_daily: {
      recentCompletedDays: Math.min(recentWindowTotalDays, recentCreativeCoverage?.completed_days ?? 0),
      recentTotalDays: recentWindowTotalDays,
      historicalCompletedDays: Math.min(creativeHistoricalTotalDays, creativeCoverage?.completed_days ?? 0),
      historicalTotalDays: creativeHistoricalTotalDays,
      readyThroughDate: creativeCoverage?.ready_through_date ?? null,
    },
    ad_daily: {
      recentCompletedDays: Math.min(recentWindowTotalDays, recentAdCoverage?.completed_days ?? 0),
      recentTotalDays: recentWindowTotalDays,
      historicalCompletedDays: Math.min(historicalTotalDays, adDailyCoverage?.completed_days ?? 0),
      historicalTotalDays,
      readyThroughDate: adDailyCoverage?.ready_through_date ?? null,
    },
  } as const;

  const historicalExtendedReady =
    historicalBreakdownsBySurface.age.isComplete &&
    historicalBreakdownsBySurface.location.isComplete &&
    historicalBreakdownsBySurface.placement.isComplete;
  const extendedRecoveryState =
    !recentExtendedReady
      ? "core_only"
      : historicalExtendedReady
        ? "extended_normal"
        : "extended_recovery";
  const quotaLimited =
    accountSnapshot?.meta.failureClass === "quota" ||
    /quota|rate[- ]?limit|too many requests|429|resource[_ ]?exhausted/i.test(
      [
        accountSnapshot?.meta.lastError,
        latestSync?.last_error ? String(latestSync.last_error) : null,
      ]
        .filter((value): value is string => Boolean(value))
        .join(" "),
    );
  const coldBootstrap =
    connected &&
    accountIds.length > 0 &&
    Number(accountStats?.row_count ?? 0) === 0 &&
    historicalArchiveCompletedDays === 0;
  const backfillInProgress =
    connected &&
    accountIds.length > 0 &&
    (historicalArchiveCompletedDays < historicalTotalDays ||
      Boolean(selectedRangeIncomplete) ||
      overallSyncActive ||
      (queueHealth?.queueDepth ?? 0) > 0 ||
      (queueHealth?.leasedPartitions ?? 0) > 0);
  const partialUpstreamCoverage =
    !selectedRangeActionRequired &&
    (pageReadiness.state === "partial" ||
      Boolean(selectedRangeStillPreparing) ||
      surfaces.missing.length > 0);
  const rebuildState =
    selectedRangeVerificationState === "repair_required"
      ? "repair_required"
      : state === "action_required" || selectedRangeVerificationState === "blocked"
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
  const finalizationExecutionPosture = isMetaAuthoritativeFinalizationV2Enabled()
    ? {
        state: "globally_enabled" as const,
        summary:
          "Meta authoritative finalization v2 is globally enabled for all businesses under the current explicit operator posture.",
      }
    : {
        state: "disabled" as const,
        summary: "Meta authoritative finalization v2 is globally disabled.",
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
  const protectedPublishedTruthState =
    protectedPublishedTruthReview == null || !protectedPublishedTruthReview.runtimeAvailable
      ? "unavailable"
      : protectedPublishedTruthReview.hasNonZeroProtectedPublishedRows
        ? "present"
        : protectedPublishedTruthReview.activePublicationPointerRows === 0 &&
            selectedRangeVerificationState === "blocked"
          ? "publication_missing"
          : rebuildState === "repair_required" ||
              rebuildState === "quota_limited" ||
              rebuildState === "cold_bootstrap" ||
              rebuildState === "backfill_in_progress" ||
              rebuildState === "partial_upstream_coverage"
            ? "rebuild_incomplete"
            : "none_visible";
  const protectedPublishedTruthSummary =
    protectedPublishedTruthState === "present"
      ? "Non-zero Meta protected published daily truth is visible in rebuilt data."
      : protectedPublishedTruthState === "publication_missing"
        ? "Protected Meta published truth is absent because required publication is still missing."
        : protectedPublishedTruthState === "rebuild_incomplete"
          ? "Protected Meta published truth is not yet visible because rebuild truth is still incomplete."
          : protectedPublishedTruthState === "none_visible"
            ? "No non-zero Meta protected published daily rows are currently visible for this business."
            : "Meta protected published truth review is unavailable.";

  const response = {
      state,
      controlPlaneIdentity,
      controlPlanePersistence,
      controlPlaneErrors,
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
      requiredScopeCompletion: metaRequiredCoverage,
      readinessLevel,
      surfaces,
      checkpointHealth,
      phaseTimings:
        phaseTimings.length > 0
          ? {
              windowHours: 24,
              phases: phaseTimings,
            }
          : null,
      runtimeContract,
      runtimeRegistry,
      deployGate: gateRecords.deployGate,
      releaseGate: gateRecords.releaseGate,
      repairPlan,
      latestRemediationExecution,
      syncTruthState: unifiedTruth.syncTruthState,
      blockerClass: unifiedTruth.blockerClass === "none" ? null : unifiedTruth.blockerClass,
      domainReadiness,
      connected,
      d1TargetDate,
      d1FinalizeState,
      d1BlockedReason,
      operatorTruth: {
        rolloutModel: "global",
        reviewWorkflow: GLOBAL_OPERATOR_REVIEW_WORKFLOW,
        execution: {
          authoritativeFinalization: finalizationExecutionPosture,
          retention: retentionExecutionPosture,
        },
        rebuild: {
          state: rebuildState,
          coldBootstrap,
          backfillInProgress,
          quotaLimited,
          partialUpstreamCoverage,
          blocked: state === "action_required" || selectedRangeVerificationState === "blocked",
          repairRequired: selectedRangeVerificationState === "repair_required",
          summary:
            rebuildState === "repair_required"
              ? "Meta historical truth needs an authoritative retry before it can be treated as ready."
              : rebuildState === "blocked"
                ? "Meta historical truth is blocked on publication or verification evidence."
                : rebuildState === "quota_limited"
                  ? "Meta rebuild is constrained by provider quota or rate-limit pressure."
                  : rebuildState === "cold_bootstrap"
                    ? "Meta is rebuilding historical truth from provider APIs on a cold warehouse."
                    : rebuildState === "backfill_in_progress"
                      ? "Meta historical truth is still backfilling."
                      : rebuildState === "partial_upstream_coverage"
                        ? "Meta has partial upstream coverage; some surfaces remain incomplete."
                        : "Meta rebuild truth is ready for the current contract. Ready means evidence only and does not auto-enable stronger execution, finalization changes, or retention.",
        },
        protectedPublishedTruth: {
          state: protectedPublishedTruthState,
          hasNonZeroProtectedPublishedRows:
            protectedPublishedTruthReview?.hasNonZeroProtectedPublishedRows ?? false,
          protectedPublishedRows:
            protectedPublishedTruthReview?.protectedPublishedRows ?? 0,
          activePublicationPointerRows:
            protectedPublishedTruthReview?.activePublicationPointerRows ?? 0,
          summary: protectedPublishedTruthSummary,
        },
      },
      assignedAccountIds: accountIds,
      primaryAccountTimezone,
      currentDateInTimezone,
      currentCoreProgressPercent: effectiveCurrentCoreProgressPercent,
      historicalArchiveProgressPercent,
      currentCoreUsable,
      historicalArchiveComplete,
      coreReadiness,
      extendedCompleteness,
      needsBootstrap:
        connected && accountIds.length > 0 && historicalArchiveCompletedDays < historicalTotalDays,
      warehouse: {
        rowCount: accountStats?.row_count ?? 0,
        firstDate: accountStats?.first_date ?? null,
        lastDate: accountStats?.last_date ?? null,
        coverage: {
          historical: {
            completedDays: historicalArchiveCompletedDays,
            totalDays: historicalTotalDays,
            readyThroughDate: historicalArchiveReadyThroughDate,
          },
          selectedRange:
            selectedStartDate && selectedEndDate && selectedRangeTotalDays
              ? {
                  startDate: selectedStartDate,
                  endDate:
                    selectedRangeEffectiveHistoricalEndDate ?? selectedEndDate,
                  completedDays: selectedRangeEffectiveCompletedDays,
                  totalDays: selectedRangeReadyTargetDays,
                  readyThroughDate: selectedRangeCoreReadyThroughDate,
                  isComplete: !selectedRangeIncomplete,
                }
              : null,
          scopes: scopeSummaries,
          accountDaily: {
            completedDays: accountCoverage?.completed_days ?? 0,
            totalDays: historicalTotalDays,
            readyThroughDate: accountCoverage?.ready_through_date ?? null,
          },
          campaignDaily: {
            completedDays: campaignCoverage?.completed_days ?? 0,
            totalDays: historicalTotalDays,
            readyThroughDate: campaignCoverage?.ready_through_date ?? null,
          },
          adsetDaily: {
            completedDays: adsetCoverage?.completed_days ?? 0,
            totalDays: historicalTotalDays,
            readyThroughDate: adsetCoverage?.ready_through_date ?? null,
          },
          breakdowns: {
            completedDays: breakdownCoverageDays,
            totalDays: Math.min(historicalTotalDays, META_BREAKDOWN_MAX_HISTORY_DAYS),
            readyThroughDate: breakdownReadyThroughDate,
          },
          breakdownsBySurface: selectedRangeRequested
            ? selectedRangeBreakdownsBySurface
            : recentBreakdownsBySurface,
          creatives: {
            completedDays: creativeCoverage?.completed_days ?? 0,
            totalDays: creativeHistoricalTotalDays,
            readyThroughDate: creativeCoverage?.ready_through_date ?? null,
            previewReadyRows: creativePreviewCoverage?.preview_ready_rows ?? 0,
            totalRows: creativePreviewCoverage?.total_rows ?? 0,
            previewReadyPercent:
              (creativePreviewCoverage?.total_rows ?? 0) > 0
                ? Math.round(
                    ((creativePreviewCoverage?.preview_ready_rows ?? 0) /
                      (creativePreviewCoverage?.total_rows ?? 1)) *
                      100
                  )
                : 0,
          },
          pendingSurfaces: scopeSummaries
            .filter((summary) => summary.completedDays < summary.totalDays)
            .map((summary) => summary.scope),
        },
      },
      jobHealth: {
        runningJobs: legacyJobHealth?.runningJobs ?? 0,
        staleRunningJobs: legacyJobHealth?.staleRunningJobs ?? 0,
        queueDepth: queueHealth?.queueDepth ?? 0,
        leasedPartitions: queueHealth?.leasedPartitions ?? 0,
        retryableFailedPartitions: queueHealth?.retryableFailedPartitions ?? 0,
        deadLetterPartitions: queueHealth?.deadLetterPartitions ?? 0,
        oldestQueuedPartition: queueHealth?.oldestQueuedPartition ?? null,
        latestCoreActivityAt: queueHealth?.latestCoreActivityAt ?? null,
        latestExtendedActivityAt: queueHealth?.latestExtendedActivityAt ?? null,
        latestMaintenanceActivityAt: queueHealth?.latestMaintenanceActivityAt ?? null,
        historicalCoreQueueDepth: queueHealth?.historicalCoreQueueDepth ?? 0,
        historicalCoreLeasedPartitions: queueHealth?.historicalCoreLeasedPartitions ?? 0,
        extendedRecentQueueDepth: queueHealth?.extendedRecentQueueDepth ?? 0,
        extendedRecentLeasedPartitions: queueHealth?.extendedRecentLeasedPartitions ?? 0,
        extendedHistoricalQueueDepth: queueHealth?.extendedHistoricalQueueDepth ?? 0,
        extendedHistoricalLeasedPartitions: queueHealth?.extendedHistoricalLeasedPartitions ?? 0,
      },
      operations: workerHealth
        ? {
            workerHealthy: workerHealth.workerHealthy,
            heartbeatAgeMs: workerHealth.heartbeatAgeMs,
            runnerLeaseActive: workerHealth.runnerLeaseActive,
            ownerWorkerId: workerHealth.ownerWorkerId,
            consumeStage: workerHealth.consumeStage,
            blockReason: operationsBlockReason,
            progressState: metaProgressState,
            activityState: metaActivityState,
            syncTruthState: unifiedTruth.syncTruthState,
            blockerClass: unifiedTruth.blockerClass === "none" ? null : unifiedTruth.blockerClass,
            progressEvidence: metaProgressEvidence,
            blockingReasons: metaBlockingReasons,
            repairableActions: metaRepairableActions,
            requiredCoverage: metaRequiredCoverage,
            stallFingerprints: metaStallFingerprints,
            providerWorker: {
              workerId: workerHealth.ownerWorkerId ?? null,
              freshnessState: workerHealth.workerFreshnessState ?? null,
              lastHeartbeatAt: workerHealth.lastHeartbeatAt ?? null,
            },
            businessWorker: {
              workerId: workerHealth.matchedWorkerId ?? null,
              freshnessState: workerHealth.workerFreshnessState ?? null,
              lastHeartbeatAt: workerHealth.lastHeartbeatAt ?? null,
              currentBusinessId: workerHealth.currentBusinessId ?? null,
            },
            lagMetrics,
            secondaryReadiness: [
              {
                key: "creatives_preview",
                state:
                  (creativeCoverage?.completed_days ?? 0) < creativeHistoricalTotalDays
                    ? "building"
                    : ((creativePreviewCoverage?.total_rows ?? 0) === 0) ||
                        ((creativePreviewCoverage?.preview_ready_rows ?? 0) >=
                          (creativePreviewCoverage?.total_rows ?? 0))
                      ? "ready"
                      : "building",
                detail:
                  (creativeCoverage?.completed_days ?? 0) < creativeHistoricalTotalDays
                    ? "Creative daily history is still backfilling."
                    : `Creative previews ready: ${creativePreviewCoverage?.preview_ready_rows ?? 0}/${creativePreviewCoverage?.total_rows ?? 0}.`,
              },
            ],
            queueSummary: queueComposition?.summary ?? null,
            retentionRuntimeAvailable: retentionRuntime.runtimeAvailable,
            retentionExecutionEnabled: retentionRuntime.executionEnabled,
            retentionMode: retentionRuntime.mode,
            retentionGateReason: retentionRuntime.gateReason,
            retentionDefaultExecutionDisabled: !retentionRuntime.executionEnabled,
            retentionScopedCommand: `npm run meta:retention-canary -- ${businessId!}`,
            retentionScopedExecuteCommand: `npm run meta:retention-canary -- ${businessId!} --execute`,
            retentionScopedExecuteAllowed:
              retentionCanaryRuntime.executeAllowed,
            retentionScopedGateReason: retentionCanaryRuntime.gateReason,
            latestRetentionRunAt: latestRetentionRun?.finishedAt ?? null,
            latestRetentionRunMode: latestRetentionRun?.executionMode ?? null,
            latestRetentionRunDisposition:
              latestRetentionMetadata.executionDisposition,
            latestRetentionScopedRunAt:
              latestRetentionCanaryRun?.finishedAt ?? null,
            latestRetentionScopedRunMode:
              latestRetentionCanaryRun?.executionMode ?? null,
            latestRetentionScopedRunDisposition:
              latestRetentionCanaryMetadata.executionDisposition,
            retentionLatestRunObserved:
              latestRetentionSummary != null
                ? latestRetentionSummary.observedTables > 0
                : false,
            retentionLatestScopedObserved:
              latestRetentionCanarySummary != null
                ? latestRetentionCanarySummary.observedTables > 0
                : false,
          }
        : null,
      retention: {
        runtimeAvailable: retentionRuntime.runtimeAvailable,
        executionEnabled: retentionRuntime.executionEnabled,
        defaultExecutionDisabled: !retentionRuntime.executionEnabled,
        mode: retentionRuntime.mode,
        gateReason: retentionRuntime.gateReason,
        policy: {
          coreDailyAuthoritativeDays: META_AUTHORITATIVE_HISTORY_DAYS,
          breakdownDailyAuthoritativeDays:
            META_BREAKDOWN_AUTHORITATIVE_HISTORY_DAYS,
          currentDay: "live_only",
          historicalInsideHorizon: "published_verified_truth_only",
          historicalOutsideCoreHorizon: "live_fallback_unchanged",
          breakdownOutsideHorizon: "unsupported_degraded",
        },
        latestRun: latestRetentionRun
          ? {
              id: latestRetentionRun.id,
              finishedAt: latestRetentionRun.finishedAt,
              executionMode: latestRetentionRun.executionMode,
              executionDisposition: latestRetentionMetadata.executionDisposition,
              scope: latestRetentionMetadata.scope,
              skippedDueToActiveLease:
                latestRetentionRun.skippedDueToActiveLease,
              totalDeletedRows: latestRetentionRun.totalDeletedRows,
              errorMessage: latestRetentionRun.errorMessage,
            }
          : null,
        summary: latestRetentionSummary,
        tables: latestRetentionTables,
        scopedExecution: {
          available: true,
          businessId: businessId!,
          command: `npm run meta:retention-canary -- ${businessId!}`,
          executeCommand: `npm run meta:retention-canary -- ${businessId!} --execute`,
          globalDefaultExecutionDisabled: !retentionRuntime.executionEnabled,
          globalExecutionEnabled: retentionCanaryRuntime.globalExecutionEnabled,
          executeAllowed: retentionCanaryRuntime.executeAllowed,
          gateReason: retentionCanaryRuntime.gateReason,
          latestRun: latestRetentionCanaryRun
            ? {
                id: latestRetentionCanaryRun.id,
                finishedAt: latestRetentionCanaryRun.finishedAt,
                executionMode: latestRetentionCanaryRun.executionMode,
                executionDisposition:
                  latestRetentionCanaryMetadata.executionDisposition,
                scope: latestRetentionCanaryMetadata.scope,
                skippedDueToActiveLease:
                  latestRetentionCanaryRun.skippedDueToActiveLease,
                totalDeletedRows: latestRetentionCanaryRun.totalDeletedRows,
                errorMessage: latestRetentionCanaryRun.errorMessage,
                scopedExecution: latestRetentionCanaryMetadata.canary,
              }
            : null,
          summary: latestRetentionCanarySummary,
          tables: latestRetentionCanaryTables,
        },
      },
      protectedPublishedTruth: {
        state: protectedPublishedTruthState,
        runtimeAvailable: protectedPublishedTruthReview?.runtimeAvailable ?? false,
        asOfDate: protectedPublishedTruthReview?.asOfDate ?? null,
        hasNonZeroProtectedPublishedRows:
          protectedPublishedTruthReview?.hasNonZeroProtectedPublishedRows ?? false,
        protectedPublishedRows:
          protectedPublishedTruthReview?.protectedPublishedRows ?? 0,
        activePublicationPointerRows:
          protectedPublishedTruthReview?.activePublicationPointerRows ?? 0,
        protectedTruthClassesPresent:
          protectedPublishedTruthReview?.protectedTruthClassesPresent ?? [],
        protectedTruthClassesAbsent:
          protectedPublishedTruthReview?.protectedTruthClassesAbsent ?? [],
        summary: protectedPublishedTruthSummary,
        classes: protectedPublishedTruthReview?.classes ?? [],
      },
      extendedRecoveryState,
      recentExtendedReady,
      historicalExtendedReady,
      recentExtendedUsable: recentExtendedReady,
      rangeCompletionBySurface,
      currentDayLive,
      pageReadiness,
      priorityWindow:
        selectedStartDate && selectedEndDate && selectedRangeTotalDays
          ? {
              startDate: selectedStartDate,
              endDate:
                selectedRangeNeedsCurrentDayFallback
                  ? selectedRangeEffectiveHistoricalEndDate ?? selectedEndDate
                  : selectedRangeTruthEndDate ?? selectedEndDate,
              completedDays: selectedRangeEffectiveCompletedDays,
              totalDays: selectedRangeReadyTargetDays,
              isActive: Boolean(selectedRangeIncomplete) && (queueHealth?.leasedPartitions ?? 0) > 0,
            }
          : null,
      selectedRangeTruth,
      latestSync: latestSync
        ? {
            id: latestSync.id ? String(latestSync.id) : null,
            status: latestSync.status ? String(latestSync.status) : undefined,
            syncType: latestSync.sync_type ? String(latestSync.sync_type) : null,
            scope: latestSync.scope ? String(latestSync.scope) : null,
            startDate: latestSync.start_date ? String(latestSync.start_date).slice(0, 10) : null,
            endDate: latestSync.end_date ? String(latestSync.end_date).slice(0, 10) : null,
            triggerSource: latestSync.trigger_source ? String(latestSync.trigger_source) : null,
            triggeredAt: latestSync.triggered_at ? String(latestSync.triggered_at) : null,
            startedAt: latestSync.started_at ? String(latestSync.started_at) : null,
            finishedAt: latestSync.finished_at ? String(latestSync.finished_at) : null,
            lastError: latestSync.last_error ? String(latestSync.last_error) : null,
            progressPercent: responseProgressPercent,
            completedDays: responseCompletedDays,
            totalDays: responseTotalDays,
            readyThroughDate: responseReadyThroughDate,
            phaseLabel: phaseLabel === "Ready" ? null : phaseLabel,
          }
        : {
            progressPercent: responseProgressPercent,
            completedDays: responseCompletedDays,
            totalDays: responseTotalDays,
            readyThroughDate: responseReadyThroughDate,
            phaseLabel: phaseLabel === "Ready" ? null : phaseLabel,
      },
  };

  const integrationSummaryInput: Parameters<typeof buildMetaIntegrationSummary>[0] = {
    state,
    connected,
    controlPlanePersistence,
    releaseGate: gateRecords?.releaseGate ?? null,
    repairPlan,
    blockerClass: response.blockerClass,
    syncTruthState: response.syncTruthState,
    assignedAccountIds: response.assignedAccountIds,
    primaryAccountTimezone,
    latestSync: response.latestSync,
    warehouse: response.warehouse,
    jobHealth: response.jobHealth,
    operations: response.operations as MetaStatusResponse["operations"],
    coreReadiness,
    extendedCompleteness,
    priorityWindow: response.priorityWindow,
    selectedRangeTruth,
    pageReadiness,
    recentExtendedReady,
    historicalExtendedReady,
    rangeCompletionBySurface,
    d1FinalizeState,
  };

  const userVisibleSyncState = deriveMetaUserVisibleSyncState(
    response as MetaStatusResponse,
  );

  return {
    ...response,
    userVisibleSyncState,
    operationalSyncState: deriveOperationalSyncState({
      releaseGateVerdict: response.releaseGate?.verdict ?? null,
      incidentSummary,
      recommendationCount: response.repairPlan?.recommendations.length ?? 0,
    }),
    degradedServing: incidentSummary?.degradedServing ?? userVisibleSyncState.degradedServing,
    openIncidents: incidentSummary?.openCount ?? response.repairPlan?.recommendations.length ?? 0,
    integrationSummary: buildMetaIntegrationSummary(integrationSummaryInput),
  };
  };

  const payload = shouldBypassMetaStatusCache()
    ? await buildResponse()
    : await readThroughCache({
        key: buildMetaStatusCacheKey({
          buildId: runtimeContract.buildId,
          businessId: businessId!,
          startDate: selectedStartDate,
          endDate: selectedEndDate,
          diagnostics: includeDiagnostics,
        }),
        ttlMs: META_STATUS_CACHE_TTL_MS,
        loader: buildResponse,
      });

  return NextResponse.json(payload, { headers: { "Cache-Control": "no-store" } });
}
