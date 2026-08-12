import { resolveDestructiveRetentionMode } from "@/lib/sync/global-kill-switch";
import { getDb } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import { clearAllProviderAccountAssignmentsForProvider } from "@/lib/provider-account-assignments";
import { clearCachedReportSnapshots } from "@/lib/reporting-cache-writer";
import { clearAllProviderAccountSnapshotsForProvider } from "@/lib/provider-account-snapshots";
import { disconnectAllIntegrationsForProvider } from "@/lib/integrations";

const META_PURGE_TABLES = [
  "provider_reporting_snapshots",
  "meta_config_snapshots",
  "meta_creatives_snapshots",
  "meta_creative_media",
  "meta_creative_daily",
  "meta_ad_daily",
  "meta_adset_daily",
  "meta_campaign_daily",
  "meta_account_daily",
  "meta_raw_snapshots",
  "meta_sync_jobs",
  "business_provider_accounts",
  "provider_account_snapshot_runs",
  "provider_connections",
] as const;
const META_LEGACY_CACHE_TABLES = [
  "provider_reporting_snapshots",
  "meta_creatives_snapshots",
] as const;
const META_CHECKPOINT_CLEANUP_TABLES = [
  "meta_sync_checkpoints",
  "meta_sync_partitions",
] as const;
const META_TERMINAL_RUN_REPAIR_TABLES = [
  "meta_sync_runs",
  "meta_sync_partitions",
] as const;
const META_CREATIVE_MEDIA_PRUNE_TABLES = [
  "meta_creative_media",
  "meta_creative_daily",
] as const;

export interface MetaCleanupSummary {
  providerReportingSnapshotsDeleted: number;
  metaConfigSnapshotsDeleted: number;
  metaCreativesSnapshotsDeleted: number;
  metaRawSnapshotsDeleted: number;
  metaSyncJobsDeleted: number;
  metaAccountDailyDeleted: number;
  metaCampaignDailyDeleted: number;
  metaAdsetDailyDeleted: number;
  metaAdDailyDeleted: number;
  metaCreativeDailyDeleted: number;
  providerAssignmentsDeleted: number;
  integrationsDisconnected: number;
}

export interface MetaCacheCleanupSummary {
  providerReportingSnapshotsDeleted: number;
  metaCreativesSnapshotsDeleted: number;
}

export interface MetaCreativeMediaPruneSummary {
  /** Set when the retention lane refused; the counts above are then all zero. */
  skippedReason?: string;
  metaCreativeMediaDeleted: number;
  metaAdDailyUpdated: number;
  metaCreativeDailyUpdated: number;
}

export interface MetaSucceededParentRunningCheckpointCleanupGroup {
  checkpointScope: string;
  phase: string;
  epochBucket: "epoch_match" | "epoch_mismatch" | "checkpoint_epoch_null";
  timingBucket:
    | "checkpoint_updated_before_or_at_parent_finished"
    | "checkpoint_updated_after_parent_finished";
  count: number;
}

export interface MetaSucceededParentRunningCheckpointCleanupSummary {
  businessId: string | null;
  totalClosed: number;
  remainingRunningChildrenOfSucceededParents: number;
  groups: MetaSucceededParentRunningCheckpointCleanupGroup[];
}

export interface MetaTerminalParentRunningRunRepairGroup {
  partitionStatus: "succeeded" | "failed" | "dead_letter" | "cancelled";
  runStatus: "succeeded" | "failed" | "cancelled";
  lane: string;
  scope: string;
  count: number;
}

export interface MetaTerminalParentRunningRunRepairSummary {
  businessId: string | null;
  totalRepaired: number;
  remainingRunningRunsUnderTerminalParents: number;
  groups: MetaTerminalParentRunningRunRepairGroup[];
}

async function assertMetaCleanupTablesReady(context: string, tables: readonly string[]) {
  await assertDbSchemaReady({
    tables: [...tables],
    context,
  });
}

async function execCount(query: Promise<unknown>) {
  const rows = await query;
  const first = Array.isArray(rows) ? rows[0] : null;
  const raw = (first as { count?: number | string } | undefined)?.count ?? 0;
  const count = typeof raw === "string" ? Number(raw) : Number(raw);
  return Number.isFinite(count) ? count : 0;
}

