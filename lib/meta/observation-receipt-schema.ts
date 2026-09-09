/**
 * Additive receipt storage: the deployed image keeps its four-column arbiter;
 * this image stores every sync attempt separately. Mirrored rows share an id,
 * so the authority read includes each occurrence exactly once. Neither table
 * is copied, rewritten or deleted during migration or image rollback.
 */
export const META_OBSERVATION_RECEIPTS_V2_SCHEMA_SQL = `
  CREATE TABLE IF NOT EXISTS meta_entity_observation_receipts_v2 (
    id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
    receipt_contract TEXT NOT NULL DEFAULT 'd086.observation-capture-receipt.v1'
      CHECK (length(btrim(receipt_contract)) > 0),
    run_id UUID NOT NULL REFERENCES meta_entity_observation_runs(id) ON DELETE RESTRICT,
    business_id TEXT NOT NULL CHECK (length(btrim(business_id)) > 0),
    provider_account_id TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
    entity_type TEXT NOT NULL CHECK (entity_type IN ('campaign', 'adset', 'ad', 'creative')),
    endpoint TEXT NOT NULL CHECK (length(btrim(endpoint)) > 0),
    partition_id UUID NOT NULL CONSTRAINT meta_entity_observation_receipts_v2_partition_fk REFERENCES meta_sync_partitions(id) ON DELETE RESTRICT,
    source_snapshot_id TEXT,
    source_snapshot_ref_id UUID CONSTRAINT meta_entity_observation_receipts_v2_snapshot_fk REFERENCES meta_raw_snapshots(id) ON DELETE RESTRICT,
    sync_run_id UUID REFERENCES meta_sync_runs(id) ON DELETE RESTRICT,
    capture_status TEXT NOT NULL CHECK (capture_status IN ('complete', 'partial', 'point_lookup', 'failed')),
    provider_row_count INTEGER NOT NULL CHECK (provider_row_count >= 0),
    page_count INTEGER NOT NULL CHECK (page_count >= 0),
    run_reused BOOLEAN NOT NULL,
    observed_at TIMESTAMPTZ NOT NULL,
    captured_at TIMESTAMPTZ NOT NULL,
    error_json JSONB CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
    created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
    CONSTRAINT meta_entity_observation_receipts_v2_time_check CHECK (observed_at <= captured_at)
  )
`;

const RECEIPT_COLUMNS = [
  "id", "receipt_contract", "run_id", "business_id", "provider_account_id",
  "entity_type", "endpoint", "partition_id", "source_snapshot_id",
  "source_snapshot_ref_id", "sync_run_id", "capture_status", "provider_row_count",
  "page_count", "run_reused", "observed_at", "captured_at", "error_json", "created_at",
] as const;

export const META_OBSERVATION_RECEIPT_AUTHORITY_SQL = `
  SELECT ${RECEIPT_COLUMNS.map((column) => `attempt.${column}`).join(", ")}
    FROM meta_entity_observation_receipts_v2 attempt
  UNION ALL
  SELECT ${RECEIPT_COLUMNS.map((column) => `legacy.${column}`).join(", ")}
    FROM meta_entity_observation_receipts legacy
   WHERE NOT EXISTS (
     SELECT 1 FROM meta_entity_observation_receipts_v2 attempt WHERE attempt.id = legacy.id
   )
`;
