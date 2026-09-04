import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import {
  INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY,
  persistImmutableAdOperatorActionReceipt,
} from "@/lib/meta/ads-action-log";
import {
  NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION,
  NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION,
  NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
  AD_OPERATOR_RESPONSE_WINDOW_DAYS,
  buildAdRecommendationEpisode,
  detectAdOperatorResponse,
  resolveAdOperatorResponseWindow,
  type AdEntityStateObservation,
  type AdEntityTombstoneObservation,
  type AdOperatorActionSemantic,
  type AdOperatorResponseResult,
  type AdOperatorTargetEntityType,
  type AdRecommendationEpisode,
  type ExactMetaAdsActionLineage,
} from "../ad-operator-response-detection";
import { canonicalSha256 } from "../canonical-evaluation";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "../execution-safety";
import { NATIVE_AD_ENGINE_VERSION } from "../types";
import { hashAdvisoryLock } from "./calibration-job";
import { ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS } from "./job-runtime";

export {
  INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY,
  persistImmutableAdOperatorActionReceipt,
};

export const AD_OPERATOR_RESPONSE_JOB_NAME =
  "engine_v3_native_ad_operator_response_shadow_job";

/**
 * The immediately preceding production image still inspects this literal in
 * operator-response constraints. Keep it in generalized constraint text so a
 * database migrated by this image remains readable by that rollback image.
 */
export const NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION =
  "v3-ad-2026-07-15-commercial-stop-loss-shadow";

export const AD_RECOMMENDATION_EPISODES_TABLE =
  "engine_v3_ad_recommendation_episodes";
export const AD_OPERATOR_ACTION_RECEIPTS_TABLE =
  "engine_v3_ad_operator_action_receipts";
export const AD_OPERATOR_RESPONSE_EVENTS_TABLE =
  "engine_v3_ad_operator_response_events";
export const AD_OPERATOR_RESPONSES_TABLE = "engine_v3_ad_operator_responses";

export const AD_OPERATOR_DELIVERY_FIELD_KEY =
  "operator_response_delivery_v1" as const;

export const AD_OPERATOR_RESPONSE_PRODUCER_DEPENDENCIES = [
  "Run this job immediately after each native-ad snapshot materialization so the mutable snapshot row is frozen as an immutable snapshot/evaluation episode.",
  `Every terminal action must synchronously materialize one immutable ${AD_OPERATOR_ACTION_RECEIPTS_TABLE} row; the detector never reads mutable meta_ads_action_log payload text.`,
  "Decision-origin pause/resume receipts must bind physical business/account references, ad, snapshot, evaluation, native epoch, decision hash, idempotency, dry-run, and provider verification.",
  `Duplicate/rebuild and campaign/adset budget-owner receipts must emit ${NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION} with explicit source_ad_id, target_entity_type, target_entity_id, and operator_action fields.`,
  `Natural cessation requires meta_entity_state_history.field_coverage_json.${AD_OPERATOR_DELIVERY_FIELD_KEY} using ${NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION}; current status-only rows cannot prove cessation.`,
  `No-response requires a closed ${AD_OPERATOR_RESPONSE_WINDOW_DAYS}-day window plus complete start/end state runs for the exact ad, campaign, and adset. Empty arrays alone remain unknown_incomplete.`,
  "The read model must consume only the parallel response tables and must never join creative_id as identity.",
] as const;

/** Exact migration input for the existing executor journal. Not scheduled/applied here. */
export const AD_OPERATOR_RESPONSE_ACTION_LOG_SCHEMA_SQL = `
ALTER TABLE meta_ads_action_log
  ADD COLUMN decision_contract_version text NULL,
  ADD COLUMN provider_account_ref_id uuid NULL,
  ADD COLUMN provider_account_id text NULL,
  ADD COLUMN decision_episode_key char(64) NULL,
  ADD COLUMN decision_snapshot_id uuid NULL,
  ADD COLUMN decision_evaluation_id uuid NULL,
  ADD COLUMN decision_engine_version text NULL,
  ADD COLUMN decision_hash char(64) NULL,
  ADD COLUMN idempotency_key text NULL,
  ADD COLUMN dry_run boolean NOT NULL DEFAULT false,
  ADD COLUMN provider_verified boolean NOT NULL DEFAULT false,
  ADD COLUMN verification_entity_id text NULL,
  ADD COLUMN verification_status text NULL,
  ADD COLUMN terminal_finalized_at timestamptz NULL,
  ADD COLUMN verification_entity_id_key text GENERATED ALWAYS AS (
    COALESCE(verification_entity_id, '')
  ) STORED NOT NULL,
  ADD COLUMN verification_status_key text GENERATED ALWAYS AS (
    COALESCE(verification_status, '')
  ) STORED NOT NULL,
  ADD COLUMN verified_at_key timestamptz GENERATED ALWAYS AS (
    COALESCE(verified_at, '-infinity'::timestamptz)
  ) STORED NOT NULL,
  ADD CONSTRAINT meta_ads_action_log_decision_origin_typed_check CHECK (
    source <> 'decision_origin' OR (
      decision_contract_version =
        '${DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION}' AND
      provider_account_ref_id IS NOT NULL AND provider_account_id IS NOT NULL AND
      decision_episode_key IS NOT NULL AND decision_snapshot_id IS NOT NULL AND
      decision_evaluation_id IS NOT NULL AND
      decision_engine_version IS NOT NULL AND
      length(btrim(decision_engine_version)) > 0 AND
      (
        decision_engine_version = '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}' OR
        decision_engine_version <> '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
      ) AND
      decision_hash ~ '^[0-9a-f]{64}$' AND idempotency_key IS NOT NULL AND
      action IN ('pause', 'resume') AND
      ((status = 'pending' AND terminal_finalized_at IS NULL AND
        provider_verified = false AND verified_at IS NULL) OR
       (status <> 'pending' AND terminal_finalized_at IS NOT NULL)) AND
      (NOT provider_verified OR (
        status = 'success' AND NOT dry_run AND verified_at IS NOT NULL AND
        verification_entity_id = ad_id AND verification_status IS NOT NULL
      ))
    )
  );

CREATE UNIQUE INDEX meta_ads_action_log_decision_idempotency_unique
  ON meta_ads_action_log (business_id, idempotency_key)
  WHERE source = 'decision_origin';
`;

export const AD_OPERATOR_RESPONSE_EPOCH_COMPATIBILITY_SQL = `
DO $native_operator_epoch_compatibility$
BEGIN
  IF to_regclass('meta_ads_action_log') IS NOT NULL
    AND NOT EXISTS (
      SELECT required.column_name
      FROM unnest(ARRAY[
        'decision_contract_version', 'provider_account_ref_id',
        'provider_account_id', 'decision_episode_key',
        'decision_snapshot_id', 'decision_evaluation_id',
        'decision_engine_version', 'decision_hash', 'idempotency_key',
        'dry_run', 'provider_verified', 'verification_entity_id',
        'verification_status', 'terminal_finalized_at'
      ]::text[]) AS required(column_name)
      WHERE NOT EXISTS (
        SELECT 1
        FROM information_schema.columns existing
        WHERE existing.table_schema = current_schema()
          AND existing.table_name = 'meta_ads_action_log'
          AND existing.column_name = required.column_name
      )
    )
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('meta_ads_action_log')
        AND conname = 'meta_ads_action_log_decision_origin_typed_check'
        AND position(
          'length(btrim(decision_engine_version))'
          IN replace(lower(pg_get_constraintdef(oid, true)), ' ', '')
        ) > 0
        AND position(
          'decision_engine_versionisnotnull'
          IN replace(lower(pg_get_constraintdef(oid, true)), ' ', '')
        ) > 0
        AND position(
          '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
          IN lower(pg_get_constraintdef(oid, true))
        ) > 0
    )
  THEN
    ALTER TABLE meta_ads_action_log
      DROP CONSTRAINT IF EXISTS meta_ads_action_log_decision_origin_typed_check;
    ALTER TABLE meta_ads_action_log
      ADD CONSTRAINT meta_ads_action_log_decision_origin_typed_check CHECK (
        source <> 'decision_origin' OR (
          decision_contract_version =
            '${DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION}' AND
          provider_account_ref_id IS NOT NULL AND
          provider_account_id IS NOT NULL AND
          decision_episode_key IS NOT NULL AND
          decision_snapshot_id IS NOT NULL AND
          decision_evaluation_id IS NOT NULL AND
          decision_engine_version IS NOT NULL AND
          length(btrim(decision_engine_version)) > 0 AND
          (
            decision_engine_version = '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}' OR
            decision_engine_version <> '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
          ) AND
          decision_hash ~ '^[0-9a-f]{64}$' AND
          idempotency_key IS NOT NULL AND
          action IN ('pause', 'resume') AND
          ((status = 'pending' AND terminal_finalized_at IS NULL AND
            provider_verified = false AND verified_at IS NULL) OR
           (status <> 'pending' AND terminal_finalized_at IS NOT NULL)) AND
          (NOT provider_verified OR (
            status = 'success' AND NOT dry_run AND verified_at IS NOT NULL AND
            verification_entity_id = ad_id AND
            verification_status IS NOT NULL
          ))
        )
      );
  END IF;

  IF to_regclass('engine_v3_ad_recommendation_episodes') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('engine_v3_ad_recommendation_episodes')
        AND conname = 'engine_v3_ad_response_episode_native_epoch_check'
        AND position(
          'length(btrim(engine_version))'
          IN replace(lower(pg_get_constraintdef(oid, true)), ' ', '')
        ) > 0
        AND position(
          '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
          IN lower(pg_get_constraintdef(oid, true))
        ) > 0
    )
  THEN
    ALTER TABLE engine_v3_ad_recommendation_episodes
      DROP CONSTRAINT IF EXISTS engine_v3_ad_response_episode_native_epoch_check;
    ALTER TABLE engine_v3_ad_recommendation_episodes
      ADD CONSTRAINT engine_v3_ad_response_episode_native_epoch_check
      CHECK (
        length(btrim(engine_version)) > 0 AND (
          engine_version = '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}' OR
          engine_version <> '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
        )
      );
  END IF;

  IF to_regclass('engine_v3_ad_operator_action_receipts') IS NOT NULL
  THEN
    ALTER TABLE engine_v3_ad_operator_action_receipts
      ADD COLUMN IF NOT EXISTS verification_lineage jsonb NULL
      CHECK (
        verification_lineage IS NULL OR
        jsonb_typeof(verification_lineage) = 'object'
      );
  END IF;

  IF to_regclass('engine_v3_ad_operator_action_receipts') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('engine_v3_ad_operator_action_receipts')
        AND conname = 'engine_v3_ad_action_receipt_verification_check'
        AND position(
          'verification_lineage'
          IN lower(pg_get_constraintdef(oid, true))
        ) > 0
    )
  THEN
    ALTER TABLE engine_v3_ad_operator_action_receipts
      DROP CONSTRAINT IF EXISTS engine_v3_ad_action_receipt_verification_check;
    ALTER TABLE engine_v3_ad_operator_action_receipts
      ADD CONSTRAINT engine_v3_ad_action_receipt_verification_check CHECK (
        NOT provider_verified OR (
          action_status = 'success' AND NOT dry_run AND
          verified_at IS NOT NULL AND verification_entity_id = source_ad_id AND
          (
            verification_lineage IS NULL OR (
              NULLIF(verification_lineage->>'sourceCreativeId', '') IS NOT NULL AND
              NULLIF(verification_lineage->>'sourceCampaignId', '') IS NOT NULL AND
              NULLIF(verification_lineage->>'sourceAdsetId', '') IS NOT NULL AND
              verification_lineage->>'verifiedProviderAccountId' =
                provider_account_id AND
              verification_lineage->>'verifiedCreativeId' =
                verification_lineage->>'sourceCreativeId' AND
              verification_lineage->>'verifiedCampaignId' =
                verification_lineage->>'sourceCampaignId' AND
              verification_lineage->>'verifiedAdsetId' =
                verification_lineage->>'sourceAdsetId'
            )
          )
        )
      );
  END IF;

  IF to_regclass('engine_v3_ad_operator_action_receipts') IS NOT NULL
    AND NOT EXISTS (
      SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('engine_v3_ad_operator_action_receipts')
        AND conname = 'engine_v3_ad_action_receipt_source_epoch_check'
        AND position(
          'length(btrim(source_engine_version))'
          IN replace(lower(pg_get_constraintdef(oid, true)), ' ', '')
        ) > 0
        AND position(
          '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
          IN lower(pg_get_constraintdef(oid, true))
        ) > 0
    )
  THEN
    ALTER TABLE engine_v3_ad_operator_action_receipts
      DROP CONSTRAINT IF EXISTS engine_v3_ad_operator_action_receipts_source_engine_version_check;
    ALTER TABLE engine_v3_ad_operator_action_receipts
      DROP CONSTRAINT IF EXISTS engine_v3_ad_action_receipt_source_epoch_check;
    ALTER TABLE engine_v3_ad_operator_action_receipts
      ADD CONSTRAINT engine_v3_ad_action_receipt_source_epoch_check
      CHECK (
        length(btrim(source_engine_version)) > 0 AND (
          source_engine_version = '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}' OR
          source_engine_version <> '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
        )
      );
  END IF;
END
$native_operator_epoch_compatibility$;
`;

