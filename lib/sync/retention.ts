import { getDbWithTimeout } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import {
  acquireSyncRunnerLease,
  releaseSyncRunnerLease,
} from "@/lib/sync/worker-health";

const TERMINAL_PARTITION_STATUSES = [
  "succeeded",
  "failed",
  "dead_letter",
  "cancelled",
] as const;
const RETENTION_LEASE_BUSINESS_ID = "__sync_retention__";
const RETENTION_LEASE_PROVIDER_SCOPE = "maintenance";
const SYNC_RETENTION_REQUIRED_TABLES = [
  "google_ads_raw_snapshots",
  "google_ads_sync_partitions",
  "google_ads_sync_checkpoints",
  "meta_raw_snapshots",
  "meta_sync_partitions",
  "meta_sync_checkpoints",
  "sync_worker_heartbeats",
  "sync_reclaim_events",
  "sync_runner_leases",
] as const;

function envNumber(name: string, fallback: number) {
  const raw = process.env[name];
  if (!raw) return fallback;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}

export interface SyncRetentionSummary {
  googleRawSnapshotsDeleted: number;
  googleCheckpointsDeleted: number;
  metaRawSnapshotsDeleted: number;
  metaCheckpointsDeleted: number;
  workerHeartbeatsDeleted: number;
  reclaimEventsDeleted: number;
  skippedDueToActiveLease?: boolean;
}

async function execCount(query: Promise<unknown>) {
  const rows = await query;
  const first = Array.isArray(rows) ? rows[0] : null;
  const raw = (first as { count?: number | string } | undefined)?.count ?? 0;
  const count = typeof raw === "string" ? Number(raw) : Number(raw);
  return Number.isFinite(count) ? count : 0;
}

function emptyRetentionSummary(
  input?: Partial<SyncRetentionSummary>,
): SyncRetentionSummary {
  return {
    googleRawSnapshotsDeleted: 0,
    googleCheckpointsDeleted: 0,
    metaRawSnapshotsDeleted: 0,
    metaCheckpointsDeleted: 0,
    workerHeartbeatsDeleted: 0,
    reclaimEventsDeleted: 0,
    skippedDueToActiveLease: false,
    ...input,
  };
}

async function deleteBatches(
  deleteBatch: () => Promise<number>,
  batchSize: number,
) {
  let totalDeleted = 0;
  while (true) {
    const deleted = await deleteBatch();
    totalDeleted += deleted;
    if (deleted < batchSize) break;
  }
  return totalDeleted;
}