export async function purgeAllMetaDataAndDisconnect(): Promise<MetaCleanupSummary> {
  await assertMetaCleanupTablesReady("meta_cleanup_purge_all", META_PURGE_TABLES);
  const sql = getDb();

  const providerReportingSnapshotsDeleted = await clearCachedReportSnapshots({
    provider: "meta",
  });
  const metaConfigSnapshotsDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_config_snapshots
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaCreativesSnapshotsDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_creatives_snapshots
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_creative_media
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaCreativeDailyDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_creative_daily
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaAdDailyDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_ad_daily
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaAdsetDailyDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_adset_daily
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaCampaignDailyDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_campaign_daily
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaAccountDailyDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_account_daily
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  // Receipts reference canonical content with ON DELETE RESTRICT, so the
  // observation layer has to be cleared first or the content delete below
  // aborts the whole reset. Order, not a weaker FK: RESTRICT is what stops a
  // retention path from silently orphaning provenance.
  await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_raw_snapshot_observations
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaRawSnapshotsDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_raw_snapshots
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);
  const metaSyncJobsDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_sync_jobs
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);

  const [providerAssignmentsDeletedRows, integrationsDisconnectedRows] = await Promise.all([
    sql<{ count: number }>`
      SELECT COUNT(*)::int AS count
      FROM business_provider_accounts
      WHERE provider = 'meta'
    `,
    sql<{ count: number }>`
      SELECT COUNT(*)::int AS count
      FROM provider_connections
      WHERE provider = 'meta'
    `,
  ]);
  const providerAssignmentsDeleted = Number(providerAssignmentsDeletedRows[0]?.count ?? 0);
  const integrationsDisconnected = Number(integrationsDisconnectedRows[0]?.count ?? 0);

  await clearAllProviderAccountSnapshotsForProvider("meta");
  await clearAllProviderAccountAssignmentsForProvider("meta");
  await disconnectAllIntegrationsForProvider("meta");

  return {
    providerReportingSnapshotsDeleted,
    metaConfigSnapshotsDeleted,
    metaCreativesSnapshotsDeleted,
    metaRawSnapshotsDeleted,
    metaSyncJobsDeleted,
    metaAccountDailyDeleted,
    metaCampaignDailyDeleted,
    metaAdsetDailyDeleted,
    metaAdDailyDeleted,
    metaCreativeDailyDeleted,
    providerAssignmentsDeleted,
    integrationsDisconnected,
  };
}

export async function purgeMetaLegacyCaches(businessId?: string | null): Promise<MetaCacheCleanupSummary> {
  await assertMetaCleanupTablesReady("meta_cleanup_legacy_caches", META_LEGACY_CACHE_TABLES);
  const sql = getDb();

  const providerReportingSnapshotsDeleted = await clearCachedReportSnapshots({
    provider: "meta",
    businessId: businessId ?? null,
  });

  const metaCreativesSnapshotsDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_creatives_snapshots
      WHERE (${businessId ?? null}::text IS NULL OR business_id = ${businessId ?? null})
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);

  return {
    providerReportingSnapshotsDeleted,
    metaCreativesSnapshotsDeleted,
  };
}

