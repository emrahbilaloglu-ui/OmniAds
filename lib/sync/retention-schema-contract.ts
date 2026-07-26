const GOOGLE_SOURCE_SNAPSHOT_TABLES = [
  "google_ads_account_daily",
  "google_ads_campaign_daily",
  "google_ads_ad_group_daily",
  "google_ads_ad_daily",
  "google_ads_keyword_daily",
  "google_ads_search_term_daily",
  "google_ads_asset_group_daily",
  "google_ads_asset_daily",
  "google_ads_audience_daily",
  "google_ads_geo_daily",
  "google_ads_device_daily",
  "google_ads_product_daily",
  "google_ads_campaign_state_history",
  "google_ads_ad_group_state_history",
  "google_ads_search_query_hot_daily",
] as const;

const META_SOURCE_SNAPSHOT_TABLES = [
  "meta_account_daily",
  "meta_campaign_daily",
  "meta_adset_daily",
  "meta_ad_daily",
  "meta_creative_daily",
  "meta_breakdown_daily",
  "meta_campaign_config_history",
  "meta_adset_config_history",
] as const;

const META_SOURCE_RUN_TABLES = [
  "meta_account_daily",
  "meta_campaign_daily",
  "meta_adset_daily",
  "meta_ad_daily",
  "meta_creative_daily",
  "meta_breakdown_daily",
  "meta_creative_media",
] as const;

export interface SyncRetentionExecutionIndexSpec {
  name: string;
  table: string;
  accessMethod: "btree" | "gin";
  unique: boolean;
  /**
   * Canonical pg_catalog key definitions in index-key order. B-tree keys
   * declare direction and null placement explicitly so ASC/DESC drift cannot
   * hide behind PostgreSQL defaults.
   */
  keyDefinitions: readonly string[];
  /**
   * Canonical pg_get_expr(indpred, indrelid, true) output, or null when the
   * production index is intentionally not partial.
   */
  predicate: string | null;
}

function ascendingKey(definition: string) {
  return `${definition} ASC NULLS LAST`;
}

function descendingKey(definition: string) {
  return `${definition} DESC NULLS FIRST`;
}

function btreeIndex(
  name: string,
  table: string,
  keyDefinitions: readonly string[],
  predicate: string | null = null,
): SyncRetentionExecutionIndexSpec {
  return {
    name,
    table,
    accessMethod: "btree",
    unique: false,
    keyDefinitions,
    predicate,
  };
}

function ginIndex(
  name: string,
  table: string,
  keyDefinitions: readonly string[],
): SyncRetentionExecutionIndexSpec {
  return {
    name,
    table,
    accessMethod: "gin",
    unique: false,
    keyDefinitions,
    predicate: null,
  };
}

const ACTIVE_JOB_PREDICATE =
  "status = ANY (ARRAY['pending'::text, 'running'::text])";
const TERMINAL_RUN_PREDICATE =
  "finished_at IS NOT NULL AND (status = ANY (ARRAY['succeeded'::text, 'cancelled'::text, 'failed'::text]))";
const RETENTION_CLAIM_PREDICATE =
  "business_id = '__sync_retention__'::text AND provider = 'maintenance'::text AND report_type = 'lifecycle_retention'::text AND date_range_key = 'v1'::text";