export async function pruneSyncLifecycleData(input?: {
  rawRetentionDays?: number;
  checkpointRetentionDays?: number;
  workerHeartbeatRetentionDays?: number;
  stoppedWorkerHeartbeatRetentionHours?: number;
  reclaimEventRetentionDays?: number;
}) {
  await assertDbSchemaReady({
    tables: [...SYNC_RETENTION_REQUIRED_TABLES],
    context: "sync_retention_prune",
  });
  const sql = getDbWithTimeout(envNumber("SYNC_RETENTION_QUERY_TIMEOUT_MS", 30_000));
  const rawRetentionDays = input?.rawRetentionDays ?? envNumber("SYNC_RAW_RETENTION_DAYS", 7);
  const checkpointRetentionDays =
    input?.checkpointRetentionDays ?? envNumber("SYNC_CHECKPOINT_RETENTION_DAYS", 14);
  const workerHeartbeatRetentionDays =
    input?.workerHeartbeatRetentionDays ?? envNumber("SYNC_WORKER_HEARTBEAT_RETENTION_DAYS", 7);
  const stoppedWorkerHeartbeatRetentionHours =
    input?.stoppedWorkerHeartbeatRetentionHours ??
    envNumber("SYNC_STOPPED_WORKER_HEARTBEAT_RETENTION_HOURS", 24);
  const reclaimEventRetentionDays =
    input?.reclaimEventRetentionDays ?? envNumber("SYNC_RECLAIM_EVENT_RETENTION_DAYS", 30);
  const batchSize = envNumber("SYNC_RETENTION_BATCH_SIZE", 250);
  const leaseMinutes = envNumber("SYNC_RETENTION_LEASE_MINUTES", 15);
  const leaseOwner = `sync-retention:${process.pid}:${Math.random().toString(36).slice(2, 10)}`;
  const leaseAcquired = await acquireSyncRunnerLease({
    businessId: RETENTION_LEASE_BUSINESS_ID,
    providerScope: RETENTION_LEASE_PROVIDER_SCOPE,
    leaseOwner,
    leaseMinutes,
  }).catch(() => false);

  if (!leaseAcquired) {
    return emptyRetentionSummary({ skippedDueToActiveLease: true });
  }

  try {
    const googleRawSnapshotsDeleted = await deleteBatches(
      () =>
        execCount(sql`
          WITH candidates AS (
            SELECT snapshot.id
            FROM google_ads_raw_snapshots snapshot
            WHERE EXISTS (
                SELECT 1
                FROM google_ads_sync_partitions partition
                WHERE partition.id = snapshot.partition_id
                  AND partition.status = ANY(${TERMINAL_PARTITION_STATUSES}::text[])
              )
              AND snapshot.fetched_at < now() - (${String(rawRetentionDays)} || ' days')::interval
            ORDER BY snapshot.fetched_at ASC, snapshot.id ASC
            LIMIT ${batchSize}
            FOR UPDATE OF snapshot SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM google_ads_raw_snapshots snapshot
            USING candidates
            WHERE snapshot.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `),
      batchSize,
    );

    const metaRawSnapshotsDeleted = await deleteBatches(
      () =>
        execCount(sql`
          WITH candidates AS (
            SELECT snapshot.id
            FROM meta_raw_snapshots snapshot
            WHERE EXISTS (
                SELECT 1
                FROM meta_sync_partitions partition
                WHERE partition.id = snapshot.partition_id
                  AND partition.status = ANY(${TERMINAL_PARTITION_STATUSES}::text[])
              )
              AND snapshot.fetched_at < now() - (${String(rawRetentionDays)} || ' days')::interval
            ORDER BY snapshot.fetched_at ASC, snapshot.id ASC
            LIMIT ${batchSize}
            FOR UPDATE OF snapshot SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM meta_raw_snapshots snapshot
            USING candidates
            WHERE snapshot.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `),
      batchSize,
    );

    const googleCheckpointsDeleted = await deleteBatches(
      () =>
        execCount(sql`
          WITH candidates AS (
            SELECT checkpoint.id
            FROM google_ads_sync_checkpoints checkpoint
            JOIN google_ads_sync_partitions partition
              ON partition.id = checkpoint.partition_id
            WHERE partition.status = ANY(${TERMINAL_PARTITION_STATUSES}::text[])
              AND checkpoint.updated_at < now() - (${String(checkpointRetentionDays)} || ' days')::interval
              AND NOT EXISTS (
                SELECT 1
                FROM google_ads_raw_snapshots snapshot
                WHERE snapshot.checkpoint_id = checkpoint.id
              )
            ORDER BY checkpoint.updated_at ASC, checkpoint.id ASC
            LIMIT ${batchSize}
            FOR UPDATE OF checkpoint SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM google_ads_sync_checkpoints checkpoint
            USING candidates
            WHERE checkpoint.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `),
      batchSize,
    );

    const metaCheckpointsDeleted = await deleteBatches(
      () =>
        execCount(sql`
          WITH candidates AS (
            SELECT checkpoint.id
            FROM meta_sync_checkpoints checkpoint
            JOIN meta_sync_partitions partition
              ON partition.id = checkpoint.partition_id
            WHERE partition.status = ANY(${TERMINAL_PARTITION_STATUSES}::text[])
              AND checkpoint.updated_at < now() - (${String(checkpointRetentionDays)} || ' days')::interval
              AND NOT EXISTS (
                SELECT 1
                FROM meta_raw_snapshots snapshot
                WHERE snapshot.checkpoint_id = checkpoint.id
              )
            ORDER BY checkpoint.updated_at ASC, checkpoint.id ASC
            LIMIT ${batchSize}
            FOR UPDATE OF checkpoint SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM meta_sync_checkpoints checkpoint
            USING candidates
            WHERE checkpoint.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `),
      batchSize,
    );

    const stoppedWorkerHeartbeatsDeleted = await deleteBatches(
      () =>
        execCount(sql`
          WITH candidates AS (
            SELECT worker_id
            FROM sync_worker_heartbeats
            WHERE status = ANY(${["stopped", "stopping"]}::text[])
              AND last_heartbeat_at <
                now() - (${String(stoppedWorkerHeartbeatRetentionHours)} || ' hours')::interval
            ORDER BY last_heartbeat_at ASC, worker_id ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM sync_worker_heartbeats heartbeat
            USING candidates
            WHERE heartbeat.worker_id = candidates.worker_id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `),
      batchSize,
    );

    const staleWorkerHeartbeatsDeleted = await deleteBatches(
      () =>
        execCount(sql`
          WITH candidates AS (
            SELECT worker_id
            FROM sync_worker_heartbeats
            WHERE last_heartbeat_at <
              now() - (${String(workerHeartbeatRetentionDays)} || ' days')::interval
            ORDER BY last_heartbeat_at ASC, worker_id ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM sync_worker_heartbeats heartbeat
            USING candidates
            WHERE heartbeat.worker_id = candidates.worker_id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `),
      batchSize,
    );

    const workerHeartbeatsDeleted =
      stoppedWorkerHeartbeatsDeleted + staleWorkerHeartbeatsDeleted;

    const reclaimEventsDeleted = await deleteBatches(
      () =>
        execCount(sql`
          WITH candidates AS (
            SELECT id
            FROM sync_reclaim_events
            WHERE created_at < now() - (${String(reclaimEventRetentionDays)} || ' days')::interval
            ORDER BY created_at ASC, id ASC
            LIMIT ${batchSize}
            FOR UPDATE SKIP LOCKED
          ),
          deleted AS (
            DELETE FROM sync_reclaim_events event
            USING candidates
            WHERE event.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `),
      batchSize,
    );

    return emptyRetentionSummary({
      googleRawSnapshotsDeleted,
      googleCheckpointsDeleted,
      metaRawSnapshotsDeleted,
      metaCheckpointsDeleted,
      workerHeartbeatsDeleted,
      reclaimEventsDeleted,
    });
  } finally {
    await releaseSyncRunnerLease({
      businessId: RETENTION_LEASE_BUSINESS_ID,
      providerScope: RETENTION_LEASE_PROVIDER_SCOPE,
      leaseOwner,
    }).catch(() => null);
  }
}
