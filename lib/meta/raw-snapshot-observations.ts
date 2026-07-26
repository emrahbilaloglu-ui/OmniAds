import { getDb } from "@/lib/db";

/**
 * Point-in-time reads over the two-layer raw-snapshot model.
 *
 * Canonical content rows are shared across observations, so `fetched_at` on the
 * content row answers "when was this content FIRST seen" — not "what did we
 * hold at time T". Reconstructing an arbitrary point in time therefore has to
 * come from the observation timeline, not from the content row.
 *
 * Legacy compatibility is additive rather than a migration: rows written before
 * this model have no receipts, and a row with no receipts is read as a single
 * self-observation at its own `fetched_at`. That is exactly what it was, so the
 * union below is read-equivalent for old data while new data gains a real
 * timeline. No legacy row is rewritten or reinterpreted.
 */

export const RAW_SNAPSHOT_OBSERVATION_TIMELINE_SQL = `
  SELECT
    observation.snapshot_id,
    observation.business_id,
    observation.provider_account_id,
    observation.endpoint_name,
    observation.entity_scope,
    observation.status,
    observation.partition_id::uuid AS partition_id,
    observation.run_id::text AS run_id,
    observation.observed_at,
    observation.last_observed_at,
    FALSE AS legacy_self_observation
  FROM meta_raw_snapshot_observations observation
  UNION ALL
  SELECT
    snapshot.id AS snapshot_id,
    snapshot.business_id,
    snapshot.provider_account_id,
    snapshot.endpoint_name,
    snapshot.entity_scope,
    snapshot.status,
    snapshot.partition_id::uuid AS partition_id,
    snapshot.run_id::text AS run_id,
    snapshot.fetched_at AS observed_at,
    COALESCE(snapshot.last_observed_at, snapshot.fetched_at) AS last_observed_at,
    TRUE AS legacy_self_observation
  FROM meta_raw_snapshots snapshot
  WHERE NOT EXISTS (
    SELECT 1
    FROM meta_raw_snapshot_observations observation
    WHERE observation.snapshot_id = snapshot.id
  )
`;

export interface MetaRawSnapshotAtPointInTime {
  snapshotId: string;
  payloadHash: string;
  observedAt: string;
  status: string;
  partitionId: string | null;
  legacySelfObservation: boolean;
}

/**
 * What was most recently observed at or before `asOf`, for one scope.
 *
 * This is the A→B→A reader: with A observed at t1, B at t2 and A again at t3,
 * asking as-of t3 must return A — which is only correct if the answer comes
 * from the observation timeline. Reading the canonical row's `fetched_at`
 * instead would return B, because A's canonical row is older than B's.
 */
export async function readMetaRawSnapshotAsOf(input: {
  businessId: string;
  providerAccountId: string;
  endpointName: string;
  entityScope?: string | null;
  asOf: string;
  status?: string;
}): Promise<MetaRawSnapshotAtPointInTime | null> {
  const sql = getDb();
  const rows = (await sql.query(
    `
    WITH timeline AS (${RAW_SNAPSHOT_OBSERVATION_TIMELINE_SQL})
    SELECT
      timeline.snapshot_id::text AS snapshot_id,
      snapshot.payload_hash,
      timeline.observed_at::text AS observed_at,
      timeline.status,
      timeline.partition_id::text AS partition_id,
      timeline.legacy_self_observation
    FROM timeline
    JOIN meta_raw_snapshots snapshot ON snapshot.id = timeline.snapshot_id
    WHERE timeline.business_id = $1
      AND timeline.provider_account_id = $2
      AND timeline.endpoint_name = $3
      AND ($4::text IS NULL OR timeline.entity_scope = $4)
      AND ($6::text IS NULL OR timeline.status = $6)
      AND timeline.observed_at <= $5::timestamptz
    ORDER BY timeline.observed_at DESC, timeline.snapshot_id DESC
    LIMIT 1
  `,
    [
      input.businessId,
      input.providerAccountId,
      input.endpointName,
      input.entityScope ?? null,
      input.asOf,
      input.status ?? null,
    ],
  )) as Array<{
    snapshot_id: string;
    payload_hash: string;
    observed_at: string;
    status: string;
    partition_id: string | null;
    legacy_self_observation: boolean;
  }>;
  const row = rows[0];
  if (!row) return null;
  return {
    snapshotId: row.snapshot_id,
    payloadHash: row.payload_hash,
    observedAt: row.observed_at,
    status: row.status,
    partitionId: row.partition_id,
    legacySelfObservation: Boolean(row.legacy_self_observation),
  };
}

/**
 * Every receipt for one partition. This is the per-partition completion
 * evidence that content sharing must not destroy: after two partitions observe
 * identical content, each still has its own receipt against the one canonical
 * row.
 */
export async function readMetaRawSnapshotReceiptsForPartition(input: {
  partitionId: string;
}): Promise<
  Array<{
    snapshotId: string;
    endpointName: string;
    status: string;
    observedAt: string;
    observationCount: number;
  }>
> {
  const sql = getDb();
  const rows = (await sql.query(
    `SELECT snapshot_id::text AS snapshot_id, endpoint_name, status,
            observed_at::text AS observed_at, observation_count
     FROM meta_raw_snapshot_observations
     WHERE partition_id = $1::uuid
     ORDER BY observed_at, id`,
    [input.partitionId],
  )) as Array<{
    snapshot_id: string;
    endpoint_name: string;
    status: string;
    observed_at: string;
    observation_count: number;
  }>;
  return rows.map((row) => ({
    snapshotId: row.snapshot_id,
    endpointName: row.endpoint_name,
    status: row.status,
    observedAt: row.observed_at,
    observationCount: Number(row.observation_count),
  }));
}