export const AD_OPERATOR_RESPONSE_SCHEMA_SQL = `
CREATE UNIQUE INDEX engine_v3_ad_snapshot_response_lineage_unique
  ON engine_v3_ad_decision_snapshots_daily (
    id, business_ref_id, business_id, provider_account_id,
    decision_entity_type, decision_entity_id, ad_id, as_of_date,
    engine_version, scope_type, scope_id, evaluation_id, input_hash,
    decision_hash
  );

CREATE UNIQUE INDEX meta_entity_state_response_lineage_unique
  ON meta_entity_state_history (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, entity_type, entity_id
  );

CREATE UNIQUE INDEX meta_entity_tombstone_response_lineage_unique
  ON meta_entity_tombstones (
    id, business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, entity_type, entity_id
  );

CREATE UNIQUE INDEX meta_ads_action_log_decision_terminal_lineage_unique
  ON meta_ads_action_log (
    id, business_id, provider_account_ref_id, provider_account_id, ad_id,
    action, status, provider_verified, verification_entity_id_key,
    verification_status_key, verified_at_key, decision_contract_version,
    decision_episode_key, decision_snapshot_id, decision_evaluation_id,
    decision_engine_version, decision_hash, idempotency_key, dry_run,
    terminal_finalized_at
  );

CREATE TABLE engine_v3_ad_recommendation_episodes (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version text NOT NULL
    CHECK (contract_version = '${NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION}'),
	  episode_key char(64) NOT NULL,
	  business_ref_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
	  business_id text NOT NULL,
	  provider_account_ref_id uuid NOT NULL,
	  provider_account_id text NOT NULL,
  decision_entity_type text NOT NULL CHECK (decision_entity_type = 'ad'),
  decision_entity_id text NOT NULL,
  ad_id text NOT NULL,
  creative_id text NULL,
  as_of_date date NOT NULL,
  engine_version text NOT NULL,
  scope_type text NOT NULL,
  scope_id text NOT NULL,
  decision_snapshot_id uuid NOT NULL,
  evaluation_id uuid NOT NULL,
  input_hash char(64) NOT NULL,
  decision_hash char(64) NOT NULL,
  decision_label text NOT NULL,
  source_campaign_id text NULL,
  source_adset_id text NULL,
  recommended_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
	  job_run_id uuid NOT NULL,
	  created_at timestamptz NOT NULL DEFAULT now(),
	  CONSTRAINT engine_v3_ad_response_episode_key_unique UNIQUE (episode_key),
	  CONSTRAINT engine_v3_ad_response_episode_lineage_unique UNIQUE (
	    episode_key, business_ref_id, business_id, provider_account_ref_id,
	    provider_account_id, ad_id, decision_snapshot_id, evaluation_id,
	    engine_version, decision_hash
	  ),
	  CONSTRAINT engine_v3_ad_response_episode_identity_unique UNIQUE (
	    episode_key, business_ref_id, business_id, provider_account_ref_id,
	    provider_account_id
	  ),
	  CONSTRAINT engine_v3_ad_response_episode_business_identity_check
	    CHECK (business_id = business_ref_id::text),
	  CONSTRAINT engine_v3_ad_response_episode_native_identity_check
	    CHECK (decision_entity_id = ad_id AND length(btrim(ad_id)) > 0),
	  CONSTRAINT engine_v3_ad_response_episode_native_epoch_check
	    CHECK (
	      length(btrim(engine_version)) > 0 AND (
	        engine_version = '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}' OR
	        engine_version <> '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
	      )
	    ),
	  CONSTRAINT engine_v3_ad_response_episode_job_run_fk
	    FOREIGN KEY (job_run_id) REFERENCES engine_v3_job_runs(id)
	    ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_episode_account_binding_fk
	    FOREIGN KEY (business_id, provider_account_ref_id, provider_account_id)
	    REFERENCES business_provider_accounts (
	      business_id, provider_account_ref_id, provider_account_id
	    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_episode_snapshot_fk
	    FOREIGN KEY (
	      decision_snapshot_id, business_ref_id, business_id,
	      provider_account_id, decision_entity_type, decision_entity_id,
	      ad_id, as_of_date, engine_version, scope_type, scope_id,
	      evaluation_id, input_hash, decision_hash
	    ) REFERENCES engine_v3_ad_decision_snapshots_daily (
	      id, business_ref_id, business_id, provider_account_id,
	      decision_entity_type, decision_entity_id, ad_id, as_of_date,
	      engine_version, scope_type, scope_id, evaluation_id, input_hash,
	      decision_hash
	    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_episode_evaluation_fk
    FOREIGN KEY (
      evaluation_id, business_ref_id, provider_account_id,
      decision_entity_type, decision_entity_id, ad_id, as_of_date,
      engine_version, scope_type, scope_id, input_hash, decision_hash
    ) REFERENCES engine_v3_ad_decision_evaluations (
      id, business_ref_id, provider_account_id, decision_entity_type,
      decision_entity_id, ad_id, as_of_date, engine_version, scope_type,
      scope_id, input_hash, decision_hash
    ) ON DELETE RESTRICT
);

CREATE INDEX engine_v3_ad_response_episode_timeline_idx
  ON engine_v3_ad_recommendation_episodes (
    business_ref_id, provider_account_id, ad_id, engine_version,
    recommended_at DESC
	  );

CREATE TABLE engine_v3_ad_operator_action_receipts (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  receipt_hash char(64) NOT NULL UNIQUE
    CHECK (receipt_hash ~ '^[0-9a-f]{64}$'),
  source_action_log_id uuid NOT NULL UNIQUE,
  contract_version text NOT NULL CHECK (contract_version IN (
    '${DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION}',
    '${NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION}'
  )),
  episode_key char(64) NOT NULL,
  business_ref_id uuid NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
  business_id text NOT NULL,
  provider_account_ref_id uuid NOT NULL,
  provider_account_id text NOT NULL,
  source_ad_id text NOT NULL,
  source_snapshot_id uuid NOT NULL,
  source_evaluation_id uuid NOT NULL,
  source_engine_version text NOT NULL,
  source_decision_hash char(64) NOT NULL
    CHECK (source_decision_hash ~ '^[0-9a-f]{64}$'),
  target_entity_type text NOT NULL
    CHECK (target_entity_type IN ('ad', 'adset', 'campaign')),
  target_entity_id text NOT NULL,
  operator_action text NOT NULL CHECK (operator_action IN (
    'pause', 'resume', 'duplicate', 'rebuild',
    'budget_increase', 'budget_decrease', 'budget_change'
  )),
  successor_kind text NULL CHECK (successor_kind IN ('duplicate', 'rebuild')),
  resulting_ad_id text NULL,
  idempotency_key text NOT NULL,
  action_status text NOT NULL
    CHECK (action_status IN ('success', 'failure', 'silent_failure')),
  dry_run boolean NOT NULL,
  provider_verified boolean NOT NULL,
  requested_at timestamptz NOT NULL,
  verified_at timestamptz NULL,
  finalized_at timestamptz NOT NULL,
  captured_at timestamptz NOT NULL,
  verification_entity_id text NULL,
  verification_status text NULL,
  verification_lineage jsonb NULL
    CHECK (
      verification_lineage IS NULL OR
      jsonb_typeof(verification_lineage) = 'object'
    ),
  verification_entity_id_key text GENERATED ALWAYS AS (
    COALESCE(verification_entity_id, '')
  ) STORED NOT NULL,
  verification_status_key text GENERATED ALWAYS AS (
    COALESCE(verification_status, '')
  ) STORED NOT NULL,
  verified_at_key timestamptz GENERATED ALWAYS AS (
    COALESCE(verified_at, '-infinity'::timestamptz)
  ) STORED NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
	  CONSTRAINT engine_v3_ad_action_receipt_identity_unique UNIQUE (
	    id, episode_key, business_ref_id, business_id,
	    provider_account_ref_id, provider_account_id, source_action_log_id
	  ),
	  CONSTRAINT engine_v3_ad_action_receipt_source_epoch_check
	    CHECK (
	      length(btrim(source_engine_version)) > 0 AND (
	        source_engine_version = '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}' OR
	        source_engine_version <> '${NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION}'
	      )
	    ),
	  CONSTRAINT engine_v3_ad_action_receipt_event_identity_unique UNIQUE (
	    id, episode_key, business_ref_id, business_id,
	    provider_account_ref_id, provider_account_id
	  ),
  CONSTRAINT engine_v3_ad_action_receipt_episode_lineage_fk
    FOREIGN KEY (
	      episode_key, business_ref_id, business_id, provider_account_ref_id,
	      provider_account_id, source_ad_id, source_snapshot_id,
      source_evaluation_id, source_engine_version, source_decision_hash
    ) REFERENCES engine_v3_ad_recommendation_episodes (
	      episode_key, business_ref_id, business_id, provider_account_ref_id,
	      provider_account_id, ad_id, decision_snapshot_id, evaluation_id,
      engine_version, decision_hash
    ) ON DELETE RESTRICT,
  CONSTRAINT engine_v3_ad_action_receipt_action_log_fk
    FOREIGN KEY (
      source_action_log_id, business_ref_id, provider_account_ref_id,
      provider_account_id, source_ad_id, operator_action, action_status,
      provider_verified, verification_entity_id_key,
      verification_status_key, verified_at_key, contract_version,
      episode_key, source_snapshot_id, source_evaluation_id,
      source_engine_version, source_decision_hash, idempotency_key, dry_run,
      finalized_at
    ) REFERENCES meta_ads_action_log (
      id, business_id, provider_account_ref_id, provider_account_id, ad_id,
      action, status, provider_verified, verification_entity_id_key,
      verification_status_key, verified_at_key, decision_contract_version,
      decision_episode_key, decision_snapshot_id, decision_evaluation_id,
      decision_engine_version, decision_hash, idempotency_key, dry_run,
      terminal_finalized_at
    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_action_receipt_account_binding_fk
	    FOREIGN KEY (business_id, provider_account_ref_id, provider_account_id)
	    REFERENCES business_provider_accounts (
	      business_id, provider_account_ref_id, provider_account_id
	    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_action_receipt_business_identity_check
	    CHECK (business_id = business_ref_id::text),
  CONSTRAINT engine_v3_ad_action_receipt_time_check CHECK (
    finalized_at >= requested_at AND captured_at >= finalized_at AND
    (verified_at IS NULL OR
      (verified_at >= requested_at AND finalized_at >= verified_at))
  ),
  CONSTRAINT engine_v3_ad_action_receipt_verification_check CHECK (
    NOT provider_verified OR (
      action_status = 'success' AND NOT dry_run AND verified_at IS NOT NULL AND
      verification_entity_id = source_ad_id AND
      (
        verification_lineage IS NULL OR (
          NULLIF(verification_lineage->>'sourceCreativeId', '') IS NOT NULL AND
          NULLIF(verification_lineage->>'sourceCampaignId', '') IS NOT NULL AND
          NULLIF(verification_lineage->>'sourceAdsetId', '') IS NOT NULL AND
          verification_lineage->>'verifiedProviderAccountId' =
            provider_account_id AND
          verification_lineage->>'verifiedCreativeId' =
            verification_lineage->>'sourceCreativeId' AND
          verification_lineage->>'verifiedCampaignId' =
            verification_lineage->>'sourceCampaignId' AND
          verification_lineage->>'verifiedAdsetId' =
            verification_lineage->>'sourceAdsetId'
        )
      )
    )
  ),
  CONSTRAINT engine_v3_ad_action_receipt_successor_check CHECK (
    (operator_action IN ('duplicate', 'rebuild') AND
      successor_kind = operator_action AND resulting_ad_id IS NOT NULL AND
      target_entity_type = 'ad' AND target_entity_id = resulting_ad_id) OR
    (operator_action NOT IN ('duplicate', 'rebuild') AND
      successor_kind IS NULL AND resulting_ad_id IS NULL)
  ),
  CONSTRAINT engine_v3_ad_action_receipt_contract_action_check CHECK (
    contract_version = '${NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION}' OR
    operator_action IN ('pause', 'resume')
  )
);

CREATE OR REPLACE FUNCTION reject_engine_v3_ad_operator_action_receipt_mutation()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  RAISE EXCEPTION 'engine_v3_ad_operator_action_receipts is immutable';
END
$$;

CREATE TRIGGER engine_v3_ad_operator_action_receipts_immutable
BEFORE UPDATE OR DELETE ON engine_v3_ad_operator_action_receipts
FOR EACH ROW EXECUTE FUNCTION reject_engine_v3_ad_operator_action_receipt_mutation();

CREATE INDEX engine_v3_ad_action_receipts_timeline_idx
  ON engine_v3_ad_operator_action_receipts (
    business_ref_id, provider_account_ref_id, provider_account_id,
    source_ad_id, requested_at DESC
  );

CREATE OR REPLACE FUNCTION enforce_meta_ads_decision_terminal_receipt()
RETURNS trigger LANGUAGE plpgsql AS $$
BEGIN
  IF NEW.source = 'decision_origin' AND NEW.status <> 'pending' THEN
    IF NOT EXISTS (
      SELECT 1
      FROM engine_v3_ad_operator_action_receipts receipt
      WHERE receipt.source_action_log_id = NEW.id
        AND receipt.business_ref_id = NEW.business_id
        AND receipt.provider_account_ref_id = NEW.provider_account_ref_id
        AND receipt.provider_account_id = NEW.provider_account_id
        AND receipt.source_ad_id = NEW.ad_id
        AND receipt.operator_action = NEW.action
        AND receipt.action_status = NEW.status
        AND receipt.provider_verified = NEW.provider_verified
        AND receipt.verification_entity_id_key = NEW.verification_entity_id_key
        AND receipt.verification_status_key = NEW.verification_status_key
        AND receipt.verified_at_key = NEW.verified_at_key
        AND receipt.contract_version = NEW.decision_contract_version
        AND receipt.episode_key = NEW.decision_episode_key
        AND receipt.source_snapshot_id = NEW.decision_snapshot_id
        AND receipt.source_evaluation_id = NEW.decision_evaluation_id
        AND receipt.source_engine_version = NEW.decision_engine_version
        AND receipt.source_decision_hash = NEW.decision_hash
        AND receipt.idempotency_key = NEW.idempotency_key
        AND receipt.dry_run = NEW.dry_run
        AND receipt.finalized_at = NEW.terminal_finalized_at
    ) THEN
      RAISE EXCEPTION
        'terminal decision-origin action requires exact immutable receipt';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER meta_ads_decision_terminal_receipt_required
AFTER INSERT OR UPDATE ON meta_ads_action_log
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW EXECUTE FUNCTION enforce_meta_ads_decision_terminal_receipt();

CREATE TABLE engine_v3_ad_operator_response_events (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version text NOT NULL
    CHECK (contract_version = '${NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION}'),
  episode_key char(64) NOT NULL,
  business_ref_id uuid NOT NULL,
  business_id text NOT NULL,
  provider_account_ref_id uuid NOT NULL,
  provider_account_id text NOT NULL,
  entity_type text NOT NULL CHECK (entity_type IN ('ad', 'adset', 'campaign')),
  entity_id text NOT NULL,
  job_run_id uuid NOT NULL,
  response_cutoff timestamptz NOT NULL,
	  evidence_kind text NOT NULL CHECK (evidence_kind IN (
	    'engine_v3_ad_operator_action_receipt', 'meta_entity_state_history',
	    'meta_entity_tombstones'
	  )),
	  evidence_source_id text NOT NULL,
	  action_receipt_id uuid NULL,
	  state_history_id uuid NULL,
	  tombstone_id uuid NULL,
  evidence_observed_at timestamptz NOT NULL,
  evidence_captured_at timestamptz NOT NULL,
  treatment_eligible boolean NOT NULL DEFAULT false,
  diagnostic_code text NULL,
  evidence_json jsonb NOT NULL,
  evidence_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
	  CONSTRAINT engine_v3_ad_response_events_episode_fk
    FOREIGN KEY (
      episode_key, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id
    ) REFERENCES engine_v3_ad_recommendation_episodes (
      episode_key, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id
    )
	    ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_events_job_run_fk
	    FOREIGN KEY (job_run_id) REFERENCES engine_v3_job_runs(id)
	    ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_events_action_receipt_fk
	    FOREIGN KEY (
	      action_receipt_id, episode_key, business_ref_id, business_id,
	      provider_account_ref_id, provider_account_id
	    ) REFERENCES engine_v3_ad_operator_action_receipts (
	      id, episode_key, business_ref_id, business_id,
	      provider_account_ref_id, provider_account_id
	    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_events_state_history_fk
	    FOREIGN KEY (
	      state_history_id, business_ref_id, business_id,
	      provider_account_ref_id, provider_account_id, entity_type, entity_id
	    ) REFERENCES meta_entity_state_history (
	      id, business_ref_id, business_id, provider_account_ref_id,
	      provider_account_id, entity_type, entity_id
	    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_events_tombstone_fk
	    FOREIGN KEY (
	      tombstone_id, business_ref_id, business_id,
	      provider_account_ref_id, provider_account_id, entity_type, entity_id
	    ) REFERENCES meta_entity_tombstones (
	      id, business_ref_id, business_id, provider_account_ref_id,
	      provider_account_id, entity_type, entity_id
	    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_event_source_check CHECK (
	    (evidence_kind = 'engine_v3_ad_operator_action_receipt' AND
	      action_receipt_id IS NOT NULL AND state_history_id IS NULL AND
	      tombstone_id IS NULL AND
	      evidence_source_id = action_receipt_id::text) OR
	    (evidence_kind = 'meta_entity_state_history' AND
	      action_receipt_id IS NULL AND state_history_id IS NOT NULL AND
	      tombstone_id IS NULL AND evidence_source_id = state_history_id::text) OR
	    (evidence_kind = 'meta_entity_tombstones' AND
	      action_receipt_id IS NULL AND state_history_id IS NULL AND
	      tombstone_id IS NOT NULL AND evidence_source_id = tombstone_id::text)
	  ),
	  CONSTRAINT engine_v3_ad_response_event_treatment_check CHECK (
	    NOT treatment_eligible OR action_receipt_id IS NOT NULL
	  ),
	  CONSTRAINT engine_v3_ad_response_event_idempotency_unique
	    UNIQUE (episode_key, response_cutoff, evidence_hash)
	);

CREATE INDEX engine_v3_ad_response_events_timeline_idx
  ON engine_v3_ad_operator_response_events (episode_key, response_cutoff DESC);

CREATE TABLE engine_v3_ad_operator_responses (
  id uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version text NOT NULL
    CHECK (contract_version = '${NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION}'),
  episode_key char(64) NOT NULL,
	  business_ref_id uuid NOT NULL,
	  business_id text NOT NULL,
	  provider_account_ref_id uuid NOT NULL,
	  provider_account_id text NOT NULL,
	  job_run_id uuid NOT NULL,
	  response_cutoff timestamptz NOT NULL,
	  observation_status text NOT NULL CHECK (observation_status IN (
	    'observed_response', 'observed_no_response', 'unknown_incomplete'
	  )),
	  response_type text NOT NULL CHECK (response_type IN (
	    'verified_pause', 'verified_resume', 'duplicate_successor',
	    'rebuild_successor', 'budget_owner_action_context',
	    'natural_spend_cessation', 'no_response_observed',
	    'unknown_incomplete', 'ambiguous_conflicting'
	  )),
  operator_response_detected boolean NOT NULL,
  ad_treatment_detected boolean NOT NULL,
	  detected_at timestamptz NULL,
	  action_receipt_id uuid NULL,
	  action_log_id uuid NULL,
  successor_ad_id text NULL,
  successor_kind text NULL CHECK (successor_kind IN ('duplicate', 'rebuild')),
  budget_owner_type text NULL CHECK (budget_owner_type IN ('campaign', 'adset')),
  budget_owner_id text NULL,
	  window_start timestamptz NOT NULL,
	  window_end timestamptz NOT NULL,
	  window_closed boolean NOT NULL,
	  source_complete boolean NOT NULL,
	  source_set_hash char(64) NOT NULL
	    CHECK (source_set_hash ~ '^[0-9a-f]{64}$'),
	  action_receipt_count integer NOT NULL CHECK (action_receipt_count >= 0),
	  state_observation_count integer NOT NULL CHECK (state_observation_count >= 0),
	  tombstone_observation_count integer NOT NULL
	    CHECK (tombstone_observation_count >= 0),
	  required_state_target_count integer NOT NULL
	    CHECK (required_state_target_count >= 1),
	  complete_state_target_count integer NOT NULL CHECK (
	    complete_state_target_count >= 0 AND
	    complete_state_target_count <= required_state_target_count
	  ),
	  diagnostics_json jsonb NOT NULL DEFAULT '[]'::jsonb,
	  evidence_hashes_json jsonb NOT NULL DEFAULT '[]'::jsonb,
	  evidence_count integer NOT NULL CHECK (evidence_count >= 0),
	  evidence_set_hash char(64) NOT NULL
	    CHECK (evidence_set_hash ~ '^[0-9a-f]{64}$'),
	  replacement_set_hash char(64) NOT NULL
	    CHECK (replacement_set_hash ~ '^[0-9a-f]{64}$'),
	  response_hash char(64) NOT NULL,
  created_at timestamptz NOT NULL DEFAULT now(),
	  CONSTRAINT engine_v3_ad_responses_episode_fk
    FOREIGN KEY (
      episode_key, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id
    ) REFERENCES engine_v3_ad_recommendation_episodes (
      episode_key, business_ref_id, business_id, provider_account_ref_id,
      provider_account_id
    )
	    ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_responses_job_run_fk
	    FOREIGN KEY (job_run_id) REFERENCES engine_v3_job_runs(id)
	    ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_responses_action_receipt_fk
	    FOREIGN KEY (
	      action_receipt_id, episode_key, business_ref_id, business_id,
	      provider_account_ref_id, provider_account_id, action_log_id
	    ) REFERENCES engine_v3_ad_operator_action_receipts (
	      id, episode_key, business_ref_id, business_id,
	      provider_account_ref_id, provider_account_id, source_action_log_id
	    ) ON DELETE RESTRICT,
	  CONSTRAINT engine_v3_ad_response_observation_unique
	    UNIQUE (episode_key, response_cutoff),
	  CONSTRAINT engine_v3_ad_response_window_check CHECK (
	    window_end > window_start AND response_cutoff >= window_start
	  ),
	  CONSTRAINT engine_v3_ad_response_source_completion_check CHECK (
	    NOT source_complete OR (
	      window_closed AND
	      complete_state_target_count = required_state_target_count
	    )
	  ),
	  CONSTRAINT engine_v3_ad_response_evidence_cardinality_check CHECK (
	    evidence_count = jsonb_array_length(evidence_hashes_json)
	  ),
	  CONSTRAINT engine_v3_ad_response_status_check CHECK (
	    (observation_status = 'observed_response' AND operator_response_detected) OR
	    (observation_status <> 'observed_response' AND NOT operator_response_detected)
	  ),
	  CONSTRAINT engine_v3_ad_response_receipt_lineage_check CHECK (
	    (operator_response_detected AND action_receipt_id IS NOT NULL AND
	      action_log_id IS NOT NULL AND detected_at IS NOT NULL) OR
	    (NOT operator_response_detected AND action_receipt_id IS NULL AND
	      action_log_id IS NULL)
	  ),
	  CONSTRAINT engine_v3_ad_response_treatment_check CHECK (
	    NOT ad_treatment_detected OR operator_response_detected
	  )
	);

CREATE INDEX engine_v3_ad_responses_timeline_idx
  ON engine_v3_ad_operator_responses (episode_key, response_cutoff DESC);
`;

export const AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_COLUMNS: Readonly<
  Record<string, readonly string[]>
> = {
  engine_v3_ad_decision_snapshots_daily: [
    "id",
    "business_ref_id",
    "business_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "creative_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "label",
    "blocked_action_type",
    "evaluation_id",
    "input_hash",
    "decision_hash",
    "computed_at",
    "created_at",
    "updated_at",
  ],
  engine_v3_ad_decision_evaluations: [
    "id",
    "business_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "creative_input_json",
    "input_hash",
    "decision_hash",
    "evaluated_at",
    "created_at",
  ],
  meta_ads_action_log: [
    "id",
    "business_id",
    "ad_id",
    "action",
    "source",
    "requested_at",
    "status",
    "verified_at",
    "decision_contract_version",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_episode_key",
    "decision_snapshot_id",
    "decision_evaluation_id",
    "decision_engine_version",
    "decision_hash",
    "idempotency_key",
    "dry_run",
    "provider_verified",
    "verification_entity_id",
    "verification_status",
    "verification_entity_id_key",
    "verification_status_key",
    "verified_at_key",
    "terminal_finalized_at",
  ],
  engine_v3_job_runs: [
    "id",
    "job_name",
    "business_ref_id",
    "business_id",
    "as_of_date",
    "engine_version",
    "status",
    "started_at",
    "finished_at",
    "duration_ms",
    "row_count",
    "error_message",
    "error_json",
    "created_at",
    "updated_at",
  ],
  meta_entity_observation_runs: [
    "id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "run_hash",
    "completeness",
  ],
  meta_entity_state_history: [
    "id",
    "run_id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "entity_id",
    "campaign_id",
    "adset_id",
    "ad_id",
    "creative_id",
    "configured_status",
    "effective_status",
    "campaign_daily_budget_raw",
    "campaign_lifetime_budget_raw",
    "adset_daily_budget_raw",
    "adset_lifetime_budget_raw",
    "budget_origin",
    "presence",
    "field_coverage_json",
    "observed_at",
    "captured_at",
    "run_completeness",
    "state_hash",
  ],
  meta_entity_tombstones: [
    "id",
    "run_id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "entity_id",
    "reason",
    "provider_evidence_json",
    "observed_at",
    "captured_at",
    "run_completeness",
    "tombstone_hash",
    "created_at",
  ],
  [AD_RECOMMENDATION_EPISODES_TABLE]: [
    "id",
    "contract_version",
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_entity_type",
    "decision_entity_id",
    "ad_id",
    "creative_id",
    "as_of_date",
    "engine_version",
    "scope_type",
    "scope_id",
    "decision_snapshot_id",
    "evaluation_id",
    "input_hash",
    "decision_hash",
    "decision_label",
    "source_campaign_id",
    "source_adset_id",
    "recommended_at",
    "captured_at",
    "job_run_id",
    "created_at",
  ],
  [AD_OPERATOR_ACTION_RECEIPTS_TABLE]: [
    "id",
    "receipt_hash",
    "source_action_log_id",
    "contract_version",
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "source_ad_id",
    "source_snapshot_id",
    "source_evaluation_id",
    "source_engine_version",
    "source_decision_hash",
    "target_entity_type",
    "target_entity_id",
    "operator_action",
    "successor_kind",
    "resulting_ad_id",
    "idempotency_key",
    "action_status",
    "dry_run",
    "provider_verified",
    "requested_at",
    "verified_at",
    "finalized_at",
    "captured_at",
    "verification_entity_id",
    "verification_status",
    "verification_entity_id_key",
    "verification_status_key",
    "verified_at_key",
    "created_at",
  ],
  [AD_OPERATOR_RESPONSE_EVENTS_TABLE]: [
    "id",
    "contract_version",
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "entity_id",
    "job_run_id",
    "response_cutoff",
    "evidence_kind",
    "evidence_source_id",
    "action_receipt_id",
    "state_history_id",
    "tombstone_id",
    "evidence_observed_at",
    "evidence_captured_at",
    "treatment_eligible",
    "diagnostic_code",
    "evidence_json",
    "evidence_hash",
    "created_at",
  ],
  [AD_OPERATOR_RESPONSES_TABLE]: [
    "id",
    "contract_version",
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "job_run_id",
    "response_cutoff",
    "observation_status",
    "response_type",
    "operator_response_detected",
    "ad_treatment_detected",
    "detected_at",
    "action_receipt_id",
    "action_log_id",
    "successor_ad_id",
    "successor_kind",
    "budget_owner_type",
    "budget_owner_id",
    "window_start",
    "window_end",
    "window_closed",
    "source_complete",
    "source_set_hash",
    "action_receipt_count",
    "state_observation_count",
    "tombstone_observation_count",
    "required_state_target_count",
    "complete_state_target_count",
    "diagnostics_json",
    "evidence_hashes_json",
    "evidence_count",
    "evidence_set_hash",
    "replacement_set_hash",
    "response_hash",
    "created_at",
  ],
};

const AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_NOT_NULL: Readonly<
  Record<string, readonly string[]>
> = {
  [AD_RECOMMENDATION_EPISODES_TABLE]: [
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "ad_id",
    "decision_snapshot_id",
    "evaluation_id",
    "engine_version",
    "decision_hash",
    "job_run_id",
  ],
  [AD_OPERATOR_ACTION_RECEIPTS_TABLE]: [
    "receipt_hash",
    "source_action_log_id",
    "contract_version",
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "source_ad_id",
    "source_snapshot_id",
    "source_evaluation_id",
    "source_engine_version",
    "source_decision_hash",
    "target_entity_type",
    "target_entity_id",
    "operator_action",
    "idempotency_key",
    "action_status",
    "dry_run",
    "provider_verified",
    "verification_entity_id_key",
    "verification_status_key",
    "verified_at_key",
    "requested_at",
    "finalized_at",
    "captured_at",
  ],
  [AD_OPERATOR_RESPONSE_EVENTS_TABLE]: [
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "entity_id",
    "job_run_id",
    "response_cutoff",
    "evidence_kind",
    "evidence_source_id",
    "evidence_hash",
  ],
  [AD_OPERATOR_RESPONSES_TABLE]: [
    "episode_key",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "job_run_id",
    "response_cutoff",
    "observation_status",
    "response_type",
    "window_start",
    "window_end",
    "window_closed",
    "source_complete",
    "source_set_hash",
    "tombstone_observation_count",
    "evidence_count",
    "evidence_set_hash",
    "replacement_set_hash",
    "response_hash",
  ],
  meta_entity_state_history: [
    "run_id",
    "business_ref_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "entity_id",
    "budget_origin",
    "run_completeness",
    "observed_at",
    "captured_at",
    "state_hash",
  ],
  meta_entity_tombstones: [
    "id",
    "run_id",
    "business_ref_id",
    "business_id",
    "provider_account_ref_id",
    "provider_account_id",
    "entity_type",
    "entity_id",
    "reason",
    "provider_evidence_json",
    "observed_at",
    "captured_at",
    "run_completeness",
    "tombstone_hash",
  ],
  meta_entity_observation_runs: ["id", "run_hash", "completeness"],
  meta_ads_action_log: [
    "id",
    "business_id",
    "ad_id",
    "action",
    "source",
    "requested_at",
    "status",
    "dry_run",
    "provider_verified",
    "verification_entity_id_key",
    "verification_status_key",
    "verified_at_key",
  ],
  engine_v3_job_runs: [
    "id",
    "job_name",
    "business_ref_id",
    "as_of_date",
    "engine_version",
    "status",
    "started_at",
    "created_at",
    "updated_at",
  ],
};

const AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_UDT: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  [AD_RECOMMENDATION_EPISODES_TABLE]: {
    id: "uuid",
    episode_key: "bpchar",
    business_ref_id: "uuid",
    business_id: "text",
    provider_account_ref_id: "uuid",
    provider_account_id: "text",
    ad_id: "text",
    as_of_date: "date",
    decision_snapshot_id: "uuid",
    evaluation_id: "uuid",
    input_hash: "bpchar",
    decision_hash: "bpchar",
    recommended_at: "timestamptz",
    captured_at: "timestamptz",
    job_run_id: "uuid",
  },
  [AD_OPERATOR_ACTION_RECEIPTS_TABLE]: {
    id: "uuid",
    receipt_hash: "bpchar",
    source_action_log_id: "uuid",
    episode_key: "bpchar",
    business_ref_id: "uuid",
    business_id: "text",
    provider_account_ref_id: "uuid",
    provider_account_id: "text",
    source_snapshot_id: "uuid",
    source_evaluation_id: "uuid",
    source_decision_hash: "bpchar",
    dry_run: "bool",
    provider_verified: "bool",
    verification_lineage: "jsonb",
    requested_at: "timestamptz",
    verified_at: "timestamptz",
    finalized_at: "timestamptz",
    captured_at: "timestamptz",
    verification_entity_id_key: "text",
    verification_status_key: "text",
    verified_at_key: "timestamptz",
  },
  [AD_OPERATOR_RESPONSE_EVENTS_TABLE]: {
    id: "uuid",
    episode_key: "bpchar",
    business_ref_id: "uuid",
    business_id: "text",
    provider_account_ref_id: "uuid",
    provider_account_id: "text",
    job_run_id: "uuid",
    response_cutoff: "timestamptz",
    action_receipt_id: "uuid",
    state_history_id: "uuid",
    tombstone_id: "uuid",
    evidence_observed_at: "timestamptz",
    evidence_captured_at: "timestamptz",
    treatment_eligible: "bool",
    evidence_json: "jsonb",
    evidence_hash: "bpchar",
  },
  [AD_OPERATOR_RESPONSES_TABLE]: {
    id: "uuid",
    episode_key: "bpchar",
    business_ref_id: "uuid",
    business_id: "text",
    provider_account_ref_id: "uuid",
    provider_account_id: "text",
    job_run_id: "uuid",
    response_cutoff: "timestamptz",
    operator_response_detected: "bool",
    ad_treatment_detected: "bool",
    action_receipt_id: "uuid",
    action_log_id: "uuid",
    window_start: "timestamptz",
    window_end: "timestamptz",
    window_closed: "bool",
    source_complete: "bool",
    source_set_hash: "bpchar",
    action_receipt_count: "int4",
    state_observation_count: "int4",
    tombstone_observation_count: "int4",
    required_state_target_count: "int4",
    complete_state_target_count: "int4",
    diagnostics_json: "jsonb",
    evidence_hashes_json: "jsonb",
    evidence_count: "int4",
    evidence_set_hash: "bpchar",
    replacement_set_hash: "bpchar",
    response_hash: "bpchar",
  },
  meta_ads_action_log: {
    id: "uuid",
    business_id: "uuid",
    provider_account_ref_id: "uuid",
    decision_episode_key: "bpchar",
    decision_snapshot_id: "uuid",
    decision_evaluation_id: "uuid",
    decision_hash: "bpchar",
    dry_run: "bool",
    provider_verified: "bool",
    verified_at: "timestamptz",
    verified_at_key: "timestamptz",
    terminal_finalized_at: "timestamptz",
  },
  engine_v3_job_runs: {
    id: "uuid",
    business_ref_id: "uuid",
    as_of_date: "date",
    started_at: "timestamptz",
    finished_at: "timestamptz",
    duration_ms: "int4",
    row_count: "int4",
    error_json: "jsonb",
  },
  meta_entity_observation_runs: { id: "uuid", run_hash: "bpchar" },
  meta_entity_state_history: {
    id: "uuid",
    run_id: "uuid",
    business_ref_id: "uuid",
    provider_account_ref_id: "uuid",
    field_coverage_json: "jsonb",
    observed_at: "timestamptz",
    captured_at: "timestamptz",
    state_hash: "bpchar",
  },
  meta_entity_tombstones: {
    id: "uuid",
    run_id: "uuid",
    business_ref_id: "uuid",
    provider_account_ref_id: "uuid",
    provider_evidence_json: "jsonb",
    observed_at: "timestamptz",
    captured_at: "timestamptz",
    tombstone_hash: "bpchar",
  },
  engine_v3_ad_decision_snapshots_daily: {
    id: "uuid",
    business_ref_id: "uuid",
    evaluation_id: "uuid",
    as_of_date: "date",
    input_hash: "bpchar",
    decision_hash: "bpchar",
    computed_at: "timestamptz",
  },
  engine_v3_ad_decision_evaluations: {
    id: "uuid",
    business_ref_id: "uuid",
    creative_input_json: "jsonb",
    as_of_date: "date",
    input_hash: "bpchar",
    decision_hash: "bpchar",
    evaluated_at: "timestamptz",
  },
};

const AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_NULLABLE: Readonly<
  Record<string, readonly string[]>
> = {
  meta_ads_action_log: [
    "decision_contract_version",
    "provider_account_ref_id",
    "provider_account_id",
    "decision_episode_key",
    "decision_snapshot_id",
    "decision_evaluation_id",
    "decision_engine_version",
    "decision_hash",
    "idempotency_key",
    "verification_entity_id",
    "verification_status",
    "verified_at",
    "terminal_finalized_at",
  ],
  [AD_RECOMMENDATION_EPISODES_TABLE]: [
    "creative_id",
    "source_campaign_id",
    "source_adset_id",
  ],
  [AD_OPERATOR_ACTION_RECEIPTS_TABLE]: [
    "successor_kind",
    "resulting_ad_id",
    "verified_at",
    "verification_entity_id",
    "verification_status",
  ],
  [AD_OPERATOR_RESPONSE_EVENTS_TABLE]: [
    "action_receipt_id",
    "state_history_id",
    "tombstone_id",
    "diagnostic_code",
  ],
  [AD_OPERATOR_RESPONSES_TABLE]: [
    "detected_at",
    "action_receipt_id",
    "action_log_id",
    "successor_ad_id",
    "successor_kind",
    "budget_owner_type",
    "budget_owner_id",
  ],
};

const AD_OPERATOR_RESPONSE_GENERATED_COLUMNS: Readonly<
  Record<string, Readonly<Record<string, string>>>
> = {
  meta_ads_action_log: {
    verification_entity_id_key: "coalesce(verification_entity_id, ''::text)",
    verification_status_key: "coalesce(verification_status, ''::text)",
    verified_at_key:
      "coalesce(verified_at, '-infinity'::timestamp with time zone)",
  },
  [AD_OPERATOR_ACTION_RECEIPTS_TABLE]: {
    verification_entity_id_key: "coalesce(verification_entity_id, ''::text)",
    verification_status_key: "coalesce(verification_status, ''::text)",
    verified_at_key:
      "coalesce(verified_at, '-infinity'::timestamp with time zone)",
  },
};

export interface AdOperatorResponseSchemaCapability {
  ready: boolean;
  missing: string[];
}

type ColumnRow = Record<string, unknown> & {
  table_name: unknown;
  column_name: unknown;
  is_nullable: unknown;
  udt_name: unknown;
  is_generated: unknown;
  generation_expression: unknown;
};
type IndexRow = Record<string, unknown> & {
  tablename: unknown;
  indexdef: unknown;
};
type ConstraintRow = Record<string, unknown> & {
  table_name: unknown;
  constraint_name: unknown;
  constraint_type: unknown;
  constraint_definition: unknown;
};
type TriggerRow = Record<string, unknown> & {
  table_name: unknown;
  trigger_name: unknown;
  event_manipulation: unknown;
  action_timing: unknown;
  action_statement: unknown;
  trigger_definition: unknown;
  function_definition: unknown;
};
type IdRow = Record<string, unknown> & { id: unknown };
type ReplacementProofRow = Record<string, unknown> & {
  responses_written: unknown;
  events_written: unknown;
  events_pruned: unknown;
  response_proof_json: unknown;
  event_proof_json: unknown;
};

function normalizedIndex(value: unknown): string {
  return typeof value === "string"
    ? value.toLowerCase().replaceAll('"', "").replace(/\s+/g, " ").trim()
    : "";
}

function hasUniqueIndex(
  rows: readonly IndexRow[],
  table: string,
  columns: readonly string[],
): boolean {
  const signature = `(${columns.join(", ")})`;
  return rows.some((row) => {
    const definition = normalizedIndex(row.indexdef).replace(
      "using btree ",
      "",
    );
    return (
      row.tablename === table &&
      definition.includes("create unique index") &&
      definition.includes(signature)
    );
  });
}