export async function closeSucceededMetaParentRunningCheckpoints(input?: {
  businessId?: string | null;
}): Promise<MetaSucceededParentRunningCheckpointCleanupSummary> {
  await assertMetaCleanupTablesReady(
    "meta_orphan_checkpoint_cleanup",
    META_CHECKPOINT_CLEANUP_TABLES,
  );
  const sql = getDb();
  const businessId = input?.businessId?.trim() || null;

  const [row] = (await sql`
    WITH candidate_checkpoints AS (
      SELECT
        checkpoint.id,
        checkpoint.business_id,
        checkpoint.provider_account_id,
        checkpoint.checkpoint_scope,
        checkpoint.phase,
        CASE
          WHEN checkpoint.lease_epoch IS NULL THEN 'checkpoint_epoch_null'
          WHEN COALESCE(checkpoint.lease_epoch, 0) = COALESCE(partition.lease_epoch, 0)
            THEN 'epoch_match'
          ELSE 'epoch_mismatch'
        END AS epoch_bucket,
        CASE
          WHEN partition.finished_at IS NOT NULL AND checkpoint.updated_at <= partition.finished_at
            THEN 'checkpoint_updated_before_or_at_parent_finished'
          ELSE 'checkpoint_updated_after_parent_finished'
        END AS timing_bucket
      FROM meta_sync_checkpoints checkpoint
      JOIN meta_sync_partitions partition
        ON partition.id = checkpoint.partition_id
      WHERE partition.status = 'succeeded'
        AND checkpoint.status = 'running'
        AND (${businessId}::text IS NULL OR checkpoint.business_id = ${businessId})
    ),
    updated_checkpoints AS (
      UPDATE meta_sync_checkpoints checkpoint
      SET
        status = 'succeeded',
        phase = 'finalize',
        next_page_url = NULL,
        provider_cursor = NULL,
        finished_at = COALESCE(checkpoint.finished_at, now()),
        updated_at = now()
      FROM candidate_checkpoints candidate
      WHERE checkpoint.id = candidate.id
      RETURNING
        candidate.checkpoint_scope,
        candidate.phase,
        candidate.epoch_bucket,
        candidate.timing_bucket
    ),
    grouped AS (
      SELECT
        checkpoint_scope,
        phase,
        epoch_bucket,
        timing_bucket,
        COUNT(*)::int AS row_count
      FROM updated_checkpoints
      GROUP BY checkpoint_scope, phase, epoch_bucket, timing_bucket
    )
    SELECT json_build_object(
      'businessId', ${businessId}::text,
      'totalClosed', COALESCE((SELECT SUM(row_count)::int FROM grouped), 0),
      'groups',
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'checkpointScope', checkpoint_scope,
              'phase', phase,
              'epochBucket', epoch_bucket,
              'timingBucket', timing_bucket,
              'count', row_count
            )
            ORDER BY checkpoint_scope, phase, epoch_bucket, timing_bucket
          )
          FROM grouped
        ),
        '[]'::json
      )
    ) AS summary
  `) as Array<{ summary: MetaSucceededParentRunningCheckpointCleanupSummary }>;

  const [remainingRow] = (await sql`
    SELECT COUNT(*)::int AS count
    FROM meta_sync_checkpoints checkpoint
    JOIN meta_sync_partitions partition
      ON partition.id = checkpoint.partition_id
    WHERE partition.status = 'succeeded'
      AND checkpoint.status = 'running'
      AND (${businessId}::text IS NULL OR checkpoint.business_id = ${businessId})
  `) as Array<{ count: number }>;

  const remainingRunningChildrenOfSucceededParents =
    typeof remainingRow?.count === "number" ? remainingRow.count : 0;

  if (row?.summary) {
    return {
      ...row.summary,
      remainingRunningChildrenOfSucceededParents,
    };
  }

  return {
    businessId,
    totalClosed: 0,
    remainingRunningChildrenOfSucceededParents,
    groups: [],
  };
}

