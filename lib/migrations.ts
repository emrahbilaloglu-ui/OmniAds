import { DECISION_AUTHORITY_BLOCKERS } from "@/lib/creative-decision-engine/types";
import {
  getDb,
  getDbWithTimeout,
  runDbTransaction,
  type DbClient,
} from "@/lib/db";
import { META_AD_DUPLICATE_RECONCILIATION_SCHEMA_SQL } from "@/lib/meta/duplicate-ad-reconciliation-store";
import {
  encryptIntegrationSecret,
  isEncryptedIntegrationSecret,
  requireIntegrationSecretKey,
} from "@/lib/integration-secrets";
import { verifyMigrationSchemaContract } from "@/lib/migration-verification";
import {
  ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL,
  ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL,
  NATIVE_AD_DECISION_SCHEMA_SQL,
} from "@/lib/creative-decision-engine/ad-evaluation-schema";
import { inspectEvaluationStoreSchemaCapability } from "@/lib/creative-decision-engine/evaluation-store";
import {
  NATIVE_AD_CALIBRATION_MIGRATION_SQL,
  inspectNativeAdCalibrationSchemaCapability,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import {
  CREATE_AD_DECISION_OUTCOMES_TABLE_SQL,
  inspectAdDecisionOutcomeSchemaCapability,
} from "@/lib/creative-decision-engine/jobs/ad-decision-outcomes-job";
import {
  AD_OPERATOR_RESPONSE_ACTION_LOG_SCHEMA_SQL,
  AD_OPERATOR_RESPONSE_EPOCH_COMPATIBILITY_SQL,
  AD_OPERATOR_RESPONSE_SCHEMA_SQL,
  inspectAdOperatorResponseSchemaCapability,
} from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import {
  CONTROLLED_REGISTRY_SCHEMA_SQL,
  inspectControlledRegistryCapabilities,
} from "@/lib/meta/controlled-experiment-registry";
import { logStartupError, logStartupEvent } from "@/lib/startup-diagnostics";

let migrationsPromise: Promise<void> | null = null;
let migrationsCompleted = false;

/**
 * Clear the in-process "already migrated" latch.
 *
 * `runMigrations` returns immediately once it has succeeded, which is right for
 * a long-lived process. A seam that has to prove the UPGRADE path — drop the
 * objects this change adds, reproduce a pre-change catalog, and show the
 * migration restores them — needs to run it twice against one database. Without
 * this it would only ever be testing a fresh migration, which says nothing about
 * the upgrade production will actually perform.
 *
 * Deliberately not called from any runtime path.
 */
export function resetMigrationLatchForSeams() {
  migrationsPromise = null;
  migrationsCompleted = false;
}
let loggedMigrationSkip = false;

const DEFAULT_MIGRATION_TIMEOUT_MS = 60_000;
type MigrationBatchQuery = Promise<unknown>;
const DESTRUCTIVE_COLUMN_DROP_LOCK_TIMEOUT_MS = 2_000;
const AUTHORITY_BLOCKER_CHECK_VALUES_SQL = DECISION_AUTHORITY_BLOCKERS.map(
  (value) => `'${value.replaceAll("'", "''")}'`,
).join(", ");

function authorityProvenanceSchemaSql(
  table: string,
  constraintPrefix: string,
  alterIfExists = false,
) {
  assertMigrationIdentifier(table);
  assertMigrationIdentifier(constraintPrefix);
  return `
ALTER TABLE ${alterIfExists ? "IF EXISTS " : ""}${table}
  ADD COLUMN IF NOT EXISTS pre_authority_label TEXT,
  ADD COLUMN IF NOT EXISTS authority_blocker TEXT;
DO $$
BEGIN
  IF to_regclass('${table}') IS NOT NULL THEN
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('${table}')
        AND conname = '${constraintPrefix}_pre_authority_label_check') THEN
      ALTER TABLE ${table}
        ADD CONSTRAINT ${constraintPrefix}_pre_authority_label_check
        CHECK (pre_authority_label IS NULL OR pre_authority_label IN (
          'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
        ));
    END IF;
    IF NOT EXISTS (SELECT 1 FROM pg_constraint
      WHERE conrelid = to_regclass('${table}')
        AND conname = '${constraintPrefix}_authority_blocker_check') THEN
      ALTER TABLE ${table}
        ADD CONSTRAINT ${constraintPrefix}_authority_blocker_check
        CHECK (authority_blocker IS NULL OR authority_blocker IN (
          'profile_hard_action_ineligible', 'source_freshness',
          'campaign_context', 'native_metrics_unavailable',
          'native_profile_unavailable'
        ));
    END IF;
  END IF;
END
$$`;
}

const LEGACY_DECISION_SNAPSHOT_PROVENANCE_SQL = authorityProvenanceSchemaSql(
  "engine_v3_decision_snapshots_daily",
  "engine_v3_decision_snapshots",
);
const LEGACY_DECISION_OUTCOME_PROVENANCE_SQL = authorityProvenanceSchemaSql(
  "engine_v3_decision_outcomes_daily",
  "engine_v3_decision_outcomes",
);
const NATIVE_AD_OUTCOME_PROVENANCE_SCHEMA_SQL = authorityProvenanceSchemaSql(
  "engine_v3_ad_decision_outcomes_daily",
  "engine_v3_ad_outcomes",
  true,
);

/**
 * Manual Meta status writes can end without a trustworthy provider outcome.
 * This append-only event closes that quarantine only after a fresh exact GET,
 * never by rewriting the original action log. Five minutes is the fixed,
 * provider-generic settlement floor; the observation itself must be no more
 * than sixty seconds old when it is persisted.
 */
export const META_AD_STATUS_RECONCILIATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta_ads_action_mutation_attempt_events (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version           TEXT NOT NULL
                               DEFAULT 'meta-manual-ad-status-mutation-attempt.v1'
                               CHECK (
                                 contract_version =
                                   'meta-manual-ad-status-mutation-attempt.v1'
                               ),
  source_action_log_id       UUID NOT NULL,
  business_id                UUID NOT NULL,
  provider_account_ref_id    UUID NOT NULL,
  provider_account_id        TEXT NOT NULL
                               CHECK (length(btrim(provider_account_id)) > 0),
  ad_id                      TEXT NOT NULL
                               CHECK (length(btrim(ad_id)) > 0),
  creative_id                TEXT NOT NULL
                               CHECK (length(btrim(creative_id)) > 0),
  campaign_id                TEXT NOT NULL
                               CHECK (length(btrim(campaign_id)) > 0),
  adset_id                   TEXT NOT NULL
                               CHECK (length(btrim(adset_id)) > 0),
  action                     TEXT NOT NULL
                               CHECK (action IN ('pause', 'resume')),
  attempt_id                 UUID NOT NULL,
  event_kind                 TEXT NOT NULL
                               CHECK (
                                 event_kind IN (
                                   'attempt_started',
                                   'attempt_completed'
                                 )
                               ),
  post_path                  TEXT NOT NULL
                               CHECK (length(btrim(post_path)) > 0),
  started_at                 TIMESTAMPTZ NOT NULL,
  lease_deadline             TIMESTAMPTZ NOT NULL,
  attempted_at               TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ,
  completion_outcome         TEXT CHECK (
                               completion_outcome IS NULL OR
                               completion_outcome IN (
                                 'provider_outcome_ambiguous',
                                 'provider_response_succeeded_verification_failed',
                                 'provider_response_verified_success',
                                 'provider_definite_failure'
                               )
                             ),
  provider_response_received BOOLEAN,
  provider_response_successful BOOLEAN,
  http_status                INTEGER,
  provider_outcome           TEXT CHECK (
                               provider_outcome IS NULL OR
                               provider_outcome IN (
                                 'outcome_ambiguous',
                                 'definite_failure',
                                 'provider_response_succeeded',
                                 'verified_success'
                               )
                             ),
  provider_response_json     JSONB,
  verification_json          JSONB,
  transport_error_json       JSONB,
  evidence_json              JSONB NOT NULL
                               CHECK (jsonb_typeof(evidence_json) = 'object'),
  evidence_hash              CHAR(64) NOT NULL
                               CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_ads_action_mutation_attempt_source_fk
    FOREIGN KEY (source_action_log_id, business_id)
    REFERENCES meta_ads_action_log (id, business_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_action_mutation_attempt_account_fk
    FOREIGN KEY (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_action_mutation_attempt_source_event_unique
    UNIQUE (source_action_log_id, event_kind),
  CONSTRAINT meta_ads_action_mutation_attempt_id_event_unique
    UNIQUE (attempt_id, event_kind),
  CONSTRAINT meta_ads_action_mutation_attempt_time_check CHECK (
    lease_deadline > started_at AND
    lease_deadline <= started_at + interval '2 minutes' AND
    (
      event_kind = 'attempt_started' OR (
        attempted_at >= started_at AND
        completed_at >= attempted_at AND
        completed_at <= lease_deadline
      )
    )
  ),
  CONSTRAINT meta_ads_action_mutation_attempt_shape_check CHECK (
    (
      event_kind = 'attempt_started' AND
      attempted_at IS NULL AND completed_at IS NULL AND
      completion_outcome IS NULL AND
      provider_response_received IS NULL AND
      provider_response_successful IS NULL AND
      http_status IS NULL AND provider_outcome IS NULL AND
      provider_response_json IS NULL AND verification_json IS NULL AND
      transport_error_json IS NULL
    ) OR (
      event_kind = 'attempt_completed' AND
      attempted_at IS NOT NULL AND completed_at IS NOT NULL AND
      completion_outcome IS NOT NULL AND
      provider_response_received IS NOT NULL AND
      provider_response_successful IS NOT NULL AND
      provider_outcome IS NOT NULL
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_action_mutation_attempt_business_ad
  ON meta_ads_action_mutation_attempt_events
  (business_id, provider_account_id, ad_id, created_at DESC);

CREATE OR REPLACE FUNCTION validate_meta_ads_action_mutation_attempt_event()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_action_mutation_attempt_validation$
DECLARE
  source_action meta_ads_action_log%ROWTYPE;
  started_event meta_ads_action_mutation_attempt_events%ROWTYPE;
  evidence_target JSONB;
  mutation_attempt JSONB;
  verification_provider_get JSONB;
  verification_creative JSONB;
  verification_campaign JSONB;
  verification_adset JSONB;
  expected_verified_status TEXT;
  verification_observed_at TIMESTAMPTZ;
  verification_is_exact BOOLEAN;
BEGIN
  -- Attempt-event authority is anchored to the database commit path. Callers
  -- cannot backdate created_at to make a stale provider observation appear
  -- newer than a late completion.
  NEW.created_at := clock_timestamp();

  SELECT *
    INTO source_action
  FROM meta_ads_action_log
  WHERE id = NEW.source_action_log_id
  FOR UPDATE;

  IF NOT FOUND
     OR source_action.source = 'decision_origin'
     OR source_action.action NOT IN ('pause', 'resume')
     OR source_action.status <> 'pending'
     OR source_action.creative_id IS NULL
     OR source_action.payload_request->>'mutation_journal_contract_version'
       IS DISTINCT FROM 'meta-manual-ad-status-mutation-attempt.v1'
     OR source_action.payload_request->>'mutation_journal_required'
       IS DISTINCT FROM 'true'
     OR jsonb_typeof(
       source_action.payload_request->'manual_status_mutation_target'
     ) IS DISTINCT FROM 'object'
     OR source_action.payload_request
       ->'manual_status_mutation_target'->>'businessId'
       IS DISTINCT FROM NEW.business_id::text
     OR source_action.payload_request
       ->'manual_status_mutation_target'->>'providerAccountId'
       IS DISTINCT FROM NEW.provider_account_id
     OR source_action.payload_request
       ->'manual_status_mutation_target'->>'adId'
       IS DISTINCT FROM NEW.ad_id
     OR source_action.payload_request
       ->'manual_status_mutation_target'->>'creativeId'
       IS DISTINCT FROM NEW.creative_id
     OR source_action.payload_request
       ->'manual_status_mutation_target'->>'campaignId'
       IS DISTINCT FROM NEW.campaign_id
     OR source_action.payload_request
       ->'manual_status_mutation_target'->>'adsetId'
       IS DISTINCT FROM NEW.adset_id
     OR EXISTS (
       SELECT 1
       FROM meta_ads_action_reconciliation_events reconciliation
       WHERE reconciliation.source_action_log_id =
         NEW.source_action_log_id
     )
     OR COALESCE(
       source_action.payload_request->>'dry_run' = 'true',
       source_action.dry_run,
       false
     )
     OR NEW.business_id <> source_action.business_id
     OR NEW.provider_account_id IS DISTINCT FROM
       source_action.provider_account_id
     OR NEW.ad_id <> source_action.ad_id
     OR NEW.creative_id <> source_action.creative_id
     OR NEW.action <> source_action.action
     OR (
       SELECT count(*)
       FROM business_provider_accounts binding
       WHERE binding.business_id = NEW.business_id::text
         AND binding.provider = 'meta'
         AND binding.provider_account_id = NEW.provider_account_id
     ) <> 1
     OR NOT EXISTS (
       SELECT 1
       FROM business_provider_accounts binding
       WHERE binding.business_id = NEW.business_id::text
         AND binding.provider = 'meta'
         AND binding.provider_account_ref_id =
           NEW.provider_account_ref_id
         AND binding.provider_account_id = NEW.provider_account_id
     ) THEN
    RAISE EXCEPTION
      'Manual Meta mutation attempt lineage is not an exact live pending action.'
      USING ERRCODE = '23514';
  END IF;

  IF trim(both '/' from NEW.post_path) <> NEW.ad_id
     OR NEW.started_at <
       date_trunc('milliseconds', source_action.requested_at)
     OR (
       NEW.event_kind = 'attempt_started' AND (
         NEW.started_at < clock_timestamp() - interval '30 seconds'
         OR NEW.started_at > clock_timestamp() + interval '5 seconds'
       )
     )
     OR NEW.evidence_json->>'contractVersion' IS DISTINCT FROM
       'meta-manual-ad-status-mutation-attempt.v1'
     OR NEW.evidence_json->>'eventKind' IS DISTINCT FROM NEW.event_kind
     OR NEW.evidence_json->>'sourceActionLogId' IS DISTINCT FROM
       NEW.source_action_log_id::text
     OR NEW.evidence_json->>'attemptId' IS DISTINCT FROM NEW.attempt_id::text
     OR NEW.evidence_json->>'action' IS DISTINCT FROM NEW.action
     OR NEW.evidence_json->>'postPath' IS DISTINCT FROM NEW.post_path
     OR NEW.evidence_json->>'startedAt' IS DISTINCT FROM
       to_char(NEW.started_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR NEW.evidence_json->>'leaseDeadline' IS DISTINCT FROM
       to_char(NEW.lease_deadline AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"')
     OR NEW.evidence_hash <>
       encode(digest(NEW.evidence_json::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION
      'Manual Meta mutation attempt timing, path, or evidence is invalid.'
      USING ERRCODE = '23514';
  END IF;

  evidence_target := NEW.evidence_json->'target';
  IF jsonb_typeof(evidence_target) IS DISTINCT FROM 'object'
     OR evidence_target->>'businessId' IS DISTINCT FROM NEW.business_id::text
     OR evidence_target->>'providerAccountRefId' IS DISTINCT FROM
       NEW.provider_account_ref_id::text
     OR evidence_target->>'providerAccountId' IS DISTINCT FROM
       NEW.provider_account_id
     OR evidence_target->>'adId' IS DISTINCT FROM NEW.ad_id
     OR evidence_target->>'creativeId' IS DISTINCT FROM NEW.creative_id
     OR evidence_target->>'campaignId' IS DISTINCT FROM NEW.campaign_id
     OR evidence_target->>'adsetId' IS DISTINCT FROM NEW.adset_id THEN
    RAISE EXCEPTION
      'Manual Meta mutation attempt target evidence is not exact.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_kind = 'attempt_completed' THEN
    SELECT *
      INTO started_event
    FROM meta_ads_action_mutation_attempt_events
    WHERE source_action_log_id = NEW.source_action_log_id
      AND event_kind = 'attempt_started'
    FOR KEY SHARE;
    IF NOT FOUND
       OR NEW.attempt_id <> started_event.attempt_id
       OR NEW.business_id <> started_event.business_id
       OR NEW.provider_account_ref_id <>
         started_event.provider_account_ref_id
       OR NEW.provider_account_id <> started_event.provider_account_id
       OR NEW.ad_id <> started_event.ad_id
       OR NEW.creative_id <> started_event.creative_id
       OR NEW.campaign_id <> started_event.campaign_id
       OR NEW.adset_id <> started_event.adset_id
       OR NEW.action <> started_event.action
       OR NEW.post_path <> started_event.post_path
       OR NEW.started_at <> started_event.started_at
       OR NEW.lease_deadline <> started_event.lease_deadline THEN
      RAISE EXCEPTION
        'Manual Meta mutation completion does not match its immutable start.'
        USING ERRCODE = '23514';
    END IF;

    mutation_attempt := NEW.evidence_json->'mutationAttempt';
    verification_provider_get :=
      NEW.verification_json->'providerGetEvidence';
    verification_creative :=
      verification_provider_get->'creative';
    verification_campaign :=
      verification_provider_get->'campaign';
    verification_adset :=
      verification_provider_get->'adset';
    expected_verified_status :=
      CASE NEW.action WHEN 'pause' THEN 'PAUSED' ELSE 'ACTIVE' END;
    verification_observed_at := NULLIF(
      NEW.verification_json->>'observedAt',
      ''
    )::timestamptz;
    verification_is_exact :=
      jsonb_typeof(NEW.verification_json) = 'object'
      AND NEW.verification_json->>'contractVersion' =
        'meta-ad-status-write-verification.v1'
      AND btrim(NEW.verification_json->>'adId') = NEW.ad_id
      AND btrim(NEW.verification_json->>'providerAccountId') =
        NEW.provider_account_id
      AND btrim(NEW.verification_json->>'creativeId') = NEW.creative_id
      AND btrim(NEW.verification_json->>'campaignId') = NEW.campaign_id
      AND btrim(NEW.verification_json->>'adsetId') = NEW.adset_id
      AND upper(btrim(
        NEW.verification_json->>'configuredStatus'
      )) = expected_verified_status
      AND upper(btrim(
        NEW.verification_json->>'effectiveStatus'
      )) = expected_verified_status
      AND upper(btrim(
        NEW.verification_json->>'campaignConfiguredStatus'
      )) = 'ACTIVE'
      AND upper(btrim(
        NEW.verification_json->>'campaignEffectiveStatus'
      )) = 'ACTIVE'
      AND upper(btrim(
        NEW.verification_json->>'adsetConfiguredStatus'
      )) = 'ACTIVE'
      AND upper(btrim(
        NEW.verification_json->>'adsetEffectiveStatus'
      )) = 'ACTIVE'
      AND NEW.verification_json->'policyEligible' = 'true'::jsonb
      AND NEW.verification_json->'reviewStatus' = 'null'::jsonb
      AND verification_observed_at >= NEW.completed_at
      AND verification_observed_at <= clock_timestamp()
      AND jsonb_typeof(verification_provider_get) = 'object'
      AND btrim(verification_provider_get->>'id') = NEW.ad_id
      AND regexp_replace(
        btrim(verification_provider_get->>'account_id'),
        '^act_',
        '',
        'i'
      ) = regexp_replace(
        NEW.provider_account_id,
        '^act_',
        '',
        'i'
      )
      AND upper(btrim(verification_provider_get->>'status')) =
        expected_verified_status
      AND upper(btrim(
        verification_provider_get->>'effective_status'
      )) = expected_verified_status
      AND jsonb_typeof(verification_creative) = 'object'
      AND btrim(verification_creative->>'id') = NEW.creative_id
      AND jsonb_typeof(verification_campaign) = 'object'
      AND btrim(verification_campaign->>'id') = NEW.campaign_id
      AND upper(btrim(verification_campaign->>'status')) = 'ACTIVE'
      AND upper(btrim(
        verification_campaign->>'effective_status'
      )) = 'ACTIVE'
      AND jsonb_typeof(verification_adset) = 'object'
      AND btrim(verification_adset->>'id') = NEW.adset_id
      AND upper(btrim(verification_adset->>'status')) = 'ACTIVE'
      AND upper(btrim(
        verification_adset->>'effective_status'
      )) = 'ACTIVE';
    IF NEW.evidence_json->>'completionOutcome' IS DISTINCT FROM
         NEW.completion_outcome
       OR NEW.evidence_json->>'providerOutcome' IS DISTINCT FROM
         NEW.provider_outcome
       OR jsonb_typeof(mutation_attempt) IS DISTINCT FROM 'object'
       OR mutation_attempt->'attemptCount' IS DISTINCT FROM '1'::jsonb
       OR mutation_attempt->>'method' IS DISTINCT FROM 'POST'
       OR mutation_attempt->>'path' IS DISTINCT FROM NEW.post_path
       OR mutation_attempt->>'attemptedAt' IS DISTINCT FROM to_char(
         NEW.attempted_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       OR mutation_attempt->>'completedAt' IS DISTINCT FROM to_char(
         NEW.completed_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       OR mutation_attempt->'providerResponseReceived' IS DISTINCT FROM
         to_jsonb(NEW.provider_response_received)
       OR mutation_attempt->'providerResponseSuccessful' IS DISTINCT FROM
         to_jsonb(NEW.provider_response_successful)
       OR mutation_attempt->'httpStatus' IS DISTINCT FROM
         COALESCE(to_jsonb(NEW.http_status), 'null'::jsonb)
       OR mutation_attempt->>'outcome' IS DISTINCT FROM
         (CASE
           WHEN NEW.provider_response_received
             THEN 'provider_response_received'
           ELSE 'outcome_ambiguous'
         END)
       OR mutation_attempt->'automaticRetryAttempted' IS DISTINCT FROM
         'false'::jsonb
       OR mutation_attempt->'transportError' IS DISTINCT FROM
         COALESCE(NEW.transport_error_json, 'null'::jsonb)
       OR NEW.evidence_json->'providerResponse' IS DISTINCT FROM
         COALESCE(NEW.provider_response_json, 'null'::jsonb)
       OR NEW.evidence_json->'verification' IS DISTINCT FROM
         COALESCE(NEW.verification_json, 'null'::jsonb) THEN
      RAISE EXCEPTION
        'Manual Meta mutation completion evidence is not exact.'
        USING ERRCODE = '23514';
    END IF;

    IF NEW.completion_outcome = 'provider_outcome_ambiguous' THEN
      IF NEW.provider_outcome <> 'outcome_ambiguous'
         OR NEW.provider_response_received
         OR NEW.provider_response_successful
         OR NEW.http_status IS NOT NULL
         OR NEW.provider_response_json IS NOT NULL
         OR NEW.verification_json IS NOT NULL
         OR jsonb_typeof(NEW.transport_error_json) IS DISTINCT FROM
           'object' THEN
        RAISE EXCEPTION
          'Manual Meta ambiguous mutation completion geometry is invalid.'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.completion_outcome =
      'provider_response_succeeded_verification_failed' THEN
      IF NEW.provider_outcome <> 'provider_response_succeeded'
         OR NOT NEW.provider_response_received
         OR NOT NEW.provider_response_successful
         OR NEW.http_status < 200
         OR NEW.http_status >= 300
         OR jsonb_typeof(NEW.provider_response_json) IS DISTINCT FROM
           'object'
         OR NEW.provider_response_json->>'success' IS DISTINCT FROM 'true'
         OR jsonb_typeof(NEW.verification_json) IS DISTINCT FROM 'object'
         OR NEW.verification_json = '{}'::jsonb
         OR verification_is_exact IS TRUE
         OR NEW.transport_error_json IS NOT NULL THEN
        RAISE EXCEPTION
          'Manual Meta verification-failed mutation geometry is invalid.'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.completion_outcome = 'provider_response_verified_success' THEN
      IF NEW.provider_outcome <> 'verified_success'
         OR NOT NEW.provider_response_received
         OR NOT NEW.provider_response_successful
         OR NEW.http_status < 200
         OR NEW.http_status >= 300
         OR jsonb_typeof(NEW.provider_response_json) IS DISTINCT FROM
           'object'
         OR NEW.provider_response_json->>'success' IS DISTINCT FROM 'true'
         OR jsonb_typeof(NEW.verification_json) IS DISTINCT FROM 'object'
         OR verification_is_exact IS DISTINCT FROM TRUE
         OR NEW.transport_error_json IS NOT NULL THEN
        RAISE EXCEPTION
          'Manual Meta verified mutation completion geometry is invalid.'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW.completion_outcome = 'provider_definite_failure' THEN
      IF NEW.provider_outcome <> 'definite_failure'
         OR NOT NEW.provider_response_received
         OR NEW.provider_response_successful
         OR NEW.http_status IS NULL
         OR (
           NEW.http_status < 400 AND
           jsonb_typeof(NEW.provider_response_json->'error') IS DISTINCT FROM
             'object'
         )
         OR jsonb_typeof(NEW.provider_response_json) IS DISTINCT FROM
           'object'
         OR NEW.verification_json IS NOT NULL
         OR NEW.transport_error_json IS NOT NULL THEN
        RAISE EXCEPTION
          'Manual Meta definite-failure mutation geometry is invalid.'
          USING ERRCODE = '23514';
      END IF;
    END IF;
  END IF;

  RETURN NEW;
END
$meta_action_mutation_attempt_validation$;

DO $meta_action_mutation_attempt_validation_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid =
      'meta_ads_action_mutation_attempt_events'::regclass
      AND tgname = 'trg_meta_ads_action_mutation_attempt_validate'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_meta_ads_action_mutation_attempt_validate
    BEFORE INSERT ON meta_ads_action_mutation_attempt_events
    FOR EACH ROW
    EXECUTE FUNCTION validate_meta_ads_action_mutation_attempt_event();
  END IF;
END
$meta_action_mutation_attempt_validation_trigger$;

CREATE OR REPLACE FUNCTION reject_meta_ads_action_mutation_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_action_mutation_attempt_immutable$
BEGIN
  RAISE EXCEPTION
    'meta_ads_action_mutation_attempt_events is append-only.'
    USING ERRCODE = '55000';
END
$meta_action_mutation_attempt_immutable$;

DO $meta_action_mutation_attempt_immutable_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid =
      'meta_ads_action_mutation_attempt_events'::regclass
      AND tgname = 'trg_meta_ads_action_mutation_attempt_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_meta_ads_action_mutation_attempt_immutable
    BEFORE UPDATE OR DELETE ON meta_ads_action_mutation_attempt_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_meta_ads_action_mutation_attempt_mutation();
  END IF;
END
$meta_action_mutation_attempt_immutable_trigger$;

CREATE TABLE IF NOT EXISTS meta_ads_action_reconciliation_events (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version           TEXT NOT NULL
                               DEFAULT 'meta-manual-ad-status-reconciliation.v1'
                               CHECK (
                                 contract_version =
                                   'meta-manual-ad-status-reconciliation.v1'
                               ),
  source_action_log_id       UUID NOT NULL,
  source_attempt_id          UUID,
  source_attempt_completed_event_id UUID,
  business_id                UUID NOT NULL,
  provider_account_ref_id    UUID NOT NULL,
  source_provider_account_id TEXT,
  provider_account_id        TEXT NOT NULL
                               CHECK (length(btrim(provider_account_id)) > 0),
  ad_id                      TEXT NOT NULL
                               CHECK (length(btrim(ad_id)) > 0),
  creative_id                TEXT NOT NULL
                               CHECK (length(btrim(creative_id)) > 0),
  campaign_id                TEXT NOT NULL
                               CHECK (length(btrim(campaign_id)) > 0),
  adset_id                   TEXT NOT NULL
                               CHECK (length(btrim(adset_id)) > 0),
  action                     TEXT NOT NULL
                               CHECK (action IN ('pause', 'resume')),
  source_authority_kind      TEXT NOT NULL CHECK (
                               source_authority_kind IN (
                                 'completed_attempt',
                                 'lease_expired_started',
                                 'pre_provider_no_attempt',
                                 'legacy_quarantine'
                               )
                             ),
  source_outcome             TEXT NOT NULL CHECK (
                               source_outcome IN (
                                 'provider_outcome_ambiguous',
                                 'provider_response_succeeded_verification_failed',
                                 'provider_response_verified_success',
                                 'provider_definite_failure',
                                 'attempt_lease_expired_without_completion',
                                 'pre_provider_no_mutation_attempt',
                                 'legacy_precontract_quarantine_elapsed'
                               )
                             ),
  source_requested_at        TIMESTAMPTZ NOT NULL,
  source_lease_deadline      TIMESTAMPTZ,
  source_attempted_at        TIMESTAMPTZ,
  source_completed_at        TIMESTAMPTZ,
  source_terminal_finalized_at TIMESTAMPTZ,
  source_legacy_anchor_at    TIMESTAMPTZ,
  settlement_not_before     TIMESTAMPTZ NOT NULL,
  resolution                 TEXT NOT NULL CHECK (
                               resolution IN (
                                 'current_state_matches_requested',
                                 'current_state_matches_precondition'
                               )
                             ),
  requested_status           TEXT NOT NULL
                               CHECK (requested_status IN ('ACTIVE', 'PAUSED')),
  observed_status            TEXT NOT NULL
                               CHECK (observed_status IN ('ACTIVE', 'PAUSED')),
  observed_effective_status  TEXT NOT NULL
                               CHECK (
                                 observed_effective_status IN (
                                   'ACTIVE',
                                   'PAUSED'
                                 )
                               ),
  observed_campaign_status   TEXT NOT NULL
                               CHECK (
                                 observed_campaign_status IN (
                                   'ACTIVE',
                                   'PAUSED'
                                 )
                               ),
  observed_campaign_effective_status TEXT NOT NULL
                               CHECK (
                                 observed_campaign_effective_status IN (
                                   'ACTIVE',
                                   'PAUSED'
                                 )
                               ),
  observed_adset_status      TEXT NOT NULL
                               CHECK (
                                 observed_adset_status IN (
                                   'ACTIVE',
                                   'PAUSED'
                                 )
                               ),
  observed_adset_effective_status TEXT NOT NULL
                               CHECK (
                                 observed_adset_effective_status IN (
                                   'ACTIVE',
                                   'PAUSED'
                                 )
                               ),
  policy_eligible            BOOLEAN NOT NULL CHECK (policy_eligible),
  review_status              TEXT,
  observed_at                TIMESTAMPTZ NOT NULL,
  captured_at                TIMESTAMPTZ NOT NULL,
  evidence_json              JSONB NOT NULL
                               CHECK (jsonb_typeof(evidence_json) = 'object'),
  evidence_hash              CHAR(64) NOT NULL
                               CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
  CONSTRAINT meta_ads_action_reconciliation_source_action_fk
    FOREIGN KEY (source_action_log_id, business_id)
    REFERENCES meta_ads_action_log (id, business_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_action_reconciliation_attempt_event_fk
    FOREIGN KEY (source_attempt_completed_event_id)
    REFERENCES meta_ads_action_mutation_attempt_events (id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_action_reconciliation_account_fk
    FOREIGN KEY (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_action_reconciliation_source_unique
    UNIQUE (source_action_log_id),
  CONSTRAINT meta_ads_action_reconciliation_source_account_check CHECK (
    source_provider_account_id IS NULL OR
    source_provider_account_id = provider_account_id
  ),
  CONSTRAINT meta_ads_action_reconciliation_requested_status_check CHECK (
    (action = 'pause' AND requested_status = 'PAUSED') OR
    (action = 'resume' AND requested_status = 'ACTIVE')
  ),
  CONSTRAINT meta_ads_action_reconciliation_resolution_geometry_check CHECK (
    observed_effective_status = observed_status AND
    observed_campaign_status = 'ACTIVE' AND
    observed_campaign_effective_status = 'ACTIVE' AND
    observed_adset_status = 'ACTIVE' AND
    observed_adset_effective_status = 'ACTIVE' AND
    review_status IS NULL AND
    (
      (
        resolution = 'current_state_matches_requested' AND
        observed_status = requested_status
      ) OR (
        resolution = 'current_state_matches_precondition' AND
        observed_status <> requested_status
      )
    )
  ),
  CONSTRAINT meta_ads_action_reconciliation_time_check CHECK (
    (
      (
        source_authority_kind = 'completed_attempt' AND
        source_attempt_id IS NOT NULL AND
        source_attempt_completed_event_id IS NOT NULL AND
        source_lease_deadline IS NOT NULL AND
        source_attempted_at >= source_requested_at AND
        source_completed_at >= source_attempted_at AND
        source_completed_at <= source_lease_deadline AND
        source_legacy_anchor_at IS NULL AND
        settlement_not_before =
          source_completed_at + interval '5 minutes' AND
        (
          source_terminal_finalized_at IS NULL OR (
            source_terminal_finalized_at >= source_completed_at AND
            observed_at >= source_terminal_finalized_at
          )
        )
      ) OR (
        source_authority_kind = 'lease_expired_started' AND
        source_outcome =
          'attempt_lease_expired_without_completion' AND
        source_attempt_id IS NOT NULL AND
        source_attempt_completed_event_id IS NULL AND
        source_lease_deadline IS NOT NULL AND
        source_attempted_at IS NULL AND
        source_completed_at IS NULL AND
        source_terminal_finalized_at IS NULL AND
        source_legacy_anchor_at IS NULL AND
        settlement_not_before =
          source_lease_deadline + interval '5 minutes'
      ) OR (
        source_authority_kind = 'pre_provider_no_attempt' AND
        source_outcome = 'pre_provider_no_mutation_attempt' AND
        source_attempt_id IS NULL AND
        source_attempt_completed_event_id IS NULL AND
        source_lease_deadline IS NULL AND
        source_attempted_at IS NULL AND
        source_completed_at IS NULL AND
        source_terminal_finalized_at IS NULL AND
        source_legacy_anchor_at IS NULL AND
        settlement_not_before =
          source_requested_at + interval '5 minutes'
      ) OR (
        source_authority_kind = 'legacy_quarantine' AND
        source_outcome = 'legacy_precontract_quarantine_elapsed' AND
        source_attempt_id IS NULL AND
        source_attempt_completed_event_id IS NULL AND
        source_lease_deadline IS NULL AND
        source_attempted_at IS NULL AND
        source_completed_at IS NULL AND
        source_terminal_finalized_at IS NULL AND
        source_legacy_anchor_at IS NOT NULL AND
        settlement_not_before =
          source_legacy_anchor_at + interval '7 days'
      )
    ) AND
    observed_at >= settlement_not_before AND
    captured_at >= observed_at AND
    captured_at - observed_at <= interval '60 seconds'
  )
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_action_reconciliation_business_ad
  ON meta_ads_action_reconciliation_events
  (business_id, provider_account_id, ad_id, created_at DESC);

CREATE OR REPLACE FUNCTION validate_meta_ads_action_reconciliation_event()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_action_reconciliation_validation$
DECLARE
  source_action meta_ads_action_log%ROWTYPE;
  started_event meta_ads_action_mutation_attempt_events%ROWTYPE;
  completed_event meta_ads_action_mutation_attempt_events%ROWTYPE;
  expected_requested_status TEXT;
  provider_get JSONB;
  provider_creative JSONB;
  provider_campaign JSONB;
  provider_adset JSONB;
  resolved_target JSONB;
  policy_proof JSONB;
  source_authority_evidence JSONB;
  pre_provider_target JSONB;
  legacy_anchor TIMESTAMPTZ;
  dimension_count INTEGER;
  exact_dimension_count INTEGER;
  unresolved_source_count INTEGER;
BEGIN
  SELECT *
    INTO source_action
  FROM meta_ads_action_log
  WHERE id = NEW.source_action_log_id
  FOR UPDATE;

  IF NOT FOUND THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation source action does not exist.'
      USING ERRCODE = '23503';
  END IF;

  IF source_action.source = 'decision_origin'
     OR source_action.action NOT IN ('pause', 'resume')
     OR source_action.status NOT IN ('pending', 'silent_failure')
     OR source_action.creative_id IS NULL
     OR COALESCE(
       source_action.payload_request->>'dry_run' = 'true',
       source_action.dry_run,
       false
     ) THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation requires a live manual silent_failure source.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.business_id <> source_action.business_id
     OR NEW.ad_id <> source_action.ad_id
     OR NEW.creative_id <> source_action.creative_id
     OR NEW.action <> source_action.action
     OR NEW.source_requested_at <>
       date_trunc('milliseconds', source_action.requested_at)
     OR NEW.source_terminal_finalized_at IS DISTINCT FROM
       date_trunc('milliseconds', source_action.terminal_finalized_at)
     OR NEW.source_provider_account_id IS DISTINCT FROM
       source_action.provider_account_id
     OR (
       source_action.provider_account_id IS NOT NULL AND
       NEW.provider_account_id <> source_action.provider_account_id
     ) THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation lineage does not match its source action.'
      USING ERRCODE = '23514';
  END IF;

  IF (
    SELECT count(*)
    FROM business_provider_accounts binding
    WHERE binding.business_id = NEW.business_id::text
      AND binding.provider = 'meta'
      AND binding.provider_account_id = NEW.provider_account_id
  ) <> 1 OR NOT EXISTS (
    SELECT 1
    FROM business_provider_accounts binding
    WHERE binding.business_id = NEW.business_id::text
      AND binding.provider = 'meta'
      AND binding.provider_account_ref_id = NEW.provider_account_ref_id
      AND binding.provider_account_id = NEW.provider_account_id
  ) THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation account binding is not exact.'
      USING ERRCODE = '23514';
  END IF;

  SELECT count(*)::integer
    INTO unresolved_source_count
  FROM meta_ads_action_log unresolved
  WHERE unresolved.business_id = NEW.business_id
    AND unresolved.ad_id = NEW.ad_id
    AND unresolved.source <> 'decision_origin'
    AND unresolved.action IN ('pause', 'resume')
    AND unresolved.status IN ('pending', 'silent_failure')
    AND NOT COALESCE(
      unresolved.payload_request->>'dry_run' = 'true',
      unresolved.dry_run,
      false
    )
    AND (
      unresolved.provider_account_id = NEW.provider_account_id
      OR unresolved.provider_account_id IS NULL
    )
    AND NOT EXISTS (
      SELECT 1
      FROM meta_ads_action_reconciliation_events prior
      WHERE prior.source_action_log_id = unresolved.id
    );
  IF unresolved_source_count <> 1 THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation requires exactly one unresolved source.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.source_authority_kind = 'completed_attempt' THEN
    SELECT *
      INTO completed_event
    FROM meta_ads_action_mutation_attempt_events
    WHERE id = NEW.source_attempt_completed_event_id
      AND source_action_log_id = NEW.source_action_log_id
      AND event_kind = 'attempt_completed'
    FOR KEY SHARE;
    SELECT *
      INTO started_event
    FROM meta_ads_action_mutation_attempt_events
    WHERE source_action_log_id = NEW.source_action_log_id
      AND event_kind = 'attempt_started'
    FOR KEY SHARE;
    IF completed_event.id IS NULL
       OR started_event.id IS NULL
       OR completed_event.attempt_id <> NEW.source_attempt_id
       OR started_event.attempt_id <> NEW.source_attempt_id
       OR completed_event.completion_outcome <> NEW.source_outcome
       OR completed_event.business_id <> NEW.business_id
       OR completed_event.provider_account_ref_id <>
         NEW.provider_account_ref_id
       OR completed_event.provider_account_id <> NEW.provider_account_id
       OR completed_event.ad_id <> NEW.ad_id
       OR completed_event.creative_id <> NEW.creative_id
       OR completed_event.campaign_id <> NEW.campaign_id
       OR completed_event.adset_id <> NEW.adset_id
       OR completed_event.action <> NEW.action
       OR completed_event.lease_deadline <> NEW.source_lease_deadline
       OR completed_event.attempted_at <> NEW.source_attempted_at
       OR completed_event.completed_at <> NEW.source_completed_at
       OR NEW.observed_at < completed_event.created_at THEN
      RAISE EXCEPTION
        'Manual Meta status reconciliation lacks exact completed-attempt authority.'
        USING ERRCODE = '23514';
    END IF;
    source_authority_evidence := completed_event.evidence_json;
  ELSIF NEW.source_authority_kind = 'lease_expired_started' THEN
    SELECT *
      INTO started_event
    FROM meta_ads_action_mutation_attempt_events
    WHERE source_action_log_id = NEW.source_action_log_id
      AND event_kind = 'attempt_started'
    FOR KEY SHARE;
    IF started_event.id IS NULL
       OR started_event.attempt_id <> NEW.source_attempt_id
       OR started_event.business_id <> NEW.business_id
       OR started_event.provider_account_ref_id <>
         NEW.provider_account_ref_id
       OR started_event.provider_account_id <> NEW.provider_account_id
       OR started_event.ad_id <> NEW.ad_id
       OR started_event.creative_id <> NEW.creative_id
       OR started_event.campaign_id <> NEW.campaign_id
       OR started_event.adset_id <> NEW.adset_id
       OR started_event.action <> NEW.action
       OR started_event.lease_deadline <> NEW.source_lease_deadline
       OR EXISTS (
         SELECT 1
         FROM meta_ads_action_mutation_attempt_events completion
         WHERE completion.source_action_log_id = NEW.source_action_log_id
           AND completion.event_kind = 'attempt_completed'
       ) THEN
      RAISE EXCEPTION
        'Manual Meta status reconciliation lacks exact expired-start authority.'
        USING ERRCODE = '23514';
    END IF;
    source_authority_evidence := started_event.evidence_json;
  ELSIF NEW.source_authority_kind = 'pre_provider_no_attempt' THEN
    pre_provider_target :=
      source_action.payload_request->'manual_status_mutation_target';
    IF source_action.status <> 'pending'
       OR source_action.payload_request->>'mutation_journal_contract_version'
         IS DISTINCT FROM
         'meta-manual-ad-status-mutation-attempt.v1'
       OR source_action.payload_request->>'mutation_journal_required'
         IS DISTINCT FROM 'true'
       OR jsonb_typeof(pre_provider_target) IS DISTINCT FROM 'object'
       OR pre_provider_target->>'businessId' IS DISTINCT FROM
         NEW.business_id::text
       OR pre_provider_target->>'providerAccountId' IS DISTINCT FROM
         NEW.provider_account_id
       OR pre_provider_target->>'adId' IS DISTINCT FROM NEW.ad_id
       OR pre_provider_target->>'creativeId' IS DISTINCT FROM NEW.creative_id
       OR pre_provider_target->>'campaignId' IS DISTINCT FROM NEW.campaign_id
       OR pre_provider_target->>'adsetId' IS DISTINCT FROM NEW.adset_id
       OR EXISTS (
         SELECT 1
         FROM meta_ads_action_mutation_attempt_events attempt
         WHERE attempt.source_action_log_id = NEW.source_action_log_id
       ) THEN
      RAISE EXCEPTION
        'Manual Meta status reconciliation lacks exact pre-provider authority.'
        USING ERRCODE = '23514';
    END IF;
    source_authority_evidence := jsonb_build_object(
      'contractVersion', 'meta-manual-ad-status-mutation-attempt.v1',
      'authority', 'pre_provider_no_attempt',
      'sourceActionLogId', NEW.source_action_log_id::text,
      'target', pre_provider_target
    );
  ELSIF NEW.source_authority_kind = 'legacy_quarantine' THEN
    legacy_anchor := date_trunc('milliseconds', GREATEST(
      source_action.requested_at,
      source_action.updated_at,
      source_action.verified_at
    ));
    SELECT
      count(*)::integer,
      count(*) FILTER (
        WHERE provider_account_ref_id = NEW.provider_account_ref_id
          AND provider_account_id = NEW.provider_account_id
          AND creative_id = NEW.creative_id
          AND campaign_id = NEW.campaign_id
          AND adset_id = NEW.adset_id
      )::integer
    INTO dimension_count, exact_dimension_count
    FROM meta_ad_dimensions
    WHERE business_id = NEW.business_id::text
      AND ad_id = NEW.ad_id;
    IF source_action.status <> 'silent_failure'
       OR source_action.provider_account_id IS NOT NULL
       OR source_action.terminal_finalized_at IS NOT NULL
       OR NEW.source_legacy_anchor_at <> legacy_anchor
       OR dimension_count <> 1
       OR exact_dimension_count <> 1
       OR EXISTS (
         SELECT 1
         FROM meta_ads_action_mutation_attempt_events attempt
         WHERE attempt.source_action_log_id = NEW.source_action_log_id
       ) THEN
      RAISE EXCEPTION
        'Legacy manual Meta reconciliation lacks one quarantined exact target.'
        USING ERRCODE = '23514';
    END IF;
    source_authority_evidence := jsonb_build_object(
      'contractVersion', 'meta-manual-ad-status-legacy-quarantine.v1',
      'authority', 'legacy_quarantine',
      'sourceActionLogId', NEW.source_action_log_id::text,
      'anchorAt', to_char(
        NEW.source_legacy_anchor_at AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'settlementNotBefore', to_char(
        NEW.settlement_not_before AT TIME ZONE 'UTC',
        'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
      ),
      'target', jsonb_build_object(
        'businessId', NEW.business_id::text,
        'providerAccountRefId', NEW.provider_account_ref_id::text,
        'providerAccountId', NEW.provider_account_id,
        'adId', NEW.ad_id,
        'creativeId', NEW.creative_id,
        'campaignId', NEW.campaign_id,
        'adsetId', NEW.adset_id
      )
    );
  ELSE
    RAISE EXCEPTION
      'Manual Meta status reconciliation authority kind is unsupported.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.observed_at < NEW.settlement_not_before
     OR (
       source_action.terminal_finalized_at IS NOT NULL AND
       NEW.observed_at < source_action.terminal_finalized_at
     ) THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation observation predates authority settlement.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.captured_at < clock_timestamp() - interval '30 seconds'
     OR NEW.captured_at > clock_timestamp() + interval '5 seconds' THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation capture time is not current.'
      USING ERRCODE = '23514';
  END IF;

  expected_requested_status :=
    CASE NEW.action WHEN 'pause' THEN 'PAUSED' ELSE 'ACTIVE' END;
  IF NEW.requested_status <> expected_requested_status THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation requested status is contradictory.'
      USING ERRCODE = '23514';
  END IF;

  provider_get := NEW.evidence_json->'providerGet';
  provider_creative := provider_get->'creative';
  provider_campaign := provider_get->'campaign';
  provider_adset := provider_get->'adset';
  resolved_target := NEW.evidence_json->'resolvedTarget';
  policy_proof := NEW.evidence_json->'policyProof';
  IF NEW.evidence_json->>'contractVersion' IS DISTINCT FROM
       'meta-manual-ad-status-reconciliation.v1'
     OR NEW.evidence_json->'sourceMutation' IS DISTINCT FROM
       source_authority_evidence
     OR jsonb_typeof(provider_get) IS DISTINCT FROM 'object'
     OR jsonb_typeof(provider_creative) IS DISTINCT FROM 'object'
     OR jsonb_typeof(provider_campaign) IS DISTINCT FROM 'object'
     OR jsonb_typeof(provider_adset) IS DISTINCT FROM 'object'
     OR jsonb_typeof(resolved_target) IS DISTINCT FROM 'object'
     OR jsonb_typeof(policy_proof) IS DISTINCT FROM 'object'
     OR btrim(provider_get->>'id') IS DISTINCT FROM NEW.ad_id
     OR regexp_replace(
       btrim(provider_get->>'account_id'),
       '^act_',
       '',
       'i'
     ) IS DISTINCT FROM regexp_replace(
       NEW.provider_account_id,
       '^act_',
       '',
       'i'
     )
     OR upper(btrim(provider_get->>'status')) IS DISTINCT FROM
       NEW.observed_status
     OR upper(btrim(provider_get->>'effective_status')) IS DISTINCT FROM
       NEW.observed_effective_status
     OR btrim(provider_creative->>'id') IS DISTINCT FROM NEW.creative_id
     OR btrim(provider_campaign->>'id') IS DISTINCT FROM NEW.campaign_id
     OR upper(btrim(provider_campaign->>'status')) IS DISTINCT FROM
       NEW.observed_campaign_status
     OR upper(btrim(provider_campaign->>'effective_status')) IS DISTINCT FROM
       NEW.observed_campaign_effective_status
     OR btrim(provider_adset->>'id') IS DISTINCT FROM NEW.adset_id
     OR upper(btrim(provider_adset->>'status')) IS DISTINCT FROM
       NEW.observed_adset_status
     OR upper(btrim(provider_adset->>'effective_status')) IS DISTINCT FROM
       NEW.observed_adset_effective_status
     OR resolved_target->>'businessId' IS DISTINCT FROM NEW.business_id::text
     OR resolved_target->>'providerAccountId' IS DISTINCT FROM
       NEW.provider_account_id
     OR resolved_target->>'adId' IS DISTINCT FROM NEW.ad_id
     OR resolved_target->>'creativeId' IS DISTINCT FROM NEW.creative_id
     OR resolved_target->>'campaignId' IS DISTINCT FROM NEW.campaign_id
     OR resolved_target->>'adsetId' IS DISTINCT FROM NEW.adset_id
     OR policy_proof->>'eligible' IS DISTINCT FROM 'true'
     OR policy_proof->'reviewStatus' IS DISTINCT FROM 'null'::jsonb
     OR policy_proof->>'basis' IS DISTINCT FROM
       'exact_configured_effective_statuses'
     OR NEW.policy_eligible IS DISTINCT FROM true
     OR NEW.review_status IS NOT NULL THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation evidence is not exact.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.evidence_hash <>
       encode(digest(NEW.evidence_json::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION
      'Manual Meta status reconciliation evidence hash is invalid.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$meta_action_reconciliation_validation$;

DO $meta_action_reconciliation_validation_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'meta_ads_action_reconciliation_events'::regclass
      AND tgname = 'trg_meta_ads_action_reconciliation_validate'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_meta_ads_action_reconciliation_validate
    BEFORE INSERT ON meta_ads_action_reconciliation_events
    FOR EACH ROW
    EXECUTE FUNCTION validate_meta_ads_action_reconciliation_event();
  END IF;
END
$meta_action_reconciliation_validation_trigger$;

CREATE OR REPLACE FUNCTION reject_meta_ads_action_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_action_reconciliation_immutable$
BEGIN
  RAISE EXCEPTION
    'meta_ads_action_reconciliation_events is append-only.'
    USING ERRCODE = '55000';
END
$meta_action_reconciliation_immutable$;

DO $meta_action_reconciliation_immutable_trigger$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger
    WHERE tgrelid = 'meta_ads_action_reconciliation_events'::regclass
      AND tgname = 'trg_meta_ads_action_reconciliation_immutable'
      AND NOT tgisinternal
  ) THEN
    CREATE TRIGGER trg_meta_ads_action_reconciliation_immutable
    BEFORE UPDATE OR DELETE ON meta_ads_action_reconciliation_events
    FOR EACH ROW
    EXECUTE FUNCTION reject_meta_ads_action_reconciliation_mutation();
  END IF;
END
$meta_action_reconciliation_immutable_trigger$;

CREATE OR REPLACE FUNCTION validate_manual_meta_ads_action_terminalization()
RETURNS trigger
LANGUAGE plpgsql
AS $manual_meta_action_terminal_validation$
DECLARE
  old_journal_required BOOLEAN;
  new_journal_required BOOLEAN;
  started_count INTEGER;
  completed_count INTEGER;
  completed_outcome TEXT;
  completed_event meta_ads_action_mutation_attempt_events%ROWTYPE;
  pre_provider_proof BOOLEAN;
  durable_target JSONB;
BEGIN
  old_journal_required := COALESCE((
    OLD.source <> 'decision_origin'
    AND OLD.action IN ('pause', 'resume')
    AND NOT COALESCE(
      OLD.payload_request->>'dry_run' = 'true',
      OLD.dry_run,
      false
    )
    AND OLD.payload_request->>'mutation_journal_contract_version' =
      'meta-manual-ad-status-mutation-attempt.v1'
    AND OLD.payload_request->>'mutation_journal_required' = 'true'
  ), FALSE);
  new_journal_required := COALESCE((
    NEW.source <> 'decision_origin'
    AND NEW.action IN ('pause', 'resume')
    AND NOT COALESCE(
      NEW.payload_request->>'dry_run' = 'true',
      NEW.dry_run,
      false
    )
    AND NEW.payload_request->>'mutation_journal_contract_version' =
      'meta-manual-ad-status-mutation-attempt.v1'
    AND NEW.payload_request->>'mutation_journal_required' = 'true'
  ), FALSE);

  IF NOT old_journal_required AND NOT new_journal_required THEN
    RETURN NEW;
  END IF;

  IF old_journal_required IS DISTINCT FROM new_journal_required
     OR NEW.id IS DISTINCT FROM OLD.id
     OR NEW.business_id IS DISTINCT FROM OLD.business_id
     OR NEW.provider_account_ref_id IS DISTINCT FROM
       OLD.provider_account_ref_id
     OR NEW.provider_account_id IS DISTINCT FROM OLD.provider_account_id
     OR NEW.ad_id IS DISTINCT FROM OLD.ad_id
     OR NEW.creative_id IS DISTINCT FROM OLD.creative_id
     OR NEW.action IS DISTINCT FROM OLD.action
     OR NEW.source IS DISTINCT FROM OLD.source
     OR NEW.requested_by IS DISTINCT FROM OLD.requested_by
     OR NEW.requested_at IS DISTINCT FROM OLD.requested_at
     OR NEW.payload_request IS DISTINCT FROM OLD.payload_request
     OR NEW.rec_id_origin IS DISTINCT FROM OLD.rec_id_origin
     OR NEW.launch_intent_id IS DISTINCT FROM OLD.launch_intent_id
     OR NEW.decision_contract_version IS DISTINCT FROM
       OLD.decision_contract_version
     OR NEW.decision_episode_key IS DISTINCT FROM OLD.decision_episode_key
     OR NEW.decision_snapshot_id IS DISTINCT FROM OLD.decision_snapshot_id
     OR NEW.decision_evaluation_id IS DISTINCT FROM
       OLD.decision_evaluation_id
     OR NEW.decision_engine_version IS DISTINCT FROM
       OLD.decision_engine_version
     OR NEW.decision_hash IS DISTINCT FROM OLD.decision_hash
     OR NEW.idempotency_key IS DISTINCT FROM OLD.idempotency_key
     OR NEW.dry_run IS DISTINCT FROM OLD.dry_run
     OR NEW.provider_verified IS DISTINCT FROM OLD.provider_verified
     OR NEW.verification_entity_id IS DISTINCT FROM
       OLD.verification_entity_id
     OR NEW.verification_status IS DISTINCT FROM OLD.verification_status
     OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
    RAISE EXCEPTION
      'Journal-required manual Meta claim identity and envelope are immutable.'
      USING ERRCODE = '55000';
  END IF;

  IF OLD.status <> 'pending'
     OR OLD.terminal_finalized_at IS NOT NULL THEN
    IF NEW.status IS DISTINCT FROM OLD.status
       OR NEW.payload_response IS DISTINCT FROM OLD.payload_response
       OR NEW.error_code IS DISTINCT FROM OLD.error_code
       OR NEW.error_message IS DISTINCT FROM OLD.error_message
       OR NEW.resulting_ad_id IS DISTINCT FROM OLD.resulting_ad_id
       OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verification_payload IS DISTINCT FROM
         OLD.verification_payload
       OR NEW.terminal_finalized_at IS DISTINCT FROM
         OLD.terminal_finalized_at THEN
      RAISE EXCEPTION
        'Journal-required manual Meta terminal fact is immutable.'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status = 'pending' THEN
    IF NEW.payload_response IS DISTINCT FROM OLD.payload_response
       OR NEW.error_code IS DISTINCT FROM OLD.error_code
       OR NEW.error_message IS DISTINCT FROM OLD.error_message
       OR NEW.resulting_ad_id IS DISTINCT FROM OLD.resulting_ad_id
       OR NEW.duration_ms IS DISTINCT FROM OLD.duration_ms
       OR NEW.verified_at IS DISTINCT FROM OLD.verified_at
       OR NEW.verification_payload IS DISTINCT FROM
         OLD.verification_payload
       OR NEW.terminal_finalized_at IS DISTINCT FROM
         OLD.terminal_finalized_at THEN
      RAISE EXCEPTION
        'Journal-required manual Meta pending terminal fields are immutable.'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  durable_target :=
    OLD.payload_request->'manual_status_mutation_target';
  IF OLD.provider_account_id IS NULL
     OR OLD.creative_id IS NULL
     OR jsonb_typeof(durable_target) IS DISTINCT FROM 'object'
     OR durable_target->>'businessId' IS DISTINCT FROM OLD.business_id::text
     OR durable_target->>'providerAccountId' IS DISTINCT FROM
       OLD.provider_account_id
     OR durable_target->>'adId' IS DISTINCT FROM OLD.ad_id
     OR durable_target->>'creativeId' IS DISTINCT FROM OLD.creative_id
     OR NULLIF(btrim(durable_target->>'campaignId'), '') IS NULL
     OR NULLIF(btrim(durable_target->>'adsetId'), '') IS NULL
     OR (
       SELECT count(*)
       FROM business_provider_accounts binding
       WHERE binding.business_id = OLD.business_id::text
         AND binding.provider = 'meta'
         AND binding.provider_account_id = OLD.provider_account_id
     ) <> 1
     OR OLD.payload_response IS NOT NULL
     OR OLD.error_code IS NOT NULL
     OR OLD.error_message IS NOT NULL
     OR OLD.resulting_ad_id IS NOT NULL
     OR OLD.duration_ms IS NOT NULL
     OR OLD.verified_at IS NOT NULL
     OR OLD.verification_payload IS NOT NULL
     OR OLD.terminal_finalized_at IS NOT NULL
     OR NEW.terminal_finalized_at IS NULL
     OR EXISTS (
       SELECT 1
       FROM meta_ads_action_reconciliation_events reconciliation
       WHERE reconciliation.source_action_log_id = OLD.id
     ) THEN
    RAISE EXCEPTION
      'Journal-required manual Meta terminalization source is not exact.'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    count(*) FILTER (
      WHERE event_kind = 'attempt_started'
    )::integer,
    count(*) FILTER (
      WHERE event_kind = 'attempt_completed'
    )::integer,
    max(completion_outcome) FILTER (
      WHERE event_kind = 'attempt_completed'
    )
  INTO started_count, completed_count, completed_outcome
  FROM meta_ads_action_mutation_attempt_events
  WHERE source_action_log_id = OLD.id;

  SELECT *
    INTO completed_event
  FROM meta_ads_action_mutation_attempt_events
  WHERE source_action_log_id = OLD.id
    AND event_kind = 'attempt_completed';

  pre_provider_proof :=
    started_count = 0
    AND completed_count = 0
    AND NEW.status = 'failure'
    AND NULLIF(btrim(NEW.error_code), '') IS NOT NULL
    AND (
      NEW.payload_response = jsonb_build_object(
        'post_claim_preflight',
        jsonb_build_object(
          'should_mutate', false,
          'blocker', NEW.error_code
        )
      )
      OR NEW.payload_response = jsonb_build_object(
        'bulk_pre_provider_abort',
        jsonb_build_object(
          'code', NEW.error_code,
          'provider_mutation_attempted', false
        )
      )
      OR NEW.payload_response = jsonb_build_object(
        'adapter_pre_provider_abort',
        jsonb_build_object(
          'code', NEW.error_code,
          'provider_mutation_attempted', false
        )
      )
      OR (
        NEW.error_code =
          'manual_mutation_attempt_start_persistence_failed'
        AND NEW.payload_response = jsonb_build_object(
          'mutation_attempt_journal',
          jsonb_build_object(
            'started', false,
            'provider_write_attempted', false
          )
        )
      )
    );

  IF NEW.resulting_ad_id IS NOT NULL
     OR (NEW.duration_ms IS NOT NULL AND NEW.duration_ms < 0) THEN
    RAISE EXCEPTION
      'Journal-required manual Meta terminal common fields are invalid.'
      USING ERRCODE = '23514';
  END IF;

  IF NOT (
    (
      NEW.status = 'success'
      AND started_count = 1
      AND completed_count = 1
      AND completed_outcome =
        'provider_response_verified_success'
      AND NEW.payload_response IS NOT DISTINCT FROM
        completed_event.provider_response_json
      AND NEW.verification_payload IS NOT DISTINCT FROM
        completed_event.verification_json
      AND NEW.verified_at IS NOT DISTINCT FROM
        NULLIF(
          completed_event.verification_json->>'observedAt',
          ''
        )::timestamptz
      AND NEW.error_code IS NULL
      AND NEW.error_message IS NULL
    )
    OR (
      NEW.status = 'silent_failure'
      AND started_count = 1
      AND completed_count = 1
      AND completed_outcome IN (
        'provider_outcome_ambiguous',
        'provider_response_succeeded_verification_failed'
      )
      AND NEW.payload_response IS NOT DISTINCT FROM
        completed_event.provider_response_json
      AND NEW.verification_payload IS NOT DISTINCT FROM
        completed_event.verification_json
      AND NEW.verified_at IS NULL
      AND NULLIF(btrim(NEW.error_code), '') IS NOT NULL
      AND NULLIF(btrim(NEW.error_message), '') IS NOT NULL
    )
    OR (
      NEW.status = 'failure'
      AND started_count = 1
      AND completed_count = 1
      AND completed_outcome = 'provider_definite_failure'
      AND NEW.payload_response IS NOT DISTINCT FROM
        completed_event.provider_response_json
      AND NEW.verification_payload IS NULL
      AND NEW.verified_at IS NULL
      AND NULLIF(btrim(NEW.error_code), '') IS NOT NULL
      AND NULLIF(btrim(NEW.error_message), '') IS NOT NULL
    )
    OR (
      pre_provider_proof
      AND NEW.verification_payload IS NULL
      AND NEW.verified_at IS NULL
      AND NULLIF(btrim(NEW.error_message), '') IS NOT NULL
    )
  ) THEN
    RAISE EXCEPTION
      'Journal-required manual Meta terminalization lacks exact attempt authority.'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$manual_meta_action_terminal_validation$;

DROP TRIGGER IF EXISTS trg_manual_meta_ads_action_terminal_validate
ON meta_ads_action_log;

CREATE TRIGGER trg_manual_meta_ads_action_terminal_validate
BEFORE UPDATE OF
  id, business_id, provider_account_ref_id, provider_account_id,
  ad_id, creative_id, action, source, requested_by, requested_at,
  payload_request, rec_id_origin, launch_intent_id,
  decision_contract_version, decision_episode_key, decision_snapshot_id,
  decision_evaluation_id, decision_engine_version, decision_hash,
  idempotency_key, dry_run, provider_verified, verification_entity_id,
  verification_status, created_at, status, payload_response, error_code,
  error_message, resulting_ad_id, duration_ms, verified_at,
  verification_payload, terminal_finalized_at
ON meta_ads_action_log
FOR EACH ROW
EXECUTE FUNCTION validate_manual_meta_ads_action_terminalization();
`;

type NativeSchemaCapability = {
  ready: boolean;
  missing?: readonly string[];
  mismatched?: readonly string[];
  issues?: readonly string[];
};

function nativeSchemaIssues(capability: NativeSchemaCapability) {
  return [
    ...(capability.missing ?? []),
    ...(capability.mismatched ?? []),
    ...(capability.issues ?? []),
  ];
}

function assertNativeSchemaCapability(
  name: string,
  capability: NativeSchemaCapability,
) {
  if (capability.ready) return;
  throw new Error(
    `Native ad schema contract is not ready after ${name}: ${nativeSchemaIssues(capability).join(", ")}`,
  );
}

async function hasPartialNonIdempotentNativeSchema(
  db: DbClient,
  input: {
    tables: readonly string[];
    columns?: readonly { table: string; column: string }[];
  },
) {
  const [row] = await db.query<{
    table_count: number | string;
    column_count: number | string;
  }>(
    `
    SELECT
      COUNT(DISTINCT table_name)::integer AS table_count,
      COUNT(*) FILTER (WHERE column_name IS NOT NULL)::integer AS column_count
    FROM (
      SELECT table_name, NULL::text AS column_name
      FROM information_schema.tables
      WHERE table_schema = current_schema()
        AND table_name = ANY($1::text[])
      UNION ALL
      SELECT table_name, column_name
      FROM information_schema.columns
      WHERE table_schema = current_schema()
        AND (table_name, column_name) IN (
          SELECT item->>'table', item->>'column'
          FROM jsonb_array_elements($2::jsonb) item
        )
    ) capability
    `,
    [input.tables, JSON.stringify(input.columns ?? [])],
  );
  return (
    Number(row?.table_count ?? 0) > 0 || Number(row?.column_count ?? 0) > 0
  );
}

export const D063_AUTHORITY_BLOCKER_CONSTRAINT_UPGRADE_SQL = `
DO $d063_authority_blocker$
DECLARE
  target RECORD;
  canonical_ready BOOLEAN;
  temporary_constraint_name TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(
    hashtext('engine-v3-d063-authority-blocker-constraints')
  );

  FOR target IN
    SELECT *
    FROM (VALUES
      ('engine_v3_decision_snapshots_daily',
       'engine_v3_decision_snapshots_authority_blocker_check'),
      ('engine_v3_decision_outcomes_daily',
       'engine_v3_decision_outcomes_authority_blocker_check'),
      ('engine_v3_ad_decision_snapshots_daily',
       'engine_v3_ad_snapshots_authority_blocker_check'),
      ('engine_v3_ad_decision_outcomes_daily',
       'engine_v3_ad_outcomes_authority_blocker_check')
    ) AS constraints(table_name, constraint_name)
  LOOP
    CONTINUE WHEN to_regclass(target.table_name) IS NULL;

    canonical_ready := FALSE;
    SELECT constraint_row.convalidated
      AND POSITION(
        'recent_recovery_unverifiable' IN
        LOWER(pg_get_constraintdef(constraint_row.oid, TRUE))
      ) > 0
    INTO canonical_ready
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid = to_regclass(target.table_name)
      AND constraint_row.conname = target.constraint_name
      AND constraint_row.contype = 'c';

    CONTINUE WHEN COALESCE(canonical_ready, FALSE);

    temporary_constraint_name := target.constraint_name || '_d063';
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      target.table_name,
      temporary_constraint_name
    );
    EXECUTE format(
      $d063_check$
      ALTER TABLE %I ADD CONSTRAINT %I
      CHECK (authority_blocker IS NULL OR authority_blocker IN (
        ${AUTHORITY_BLOCKER_CHECK_VALUES_SQL}
      )) NOT VALID
      $d063_check$,
      target.table_name,
      temporary_constraint_name
    );
    EXECUTE format(
      'ALTER TABLE %I VALIDATE CONSTRAINT %I',
      target.table_name,
      temporary_constraint_name
    );
    EXECUTE format(
      'ALTER TABLE %I DROP CONSTRAINT IF EXISTS %I',
      target.table_name,
      target.constraint_name
    );
    EXECUTE format(
      'ALTER TABLE %I RENAME CONSTRAINT %I TO %I',
      target.table_name,
      temporary_constraint_name,
      target.constraint_name
    );
  END LOOP;
END
$d063_authority_blocker$;
`;

async function runNativeAdSchemaMigrations(
  timeoutMs: number,
  verifyCapabilities: boolean,
) {
  await runDbTransaction(
    async () => {
      const db = getDbWithTimeout(timeoutMs);
      const inspectorDb = createMigrationDb(db);

      await db.query(D063_AUTHORITY_BLOCKER_CONSTRAINT_UPGRADE_SQL);

      // SQL-capture unit tests exercise the emitted migration text with a
      // deliberately non-stateful DB mock. Production and the ephemeral
      // PostgreSQL seam always use the strict post-apply catalog verification.
      if (!verifyCapabilities) {
        await db.query(NATIVE_AD_CALIBRATION_MIGRATION_SQL);
        for (const statement of NATIVE_AD_DECISION_SCHEMA_SQL) {
          await db.query(statement);
        }
        await db.query(AD_OPERATOR_RESPONSE_ACTION_LOG_SCHEMA_SQL);
        await db.query(AD_OPERATOR_RESPONSE_SCHEMA_SQL);
        await db.query(AD_OPERATOR_RESPONSE_EPOCH_COMPATIBILITY_SQL);
        await db.query(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL);
        await db.query(NATIVE_AD_OUTCOME_PROVENANCE_SCHEMA_SQL);
        await db.query(CONTROLLED_REGISTRY_SCHEMA_SQL);
        return;
      }

      let calibration =
        await inspectNativeAdCalibrationSchemaCapability(inspectorDb);
      if (!calibration.ready) {
        await db.query(NATIVE_AD_CALIBRATION_MIGRATION_SQL);
        calibration =
          await inspectNativeAdCalibrationSchemaCapability(inspectorDb);
      }
      assertNativeSchemaCapability("native calibration migration", calibration);

      await db.query(ALTER_NATIVE_AD_DECISION_PROVENANCE_SQL);
      await db.query(ALTER_NATIVE_AD_SNAPSHOT_AUTHORITY_CHECK_SQL);
      let decisions = await inspectEvaluationStoreSchemaCapability(inspectorDb);
      if (!decisions.ready) {
        const partial = await hasPartialNonIdempotentNativeSchema(db, {
          tables: [
            "engine_v3_ad_decision_evaluation_contexts",
            "engine_v3_ad_decision_evaluations",
            "engine_v3_ad_decision_snapshots_daily",
            "engine_v3_ad_decision_events",
          ],
        });
        if (partial) {
          throw new Error(
            "Refusing to apply the non-idempotent native decision contract over a partial schema.",
          );
        }
        for (const statement of NATIVE_AD_DECISION_SCHEMA_SQL) {
          await db.query(statement);
        }
        decisions = await inspectEvaluationStoreSchemaCapability(inspectorDb);
      }
      assertNativeSchemaCapability("native decision migration", decisions);

      await db.query(AD_OPERATOR_RESPONSE_EPOCH_COMPATIBILITY_SQL);
      let operatorResponse =
        await inspectAdOperatorResponseSchemaCapability(inspectorDb);
      if (!operatorResponse.ready) {
        const partial = await hasPartialNonIdempotentNativeSchema(db, {
          tables: [
            "engine_v3_ad_recommendation_episodes",
            "engine_v3_ad_operator_action_receipts",
            "engine_v3_ad_operator_response_events",
            "engine_v3_ad_operator_responses",
          ],
          columns: [
            {
              table: "meta_ads_action_log",
              column: "decision_contract_version",
            },
            { table: "meta_ads_action_log", column: "decision_episode_key" },
            { table: "meta_ads_action_log", column: "terminal_finalized_at" },
          ],
        });
        if (partial) {
          throw new Error(
            "Refusing to apply the non-idempotent native operator-response contract over a partial schema.",
          );
        }
        await db.query(`
          DO $native_operator_dependency$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'engine_v3_ad_decision_evaluations'::regclass
                AND conname = 'engine_v3_ad_evaluations_operator_response_lineage_unique'
            ) THEN
              ALTER TABLE engine_v3_ad_decision_evaluations
                ADD CONSTRAINT engine_v3_ad_evaluations_operator_response_lineage_unique
                UNIQUE (
                  id, business_ref_id, provider_account_id,
                  decision_entity_type, decision_entity_id, ad_id, as_of_date,
                  engine_version, scope_type, scope_id, input_hash,
                  decision_hash
                );
            END IF;
          END
          $native_operator_dependency$
        `);
        await db.query(AD_OPERATOR_RESPONSE_ACTION_LOG_SCHEMA_SQL);
        await db.query(AD_OPERATOR_RESPONSE_SCHEMA_SQL);
        await db.query(AD_OPERATOR_RESPONSE_EPOCH_COMPATIBILITY_SQL);
        operatorResponse =
          await inspectAdOperatorResponseSchemaCapability(inspectorDb);
      }
      assertNativeSchemaCapability(
        "native operator-response migration",
        operatorResponse,
      );

      await db.query(`
        ALTER TABLE engine_v3_ad_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS idempotency_key TEXT
          NOT NULL DEFAULT gen_random_uuid()::text
      `);
      await db.query(`
        CREATE UNIQUE INDEX IF NOT EXISTS
          engine_v3_ad_snapshots_idempotency_key_unique
        ON engine_v3_ad_decision_snapshots_daily (idempotency_key)
      `);

      await db.query(NATIVE_AD_OUTCOME_PROVENANCE_SCHEMA_SQL);
      let outcomes =
        await inspectAdDecisionOutcomeSchemaCapability(inspectorDb);
      if (!outcomes.ready) {
        await db.query(CREATE_AD_DECISION_OUTCOMES_TABLE_SQL);
        await db.query(NATIVE_AD_OUTCOME_PROVENANCE_SCHEMA_SQL);
        outcomes = await inspectAdDecisionOutcomeSchemaCapability(inspectorDb);
      }
      assertNativeSchemaCapability("native outcome migration", outcomes);

      let controlled = await inspectControlledRegistryCapabilities();
      if (!controlled.ready) {
        await db.query(CONTROLLED_REGISTRY_SCHEMA_SQL);
        controlled = await inspectControlledRegistryCapabilities();
      }
      assertNativeSchemaCapability("controlled registry migration", controlled);
    },
    { timeoutMs },
  );
}

function createMigrationDb(sql: ReturnType<typeof getDb>) {
  let queue = Promise.resolve();

  const enqueue = <T>(operation: () => Promise<T>): Promise<T> => {
    const next = queue.then(operation, operation);
    queue = next.then(
      () => undefined,
      () => undefined,
    );
    return next;
  };

  return Object.assign(
    ((strings: TemplateStringsArray, ...values: unknown[]) =>
      enqueue(() => sql(strings, ...values))) as ReturnType<typeof getDb>,
    {
      query: ((...args: Parameters<ReturnType<typeof getDb>["query"]>) =>
        enqueue(() => sql.query(...args))) as ReturnType<typeof getDb>["query"],
    },
  );
}

async function runMigrationBatchSequentially(queries: MigrationBatchQuery[]) {
  for (const query of queries) {
    await query;
  }
}

/**
 * A group of statements whose ORDER is load-bearing.
 *
 * Every `sql\`…\`` in a batch array starts executing the moment the array
 * literal is evaluated — `getDb()` returns a function that calls the pool
 * immediately and hands back a live Promise.
 * `runMigrationBatchSequentially` awaits them in order but does not ISSUE them
 * in order. For a list of independent `CREATE TABLE IF NOT EXISTS` statements
 * that distinction never matters. For "add the column, backfill it, then make it
 * NOT NULL" it is the difference between a migration and a coin flip.
 *
 * Steps are passed as thunks so nothing runs until its turn, and each runs in
 * its own implicit transaction — which is also what `CREATE INDEX CONCURRENTLY`
 * requires.
 */
function orderedMigrationSteps(
  steps: Array<() => Promise<unknown>>,
): MigrationBatchQuery {
  return (async () => {
    for (const step of steps) {
      await step();
    }
  })();
}

/**
 * Refuse a HEAVY migration step that the host cannot afford.
 *
 * The release-gate step rewrites `provider_scope` across every row of a
 * multi-gigabyte relation and then builds three indexes concurrently. On the
 * production table that is roughly the relation's size again in new tuples,
 * plus the index builds, plus WAL — and it ran with no capacity check at all.
 * The post-migration TypeScript verification notices a full disk only after the
 * damage is done, and the cutover's `df` gate does not protect a migration
 * started any other way.
 *
 * OLD-SCHEMA SAFE by construction:
 *   - every catalog lookup goes through `to_regclass`, so a table this
 *     migration has not created yet is simply absent rather than an error;
 *   - the gate only ENGAGES when the work is actually heavy. On a fresh
 *     database the relation is empty, there is nothing to rewrite, and the
 *     step proceeds. That keeps migrations-from-zero honest instead of
 *     requiring capacity telemetry that only production has.
 *
 * When the work IS heavy the physical sample is mandatory. "No sample" is a
 * refusal, not a pass: an unmeasurable host is exactly the case where a
 * multi-gigabyte rewrite must not start.
 */
async function assertMigrationCapacityForHeavyStep(
  sql: DbClientLike,
  input: {
    label: string;
    /** Relation whose rewrite/index build this step performs. */
    relation: string;
    /** Bytes below which the step is not heavy enough to gate. */
    heavyBytes?: number;
    /** Multiple of the relation size the host must have free. */
    headroomMultiplier?: number;
  },
): Promise<{ engaged: boolean; detail: string }> {
  const heavyBytes = input.heavyBytes ?? 256 * 1024 * 1024;
  const headroomMultiplier = input.headroomMultiplier ?? 3;

  const sizeRows = (await sql.query(
    `SELECT COALESCE(pg_total_relation_size(to_regclass($1)), 0)::bigint AS relation_bytes,
            pg_database_size(current_database())::bigint AS database_bytes`,
    [input.relation],
  )) as Array<{ relation_bytes: string; database_bytes: string }>;
  const relationBytes = Number(sizeRows[0]?.relation_bytes ?? 0);
  const databaseBytes = Number(sizeRows[0]?.database_bytes ?? 0);

  if (!Number.isFinite(relationBytes) || relationBytes < heavyBytes) {
    return {
      engaged: false,
      detail: `${input.relation} is ${relationBytes}B; below the ${heavyBytes}B heavy threshold, so no capacity gate applies`,
    };
  }

  const override = process.env.ADSECUTE_MIGRATION_CAPACITY_OVERRIDE?.trim();
  const requiredBytes = relationBytes * headroomMultiplier;

  // The physical sample, read exactly the way the growth fence reads it:
  // freshest row for the healthcheck source, for THIS database, for the data
  // path — never the root filesystem.
  const sampleRows = (await sql.query(
    `SELECT s.payload,
            EXTRACT(EPOCH FROM (clock_timestamp() - s.sampled_at)) AS age_seconds
     FROM (SELECT to_regclass('system_capacity_snapshots') AS present) probe
     JOIN system_capacity_snapshots s ON probe.present IS NOT NULL
     WHERE s.source = $1
     ORDER BY s.sampled_at DESC, s.id DESC
     LIMIT 1`,
    ["db_host_healthcheck"],
  ).catch(() => [])) as Array<{ payload: unknown; age_seconds: string | number }>;

  const sample = sampleRows[0];
  const payload =
    sample && typeof sample.payload === "object" && sample.payload != null
      ? (sample.payload as Record<string, unknown>)
      : null;
  const disks = Array.isArray(payload?.disks) ? (payload!.disks as unknown[]) : [];
  const disk = disks
    .map((entry) => (typeof entry === "object" && entry != null ? (entry as Record<string, unknown>) : null))
    .find((entry) => entry && String(entry.path ?? "") === "/var/lib/postgresql");
  const availableBytes = Number(disk?.availableBytes ?? Number.NaN);
  const ageSeconds = Number(sample?.age_seconds ?? Number.NaN);

  const problem =
    sample == null
      ? "no db_host_healthcheck sample exists"
      : !Number.isFinite(ageSeconds) || ageSeconds > 900
        ? `the newest db_host_healthcheck sample is ${ageSeconds}s old`
        : !Number.isFinite(availableBytes)
          ? "the sample does not report free bytes for /var/lib/postgresql"
          : availableBytes < requiredBytes
            ? `only ${availableBytes}B free, ${requiredBytes}B required`
            : null;

  if (problem == null) {
    return {
      engaged: true,
      detail: `${input.relation} is ${relationBytes}B in a ${databaseBytes}B database; ${availableBytes}B free covers the ${requiredBytes}B required`,
    };
  }
  if (override) {
    logStartupEvent("migration_capacity_override", {
      step: input.label,
      relation: input.relation,
      relationBytes,
      requiredBytes,
      problem,
      reason: override,
    });
    return {
      engaged: true,
      detail: `capacity unproven (${problem}) but overridden: ${override}`,
    };
  }
  throw new Error(
    `migration_capacity_refused:${input.label}: ${input.relation} is ${relationBytes}B and needs ${requiredBytes}B free, but ${problem}. ` +
      `Confirm adsecute-db-healthcheck.timer is running on the database host, or set ADSECUTE_MIGRATION_CAPACITY_OVERRIDE with a reason.`,
  );
}

/**
 * Seam entrypoint for the heavy-step capacity gate.
 *
 * Exported so a real-PostgreSQL seam can exercise the refusal on a relation of
 * production-like size instead of asserting it from the migration's log line.
 */
export async function assertMigrationCapacityForHeavyStepForSeams(input: {
  label: string;
  relation: string;
  heavyBytes?: number;
  headroomMultiplier?: number;
}) {
  return assertMigrationCapacityForHeavyStep(getDb(), input);
}

/**
 * Version of the legacy-import contract. Bump only to deliberately re-open every
 * sealed import; a bump makes every deployment import again.
 */
const LEGACY_IMPORT_VERSION = 1;

/**
 * Run a legacy import exactly ONCE per database, ever.
 *
 * `ON CONFLICT ... DO NOTHING` stopped a rerun from overwriting canonical truth,
 * which was the immediate bug. It did not stop a rerun from INSERTING. The
 * legacy tables are still present and still writable, so a row that appears in
 * `provider_account_assignments` after the first import — restored from a
 * backup, written by an old code path, added by hand — hits no conflict on the
 * next deploy and creates a brand-new canonical `business_provider_accounts` row
 * with `is_selected = TRUE`. That is a deploy silently selecting an account
 * nobody selected, and it starts syncing it.
 *
 * So the import is sealed: the first successful run records a durable marker
 * with the row count it imported, and every later deploy skips the statement
 * entirely. There is no path by which a late legacy row reaches canonical state.
 */
async function runSealedLegacyImport(
  sql: DbClientLike,
  input: {
    importKey: string;
    /**
     * The import statement itself, ending in `RETURNING <col>`.
     *
     * Passed as TEXT rather than as a thunk because it is composed into the
     * same statement as the marker write — see below.
     */
    importSql: string;
  },
): Promise<"imported" | "sealed"> {
  const existing = (await sql.query(
    `SELECT import_key FROM schema_legacy_import_state
     WHERE import_key = $1 AND import_version = $2`,
    [input.importKey, LEGACY_IMPORT_VERSION],
  )) as Array<{ import_key: string }>;
  if (existing.length > 0) return "sealed";

  // The import and its seal are ONE statement.
  //
  // They used to be two autocommit statements: the import ran, then the marker
  // was written. A crash, a connection reset or a migration timeout between
  // them left the import applied and the seal missing — so the next deploy
  // re-opened the import and a legacy row that had appeared in the meantime
  // created a canonical, SELECTED account nobody selected. That is the exact
  // failure the seal exists to prevent, reachable by simply interrupting it.
  //
  // A single statement is atomic in PostgreSQL, so there is no instant at which
  // one has happened and the other has not. The data-modifying CTE also cannot
  // be skipped or reordered: the outer INSERT reads its count.
  //
  // Concurrency needs nothing extra. Two deployments racing both execute this;
  // each import's own arbiter makes the loser's rows a no-op, and the marker's
  // primary key makes the loser's seal an idempotent upsert.
  await sql.query(
    `WITH imported AS (
       ${input.importSql}
     )
     INSERT INTO schema_legacy_import_state
       (import_key, import_version, imported_row_count, completed_at)
     SELECT $1, $2, (SELECT count(*) FROM imported), now()
     ON CONFLICT (import_key) DO UPDATE SET
       import_version = EXCLUDED.import_version,
       imported_row_count = EXCLUDED.imported_row_count,
       completed_at = EXCLUDED.completed_at`,
    [input.importKey, LEGACY_IMPORT_VERSION],
  );
  return "imported";
}

type DbClientLike = {
  query: (text: string, params?: unknown[]) => Promise<unknown>;
};

/**
 * The rows that still hold a Shopify access token in the clear.
 *
 * `enc:v1:` is the prefix `lib/integration-secrets.ts` writes, and
 * `isEncryptedIntegrationSecret` is the same test in TypeScript. Expressing it
 * once, as a SQL predicate, is what lets the conversion, its remaining-work
 * count and the post-migration contract in `lib/migration-verification.ts` all
 * mean literally the same thing.
 */
const SHOPIFY_INSTALL_CONTEXT_PLAINTEXT_PREDICATE =
  "access_token IS NOT NULL AND access_token NOT LIKE 'enc:v1:%'";

export interface ShopifyInstallContextEncryptionResult {
  /** Rows this call turned from plaintext into ciphertext. */
  converted: number;
  /** Rows STILL holding a plaintext token when the call returned. */
  remaining: number;
  /** True when `maxBatches` stopped the sweep before it ran out of work. */
  interrupted: boolean;
}

/**
 * Convert every pre-existing plaintext Shopify install token to `enc:v1`.
 *
 * Rows written before the writer started encrypting hold a LIVE shop credential
 * in the clear, and they outlive the change: nothing rewrites them, and the
 * table's 30-minute expiry only removes rows that are read, not rows that sit in
 * a nightly backup that has already been taken. So the migration converts them.
 *
 * IDEMPOTENT. The predicate selects only rows whose token lacks the `enc:v1`
 * prefix, so an already-encrypted value is never a candidate and can never be
 * double-encrypted. The UPDATE is additionally a compare-and-set on the exact
 * plaintext that was read, so a row someone else converted between the SELECT
 * and the UPDATE is left alone rather than overwritten.
 *
 * CRASH-SAFE. Each row is its own autocommit statement, so an interruption
 * leaves a converted prefix and an unconverted remainder — both individually
 * valid, because reads accept either form during the transition. A re-run picks
 * up exactly the rows that are still plaintext; there is no ledger that can say
 * "already done" over work that was not finished, because the DATA is the
 * ledger.
 *
 * FAIL-CLOSED ON A MISSING KEY. The key is required only when there is actually
 * something to convert — which is what keeps `test:migrations-from-zero` and the
 * upgrade seams honest without handing them production key material — and when
 * there IS something to convert, an absent key raises
 * `IntegrationSecretKeyRequiredError` and fails the migration. The alternative,
 * skipping quietly, is the worst of the three outcomes: the plaintext stays
 * forever, every later run finds the same rows and skips them again, and the
 * deploy reports success.
 *
 * The final count is checked rather than assumed. A sweep that finished and
 * still leaves plaintext behind means something wrote a plaintext token while
 * the migration was running, and that is a refusal, not a rounding error.
 */
export async function encryptShopifyInstallContextAccessTokens(
  sql: DbClientLike,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<ShopifyInstallContextEncryptionResult> {
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 200, 1_000));
  const maxBatches = Math.max(1, options?.maxBatches ?? 100_000);

  const tablePresence = (await sql.query(
    `SELECT to_regclass('public.shopify_install_contexts') IS NOT NULL AS present`,
  )) as Array<{ present: boolean }>;
  if (!tablePresence[0]?.present) {
    return { converted: 0, remaining: 0, interrupted: false };
  }

  const countPlaintext = async () => {
    const rows = (await sql.query(
      `SELECT COUNT(*)::text AS count FROM shopify_install_contexts
       WHERE ${SHOPIFY_INSTALL_CONTEXT_PLAINTEXT_PREDICATE}`,
    )) as Array<{ count: string }>;
    return Number(rows[0]?.count ?? "0");
  };

  if ((await countPlaintext()) === 0) {
    return { converted: 0, remaining: 0, interrupted: false };
  }

  // There is plaintext to convert, so the key is mandatory. This throws.
  requireIntegrationSecretKey();

  let converted = 0;
  let batches = 0;
  let interrupted = false;
  // Keyset pagination, so the scan cannot revisit a row whose UPDATE was a
  // no-op and spin forever on it. Progress is structural rather than hoped for.
  let cursor = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    if (batches >= maxBatches) {
      interrupted = true;
      break;
    }
    const rows = (await sql.query(
      `SELECT id::text AS id, access_token
       FROM shopify_install_contexts
       WHERE ${SHOPIFY_INSTALL_CONTEXT_PLAINTEXT_PREDICATE}
         AND id > $1::uuid
       ORDER BY id ASC
       LIMIT $2`,
      [cursor, batchSize],
    )) as Array<{ id: string; access_token: string }>;
    if (rows.length === 0) break;
    batches += 1;

    for (const row of rows) {
      cursor = row.id;
      const encrypted = encryptIntegrationSecret(row.access_token);
      if (!encrypted || !isEncryptedIntegrationSecret(encrypted)) {
        throw new Error(
          "Refusing to rewrite a Shopify install context: the encrypted form is not ciphertext.",
        );
      }
      const updated = (await sql.query(
        `UPDATE shopify_install_contexts
         SET access_token = $1
         WHERE id = $2::uuid AND access_token = $3
         RETURNING 1 AS converted`,
        [encrypted, row.id, row.access_token],
      )) as Array<unknown>;
      converted += updated.length;
    }
  }

  const remaining = await countPlaintext();
  if (!interrupted && remaining > 0) {
    throw new Error(
      `Shopify install context encryption finished with ${remaining} row(s) still holding a plaintext access token.`,
    );
  }
  return { converted, remaining, interrupted };
}

/**
 * Encrypt any legacy plaintext secret still sitting in `integration_credentials`.
 *
 * The Shopify install-context sweep above was scoped to the one table that fix
 * was about. Production turned out to hold live Google OAuth REFRESH tokens in
 * plaintext in this table too — rows written before `upsertIntegration` enforced
 * encryption, which nothing has rewritten since, because a refresh token is only
 * re-persisted when the principal reconnects.
 *
 * `decryptIntegrationSecret` passes an unprefixed value through unchanged, so
 * those rows still work; they are simply readable by anyone who can read the
 * table — or a backup of it. That last part is why this belongs in THIS release:
 * the daily backup now dumps the whole database instead of a 15-table allowlist,
 * so every artifact from here on carries whatever plaintext is left behind.
 *
 * Same contract as the install-context sweep: keyset pagination so a no-op
 * UPDATE cannot spin, compare-and-set so a row someone else converted mid-sweep
 * is left alone, the key required only when there is work to do (which keeps
 * migrations-from-zero honest without key material), and a hard failure rather
 * than a silent skip if plaintext survives the pass.
 */
export async function encryptLegacyIntegrationCredentials(
  sql: DbClientLike,
  options?: { batchSize?: number; maxBatches?: number },
): Promise<ShopifyInstallContextEncryptionResult> {
  const batchSize = Math.max(1, Math.min(options?.batchSize ?? 200, 1_000));
  const maxBatches = Math.max(1, options?.maxBatches ?? 100_000);
  const COLUMNS = ["access_token", "refresh_token"] as const;

  const tablePresence = (await sql.query(
    `SELECT to_regclass('public.integration_credentials') IS NOT NULL AS present`,
  )) as Array<{ present: boolean }>;
  if (!tablePresence[0]?.present) {
    return { converted: 0, remaining: 0, interrupted: false };
  }

  const plaintextPredicate = COLUMNS.map(
    (column) => `(${column} IS NOT NULL AND ${column} NOT LIKE 'enc:v1:%')`,
  ).join(" OR ");

  const countPlaintext = async () => {
    const rows = (await sql.query(
      `SELECT COUNT(*)::text AS count FROM integration_credentials
       WHERE ${plaintextPredicate}`,
    )) as Array<{ count: string }>;
    return Number(rows[0]?.count ?? "0");
  };

  if ((await countPlaintext()) === 0) {
    return { converted: 0, remaining: 0, interrupted: false };
  }

  requireIntegrationSecretKey();

  let converted = 0;
  let batches = 0;
  let interrupted = false;
  let cursor = "00000000-0000-0000-0000-000000000000";

  for (;;) {
    if (batches >= maxBatches) {
      interrupted = true;
      break;
    }
    const rows = (await sql.query(
      `SELECT id::text AS id, access_token, refresh_token
       FROM integration_credentials
       WHERE (${plaintextPredicate}) AND id > $1::uuid
       ORDER BY id ASC
       LIMIT $2`,
      [cursor, batchSize],
    )) as Array<{
      id: string;
      access_token: string | null;
      refresh_token: string | null;
    }>;
    if (rows.length === 0) break;
    batches += 1;

    for (const row of rows) {
      cursor = row.id;
      for (const column of COLUMNS) {
        const current = row[column];
        if (!current || isEncryptedIntegrationSecret(current)) continue;
        const encrypted = encryptIntegrationSecret(current);
        if (!encrypted || !isEncryptedIntegrationSecret(encrypted)) {
          throw new Error(
            `Refusing to rewrite integration_credentials.${column}: the encrypted form is not ciphertext.`,
          );
        }
        const updated = (await sql.query(
          `UPDATE integration_credentials
             SET ${column} = $1
           WHERE id = $2::uuid AND ${column} = $3
           RETURNING 1 AS converted`,
          [encrypted, row.id, current],
        )) as Array<unknown>;
        converted += updated.length;
      }
    }
  }

  const remaining = await countPlaintext();
  if (!interrupted && remaining > 0) {
    throw new Error(
      `Integration credential encryption finished with ${remaining} row(s) still holding a plaintext secret.`,
    );
  }
  return { converted, remaining, interrupted };
}

function assertMigrationIdentifier(identifier: string) {
  if (!/^[a-zA-Z_][a-zA-Z0-9_]*$/.test(identifier)) {
    throw new Error(`Unsafe migration identifier: ${identifier}`);
  }
}

/**
 * SQL that removes a same-name index which is invalid or does not match the
 * definition we are about to create.
 *
 * `CREATE INDEX ... IF NOT EXISTS` matches on NAME ONLY. An interrupted
 * `CREATE INDEX CONCURRENTLY` leaves behind an index that exists, is named
 * correctly, and is INVALID — PostgreSQL will not use it, and IF NOT EXISTS
 * will happily skip recreating it, so the build stays broken forever while
 * every migration run reports success. The same applies to an index that was
 * created earlier with different columns or a different predicate.
 */
function buildInvalidIndexRepairQuery(input: {
  indexName: string;
  /** LIKE patterns every correct definition must contain. */
  definitionMustContain: readonly string[];
}) {
  assertMigrationIdentifier(input.indexName);
  const mismatchConditions = input.definitionMustContain
    .map(
      (fragment) =>
        `existing_definition NOT LIKE ${quoteLiteral(`%${fragment}%`)}`,
    )
    .join("\n              OR ");
  return `
    DO $repair_${input.indexName}$
    DECLARE
      existing_definition TEXT;
      existing_valid BOOLEAN;
    BEGIN
      SELECT pg_get_indexdef(index_class.oid), index_catalog.indisvalid
        INTO existing_definition, existing_valid
      FROM pg_class index_class
      JOIN pg_index index_catalog ON index_catalog.indexrelid = index_class.oid
      WHERE index_class.relname = ${quoteLiteral(input.indexName)};
      IF existing_definition IS NOT NULL AND (
        existing_valid IS NOT TRUE
        OR ${mismatchConditions}
      ) THEN
        RAISE WARNING 'dropping unusable index %: valid=% definition=%',
          ${quoteLiteral(input.indexName)}, existing_valid, existing_definition;
        -- Not CONCURRENTLY: PostgreSQL forbids it inside a function/DO block.
        -- The bounded ACCESS EXCLUSIVE this takes is on an index that is
        -- already unusable — no plan can be depending on it — and the session
        -- lock_timeout set at the start of the migration bounds the wait.
        EXECUTE 'DROP INDEX IF EXISTS ' || ${quoteLiteral(input.indexName)};
      END IF;
    END
    $repair_${input.indexName}$
  `;
}

/**
 * Proves an index exists under its declared name AND is usable.
 *
 * Deliberately unswallowed: an index this migration is responsible for creating
 * either exists valid/ready/live afterwards, or the migration has not
 * succeeded. Reporting completion with a missing index on a multi-gigabyte
 * relation is how a destructive path ends up on a sequential scan.
 */
function buildIndexContractQuery(input: {
  indexName: string;
  definitionMustContain: readonly string[];
}) {
  assertMigrationIdentifier(input.indexName);
  const checks = input.definitionMustContain
    .map(
      (fragment) => `
      IF actual_definition NOT LIKE ${quoteLiteral(`%${fragment}%`)} THEN
        RAISE EXCEPTION '% lost required definition fragment %: %',
          ${quoteLiteral(input.indexName)}, ${quoteLiteral(fragment)}, actual_definition;
      END IF;`,
    )
    .join("");
  return `
    DO $contract_${input.indexName}$
    DECLARE
      actual_definition TEXT;
    BEGIN
      SELECT pg_get_indexdef(index_class.oid)
        INTO actual_definition
      FROM pg_class index_class
      JOIN pg_index index_catalog ON index_catalog.indexrelid = index_class.oid
      WHERE index_class.relname = ${quoteLiteral(input.indexName)}
        AND index_catalog.indisvalid
        AND index_catalog.indisready
        AND index_catalog.indislive;
      IF actual_definition IS NULL THEN
        RAISE EXCEPTION '% is missing or not valid/ready/live', ${quoteLiteral(input.indexName)};
      END IF;${checks}
    END
    $contract_${input.indexName}$
  `;
}

function quoteLiteral(value: string) {
  return `'${value.replace(/'/g, "''")}'`;
}

function buildLockSafeDropColumnQuery(tableName: string, columnName: string) {
  assertMigrationIdentifier(tableName);
  assertMigrationIdentifier(columnName);
  return `
    SET lock_timeout = '${DESTRUCTIVE_COLUMN_DROP_LOCK_TIMEOUT_MS}ms';
    ALTER TABLE ${tableName}
      DROP COLUMN IF EXISTS ${columnName};
    RESET lock_timeout;
  `;
}

function isLockTimeoutError(error: unknown) {
  return (
    typeof error === "object" &&
    error != null &&
    "code" in error &&
    (error as { code?: unknown }).code === "55P03"
  );
}

function getMigrationErrorCode(error: unknown) {
  if (typeof error !== "object" || error == null || !("code" in error))
    return null;
  const code = (error as { code?: unknown }).code;
  return code == null ? null : String(code);
}

async function dropColumnIfExistsWithShortLock(
  sql: ReturnType<typeof createMigrationDb>,
  tableName: string,
  columnName: string,
) {
  try {
    await sql.query(buildLockSafeDropColumnQuery(tableName, columnName));
  } catch (error) {
    if (isLockTimeoutError(error)) {
      logStartupEvent("migration_column_drop_deferred_lock_timeout", {
        tableName,
        columnName,
        lockTimeoutMs: DESTRUCTIVE_COLUMN_DROP_LOCK_TIMEOUT_MS,
      });
      return;
    }
    logStartupEvent("migration_column_drop_deferred_error", {
      tableName,
      columnName,
      code: getMigrationErrorCode(error),
      message: error instanceof Error ? error.message : String(error ?? ""),
    });
  }
}

/**
 * Returned as SEPARATE statements, run in order, by a caller that lets failures
 * propagate — see applyMetaConfigGrowthGuard.
 *
 * This was one multi-statement string, issued from inside a concurrent batch,
 * ending in `.catch(() => {})`. On a production cutover the two config-history
 * triggers it exists to DROP were still present afterwards, and only the
 * post-migration verification noticed — by the consequence, never the cause,
 * because the cause had been discarded.
 *
 * A multi-statement string goes to PostgreSQL as one simple query, which runs it
 * in an IMPLICIT TRANSACTION: any single statement failing rolls back all of
 * them, including the drops. Issued concurrently with the `ALTER TABLE
 * meta_campaign_config_history ADD COLUMN` entries in the same batch, the
 * `DROP TRIGGER` waits on ACCESS EXCLUSIVE for a table those ALTERs are holding,
 * and a wait that reaches statement_timeout takes the whole block down with it.
 *
 * Splitting removes the all-or-nothing rollback, running it outside the batch
 * removes the contention, and not catching removes the silence. The `$$`-quoted
 * function body is one statement and stays whole.
 */
function buildMetaConfigGrowthGuardStatements(): string[] {
  return [
    `CREATE OR REPLACE FUNCTION public.skip_unchanged_meta_config_snapshot()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    DECLARE
      latest_payload jsonb;
    BEGIN
      SELECT existing.payload
      INTO latest_payload
      FROM public.meta_config_snapshots existing
      WHERE existing.business_id = NEW.business_id
        AND existing.account_id = NEW.account_id
        AND existing.entity_level = NEW.entity_level
        AND existing.entity_id = NEW.entity_id
      ORDER BY existing.captured_at DESC
      LIMIT 1;

      IF FOUND AND latest_payload IS NOT DISTINCT FROM NEW.payload THEN
        RETURN NULL;
      END IF;

      RETURN NEW;
    END;
    $$`,

    `CREATE OR REPLACE TRIGGER trg_skip_unchanged_meta_config_snapshot
    BEFORE INSERT ON public.meta_config_snapshots
    FOR EACH ROW EXECUTE FUNCTION public.skip_unchanged_meta_config_snapshot()`,

    // The two config-history triggers are DROPPED, not created.
    //
    // Each was a BEFORE INSERT read-then-insert: it read the latest fingerprint
    // for the entity and returned NULL when unchanged. With no per-entity
    // serialisation two concurrent observations both read the same "latest", so
    // an A -> B -> A sequence could lose the revert entirely — B is written and
    // the return to A is dropped as unchanged. Its ORDER BY captured_at DESC
    // had no id tie-break either, so two rows at the same instant made the
    // decision nondeterministic.
    //
    // The transition decision now lives in appendMetaCurrentConfigHistory,
    // inside one transaction that holds a per-entity advisory lock, so the read
    // and the insert are one atomic step and the inserted count is exact.
    // Leaving the trigger in place would silently discard rows that writer had
    // already decided to keep.
    `DROP TRIGGER IF EXISTS trg_skip_unchanged_meta_campaign_config_history
      ON public.meta_campaign_config_history`,
    `DROP TRIGGER IF EXISTS trg_skip_unchanged_meta_adset_config_history
      ON public.meta_adset_config_history`,
    `DROP FUNCTION IF EXISTS public.skip_unchanged_meta_campaign_config_history()`,
    `DROP FUNCTION IF EXISTS public.skip_unchanged_meta_adset_config_history()`,
  ];
}

/**
 * Runs the growth-guard statements in order and lets a failure propagate.
 *
 * The call site used to end in `.catch(() => {})`. The block it guarded is the
 * only thing that removes two triggers which now silently discard rows the
 * serialized application writer has already decided to keep — so discarding its
 * error meant the migration could report success while leaving the database in
 * exactly the state the migration exists to prevent.
 */
async function applyMetaConfigGrowthGuard(sql: DbClient) {
  for (const statement of buildMetaConfigGrowthGuardStatements()) {
    await sql.query(statement);
  }
}

function runtimeMigrationsEnabled() {
  const explicit = process.env.ENABLE_RUNTIME_MIGRATIONS?.trim().toLowerCase();
  if (explicit === "1" || explicit === "true") return true;
  if (explicit === "0" || explicit === "false") return false;
  if (process.env.NODE_ENV !== "production") return true;
  return false;
}

function getMigrationTimeoutMs() {
  const raw = process.env.MIGRATION_TIMEOUT_MS?.trim();
  if (!raw) return DEFAULT_MIGRATION_TIMEOUT_MS;
  const parsed = Number(raw);
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : DEFAULT_MIGRATION_TIMEOUT_MS;
}

function withMigrationTimeout<T>(
  promise: Promise<T>,
  timeoutMs: number,
): Promise<T> {
  return Promise.race([
    promise,
    new Promise<T>((_, reject) => {
      const timer = setTimeout(() => {
        reject(
          new Error(`Database migrations timed out after ${timeoutMs}ms.`),
        );
      }, timeoutMs);
      promise
        .finally(() => clearTimeout(timer))
        .catch(() => clearTimeout(timer));
    }),
  ]);
}

function buildGoogleAdsWarehouseTableQuery(tableName: string) {
  return `
    CREATE TABLE IF NOT EXISTS ${tableName} (
      id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
      business_id       TEXT NOT NULL,
      provider_account_id TEXT NOT NULL,
      date              DATE NOT NULL,
      account_timezone  TEXT NOT NULL DEFAULT 'UTC',
      account_currency  TEXT NOT NULL DEFAULT 'USD',
      entity_key        TEXT NOT NULL,
      entity_label      TEXT,
      campaign_id       TEXT,
      campaign_name     TEXT,
      ad_group_id       TEXT,
      ad_group_name     TEXT,
      status            TEXT,
      channel           TEXT,
      classification    TEXT,
      payload_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
      spend             NUMERIC(18, 4) NOT NULL DEFAULT 0,
      revenue           NUMERIC(18, 4) NOT NULL DEFAULT 0,
      conversions       NUMERIC(18, 4) NOT NULL DEFAULT 0,
      impressions       BIGINT NOT NULL DEFAULT 0,
      clicks            BIGINT NOT NULL DEFAULT 0,
      ctr               NUMERIC(18, 4),
      cpc               NUMERIC(18, 4),
      cpa               NUMERIC(18, 4),
      roas              NUMERIC(18, 4) NOT NULL DEFAULT 0,
      conversion_rate   NUMERIC(18, 4),
      interaction_rate  NUMERIC(18, 4),
      source_snapshot_id UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
      created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
      UNIQUE (business_id, provider_account_id, date, entity_key)
    )
  `;
}

function buildGoogleAdsWarehouseIndexQueries(tableName: string) {
  return [
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_date ON ${tableName} (business_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_account_date ON ${tableName} (provider_account_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_account_date ON ${tableName} (business_id, provider_account_id, date DESC)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_date_entity ON ${tableName} (business_id, date DESC, entity_key)`,
    `CREATE INDEX IF NOT EXISTS idx_${tableName}_campaign_date ON ${tableName} (campaign_id, date DESC)`,
  ];
}

function legacyCoreCompatTablesEnabled() {
  return process.env.DB_ENABLE_LEGACY_CORE_COMPAT_TABLES?.trim() === "1";
}

function legacyCoreTableDropEnabled() {
  return process.env.DB_DROP_LEGACY_CORE_TABLES?.trim() === "1";
}

async function doesTableExist(
  sql: ReturnType<typeof createMigrationDb>,
  tableName: string,
): Promise<boolean> {
  const rows = (await sql.query<{ exists: boolean }>(
    "SELECT to_regclass($1) IS NOT NULL AS exists",
    [`public.${tableName}`],
  )) as Array<{ exists?: boolean }>;
  return rows[0]?.exists === true;
}

async function doesTableHaveRows(
  sql: ReturnType<typeof createMigrationDb>,
  tableName: string,
): Promise<boolean> {
  assertMigrationIdentifier(tableName);
  const rows = (await sql.query<{ exists: boolean }>(
    `SELECT EXISTS (SELECT 1 FROM ${tableName} LIMIT 1) AS exists`,
  )) as Array<{ exists?: boolean }>;
  return rows[0]?.exists === true;
}

async function doesProviderAccountSeedExist(
  sql: ReturnType<typeof createMigrationDb>,
  provider: "google" | "meta" | "shopify",
): Promise<boolean> {
  const rows = (await sql.query<{ exists: boolean }>(
    "SELECT EXISTS (SELECT 1 FROM provider_accounts WHERE provider = $1 LIMIT 1) AS exists",
    [provider],
  )) as Array<{ exists?: boolean }>;
  return rows[0]?.exists === true;
}

function buildProviderAccountSeedUnionQuery(
  tableNames: readonly string[],
  columnName: string,
) {
  return tableNames
    .map(
      (tableName) => `
        SELECT NULLIF(TRIM(${columnName}), '') AS external_account_id
        FROM ${tableName}
        WHERE ${columnName} IS NOT NULL
      `,
    )
    .join("\nUNION\n");
}

const META_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_account_daily",
  "meta_campaign_daily",
  "meta_adset_daily",
  "meta_breakdown_daily",
  "meta_ad_daily",
  "meta_creative_daily",
  "meta_creative_media",
  "meta_campaign_dimensions",
  "meta_campaign_config_history",
  "meta_adset_dimensions",
  "meta_adset_config_history",
  "meta_ad_dimensions",
  "meta_creative_dimensions",
  "meta_decision_action_outcome_logs",
] as const;

const GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES = [
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
  "google_ads_campaign_dimensions",
  "google_ads_campaign_state_history",
  "google_ads_ad_group_dimensions",
  "google_ads_ad_group_state_history",
  "google_ads_ad_dimensions",
  "google_ads_keyword_dimensions",
  "google_ads_asset_group_dimensions",
  "google_ads_product_dimensions",
] as const;

const SHOPIFY_CANONICAL_PROVIDER_REF_TABLES = [
  "shopify_raw_snapshots",
  "shopify_entity_payload_archives",
  "shopify_shop_dimensions",
  "shopify_customer_dimensions",
  "shopify_product_dimensions",
  "shopify_variant_dimensions",
  "shopify_orders",
  "shopify_order_lines",
  "shopify_refunds",
  "shopify_order_transactions",
  "shopify_returns",
  "shopify_customer_events",
  "shopify_sales_events",
  "shopify_serving_overrides",
  "shopify_webhook_deliveries",
  "shopify_repair_intents",
  "shopify_reconciliation_runs",
  "shopify_serving_state",
  "shopify_serving_state_history",
] as const;

const META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_creative_score_snapshots",
  "meta_authoritative_source_manifests",
  "meta_authoritative_slice_versions",
  "meta_authoritative_publication_pointers",
  "meta_authoritative_reconciliation_events",
  "meta_authoritative_day_state",
] as const;

const META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_config_snapshots",
] as const;

const GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES = [
  "google_ads_search_query_hot_daily",
  "google_ads_top_query_weekly",
  "google_ads_search_cluster_daily",
  "google_ads_decision_action_outcome_logs",
] as const;

const GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES = [
  "google_ads_advisor_memory",
  "google_ads_advisor_execution_logs",
  "google_ads_advisor_snapshots",
] as const;

const META_CONTROL_CANONICAL_PROVIDER_REF_TABLES = [
  "meta_sync_jobs",
  "meta_sync_partitions",
  "meta_sync_runs",
  "meta_sync_checkpoints",
  "meta_sync_phase_timings",
  "meta_sync_state",
  "meta_raw_snapshots",
] as const;

const GOOGLE_ADS_CONTROL_CANONICAL_PROVIDER_REF_TABLES = [
  "google_ads_sync_jobs",
  "google_ads_sync_partitions",
  "google_ads_sync_runs",
  "google_ads_sync_checkpoints",
  "google_ads_sync_state",
  "google_ads_raw_snapshots",
] as const;

const SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES = [
  "shopify_sync_state",
] as const;

const META_PROVIDER_ACCOUNT_SEED_TABLES = [
  ...META_CANONICAL_PROVIDER_REF_TABLES,
  ...META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES,
  ...META_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
] as const;

const GOOGLE_PROVIDER_ACCOUNT_SEED_TABLES = [
  ...GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
] as const;

const SHOPIFY_PROVIDER_ACCOUNT_SEED_TABLES = [
  ...SHOPIFY_CANONICAL_PROVIDER_REF_TABLES,
  ...SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
] as const;

const GENERIC_CANONICAL_PROVIDER_REF_TABLES = [
  "provider_account_rollover_state",
] as const;

const BUSINESS_ONLY_CANONICAL_REF_TABLES = [
  "ai_daily_insights",
  "business_cost_models",
  "provider_connections",
  "business_provider_accounts",
  "provider_account_snapshot_runs",
  "business_target_packs",
  "business_country_economics",
  "business_promo_calendar_events",
  "business_operating_constraints",
  "business_decision_calibration_profiles",
  "command_center_mutation_receipts",
  "command_center_saved_views",
  "command_center_handoffs",
  "command_center_feedback",
  "command_center_action_journal",
  "command_center_action_state",
  "command_center_action_execution_state",
  "command_center_action_execution_audit",
  "custom_reports",
  "discount_redemptions",
  "meta_creatives_snapshots",
  "seo_ai_monthly_analyses",
  "seo_results_cache",
  "provider_cooldown_state",
  "provider_sync_jobs",
  "provider_quota_usage",
  "provider_request_audit_daily",
  "sync_runner_leases",
  "google_ads_runner_leases",
] as const;

const CANONICAL_PROVIDER_REF_TABLES = [
  ...META_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES,
  ...META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES,
  ...META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES,
  ...META_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
  ...GOOGLE_ADS_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
  ...SHOPIFY_CANONICAL_PROVIDER_REF_TABLES,
  ...SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES,
  ...GENERIC_CANONICAL_PROVIDER_REF_TABLES,
  "platform_overview_daily_summary",
] as const;

const CANONICAL_BUSINESS_REF_TABLES = [
  ...CANONICAL_PROVIDER_REF_TABLES,
  ...BUSINESS_ONLY_CANONICAL_REF_TABLES,
  "provider_reporting_snapshots",
  "platform_overview_summary_ranges",
] as const;

export async function runMigrations(options?: {
  force?: boolean;
  reason?: string;
  timeoutMs?: number;
  verifyNativeSchemaCapabilities?: boolean;
}) {
  const force = options?.force ?? false;
  const reason = options?.reason ?? "unspecified";

  if (!force && !runtimeMigrationsEnabled()) {
    if (!loggedMigrationSkip) {
      loggedMigrationSkip = true;
      logStartupEvent("migrations_skipped_runtime_disabled", {
        reason,
        nodeEnv: process.env.NODE_ENV,
      });
    }
    return;
  }

  if (migrationsCompleted) return;
  if (migrationsPromise) {
    await migrationsPromise;
    return;
  }

  const timeoutMs = options?.timeoutMs ?? getMigrationTimeoutMs();
  logStartupEvent("migrations_started", { reason, force, timeoutMs });

  migrationsPromise = withMigrationTimeout(
    (async () => {
      const sql = createMigrationDb(
        options?.timeoutMs != null
          ? getDbWithTimeout(options.timeoutMs)
          : getDb(),
      );

      // Bounded lock waiting, and a record of what the session actually used.
      // A DDL statement that blocks behind a long-running reader would
      // otherwise queue every subsequent request behind it — the classic
      // migration-takes-the-site-down shape — with nothing in the logs to say
      // which statement was waiting.
      const lockTimeoutMs = Math.max(
        1_000,
        Number(process.env.MIGRATION_LOCK_TIMEOUT_MS ?? 15_000),
      );
      await sql
        .query(`SET lock_timeout = ${Math.floor(lockTimeoutMs)}`)
        .catch(() => undefined);
      const migrationSessionSettings = (await sql
        .query(
          `SELECT current_setting('lock_timeout') AS lock_timeout,
                  current_setting('statement_timeout') AS statement_timeout,
                  current_setting('idle_in_transaction_session_timeout') AS idle_timeout`,
        )
        .catch(() => [])) as Array<Record<string, string>>;
      // Preflight: report the headroom this migration is about to consume from,
      // so a failure has the numbers next to it. These are OBSERVATIONS, not a
      // gate — the app cannot see the database host's filesystem, and claiming
      // otherwise is what conflates a logical budget with disk telemetry.
      const preflight = (await sql
        .query(
          `SELECT pg_database_size(current_database())::text AS database_bytes,
                  pg_size_pretty(pg_database_size(current_database())) AS database_pretty,
                  (SELECT COALESCE(SUM(size), 0)::text FROM pg_ls_waldir()) AS wal_bytes,
                  COALESCE(current_setting('temp_file_limit', true), 'unset') AS temp_file_limit,
                  -- to_regclass, because a from-zero database has none of the
                  -- relations this migration is about to create.
                  COALESCE(
                    pg_size_pretty(
                      pg_total_relation_size(to_regclass('public.meta_raw_snapshots'))
                    ),
                    'absent'
                  ) AS meta_raw_snapshots_size,
                  COALESCE(
                    pg_size_pretty(
                      pg_total_relation_size(to_regclass('public.shopify_raw_snapshots'))
                    ),
                    'absent'
                  ) AS shopify_raw_snapshots_size`,
        )
        .catch((error) => [
          { preflight_error: error instanceof Error ? error.message : String(error) },
        ])) as Array<Record<string, string>>;
      logStartupEvent("migrations_preflight", {
        reason,
        session: migrationSessionSettings[0] ?? null,
        capacity: preflight[0] ?? null,
      });

      await sql.query(`CREATE EXTENSION IF NOT EXISTS pgcrypto`);
      const legacyCompatEnabled =
        legacyCoreCompatTablesEnabled() && !legacyCoreTableDropEnabled();
      const legacyCoreDropEnabled = legacyCoreTableDropEnabled();
      const [
        legacyIntegrationsExists,
        legacyAssignmentsExists,
        legacySnapshotsExists,
      ] = await Promise.all([
        doesTableExist(sql, "integrations"),
        doesTableExist(sql, "provider_account_assignments"),
        doesTableExist(sql, "provider_account_snapshots"),
      ]);
      const legacyIntegrationsAvailable =
        legacyCompatEnabled || legacyIntegrationsExists;
      const legacyAssignmentsAvailable =
        legacyCompatEnabled || legacyAssignmentsExists;
      const legacySnapshotsAvailable =
        legacyCompatEnabled || legacySnapshotsExists;

      // ── PHASE 1: Tables with no FK dependencies (ordered batch) ───────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS users (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name          TEXT NOT NULL,
          email         TEXT NOT NULL UNIQUE,
          password_hash TEXT NOT NULL,
          avatar        TEXT,
          language      TEXT NOT NULL DEFAULT 'en',
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        ...(legacyCompatEnabled
          ? [
              sql`CREATE TABLE IF NOT EXISTS integrations (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id           TEXT NOT NULL,
          provider              TEXT NOT NULL,
          status                TEXT NOT NULL DEFAULT 'disconnected',
          provider_account_id   TEXT,
          provider_account_name TEXT,
          access_token          TEXT,
          refresh_token         TEXT,
          token_expires_at      TIMESTAMPTZ,
          scopes                TEXT,
          error_message         TEXT,
          connected_at          TIMESTAMPTZ,
          disconnected_at       TIMESTAMPTZ,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
            ]
          : []),
        ...(legacyCompatEnabled
          ? [
              sql`CREATE TABLE IF NOT EXISTS provider_account_assignments (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider    TEXT NOT NULL,
          account_ids TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
            ]
          : []),
        ...(legacyCompatEnabled
          ? [
              sql`CREATE TABLE IF NOT EXISTS provider_account_snapshots (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id      TEXT NOT NULL,
          provider         TEXT NOT NULL,
          accounts_payload JSONB NOT NULL DEFAULT '[]'::jsonb,
          fetched_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          refresh_failed   BOOLEAN NOT NULL DEFAULT FALSE,
          last_error       TEXT,
          refresh_requested_at TIMESTAMPTZ,
          last_refresh_attempt_at TIMESTAMPTZ,
          next_refresh_after TIMESTAMPTZ,
          refresh_in_progress BOOLEAN NOT NULL DEFAULT FALSE,
          accounts_hash     TEXT,
          source_reason     TEXT,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
            ]
          : []),
        sql`CREATE TABLE IF NOT EXISTS provider_accounts (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider            TEXT NOT NULL,
          external_account_id TEXT NOT NULL,
          account_name        TEXT,
          currency            TEXT,
          timezone            TEXT,
          is_manager          BOOLEAN,
          metadata            JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider, external_account_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_connections (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id            TEXT NOT NULL,
          provider               TEXT NOT NULL,
          status                 TEXT NOT NULL DEFAULT 'disconnected',
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_account_id    TEXT,
          provider_account_name  TEXT,
          connected_at           TIMESTAMPTZ,
          disconnected_at        TIMESTAMPTZ,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider)
        )`,
        sql`CREATE TABLE IF NOT EXISTS integration_credentials (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider_connection_id UUID NOT NULL REFERENCES provider_connections(id) ON DELETE CASCADE,
          access_token          TEXT,
          refresh_token         TEXT,
          token_expires_at      TIMESTAMPTZ,
          scopes                TEXT,
          error_message         TEXT,
          metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider_connection_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_provider_accounts (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id            TEXT NOT NULL,
          provider               TEXT NOT NULL,
          provider_account_ref_id UUID NOT NULL REFERENCES provider_accounts(id) ON DELETE CASCADE,
          provider_account_id    TEXT NOT NULL,
          position               INTEGER NOT NULL DEFAULT 0,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider, provider_account_ref_id)
        )`,
        // ── Selection contract (additive, ordered) ─────────────────────────
        //
        // business_provider_accounts is BOTH the immutable historical identity
        // binding and the source of the current account selection. Those two
        // roles are split by is_selected: a row is created once and never
        // deleted when the user deselects an account, only marked unselected.
        // Deleting it would break the many inbound references that treat a
        // binding as historical identity.
        //
        // Cutover ordering matters and is deliberate:
        //   1. ADD COLUMN ... NOT NULL DEFAULT TRUE. Every legacy row DID
        //      represent the current selection, so they must be admitted as
        //      selected. Crucially this also covers concurrent inserts from
        //      still-running old code during the cutover, which would otherwise
        //      be silently born deselected and would drop accounts out of sync.
        //      On PG11+ this is metadata-only: no heap rewrite.
        //   2. Prove the column exists with the exact type and NOT NULL.
        //   3. Only THEN switch the default to FALSE, so from here on any
        //      insert that forgets the column fails closed to unselected and
        //      only the assignment writer may declare an account selected.
        sql`ALTER TABLE business_provider_accounts
          ADD COLUMN IF NOT EXISTS is_selected BOOLEAN NOT NULL DEFAULT TRUE`.catch(
          () => {},
        ),
        sql`
          DO $business_provider_accounts_selection_contract$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'business_provider_accounts'
                AND column_name = 'is_selected'
                AND data_type = 'boolean'
                AND is_nullable = 'NO'
            ) THEN
              RAISE EXCEPTION
                'business_provider_accounts.is_selected must exist as BOOLEAN NOT NULL';
            END IF;
          END
          $business_provider_accounts_selection_contract$
        `,
        sql`ALTER TABLE business_provider_accounts
          ALTER COLUMN is_selected SET DEFAULT FALSE`.catch(() => {}),
        sql`
          DO $business_provider_accounts_selection_default$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM information_schema.columns
              WHERE table_schema = current_schema()
                AND table_name = 'business_provider_accounts'
                AND column_name = 'is_selected'
                AND column_default = 'false'
            ) THEN
              RAISE EXCEPTION
                'business_provider_accounts.is_selected must default to FALSE after cutover';
            END IF;
          END
          $business_provider_accounts_selection_default$
        `,
        // Current-selection lookups always filter is_selected, so the index is
        // partial on exactly that predicate. IF NOT EXISTS matches on NAME
        // alone, so a same-name index with a different definition — including
        // an invalid one left by an interrupted CONCURRENTLY build — would be
        // silently accepted. Drop that case first, then verify the definition
        // rather than swallowing the failure.
        orderedMigrationSteps([
          () =>
            sql`
          DO $business_provider_accounts_selected_index_repair$
          DECLARE
            existing_definition TEXT;
            existing_valid BOOLEAN;
          BEGIN
            SELECT pg_get_indexdef(index_class.oid), index_catalog.indisvalid
              INTO existing_definition, existing_valid
            FROM pg_class index_class
            JOIN pg_index index_catalog ON index_catalog.indexrelid = index_class.oid
            WHERE index_class.relname = 'idx_business_provider_accounts_selected';
            IF existing_definition IS NOT NULL AND (
              existing_valid IS NOT TRUE
              OR existing_definition NOT LIKE '%business_id, provider, "position", id%'
              OR existing_definition NOT LIKE '%WHERE is_selected%'
            ) THEN
              EXECUTE 'DROP INDEX idx_business_provider_accounts_selected';
            END IF;
          END
          $business_provider_accounts_selected_index_repair$
        `,
          () =>
            sql`CREATE INDEX IF NOT EXISTS idx_business_provider_accounts_selected
          ON business_provider_accounts (business_id, provider, position, id)
          WHERE is_selected`,
          // Asserted key-for-key, not "has a predicate".
          //
          // `(id) WHERE is_selected` is a perfectly valid partial index that
          // passes a `LIKE '%WHERE is_selected%'` check and cannot serve the
          // ordered current-selection read at all — the selection path then
          // sorts every selected row of every business on every request. Access
          // method matters for the same reason: a hash index on the same columns
          // has no ordering.
          () =>
            sql`
          DO $business_provider_accounts_selected_index_contract$
          DECLARE
            actual_definition TEXT;
            actual_method TEXT;
          BEGIN
            SELECT pg_get_indexdef(index_class.oid), access_method.amname
              INTO actual_definition, actual_method
            FROM pg_class index_class
            JOIN pg_index index_catalog ON index_catalog.indexrelid = index_class.oid
            JOIN pg_am access_method ON access_method.oid = index_class.relam
            WHERE index_class.relname = 'idx_business_provider_accounts_selected'
              AND index_catalog.indisunique = FALSE
              AND index_catalog.indisvalid
              AND index_catalog.indisready
              AND index_catalog.indislive
              AND index_catalog.indnkeyatts = 4;
            IF actual_definition IS NULL THEN
              RAISE EXCEPTION
                'idx_business_provider_accounts_selected is missing, unique, not valid/ready/live, or does not have exactly 4 key columns';
            END IF;
            IF actual_method <> 'btree' THEN
              RAISE EXCEPTION
                'idx_business_provider_accounts_selected uses access method %, expected btree',
                actual_method;
            END IF;
            IF actual_definition NOT LIKE '%(business_id, provider, "position", id)%' THEN
              RAISE EXCEPTION
                'idx_business_provider_accounts_selected does not key exactly (business_id, provider, position, id): %',
                actual_definition;
            END IF;
            IF actual_definition NOT LIKE '%WHERE is_selected' THEN
              RAISE EXCEPTION
                'idx_business_provider_accounts_selected lost its is_selected predicate: %',
                actual_definition;
            END IF;
          END
          $business_provider_accounts_selected_index_contract$
        `,
        ]),
        sql`CREATE TABLE IF NOT EXISTS provider_account_snapshot_runs (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id              TEXT NOT NULL,
          provider                 TEXT NOT NULL,
          fetched_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          refresh_failed           BOOLEAN NOT NULL DEFAULT FALSE,
          last_error               TEXT,
          refresh_requested_at     TIMESTAMPTZ,
          last_refresh_attempt_at  TIMESTAMPTZ,
          next_refresh_after       TIMESTAMPTZ,
          refresh_in_progress      BOOLEAN NOT NULL DEFAULT FALSE,
          accounts_hash            TEXT,
          source_reason            TEXT,
          last_successful_refresh_at TIMESTAMPTZ,
          refresh_failure_streak   INTEGER NOT NULL DEFAULT 0,
          connection_fingerprint   TEXT,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider)
        )`,
        // Which connection generation produced the snapshot. Nullable on
        // purpose: rows written before this column exists carry NULL, and
        // selection treats NULL as "not bound to the current credential" and
        // therefore refuses — the fail-closed direction. Not swallowed, because
        // selection authority depends on the column existing.
        sql`ALTER TABLE provider_account_snapshot_runs
          ADD COLUMN IF NOT EXISTS connection_fingerprint TEXT`,
        sql`CREATE TABLE IF NOT EXISTS provider_account_snapshot_items (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_run_id        UUID NOT NULL REFERENCES provider_account_snapshot_runs(id) ON DELETE CASCADE,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_account_id    TEXT NOT NULL,
          provider_account_name  TEXT NOT NULL,
          currency               TEXT,
          timezone               TEXT,
          is_manager             BOOLEAN,
          position               INTEGER NOT NULL DEFAULT 0,
          raw_payload            JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (snapshot_run_id, provider_account_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_account_rollover_state (
          provider                 TEXT NOT NULL,
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT NOT NULL,
          last_observed_current_date DATE NOT NULL,
          current_d1_target_date   DATE NOT NULL,
          rollover_detected_at     TIMESTAMPTZ,
          d1_finalize_started_at   TIMESTAMPTZ,
          d1_finalize_completed_at TIMESTAMPTZ,
          last_recovery_at         TIMESTAMPTZ,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (provider, business_id, provider_account_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS provider_reporting_snapshots (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          provider       TEXT NOT NULL,
          report_type    TEXT NOT NULL,
          date_range_key TEXT NOT NULL,
          payload        JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS system_capacity_snapshots (
          id         BIGSERIAL PRIMARY KEY,
          source     TEXT NOT NULL,
          hostname   TEXT,
          payload    JSONB NOT NULL DEFAULT '{}'::jsonb,
          sampled_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS meta_config_snapshots (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id   TEXT NOT NULL,
          account_id    TEXT NOT NULL,
          entity_level  TEXT NOT NULL CHECK (entity_level IN ('campaign', 'adset')),
          entity_id     TEXT NOT NULL,
          payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          snapshot_date DATE NOT NULL DEFAULT CURRENT_DATE,
          captured_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS creative_decision_os_snapshots (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          surface                   TEXT NOT NULL DEFAULT 'creative',
          business_id               TEXT NOT NULL,
          analysis_scope            TEXT NOT NULL CHECK (analysis_scope IN ('account', 'campaign')),
          analysis_scope_id         TEXT,
          analysis_scope_label      TEXT NOT NULL,
          benchmark_scope           TEXT NOT NULL CHECK (benchmark_scope IN ('account', 'campaign')),
          benchmark_scope_id        TEXT,
          benchmark_scope_label     TEXT NOT NULL,
          decision_as_of            DATE,
          generated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          generated_by              TEXT,
          source_window             JSONB NOT NULL DEFAULT '{}'::jsonb,
          operator_decision_version TEXT,
          policy_version            TEXT,
          instruction_version       TEXT,
          input_hash                TEXT,
          evidence_hash             TEXT,
          summary_counts            JSONB NOT NULL DEFAULT '{}'::jsonb,
          status                    TEXT NOT NULL DEFAULT 'ready' CHECK (status IN ('ready', 'error')),
          error_json                JSONB,
          payload                   JSONB,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_provider_account_rollover_state_business
          ON provider_account_rollover_state (business_id, provider, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_account_rollover_state_target
          ON provider_account_rollover_state (provider, current_d1_target_date DESC, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS custom_reports (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          name        TEXT NOT NULL,
          description TEXT,
          template_id TEXT,
          definition  JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS custom_report_share_snapshots (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token      TEXT NOT NULL UNIQUE,
          report_id  TEXT,
          payload    JSONB NOT NULL,
          expires_at TIMESTAMPTZ NOT NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS creative_media_cache (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          creative_id     TEXT NOT NULL,
          business_id     TEXT NOT NULL,
          provider        TEXT NOT NULL DEFAULT 'meta',
          source_url      TEXT NOT NULL,
          storage_key     TEXT UNIQUE,
          content_type    TEXT,
          file_size_bytes INTEGER,
          status          TEXT NOT NULL DEFAULT 'pending'
                          CHECK (status IN ('pending', 'downloading', 'cached', 'failed')),
          error_message   TEXT,
          retry_count     INTEGER NOT NULL DEFAULT 0,
          cached_at       TIMESTAMPTZ,
          expires_at      TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS meta_creatives_snapshots (
          id                     UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_key           TEXT NOT NULL UNIQUE,
          business_id            TEXT NOT NULL,
          assigned_accounts_hash TEXT NOT NULL,
          start_date             DATE NOT NULL,
          end_date               DATE NOT NULL,
          group_by               TEXT NOT NULL,
          format                 TEXT NOT NULL,
          sort                   TEXT NOT NULL,
          payload                JSONB NOT NULL,
          snapshot_level         TEXT NOT NULL CHECK (snapshot_level IN ('metadata', 'full')),
          row_count              INTEGER NOT NULL DEFAULT 0,
          preview_ready_count    INTEGER NOT NULL DEFAULT 0,
          last_synced_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          refresh_started_at     TIMESTAMPTZ,
          created_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at             TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS shopify_subscriptions (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          shop_id       TEXT NOT NULL UNIQUE,
          plan_id       TEXT NOT NULL,
          status        TEXT NOT NULL,
          billing_cycle TEXT NOT NULL,
          created_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS ai_daily_insights (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id     TEXT NOT NULL,
          insight_date    DATE NOT NULL,
          locale          TEXT NOT NULL DEFAULT 'en',
          summary         TEXT NOT NULL DEFAULT '',
          risks           JSONB NOT NULL DEFAULT '[]'::jsonb,
          opportunities   JSONB NOT NULL DEFAULT '[]'::jsonb,
          recommendations JSONB NOT NULL DEFAULT '[]'::jsonb,
          raw_response    JSONB,
          status          TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed')),
          error_message   TEXT,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS ai_creative_decisions_cache (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          analysis_key   TEXT NOT NULL,
          locale         TEXT NOT NULL DEFAULT 'en',
          currency       TEXT NOT NULL DEFAULT 'USD',
          creative_count INTEGER NOT NULL DEFAULT 0,
          decisions      JSONB NOT NULL DEFAULT '[]'::jsonb,
          source         TEXT NOT NULL DEFAULT 'deterministic' CHECK (source IN ('deterministic', 'fallback')),
          warning        TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS seo_ai_monthly_analyses (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          analysis_month DATE NOT NULL,
          period_start   DATE NOT NULL,
          period_end     DATE NOT NULL,
          analysis       JSONB,
          raw_response   JSONB,
          status         TEXT NOT NULL DEFAULT 'success' CHECK (status IN ('success', 'failed')),
          error_message  TEXT,
          created_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at     TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_memory (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          account_id                 TEXT NOT NULL,
          recommendation_fingerprint TEXT NOT NULL,
          recommendation_type        TEXT NOT NULL,
          entity_id                  TEXT,
          first_seen_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          prior_status               TEXT,
          current_status             TEXT NOT NULL DEFAULT 'new',
          seen_count                 INTEGER NOT NULL DEFAULT 1,
          last_do_bucket             TEXT NOT NULL DEFAULT 'do_later',
          user_action                TEXT,
          dismiss_reason             TEXT,
          suppress_until             TIMESTAMPTZ,
          applied_at                 TIMESTAMPTZ,
          outcome_check_at           TIMESTAMPTZ,
          outcome_check_window_days  INTEGER,
          outcome_verdict            TEXT,
          outcome_metric             TEXT,
          outcome_delta              NUMERIC(18, 4),
          outcome_verdict_fail_reason TEXT,
          outcome_confidence         TEXT,
          execution_status           TEXT,
          executed_at                TIMESTAMPTZ,
          execution_error            TEXT,
          rollback_available         BOOLEAN,
          rollback_executed_at       TIMESTAMPTZ,
          completion_mode            TEXT,
          completed_step_count       INTEGER,
          total_step_count           INTEGER,
          completed_step_ids         JSONB,
          skipped_step_ids           JSONB,
          core_step_ids              JSONB,
          execution_metadata         JSONB,
          applied_snapshot           JSONB,
          recommendation_snapshot    JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, account_id, recommendation_fingerprint)
        )`,
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_execution_logs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          account_id                 TEXT NOT NULL,
          recommendation_fingerprint TEXT NOT NULL,
          mutate_action_type         TEXT NOT NULL,
          operation                  TEXT NOT NULL,
          status                     TEXT NOT NULL,
          payload_json               JSONB,
          response_json              JSONB,
          error_message              TEXT,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_snapshots (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id           TEXT NOT NULL,
          account_id            TEXT,
          analysis_version      TEXT NOT NULL DEFAULT 'v1',
          analysis_mode         TEXT NOT NULL DEFAULT 'snapshot',
          as_of_date            DATE NOT NULL,
          selected_window_key   TEXT NOT NULL DEFAULT 'last90',
          advisor_payload       JSONB NOT NULL DEFAULT '{}'::jsonb,
          historical_support_json JSONB,
          source_max_updated_at TIMESTAMPTZ,
          status                TEXT NOT NULL DEFAULT 'success',
          error_message         TEXT,
          generated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, account_id, as_of_date, analysis_version)
        )`,
      ]);

      // ── PHASE 2: businesses (deps: users) + alter phase-1 tables ──────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS businesses (
          id               UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          name             TEXT NOT NULL,
          owner_id         UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          timezone         TEXT,
          timezone_source  TEXT,
          currency         TEXT NOT NULL DEFAULT 'USD',
          is_demo_business BOOLEAN NOT NULL DEFAULT FALSE,
          industry         TEXT,
          platform         TEXT,
          metadata         JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS creative_share_snapshots (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token       TEXT NOT NULL UNIQUE,
          payload     JSONB NOT NULL,
          expires_at  TIMESTAMPTZ NOT NULL,
          business_id UUID REFERENCES businesses(id) ON DELETE CASCADE,
          provider_account_id TEXT,
          created_by  UUID REFERENCES users(id) ON DELETE SET NULL,
          revoked_at  TIMESTAMPTZ,
          revoked_by  UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS google_id TEXT`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS facebook_id TEXT`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS auth_provider TEXT NOT NULL DEFAULT 'password'`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS language TEXT NOT NULL DEFAULT 'en'`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS is_superadmin BOOLEAN NOT NULL DEFAULT false`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS suspended_at TIMESTAMPTZ`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS last_login_at TIMESTAMPTZ`,
        sql`ALTER TABLE users ADD COLUMN IF NOT EXISTS plan_override TEXT`,
        sql`ALTER TABLE businesses ALTER COLUMN timezone DROP NOT NULL`.catch(
          () => {},
        ),
        sql`ALTER TABLE businesses ALTER COLUMN timezone DROP DEFAULT`.catch(
          () => {},
        ),
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS timezone_source TEXT`.catch(
          () => {},
        ),
        ...(legacyIntegrationsAvailable
          ? [
              sql`ALTER TABLE integrations ADD COLUMN IF NOT EXISTS metadata JSONB DEFAULT '{}'::jsonb`,
              sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_integrations_biz_provider ON integrations (business_id, provider)`.catch(
                () => {},
              ),
              sql`CREATE INDEX IF NOT EXISTS idx_integrations_business_id ON integrations (business_id)`.catch(
                () => {},
              ),
            ]
          : []),
        ...(legacyAssignmentsAvailable
          ? [
              sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_assignments_biz_provider ON provider_account_assignments (business_id, provider)`.catch(
                () => {},
              ),
            ]
          : []),
        ...(legacySnapshotsAvailable
          ? [
              sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_snapshots_biz_provider ON provider_account_snapshots (business_id, provider)`.catch(
                () => {},
              ),
              sql`CREATE INDEX IF NOT EXISTS idx_provider_account_snapshots_business ON provider_account_snapshots (business_id)`.catch(
                () => {},
              ),
              sql`CREATE INDEX IF NOT EXISTS idx_provider_account_snapshots_next_refresh ON provider_account_snapshots (next_refresh_after)`.catch(
                () => {},
              ),
            ]
          : []),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_provider_external ON provider_accounts (provider, external_account_id)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_connections_business_provider ON provider_connections (business_id, provider)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_integration_credentials_connection ON integration_credentials (provider_connection_id)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_business_provider_accounts_business_provider_account ON business_provider_accounts (business_id, provider, provider_account_ref_id)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_snapshot_runs_business_provider ON provider_account_snapshot_runs (business_id, provider)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_account_snapshot_items_run_account ON provider_account_snapshot_items (snapshot_run_id, provider_account_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_provider_accounts_business_provider ON business_provider_accounts (business_id, provider, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_account_snapshot_items_run_position ON provider_account_snapshot_items (snapshot_run_id, position ASC)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_reporting_snapshots_lookup ON provider_reporting_snapshots (business_id, provider, report_type, date_range_key)`.catch(
          () => {},
        ),
        sql`
          UPDATE businesses AS business
          SET
            timezone = derived.timezone,
            timezone_source = derived.timezone_source
          FROM (
            SELECT
              b.id AS business_id,
              CASE
                WHEN NULLIF(shopify.metadata->>'iana_timezone', '') IS NOT NULL
                  THEN shopify.metadata->>'iana_timezone'
                WHEN NULLIF(ga4.metadata->>'ga4PropertyTimeZone', '') IS NOT NULL
                  THEN ga4.metadata->>'ga4PropertyTimeZone'
                ELSE NULL
              END AS timezone,
              CASE
                WHEN NULLIF(shopify.metadata->>'iana_timezone', '') IS NOT NULL THEN 'shopify'
                WHEN NULLIF(ga4.metadata->>'ga4PropertyTimeZone', '') IS NOT NULL THEN 'ga4'
                ELSE NULL
              END AS timezone_source
            FROM businesses b
            LEFT JOIN (
              SELECT
                pc.business_id,
                pc.provider,
                pc.status,
                COALESCE(ic.metadata, '{}'::jsonb) AS metadata
              FROM provider_connections pc
              LEFT JOIN integration_credentials ic
                ON ic.provider_connection_id = pc.id
            ) shopify
              ON shopify.business_id = b.id::text
             AND shopify.provider = 'shopify'
             AND shopify.status = 'connected'
            LEFT JOIN (
              SELECT
                pc.business_id,
                pc.provider,
                pc.status,
                COALESCE(ic.metadata, '{}'::jsonb) AS metadata
              FROM provider_connections pc
              LEFT JOIN integration_credentials ic
                ON ic.provider_connection_id = pc.id
            ) ga4
              ON ga4.business_id = b.id::text
             AND ga4.provider = 'ga4'
             AND ga4.status = 'connected'
          ) AS derived
          WHERE business.id = derived.business_id
            AND (
              business.timezone IS DISTINCT FROM derived.timezone
              OR business.timezone_source IS DISTINCT FROM derived.timezone_source
            )
        `.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_reporting_snapshots_business ON provider_reporting_snapshots (business_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_config_snapshots_lookup ON meta_config_snapshots (business_id, entity_level, entity_id, captured_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_config_snapshots_latest_guard
          ON meta_config_snapshots (business_id, account_id, entity_level, entity_id, captured_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_share_snapshots_token ON creative_share_snapshots (token)`.catch(
          () => {},
        ),
        sql`ALTER TABLE creative_share_snapshots
          ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE CASCADE`.catch(
          () => {},
        ),
        sql`ALTER TABLE creative_share_snapshots
          ADD COLUMN IF NOT EXISTS created_by UUID REFERENCES users(id) ON DELETE SET NULL`.catch(
          () => {},
        ),
        sql`ALTER TABLE creative_share_snapshots
          ADD COLUMN IF NOT EXISTS revoked_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE creative_share_snapshots
          ADD COLUMN IF NOT EXISTS revoked_by UUID REFERENCES users(id) ON DELETE SET NULL`.catch(
          () => {},
        ),
        sql`UPDATE creative_share_snapshots AS snapshot
          SET business_id = business.id
          FROM businesses AS business
          WHERE snapshot.business_id IS NULL
            AND NULLIF(snapshot.payload->>'businessId', '') = business.id::text`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_share_snapshots_business_active
          ON creative_share_snapshots (business_id)
          WHERE revoked_at IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_share_snapshots_creator_active
          ON creative_share_snapshots (created_by)
          WHERE revoked_at IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_decision_os_snapshots_scope
          ON creative_decision_os_snapshots (
            business_id,
            surface,
            analysis_scope,
            COALESCE(analysis_scope_id, ''),
            benchmark_scope,
            COALESCE(benchmark_scope_id, ''),
            generated_at DESC
          )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_custom_reports_business ON custom_reports (business_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_custom_report_share_snapshots_token ON custom_report_share_snapshots (token)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_creative_media_cache_creative_biz ON creative_media_cache (creative_id, business_id, provider)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_media_cache_status ON creative_media_cache (status)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_media_cache_storage_key ON creative_media_cache (storage_key)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_creative_media_cache_expires ON creative_media_cache (expires_at)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creatives_snapshots_business ON meta_creatives_snapshots (business_id, last_synced_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creatives_snapshots_refresh ON meta_creatives_snapshots (refresh_started_at)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_subscriptions_shop_id ON shopify_subscriptions (shop_id)`.catch(
          () => {},
        ),
        sql`ALTER TABLE ai_daily_insights ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en'`.catch(
          () => {},
        ),
        sql`ALTER TABLE ai_creative_decisions_cache ADD COLUMN IF NOT EXISTS locale TEXT NOT NULL DEFAULT 'en'`.catch(
          () => {},
        ),
        sql`ALTER TABLE ai_creative_decisions_cache DROP CONSTRAINT IF EXISTS ai_creative_decisions_cache_source_check`.catch(
          () => {},
        ),
        sql`UPDATE ai_creative_decisions_cache SET source = 'deterministic' WHERE source = 'ai'`.catch(
          () => {},
        ),
        sql`ALTER TABLE ai_creative_decisions_cache ALTER COLUMN source SET DEFAULT 'deterministic'`.catch(
          () => {},
        ),
        sql`ALTER TABLE ai_creative_decisions_cache ADD CONSTRAINT ai_creative_decisions_cache_source_check CHECK (source IN ('deterministic', 'fallback'))`.catch(
          () => {},
        ),
        sql`DROP INDEX IF EXISTS idx_ai_daily_insights_biz_date`.catch(
          () => {},
        ),
        sql`DROP INDEX IF EXISTS idx_ai_creative_decisions_cache_business_analysis`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_daily_insights_biz_date_locale ON ai_daily_insights (business_id, insight_date, locale)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_ai_daily_insights_business ON ai_daily_insights (business_id, insight_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_ai_creative_decisions_cache_business_analysis_locale ON ai_creative_decisions_cache (business_id, analysis_key, locale)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_ai_creative_decisions_cache_business_updated ON ai_creative_decisions_cache (business_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_ai_monthly_analyses_business_month ON seo_ai_monthly_analyses (business_id, analysis_month)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_seo_ai_monthly_analyses_business_updated ON seo_ai_monthly_analyses (business_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_scope ON google_ads_advisor_memory (business_id, account_id, last_seen_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_suppress_until ON google_ads_advisor_memory (suppress_until)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_status ON google_ads_advisor_memory (current_status, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_memory_outcome_check ON google_ads_advisor_memory (outcome_check_at)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_execution_logs_scope ON google_ads_advisor_execution_logs (business_id, account_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_execution_logs_created_at ON google_ads_advisor_execution_logs (created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_snapshots_scope ON google_ads_advisor_snapshots (business_id, account_id, generated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_advisor_snapshots_status ON google_ads_advisor_snapshots (status, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_google_id ON users (google_id) WHERE google_id IS NOT NULL`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_users_facebook_id ON users (facebook_id) WHERE facebook_id IS NOT NULL`.catch(
          () => {},
        ),
      ]);

      // ── PHASE 2.5: Backfill canonical provider-account backbone ─────────
      const providerAccountLegacySeedSources: string[] = [];
      if (legacyIntegrationsAvailable) {
        providerAccountLegacySeedSources.push(`
          SELECT
            i.provider,
            NULLIF(i.provider_account_id, '') AS external_account_id,
            NULLIF(i.provider_account_name, '') AS account_name,
            NULL::TEXT AS currency,
            NULL::TEXT AS timezone,
            NULL::BOOLEAN AS is_manager,
            COALESCE(i.metadata, '{}'::jsonb) AS metadata,
            1 AS source_rank
          FROM integrations i
          WHERE NULLIF(i.provider_account_id, '') IS NOT NULL
        `);
      }
      if (legacySnapshotsAvailable) {
        providerAccountLegacySeedSources.push(`
          SELECT
            s.provider,
            NULLIF(item->>'id', '') AS external_account_id,
            NULLIF(item->>'name', '') AS account_name,
            NULLIF(item->>'currency', '') AS currency,
            NULLIF(item->>'timezone', '') AS timezone,
            CASE
              WHEN item ? 'isManager' THEN (item->>'isManager')::BOOLEAN
              ELSE NULL
            END AS is_manager,
            item AS metadata,
            2 AS source_rank
          FROM provider_account_snapshots s
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.accounts_payload, '[]'::jsonb)) AS item
          WHERE NULLIF(item->>'id', '') IS NOT NULL
        `);
      }
      if (legacyAssignmentsAvailable) {
        providerAccountLegacySeedSources.push(`
          SELECT
            a.provider,
            NULLIF(account_id, '') AS external_account_id,
            NULL::TEXT AS account_name,
            NULL::TEXT AS currency,
            NULL::TEXT AS timezone,
            NULL::BOOLEAN AS is_manager,
            '{}'::jsonb AS metadata,
            3 AS source_rank
          FROM provider_account_assignments a
          CROSS JOIN LATERAL unnest(COALESCE(a.account_ids, ARRAY[]::TEXT[])) AS account_id
          WHERE NULLIF(account_id, '') IS NOT NULL
        `);
      }
      // The legacy imports run at most ONCE per database, in order.
      //
      // Two separate guarantees: `orderedMigrationSteps` because a batch array
      // issues its statements concurrently and these depend on each other
      // (connections need accounts; credentials need connections; snapshot items
      // need snapshot runs), and `runSealedLegacyImport` because DO NOTHING only
      // stops a rerun from OVERWRITING — it never stopped one from INSERTING a
      // legacy row that appeared after the first import.
      await sql`CREATE TABLE IF NOT EXISTS schema_legacy_import_state (
        import_key         TEXT PRIMARY KEY,
        import_version     INTEGER NOT NULL,
        imported_row_count BIGINT NOT NULL DEFAULT 0,
        completed_at       TIMESTAMPTZ NOT NULL DEFAULT now()
      )`;
      await orderedMigrationSteps([
        ...(providerAccountLegacySeedSources.length > 0
          ? [
              () =>
                runSealedLegacyImport(sql, {
                  importKey: "provider_accounts_seed",
                  importSql: `
          INSERT INTO provider_accounts (
            provider,
            external_account_id,
            account_name,
            currency,
            timezone,
            is_manager,
            metadata,
            created_at,
            updated_at
          )
          SELECT DISTINCT ON (provider, external_account_id)
            provider,
            external_account_id,
            account_name,
            currency,
            timezone,
            is_manager,
            metadata,
            now(),
            now()
          FROM (
            ${providerAccountLegacySeedSources.join("\nUNION ALL\n")}
          ) AS source
          WHERE external_account_id IS NOT NULL
          ORDER BY provider, external_account_id, source_rank
          -- STRICTLY ONE-WAY. This import exists to seed canonical rows the
          -- first time a deployment upgrades from the legacy tables; it is not
          -- a synchronisation. Migrations rerun on every deploy, and the
          -- previous DO UPDATE clauses meant every rerun replayed whatever the
          -- legacy table still held over whatever canonical truth had happened
          -- since — undoing a disconnect, a credential rotation, a snapshot
          -- refresh, or a deselection. DO NOTHING makes a rerun a no-op.
          ON CONFLICT (provider, external_account_id) DO NOTHING
          RETURNING id
        `,
                }),
            ]
          : []),
        ...(legacyIntegrationsAvailable
          ? [
              () =>
                runSealedLegacyImport(sql, {
                  importKey: "provider_connections_from_integrations",
                  importSql: `
          INSERT INTO provider_connections (
            business_id,
            provider,
            status,
            provider_account_ref_id,
            provider_account_id,
            provider_account_name,
            connected_at,
            disconnected_at,
            created_at,
            updated_at
          )
          SELECT
            i.business_id,
            i.provider,
            i.status,
            pa.id,
            NULLIF(i.provider_account_id, ''),
            NULLIF(i.provider_account_name, ''),
            i.connected_at,
            i.disconnected_at,
            i.created_at,
            i.updated_at
          FROM integrations i
          LEFT JOIN provider_accounts pa
            ON pa.provider = i.provider
           AND pa.external_account_id = NULLIF(i.provider_account_id, '')
          -- STRICTLY ONE-WAY. This import exists to seed canonical rows the
          -- first time a deployment upgrades from the legacy tables; it is not
          -- a synchronisation. Migrations rerun on every deploy, and the
          -- previous DO UPDATE clauses meant every rerun replayed whatever the
          -- legacy table still held over whatever canonical truth had happened
          -- since — undoing a disconnect, a credential rotation, a snapshot
          -- refresh, or a deselection. DO NOTHING makes a rerun a no-op.
          -- Connection STATUS in particular: replaying a stale
          -- 'connected' over a canonical disconnect would silently reconnect an
          -- integration the user turned off.
          ON CONFLICT (business_id, provider) DO NOTHING
          RETURNING id
        `,
                }),
            ]
          : []),
        ...(legacyIntegrationsAvailable
          ? [
              () =>
                runSealedLegacyImport(sql, {
                  importKey: "integration_credentials_from_integrations",
                  importSql: `
          INSERT INTO integration_credentials (
            provider_connection_id,
            access_token,
            refresh_token,
            token_expires_at,
            scopes,
            error_message,
            metadata,
            created_at,
            updated_at
          )
          SELECT
            pc.id,
            i.access_token,
            i.refresh_token,
            i.token_expires_at,
            i.scopes,
            i.error_message,
            COALESCE(i.metadata, '{}'::jsonb),
            i.created_at,
            i.updated_at
          FROM integrations i
          JOIN provider_connections pc
            ON pc.business_id = i.business_id
           AND pc.provider = i.provider
          -- STRICTLY ONE-WAY. This import exists to seed canonical rows the
          -- first time a deployment upgrades from the legacy tables; it is not
          -- a synchronisation. Migrations rerun on every deploy, and the
          -- previous DO UPDATE clauses meant every rerun replayed whatever the
          -- legacy table still held over whatever canonical truth had happened
          -- since — undoing a disconnect, a credential rotation, a snapshot
          -- refresh, or a deselection. DO NOTHING makes a rerun a no-op.
          -- Secrets especially: a rerun must never put a rotated-away
          -- token back.
          ON CONFLICT (provider_connection_id) DO NOTHING
          RETURNING id
        `,
                }),
            ]
          : []),
        ...(legacyAssignmentsAvailable
          ? [
              () =>
                runSealedLegacyImport(sql, {
                  importKey: "business_provider_accounts_from_assignments",
                  importSql: `
          INSERT INTO business_provider_accounts (
            business_id,
            provider,
            provider_account_ref_id,
            provider_account_id,
            position,
            -- EXPLICITLY TRUE. This backfill runs after the is_selected cutover
            -- has already switched the column default to FALSE, so relying on
            -- the default here would import every legacy assignment as
            -- deselected and silently stop syncing accounts that were active.
            -- A row in provider_account_assignments WAS the selection.
            is_selected,
            created_at,
            updated_at
          )
          SELECT
            a.business_id,
            a.provider,
            pa.id,
            pa.external_account_id,
            ordinality - 1,
            TRUE,
            a.created_at,
            a.updated_at
          FROM provider_account_assignments a
          CROSS JOIN LATERAL unnest(COALESCE(a.account_ids, ARRAY[]::TEXT[])) WITH ORDINALITY AS account(account_id, ordinality)
          JOIN provider_accounts pa
            ON pa.provider = a.provider
           AND pa.external_account_id = account.account_id
          -- STRICTLY ONE-WAY. This import exists to seed canonical rows the
          -- first time a deployment upgrades from the legacy tables; it is not
          -- a synchronisation. Migrations rerun on every deploy, and the
          -- previous DO UPDATE clauses meant every rerun replayed whatever the
          -- legacy table still held over whatever canonical truth had happened
          -- since — undoing a disconnect, a credential rotation, a snapshot
          -- refresh, or a deselection. DO NOTHING makes a rerun a no-op.
          -- The is_selected = existing OR EXCLUDED clause was the
          -- reselection defect: a canonically DESELECTED account that the legacy
          -- table still listed came back on the next migration run, and no
          -- selection change can survive a deploy under that rule.
          ON CONFLICT (business_id, provider, provider_account_ref_id) DO NOTHING
          RETURNING id
        `,
                }),
            ]
          : []),
        ...(legacySnapshotsAvailable
          ? [
              () =>
                runSealedLegacyImport(sql, {
                  importKey: "snapshot_runs_from_snapshots",
                  importSql: `
          INSERT INTO provider_account_snapshot_runs (
            business_id,
            provider,
            fetched_at,
            refresh_failed,
            last_error,
            refresh_requested_at,
            last_refresh_attempt_at,
            next_refresh_after,
            refresh_in_progress,
            accounts_hash,
            source_reason,
            last_successful_refresh_at,
            refresh_failure_streak,
            created_at,
            updated_at
          )
          SELECT
            business_id,
            provider,
            fetched_at,
            refresh_failed,
            last_error,
            refresh_requested_at,
            last_refresh_attempt_at,
            next_refresh_after,
            refresh_in_progress,
            accounts_hash,
            source_reason,
            last_successful_refresh_at,
            refresh_failure_streak,
            created_at,
            updated_at
          FROM provider_account_snapshots
          -- STRICTLY ONE-WAY. This import exists to seed canonical rows the
          -- first time a deployment upgrades from the legacy tables; it is not
          -- a synchronisation. Migrations rerun on every deploy, and the
          -- previous DO UPDATE clauses meant every rerun replayed whatever the
          -- legacy table still held over whatever canonical truth had happened
          -- since — undoing a disconnect, a credential rotation, a snapshot
          -- refresh, or a deselection. DO NOTHING makes a rerun a no-op.
          -- Snapshot health too: replaying a stale healthy row over a
          -- current failed one would make a degraded discovery look fresh, and
          -- selection authority reads exactly those fields.
          ON CONFLICT (business_id, provider) DO NOTHING
          RETURNING id
        `,
                }),
            ]
          : []),
        ...(legacySnapshotsAvailable
          ? [
              () =>
                runSealedLegacyImport(sql, {
                  importKey: "snapshot_items_from_snapshots",
                  importSql: `
          INSERT INTO provider_account_snapshot_items (
            snapshot_run_id,
            provider_account_ref_id,
            provider_account_id,
            provider_account_name,
            currency,
            timezone,
            is_manager,
            position,
            raw_payload,
            created_at,
            updated_at
          )
          SELECT
            run.id,
            pa.id,
            NULLIF(item->>'id', ''),
            COALESCE(NULLIF(item->>'name', ''), NULLIF(item->>'id', '')),
            NULLIF(item->>'currency', ''),
            NULLIF(item->>'timezone', ''),
            CASE
              WHEN item ? 'isManager' THEN (item->>'isManager')::BOOLEAN
              ELSE NULL
            END,
            ordinality - 1,
            item,
            now(),
            now()
          FROM provider_account_snapshots s
          JOIN provider_account_snapshot_runs run
            ON run.business_id = s.business_id
           AND run.provider = s.provider
          CROSS JOIN LATERAL jsonb_array_elements(COALESCE(s.accounts_payload, '[]'::jsonb)) WITH ORDINALITY AS item(item, ordinality)
          LEFT JOIN provider_accounts pa
            ON pa.provider = s.provider
           AND pa.external_account_id = NULLIF(item.item->>'id', '')
          WHERE NULLIF(item.item->>'id', '') IS NOT NULL
          -- STRICTLY ONE-WAY. This import exists to seed canonical rows the
          -- first time a deployment upgrades from the legacy tables; it is not
          -- a synchronisation. Migrations rerun on every deploy, and the
          -- previous DO UPDATE clauses meant every rerun replayed whatever the
          -- legacy table still held over whatever canonical truth had happened
          -- since — undoing a disconnect, a credential rotation, a snapshot
          -- refresh, or a deselection. DO NOTHING makes a rerun a no-op.
          ON CONFLICT (snapshot_run_id, provider_account_id) DO NOTHING
          RETURNING id
        `,
                }),
            ]
          : []),
      ]);

      // ── PHASE 3: Tables that depend on users+businesses ───────────────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS memberships (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          role        TEXT NOT NULL CHECK (role IN ('admin', 'collaborator', 'guest')),
          status      TEXT NOT NULL CHECK (status IN ('active', 'invited', 'pending')),
          joined_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (user_id, business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS invites (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          email              TEXT NOT NULL,
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          role               TEXT NOT NULL CHECK (role IN ('admin', 'collaborator', 'guest')),
          token              TEXT NOT NULL UNIQUE,
          status             TEXT NOT NULL DEFAULT 'pending' CHECK (status IN ('pending', 'accepted', 'revoked', 'expired')),
          invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          expires_at         TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days'),
          accepted_at        TIMESTAMPTZ,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS sessions (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id            UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash         TEXT NOT NULL UNIQUE,
          active_business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
          expires_at         TIMESTAMPTZ NOT NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS password_reset_tokens (
          id         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          user_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          token_hash TEXT NOT NULL UNIQUE,
          expires_at TIMESTAMPTZ NOT NULL,
          used_at    TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_password_reset_tokens_user
          ON password_reset_tokens (user_id)`,
        sql`CREATE TABLE IF NOT EXISTS business_cost_models (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          cogs_percent       DOUBLE PRECISION NOT NULL DEFAULT 0,
          shipping_percent   DOUBLE PRECISION NOT NULL DEFAULT 0,
          fee_percent        DOUBLE PRECISION NOT NULL DEFAULT 0,
          fixed_monthly_cost DOUBLE PRECISION NOT NULL DEFAULT 0,
          fixed_cost         DOUBLE PRECISION NOT NULL DEFAULT 0,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_target_packs (
          id                             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                    UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          target_cpa                     DOUBLE PRECISION,
          target_roas                    DOUBLE PRECISION,
          break_even_cpa                 DOUBLE PRECISION,
          break_even_roas                DOUBLE PRECISION,
          contribution_margin_assumption DOUBLE PRECISION,
          aov_assumption                 DOUBLE PRECISION,
          new_customer_weight            DOUBLE PRECISION,
          default_risk_posture           TEXT NOT NULL DEFAULT 'balanced'
                                          CHECK (default_risk_posture IN ('conservative', 'balanced', 'aggressive')),
          cost_cogs_percent              DOUBLE PRECISION,
          cost_shipping_percent          DOUBLE PRECISION,
          cost_fulfillment_percent       DOUBLE PRECISION,
          cost_payment_processing_percent DOUBLE PRECISION,
          source_label                   TEXT,
          updated_by_user_id             UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_target_pack_history (
          id                              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          business_ref_id                 UUID REFERENCES businesses(id) ON DELETE SET NULL,
          target_cpa                      DOUBLE PRECISION,
          target_roas                     DOUBLE PRECISION,
          break_even_cpa                  DOUBLE PRECISION,
          break_even_roas                 DOUBLE PRECISION,
          contribution_margin_assumption  DOUBLE PRECISION,
          aov_assumption                  DOUBLE PRECISION,
          new_customer_weight             DOUBLE PRECISION,
          default_risk_posture            TEXT NOT NULL
                                            CHECK (default_risk_posture IN ('conservative', 'balanced', 'aggressive')),
          cost_cogs_percent               DOUBLE PRECISION,
          cost_shipping_percent           DOUBLE PRECISION,
          cost_fulfillment_percent        DOUBLE PRECISION,
          cost_payment_processing_percent DOUBLE PRECISION,
          source_label                    TEXT,
          operation                       TEXT NOT NULL CHECK (operation IN ('upsert', 'delete')),
          effective_at                    TIMESTAMPTZ NOT NULL,
          recorded_at                     TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_by_user_id              UUID REFERENCES users(id) ON DELETE SET NULL,
          CHECK (effective_at <= recorded_at)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_country_economics (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          country_code         TEXT NOT NULL,
          economics_multiplier DOUBLE PRECISION,
          margin_modifier      DOUBLE PRECISION,
          serviceability       TEXT NOT NULL DEFAULT 'full'
                                CHECK (serviceability IN ('full', 'limited', 'blocked')),
          priority_tier        TEXT NOT NULL DEFAULT 'tier_2'
                                CHECK (priority_tier IN ('tier_1', 'tier_2', 'tier_3')),
          scale_override       TEXT NOT NULL DEFAULT 'default'
                                CHECK (scale_override IN ('default', 'prefer_scale', 'hold', 'deprioritize')),
          notes                TEXT,
          source_label         TEXT,
          updated_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, country_code)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_promo_calendar_events (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          event_id           TEXT NOT NULL,
          title              TEXT NOT NULL,
          promo_type         TEXT NOT NULL DEFAULT 'sale'
                              CHECK (promo_type IN ('sale', 'launch', 'clearance', 'seasonal', 'other')),
          severity           TEXT NOT NULL DEFAULT 'medium'
                              CHECK (severity IN ('low', 'medium', 'high')),
          start_date         DATE NOT NULL,
          end_date           DATE NOT NULL,
          affected_scope     TEXT,
          notes              TEXT,
          source_label       TEXT,
          updated_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, event_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_operating_constraints (
          id                                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                          UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          site_issue_status                    TEXT NOT NULL DEFAULT 'none'
                                                CHECK (site_issue_status IN ('none', 'watch', 'critical')),
          checkout_issue_status                TEXT NOT NULL DEFAULT 'none'
                                                CHECK (checkout_issue_status IN ('none', 'watch', 'critical')),
          conversion_tracking_issue_status     TEXT NOT NULL DEFAULT 'none'
                                                CHECK (conversion_tracking_issue_status IN ('none', 'watch', 'critical')),
          feed_issue_status                    TEXT NOT NULL DEFAULT 'none'
                                                CHECK (feed_issue_status IN ('none', 'watch', 'critical')),
          stock_pressure_status                TEXT NOT NULL DEFAULT 'healthy'
                                                CHECK (stock_pressure_status IN ('healthy', 'watch', 'blocked')),
          landing_page_concern                 TEXT,
          merchandising_concern                TEXT,
          manual_do_not_scale_reason           TEXT,
          source_label                         TEXT,
          updated_by_user_id                   UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id)
        )`,
        sql`CREATE TABLE IF NOT EXISTS business_decision_calibration_profiles (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          channel                    TEXT NOT NULL
                                       CHECK (channel IN ('meta', 'creative', 'command_center')),
          objective_family           TEXT NOT NULL
                                       CHECK (objective_family IN ('sales', 'catalog', 'leads', 'traffic', 'awareness', 'engagement', 'unknown')),
          bid_regime                 TEXT NOT NULL
                                       CHECK (bid_regime IN ('open', 'cost_cap', 'bid_cap', 'roas_floor', 'unknown')),
          archetype                  TEXT NOT NULL,
          target_roas_multiplier     DOUBLE PRECISION,
          break_even_roas_multiplier DOUBLE PRECISION,
          target_cpa_multiplier      DOUBLE PRECISION,
          break_even_cpa_multiplier  DOUBLE PRECISION,
          confidence_cap             DOUBLE PRECISION,
          action_ceiling             TEXT
                                       CHECK (action_ceiling IN ('review_hold', 'review_reduce', 'monitor_low_truth', 'degraded_no_scale')),
          engine_preset_label        TEXT NOT NULL DEFAULT 'balanced'
                                       CHECK (engine_preset_label IN ('aggressive', 'balanced', 'conservative')),
          zero_conv_burner_multiplier DOUBLE PRECISION,
          cut_candidate_multiplier   DOUBLE PRECISION,
          sustained_loser_multiplier DOUBLE PRECISION,
          hard_cut_multiplier        DOUBLE PRECISION,
          scale_evidence_multiplier  DOUBLE PRECISION,
          scale_purchase_multiplier  DOUBLE PRECISION,
          winner_memory_multiplier   DOUBLE PRECISION,
          recent_sample_multiplier   DOUBLE PRECISION,
          weak_funnel_rate_multiplier DOUBLE PRECISION,
          attribution_aov_adjustment_multiplier DOUBLE PRECISION,
          notes                      TEXT,
          source_label               TEXT,
          updated_by_user_id         UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, channel, objective_family, bid_regime, archetype)
        )`,
        sql`CREATE TABLE IF NOT EXISTS admin_audit_logs (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          admin_id    UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          action      TEXT NOT NULL,
          target_type TEXT NOT NULL,
          target_id   TEXT,
          meta        JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS meta_ads_action_log (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          ad_id           TEXT NOT NULL,
          creative_id     TEXT,
          action          TEXT NOT NULL CHECK (action IN ('pause', 'resume', 'duplicate')),
          source          TEXT NOT NULL DEFAULT 'ui_manual',
          requested_by    UUID,
          requested_at    TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          payload_request JSONB,
          payload_response JSONB,
          status          TEXT NOT NULL DEFAULT 'pending'
            CHECK (status IN ('pending', 'success', 'failure', 'silent_failure')),
          error_code      TEXT,
          error_message   TEXT,
          resulting_ad_id TEXT,
          duration_ms     INTEGER,
          verified_at     TIMESTAMPTZ,
          verification_payload JSONB,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ads_action_log_business_recent
          ON meta_ads_action_log (business_id, requested_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ads_action_log_ad
          ON meta_ads_action_log (ad_id, requested_at DESC)`.catch(() => {}),
        sql`ALTER TABLE meta_ads_action_log
          ADD COLUMN IF NOT EXISTS rec_id_origin TEXT`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_launch_drafts (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          payload_json JSONB NOT NULL,
          status TEXT NOT NULL CHECK (status IN ('draft', 'queued', 'launched', 'failed')) DEFAULT 'draft',
          created_by UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          launched_at TIMESTAMPTZ,
          last_error_json JSONB
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_launch_drafts_business_recent
          ON meta_launch_drafts (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_launch_templates (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          name TEXT NOT NULL,
          description TEXT,
          payload_json JSONB NOT NULL,
          source TEXT NOT NULL CHECK (source IN ('manual', 'auto_recent')) DEFAULT 'manual',
          created_by UUID,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_launch_templates_business
          ON meta_launch_templates (business_id, source, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_automation_business_controls (
          business_id UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
          kill_switch_engaged BOOLEAN NOT NULL DEFAULT FALSE,
          kill_switch_reason TEXT,
          auto_execution_enabled BOOLEAN NOT NULL DEFAULT FALSE,
          readiness_tier TEXT NOT NULL DEFAULT 'manual_review'
            CHECK (readiness_tier IN ('read_only', 'manual_review', 'backtest_candidate', 'auto_execute')),
          guardrails_json JSONB NOT NULL DEFAULT '{
            "dailyAutoActionCap": 3,
            "perActionSpendCeilingMinor": 5000,
            "perActionSpendCeilingCurrency": "EUR",
            "notificationPolicy": "every_auto_action",
            "maxBudgetIncreasePct": 15,
            "maxDailyBudgetChangeMinor": null,
            "requireCampaignLabel": true,
            "requireCommercialAnchor": true,
            "requireLivePreflight": true,
            "requireRollbackPlan": true,
            "dryRunOnly": true
          }'::jsonb,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by UUID REFERENCES users(id) ON DELETE SET NULL
        )`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_automation_promotion_records (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          rec_id TEXT,
          entity_type TEXT NOT NULL,
          entity_id TEXT,
          source_tier TEXT,
          target_tier TEXT,
          status TEXT NOT NULL DEFAULT 'proposed'
            CHECK (status IN ('proposed', 'approved', 'blocked', 'executed', 'rejected', 'expired')),
          reason TEXT,
          payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_automation_promotion_records_business
          ON meta_automation_promotion_records (business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_automation_activity_ledger (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          activity_type TEXT NOT NULL,
          severity TEXT NOT NULL DEFAULT 'info'
            CHECK (severity IN ('info', 'warning', 'danger', 'success')),
          message TEXT NOT NULL,
          payload_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_by UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_automation_activity_ledger_business
          ON meta_automation_activity_ledger (business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_automation_decision_type_modes (
          business_id UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          decision_type TEXT NOT NULL
            CHECK (decision_type IN ('pause', 'bid', 'budget', 'creative')),
          mode TEXT NOT NULL DEFAULT 'manual'
            CHECK (mode IN ('manual', 'semi_auto', 'auto')),
          lock_reason TEXT,
          updated_by UUID REFERENCES users(id) ON DELETE SET NULL,
          updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          PRIMARY KEY (business_id, decision_type)
        )`.catch(() => {}),
        sql`DO $$
          DECLARE
            action_constraint_name TEXT;
          BEGIN
            SELECT c.conname
            INTO action_constraint_name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema()
              AND t.relname = 'meta_ads_action_log'
              AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) LIKE '%action%'
            LIMIT 1;

            IF action_constraint_name IS NOT NULL THEN
              EXECUTE format(
                'ALTER TABLE meta_ads_action_log DROP CONSTRAINT %I',
                action_constraint_name
              );
            END IF;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'meta_ads_action_log'
                AND c.contype = 'c'
                AND pg_get_constraintdef(c.oid) LIKE '%launch_campaign%'
                AND pg_get_constraintdef(c.oid) LIKE '%launch_adset%'
                AND pg_get_constraintdef(c.oid) LIKE '%launch_ad%'
            ) THEN
              ALTER TABLE meta_ads_action_log
                ADD CONSTRAINT meta_ads_action_log_action_check
                CHECK (action IN (
                  'pause',
                  'resume',
                  'duplicate',
                  'launch_campaign',
                  'launch_adset',
                  'launch_ad'
                ));
            END IF;
          END
          $$`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS discount_codes (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code        TEXT NOT NULL UNIQUE,
          description TEXT,
          type        TEXT NOT NULL CHECK (type IN ('percent', 'fixed')),
          value       NUMERIC(10,2) NOT NULL,
          max_uses    INTEGER,
          uses        INTEGER NOT NULL DEFAULT 0,
          applies_to  TEXT[] NOT NULL DEFAULT '{}',
          valid_from  TIMESTAMPTZ,
          valid_until TIMESTAMPTZ,
          is_active   BOOLEAN NOT NULL DEFAULT true,
          created_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_by  UUID REFERENCES users(id) ON DELETE SET NULL
        )`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS is_demo_business BOOLEAN NOT NULL DEFAULT FALSE`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS industry TEXT`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS platform TEXT`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS metadata JSONB NOT NULL DEFAULT '{}'::jsonb`,
        sql`ALTER TABLE businesses ADD COLUMN IF NOT EXISTS plan_override TEXT`,
        ...(legacySnapshotsAvailable
          ? [
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS refresh_requested_at TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS last_refresh_attempt_at TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS next_refresh_after TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS refresh_in_progress BOOLEAN NOT NULL DEFAULT FALSE`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS accounts_hash TEXT`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS source_reason TEXT`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS last_successful_refresh_at TIMESTAMPTZ`,
              sql`ALTER TABLE provider_account_snapshots ADD COLUMN IF NOT EXISTS refresh_failure_streak INTEGER NOT NULL DEFAULT 0`,
            ]
          : []),
        sql`ALTER TABLE shopify_subscriptions ADD COLUMN IF NOT EXISTS business_id UUID REFERENCES businesses(id) ON DELETE SET NULL`,
        sql`ALTER TABLE shopify_subscriptions ADD COLUMN IF NOT EXISTS user_id UUID REFERENCES users(id) ON DELETE SET NULL`,
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS applied_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_check_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_check_window_days INTEGER`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_verdict TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_metric TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_delta NUMERIC(18, 4)`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_verdict_fail_reason TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS outcome_confidence TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS execution_status TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS executed_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS execution_error TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS rollback_available BOOLEAN`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS rollback_executed_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS completion_mode TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS completed_step_count INTEGER`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS total_step_count INTEGER`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS completed_step_ids JSONB`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS skipped_step_ids JSONB`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS core_step_ids JSONB`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS execution_metadata JSONB`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_advisor_memory ADD COLUMN IF NOT EXISTS applied_snapshot JSONB`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_advisor_execution_logs (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          account_id TEXT NOT NULL,
          recommendation_fingerprint TEXT NOT NULL,
          mutate_action_type TEXT NOT NULL,
          operation TEXT NOT NULL,
          status TEXT NOT NULL,
          payload_json JSONB,
          response_json JSONB,
          error_message TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_state (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint  TEXT NOT NULL,
          source_system       TEXT NOT NULL CHECK (source_system IN ('meta', 'creative')),
          source_type         TEXT NOT NULL,
          action_title        TEXT NOT NULL,
          recommended_action  TEXT NOT NULL,
          workflow_status     TEXT NOT NULL DEFAULT 'pending'
                                CHECK (workflow_status IN ('pending', 'approved', 'rejected', 'snoozed', 'completed_manual', 'executed', 'failed', 'canceled')),
          assignee_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
          snooze_until        TIMESTAMPTZ,
          latest_note_excerpt TEXT,
          note_count          INTEGER NOT NULL DEFAULT 0,
          last_mutation_id    TEXT,
          last_mutated_at     TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, action_fingerprint)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_state_business_status
          ON command_center_action_state (business_id, workflow_status, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_state_business_assignee
          ON command_center_action_state (business_id, assignee_user_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_journal (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint TEXT NOT NULL,
          action_title       TEXT NOT NULL,
          source_system      TEXT NOT NULL CHECK (source_system IN ('meta', 'creative')),
          source_type        TEXT NOT NULL,
          event_type         TEXT NOT NULL
                              CHECK (event_type IN ('status_changed', 'assignee_changed', 'note_added', 'handoff_created', 'handoff_acknowledged')),
          actor_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          client_mutation_id TEXT NOT NULL,
          message            TEXT NOT NULL,
          note               TEXT,
          metadata_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_journal_business_action
          ON command_center_action_journal (business_id, action_fingerprint, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_journal_business_created
          ON command_center_action_journal (business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS command_center_mutation_receipts (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          client_mutation_id TEXT NOT NULL,
          mutation_scope     TEXT NOT NULL,
          payload_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_mutation_receipts_business_created
          ON command_center_mutation_receipts (business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS command_center_saved_views (
          id              UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id     UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          view_key        TEXT NOT NULL,
          name            TEXT NOT NULL,
          definition_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, view_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_saved_views_business
          ON command_center_saved_views (business_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS command_center_handoffs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          shift                      TEXT NOT NULL CHECK (shift IN ('morning', 'evening')),
          summary                    TEXT NOT NULL,
          blockers_json              JSONB NOT NULL DEFAULT '[]'::jsonb,
          watchouts_json             JSONB NOT NULL DEFAULT '[]'::jsonb,
          linked_action_fingerprints TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          from_user_id               UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          to_user_id                 UUID REFERENCES users(id) ON DELETE SET NULL,
          acknowledged_at            TIMESTAMPTZ,
          acknowledged_by_user_id    UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_handoffs_business_shift
          ON command_center_handoffs (business_id, shift, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS command_center_feedback (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          client_mutation_id TEXT NOT NULL,
          feedback_type      TEXT NOT NULL
                              CHECK (feedback_type IN ('false_positive', 'bad_recommendation', 'false_negative')),
          outcome            TEXT NOT NULL DEFAULT 'operator_note'
                              CHECK (outcome IN ('calibration_candidate', 'workflow_gap', 'operator_note')),
          scope              TEXT NOT NULL CHECK (scope IN ('action', 'queue_gap')),
          action_fingerprint TEXT,
          action_title       TEXT,
          source_system      TEXT CHECK (source_system IN ('meta', 'creative')),
          source_type        TEXT,
          workload_class     TEXT
                              CHECK (workload_class IN ('budget_shift', 'scale_promotion', 'recovery', 'creative_refresh', 'test_backlog', 'geo_review', 'risk_triage', 'policy_guardrail', 'protected_watch', 'archive_context')),
          calibration_hint_json JSONB NOT NULL DEFAULT 'null'::jsonb,
          view_key           TEXT,
          note               TEXT NOT NULL,
          actor_user_id      UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`ALTER TABLE command_center_feedback
          ADD COLUMN IF NOT EXISTS outcome TEXT NOT NULL DEFAULT 'operator_note'
            CHECK (outcome IN ('calibration_candidate', 'workflow_gap', 'operator_note'))`.catch(
          () => {},
        ),
        sql`ALTER TABLE command_center_feedback
          ADD COLUMN IF NOT EXISTS workload_class TEXT
            CHECK (workload_class IN ('budget_shift', 'scale_promotion', 'recovery', 'creative_refresh', 'test_backlog', 'geo_review', 'risk_triage', 'policy_guardrail', 'protected_watch', 'archive_context'))`.catch(
          () => {},
        ),
        sql`ALTER TABLE command_center_feedback
          ADD COLUMN IF NOT EXISTS calibration_hint_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_feedback_business_created
          ON command_center_feedback (business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_feedback_business_action
          ON command_center_feedback (business_id, action_fingerprint, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_execution_state (
          id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint           TEXT NOT NULL,
          execution_status             TEXT NOT NULL
                                        CHECK (execution_status IN ('draft', 'ready_for_apply', 'applying', 'executed', 'failed', 'rolled_back', 'manual_only', 'unsupported')),
          support_mode                 TEXT NOT NULL
                                        CHECK (support_mode IN ('supported', 'manual_only', 'unsupported')),
          source_system                TEXT NOT NULL CHECK (source_system IN ('meta', 'creative')),
          source_type                  TEXT NOT NULL,
          requested_action             TEXT NOT NULL,
          preview_hash                 TEXT,
          capability_key               TEXT,
          workflow_status_snapshot     TEXT NOT NULL DEFAULT 'pending'
                                        CHECK (workflow_status_snapshot IN ('pending', 'approved', 'rejected', 'snoozed', 'completed_manual', 'executed', 'failed', 'canceled')),
          approval_actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
          approval_actor_name          TEXT,
          approval_actor_email         TEXT,
          approved_at                  TIMESTAMPTZ,
          applied_by_user_id           UUID REFERENCES users(id) ON DELETE SET NULL,
          applied_by_name              TEXT,
          applied_by_email             TEXT,
          applied_at                   TIMESTAMPTZ,
          rollback_kind                TEXT NOT NULL DEFAULT 'not_available'
                                        CHECK (rollback_kind IN ('provider_rollback', 'recovery_note_only', 'not_available')),
          rollback_note                TEXT,
          last_client_mutation_id      TEXT,
          last_error_code              TEXT,
          last_error_message           TEXT,
          current_state_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          requested_state_json         JSONB NOT NULL DEFAULT 'null'::jsonb,
          captured_pre_apply_state_json JSONB NOT NULL DEFAULT 'null'::jsonb,
          preflight_json               JSONB NOT NULL DEFAULT 'null'::jsonb,
          validation_json              JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_diff_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_response_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, action_fingerprint)
        )`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS capability_key TEXT`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS preflight_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS validation_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE command_center_action_execution_state
          ADD COLUMN IF NOT EXISTS provider_diff_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_execution_state_business_status
          ON command_center_action_execution_state (business_id, execution_status, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS command_center_action_execution_audit (
          id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                  UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          action_fingerprint           TEXT NOT NULL,
          client_mutation_id           TEXT NOT NULL,
          operation                    TEXT NOT NULL CHECK (operation IN ('apply', 'rollback')),
          execution_status             TEXT NOT NULL
                                        CHECK (execution_status IN ('draft', 'ready_for_apply', 'applying', 'executed', 'failed', 'rolled_back', 'manual_only', 'unsupported')),
          support_mode                 TEXT NOT NULL
                                        CHECK (support_mode IN ('supported', 'manual_only', 'unsupported')),
          actor_user_id                UUID REFERENCES users(id) ON DELETE SET NULL,
          actor_name                   TEXT,
          actor_email                  TEXT,
          approval_actor_user_id       UUID REFERENCES users(id) ON DELETE SET NULL,
          approval_actor_name          TEXT,
          approval_actor_email         TEXT,
          approved_at                  TIMESTAMPTZ,
          preview_hash                 TEXT,
          capability_key               TEXT,
          rollback_kind                TEXT NOT NULL DEFAULT 'not_available'
                                        CHECK (rollback_kind IN ('provider_rollback', 'recovery_note_only', 'not_available')),
          rollback_note                TEXT,
          current_state_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          requested_state_json         JSONB NOT NULL DEFAULT 'null'::jsonb,
          captured_pre_apply_state_json JSONB NOT NULL DEFAULT 'null'::jsonb,
          preflight_json               JSONB NOT NULL DEFAULT 'null'::jsonb,
          validation_json              JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_diff_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          provider_response_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          failure_reason               TEXT,
          external_refs_json           JSONB NOT NULL DEFAULT 'null'::jsonb,
          created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, client_mutation_id)
        )`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS capability_key TEXT`.catch(() => {}),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS preflight_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS validation_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE command_center_action_execution_audit
          ADD COLUMN IF NOT EXISTS provider_diff_json JSONB NOT NULL DEFAULT 'null'::jsonb`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_command_center_action_execution_audit_business_action
          ON command_center_action_execution_audit (business_id, action_fingerprint, created_at DESC)`.catch(
          () => {},
        ),
      ]);

      // ── PHASE 4: Tables with deeper deps + all remaining indexes ──────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS discount_redemptions (
          id          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          code_id     UUID NOT NULL REFERENCES discount_codes(id) ON DELETE CASCADE,
          user_id     UUID NOT NULL REFERENCES users(id) ON DELETE CASCADE,
          business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
          plan_id     TEXT NOT NULL,
          amount_off  NUMERIC(10,2) NOT NULL,
          redeemed_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE TABLE IF NOT EXISTS shopify_install_contexts (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          token                 TEXT NOT NULL UNIQUE,
          shop_domain           TEXT NOT NULL,
          shop_name             TEXT,
          access_token          TEXT NOT NULL,
          scopes                TEXT,
          metadata              JSONB NOT NULL DEFAULT '{}'::jsonb,
          return_to             TEXT,
          session_id            UUID REFERENCES sessions(id) ON DELETE SET NULL,
          user_id               UUID REFERENCES users(id) ON DELETE SET NULL,
          preferred_business_id UUID REFERENCES businesses(id) ON DELETE SET NULL,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          expires_at            TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '30 minutes')
        )`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS invited_by_user_id UUID REFERENCES users(id) ON DELETE SET NULL`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS expires_at TIMESTAMPTZ NOT NULL DEFAULT (now() + interval '7 days')`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS accepted_at TIMESTAMPTZ`,
        sql`ALTER TABLE invites ADD COLUMN IF NOT EXISTS workspace_ids UUID[]`,
        sql`ALTER TABLE business_cost_models ADD COLUMN IF NOT EXISTS fixed_monthly_cost DOUBLE PRECISION NOT NULL DEFAULT 0`,
        sql`ALTER TABLE business_cost_models ADD COLUMN IF NOT EXISTS fixed_cost DOUBLE PRECISION NOT NULL DEFAULT 0`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_cogs_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_shipping_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_fulfillment_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_target_packs ADD COLUMN IF NOT EXISTS cost_payment_processing_percent DOUBLE PRECISION`,
        sql`ALTER TABLE business_decision_calibration_profiles
          ADD COLUMN IF NOT EXISTS engine_preset_label TEXT NOT NULL DEFAULT 'balanced'
            CHECK (engine_preset_label IN ('aggressive', 'balanced', 'conservative')),
          ADD COLUMN IF NOT EXISTS zero_conv_burner_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS cut_candidate_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS sustained_loser_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS hard_cut_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS scale_evidence_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS scale_purchase_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_memory_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS recent_sample_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS weak_funnel_rate_multiplier DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS attribution_aov_adjustment_multiplier DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sessions_user_id ON sessions (user_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_invites_business_id ON invites (business_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_invites_email ON invites (email)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_cost_models_business_id ON business_cost_models (business_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_target_packs_business_id ON business_target_packs (business_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_target_pack_history_business_effective
          ON business_target_pack_history (business_id, effective_at DESC, recorded_at DESC, id DESC)`.catch(
          () => {},
        ),
        sql`INSERT INTO business_target_pack_history (
          business_id,
          business_ref_id,
          target_cpa,
          target_roas,
          break_even_cpa,
          break_even_roas,
          contribution_margin_assumption,
          aov_assumption,
          new_customer_weight,
          default_risk_posture,
          cost_cogs_percent,
          cost_shipping_percent,
          cost_fulfillment_percent,
          cost_payment_processing_percent,
          source_label,
          operation,
          effective_at,
          recorded_at,
          updated_by_user_id
        )
        SELECT
          target.business_id,
          target.business_id,
          target.target_cpa,
          target.target_roas,
          target.break_even_cpa,
          target.break_even_roas,
          target.contribution_margin_assumption,
          target.aov_assumption,
          target.new_customer_weight,
          target.default_risk_posture,
          target.cost_cogs_percent,
          target.cost_shipping_percent,
          target.cost_fulfillment_percent,
          target.cost_payment_processing_percent,
          target.source_label,
          'upsert',
          target.updated_at,
          GREATEST(transaction_timestamp(), target.updated_at),
          target.updated_by_user_id
        FROM business_target_packs target
        WHERE NOT EXISTS (
          SELECT 1
          FROM business_target_pack_history history
          WHERE history.business_id = target.business_id
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_business_country_economics_business_country ON business_country_economics (business_id, country_code)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_promo_calendar_events_business_event ON business_promo_calendar_events (business_id, event_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_promo_calendar_events_business_dates ON business_promo_calendar_events (business_id, start_date, end_date)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_operating_constraints_business_id ON business_operating_constraints (business_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_decision_calibration_profiles_business ON business_decision_calibration_profiles (business_id, channel)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_business_decision_calibration_profiles_profile ON business_decision_calibration_profiles (business_id, objective_family, bid_regime, archetype)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_admin ON admin_audit_logs (admin_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_admin_audit_logs_created ON admin_audit_logs (created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_discount_codes_code ON discount_codes (lower(code))`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_subscriptions_business_id ON shopify_subscriptions (business_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_subscriptions_user_id ON shopify_subscriptions (user_id)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_shopify_install_contexts_token ON shopify_install_contexts (token)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_install_contexts_expires_at ON shopify_install_contexts (expires_at)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_install_contexts_user_id ON shopify_install_contexts (user_id)`.catch(
          () => {},
        ),
      ]);

      // Phase 4b: discount_redemptions indexes (after table created above)
      await runMigrationBatchSequentially([
        sql`CREATE INDEX IF NOT EXISTS idx_discount_redemptions_code ON discount_redemptions (code_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_discount_redemptions_user ON discount_redemptions (user_id)`.catch(
          () => {},
        ),
        sql`UPDATE business_cost_models SET fixed_monthly_cost = fixed_cost WHERE fixed_monthly_cost = 0 AND fixed_cost <> 0`,
        sql`UPDATE business_cost_models SET fixed_cost = fixed_monthly_cost WHERE fixed_cost = 0 AND fixed_monthly_cost <> 0`,
        sql`CREATE TABLE IF NOT EXISTS seo_results_cache (
          id           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id  TEXT NOT NULL,
          cache_type   TEXT NOT NULL CHECK (cache_type IN ('overview', 'findings')),
          start_date   DATE NOT NULL,
          end_date     DATE NOT NULL,
          payload      JSONB NOT NULL,
          generated_at TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_seo_results_cache_lookup ON seo_results_cache (business_id, cache_type, start_date, end_date)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_seo_results_cache_business ON seo_results_cache (business_id, generated_at DESC)`.catch(
          () => {},
        ),
        // ── Google integration: quota & sync tables ──────────────────────────
        sql`CREATE TABLE IF NOT EXISTS provider_cooldown_state (
          id            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id   TEXT NOT NULL,
          provider      TEXT NOT NULL,
          request_type  TEXT NOT NULL,
          failed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          failure_count INT NOT NULL DEFAULT 1,
          error_message TEXT,
          http_status   INT,
          cooldown_until TIMESTAMPTZ NOT NULL,
          updated_at    TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_cooldown_state_key ON provider_cooldown_state (business_id, provider, request_type)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_cooldown_state_until ON provider_cooldown_state (cooldown_until)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS provider_sync_jobs (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          provider       TEXT NOT NULL,
          report_type    TEXT NOT NULL,
          date_range_key TEXT NOT NULL,
          status         TEXT NOT NULL DEFAULT 'pending',
          triggered_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at     TIMESTAMPTZ,
          lock_owner     TEXT,
          lock_expires_at TIMESTAMPTZ,
          completed_at   TIMESTAMPTZ,
          error_message  TEXT
        )`.catch(() => {}),
        sql`ALTER TABLE provider_sync_jobs ADD COLUMN IF NOT EXISTS lock_owner TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE provider_sync_jobs ADD COLUMN IF NOT EXISTS lock_expires_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_sync_jobs_key ON provider_sync_jobs (business_id, provider, report_type, date_range_key)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_sync_jobs_status ON provider_sync_jobs (status, triggered_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_sync_jobs_lock_expiry ON provider_sync_jobs (lock_expires_at)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS provider_quota_usage (
          id             UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id    TEXT NOT NULL,
          provider       TEXT NOT NULL,
          quota_date     DATE NOT NULL DEFAULT CURRENT_DATE,
          call_count     INT NOT NULL DEFAULT 0,
          error_count    INT NOT NULL DEFAULT 0,
          last_called_at TIMESTAMPTZ
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_quota_usage_key ON provider_quota_usage (business_id, provider, quota_date)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS provider_request_audit_daily (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider                TEXT NOT NULL,
          audit_date              DATE NOT NULL DEFAULT CURRENT_DATE,
          request_type            TEXT NOT NULL,
          audit_source            TEXT NOT NULL DEFAULT 'unknown',
          audit_path              TEXT NOT NULL DEFAULT '',
          request_count           INT NOT NULL DEFAULT 0,
          error_count             INT NOT NULL DEFAULT 0,
          quota_error_count       INT NOT NULL DEFAULT 0,
          auth_error_count        INT NOT NULL DEFAULT 0,
          permission_error_count  INT NOT NULL DEFAULT 0,
          generic_error_count     INT NOT NULL DEFAULT 0,
          cooldown_hit_count      INT NOT NULL DEFAULT 0,
          deduped_count           INT NOT NULL DEFAULT 0,
          last_error_at           TIMESTAMPTZ,
          last_error_message      TEXT,
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_request_audit_daily_key
          ON provider_request_audit_daily (
            business_id,
            provider,
            audit_date,
            request_type,
            audit_source,
            audit_path
          )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_request_audit_daily_provider
          ON provider_request_audit_daily (provider, audit_date, updated_at DESC)`.catch(
          () => {},
        ),
        // ── Meta warehouse-first pilot tables ───────────────────────────────
        sql`CREATE TABLE IF NOT EXISTS meta_sync_jobs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          sync_type           TEXT NOT NULL
                              CHECK (sync_type IN ('initial_backfill', 'incremental_recent', 'today_refresh', 'repair_window', 'reconnect_backfill')),
          scope               TEXT NOT NULL DEFAULT 'account_daily',
          start_date          DATE NOT NULL,
          end_date            DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
          progress_percent    DOUBLE PRECISION NOT NULL DEFAULT 0,
          trigger_source      TEXT NOT NULL DEFAULT 'system',
          retry_count         INTEGER NOT NULL DEFAULT 0,
          last_error          TEXT,
          triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_jobs_business ON meta_sync_jobs (business_id, triggered_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_jobs_account ON meta_sync_jobs (provider_account_id, triggered_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_jobs_status ON meta_sync_jobs (status, triggered_at DESC)`.catch(
          () => {},
        ),
        sql`
          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY business_id, provider_account_id, sync_type, scope, start_date, end_date, trigger_source
                ORDER BY updated_at DESC, triggered_at DESC, id DESC
              ) AS row_number
            FROM meta_sync_jobs
            WHERE status = 'running'
          )
          UPDATE meta_sync_jobs job
          SET
            status = 'failed',
            last_error = COALESCE(job.last_error, 'duplicate running sync job cleaned up during migration'),
            finished_at = now(),
            updated_at = now()
          FROM ranked
          WHERE job.id = ranked.id
            AND ranked.row_number > 1
        `.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_sync_jobs_running_unique
          ON meta_sync_jobs (
            business_id,
            provider_account_id,
            sync_type,
            scope,
            start_date,
            end_date,
            trigger_source
          )
          WHERE status = 'running'`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_partitions (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
          priority            INTEGER NOT NULL DEFAULT 0,
          source              TEXT NOT NULL DEFAULT 'system',
          lease_owner         TEXT,
          lease_expires_at    TIMESTAMPTZ,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          next_retry_at       TIMESTAMPTZ,
          last_error          TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, lane, scope, partition_date)
        )`.catch(() => {}),
        // The scheduling attempt that created this partition. "syncScheduled:
        // true" was proven by account ids plus an app-clock `created_at` window,
        // which a concurrent enqueue satisfies and clock skew breaks; an
        // immutable attempt id answers "did THIS operation create work?" exactly.
        sql`ALTER TABLE meta_sync_partitions
          ADD COLUMN IF NOT EXISTS scheduling_attempt_id UUID`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_partitions_queue
          ON meta_sync_partitions (business_id, lane, status, priority DESC, partition_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_partitions_lease
          ON meta_sync_partitions (status, lease_expires_at, next_retry_at, updated_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_sync_partitions ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_runs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id        UUID REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
          worker_id           TEXT,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          row_count           INTEGER,
          duration_ms         INTEGER,
          error_class         TEXT,
          error_message       TEXT,
          meta_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_runs_partition ON meta_sync_runs (partition_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_runs_business ON meta_sync_runs (business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_sync_runs_one_running_per_partition
          ON meta_sync_runs (partition_id)
          WHERE status = 'running'`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_checkpoints (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id              UUID NOT NULL REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          business_id               TEXT NOT NULL,
          provider_account_id       TEXT NOT NULL,
          checkpoint_scope          TEXT NOT NULL,
          phase                     TEXT NOT NULL
                                    CHECK (phase IN ('fetch_raw', 'transform', 'bulk_upsert', 'finalize')),
          status                    TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
          page_index                INTEGER NOT NULL DEFAULT 0,
          next_page_url             TEXT,
          provider_cursor           TEXT,
          rows_fetched              INTEGER NOT NULL DEFAULT 0,
          rows_written              INTEGER NOT NULL DEFAULT 0,
          last_successful_entity_key TEXT,
          last_response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          checkpoint_hash           TEXT,
          attempt_count             INTEGER NOT NULL DEFAULT 0,
          retry_after_at            TIMESTAMPTZ,
          lease_owner               TEXT,
          lease_expires_at          TIMESTAMPTZ,
          started_at                TIMESTAMPTZ,
          finished_at               TIMESTAMPTZ,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (partition_id, checkpoint_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_partition
          ON meta_sync_checkpoints (partition_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_scope
          ON meta_sync_checkpoints (business_id, provider_account_id, checkpoint_scope, status, updated_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_sync_checkpoints ADD COLUMN IF NOT EXISTS lease_epoch BIGINT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_sync_checkpoints ADD COLUMN IF NOT EXISTS run_id TEXT`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_partition_epoch
          ON meta_sync_checkpoints (partition_id, lease_epoch, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_checkpoints_partition_run
          ON meta_sync_checkpoints (partition_id, checkpoint_scope, run_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_phase_timings (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id        UUID NOT NULL REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          timing_scope        TEXT NOT NULL,
          run_id              TEXT,
          phase               TEXT NOT NULL
                              CHECK (phase IN ('fetch_raw', 'transform', 'bulk_upsert', 'finalize', 'publish')),
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
          rows_fetched        INTEGER NOT NULL DEFAULT 0,
          rows_written        INTEGER NOT NULL DEFAULT 0,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          lease_epoch         BIGINT,
          lease_owner         TEXT,
          lease_expires_at    TIMESTAMPTZ,
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (partition_id, timing_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_phase_timings_partition
          ON meta_sync_phase_timings (partition_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_phase_timings_business
          ON meta_sync_phase_timings (business_id, provider_account_id, phase, status, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS sync_worker_heartbeats (
          worker_id          TEXT PRIMARY KEY,
          instance_type      TEXT NOT NULL,
          provider_scope     TEXT NOT NULL,
          status             TEXT NOT NULL DEFAULT 'starting'
                             CHECK (status IN ('starting', 'idle', 'running', 'stopping', 'stopped', 'disabled')),
          last_heartbeat_at  TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_business_id   TEXT,
          last_partition_id  TEXT,
          meta_json          JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_worker_heartbeats_status
          ON sync_worker_heartbeats (status, last_heartbeat_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_worker_heartbeats_last_heartbeat
          ON sync_worker_heartbeats (last_heartbeat_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS sync_reclaim_events (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          provider_scope    TEXT NOT NULL,
          business_id       TEXT NOT NULL,
          partition_id      TEXT,
          checkpoint_scope  TEXT,
          event_type        TEXT NOT NULL
                           CHECK (event_type IN ('reclaimed', 'poisoned')),
          disposition       TEXT,
          reason_code       TEXT,
          detail            TEXT,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`ALTER TABLE sync_reclaim_events ADD COLUMN IF NOT EXISTS disposition TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE sync_reclaim_events ADD COLUMN IF NOT EXISTS reason_code TEXT`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_reclaim_events_provider
          ON sync_reclaim_events (provider_scope, business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS sync_runner_leases (
          business_id        TEXT NOT NULL,
          provider_scope     TEXT NOT NULL,
          lease_owner        TEXT NOT NULL,
          lease_expires_at   TIMESTAMPTZ NOT NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_runner_leases_expiry
          ON sync_runner_leases (provider_scope, lease_expires_at, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS sync_runtime_instances (
          instance_id         TEXT PRIMARY KEY,
          service             TEXT NOT NULL
                              CHECK (service IN ('web', 'worker')),
          runtime_role        TEXT NOT NULL
                              CHECK (runtime_role IN ('web', 'worker')),
          build_id            TEXT NOT NULL,
          db_fingerprint      TEXT NOT NULL,
          config_fingerprint  TEXT NOT NULL,
          provider_scopes     TEXT[] NOT NULL DEFAULT ARRAY[]::TEXT[],
          health_state        TEXT NOT NULL DEFAULT 'healthy'
                              CHECK (health_state IN ('healthy', 'invalid')),
          contract_json       JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_runtime_instances_service_seen
          ON sync_runtime_instances (service, last_seen_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_runtime_instances_build
          ON sync_runtime_instances (build_id, service, last_seen_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS sync_release_gates (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id          TEXT NOT NULL,
          environment       TEXT NOT NULL,
          gate_kind         TEXT NOT NULL
                            CHECK (gate_kind IN ('deploy_gate', 'release_gate')),
          gate_scope        TEXT NOT NULL DEFAULT 'release_readiness',
          mode              TEXT NOT NULL
                            CHECK (mode IN ('measure_only', 'warn_only', 'block')),
          base_result       TEXT NOT NULL
                            CHECK (base_result IN ('pass', 'fail', 'misconfigured')),
          verdict           TEXT NOT NULL
                            CHECK (verdict IN ('pass', 'fail', 'misconfigured', 'measure_only', 'warn_only', 'blocked')),
          blocker_class     TEXT,
          summary           TEXT NOT NULL,
          break_glass       BOOLEAN NOT NULL DEFAULT FALSE,
          override_reason   TEXT,
          evidence_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
          emitted_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (build_id, environment, gate_kind)
        )`.catch(() => {}),
        sql`ALTER TABLE sync_release_gates
          DROP CONSTRAINT IF EXISTS sync_release_gates_build_id_environment_gate_kind_key`.catch(
          () => {},
        ),
        sql`ALTER TABLE sync_release_gates
          ADD COLUMN IF NOT EXISTS gate_scope TEXT NOT NULL DEFAULT 'release_readiness'`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_release_gates_build
          ON sync_release_gates (build_id, environment, gate_kind, emitted_at DESC)`.catch(
          () => {},
        ),
        // `idx_sync_release_gates_emitted (emitted_at DESC)` is deliberately NOT
        // created here any more, and is dropped in the ordered group below. Every
        // production read is keyed on (build_id|gate_kind, …), and the only
        // remaining emitted_at-ordered query is retention's ASCENDING keyset —
        // which this DESC index served only by scanning backwards and then
        // applying an Incremental Sort for the id tie-break.
        //
        // Anti-runaway contract for sync_release_gates.
        //
        // This table is ~1.35 GB because every evaluation appended a row and
        // every read scanned all of them: `getLatestSyncGateRecords` ran two
        // unbounded `ORDER BY emitted_at DESC` queries with no LIMIT and
        // filtered in JavaScript, and the control-plane status read three
        // `LIMIT 100` scans including one with no key predicate at all. The
        // fix is a keyed latest read with an explicit tie-break, plus logical
        // coalescing so an unchanged decision advances a counter instead of
        // appending an identical row.
        //
        // NOT swallowed. These columns and indexes are the contract every read
        // and write below depends on; a migration that "completed" without them
        // has left the runaway in place while reporting success.
        // Monotonic generation of a provider connection. A reconnect used to be
        // invisible — connected_at is COALESCEd to the original value, so
        // disconnect-then-reconnect produced a byte-identical row and any
        // evidence bound to "the connection it was captured under" kept
        // validating. NOT swallowed: selection authority refuses when a
        // discovery snapshot is not bound to the current generation, so an
        // absent column would make every selection fail rather than degrade.
        sql`ALTER TABLE provider_connections
          ADD COLUMN IF NOT EXISTS connection_generation BIGINT NOT NULL DEFAULT 1`,
        // Ownership of an in-flight discovery refresh.
        //
        // The claim was `refresh_in_progress = TRUE` and nothing else, so an old
        // claimant whose claim had timed out could still commit its success or
        // its failure over the new owner's work — including stamping the OLD
        // account list with the NEW credential's authority. Owner plus epoch
        // makes every commit a CAS, and the captured generation records which
        // credential the in-flight call is actually using.
        sql`ALTER TABLE provider_account_snapshot_runs
          ADD COLUMN IF NOT EXISTS refresh_claim_owner TEXT`,
        sql`ALTER TABLE provider_account_snapshot_runs
          ADD COLUMN IF NOT EXISTS refresh_claim_epoch BIGINT NOT NULL DEFAULT 0`,
        sql`ALTER TABLE provider_account_snapshot_runs
          ADD COLUMN IF NOT EXISTS refresh_claim_generation TEXT`,
        sql`ALTER TABLE sync_release_gates
          ADD COLUMN IF NOT EXISTS decision_fingerprint TEXT`,
        sql`ALTER TABLE sync_release_gates
          ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ NOT NULL DEFAULT now()`,
        sql`ALTER TABLE sync_release_gates
          ADD COLUMN IF NOT EXISTS coalesced_count INTEGER NOT NULL DEFAULT 1`,
        //
        // The release-gate provider-scope contract, in an ORDER that is
        // load-bearing: the column must exist before it is backfilled, be
        // backfilled before it is made NOT NULL, and be NOT NULL before an index
        // keyed on plain equality means anything.
        //
        // `COALESCE(provider_scope, 'meta')` was a lie about two different kinds
        // of row. A deploy gate is global — one verdict for the deployment, not
        // a Meta fact — so labelling it 'meta' made it unreachable from the
        // Google control plane, which asks for 'google_ads' and got nothing back
        // at all. And a legacy release gate whose provider was never recorded is
        // not a Meta verdict; calling it one lets it answer Meta questions and
        // files it in the Meta retention group.
        //
        // Each row is labelled by what is actually known about it:
        //   deploy gates    -> 'global'   (true by construction of the gate)
        //   release gates   -> evidence_json->>'providerScope' when present
        //   everything else -> 'unknown'  (explicit, never silently Meta)
        //
        // evidence_json is never rewritten, so the ambiguity stays inspectable.
        orderedMigrationSteps([
          // Capacity FIRST. Everything below rewrites or rebuilds a relation
          // that is ~1.35 GB in production, and it ran with no gate at all.
          async () => {
            const decision = await assertMigrationCapacityForHeavyStep(sql, {
              label: "sync_release_gates_provider_scope",
              relation: "sync_release_gates",
            });
            logStartupEvent("migration_capacity_checked", {
              step: "sync_release_gates_provider_scope",
              ...decision,
            });
          },
          () =>
            sql`ALTER TABLE sync_release_gates
              ADD COLUMN IF NOT EXISTS provider_scope TEXT`,
          // 20k-row chunks, each its own transaction: bounded lock duration and
          // bounded WAL per statement instead of one rewrite-sized transaction
          // over a multi-gigabyte relation.
          async () => {
            for (;;) {
              const touched = (await sql.query(
                `UPDATE sync_release_gates
                 SET provider_scope = CASE
                       WHEN gate_kind = 'deploy_gate' THEN 'global'
                       WHEN NULLIF(TRIM(COALESCE(evidence_json->>'providerScope', '')), '')
                            IS NOT NULL
                         THEN TRIM(evidence_json->>'providerScope')
                       ELSE 'unknown'
                     END
                 WHERE id IN (
                   SELECT id FROM sync_release_gates
                   WHERE provider_scope IS NULL
                   LIMIT 20000
                 )
                 RETURNING id`,
              )) as Array<{ id: string }>;
              if (touched.length === 0) break;
            }
          },
          // Deploy-gate rows written by the previous revision of this change
          // went in as 'meta'. They are global gates mislabelled by code, not
          // evidence about a provider, so the same by-kind rule applies.
          () =>
            sql.query(
              `UPDATE sync_release_gates
               SET provider_scope = 'global'
               WHERE gate_kind = 'deploy_gate' AND provider_scope IS DISTINCT FROM 'global'`,
            ),
          () =>
            sql`ALTER TABLE sync_release_gates
              ALTER COLUMN provider_scope SET DEFAULT 'unknown'`,
          () =>
            sql`ALTER TABLE sync_release_gates
              ALTER COLUMN provider_scope SET NOT NULL`,
          // The expression indexes on COALESCE(provider_scope, 'meta') encode
          // the semantics this change removes and cannot serve the plain
          // equality predicate that replaced it. Dropped rather than left as
          // dead weight on a multi-gigabyte relation.
          () =>
            sql`DROP INDEX CONCURRENTLY IF EXISTS idx_sync_release_gates_key_latest`.catch(
              () => {},
            ),
          () =>
            sql`DROP INDEX CONCURRENTLY IF EXISTS idx_sync_release_gates_kind_latest`.catch(
              () => {},
            ),
          () =>
            sql.query(
              buildInvalidIndexRepairQuery({
                indexName: "idx_sync_release_gates_key_latest",
                definitionMustContain: [
                  "build_id, environment, gate_kind, provider_scope, emitted_at DESC, id DESC",
                ],
              }),
            ),
          () =>
            sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_release_gates_key_latest
              ON sync_release_gates (
                build_id, environment, gate_kind, provider_scope, emitted_at DESC, id DESC
              )`.catch(() => {}),
          () =>
            sql.query(
              buildIndexContractQuery({
                indexName: "idx_sync_release_gates_key_latest",
                definitionMustContain: [
                  "build_id, environment, gate_kind, provider_scope, emitted_at DESC, id DESC",
                ],
              }),
            ),
          () =>
            sql.query(
              buildInvalidIndexRepairQuery({
                indexName: "idx_sync_release_gates_kind_latest",
                definitionMustContain: [
                  "gate_kind, provider_scope, environment, emitted_at DESC, id DESC",
                ],
              }),
            ),
          // `environment` is a KEY column here, not a filter: the diagnostic
          // read constrains it, and without it in the index that read walks the
          // kind's whole history discarding other environments.
          () =>
            sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_release_gates_kind_latest
              ON sync_release_gates (
                gate_kind, provider_scope, environment, emitted_at DESC, id DESC
              )`.catch(() => {}),
          () =>
            sql.query(
              buildIndexContractQuery({
                indexName: "idx_sync_release_gates_kind_latest",
                definitionMustContain: [
                  "gate_kind, provider_scope, environment, emitted_at DESC, id DESC",
                ],
              }),
            ),
          // Retention's candidate scan walks the OLDEST rows ascending and stops
          // at the batch limit. `idx_sync_release_gates_emitted` is DESC-only,
          // so it cannot serve that keyset without walking the newest rows
          // first — which is the whole table, every tick.
          () =>
            sql.query(
              buildInvalidIndexRepairQuery({
                indexName: "idx_sync_release_gates_retention_scan",
                definitionMustContain: ["emitted_at, id"],
              }),
            ),
          () =>
            sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_release_gates_retention_scan
              ON sync_release_gates (emitted_at, id)`.catch(() => {}),
          // Dropped only AFTER the replacement exists, so there is no window
          // where retention has no usable index at all.
          () =>
            sql`DROP INDEX CONCURRENTLY IF EXISTS idx_sync_release_gates_emitted`.catch(
              () => {},
            ),
          () =>
            sql.query(
              buildIndexContractQuery({
                indexName: "idx_sync_release_gates_retention_scan",
                definitionMustContain: ["emitted_at, id"],
              }),
            ),
        ]),
        sql`CREATE TABLE IF NOT EXISTS sync_repair_plans (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id            TEXT NOT NULL,
          environment         TEXT NOT NULL,
          provider_scope      TEXT NOT NULL,
          plan_mode           TEXT NOT NULL
                              CHECK (plan_mode IN ('dry_run', 'auto_execute', 'escalated_manual')),
          eligible            BOOLEAN NOT NULL DEFAULT FALSE,
          blocked_reason      TEXT,
          break_glass         BOOLEAN NOT NULL DEFAULT FALSE,
          summary             TEXT NOT NULL,
          payload_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
          emitted_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (build_id, environment, provider_scope, plan_mode)
        )`.catch(() => {}),
        //
        // The repair-plan ON CONFLICT arbiter, made explicit.
        //
        // `persistSyncRepairPlan` writes with
        // `ON CONFLICT (build_id, environment, provider_scope, plan_mode)`, so
        // that unique arbiter has to exist or every write fails with 42P10.
        // The only thing providing it was the table's inline UNIQUE, whose
        // auto-generated name is
        // sync_repair_plans_build_id_environment_provider_scope_plan_mode_key —
        // 67 characters, which PostgreSQL truncates to 63. The DROP CONSTRAINT
        // that used to sit here named the untruncated form, so it silently
        // matched nothing and the arbiter survived BY ACCIDENT. A deployment
        // where that name happened to match would have lost the arbiter and
        // broken every repair-plan write.
        //
        // So: create an explicitly named unique index first, then adopt by
        // dropping whatever auto-named constraint covers exactly the same
        // columns — found by COLUMN SET, never by a guessed name — then verify.
        // The arbiter is never absent at any point in that order.
        // Ordered, because "repair, create, adopt, verify" only means anything in
        // that order — and a batch array issues its statements concurrently.
        orderedMigrationSteps([
        () =>
        sql.query(
          // Asserted as ONE contiguous fragment, not four separate substrings.
          // A same-name UNIQUE index on `(build_id)` alone contains "build_id",
          // "environment" (nowhere), ... — in practice a subset index passed the
          // per-fragment check whenever the missing columns appeared elsewhere in
          // the definition text, and then every production write failed 42P10.
          buildInvalidIndexRepairQuery({
            indexName: "sync_repair_plans_scope_mode_identity",
            definitionMustContain: [
              "UNIQUE",
              "(build_id, environment, provider_scope, plan_mode)",
            ],
          }),
        ),
        () =>
        sql`CREATE UNIQUE INDEX IF NOT EXISTS sync_repair_plans_scope_mode_identity
          ON sync_repair_plans (build_id, environment, provider_scope, plan_mode)`,
        () =>
        sql`DO $sync_repair_plans_adopt_arbiter$
          DECLARE
            legacy_constraint TEXT;
          BEGIN
            SELECT constraint_catalog.conname INTO legacy_constraint
            FROM pg_constraint constraint_catalog
            WHERE constraint_catalog.conrelid = 'sync_repair_plans'::regclass
              AND constraint_catalog.contype = 'u'
              AND constraint_catalog.conname <> 'sync_repair_plans_scope_mode_identity'
              AND (
                SELECT array_agg(attribute.attname::text ORDER BY attribute.attname)
                FROM unnest(constraint_catalog.conkey) AS key(attnum)
                JOIN pg_attribute attribute
                  ON attribute.attrelid = constraint_catalog.conrelid
                 AND attribute.attnum = key.attnum
              ) = ARRAY['build_id','environment','plan_mode','provider_scope']
            LIMIT 1;
            IF legacy_constraint IS NOT NULL THEN
              RAISE NOTICE 'adopting repair-plan arbiter: dropping %', legacy_constraint;
              EXECUTE 'ALTER TABLE sync_repair_plans DROP CONSTRAINT ' ||
                quote_ident(legacy_constraint);
            END IF;
          END
          $sync_repair_plans_adopt_arbiter$`,
        () =>
        sql.query(
          buildIndexContractQuery({
            indexName: "sync_repair_plans_scope_mode_identity",
            definitionMustContain: [
              "UNIQUE",
              "(build_id, environment, provider_scope, plan_mode)",
            ],
          }),
        ),
        // Proof that PostgreSQL will actually INFER this arbiter for the exact
        // unqualified `ON CONFLICT` the writer issues. Catalog shape and arbiter
        // inference are different questions: a partial unique index satisfies
        // every catalog assertion and raises 42P10 here. Rolled back, so it
        // writes nothing.
        () =>
          sql.query(
            `DO $sync_repair_plans_arbiter_readback$
             BEGIN
               BEGIN
                 INSERT INTO sync_repair_plans
                   (build_id, environment, provider_scope, plan_mode, eligible, summary, payload_json)
                 VALUES ('__arbiter_probe__', '__arbiter_probe__', '__arbiter_probe__',
                         'dry_run', FALSE, 'probe', '{}'::jsonb)
                 ON CONFLICT (build_id, environment, provider_scope, plan_mode)
                 DO UPDATE SET summary = EXCLUDED.summary;
               EXCEPTION WHEN OTHERS THEN
                 RAISE EXCEPTION
                   'sync_repair_plans arbiter is not inferable for ON CONFLICT (build_id, environment, provider_scope, plan_mode): % (%)',
                   SQLERRM, SQLSTATE;
               END;
               DELETE FROM sync_repair_plans WHERE build_id = '__arbiter_probe__';
             END
             $sync_repair_plans_arbiter_readback$`,
          ),
        ]),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_plans_build
          ON sync_repair_plans (build_id, environment, provider_scope, emitted_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_plans_provider_latest
          ON sync_repair_plans (provider_scope, emitted_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS sync_repair_executions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id                TEXT NOT NULL,
          environment             TEXT NOT NULL,
          provider_scope          TEXT NOT NULL,
          business_id             TEXT NOT NULL,
          business_name           TEXT,
          source_release_gate_id  UUID,
          source_repair_plan_id   UUID,
          post_run_release_gate_id UUID,
          post_run_repair_plan_id  UUID,
          recommended_action      TEXT,
          executed_action         TEXT,
          workflow_run_id         TEXT,
          workflow_actor          TEXT,
          lock_owner              TEXT,
          execution_signature     TEXT,
          status                  TEXT NOT NULL
                                  CHECK (status IN ('queued', 'running', 'succeeded', 'completed', 'failed', 'exhausted', 'locked')),
          outcome_classification  TEXT
                                  CHECK (
                                    outcome_classification IS NULL OR
                                    outcome_classification IN (
                                      'cleared',
                                      'improving_not_cleared',
                                      'no_change',
                                      'worse',
                                      'manual_follow_up_required',
                                      'locked'
                                    )
                                  ),
          expected_outcome_met    BOOLEAN,
          before_evidence_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
          action_result_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
          after_evidence_json     JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at             TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`ALTER TABLE sync_repair_executions
          ADD COLUMN IF NOT EXISTS post_run_release_gate_id UUID`.catch(
          () => {},
        ),
        sql`ALTER TABLE sync_repair_executions
          ADD COLUMN IF NOT EXISTS post_run_repair_plan_id UUID`.catch(
          () => {},
        ),
        sql`ALTER TABLE sync_repair_executions
          ADD COLUMN IF NOT EXISTS execution_signature TEXT`.catch(() => {}),
        sql`ALTER TABLE sync_repair_plans
          DROP CONSTRAINT IF EXISTS sync_repair_plans_plan_mode_check`.catch(
          () => {},
        ),
        sql`ALTER TABLE sync_repair_plans
          ADD CONSTRAINT sync_repair_plans_plan_mode_check
          CHECK (plan_mode IN ('dry_run', 'auto_execute', 'escalated_manual'))`.catch(
          () => {},
        ),
        sql`ALTER TABLE sync_repair_executions
          DROP CONSTRAINT IF EXISTS sync_repair_executions_status_check`.catch(
          () => {},
        ),
        sql`ALTER TABLE sync_repair_executions
          ADD CONSTRAINT sync_repair_executions_status_check
          CHECK (status IN ('queued', 'running', 'succeeded', 'completed', 'failed', 'exhausted', 'locked'))`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_executions_build
          ON sync_repair_executions (build_id, environment, provider_scope, started_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_executions_business
          ON sync_repair_executions (business_id, provider_scope, started_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_repair_executions_signature
          ON sync_repair_executions (provider_scope, business_id, execution_signature, started_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS sync_incidents (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          build_id             TEXT NOT NULL,
          environment          TEXT NOT NULL,
          provider_scope       TEXT NOT NULL,
          business_id          TEXT NOT NULL,
          resource_scope       TEXT NOT NULL DEFAULT 'business',
          fault_class          TEXT NOT NULL,
          fault_signature      TEXT NOT NULL,
          status               TEXT NOT NULL
                               CHECK (
                                 status IN (
                                   'detected',
                                   'eligible',
                                   'repairing',
                                   'cooldown',
                                   'half_open',
                                   'cleared',
                                   'quarantined',
                                   'exhausted',
                                   'manual_required'
                                 )
                               ),
          blocker_class        TEXT,
          summary              TEXT NOT NULL,
          observation_count    INTEGER NOT NULL DEFAULT 1,
          first_seen_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_seen_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          eligible_at          TIMESTAMPTZ,
          repairing_at         TIMESTAMPTZ,
          cooldown_until       TIMESTAMPTZ,
          half_open_at         TIMESTAMPTZ,
          cleared_at           TIMESTAMPTZ,
          quarantined_at       TIMESTAMPTZ,
          exhausted_at         TIMESTAMPTZ,
          manual_required_at   TIMESTAMPTZ,
          last_error           TEXT,
          evidence_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
          metadata_json        JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (provider_scope, business_id, resource_scope, fault_class, fault_signature)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_incidents_active
          ON sync_incidents (build_id, environment, provider_scope, business_id, status, last_seen_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_sync_incidents_fault
          ON sync_incidents (provider_scope, business_id, resource_scope, fault_class, fault_signature, last_seen_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_sync_state (
          business_id                   TEXT NOT NULL,
          provider_account_id           TEXT NOT NULL,
          scope                         TEXT NOT NULL,
          historical_target_start       DATE NOT NULL,
          historical_target_end         DATE NOT NULL,
          effective_target_start        DATE NOT NULL,
          effective_target_end          DATE NOT NULL,
          ready_through_date            DATE,
          last_successful_partition_date DATE,
          latest_background_activity_at TIMESTAMPTZ,
          latest_successful_sync_at     TIMESTAMPTZ,
          completed_days                INTEGER NOT NULL DEFAULT 0,
          dead_letter_count             INTEGER NOT NULL DEFAULT 0,
          updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_sync_state_business
          ON meta_sync_state (business_id, scope, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_raw_snapshots (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          partition_id         UUID REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          checkpoint_id        UUID REFERENCES meta_sync_checkpoints(id) ON DELETE SET NULL,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL DEFAULT 'account',
          page_index           INTEGER,
          provider_cursor      TEXT,
          start_date           DATE NOT NULL,
          end_date             DATE NOT NULL,
          account_timezone     TEXT,
          account_currency     TEXT,
          payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          payload_hash         TEXT NOT NULL,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_http_status INTEGER,
          status               TEXT NOT NULL DEFAULT 'fetched'
                               CHECK (status IN ('fetched', 'partial', 'failed')),
          fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`DO $$
          BEGIN
            IF EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'meta_raw_snapshots'::regclass
                AND conname = 'meta_raw_snapshots_status_check'
                AND pg_get_constraintdef(oid) NOT ILIKE '%superseded%'
            ) THEN
              ALTER TABLE meta_raw_snapshots
                DROP CONSTRAINT meta_raw_snapshots_status_check;
              ALTER TABLE meta_raw_snapshots
                ADD CONSTRAINT meta_raw_snapshots_status_check
                CHECK (status IN ('fetched', 'partial', 'failed', 'superseded'));
            ELSIF NOT EXISTS (
              SELECT 1
              FROM pg_constraint
              WHERE conrelid = 'meta_raw_snapshots'::regclass
                AND conname = 'meta_raw_snapshots_status_check'
            ) THEN
              ALTER TABLE meta_raw_snapshots
                ADD CONSTRAINT meta_raw_snapshots_status_check
                CHECK (status IN ('fetched', 'partial', 'failed', 'superseded'));
            END IF;
          END $$`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_business ON meta_raw_snapshots (business_id, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_account ON meta_raw_snapshots (provider_account_id, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_window ON meta_raw_snapshots (business_id, provider_account_id, start_date, end_date)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_endpoint ON meta_raw_snapshots (endpoint_name, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_raw_snapshots_retention
          ON meta_raw_snapshots (fetched_at ASC, id ASC, partition_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_partition_endpoint
          ON meta_raw_snapshots (partition_id, endpoint_name, page_index)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_system_capacity_snapshots_source_sampled
          ON system_capacity_snapshots (source, sampled_at DESC)`.catch(
          () => {},
        ),
        // Deterministic ordering for the growth fence's physical-capacity read.
        // The fence orders by (sampled_at DESC, id DESC) so two samples written
        // in the same millisecond resolve to ONE row rather than to whichever
        // the planner returns; the weaker (source, sampled_at DESC) index cannot
        // supply that tiebreak. Deliberately NOT `.catch(() => {})`: the fence
        // refuses to admit any write without this read, so a silently missing
        // index is a silently degraded safety gate. It is also asserted by
        // `verifyMigrationSchemaContract`.
        sql`CREATE INDEX IF NOT EXISTS idx_system_capacity_snapshots_source_sampled_id
          ON system_capacity_snapshots (source, sampled_at DESC, id DESC)`,
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS partition_id UUID REFERENCES meta_sync_partitions(id) ON DELETE CASCADE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS checkpoint_id UUID REFERENCES meta_sync_checkpoints(id) ON DELETE SET NULL`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS run_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS page_index INTEGER`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS provider_cursor TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_raw_snapshots ADD COLUMN IF NOT EXISTS response_headers JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshots_partition_run_endpoint
          ON meta_raw_snapshots (partition_id, run_id, endpoint_name, page_index)`.catch(
          () => {},
        ),
        // ── Two-layer content + observation model ──────────────────────────
        //
        // The snapshot table records the SAME payload thousands of times. It is
        // the single largest table in the database, and collapsing repeats to
        // one row per distinct observed payload is only safe if that row still
        // answers everything the duplicates answered: when the content was
        // FIRST seen, when it was LAST seen, and how many times. Overwriting
        // `fetched_at` would destroy first-observation time and with it exact
        // point-in-time visibility, so `fetched_at` is never touched after
        // insert and the new columns carry the heartbeat instead.
        sql`ALTER TABLE meta_raw_snapshots
          ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots
          ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_raw_snapshots
          ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        // Deliberately NOT backfilled. An UPDATE across the whole table would
        // rewrite every heap page of the largest relation in the database for
        // no read benefit. Legacy rows keep NULL observation columns and are
        // read through the legacy-compatibility path, which treats a row with
        // no receipts as a single self-observation at its own `fetched_at` —
        // exactly what such a row already was.
        //
        // Layer 1: one immutable canonical row per distinct payload CONTENT.
        // Its identity deliberately excludes partition_id, run_id and
        // checkpoint_id — those describe an observation, not the content — but
        // includes every scope field needed to stop cross-business, account,
        // endpoint, date or page collisions.
        //
        // `content_key` is set only by NEW writes. Legacy rows keep NULL, so
        // the partial unique index cannot collide with the existing duplicate
        // rows and no table rewrite is required. Legacy cleanup stays a
        // separate, blocked, dry-run-only concern.
        sql`ALTER TABLE meta_raw_snapshots
          ADD COLUMN IF NOT EXISTS content_key TEXT`.catch(() => {}),
        // CONCURRENTLY: this builds a unique index on a multi-gigabyte relation.
        // A plain CREATE INDEX takes ACCESS EXCLUSIVE for the whole build and
        // would stall every reader and writer of meta_raw_snapshots for the
        // duration. Repair first, because IF NOT EXISTS matches on name alone
        // and an interrupted CONCURRENTLY build leaves an INVALID index that it
        // silently accepts; then verify, because an index this migration is
        // responsible for either exists usable or the migration has not
        // succeeded.
        sql.query(
          buildInvalidIndexRepairQuery({
            indexName: "meta_raw_snapshots_content_identity",
            definitionMustContain: ["(content_key)", "WHERE (content_key IS NOT NULL)"],
          }),
        ),
        sql`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS meta_raw_snapshots_content_identity
          ON meta_raw_snapshots (content_key)
          WHERE content_key IS NOT NULL`.catch(() => {}),
        sql.query(
          buildIndexContractQuery({
            indexName: "meta_raw_snapshots_content_identity",
            definitionMustContain: ["(content_key)", "WHERE (content_key IS NOT NULL)"],
          }),
        ),
        //
        // Layer 2: the append-only observation receipt. This is what preserves
        // per-partition completion evidence once content is shared. The FK to
        // canonical content is RESTRICT, never SET NULL: content that still has
        // receipts must not be deletable, and provenance must never silently
        // become NULL.
        sql`CREATE TABLE IF NOT EXISTS meta_raw_snapshot_observations (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_id          UUID NOT NULL
                               REFERENCES meta_raw_snapshots(id) ON DELETE RESTRICT,
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          -- CASCADE, not SET NULL: deleting a partition removes only ITS
          -- receipts. Shared canonical content and every other partition's
          -- evidence survive. SET NULL would additionally collide two receipts
          -- that differ only by partition onto one identity.
          partition_id         UUID REFERENCES meta_sync_partitions(id) ON DELETE CASCADE,
          -- TEXT to match meta_raw_snapshots.run_id, which is TEXT. A UUID
          -- column here would fail on any non-UUID run id already in use.
          run_id               TEXT,
          checkpoint_id        UUID,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL,
          page_index           INTEGER,
          provider_cursor      TEXT,
          status               TEXT NOT NULL,
          provider_http_status INTEGER,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          observed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          first_observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          observation_count    INTEGER NOT NULL DEFAULT 1,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        // Receipt identity includes observed_at, so every distinct observation
        // INSTANT is its own row. That is what makes arbitrary point-in-time
        // exact: with content A observed at t1, B at t2 and A again at t3,
        // collapsing the two A observations into one receipt would leave the
        // timeline unable to answer t1.5 and t3.5 differently. Receipts carry
        // no payload, so this is bounded — the bulk is payload content, which
        // is now shared.
        //
        // A genuine duplicate — the same observation replayed at the same
        // instant, e.g. a retried write — still heartbeats instead of
        // appending.
        sql`CREATE UNIQUE INDEX IF NOT EXISTS meta_raw_snapshot_observations_identity
          ON meta_raw_snapshot_observations (
            snapshot_id,
            COALESCE(partition_id, '00000000-0000-0000-0000-000000000000'::uuid),
            COALESCE(run_id, ''),
            COALESCE(checkpoint_id, '00000000-0000-0000-0000-000000000000'::uuid),
            COALESCE(page_index, -1),
            COALESCE(provider_cursor, ''),
            status,
            observed_at
          )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshot_observations_retention
          ON meta_raw_snapshot_observations (observed_at ASC, id ASC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshot_observations_timeline
          ON meta_raw_snapshot_observations (
            business_id, provider_account_id, endpoint_name, observed_at DESC
          )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshot_observations_snapshot
          ON meta_raw_snapshot_observations (snapshot_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_raw_snapshot_observations_partition
          ON meta_raw_snapshot_observations (partition_id, run_id, endpoint_name, page_index)
          WHERE partition_id IS NOT NULL`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_account_daily (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          date                 DATE NOT NULL,
          account_name         TEXT,
          account_timezone     TEXT NOT NULL,
          account_currency     TEXT NOT NULL,
          spend                DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions          BIGINT NOT NULL DEFAULT 0,
          clicks               BIGINT NOT NULL DEFAULT 0,
          reach                BIGINT NOT NULL DEFAULT 0,
          frequency            DOUBLE PRECISION,
          conversions          DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue              DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                 DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                  DOUBLE PRECISION,
          ctr                  DOUBLE PRECISION,
          cpc                  DOUBLE PRECISION,
          source_snapshot_id   UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_account_daily_business_date ON meta_account_daily (business_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_account_daily_account_date ON meta_account_daily (provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_account_daily_business_account_date
          ON meta_account_daily (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_account_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_daily (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          date                    DATE NOT NULL,
          campaign_id             TEXT NOT NULL,
          campaign_name_current   TEXT,
          campaign_name_historical TEXT,
          campaign_status         TEXT,
          objective               TEXT,
          buying_type             TEXT,
          optimization_goal       TEXT,
          custom_event_type       TEXT,
          bid_strategy_type       TEXT,
          bid_value               DOUBLE PRECISION,
          bid_value_format        TEXT,
          daily_budget            DOUBLE PRECISION,
          lifetime_budget         DOUBLE PRECISION,
          is_budget_mixed         BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed         BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_custom_event_type_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed   BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed      BOOLEAN NOT NULL DEFAULT FALSE,
          account_timezone        TEXT NOT NULL,
          account_currency        TEXT NOT NULL,
          spend                   DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions             BIGINT NOT NULL DEFAULT 0,
          clicks                  BIGINT NOT NULL DEFAULT 0,
          reach                   BIGINT NOT NULL DEFAULT 0,
          frequency               DOUBLE PRECISION,
          conversions             DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue                 DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                    DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                     DOUBLE PRECISION,
          ctr                     DOUBLE PRECISION,
          cpc                     DOUBLE PRECISION,
          source_snapshot_id      UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          metric_schema_version   INTEGER NOT NULL DEFAULT 1,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, campaign_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_business_date ON meta_campaign_daily (business_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_account_date ON meta_campaign_daily (provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_campaign ON meta_campaign_daily (campaign_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_business_account_date
          ON meta_campaign_daily (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_daily_business_date_campaign
          ON meta_campaign_daily (business_id, date DESC, campaign_id)`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS optimization_goal TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS custom_event_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS bid_strategy_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS bid_value DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS bid_value_format TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS daily_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS lifetime_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_budget_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_config_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_custom_event_type_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_bid_strategy_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS is_bid_value_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_adset_daily (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          date                 DATE NOT NULL,
          campaign_id          TEXT,
          adset_id             TEXT NOT NULL,
          adset_name_current   TEXT,
          adset_name_historical TEXT,
          adset_status         TEXT,
          optimization_goal    TEXT,
          custom_event_type    TEXT,
          pixel_id             TEXT,
          custom_conversion_id TEXT,
          promoted_object_json JSONB,
          bid_strategy_type    TEXT,
          bid_value            DOUBLE PRECISION,
          bid_value_format     TEXT,
          daily_budget         DOUBLE PRECISION,
          lifetime_budget      DOUBLE PRECISION,
          is_budget_mixed      BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed      BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed   BOOLEAN NOT NULL DEFAULT FALSE,
          account_timezone     TEXT NOT NULL,
          account_currency     TEXT NOT NULL,
          spend                DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions          BIGINT NOT NULL DEFAULT 0,
          clicks               BIGINT NOT NULL DEFAULT 0,
          reach                BIGINT NOT NULL DEFAULT 0,
          frequency            DOUBLE PRECISION,
          conversions          DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue              DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                 DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                  DOUBLE PRECISION,
          ctr                  DOUBLE PRECISION,
          cpc                  DOUBLE PRECISION,
          source_snapshot_id   UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, adset_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_business_date ON meta_adset_daily (business_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_account_date ON meta_adset_daily (provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_adset ON meta_adset_daily (adset_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_business_account_date
          ON meta_adset_daily (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_daily_business_date_adset
          ON meta_adset_daily (business_id, date DESC, adset_id)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_decision_snapshots_daily (
          scope_type          TEXT NOT NULL CHECK (scope_type IN ('account', 'campaign', 'adset')),
          scope_id            TEXT NOT NULL,
          business_id         TEXT NOT NULL,
          snapshot_date       DATE NOT NULL,
          rec_id              TEXT NOT NULL,
          rec_type            TEXT NOT NULL,
          level               TEXT NOT NULL,
          decision_state      TEXT NOT NULL CHECK (decision_state IN ('act', 'test', 'watch')),
          confidence_score    NUMERIC CHECK (confidence_score BETWEEN 0 AND 1),
          evidence            JSONB NOT NULL DEFAULT '{}'::jsonb,
          recommended_action  TEXT NOT NULL,
          target_value        JSONB,
          expected_impact     TEXT,
          reasoning           TEXT NOT NULL,
          predictive_overlay  TEXT,
          engine_version      TEXT NOT NULL,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (scope_type, scope_id, snapshot_date, rec_type)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_decision_snapshots_daily_business_date
          ON meta_decision_snapshots_daily (business_id, snapshot_date)`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS kind TEXT NOT NULL DEFAULT 'recommendation'
          CHECK (kind IN ('recommendation', 'anomaly'))`.catch(() => {}),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS severity TEXT
          CHECK (severity IS NULL OR severity IN ('high', 'medium', 'low'))`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS diagnostics JSONB NOT NULL DEFAULT '[]'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS detected_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS resolved_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS evidence_trail JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS campaign_role TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS bid_regime TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS decision_label TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS state_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS calibration_scope JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS signal_quality JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_decision_snapshots_daily
          ALTER COLUMN confidence_score DROP NOT NULL`.catch(() => {}),
        sql`UPDATE meta_decision_snapshots_daily
          SET confidence_score = NULL
          WHERE kind = 'recommendation'
            AND confidence_score = 0.4
            AND evidence->'recommendation'->'confidenceScore' IS NULL`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_entity_decision_signals_daily (
          business_id TEXT NOT NULL,
          provider_account_id TEXT,
          scope_type TEXT NOT NULL CHECK (scope_type IN ('campaign', 'adset')),
          scope_id TEXT NOT NULL,
          as_of_date DATE NOT NULL,
          learning_state TEXT,
          days_at_learning_state INTEGER,
          last_significant_edit_at TIMESTAMPTZ,
          recent_change_cooldown_until TIMESTAMPTZ,
          audience_overlap_pct DOUBLE PRECISION,
          audience_size BIGINT,
          lookalike_pct DOUBLE PRECISION,
          audience_stage TEXT,
          creative_age_days INTEGER,
          creative_age_days_max INTEGER,
          frequency_p80 DOUBLE PRECISION,
          ctr_decay_pct DOUBLE PRECISION,
          days_since_significant_edit INTEGER,
          feed_disapproval_count INTEGER,
          feed_status TEXT,
          dedup_rate_pct DOUBLE PRECISION,
          meta_to_crm_ratio DOUBLE PRECISION,
          tracking_quality_status TEXT,
          source_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          quality_status TEXT NOT NULL DEFAULT 'missing'
            CHECK (quality_status IN ('ready', 'partial', 'missing', 'stale', 'unsupported')),
          computed_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, scope_type, scope_id, as_of_date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_decision_signals_business_date
          ON meta_entity_decision_signals_daily (business_id, as_of_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_decision_signals_scope_date
          ON meta_entity_decision_signals_daily (scope_type, scope_id, as_of_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_decision_signals_quality
          ON meta_entity_decision_signals_daily (business_id, as_of_date DESC, quality_status)`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_entity_decision_signals_daily
          ADD COLUMN IF NOT EXISTS creative_age_days_max INTEGER`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_entity_decision_signals_daily
          ADD COLUMN IF NOT EXISTS days_since_significant_edit INTEGER`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_decision_calibration_daily (
          business_id   TEXT NOT NULL,
          scope_type    TEXT NOT NULL CHECK (scope_type IN ('account', 'campaign')),
          scope_id      TEXT NOT NULL,
          snapshot_date DATE NOT NULL,
          metric_name   TEXT NOT NULL,
          cohort        TEXT NOT NULL DEFAULT 'purchase',
          campaign_kind TEXT NOT NULL DEFAULT 'all'
            CHECK (campaign_kind IN ('all', 'main', 'test', 'mixed')),
          p10           NUMERIC NOT NULL,
          p25           NUMERIC NOT NULL,
          p50           NUMERIC NOT NULL,
          p75           NUMERIC NOT NULL,
          p90           NUMERIC NOT NULL,
          sample_size   INTEGER NOT NULL,
          PRIMARY KEY (business_id, scope_type, scope_id, snapshot_date, metric_name, cohort, campaign_kind)
        )`.catch(() => {}),
        sql`ALTER TABLE meta_decision_calibration_daily
          ADD COLUMN IF NOT EXISTS cohort TEXT NOT NULL DEFAULT 'purchase'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_decision_calibration_daily
          ADD COLUMN IF NOT EXISTS campaign_kind TEXT NOT NULL DEFAULT 'all'`.catch(
          () => {},
        ),
        sql`UPDATE meta_decision_calibration_daily
          SET cohort = 'purchase'
          WHERE cohort IS NULL`.catch(() => {}),
        sql`UPDATE meta_decision_calibration_daily
          SET campaign_kind = 'all'
          WHERE campaign_kind IS NULL`.catch(() => {}),
        sql`ALTER TABLE meta_decision_calibration_daily
          ADD CONSTRAINT meta_decision_calibration_daily_campaign_kind_check
          CHECK (campaign_kind IN ('all', 'main', 'test', 'mixed'))`.catch(
          () => {},
        ),
        sql`DO $$
          DECLARE
            current_pk_name TEXT;
            current_pk_columns TEXT[];
            desired_pk_columns CONSTANT TEXT[] := ARRAY[
              'business_id',
              'scope_type',
              'scope_id',
              'snapshot_date',
              'metric_name',
              'cohort',
              'campaign_kind'
            ];
          BEGIN
            SELECT
              c.conname,
              array_agg(a.attname::text ORDER BY u.ord)
            INTO current_pk_name, current_pk_columns
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            JOIN unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord) ON true
            JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
            WHERE n.nspname = current_schema()
              AND t.relname = 'meta_decision_calibration_daily'
              AND c.contype = 'p'
            GROUP BY c.conname;

            IF current_pk_columns IS DISTINCT FROM desired_pk_columns THEN
              PERFORM set_config('lock_timeout', '2000ms', true);
              IF current_pk_name IS NOT NULL THEN
                EXECUTE format(
                  'ALTER TABLE meta_decision_calibration_daily DROP CONSTRAINT %I',
                  current_pk_name
                );
              END IF;

              ALTER TABLE meta_decision_calibration_daily
                ADD PRIMARY KEY (business_id, scope_type, scope_id, snapshot_date, metric_name, cohort, campaign_kind);
            END IF;
          END
          $$`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_calibration_cohort_scope
          ON meta_decision_calibration_daily (business_id, scope_type, scope_id, snapshot_date, cohort, campaign_kind)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_decision_responses (
          rec_id         TEXT NOT NULL,
          business_id    TEXT NOT NULL,
          action         TEXT NOT NULL CHECK (action IN ('acted', 'deferred', 'undeferred', 'ignored')),
          action_subtype TEXT,
          timestamp      TIMESTAMPTZ NOT NULL DEFAULT now(),
          reappear_at    TIMESTAMPTZ,
          PRIMARY KEY (rec_id, action, timestamp)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_decision_responses_business_timestamp
          ON meta_decision_responses (business_id, timestamp)`.catch(() => {}),
        // Operator workflow overlay. This records who owns a decision and what
        // they did about it. It is deliberately separate from engine truth: no
        // column here can change a decision's label, authority, or provider
        // eligibility, and nothing in the engine reads it.
        sql`CREATE TABLE IF NOT EXISTS decision_workflow_state (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          business_ref_id      UUID REFERENCES businesses(id) ON DELETE CASCADE,
          provider_account_id  TEXT,
          entity_type          TEXT NOT NULL,
          entity_id            TEXT NOT NULL,
          decision_key         TEXT NOT NULL,
          state                TEXT NOT NULL DEFAULT 'open' CHECK (state IN (
                                 'open','acknowledged','deferred','snoozed','rejected','resolved'
                               )),
          assignee_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
          due_at               TIMESTAMPTZ,
          snooze_until         TIMESTAMPTZ,
          reason_code          TEXT,
          state_version        INTEGER NOT NULL DEFAULT 1,
          updated_by_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, decision_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_decision_workflow_state_business_state
          ON decision_workflow_state (business_id, state, updated_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_decision_workflow_state_assignee
          ON decision_workflow_state (assignee_user_id, state)`.catch(() => {}),
        // Append-only journal. Rolling the overlay back hides the controls but
        // never destroys the record of what an operator decided.
        sql`CREATE TABLE IF NOT EXISTS decision_workflow_events (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        TEXT NOT NULL,
          decision_key       TEXT NOT NULL,
          event              TEXT NOT NULL,
          from_state         TEXT,
          to_state           TEXT,
          assignee_user_id   UUID REFERENCES users(id) ON DELETE SET NULL,
          reason_code        TEXT,
          comment            TEXT,
          actor_user_id      UUID REFERENCES users(id) ON DELETE SET NULL,
          state_version      INTEGER NOT NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_decision_workflow_events_decision
          ON decision_workflow_events (business_id, decision_key, created_at DESC)`.catch(() => {}),
        // Notification ledger. Every event that was worth telling someone about
        // is recorded here whether or not a channel ever carried it, so the
        // product can never report "notified" without evidence of delivery.
        sql`CREATE TABLE IF NOT EXISTS notification_events (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          business_ref_id      UUID REFERENCES businesses(id) ON DELETE CASCADE,
          provider_account_id  TEXT,
          event_type           TEXT NOT NULL,
          severity             TEXT NOT NULL CHECK (severity IN ('critical','warning','info')),
          entity_type          TEXT,
          entity_id            TEXT,
          source_kind          TEXT NOT NULL,
          source_id            TEXT NOT NULL,
          occurred_on          DATE NOT NULL,
          dedupe_key           TEXT NOT NULL,
          deep_link            TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (dedupe_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_notification_events_business_created
          ON notification_events (business_id, created_at DESC)`.catch(() => {}),
        // Delivery attempts are separate from the event: one event may be
        // attempted several times across channels, and queued is not delivered.
        sql`CREATE TABLE IF NOT EXISTS notification_deliveries (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          notification_event_id UUID NOT NULL REFERENCES notification_events(id) ON DELETE CASCADE,
          recipient_user_id     UUID REFERENCES users(id) ON DELETE SET NULL,
          channel               TEXT NOT NULL,
          state                 TEXT NOT NULL DEFAULT 'queued' CHECK (state IN (
                                  'queued','attempted','delivered','failed','suppressed','acknowledged'
                                )),
          suppression_reason    TEXT,
          attempts              INTEGER NOT NULL DEFAULT 0,
          failure_reason        TEXT,
          queued_at             TIMESTAMPTZ NOT NULL DEFAULT now(),
          attempted_at          TIMESTAMPTZ,
          delivered_at          TIMESTAMPTZ,
          failed_at             TIMESTAMPTZ,
          opened_at             TIMESTAMPTZ,
          acknowledged_at       TIMESTAMPTZ,
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_notification_deliveries_state
          ON notification_deliveries (state, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_decision_action_outcome_logs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          recommendation_fingerprint TEXT NOT NULL,
          rec_id                     TEXT,
          rec_type                   TEXT,
          decision_label             TEXT,
          decision_family            TEXT,
          action_type                TEXT NOT NULL
                                     CHECK (action_type IN ('operator_response', 'preflight', 'execute', 'rollback', 'outcome')),
          outcome_status             TEXT,
          summary                    TEXT NOT NULL,
          payload_json               JSONB NOT NULL DEFAULT '{}'::jsonb,
          occurred_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_decision_action_outcome_logs_business
          ON meta_decision_action_outcome_logs (business_id, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_decision_action_outcome_logs_recommendation
          ON meta_decision_action_outcome_logs (recommendation_fingerprint, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_decision_action_outcome_logs_rec
          ON meta_decision_action_outcome_logs (business_id, rec_id, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_labels (
          business_id         TEXT NOT NULL,
          campaign_id         TEXT NOT NULL,
          provider_account_id TEXT,
          campaign_name       TEXT,
          campaign_kind       TEXT NOT NULL
            CHECK (campaign_kind IN ('main', 'test', 'mixed')),
          test_dimension      TEXT
            CHECK (
              test_dimension IS NULL OR
              test_dimension IN ('creative', 'audience', 'bid', 'offer', 'structure', 'other')
            ),
          source              TEXT NOT NULL DEFAULT 'user'
            CHECK (source IN ('user', 'bulk_apply_confirmed')),
          labeled_by          TEXT,
          labeled_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, campaign_id),
          CHECK (campaign_kind = 'test' OR test_dimension IS NULL)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_labels_business_kind
          ON meta_campaign_labels (business_id, campaign_kind, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_labels_account
          ON meta_campaign_labels (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_provider_accounts_id_external
          ON provider_accounts (id, external_account_id)`,
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_business_provider_accounts_binding
          ON business_provider_accounts (business_id, provider_account_ref_id, provider_account_id)`,
        sql`CREATE TABLE IF NOT EXISTS meta_entity_observation_runs (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          contract_version          TEXT NOT NULL DEFAULT 'meta-entity-observation.v1'
                                    CHECK (length(btrim(contract_version)) > 0),
          business_ref_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
          business_id               TEXT NOT NULL CHECK (length(btrim(business_id)) > 0),
          provider_account_ref_id   UUID NOT NULL,
          provider_account_id       TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
          entity_type               TEXT NOT NULL
                                    CHECK (entity_type IN ('campaign', 'adset', 'ad', 'creative')),
          endpoint                  TEXT NOT NULL CHECK (length(btrim(endpoint)) > 0),
          observed_at               TIMESTAMPTZ NOT NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          completeness              TEXT NOT NULL
                                    CHECK (completeness IN ('complete', 'partial', 'point_lookup', 'failed')),
          page_count                INTEGER NOT NULL DEFAULT 0 CHECK (page_count >= 0),
          row_count                 INTEGER NOT NULL DEFAULT 0 CHECK (row_count >= 0),
          source_snapshot_id        TEXT,
          payload_hash              CHAR(64)
                                    CHECK (payload_hash IS NULL OR payload_hash ~ '^[0-9a-f]{64}$'),
          run_hash                  CHAR(64) NOT NULL CHECK (run_hash ~ '^[0-9a-f]{64}$'),
          error_json                JSONB
                                    CHECK (error_json IS NULL OR jsonb_typeof(error_json) = 'object'),
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT meta_entity_observation_runs_business_identity_check
            CHECK (business_id = business_ref_id::text),
          CONSTRAINT meta_entity_observation_runs_account_fk FOREIGN KEY (
            provider_account_ref_id,
            provider_account_id
          ) REFERENCES provider_accounts (id, external_account_id) ON DELETE RESTRICT,
          CONSTRAINT meta_entity_observation_runs_binding_fk FOREIGN KEY (
            business_id,
            provider_account_ref_id,
            provider_account_id
          ) REFERENCES business_provider_accounts (
            business_id,
            provider_account_ref_id,
            provider_account_id
          ) ON DELETE RESTRICT,
          CONSTRAINT meta_entity_observation_runs_time_check
            CHECK (captured_at >= observed_at),
          CONSTRAINT meta_entity_observation_runs_failure_check
            CHECK (completeness <> 'failed' OR error_json IS NOT NULL),
          CONSTRAINT meta_entity_observation_runs_hash_unique UNIQUE (run_hash),
          CONSTRAINT meta_entity_observation_runs_lineage_unique UNIQUE (
            id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            entity_type,
            observed_at,
            captured_at,
            completeness
          ),
          CONSTRAINT meta_entity_observation_runs_capture_lineage_unique UNIQUE (
            id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            entity_type,
            captured_at,
            completeness
          )
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_observation_runs_asof
          ON meta_entity_observation_runs
          (business_id, provider_account_id, entity_type, observed_at DESC, captured_at DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_observation_runs_refs
          ON meta_entity_observation_runs
          (business_ref_id, provider_account_ref_id, entity_type, observed_at DESC)`,
        //
        // Semantic heartbeat for observation runs.
        //
        // `run_hash` includes observed_at and captured_at, so replaying the same
        // provider truth one second later was a different run — and every run
        // writes a full state set. That is the remaining structural source of
        // meta_entity_state_history growth: identical inventory, observed
        // repeatedly, stored in full every time.
        //
        // `semantic_hash` covers the truth (entity states, completeness and the
        // decision-relevant scope) with NO clocks in it, so repeated identical
        // truth is recognisable as repeated. NOT swallowed: the coalescing
        // writer cannot function without these.
        sql`ALTER TABLE meta_entity_observation_runs
          ADD COLUMN IF NOT EXISTS semantic_hash TEXT`,
        sql`ALTER TABLE meta_entity_observation_runs
          ADD COLUMN IF NOT EXISTS last_seen_at TIMESTAMPTZ`,
        sql`ALTER TABLE meta_entity_observation_runs
          ADD COLUMN IF NOT EXISTS repeat_count INTEGER NOT NULL DEFAULT 1`,
        sql`ALTER TABLE meta_entity_observation_runs
          ADD COLUMN IF NOT EXISTS last_checkpoint_at TIMESTAMPTZ`,
        sql.query(
          buildInvalidIndexRepairQuery({
            indexName: "idx_meta_entity_observation_runs_semantic_latest",
            definitionMustContain: [
              "business_id",
              "provider_account_id",
              "entity_type",
              "endpoint",
              "observed_at DESC",
              "id DESC",
            ],
          }),
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_entity_observation_runs_semantic_latest
          ON meta_entity_observation_runs
          (business_id, provider_account_id, entity_type, endpoint, observed_at DESC, id DESC)`.catch(
          () => {},
        ),
        sql.query(
          buildIndexContractQuery({
            indexName: "idx_meta_entity_observation_runs_semantic_latest",
            definitionMustContain: [
              "business_id",
              "provider_account_id",
              "entity_type",
              "endpoint",
              "observed_at DESC",
              "id DESC",
            ],
          }),
        ),
        sql`DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_entity_observation_runs'::regclass
                AND conname = 'meta_entity_observation_runs_capture_lineage_unique'
            ) THEN
              ALTER TABLE meta_entity_observation_runs
                ADD CONSTRAINT meta_entity_observation_runs_capture_lineage_unique
                UNIQUE (
                  id, business_ref_id, business_id, provider_account_ref_id,
                  provider_account_id, entity_type, captured_at, completeness
                );
            END IF;
          END
          $$`,
        sql`CREATE TABLE IF NOT EXISTS meta_entity_state_history (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          run_id                    UUID NOT NULL,
          business_ref_id           UUID NOT NULL,
          business_id               TEXT NOT NULL CHECK (length(btrim(business_id)) > 0),
          provider_account_ref_id   UUID NOT NULL,
          provider_account_id       TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
          entity_type               TEXT NOT NULL
                                    CHECK (entity_type IN ('campaign', 'adset', 'ad', 'creative')),
          entity_id                 TEXT NOT NULL CHECK (length(btrim(entity_id)) > 0),
          campaign_id               TEXT,
          adset_id                  TEXT,
          ad_id                     TEXT,
          creative_id               TEXT,
          entity_name               TEXT,
          configured_status         TEXT,
          effective_status          TEXT,
          learning_status           TEXT,
          learning_source           TEXT NOT NULL DEFAULT 'not_observed'
                                    CHECK (learning_source IN ('provider', 'inferred', 'not_observed')),
          campaign_daily_budget_raw TEXT,
          campaign_lifetime_budget_raw TEXT,
          adset_daily_budget_raw    TEXT,
          adset_lifetime_budget_raw TEXT,
          budget_currency           TEXT,
          budget_origin             TEXT NOT NULL DEFAULT 'not_observed'
                                    CHECK (budget_origin IN ('campaign', 'adset', 'not_observed', 'not_applicable')),
          review_status             TEXT,
          policy_status             TEXT,
          policy_reasons_json       JSONB
                                    CHECK (policy_reasons_json IS NULL OR jsonb_typeof(policy_reasons_json) = 'array'),
          provider_updated_at       TIMESTAMPTZ,
          presence                  TEXT NOT NULL
                                    CHECK (presence IN ('present', 'absent_unconfirmed')),
          field_coverage_json       JSONB NOT NULL DEFAULT '{}'::jsonb
                                    CHECK (jsonb_typeof(field_coverage_json) = 'object'),
          observed_at               TIMESTAMPTZ NOT NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          run_completeness          TEXT NOT NULL
                                    CHECK (run_completeness IN ('complete', 'partial', 'point_lookup')),
          state_hash                CHAR(64) NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT meta_entity_state_history_run_fk FOREIGN KEY (
            run_id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            entity_type,
            captured_at,
            run_completeness
          ) REFERENCES meta_entity_observation_runs (
            id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            entity_type,
            captured_at,
            completeness
          ) ON DELETE RESTRICT,
          CONSTRAINT meta_entity_state_history_entity_identity_check CHECK (
            (entity_type = 'campaign' AND campaign_id IS NOT NULL AND campaign_id = entity_id) OR
            (entity_type = 'adset' AND campaign_id IS NOT NULL AND adset_id IS NOT NULL AND adset_id = entity_id) OR
            (entity_type = 'ad' AND campaign_id IS NOT NULL AND adset_id IS NOT NULL AND ad_id IS NOT NULL AND ad_id = entity_id) OR
            (entity_type = 'creative' AND creative_id IS NOT NULL AND creative_id = entity_id)
          ),
          CONSTRAINT meta_entity_state_history_learning_check CHECK (
            (learning_source = 'not_observed' AND learning_status IS NULL) OR
            (learning_source IN ('provider', 'inferred') AND learning_status IS NOT NULL)
          ),
          CONSTRAINT meta_entity_state_history_budget_check CHECK (
            (budget_origin = 'campaign' AND (
              campaign_daily_budget_raw IS NOT NULL OR campaign_lifetime_budget_raw IS NOT NULL
            )) OR
            (budget_origin = 'adset' AND (
              adset_daily_budget_raw IS NOT NULL OR adset_lifetime_budget_raw IS NOT NULL
            )) OR
            budget_origin IN ('not_observed', 'not_applicable')
          ),
          CONSTRAINT meta_entity_state_history_time_check CHECK (captured_at >= observed_at),
          CONSTRAINT meta_entity_state_history_run_entity_unique UNIQUE (run_id, entity_id)
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_state_history_asof
          ON meta_entity_state_history
          (business_id, provider_account_id, entity_type, entity_id, observed_at DESC, captured_at DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_state_history_run
          ON meta_entity_state_history (run_id, entity_id)`,
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_entity_state_history_run_ad_identity
          ON meta_entity_state_history (run_id, entity_type, ad_id, creative_id)`,
        sql`DO $$
          DECLARE
            existing_definition TEXT;
          BEGIN
            SELECT pg_get_constraintdef(oid)
            INTO existing_definition
            FROM pg_constraint
            WHERE conrelid = 'meta_entity_state_history'::regclass
              AND conname = 'meta_entity_state_history_run_fk';

            IF existing_definition IS NOT NULL AND existing_definition LIKE '%observed_at%' THEN
              ALTER TABLE meta_entity_state_history
                DROP CONSTRAINT meta_entity_state_history_run_fk;
              existing_definition := NULL;
            END IF;

            IF existing_definition IS NULL THEN
              ALTER TABLE meta_entity_state_history
                ADD CONSTRAINT meta_entity_state_history_run_fk
                FOREIGN KEY (
                  run_id, business_ref_id, business_id, provider_account_ref_id,
                  provider_account_id, entity_type, captured_at, run_completeness
                ) REFERENCES meta_entity_observation_runs (
                  id, business_ref_id, business_id, provider_account_ref_id,
                  provider_account_id, entity_type, captured_at, completeness
                ) ON DELETE RESTRICT NOT VALID;
            END IF;
          END
          $$`,
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_label_history (
          id                           UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          contract_version             TEXT NOT NULL DEFAULT 'meta-campaign-label-history.v1'
                                       CHECK (length(btrim(contract_version)) > 0),
          business_ref_id              UUID,
          business_id                  TEXT NOT NULL CHECK (length(btrim(business_id)) > 0),
          campaign_id                  TEXT NOT NULL CHECK (length(btrim(campaign_id)) > 0),
          provider_account_ref_id      UUID,
          provider_account_id          TEXT,
          campaign_name                TEXT,
          campaign_kind                TEXT NOT NULL
                                       CHECK (campaign_kind IN ('main', 'test', 'mixed')),
          test_dimension               TEXT CHECK (
            test_dimension IS NULL OR
            test_dimension IN ('creative', 'audience', 'bid', 'offer', 'structure', 'other')
          ),
          source                       TEXT NOT NULL
                                       CHECK (source IN ('user', 'bulk_apply_confirmed')),
          previous_provider_account_id TEXT,
          previous_campaign_name       TEXT,
          previous_campaign_kind       TEXT
                                       CHECK (previous_campaign_kind IS NULL OR previous_campaign_kind IN ('main', 'test', 'mixed')),
          previous_test_dimension      TEXT CHECK (
            previous_test_dimension IS NULL OR
            previous_test_dimension IN ('creative', 'audience', 'bid', 'offer', 'structure', 'other')
          ),
          previous_source              TEXT
                                       CHECK (previous_source IS NULL OR previous_source IN ('user', 'bulk_apply_confirmed')),
          labeled_by                   TEXT,
          change_kind                  TEXT NOT NULL CHECK (change_kind IN ('created', 'updated')),
          observed_at                  TIMESTAMPTZ NOT NULL,
          state_hash                   CHAR(64) NOT NULL CHECK (state_hash ~ '^[0-9a-f]{64}$'),
          created_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT meta_campaign_label_history_current_dimension_check
            CHECK (campaign_kind = 'test' OR test_dimension IS NULL),
          CONSTRAINT meta_campaign_label_history_previous_dimension_check
            CHECK (previous_test_dimension IS NULL OR previous_campaign_kind = 'test'),
          CONSTRAINT meta_campaign_label_history_change_check CHECK (
            (change_kind = 'created' AND
              previous_provider_account_id IS NULL AND previous_campaign_name IS NULL AND
              previous_campaign_kind IS NULL AND previous_test_dimension IS NULL AND previous_source IS NULL) OR
            (change_kind = 'updated' AND previous_campaign_kind IS NOT NULL AND previous_source IS NOT NULL)
          ),
          CONSTRAINT meta_campaign_label_history_event_unique
            UNIQUE (business_id, campaign_id, observed_at, state_hash)
        )`,
        sql`ALTER TABLE meta_campaign_label_history
          ADD COLUMN IF NOT EXISTS business_ref_id UUID,
          ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID`,
        sql`UPDATE meta_campaign_label_history history
          SET business_ref_id = business.id
          FROM businesses business
          WHERE history.business_ref_id IS NULL
            AND history.business_id = business.id::text`,
        sql`UPDATE meta_campaign_label_history history
          SET provider_account_ref_id = assignment.provider_account_ref_id
          FROM business_provider_accounts assignment
          WHERE history.provider_account_ref_id IS NULL
            AND history.provider_account_id IS NOT NULL
            AND assignment.business_id = history.business_id
            AND assignment.provider = 'meta'
            AND assignment.provider_account_id = history.provider_account_id`,
        sql`DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_campaign_label_history'::regclass
                AND conname = 'meta_campaign_label_history_tenant_fields_check'
            ) THEN
              ALTER TABLE meta_campaign_label_history
                ADD CONSTRAINT meta_campaign_label_history_tenant_fields_check
                CHECK (
                  business_ref_id IS NOT NULL AND
                  (
                    (provider_account_id IS NULL AND provider_account_ref_id IS NULL) OR
                    (provider_account_id IS NOT NULL AND provider_account_ref_id IS NOT NULL)
                  )
                ) NOT VALID;
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_campaign_label_history'::regclass
                AND conname = 'meta_campaign_label_history_business_identity_check'
            ) THEN
              ALTER TABLE meta_campaign_label_history
                ADD CONSTRAINT meta_campaign_label_history_business_identity_check
                CHECK (business_ref_id IS NULL OR business_id = business_ref_id::text)
                NOT VALID;
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_campaign_label_history'::regclass
                AND conname = 'meta_campaign_label_history_business_fk'
            ) THEN
              ALTER TABLE meta_campaign_label_history
                ADD CONSTRAINT meta_campaign_label_history_business_fk
                FOREIGN KEY (business_ref_id) REFERENCES businesses(id)
                ON DELETE RESTRICT NOT VALID;
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_campaign_label_history'::regclass
                AND conname = 'meta_campaign_label_history_account_fk'
            ) THEN
              ALTER TABLE meta_campaign_label_history
                ADD CONSTRAINT meta_campaign_label_history_account_fk
                FOREIGN KEY (provider_account_ref_id, provider_account_id)
                REFERENCES provider_accounts (id, external_account_id)
                ON DELETE RESTRICT NOT VALID;
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_campaign_label_history'::regclass
                AND conname = 'meta_campaign_label_history_binding_fk'
            ) THEN
              ALTER TABLE meta_campaign_label_history
                ADD CONSTRAINT meta_campaign_label_history_binding_fk
                FOREIGN KEY (business_id, provider_account_ref_id, provider_account_id)
                REFERENCES business_provider_accounts (
                  business_id, provider_account_ref_id, provider_account_id
                ) ON DELETE RESTRICT NOT VALID;
            END IF;
          END
          $$`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_label_history_asof
          ON meta_campaign_label_history
          (business_id, provider_account_id, campaign_id, observed_at DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_label_history_refs
          ON meta_campaign_label_history
          (business_ref_id, provider_account_ref_id, campaign_id, observed_at DESC)`,
        sql`CREATE TABLE IF NOT EXISTS meta_entity_tombstones (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          run_id                    UUID NOT NULL,
          business_ref_id           UUID NOT NULL,
          business_id               TEXT NOT NULL CHECK (length(btrim(business_id)) > 0),
          provider_account_ref_id   UUID NOT NULL,
          provider_account_id       TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
          entity_type               TEXT NOT NULL
                                    CHECK (entity_type IN ('campaign', 'adset', 'ad', 'creative')),
          entity_id                 TEXT NOT NULL CHECK (length(btrim(entity_id)) > 0),
          reason                    TEXT NOT NULL CHECK (reason IN ('explicit_deleted', 'explicit_not_found')),
          provider_evidence_json    JSONB NOT NULL CHECK (jsonb_typeof(provider_evidence_json) = 'object'),
          observed_at               TIMESTAMPTZ NOT NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          run_completeness          TEXT NOT NULL
                                    CHECK (run_completeness IN ('complete', 'point_lookup')),
          tombstone_hash            CHAR(64) NOT NULL CHECK (tombstone_hash ~ '^[0-9a-f]{64}$'),
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT meta_entity_tombstones_run_fk FOREIGN KEY (
            run_id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            entity_type,
            observed_at,
            captured_at,
            run_completeness
          ) REFERENCES meta_entity_observation_runs (
            id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            entity_type,
            observed_at,
            captured_at,
            completeness
          ) ON DELETE RESTRICT,
          CONSTRAINT meta_entity_tombstones_time_check CHECK (captured_at >= observed_at),
          CONSTRAINT meta_entity_tombstones_not_found_check CHECK (
            reason <> 'explicit_not_found' OR run_completeness = 'point_lookup'
          ),
          CONSTRAINT meta_entity_tombstones_event_unique
            UNIQUE (run_id, entity_type, entity_id, reason)
        )`,
        sql`DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_entity_tombstones'::regclass
                AND conname = 'meta_entity_tombstones_point_evidence_check'
            ) THEN
              ALTER TABLE meta_entity_tombstones
                ADD CONSTRAINT meta_entity_tombstones_point_evidence_check
                CHECK (run_completeness = 'point_lookup') NOT VALID;
            END IF;
          END
          $$`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_entity_tombstones_asof
          ON meta_entity_tombstones
          (business_id, provider_account_id, entity_type, entity_id, observed_at DESC, captured_at DESC)`,
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_ads_action_log_id_business
          ON meta_ads_action_log (id, business_id)`,
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_ads_action_log_verified_lineage
          ON meta_ads_action_log (
            id, business_id, action, status, verified_at, ad_id, resulting_ad_id, creative_id
          )`,
        sql`CREATE TABLE IF NOT EXISTS meta_creative_lineage_edges (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          contract_version          TEXT NOT NULL DEFAULT 'meta-creative-lineage.v1'
                                    CHECK (length(btrim(contract_version)) > 0),
          business_ref_id           UUID NOT NULL REFERENCES businesses(id) ON DELETE RESTRICT,
          business_id               TEXT NOT NULL CHECK (length(btrim(business_id)) > 0),
          provider_account_ref_id   UUID NOT NULL,
          provider_account_id       TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
          source_ad_id              TEXT NOT NULL CHECK (length(btrim(source_ad_id)) > 0),
          source_creative_id        TEXT NOT NULL CHECK (length(btrim(source_creative_id)) > 0),
          target_ad_id              TEXT NOT NULL CHECK (length(btrim(target_ad_id)) > 0),
          target_creative_id        TEXT NOT NULL CHECK (length(btrim(target_creative_id)) > 0),
          lineage_type              TEXT NOT NULL
                                    CHECK (lineage_type IN ('reuse_same_creative', 'rebuild_successor')),
          evidence_source           TEXT NOT NULL
                                    CHECK (evidence_source IN ('observation_run', 'verified_action', 'manual_verified')),
          observation_run_id        UUID,
          observation_run_entity_type TEXT
                                    CHECK (observation_run_entity_type IS NULL OR observation_run_entity_type IN ('ad', 'creative')),
          observation_run_completeness TEXT
                                    CHECK (observation_run_completeness IS NULL OR observation_run_completeness IN ('complete', 'partial', 'point_lookup')),
          action_log_id             UUID,
          action_type               TEXT CHECK (action_type IS NULL OR action_type = 'duplicate'),
          action_status             TEXT CHECK (action_status IS NULL OR action_status = 'success'),
          action_verified_at        TIMESTAMPTZ,
          evidence_json             JSONB NOT NULL DEFAULT '{}'::jsonb
                                    CHECK (jsonb_typeof(evidence_json) = 'object'),
          observed_at               TIMESTAMPTZ NOT NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          lineage_hash              CHAR(64) NOT NULL CHECK (lineage_hash ~ '^[0-9a-f]{64}$'),
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT meta_creative_lineage_business_identity_check
            CHECK (business_id = business_ref_id::text),
          CONSTRAINT meta_creative_lineage_account_fk FOREIGN KEY (
            provider_account_ref_id,
            provider_account_id
          ) REFERENCES provider_accounts (id, external_account_id) ON DELETE RESTRICT,
          CONSTRAINT meta_creative_lineage_binding_fk FOREIGN KEY (
            business_id,
            provider_account_ref_id,
            provider_account_id
          ) REFERENCES business_provider_accounts (
            business_id,
            provider_account_ref_id,
            provider_account_id
          ) ON DELETE RESTRICT,
          CONSTRAINT meta_creative_lineage_observation_account_fk FOREIGN KEY (
            observation_run_id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            observation_run_entity_type,
            observed_at,
            captured_at,
            observation_run_completeness
          ) REFERENCES meta_entity_observation_runs (
            id,
            business_ref_id,
            business_id,
            provider_account_ref_id,
            provider_account_id,
            entity_type,
            observed_at,
            captured_at,
            completeness
          ) ON DELETE RESTRICT,
          CONSTRAINT meta_creative_lineage_action_business_fk FOREIGN KEY (
            action_log_id,
            business_ref_id,
            action_type,
            action_status,
            action_verified_at,
            source_ad_id,
            target_ad_id,
            source_creative_id
          ) REFERENCES meta_ads_action_log (
            id,
            business_id,
            action,
            status,
            verified_at,
            ad_id,
            resulting_ad_id,
            creative_id
          ) ON DELETE RESTRICT,
          CONSTRAINT meta_creative_lineage_time_check CHECK (captured_at >= observed_at),
          CONSTRAINT meta_creative_lineage_observation_fields_check CHECK (
            (observation_run_id IS NULL AND
              observation_run_entity_type IS NULL AND
              observation_run_completeness IS NULL) OR
            (observation_run_id IS NOT NULL AND
              observation_run_entity_type IS NOT NULL AND
              observation_run_completeness IS NOT NULL)
          ),
          CONSTRAINT meta_creative_lineage_action_fields_check CHECK (
            (action_log_id IS NULL AND action_type IS NULL AND action_status IS NULL AND action_verified_at IS NULL) OR
            (action_log_id IS NOT NULL AND action_type = 'duplicate' AND
              action_status = 'success' AND action_verified_at IS NOT NULL)
          ),
          CONSTRAINT meta_creative_lineage_action_time_check CHECK (
            action_log_id IS NULL OR observed_at >= action_verified_at
          ),
          CONSTRAINT meta_creative_lineage_identity_check CHECK (
            (lineage_type = 'reuse_same_creative' AND
              source_creative_id = target_creative_id AND source_ad_id <> target_ad_id) OR
            (lineage_type = 'rebuild_successor' AND source_creative_id <> target_creative_id)
          ),
          CONSTRAINT meta_creative_lineage_evidence_check CHECK (
            (evidence_source = 'observation_run' AND
              observation_run_id IS NOT NULL AND
              observation_run_entity_type IS NOT NULL AND
              observation_run_entity_type IN ('ad', 'creative') AND
              observation_run_completeness IS NOT NULL AND
              observation_run_completeness IN ('complete', 'partial', 'point_lookup')) OR
            (evidence_source = 'verified_action' AND
              action_log_id IS NOT NULL AND
              action_type = 'duplicate' AND
              action_status = 'success' AND
              action_verified_at IS NOT NULL) OR
            evidence_source = 'manual_verified'
          ),
          CONSTRAINT meta_creative_lineage_hash_unique
            UNIQUE (business_id, provider_account_id, lineage_hash)
        )`,
        //
        // Stable logical identity for a lineage edge.
        //
        // `lineage_hash` included observationRunId, so the SAME logical edge —
        // this ad reuses that creative — got a new hash on every observation and
        // the unique constraint never deduplicated anything. The logical key
        // carries source/target/entity/evidence semantics and no run id.
        //
        // Added as a SEPARATE column with a PARTIAL unique index rather than by
        // redefining lineage_hash: existing rows carry run-scoped hashes that
        // cannot be recomputed in a migration, and a NULL logical key keeps them
        // outside the new arbiter instead of colliding with it. Collapsing them
        // is a planned, dry-run, application-driven pass — not a DDL side
        // effect.
        sql`ALTER TABLE meta_creative_lineage_edges
          ADD COLUMN IF NOT EXISTS logical_lineage_key TEXT`,
        // The clocks of the observation that ACTUALLY saw the relationship.
        //
        // An edge's (observed_at, captured_at) are forced to equal its run's by
        // meta_creative_lineage_observation_account_fk. When a relationship
        // becomes available on a LATER observation whose state payload
        // coalesces, the edge is attached to the kept run and therefore carries
        // that run's ORIGINAL clocks — so an as-of read at t1 already returns an
        // edge nobody had observed yet.
        //
        // These columns carry the real observation instant alongside the run
        // identity the foreign key needs. NOT swallowed: the as-of reader
        // depends on them, and an absent column would silently restore the
        // premature edge.
        sql`ALTER TABLE meta_creative_lineage_edges
          ADD COLUMN IF NOT EXISTS relationship_observed_at TIMESTAMPTZ`,
        sql`ALTER TABLE meta_creative_lineage_edges
          ADD COLUMN IF NOT EXISTS relationship_captured_at TIMESTAMPTZ`,
        sql.query(
          buildInvalidIndexRepairQuery({
            indexName: "meta_creative_lineage_logical_identity",
            definitionMustContain: [
              "business_id",
              "provider_account_id",
              "logical_lineage_key",
              "WHERE (logical_lineage_key IS NOT NULL)",
            ],
          }),
        ),
        sql`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS meta_creative_lineage_logical_identity
          ON meta_creative_lineage_edges
          (business_id, provider_account_id, logical_lineage_key)
          WHERE logical_lineage_key IS NOT NULL`.catch(() => {}),
        sql.query(
          buildIndexContractQuery({
            indexName: "meta_creative_lineage_logical_identity",
            definitionMustContain: [
              "business_id",
              "provider_account_id",
              "logical_lineage_key",
              "WHERE (logical_lineage_key IS NOT NULL)",
            ],
          }),
        ),
        sql`DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_creative_lineage_edges'::regclass
                AND conname = 'meta_creative_lineage_account_authority_check'
            ) THEN
              ALTER TABLE meta_creative_lineage_edges
                ADD CONSTRAINT meta_creative_lineage_account_authority_check
                CHECK (
                  evidence_source IN ('observation_run', 'verified_action') AND
                  observation_run_id IS NOT NULL AND
                  observation_run_entity_type = 'ad' AND
                  observation_run_completeness IN ('complete', 'partial', 'point_lookup')
                ) NOT VALID;
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_creative_lineage_edges'::regclass
                AND conname = 'meta_creative_lineage_source_state_fk'
            ) THEN
              ALTER TABLE meta_creative_lineage_edges
                ADD CONSTRAINT meta_creative_lineage_source_state_fk
                FOREIGN KEY (
                  observation_run_id, observation_run_entity_type,
                  source_ad_id, source_creative_id
                ) REFERENCES meta_entity_state_history (
                  run_id, entity_type, ad_id, creative_id
                ) ON DELETE RESTRICT NOT VALID;
            END IF;
            IF NOT EXISTS (
              SELECT 1 FROM pg_constraint
              WHERE conrelid = 'meta_creative_lineage_edges'::regclass
                AND conname = 'meta_creative_lineage_target_state_fk'
            ) THEN
              ALTER TABLE meta_creative_lineage_edges
                ADD CONSTRAINT meta_creative_lineage_target_state_fk
                FOREIGN KEY (
                  observation_run_id, observation_run_entity_type,
                  target_ad_id, target_creative_id
                ) REFERENCES meta_entity_state_history (
                  run_id, entity_type, ad_id, creative_id
                ) ON DELETE RESTRICT NOT VALID;
            END IF;
          END
          $$`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_lineage_source_asof
          ON meta_creative_lineage_edges
          (business_id, provider_account_id, source_creative_id, observed_at DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_lineage_target_asof
          ON meta_creative_lineage_edges
          (business_id, provider_account_id, target_creative_id, observed_at DESC)`,
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS optimization_goal TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS custom_event_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS pixel_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS custom_conversion_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS promoted_object_json JSONB`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS bid_strategy_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS bid_value DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS bid_value_format TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS daily_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS lifetime_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_budget_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_config_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_bid_strategy_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS is_bid_value_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_breakdown_daily (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date                DATE NOT NULL,
          breakdown_type      TEXT NOT NULL,
          breakdown_key       TEXT NOT NULL,
          breakdown_label     TEXT NOT NULL,
          account_timezone    TEXT NOT NULL,
          account_currency    TEXT NOT NULL,
          spend               DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions         BIGINT NOT NULL DEFAULT 0,
          clicks              BIGINT NOT NULL DEFAULT 0,
          reach               BIGINT NOT NULL DEFAULT 0,
          frequency           DOUBLE PRECISION,
          conversions         DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue             DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                 DOUBLE PRECISION,
          ctr                 DOUBLE PRECISION,
          cpc                 DOUBLE PRECISION,
          source_snapshot_id  UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          truth_state         TEXT NOT NULL DEFAULT 'finalized',
          truth_version       INTEGER NOT NULL DEFAULT 1,
          finalized_at        TIMESTAMPTZ,
          validation_status   TEXT NOT NULL DEFAULT 'passed',
          source_run_id       TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, breakdown_type, breakdown_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_breakdown_daily_business_date
          ON meta_breakdown_daily (business_id, date DESC, breakdown_type)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_breakdown_daily_account_date
          ON meta_breakdown_daily (provider_account_id, date DESC, breakdown_type)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_ad_daily (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date                DATE NOT NULL,
          campaign_id         TEXT,
          adset_id            TEXT,
          ad_id               TEXT NOT NULL,
          ad_name_current     TEXT,
          ad_name_historical  TEXT,
          ad_status           TEXT,
          destination_url      TEXT,
          destination_url_raw  TEXT,
          destination_url_source TEXT,
          destination_url_confidence TEXT,
          cta_type             TEXT,
          object_story_id      TEXT,
          effective_object_story_id TEXT,
          account_timezone    TEXT NOT NULL,
          account_currency    TEXT NOT NULL,
          spend               DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions         BIGINT NOT NULL DEFAULT 0,
          clicks              BIGINT NOT NULL DEFAULT 0,
          reach               BIGINT NOT NULL DEFAULT 0,
          frequency           DOUBLE PRECISION,
          conversions         DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue             DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                DOUBLE PRECISION NOT NULL DEFAULT 0,
          cpa                 DOUBLE PRECISION,
          ctr                 DOUBLE PRECISION,
          cpc                 DOUBLE PRECISION,
          link_clicks         BIGINT NOT NULL DEFAULT 0,
          source_snapshot_id  UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          truth_state         TEXT NOT NULL DEFAULT 'finalized',
          truth_version       INTEGER NOT NULL DEFAULT 1,
          finalized_at        TIMESTAMPTZ,
          validation_status   TEXT NOT NULL DEFAULT 'passed',
          source_run_id       TEXT,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, ad_id)
        )`.catch(() => {}),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS payload_json JSONB`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS link_clicks BIGINT NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS destination_url TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS destination_url_raw TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS destination_url_source TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS destination_url_confidence TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS cta_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS object_story_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS effective_object_story_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS truth_state TEXT NOT NULL DEFAULT 'finalized'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS truth_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS finalized_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS validation_status TEXT NOT NULL DEFAULT 'passed'`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_ad_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_business_date ON meta_ad_daily (business_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_account_date ON meta_ad_daily (provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_ad ON meta_ad_daily (ad_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_business_account_date
          ON meta_ad_daily (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_daily_business_date_ad
          ON meta_ad_daily (business_id, date DESC, ad_id)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_daily (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date                DATE NOT NULL,
          campaign_id         TEXT,
          adset_id            TEXT,
          ad_id               TEXT,
          creative_id         TEXT NOT NULL,
          creative_name       TEXT,
          headline            TEXT,
          primary_text        TEXT,
          destination_url     TEXT,
          destination_url_raw TEXT,
          destination_url_source TEXT,
          destination_url_confidence TEXT,
          cta_type            TEXT,
          object_story_id     TEXT,
          effective_object_story_id TEXT,
          thumbnail_url       TEXT,
          asset_type          TEXT,
          account_timezone    TEXT NOT NULL,
          account_currency    TEXT NOT NULL,
          spend               DOUBLE PRECISION NOT NULL DEFAULT 0,
          impressions         BIGINT NOT NULL DEFAULT 0,
          clicks              BIGINT NOT NULL DEFAULT 0,
          conversions         DOUBLE PRECISION NOT NULL DEFAULT 0,
          revenue             DOUBLE PRECISION NOT NULL DEFAULT 0,
          roas                DOUBLE PRECISION NOT NULL DEFAULT 0,
          ctr                 DOUBLE PRECISION,
          cpc                 DOUBLE PRECISION,
          link_clicks         BIGINT NOT NULL DEFAULT 0,
          source_snapshot_id  UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          source_run_id       TEXT,
          metric_schema_version INTEGER NOT NULL DEFAULT 1,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, creative_id)
        )`.catch(() => {}),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS payload_json JSONB`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS destination_url_raw TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS destination_url_source TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS destination_url_confidence TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS cta_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS object_story_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS effective_object_story_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS business_ref_id UUID REFERENCES businesses(id) ON DELETE SET NULL`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS reach BIGINT NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS frequency DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS cpa DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS link_clicks BIGINT NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS outbound_clicks BIGINT NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS description_text TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS launch_date DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS first_seen_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS first_spend_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS effective_status TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS objective TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS attribution_setting TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS quality_ranking TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS engagement_rate_ranking TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS conversion_rate_ranking TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS bid_strategy TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS optimization_goal TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS campaign_daily_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS adset_daily_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS campaign_lifetime_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS adset_lifetime_budget DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_delivery_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_visual_format TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_primary_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS creative_secondary_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS image_hash TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS source_run_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_creative_daily ADD COLUMN IF NOT EXISTS metric_schema_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_business_date ON meta_creative_daily (business_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_account_date ON meta_creative_daily (provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_creative ON meta_creative_daily (creative_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_business_account_date
          ON meta_creative_daily (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_business_account_date_creative
          ON meta_creative_daily (business_id, provider_account_id, date DESC, creative_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_daily_image_hash
          ON meta_creative_daily (business_id, provider_account_id, image_hash)
          WHERE image_hash IS NOT NULL`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_media (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          date                    DATE NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT,
          ad_id                   TEXT,
          creative_id             TEXT NOT NULL,
          preview_url             TEXT,
          thumbnail_url           TEXT,
          image_url               TEXT,
          table_thumbnail_url     TEXT,
          card_preview_url        TEXT,
          video_url               TEXT,
          poster_url              TEXT,
          preview_html            TEXT,
          media_cache_key         TEXT,
          image_hash              TEXT,
          payload_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_run_id           TEXT,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`ALTER TABLE meta_creative_media
          DROP CONSTRAINT IF EXISTS meta_creative_media_business_id_provider_account_id_date_creative_id_key`.catch(
          () => {},
        ),
        sql`DO $migration$
          DECLARE old_constraint_name TEXT;
          BEGIN
            SELECT conname INTO old_constraint_name
            FROM pg_constraint
            WHERE conrelid = 'meta_creative_media'::regclass
              AND contype = 'u'
              AND pg_get_constraintdef(oid) LIKE 'UNIQUE (business_id, provider_account_id, date, creative_id)%'
            LIMIT 1;
            IF old_constraint_name IS NOT NULL THEN
              EXECUTE format('ALTER TABLE meta_creative_media DROP CONSTRAINT %I', old_constraint_name);
            END IF;
          END
        $migration$`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_creative_media_ad_grain
          ON meta_creative_media (business_id, provider_account_id, date, creative_id, (COALESCE(ad_id, '')))`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_business_date
          ON meta_creative_media (business_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_account_date
          ON meta_creative_media (provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_creative
          ON meta_creative_media (creative_id, date DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_media_image_hash
          ON meta_creative_media (business_id, provider_account_id, image_hash)
          WHERE image_hash IS NOT NULL`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_campaign_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT NOT NULL,
          campaign_name           TEXT,
          normalized_status       TEXT,
          channel                 TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_dimensions_business_account
          ON google_ads_campaign_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_dimensions_campaign
          ON google_ads_campaign_dimensions (campaign_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_campaign_state_history (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT NOT NULL,
          state_fingerprint       TEXT NOT NULL,
          campaign_name           TEXT,
          normalized_status       TEXT,
          channel                 TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_kind             TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id      UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          captured_at             TIMESTAMPTZ NOT NULL,
          effective_from          DATE,
          effective_to            DATE,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id, state_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_state_history_lookup
          ON google_ads_campaign_state_history (business_id, campaign_id, captured_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_ad_group_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT NOT NULL,
          ad_group_name           TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_group_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group_dimensions_business_account
          ON google_ads_ad_group_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group_dimensions_ad_group
          ON google_ads_ad_group_dimensions (ad_group_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_ad_group_state_history (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT NOT NULL,
          state_fingerprint       TEXT NOT NULL,
          ad_group_name           TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_kind             TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id      UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          captured_at             TIMESTAMPTZ NOT NULL,
          effective_from          DATE,
          effective_to            DATE,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_group_id, state_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group_state_history_lookup
          ON google_ads_ad_group_state_history (business_id, ad_group_id, captured_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_ad_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT,
          ad_id                   TEXT NOT NULL,
          ad_name                 TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_dimensions_business_account
          ON google_ads_ad_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_dimensions_ad
          ON google_ads_ad_dimensions (ad_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_keyword_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT,
          keyword_id              TEXT NOT NULL,
          keyword_text            TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, keyword_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_keyword_dimensions_business_account
          ON google_ads_keyword_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_keyword_dimensions_keyword
          ON google_ads_keyword_dimensions (keyword_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_asset_group_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          asset_group_id          TEXT NOT NULL,
          asset_group_name        TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, asset_group_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_asset_group_dimensions_business_account
          ON google_ads_asset_group_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_asset_group_dimensions_asset_group
          ON google_ads_asset_group_dimensions (asset_group_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_product_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          product_key             TEXT NOT NULL,
          product_title           TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, product_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_product_dimensions_business_account
          ON google_ads_product_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_product_dimensions_product
          ON google_ads_product_dimensions (product_key, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT NOT NULL,
          campaign_name_current   TEXT,
          campaign_name_historical TEXT,
          campaign_status         TEXT,
          buying_type             TEXT,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_dimensions_business_account
          ON meta_campaign_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_dimensions_campaign
          ON meta_campaign_dimensions (campaign_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_campaign_config_history (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id               TEXT NOT NULL,
          provider_account_id       TEXT NOT NULL,
          campaign_id               TEXT NOT NULL,
          config_fingerprint        TEXT NOT NULL,
          objective                 TEXT,
          optimization_goal         TEXT,
          custom_event_type         TEXT,
          bid_strategy_type         TEXT,
          bid_value                 DOUBLE PRECISION,
          bid_value_format          TEXT,
          daily_budget              DOUBLE PRECISION,
          lifetime_budget           DOUBLE PRECISION,
          is_budget_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_custom_event_type_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed     BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed        BOOLEAN NOT NULL DEFAULT FALSE,
          source_kind               TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id        UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          effective_from            DATE,
          effective_to              DATE,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id, config_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_config_history_lookup
          ON meta_campaign_config_history (business_id, campaign_id, captured_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_campaign_config_history_latest_guard
          ON meta_campaign_config_history (business_id, provider_account_id, campaign_id, captured_at DESC)
          INCLUDE (config_fingerprint)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_adset_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT NOT NULL,
          adset_name_current      TEXT,
          adset_name_historical   TEXT,
          adset_status            TEXT,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, adset_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_dimensions_business_account
          ON meta_adset_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_dimensions_adset
          ON meta_adset_dimensions (adset_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_adset_config_history (
          id                        UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id               TEXT NOT NULL,
          provider_account_id       TEXT NOT NULL,
          campaign_id               TEXT,
          adset_id                  TEXT NOT NULL,
          config_fingerprint        TEXT NOT NULL,
          optimization_goal         TEXT,
          custom_event_type         TEXT,
          pixel_id                  TEXT,
          custom_conversion_id      TEXT,
          promoted_object_json      JSONB,
          bid_strategy_type         TEXT,
          bid_value                 DOUBLE PRECISION,
          bid_value_format          TEXT,
          daily_budget              DOUBLE PRECISION,
          lifetime_budget           DOUBLE PRECISION,
          is_budget_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_config_mixed           BOOLEAN NOT NULL DEFAULT FALSE,
          is_optimization_goal_mixed BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_strategy_mixed     BOOLEAN NOT NULL DEFAULT FALSE,
          is_bid_value_mixed        BOOLEAN NOT NULL DEFAULT FALSE,
          source_kind               TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id        UUID REFERENCES meta_raw_snapshots(id) ON DELETE SET NULL,
          captured_at               TIMESTAMPTZ NOT NULL,
          effective_from            DATE,
          effective_to              DATE,
          created_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, adset_id, config_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_config_history_lookup
          ON meta_adset_config_history (business_id, adset_id, captured_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_adset_config_history_latest_guard
          ON meta_adset_config_history (business_id, provider_account_id, adset_id, captured_at DESC)
          INCLUDE (config_fingerprint)`.catch(() => {}),
        sql`ALTER TABLE meta_campaign_config_history ADD COLUMN IF NOT EXISTS custom_event_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_campaign_config_history ADD COLUMN IF NOT EXISTS is_custom_event_type_mixed BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_config_history ADD COLUMN IF NOT EXISTS custom_event_type TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_config_history ADD COLUMN IF NOT EXISTS pixel_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_config_history ADD COLUMN IF NOT EXISTS custom_conversion_id TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE meta_adset_config_history ADD COLUMN IF NOT EXISTS promoted_object_json JSONB`.catch(
          () => {},
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_campaign_daily",
          "bid_strategy_label",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_campaign_daily",
          "manual_bid_amount",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_adset_daily",
          "bid_strategy_label",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_adset_daily",
          "manual_bid_amount",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_campaign_config_history",
          "bid_strategy_label",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_campaign_config_history",
          "manual_bid_amount",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_adset_config_history",
          "bid_strategy_label",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "meta_adset_config_history",
          "manual_bid_amount",
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_ad_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT,
          ad_id                   TEXT NOT NULL,
          ad_name_current         TEXT,
          ad_name_historical      TEXT,
          ad_status               TEXT,
          creative_id             TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_dimensions_business_account
          ON meta_ad_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ad_dimensions_ad
          ON meta_ad_dimensions (ad_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_dimensions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          campaign_id             TEXT,
          adset_id                TEXT,
          ad_id                   TEXT,
          creative_id             TEXT NOT NULL,
          creative_name           TEXT,
          headline                TEXT,
          primary_text            TEXT,
          destination_url         TEXT,
          thumbnail_url           TEXT,
          asset_type              TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at           TIMESTAMPTZ,
          last_seen_at            TIMESTAMPTZ,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, creative_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_dimensions_business_account
          ON meta_creative_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_dimensions_creative
          ON meta_creative_dimensions (creative_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_creative_score_snapshots (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          creative_id         TEXT NOT NULL,
          as_of_date          DATE NOT NULL,
          selected_start_date DATE NOT NULL,
          selected_end_date   DATE NOT NULL,
          window_metrics      JSONB NOT NULL DEFAULT '{}'::jsonb,
          selected_row_json   JSONB NOT NULL DEFAULT '{}'::jsonb,
          weighted_score      DOUBLE PRECISION,
          label               TEXT,
          computed_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          freshness_state     TEXT NOT NULL DEFAULT 'fresh',
          rule_version        TEXT NOT NULL,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (
            business_id,
            provider_account_id,
            creative_id,
            as_of_date,
            selected_start_date,
            selected_end_date,
            rule_version
          )
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_score_snapshots_lookup ON meta_creative_score_snapshots (business_id, selected_start_date, selected_end_date, as_of_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_score_snapshots_creative ON meta_creative_score_snapshots (creative_id, as_of_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_source_manifests (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          account_timezone        TEXT NOT NULL,
          source_kind             TEXT NOT NULL,
          source_window_kind      TEXT NOT NULL,
          run_id                  TEXT,
          fetch_status            TEXT NOT NULL DEFAULT 'pending',
          fresh_start_applied     BOOLEAN NOT NULL DEFAULT FALSE,
          checkpoint_reset_applied BOOLEAN NOT NULL DEFAULT FALSE,
          raw_snapshot_watermark  TEXT,
          source_spend            DOUBLE PRECISION,
          validation_basis_version TEXT,
          meta_json               JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at              TIMESTAMPTZ,
          completed_at            TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_source_manifests_lookup
          ON meta_authoritative_source_manifests (business_id, provider_account_id, day DESC, surface, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_source_manifests_run
          ON meta_authoritative_source_manifests (run_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_slice_versions (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          manifest_id             UUID REFERENCES meta_authoritative_source_manifests(id) ON DELETE SET NULL,
          candidate_version       INTEGER NOT NULL,
          state                   TEXT NOT NULL DEFAULT 'pending_finalization',
          truth_state             TEXT NOT NULL DEFAULT 'finalized',
          validation_status       TEXT NOT NULL DEFAULT 'pending',
          status                  TEXT NOT NULL DEFAULT 'staging',
          staged_row_count        INTEGER,
          aggregated_spend        DOUBLE PRECISION,
          validation_summary      JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_run_id           TEXT,
          stage_started_at        TIMESTAMPTZ,
          stage_completed_at      TIMESTAMPTZ,
          publish_started_at      TIMESTAMPTZ,
          published_at            TIMESTAMPTZ,
          superseded_at           TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, day, surface, candidate_version)
        )`.catch(() => {}),
        sql`ALTER TABLE IF EXISTS meta_authoritative_slice_versions
          ADD COLUMN IF NOT EXISTS publish_started_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_slice_versions_lookup
          ON meta_authoritative_slice_versions (business_id, provider_account_id, day DESC, surface, candidate_version DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_slice_versions_manifest
          ON meta_authoritative_slice_versions (manifest_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_publication_pointers (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          active_slice_version_id UUID NOT NULL REFERENCES meta_authoritative_slice_versions(id) ON DELETE CASCADE,
          published_by_run_id     TEXT,
          publication_reason      TEXT NOT NULL,
          published_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, day, surface)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_publication_pointers_slice
          ON meta_authoritative_publication_pointers (active_slice_version_id, published_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_reconciliation_events (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          day                     DATE NOT NULL,
          surface                 TEXT NOT NULL,
          slice_version_id        UUID REFERENCES meta_authoritative_slice_versions(id) ON DELETE SET NULL,
          manifest_id             UUID REFERENCES meta_authoritative_source_manifests(id) ON DELETE SET NULL,
          event_kind              TEXT NOT NULL,
          severity                TEXT NOT NULL DEFAULT 'info',
          source_spend            DOUBLE PRECISION,
          warehouse_account_spend DOUBLE PRECISION,
          warehouse_campaign_spend DOUBLE PRECISION,
          tolerance_applied       DOUBLE PRECISION,
          result                  TEXT NOT NULL,
          details_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_reconciliation_events_lookup
          ON meta_authoritative_reconciliation_events (business_id, provider_account_id, day DESC, surface, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_authoritative_day_state (
          business_id                TEXT NOT NULL,
          provider_account_id        TEXT NOT NULL,
          day                        DATE NOT NULL,
          surface                    TEXT NOT NULL CHECK (surface IN ('account_daily', 'campaign_daily', 'adset_daily', 'ad_daily', 'breakdown_daily')),
          state                      TEXT NOT NULL DEFAULT 'pending'
                                    CHECK (state IN ('pending', 'queued', 'running', 'published', 'repair_required', 'failed', 'blocked', 'not_applicable')),
          account_timezone           TEXT NOT NULL DEFAULT 'UTC',
          active_partition_id        UUID,
          last_run_id                TEXT,
          last_manifest_id           UUID,
          last_publication_pointer_id UUID,
          published_at               TIMESTAMPTZ,
          retry_after_at             TIMESTAMPTZ,
          failure_streak             INTEGER NOT NULL DEFAULT 0,
          diagnosis_code             TEXT,
          diagnosis_detail_json      JSONB NOT NULL DEFAULT '{}'::jsonb,
          last_started_at            TIMESTAMPTZ,
          last_finished_at           TIMESTAMPTZ,
          last_autoheal_at           TIMESTAMPTZ,
          autoheal_count             INTEGER NOT NULL DEFAULT 0,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, day, surface)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_day_state_business_day
          ON meta_authoritative_day_state (business_id, provider_account_id, day DESC, surface)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_authoritative_day_state_status
          ON meta_authoritative_day_state (business_id, state, day DESC, surface)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS meta_retention_runs (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          execution_mode           TEXT NOT NULL CHECK (execution_mode IN ('dry_run', 'execute')),
          execution_enabled        BOOLEAN NOT NULL DEFAULT FALSE,
          skipped_due_to_active_lease BOOLEAN NOT NULL DEFAULT FALSE,
          total_deleted_rows       INTEGER NOT NULL DEFAULT 0,
          summary_json             JSONB NOT NULL DEFAULT '{}'::jsonb,
          error_message            TEXT,
          started_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at              TIMESTAMPTZ,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_meta_retention_runs_finished
          ON meta_retention_runs (finished_at DESC NULLS LAST, created_at DESC)`.catch(
          () => {},
        ),
        // ── Google Ads warehouse-first tables ──────────────────────────────
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_jobs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          sync_type           TEXT NOT NULL
                              CHECK (sync_type IN ('initial_backfill', 'incremental_recent', 'today_refresh', 'repair_window', 'reconnect_backfill')),
          scope               TEXT NOT NULL DEFAULT 'account_daily',
          start_date          DATE NOT NULL,
          end_date            DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'pending'
                              CHECK (status IN ('pending', 'running', 'succeeded', 'partial', 'failed', 'cancelled')),
          progress_percent    DOUBLE PRECISION NOT NULL DEFAULT 0,
          trigger_source      TEXT NOT NULL DEFAULT 'system',
          retry_count         INTEGER NOT NULL DEFAULT 0,
          last_error          TEXT,
          triggered_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_business ON google_ads_sync_jobs (business_id, triggered_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_account ON google_ads_sync_jobs (provider_account_id, triggered_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_status ON google_ads_sync_jobs (status, triggered_at DESC)`.catch(
          () => {},
        ),
        sql`
          WITH ranked AS (
            SELECT
              id,
              ROW_NUMBER() OVER (
                PARTITION BY business_id, provider_account_id, sync_type, scope, start_date, end_date, trigger_source
                ORDER BY updated_at DESC, triggered_at DESC, id DESC
              ) AS row_number
            FROM google_ads_sync_jobs
            WHERE status = 'running'
          )
          UPDATE google_ads_sync_jobs job
          SET
            status = 'failed',
            last_error = COALESCE(job.last_error, 'duplicate running sync job cleaned up during migration'),
            finished_at = now(),
            updated_at = now()
          FROM ranked
          WHERE job.id = ranked.id
            AND ranked.row_number > 1
        `.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_sync_jobs_running_unique
          ON google_ads_sync_jobs (
            business_id,
            provider_account_id,
            sync_type,
            scope,
            start_date,
            end_date,
            trigger_source
          )
          WHERE status = 'running'`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_runner_leases (
          business_id       TEXT NOT NULL,
          lane              TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          lease_owner       TEXT NOT NULL,
          lease_expires_at  TIMESTAMPTZ NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, lane)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_runner_leases_expiry
          ON google_ads_runner_leases (lease_expires_at, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_partitions (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL DEFAULT 'queued'
                              CHECK (status IN ('queued', 'leased', 'running', 'succeeded', 'failed', 'dead_letter', 'cancelled')),
          priority            INTEGER NOT NULL DEFAULT 0,
          source              TEXT NOT NULL DEFAULT 'system',
          lease_owner         TEXT,
          lease_expires_at    TIMESTAMPTZ,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          next_retry_at       TIMESTAMPTZ,
          last_error          TEXT,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, lane, scope, partition_date)
        )`.catch(() => {}),
        sql`ALTER TABLE google_ads_sync_partitions
          ADD COLUMN IF NOT EXISTS scheduling_attempt_id UUID`,
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_partitions_queue
          ON google_ads_sync_partitions (business_id, lane, status, priority DESC, partition_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_partitions_lease
          ON google_ads_sync_partitions (status, lease_expires_at, next_retry_at, updated_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_partitions ADD COLUMN IF NOT EXISTS lease_epoch BIGINT NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_runs (
          id                  UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id        UUID REFERENCES google_ads_sync_partitions(id) ON DELETE CASCADE,
          business_id         TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          lane                TEXT NOT NULL CHECK (lane IN ('core', 'extended', 'maintenance')),
          scope               TEXT NOT NULL,
          partition_date      DATE NOT NULL,
          status              TEXT NOT NULL CHECK (status IN ('running', 'succeeded', 'failed', 'cancelled')),
          worker_id           TEXT,
          attempt_count       INTEGER NOT NULL DEFAULT 0,
          row_count           INTEGER,
          duration_ms         INTEGER,
          error_class         TEXT,
          error_message       TEXT,
          meta_json           JSONB NOT NULL DEFAULT '{}'::jsonb,
          started_at          TIMESTAMPTZ,
          finished_at         TIMESTAMPTZ,
          created_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at          TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_runs_partition ON google_ads_sync_runs (partition_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_runs_business ON google_ads_sync_runs (business_id, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_checkpoints (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          partition_id               UUID NOT NULL REFERENCES google_ads_sync_partitions(id) ON DELETE CASCADE,
          business_id                TEXT NOT NULL,
          provider_account_id        TEXT NOT NULL,
          checkpoint_scope           TEXT NOT NULL,
          phase                      TEXT NOT NULL
                                      CHECK (phase IN ('fetch_raw', 'transform', 'bulk_upsert', 'finalize')),
          status                     TEXT NOT NULL
                                      CHECK (status IN ('pending', 'running', 'succeeded', 'failed', 'cancelled')),
          page_index                 INTEGER NOT NULL DEFAULT 0,
          next_page_token            TEXT,
          provider_cursor            TEXT,
          rows_fetched               INTEGER NOT NULL DEFAULT 0,
          rows_written               INTEGER NOT NULL DEFAULT 0,
          last_successful_entity_key TEXT,
          last_response_headers      JSONB NOT NULL DEFAULT '{}'::jsonb,
          checkpoint_hash            TEXT,
          attempt_count              INTEGER NOT NULL DEFAULT 0,
          retry_after_at             TIMESTAMPTZ,
          lease_owner                TEXT,
          lease_expires_at           TIMESTAMPTZ,
          started_at                 TIMESTAMPTZ,
          finished_at                TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (partition_id, checkpoint_scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_checkpoints_partition
          ON google_ads_sync_checkpoints (partition_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_checkpoints_scope
          ON google_ads_sync_checkpoints (business_id, provider_account_id, checkpoint_scope, status, updated_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS lease_epoch BIGINT`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_checkpoints_partition_epoch
          ON google_ads_sync_checkpoints (partition_id, lease_epoch, updated_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS is_paginated BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS raw_snapshot_ids JSONB NOT NULL DEFAULT '[]'::jsonb`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS progress_heartbeat_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS poisoned_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS poison_reason TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS replay_reason_code TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_sync_checkpoints ADD COLUMN IF NOT EXISTS replay_detail TEXT`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_sync_state (
          business_id                  TEXT NOT NULL,
          provider_account_id          TEXT NOT NULL,
          scope                        TEXT NOT NULL,
          historical_target_start      DATE NOT NULL,
          historical_target_end        DATE NOT NULL,
          effective_target_start       DATE NOT NULL,
          effective_target_end         DATE NOT NULL,
          ready_through_date           DATE,
          last_successful_partition_date DATE,
          latest_background_activity_at TIMESTAMPTZ,
          latest_successful_sync_at    TIMESTAMPTZ,
          completed_days               INTEGER NOT NULL DEFAULT 0,
          dead_letter_count            INTEGER NOT NULL DEFAULT 0,
          updated_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, scope)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_sync_state_business
          ON google_ads_sync_state (business_id, scope, updated_at DESC)`.catch(
          () => {},
        ),
        // ── Google Ads day finality ──────────────────────────────────────
        //
        // "Final" must mean a date was FETCHED FROM THE PROVIDER after that
        // account's own timezone day closed — not "a row exists and time has
        // passed". Coverage today is `SELECT DISTINCT date`, so a day read once
        // at 01:40 and never re-read is indistinguishable from a settled one,
        // and the D+1 path marks such a day finalize-complete without ever
        // calling Google.
        //
        // A day-grain table, deliberately, rather than a column elsewhere:
        //   - not on the twelve *_daily relations, because the day is the unit
        //     of finality while their row grain is entity_key — the same
        //     date-level fact would be rewritten tens of thousands of times per
        //     account-day across twelve tables, with twelve copies to reconcile;
        //   - not on google_ads_sync_partitions, because those are CASCADE-
        //     pruned work-queue rows (the proof would age out with them) and
        //     `lane` is in their unique key, so the claim would be multi-valued
        //     across core/extended/maintenance.
        //
        // ABSENCE IS A STATE, and that is the point. No row = never tracked,
        // predating this table: neither trusted as final nor treated as a
        // re-fetch obligation for all history. A tracked-but-provisional date
        // is `finalized_at IS NULL`. Those are physically distinct, so a
        // pre-existing completed row is never silently read as trustworthy.
        //
        // Modelled on meta_authoritative_day_state, which solves this same
        // problem for the other provider.
        //
        // No column is named run_id / source_run_id / last_run_id /
        // published_by_run_id: retention-readiness refuses the retention
        // contract for ANY google_ads_% table carrying one, which would fail
        // the cutover's verify-contract phase.
        orderedMigrationSteps([
          () =>
            sql`CREATE TABLE IF NOT EXISTS google_ads_day_finality (
              business_id             TEXT NOT NULL,
              provider_account_id     TEXT NOT NULL,
              scope                   TEXT NOT NULL,
              date                    DATE NOT NULL,
              account_timezone        TEXT,
              day_closed_at           TIMESTAMPTZ,
              last_observed_at        TIMESTAMPTZ,
              metrics_settled_at      TIMESTAMPTZ,
              lookback_exhausted_at   TIMESTAMPTZ,
              next_refresh_due_at     TIMESTAMPTZ,
              freshness_tier          TEXT,
              observation_count       INTEGER NOT NULL DEFAULT 0,
              created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
              updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
              PRIMARY KEY (business_id, provider_account_id, scope, date)
            )`.catch(() => {}),
          // Additive for a database that already has the first shape of this
          // table. It shipped with a `finalized_at` that asserted permanent
          // immutability after one post-close fetch — which Google does not
          // offer: conversions can be attributed back to a click date for up to
          // the configured conversion window (1-90 days, default 30), and
          // reports are revised days later for invalid traffic and late
          // conversions. These columns replace that single bit with the five
          // distinguishable facts.
          () =>
            sql`ALTER TABLE google_ads_day_finality
              ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ`.catch(() => {}),
          () =>
            sql`ALTER TABLE google_ads_day_finality
              ADD COLUMN IF NOT EXISTS metrics_settled_at TIMESTAMPTZ`.catch(() => {}),
          () =>
            sql`ALTER TABLE google_ads_day_finality
              ADD COLUMN IF NOT EXISTS lookback_exhausted_at TIMESTAMPTZ`.catch(() => {}),
          () =>
            sql`ALTER TABLE google_ads_day_finality
              ADD COLUMN IF NOT EXISTS next_refresh_due_at TIMESTAMPTZ`.catch(() => {}),
          () =>
            sql`ALTER TABLE google_ads_day_finality
              ADD COLUMN IF NOT EXISTS freshness_tier TEXT`.catch(() => {}),
          () =>
            sql`ALTER TABLE google_ads_day_finality
              ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 0`.catch(
              () => {},
            ),
          // Drop the immutability constraint and the column behind it, then
          // install the honest invariant. A DO block because PostgreSQL has no
          // IF NOT EXISTS for constraints, and this must be re-entrant: the
          // runner has no ledger and re-executes every statement on every run.
          () =>
            sql.query(`
              DO $google_ads_day_finality_shape$
              BEGIN
                IF EXISTS (
                  SELECT 1 FROM pg_constraint
                  WHERE conname = 'google_ads_day_finality_close_proof_check'
                ) THEN
                  ALTER TABLE google_ads_day_finality
                    DROP CONSTRAINT google_ads_day_finality_close_proof_check;
                END IF;
                ALTER TABLE google_ads_day_finality DROP COLUMN IF EXISTS finalized_at;
                ALTER TABLE google_ads_day_finality DROP COLUMN IF EXISTS finality_source;
                ALTER TABLE google_ads_day_finality DROP COLUMN IF EXISTS last_fetch_completed_at;
                ALTER TABLE google_ads_day_finality DROP COLUMN IF EXISTS attempt_count;
                IF NOT EXISTS (
                  SELECT 1 FROM pg_constraint
                  WHERE conname = 'google_ads_day_finality_settlement_proof_check'
                ) THEN
                  -- A settlement claim requires proof the day actually closed.
                  -- This is the honest analogue of the constraint it replaces:
                  -- it refuses fabricated settlement, and deliberately does NOT
                  -- assert that an observed day can never change again.
                  ALTER TABLE google_ads_day_finality
                    ADD CONSTRAINT google_ads_day_finality_settlement_proof_check CHECK (
                      (metrics_settled_at IS NULL OR day_closed_at IS NOT NULL)
                      AND (lookback_exhausted_at IS NULL OR day_closed_at IS NOT NULL)
                      AND (next_refresh_due_at IS NULL OR last_observed_at IS NOT NULL)
                    );
                END IF;
              END
              $google_ads_day_finality_shape$
            `),
          // The due-scan: "which dates owe a re-read now". Partial on the
          // schedule rather than on a finality bit, because no date is ever
          // permanently done.
          () =>
            sql`CREATE INDEX IF NOT EXISTS idx_google_ads_day_finality_due
              ON google_ads_day_finality (business_id, provider_account_id, scope, next_refresh_due_at)`.catch(
              () => {},
            ),
          () =>
            sql`DROP INDEX IF EXISTS idx_google_ads_day_finality_provisional`.catch(
              () => {},
            ),
        ]),
        sql`CREATE TABLE IF NOT EXISTS google_ads_raw_snapshots (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL DEFAULT 'account',
          start_date           DATE NOT NULL,
          end_date             DATE NOT NULL,
          account_timezone     TEXT,
          account_currency     TEXT,
          payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          payload_hash         TEXT NOT NULL,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_http_status INTEGER,
          status               TEXT NOT NULL DEFAULT 'fetched'
                               CHECK (status IN ('fetched', 'partial', 'failed')),
          fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_business ON google_ads_raw_snapshots (business_id, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_account ON google_ads_raw_snapshots (provider_account_id, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_window ON google_ads_raw_snapshots (business_id, provider_account_id, start_date, end_date)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_endpoint ON google_ads_raw_snapshots (endpoint_name, fetched_at DESC)`.catch(
          () => {},
        ),
        // From-zero convergence: the two state-history tables above declare
        // an FK to google_ads_raw_snapshots but are created earlier in this
        // file; on a fresh database their first CREATE fails (silently, via
        // the trailing catch). Re-issuing them here, after the referenced
        // table exists, makes a from-zero deploy converge in one migration
        // run. Existing databases no-op (IF NOT EXISTS). Found by
        // test:migrations-from-zero.
        sql`CREATE TABLE IF NOT EXISTS google_ads_campaign_state_history (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT NOT NULL,
          state_fingerprint       TEXT NOT NULL,
          campaign_name           TEXT,
          normalized_status       TEXT,
          channel                 TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_kind             TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id      UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          captured_at             TIMESTAMPTZ NOT NULL,
          effective_from          DATE,
          effective_to            DATE,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, campaign_id, state_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_campaign_state_history_lookup
          ON google_ads_campaign_state_history (business_id, campaign_id, captured_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_ad_group_state_history (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          campaign_id             TEXT,
          ad_group_id             TEXT NOT NULL,
          state_fingerprint       TEXT NOT NULL,
          ad_group_name           TEXT,
          normalized_status       TEXT,
          projection_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_kind             TEXT NOT NULL DEFAULT 'warehouse_daily',
          source_snapshot_id      UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          captured_at             TIMESTAMPTZ NOT NULL,
          effective_from          DATE,
          effective_to            DATE,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, ad_group_id, state_fingerprint, captured_at)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_ad_group_state_history_lookup
          ON google_ads_ad_group_state_history (business_id, ad_group_id, captured_at DESC)`.catch(
          () => {},
        ),
        // The columns, THEN the indexes that name them — as thunks.
        //
        // Both indexes reference `partition_id` and `page_index` and were
        // issued BEFORE the ALTER TABLEs that add them, with the failure
        // swallowed, so on a database built from zero neither index existed
        // until migrations happened to run a second time. Reordering the array
        // alone would not have fixed it: every `sql\`…\`` in a batch starts
        // executing when the array literal is evaluated, so
        // `runMigrationBatchSequentially` awaits in order but ISSUES all at
        // once. Only thunks defer the issue itself.
        orderedMigrationSteps([
          () =>
            sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS partition_id UUID REFERENCES google_ads_sync_partitions(id) ON DELETE CASCADE`.catch(
              () => {},
            ),
          () =>
            sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS checkpoint_id UUID REFERENCES google_ads_sync_checkpoints(id) ON DELETE SET NULL`.catch(
              () => {},
            ),
          () =>
            sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS page_index INTEGER`.catch(
              () => {},
            ),
          () =>
            sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS provider_cursor TEXT`.catch(
              () => {},
            ),
          () =>
            sql`ALTER TABLE google_ads_raw_snapshots ADD COLUMN IF NOT EXISTS response_headers JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(
              () => {},
            ),
          // CONCURRENTLY needs its own transaction, which is exactly what a
          // thunk in this runner gets.
          () =>
            sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_raw_snapshots_retention
              ON google_ads_raw_snapshots (fetched_at ASC, id ASC, partition_id)`.catch(
              () => {},
            ),
          () =>
            sql`CREATE INDEX IF NOT EXISTS idx_google_ads_raw_snapshots_partition_endpoint
              ON google_ads_raw_snapshots (partition_id, endpoint_name, page_index)`.catch(
              () => {},
            ),
        ]),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_account_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_campaign_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_ad_group_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_ad_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_keyword_daily"))
          .catch(() => {}),
        sql
          .query(
            buildGoogleAdsWarehouseTableQuery("google_ads_search_term_daily"),
          )
          .catch(() => {}),
        sql
          .query(
            buildGoogleAdsWarehouseTableQuery("google_ads_asset_group_daily"),
          )
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_asset_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_audience_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_geo_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_device_daily"))
          .catch(() => {}),
        sql
          .query(buildGoogleAdsWarehouseTableQuery("google_ads_product_daily"))
          .catch(() => {}),
        sql`ALTER TABLE google_ads_search_term_daily ADD COLUMN IF NOT EXISTS query_hash TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_search_term_daily ADD COLUMN IF NOT EXISTS normalized_query TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE google_ads_search_term_daily ADD COLUMN IF NOT EXISTS cluster_key TEXT`.catch(
          () => {},
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_account_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_campaign_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_ad_group_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_ad_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_keyword_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries(
          "google_ads_search_term_daily",
        ).map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries(
          "google_ads_asset_group_daily",
        ).map((query) => sql.query(query).catch(() => {})),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_asset_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_audience_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_geo_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_device_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        ...buildGoogleAdsWarehouseIndexQueries("google_ads_product_daily").map(
          (query) => sql.query(query).catch(() => {}),
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_term_daily_query_hash
          ON google_ads_search_term_daily (business_id, date DESC, query_hash)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_query_dictionary (
          query_hash       TEXT PRIMARY KEY,
          normalized_query TEXT NOT NULL,
          display_query    TEXT NOT NULL,
          token_count      INTEGER NOT NULL DEFAULT 0,
          first_seen_date  DATE NOT NULL,
          last_seen_date   DATE NOT NULL,
          created_at       TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at       TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_google_ads_query_dictionary_normalized
          ON google_ads_query_dictionary (normalized_query)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS google_ads_search_query_hot_daily (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date               DATE NOT NULL,
          account_timezone   TEXT NOT NULL DEFAULT 'UTC',
          account_currency   TEXT NOT NULL DEFAULT 'USD',
          query_hash         TEXT NOT NULL REFERENCES google_ads_query_dictionary(query_hash) ON DELETE RESTRICT,
          campaign_id        TEXT,
          campaign_name      TEXT,
          ad_group_id        TEXT,
          ad_group_name      TEXT,
          cluster_key        TEXT NOT NULL,
          cluster_label      TEXT NOT NULL,
          theme_key          TEXT,
          intent_class       TEXT,
          ownership_class    TEXT,
          spend              NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue            NUMERIC(18, 4) NOT NULL DEFAULT 0,
          conversions        NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions        BIGINT NOT NULL DEFAULT 0,
          clicks             BIGINT NOT NULL DEFAULT 0,
          source_snapshot_id UUID REFERENCES google_ads_raw_snapshots(id) ON DELETE SET NULL,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, query_hash, campaign_id, ad_group_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_query_hot_daily_business_date
          ON google_ads_search_query_hot_daily (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_query_hot_daily_query
          ON google_ads_search_query_hot_daily (query_hash, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_top_query_weekly (
          id                 UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id        TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          week_start         DATE NOT NULL,
          week_end           DATE NOT NULL,
          query_hash         TEXT NOT NULL REFERENCES google_ads_query_dictionary(query_hash) ON DELETE RESTRICT,
          query_count_days   INTEGER NOT NULL DEFAULT 0,
          spend              NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue            NUMERIC(18, 4) NOT NULL DEFAULT 0,
          conversions        NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions        BIGINT NOT NULL DEFAULT 0,
          clicks             BIGINT NOT NULL DEFAULT 0,
          created_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at         TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, week_start, query_hash)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_top_query_weekly_business
          ON google_ads_top_query_weekly (business_id, provider_account_id, week_start DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_search_cluster_daily (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          provider_account_id     TEXT NOT NULL,
          date                    DATE NOT NULL,
          cluster_key             TEXT NOT NULL,
          cluster_label           TEXT NOT NULL,
          theme_key               TEXT,
          dominant_intent_class   TEXT,
          dominant_ownership_class TEXT,
          unique_query_count      INTEGER NOT NULL DEFAULT 0,
          spend                   NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue                 NUMERIC(18, 4) NOT NULL DEFAULT 0,
          conversions             NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions             BIGINT NOT NULL DEFAULT 0,
          clicks                  BIGINT NOT NULL DEFAULT 0,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, date, cluster_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_search_cluster_daily_business
          ON google_ads_search_cluster_daily (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_decision_action_outcome_logs (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT,
          recommendation_fingerprint TEXT NOT NULL,
          decision_family          TEXT,
          action_type              TEXT NOT NULL,
          outcome_status           TEXT,
          summary                  TEXT NOT NULL,
          payload_json             JSONB NOT NULL DEFAULT '{}'::jsonb,
          occurred_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_decision_action_outcome_logs_business
          ON google_ads_decision_action_outcome_logs (business_id, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_decision_action_outcome_logs_recommendation
          ON google_ads_decision_action_outcome_logs (recommendation_fingerprint, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS google_ads_retention_runs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          execution_mode             TEXT NOT NULL
                                     CHECK (execution_mode IN ('dry_run', 'execute')),
          execution_enabled          BOOLEAN NOT NULL DEFAULT FALSE,
          skipped_due_to_active_lease BOOLEAN NOT NULL DEFAULT FALSE,
          total_deleted_rows         INTEGER NOT NULL DEFAULT 0,
          summary_json               JSONB NOT NULL DEFAULT '{}'::jsonb,
          error_message              TEXT,
          started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at                TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_google_ads_retention_runs_finished
          ON google_ads_retention_runs (finished_at DESC NULLS LAST, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_raw_snapshots (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL DEFAULT 'shop',
          start_date           DATE,
          end_date             DATE,
          payload_json         JSONB NOT NULL DEFAULT '{}'::jsonb,
          payload_hash         TEXT NOT NULL,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          provider_http_status INTEGER,
          status               TEXT NOT NULL DEFAULT 'fetched'
                               CHECK (status IN ('fetched', 'partial', 'failed')),
          fetched_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        // ── Shopify two-layer content + observation ────────────────────────
        //
        // Same principle and the same shapes as meta_raw_snapshots, applied to
        // the same problem: a large majority of rows are exact repeats of a
        // payload already stored. Only the tables differ — there is no second
        // decision core, so the model is deliberately identical rather than
        // re-invented.
        //
        // Additive: content_key is set by NEW writes only, so the partial
        // unique index cannot collide with the existing duplicates and no
        // rewrite of the table is needed.
        sql`ALTER TABLE shopify_raw_snapshots
          ADD COLUMN IF NOT EXISTS content_key TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_raw_snapshots
          ADD COLUMN IF NOT EXISTS first_observed_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_raw_snapshots
          ADD COLUMN IF NOT EXISTS last_observed_at TIMESTAMPTZ`.catch(() => {}),
        sql`ALTER TABLE shopify_raw_snapshots
          ADD COLUMN IF NOT EXISTS observation_count INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        // CONCURRENTLY: this builds a unique index on a multi-gigabyte relation.
        // A plain CREATE INDEX takes ACCESS EXCLUSIVE for the whole build and
        // would stall every reader and writer of shopify_raw_snapshots for the
        // duration. Repair first, because IF NOT EXISTS matches on name alone
        // and an interrupted CONCURRENTLY build leaves an INVALID index that it
        // silently accepts; then verify, because an index this migration is
        // responsible for either exists usable or the migration has not
        // succeeded.
        sql.query(
          buildInvalidIndexRepairQuery({
            indexName: "shopify_raw_snapshots_content_identity",
            definitionMustContain: ["(content_key)", "WHERE (content_key IS NOT NULL)"],
          }),
        ),
        sql`CREATE UNIQUE INDEX CONCURRENTLY IF NOT EXISTS shopify_raw_snapshots_content_identity
          ON shopify_raw_snapshots (content_key)
          WHERE content_key IS NOT NULL`.catch(() => {}),
        sql.query(
          buildIndexContractQuery({
            indexName: "shopify_raw_snapshots_content_identity",
            definitionMustContain: ["(content_key)", "WHERE (content_key IS NOT NULL)"],
          }),
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_raw_snapshot_observations (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          snapshot_id          UUID NOT NULL
                               REFERENCES shopify_raw_snapshots(id) ON DELETE RESTRICT,
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          endpoint_name        TEXT NOT NULL,
          entity_scope         TEXT NOT NULL,
          status               TEXT NOT NULL,
          provider_http_status INTEGER,
          request_context      JSONB NOT NULL DEFAULT '{}'::jsonb,
          response_headers     JSONB NOT NULL DEFAULT '{}'::jsonb,
          observed_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          first_observed_at    TIMESTAMPTZ NOT NULL DEFAULT now(),
          last_observed_at     TIMESTAMPTZ NOT NULL DEFAULT now(),
          observation_count    INTEGER NOT NULL DEFAULT 1,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        // Shopify snapshots have no partition/run/checkpoint lifecycle, so the
        // receipt identity is (content, status, instant) — the same rule as on
        // the Meta side, minus the columns that do not exist here.
        sql`CREATE UNIQUE INDEX IF NOT EXISTS shopify_raw_snapshot_observations_identity
          ON shopify_raw_snapshot_observations (snapshot_id, status, observed_at)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshot_observations_retention
          ON shopify_raw_snapshot_observations (observed_at ASC, id ASC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshot_observations_snapshot
          ON shopify_raw_snapshot_observations (snapshot_id)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshot_observations_timeline
          ON shopify_raw_snapshot_observations (
            business_id, provider_account_id, endpoint_name, observed_at DESC
          )`.catch(() => {}),
        // The retention sweep scans this table ordered by (fetched_at ASC,
        // id ASC). The business index above is DESC and business-scoped, so it
        // cannot serve that scan — without this the Shopify content sweep runs
        // a sequential scan of a 13.9 GB relation on a destructive path.
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_shopify_raw_snapshots_retention
          ON shopify_raw_snapshots (fetched_at ASC, id ASC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshots_business
          ON shopify_raw_snapshots (business_id, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshots_account
          ON shopify_raw_snapshots (provider_account_id, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_raw_snapshots_endpoint
          ON shopify_raw_snapshots (endpoint_name, fetched_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_entity_payload_archives (
          id                      UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id             TEXT NOT NULL,
          business_ref_id         UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id     TEXT NOT NULL,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                 TEXT NOT NULL,
          entity_type             TEXT NOT NULL,
          entity_id               TEXT NOT NULL,
          parent_entity_id        TEXT,
          payload_hash            TEXT NOT NULL,
          payload_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          source_snapshot_id      UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          source_updated_at       TIMESTAMPTZ,
          created_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at              TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, entity_type, entity_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_entity_payload_archives_business_account
          ON shopify_entity_payload_archives (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_entity_payload_archives_entity
          ON shopify_entity_payload_archives (entity_type, entity_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_shop_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          shop_domain                TEXT,
          shop_currency_code         TEXT,
          default_order_currency_code TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_shop_dimensions_business_account
          ON shopify_shop_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_shop_dimensions_shop
          ON shopify_shop_dimensions (shop_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_customer_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          customer_id                TEXT NOT NULL,
          last_order_id              TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, customer_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_dimensions_business_account
          ON shopify_customer_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_dimensions_customer
          ON shopify_customer_dimensions (customer_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_product_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          product_id                 TEXT NOT NULL,
          product_title              TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, product_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_product_dimensions_business_account
          ON shopify_product_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_product_dimensions_product
          ON shopify_product_dimensions (product_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_variant_dimensions (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                TEXT NOT NULL,
          business_ref_id            UUID REFERENCES businesses(id) ON DELETE SET NULL,
          provider_account_id        TEXT NOT NULL,
          provider_account_ref_id    UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          shop_id                    TEXT NOT NULL,
          product_id                 TEXT,
          variant_id                 TEXT NOT NULL,
          sku                        TEXT,
          product_title              TEXT,
          variant_title              TEXT,
          projection_json            JSONB NOT NULL DEFAULT '{}'::jsonb,
          first_seen_at              TIMESTAMPTZ,
          last_seen_at               TIMESTAMPTZ,
          source_updated_at          TIMESTAMPTZ,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, variant_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_variant_dimensions_business_account
          ON shopify_variant_dimensions (business_id, provider_account_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_variant_dimensions_variant
          ON shopify_variant_dimensions (variant_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_orders (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT NOT NULL,
          shop_id                  TEXT NOT NULL,
          order_id                 TEXT NOT NULL,
          order_name               TEXT,
          customer_id              TEXT,
          currency_code            TEXT,
          shop_currency_code       TEXT,
          order_created_at         TIMESTAMPTZ NOT NULL,
          order_created_date_local DATE,
          order_updated_at         TIMESTAMPTZ,
          order_updated_date_local DATE,
          order_processed_at       TIMESTAMPTZ,
          order_cancelled_at       TIMESTAMPTZ,
          order_closed_at          TIMESTAMPTZ,
          financial_status         TEXT,
          fulfillment_status       TEXT,
          customer_journey_summary JSONB NOT NULL DEFAULT '{}'::jsonb,
          subtotal_price           NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_discounts          NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_shipping           NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_tax                NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_refunded           NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_price              NUMERIC(18, 4) NOT NULL DEFAULT 0,
          original_total_price     NUMERIC(18, 4) NOT NULL DEFAULT 0,
          current_total_price      NUMERIC(18, 4) NOT NULL DEFAULT 0,
          source_snapshot_id       UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, order_id)
        )`.catch(() => {}),
        sql`ALTER TABLE shopify_orders
          ADD COLUMN IF NOT EXISTS order_created_date_local DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_orders
          ADD COLUMN IF NOT EXISTS order_updated_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_orders
          ADD COLUMN IF NOT EXISTS order_updated_date_local DATE`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_account_created_local
          ON shopify_orders (business_id, provider_account_id, order_created_date_local DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_account_created_fallback
          ON shopify_orders (business_id, provider_account_id, (order_created_at::date) DESC)
          WHERE order_created_date_local IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_created
          ON shopify_orders (business_id, order_created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_created_local
          ON shopify_orders (business_id, order_created_date_local DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_business_updated
          ON shopify_orders (business_id, order_updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_shop_created
          ON shopify_orders (shop_id, order_created_at DESC)`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_orders_customer
          ON shopify_orders (business_id, customer_id, order_created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_order_lines (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT NOT NULL,
          line_item_id         TEXT NOT NULL,
          product_id           TEXT,
          variant_id           TEXT,
          sku                  TEXT,
          title                TEXT,
          variant_title        TEXT,
          quantity             INTEGER NOT NULL DEFAULT 0,
          discounted_total     NUMERIC(18, 4) NOT NULL DEFAULT 0,
          original_total       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          tax_total            NUMERIC(18, 4) NOT NULL DEFAULT 0,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, order_id, line_item_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_order_lines_business_product
          ON shopify_order_lines (business_id, product_id, variant_id)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_refunds (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT NOT NULL,
          refund_id            TEXT NOT NULL,
          refunded_at          TIMESTAMPTZ NOT NULL,
          refunded_date_local  DATE,
          refunded_sales       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          refunded_shipping    NUMERIC(18, 4) NOT NULL DEFAULT 0,
          refunded_taxes       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          total_refunded       NUMERIC(18, 4) NOT NULL DEFAULT 0,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, refund_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_refunded
          ON shopify_refunds (business_id, refunded_at DESC)`.catch(() => {}),
        sql`ALTER TABLE shopify_refunds
          ADD COLUMN IF NOT EXISTS refunded_date_local DATE`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_account_refunded_local
          ON shopify_refunds (business_id, provider_account_id, refunded_date_local DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_account_refunded_fallback
          ON shopify_refunds (business_id, provider_account_id, (refunded_at::date) DESC)
          WHERE refunded_date_local IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_refunds_business_refunded_local
          ON shopify_refunds (business_id, refunded_date_local DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_order_transactions (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT NOT NULL,
          transaction_id       TEXT NOT NULL,
          kind                 TEXT,
          status               TEXT,
          gateway              TEXT,
          processed_at         TIMESTAMPTZ,
          amount               NUMERIC(18, 4) NOT NULL DEFAULT 0,
          currency_code        TEXT,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, transaction_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_order_transactions_business_processed
          ON shopify_order_transactions (business_id, processed_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_returns (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          order_id             TEXT,
          return_id            TEXT NOT NULL,
          status               TEXT,
          created_at_provider  TIMESTAMPTZ NOT NULL,
          created_date_local   DATE,
          updated_at_provider  TIMESTAMPTZ,
          updated_date_local   DATE,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, return_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_created
          ON shopify_returns (business_id, created_at_provider DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_returns
          ADD COLUMN IF NOT EXISTS created_date_local DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_returns
          ADD COLUMN IF NOT EXISTS updated_date_local DATE`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_account_created_local
          ON shopify_returns (business_id, provider_account_id, created_date_local DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_account_created_fallback
          ON shopify_returns (business_id, provider_account_id, (created_at_provider::date) DESC)
          WHERE created_date_local IS NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_returns_business_created_local
          ON shopify_returns (business_id, created_date_local DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_customer_events (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          event_id             TEXT NOT NULL,
          event_type           TEXT NOT NULL,
          occurred_at          TIMESTAMPTZ NOT NULL,
          customer_id          TEXT,
          session_id           TEXT,
          page_type            TEXT,
          page_url             TEXT,
          consent_state        TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, event_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_events_business_occurred
          ON shopify_customer_events (business_id, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_customer_events_session
          ON shopify_customer_events (business_id, session_id, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_sales_events (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          shop_id              TEXT NOT NULL,
          event_id             TEXT NOT NULL,
          source_kind          TEXT NOT NULL,
          source_id            TEXT NOT NULL,
          order_id             TEXT,
          occurred_at          TIMESTAMPTZ NOT NULL,
          occurred_date_local  DATE,
          gross_sales          NUMERIC(18,2) NOT NULL DEFAULT 0,
          refunded_sales       NUMERIC(18,2) NOT NULL DEFAULT 0,
          refunded_shipping    NUMERIC(18,2) NOT NULL DEFAULT 0,
          refunded_taxes       NUMERIC(18,2) NOT NULL DEFAULT 0,
          net_revenue          NUMERIC(18,2) NOT NULL DEFAULT 0,
          currency_code        TEXT,
          source_snapshot_id   UUID REFERENCES shopify_raw_snapshots(id) ON DELETE SET NULL,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, shop_id, event_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_sales_events_business_date
          ON shopify_sales_events (business_id, occurred_date_local DESC, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_sales_events_order
          ON shopify_sales_events (business_id, order_id, occurred_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_serving_overrides (
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          override_key         TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          mode                 TEXT NOT NULL DEFAULT 'auto',
          reason               TEXT,
          updated_by           TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, override_key)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_overrides_business_range
          ON shopify_serving_overrides (business_id, start_date DESC, end_date DESC, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_webhook_deliveries (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT,
          provider_account_id  TEXT,
          topic                TEXT NOT NULL,
          shop_domain          TEXT NOT NULL,
          webhook_id           TEXT,
          payload_hash         TEXT NOT NULL,
          received_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          processed_at         TIMESTAMPTZ,
          processing_state     TEXT NOT NULL DEFAULT 'received',
          error_message        TEXT,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (shop_domain, topic, payload_hash)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_webhook_deliveries_business
          ON shopify_webhook_deliveries (business_id, received_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_reconciliation_runs (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          reconciliation_key   TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          preferred_source     TEXT,
          can_serve_warehouse  BOOLEAN NOT NULL DEFAULT FALSE,
          selected_revenue_truth_basis TEXT,
          basis_selection_reason TEXT,
          transaction_coverage_order_rate DOUBLE PRECISION,
          transaction_coverage_amount_rate DOUBLE PRECISION,
          order_revenue_truth_delta DOUBLE PRECISION,
          transaction_revenue_delta DOUBLE PRECISION,
          explained_adjustment_revenue DOUBLE PRECISION,
          unexplained_adjustment_revenue DOUBLE PRECISION,
          divergence           JSONB,
          warehouse_aggregate  JSONB,
          ledger_aggregate     JSONB,
          live_aggregate       JSONB,
          recorded_at          TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_reconciliation_runs_business_recorded
          ON shopify_reconciliation_runs (business_id, recorded_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS selected_revenue_truth_basis TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS basis_selection_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS transaction_coverage_order_rate DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS transaction_coverage_amount_rate DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS order_revenue_truth_delta DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS transaction_revenue_delta DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS explained_adjustment_revenue DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_reconciliation_runs
          ADD COLUMN IF NOT EXISTS unexplained_adjustment_revenue DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_serving_state (
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          canary_key           TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          time_zone_basis      TEXT,
          assessed_at          TIMESTAMPTZ,
          status_state         TEXT,
          preferred_source     TEXT,
          can_serve_warehouse  BOOLEAN NOT NULL DEFAULT FALSE,
          canary_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
          decision_reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
          divergence           JSONB,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, canary_key)
        )`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS start_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS end_date DATE`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS time_zone_basis TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_recent_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_timestamp TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_value TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_recent_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_timestamp TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_value TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_historical_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_historical_ready_through_date DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS orders_historical_target_end DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_historical_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_historical_ready_through_date DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS returns_historical_target_end DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS production_mode TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS trust_state TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS fallback_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS coverage_status TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair_started_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair_last_topic TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS pending_repair_last_received_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state
          ADD COLUMN IF NOT EXISTS consecutive_clean_validations INTEGER NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_business_updated
          ON shopify_serving_state (business_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_business_range
          ON shopify_serving_state (business_id, start_date DESC, end_date DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_serving_state_history (
          id                   UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id          TEXT NOT NULL,
          provider_account_id  TEXT NOT NULL,
          canary_key           TEXT NOT NULL,
          start_date           DATE,
          end_date             DATE,
          time_zone_basis      TEXT,
          assessed_at          TIMESTAMPTZ,
          status_state         TEXT,
          preferred_source     TEXT,
          orders_recent_synced_at TIMESTAMPTZ,
          orders_recent_cursor_timestamp TIMESTAMPTZ,
          orders_recent_cursor_value TEXT,
          returns_recent_synced_at TIMESTAMPTZ,
          returns_recent_cursor_timestamp TIMESTAMPTZ,
          returns_recent_cursor_value TEXT,
          orders_historical_synced_at TIMESTAMPTZ,
          orders_historical_ready_through_date DATE,
          orders_historical_target_end DATE,
          returns_historical_synced_at TIMESTAMPTZ,
          returns_historical_ready_through_date DATE,
          returns_historical_target_end DATE,
          can_serve_warehouse  BOOLEAN NOT NULL DEFAULT FALSE,
          canary_enabled       BOOLEAN NOT NULL DEFAULT FALSE,
          decision_reasons     JSONB NOT NULL DEFAULT '[]'::jsonb,
          divergence           JSONB,
          created_at           TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at           TIMESTAMPTZ NOT NULL DEFAULT now()
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_history_business_assessed
          ON shopify_serving_state_history (business_id, assessed_at DESC, created_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_serving_state_history_business_range
          ON shopify_serving_state_history (business_id, start_date DESC, end_date DESC, assessed_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_recent_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_timestamp TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_recent_cursor_value TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_recent_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_timestamp TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_recent_cursor_value TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_historical_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_historical_ready_through_date DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS orders_historical_target_end DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_historical_synced_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_historical_ready_through_date DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS returns_historical_target_end DATE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS production_mode TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS trust_state TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS fallback_reason TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS coverage_status TEXT`.catch(() => {}),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair_started_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair_last_topic TEXT`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS pending_repair_last_received_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_serving_state_history
          ADD COLUMN IF NOT EXISTS consecutive_clean_validations INTEGER NOT NULL DEFAULT 0`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_repair_intents (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          entity_type TEXT NOT NULL,
          entity_id TEXT NOT NULL,
          topic TEXT NOT NULL,
          payload_hash TEXT NOT NULL,
          event_timestamp TIMESTAMPTZ,
          event_age_days INTEGER,
          escalation_level INTEGER NOT NULL DEFAULT 0,
          status TEXT NOT NULL DEFAULT 'pending',
          attempt_count INTEGER NOT NULL DEFAULT 0,
          last_error TEXT,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider_account_id, entity_type, entity_id, topic, payload_hash)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_repair_intents_business_updated
          ON shopify_repair_intents (business_id, updated_at DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS shopify_sync_state (
          business_id              TEXT NOT NULL,
          provider_account_id      TEXT NOT NULL,
          sync_target              TEXT NOT NULL,
          historical_target_start  DATE,
          historical_target_end    DATE,
          ready_through_date       DATE,
          cursor_timestamp         TIMESTAMPTZ,
          cursor_value             TEXT,
          latest_sync_started_at   TIMESTAMPTZ,
          latest_successful_sync_at TIMESTAMPTZ,
          latest_sync_status       TEXT,
          latest_sync_window_start DATE,
          latest_sync_window_end   DATE,
          last_error               TEXT,
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (business_id, provider_account_id, sync_target)
        )`.catch(() => {}),
        sql`ALTER TABLE shopify_sync_state
          ADD COLUMN IF NOT EXISTS cursor_timestamp TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE shopify_sync_state
          ADD COLUMN IF NOT EXISTS cursor_value TEXT`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_shopify_sync_state_business
          ON shopify_sync_state (business_id, updated_at DESC)`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS platform_overview_daily_summary (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_account_id TEXT NOT NULL,
          date DATE NOT NULL,
          spend NUMERIC(18, 4) NOT NULL DEFAULT 0,
          revenue NUMERIC(18, 4) NOT NULL DEFAULT 0,
          purchases NUMERIC(18, 4) NOT NULL DEFAULT 0,
          impressions BIGINT NOT NULL DEFAULT 0,
          clicks BIGINT NOT NULL DEFAULT 0,
          source_updated_at TIMESTAMPTZ,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider, provider_account_id, date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_daily_summary_business_provider_date
          ON platform_overview_daily_summary (business_id, provider, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_daily_summary_business_account_date
          ON platform_overview_daily_summary (business_id, provider_account_id, date DESC)`.catch(
          () => {},
        ),
        sql`CREATE TABLE IF NOT EXISTS platform_overview_summary_ranges (
          id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id TEXT NOT NULL,
          provider TEXT NOT NULL,
          provider_account_ids_hash TEXT NOT NULL,
          start_date DATE NOT NULL,
          end_date DATE NOT NULL,
          row_count INTEGER NOT NULL DEFAULT 0,
          expected_row_count INTEGER,
          coverage_complete BOOLEAN NOT NULL DEFAULT FALSE,
          max_source_updated_at TIMESTAMPTZ,
          truth_state TEXT,
          projection_version INTEGER NOT NULL DEFAULT 1,
          invalidation_reason TEXT,
          hydrated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, provider, provider_account_ids_hash, start_date, end_date)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_summary_ranges_business_provider
          ON platform_overview_summary_ranges (business_id, provider, hydrated_at DESC)`.catch(
          () => {},
        ),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS expected_row_count INTEGER`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS coverage_complete BOOLEAN NOT NULL DEFAULT FALSE`.catch(
          () => {},
        ),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS max_source_updated_at TIMESTAMPTZ`.catch(
          () => {},
        ),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS truth_state TEXT`.catch(() => {}),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS projection_version INTEGER NOT NULL DEFAULT 1`.catch(
          () => {},
        ),
        sql`ALTER TABLE platform_overview_summary_ranges
          ADD COLUMN IF NOT EXISTS invalidation_reason TEXT`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS platform_overview_summary_range_accounts (
          summary_range_id UUID NOT NULL REFERENCES platform_overview_summary_ranges(id) ON DELETE CASCADE,
          provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL,
          provider_account_id TEXT NOT NULL,
          position INTEGER NOT NULL DEFAULT 0,
          created_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (summary_range_id, provider_account_id)
        )`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_summary_range_accounts_range
          ON platform_overview_summary_range_accounts (summary_range_id, position ASC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_platform_overview_summary_range_accounts_provider_account_ref
          ON platform_overview_summary_range_accounts (provider_account_ref_id)`.catch(
          () => {},
        ),
      ]);

      // Deliberately AFTER the batch above has settled, and deliberately not an
      // entry in it.
      //
      // Every `sql` in a batch array starts the moment the array literal is
      // evaluated (see the note on runMigrationBatchSequentially), so an entry
      // here would issue `DROP TRIGGER ... ON meta_campaign_config_history`
      // concurrently with the `ALTER TABLE meta_campaign_config_history ADD
      // COLUMN` entries a few lines above it. Both need ACCESS EXCLUSIVE on the
      // same table, so one waits on the other and can reach statement_timeout.
      // That was survivable only while the error was being thrown away; now that
      // it is not, the statements have to run where nothing else is holding the
      // lock — and where the tables the batch creates definitely exist.
      await applyMetaConfigGrowthGuard(sql);

      // Widen sync_worker_heartbeats.status to admit 'disabled'.
      //
      // A staged worker — started by the cutover with every lane off, so the
      // release can be inspected before it is enabled — heartbeats 'disabled'.
      // The CHECK constraint above predates that status, and CREATE TABLE IF
      // NOT EXISTS does not touch an existing table, so on any database that
      // already has this table the first staged heartbeat fails with 23514 and
      // the worker crash-loops. The staging concession is worthless without
      // this.
      await sql.query(
        `ALTER TABLE sync_worker_heartbeats DROP CONSTRAINT IF EXISTS sync_worker_heartbeats_status_check`,
      );
      await sql.query(
        `ALTER TABLE sync_worker_heartbeats ADD CONSTRAINT sync_worker_heartbeats_status_check
           CHECK (status IN ('starting', 'idle', 'running', 'stopping', 'stopped', 'disabled'))`,
      );

      // ── Engine v3 pre-computed analytics tables (schema only) ─────────────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS engine_v3_job_runs (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          job_name                   TEXT NOT NULL,
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL,
          status                     TEXT NOT NULL CHECK (status IN ('running', 'success', 'failed', 'skipped')),
          dependency_run_id          UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          started_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          finished_at                TIMESTAMPTZ,
          duration_ms                INTEGER,
          row_count                  INTEGER,
          source_min_date            DATE,
          source_max_date            DATE,
          source_max_updated_at      TIMESTAMPTZ,
          input_hash                 TEXT,
          retry_count                INTEGER NOT NULL DEFAULT 0,
          error_code                 TEXT,
          error_message              TEXT,
          error_json                 JSONB,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_job_runs_lookup
          ON engine_v3_job_runs (job_name, business_ref_id, as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_job_runs_status
          ON engine_v3_job_runs (status, started_at DESC)
          WHERE status IN ('running', 'failed')`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_job_runs_business_recent
          ON engine_v3_job_runs (business_ref_id, started_at DESC)`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_account_calibration_daily (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          scope_type                 TEXT NOT NULL DEFAULT 'account',
          scope_id                   TEXT NOT NULL DEFAULT '*',
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL,
          sample_window_start        DATE NOT NULL,
          sample_window_end          DATE NOT NULL,
          sample_window_days         INTEGER NOT NULL,
          eligible_creative_count    INTEGER NOT NULL DEFAULT 0,
          mature_creative_count      INTEGER NOT NULL DEFAULT 0,
          zero_conversion_count      INTEGER NOT NULL DEFAULT 0,
          roas_p75                   DOUBLE PRECISION,
          roas_p60                   DOUBLE PRECISION,
          refresh_ratio_p10          DOUBLE PRECISION,
          low_ctr_p10                DOUBLE PRECISION,
          account_cpa_p50            DOUBLE PRECISION,
          account_cpa_sample_count   INTEGER NOT NULL DEFAULT 0,
          meta_attributed_aov_mean_90d DOUBLE PRECISION,
          meta_attributed_aov_purchase_count_90d INTEGER NOT NULL DEFAULT 0,
          meta_attributed_revenue_90d DOUBLE PRECISION,
          meta_aov_quality           TEXT
                                      CHECK (meta_aov_quality IN ('unavailable', 'unstable', 'low_sample', 'ready')),
          mature_spend_p50           DOUBLE PRECISION,
          mature_spend_p75           DOUBLE PRECISION,
          winner_spend_p25           DOUBLE PRECISION,
          winner_spend_p50           DOUBLE PRECISION,
          winner_purchase_p50        DOUBLE PRECISION,
          roas_ratio_p10             DOUBLE PRECISION,
          roas_ratio_p25             DOUBLE PRECISION,
          roas_ratio_p50             DOUBLE PRECISION,
          roas_ratio_p75             DOUBLE PRECISION,
          source_min_date            DATE,
          source_max_date            DATE,
          source_max_updated_at      TIMESTAMPTZ,
          quality_status             TEXT NOT NULL DEFAULT 'ready' CHECK (quality_status IN ('ready', 'low_sample', 'stale', 'fallback')),
          job_run_id                 UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          input_hash                 TEXT,
          computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          campaign_kind              TEXT NOT NULL DEFAULT 'all'
                                      CHECK (campaign_kind IN ('all', 'main', 'test', 'mixed')),
          UNIQUE (business_ref_id, scope_type, scope_id, as_of_date, engine_version)
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_calibration_latest
          ON engine_v3_account_calibration_daily
          (business_ref_id, scope_type, scope_id, as_of_date DESC)
          INCLUDE (roas_p75, roas_p60, refresh_ratio_p10, low_ctr_p10, quality_status, source_max_date)`,
        sql`ALTER TABLE engine_v3_account_calibration_daily
          ADD COLUMN IF NOT EXISTS account_cpa_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS account_cpa_sample_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS meta_attributed_aov_mean_90d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS meta_attributed_aov_purchase_count_90d INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS meta_attributed_revenue_90d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS meta_aov_quality TEXT
            CHECK (meta_aov_quality IN ('unavailable', 'unstable', 'low_sample', 'ready')),
          ADD COLUMN IF NOT EXISTS mature_spend_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS mature_spend_p75 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_spend_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_spend_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS winner_purchase_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p10 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS roas_ratio_p75 DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`ALTER TABLE engine_v3_account_calibration_daily
          ADD COLUMN IF NOT EXISTS creative_format TEXT NOT NULL DEFAULT 'overall',
          ADD COLUMN IF NOT EXISTS campaign_kind TEXT NOT NULL DEFAULT 'all'
            CHECK (campaign_kind IN ('all', 'main', 'test', 'mixed')),
          ADD COLUMN IF NOT EXISTS ctr_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ctr_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS cpm_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS cpm_p75 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS thumbstop_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS thumbstop_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_lpv_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_lpv_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_atc_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_atc_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS lpv_to_atc_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS lpv_to_atc_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_ic_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_ic_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ic_to_purchase_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ic_to_purchase_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS click_to_purchase_p25 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS click_to_purchase_p50 DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS funnel_sample_count INTEGER NOT NULL DEFAULT 0,
          ADD COLUMN IF NOT EXISTS funnel_quality_status TEXT
            CHECK (funnel_quality_status IN ('ready', 'low_sample', 'insufficient'))`.catch(
          () => {},
        ),
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_calibration_latest_by_kind
          ON engine_v3_account_calibration_daily
          (business_ref_id, scope_type, scope_id, campaign_kind, as_of_date DESC, creative_format)`,
        sql`DO $$
          DECLARE
            old_constraint_name TEXT;
          BEGIN
            FOR old_constraint_name IN
              SELECT c.conname
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_account_calibration_daily'
                AND c.contype = 'u'
                AND (
                  (
                    SELECT array_agg(a.attname::text ORDER BY u.ord)
                    FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
                  ) = ARRAY['business_ref_id', 'scope_type', 'scope_id', 'as_of_date', 'engine_version']
                  OR (
                    SELECT array_agg(a.attname::text ORDER BY u.ord)
                    FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                    JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
                  ) = ARRAY[
                    'business_ref_id',
                    'scope_type',
                    'scope_id',
                    'creative_format',
                    'as_of_date',
                    'engine_version'
                  ]
                )
            LOOP
              PERFORM set_config('lock_timeout', '2000ms', true);
              EXECUTE format(
                'ALTER TABLE engine_v3_account_calibration_daily DROP CONSTRAINT %I',
                old_constraint_name
              );
            END LOOP;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_account_calibration_daily'
                AND c.contype = 'u'
                AND (
                  SELECT array_agg(a.attname::text ORDER BY u.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
                ) = ARRAY[
                  'business_ref_id',
                  'scope_type',
                  'scope_id',
                  'campaign_kind',
                  'creative_format',
                  'as_of_date',
                  'engine_version'
                ]
            ) THEN
              PERFORM set_config('lock_timeout', '2000ms', true);
              ALTER TABLE engine_v3_account_calibration_daily
                ADD CONSTRAINT engine_v3_account_calibration_daily_format_unique
                UNIQUE (business_ref_id, scope_type, scope_id, campaign_kind, creative_format, as_of_date, engine_version);
            END IF;
          END
          $$`.catch(() => {}),
        sql`CREATE TABLE IF NOT EXISTS engine_v3_creative_lifecycle_daily (
          id                            UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id               UUID NOT NULL,
          business_id                   TEXT,
          provider_account_ref_id       UUID,
          provider_account_id           TEXT,
          campaign_id                   TEXT,
          adset_id                      TEXT,
          ad_id                         TEXT,
          creative_id                   TEXT NOT NULL,
          effective_object_story_id     TEXT,
          post_id                       TEXT,
          creative_identity_hash        TEXT,
          as_of_date                    DATE NOT NULL,
          engine_version                TEXT NOT NULL,
          spend_28d                     DOUBLE PRECISION,
          purchases_28d                 DOUBLE PRECISION,
          purchase_value_28d            DOUBLE PRECISION,
          impressions_28d               BIGINT,
          link_clicks_28d               BIGINT,
          roas_28d                      DOUBLE PRECISION,
          cpa_28d                       DOUBLE PRECISION,
          ctr_28d                       DOUBLE PRECISION,
          frequency_28d                 DOUBLE PRECISION,
          spend_7d                      DOUBLE PRECISION,
          purchases_7d                  DOUBLE PRECISION,
          roas_7d                       DOUBLE PRECISION,
          impressions_7d                BIGINT,
          first_seen_date               DATE,
          last_active_date              DATE,
          active_days_30d               INTEGER,
          age_days                      INTEGER,
          peak_roas_30d                 DOUBLE PRECISION,
          peak_roas_date                DATE,
          days_since_peak               INTEGER,
          peak_confidence               DOUBLE PRECISION,
          peak_spend_30d                DOUBLE PRECISION,
          peak_purchases_30d            DOUBLE PRECISION,
          spend_slope_7d                DOUBLE PRECISION,
          spend_slope_30d               DOUBLE PRECISION,
          roas_slope_7d                 DOUBLE PRECISION,
          roas_slope_30d                DOUBLE PRECISION,
          spend_trajectory_30d          TEXT CHECK (spend_trajectory_30d IN ('rising', 'flat', 'falling', 'volatile', 'unknown')),
          lifecycle_position            TEXT CHECK (lifecycle_position IN (
            'rising', 'plateau', 'closing',
            'past_peak_inaction', 'past_peak_natural', 'past_peak_unclear',
            'volatile', 'insufficient_history'
          )),
          fatigue_status                TEXT CHECK (fatigue_status IN ('none', 'watch', 'fatigued', 'unknown')),
          fatigue_confidence            DOUBLE PRECISION,
          fatigue_evidence              JSONB,
          decision_recommended_at       TIMESTAMPTZ,
          operator_response_detected_at TIMESTAMPTZ,
          operator_response_type        TEXT CHECK (operator_response_type IN (
            'scaled', 'ignored', 'paused', 'creative_archived', 'budget_cut', 'unknown'
          )),
          effective_status              TEXT,
          objective                      TEXT,
          target_roas                   DOUBLE PRECISION,
          breakeven_roas                DOUBLE PRECISION,
          data_freshness_hours          INTEGER,
          source_max_date               DATE,
          source_max_updated_at         TIMESTAMPTZ,
          eligible_for_lifecycle        BOOLEAN NOT NULL DEFAULT true,
          job_run_id                    UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          input_hash                    TEXT,
          computed_at                   TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                    TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_ref_id, creative_id, as_of_date, engine_version)
        )`,
        sql`ALTER TABLE engine_v3_creative_lifecycle_daily
          ADD COLUMN IF NOT EXISTS cpm_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS outbound_clicks_28d INTEGER,
          ADD COLUMN IF NOT EXISTS landing_page_views_28d INTEGER,
          ADD COLUMN IF NOT EXISTS add_to_cart_28d INTEGER,
          ADD COLUMN IF NOT EXISTS initiate_checkout_28d INTEGER,
          ADD COLUMN IF NOT EXISTS thumbstop_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video25_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video50_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video75_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS video100_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS quality_ranking TEXT,
          ADD COLUMN IF NOT EXISTS engagement_rate_ranking TEXT,
          ADD COLUMN IF NOT EXISTS conversion_rate_ranking TEXT,
          ADD COLUMN IF NOT EXISTS creative_format TEXT,
          ADD COLUMN IF NOT EXISTS outbound_click_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_lpv_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS link_to_atc_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS lpv_to_atc_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_ic_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS ic_to_purchase_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS atc_to_purchase_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS click_to_purchase_rate_28d DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS funnel_primary_weak_stage TEXT
            CHECK (funnel_primary_weak_stage IN ('upper_funnel', 'landing_page', 'checkout', 'tracking', 'none', 'insufficient_signal')),
          ADD COLUMN IF NOT EXISTS funnel_confidence DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS funnel_evidence JSONB,
          ADD COLUMN IF NOT EXISTS creative_responsibility_score DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS site_responsibility_score DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS checkout_responsibility_score DOUBLE PRECISION,
          ADD COLUMN IF NOT EXISTS tracking_anomaly_score DOUBLE PRECISION`.catch(
          () => {},
        ),
        sql`DO $$
          DECLARE
            old_constraint_name TEXT;
          BEGIN
            SELECT c.conname
            INTO old_constraint_name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema()
              AND t.relname = 'engine_v3_creative_lifecycle_daily'
              AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) LIKE '%operator_response_type%'
              AND pg_get_constraintdef(c.oid) NOT LIKE '%creative_archived%'
            LIMIT 1;

            IF old_constraint_name IS NOT NULL THEN
              EXECUTE format(
                'ALTER TABLE engine_v3_creative_lifecycle_daily DROP CONSTRAINT %I',
                old_constraint_name
              );
            END IF;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_creative_lifecycle_daily'
                AND c.contype = 'c'
                AND pg_get_constraintdef(c.oid) LIKE '%operator_response_type%'
                AND pg_get_constraintdef(c.oid) LIKE '%creative_archived%'
            ) THEN
              ALTER TABLE engine_v3_creative_lifecycle_daily
                ADD CONSTRAINT engine_v3_creative_lifecycle_daily_operator_response_type_check
                CHECK (operator_response_type IN (
                  'scaled', 'ignored', 'paused', 'creative_archived', 'budget_cut', 'unknown'
                ));
            END IF;
          END
          $$`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_lifecycle_business_day
          ON engine_v3_creative_lifecycle_daily
          (business_ref_id, as_of_date DESC, creative_id)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_lifecycle_creative_timeline
          ON engine_v3_creative_lifecycle_daily
          (business_ref_id, creative_id, as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_lifecycle_attention
          ON engine_v3_creative_lifecycle_daily
          (business_ref_id, as_of_date DESC, lifecycle_position)
          WHERE lifecycle_position IN ('rising', 'plateau', 'past_peak_inaction', 'past_peak_unclear')`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_decision_evaluation_contexts (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL CHECK (length(btrim(engine_version)) > 0),
          scope_type                 TEXT NOT NULL CHECK (length(btrim(scope_type)) > 0),
          scope_id                   TEXT NOT NULL CHECK (length(btrim(scope_id)) > 0),
          contract_version           TEXT NOT NULL CHECK (length(btrim(contract_version)) > 0),
          context_json               JSONB NOT NULL CHECK (jsonb_typeof(context_json) = 'object'),
          account_profile_json       JSONB NOT NULL CHECK (jsonb_typeof(account_profile_json) = 'object'),
          data_health_json           JSONB NOT NULL CHECK (jsonb_typeof(data_health_json) = 'object'),
          flags_json                 JSONB NOT NULL CHECK (jsonb_typeof(flags_json) = 'object'),
          context_hash               CHAR(64) NOT NULL
                                       CHECK (context_hash ~ '^[0-9a-f]{64}$'),
          job_run_id                 UUID NOT NULL,
          evaluated_at               TIMESTAMPTZ NOT NULL,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT engine_v3_eval_contexts_business_fk
            FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT,
          CONSTRAINT engine_v3_eval_contexts_job_run_fk
            FOREIGN KEY (job_run_id) REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT,
          CONSTRAINT engine_v3_eval_contexts_run_scope_hash_unique
            UNIQUE (
              job_run_id,
              business_ref_id,
              as_of_date,
              engine_version,
              scope_type,
              scope_id,
              context_hash
            ),
          CONSTRAINT engine_v3_eval_contexts_lineage_unique
            UNIQUE (
              id,
              business_ref_id,
              as_of_date,
              engine_version,
              scope_type,
              scope_id,
              contract_version,
              job_run_id
            )
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_eval_contexts_business_scope
          ON engine_v3_decision_evaluation_contexts
          (business_ref_id, as_of_date DESC, engine_version, scope_type, scope_id, evaluated_at DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_eval_contexts_job_run
          ON engine_v3_decision_evaluation_contexts (job_run_id, evaluated_at DESC)`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_decision_evaluations (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          context_id                 UUID NOT NULL,
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          creative_id                TEXT NOT NULL CHECK (length(btrim(creative_id)) > 0),
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL CHECK (length(btrim(engine_version)) > 0),
          scope_type                 TEXT NOT NULL CHECK (length(btrim(scope_type)) > 0),
          scope_id                   TEXT NOT NULL CHECK (length(btrim(scope_id)) > 0),
          contract_version           TEXT NOT NULL CHECK (length(btrim(contract_version)) > 0),
          creative_input_json        JSONB NOT NULL CHECK (jsonb_typeof(creative_input_json) = 'object'),
          campaign_context_json      JSONB NOT NULL CHECK (jsonb_typeof(campaign_context_json) = 'object'),
          prior_hysteresis_json      JSONB NOT NULL CHECK (jsonb_typeof(prior_hysteresis_json) = 'object'),
          decision_output_json       JSONB NOT NULL CHECK (jsonb_typeof(decision_output_json) = 'object'),
          raw_label                  TEXT NOT NULL CHECK (raw_label IN (
            'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
          )),
          hysteresis_suppressed      BOOLEAN NOT NULL DEFAULT FALSE,
          input_hash                 CHAR(64) NOT NULL CHECK (input_hash ~ '^[0-9a-f]{64}$'),
          decision_hash              CHAR(64) NOT NULL CHECK (decision_hash ~ '^[0-9a-f]{64}$'),
          job_run_id                 UUID NOT NULL,
          evaluated_at               TIMESTAMPTZ NOT NULL,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT engine_v3_decision_evaluations_business_fk
            FOREIGN KEY (business_ref_id) REFERENCES businesses(id) ON DELETE RESTRICT,
          CONSTRAINT engine_v3_decision_evaluations_job_run_fk
            FOREIGN KEY (job_run_id) REFERENCES engine_v3_job_runs(id) ON DELETE RESTRICT,
          CONSTRAINT engine_v3_decision_evaluations_context_lineage_fk
            FOREIGN KEY (
              context_id,
              business_ref_id,
              as_of_date,
              engine_version,
              scope_type,
              scope_id,
              contract_version,
              job_run_id
            ) REFERENCES engine_v3_decision_evaluation_contexts (
              id,
              business_ref_id,
              as_of_date,
              engine_version,
              scope_type,
              scope_id,
              contract_version,
              job_run_id
            ) ON DELETE RESTRICT,
          CONSTRAINT engine_v3_decision_evaluations_event_unique
            UNIQUE (context_id, creative_id, input_hash, decision_hash)
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_evaluations_business_scope_creative
          ON engine_v3_decision_evaluations
          (business_ref_id, as_of_date DESC, engine_version, scope_type, scope_id, creative_id)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_evaluations_creative_timeline
          ON engine_v3_decision_evaluations
          (business_ref_id, creative_id, as_of_date DESC, evaluated_at DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_evaluations_context
          ON engine_v3_decision_evaluations (context_id, evaluated_at DESC)`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_decision_snapshots_daily (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          creative_id                TEXT NOT NULL,
          as_of_date                 DATE NOT NULL,
          engine_version             TEXT NOT NULL,
          scope_type                 TEXT NOT NULL DEFAULT 'account',
          scope_id                   TEXT NOT NULL DEFAULT '*',
          label                      TEXT NOT NULL CHECK (label IN (
            'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
          )),
          pre_authority_label        TEXT,
          authority_blocker          TEXT,
          confidence                 INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
          truth_source               TEXT NOT NULL CHECK (truth_source IN (
            'commercial_truth', 'commercial_truth_stale', 'account_baseline',
            'account_baseline_thin', 'global_default'
          )),
          effective_target_roas      DOUBLE PRECISION NOT NULL,
          ratio_to_target            DOUBLE PRECISION,
          badges                     JSONB NOT NULL DEFAULT '[]'::jsonb,
          reason                     TEXT NOT NULL,
          spend                      DOUBLE PRECISION,
          purchases                  DOUBLE PRECISION,
          roas                       DOUBLE PRECISION,
          recent7d_roas              DOUBLE PRECISION,
          label_transform            TEXT CHECK (label_transform IN ('test_cohort_refresh_to_cut')),
          blocked_action_type        TEXT CHECK (blocked_action_type IN ('scale', 'cut', 'refresh')),
          job_run_id                 UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          lifecycle_row_id           UUID REFERENCES engine_v3_creative_lifecycle_daily(id) ON DELETE SET NULL,
          calibration_row_id         UUID REFERENCES engine_v3_account_calibration_daily(id) ON DELETE SET NULL,
          evaluation_id              UUID,
          input_hash                 TEXT,
          decision_hash              CHAR(64),
          computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_ref_id, creative_id, as_of_date, engine_version, scope_type, scope_id)
        )`,
        sql`ALTER TABLE engine_v3_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS scope_type TEXT NOT NULL DEFAULT 'account',
          ADD COLUMN IF NOT EXISTS scope_id TEXT NOT NULL DEFAULT '*',
          ADD COLUMN IF NOT EXISTS label_transform TEXT CHECK (label_transform IN ('test_cohort_refresh_to_cut')),
          ADD COLUMN IF NOT EXISTS blocked_action_type TEXT CHECK (blocked_action_type IN ('scale', 'cut', 'refresh')),
          ADD COLUMN IF NOT EXISTS evaluation_id UUID,
          ADD COLUMN IF NOT EXISTS decision_hash CHAR(64)`.catch(() => {}),
        sql`DO $$
          BEGIN
            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_decision_snapshots_daily'
                AND c.conname = 'engine_v3_decision_snapshots_daily_evaluation_fk'
            ) THEN
              ALTER TABLE engine_v3_decision_snapshots_daily
                ADD CONSTRAINT engine_v3_decision_snapshots_daily_evaluation_fk
                FOREIGN KEY (evaluation_id)
                REFERENCES engine_v3_decision_evaluations(id)
                ON DELETE RESTRICT;
            END IF;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_decision_snapshots_daily'
                AND c.conname = 'engine_v3_decision_snapshots_daily_decision_hash_check'
            ) THEN
              ALTER TABLE engine_v3_decision_snapshots_daily
                ADD CONSTRAINT engine_v3_decision_snapshots_daily_decision_hash_check
                CHECK (decision_hash IS NULL OR decision_hash ~ '^[0-9a-f]{64}$');
            END IF;
          END
          $$`,
        sql`DO $$
          DECLARE
            old_constraint_name TEXT;
          BEGIN
            SELECT c.conname
            INTO old_constraint_name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema()
              AND t.relname = 'engine_v3_decision_snapshots_daily'
              AND c.contype = 'c'
              AND pg_get_constraintdef(c.oid) LIKE '%truth_source%'
              AND pg_get_constraintdef(c.oid) NOT LIKE '%commercial_truth_stale%'
            LIMIT 1;

            IF old_constraint_name IS NOT NULL THEN
              EXECUTE format(
                'ALTER TABLE engine_v3_decision_snapshots_daily DROP CONSTRAINT %I',
                old_constraint_name
              );
            END IF;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_decision_snapshots_daily'
                AND c.contype = 'c'
                AND pg_get_constraintdef(c.oid) LIKE '%truth_source%'
                AND pg_get_constraintdef(c.oid) LIKE '%commercial_truth_stale%'
            ) THEN
              ALTER TABLE engine_v3_decision_snapshots_daily
                ADD CONSTRAINT engine_v3_decision_snapshots_daily_truth_source_check
                CHECK (truth_source IN (
                  'commercial_truth', 'commercial_truth_stale', 'account_baseline',
                  'account_baseline_thin', 'global_default'
                ));
            END IF;
          END
          $$`,
        sql`DO $$
          DECLARE
            old_constraint_name TEXT;
          BEGIN
            SELECT c.conname
            INTO old_constraint_name
            FROM pg_constraint c
            JOIN pg_class t ON t.oid = c.conrelid
            JOIN pg_namespace n ON n.oid = t.relnamespace
            WHERE n.nspname = current_schema()
              AND t.relname = 'engine_v3_decision_snapshots_daily'
              AND c.contype = 'u'
              AND (
                SELECT array_agg(a.attname::text ORDER BY u.ord)
                FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
              ) = ARRAY['business_ref_id', 'creative_id', 'as_of_date', 'engine_version']
            LIMIT 1;

            IF old_constraint_name IS NOT NULL THEN
              EXECUTE format(
                'ALTER TABLE engine_v3_decision_snapshots_daily DROP CONSTRAINT %I',
                old_constraint_name
              );
            END IF;

            IF NOT EXISTS (
              SELECT 1
              FROM pg_constraint c
              JOIN pg_class t ON t.oid = c.conrelid
              JOIN pg_namespace n ON n.oid = t.relnamespace
              WHERE n.nspname = current_schema()
                AND t.relname = 'engine_v3_decision_snapshots_daily'
                AND c.contype = 'u'
                AND (
                  SELECT array_agg(a.attname::text ORDER BY u.ord)
                  FROM unnest(c.conkey) WITH ORDINALITY AS u(attnum, ord)
                  JOIN pg_attribute a ON a.attrelid = c.conrelid AND a.attnum = u.attnum
                ) = ARRAY[
                  'business_ref_id',
                  'creative_id',
                  'as_of_date',
                  'engine_version',
                  'scope_type',
                  'scope_id'
                ]
            ) THEN
              ALTER TABLE engine_v3_decision_snapshots_daily
                ADD CONSTRAINT engine_v3_decision_snapshots_daily_scope_unique
                UNIQUE (business_ref_id, creative_id, as_of_date, engine_version, scope_type, scope_id);
            END IF;
          END
          $$`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_decisions_business_day_label
          ON engine_v3_decision_snapshots_daily
          (business_ref_id, as_of_date DESC, label)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_decisions_creative_timeline
          ON engine_v3_decision_snapshots_daily
          (business_ref_id, creative_id, as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_decisions_first_scale
          ON engine_v3_decision_snapshots_daily
          (business_ref_id, creative_id, as_of_date)
          WHERE label = 'scale'`,
        sql`CREATE UNIQUE INDEX IF NOT EXISTS idx_engine_v3_decisions_evaluation_unique
          ON engine_v3_decision_snapshots_daily (evaluation_id)
          WHERE evaluation_id IS NOT NULL`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_decisions_decision_hash
          ON engine_v3_decision_snapshots_daily (business_ref_id, decision_hash)
          WHERE decision_hash IS NOT NULL`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_decision_events (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          creative_id                TEXT NOT NULL,
          event_date                 DATE NOT NULL,
          event_type                 TEXT NOT NULL CHECK (event_type IN (
            'decision_changed',
            'operator_action',
            'data_disabled',
            'manual_override'
          )),
          previous_label             TEXT,
          current_label              TEXT,
          previous_confidence        INTEGER,
          current_confidence         INTEGER,
          operator_action_type       TEXT CHECK (operator_action_type IN (
            'scaled', 'paused', 'budget_increased', 'budget_decreased', 'creative_archived', 'unknown'
          )),
          operator_evidence          JSONB,
          decision_snapshot_id       UUID REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE SET NULL,
          job_run_id                 UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          notes                      TEXT,
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now()
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_events_business_date
          ON engine_v3_decision_events
          (business_ref_id, event_date DESC, event_type)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_events_creative_timeline
          ON engine_v3_decision_events
          (business_ref_id, creative_id, event_date DESC)`,
        sql`CREATE TABLE IF NOT EXISTS engine_v3_decision_outcomes_daily (
          id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          decision_snapshot_id       UUID NOT NULL REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE CASCADE,
          business_ref_id            UUID NOT NULL,
          business_id                TEXT,
          creative_id                TEXT NOT NULL,
          decision_as_of_date        DATE NOT NULL,
          evaluation_date            DATE NOT NULL,
          outcome_window_days        INTEGER NOT NULL CHECK (outcome_window_days IN (7, 14)),
          engine_version             TEXT NOT NULL,
          label                      TEXT NOT NULL CHECK (label IN (
            'scale', 'keep', 'refresh', 'cut', 'test_more', 'diagnose', 'out_of_scope'
          )),
          pre_authority_label        TEXT,
          authority_blocker          TEXT,
          confidence                 INTEGER NOT NULL CHECK (confidence >= 0 AND confidence <= 100),
          effective_target_roas      DOUBLE PRECISION NOT NULL,
          baseline_spend             DOUBLE PRECISION,
          baseline_purchases         DOUBLE PRECISION,
          baseline_roas              DOUBLE PRECISION,
          outcome_spend              DOUBLE PRECISION NOT NULL DEFAULT 0,
          outcome_purchases          DOUBLE PRECISION NOT NULL DEFAULT 0,
          outcome_revenue            DOUBLE PRECISION NOT NULL DEFAULT 0,
          outcome_roas               DOUBLE PRECISION,
          realized_outcome           TEXT NOT NULL CHECK (realized_outcome IN (
            'positive', 'negative', 'neutral', 'unknown'
          )),
          severity                   TEXT NOT NULL CHECK (severity IN (
            'critical', 'high', 'medium', 'low'
          )),
          classifier_version         TEXT NOT NULL,
          evidence_json              JSONB NOT NULL DEFAULT '{}'::jsonb,
          job_run_id                 UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          computed_at                TIMESTAMPTZ NOT NULL DEFAULT now(),
          created_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at                 TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (decision_snapshot_id, outcome_window_days)
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_outcomes_business_eval
          ON engine_v3_decision_outcomes_daily
          (business_ref_id, evaluation_date DESC, outcome_window_days)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_outcomes_label_window
          ON engine_v3_decision_outcomes_daily
          (business_ref_id, label, outcome_window_days, decision_as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_outcomes_snapshot
          ON engine_v3_decision_outcomes_daily
          (decision_snapshot_id, outcome_window_days)`,
        sql.query(LEGACY_DECISION_SNAPSHOT_PROVENANCE_SQL),
        sql.query(LEGACY_DECISION_OUTCOME_PROVENANCE_SQL),
      ]);

      // ── Decision-label hysteresis: persist the raw (pre-hysteresis) label ─
      await runMigrationBatchSequentially([
        sql`ALTER TABLE engine_v3_decision_snapshots_daily
          ADD COLUMN IF NOT EXISTS raw_label TEXT NULL,
          ADD COLUMN IF NOT EXISTS blocked_action_type TEXT CHECK (blocked_action_type IN ('scale', 'cut', 'refresh'))`,
      ]);

      // Creative Briefs are separate workflow objects linked to immutable
      // decision evidence. They never alter or decorate a decision row.
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS meta_creative_briefs (
          id                       UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id              UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          provider_account_id      TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
          contract_version         TEXT NOT NULL DEFAULT 'meta-creative-brief.v1'
                                     CHECK (contract_version = 'meta-creative-brief.v1'),
          idempotency_key          TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
          create_request_hash      TEXT NOT NULL CHECK (length(create_request_hash) = 64),
          source_decision_id       TEXT NOT NULL CHECK (length(btrim(source_decision_id)) > 0),
          source_snapshot_id       UUID NOT NULL REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE RESTRICT,
          source_creative_id       TEXT NOT NULL CHECK (length(btrim(source_creative_id)) > 0),
          source_engine_version    TEXT NOT NULL CHECK (length(btrim(source_engine_version)) > 0),
          source_snapshot_as_of    DATE NOT NULL,
          source_scope_type        TEXT NOT NULL,
          source_scope_id          TEXT NOT NULL,
          source_published_label   TEXT NOT NULL,
          source_raw_label         TEXT,
          source_reason            TEXT NOT NULL,
          source_badges_json       JSONB NOT NULL DEFAULT '[]'::jsonb
                                     CHECK (jsonb_typeof(source_badges_json) = 'array'),
          source_trigger           TEXT NOT NULL CHECK (length(btrim(source_trigger)) > 0),
          keep_text                TEXT NOT NULL DEFAULT '',
          change_text              TEXT NOT NULL DEFAULT '',
          next_text                TEXT NOT NULL DEFAULT '',
          status                   TEXT NOT NULL DEFAULT 'draft'
                                     CHECK (status IN ('draft', 'reviewed')),
          version                  INTEGER NOT NULL DEFAULT 1 CHECK (version > 0),
          created_by               UUID REFERENCES users(id) ON DELETE SET NULL,
          updated_by               UUID REFERENCES users(id) ON DELETE SET NULL,
          reviewed_by              UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at               TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          reviewed_at              TIMESTAMPTZ,
          UNIQUE (business_id, provider_account_id, idempotency_key),
          CHECK (
            (status = 'draft' AND reviewed_at IS NULL)
            OR (status = 'reviewed' AND reviewed_at IS NOT NULL)
          )
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_briefs_account_recent
          ON meta_creative_briefs
          (business_id, provider_account_id, updated_at DESC, id DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_creative_briefs_source_decision
          ON meta_creative_briefs
          (business_id, provider_account_id, source_decision_id, created_at DESC)`,
      ]);

      // Launchpad workflow objects are explicitly Meta-account scoped. Legacy
      // draft/template rows remain nullable and are withheld by account-scoped
      // readers rather than being guessed into an account.
      await runMigrationBatchSequentially([
        sql`ALTER TABLE creative_share_snapshots
          ADD COLUMN IF NOT EXISTS provider_account_id TEXT`,
        sql`CREATE INDEX IF NOT EXISTS idx_creative_share_snapshots_account_recent
          ON creative_share_snapshots
          (business_id, provider_account_id, created_at DESC)
          WHERE provider_account_id IS NOT NULL`,
        sql`ALTER TABLE meta_launch_drafts
          ADD COLUMN IF NOT EXISTS provider_account_id TEXT`,
        sql`ALTER TABLE meta_launch_templates
          ADD COLUMN IF NOT EXISTS provider_account_id TEXT`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_launch_drafts_account_recent
          ON meta_launch_drafts
          (business_id, provider_account_id, updated_at DESC, id DESC)
          WHERE provider_account_id IS NOT NULL`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_launch_templates_account_recent
          ON meta_launch_templates
          (business_id, provider_account_id, source, updated_at DESC, id DESC)
          WHERE provider_account_id IS NOT NULL`,
      ]);

      // LaunchIntent is the immutable account-bound command envelope between
      // Decisions/Creative Briefs and guarded provider writes. All executions
      // remain PAUSED-only; outcome receipts explicitly deny retry/rollback.
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS meta_launch_intents (
          id                          UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id                 UUID NOT NULL REFERENCES businesses(id) ON DELETE CASCADE,
          provider_account_id         TEXT NOT NULL CHECK (length(btrim(provider_account_id)) > 0),
          operation                   TEXT NOT NULL CHECK (operation IN ('new_campaign', 'add_to_existing')),
          idempotency_key             TEXT NOT NULL CHECK (length(btrim(idempotency_key)) > 0),
          requested_status            TEXT NOT NULL DEFAULT 'PAUSED' CHECK (requested_status = 'PAUSED'),
          source_decision_id          TEXT,
          source_decision_snapshot_id UUID REFERENCES engine_v3_decision_snapshots_daily(id) ON DELETE RESTRICT,
          creative_brief_id           UUID REFERENCES meta_creative_briefs(id) ON DELETE RESTRICT,
          source_draft_id              UUID REFERENCES meta_launch_drafts(id) ON DELETE RESTRICT,
          request_payload_json        JSONB NOT NULL CHECK (jsonb_typeof(request_payload_json) = 'object'),
          request_fingerprint         TEXT NOT NULL CHECK (length(request_fingerprint) = 64),
          status                      TEXT NOT NULL DEFAULT 'prepared' CHECK (status IN (
            'prepared', 'validation_blocked', 'write_blocked', 'ready',
            'executing', 'succeeded', 'partially_succeeded', 'failed',
            'silent_failure'
          )),
          validation_receipt_json     JSONB,
          result_receipt_json         JSONB,
          error_receipt_json          JSONB,
          created_by                  UUID REFERENCES users(id) ON DELETE SET NULL,
          created_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_at                  TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          started_at                  TIMESTAMPTZ,
          completed_at                TIMESTAMPTZ,
          UNIQUE (business_id, provider_account_id, operation, idempotency_key),
          CHECK (validation_receipt_json IS NULL OR jsonb_typeof(validation_receipt_json) = 'object'),
          CHECK (result_receipt_json IS NULL OR jsonb_typeof(result_receipt_json) = 'object'),
          CHECK (error_receipt_json IS NULL OR jsonb_typeof(error_receipt_json) = 'object')
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_launch_intents_business_account_recent
          ON meta_launch_intents
          (business_id, provider_account_id, created_at DESC, id DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_launch_intents_lineage_decision
          ON meta_launch_intents (business_id, source_decision_id)
          WHERE source_decision_id IS NOT NULL`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_launch_intents_lineage_brief
          ON meta_launch_intents (business_id, creative_brief_id)
          WHERE creative_brief_id IS NOT NULL`,
        sql`ALTER TABLE meta_ads_action_log
          ADD COLUMN IF NOT EXISTS launch_intent_id UUID
          REFERENCES meta_launch_intents(id) ON DELETE SET NULL`,
        sql`CREATE INDEX IF NOT EXISTS idx_meta_ads_action_log_launch_intent
          ON meta_ads_action_log (launch_intent_id, requested_at ASC)
          WHERE launch_intent_id IS NOT NULL`,
      ]);

      // ── Automatic campaign context (D033): daily inferred campaign role ──
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS engine_v3_campaign_context_daily (
          id                    UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          business_id           TEXT NOT NULL,
          provider_account_id   TEXT,
          campaign_id           TEXT NOT NULL,
          campaign_name         TEXT,
          as_of_date            DATE NOT NULL,
          inferred_kind         TEXT NULL CHECK (
            inferred_kind IS NULL OR inferred_kind IN ('main', 'test', 'mixed')
          ),
          confidence_score      DOUBLE PRECISION NOT NULL DEFAULT 0,
          confidence_class      TEXT NOT NULL CHECK (confidence_class IN (
            'high', 'medium', 'low', 'unknown', 'conflict'
          )),
          kind_source           TEXT NOT NULL DEFAULT 'system_inferred',
          kind_basis            TEXT NOT NULL DEFAULT 'behavioral',
          resolver_version      TEXT NOT NULL,
          signal_scores_json    JSONB NOT NULL DEFAULT '{}'::jsonb,
          evidence_json         JSONB NOT NULL DEFAULT '[]'::jsonb,
          conflict_reasons_json JSONB NOT NULL DEFAULT '[]'::jsonb,
          hysteresis_state_json JSONB NOT NULL DEFAULT '{}'::jsonb,
          input_freshness_json  JSONB NOT NULL DEFAULT '{}'::jsonb,
          job_run_id            UUID REFERENCES engine_v3_job_runs(id) ON DELETE SET NULL,
          created_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          updated_at            TIMESTAMPTZ NOT NULL DEFAULT now(),
          UNIQUE (business_id, campaign_id, as_of_date)
        )`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_campaign_context_business_date
          ON engine_v3_campaign_context_daily (business_id, as_of_date DESC)`,
        sql`CREATE INDEX IF NOT EXISTS idx_engine_v3_campaign_context_campaign
          ON engine_v3_campaign_context_daily (business_id, campaign_id, as_of_date DESC)`,
      ]);

      // ── Engine v3 rollout feature flags (NULL = inherit env default) ─────
      await runMigrationBatchSequentially([
        sql`CREATE TABLE IF NOT EXISTS business_engine_v3_flags (
          business_id     UUID PRIMARY KEY REFERENCES businesses(id) ON DELETE CASCADE,
          enabled         BOOLEAN NULL,
          surface_visible BOOLEAN NULL,
          shadow_only     BOOLEAN NULL,
          notes           TEXT NULL,
          updated_at      TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          updated_by      TEXT NULL
        )`,
        sql`ALTER TABLE business_engine_v3_flags
          ADD COLUMN IF NOT EXISTS enabled BOOLEAN NULL,
          ADD COLUMN IF NOT EXISTS surface_visible BOOLEAN NULL,
          ADD COLUMN IF NOT EXISTS shadow_only BOOLEAN NULL,
          ADD COLUMN IF NOT EXISTS notes TEXT NULL,
          ADD COLUMN IF NOT EXISTS updated_at TIMESTAMPTZ NOT NULL DEFAULT NOW(),
          ADD COLUMN IF NOT EXISTS updated_by TEXT NULL`.catch(() => {}),
      ]);

      // ── Engine v3 per-business preset override (NULL = inherit chain) ───
      await runMigrationBatchSequentially([
        sql`ALTER TABLE business_engine_v3_flags
          ADD COLUMN IF NOT EXISTS preset_override TEXT NULL
            CHECK (preset_override IS NULL
              OR preset_override IN ('aggressive', 'balanced', 'conservative'))`.catch(
          () => {},
        ),
      ]);

      await runMigrationBatchSequentially([
        ...CANONICAL_BUSINESS_REF_TABLES.map((tableName) =>
          sql
            .query(
              `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS business_ref_id UUID REFERENCES businesses(id) ON DELETE SET NULL`,
            )
            .catch(() => {}),
        ),
        ...CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `ALTER TABLE ${tableName} ADD COLUMN IF NOT EXISTS provider_account_ref_id UUID REFERENCES provider_accounts(id) ON DELETE SET NULL`,
            )
            .catch(() => {}),
        ),
      ]);

      const [
        metaProviderAccountsSeeded,
        googleProviderAccountsSeeded,
        shopifyProviderAccountsSeeded,
      ] = await Promise.all([
        doesProviderAccountSeedExist(sql, "meta"),
        doesProviderAccountSeedExist(sql, "google"),
        doesProviderAccountSeedExist(sql, "shopify"),
      ]);

      if (metaProviderAccountsSeeded) {
        logStartupEvent(
          "migration_provider_account_seed_skipped_existing_rows",
          {
            provider: "meta",
          },
        );
      }
      if (googleProviderAccountsSeeded) {
        logStartupEvent(
          "migration_provider_account_seed_skipped_existing_rows",
          {
            provider: "google",
          },
        );
      }
      if (shopifyProviderAccountsSeeded) {
        logStartupEvent(
          "migration_provider_account_seed_skipped_existing_rows",
          {
            provider: "shopify",
          },
        );
      }

      await runMigrationBatchSequentially([
        ...(metaProviderAccountsSeeded
          ? []
          : [
              sql
                .query(
                  `
            INSERT INTO provider_accounts (
              provider,
              external_account_id,
              created_at,
              updated_at
            )
            SELECT
              'meta',
              seed.external_account_id,
              now(),
              now()
            FROM (
              ${buildProviderAccountSeedUnionQuery(META_PROVIDER_ACCOUNT_SEED_TABLES, "provider_account_id")}
              UNION
              ${buildProviderAccountSeedUnionQuery(META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES, "account_id")}
            ) AS seed
            WHERE seed.external_account_id IS NOT NULL
            ON CONFLICT (provider, external_account_id) DO UPDATE SET
              updated_at = EXCLUDED.updated_at
                `,
                )
                .catch(() => {}),
            ]),
        ...(googleProviderAccountsSeeded
          ? []
          : [
              sql
                .query(
                  `
            INSERT INTO provider_accounts (
              provider,
              external_account_id,
              created_at,
              updated_at
            )
            SELECT
              'google',
              seed.external_account_id,
              now(),
              now()
            FROM (
              ${buildProviderAccountSeedUnionQuery(GOOGLE_PROVIDER_ACCOUNT_SEED_TABLES, "provider_account_id")}
              UNION
              ${buildProviderAccountSeedUnionQuery(GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES, "account_id")}
            ) AS seed
            WHERE seed.external_account_id IS NOT NULL
            ON CONFLICT (provider, external_account_id) DO UPDATE SET
              updated_at = EXCLUDED.updated_at
                `,
                )
                .catch(() => {}),
            ]),
        ...(shopifyProviderAccountsSeeded
          ? []
          : [
              sql
                .query(
                  `
            INSERT INTO provider_accounts (
              provider,
              external_account_id,
              created_at,
              updated_at
            )
            SELECT
              'shopify',
              seed.external_account_id,
              now(),
              now()
            FROM (
              ${buildProviderAccountSeedUnionQuery(SHOPIFY_PROVIDER_ACCOUNT_SEED_TABLES, "provider_account_id")}
            ) AS seed
            WHERE seed.external_account_id IS NOT NULL
            ON CONFLICT (provider, external_account_id) DO UPDATE SET
              updated_at = EXCLUDED.updated_at
                `,
                )
                .catch(() => {}),
            ]),
        ...CANONICAL_BUSINESS_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET business_ref_id = business.id
              FROM businesses AS business
              WHERE target.business_ref_id IS NULL
                AND business.id::text = target.business_id
            `,
            )
            .catch(() => {}),
        ),
        ...META_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'meta'
                AND provider_account.external_account_id = target.provider_account_id
            `,
            )
            .catch(() => {}),
        ),
        ...GOOGLE_ADS_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'google'
                AND provider_account.external_account_id = target.provider_account_id
            `,
            )
            .catch(() => {}),
        ),
        ...SHOPIFY_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'shopify'
                AND provider_account.external_account_id = target.provider_account_id
            `,
            )
            .catch(() => {}),
        ),
        ...META_AUTHORITATIVE_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'meta'
                AND provider_account.external_account_id = target.provider_account_id
            `,
            )
            .catch(() => {}),
        ),
        ...META_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'meta'
                AND provider_account.external_account_id = target.account_id
            `,
            )
            .catch(() => {}),
        ),
        ...GOOGLE_ADS_SEARCH_INTELLIGENCE_CANONICAL_PROVIDER_REF_TABLES.map(
          (tableName) =>
            sql
              .query(
                `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'google'
                AND provider_account.external_account_id = target.provider_account_id
            `,
              )
              .catch(() => {}),
        ),
        ...GOOGLE_ADS_ACCOUNT_ID_CANONICAL_PROVIDER_REF_TABLES.map(
          (tableName) =>
            sql
              .query(
                `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'google'
                AND provider_account.external_account_id = target.account_id
            `,
              )
              .catch(() => {}),
        ),
        ...SHOPIFY_CONTROL_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = 'shopify'
                AND provider_account.external_account_id = target.provider_account_id
            `,
            )
            .catch(() => {}),
        ),
        ...GENERIC_CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `
              UPDATE ${tableName} AS target
              SET provider_account_ref_id = provider_account.id
              FROM provider_accounts AS provider_account
              WHERE target.provider_account_ref_id IS NULL
                AND provider_account.provider = CASE
                  WHEN target.provider = 'google_ads' THEN 'google'
                  ELSE target.provider
                END
                AND provider_account.external_account_id = target.provider_account_id
            `,
            )
            .catch(() => {}),
        ),
        sql
          .query(
            `
            UPDATE platform_overview_daily_summary AS target
            SET provider_account_ref_id = provider_account.id
            FROM provider_accounts AS provider_account
            WHERE target.provider_account_ref_id IS NULL
              AND provider_account.provider = target.provider
              AND provider_account.external_account_id = target.provider_account_id
          `,
          )
          .catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        sql
          .query(
            `
            WITH source_rows AS (
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'order'::text AS entity_type,
                order_id AS entity_id,
                NULL::text AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(order_updated_at, order_created_at, updated_at) AS source_updated_at
              FROM shopify_orders
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'order_line'::text AS entity_type,
                line_item_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                updated_at AS source_updated_at
              FROM shopify_order_lines
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'refund'::text AS entity_type,
                refund_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(refunded_at, updated_at) AS source_updated_at
              FROM shopify_refunds
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'transaction'::text AS entity_type,
                transaction_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(processed_at, updated_at) AS source_updated_at
              FROM shopify_order_transactions
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'return'::text AS entity_type,
                return_id AS entity_id,
                order_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(updated_at_provider, created_at_provider, updated_at) AS source_updated_at
              FROM shopify_returns
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'sales_event'::text AS entity_type,
                event_id AS entity_id,
                COALESCE(order_id, source_id) AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                source_snapshot_id,
                COALESCE(occurred_at, updated_at) AS source_updated_at
              FROM shopify_sales_events
              WHERE payload_json <> '{}'::jsonb
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                'customer_event'::text AS entity_type,
                event_id AS entity_id,
                customer_id AS parent_entity_id,
                md5(payload_json::text) AS payload_hash,
                payload_json,
                NULL::uuid AS source_snapshot_id,
                COALESCE(occurred_at, updated_at) AS source_updated_at
              FROM shopify_customer_events
              WHERE payload_json <> '{}'::jsonb
            )
            INSERT INTO shopify_entity_payload_archives (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              updated_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              now()
            FROM source_rows
            ON CONFLICT (business_id, provider_account_id, shop_id, entity_type, entity_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_entity_payload_archives.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_entity_payload_archives.provider_account_ref_id),
              parent_entity_id = COALESCE(EXCLUDED.parent_entity_id, shopify_entity_payload_archives.parent_entity_id),
              payload_hash = EXCLUDED.payload_hash,
              payload_json = EXCLUDED.payload_json,
              source_snapshot_id = COALESCE(EXCLUDED.source_snapshot_id, shopify_entity_payload_archives.source_snapshot_id),
              source_updated_at = GREATEST(COALESCE(shopify_entity_payload_archives.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
      ]);

      await runMigrationBatchSequentially([
        dropColumnIfExistsWithShortLock(sql, "shopify_orders", "payload_json"),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_order_lines",
          "payload_json",
        ),
        dropColumnIfExistsWithShortLock(sql, "shopify_refunds", "payload_json"),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_order_transactions",
          "payload_json",
        ),
        dropColumnIfExistsWithShortLock(sql, "shopify_returns", "payload_json"),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_sales_events",
          "payload_json",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_customer_events",
          "payload_json",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_webhook_deliveries",
          "payload_json",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_webhook_deliveries",
          "result_summary",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_repair_intents",
          "last_sync_result",
        ),
        dropColumnIfExistsWithShortLock(
          sql,
          "shopify_sync_state",
          "last_result_summary",
        ),
      ]);

      await runMigrationBatchSequentially([
        sql
          .query(
            `
            WITH source_rows AS (
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                provider_account_id AS shop_id,
                'webhook_delivery'::text AS entity_type,
                shop_domain || '::' || topic || '::' || payload_hash AS entity_id,
                webhook_id AS parent_entity_id,
                payload_hash,
                jsonb_strip_nulls(
                  jsonb_build_object(
                    'payload',
                    CASE
                      WHEN payload_json <> '{}'::jsonb THEN payload_json
                      ELSE NULL
                    END,
                    'resultSummary',
                    result_summary
                  )
                ) AS payload_json,
                NULL::uuid AS source_snapshot_id,
                COALESCE(processed_at, received_at, updated_at, created_at) AS source_updated_at
              FROM shopify_webhook_deliveries
              WHERE business_id IS NOT NULL
                AND provider_account_id IS NOT NULL
                AND (payload_json <> '{}'::jsonb OR result_summary IS NOT NULL)
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                provider_account_id AS shop_id,
                'repair_intent_state'::text AS entity_type,
                id::text AS entity_id,
                entity_id AS parent_entity_id,
                payload_hash,
                jsonb_build_object('lastSyncResult', last_sync_result) AS payload_json,
                NULL::uuid AS source_snapshot_id,
                updated_at AS source_updated_at
              FROM shopify_repair_intents
              WHERE last_sync_result IS NOT NULL
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                provider_account_id AS shop_id,
                'sync_state_detail'::text AS entity_type,
                sync_target AS entity_id,
                NULL::text AS parent_entity_id,
                md5(last_result_summary::text) AS payload_hash,
                jsonb_build_object('lastResultSummary', last_result_summary) AS payload_json,
                NULL::uuid AS source_snapshot_id,
                COALESCE(latest_successful_sync_at, latest_sync_started_at, updated_at) AS source_updated_at
              FROM shopify_sync_state
              WHERE last_result_summary IS NOT NULL
            )
            INSERT INTO shopify_entity_payload_archives (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              updated_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              entity_type,
              entity_id,
              parent_entity_id,
              payload_hash,
              payload_json,
              source_snapshot_id,
              source_updated_at,
              now()
            FROM source_rows
            WHERE payload_json <> '{}'::jsonb
            ON CONFLICT (business_id, provider_account_id, shop_id, entity_type, entity_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_entity_payload_archives.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_entity_payload_archives.provider_account_ref_id),
              parent_entity_id = COALESCE(EXCLUDED.parent_entity_id, shopify_entity_payload_archives.parent_entity_id),
              payload_hash = EXCLUDED.payload_hash,
              payload_json = EXCLUDED.payload_json,
              source_updated_at = GREATEST(COALESCE(shopify_entity_payload_archives.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
      ]);

      const [campaignConfigHistoryHasRows, adsetConfigHistoryHasRows] =
        await Promise.all([
          doesTableHaveRows(sql, "meta_campaign_config_history"),
          doesTableHaveRows(sql, "meta_adset_config_history"),
        ]);

      if (campaignConfigHistoryHasRows) {
        logStartupEvent(
          "migration_config_history_backfill_skipped_existing_rows",
          {
            tableName: "meta_campaign_config_history",
          },
        );
      }
      if (adsetConfigHistoryHasRows) {
        logStartupEvent(
          "migration_config_history_backfill_skipped_existing_rows",
          {
            tableName: "meta_adset_config_history",
          },
        );
      }

      await runMigrationBatchSequentially([
        sql
          .query(
            `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                MIN(order_created_at) AS first_seen_at,
                MAX(COALESCE(order_updated_at, order_created_at)) AS last_seen_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(shop_id), '') IS NOT NULL
              GROUP BY business_id, provider_account_id, shop_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                provider_account_id AS shop_domain,
                shop_currency_code,
                currency_code AS default_order_currency_code,
                COALESCE(order_updated_at, order_created_at) AS source_updated_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(shop_id), '') IS NOT NULL
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                COALESCE(order_updated_at, order_created_at) DESC NULLS LAST,
                order_created_at DESC,
                updated_at DESC
            )
            INSERT INTO shopify_shop_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              shop_domain,
              shop_currency_code,
              default_order_currency_code,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.shop_domain,
              latest.shop_currency_code,
              latest.default_order_currency_code,
              '{}'::jsonb,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
            ON CONFLICT (business_id, provider_account_id, shop_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_shop_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_shop_dimensions.provider_account_ref_id),
              shop_domain = COALESCE(EXCLUDED.shop_domain, shopify_shop_dimensions.shop_domain),
              shop_currency_code = COALESCE(EXCLUDED.shop_currency_code, shopify_shop_dimensions.shop_currency_code),
              default_order_currency_code = COALESCE(EXCLUDED.default_order_currency_code, shopify_shop_dimensions.default_order_currency_code),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_shop_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_shop_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_shop_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_shop_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                customer_id,
                MIN(order_created_at) AS first_seen_at,
                MAX(COALESCE(order_updated_at, order_created_at)) AS last_seen_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(customer_id), '') IS NOT NULL
              GROUP BY business_id, provider_account_id, shop_id, customer_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id, customer_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                customer_id,
                order_id AS last_order_id,
                COALESCE(order_updated_at, order_created_at) AS source_updated_at
              FROM shopify_orders
              WHERE NULLIF(TRIM(customer_id), '') IS NOT NULL
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                customer_id,
                COALESCE(order_updated_at, order_created_at) DESC NULLS LAST,
                order_created_at DESC,
                updated_at DESC
            )
            INSERT INTO shopify_customer_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              customer_id,
              last_order_id,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.customer_id,
              latest.last_order_id,
              '{}'::jsonb,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
             AND bounds.customer_id = latest.customer_id
            ON CONFLICT (business_id, provider_account_id, shop_id, customer_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_customer_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_customer_dimensions.provider_account_ref_id),
              last_order_id = COALESCE(EXCLUDED.last_order_id, shopify_customer_dimensions.last_order_id),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_customer_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_customer_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_customer_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_customer_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH source_rows AS (
              SELECT
                line.business_id,
                line.business_ref_id,
                line.provider_account_id,
                line.provider_account_ref_id,
                line.shop_id,
                line.product_id,
                NULLIF(TRIM(line.title), '') AS product_title,
                NULLIF(TRIM(line.sku), '') AS sku,
                NULLIF(TRIM(line.variant_title), '') AS variant_title,
                COALESCE(order_row.order_created_at, order_row.order_updated_at, line.updated_at) AS first_seen_candidate,
                COALESCE(order_row.order_updated_at, order_row.order_created_at, line.updated_at) AS source_updated_at,
                line.updated_at
              FROM shopify_order_lines AS line
              LEFT JOIN shopify_orders AS order_row
                ON order_row.business_id = line.business_id
               AND order_row.provider_account_id = line.provider_account_id
               AND order_row.shop_id = line.shop_id
               AND order_row.order_id = line.order_id
              WHERE NULLIF(TRIM(line.product_id), '') IS NOT NULL
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                product_id,
                MIN(first_seen_candidate) AS first_seen_at,
                MAX(source_updated_at) AS last_seen_at
              FROM source_rows
              GROUP BY business_id, provider_account_id, shop_id, product_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id, product_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                product_id,
                product_title,
                sku,
                variant_title,
                source_updated_at
              FROM source_rows
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                product_id,
                source_updated_at DESC NULLS LAST,
                updated_at DESC
            )
            INSERT INTO shopify_product_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              product_id,
              product_title,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.product_id,
              latest.product_title,
              jsonb_strip_nulls(jsonb_build_object(
                'sku', latest.sku,
                'variantTitle', latest.variant_title
              )),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
             AND bounds.product_id = latest.product_id
            ON CONFLICT (business_id, provider_account_id, shop_id, product_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_product_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_product_dimensions.provider_account_ref_id),
              product_title = COALESCE(EXCLUDED.product_title, shopify_product_dimensions.product_title),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_product_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_product_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_product_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_product_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH source_rows AS (
              SELECT
                line.business_id,
                line.business_ref_id,
                line.provider_account_id,
                line.provider_account_ref_id,
                line.shop_id,
                line.product_id,
                line.variant_id,
                NULLIF(TRIM(line.sku), '') AS sku,
                NULLIF(TRIM(line.title), '') AS product_title,
                NULLIF(TRIM(line.variant_title), '') AS variant_title,
                COALESCE(order_row.order_created_at, order_row.order_updated_at, line.updated_at) AS first_seen_candidate,
                COALESCE(order_row.order_updated_at, order_row.order_created_at, line.updated_at) AS source_updated_at,
                line.updated_at
              FROM shopify_order_lines AS line
              LEFT JOIN shopify_orders AS order_row
                ON order_row.business_id = line.business_id
               AND order_row.provider_account_id = line.provider_account_id
               AND order_row.shop_id = line.shop_id
               AND order_row.order_id = line.order_id
              WHERE NULLIF(TRIM(line.variant_id), '') IS NOT NULL
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                shop_id,
                variant_id,
                MIN(first_seen_candidate) AS first_seen_at,
                MAX(source_updated_at) AS last_seen_at
              FROM source_rows
              GROUP BY business_id, provider_account_id, shop_id, variant_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, shop_id, variant_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                shop_id,
                product_id,
                variant_id,
                sku,
                product_title,
                variant_title,
                source_updated_at
              FROM source_rows
              ORDER BY
                business_id,
                provider_account_id,
                shop_id,
                variant_id,
                source_updated_at DESC NULLS LAST,
                updated_at DESC
            )
            INSERT INTO shopify_variant_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              shop_id,
              product_id,
              variant_id,
              sku,
              product_title,
              variant_title,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.shop_id,
              latest.product_id,
              latest.variant_id,
              latest.sku,
              latest.product_title,
              latest.variant_title,
              '{}'::jsonb,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.source_updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.shop_id = latest.shop_id
             AND bounds.variant_id = latest.variant_id
            ON CONFLICT (business_id, provider_account_id, shop_id, variant_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, shopify_variant_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, shopify_variant_dimensions.provider_account_ref_id),
              product_id = COALESCE(EXCLUDED.product_id, shopify_variant_dimensions.product_id),
              sku = COALESCE(EXCLUDED.sku, shopify_variant_dimensions.sku),
              product_title = COALESCE(EXCLUDED.product_title, shopify_variant_dimensions.product_title),
              variant_title = COALESCE(EXCLUDED.variant_title, shopify_variant_dimensions.variant_title),
              projection_json = CASE
                WHEN EXCLUDED.projection_json = '{}'::jsonb THEN shopify_variant_dimensions.projection_json
                ELSE EXCLUDED.projection_json
              END,
              first_seen_at = COALESCE(shopify_variant_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(shopify_variant_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(shopify_variant_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
      ]);

      const googleAdsProductDimensionsHasRows = await doesTableHaveRows(
        sql,
        "google_ads_product_dimensions",
      );
      if (googleAdsProductDimensionsHasRows) {
        logStartupEvent("migration_dimension_backfill_skipped_existing_rows", {
          tableName: "google_ads_product_dimensions",
        });
      }

      const [
        metaCampaignDimensionsHasRows,
        metaAdsetDimensionsHasRows,
        metaAdDimensionsHasRows,
        metaCreativeDimensionsHasRows,
      ] = await Promise.all([
        doesTableHaveRows(sql, "meta_campaign_dimensions"),
        doesTableHaveRows(sql, "meta_adset_dimensions"),
        doesTableHaveRows(sql, "meta_ad_dimensions"),
        doesTableHaveRows(sql, "meta_creative_dimensions"),
      ]);
      if (metaCampaignDimensionsHasRows) {
        logStartupEvent("migration_dimension_backfill_skipped_existing_rows", {
          tableName: "meta_campaign_dimensions",
        });
      }
      if (metaAdsetDimensionsHasRows) {
        logStartupEvent("migration_dimension_backfill_skipped_existing_rows", {
          tableName: "meta_adset_dimensions",
        });
      }
      if (metaAdDimensionsHasRows) {
        logStartupEvent("migration_dimension_backfill_skipped_existing_rows", {
          tableName: "meta_ad_dimensions",
        });
      }
      if (metaCreativeDimensionsHasRows) {
        logStartupEvent("migration_dimension_backfill_skipped_existing_rows", {
          tableName: "meta_creative_dimensions",
        });
      }

      await runMigrationBatchSequentially([
        sql
          .query(
            `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                COALESCE(campaign_id, entity_key) AS campaign_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_campaign_daily
              WHERE COALESCE(campaign_id, entity_key) IS NOT NULL
              GROUP BY business_id, provider_account_id, COALESCE(campaign_id, entity_key)
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, COALESCE(campaign_id, entity_key))
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                COALESCE(campaign_id, entity_key) AS campaign_id,
                campaign_name,
                status,
                channel,
                payload_json,
                updated_at
              FROM google_ads_campaign_daily
              WHERE COALESCE(campaign_id, entity_key) IS NOT NULL
              ORDER BY business_id, provider_account_id, COALESCE(campaign_id, entity_key), date DESC, updated_at DESC
            )
            INSERT INTO google_ads_campaign_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              campaign_name,
              normalized_status,
              channel,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.campaign_name,
              latest.status,
              latest.channel,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.campaign_id = latest.campaign_id
            ON CONFLICT (business_id, provider_account_id, campaign_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_campaign_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_campaign_dimensions.provider_account_ref_id),
              campaign_name = EXCLUDED.campaign_name,
              normalized_status = EXCLUDED.normalized_status,
              channel = EXCLUDED.channel,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_campaign_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_campaign_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_campaign_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                COALESCE(ad_group_id, entity_key) AS ad_group_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_ad_group_daily
              WHERE COALESCE(ad_group_id, entity_key) IS NOT NULL
              GROUP BY business_id, provider_account_id, COALESCE(ad_group_id, entity_key)
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, COALESCE(ad_group_id, entity_key))
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                COALESCE(ad_group_id, entity_key) AS ad_group_id,
                ad_group_name,
                status,
                payload_json,
                updated_at
              FROM google_ads_ad_group_daily
              WHERE COALESCE(ad_group_id, entity_key) IS NOT NULL
              ORDER BY business_id, provider_account_id, COALESCE(ad_group_id, entity_key), date DESC, updated_at DESC
            )
            INSERT INTO google_ads_ad_group_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              ad_group_name,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.ad_group_id,
              latest.ad_group_name,
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.ad_group_id = latest.ad_group_id
            ON CONFLICT (business_id, provider_account_id, ad_group_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_ad_group_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_ad_group_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              ad_group_name = EXCLUDED.ad_group_name,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_ad_group_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_ad_group_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_ad_group_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS ad_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_ad_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                ad_group_id,
                entity_key AS ad_id,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_ad_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_ad_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              ad_id,
              ad_name,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.ad_group_id,
              latest.ad_id,
              COALESCE(NULLIF(latest.payload_json->>'name', ''), latest.entity_label),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.ad_id = latest.ad_id
            ON CONFLICT (business_id, provider_account_id, ad_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_ad_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_ad_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              ad_group_id = EXCLUDED.ad_group_id,
              ad_name = EXCLUDED.ad_name,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_ad_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_ad_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_ad_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS keyword_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_keyword_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                ad_group_id,
                entity_key AS keyword_id,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_keyword_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_keyword_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              keyword_id,
              keyword_text,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.ad_group_id,
              latest.keyword_id,
              COALESCE(
                NULLIF(latest.payload_json->>'keywordText', ''),
                NULLIF(latest.payload_json->>'keyword', ''),
                latest.entity_label
              ),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.keyword_id = latest.keyword_id
            ON CONFLICT (business_id, provider_account_id, keyword_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_keyword_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_keyword_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              ad_group_id = EXCLUDED.ad_group_id,
              keyword_text = EXCLUDED.keyword_text,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_keyword_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_keyword_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_keyword_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS asset_group_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_asset_group_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                entity_key AS asset_group_id,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_asset_group_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_asset_group_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              asset_group_id,
              asset_group_name,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.asset_group_id,
              COALESCE(NULLIF(latest.payload_json->>'assetGroupName', ''), latest.entity_label),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.asset_group_id = latest.asset_group_id
            ON CONFLICT (business_id, provider_account_id, asset_group_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_asset_group_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_asset_group_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              asset_group_name = EXCLUDED.asset_group_name,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_asset_group_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_asset_group_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_asset_group_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        ...(googleAdsProductDimensionsHasRows
          ? []
          : [
              sql
                .query(
                  `
            WITH bounds AS (
              SELECT
                business_id,
                provider_account_id,
                entity_key AS product_key,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM google_ads_product_daily
              WHERE entity_key IS NOT NULL
              GROUP BY business_id, provider_account_id, entity_key
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, entity_key)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                entity_key AS product_key,
                entity_label,
                status,
                payload_json,
                updated_at
              FROM google_ads_product_daily
              WHERE entity_key IS NOT NULL
              ORDER BY business_id, provider_account_id, entity_key, date DESC, updated_at DESC
            )
            INSERT INTO google_ads_product_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              product_key,
              product_title,
              normalized_status,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.product_key,
              COALESCE(
                NULLIF(latest.payload_json->>'productTitle', ''),
                NULLIF(latest.payload_json->>'title', ''),
                latest.entity_label
              ),
              latest.status,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.product_key = latest.product_key
            ON CONFLICT (business_id, provider_account_id, product_key) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, google_ads_product_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, google_ads_product_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              product_title = EXCLUDED.product_title,
              normalized_status = EXCLUDED.normalized_status,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(google_ads_product_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(google_ads_product_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(google_ads_product_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
                `,
                )
                .catch(() => {}),
            ]),
        sql
          .query(
            `
            INSERT INTO google_ads_campaign_state_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              state_fingerprint,
              campaign_name,
              normalized_status,
              channel,
              projection_json,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              COALESCE(campaign_id, entity_key) AS campaign_id,
              md5(
                jsonb_build_object(
                  'campaign_name', campaign_name,
                  'normalized_status', status,
                  'channel', channel,
                  'projection_json', COALESCE(payload_json, '{}'::jsonb)
                )::text
              ) AS state_fingerprint,
              campaign_name,
              status,
              channel,
              COALESCE(payload_json, '{}'::jsonb),
              'warehouse_daily' AS source_kind,
              NULL::uuid AS source_snapshot_id,
              MAX(COALESCE(updated_at, date::timestamptz)) AS captured_at,
              MIN(date) AS effective_from,
              MAX(date) AS effective_to,
              now()
            FROM google_ads_campaign_daily
            WHERE COALESCE(campaign_id, entity_key) IS NOT NULL
            GROUP BY
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              COALESCE(campaign_id, entity_key),
              campaign_name,
              status,
              channel,
              COALESCE(payload_json, '{}'::jsonb)
            ON CONFLICT (business_id, provider_account_id, campaign_id, state_fingerprint, captured_at) DO NOTHING
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            INSERT INTO google_ads_ad_group_state_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              ad_group_id,
              state_fingerprint,
              ad_group_name,
              normalized_status,
              projection_json,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              COALESCE(ad_group_id, entity_key) AS ad_group_id,
              md5(
                jsonb_build_object(
                  'ad_group_name', ad_group_name,
                  'normalized_status', status,
                  'projection_json', COALESCE(payload_json, '{}'::jsonb)
                )::text
              ) AS state_fingerprint,
              ad_group_name,
              status,
              COALESCE(payload_json, '{}'::jsonb),
              'warehouse_daily' AS source_kind,
              NULL::uuid AS source_snapshot_id,
              MAX(COALESCE(updated_at, date::timestamptz)) AS captured_at,
              MIN(date) AS effective_from,
              MAX(date) AS effective_to,
              now()
            FROM google_ads_ad_group_daily
            WHERE COALESCE(ad_group_id, entity_key) IS NOT NULL
            GROUP BY
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              COALESCE(ad_group_id, entity_key),
              ad_group_name,
              status,
              COALESCE(payload_json, '{}'::jsonb)
            ON CONFLICT (business_id, provider_account_id, ad_group_id, state_fingerprint, captured_at) DO NOTHING
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH should_backfill AS (
              SELECT NOT EXISTS (SELECT 1 FROM meta_campaign_dimensions LIMIT 1) AS enabled
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                campaign_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_campaign_daily
              WHERE campaign_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              GROUP BY business_id, provider_account_id, campaign_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, campaign_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                campaign_name_current,
                campaign_name_historical,
                campaign_status,
                buying_type,
                updated_at
              FROM meta_campaign_daily
              WHERE campaign_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              ORDER BY business_id, provider_account_id, campaign_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_campaign_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              campaign_name_current,
              campaign_name_historical,
              campaign_status,
              buying_type,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.campaign_name_current,
              latest.campaign_name_historical,
              latest.campaign_status,
              latest.buying_type,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.campaign_id = latest.campaign_id
            ON CONFLICT (business_id, provider_account_id, campaign_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_campaign_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_campaign_dimensions.provider_account_ref_id),
              campaign_name_current = EXCLUDED.campaign_name_current,
              campaign_name_historical = EXCLUDED.campaign_name_historical,
              campaign_status = EXCLUDED.campaign_status,
              buying_type = EXCLUDED.buying_type,
              first_seen_at = COALESCE(meta_campaign_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_campaign_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_campaign_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH should_backfill AS (
              SELECT NOT EXISTS (SELECT 1 FROM meta_adset_dimensions LIMIT 1) AS enabled
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                adset_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_adset_daily
              WHERE adset_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              GROUP BY business_id, provider_account_id, adset_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, adset_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                adset_name_current,
                adset_name_historical,
                adset_status,
                updated_at
              FROM meta_adset_daily
              WHERE adset_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              ORDER BY business_id, provider_account_id, adset_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_adset_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              adset_name_current,
              adset_name_historical,
              adset_status,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.adset_id,
              latest.adset_name_current,
              latest.adset_name_historical,
              latest.adset_status,
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.adset_id = latest.adset_id
            ON CONFLICT (business_id, provider_account_id, adset_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_adset_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_adset_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              adset_name_current = EXCLUDED.adset_name_current,
              adset_name_historical = EXCLUDED.adset_name_historical,
              adset_status = EXCLUDED.adset_status,
              first_seen_at = COALESCE(meta_adset_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_adset_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_adset_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH should_backfill AS (
              SELECT NOT EXISTS (SELECT 1 FROM meta_ad_dimensions LIMIT 1) AS enabled
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                ad_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_ad_daily
              WHERE ad_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              GROUP BY business_id, provider_account_id, ad_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, ad_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                ad_id,
                ad_name_current,
                ad_name_historical,
                ad_status,
                payload_json,
                updated_at
              FROM meta_ad_daily
              WHERE ad_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              ORDER BY business_id, provider_account_id, ad_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_ad_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              ad_id,
              ad_name_current,
              ad_name_historical,
              ad_status,
              creative_id,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.adset_id,
              latest.ad_id,
              latest.ad_name_current,
              latest.ad_name_historical,
              latest.ad_status,
              NULLIF(latest.payload_json->>'creative_id', ''),
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.ad_id = latest.ad_id
            ON CONFLICT (business_id, provider_account_id, ad_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_ad_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_ad_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              adset_id = EXCLUDED.adset_id,
              ad_name_current = EXCLUDED.ad_name_current,
              ad_name_historical = EXCLUDED.ad_name_historical,
              ad_status = EXCLUDED.ad_status,
              creative_id = COALESCE(EXCLUDED.creative_id, meta_ad_dimensions.creative_id),
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(meta_ad_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_ad_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_ad_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        sql
          .query(
            `
            WITH should_backfill AS (
              SELECT NOT EXISTS (SELECT 1 FROM meta_creative_dimensions LIMIT 1) AS enabled
            ),
            bounds AS (
              SELECT
                business_id,
                provider_account_id,
                creative_id,
                MIN(date)::timestamptz AS first_seen_at,
                MAX(date)::timestamptz AS last_seen_at
              FROM meta_creative_daily
              WHERE creative_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              GROUP BY business_id, provider_account_id, creative_id
            ),
            latest AS (
              SELECT DISTINCT ON (business_id, provider_account_id, creative_id)
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                ad_id,
                creative_id,
                creative_name,
                headline,
                primary_text,
                destination_url,
                thumbnail_url,
                asset_type,
                payload_json,
                updated_at
              FROM meta_creative_daily
              WHERE creative_id IS NOT NULL
                AND (SELECT enabled FROM should_backfill)
              ORDER BY business_id, provider_account_id, creative_id, date DESC, updated_at DESC
            )
            INSERT INTO meta_creative_dimensions (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              ad_id,
              creative_id,
              creative_name,
              headline,
              primary_text,
              destination_url,
              thumbnail_url,
              asset_type,
              projection_json,
              first_seen_at,
              last_seen_at,
              source_updated_at,
              updated_at
            )
            SELECT
              latest.business_id,
              latest.business_ref_id,
              latest.provider_account_id,
              latest.provider_account_ref_id,
              latest.campaign_id,
              latest.adset_id,
              latest.ad_id,
              latest.creative_id,
              latest.creative_name,
              latest.headline,
              latest.primary_text,
              latest.destination_url,
              latest.thumbnail_url,
              latest.asset_type,
              COALESCE(latest.payload_json, '{}'::jsonb),
              bounds.first_seen_at,
              bounds.last_seen_at,
              latest.updated_at,
              now()
            FROM latest
            INNER JOIN bounds
              ON bounds.business_id = latest.business_id
             AND bounds.provider_account_id = latest.provider_account_id
             AND bounds.creative_id = latest.creative_id
            ON CONFLICT (business_id, provider_account_id, creative_id) DO UPDATE SET
              business_ref_id = COALESCE(EXCLUDED.business_ref_id, meta_creative_dimensions.business_ref_id),
              provider_account_ref_id = COALESCE(EXCLUDED.provider_account_ref_id, meta_creative_dimensions.provider_account_ref_id),
              campaign_id = EXCLUDED.campaign_id,
              adset_id = EXCLUDED.adset_id,
              ad_id = EXCLUDED.ad_id,
              creative_name = EXCLUDED.creative_name,
              headline = EXCLUDED.headline,
              primary_text = EXCLUDED.primary_text,
              destination_url = EXCLUDED.destination_url,
              thumbnail_url = EXCLUDED.thumbnail_url,
              asset_type = EXCLUDED.asset_type,
              projection_json = EXCLUDED.projection_json,
              first_seen_at = COALESCE(meta_creative_dimensions.first_seen_at, EXCLUDED.first_seen_at),
              last_seen_at = GREATEST(COALESCE(meta_creative_dimensions.last_seen_at, EXCLUDED.last_seen_at), EXCLUDED.last_seen_at),
              source_updated_at = GREATEST(COALESCE(meta_creative_dimensions.source_updated_at, EXCLUDED.source_updated_at), EXCLUDED.source_updated_at),
              updated_at = now()
          `,
          )
          .catch(() => {}),
        ...(campaignConfigHistoryHasRows
          ? []
          : [
              sql
                .query(
                  `
            INSERT INTO meta_campaign_config_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              config_fingerprint,
              objective,
              optimization_goal,
              custom_event_type,
              bid_strategy_type,
              bid_value,
              bid_value_format,
              daily_budget,
              lifetime_budget,
              is_budget_mixed,
              is_config_mixed,
              is_optimization_goal_mixed,
              is_custom_event_type_mixed,
              is_bid_strategy_mixed,
              is_bid_value_mixed,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              source.business_id,
              source.business_ref_id,
              source.provider_account_id,
              source.provider_account_ref_id,
              source.campaign_id,
              md5(
                jsonb_build_object(
                  'objective', source.objective,
                  'optimization_goal', source.optimization_goal,
                  'custom_event_type', source.custom_event_type,
                  'bid_strategy_type', source.bid_strategy_type,
                  'bid_value', source.bid_value,
                  'bid_value_format', source.bid_value_format,
                  'daily_budget', source.daily_budget,
                  'lifetime_budget', source.lifetime_budget,
                  'is_budget_mixed', source.is_budget_mixed,
                  'is_config_mixed', source.is_config_mixed,
                  'is_optimization_goal_mixed', source.is_optimization_goal_mixed,
                  'is_custom_event_type_mixed', source.is_custom_event_type_mixed,
                  'is_bid_strategy_mixed', source.is_bid_strategy_mixed,
                  'is_bid_value_mixed', source.is_bid_value_mixed
                )::text
              ) AS config_fingerprint,
              source.objective,
              source.optimization_goal,
              source.custom_event_type,
              source.bid_strategy_type,
              source.bid_value,
              source.bid_value_format,
              source.daily_budget,
              source.lifetime_budget,
              source.is_budget_mixed,
              source.is_config_mixed,
              source.is_optimization_goal_mixed,
              source.is_custom_event_type_mixed,
              source.is_bid_strategy_mixed,
              source.is_bid_value_mixed,
              source.source_kind,
              source.source_snapshot_id,
              source.captured_at,
              source.effective_from,
              source.effective_to,
              now()
            FROM (
              SELECT
                business_id,
                business_ref_id,
                account_id AS provider_account_id,
                provider_account_ref_id,
                entity_id AS campaign_id,
                NULLIF(payload->>'objective', '') AS objective,
                NULLIF(payload->>'optimizationGoal', '') AS optimization_goal,
                NULLIF(payload->>'customEventType', '') AS custom_event_type,
                NULLIF(payload->>'bidStrategyType', '') AS bid_strategy_type,
                NULLIF(payload->>'bidValue', '')::double precision AS bid_value,
                NULLIF(payload->>'bidValueFormat', '') AS bid_value_format,
                NULLIF(payload->>'dailyBudget', '')::double precision AS daily_budget,
                NULLIF(payload->>'lifetimeBudget', '')::double precision AS lifetime_budget,
                COALESCE((payload->>'isBudgetMixed')::boolean, FALSE) AS is_budget_mixed,
                COALESCE((payload->>'isConfigMixed')::boolean, FALSE) AS is_config_mixed,
                COALESCE((payload->>'isOptimizationGoalMixed')::boolean, FALSE) AS is_optimization_goal_mixed,
                COALESCE((payload->>'isCustomEventTypeMixed')::boolean, FALSE) AS is_custom_event_type_mixed,
                COALESCE((payload->>'isBidStrategyMixed')::boolean, FALSE) AS is_bid_strategy_mixed,
                COALESCE((payload->>'isBidValueMixed')::boolean, FALSE) AS is_bid_value_mixed,
                'config_snapshot'::text AS source_kind,
                NULL::uuid AS source_snapshot_id,
                captured_at,
                snapshot_date AS effective_from,
                snapshot_date AS effective_to
              FROM meta_config_snapshots
              WHERE entity_level = 'campaign'
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                objective,
                optimization_goal,
                custom_event_type,
                bid_strategy_type,
                bid_value,
                bid_value_format,
                daily_budget,
                lifetime_budget,
                is_budget_mixed,
                is_config_mixed,
                is_optimization_goal_mixed,
                is_custom_event_type_mixed,
                is_bid_strategy_mixed,
                is_bid_value_mixed,
                'warehouse_daily'::text AS source_kind,
                source_snapshot_id,
                COALESCE(finalized_at, (date::text || 'T00:00:00Z')::timestamptz) AS captured_at,
                date AS effective_from,
                date AS effective_to
              FROM meta_campaign_daily
              WHERE campaign_id IS NOT NULL
                AND (
                  objective IS NOT NULL
                  OR optimization_goal IS NOT NULL
                  OR custom_event_type IS NOT NULL
                  OR bid_strategy_type IS NOT NULL
                  OR bid_value IS NOT NULL
                  OR daily_budget IS NOT NULL
                  OR lifetime_budget IS NOT NULL
                  OR is_budget_mixed = TRUE
                  OR is_config_mixed = TRUE
                  OR is_optimization_goal_mixed = TRUE
                  OR is_custom_event_type_mixed = TRUE
                  OR is_bid_strategy_mixed = TRUE
                  OR is_bid_value_mixed = TRUE
                )
            ) AS source
            WHERE source.campaign_id IS NOT NULL
            ON CONFLICT (business_id, provider_account_id, campaign_id, config_fingerprint, captured_at) DO NOTHING
          `,
                )
                .catch(() => {}),
            ]),
        ...(adsetConfigHistoryHasRows
          ? []
          : [
              sql
                .query(
                  `
            INSERT INTO meta_adset_config_history (
              business_id,
              business_ref_id,
              provider_account_id,
              provider_account_ref_id,
              campaign_id,
              adset_id,
              config_fingerprint,
              optimization_goal,
              custom_event_type,
              pixel_id,
              custom_conversion_id,
              promoted_object_json,
              bid_strategy_type,
              bid_value,
              bid_value_format,
              daily_budget,
              lifetime_budget,
              is_budget_mixed,
              is_config_mixed,
              is_optimization_goal_mixed,
              is_bid_strategy_mixed,
              is_bid_value_mixed,
              source_kind,
              source_snapshot_id,
              captured_at,
              effective_from,
              effective_to,
              created_at
            )
            SELECT
              source.business_id,
              source.business_ref_id,
              source.provider_account_id,
              source.provider_account_ref_id,
              source.campaign_id,
              source.adset_id,
              md5(
                jsonb_build_object(
                  'optimization_goal', source.optimization_goal,
                  'custom_event_type', source.custom_event_type,
                  'pixel_id', source.pixel_id,
                  'custom_conversion_id', source.custom_conversion_id,
                  'promoted_object_json', source.promoted_object_json,
                  'bid_strategy_type', source.bid_strategy_type,
                  'bid_value', source.bid_value,
                  'bid_value_format', source.bid_value_format,
                  'daily_budget', source.daily_budget,
                  'lifetime_budget', source.lifetime_budget,
                  'is_budget_mixed', source.is_budget_mixed,
                  'is_config_mixed', source.is_config_mixed,
                  'is_optimization_goal_mixed', source.is_optimization_goal_mixed,
                  'is_bid_strategy_mixed', source.is_bid_strategy_mixed,
                  'is_bid_value_mixed', source.is_bid_value_mixed
                )::text
              ) AS config_fingerprint,
              source.optimization_goal,
              source.custom_event_type,
              source.pixel_id,
              source.custom_conversion_id,
              source.promoted_object_json,
              source.bid_strategy_type,
              source.bid_value,
              source.bid_value_format,
              source.daily_budget,
              source.lifetime_budget,
              source.is_budget_mixed,
              source.is_config_mixed,
              source.is_optimization_goal_mixed,
              source.is_bid_strategy_mixed,
              source.is_bid_value_mixed,
              source.source_kind,
              source.source_snapshot_id,
              source.captured_at,
              source.effective_from,
              source.effective_to,
              now()
            FROM (
              SELECT
                business_id,
                business_ref_id,
                account_id AS provider_account_id,
                provider_account_ref_id,
                NULLIF(payload->>'campaignId', '') AS campaign_id,
                entity_id AS adset_id,
                NULLIF(payload->>'optimizationGoal', '') AS optimization_goal,
                NULLIF(payload->>'customEventType', '') AS custom_event_type,
                NULLIF(payload->>'pixelId', '') AS pixel_id,
                NULLIF(payload->>'customConversionId', '') AS custom_conversion_id,
                payload->'promotedObject' AS promoted_object_json,
                NULLIF(payload->>'bidStrategyType', '') AS bid_strategy_type,
                NULLIF(payload->>'bidValue', '')::double precision AS bid_value,
                NULLIF(payload->>'bidValueFormat', '') AS bid_value_format,
                NULLIF(payload->>'dailyBudget', '')::double precision AS daily_budget,
                NULLIF(payload->>'lifetimeBudget', '')::double precision AS lifetime_budget,
                COALESCE((payload->>'isBudgetMixed')::boolean, FALSE) AS is_budget_mixed,
                COALESCE((payload->>'isConfigMixed')::boolean, FALSE) AS is_config_mixed,
                COALESCE((payload->>'isOptimizationGoalMixed')::boolean, FALSE) AS is_optimization_goal_mixed,
                COALESCE((payload->>'isBidStrategyMixed')::boolean, FALSE) AS is_bid_strategy_mixed,
                COALESCE((payload->>'isBidValueMixed')::boolean, FALSE) AS is_bid_value_mixed,
                'config_snapshot'::text AS source_kind,
                NULL::uuid AS source_snapshot_id,
                captured_at,
                snapshot_date AS effective_from,
                snapshot_date AS effective_to
              FROM meta_config_snapshots
              WHERE entity_level = 'adset'
              UNION ALL
              SELECT
                business_id,
                business_ref_id,
                provider_account_id,
                provider_account_ref_id,
                campaign_id,
                adset_id,
                optimization_goal,
                custom_event_type,
                pixel_id,
                custom_conversion_id,
                promoted_object_json,
                bid_strategy_type,
                bid_value,
                bid_value_format,
                daily_budget,
                lifetime_budget,
                is_budget_mixed,
                is_config_mixed,
                is_optimization_goal_mixed,
                is_bid_strategy_mixed,
                is_bid_value_mixed,
                'warehouse_daily'::text AS source_kind,
                source_snapshot_id,
                COALESCE(finalized_at, (date::text || 'T00:00:00Z')::timestamptz) AS captured_at,
                date AS effective_from,
                date AS effective_to
              FROM meta_adset_daily
              WHERE adset_id IS NOT NULL
                AND (
                  optimization_goal IS NOT NULL
                  OR custom_event_type IS NOT NULL
                  OR pixel_id IS NOT NULL
                  OR custom_conversion_id IS NOT NULL
                  OR promoted_object_json IS NOT NULL
                  OR bid_strategy_type IS NOT NULL
                  OR bid_value IS NOT NULL
                  OR daily_budget IS NOT NULL
                  OR lifetime_budget IS NOT NULL
                  OR is_budget_mixed = TRUE
                  OR is_config_mixed = TRUE
                  OR is_optimization_goal_mixed = TRUE
                  OR is_bid_strategy_mixed = TRUE
                  OR is_bid_value_mixed = TRUE
                )
            ) AS source
            WHERE source.adset_id IS NOT NULL
            ON CONFLICT (business_id, provider_account_id, adset_id, config_fingerprint, captured_at) DO NOTHING
          `,
                )
                .catch(() => {}),
            ]),
      ]);

      await runMigrationBatchSequentially([
        ...CANONICAL_BUSINESS_REF_TABLES.map((tableName) =>
          sql
            .query(
              `CREATE INDEX IF NOT EXISTS idx_${tableName}_business_ref ON ${tableName} (business_ref_id)`,
            )
            .catch(() => {}),
        ),
        ...CANONICAL_PROVIDER_REF_TABLES.map((tableName) =>
          sql
            .query(
              `CREATE INDEX IF NOT EXISTS idx_${tableName}_provider_account_ref ON ${tableName} (provider_account_ref_id)`,
            )
            .catch(() => {}),
        ),
      ]);

      // The native-ad path is an isolated shadow epoch. Its exported schema
      // contracts depend on the canonical physical account references above,
      // so they are applied last in one dependency-ordered transaction and
      // re-read through the same capability gates used by the runtime jobs.
      await runNativeAdSchemaMigrations(
        timeoutMs,
        options?.verifyNativeSchemaCapabilities ?? true,
      );
      await sql.query(META_AD_STATUS_RECONCILIATION_SCHEMA_SQL);
      // Product instrumentation: first-party, tenant-scoped, retained.
      //
      // Every string column is an allowlist enforced here, so there is nowhere
      // for a query, an exception message, a token, ad copy or PII to land.
      // Scope and tenancy are constrained together: a business event must name
      // a business, and a portfolio event must not, so cross-tenant work can
      // never be attributed to one tenant.
      await sql.query(`
        CREATE TABLE IF NOT EXISTS product_instrumentation_events (
          id                UUID PRIMARY KEY DEFAULT gen_random_uuid(),
          contract_version  TEXT NOT NULL
                              DEFAULT 'product-instrumentation-event.v1'
                              CHECK (contract_version = 'product-instrumentation-event.v1'),
          business_id       TEXT,
          scope             TEXT NOT NULL CHECK (scope IN ('business', 'portfolio')),
          event_name        TEXT NOT NULL CHECK (event_name IN (
                              'agency_today_viewed',
                              'search_submitted', 'search_zero_result',
                              'decision_workflow_changed',
                              'guarded_action_preflight'
                            )),
          surface           TEXT NOT NULL CHECK (surface IN (
                              'overview', 'global_search', 'meta_decisions',
                              'meta_decision_inspector', 'creative_studio', 'reports',
                              'google_ads', 'integrations', 'settings', 'launchpad',
                              'automation', 'mobile', 'system'
                            )),
          outcome           TEXT NOT NULL CHECK (outcome IN ('ok', 'failed', 'withheld')),
          provider          TEXT CHECK (provider IS NULL OR provider IN ('meta', 'google')),
          item_count        INTEGER CHECK (item_count IS NULL OR item_count >= 0),
          duration_ms       INTEGER CHECK (duration_ms IS NULL OR duration_ms >= 0),
          failure_code      TEXT CHECK (failure_code IS NULL OR failure_code IN (
                              'upstream_unavailable', 'upstream_timeout',
                              'not_authorized', 'not_assigned',
                              'contract_violation', 'unknown'
                            )),
          occurred_at       TIMESTAMPTZ NOT NULL,
          retain_until      DATE NOT NULL,
          created_at        TIMESTAMPTZ NOT NULL DEFAULT now(),
          CONSTRAINT product_instrumentation_failure_needs_code
            CHECK (outcome <> 'failed' OR failure_code IS NOT NULL),
          CONSTRAINT product_instrumentation_scope_tenancy
            CHECK (
              (scope = 'business' AND business_id IS NOT NULL) OR
              (scope = 'portfolio' AND business_id IS NULL)
            )
        )
      `);
      await sql.query(
        `CREATE INDEX IF NOT EXISTS idx_product_instrumentation_business_event
         ON product_instrumentation_events (business_id, event_name, occurred_at DESC)`,
      );
      await sql.query(
        `CREATE INDEX IF NOT EXISTS idx_product_instrumentation_retention
         ON product_instrumentation_events (retain_until)`,
      );
      // Operator-visible sink health: a failing sink must be a fact someone can
      // read, not a console line.
      await sql.query(`
        CREATE TABLE IF NOT EXISTS product_instrumentation_sink_health (
          day          DATE NOT NULL,
          status       TEXT NOT NULL CHECK (status IN (
                         'recorded', 'invalid_event', 'sink_unavailable', 'timeout'
                       )),
          event_count  BIGINT NOT NULL DEFAULT 0 CHECK (event_count >= 0),
          updated_at   TIMESTAMPTZ NOT NULL DEFAULT now(),
          PRIMARY KEY (day, status)
        )
      `);
      await sql.query(META_AD_DUPLICATE_RECONCILIATION_SCHEMA_SQL);

      if (legacyCoreDropEnabled) {
        await runMigrationBatchSequentially([
          sql`DROP TABLE IF EXISTS provider_account_snapshots`.catch(() => {}),
          sql`DROP TABLE IF EXISTS provider_account_assignments`.catch(
            () => {},
          ),
          sql`DROP TABLE IF EXISTS integrations`.catch(() => {}),
        ]);
      }

      // ── Retention execution schema ────────────────────────────────────────
      //
      // Every index the fail-closed retention contract declares by name. The
      // contract refuses the destructive sweep unless each exists with its
      // declared method, ordered keys, predicate, uniqueness and key count and
      // is valid/ready/live — so without these, retention is permanently
      // refused rather than silently running a sequential scan while deleting.
      //
      // CONCURRENTLY, because these are built against live tables and a
      // blocking index build on the largest relations is its own incident.
      await runMigrationBatchSequentially([
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_raw_snapshots_retention
          ON google_ads_raw_snapshots (fetched_at ASC, id ASC, partition_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_runner_leases_owner_expiry
          ON google_ads_runner_leases (lease_owner, lease_expires_at)
          WHERE lease_owner IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_sync_checkpoints_owner_expiry
          ON google_ads_sync_checkpoints (lease_owner, lease_expires_at)
          WHERE lease_owner IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_sync_checkpoints_raw_snapshot_ids
          ON google_ads_sync_checkpoints USING GIN (raw_snapshot_ids)`.catch(
          () => {},
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_sync_jobs_retention_active
          ON google_ads_sync_jobs (
            business_id,
            provider_account_id,
            scope,
            start_date,
            end_date
          )
          WHERE status IN ('pending', 'running')`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_sync_partitions_owner_expiry
          ON google_ads_sync_partitions (lease_owner, lease_expires_at)
          WHERE lease_owner IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_sync_runs_partition_updated_retention
          ON google_ads_sync_runs (partition_id, updated_at DESC, id DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_sync_runs_retention
          ON google_ads_sync_runs (status, updated_at ASC, id, partition_id)
          WHERE finished_at IS NOT NULL
            AND status IN ('succeeded', 'cancelled', 'failed')`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_google_ads_sync_runs_worker_status
          ON google_ads_sync_runs (worker_id, status)
          WHERE worker_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_authoritative_day_state_active_partition
          ON meta_authoritative_day_state (active_partition_id)
          WHERE active_partition_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_authoritative_day_state_last_run
          ON meta_authoritative_day_state (last_run_id)
          WHERE last_run_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_authoritative_publication_pointers_run_retention
          ON meta_authoritative_publication_pointers (published_by_run_id)
          WHERE published_by_run_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_authoritative_slice_versions_source_run_retention
          ON meta_authoritative_slice_versions (source_run_id)
          WHERE source_run_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_raw_snapshots_run_retention
          ON meta_raw_snapshots (run_id)
          WHERE run_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_source_manifests_raw_watermark
          ON meta_authoritative_source_manifests (raw_snapshot_watermark)
          WHERE raw_snapshot_watermark IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_checkpoints_owner_expiry
          ON meta_sync_checkpoints (lease_owner, lease_expires_at)
          WHERE lease_owner IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_checkpoints_run_retention
          ON meta_sync_checkpoints (run_id)
          WHERE run_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_jobs_retention_active
          ON meta_sync_jobs (
            business_id,
            provider_account_id,
            scope,
            start_date,
            end_date
          )
          WHERE status IN ('pending', 'running')`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_partitions_owner_expiry
          ON meta_sync_partitions (lease_owner, lease_expires_at)
          WHERE lease_owner IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_phase_timings_run_retention
          ON meta_sync_phase_timings (run_id)
          WHERE run_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_runs_partition_updated_retention
          ON meta_sync_runs (partition_id, updated_at DESC, id DESC)`.catch(
          () => {},
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_runs_retention
          ON meta_sync_runs (status, updated_at ASC, id, partition_id)
          WHERE finished_at IS NOT NULL
            AND status IN ('succeeded', 'cancelled', 'failed')`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_meta_sync_runs_worker_status
          ON meta_sync_runs (worker_id, status)
          WHERE worker_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_provider_sync_jobs_owner_expiry
          ON provider_sync_jobs (lock_owner, lock_expires_at)
          WHERE lock_owner IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX IF NOT EXISTS idx_provider_sync_jobs_retention_due
          ON provider_sync_jobs (completed_at, triggered_at)
          WHERE business_id = '__sync_retention__'
            AND provider = 'maintenance'
            AND report_type = 'lifecycle_retention'
            AND date_range_key = 'v1'`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_worker_heartbeats_retention
          ON sync_worker_heartbeats (last_heartbeat_at ASC, worker_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_worker_heartbeats_partition_activity
          ON sync_worker_heartbeats (last_partition_id, last_heartbeat_at DESC)
          WHERE last_partition_id IS NOT NULL`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_reclaim_events_retention
          ON sync_reclaim_events (created_at ASC, id)`.catch(() => {}),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_runtime_instances_retention
          ON sync_runtime_instances (last_seen_at ASC, build_id, service, instance_id)`.catch(
          () => {},
        ),
        sql`CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_sync_runner_leases_owner_expiry
          ON sync_runner_leases (lease_owner, lease_expires_at)
          WHERE lease_owner IS NOT NULL`.catch(() => {}),
        // Provenance back-references. Retention has to answer, per candidate,
        // whether any typed warehouse row still points at it; without these the
        // guard degrades to a sequential scan of every warehouse table on a
        // destructive path.
        ...[
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
          "meta_account_daily",
          "meta_campaign_daily",
          "meta_adset_daily",
          "meta_ad_daily",
          "meta_creative_daily",
          "meta_breakdown_daily",
          "meta_campaign_config_history",
          "meta_adset_config_history",
        ].map((tableName) =>
          sql
            .query(
              `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_source_snapshot_retention ON ${tableName} (source_snapshot_id) WHERE source_snapshot_id IS NOT NULL`,
            )
            .catch(() => {}),
        ),
        ...[
          "meta_account_daily",
          "meta_campaign_daily",
          "meta_adset_daily",
          "meta_ad_daily",
          "meta_creative_daily",
          "meta_breakdown_daily",
          "meta_creative_media",
        ].map((tableName) =>
          sql
            .query(
              `CREATE INDEX CONCURRENTLY IF NOT EXISTS idx_${tableName}_source_run_retention ON ${tableName} (source_run_id) WHERE source_run_id IS NOT NULL`,
            )
            .catch(() => {}),
        ),
      ]);
      // Declared by the retention column contract: the sweep reads job progress
      // to decide what is resumable rather than re-claiming completed work.
      await sql`ALTER TABLE provider_sync_jobs ADD COLUMN IF NOT EXISTS progress_json JSONB NOT NULL DEFAULT '{}'::jsonb`.catch(
        () => {},
      );

      // ── Shopify install grants at rest ────────────────────────────────────
      //
      // Deliberately NOT wrapped in `.catch(() => {})`. Every other swallowed
      // statement in this file is a DDL that is either already done or harmless
      // to skip; this one is the difference between a table of live shop
      // credentials in the clear and a table of ciphertext. A skipped run leaves
      // the plaintext there permanently and reports success, so it throws.
      const installTokenEncryption =
        await encryptShopifyInstallContextAccessTokens(sql);
        await encryptLegacyIntegrationCredentials(sql);
      if (installTokenEncryption.converted > 0) {
        logStartupEvent("migrations_shopify_install_tokens_encrypted", {
          reason,
          converted: installTokenEncryption.converted,
        });
      }

      // ── Seed superadmin ───────────────────────────────────────────────────
      await sql`UPDATE users SET is_superadmin = true WHERE lower(email) = 'emrahbilaloglu@gmail.com'`;

      // Prove the schema this change is responsible for actually landed BEFORE
      // announcing completion. Almost every DDL statement above swallows its
      // error, which means a failed column, table, FK or index would otherwise
      // be reported as a successful migration and the application would start
      // against a schema that cannot support it. This throws.
      const verification = await verifyMigrationSchemaContract({ timeoutMs });
      logStartupEvent("migrations_schema_verified", {
        reason,
        verifiedObjects: verification.verified,
      });

      migrationsCompleted = true;
      logStartupEvent("migrations_completed", { reason });
    })(),
    timeoutMs,
  );

  try {
    await migrationsPromise;
  } catch (error) {
    migrationsPromise = null;

    const isSystemCatalogRace =
      error instanceof Error &&
      "code" in error &&
      (error as { code: string }).code === "23505" &&
      "table" in error &&
      typeof (error as { table: string }).table === "string" &&
      ["pg_type", "pg_class"].includes((error as { table: string }).table);

    if (isSystemCatalogRace) {
      migrationsCompleted = true;
      logStartupEvent("migrations_completed_after_race", { reason });
      return;
    }

    logStartupError("migrations_failed", error, { reason, force });
    throw error;
  }
}