export async function inspectAdOperatorResponseSchemaCapability(
  db: DbClient = getDb(),
): Promise<AdOperatorResponseSchemaCapability> {
  const tables = Object.keys(AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_COLUMNS);
  const columns = await db.query<ColumnRow>(
    `
    SELECT table_name, column_name, is_nullable, udt_name,
      is_generated, generation_expression
    FROM information_schema.columns
    WHERE table_schema = current_schema()
      AND table_name = ANY($1::text[])
    `,
    [tables],
  );
  const indexes = await db.query<IndexRow>(
    `
    SELECT tablename, indexdef
    FROM pg_indexes
    WHERE schemaname = current_schema()
      AND tablename = ANY($1::text[])
    `,
    [
      [
        AD_RECOMMENDATION_EPISODES_TABLE,
        AD_OPERATOR_ACTION_RECEIPTS_TABLE,
        AD_OPERATOR_RESPONSE_EVENTS_TABLE,
        AD_OPERATOR_RESPONSES_TABLE,
        "meta_ads_action_log",
        "meta_entity_state_history",
        "meta_entity_tombstones",
        "engine_v3_ad_decision_snapshots_daily",
        "engine_v3_job_runs",
      ],
    ],
  );
  const constraints = await db.query<ConstraintRow>(
    `
    SELECT relation.relname AS table_name,
      constraint_row.conname AS constraint_name,
      constraint_row.contype::text AS constraint_type,
      pg_get_constraintdef(constraint_row.oid, true) AS constraint_definition
    FROM pg_constraint constraint_row
    INNER JOIN pg_class relation ON relation.oid = constraint_row.conrelid
    INNER JOIN pg_namespace namespace_row
      ON namespace_row.oid = relation.relnamespace
    WHERE namespace_row.nspname = current_schema()
      AND relation.relname = ANY($1::text[])
    `,
    [
      [
        AD_RECOMMENDATION_EPISODES_TABLE,
        AD_OPERATOR_ACTION_RECEIPTS_TABLE,
        AD_OPERATOR_RESPONSE_EVENTS_TABLE,
        AD_OPERATOR_RESPONSES_TABLE,
        "meta_ads_action_log",
        "meta_entity_state_history",
        "meta_entity_tombstones",
        "engine_v3_ad_decision_snapshots_daily",
      ],
    ],
  );
  const triggers = await db.query<TriggerRow>(
    `
    SELECT trigger_info.event_object_table AS table_name,
      trigger_info.trigger_name, trigger_info.event_manipulation,
      trigger_info.action_timing, trigger_info.action_statement,
      pg_get_triggerdef(trigger_row.oid, true) AS trigger_definition,
      pg_get_functiondef(procedure_row.oid) AS function_definition
    FROM information_schema.triggers trigger_info
    INNER JOIN pg_class relation
      ON relation.relname = trigger_info.event_object_table
    INNER JOIN pg_namespace namespace_row
      ON namespace_row.oid = relation.relnamespace
     AND namespace_row.nspname = trigger_info.trigger_schema
    INNER JOIN pg_trigger trigger_row
      ON trigger_row.tgrelid = relation.oid
     AND trigger_row.tgname = trigger_info.trigger_name
    INNER JOIN pg_proc procedure_row
      ON procedure_row.oid = trigger_row.tgfoid
    WHERE trigger_info.trigger_schema = current_schema()
      AND trigger_info.event_object_table = ANY($1::text[])
      AND NOT trigger_row.tgisinternal
    `,
    [[AD_OPERATOR_ACTION_RECEIPTS_TABLE, "meta_ads_action_log"]],
  );
  const columnMap = new Map(
    columns.map((row) => [
      `${String(row.table_name)}.${String(row.column_name)}`,
      {
        isNullable: String(row.is_nullable),
        udtName: String(row.udt_name),
        isGenerated: String(row.is_generated),
        generationExpression: String(row.generation_expression ?? ""),
      },
    ]),
  );
  const missing: string[] = [];
  for (const [table, requiredColumns] of Object.entries(
    AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_COLUMNS,
  )) {
    for (const column of requiredColumns) {
      if (!columnMap.has(`${table}.${column}`)) {
        missing.push(`${table}.${column}`);
      }
    }
  }
  for (const [table, requiredColumns] of Object.entries(
    AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_NOT_NULL,
  )) {
    for (const column of requiredColumns) {
      if (columnMap.get(`${table}.${column}`)?.isNullable !== "NO") {
        missing.push(`${table}.${column}_not_null`);
      }
    }
  }
  for (const [table, requiredColumns] of Object.entries(
    AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_NULLABLE,
  )) {
    for (const column of requiredColumns) {
      if (columnMap.get(`${table}.${column}`)?.isNullable !== "YES") {
        missing.push(`${table}.${column}_nullable`);
      }
    }
  }
  for (const [table, requiredColumns] of Object.entries(
    AD_OPERATOR_RESPONSE_SCHEMA_REQUIRED_UDT,
  )) {
    for (const [column, expectedUdt] of Object.entries(requiredColumns)) {
      if (columnMap.get(`${table}.${column}`)?.udtName !== expectedUdt) {
        missing.push(`${table}.${column}_type_${expectedUdt}`);
      }
    }
  }
  for (const [table, generatedColumns] of Object.entries(
    AD_OPERATOR_RESPONSE_GENERATED_COLUMNS,
  )) {
    for (const [column, expression] of Object.entries(generatedColumns)) {
      const actual = columnMap.get(`${table}.${column}`);
      if (
        actual?.isGenerated !== "ALWAYS" ||
        normalizedIndex(actual.generationExpression) !==
          normalizedIndex(expression)
      ) {
        missing.push(`${table}.${column}_generated_expression`);
      }
    }
  }
  for (const [table, columnsForIndex, name] of [
    [AD_RECOMMENDATION_EPISODES_TABLE, ["episode_key"], "episode_key_unique"],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      [
        "episode_key",
        "business_ref_id",
        "business_id",
        "provider_account_ref_id",
        "provider_account_id",
      ],
      "episode_identity_unique",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      ["receipt_hash"],
      "receipt_hash_unique",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      ["source_action_log_id"],
      "source_action_log_unique",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      [
        "id",
        "episode_key",
        "business_ref_id",
        "business_id",
        "provider_account_ref_id",
        "provider_account_id",
      ],
      "receipt_event_identity_unique",
    ],
    [
      "engine_v3_ad_decision_snapshots_daily",
      [
        "id",
        "business_ref_id",
        "business_id",
        "provider_account_id",
        "decision_entity_type",
        "decision_entity_id",
        "ad_id",
        "as_of_date",
        "engine_version",
        "scope_type",
        "scope_id",
        "evaluation_id",
        "input_hash",
        "decision_hash",
      ],
      "response_lineage_unique",
    ],
    [
      "meta_entity_state_history",
      [
        "id",
        "business_ref_id",
        "business_id",
        "provider_account_ref_id",
        "provider_account_id",
        "entity_type",
        "entity_id",
      ],
      "response_lineage_unique",
    ],
    [
      "meta_entity_tombstones",
      [
        "id",
        "business_ref_id",
        "business_id",
        "provider_account_ref_id",
        "provider_account_id",
        "entity_type",
        "entity_id",
      ],
      "response_lineage_unique",
    ],
    [
      "meta_ads_action_log",
      [
        "id",
        "business_id",
        "provider_account_ref_id",
        "provider_account_id",
        "ad_id",
        "action",
        "status",
        "provider_verified",
        "verification_entity_id_key",
        "verification_status_key",
        "verified_at_key",
        "decision_contract_version",
        "decision_episode_key",
        "decision_snapshot_id",
        "decision_evaluation_id",
        "decision_engine_version",
        "decision_hash",
        "idempotency_key",
        "dry_run",
        "terminal_finalized_at",
      ],
      "decision_terminal_lineage_unique",
    ],
    [
      "meta_ads_action_log",
      ["business_id", "idempotency_key"],
      "decision_idempotency_unique",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      ["episode_key", "response_cutoff", "evidence_hash"],
      "event_idempotency_unique",
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      ["episode_key", "response_cutoff"],
      "response_observation_unique",
    ],
  ] as const) {
    if (!hasUniqueIndex(indexes, table, columnsForIndex)) {
      missing.push(`${table}.${name}`);
    }
  }
  const decisionIdempotencyIndex = indexes.find((row) => {
    const definition = normalizedIndex(row.indexdef);
    return (
      row.tablename === "meta_ads_action_log" &&
      definition.includes("create unique index") &&
      definition.includes("(business_id, idempotency_key)") &&
      definition.includes("where (source = 'decision_origin'::text)")
    );
  });
  if (!decisionIdempotencyIndex) {
    missing.push("meta_ads_action_log.decision_idempotency_partial_predicate");
  }
  const constraintNames = new Set(
    constraints.map(
      (row) => `${String(row.table_name)}.${String(row.constraint_name)}`,
    ),
  );
  for (const [table, name] of [
    ["meta_ads_action_log", "meta_ads_action_log_decision_origin_typed_check"],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_evaluation_fk",
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_snapshot_fk",
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_account_binding_fk",
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_job_run_fk",
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_business_identity_check",
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_native_identity_check",
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_native_epoch_check",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_episode_lineage_fk",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_account_binding_fk",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_source_epoch_check",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_action_log_fk",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_episode_fk",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_action_receipt_fk",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_state_history_fk",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_tombstone_fk",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_job_run_fk",
    ],
    [AD_OPERATOR_RESPONSES_TABLE, "engine_v3_ad_responses_episode_fk"],
    [AD_OPERATOR_RESPONSES_TABLE, "engine_v3_ad_responses_job_run_fk"],
    [AD_OPERATOR_RESPONSES_TABLE, "engine_v3_ad_responses_action_receipt_fk"],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_time_check",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_verification_check",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_successor_check",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_contract_action_check",
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_business_identity_check",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_event_source_check",
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_event_treatment_check",
    ],
    [AD_OPERATOR_RESPONSES_TABLE, "engine_v3_ad_response_window_check"],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_source_completion_check",
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_evidence_cardinality_check",
    ],
    [AD_OPERATOR_RESPONSES_TABLE, "engine_v3_ad_response_status_check"],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_receipt_lineage_check",
    ],
    [AD_OPERATOR_RESPONSES_TABLE, "engine_v3_ad_response_treatment_check"],
  ] as const) {
    if (!constraintNames.has(`${table}.${name}`)) {
      missing.push(`${table}.${name}`);
    }
  }
  const constraintByKey = new Map(
    constraints.map((row) => [
      `${String(row.table_name)}.${String(row.constraint_name)}`,
      row,
    ]),
  );
  for (const [table, name, type, fragments] of [
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_snapshot_fk",
      "f",
      [
        "foreign key (decision_snapshot_id, business_ref_id, business_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, evaluation_id, input_hash, decision_hash)",
        "references engine_v3_ad_decision_snapshots_daily(id, business_ref_id, business_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, evaluation_id, input_hash, decision_hash) on delete restrict",
      ],
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_evaluation_fk",
      "f",
      [
        "foreign key (evaluation_id, business_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, input_hash, decision_hash)",
        "references engine_v3_ad_decision_evaluations(id, business_ref_id, provider_account_id, decision_entity_type, decision_entity_id, ad_id, as_of_date, engine_version, scope_type, scope_id, input_hash, decision_hash) on delete restrict",
      ],
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_account_binding_fk",
      "f",
      [
        "foreign key (business_id, provider_account_ref_id, provider_account_id)",
        "references business_provider_accounts(business_id, provider_account_ref_id, provider_account_id) on delete restrict",
      ],
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_job_run_fk",
      "f",
      [
        "foreign key (job_run_id)",
        "references engine_v3_job_runs(id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_episode_lineage_fk",
      "f",
      [
        "foreign key (episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id, source_ad_id, source_snapshot_id, source_evaluation_id, source_engine_version, source_decision_hash)",
        "references engine_v3_ad_recommendation_episodes(episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id, ad_id, decision_snapshot_id, evaluation_id, engine_version, decision_hash) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_action_log_fk",
      "f",
      [
        "foreign key (source_action_log_id, business_ref_id, provider_account_ref_id, provider_account_id, source_ad_id, operator_action, action_status, provider_verified, verification_entity_id_key, verification_status_key, verified_at_key, contract_version, episode_key, source_snapshot_id, source_evaluation_id, source_engine_version, source_decision_hash, idempotency_key, dry_run, finalized_at)",
        "references meta_ads_action_log(id, business_id, provider_account_ref_id, provider_account_id, ad_id, action, status, provider_verified, verification_entity_id_key, verification_status_key, verified_at_key, decision_contract_version, decision_episode_key, decision_snapshot_id, decision_evaluation_id, decision_engine_version, decision_hash, idempotency_key, dry_run, terminal_finalized_at) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_episode_fk",
      "f",
      [
        "foreign key (episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id)",
        "references engine_v3_ad_recommendation_episodes(episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_action_receipt_fk",
      "f",
      [
        "foreign key (action_receipt_id, episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id)",
        "references engine_v3_ad_operator_action_receipts(id, episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_state_history_fk",
      "f",
      [
        "foreign key (state_history_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, entity_type, entity_id)",
        "references meta_entity_state_history(id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, entity_type, entity_id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_tombstone_fk",
      "f",
      [
        "foreign key (tombstone_id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, entity_type, entity_id)",
        "references meta_entity_tombstones(id, business_ref_id, business_id, provider_account_ref_id, provider_account_id, entity_type, entity_id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_events_job_run_fk",
      "f",
      [
        "foreign key (job_run_id)",
        "references engine_v3_job_runs(id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_responses_episode_fk",
      "f",
      [
        "foreign key (episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id)",
        "references engine_v3_ad_recommendation_episodes(episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_responses_action_receipt_fk",
      "f",
      [
        "foreign key (action_receipt_id, episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id, action_log_id)",
        "references engine_v3_ad_operator_action_receipts(id, episode_key, business_ref_id, business_id, provider_account_ref_id, provider_account_id, source_action_log_id) on delete restrict",
      ],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_responses_job_run_fk",
      "f",
      [
        "foreign key (job_run_id)",
        "references engine_v3_job_runs(id) on delete restrict",
      ],
    ],
  ] as const) {
    const row = constraintByKey.get(`${table}.${name}`);
    const definition = normalizedIndex(row?.constraint_definition);
    if (
      String(row?.constraint_type) !== type ||
      fragments.some(
        (fragment) => !definition.includes(normalizedIndex(fragment)),
      )
    ) {
      missing.push(`${table}.${name}_definition`);
    }
  }
  for (const [table, name, fragments] of [
    [
      "meta_ads_action_log",
      "meta_ads_action_log_decision_origin_typed_check",
      [
        "source",
        "decision_contract_version",
        DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
        "provider_account_ref_id",
        "decision_episode_key",
        "decision_snapshot_id",
        "decision_evaluation_id",
        "decision_engine_version",
        "length",
        "btrim",
        "decision_hash",
        "idempotency_key",
        "terminal_finalized_at",
        "provider_verified",
        "verified_at",
        "verification_entity_id",
        "verification_status",
      ],
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_business_identity_check",
      ["business_id", "business_ref_id", "text"],
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_native_identity_check",
      ["decision_entity_id", "ad_id", "length", "btrim"],
    ],
    [
      AD_RECOMMENDATION_EPISODES_TABLE,
      "engine_v3_ad_response_episode_native_epoch_check",
      ["engine_version", "length", "btrim"],
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_source_epoch_check",
      ["source_engine_version", "length", "btrim"],
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_time_check",
      ["finalized_at", "requested_at", "captured_at", "verified_at"],
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_verification_check",
      [
        "provider_verified",
        "action_status",
        "success",
        "dry_run",
        "verified_at",
        "verification_entity_id",
      ],
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_successor_check",
      [
        "operator_action",
        "successor_kind",
        "resulting_ad_id",
        "target_entity_type",
        "target_entity_id",
      ],
    ],
    [
      AD_OPERATOR_ACTION_RECEIPTS_TABLE,
      "engine_v3_ad_action_receipt_contract_action_check",
      ["contract_version", "operator_action", "pause", "resume"],
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_event_source_check",
      [
        "evidence_kind",
        "action_receipt_id",
        "state_history_id",
        "tombstone_id",
        "evidence_source_id",
      ],
    ],
    [
      AD_OPERATOR_RESPONSE_EVENTS_TABLE,
      "engine_v3_ad_response_event_treatment_check",
      ["treatment_eligible", "action_receipt_id"],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_window_check",
      ["window_end", "window_start", "response_cutoff"],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_source_completion_check",
      [
        "source_complete",
        "window_closed",
        "complete_state_target_count",
        "required_state_target_count",
      ],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_evidence_cardinality_check",
      ["evidence_count", "jsonb_array_length", "evidence_hashes_json"],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_status_check",
      ["observation_status", "observed_response", "operator_response_detected"],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_receipt_lineage_check",
      [
        "operator_response_detected",
        "action_receipt_id",
        "action_log_id",
        "detected_at",
      ],
    ],
    [
      AD_OPERATOR_RESPONSES_TABLE,
      "engine_v3_ad_response_treatment_check",
      ["ad_treatment_detected", "operator_response_detected"],
    ],
  ] as const) {
    const row = constraintByKey.get(`${table}.${name}`);
    const definition = normalizedIndex(row?.constraint_definition);
    if (
      String(row?.constraint_type) !== "c" ||
      fragments.some(
        (fragment) => !definition.includes(normalizedIndex(fragment)),
      )
    ) {
      missing.push(`${table}.${name}_definition`);
    }
  }
  const immutableTriggerRows = triggers.filter(
    (row) =>
      row.table_name === AD_OPERATOR_ACTION_RECEIPTS_TABLE &&
      row.trigger_name === "engine_v3_ad_operator_action_receipts_immutable",
  );
  const immutableTriggerEvents = new Set(
    immutableTriggerRows.map((row) => String(row.event_manipulation)),
  );
  if (
    immutableTriggerEvents.size !== 2 ||
    !immutableTriggerEvents.has("UPDATE") ||
    !immutableTriggerEvents.has("DELETE") ||
    immutableTriggerRows.some(
      (row) =>
        row.action_timing !== "BEFORE" ||
        !String(row.action_statement).includes(
          "reject_engine_v3_ad_operator_action_receipt_mutation",
        ) ||
        !normalizedIndex(row.function_definition).includes(
          "raise exception 'engine_v3_ad_operator_action_receipts is immutable'",
        ),
    )
  ) {
    missing.push(
      `${AD_OPERATOR_ACTION_RECEIPTS_TABLE}.immutable_update_delete_trigger`,
    );
  }
  const terminalReceiptTriggerRows = triggers.filter(
    (row) =>
      row.table_name === "meta_ads_action_log" &&
      row.trigger_name === "meta_ads_decision_terminal_receipt_required",
  );
  const terminalReceiptEvents = new Set(
    terminalReceiptTriggerRows.map((row) => String(row.event_manipulation)),
  );
  const terminalReceiptBodyFragments = [
    "new.source = 'decision_origin'",
    "new.status <> 'pending'",
    "receipt.source_action_log_id = new.id",
    "receipt.business_ref_id = new.business_id",
    "receipt.provider_account_ref_id = new.provider_account_ref_id",
    "receipt.provider_account_id = new.provider_account_id",
    "receipt.source_ad_id = new.ad_id",
    "receipt.operator_action = new.action",
    "receipt.action_status = new.status",
    "receipt.provider_verified = new.provider_verified",
    "receipt.episode_key = new.decision_episode_key",
    "receipt.source_snapshot_id = new.decision_snapshot_id",
    "receipt.source_evaluation_id = new.decision_evaluation_id",
    "receipt.source_engine_version = new.decision_engine_version",
    "receipt.source_decision_hash = new.decision_hash",
    "receipt.idempotency_key = new.idempotency_key",
    "receipt.dry_run = new.dry_run",
    "receipt.finalized_at = new.terminal_finalized_at",
    "raise exception 'terminal decision-origin action requires exact immutable receipt'",
  ];
  if (
    terminalReceiptEvents.size !== 2 ||
    !terminalReceiptEvents.has("INSERT") ||
    !terminalReceiptEvents.has("UPDATE") ||
    terminalReceiptTriggerRows.some((row) => {
      const triggerDefinition = normalizedIndex(row.trigger_definition);
      const functionDefinition = normalizedIndex(row.function_definition);
      return (
        row.action_timing !== "AFTER" ||
        !triggerDefinition.includes("deferrable initially deferred") ||
        !triggerDefinition.includes(
          "execute function enforce_meta_ads_decision_terminal_receipt()",
        ) ||
        terminalReceiptBodyFragments.some(
          (fragment) => !functionDefinition.includes(normalizedIndex(fragment)),
        )
      );
    })
  ) {
    missing.push("meta_ads_action_log.deferred_terminal_receipt_trigger");
  }
  return { ready: missing.length === 0, missing };
}

export const FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY = `
SELECT
  snapshot.business_ref_id::text AS business_ref_id,
  snapshot.business_id,
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.binding_count AS provider_account_binding_count,
  snapshot.provider_account_id,
  snapshot.ad_id,
  snapshot.creative_id,
  snapshot.as_of_date::text AS as_of_date,
  snapshot.engine_version,
  snapshot.scope_type,
  snapshot.scope_id,
  snapshot.id::text AS decision_snapshot_id,
  evaluation.id::text AS evaluation_id,
  snapshot.input_hash,
  snapshot.decision_hash,
  snapshot.label AS decision_label,
  NULLIF(evaluation.creative_input_json->>'campaignId', '') AS source_campaign_id,
  NULLIF(evaluation.creative_input_json->>'adsetId', '') AS source_adset_id,
  GREATEST(snapshot.computed_at, evaluation.evaluated_at)::text AS recommended_at
FROM engine_v3_ad_decision_snapshots_daily snapshot
INNER JOIN engine_v3_ad_decision_evaluations evaluation
  ON evaluation.id = snapshot.evaluation_id
 AND evaluation.business_ref_id = snapshot.business_ref_id
 AND evaluation.provider_account_id = snapshot.provider_account_id
 AND evaluation.decision_entity_type = snapshot.decision_entity_type
 AND evaluation.decision_entity_id = snapshot.decision_entity_id
 AND evaluation.ad_id = snapshot.ad_id
 AND evaluation.as_of_date = snapshot.as_of_date
 AND evaluation.engine_version = snapshot.engine_version
 AND evaluation.scope_type = snapshot.scope_type
 AND evaluation.scope_id = snapshot.scope_id
 AND evaluation.input_hash = snapshot.input_hash
 AND evaluation.decision_hash = snapshot.decision_hash
INNER JOIN LATERAL (
  SELECT
    (array_agg(assignment.provider_account_ref_id
      ORDER BY assignment.provider_account_ref_id))[1] AS provider_account_ref_id,
    count(*)::integer AS binding_count
  FROM business_provider_accounts assignment
  INNER JOIN provider_accounts provider_account
    ON provider_account.id = assignment.provider_account_ref_id
   AND provider_account.external_account_id = assignment.provider_account_id
  WHERE assignment.business_id = snapshot.business_ref_id::text
    AND assignment.provider = 'meta'
    AND assignment.provider_account_id = snapshot.provider_account_id
) binding ON true
WHERE snapshot.business_ref_id = $1::uuid
  AND snapshot.business_id = snapshot.business_ref_id::text
  AND snapshot.decision_entity_type = 'ad'
  AND snapshot.decision_entity_id = snapshot.ad_id
  AND snapshot.engine_version = $4
  AND snapshot.label IN ('scale', 'cut', 'refresh')
  AND snapshot.blocked_action_type IS NULL
  AND snapshot.computed_at > ($2::timestamptz - ($3::integer * interval '1 day'))
  AND snapshot.computed_at <= $2::timestamptz
  AND snapshot.created_at <= $2::timestamptz
  AND snapshot.updated_at <= $2::timestamptz
  AND evaluation.evaluated_at <= $2::timestamptz
  AND evaluation.created_at <= $2::timestamptz
ORDER BY snapshot.computed_at, snapshot.provider_account_id, snapshot.ad_id,
  snapshot.id, evaluation.id
`;

export const READ_AD_OPERATOR_RESPONSE_DB_TIME_QUERY =
  "SELECT clock_timestamp()::text AS captured_at";

export const INSERT_AD_RECOMMENDATION_EPISODES_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    contract_version text,
    episode_key text,
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    decision_entity_type text,
    decision_entity_id text,
    ad_id text,
    creative_id text,
    as_of_date date,
    engine_version text,
    scope_type text,
    scope_id text,
    decision_snapshot_id uuid,
    evaluation_id uuid,
    input_hash text,
    decision_hash text,
    decision_label text,
    source_campaign_id text,
    source_adset_id text,
    recommended_at timestamptz,
    captured_at timestamptz,
    job_run_id uuid
  )
)
INSERT INTO engine_v3_ad_recommendation_episodes (
  contract_version, episode_key, business_ref_id, business_id,
  provider_account_ref_id, provider_account_id, decision_entity_type,
  decision_entity_id, ad_id,
  creative_id, as_of_date, engine_version, scope_type, scope_id,
  decision_snapshot_id, evaluation_id, input_hash, decision_hash,
  decision_label, source_campaign_id, source_adset_id, recommended_at,
  captured_at, job_run_id
)
SELECT
  contract_version, episode_key, business_ref_id, business_id,
  provider_account_ref_id, provider_account_id, decision_entity_type,
  decision_entity_id, ad_id,
  creative_id, as_of_date, engine_version, scope_type, scope_id,
  decision_snapshot_id, evaluation_id, input_hash, decision_hash,
  decision_label, source_campaign_id, source_adset_id, recommended_at,
  captured_at, job_run_id
FROM payload
ON CONFLICT (episode_key) DO NOTHING
RETURNING id
`;

export const READ_AD_RECOMMENDATION_EPISODES_QUERY = `
SELECT
  episode_key, business_ref_id::text AS business_ref_id, business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, ad_id, creative_id, as_of_date::text AS as_of_date,
  engine_version, scope_type, scope_id,
  decision_snapshot_id::text AS decision_snapshot_id,
  evaluation_id::text AS evaluation_id, input_hash, decision_hash,
  decision_label, source_campaign_id, source_adset_id,
  recommended_at::text AS recommended_at
FROM engine_v3_ad_recommendation_episodes
WHERE business_ref_id = $1::uuid
  AND engine_version = $4
  AND recommended_at > ($2::timestamptz - ($3::integer * interval '1 day'))
  AND recommended_at <= $2::timestamptz
ORDER BY recommended_at, provider_account_id, ad_id, episode_key
`;

export const FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY = `
WITH episodes AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS episode(
    episode_key text,
    business_id uuid,
    provider_account_ref_id uuid,
    provider_account_id text,
    ad_id text,
    snapshot_id uuid,
    evaluation_id uuid,
    engine_version text,
    decision_hash text
  )
)
SELECT
  episode.episode_key,
  receipt.id::text AS receipt_id,
  receipt.receipt_hash,
  receipt.source_action_log_id::text AS action_log_id,
  receipt.contract_version,
	  receipt.business_id,
  receipt.provider_account_ref_id::text AS provider_account_ref_id,
  receipt.provider_account_id,
  receipt.source_ad_id,
  receipt.source_snapshot_id::text AS source_snapshot_id,
  receipt.source_evaluation_id::text AS source_evaluation_id,
  receipt.source_engine_version,
  receipt.source_decision_hash,
  receipt.target_entity_type,
  receipt.target_entity_id,
  receipt.operator_action,
  receipt.successor_kind,
  receipt.resulting_ad_id,
  receipt.idempotency_key,
  receipt.action_status AS status,
  receipt.dry_run,
  receipt.provider_verified,
  receipt.requested_at::text AS requested_at,
  receipt.verified_at::text AS verified_at,
  receipt.finalized_at::text AS finalized_at,
  receipt.captured_at::text AS captured_at,
  receipt.verification_entity_id,
  receipt.verification_status,
  receipt.verification_lineage
FROM episodes episode
INNER JOIN engine_v3_ad_operator_action_receipts receipt
	  ON receipt.episode_key = episode.episode_key
 AND receipt.business_ref_id = episode.business_id
 AND receipt.business_id = episode.business_id::text
 AND receipt.provider_account_ref_id = episode.provider_account_ref_id
 AND receipt.provider_account_id = episode.provider_account_id
 AND receipt.source_ad_id = episode.ad_id
 AND receipt.source_snapshot_id = episode.snapshot_id
 AND receipt.source_evaluation_id = episode.evaluation_id
 AND receipt.source_engine_version = episode.engine_version
 AND receipt.source_decision_hash = episode.decision_hash
 AND receipt.captured_at <= $2::timestamptz
ORDER BY episode.episode_key, receipt.requested_at, receipt.id
`;

/** @deprecated Native detection reads immutable typed receipts only. */
export const FIND_EXACT_META_ADS_ACTION_LINEAGE_QUERY =
  FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY;

/**
 * D075 confirmed_until — the scope-confirmation half. A later delta manifest
 * in the same endpoint scope re-observed the whole scope; while this row is
 * still the entity's deterministic complete-lane winner, each such run
 * re-confirms the state unchanged. Superseded rows get no extension.
 * Exported so the real-Postgres D15 seam asserts the exact production
 * predicate per row (aliases required in the embedding query:
 * `state`, `observation_run`, `target.cutoff`).
 */
export const AD_OPERATOR_SCOPE_CONFIRMATION_LATERAL_SQL = `
    SELECT MAX(
      GREATEST(
        later_run.captured_at,
        CASE WHEN later_run.last_captured_at <= target.cutoff
          THEN later_run.last_captured_at ELSE later_run.captured_at END
      )
    ) AS confirmed_until
    FROM meta_entity_observation_runs later_run
    WHERE state.run_completeness = 'complete'
      AND later_run.manifest_kind = 'delta'
      AND later_run.completeness = 'complete'
      AND later_run.business_ref_id = state.business_ref_id
      AND later_run.business_id = state.business_id
      AND later_run.provider_account_ref_id = state.provider_account_ref_id
      AND later_run.provider_account_id = state.provider_account_id
      AND later_run.entity_type = state.entity_type
      AND later_run.endpoint = observation_run.endpoint
      AND later_run.captured_at >= state.captured_at
      AND later_run.captured_at <= target.cutoff
      AND NOT EXISTS (
        SELECT 1
        FROM meta_entity_state_history newer
        WHERE newer.business_ref_id = state.business_ref_id
          AND newer.business_id = state.business_id
          AND newer.provider_account_ref_id = state.provider_account_ref_id
          AND newer.provider_account_id = state.provider_account_id
          AND newer.entity_type = state.entity_type
          AND newer.entity_id = state.entity_id
          AND newer.run_completeness = 'complete'
          -- Supersession follows the exact D075 complete-lane winner order
          -- (captured_at DESC, created_at DESC, id DESC): an equal-captured
          -- competitor that wins the tuple tie supersedes; the tuple-lesser
          -- row never receives confirmation.
          AND (newer.captured_at, newer.created_at, newer.id)
              > (state.captured_at, state.created_at, state.id)
          AND newer.captured_at <= target.cutoff
          -- Supersession authority is the row's own ENDPOINT scope — the
          -- same scope unit the D075 writer diffs and the reconstruction
          -- reads. A sibling endpoint's rows are a different manifest and
          -- neither supersede this endpoint's winner nor borrow its
          -- confirmation.
          AND EXISTS (
            SELECT 1
            FROM meta_entity_observation_runs newer_run
            WHERE newer_run.id = newer.run_id
              AND newer_run.endpoint = observation_run.endpoint
          )
      )`;

export const FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY = `
WITH targets AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS target(
    episode_key text,
    business_id uuid,
    provider_account_ref_id uuid,
    provider_account_id text,
    entity_type text,
    entity_id text,
    recommended_at timestamptz,
    window_end timestamptz,
    cutoff timestamptz
  )
), truth_events AS (
  -- Bind the tiny request target set before combining state and tombstone
  -- history. This CTE is referenced three times below, so PostgreSQL may
  -- materialize it. Building the old unscoped union first forced every job to
  -- read and spill the whole multi-business history table even when only a
  -- handful of exact entities were requested.
  SELECT
    target.episode_key,
    target.entity_type AS target_entity_type,
    target.entity_id AS target_entity_id,
    target.recommended_at,
    target.window_end,
    target.cutoff,
    'meta_entity_state_history'::text AS evidence_kind,
    state.id::text AS evidence_id,
    state.id::text AS state_history_id,
    NULL::text AS tombstone_id,
    state.run_id::text AS run_id,
    observation_run.run_hash,
    state.run_completeness,
    state.business_ref_id::text AS business_id,
    state.provider_account_ref_id::text AS provider_account_ref_id,
    state.provider_account_id,
    state.entity_type,
    state.entity_id,
    state.campaign_id,
    state.adset_id,
    state.ad_id,
    state.creative_id,
    state.configured_status,
    state.effective_status,
    state.campaign_daily_budget_raw,
    state.campaign_lifetime_budget_raw,
    state.adset_daily_budget_raw,
    state.adset_lifetime_budget_raw,
    state.budget_origin,
    state.presence,
    state.field_coverage_json,
    state.observed_at,
    state.captured_at,
    -- D075 consumer sweep: a state row's captured_at freezes at first
    -- capture — the writer confirms an unchanged state through the run
    -- heartbeat (last_captured_at) and, for delta manifests, through later
    -- delta runs whose reconstruction re-observed this winner unchanged.
    -- confirmed_until is that as-of-cutoff re-confirmation clock; without
    -- it no evidence row can ever certify window-end truth for an
    -- unchanged entity and no-response stays permanently unknown.
    GREATEST(
      state.captured_at,
      COALESCE(
        CASE WHEN observation_run.last_captured_at <= target.cutoff
          THEN observation_run.last_captured_at END,
        state.captured_at
      ),
      COALESCE(scope_confirmation.confirmed_until, state.captured_at)
    ) AS confirmed_until,
    state.state_hash::text AS state_hash,
    NULL::text AS tombstone_reason,
    NULL::jsonb AS provider_evidence_json,
    NULL::text AS tombstone_hash,
    state.created_at
  FROM targets target
  INNER JOIN meta_entity_state_history state
    ON state.business_ref_id = target.business_id
   AND state.business_id = target.business_id::text
   AND state.provider_account_ref_id = target.provider_account_ref_id
   AND state.provider_account_id = target.provider_account_id
   AND state.entity_type = target.entity_type
   AND state.entity_id = target.entity_id
   AND state.observed_at <= target.cutoff
   AND state.captured_at <= target.cutoff
  INNER JOIN meta_entity_observation_runs observation_run
    ON observation_run.id = state.run_id
   AND observation_run.business_ref_id = state.business_ref_id
   AND observation_run.business_id = state.business_id
   AND observation_run.provider_account_ref_id = state.provider_account_ref_id
   AND observation_run.provider_account_id = state.provider_account_id
   AND observation_run.entity_type = state.entity_type
   AND observation_run.completeness = state.run_completeness
  LEFT JOIN LATERAL (
${AD_OPERATOR_SCOPE_CONFIRMATION_LATERAL_SQL}
  ) scope_confirmation ON TRUE
  UNION ALL
  SELECT
    target.episode_key,
    target.entity_type AS target_entity_type,
    target.entity_id AS target_entity_id,
    target.recommended_at,
    target.window_end,
    target.cutoff,
    'meta_entity_tombstones'::text AS evidence_kind,
    tombstone.id::text AS evidence_id,
    NULL::text AS state_history_id,
    tombstone.id::text AS tombstone_id,
    tombstone.run_id::text AS run_id,
    observation_run.run_hash,
    tombstone.run_completeness,
    tombstone.business_ref_id::text AS business_id,
    tombstone.provider_account_ref_id::text AS provider_account_ref_id,
    tombstone.provider_account_id,
    tombstone.entity_type,
    tombstone.entity_id,
    CASE WHEN tombstone.entity_type = 'campaign'
      THEN tombstone.entity_id ELSE NULL END AS campaign_id,
    CASE WHEN tombstone.entity_type = 'adset'
      THEN tombstone.entity_id ELSE NULL END AS adset_id,
    CASE WHEN tombstone.entity_type = 'ad'
      THEN tombstone.entity_id ELSE NULL END AS ad_id,
    CASE WHEN tombstone.entity_type = 'creative'
      THEN tombstone.entity_id ELSE NULL END AS creative_id,
    NULL::text AS configured_status,
    NULL::text AS effective_status,
    NULL::text AS campaign_daily_budget_raw,
    NULL::text AS campaign_lifetime_budget_raw,
    NULL::text AS adset_daily_budget_raw,
    NULL::text AS adset_lifetime_budget_raw,
    'not_observed'::text AS budget_origin,
    'explicit_tombstone'::text AS presence,
    '{}'::jsonb AS field_coverage_json,
    tombstone.observed_at,
    tombstone.captured_at,
    tombstone.captured_at AS confirmed_until,
    NULL::text AS state_hash,
    tombstone.reason AS tombstone_reason,
    tombstone.provider_evidence_json,
    tombstone.tombstone_hash::text AS tombstone_hash,
    tombstone.created_at
  FROM targets target
  INNER JOIN meta_entity_tombstones tombstone
    ON tombstone.business_ref_id = target.business_id
   AND tombstone.business_id = target.business_id::text
   AND tombstone.provider_account_ref_id = target.provider_account_ref_id
   AND tombstone.provider_account_id = target.provider_account_id
   AND tombstone.entity_type = target.entity_type
   AND tombstone.entity_id = target.entity_id
   AND tombstone.observed_at <= target.cutoff
   AND tombstone.captured_at <= target.cutoff
  INNER JOIN meta_entity_observation_runs observation_run
    ON observation_run.id = tombstone.run_id
   AND observation_run.business_ref_id = tombstone.business_ref_id
   AND observation_run.business_id = tombstone.business_id
   AND observation_run.provider_account_ref_id = tombstone.provider_account_ref_id
   AND observation_run.provider_account_id = tombstone.provider_account_id
   AND observation_run.entity_type = tombstone.entity_type
   AND observation_run.completeness = tombstone.run_completeness
), baseline AS (
  SELECT DISTINCT ON (
    truth.episode_key, truth.target_entity_type, truth.target_entity_id
  ) truth.*
  FROM truth_events truth
  WHERE truth.observed_at <= truth.recommended_at
    AND truth.captured_at <= truth.recommended_at
  ORDER BY truth.episode_key, truth.target_entity_type, truth.target_entity_id,
    truth.observed_at DESC, truth.captured_at DESC,
    (truth.evidence_kind = 'meta_entity_tombstones') DESC,
    truth.created_at DESC, truth.evidence_id DESC
), post_recommendation AS (
  SELECT truth.*
  FROM truth_events truth
  WHERE truth.observed_at > truth.recommended_at
    AND truth.observed_at <= LEAST(truth.window_end, truth.cutoff)
    AND truth.captured_at <= truth.cutoff
), terminal_confirmation AS (
  SELECT DISTINCT ON (
    truth.episode_key, truth.target_entity_type, truth.target_entity_id
  ) truth.*
  FROM truth_events truth
  WHERE truth.cutoff >= truth.window_end
    AND truth.observed_at <= truth.window_end
    AND truth.confirmed_until >= truth.window_end
    AND truth.captured_at <= truth.cutoff
  ORDER BY truth.episode_key, truth.target_entity_type, truth.target_entity_id,
    truth.captured_at DESC, truth.observed_at DESC,
    (truth.evidence_kind = 'meta_entity_tombstones') DESC,
    truth.created_at DESC, truth.evidence_id DESC
)
SELECT
  scoped.episode_key, scoped.evidence_kind, scoped.evidence_id,
  scoped.state_history_id, scoped.tombstone_id,
  scoped.run_id, scoped.run_hash,
  scoped.run_completeness,
  scoped.business_id, scoped.provider_account_ref_id,
  scoped.provider_account_id, scoped.entity_type,
  scoped.entity_id, scoped.campaign_id, scoped.adset_id, scoped.ad_id,
  scoped.creative_id, scoped.configured_status, scoped.effective_status,
  scoped.campaign_daily_budget_raw, scoped.campaign_lifetime_budget_raw,
  scoped.adset_daily_budget_raw, scoped.adset_lifetime_budget_raw,
  scoped.budget_origin, scoped.presence, scoped.field_coverage_json,
  scoped.observed_at::text AS observed_at,
  scoped.captured_at::text AS captured_at,
  scoped.confirmed_until::text AS confirmed_until, scoped.state_hash,
  scoped.tombstone_reason, scoped.provider_evidence_json,
  scoped.tombstone_hash
FROM (
  SELECT * FROM baseline
  UNION
  SELECT * FROM post_recommendation
  UNION
  SELECT * FROM terminal_confirmation
) scoped
ORDER BY scoped.episode_key, scoped.observed_at, scoped.captured_at,
  (scoped.evidence_kind = 'meta_entity_tombstones'), scoped.evidence_id
`;

export const REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY = `
WITH response_payload AS (
  SELECT *
  FROM jsonb_to_recordset($1::jsonb) AS row(
    contract_version text,
    episode_key text,
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    job_run_id uuid,
    response_cutoff timestamptz,
    observation_status text,
    response_type text,
    operator_response_detected boolean,
    ad_treatment_detected boolean,
    detected_at timestamptz,
    action_receipt_id uuid,
    action_log_id uuid,
    successor_ad_id text,
    successor_kind text,
    budget_owner_type text,
    budget_owner_id text,
    window_start timestamptz,
    window_end timestamptz,
    window_closed boolean,
    source_complete boolean,
    source_set_hash text,
    action_receipt_count integer,
    state_observation_count integer,
    tombstone_observation_count integer,
    required_state_target_count integer,
    complete_state_target_count integer,
    diagnostics_json jsonb,
    evidence_hashes_json jsonb,
    evidence_count integer,
    evidence_set_hash text,
    replacement_set_hash text,
    response_hash text
  )
), event_payload AS (
  SELECT *
  FROM jsonb_to_recordset($2::jsonb) AS row(
    contract_version text,
    episode_key text,
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    entity_type text,
    entity_id text,
    job_run_id uuid,
    response_cutoff timestamptz,
    evidence_kind text,
    evidence_source_id text,
    action_receipt_id uuid,
    state_history_id uuid,
    tombstone_id uuid,
    evidence_observed_at timestamptz,
    evidence_captured_at timestamptz,
    treatment_eligible boolean,
    diagnostic_code text,
    evidence_json jsonb,
    evidence_hash text
  )
), upserted_responses AS (
  INSERT INTO engine_v3_ad_operator_responses (
    contract_version, episode_key, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id, job_run_id,
    response_cutoff, observation_status,
    response_type, operator_response_detected, ad_treatment_detected,
    detected_at, action_receipt_id, action_log_id, successor_ad_id,
    successor_kind, budget_owner_type, budget_owner_id, window_start,
    window_end, window_closed, source_complete, source_set_hash,
    action_receipt_count, state_observation_count, tombstone_observation_count,
    required_state_target_count, complete_state_target_count,
    diagnostics_json, evidence_hashes_json, evidence_count,
    evidence_set_hash, replacement_set_hash, response_hash
  )
  SELECT
    contract_version, episode_key, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id, job_run_id,
    response_cutoff, observation_status,
    response_type, operator_response_detected, ad_treatment_detected,
    detected_at, action_receipt_id, action_log_id, successor_ad_id,
    successor_kind, budget_owner_type, budget_owner_id, window_start,
    window_end, window_closed, source_complete, source_set_hash,
    action_receipt_count, state_observation_count, tombstone_observation_count,
    required_state_target_count, complete_state_target_count,
    diagnostics_json, evidence_hashes_json, evidence_count,
    evidence_set_hash, replacement_set_hash, response_hash
  FROM response_payload
  ON CONFLICT (episode_key, response_cutoff) DO UPDATE SET
    contract_version = EXCLUDED.contract_version,
    business_ref_id = EXCLUDED.business_ref_id,
    business_id = EXCLUDED.business_id,
    provider_account_ref_id = EXCLUDED.provider_account_ref_id,
    provider_account_id = EXCLUDED.provider_account_id,
    job_run_id = EXCLUDED.job_run_id,
    observation_status = EXCLUDED.observation_status,
    response_type = EXCLUDED.response_type,
    operator_response_detected = EXCLUDED.operator_response_detected,
    ad_treatment_detected = EXCLUDED.ad_treatment_detected,
    detected_at = EXCLUDED.detected_at,
    action_receipt_id = EXCLUDED.action_receipt_id,
    action_log_id = EXCLUDED.action_log_id,
    successor_ad_id = EXCLUDED.successor_ad_id,
    successor_kind = EXCLUDED.successor_kind,
    budget_owner_type = EXCLUDED.budget_owner_type,
    budget_owner_id = EXCLUDED.budget_owner_id,
    window_start = EXCLUDED.window_start,
    window_end = EXCLUDED.window_end,
    window_closed = EXCLUDED.window_closed,
    source_complete = EXCLUDED.source_complete,
    source_set_hash = EXCLUDED.source_set_hash,
    action_receipt_count = EXCLUDED.action_receipt_count,
    state_observation_count = EXCLUDED.state_observation_count,
    tombstone_observation_count = EXCLUDED.tombstone_observation_count,
    required_state_target_count = EXCLUDED.required_state_target_count,
    complete_state_target_count = EXCLUDED.complete_state_target_count,
    diagnostics_json = EXCLUDED.diagnostics_json,
    evidence_hashes_json = EXCLUDED.evidence_hashes_json,
    evidence_count = EXCLUDED.evidence_count,
    evidence_set_hash = EXCLUDED.evidence_set_hash,
    replacement_set_hash = EXCLUDED.replacement_set_hash,
    response_hash = EXCLUDED.response_hash
  RETURNING episode_key, response_cutoff, replacement_set_hash
), upserted_events AS (
  INSERT INTO engine_v3_ad_operator_response_events (
    contract_version, episode_key, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id, entity_type, entity_id,
    job_run_id, response_cutoff, evidence_kind,
    evidence_source_id, action_receipt_id, state_history_id, tombstone_id,
    evidence_observed_at, evidence_captured_at, treatment_eligible,
    diagnostic_code, evidence_json, evidence_hash
  )
  SELECT
    contract_version, episode_key, business_ref_id, business_id,
    provider_account_ref_id, provider_account_id, entity_type, entity_id,
    job_run_id, response_cutoff, evidence_kind,
    evidence_source_id, action_receipt_id, state_history_id, tombstone_id,
    evidence_observed_at, evidence_captured_at, treatment_eligible,
    diagnostic_code, evidence_json, evidence_hash
  FROM event_payload
  ON CONFLICT (episode_key, response_cutoff, evidence_hash) DO UPDATE SET
    contract_version = EXCLUDED.contract_version,
    business_ref_id = EXCLUDED.business_ref_id,
    business_id = EXCLUDED.business_id,
    provider_account_ref_id = EXCLUDED.provider_account_ref_id,
    provider_account_id = EXCLUDED.provider_account_id,
    entity_type = EXCLUDED.entity_type,
    entity_id = EXCLUDED.entity_id,
    job_run_id = EXCLUDED.job_run_id,
    evidence_kind = EXCLUDED.evidence_kind,
    evidence_source_id = EXCLUDED.evidence_source_id,
    action_receipt_id = EXCLUDED.action_receipt_id,
    state_history_id = EXCLUDED.state_history_id,
    tombstone_id = EXCLUDED.tombstone_id,
    evidence_observed_at = EXCLUDED.evidence_observed_at,
    evidence_captured_at = EXCLUDED.evidence_captured_at,
    treatment_eligible = EXCLUDED.treatment_eligible,
    diagnostic_code = EXCLUDED.diagnostic_code,
    evidence_json = EXCLUDED.evidence_json
  RETURNING episode_key, response_cutoff, evidence_hash
), deleted_stale_events AS (
  DELETE FROM engine_v3_ad_operator_response_events existing
  USING response_payload response
  WHERE existing.episode_key = response.episode_key
    AND existing.response_cutoff = response.response_cutoff
    AND NOT EXISTS (
      SELECT 1
      FROM event_payload event
      WHERE event.episode_key = existing.episode_key
        AND event.response_cutoff = existing.response_cutoff
        AND event.evidence_hash = existing.evidence_hash
    )
  RETURNING existing.id
)
SELECT
  (SELECT count(*)::integer FROM upserted_responses) AS responses_written,
  (SELECT count(*)::integer FROM upserted_events) AS events_written,
  (SELECT count(*)::integer FROM deleted_stale_events) AS events_pruned,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'episode_key', episode_key,
      'response_cutoff', response_cutoff,
      'replacement_set_hash', replacement_set_hash
    ) ORDER BY episode_key, response_cutoff)
    FROM upserted_responses
  ), '[]'::jsonb) AS response_proof_json,
  COALESCE((
    SELECT jsonb_agg(jsonb_build_object(
      'episode_key', episode_key,
      'response_cutoff', response_cutoff,
      'evidence_hash', evidence_hash
    ) ORDER BY episode_key, response_cutoff, evidence_hash)
    FROM upserted_events
  ), '[]'::jsonb) AS event_proof_json