export async function repairMetaRunningRunsUnderTerminalParents(input?: {
  businessId?: string | null;
}): Promise<MetaTerminalParentRunningRunRepairSummary> {
  await assertMetaCleanupTablesReady(
    "meta_terminal_run_repair",
    META_TERMINAL_RUN_REPAIR_TABLES,
  );
  const sql = getDb();
  const businessId = input?.businessId?.trim() || null;

  const [row] = (await sql`
    WITH candidate_runs AS (
      SELECT
        run.id,
        run.partition_id,
        run.worker_id,
        partition.lease_epoch,
        partition.status AS partition_status,
        partition.last_error AS partition_last_error,
        run.lane,
        run.scope,
        CASE
          WHEN partition.status = 'succeeded' THEN 'succeeded'
          WHEN partition.status = 'cancelled' THEN 'cancelled'
          ELSE 'failed'
        END AS run_status
      FROM meta_sync_runs run
      JOIN meta_sync_partitions partition
        ON partition.id = run.partition_id
      WHERE run.status = 'running'
        AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
        AND (${businessId}::text IS NULL OR run.business_id = ${businessId})
    ),
    repaired_runs AS (
      UPDATE meta_sync_runs run
      SET
        status = candidate.run_status,
        error_class = CASE
          WHEN candidate.run_status IN ('succeeded', 'cancelled') THEN NULL
          WHEN candidate.partition_status = 'dead_letter' THEN COALESCE(run.error_class, 'dead_letter')
          ELSE COALESCE(run.error_class, 'failed')
        END,
        error_message = CASE
          WHEN candidate.run_status IN ('succeeded', 'cancelled') THEN NULL
          WHEN candidate.partition_status = 'dead_letter'
            THEN COALESCE(candidate.partition_last_error, run.error_message, 'partition already dead_letter')
          ELSE COALESCE(candidate.partition_last_error, run.error_message, 'partition already failed')
        END,
        finished_at = COALESCE(run.finished_at, now()),
        duration_ms = COALESCE(
          run.duration_ms,
          GREATEST(0, FLOOR(EXTRACT(EPOCH FROM (now() - COALESCE(run.started_at, run.created_at))) * 1000))::int
        ),
        meta_json = COALESCE(run.meta_json, '{}'::jsonb) || jsonb_build_object(
          'decisionCaller', 'repairMetaRunningRunsUnderTerminalParents',
          'closureReason', CASE
            WHEN candidate.partition_status = 'succeeded' THEN 'partition_already_succeeded'
            WHEN candidate.partition_status = 'failed' THEN 'partition_already_failed'
            WHEN candidate.partition_status = 'dead_letter' THEN 'partition_already_dead_letter'
            ELSE 'partition_already_cancelled'
          END
        ),
        updated_at = now()
      FROM candidate_runs candidate
      WHERE run.id = candidate.id
      RETURNING
        candidate.id,
        candidate.partition_id,
        candidate.worker_id,
        candidate.lease_epoch,
        candidate.partition_status,
        candidate.run_status,
        candidate.lane,
        candidate.scope
    ),
    grouped AS (
      SELECT
        partition_status,
        run_status,
        lane,
        scope,
        COUNT(*)::int AS row_count
      FROM repaired_runs
      GROUP BY partition_status, run_status, lane, scope
    )
    SELECT json_build_object(
      'businessId', ${businessId}::text,
      'totalRepaired', COALESCE((SELECT SUM(row_count)::int FROM grouped), 0),
      'groups',
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'partitionStatus', partition_status,
              'runStatus', run_status,
              'lane', lane,
              'scope', scope,
              'count', row_count
            )
            ORDER BY partition_status, run_status, lane, scope
          )
          FROM grouped
        ),
        '[]'::json
      ),
      'repairRows',
      COALESCE(
        (
          SELECT json_agg(
            json_build_object(
              'runId', id,
              'partitionId', partition_id,
              'workerId', worker_id,
              'leaseEpoch', lease_epoch,
              'partitionStatus', partition_status,
              'runStatusAfter', run_status,
              'lane', lane,
              'scope', scope
            )
            ORDER BY partition_status, run_status, lane, scope, id
          )
          FROM repaired_runs
        ),
        '[]'::json
      )
    ) AS summary
  `) as Array<
    {
      summary: MetaTerminalParentRunningRunRepairSummary & {
        repairRows?: Array<{
          runId: string;
          partitionId: string;
          workerId: string | null;
          leaseEpoch: number | null;
          partitionStatus: string;
          runStatusAfter: string;
          lane: string;
          scope: string;
        }>;
      };
    }
  >;

  const [remainingRow] = (await sql`
    SELECT COUNT(*)::int AS count
    FROM meta_sync_runs run
    JOIN meta_sync_partitions partition
      ON partition.id = run.partition_id
    WHERE run.status = 'running'
      AND partition.status IN ('succeeded', 'failed', 'dead_letter', 'cancelled')
      AND (${businessId}::text IS NULL OR run.business_id = ${businessId})
  `) as Array<{ count: number }>;

  const remainingRunningRunsUnderTerminalParents =
    typeof remainingRow?.count === "number" ? remainingRow.count : 0;

  for (const repairRow of row?.summary?.repairRows ?? []) {
    console.warn("[meta-sync] terminal_parent_running_run_repaired", {
      partitionId: repairRow.partitionId,
      runId: repairRow.runId,
      recoveredRunId: null,
      workerId: repairRow.workerId ?? null,
      leaseEpoch: repairRow.leaseEpoch ?? null,
      lane: repairRow.lane,
      scope: repairRow.scope,
      partitionStatus: repairRow.partitionStatus,
      runStatusBefore: "running",
      runStatusAfter: repairRow.runStatusAfter,
      pathKind: "repair",
    });
  }

  if (row?.summary) {
    const { repairRows: _repairRows, ...summary } = row.summary;
    return {
      ...summary,
      remainingRunningRunsUnderTerminalParents,
    };
  }

  return {
    businessId,
    totalRepaired: 0,
    remainingRunningRunsUnderTerminalParents,
    groups: [],
  };
}

