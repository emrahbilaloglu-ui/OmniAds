import { writeFile } from "node:fs/promises";
import { getDb } from "@/lib/db";
import { getProviderAccountAssignments } from "@/lib/provider-account-assignments";
import { readProviderAccountSnapshot } from "@/lib/provider-account-snapshots";
import {
  classifyGoogleAdsQueuedCampaignDailyPartition,
  decideGoogleAdsHistoricalFrontier,
  getGoogleAdsFullSyncPriorityState,
  getGoogleAdsIncidentPolicy,
  getGoogleAdsRecent90CompletionState,
} from "@/lib/sync/google-ads-sync";
import { getGoogleAdsQueueHealth } from "@/lib/google-ads/warehouse";
import {
  configureOperationalScriptRuntime,
  runOperationalMigrationsIfEnabled,
} from "./_operational-runtime";

type ParsedArgs = {
  businessId: string | null;
  outPath: string | null;
};

function parseArgs(argv: string[]): ParsedArgs {
  let businessId: string | null = null;
  let outPath: string | null = null;

  for (let index = 0; index < argv.length; index += 1) {
    const current = argv[index];
    if ((current === "--business" || current === "-b") && argv[index + 1]) {
      businessId = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if ((current === "--out" || current === "-o") && argv[index + 1]) {
      outPath = argv[index + 1] ?? null;
      index += 1;
      continue;
    }
    if (!current?.startsWith("-") && !businessId) {
      businessId = current;
    }
  }

  return {
    businessId,
    outPath,
  };
}

function toIso(value: unknown) {
  if (!value) return null;
  if (value instanceof Date) return value.toISOString();
  const text = String(value).trim();
  const parsed = new Date(text);
  return Number.isFinite(parsed.getTime()) ? parsed.toISOString() : text;
}

function toNumber(value: unknown) {
  const parsed = typeof value === "number" ? value : Number(value ?? 0);
  return Number.isFinite(parsed) ? parsed : 0;
}

function minutesSince(value: unknown) {
  const iso = toIso(value);
  if (!iso) return null;
  const ms = new Date(iso).getTime();
  if (!Number.isFinite(ms)) return null;
  return Math.round(((Date.now() - ms) / 60_000) * 100) / 100;
}

type LeaseableBreakdownRow = {
  businessId: string;
  businessName: string;
  scope: string;
  lane: string;
  source: string;
  partitionDate: string | null;
  priority: number;
  attemptCount: number;
  nextRetryAt: string | null;
  classification:
    | "leaseable_now"
    | "suspended_maintenance"
    | "outside_frontier"
    | "retry_cooldown"
    | "action_required_excluded";
};

function buildLeaseableBacklogSummary(
  businessId: string,
  businessName: string,
  rows: LeaseableBreakdownRow[],
) {
  return {
    businessId,
    businessName,
    totalQueued: rows.length,
    totalQueuedCampaignDaily: rows.filter((row) => row.scope === "campaign_daily")
      .length,
    coreQueueDepth: rows.filter((row) => row.lane === "core").length,
    maintenanceQueueDepth: rows.filter((row) => row.lane === "maintenance")
      .length,
    leaseable_now: rows.filter((row) => row.classification === "leaseable_now")
      .length,
    suspended_maintenance: rows.filter(
      (row) => row.classification === "suspended_maintenance",
    ).length,
    outside_frontier: rows.filter(
      (row) => row.classification === "outside_frontier",
    ).length,
    retry_cooldown: rows.filter(
      (row) => row.classification === "retry_cooldown",
    ).length,
    action_required_excluded: rows.filter(
      (row) => row.classification === "action_required_excluded",
    ).length,
    byScope: rows.reduce<Record<string, {
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
    }, {}),
  };
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

async function collectTargetAccounts(input: {
  businessId: string;
  stateRows: Array<{
    provider_account_id: string;
    last_successful_sync_at: string | null;
  }>;
}) {
  const assignment = await getProviderAccountAssignments(
    input.businessId,
    "google",
  );
  const snapshot = await readProviderAccountSnapshot({
    businessId: input.businessId,
    provider: "google",
  }).catch(() => null);

  const accounts = new Map<
    string,
    {
      accountId: string;
      sources: string[];
      lastSuccessfulSyncAt: string | null;
      snapshotName: string | null;
    }
  >();

  for (const accountId of assignment?.account_ids ?? []) {
    accounts.set(accountId, {
      accountId,
      sources: ["assignment"],
      lastSuccessfulSyncAt: null,
      snapshotName: null,
    });
  }

  for (const row of input.stateRows) {
    const existing = accounts.get(row.provider_account_id);
    accounts.set(row.provider_account_id, {
      accountId: row.provider_account_id,
      sources: existing
        ? Array.from(new Set([...existing.sources, "sync_state"]))
        : ["sync_state"],
      lastSuccessfulSyncAt: toIso(row.last_successful_sync_at),
      snapshotName: existing?.snapshotName ?? null,
    });
  }

  for (const account of snapshot?.accounts ?? []) {
    if (!account.id?.trim()) continue;
    if (account.isManager) continue;
    const existing = accounts.get(account.id);
    accounts.set(account.id, {
      accountId: account.id,
      sources: existing
        ? Array.from(new Set([...existing.sources, "provider_snapshot"]))
        : ["provider_snapshot"],
      lastSuccessfulSyncAt: existing?.lastSuccessfulSyncAt ?? null,
      snapshotName: account.name ?? existing?.snapshotName ?? null,
    });
  }

  return Array.from(accounts.values()).sort((left, right) =>
    left.accountId.localeCompare(right.accountId),
  );
}

async function main() {
  const runtime = configureOperationalScriptRuntime();
  const args = parseArgs(process.argv.slice(2));

  const payload = await withStartupLogsSilenced(async () => {
    await runOperationalMigrationsIfEnabled(runtime);
    const sql = getDb();

    const businessFilter = args.businessId ?? null;

    const [
      businessRows,
      integrationRows,
      stateRows,
      partitionStateRows,
      stalePartitionRows,
      checkpointStateRows,
      staleCheckpointRows,
      deadLetterRows,
      workerRows,
      workerStatusRows,
      recentErrorRows,
      runningUnderTerminalRows,
      duplicateRunningRows,
      staleRunningRows,
      terminalParentCheckpointRows,
      recentSignalRows,
      throughputRows,
      slowBusinessRows,
      queuedCampaignDailyRows,
    ] = (await Promise.all([
      sql`
      SELECT id::text AS business_id, name AS business_name
      FROM businesses
      WHERE (${businessFilter}::text IS NULL OR id::text = ${businessFilter})
      ORDER BY name
    `,
      sql`
      SELECT DISTINCT ON (integration.business_id)
        integration.business_id,
        business.name AS business_name,
        integration.status,
        integration.updated_at
      FROM provider_connections integration
      JOIN businesses business
        ON business.id::text = integration.business_id
      WHERE integration.provider = 'google'
        AND (${businessFilter}::text IS NULL OR integration.business_id = ${businessFilter})
      ORDER BY integration.business_id, integration.updated_at DESC
    `,
      sql`
      SELECT
        business_id,
        provider_account_id,
        MAX(latest_successful_sync_at) AS last_successful_sync_at
      FROM google_ads_sync_state
      WHERE (${businessFilter}::text IS NULL OR business_id = ${businessFilter})
      GROUP BY business_id, provider_account_id
      ORDER BY business_id, provider_account_id
    `,
      sql`
      SELECT
        partition.business_id,
        business.name AS business_name,
        partition.scope,
        COUNT(*) FILTER (WHERE partition.status = 'queued')::int AS queued,
        COUNT(*) FILTER (WHERE partition.status = 'leased')::int AS leased,
        COUNT(*) FILTER (WHERE partition.status = 'running')::int AS running,
        COUNT(*) FILTER (WHERE partition.status = 'succeeded')::int AS succeeded,
        COUNT(*) FILTER (WHERE partition.status = 'failed')::int AS failed,
        COUNT(*) FILTER (WHERE partition.status = 'dead_letter')::int AS dead_letter,
        COUNT(*) FILTER (WHERE partition.status = 'cancelled')::int AS cancelled
      FROM google_ads_sync_partitions partition
      JOIN businesses business
        ON business.id::text = partition.business_id
      WHERE (${businessFilter}::text IS NULL OR partition.business_id = ${businessFilter})
      GROUP BY partition.business_id, business.name, partition.scope
      ORDER BY business.name, partition.scope
    `,
      sql`
      SELECT
        partition.id::text AS partition_id,
        partition.scope,
        partition.business_id,
        business.name AS business_name,
        partition.started_at,
        partition.updated_at,
        COALESCE(partition.lease_epoch, 0) AS lease_epoch,
        ROUND(EXTRACT(EPOCH FROM (now() - partition.updated_at)) / 60.0, 2) AS minutes_since_updated,
        partition.lease_owner,
        partition.lease_expires_at,
        partition.attempt_count
      FROM google_ads_sync_partitions partition
      JOIN businesses business
        ON business.id::text = partition.business_id
      WHERE partition.status = 'running'
        AND partition.updated_at < now() - interval '30 minutes'
        AND (${businessFilter}::text IS NULL OR partition.business_id = ${businessFilter})
      ORDER BY partition.updated_at ASC
    `,
      sql`
      SELECT status, COUNT(*)::int AS count
      FROM google_ads_sync_checkpoints
      WHERE (${businessFilter}::text IS NULL OR business_id = ${businessFilter})
      GROUP BY status
      ORDER BY status
    `,
      sql`
      SELECT
        checkpoint.id::text AS checkpoint_id,
        checkpoint.partition_id::text AS partition_id,
        checkpoint.business_id,
        business.name AS business_name,
        checkpoint.checkpoint_scope,
        checkpoint.phase,
        checkpoint.status,
        checkpoint.updated_at,
        checkpoint.next_page_token,
        checkpoint.provider_cursor,
        COALESCE(checkpoint.lease_epoch, 0) AS checkpoint_lease_epoch,
        checkpoint.lease_owner,
        checkpoint.lease_expires_at,
        COALESCE(partition.lease_epoch, 0) AS partition_lease_epoch,
        partition.status AS partition_status,
        partition.finished_at AS partition_finished_at,
        ROUND(EXTRACT(EPOCH FROM (now() - checkpoint.updated_at)) / 60.0, 2) AS minutes_since_updated
      FROM google_ads_sync_checkpoints checkpoint
      JOIN businesses business
        ON business.id::text = checkpoint.business_id
      LEFT JOIN google_ads_sync_partitions partition
        ON partition.id = checkpoint.partition_id
      WHERE checkpoint.status = 'running'
        AND checkpoint.updated_at < now() - interval '15 minutes'
        AND (${businessFilter}::text IS NULL OR checkpoint.business_id = ${businessFilter})
      ORDER BY checkpoint.updated_at ASC
    `,
      sql`
      SELECT
        partition.id::text AS partition_id,
        partition.business_id,
        business.name AS business_name,
        partition.scope,
        partition.provider_account_id,
        partition.partition_date,
        partition.last_error,
        partition.updated_at
      FROM google_ads_sync_partitions partition
      JOIN businesses business
        ON business.id::text = partition.business_id
      WHERE partition.status = 'dead_letter'
        AND (${businessFilter}::text IS NULL OR partition.business_id = ${businessFilter})
      ORDER BY partition.updated_at DESC
    `,
      sql`
      SELECT
        worker_id,
        provider_scope,
        status,
        last_business_id,
        last_partition_id,
        last_heartbeat_at,
        ROUND(EXTRACT(EPOCH FROM (now() - last_heartbeat_at)) / 60.0, 2) AS heartbeat_age_minutes
      FROM sync_worker_heartbeats
      WHERE provider_scope IN ('google_ads', 'all')
      ORDER BY last_heartbeat_at DESC, worker_id
    `,
      sql`
      SELECT
        provider_scope,
        status,
        COUNT(*)::int AS count
      FROM sync_worker_heartbeats
      WHERE provider_scope IN ('google_ads', 'all')
      GROUP BY provider_scope, status
      ORDER BY provider_scope, status
    `,
      sql`
      SELECT
        error_message,
        COUNT(*)::int AS count,
        MAX(updated_at) AS latest_seen_at
      FROM google_ads_sync_runs
      WHERE updated_at >= now() - interval '2 hours'
        AND error_message IS NOT NULL
        AND (${businessFilter}::text IS NULL OR business_id = ${businessFilter})
      GROUP BY error_message
      ORDER BY count DESC, latest_seen_at DESC
      LIMIT 25
    `,
      sql`
      SELECT
        partition.id::text AS partition_id,
        run.id::text AS run_id,
        run.lane,
        run.scope,
        run.business_id,
        business.name AS business_name,
        run.worker_id,
        run.created_at AS run_created_at,
        run.updated_at AS run_updated_at,
        partition.status AS partition_status,
        partition.finished_at AS partition_finished_at
      FROM google_ads_sync_runs run
      JOIN google_ads_sync_partitions partition
        ON partition.id = run.partition_id
      JOIN businesses business
        ON business.id::text = run.business_id
      WHERE run.status = 'running'
        AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
        AND (${businessFilter}::text IS NULL OR run.business_id = ${businessFilter})
      ORDER BY run.updated_at DESC
    `,
      sql`
      SELECT
        run.partition_id::text AS partition_id,
        run.business_id,
        business.name AS business_name,
        run.scope,
        COUNT(*)::int AS running_run_count,
        json_agg(
          json_build_object(
            'runId', run.id::text,
            'workerId', run.worker_id,
            'createdAt', run.created_at,
            'updatedAt', run.updated_at
          )
          ORDER BY run.created_at DESC
        ) AS sample_runs
      FROM google_ads_sync_runs run
      JOIN businesses business
        ON business.id::text = run.business_id
      WHERE run.status = 'running'
        AND (${businessFilter}::text IS NULL OR run.business_id = ${businessFilter})
      GROUP BY run.partition_id, run.business_id, business.name, run.scope
      HAVING COUNT(*) > 1
      ORDER BY running_run_count DESC, run.partition_id
    `,
      sql`
      SELECT
        run.id::text AS run_id,
        run.partition_id::text AS partition_id,
        run.business_id,
        business.name AS business_name,
        run.lane,
        run.scope,
        run.worker_id,
        run.created_at,
        run.updated_at,
        latest_checkpoint.checkpoint_scope,
        latest_checkpoint.phase,
        latest_checkpoint.updated_at AS checkpoint_updated_at,
        latest_checkpoint.next_page_token,
        latest_checkpoint.provider_cursor,
        latest_checkpoint.checkpoint_lease_epoch,
        latest_checkpoint.partition_lease_epoch
      FROM google_ads_sync_runs run
      JOIN businesses business
        ON business.id::text = run.business_id
      LEFT JOIN LATERAL (
        SELECT
          checkpoint.checkpoint_scope,
          checkpoint.phase,
          checkpoint.updated_at,
          checkpoint.next_page_token,
          checkpoint.provider_cursor,
          COALESCE(checkpoint.lease_epoch, 0) AS checkpoint_lease_epoch,
          COALESCE(partition.lease_epoch, 0) AS partition_lease_epoch
        FROM google_ads_sync_checkpoints checkpoint
        JOIN google_ads_sync_partitions partition
          ON partition.id = checkpoint.partition_id
        WHERE checkpoint.partition_id = run.partition_id
        ORDER BY checkpoint.updated_at DESC
        LIMIT 1
      ) latest_checkpoint ON TRUE
      WHERE run.status = 'running'
        AND run.updated_at < now() - interval '15 minutes'
        AND (${businessFilter}::text IS NULL OR run.business_id = ${businessFilter})
      ORDER BY run.updated_at ASC
    `,
      sql`
      SELECT
        checkpoint.id::text AS checkpoint_id,
        checkpoint.partition_id::text AS partition_id,
        checkpoint.business_id,
        business.name AS business_name,
        checkpoint.checkpoint_scope,
        checkpoint.phase,
        checkpoint.updated_at AS checkpoint_updated_at,
        partition.status AS partition_status,
        partition.finished_at AS partition_finished_at
      FROM google_ads_sync_checkpoints checkpoint
      JOIN google_ads_sync_partitions partition
        ON partition.id = checkpoint.partition_id
      JOIN businesses business
        ON business.id::text = checkpoint.business_id
      WHERE checkpoint.status = 'running'
        AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
        AND (${businessFilter}::text IS NULL OR checkpoint.business_id = ${businessFilter})
      ORDER BY checkpoint.updated_at DESC
    `,
      sql`
      WITH recent_runs AS (
        SELECT
          updated_at,
          error_class,
          error_message,
          meta_json
        FROM google_ads_sync_runs
        WHERE updated_at >= now() - interval '2 hours'
          AND (${businessFilter}::text IS NULL OR business_id = ${businessFilter})
      ),
      classified AS (
        SELECT
          CASE
            WHEN COALESCE(error_class, '') = 'lease_conflict'
              OR COALESCE(error_message, '') ILIKE '%lost ownership before%'
              OR COALESCE(error_message, '') ILIKE '%superseded by a newer worker%'
              THEN 'lease_conflict_or_completion_denied'
            WHEN COALESCE(error_class, '') = 'stale_run'
              OR COALESCE(meta_json->>'closureReason', '') = 'lane_stale_threshold_exceeded'
              THEN 'stale_auto_close'
            WHEN COALESCE(meta_json->>'decisionCaller', '') IN (
              'cleanupGoogleAdsPartitionOrchestration',
              'backfillGoogleAdsRunningRunsForTerminalPartition'
            )
              THEN 'cleanup_or_repair_closure'
            WHEN COALESCE(meta_json->>'closureReason', '') LIKE 'partition_already_%'
              THEN 'partition_state_invalid_style'
            ELSE NULL
          END AS signal_class,
          updated_at
        FROM recent_runs
      )
      SELECT
        signal_class,
        COUNT(*)::int AS count,
        MAX(updated_at) AS latest_seen_at
      FROM classified
      WHERE signal_class IS NOT NULL
      GROUP BY signal_class
      ORDER BY count DESC, latest_seen_at DESC
    `,
      sql`
      WITH recent_partitions AS (
        SELECT
          scope,
          business_id,
          status,
          finished_at
        FROM google_ads_sync_partitions
        WHERE finished_at >= now() - interval '2 hours'
          AND (${businessFilter}::text IS NULL OR business_id = ${businessFilter})
      ),
      recent_runs AS (
        SELECT
          scope,
          business_id,
          duration_ms
        FROM google_ads_sync_runs
        WHERE finished_at >= now() - interval '2 hours'
          AND duration_ms IS NOT NULL
          AND (${businessFilter}::text IS NULL OR business_id = ${businessFilter})
      )
      SELECT
        scope,
        COUNT(*) FILTER (WHERE status = 'succeeded')::int AS succeeded_partition_count,
        COUNT(*) FILTER (WHERE status IN ('failed', 'dead_letter'))::int AS failed_partition_count,
        COUNT(recent_runs.duration_ms)::int AS run_count,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY recent_runs.duration_ms) AS median_run_duration_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY recent_runs.duration_ms) AS p95_run_duration_ms
      FROM recent_partitions
      LEFT JOIN recent_runs USING (scope, business_id)
      GROUP BY scope
      ORDER BY scope
    `,
      sql`
      SELECT
        run.business_id,
        business.name AS business_name,
        run.scope,
        COUNT(*)::int AS run_count,
        percentile_cont(0.5) WITHIN GROUP (ORDER BY run.duration_ms) AS median_run_duration_ms,
        percentile_cont(0.95) WITHIN GROUP (ORDER BY run.duration_ms) AS p95_run_duration_ms
      FROM google_ads_sync_runs run
      JOIN businesses business
        ON business.id::text = run.business_id
      WHERE run.finished_at >= now() - interval '2 hours'
        AND run.duration_ms IS NOT NULL
        AND (${businessFilter}::text IS NULL OR run.business_id = ${businessFilter})
      GROUP BY run.business_id, business.name, run.scope
      HAVING COUNT(*) > 0
      ORDER BY p95_run_duration_ms DESC NULLS LAST, run_count DESC
      LIMIT 15
    `,
      sql`
      SELECT
        partition.business_id,
        business.name AS business_name,
        partition.scope,
        partition.lane,
        partition.source,
        partition.partition_date,
        partition.priority,
        partition.attempt_count,
        partition.next_retry_at
      FROM google_ads_sync_partitions partition
      JOIN businesses business
        ON business.id::text = partition.business_id
      WHERE partition.status = 'queued'
        AND (${businessFilter}::text IS NULL OR partition.business_id = ${businessFilter})
      ORDER BY business.name, partition.scope, partition.lane, partition.source, partition.partition_date ASC
    `,
    ])) as Array<Array<Record<string, unknown>>>;

    const businessNameById = new Map(
      businessRows.map((row) => [
        String(row.business_id),
        String(row.business_name),
      ]),
    );

    const stateRowsByBusiness = new Map<
      string,
      Array<{
        provider_account_id: string;
        last_successful_sync_at: string | null;
      }>
    >();
    for (const row of stateRows) {
      const businessId = String(row.business_id);
      const bucket = stateRowsByBusiness.get(businessId) ?? [];
      bucket.push({
        provider_account_id: String(row.provider_account_id),
        last_successful_sync_at: toIso(row.last_successful_sync_at),
      });
      stateRowsByBusiness.set(businessId, bucket);
    }

    const activeIntegrations = [];
    for (const integrationRow of integrationRows) {
      const businessId = String(integrationRow.business_id);
      const targets = await collectTargetAccounts({
        businessId,
        stateRows: stateRowsByBusiness.get(businessId) ?? [],
      });

      if (targets.length === 0) {
        activeIntegrations.push({
          businessId,
          businessName: String(integrationRow.business_name),
          status: String(integrationRow.status),
          accountId: null,
          lastSuccessfulSyncAt: null,
          sources: ["no_target_account"],
        });
        continue;
      }

      for (const target of targets) {
        activeIntegrations.push({
          businessId,
          businessName: String(integrationRow.business_name),
          status: String(integrationRow.status),
          accountId: target.accountId,
          lastSuccessfulSyncAt: target.lastSuccessfulSyncAt,
          sources: target.sources,
          snapshotName: target.snapshotName,
        });
      }
    }

    const staleCheckpointIds = new Set(
      staleCheckpointRows.map((row) => String(row.checkpoint_id)),
    );
    const stalePartitionIds = new Set(
      stalePartitionRows.map((row) => String(row.partition_id)),
    );
    const anomalyPartitionIds = new Set<string>([
      ...stalePartitionRows.map((row) => String(row.partition_id)),
      ...runningUnderTerminalRows.map((row) => String(row.partition_id)),
      ...duplicateRunningRows.map((row) => String(row.partition_id)),
    ]);

    const leaseSnapshotRows = (await sql`
    SELECT
      partition.id::text AS partition_id,
      partition.business_id,
      business.name AS business_name,
      partition.scope,
      partition.status,
      partition.lease_owner,
      partition.lease_expires_at,
      partition.started_at,
      partition.updated_at,
      COALESCE(partition.lease_epoch, 0) AS lease_epoch,
      ROUND(EXTRACT(EPOCH FROM (now() - partition.updated_at)) / 60.0, 2) AS minutes_since_updated,
      partition.attempt_count
    FROM google_ads_sync_partitions partition
    JOIN businesses business
      ON business.id::text = partition.business_id
    WHERE (
      COALESCE(array_length(${Array.from(anomalyPartitionIds)}::text[], 1), 0) = 0
      OR partition.id::text = ANY(${Array.from(anomalyPartitionIds)}::text[])
    )
      AND (${businessFilter}::text IS NULL OR partition.business_id = ${businessFilter})
    ORDER BY partition.updated_at ASC
    `) as Array<Record<string, unknown>>;

    const queuedCampaignRowsByBusiness = new Map<
      string,
      Array<Record<string, unknown>>
    >();
    for (const row of queuedCampaignDailyRows) {
      const businessId = String(row.business_id);
      const bucket = queuedCampaignRowsByBusiness.get(businessId) ?? [];
      bucket.push(row);
      queuedCampaignRowsByBusiness.set(businessId, bucket);
    }

    const leaseableBacklogBusinessBreakdown = await Promise.all(
      Array.from(queuedCampaignRowsByBusiness.entries()).map(
        async ([businessId, rows]) => {
          const [fullSyncPriority, recent90State, queueHealth] = await Promise.all([
            getGoogleAdsFullSyncPriorityState({ businessId }).catch(() => null),
            getGoogleAdsRecent90CompletionState({ businessId }).catch(
              () => null,
            ),
            getGoogleAdsQueueHealth({ businessId }).catch(() => null),
          ]);
          const actionRequiredExcludedScopeSet = new Set<string>(
            [
              ...(queueHealth?.actionRequiredBlockingDeadLetterScopes ?? []),
              ...(queueHealth?.actionRequiredDeadLetterScopes ?? []),
            ].map(String),
          );
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

          const classifiedRows: LeaseableBreakdownRow[] = rows.map((row) => {
            const baseClassification =
              classifyGoogleAdsQueuedCampaignDailyPartition({
                row: {
                  lane: String(row.lane) as "core" | "maintenance" | "extended",
                  partitionDate: toIso(row.partition_date)?.slice(0, 10) ?? null,
                  nextRetryAt: toIso(row.next_retry_at),
                },
                frontierStart,
                suspendMaintenance: Boolean(incidentPolicy?.suspendMaintenance),
              });
            const scope = String(row.scope ?? "unknown");
            return {
              businessId,
              businessName:
                String(row.business_name) ??
                businessNameById.get(businessId) ??
                businessId,
              scope,
              lane: String(row.lane),
              source: String(row.source),
              partitionDate: toIso(row.partition_date)?.slice(0, 10) ?? null,
              priority: toNumber(row.priority),
              attemptCount: toNumber(row.attempt_count),
              nextRetryAt: toIso(row.next_retry_at),
              classification: actionRequiredExcludedScopeSet.has(scope)
                ? "action_required_excluded"
                : baseClassification,
            };
          });

          return {
            businessId,
            businessName: businessNameById.get(businessId) ?? businessId,
            frontierStart,
            rows: classifiedRows,
            summary: buildLeaseableBacklogSummary(
              businessId,
              businessNameById.get(businessId) ?? businessId,
              classifiedRows,
            ),
          };
        },
      ),
    );

    const leaseableBacklogRows = leaseableBacklogBusinessBreakdown.flatMap(
      (entry) => entry.rows,
    );
    const leaseableBacklogTotals = {
      totalQueued: leaseableBacklogRows.length,
      totalQueuedCampaignDaily: leaseableBacklogRows.filter(
        (row) => row.scope === "campaign_daily",
      ).length,
      coreQueueDepth: leaseableBacklogRows.filter((row) => row.lane === "core")
        .length,
      maintenanceQueueDepth: leaseableBacklogRows.filter(
        (row) => row.lane === "maintenance",
      ).length,
      leaseable_now: leaseableBacklogRows.filter(
        (row) => row.classification === "leaseable_now",
      ).length,
      suspended_maintenance: leaseableBacklogRows.filter(
        (row) => row.classification === "suspended_maintenance",
      ).length,
      outside_frontier: leaseableBacklogRows.filter(
        (row) => row.classification === "outside_frontier",
      ).length,
      retry_cooldown: leaseableBacklogRows.filter(
        (row) => row.classification === "retry_cooldown",
      ).length,
      action_required_excluded: leaseableBacklogRows.filter(
        (row) => row.classification === "action_required_excluded",
      ).length,
    };

    return {
      capturedAt: new Date().toISOString(),
      businessFilter,
      questions: {
        terminalParentHasRunningRunOrCheckpoint:
          runningUnderTerminalRows.length > 0 ||
          terminalParentCheckpointRows.length > 0,
        duplicateRunningRunsPerPartition: duplicateRunningRows.length > 0,
        stalePartitionScopeLeaders: partitionStateRows
          .map((row) => ({
            businessId: String(row.business_id),
            businessName: String(row.business_name),
            scope: String(row.scope),
            running: toNumber(row.running),
          }))
          .filter((row) => row.running > 0)
          .sort((left, right) => right.running - left.running)
          .slice(0, 10),
      },
      activeIntegrations,
      partitionState: partitionStateRows.map((row) => ({
        businessId: String(row.business_id),
        businessName: String(row.business_name),
        scope: String(row.scope),
        queued: toNumber(row.queued),
        leased: toNumber(row.leased),
        running: toNumber(row.running),
        succeeded: toNumber(row.succeeded),
        failed: toNumber(row.failed),
        deadLetter: toNumber(row.dead_letter),
        cancelled: toNumber(row.cancelled),
      })),
      staleRunningPartitions: stalePartitionRows.map((row) => ({
        partitionId: String(row.partition_id),
        scope: String(row.scope),
        businessId: String(row.business_id),
        businessName: String(row.business_name),
        startedAt: toIso(row.started_at),
        updatedAt: toIso(row.updated_at),
        leaseEpoch: toNumber(row.lease_epoch),
        minutesSinceUpdated: toNumber(row.minutes_since_updated),
        leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
        leaseExpiresAt: toIso(row.lease_expires_at),
        attemptCount: toNumber(row.attempt_count),
      })),
      checkpointState: {
        counts: checkpointStateRows.map((row) => ({
          status: String(row.status),
          count: toNumber(row.count),
        })),
        staleRunningCheckpoints: staleCheckpointRows.map((row) => ({
          checkpointId: String(row.checkpoint_id),
          partitionId: String(row.partition_id),
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          checkpointScope: String(row.checkpoint_scope),
          phase: String(row.phase),
          status: String(row.status),
          updatedAt: toIso(row.updated_at),
          partitionLeaseEpoch: toNumber(row.partition_lease_epoch),
          checkpointLeaseEpoch: toNumber(row.checkpoint_lease_epoch),
          minutesSinceUpdated: toNumber(row.minutes_since_updated),
          nextPageToken: row.next_page_token
            ? String(row.next_page_token)
            : null,
          providerCursor: row.provider_cursor
            ? String(row.provider_cursor)
            : null,
          leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
          leaseExpiresAt: toIso(row.lease_expires_at),
          parentPartitionStatus: row.partition_status
            ? String(row.partition_status)
            : null,
          parentPartitionFinishedAt: toIso(row.partition_finished_at),
        })),
      },
      deadLetterQueue: {
        count: deadLetterRows.length,
        partitions: deadLetterRows.map((row) => ({
          partitionId: String(row.partition_id),
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          scope: String(row.scope),
          providerAccountId: String(row.provider_account_id),
          partitionDate: String(row.partition_date).slice(0, 10),
          errorMessage: row.last_error ? String(row.last_error) : null,
          updatedAt: toIso(row.updated_at),
        })),
      },
      workerHeartbeat: {
        workers: workerRows.map((row) => ({
          workerId: String(row.worker_id),
          providerScope: String(row.provider_scope),
          status: String(row.status),
          lastBusinessId: row.last_business_id
            ? String(row.last_business_id)
            : null,
          lastPartitionId: row.last_partition_id
            ? String(row.last_partition_id)
            : null,
          lastHeartbeatAt: toIso(row.last_heartbeat_at),
          heartbeatAgeMinutes: toNumber(row.heartbeat_age_minutes),
        })),
        statusCounts: workerStatusRows.map((row) => ({
          providerScope: String(row.provider_scope),
          status: String(row.status),
          count: toNumber(row.count),
        })),
      },
      recentErrors: recentErrorRows.map((row) => ({
        errorMessage: String(row.error_message),
        count: toNumber(row.count),
        latestSeenAt: toIso(row.latest_seen_at),
      })),
      runningRunsUnderTerminalParents: {
        count: runningUnderTerminalRows.length,
        rows: runningUnderTerminalRows.map((row) => ({
          partitionId: String(row.partition_id),
          runId: String(row.run_id),
          lane: String(row.lane),
          scope: String(row.scope),
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          workerId: row.worker_id ? String(row.worker_id) : null,
          runCreatedAt: toIso(row.run_created_at),
          runUpdatedAt: toIso(row.run_updated_at),
          partitionStatus: String(row.partition_status),
          partitionFinishedAt: toIso(row.partition_finished_at),
        })),
      },
      duplicateRunningRunsPerPartition: {
        count: duplicateRunningRows.length,
        rows: duplicateRunningRows.map((row) => ({
          partitionId: String(row.partition_id),
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          scope: String(row.scope),
          runningRunCount: toNumber(row.running_run_count),
          sampleRuns: Array.isArray(row.sample_runs) ? row.sample_runs : [],
        })),
      },
      latestCheckpointContextForStaleWork: {
        staleRunningPartitions: stalePartitionRows.map((row) => {
          const latestCheckpoint = staleCheckpointRows.find(
            (checkpoint) =>
              String(checkpoint.partition_id) === String(row.partition_id),
          );
          return {
            partitionId: String(row.partition_id),
            businessId: String(row.business_id),
            businessName: String(row.business_name),
            scope: String(row.scope),
            latestCheckpointScope: latestCheckpoint
              ? String(latestCheckpoint.checkpoint_scope)
              : null,
            latestCheckpointPhase: latestCheckpoint
              ? String(latestCheckpoint.phase)
              : null,
            latestCheckpointUpdatedAt: latestCheckpoint
              ? toIso(latestCheckpoint.updated_at)
              : null,
            nextPageToken: latestCheckpoint?.next_page_token
              ? String(latestCheckpoint.next_page_token)
              : null,
            providerCursor: latestCheckpoint?.provider_cursor
              ? String(latestCheckpoint.provider_cursor)
              : null,
            partitionLeaseEpoch: latestCheckpoint
              ? toNumber(latestCheckpoint.partition_lease_epoch)
              : toNumber(row.lease_epoch),
            checkpointLeaseEpoch: latestCheckpoint
              ? toNumber(latestCheckpoint.checkpoint_lease_epoch)
              : null,
          };
        }),
        staleRunningRuns: staleRunningRows.map((row) => ({
          runId: String(row.run_id),
          partitionId: String(row.partition_id),
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          lane: String(row.lane),
          scope: String(row.scope),
          workerId: row.worker_id ? String(row.worker_id) : null,
          createdAt: toIso(row.created_at),
          updatedAt: toIso(row.updated_at),
          checkpointScope: row.checkpoint_scope
            ? String(row.checkpoint_scope)
            : null,
          checkpointPhase: row.phase ? String(row.phase) : null,
          checkpointUpdatedAt: toIso(row.checkpoint_updated_at),
          partitionLeaseEpoch: toNumber(row.partition_lease_epoch),
          checkpointLeaseEpoch: toNumber(row.checkpoint_lease_epoch),
          nextPageToken: row.next_page_token
            ? String(row.next_page_token)
            : null,
          providerCursor: row.provider_cursor
            ? String(row.provider_cursor)
            : null,
        })),
        staleRunningCheckpointIds: Array.from(staleCheckpointIds),
        staleRunningPartitionIds: Array.from(stalePartitionIds),
      },
      leaseableBacklogBreakdown: {
        totals: leaseableBacklogTotals,
        businesses: leaseableBacklogBusinessBreakdown.map((entry) => ({
          ...entry.summary,
          frontierStart: entry.frontierStart,
        })),
        rows: leaseableBacklogRows,
      },
      leaseSnapshot: {
        leaseEpochPresent: true,
        leaseEpochField: "lease_epoch",
        rows: leaseSnapshotRows.map((row) => ({
          partitionId: String(row.partition_id),
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          scope: String(row.scope),
          status: String(row.status),
          leaseEpoch: toNumber(row.lease_epoch),
          leaseOwner: row.lease_owner ? String(row.lease_owner) : null,
          leaseExpiresAt: toIso(row.lease_expires_at),
          startedAt: toIso(row.started_at),
          updatedAt: toIso(row.updated_at),
          minutesSinceUpdated: toNumber(row.minutes_since_updated),
          attemptCount: toNumber(row.attempt_count),
        })),
      },
      terminalParentRunningCheckpoints: {
        count: terminalParentCheckpointRows.length,
        rows: terminalParentCheckpointRows.map((row) => ({
          checkpointId: String(row.checkpoint_id),
          partitionId: String(row.partition_id),
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          checkpointScope: String(row.checkpoint_scope),
          phase: String(row.phase),
          checkpointUpdatedAt: toIso(row.checkpoint_updated_at),
          partitionStatus: String(row.partition_status),
          partitionFinishedAt: toIso(row.partition_finished_at),
        })),
      },
      recentSignals: recentSignalRows.map((row) => ({
        signalClass: String(row.signal_class),
        count: toNumber(row.count),
        latestSeenAt: toIso(row.latest_seen_at),
      })),
      throughputSnapshot: {
        byScope: throughputRows.map((row) => ({
          scope: String(row.scope),
          succeededPartitionCount: toNumber(row.succeeded_partition_count),
          failedPartitionCount: toNumber(row.failed_partition_count),
          runCount: toNumber(row.run_count),
          medianRunDurationMs:
            row.median_run_duration_ms == null
              ? null
              : toNumber(row.median_run_duration_ms),
          p95RunDurationMs:
            row.p95_run_duration_ms == null
              ? null
              : toNumber(row.p95_run_duration_ms),
        })),
        slowestBusinesses: slowBusinessRows.map((row) => ({
          businessId: String(row.business_id),
          businessName: String(row.business_name),
          scope: String(row.scope),
          runCount: toNumber(row.run_count),
          medianRunDurationMs:
            row.median_run_duration_ms == null
              ? null
              : toNumber(row.median_run_duration_ms),
          p95RunDurationMs:
            row.p95_run_duration_ms == null
              ? null
              : toNumber(row.p95_run_duration_ms),
        })),
      },
      businessNames: Object.fromEntries(
        Array.from(businessNameById.entries()).sort((left, right) =>
          left[1].localeCompare(right[1]),
        ),
      ),
    };
  });

  const text = JSON.stringify(payload, null, 2);
  if (args.outPath) {
    await writeFile(args.outPath, text, "utf8");
  }
  process.stdout.write(text);
}

main().catch((error) => {
  console.error(error);
  process.exit(1);
});
