import { getDbWithTimeout } from "@/lib/db";
import { assertDbSchemaReady } from "@/lib/db-schema-readiness";
import { assertSyncRetentionExecutionReady } from "@/lib/sync/retention-readiness";
import { assertSyncLaneEnabled } from "@/lib/sync/global-kill-switch";
import { runSyncGateRetentionPass } from "@/lib/sync/release-gates";
import {
  runStorageContainmentPass,
  type StorageContainmentReport,
} from "@/lib/sync/storage-containment";
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
  "meta_raw_snapshot_observations",
  "meta_sync_partitions",
  "meta_sync_checkpoints",
  "shopify_raw_snapshots",
  "shopify_raw_snapshot_observations",
  "sync_worker_heartbeats",
  "sync_reclaim_events",
  "sync_runner_leases",
] as const;

/**
 * Every relation this sweep issues a DELETE against.
 *
 * Declared so the readiness contract's coverage can be checked in BOTH
 * directions: every declared index must resolve to a real relation, and every
 * relation this sweep deletes from must be covered by a declared index. A
 * contract that only checks one direction can be satisfied while a destructive
 * path runs entirely unindexed.
 */
export const SYNC_RETENTION_DELETE_TARGET_TABLES = [
  "google_ads_raw_snapshots",
  "meta_raw_snapshot_observations",
  "shopify_raw_snapshot_observations",
  "meta_raw_snapshots",
  "shopify_raw_snapshots",
  "google_ads_sync_checkpoints",
  "meta_sync_checkpoints",
  "sync_worker_heartbeats",
  "sync_reclaim_events",
] as const;

/**
 * Every table holding a typed reference INTO canonical raw content.
 *
 * These are all `ON DELETE SET NULL`, which is exactly why they must be
 * enumerated here: deleting referenced content would not fail, it would
 * silently null the provenance of a durable warehouse row. Retention therefore
 * refuses to collect content that any of them still points at.
 *
 * The lists are static so the delete SQL stays reviewable, and the real-PG
 * retention seam asserts they cover EVERY inbound foreign key in the catalog —
 * so adding a new reference without adding it here fails a test rather than
 * quietly losing provenance in production.
 */
export const META_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES = [
  "meta_account_daily",
  "meta_campaign_daily",
  "meta_adset_daily",
  "meta_breakdown_daily",
  "meta_ad_daily",
  "meta_creative_daily",
  "meta_campaign_config_history",
  "meta_adset_config_history",
] as const;

export const SHOPIFY_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES = [
  "shopify_entity_payload_archives",
  "shopify_orders",
  "shopify_order_lines",
  "shopify_refunds",
  "shopify_order_transactions",
  "shopify_returns",
  "shopify_sales_events",
] as const;

function inboundReferenceGuard(tables: readonly string[], alias: string) {
  // Rendered from a closed literal list, never from input.
  return tables
    .map(
      (table) =>
        `NOT EXISTS (SELECT 1 FROM ${table} referrer WHERE referrer.source_snapshot_id = ${alias}.id)`,
    )
    .join("\n              AND ");
}

/**
 * Meta canonical content that is safe to collect.
 *
 * Two branches, one statement — deliberately not a UNION, because
 * `FOR UPDATE ... SKIP LOCKED` is not allowed over a UNION and the claim must
 * be lock-safe against a concurrent sweep.
 *
 *  - New model (`content_key IS NOT NULL`): content is observation-free
 *    evidence once nothing observes it. Attribution lives on receipts, so a
 *    partition-column test would find nothing and the new rows would be
 *    immortal.
 *  - Legacy (`content_key IS NULL`): unchanged behaviour — attributed to a
 *    terminal partition through its own partition column.
 *
 * Both branches are additionally gated on zero inbound typed references.
 */
export const META_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL = `
            SELECT snapshot.id
            FROM meta_raw_snapshots snapshot
            WHERE snapshot.fetched_at < now() - ($1 || ' days')::interval
              AND (
                (
                  snapshot.content_key IS NOT NULL
                  AND NOT EXISTS (
                    SELECT 1
                    FROM meta_raw_snapshot_observations receipt
                    WHERE receipt.snapshot_id = snapshot.id
                  )
                )
                OR (
                  snapshot.content_key IS NULL
                  AND EXISTS (
                    SELECT 1
                    FROM meta_sync_partitions partition
                    WHERE partition.id = snapshot.partition_id
                      AND partition.status = ANY($2::text[])
                  )
                )
              )
              AND ${inboundReferenceGuard(META_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES, "snapshot")}
            ORDER BY snapshot.fetched_at ASC, snapshot.id ASC
            LIMIT $3
            FOR UPDATE OF snapshot SKIP LOCKED`;

