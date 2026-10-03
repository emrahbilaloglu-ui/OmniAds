import type { DbClient } from "@/lib/db";

/** Read compatibility before a later reference-only writer release. R1 still
 * writes inline; adding this schema does not itself save storage or reclaim it. */
export const NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION = "native-campaign-context-jsonb.v1" as const;
export const NATIVE_CAMPAIGN_CONTEXT_OBJECTS_TABLE = "engine_v3_ad_campaign_context_objects" as const;
const IMMUTABILITY_BODY = `
BEGIN
  RAISE EXCEPTION 'Native campaign context objects are immutable; GC is not implemented'
    USING ERRCODE = '23514';
END;
`;

/** Tenant-bound and immutable. The digest is over PostgreSQL's original JSONB
 * text, independently of all decision/input/context hashes. No GC/reverse index.
 * The new nullable column has no default and does not rewrite old evaluations.
 * R1 deliberately retains campaign_context_json NOT NULL for the old image. */
export const NATIVE_CAMPAIGN_CONTEXT_STORAGE_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS engine_v3_ad_campaign_context_objects (
  business_ref_id UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  payload_sha256 BYTEA NOT NULL,
  storage_encoding_version TEXT NOT NULL,
  payload_json JSONB NOT NULL,
  byte_length INTEGER NOT NULL,
  created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT engine_v3_ad_campaign_objects_pkey PRIMARY KEY (business_ref_id, payload_sha256),
  CONSTRAINT engine_v3_ad_campaign_objects_digest_check CHECK (
    octet_length(payload_sha256) = 32 AND
    payload_sha256 = sha256(convert_to(payload_json::text, 'UTF8'))
  ),
  CONSTRAINT engine_v3_ad_campaign_objects_payload_check CHECK (
    jsonb_typeof(payload_json) = 'object' AND
    byte_length = octet_length(convert_to(payload_json::text, 'UTF8')) AND
    byte_length > 0 AND byte_length <= 1048576
  ),
  CONSTRAINT engine_v3_ad_campaign_objects_version_check CHECK (
    storage_encoding_version = '${NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION}'
  )
);

CREATE OR REPLACE FUNCTION refuse_native_campaign_context_object_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$${IMMUTABILITY_BODY}$$;

DO $$
BEGIN
  IF NOT EXISTS (SELECT 1 FROM pg_trigger WHERE
    tgrelid = 'engine_v3_ad_campaign_context_objects'::regclass
    AND tgname = 'engine_v3_ad_campaign_objects_immutable' AND NOT tgisinternal) THEN
    CREATE TRIGGER engine_v3_ad_campaign_objects_immutable
      BEFORE UPDATE OR DELETE ON engine_v3_ad_campaign_context_objects
      FOR EACH ROW EXECUTE FUNCTION refuse_native_campaign_context_object_mutation();
  END IF;
END
$$;

DO $$
DECLARE
  previous_lock_bound TEXT := current_setting('lock_timeout');
BEGIN
  -- The hot evaluation-table lock must not inherit the wider migration bound.
  -- All DDL still runs on the caller's pinned transaction and outer deadline.
  PERFORM set_config('lock_timeout', '500ms', true);
  IF to_regclass('engine_v3_ad_decision_evaluations') IS NOT NULL THEN
  -- ADD COLUMN IF NOT EXISTS still takes ACCESS EXCLUSIVE on every repeat.
  -- Inspect metadata first; only the first actual addition takes that lock.
  IF NOT EXISTS (SELECT 1 FROM pg_attribute WHERE
    attrelid = 'engine_v3_ad_decision_evaluations'::regclass
    AND attname = 'campaign_context_ref' AND NOT attisdropped) THEN
    ALTER TABLE engine_v3_ad_decision_evaluations ADD COLUMN campaign_context_ref BYTEA;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conrelid = 'engine_v3_ad_decision_evaluations'::regclass
    AND conname = 'engine_v3_ad_evaluations_campaign_storage_check') THEN
    ALTER TABLE engine_v3_ad_decision_evaluations ADD CONSTRAINT
      engine_v3_ad_evaluations_campaign_storage_check CHECK (
        (campaign_context_json IS NULL) <> (campaign_context_ref IS NULL)
      ) NOT VALID;
  END IF;
  IF NOT EXISTS (SELECT 1 FROM pg_constraint WHERE
    conrelid = 'engine_v3_ad_decision_evaluations'::regclass
    AND conname = 'engine_v3_ad_evaluations_campaign_object_fk') THEN
    ALTER TABLE engine_v3_ad_decision_evaluations ADD CONSTRAINT
      engine_v3_ad_evaluations_campaign_object_fk FOREIGN KEY (
        business_ref_id, campaign_context_ref
      ) REFERENCES engine_v3_ad_campaign_context_objects (
        business_ref_id, payload_sha256
      ) ON DELETE RESTRICT NOT VALID;
  END IF;
  END IF;
  PERFORM set_config('lock_timeout', previous_lock_bound, true);