`;

export const READ_AD_OPERATOR_RESPONSES_QUERY = `
WITH ranked AS (
  SELECT
    response.id::text AS response_id,
    response.episode_key,
    episode.business_ref_id::text AS business_id,
    episode.business_id AS business_display_id,
    episode.provider_account_id,
    episode.ad_id,
    episode.creative_id,
    episode.engine_version,
    episode.decision_snapshot_id::text AS decision_snapshot_id,
    episode.evaluation_id::text AS evaluation_id,
	    episode.decision_hash,
	    response.response_cutoff::text AS response_cutoff,
	    response.observation_status,
	    response.response_type,
    response.operator_response_detected,
    response.ad_treatment_detected,
	    response.detected_at::text AS detected_at,
	    response.action_receipt_id::text AS action_receipt_id,
	    response.action_log_id::text AS action_log_id,
    response.successor_ad_id,
    response.successor_kind,
	    response.budget_owner_type,
	    response.budget_owner_id,
	    response.window_start::text AS window_start,
	    response.window_end::text AS window_end,
	    response.window_closed,
	    response.source_complete,
	    response.source_set_hash,
	    response.action_receipt_count,
	    response.state_observation_count,
	    response.tombstone_observation_count,
	    response.required_state_target_count,
	    response.complete_state_target_count,
	    response.diagnostics_json,
	    response.evidence_hashes_json,
	    response.evidence_count,
	    response.evidence_set_hash,
	    response.replacement_set_hash,
	    response.response_hash,
    ROW_NUMBER() OVER (
      PARTITION BY response.episode_key
      ORDER BY response.response_cutoff DESC, response.created_at DESC,
        response.id DESC
    ) AS row_number
  FROM engine_v3_ad_operator_responses response
  INNER JOIN engine_v3_ad_recommendation_episodes episode
    ON episode.episode_key = response.episode_key
   AND episode.business_ref_id = response.business_ref_id
   AND episode.business_id = response.business_id
   AND episode.provider_account_ref_id = response.provider_account_ref_id
   AND episode.provider_account_id = response.provider_account_id
  WHERE episode.business_ref_id = $1::uuid
    AND ($2::text IS NULL OR episode.provider_account_id = $2)
    AND ($3::text IS NULL OR episode.ad_id = $3)
	    AND episode.engine_version = $4
    AND ($5::timestamptz IS NULL OR response.response_cutoff <= $5)
)
SELECT *
FROM ranked
WHERE row_number = 1
ORDER BY response_cutoff DESC, provider_account_id, ad_id, episode_key
LIMIT $6::integer
`;

type EpisodeCandidateRow = Record<string, unknown> & {
  business_ref_id: unknown;
  business_id: unknown;
  provider_account_ref_id: unknown;
  provider_account_binding_count: unknown;
  provider_account_id: unknown;
  ad_id: unknown;
  creative_id: unknown;
  as_of_date: unknown;
  engine_version: unknown;
  scope_type: unknown;
  scope_id: unknown;
  decision_snapshot_id: unknown;
  evaluation_id: unknown;
  input_hash: unknown;
  decision_hash: unknown;
  decision_label: unknown;
  source_campaign_id: unknown;
  source_adset_id: unknown;
  recommended_at: unknown;
};

type StoredEpisodeRow = EpisodeCandidateRow & { episode_key: unknown };

type ActionLineageRow = Record<string, unknown> & {
  episode_key: unknown;
  receipt_id: unknown;
  receipt_hash: unknown;
  action_log_id: unknown;
  contract_version: unknown;
  business_id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  source_ad_id: unknown;
  source_snapshot_id: unknown;
  source_evaluation_id: unknown;
  source_engine_version: unknown;
  source_decision_hash: unknown;
  target_entity_type: unknown;
  target_entity_id: unknown;
  operator_action: unknown;
  successor_kind: unknown;
  resulting_ad_id: unknown;
  idempotency_key: unknown;
  status: unknown;
  dry_run: unknown;
  provider_verified: unknown;
  verification_lineage: unknown;
  requested_at: unknown;
  verified_at: unknown;
  finalized_at: unknown;
  captured_at: unknown;
  verification_entity_id: unknown;
  verification_status: unknown;
};

type StateRow = Record<string, unknown> & {
  episode_key: unknown;
  evidence_kind: unknown;
  evidence_id: unknown;
  state_history_id: unknown;
  tombstone_id: unknown;
  run_id: unknown;
  run_hash: unknown;
  run_completeness: unknown;
  business_id: unknown;
  provider_account_ref_id: unknown;
  provider_account_id: unknown;
  entity_type: unknown;
  entity_id: unknown;
  campaign_id: unknown;
  adset_id: unknown;
  ad_id: unknown;
  creative_id: unknown;
  configured_status: unknown;
  effective_status: unknown;
  campaign_daily_budget_raw: unknown;
  campaign_lifetime_budget_raw: unknown;
  adset_daily_budget_raw: unknown;
  adset_lifetime_budget_raw: unknown;
  budget_origin: unknown;
  presence: unknown;
  field_coverage_json: unknown;
  observed_at: unknown;
  captured_at: unknown;
  confirmed_until: unknown;
  state_hash: unknown;
  tombstone_reason: unknown;
  provider_evidence_json: unknown;
  tombstone_hash: unknown;
};

type ResponseReadRow = Record<string, unknown> & {
  response_id: unknown;
  episode_key: unknown;
  business_id: unknown;
  business_display_id: unknown;
  provider_account_id: unknown;
  ad_id: unknown;
  creative_id: unknown;
  engine_version: unknown;
  decision_snapshot_id: unknown;
  evaluation_id: unknown;
  decision_hash: unknown;
  response_cutoff: unknown;
  observation_status: unknown;
  response_type: unknown;
  operator_response_detected: unknown;
  ad_treatment_detected: unknown;
  detected_at: unknown;
  action_receipt_id: unknown;
  action_log_id: unknown;
  successor_ad_id: unknown;
  successor_kind: unknown;
  budget_owner_type: unknown;
  budget_owner_id: unknown;
  window_start: unknown;
  window_end: unknown;
  window_closed: unknown;
  source_complete: unknown;
  source_set_hash: unknown;
  action_receipt_count: unknown;
  state_observation_count: unknown;
  tombstone_observation_count: unknown;
  required_state_target_count: unknown;
  complete_state_target_count: unknown;
  diagnostics_json: unknown;
  evidence_hashes_json: unknown;
  evidence_count: unknown;
  evidence_set_hash: unknown;
  replacement_set_hash: unknown;
  response_hash: unknown;
};

function stringValue(value: unknown, field: string): string {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} must be a non-empty string.`);
  return normalized;
}