export async function pruneMetaCreativeMediaOutsideRetention(input: {
  businessId?: string | null;
  keepFromDate: string;
}): Promise<MetaCreativeMediaPruneSummary> {
  // The retention lane admits this, like every other delete.
  //
  // It did not. This function issues an unbounded DELETE against
  // meta_creative_media and two unbounded UPDATEs, and it runs as the FIRST
  // statement of every creative sync — so with the retention lane deliberately
  // OFF in production, ordinary syncing was still deleting rows every tick.
  // The call site swallows failures, so nothing said so.
  //
  // That contradicted the lane's own contract ("The only path that deletes.
  // Deliberately last and deliberately separate", global-kill-switch.ts) and
  // duplicated a policy that already exists for this exact table, lane-gated,
  // in warehouse-retention.ts. Two retention implementations for one table, one
  // of them ungated, is how "retention is off" stops being true.
  const admission = resolveDestructiveRetentionMode({ requestedExecute: true });
  if (admission.mode !== "execute") {
    return {
      metaCreativeMediaDeleted: 0,
      metaAdDailyUpdated: 0,
      metaCreativeDailyUpdated: 0,
      skippedReason: admission.laneAdmission.reason,
    };
  }
  await assertMetaCleanupTablesReady(
    "meta_creative_media_prune",
    META_CREATIVE_MEDIA_PRUNE_TABLES,
  );
  const sql = getDb();

  const metaCreativeMediaDeleted = await execCount(sql`
    WITH deleted AS (
      DELETE FROM meta_creative_media
      WHERE (${input.businessId ?? null}::text IS NULL OR business_id = ${input.businessId ?? null})
        AND date::date < ${input.keepFromDate}::date
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM deleted
  `);

  const metaCreativeDailyUpdated = await execCount(sql`
    WITH updated AS (
      UPDATE meta_creative_daily
      SET
        thumbnail_url = NULL,
        payload_json = jsonb_set(
          jsonb_set(
            jsonb_set(
              jsonb_set(
                jsonb_set(
                  jsonb_set(
                    COALESCE(payload_json, '{}'::jsonb),
                    '{preview_url}',
                    'null'::jsonb,
                    true
                  ),
                  '{thumbnail_url}',
                  'null'::jsonb,
                  true
                ),
                '{image_url}',
                'null'::jsonb,
                true
              ),
              '{table_thumbnail_url}',
              'null'::jsonb,
              true
            ),
            '{card_preview_url}',
            'null'::jsonb,
            true
          ),
          '{preview}',
          jsonb_set(
            jsonb_set(
              jsonb_set(COALESCE(payload_json->'preview', '{}'::jsonb), '{image_url}', 'null'::jsonb, true),
              '{poster_url}',
              'null'::jsonb,
              true
            ),
            '{video_url}',
            'null'::jsonb,
            true
          ),
          true
        ),
        updated_at = now()
      WHERE (${input.businessId ?? null}::text IS NULL OR business_id = ${input.businessId ?? null})
        AND date::date < ${input.keepFromDate}::date
        AND (
          thumbnail_url IS NOT NULL OR
          NULLIF(payload_json->>'preview_url', '') IS NOT NULL OR
          NULLIF(payload_json->>'thumbnail_url', '') IS NOT NULL OR
          NULLIF(payload_json->>'image_url', '') IS NOT NULL OR
          NULLIF(payload_json->>'table_thumbnail_url', '') IS NOT NULL OR
          NULLIF(payload_json->>'card_preview_url', '') IS NOT NULL OR
          NULLIF(payload_json->'preview'->>'image_url', '') IS NOT NULL OR
          NULLIF(payload_json->'preview'->>'poster_url', '') IS NOT NULL OR
          NULLIF(payload_json->'preview'->>'video_url', '') IS NOT NULL
        )
      RETURNING 1
    )
    SELECT COUNT(*)::int AS count FROM updated
  `);

  return {
    metaCreativeMediaDeleted,
    // meta_ad_daily is immutable decision-fact history from this cleanup
    // path. Authoritative ingestion strips media fields before persistence.
    metaAdDailyUpdated: 0,
    metaCreativeDailyUpdated,
  };
}
