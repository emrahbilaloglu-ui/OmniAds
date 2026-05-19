import { getDb } from "@/lib/db";
import {
  classifyGoogleAdsQueuedCampaignDailyPartition,
  decideGoogleAdsHistoricalFrontier,
  getGoogleAdsFullSyncPriorityState,
  getGoogleAdsIncidentPolicy,
  getGoogleAdsRecent90CompletionState,
  getGoogleAdsWorkerSchedulingState,
} from "@/lib/sync/google-ads-sync";
import { getGoogleAdsQueueHealth } from "@/lib/google-ads/warehouse";
import { configureOperationalScriptRuntime } from "./_operational-runtime";

type LeaseEligibilityClassification =
  | "leaseable_now"
  | "suspended_maintenance"
  | "outside_frontier"
  | "retry_cooldown"
  | "action_required_excluded";

function toIso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : text;
}

async function withStartupLogsSilenced<T>(callback: () => Promise<T>) {
  const originalInfo = console.info;
  console.info = (...args: unknown[]) => {
    if (typeof args[0] === "string" && args[0].startsWith("[startup]")) {
      return;
    }
    originalInfo(...args);
  };
  try {
    return await callback();
  } finally {
    console.info = originalInfo;
  }
}

async function main() {
  configureOperationalScriptRuntime();
  const businessId = process.argv[2];
  if (!businessId) {
    console.error(
      "usage: node --import tsx scripts/google-ads-lease-eligibility-diagnostic.ts <businessId>",
    );
    process.exit(1);
  }

  await withStartupLogsSilenced(async () => {
    const sql = getDb();
    const [
      queuedRowsResult,
      queueHealth,
      fullSyncPriority,
      recent90State,
      workerState,
    ] = await Promise.all([
      sql.query(
        `
          SELECT
            scope,
            lane,
            source,
            partition_date,
            priority,
            provider_account_id,
            attempt_count,
            next_retry_at,
            created_at,
            updated_at
          FROM google_ads_sync_partitions
          WHERE business_id = $1
            AND status = 'queued'
          ORDER BY scope ASC, lane ASC, source ASC, partition_date DESC, updated_at ASC
        `,
        [businessId],
      ),
      getGoogleAdsQueueHealth({ businessId }).catch(() => null),
      getGoogleAdsFullSyncPriorityState({ businessId }).catch(() => null),
      getGoogleAdsRecent90CompletionState({ businessId }).catch(() => null),
      getGoogleAdsWorkerSchedulingState({ businessId }).catch(() => null),
    ]);
    const queuedRows = queuedRowsResult as Array<Record<string, unknown>>;

    const incidentPolicy = await getGoogleAdsIncidentPolicy({
      businessId,
      queueHealth,
    }).catch(() => null);
    const frontierStart =
      fullSyncPriority?.historicalStart && recent90State?.recent90Start
        ? decideGoogleAdsHistoricalFrontier({
            historicalStart: fullSyncPriority.historicalStart,
            recent90Start: recent90State.recent90Start,
            recent90Complete: recent90State.complete,
          })
        : (fullSyncPriority?.historicalStart ?? null);

    const actionRequiredExcludedScopeSet = new Set<string>(
      [
        ...(queueHealth?.actionRequiredBlockingDeadLetterScopes ?? []),
        ...(queueHealth?.actionRequiredDeadLetterScopes ?? []),
      ].map(String),
    );
    const classifiedRows = queuedRows.map((row: Record<string, unknown>) => {
      const baseClassification = classifyGoogleAdsQueuedCampaignDailyPartition({
        row: {
          lane: String(row.lane) as "core" | "maintenance" | "extended",
          partitionDate: toIso(row.partition_date)?.slice(0, 10) ?? null,
          nextRetryAt: toIso(row.next_retry_at),
        },
        frontierStart,
        suspendMaintenance: Boolean(incidentPolicy?.suspendMaintenance),
      });
      const classification: LeaseEligibilityClassification = actionRequiredExcludedScopeSet.has(String(row.scope))
        ? "action_required_excluded"
        : baseClassification;

      return {
        scope: String(row.scope),
        lane: String(row.lane),
        source: String(row.source),
        partitionDate: toIso(row.partition_date)?.slice(0, 10) ?? null,
        priority: Number(row.priority ?? 0),
        providerAccountId: String(row.provider_account_id),
        attemptCount: Number(row.attempt_count ?? 0),
        nextRetryAt: toIso(row.next_retry_at),
        createdAt: toIso(row.created_at),
        updatedAt: toIso(row.updated_at),
        classification,
      };
    });

    const byScope = classifiedRows.reduce<Record<string, {
      totalQueued: number;
      leaseable_now: number;
      suspended_maintenance: number;
      outside_frontier: number;
      retry_cooldown: number;
      action_required_excluded: number;
    }>>((accumulator, row) => {
      const bucket = accumulator[row.scope] ?? {
        totalQueued: 0,
        leaseable_now: 0,
        suspended_maintenance: 0,
        outside_frontier: 0,
        retry_cooldown: 0,
        action_required_excluded: 0,
      };
      bucket.totalQueued += 1;
      bucket[row.classification] += 1;
      accumulator[row.scope] = bucket;
      return accumulator;
    }, {});

    const summary = {
      totalQueued: classifiedRows.length,
      totalQueuedCampaignDaily: classifiedRows.filter(
        (row) => row.scope === "campaign_daily",
      ).length,
      coreQueueDepth: classifiedRows.filter(
        (row: (typeof classifiedRows)[number]) => row.lane === "core",
      ).length,
      maintenanceQueueDepth: classifiedRows.filter(
        (row: (typeof classifiedRows)[number]) => row.lane === "maintenance",
      ).length,
      leaseable_now: classifiedRows.filter(
        (row: (typeof classifiedRows)[number]) =>
          row.classification === "leaseable_now",
      ).length,
      suspended_maintenance: classifiedRows.filter(
        (row: (typeof classifiedRows)[number]) =>
          row.classification === "suspended_maintenance",
      ).length,
      outside_frontier: classifiedRows.filter(
        (row: (typeof classifiedRows)[number]) =>
          row.classification === "outside_frontier",
      ).length,
      retry_cooldown: classifiedRows.filter(
        (row: (typeof classifiedRows)[number]) =>
          row.classification === "retry_cooldown",
      ).length,
      action_required_excluded: classifiedRows.filter(
        (row: (typeof classifiedRows)[number]) =>
          row.classification === "action_required_excluded",
      ).length,
      byScope,
    };

    console.log(
      JSON.stringify(
        {
          businessId,
          frontierStart,
          leaseableBacklogBreakdown: {
            summary,
            rows: classifiedRows,
          },
          queueHealth,
          fullSyncPriority,
          recent90State,
          workerSchedulingState: workerState,
          incidentPolicy,
        },
        null,
        2,
      ),
    );
  });
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