export const SHOPIFY_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL = `
            SELECT snapshot.id
            FROM shopify_raw_snapshots snapshot
            WHERE snapshot.fetched_at < now() - ($1 || ' days')::interval
              AND NOT EXISTS (
                SELECT 1
                FROM shopify_raw_snapshot_observations receipt
                WHERE receipt.snapshot_id = snapshot.id
              )
              AND ${inboundReferenceGuard(SHOPIFY_RAW_SNAPSHOT_INBOUND_REFERENCE_TABLES, "snapshot")}
            ORDER BY snapshot.fetched_at ASC, snapshot.id ASC
            LIMIT $2
            FOR UPDATE OF snapshot SKIP LOCKED`;

/**
 * Receipts whose partition is finished, or which never had one.
 *
 * Receipt-first is the required order: canonical content is protected by
 * RESTRICT while any receipt points at it, so ageing receipts out is what makes
 * content collectable at all. A live partition's receipts are never touched —
 * that is the completion evidence a running sync depends on.
 */
export const META_RAW_SNAPSHOT_OBSERVATION_RETENTION_CANDIDATE_SQL = `
            SELECT receipt.id
            FROM meta_raw_snapshot_observations receipt
            WHERE receipt.observed_at < now() - ($1 || ' days')::interval
              AND (
                receipt.partition_id IS NULL
                OR EXISTS (
                  SELECT 1
                  FROM meta_sync_partitions partition
                  WHERE partition.id = receipt.partition_id
                    AND partition.status = ANY($2::text[])
                )
              )
            ORDER BY receipt.observed_at ASC, receipt.id ASC
            LIMIT $3
            FOR UPDATE OF receipt SKIP LOCKED`;