function nullableString(value: unknown): string | null {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function timestampValue(value: unknown, field: string): string {
  const raw = stringValue(value, field);
  const parsed = Date.parse(raw);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid exact timestamp.`);
  }
  return new Date(parsed).toISOString();
}

function responsePersistenceKey(episodeKey: unknown, cutoff: unknown): string {
  return `${stringValue(episodeKey, "episode_key")}\u0000${timestampValue(
    cutoff,
    "response_cutoff",
  )}`;
}

function recordValue(value: unknown): Record<string, unknown> {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Record<string, unknown>)
    : {};
}

function numberOrNull(value: unknown): number | null {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) && parsed >= 0 ? parsed : null;
}

function integerValue(value: unknown, field: string): number {
  const parsed = typeof value === "number" ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${field} must be a non-negative safe integer.`);
  }
  return parsed;
}

function mapEpisode(row: EpisodeCandidateRow | StoredEpisodeRow) {
  if (
    "provider_account_binding_count" in row &&
    integerValue(
      row.provider_account_binding_count,
      "provider_account_binding_count",
    ) !== 1
  ) {
    throw new Error(
      "Native episode requires exactly one physical Meta account binding.",
    );
  }
  const episode = buildAdRecommendationEpisode({
    businessId: stringValue(row.business_ref_id, "business_ref_id"),
    businessDisplayId: stringValue(row.business_id, "business_id"),
    providerAccountRefId: stringValue(
      row.provider_account_ref_id,
      "provider_account_ref_id",
    ),
    providerAccountId: stringValue(
      row.provider_account_id,
      "provider_account_id",
    ),
    adId: stringValue(row.ad_id, "ad_id"),
    creativeId: nullableString(row.creative_id),
    asOfDate: stringValue(row.as_of_date, "as_of_date"),
    engineVersion: stringValue(row.engine_version, "engine_version"),
    scopeType: stringValue(row.scope_type, "scope_type"),
    scopeId: stringValue(row.scope_id, "scope_id"),
    snapshotId: stringValue(row.decision_snapshot_id, "decision_snapshot_id"),
    evaluationId: stringValue(row.evaluation_id, "evaluation_id"),
    inputHash: stringValue(row.input_hash, "input_hash"),
    decisionHash: stringValue(row.decision_hash, "decision_hash"),
    decisionLabel: stringValue(row.decision_label, "decision_label"),
    sourceCampaignId: nullableString(row.source_campaign_id),
    sourceAdsetId: nullableString(row.source_adset_id),
    recommendedAt: stringValue(row.recommended_at, "recommended_at"),
  });
  if (
    "episode_key" in row &&
    stringValue(row.episode_key, "episode_key") !== episode.episodeKey
  ) {
    throw new Error("Stored episode key does not match exact source lineage.");
  }
  return episode;
}

function episodePersistencePayload(
  episodes: readonly AdRecommendationEpisode[],
  capturedAt: string,
  jobRunId: string,
) {
  return episodes.map((episode) => ({
    contract_version: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
    episode_key: episode.episodeKey,
    business_ref_id: episode.businessId,
    business_id: episode.businessDisplayId,
    provider_account_ref_id: episode.providerAccountRefId,
    provider_account_id: episode.providerAccountId,
    decision_entity_type: "ad",
    decision_entity_id: episode.adId,
    ad_id: episode.adId,
    creative_id: episode.creativeId,
    as_of_date: episode.asOfDate,
    engine_version: episode.engineVersion,
    scope_type: episode.scopeType,
    scope_id: episode.scopeId,
    decision_snapshot_id: episode.snapshotId,
    evaluation_id: episode.evaluationId,
    input_hash: episode.inputHash,
    decision_hash: episode.decisionHash,
    decision_label: episode.decisionLabel,
    source_campaign_id: episode.sourceCampaignId,
    source_adset_id: episode.sourceAdsetId,
    recommended_at: episode.recommendedAt,
    captured_at: capturedAt,
    job_run_id: jobRunId,
  }));
}

function frozenEpisodeHash(episode: AdRecommendationEpisode): string {
  return canonicalSha256({
    episodeKey: episode.episodeKey,
    businessId: episode.businessId,
    businessDisplayId: episode.businessDisplayId,
    providerAccountRefId: episode.providerAccountRefId,
    providerAccountId: episode.providerAccountId,
    adId: episode.adId,
    creativeId: episode.creativeId,
    asOfDate: episode.asOfDate,
    engineVersion: episode.engineVersion,
    scopeType: episode.scopeType,
    scopeId: episode.scopeId,
    snapshotId: episode.snapshotId,
    evaluationId: episode.evaluationId,
    inputHash: episode.inputHash,
    decisionHash: episode.decisionHash,
    decisionLabel: episode.decisionLabel,
    sourceCampaignId: episode.sourceCampaignId,
    sourceAdsetId: episode.sourceAdsetId,
    recommendedAt: episode.recommendedAt,
  });
}

export function assertAdRecommendationEpisodeCapture(input: {
  candidates: readonly AdRecommendationEpisode[];
  stored: readonly AdRecommendationEpisode[];
}): void {
  const storedByKey = new Map(
    input.stored.map((episode) => [episode.episodeKey, episode]),
  );
  const candidateKeys = new Set<string>();
  for (const candidate of input.candidates) {
    if (candidateKeys.has(candidate.episodeKey)) {
      throw new Error(
        `Duplicate native recommendation episode candidate: ${candidate.episodeKey}`,
      );
    }
    candidateKeys.add(candidate.episodeKey);
    const stored = storedByKey.get(candidate.episodeKey);
    if (!stored || frozenEpisodeHash(stored) !== frozenEpisodeHash(candidate)) {
      throw new Error(
        `Native recommendation episode freeze did not reconcile: ${candidate.episodeKey}`,
      );
    }
  }
}

export async function persistAdRecommendationEpisodes(
  episodes: readonly AdRecommendationEpisode[],
  capturedAt: string,
  jobRunId: string,
  db: DbClient = getDb(),
): Promise<number> {
  if (episodes.length === 0) return 0;
  const episodeKeys = new Set(episodes.map((episode) => episode.episodeKey));
  if (episodeKeys.size !== episodes.length) {
    throw new TypeError(
      "Recommendation episode batch contains duplicate keys.",
    );
  }
  const rows = await db.query<IdRow>(INSERT_AD_RECOMMENDATION_EPISODES_QUERY, [
    JSON.stringify(episodePersistencePayload(episodes, capturedAt, jobRunId)),
  ]);
  return rows.length;
}

async function readRecommendationEpisodes(input: {
  businessId: string;
  cutoff: string;
  lookbackDays: number;
  engineVersion: string;
  db: DbClient;
}) {
  const rows = await input.db.query<StoredEpisodeRow>(
    READ_AD_RECOMMENDATION_EPISODES_QUERY,
    [input.businessId, input.cutoff, input.lookbackDays, input.engineVersion],
  );
  return rows.map(mapEpisode);
}

function isActionSemantic(value: unknown): value is AdOperatorActionSemantic {
  return [
    "pause",
    "resume",
    "duplicate",
    "rebuild",
    "budget_increase",
    "budget_decrease",
    "budget_change",
  ].includes(String(value));
}

function isTargetEntityType(
  value: unknown,
): value is AdOperatorTargetEntityType {
  return ["ad", "adset", "campaign"].includes(String(value));
}

