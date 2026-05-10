import { resolveSyncControlPlaneKey } from "@/lib/sync/control-plane-key";
import type { GoogleAdsSyncStateRecord } from "@/lib/google-ads/warehouse-types";

const GOOGLE_ADS_CONTROL_PLANE_SCOPES = [
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

const GOOGLE_ADS_CORE_RELEASE_SCOPES = new Set(["account_daily", "campaign_daily"]);

function isGoogleAdsCoreReleaseScope(scope: unknown) {
  return GOOGLE_ADS_CORE_RELEASE_SCOPES.has(String(scope ?? ""));
}

export type GoogleAdsControlPlaneBusiness = {
  businessId: string;
  businessName: string | null;
  assignedAccountCount: number;
  backfillIncomplete?: boolean;
  incompleteScopeCount?: number;
  latestSuccessfulSyncAt?: string | null;
};

export function resolveGoogleAdsControlPlaneSyncTruth(input: {
  latestSyncStatus?: string | null;
  latestSyncScope?: string | null;
  queueDepth: number;
  deadLetterPartitions: number;
  scopeStates: GoogleAdsSyncStateRecord[];
  recentWindowMinutes?: number;
  nowMs?: number;
}) {
  const recentWindowMinutes = Math.max(1, input.recentWindowMinutes ?? 20);
  const nowMs = input.nowMs ?? Date.now();
  const latestSuccessfulScopeSyncAt =
    input.scopeStates
      .map((row) => row.latestSuccessfulSyncAt)
      .filter((value): value is string => Boolean(value))
      .map((value) => Date.parse(value))
      .filter((value) => Number.isFinite(value))
      .sort((a, b) => b - a)[0] ?? null;
  const hasRecentSuccessfulScopeSync =
    latestSuccessfulScopeSyncAt != null &&
    nowMs - latestSuccessfulScopeSyncAt <= recentWindowMinutes * 60_000;
  const coreServingReady = ["account_daily", "campaign_daily"].every((scope) =>
    input.scopeStates.some(
      (row) =>
        row.scope === scope &&
        (row.completedDays ?? 0) > 0 &&
        Boolean(row.latestSuccessfulSyncAt),
    ),
  );
  const latestFailedBlocksCore =
    input.latestSyncStatus === "failed" &&
    (input.latestSyncScope == null ||
      isGoogleAdsCoreReleaseScope(input.latestSyncScope));
  const releaseLatestSyncStatus =
    input.latestSyncStatus === "failed" && !latestFailedBlocksCore
      ? null
      : input.latestSyncStatus;
  const effectiveLatestSyncStatus =
    latestFailedBlocksCore
      ? "failed"
      : input.queueDepth === 0 &&
          input.deadLetterPartitions === 0 &&
          hasRecentSuccessfulScopeSync
        ? "succeeded"
        : releaseLatestSyncStatus ?? null;

  return {
    effectiveLatestSyncStatus,
    hasRecentSuccessfulScopeSync,
    coreServingReady,
    servingReady:
      input.deadLetterPartitions === 0 &&
      effectiveLatestSyncStatus !== "failed" &&
      coreServingReady,
    fullyReady:
      input.queueDepth === 0 &&
      input.deadLetterPartitions === 0 &&
      effectiveLatestSyncStatus !== "failed" &&
      (effectiveLatestSyncStatus === "succeeded" ||
        hasRecentSuccessfulScopeSync ||
        coreServingReady),
  };
}

export async function readConnectedGoogleAdsControlPlaneBusinesses() {
  const { getDb } = await import("@/lib/db");
  const sql = getDb();
  const rows = await sql`
    SELECT
      bpa.business_id,
      business.name AS business_name,
      COUNT(*)::int AS assigned_account_count,
      COALESCE(sync_state.incomplete_scope_count, 1)::int AS incomplete_scope_count,
      sync_state.latest_successful_sync_at
    FROM business_provider_accounts bpa
    INNER JOIN provider_connections connection
      ON connection.business_id = bpa.business_id
     AND connection.provider = bpa.provider
     AND connection.status = 'connected'
    LEFT JOIN businesses business
      ON business.id::text = bpa.business_id
    LEFT JOIN (
      SELECT
        business_id,
        (COUNT(*) FILTER (
          WHERE completed_days < GREATEST(1, (effective_target_end - effective_target_start + 1))
        ))::int AS incomplete_scope_count,
        MAX(latest_successful_sync_at)::text AS latest_successful_sync_at
      FROM google_ads_sync_state
      GROUP BY business_id
    ) sync_state
      ON sync_state.business_id = bpa.business_id
    WHERE bpa.provider = 'google'
    GROUP BY
      bpa.business_id,
      business.name,
      sync_state.incomplete_scope_count,
      sync_state.latest_successful_sync_at
    ORDER BY
      (COALESCE(sync_state.incomplete_scope_count, 1) > 0) DESC,
      sync_state.latest_successful_sync_at NULLS FIRST,
      business.name NULLS LAST,
      bpa.business_id
  ` as Array<Record<string, unknown>>;

  return rows.map((row) => ({
    businessId: String(row.business_id),
    businessName:
      typeof row.business_name === "string" && row.business_name.trim().length > 0
        ? row.business_name.trim()
        : null,
    assignedAccountCount: Number(row.assigned_account_count ?? 0),
    incompleteScopeCount: Number(row.incomplete_scope_count ?? 0),
    backfillIncomplete: Number(row.incomplete_scope_count ?? 0) > 0,
    latestSuccessfulSyncAt:
      typeof row.latest_successful_sync_at === "string"
        ? row.latest_successful_sync_at
        : null,
  })) satisfies GoogleAdsControlPlaneBusiness[];
}

export async function buildGoogleAdsReleaseGateCanaries(
  businesses: GoogleAdsControlPlaneBusiness[],
) {
  const {
    getGoogleAdsCheckpointHealth,
    getGoogleAdsQueueHealth,
    getGoogleAdsSyncState,
    getLatestGoogleAdsSyncHealth,
  } = await import("@/lib/google-ads/warehouse");
  const { getGoogleAdsWorkerSchedulingState } = await import("@/lib/sync/google-ads-sync");
  const {
    buildProviderProgressEvidence,
    deriveProviderActivityState,
    deriveProviderProgressState,
    deriveProviderStallFingerprints,
    deriveUnifiedSyncTruth,
  } = await import("@/lib/sync/provider-status-truth");
  const {
    buildGoogleAdsReleaseReadinessCandidate,
  } = await import("@/lib/google-ads/control-plane");

  return Promise.all(
    businesses.map(async (business) => {
      const [queueHealth, checkpointHealth, latestSyncHealth, workerState, ...scopeStates] =
        await Promise.all([
          getGoogleAdsQueueHealth({
            businessId: business.businessId,
          }),
          getGoogleAdsCheckpointHealth({
            businessId: business.businessId,
            providerAccountId: null,
          }).catch(() => null),
          getLatestGoogleAdsSyncHealth({
            businessId: business.businessId,
            providerAccountId: null,
          }).catch(() => null),
          getGoogleAdsWorkerSchedulingState({
            businessId: business.businessId,
          }).catch(() => null),
          ...GOOGLE_ADS_CONTROL_PLANE_SCOPES.map((scope) =>
            getGoogleAdsSyncState({
              businessId: business.businessId,
              scope,
            }).catch(() => []),
          ),
        ]);

      const latestGoogleActivityAt =
        queueHealth.latestCoreActivityAt ??
        queueHealth.latestExtendedActivityAt ??
        queueHealth.latestMaintenanceActivityAt ??
        null;
      const flattenedScopeStates = scopeStates.flatMap((rows) => rows);
      const progressEvidence = buildProviderProgressEvidence({
        states: flattenedScopeStates,
        checkpointUpdatedAt: checkpointHealth?.latestCheckpointUpdatedAt ?? null,
        recentActivityWindowMinutes: 20,
        aggregation: "latest",
      });
      const latestSyncStatus =
        latestSyncHealth?.status != null ? String(latestSyncHealth.status) : null;
      const latestSyncScope =
        typeof latestSyncHealth?.scope === "string"
          ? latestSyncHealth.scope
          : null;
      const totalQueueDepth = queueHealth.queueDepth;
      const releaseQueueDepth = queueHealth.coreQueueDepth;
      const releaseLeasedPartitions = queueHealth.coreLeasedPartitions;
      const blockingDeadLetterPartitions =
        queueHealth.coreBlockingDeadLetterPartitions ??
        queueHealth.blockingDeadLetterPartitions ??
        queueHealth.deadLetterPartitions;
      const controlPlaneSyncTruth = resolveGoogleAdsControlPlaneSyncTruth({
        latestSyncStatus,
        latestSyncScope,
        queueDepth: releaseQueueDepth,
        deadLetterPartitions: blockingDeadLetterPartitions,
        scopeStates: flattenedScopeStates,
      });
      const blocked =
        blockingDeadLetterPartitions > 0 ||
        controlPlaneSyncTruth.effectiveLatestSyncStatus === "failed";
      const progressState = deriveProviderProgressState({
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        checkpointLagMinutes:
          controlPlaneSyncTruth.hasRecentSuccessfulScopeSync
            ? null
            : checkpointHealth?.checkpointLagMinutes ?? null,
        latestPartitionActivityAt: latestGoogleActivityAt,
        blocked,
        fullyReady: controlPlaneSyncTruth.fullyReady,
        staleRunPressure: 0,
        progressEvidence,
      });
      const activityState = deriveProviderActivityState({
        progressState,
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        blocked,
      });
      const stallFingerprints = deriveProviderStallFingerprints({
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        checkpointLagMinutes: checkpointHealth?.checkpointLagMinutes ?? null,
        latestPartitionActivityAt: latestGoogleActivityAt,
        blocked,
        staleRunPressure: 0,
        progressEvidence,
        blockedReasonCodes: blockingDeadLetterPartitions > 0
          ? ["required_dead_letter_partitions"]
          : controlPlaneSyncTruth.effectiveLatestSyncStatus === "failed"
            ? ["latest_sync_failed"]
            : [],
        historicalBacklogDepth:
          queueHealth.extendedHistoricalQueueDepth +
          queueHealth.extendedHistoricalLeasedPartitions,
      });
      const unifiedTruth = deriveUnifiedSyncTruth({
        activityState,
        progressState,
        workerOnline: workerState?.healthy ?? null,
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
      });
      const candidate = buildGoogleAdsReleaseReadinessCandidate({
        connected: true,
        assignedAccountCount: business.assignedAccountCount,
        activityState,
        progressState,
        workerOnline: workerState?.healthy ?? null,
        queueDepth: releaseQueueDepth,
        leasedPartitions: releaseLeasedPartitions,
        retryableFailedPartitions: 0,
        deadLetterPartitions: blockingDeadLetterPartitions,
        staleLeasePartitions: 0,
        syncTruthState: unifiedTruth.syncTruthState,
        truthReady: controlPlaneSyncTruth.servingReady,
        stallFingerprints,
      });

      return {
        businessId: business.businessId,
        businessName: business.businessName,
        pass: candidate?.pass ?? false,
        blockerClass: candidate?.blockerClass ?? "not_release_ready",
        evidence: {
          ...(candidate?.evidence ?? {}),
          totalDeadLetterPartitions: queueHealth.deadLetterPartitions,
          totalQueueDepth,
          nonBlockingQueueDepth: Math.max(0, totalQueueDepth - releaseQueueDepth),
          releaseBlockingQueueDepth: releaseQueueDepth,
          coreQueueDepth: queueHealth.coreQueueDepth,
          extendedQueueDepth: queueHealth.extendedQueueDepth,
          maintenanceQueueDepth: queueHealth.maintenanceQueueDepth,
          coreBlockingDeadLetterPartitions:
            queueHealth.coreBlockingDeadLetterPartitions ?? 0,
          quarantinedHistoricalDeadLetterPartitions:
            queueHealth.quarantinedHistoricalDeadLetterPartitions ?? 0,
          actionRequiredDeadLetterPartitions:
            queueHealth.actionRequiredBlockingDeadLetterPartitions ?? 0,
          totalActionRequiredDeadLetterPartitions:
            queueHealth.actionRequiredDeadLetterPartitions ?? 0,
          coreActionRequiredDeadLetterPartitions:
            queueHealth.coreActionRequiredBlockingDeadLetterPartitions ?? 0,
          actionRequiredDeadLetterScopes:
            queueHealth.actionRequiredBlockingDeadLetterScopes ?? [],
          replayableDeadLetterPartitions:
            queueHealth.replayableBlockingDeadLetterPartitions ?? 0,
          unknownDeadLetterPartitions:
            queueHealth.unknownBlockingDeadLetterPartitions ?? 0,
          latestSyncStatus: controlPlaneSyncTruth.effectiveLatestSyncStatus,
        },
      };
    }),
  );
}

export async function evaluateAndPersistGoogleAdsControlPlane(input?: {
  buildId?: string;
  environment?: string;
  breakGlass?: boolean;
  overrideReason?: string | null;
}) {
  const identity = resolveSyncControlPlaneKey({
    buildId: input?.buildId,
    environment: input?.environment,
    providerScope: "google_ads",
  });
  const { evaluateDeployGate, upsertSyncGateRecord } = await import("@/lib/sync/release-gates");
  const { buildGoogleAdsReleaseGateRecord } = await import("@/lib/google-ads/control-plane");

  return {
    identity,
    checkedAt: new Date().toISOString(),
    deployGate: await evaluateDeployGate({
      buildId: identity.buildId,
      environment: identity.environment,
      breakGlass: input?.breakGlass,
      overrideReason: input?.overrideReason ?? null,
      persist: true,
    }),
    releaseGate: await upsertSyncGateRecord(
      buildGoogleAdsReleaseGateRecord({
        buildId: identity.buildId,
        environment: identity.environment,
        canaries: await buildGoogleAdsReleaseGateCanaries(
          await readConnectedGoogleAdsControlPlaneBusinesses(),
        ),
        breakGlass: input?.breakGlass,
        overrideReason: input?.overrideReason ?? null,
      }),
    ),
  };
}