export const SHOPIFY_RAW_SNAPSHOT_OBSERVATION_RETENTION_CANDIDATE_SQL = `
            SELECT receipt.id
            FROM shopify_raw_snapshot_observations receipt
            WHERE receipt.observed_at < now() - ($1 || ' days')::interval
            ORDER BY receipt.observed_at ASC, receipt.id ASC
            LIMIT $2
            FOR UPDATE OF receipt SKIP LOCKED`;

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
  metaRawSnapshotObservationsDeleted: number;
  shopifyRawSnapshotsDeleted: number;
  shopifyRawSnapshotObservationsDeleted: number;
  metaCheckpointsDeleted: number;
  workerHeartbeatsDeleted: number;
  reclaimEventsDeleted: number;
  /**
   * The `sync_release_gates` containment pass.
   *
   * Reported separately because it has its OWN dry-run/execute decision — it
   * proposes candidates and reports them even while the retention lane keeps it
   * from deleting anything, which is the only way to see whether the table's
   * growth is actually contained before enabling deletion.
   */
  releaseGates: {
    mode: "execute" | "dry_run";
    batches: number;
    examined: number;
    candidates: number;
    deleted: number;
    completed: boolean;
  };
  /**
   * Lineage collapse progress and config-history forward-growth measurement.
   *
   * Reported here because containment is only meaningful operationally if
   * something runs it and something measures whether it worked. Neither the
   * collapse nor the growth measurement deletes anything.
   */
  storageContainment: StorageContainmentReport | null;
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
    metaRawSnapshotObservationsDeleted: 0,
    shopifyRawSnapshotsDeleted: 0,
    shopifyRawSnapshotObservationsDeleted: 0,
    metaCheckpointsDeleted: 0,
    workerHeartbeatsDeleted: 0,
    reclaimEventsDeleted: 0,
    releaseGates: {
      mode: "dry_run",
      batches: 0,
      examined: 0,
      candidates: 0,
      deleted: 0,
      completed: true,
    },
    storageContainment: null,
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
  // Retention deletes. It has its own lane and stays off even when every other
  // lane is on, so "resume sync" can never resume deletion.
  assertSyncLaneEnabled("retention");
  await assertDbSchemaReady({
    tables: [...SYNC_RETENTION_REQUIRED_TABLES],
    context: "sync_retention_prune",
  });
  // Fail closed BEFORE the lease is taken and before any row is claimed.
  // Every index this sweep depends on must exist under its declared name with
  // the declared method, ordered keys, predicate, uniqueness and key count, and
  // be valid/ready/live. Any negative drift throws here, so a refused run
  // performs zero mutations rather than falling back to a sequential scan over
  // a destructive path.
  await assertSyncRetentionExecutionReady({
    timeoutMs: envNumber("SYNC_RETENTION_QUERY_TIMEOUT_MS", 30_000),
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

    // Receipt-first. Canonical content is protected by RESTRICT for as long as
    // any receipt points at it, so ageing receipts out is what makes content
    // collectable at all. Running this after the content sweep would leave
    // every shared row immortal for one extra cycle.
    const metaRawSnapshotObservationsDeleted = await deleteBatches(
      () =>
        execCount(
          sql.query(
            `
          WITH candidates AS (${META_RAW_SNAPSHOT_OBSERVATION_RETENTION_CANDIDATE_SQL}
          ),
          deleted AS (
            DELETE FROM meta_raw_snapshot_observations receipt
            USING candidates
            WHERE receipt.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `,
            [String(rawRetentionDays), [...TERMINAL_PARTITION_STATUSES], batchSize],
          ),
        ),
      batchSize,
    );

    const shopifyRawSnapshotObservationsDeleted = await deleteBatches(
      () =>
        execCount(
          sql.query(
            `
          WITH candidates AS (${SHOPIFY_RAW_SNAPSHOT_OBSERVATION_RETENTION_CANDIDATE_SQL}
          ),
          deleted AS (
            DELETE FROM shopify_raw_snapshot_observations receipt
            USING candidates
            WHERE receipt.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `,
            [String(rawRetentionDays), batchSize],
          ),
        ),
      batchSize,
    );

    const metaRawSnapshotsDeleted = await deleteBatches(
      () =>
        execCount(
          sql.query(
            `
          WITH candidates AS (${META_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL}
          ),
          deleted AS (
            DELETE FROM meta_raw_snapshots snapshot
            USING candidates
            WHERE snapshot.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `,
            [String(rawRetentionDays), [...TERMINAL_PARTITION_STATUSES], batchSize],
          ),
        ),
      batchSize,
    );

    const shopifyRawSnapshotsDeleted = await deleteBatches(
      () =>
        execCount(
          sql.query(
            `
          WITH candidates AS (${SHOPIFY_RAW_SNAPSHOT_RETENTION_CANDIDATE_SQL}
          ),
          deleted AS (
            DELETE FROM shopify_raw_snapshots snapshot
            USING candidates
            WHERE snapshot.id = candidates.id
            RETURNING 1
          )
          SELECT COUNT(*)::int AS count FROM deleted
        `,
            [String(rawRetentionDays), batchSize],
          ),
        ),
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

    // The release-gate containment pass. `pruneSyncGateRecords` had no caller at
    // all, so the 1.35 GB stayed 1.35 GB however correct the batch logic was.
    // It runs here, under the retention lease that already serialises this
    // sweep, and it makes its own dry-run/execute decision — so with the
    // retention lane off it reports what it WOULD remove and removes nothing.
    const releaseGates = await runSyncGateRetentionPass({
      maxAgeDays: envNumber("SYNC_RELEASE_GATE_RETENTION_DAYS", 90),
      batchLimit: envNumber("SYNC_RELEASE_GATE_RETENTION_BATCH", 2_000),
      maxBatches: envNumber("SYNC_RELEASE_GATE_RETENTION_MAX_BATCHES", 20),
    }).catch((error: unknown) => {
      console.error("[sync-retention] release_gate_pass_failed", {
        message: error instanceof Error ? error.message : String(error),
      });
      return null;
    });

    // Lineage collapse progress and config forward-growth truth. Neither
    // deletes; both are bounded and resumable, and the collapse only stamps
    // keepers when the destructive lane is on.
    const storageContainment = await runStorageContainmentPass().catch(
      (error: unknown) => {
        console.error("[sync-retention] storage_containment_failed", {
          message: error instanceof Error ? error.message : String(error),
        });
        return null;
      },
    );

    return emptyRetentionSummary({
      storageContainment,
      googleRawSnapshotsDeleted,
      googleCheckpointsDeleted,
      metaRawSnapshotsDeleted,
      metaRawSnapshotObservationsDeleted,
      shopifyRawSnapshotsDeleted,
      shopifyRawSnapshotObservationsDeleted,
      metaCheckpointsDeleted,
      workerHeartbeatsDeleted,
      reclaimEventsDeleted,
      ...(releaseGates
        ? {
            releaseGates: {
              mode: releaseGates.mode,
              batches: releaseGates.batches,
              examined: releaseGates.examined,
              candidates: releaseGates.candidates,
              deleted: releaseGates.deleted,
              completed: releaseGates.completed,
            },
          }
        : {}),
    });
  } finally {
    await releaseSyncRunnerLease({
      businessId: RETENTION_LEASE_BUSINESS_ID,
      providerScope: RETENTION_LEASE_PROVIDER_SCOPE,
      leaseOwner,
    }).catch(() => null);
  }
}