export const SYNC_RETENTION_EXECUTION_INDEX_SPECS: readonly SyncRetentionExecutionIndexSpec[] =
  [
    btreeIndex(
      "idx_provider_sync_jobs_retention_due",
      "provider_sync_jobs",
      [ascendingKey("completed_at"), ascendingKey("triggered_at")],
      RETENTION_CLAIM_PREDICATE,
    ),
    btreeIndex(
      "idx_provider_sync_jobs_owner_expiry",
      "provider_sync_jobs",
      [ascendingKey("lock_owner"), ascendingKey("lock_expires_at")],
      "lock_owner IS NOT NULL",
    ),
    btreeIndex(
      "idx_google_ads_raw_snapshots_retention",
      "google_ads_raw_snapshots",
      [
        ascendingKey("fetched_at"),
        ascendingKey("id"),
        ascendingKey("partition_id"),
      ],
    ),
    btreeIndex("idx_meta_raw_snapshots_retention", "meta_raw_snapshots", [
      ascendingKey("fetched_at"),
      ascendingKey("id"),
      ascendingKey("partition_id"),
    ]),
    // Receipts are aged out before canonical content, so this target is part of
    // the same destructive path and belongs under the same fail-closed
    // contract. Without an ordered scan index the sweep degrades to a
    // sequential read of the whole observation relation.
    btreeIndex(
      "idx_meta_raw_snapshot_observations_retention",
      "meta_raw_snapshot_observations",
      [ascendingKey("observed_at"), ascendingKey("id")],
    ),
    btreeIndex(
      "idx_shopify_raw_snapshot_observations_retention",
      "shopify_raw_snapshot_observations",
      [ascendingKey("observed_at"), ascendingKey("id")],
    ),
    // The Shopify CONTENT sweep, which had no declared index at all: the sweep
    // deleted from this relation while the contract said nothing about it.
    btreeIndex("idx_shopify_raw_snapshots_retention", "shopify_raw_snapshots", [
      ascendingKey("fetched_at"),
      ascendingKey("id"),
    ]),
    ginIndex(
      "idx_google_ads_sync_checkpoints_raw_snapshot_ids",
      "google_ads_sync_checkpoints",
      ["raw_snapshot_ids"],
    ),
    btreeIndex(
      "idx_sync_worker_heartbeats_retention",
      "sync_worker_heartbeats",
      [ascendingKey("last_heartbeat_at"), ascendingKey("worker_id")],
    ),
    btreeIndex(
      "idx_sync_worker_heartbeats_partition_activity",
      "sync_worker_heartbeats",
      [ascendingKey("last_partition_id"), descendingKey("last_heartbeat_at")],
      "last_partition_id IS NOT NULL",
    ),
    btreeIndex("idx_sync_reclaim_events_retention", "sync_reclaim_events", [
      ascendingKey("created_at"),
      ascendingKey("id"),
    ]),
    btreeIndex(
      "idx_sync_runtime_instances_retention",
      "sync_runtime_instances",
      [
        ascendingKey("last_seen_at"),
        ascendingKey("build_id"),
        ascendingKey("service"),
        ascendingKey("instance_id"),
      ],
    ),
    // NOTE: `shopify_sync_execution_receipts` is deliberately absent. Its
    // sweep does not exist here, and neither does the relation, so declaring
    // an index for it would leave the gate permanently closed — which is not
    // fail-closed, it is never-open, and a gate that can never pass carries no
    // signal about real drift. `assertSyncRetentionExecutionSpecsAreResolvable`
    // is what keeps this from being reintroduced by accident.
    btreeIndex(
      "idx_sync_runner_leases_owner_expiry",
      "sync_runner_leases",
      [ascendingKey("lease_owner"), ascendingKey("lease_expires_at")],
      "lease_owner IS NOT NULL",
    ),
    btreeIndex(
      "idx_google_ads_runner_leases_owner_expiry",
      "google_ads_runner_leases",
      [ascendingKey("lease_owner"), ascendingKey("lease_expires_at")],
      "lease_owner IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_sync_partitions_owner_expiry",
      "meta_sync_partitions",
      [ascendingKey("lease_owner"), ascendingKey("lease_expires_at")],
      "lease_owner IS NOT NULL",
    ),
    btreeIndex(
      "idx_google_ads_sync_partitions_owner_expiry",
      "google_ads_sync_partitions",
      [ascendingKey("lease_owner"), ascendingKey("lease_expires_at")],
      "lease_owner IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_sync_checkpoints_owner_expiry",
      "meta_sync_checkpoints",
      [ascendingKey("lease_owner"), ascendingKey("lease_expires_at")],
      "lease_owner IS NOT NULL",
    ),
    btreeIndex(
      "idx_google_ads_sync_checkpoints_owner_expiry",
      "google_ads_sync_checkpoints",
      [ascendingKey("lease_owner"), ascendingKey("lease_expires_at")],
      "lease_owner IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_sync_runs_worker_status",
      "meta_sync_runs",
      [ascendingKey("worker_id"), ascendingKey("status")],
      "worker_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_google_ads_sync_runs_worker_status",
      "google_ads_sync_runs",
      [ascendingKey("worker_id"), ascendingKey("status")],
      "worker_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_sync_runs_retention",
      "meta_sync_runs",
      [
        ascendingKey("status"),
        ascendingKey("updated_at"),
        ascendingKey("id"),
        ascendingKey("partition_id"),
      ],
      TERMINAL_RUN_PREDICATE,
    ),
    btreeIndex(
      "idx_google_ads_sync_runs_retention",
      "google_ads_sync_runs",
      [
        ascendingKey("status"),
        ascendingKey("updated_at"),
        ascendingKey("id"),
        ascendingKey("partition_id"),
      ],
      TERMINAL_RUN_PREDICATE,
    ),
    btreeIndex(
      "idx_meta_sync_runs_partition_updated_retention",
      "meta_sync_runs",
      [
        ascendingKey("partition_id"),
        descendingKey("updated_at"),
        descendingKey("id"),
      ],
    ),
    btreeIndex(
      "idx_google_ads_sync_runs_partition_updated_retention",
      "google_ads_sync_runs",
      [
        ascendingKey("partition_id"),
        descendingKey("updated_at"),
        descendingKey("id"),
      ],
    ),
    btreeIndex(
      "idx_meta_sync_jobs_retention_active",
      "meta_sync_jobs",
      [
        ascendingKey("business_id"),
        ascendingKey("provider_account_id"),
        ascendingKey("scope"),
        ascendingKey("start_date"),
        ascendingKey("end_date"),
      ],
      ACTIVE_JOB_PREDICATE,
    ),
    btreeIndex(
      "idx_google_ads_sync_jobs_retention_active",
      "google_ads_sync_jobs",
      [
        ascendingKey("business_id"),
        ascendingKey("provider_account_id"),
        ascendingKey("scope"),
        ascendingKey("start_date"),
        ascendingKey("end_date"),
      ],
      ACTIVE_JOB_PREDICATE,
    ),
    btreeIndex(
      "idx_meta_raw_snapshots_run_retention",
      "meta_raw_snapshots",
      [ascendingKey("run_id")],
      "run_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_sync_checkpoints_run_retention",
      "meta_sync_checkpoints",
      [ascendingKey("run_id")],
      "run_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_sync_phase_timings_run_retention",
      "meta_sync_phase_timings",
      [ascendingKey("run_id")],
      "run_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_authoritative_source_manifests_run",
      "meta_authoritative_source_manifests",
      [ascendingKey("run_id"), descendingKey("created_at")],
    ),
    btreeIndex(
      "idx_meta_source_manifests_raw_watermark",
      "meta_authoritative_source_manifests",
      [ascendingKey("raw_snapshot_watermark")],
      "raw_snapshot_watermark IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_authoritative_day_state_last_run",
      "meta_authoritative_day_state",
      [ascendingKey("last_run_id")],
      "last_run_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_authoritative_day_state_active_partition",
      "meta_authoritative_day_state",
      [ascendingKey("active_partition_id")],
      "active_partition_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_authoritative_slice_versions_source_run_retention",
      "meta_authoritative_slice_versions",
      [ascendingKey("source_run_id")],
      "source_run_id IS NOT NULL",
    ),
    btreeIndex(
      "idx_meta_authoritative_publication_pointers_run_retention",
      "meta_authoritative_publication_pointers",
      [ascendingKey("published_by_run_id")],
      "published_by_run_id IS NOT NULL",
    ),
    ...GOOGLE_SOURCE_SNAPSHOT_TABLES.map((table) =>
      btreeIndex(
        `idx_${table}_source_snapshot_retention`,
        table,
        [ascendingKey("source_snapshot_id")],
        "source_snapshot_id IS NOT NULL",
      ),
    ),
    ...META_SOURCE_SNAPSHOT_TABLES.map((table) =>
      btreeIndex(
        `idx_${table}_source_snapshot_retention`,
        table,
        [ascendingKey("source_snapshot_id")],
        "source_snapshot_id IS NOT NULL",
      ),
    ),
    ...META_SOURCE_RUN_TABLES.map((table) =>
      btreeIndex(
        `idx_${table}_source_run_retention`,
        table,
        [ascendingKey("source_run_id")],
        "source_run_id IS NOT NULL",
      ),
    ),
  ];

export const SYNC_RETENTION_EXECUTION_COLUMN_SPECS = [
  {
    table: "provider_sync_jobs",
    column: "progress_json",
  },
] as const;