END
$$
`;

/** Catalog proof, not a mutation probe on a live object. Reject a disabled or
 * same-named impostor trigger/function before reporting schema capability. */
export async function inspectNativeCampaignContextImmutability(db: Pick<DbClient, "query">): Promise<boolean> {
  const rows = await db.query<{ enabled: string; trigger_type: number; function_name: string;
    function_source: string; security_definer: boolean; function_result: string }>(`
    SELECT trigger_row.tgenabled::text AS enabled, trigger_row.tgtype::integer AS trigger_type,
      fn.proname::text AS function_name, fn.prosrc AS function_source,
      fn.prosecdef AS security_definer, pg_get_function_result(fn.oid) AS function_result
    FROM pg_trigger trigger_row
    JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace_row ON namespace_row.oid = relation.relnamespace
    JOIN pg_proc fn ON fn.oid = trigger_row.tgfoid
    WHERE namespace_row.nspname = current_schema()
      AND relation.relname = 'engine_v3_ad_campaign_context_objects'
      AND trigger_row.tgname = 'engine_v3_ad_campaign_objects_immutable'
      AND NOT trigger_row.tgisinternal
  `);
  const row = rows[0];
  return rows.length === 1 && row?.enabled === "O" && row.trigger_type === 27 &&
    row.function_name === "refuse_native_campaign_context_object_mutation" &&
    row.function_source.trim() === IMMUTABILITY_BODY.trim() &&
    row.security_definer === false && row.function_result === "trigger";
}

/** The sole active native read expression. Both representations populated,
 * neither populated, missing objects, wrong tenant and unknown versions yield
 * NULL and must be refused by the existing object validators, never '{}'. */
export function nativeCampaignContextSql(alias: string): string {
  if (!/^[a-z_][a-z0-9_]*$/.test(alias)) throw new Error("Invalid native evaluation SQL alias");
  return `(CASE
    WHEN ${alias}.campaign_context_ref IS NULL THEN ${alias}.campaign_context_json
    WHEN ${alias}.campaign_context_json IS NULL THEN (
      SELECT campaign_object.payload_json
      FROM engine_v3_ad_campaign_context_objects campaign_object
      WHERE campaign_object.business_ref_id = ${alias}.business_ref_id
        AND campaign_object.payload_sha256 = ${alias}.campaign_context_ref
        AND campaign_object.storage_encoding_version = '${NATIVE_CAMPAIGN_CONTEXT_STORAGE_VERSION}'
    )
    ELSE NULL
  END)`;
}

export function requireNativeCampaignContext(value: unknown): Record<string, unknown> {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    throw new Error("Native campaign context storage unavailable or inconsistent");
  }
  return value as Record<string, unknown>;
}

/** Original inline v1 archives remain byte-exact. A reference-only row needs a
 * separately versioned archive with its shared objects and restore membership;
 * the current five/seven-table contracts must refuse it rather than drop roots. */
export function assertInlineCampaignContextArchiveRow(row: Record<string, unknown>): void {
  if (row.campaign_context_ref !== null && row.campaign_context_ref !== undefined) {
    throw new Error("Native archive refused: referenced campaign context needs a new archive contract");
  }
}
