import type { DbClient } from "@/lib/db";
import {
  NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION,
  requireNativeCampaignContext,
} from "./native-campaign-context-storage";

/** Storage-only opt-in. It neither changes canonical identity nor grants any
 * provider authority. R1 must already be live before this is activated. */
export function nativeCampaignContextReferenceWritesEnabled(): boolean {
  return process.env.ENGINE_V3_NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITES_ENABLED === "true";
}

/** Metadata-only R2 upgrade. The preceding R1 schema installs the immutable
 * roots and new-row XOR/FK; the same pinned transaction verifies them before
 * commit. No old row is rewritten, and a repeated upgrade avoids ALTER. */
export const NATIVE_CAMPAIGN_CONTEXT_REFERENCE_WRITER_SCHEMA_SQL = `
DO $$
DECLARE
  previous_lock_bound TEXT := current_setting('lock_timeout');
BEGIN
  PERFORM set_config('lock_timeout', '500ms', true);
  IF EXISTS (SELECT 1 FROM pg_attribute WHERE
    attrelid = to_regclass('engine_v3_ad_decision_evaluations')
    AND attname = 'campaign_context_json' AND NOT attisdropped AND attnotnull) THEN
    IF to_regclass('engine_v3_ad_campaign_context_objects') IS NULL OR
      (SELECT count(*) FROM pg_constraint WHERE
        conrelid = 'engine_v3_ad_decision_evaluations'::regclass
        AND conname IN ('engine_v3_ad_evaluations_campaign_storage_check',
          'engine_v3_ad_evaluations_campaign_object_fk')) <> 2 THEN
      RAISE EXCEPTION 'Native campaign reference writer requires R1 XOR and tenant object FK';
    END IF;
    ALTER TABLE engine_v3_ad_decision_evaluations
      ALTER COLUMN campaign_context_json DROP NOT NULL;
  END IF;
  PERFORM set_config('lock_timeout', previous_lock_bound, true);
END
$$
`;

export const READ_NATIVE_CAMPAIGN_CONTEXT_WRITER_READY_QUERY = `
SELECT column_row.attnotnull = false AND column_row.atttypid = 'jsonb'::regtype
  AND ref_column.atttypid = 'bytea'::regtype AS reference_writer_ready
FROM pg_attribute column_row
JOIN pg_attribute ref_column ON ref_column.attrelid = column_row.attrelid
  AND ref_column.attname = 'campaign_context_ref' AND NOT ref_column.attisdropped
WHERE column_row.attrelid = to_regclass('engine_v3_ad_decision_evaluations')
  AND column_row.attname = 'campaign_context_json' AND NOT column_row.attisdropped
`;

/** Called after the full R1 capability check, before any producer INSERT. A
 * flag is not schema readiness; unknown/old metadata refuses the whole batch. */
export async function assertNativeCampaignContextReferenceWriterReady(db: Pick<DbClient, "query">): Promise<void> {
  const rows = await db.query<{ reference_writer_ready: boolean }>(READ_NATIVE_CAMPAIGN_CONTEXT_WRITER_READY_QUERY);
  if (rows.length !== 1 || rows[0]?.reference_writer_ready !== true) {
    throw new Error("Native campaign context reference writer schema not ready");
  }
}

export const INSERT_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY = `
WITH payload AS (
  SELECT business_ref_id, campaign_context_json
  FROM jsonb_to_recordset($1::jsonb) AS row(
    business_ref_id uuid, campaign_context_json jsonb
  )
)
INSERT INTO engine_v3_ad_campaign_context_objects (
  business_ref_id, payload_sha256, storage_encoding_version, payload_json, byte_length
)
SELECT DISTINCT business_ref_id,
  sha256(convert_to(campaign_context_json::text, 'UTF8')),
  '${NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION}', campaign_context_json,
  octet_length(convert_to(campaign_context_json::text, 'UTF8'))
FROM payload
ON CONFLICT DO NOTHING
`;

/** Resolve each original input ordinal separately. Both the tenant and exact
 * original PostgreSQL JSONB representation are checked after conflict no-op;
 * an existing hash identity cannot silently supply different content. */
export const READ_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY = `
WITH payload AS (
  SELECT ordinal, (value->>'business_ref_id')::uuid AS business_ref_id,
    value->'campaign_context_json' AS campaign_context_json
  FROM jsonb_array_elements($1::jsonb) WITH ORDINALITY AS input(value, ordinal)
)
SELECT payload.ordinal::integer AS ordinal,
  encode(sha256(convert_to(payload.campaign_context_json::text, 'UTF8')), 'hex') AS reference_hex,
  COALESCE(stored.storage_encoding_version = '${NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION}'
    AND stored.payload_json::text = payload.campaign_context_json::text
    AND stored.byte_length = octet_length(convert_to(payload.campaign_context_json::text, 'UTF8')),
    false) AS original_payload_matches
FROM payload
LEFT JOIN engine_v3_ad_campaign_context_objects stored
  ON stored.business_ref_id = payload.business_ref_id
 AND stored.payload_sha256 = sha256(convert_to(payload.campaign_context_json::text, 'UTF8'))
ORDER BY payload.ordinal
`;

/** The caller owns the same transaction as context/evidence/evaluation writes.
 * Do not retain inline shadows or update immutable objects on conflict. */
export async function persistNativeCampaignContextReferences(
  db: Pick<DbClient, "query">,
  inputs: ReadonlyArray<{ business_ref_id: string; campaign_context_json: unknown }>,
): Promise<string[]> {
  if (inputs.length === 0) return [];
  for (const input of inputs) requireNativeCampaignContext(input.campaign_context_json);
  const payload = JSON.stringify(inputs);
  await db.query(INSERT_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY, [payload]);
  const rows = await db.query<{ ordinal: number; reference_hex: string; original_payload_matches: boolean }>(
    READ_NATIVE_CAMPAIGN_CONTEXT_OBJECTS_QUERY, [payload],
  );
  const references = new Map<number, string>();
  for (const row of rows) {
    if (!Number.isInteger(row.ordinal) || row.ordinal < 1 || row.ordinal > inputs.length
      || references.has(row.ordinal) || row.original_payload_matches !== true
      || typeof row.reference_hex !== "string" || !/^[0-9a-f]{64}$/.test(row.reference_hex)) {
      throw new Error("Native campaign context object missing or original storage identity differs");
    }
    references.set(row.ordinal, row.reference_hex);
  }
  if (references.size !== inputs.length) {
    throw new Error("Native campaign context reference linkage incomplete");
  }
  return inputs.map((_, index) => references.get(index + 1)!);
}