function mapActionLineage(row: ActionLineageRow): {
  episodeKey: string;
  action: ExactMetaAdsActionLineage;
} {
  if (
    !isActionSemantic(row.operator_action) ||
    !isTargetEntityType(row.target_entity_type)
  ) {
    throw new TypeError(
      "Immutable action receipt contains an invalid typed action.",
    );
  }
  const contractVersion = stringValue(row.contract_version, "contract_version");
  if (
    contractVersion !== DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION &&
    contractVersion !== NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION
  ) {
    throw new TypeError("Immutable action receipt contract is unsupported.");
  }
  const status = stringValue(row.status, "status");
  if (
    status !== "success" &&
    status !== "failure" &&
    status !== "silent_failure"
  ) {
    throw new TypeError("Immutable action receipt status is not terminal.");
  }
  const verifiedAt = nullableString(row.verified_at);
  const verificationEntityId = nullableString(row.verification_entity_id);
  const verificationLineage =
    row.verification_lineage == null
      ? null
      : recordValue(row.verification_lineage);
  return {
    episodeKey: stringValue(row.episode_key, "episode_key"),
    action: {
      receiptId: stringValue(row.receipt_id, "receipt_id"),
      receiptHash: stringValue(row.receipt_hash, "receipt_hash"),
      actionLogId: stringValue(row.action_log_id, "action_log_id"),
      contractVersion,
      businessId: stringValue(row.business_id, "business_id"),
      providerAccountRefId: stringValue(
        row.provider_account_ref_id,
        "provider_account_ref_id",
      ),
      providerAccountId: stringValue(
        row.provider_account_id,
        "provider_account_id",
      ),
      sourceAdId: stringValue(row.source_ad_id, "source_ad_id"),
      sourceSnapshotId: stringValue(
        row.source_snapshot_id,
        "source_snapshot_id",
      ),
      sourceEvaluationId: stringValue(
        row.source_evaluation_id,
        "source_evaluation_id",
      ),
      sourceEngineVersion: stringValue(
        row.source_engine_version,
        "source_engine_version",
      ),
      sourceDecisionHash: stringValue(
        row.source_decision_hash,
        "source_decision_hash",
      ),
      targetEntityType: row.target_entity_type,
      targetEntityId: stringValue(row.target_entity_id, "target_entity_id"),
      action: row.operator_action,
      successorKind:
        row.successor_kind === "duplicate" || row.successor_kind === "rebuild"
          ? row.successor_kind
          : null,
      resultingAdId: nullableString(row.resulting_ad_id),
      idempotencyKey: stringValue(row.idempotency_key, "idempotency_key"),
      status,
      dryRun: row.dry_run === true,
      providerVerified: row.provider_verified === true,
      requestedAt: stringValue(row.requested_at, "requested_at"),
      verifiedAt,
      finalizedAt: stringValue(row.finalized_at, "finalized_at"),
      capturedAt: stringValue(row.captured_at, "captured_at"),
      verificationEntityId,
      verificationStatus: nullableString(row.verification_status),
      verificationLineage: verificationLineage
        ? {
            sourceCreativeId: nullableString(
              verificationLineage.sourceCreativeId,
            ),
            sourceCampaignId: nullableString(
              verificationLineage.sourceCampaignId,
            ),
            sourceAdsetId: nullableString(
              verificationLineage.sourceAdsetId,
            ),
            verifiedProviderAccountId: nullableString(
              verificationLineage.verifiedProviderAccountId,
            ),
            verifiedCreativeId: nullableString(
              verificationLineage.verifiedCreativeId,
            ),
            verifiedCampaignId: nullableString(
              verificationLineage.verifiedCampaignId,
            ),
            verifiedAdsetId: nullableString(
              verificationLineage.verifiedAdsetId,
            ),
          }
        : null,
    },
  };
}

function parseDeliveryObservation(value: unknown) {
  const root = recordValue(value);
  const delivery = recordValue(root[AD_OPERATOR_DELIVERY_FIELD_KEY]);
  if (
    delivery.contract_version !==
      NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION ||
    typeof delivery.window_start !== "string" ||
    typeof delivery.window_end !== "string"
  ) {
    return null;
  }
  const currentWindowSpend = numberOrNull(delivery.current_window_spend);
  if (currentWindowSpend == null) return null;
  return {
    contractVersion: NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION,
    priorWindowSpend: numberOrNull(delivery.prior_window_spend),
    currentWindowSpend,
    windowStart: delivery.window_start,
    windowEnd: delivery.window_end,
  } as const;
}

function mapState(row: StateRow): {
  episodeKey: string;
  state: AdEntityStateObservation | null;
  tombstone: AdEntityTombstoneObservation | null;
} | null {
  if (!isTargetEntityType(row.entity_type)) return null;
  if (
    row.run_completeness !== "complete" &&
    row.run_completeness !== "partial" &&
    row.run_completeness !== "point_lookup"
  ) {
    throw new TypeError("State history row has invalid run completeness.");
  }
  if (row.evidence_kind === "meta_entity_tombstones") {
    if (
      row.run_completeness !== "complete" &&
      row.run_completeness !== "point_lookup"
    ) {
      throw new TypeError("Tombstone row has invalid run completeness.");
    }
    if (
      row.tombstone_reason !== "explicit_deleted" &&
      row.tombstone_reason !== "explicit_not_found"
    ) {
      throw new TypeError("Tombstone row has invalid explicit reason.");
    }
    return {
      episodeKey: stringValue(row.episode_key, "episode_key"),
      state: null,
      tombstone: {
        tombstoneId: stringValue(row.tombstone_id, "tombstone_id"),
        runId: stringValue(row.run_id, "run_id"),
        runHash: stringValue(row.run_hash, "run_hash"),
        runCompleteness: row.run_completeness,
        businessId: stringValue(row.business_id, "business_id"),
        providerAccountRefId: stringValue(
          row.provider_account_ref_id,
          "provider_account_ref_id",
        ),
        providerAccountId: stringValue(
          row.provider_account_id,
          "provider_account_id",
        ),
        entityType: row.entity_type,
        entityId: stringValue(row.entity_id, "entity_id"),
        reason: row.tombstone_reason,
        providerEvidence: recordValue(row.provider_evidence_json),
        observedAt: stringValue(row.observed_at, "observed_at"),
        capturedAt: stringValue(row.captured_at, "captured_at"),
        tombstoneHash: stringValue(row.tombstone_hash, "tombstone_hash"),
      },
    };
  }
  if (row.evidence_kind !== "meta_entity_state_history") {
    throw new TypeError("Entity truth row has unsupported evidence kind.");
  }
  return {
    episodeKey: stringValue(row.episode_key, "episode_key"),
    tombstone: null,
    state: {
      stateHistoryId: stringValue(row.state_history_id, "state_history_id"),
      runId: stringValue(row.run_id, "run_id"),
      runHash: stringValue(row.run_hash, "run_hash"),
      runCompleteness: row.run_completeness,
      businessId: stringValue(row.business_id, "business_id"),
      providerAccountRefId: stringValue(
        row.provider_account_ref_id,
        "provider_account_ref_id",
      ),
      providerAccountId: stringValue(
        row.provider_account_id,
        "provider_account_id",
      ),
      entityType: row.entity_type,
      entityId: stringValue(row.entity_id, "entity_id"),
      campaignId: nullableString(row.campaign_id),
      adsetId: nullableString(row.adset_id),
      adId: nullableString(row.ad_id),
      creativeId: nullableString(row.creative_id),
      configuredStatus: nullableString(row.configured_status),
      effectiveStatus: nullableString(row.effective_status),
      campaignDailyBudgetRaw: nullableString(row.campaign_daily_budget_raw),
      campaignLifetimeBudgetRaw: nullableString(
        row.campaign_lifetime_budget_raw,
      ),
      adsetDailyBudgetRaw: nullableString(row.adset_daily_budget_raw),
      adsetLifetimeBudgetRaw: nullableString(row.adset_lifetime_budget_raw),
      budgetOrigin:
        row.budget_origin === "campaign" ||
        row.budget_origin === "adset" ||
        row.budget_origin === "not_applicable"
          ? row.budget_origin
          : "not_observed",
      presence: row.presence === "present" ? "present" : "absent_unconfirmed",
      observedAt: stringValue(row.observed_at, "observed_at"),
      capturedAt: stringValue(row.captured_at, "captured_at"),
      confirmedUntil: stringValue(row.confirmed_until, "confirmed_until"),
      stateHash: stringValue(row.state_hash, "state_hash"),
      fieldCoverage: recordValue(row.field_coverage_json),
      delivery: parseDeliveryObservation(row.field_coverage_json),
    },
  };
}

function groupByEpisode<T>(
  values: readonly { episodeKey: string; value: T }[],
): Map<string, T[]> {
  const grouped = new Map<string, T[]>();
  for (const entry of values) {
    const current = grouped.get(entry.episodeKey) ?? [];
    current.push(entry.value);
    grouped.set(entry.episodeKey, current);
  }
  return grouped;
}

function actionQueryPayload(episodes: readonly AdRecommendationEpisode[]) {
  return episodes.map((episode) => ({
    episode_key: episode.episodeKey,
    business_id: episode.businessId,
    provider_account_ref_id: episode.providerAccountRefId,
    provider_account_id: episode.providerAccountId,
    ad_id: episode.adId,
    snapshot_id: episode.snapshotId,
    evaluation_id: episode.evaluationId,
    engine_version: episode.engineVersion,
    decision_hash: episode.decisionHash,
  }));
}

function stateTargetPayload(input: {
  episodes: readonly AdRecommendationEpisode[];
  actionsByEpisode: ReadonlyMap<string, readonly ExactMetaAdsActionLineage[]>;
  cutoff: string;
}) {
  const targets = new Map<string, Record<string, unknown>>();
  for (const episode of input.episodes) {
    const window = resolveAdOperatorResponseWindow({
      recommendedAt: episode.recommendedAt,
    });
    const add = (
      entityType: AdOperatorTargetEntityType,
      entityId: string | null,
    ) => {
      if (!entityId) return;
      const key = `${episode.episodeKey}\u0000${entityType}\u0000${entityId}`;
      targets.set(key, {
        episode_key: episode.episodeKey,
        business_id: episode.businessId,
        provider_account_ref_id: episode.providerAccountRefId,
        provider_account_id: episode.providerAccountId,
        entity_type: entityType,
        entity_id: entityId,
        recommended_at: episode.recommendedAt,
        window_end: window.end,
        cutoff: input.cutoff,
      });
    };
    add("ad", episode.adId);
    add("campaign", episode.sourceCampaignId);
    add("adset", episode.sourceAdsetId);
    for (const action of input.actionsByEpisode.get(episode.episodeKey) ?? []) {
      add(action.targetEntityType, action.targetEntityId);
      add("ad", action.resultingAdId);
    }
  }
  return [...targets.values()];
}

export interface AdOperatorResponsePersistenceBatch {
  eventRows: Array<Record<string, unknown>>;
  responseRow: Record<string, unknown>;
}

export function buildAdOperatorResponsePersistenceBatch(input: {
  episode: AdRecommendationEpisode;
  jobRunId: string;
  result: AdOperatorResponseResult;
  cutoff: string;
}): AdOperatorResponsePersistenceBatch {
  const cutoff = timestampValue(input.cutoff, "cutoff");
  const eventRows = input.result.evidence.map((entry) => {
    const entityType =
      entry.kind === "engine_v3_ad_operator_action_receipt"
        ? entry.payload.targetEntityType
        : entry.payload.entityType;
    const entityId =
      entry.kind === "engine_v3_ad_operator_action_receipt"
        ? entry.payload.targetEntityId
        : entry.payload.entityId;
    if (!isTargetEntityType(entityType) || typeof entityId !== "string") {
      throw new TypeError(
        "Operator-response evidence lacks exact entity identity.",
      );
    }
    const evidenceJson = {
      role: entry.role,
      diagnosticCode: entry.diagnosticCode,
      payload: entry.payload,
    };
    return {
      contract_version: input.result.contractVersion,
      episode_key: input.result.episodeKey,
      business_ref_id: input.episode.businessId,
      business_id: input.episode.businessDisplayId,
      provider_account_ref_id: input.episode.providerAccountRefId,
      provider_account_id: input.episode.providerAccountId,
      entity_type: entityType,
      entity_id: entityId,
      job_run_id: input.jobRunId,
      response_cutoff: cutoff,
      evidence_kind: entry.kind,
      evidence_source_id: entry.sourceId,
      action_receipt_id:
        entry.kind === "engine_v3_ad_operator_action_receipt"
          ? entry.sourceId
          : null,
      state_history_id:
        entry.kind === "meta_entity_state_history" ? entry.sourceId : null,
      tombstone_id:
        entry.kind === "meta_entity_tombstones" ? entry.sourceId : null,
      evidence_observed_at: entry.observedAt,
      evidence_captured_at: entry.capturedAt,
      treatment_eligible: entry.treatmentEligible,
      diagnostic_code: entry.diagnosticCode,
      evidence_json: evidenceJson,
      evidence_hash: canonicalSha256({
        episodeKey: input.result.episodeKey,
        responseCutoff: cutoff,
        kind: entry.kind,
        sourceId: entry.sourceId,
        observedAt: entry.observedAt,
        capturedAt: entry.capturedAt,
        treatmentEligible: entry.treatmentEligible,
        evidenceJson,
      }),
    };
  });
  const evidenceHashes = eventRows
    .map((row) => stringValue(row.evidence_hash, "evidence_hash"))
    .sort();
  const evidenceSetHash = canonicalSha256({
    episodeKey: input.result.episodeKey,
    responseCutoff: cutoff,
    evidenceHashes,
  });
  const replacementSetHash = canonicalSha256({
    episodeKey: input.result.episodeKey,
    responseCutoff: cutoff,
    responseHash: input.result.responseHash,
    sourceSetHash: input.result.sourceProof.sourceSetHash,
    evidenceSetHash,
    evidenceCount: evidenceHashes.length,
  });
  return {
    eventRows,
    responseRow: {
      contract_version: input.result.contractVersion,
      episode_key: input.result.episodeKey,
      business_ref_id: input.episode.businessId,
      business_id: input.episode.businessDisplayId,
      provider_account_ref_id: input.episode.providerAccountRefId,
      provider_account_id: input.episode.providerAccountId,
      job_run_id: input.jobRunId,
      response_cutoff: cutoff,
      observation_status: input.result.observationStatus,
      response_type: input.result.responseType,
      operator_response_detected: input.result.operatorResponseDetected,
      ad_treatment_detected: input.result.adTreatmentDetected,
      detected_at: input.result.detectedAt,
      action_receipt_id: input.result.actionReceiptId,
      action_log_id: input.result.actionLogId,
      successor_ad_id: input.result.successorAdId,
      successor_kind: input.result.successorKind,
      budget_owner_type: input.result.budgetOwnerType,
      budget_owner_id: input.result.budgetOwnerId,
      window_start: input.result.sourceProof.windowStart,
      window_end: input.result.sourceProof.windowEnd,
      window_closed: input.result.sourceProof.windowClosed,
      source_complete: input.result.sourceProof.sourceComplete,
      source_set_hash: input.result.sourceProof.sourceSetHash,
      action_receipt_count: input.result.sourceProof.actionReceiptCount,
      state_observation_count: input.result.sourceProof.stateObservationCount,
      tombstone_observation_count:
        input.result.sourceProof.tombstoneObservationCount,
      required_state_target_count:
        input.result.sourceProof.requiredStateTargetCount,
      complete_state_target_count:
        input.result.sourceProof.completeStateTargetCount,
      diagnostics_json: input.result.diagnostics,
      evidence_hashes_json: evidenceHashes,
      evidence_count: evidenceHashes.length,
      evidence_set_hash: evidenceSetHash,
      replacement_set_hash: replacementSetHash,
      response_hash: input.result.responseHash,
    },
  };
}

export async function persistAdOperatorResponseBatches(
  batches: readonly AdOperatorResponsePersistenceBatch[],
  db: DbClient = getDb(),
): Promise<{
  eventsWritten: number;
  eventsPruned: number;
  responsesWritten: number;
}> {
  if (batches.length === 0) {
    return { eventsWritten: 0, eventsPruned: 0, responsesWritten: 0 };
  }
  const eventRows = batches.flatMap((batch) => batch.eventRows);
  const responseRows = batches.map((batch) => batch.responseRow);
  const responseByKey = new Map<string, Record<string, unknown>>();
  for (const response of responseRows) {
    const key = responsePersistenceKey(
      response.episode_key,
      response.response_cutoff,
    );
    if (responseByKey.has(key)) {
      throw new TypeError(`Duplicate response replacement key: ${key}`);
    }
    responseByKey.set(key, response);
  }
  const eventsByKey = new Map<string, string[]>();
  for (const event of eventRows) {
    const key = responsePersistenceKey(
      event.episode_key,
      event.response_cutoff,
    );
    if (!responseByKey.has(key)) {
      throw new TypeError("Evidence row has no response replacement owner.");
    }
    const hashes = eventsByKey.get(key) ?? [];
    hashes.push(stringValue(event.evidence_hash, "evidence_hash"));
    eventsByKey.set(key, hashes);
  }
  for (const [key, response] of responseByKey) {
    const eventHashes = [...(eventsByKey.get(key) ?? [])].sort();
    const responseHashes = Array.isArray(response.evidence_hashes_json)
      ? response.evidence_hashes_json
          .map((value) => stringValue(value, "evidence_hashes_json"))
          .sort()
      : [];
    if (
      integerValue(response.evidence_count, "evidence_count") !==
        eventHashes.length ||
      canonicalSha256(responseHashes) !== canonicalSha256(eventHashes)
    ) {
      throw new TypeError("Response/evidence cardinality proof mismatch.");
    }
    const episodeKey = stringValue(response.episode_key, "episode_key");
    const responseCutoff = timestampValue(
      response.response_cutoff,
      "response_cutoff",
    );
    const evidenceSetHash = canonicalSha256({
      episodeKey,
      responseCutoff,
      evidenceHashes: eventHashes,
    });
    if (
      stringValue(response.evidence_set_hash, "evidence_set_hash") !==
      evidenceSetHash
    ) {
      throw new TypeError("Evidence set hash proof mismatch.");
    }
    const replacementSetHash = canonicalSha256({
      episodeKey,
      responseCutoff,
      responseHash: stringValue(response.response_hash, "response_hash"),
      sourceSetHash: stringValue(response.source_set_hash, "source_set_hash"),
      evidenceSetHash,
      evidenceCount: eventHashes.length,
    });
    if (
      stringValue(response.replacement_set_hash, "replacement_set_hash") !==
      replacementSetHash
    ) {
      throw new TypeError("Replacement set hash proof mismatch.");
    }
  }
  const proofRows = await db.query<ReplacementProofRow>(
    REPLACE_AD_OPERATOR_RESPONSE_BATCHES_QUERY,
    [JSON.stringify(responseRows), JSON.stringify(eventRows)],
  );
  const proof = proofRows[0];
  if (!proof) throw new Error("Response replacement returned no proof row.");
  const responsesWritten = integerValue(
    proof.responses_written,
    "responses_written",
  );
  const eventsWritten = integerValue(proof.events_written, "events_written");
  const eventsPruned = integerValue(proof.events_pruned, "events_pruned");
  const responseProof = Array.isArray(proof.response_proof_json)
    ? proof.response_proof_json
    : [];
  const eventProof = Array.isArray(proof.event_proof_json)
    ? proof.event_proof_json
    : [];
  const returnedResponseProof = new Map(
    responseProof.map((entry) => {
      const record = recordValue(entry);
      return [
        responsePersistenceKey(record.episode_key, record.response_cutoff),
        stringValue(record.replacement_set_hash, "replacement_set_hash"),
      ];
    }),
  );
  const returnedEventProof = new Map<string, string[]>();
  for (const entry of eventProof) {
    const record = recordValue(entry);
    const key = responsePersistenceKey(
      record.episode_key,
      record.response_cutoff,
    );
    const hashes = returnedEventProof.get(key) ?? [];
    hashes.push(stringValue(record.evidence_hash, "evidence_hash"));
    returnedEventProof.set(key, hashes);
  }
  if (
    responsesWritten !== responseRows.length ||
    eventsWritten !== eventRows.length ||
    returnedResponseProof.size !== responseRows.length
  ) {
    throw new Error(
      "Response replacement cardinality proof did not reconcile.",
    );
  }
  for (const [key, response] of responseByKey) {
    if (
      returnedResponseProof.get(key) !==
      stringValue(response.replacement_set_hash, "replacement_set_hash")
    ) {
      throw new Error("Response replacement hash proof did not reconcile.");
    }
    const expectedEventHashes = [...(eventsByKey.get(key) ?? [])].sort();
    const actualEventHashes = [...(returnedEventProof.get(key) ?? [])].sort();
    if (
      canonicalSha256(expectedEventHashes) !==
      canonicalSha256(actualEventHashes)
    ) {
      throw new Error("Evidence replacement hash proof did not reconcile.");
    }
  }
  return {
    eventsWritten,
    eventsPruned,
    responsesWritten,
  };
}

export interface PersistedAdOperatorResponse {
  responseId: string;
  episodeKey: string;
  businessId: string;
  businessDisplayId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string | null;
  engineVersion: string;
  snapshotId: string;
  evaluationId: string;
  decisionHash: string;
  responseCutoff: string;
  observationStatus: AdOperatorResponseResult["observationStatus"];
  responseType: AdOperatorResponseResult["responseType"];
  operatorResponseDetected: boolean;
  adTreatmentDetected: boolean;
  detectedAt: string | null;
  actionReceiptId: string | null;
  actionLogId: string | null;
  successorAdId: string | null;
  successorKind: "duplicate" | "rebuild" | null;
  budgetOwnerType: "campaign" | "adset" | null;
  budgetOwnerId: string | null;
  windowStart: string;
  windowEnd: string;
  windowClosed: boolean;
  sourceComplete: boolean;
  sourceSetHash: string;
  actionReceiptCount: number;
  stateObservationCount: number;
  tombstoneObservationCount: number;
  requiredStateTargetCount: number;
  completeStateTargetCount: number;
  diagnostics: unknown[];
  evidenceHashes: string[];
  evidenceCount: number;
  evidenceSetHash: string;
  replacementSetHash: string;
  responseHash: string;
}

function mapReadResponse(row: ResponseReadRow): PersistedAdOperatorResponse {
  const responseType = stringValue(row.response_type, "response_type");
  if (
    ![
      "verified_pause",
      "verified_resume",
      "duplicate_successor",
      "rebuild_successor",
      "budget_owner_action_context",
      "natural_spend_cessation",
      "no_response_observed",
      "unknown_incomplete",
      "ambiguous_conflicting",
    ].includes(responseType)
  ) {
    throw new TypeError(`Unsupported response_type: ${responseType}`);
  }
  const observationStatus = stringValue(
    row.observation_status,
    "observation_status",
  );
  if (
    observationStatus !== "observed_response" &&
    observationStatus !== "observed_no_response" &&
    observationStatus !== "unknown_incomplete"
  ) {
    throw new TypeError(`Unsupported observation_status: ${observationStatus}`);
  }
  return {
    responseId: stringValue(row.response_id, "response_id"),
    episodeKey: stringValue(row.episode_key, "episode_key"),
    businessId: stringValue(row.business_id, "business_id"),
    businessDisplayId: stringValue(
      row.business_display_id,
      "business_display_id",
    ),
    providerAccountId: stringValue(
      row.provider_account_id,
      "provider_account_id",
    ),
    adId: stringValue(row.ad_id, "ad_id"),
    creativeId: nullableString(row.creative_id),
    engineVersion: stringValue(row.engine_version, "engine_version"),
    snapshotId: stringValue(row.decision_snapshot_id, "decision_snapshot_id"),
    evaluationId: stringValue(row.evaluation_id, "evaluation_id"),
    decisionHash: stringValue(row.decision_hash, "decision_hash"),
    responseCutoff: stringValue(row.response_cutoff, "response_cutoff"),
    observationStatus,
    responseType: responseType as PersistedAdOperatorResponse["responseType"],
    operatorResponseDetected: row.operator_response_detected === true,
    adTreatmentDetected: row.ad_treatment_detected === true,
    detectedAt: nullableString(row.detected_at),
    actionReceiptId: nullableString(row.action_receipt_id),
    actionLogId: nullableString(row.action_log_id),
    successorAdId: nullableString(row.successor_ad_id),
    successorKind:
      row.successor_kind === "duplicate" || row.successor_kind === "rebuild"
        ? row.successor_kind
        : null,
    budgetOwnerType:
      row.budget_owner_type === "campaign" || row.budget_owner_type === "adset"
        ? row.budget_owner_type
        : null,
    budgetOwnerId: nullableString(row.budget_owner_id),
    windowStart: stringValue(row.window_start, "window_start"),
    windowEnd: stringValue(row.window_end, "window_end"),
    windowClosed: row.window_closed === true,
    sourceComplete: row.source_complete === true,
    sourceSetHash: stringValue(row.source_set_hash, "source_set_hash"),
    actionReceiptCount: integerValue(
      row.action_receipt_count,
      "action_receipt_count",
    ),
    stateObservationCount: integerValue(
      row.state_observation_count,
      "state_observation_count",
    ),
    tombstoneObservationCount: integerValue(
      row.tombstone_observation_count,
      "tombstone_observation_count",
    ),
    requiredStateTargetCount: integerValue(
      row.required_state_target_count,
      "required_state_target_count",
    ),
    completeStateTargetCount: integerValue(
      row.complete_state_target_count,
      "complete_state_target_count",
    ),
    diagnostics: Array.isArray(row.diagnostics_json)
      ? row.diagnostics_json
      : [],
    evidenceHashes: Array.isArray(row.evidence_hashes_json)
      ? row.evidence_hashes_json.filter(
          (value): value is string => typeof value === "string",
        )
      : [],
    evidenceCount: integerValue(row.evidence_count, "evidence_count"),
    evidenceSetHash: stringValue(row.evidence_set_hash, "evidence_set_hash"),
    replacementSetHash: stringValue(
      row.replacement_set_hash,
      "replacement_set_hash",
    ),
    responseHash: stringValue(row.response_hash, "response_hash"),
  };
}

export async function readAdOperatorResponses(input: {
  businessId: string;
  providerAccountId?: string | null;
  adId?: string | null;
  engineVersion?: string | null;
  cutoff?: string | null;
  limit?: number;
  db?: DbClient;
}): Promise<PersistedAdOperatorResponse[]> {
  const limit = Math.max(1, Math.min(input.limit ?? 100, 500));
  const db = input.db ?? getDb();
  const engineVersion =
    nullableString(input.engineVersion) ?? NATIVE_AD_ENGINE_VERSION;
  if (engineVersion !== NATIVE_AD_ENGINE_VERSION) {
    throw new TypeError(
      `Native operator responses require ${NATIVE_AD_ENGINE_VERSION}.`,
    );
  }
  const rows = await db.query<ResponseReadRow>(
    READ_AD_OPERATOR_RESPONSES_QUERY,
    [
      input.businessId,
      nullableString(input.providerAccountId),
      nullableString(input.adId),
      engineVersion,
      nullableString(input.cutoff),
      limit,
    ],
  );
  return rows.map(mapReadResponse);
}

export interface AdOperatorResponseJobInput {
  businessId: string;
  cutoff: string;
  engineVersion?: string;
  lookbackDays?: number;
}

export interface AdOperatorResponseJobResult {
  jobRunId: string;
  status: "success" | "failed" | "skipped";
  engineVersion: string;
  episodesCaptured: number;
  episodesEvaluated: number;
  evidenceEventsWritten: number;
  evidenceEventsPruned: number;
  responsesWritten: number;
  durationMs: number;
  reason?: "lock_not_acquired" | "schema_not_ready" | "invalid_input";
  missingSchema?: string[];
  errorMessage?: string;
}

function normalizedJobInput(input: AdOperatorResponseJobInput) {
  const businessId = stringValue(input.businessId, "businessId");
  const cutoff = timestampValue(input.cutoff, "cutoff");
  const engineVersion =
    nullableString(input.engineVersion) ?? NATIVE_AD_ENGINE_VERSION;
  if (engineVersion !== NATIVE_AD_ENGINE_VERSION) {
    throw new TypeError(
      `engineVersion must equal the native ad epoch ${NATIVE_AD_ENGINE_VERSION}.`,
    );
  }
  const requestedLookback = input.lookbackDays ?? 90;
  if (!Number.isInteger(requestedLookback) || requestedLookback < 1) {
    throw new TypeError("lookbackDays must be a positive integer.");
  }
  return {
    businessId,
    cutoff,
    engineVersion,
    lookbackDays: Math.max(
      AD_OPERATOR_RESPONSE_WINDOW_DAYS + 1,
      Math.min(requestedLookback, 90),
    ),
  };
}

export function adOperatorResponseJobAdvisoryLockKey(
  input: AdOperatorResponseJobInput,
): bigint {
  const normalized = normalizedJobInput(input);
  return hashAdvisoryLock(
    `${AD_OPERATOR_RESPONSE_JOB_NAME}:${normalized.businessId}:${normalized.cutoff}:${normalized.engineVersion}`,
  );
}

class AdOperatorResponseSchemaNotReadyError extends Error {
  constructor(readonly missing: string[]) {
    super(
      `Native ad operator-response schema is not ready: ${missing.join(", ")}`,
    );
    this.name = "AdOperatorResponseSchemaNotReadyError";
  }
}

function operatorResponseJobAsOf(cutoff: string) {
  return timestampValue(cutoff, "cutoff").slice(0, 10);
}

async function insertAdOperatorResponseJobRun(
  input: ReturnType<typeof normalizedJobInput> & {
    status: "running" | "skipped";
    durationMs?: number;
    errorMessage?: string;
  },
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    `
    INSERT INTO engine_v3_job_runs (
      job_name, business_ref_id, business_id, as_of_date, engine_version,
      status, finished_at, duration_ms, row_count, error_message
    ) VALUES (
      $1, $2::uuid, $2::uuid::text, $3::date, $4, $5,
      CASE WHEN $5 = 'running' THEN NULL ELSE clock_timestamp() END,
      $6::integer, CASE WHEN $5 = 'running' THEN NULL ELSE 0 END, $7
    )
    RETURNING id::text AS id, status
    `,
    [
      AD_OPERATOR_RESPONSE_JOB_NAME,
      input.businessId,
      operatorResponseJobAsOf(input.cutoff),
      input.engineVersion,
      input.status,
      input.durationMs ?? null,
      input.errorMessage ?? null,
    ],
  );
  if (
    rows.length !== 1 ||
    rows[0]?.status !== input.status ||
    !nullableString(rows[0]?.id)
  ) {
    throw new Error(
      `Operator-response ${input.status} job-run insert did not return exactly one row.`,
    );
  }
  return stringValue(rows[0]?.id, "operator_response_job_run_id");
}

function assertTerminalOperatorResponseJobRun(
  rows: Record<string, unknown>[],
  jobRunId: string,
  status: "success" | "failed",
) {
  if (
    rows.length !== 1 ||
    rows[0]?.status !== status ||
    stringValue(rows[0]?.id, `${status}_operator_response_job_run_id`) !==
      jobRunId
  ) {
    throw new Error(
      `Operator-response ${status} terminal update did not affect exactly its running job row.`,
    );
  }
}

async function markAdOperatorResponseJobSuccess(
  input: {
    jobRunId: string;
    durationMs: number;
    episodesCaptured: number;
    episodesEvaluated: number;
    evidenceEventsWritten: number;
    evidenceEventsPruned: number;
    responsesWritten: number;
  },
  db: DbClient,
) {
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'success', finished_at = clock_timestamp(),
      duration_ms = $1::integer, row_count = $2::integer,
      error_message = NULL, error_json = $3::jsonb, updated_at = clock_timestamp()
    WHERE id = $4::uuid AND status = 'running'
    RETURNING id::text AS id, status
    `,
    [
      input.durationMs,
      input.responsesWritten,
      JSON.stringify({
        metadata: {
          native_ad_grain: true,
          shadow_only: true,
          episodes_captured: input.episodesCaptured,
          episodes_evaluated: input.episodesEvaluated,
          evidence_events_written: input.evidenceEventsWritten,
          evidence_events_pruned: input.evidenceEventsPruned,
          responses_written: input.responsesWritten,
        },
      }),
      input.jobRunId,
    ],
  );
  assertTerminalOperatorResponseJobRun(rows, input.jobRunId, "success");
}

async function markAdOperatorResponseJobFailed(
  input: {
    jobRunId: string;
    durationMs: number;
    error: unknown;
  },
  db: DbClient,
) {
  const errorMessage =
    input.error instanceof Error ? input.error.message : String(input.error);
  const rows = await db.query<Record<string, unknown>>(
    `
    UPDATE engine_v3_job_runs
    SET status = 'failed', finished_at = clock_timestamp(),
      duration_ms = $1::integer, row_count = 0, error_message = $2,
      error_json = $3::jsonb, updated_at = clock_timestamp()
    WHERE id = $4::uuid AND status = 'running'
    RETURNING id::text AS id, status
    `,
    [
      input.durationMs,
      errorMessage,
      JSON.stringify({
        name: input.error instanceof Error ? input.error.name : "Error",
        message: errorMessage,
      }),
      input.jobRunId,
    ],
  );
  assertTerminalOperatorResponseJobRun(rows, input.jobRunId, "failed");
}

export async function executeAdOperatorResponseJob(
  input: AdOperatorResponseJobInput,
  db: DbClient,
  startedAt = Date.now(),
): Promise<AdOperatorResponseJobResult> {
  let normalized: ReturnType<typeof normalizedJobInput>;
  try {
    normalized = normalizedJobInput(input);
  } catch (error) {
    return {
      jobRunId: "",
      status: "failed",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      episodesCaptured: 0,
      episodesEvaluated: 0,
      evidenceEventsWritten: 0,
      evidenceEventsPruned: 0,
      responsesWritten: 0,
      durationMs: Date.now() - startedAt,
      reason: "invalid_input",
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
  await db.query("SET TRANSACTION ISOLATION LEVEL REPEATABLE READ");
  const [lock] = await db.query<
    Record<string, unknown> & { acquired: unknown }
  >("SELECT pg_try_advisory_xact_lock($1::bigint) AS acquired", [
    adOperatorResponseJobAdvisoryLockKey(normalized).toString(),
  ]);
  if (lock?.acquired !== true) {
    const durationMs = Date.now() - startedAt;
    const errorMessage =
      "Advisory lock not acquired (native ad operator-response may already be running).";
    const jobRunId = await insertAdOperatorResponseJobRun(
      {
        ...normalized,
        status: "skipped",
        durationMs,
        errorMessage,
      },
      db,
    );
    return {
      jobRunId,
      status: "skipped",
      engineVersion: normalized.engineVersion,
      episodesCaptured: 0,
      episodesEvaluated: 0,
      evidenceEventsWritten: 0,
      evidenceEventsPruned: 0,
      responsesWritten: 0,
      durationMs,
      reason: "lock_not_acquired",
      errorMessage,
    };
  }
  const jobRunId = await insertAdOperatorResponseJobRun(
    { ...normalized, status: "running" },
    db,
  );
  await db.query("SAVEPOINT engine_v3_ad_operator_response_job_work");
  try {
    const capability = await inspectAdOperatorResponseSchemaCapability(db);
    if (!capability.ready) {
      throw new AdOperatorResponseSchemaNotReadyError(capability.missing);
    }
    const candidateRows = await db.query<EpisodeCandidateRow>(
      FIND_NATIVE_AD_RECOMMENDATION_EPISODE_CANDIDATES_QUERY,
      [
        normalized.businessId,
        normalized.cutoff,
        normalized.lookbackDays,
        normalized.engineVersion,
      ],
    );
    const candidateEpisodes = candidateRows.map(mapEpisode);
    const [dbTime] = await db.query<
      Record<string, unknown> & { captured_at: unknown }
    >(READ_AD_OPERATOR_RESPONSE_DB_TIME_QUERY);
    const capturedAt = stringValue(dbTime?.captured_at, "captured_at");
    const episodesCaptured = await persistAdRecommendationEpisodes(
      candidateEpisodes,
      capturedAt,
      jobRunId,
      db,
    );
    const episodes = await readRecommendationEpisodes({ ...normalized, db });
    assertAdRecommendationEpisodeCapture({
      candidates: candidateEpisodes,
      stored: episodes,
    });

    const actionRows =
      episodes.length === 0
        ? []
        : await db.query<ActionLineageRow>(
            FIND_EXACT_NATIVE_AD_ACTION_RECEIPTS_QUERY,
            [JSON.stringify(actionQueryPayload(episodes)), normalized.cutoff],
          );
    const mappedActions = actionRows.map((row) => {
      const mapped = mapActionLineage(row);
      return { episodeKey: mapped.episodeKey, value: mapped.action };
    });
    const actionsByEpisode = groupByEpisode(mappedActions);
    const targets = stateTargetPayload({
      episodes,
      actionsByEpisode,
      cutoff: normalized.cutoff,
    });
    const stateRows =
      targets.length === 0
        ? []
        : await db.query<StateRow>(FIND_CUTOFF_SAFE_META_ENTITY_STATES_QUERY, [
            JSON.stringify(targets),
          ]);
    const mappedTruth = stateRows.flatMap((row) => {
      const mapped = mapState(row);
      return mapped ? [mapped] : [];
    });
    const statesByEpisode = groupByEpisode(
      mappedTruth.flatMap((mapped) =>
        mapped.state
          ? [{ episodeKey: mapped.episodeKey, value: mapped.state }]
          : [],
      ),
    );
    const tombstonesByEpisode = groupByEpisode(
      mappedTruth.flatMap((mapped) =>
        mapped.tombstone
          ? [{ episodeKey: mapped.episodeKey, value: mapped.tombstone }]
          : [],
      ),
    );
    const batches = episodes.map((episode) =>
      buildAdOperatorResponsePersistenceBatch({
        episode,
        jobRunId,
        cutoff: normalized.cutoff,
        result: detectAdOperatorResponse({
          episode,
          cutoff: normalized.cutoff,
          actions: actionsByEpisode.get(episode.episodeKey) ?? [],
          states: statesByEpisode.get(episode.episodeKey) ?? [],
          tombstones: tombstonesByEpisode.get(episode.episodeKey) ?? [],
          sourceReads: {
            actionReceiptsComplete: true,
            stateHistoryComplete: true,
            tombstonesComplete: true,
          },
        }),
      }),
    );
    const persisted = await persistAdOperatorResponseBatches(batches, db);
    const durationMs = Date.now() - startedAt;
    await markAdOperatorResponseJobSuccess(
      {
        jobRunId,
        durationMs,
        episodesCaptured,
        episodesEvaluated: episodes.length,
        evidenceEventsWritten: persisted.eventsWritten,
        evidenceEventsPruned: persisted.eventsPruned,
        responsesWritten: persisted.responsesWritten,
      },
      db,
    );
    return {
      jobRunId,
      status: "success",
      engineVersion: normalized.engineVersion,
      episodesCaptured,
      episodesEvaluated: episodes.length,
      evidenceEventsWritten: persisted.eventsWritten,
      evidenceEventsPruned: persisted.eventsPruned,
      responsesWritten: persisted.responsesWritten,
      durationMs,
    };
  } catch (error) {
    await db.query(
      "ROLLBACK TO SAVEPOINT engine_v3_ad_operator_response_job_work",
    );
    const durationMs = Date.now() - startedAt;
    await markAdOperatorResponseJobFailed({ jobRunId, durationMs, error }, db);
    return {
      jobRunId,
      status: "failed",
      engineVersion: normalized.engineVersion,
      episodesCaptured: 0,
      episodesEvaluated: 0,
      evidenceEventsWritten: 0,
      evidenceEventsPruned: 0,
      responsesWritten: 0,
      durationMs,
      ...(error instanceof AdOperatorResponseSchemaNotReadyError
        ? {
            reason: "schema_not_ready" as const,
            missingSchema: error.missing,
          }
        : {}),
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}

export async function runAdOperatorResponseJob(
  input: AdOperatorResponseJobInput,
): Promise<AdOperatorResponseJobResult> {
  const startedAt = Date.now();
  try {
    return await runDbTransaction(
      async () => executeAdOperatorResponseJob(input, getDb(), startedAt),
      { timeoutMs: ENGINE_V3_JOB_TRANSACTION_TIMEOUT_MS },
    );
  } catch (error) {
    return {
      jobRunId: "",
      status: "failed",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      episodesCaptured: 0,
      episodesEvaluated: 0,
      evidenceEventsWritten: 0,
      evidenceEventsPruned: 0,
      responsesWritten: 0,
      durationMs: Date.now() - startedAt,
      errorMessage: error instanceof Error ? error.message : String(error),
    };
  }
}
