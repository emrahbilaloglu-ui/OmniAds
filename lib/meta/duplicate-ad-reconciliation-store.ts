import { createHash, randomUUID } from "node:crypto";
import { getDb, runDbTransaction } from "@/lib/db";

export const META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION =
  "meta-manual-ad-duplicate-attempt.v1" as const;
export const META_AD_DUPLICATE_RECONCILIATION_CONTRACT_VERSION =
  "meta-manual-ad-duplicate-reconciliation.v1" as const;
export const META_AD_DUPLICATE_OBSERVATION_CONTRACT_VERSION =
  "meta-manual-ad-duplicate-reconciliation-observation.v1" as const;
export const META_AD_DUPLICATE_ATTEMPT_LEASE_MS = 2 * 60_000;
export const META_AD_DUPLICATE_SETTLEMENT_MS = 5 * 60_000;
export const META_AD_DUPLICATE_MAX_OBSERVATION_AGE_MS = 60_000;
export const META_AD_DUPLICATE_OBSERVATION_BACKOFF_BASE_SECONDS = 10 * 60;
export const META_AD_DUPLICATE_OBSERVATION_BACKOFF_CAP_SECONDS = 24 * 60 * 60;
export const META_AD_DUPLICATE_SCAN_PROGRESS_DELAY_SECONDS = 60;
export const META_AD_DUPLICATE_MARKER_PREFIX = "ADSECUTE_DUP";

export type MetaAdDuplicateAttemptEventKind =
  | "attempt_prepared"
  | "attempt_started"
  | "attempt_completed";
export type MetaAdDuplicateCompletionOutcome =
  | "provider_outcome_ambiguous"
  | "provider_response_succeeded_verification_failed"
  | "provider_response_verified_success"
  | "provider_definite_failure";
export type MetaAdDuplicateReconciliationResolution = "exact_provider_match";
export type MetaAdDuplicateObservationDisposition =
  | "scan_segment_progress"
  | "point_verification_pending"
  | "complete_scan_absence"
  | "provider_read_incomplete"
  | "provider_identity_drift"
  | "multiple_exact_provider_matches"
  | "provider_deadline_exhausted"
  | "credentials_unavailable"
  | "reconciliation_persistence_unavailable"
  | "unexpected_reconciliation_error";
export type MetaAdDuplicateObservationMethod =
  | "account_ads_scan"
  | "known_result_point_get"
  | "credentials"
  | "internal";

export interface MetaAdDuplicateTarget {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceAdId: string;
  sourceCreativeId: string;
  targetAdsetId: string;
  marker: string;
  canonicalAdName: string;
  requestedStatus: "PAUSED";
}

export interface MetaAdDuplicatePreparedAttempt {
  sourceActionLogId: string;
  attemptId: string;
  target: MetaAdDuplicateTarget;
  postPath: string;
  preparedAt: string;
  leaseDeadline: string;
}

export interface MetaAdDuplicateMutationReceipt {
  attemptCount: 1;
  method: "POST";
  path: string;
  attemptedAt: string;
  completedAt: string;
  providerResponseReceived: boolean;
  providerResponseSuccessful?: boolean;
  httpStatus: number | null;
  outcome: "provider_response_received" | "outcome_ambiguous";
  automaticRetryAttempted: false;
  transportError: Record<string, unknown> | null;
}

export interface MetaAdDuplicateReconciliationCandidate {
  sourceActionLogId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceAdId: string;
  sourceCreativeId: string;
  targetAdsetId: string;
  marker: string;
  canonicalAdName: string;
  requestedStatus: "PAUSED";
  resultingAdId: string | null;
  status: "pending" | "silent_failure";
  attemptId: string;
  authorityKind:
    | "completed_attempt"
    | "lease_expired_started"
    | "expired_prepared";
  settlementNotBefore: string;
  readyForProviderRead: boolean;
  scanContinuation?: {
    cycleId: string;
    segmentIndex: number;
    afterCursor: string;
    visitedCursorHashes: string[];
    cumulativePageCount: number;
    cumulativeObservationCount: number;
    cumulativeExactMatchIds: string[];
  } | null;
}

interface DuplicateAttemptDbRow {
  source_action_log_id: string;
  attempt_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  source_ad_id: string;
  source_creative_id: string;
  target_adset_id: string;
  marker: string;
  canonical_ad_name: string;
  requested_status: "PAUSED";
  post_path: string;
  prepared_at: string | Date;
  lease_deadline: string | Date;
}

interface DuplicateCandidateDbRow {
  source_action_log_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  source_ad_id: string;
  source_creative_id: string;
  target_adset_id: string;
  marker: string;
  canonical_ad_name: string;
  requested_status: "PAUSED";
  resulting_ad_id: string | null;
  status: "pending" | "silent_failure";
  attempt_id: string;
  authority_kind:
    | "completed_attempt"
    | "lease_expired_started"
    | "expired_prepared";
  settlement_not_before: string | Date;
  db_now: string | Date;
  scan_cycle_id: string | null;
  scan_segment_index: number | null;
  scan_after_cursor: string | null;
  scan_visited_cursor_hashes: unknown;
  scan_cumulative_page_count: number | null;
  scan_cumulative_observation_count: number | null;
  scan_cumulative_exact_match_ids: unknown;
}

export interface MetaAdDuplicateScanCheckpoint {
  cycleId: string;
  segmentIndex: number;
  segmentStartAfterCursor: string | null;
  segmentStartCursorHash: string | null;
  segmentEndAfterCursor: string | null;
  segmentEndCursorHash: string | null;
  cycleComplete: boolean;
  visitedCursorHashes: string[];
  cumulativePageCount: number;
  cumulativeObservationCount: number;
  cumulativeExactMatchIds: string[];
}

function iso(value: string | Date) {
  const parsed = value instanceof Date ? value : new Date(value);
  if (!Number.isFinite(parsed.getTime())) {
    throw new TypeError("Duplicate-attempt timestamp is invalid.");
  }
  return parsed.toISOString();
}

function exactText(value: string, label: string) {
  const normalized = value.trim();
  if (!normalized) {
    throw new TypeError(`${label} is required.`);
  }
  return normalized;
}

function normalizeCheckpointCursor(
  value: string | null,
  label: string,
) {
  if (value == null) return null;
  const cursor = value.trim();
  if (
    !cursor ||
    cursor !== value ||
    cursor.length > 2_048 ||
    /[\r\n\t\s]/.test(cursor) ||
    /https?:\/\//i.test(cursor) ||
    /access_?token|authorization|bearer/i.test(cursor)
  ) {
    throw new TypeError(`${label} is not a safe opaque after cursor.`);
  }
  return cursor;
}

function checkpointCursorHash(value: string | null) {
  return value
    ? createHash("sha256")
        .update(`cursor:${value}`, "utf8")
        .digest("hex")
    : null;
}

function normalizeHashList(value: string[]) {
  if (
    value.length > 100_000 ||
    value.some((hash) => !/^[0-9a-f]{64}$/.test(hash)) ||
    new Set(value).size !== value.length
  ) {
    throw new TypeError("Duplicate scan visited cursor hashes are invalid.");
  }
  return [...value];
}

function normalizeExactMatchIds(value: string[]) {
  const ids = value.map((id) => exactText(id, "cumulativeExactMatchId"));
  if (ids.length > 2 || new Set(ids).size !== ids.length) {
    throw new TypeError("Duplicate scan cumulative exact-match ids are invalid.");
  }
  return ids;
}

export function normalizeMetaAdDuplicateMarker(value: string) {
  const marker = value.trim().toLowerCase();
  if (
    !/^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      marker,
    )
  ) {
    throw new TypeError("Duplicate marker must be a canonical UUID v4.");
  }
  return marker;
}

export function buildMetaAdDuplicateCanonicalName(
  requestedName: string | null | undefined,
  marker: string,
) {
  const normalizedMarker = normalizeMetaAdDuplicateMarker(marker);
  const suffix = `[${META_AD_DUPLICATE_MARKER_PREFIX}:${normalizedMarker}]`;
  const base = requestedName?.trim() || "Adsecute duplicate";
  const boundedBase = base.slice(0, Math.max(1, 255 - suffix.length - 1)).trim();
  return `${boundedBase} ${suffix}`;
}

export function createMetaAdDuplicateMarker() {
  return randomUUID();
}

/**
 * Duplicate writes have a different recovery geometry than status changes:
 * the resulting provider id may be lost. These tables therefore remain
 * separate from the pause/resume journal and are append-only.
 */
export const META_AD_DUPLICATE_RECONCILIATION_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS meta_ads_duplicate_action_attempt_events (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version           TEXT NOT NULL
                               DEFAULT '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
                               CHECK (
                                 contract_version =
                                   '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
                               ),
  source_action_log_id       UUID NOT NULL,
  business_id                UUID NOT NULL,
  provider_account_ref_id    UUID NOT NULL,
  provider_account_id        TEXT NOT NULL
                               CHECK (length(btrim(provider_account_id)) > 0),
  source_ad_id               TEXT NOT NULL
                               CHECK (length(btrim(source_ad_id)) > 0),
  source_creative_id         TEXT NOT NULL
                               CHECK (length(btrim(source_creative_id)) > 0),
  target_adset_id            TEXT NOT NULL
                               CHECK (length(btrim(target_adset_id)) > 0),
  marker                     UUID NOT NULL,
  canonical_ad_name          TEXT NOT NULL
                               CHECK (length(btrim(canonical_ad_name)) > 0),
  requested_status           TEXT NOT NULL DEFAULT 'PAUSED'
                               CHECK (requested_status = 'PAUSED'),
  attempt_id                 UUID NOT NULL,
  event_kind                 TEXT NOT NULL
                               CHECK (
                                 event_kind IN (
                                   'attempt_prepared',
                                   'attempt_started',
                                   'attempt_completed'
                                 )
                               ),
  post_path                  TEXT NOT NULL
                               CHECK (length(btrim(post_path)) > 0),
  prepared_at                TIMESTAMPTZ NOT NULL,
  lease_deadline             TIMESTAMPTZ NOT NULL,
  started_at                 TIMESTAMPTZ,
  attempted_at               TIMESTAMPTZ,
  completed_at               TIMESTAMPTZ,
  verification_observed_at   TIMESTAMPTZ,
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
                                 'provider_response_received'
                               )
                             ),
  resulting_ad_id            TEXT,
  provider_response_json     JSONB,
  verification_json          JSONB,
  transport_error_json       JSONB,
  evidence_json              JSONB NOT NULL
                               CHECK (jsonb_typeof(evidence_json) = 'object'),
  evidence_hash              CHAR(64) NOT NULL
                               CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meta_ads_duplicate_attempt_source_fk
    FOREIGN KEY (source_action_log_id, business_id)
    REFERENCES meta_ads_action_log (id, business_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_attempt_account_fk
    FOREIGN KEY (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_attempt_source_event_unique
    UNIQUE (source_action_log_id, event_kind),
  CONSTRAINT meta_ads_duplicate_attempt_id_event_unique
    UNIQUE (attempt_id, event_kind),
  CONSTRAINT meta_ads_duplicate_attempt_shape_check CHECK (
    lease_deadline > prepared_at AND
    lease_deadline <= prepared_at + interval '2 minutes' AND
    (
      (
        event_kind = 'attempt_prepared' AND
        started_at IS NULL AND attempted_at IS NULL AND completed_at IS NULL AND
        verification_observed_at IS NULL AND completion_outcome IS NULL AND
        provider_response_received IS NULL AND
        provider_response_successful IS NULL AND http_status IS NULL AND
        provider_outcome IS NULL AND resulting_ad_id IS NULL AND
        provider_response_json IS NULL AND verification_json IS NULL AND
        transport_error_json IS NULL
      ) OR (
        event_kind = 'attempt_started' AND
        started_at IS NOT NULL AND started_at >= prepared_at AND
        started_at < lease_deadline AND attempted_at IS NULL AND
        completed_at IS NULL AND verification_observed_at IS NULL AND
        completion_outcome IS NULL AND
        provider_response_received IS NULL AND
        provider_response_successful IS NULL AND http_status IS NULL AND
        provider_outcome IS NULL AND resulting_ad_id IS NULL AND
        provider_response_json IS NULL AND verification_json IS NULL AND
        transport_error_json IS NULL
      ) OR (
        event_kind = 'attempt_completed' AND
        started_at IS NOT NULL AND attempted_at IS NOT NULL AND
        completed_at IS NOT NULL AND attempted_at >= started_at AND
        completed_at >= attempted_at AND completed_at <= lease_deadline AND
        completion_outcome IS NOT NULL AND
        (
          (
            completion_outcome = 'provider_response_verified_success' AND
            verification_observed_at IS NOT NULL
          ) OR (
            completion_outcome <> 'provider_response_verified_success' AND
            verification_observed_at IS NULL
          )
        ) AND
        provider_response_received IS NOT NULL AND
        provider_response_successful IS NOT NULL AND
        provider_outcome IS NOT NULL
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_duplicate_attempt_business
  ON meta_ads_duplicate_action_attempt_events
  (business_id, provider_account_id, source_ad_id, target_adset_id, created_at);

CREATE TABLE IF NOT EXISTS meta_ads_duplicate_action_reconciliation_events (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version           TEXT NOT NULL
                               DEFAULT '${META_AD_DUPLICATE_RECONCILIATION_CONTRACT_VERSION}'
                               CHECK (
                                 contract_version =
                                   '${META_AD_DUPLICATE_RECONCILIATION_CONTRACT_VERSION}'
                               ),
  source_action_log_id       UUID NOT NULL,
  source_attempt_id          UUID NOT NULL,
  source_prepared_event_id   UUID NOT NULL,
  business_id                UUID NOT NULL,
  provider_account_ref_id    UUID NOT NULL,
  provider_account_id        TEXT NOT NULL,
  source_ad_id               TEXT NOT NULL,
  source_creative_id         TEXT NOT NULL,
  target_adset_id            TEXT NOT NULL,
  marker                     UUID NOT NULL,
  canonical_ad_name          TEXT NOT NULL,
  requested_status           TEXT NOT NULL CHECK (requested_status = 'PAUSED'),
  authority_kind             TEXT NOT NULL CHECK (
                               authority_kind IN (
                                 'completed_attempt',
                                 'lease_expired_started'
                               )
                             ),
  settlement_not_before      TIMESTAMPTZ NOT NULL,
  resolution                 TEXT NOT NULL CHECK (
                               resolution = 'exact_provider_match'
                             ),
  resulting_ad_id            TEXT,
  scan_complete              BOOLEAN NOT NULL,
  scanned_page_count         INTEGER NOT NULL CHECK (scanned_page_count >= 0),
  observation_count          INTEGER NOT NULL CHECK (observation_count >= 0),
  exact_match_count          INTEGER NOT NULL CHECK (exact_match_count >= 0),
  observed_at                TIMESTAMPTZ NOT NULL,
  captured_at                TIMESTAMPTZ NOT NULL,
  evidence_json              JSONB NOT NULL
                               CHECK (jsonb_typeof(evidence_json) = 'object'),
  evidence_hash              CHAR(64) NOT NULL
                               CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meta_ads_duplicate_reconciliation_source_fk
    FOREIGN KEY (source_action_log_id, business_id)
    REFERENCES meta_ads_action_log (id, business_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_reconciliation_attempt_fk
    FOREIGN KEY (source_prepared_event_id)
    REFERENCES meta_ads_duplicate_action_attempt_events (id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_reconciliation_account_fk
    FOREIGN KEY (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_reconciliation_source_unique
    UNIQUE (source_action_log_id),
  CONSTRAINT meta_ads_duplicate_reconciliation_shape_check CHECK (
    captured_at >= observed_at AND
    resolution = 'exact_provider_match' AND
    resulting_ad_id IS NOT NULL AND scan_complete AND
    exact_match_count = 1
  )
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_duplicate_reconciliation_business
  ON meta_ads_duplicate_action_reconciliation_events
  (business_id, provider_account_id, source_ad_id, target_adset_id, created_at);

CREATE TABLE IF NOT EXISTS meta_ads_duplicate_reconciliation_observations (
  id                         UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  contract_version           TEXT NOT NULL
                               DEFAULT '${META_AD_DUPLICATE_OBSERVATION_CONTRACT_VERSION}'
                               CHECK (
                                 contract_version =
                                   '${META_AD_DUPLICATE_OBSERVATION_CONTRACT_VERSION}'
                               ),
  source_action_log_id       UUID NOT NULL,
  source_attempt_id          UUID NOT NULL,
  source_prepared_event_id   UUID NOT NULL,
  business_id                UUID NOT NULL,
  provider_account_ref_id    UUID NOT NULL,
  provider_account_id        TEXT NOT NULL,
  source_ad_id               TEXT NOT NULL,
  source_creative_id         TEXT NOT NULL,
  target_adset_id            TEXT NOT NULL,
  marker                     UUID NOT NULL,
  canonical_ad_name          TEXT NOT NULL,
  requested_status           TEXT NOT NULL CHECK (requested_status = 'PAUSED'),
  attempt_ordinal            INTEGER NOT NULL CHECK (attempt_ordinal > 0),
  observation_method         TEXT NOT NULL CHECK (
                               observation_method IN (
                                 'account_ads_scan',
                                 'known_result_point_get',
                                 'credentials',
                                 'internal'
                               )
                             ),
  disposition                TEXT NOT NULL CHECK (
                               disposition IN (
                                 'complete_scan_absence',
                                 'scan_segment_progress',
                                 'point_verification_pending',
                                 'provider_read_incomplete',
                                 'provider_identity_drift',
                                 'multiple_exact_provider_matches',
                                 'provider_deadline_exhausted',
                                 'credentials_unavailable',
                                 'reconciliation_persistence_unavailable',
                                 'unexpected_reconciliation_error'
                               )
                             ),
  resulting_ad_id            TEXT,
  scan_complete              BOOLEAN NOT NULL,
  scanned_page_count         INTEGER NOT NULL CHECK (scanned_page_count >= 0),
  observation_count          INTEGER NOT NULL CHECK (observation_count >= 0),
  exact_match_count          INTEGER NOT NULL CHECK (exact_match_count >= 0),
  scan_cycle_id              UUID,
  scan_segment_index         INTEGER CHECK (
                               scan_segment_index IS NULL OR
                               scan_segment_index >= 0
                             ),
  segment_start_after_cursor TEXT,
  segment_start_cursor_hash  CHAR(64) CHECK (
                               segment_start_cursor_hash IS NULL OR
                               segment_start_cursor_hash ~ '^[0-9a-f]{64}$'
                             ),
  segment_end_after_cursor   TEXT,
  segment_end_cursor_hash    CHAR(64) CHECK (
                               segment_end_cursor_hash IS NULL OR
                               segment_end_cursor_hash ~ '^[0-9a-f]{64}$'
                             ),
  scan_cycle_complete        BOOLEAN,
  observed_at                TIMESTAMPTZ NOT NULL,
  captured_at                TIMESTAMPTZ NOT NULL,
  backoff_seconds            INTEGER NOT NULL CHECK (backoff_seconds > 0),
  next_attempt_not_before    TIMESTAMPTZ NOT NULL,
  evidence_json              JSONB NOT NULL
                               CHECK (jsonb_typeof(evidence_json) = 'object'),
  evidence_hash              CHAR(64) NOT NULL
                               CHECK (evidence_hash ~ '^[0-9a-f]{64}$'),
  created_at                 TIMESTAMPTZ NOT NULL DEFAULT clock_timestamp(),
  CONSTRAINT meta_ads_duplicate_observation_source_fk
    FOREIGN KEY (source_action_log_id, business_id)
    REFERENCES meta_ads_action_log (id, business_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_observation_attempt_fk
    FOREIGN KEY (source_prepared_event_id)
    REFERENCES meta_ads_duplicate_action_attempt_events (id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_observation_account_fk
    FOREIGN KEY (provider_account_ref_id, provider_account_id)
    REFERENCES provider_accounts (id, external_account_id)
    ON DELETE RESTRICT,
  CONSTRAINT meta_ads_duplicate_observation_ordinal_unique
    UNIQUE (source_action_log_id, attempt_ordinal),
  CONSTRAINT meta_ads_duplicate_observation_shape_check CHECK (
    captured_at >= observed_at AND
    next_attempt_not_before > captured_at AND
    (
      (
        disposition = 'scan_segment_progress' AND
        observation_method = 'account_ads_scan' AND
        NOT scan_complete AND scanned_page_count > 0 AND
        segment_end_after_cursor IS NOT NULL
      ) OR (
        disposition = 'point_verification_pending' AND
        observation_method = 'account_ads_scan' AND
        scan_complete AND scanned_page_count > 0 AND
        exact_match_count = 1 AND resulting_ad_id IS NOT NULL
      ) OR (
        disposition = 'complete_scan_absence' AND
        observation_method = 'account_ads_scan' AND
        scan_complete AND scanned_page_count > 0 AND
        exact_match_count = 0 AND resulting_ad_id IS NULL
      ) OR (
        disposition = 'multiple_exact_provider_matches' AND
        observation_method = 'account_ads_scan' AND
        scanned_page_count > 0 AND
        exact_match_count > 1 AND resulting_ad_id IS NULL
      ) OR (
        disposition = 'credentials_unavailable' AND
        observation_method = 'credentials' AND
        NOT scan_complete AND scanned_page_count = 0 AND
        observation_count = 0 AND exact_match_count = 0
      ) OR disposition IN (
        'provider_read_incomplete',
        'provider_identity_drift',
        'provider_deadline_exhausted',
        'reconciliation_persistence_unavailable',
        'unexpected_reconciliation_error'
      )
    ) AND (
      (
        observation_method = 'account_ads_scan' AND
        scan_cycle_id IS NOT NULL AND
        scan_segment_index IS NOT NULL AND
        scan_cycle_complete IS NOT NULL AND
        (
          (segment_start_after_cursor IS NULL AND
           segment_start_cursor_hash IS NULL) OR
          (segment_start_after_cursor IS NOT NULL AND
           segment_start_cursor_hash IS NOT NULL)
        ) AND (
          (segment_end_after_cursor IS NULL AND
           segment_end_cursor_hash IS NULL) OR
          (segment_end_after_cursor IS NOT NULL AND
           segment_end_cursor_hash IS NOT NULL)
        )
      ) OR (
        observation_method <> 'account_ads_scan' AND
        scan_cycle_id IS NULL AND
        scan_segment_index IS NULL AND
        segment_start_after_cursor IS NULL AND
        segment_start_cursor_hash IS NULL AND
        segment_end_after_cursor IS NULL AND
        segment_end_cursor_hash IS NULL AND
        scan_cycle_complete IS NULL
      )
    )
  )
);

CREATE INDEX IF NOT EXISTS idx_meta_ads_duplicate_observation_schedule
  ON meta_ads_duplicate_reconciliation_observations
  (next_attempt_not_before, captured_at, source_action_log_id);

CREATE UNIQUE INDEX IF NOT EXISTS idx_meta_ads_duplicate_open_claim_unique
  ON meta_ads_action_log (
    business_id,
    provider_account_ref_id,
    provider_account_id,
    ad_id,
    (payload_request->'duplicate_target'->>'targetAdsetId')
  )
  WHERE action = 'duplicate'
    AND source = 'manual_operator_v1'
    AND status IN ('pending', 'silent_failure')
    AND NOT COALESCE(dry_run, FALSE)
    AND payload_request->>'duplicate_attempt_contract_version' =
      '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
    AND payload_request->>'duplicate_attempt_required' = 'true';

CREATE OR REPLACE FUNCTION enforce_manual_meta_ads_duplicate_insert_contract()
RETURNS trigger
LANGUAGE plpgsql
AS $manual_meta_duplicate_insert_contract$
DECLARE
  durable_target JSONB;
  request_body JSONB;
  marker_text TEXT;
  canonical_name TEXT;
  binding_count INTEGER;
BEGIN
  IF NEW.action <> 'duplicate'
     OR NEW.source <> 'manual_operator_v1' THEN
    RETURN NEW;
  END IF;

  request_body := NEW.payload_request->'body';
  IF COALESCE(NEW.dry_run, FALSE) THEN
    IF jsonb_typeof(NEW.payload_request) IS DISTINCT FROM 'object'
       OR NEW.payload_request->'dry_run' IS DISTINCT FROM 'true'::jsonb
       OR jsonb_typeof(request_body) IS DISTINCT FROM 'object'
       OR request_body->'dry_run' IS DISTINCT FROM 'true'::jsonb
       OR NEW.payload_request->>'method' IS DISTINCT FROM 'POST'
       OR NULLIF(btrim(NEW.provider_account_id), '') IS NULL
       OR NEW.payload_request->>'endpoint' IS DISTINCT FROM
         '/act_' ||
           regexp_replace(NEW.provider_account_id, '^act_', '', 'i') ||
           '/ads'
       OR NULLIF(btrim(request_body->>'target_adset_id'), '') IS NULL
       OR request_body->>'adset_id' IS DISTINCT FROM
         request_body->>'target_adset_id'
       OR request_body->>'status_option' IS DISTINCT FROM 'PAUSED'
       OR NEW.status IS DISTINCT FROM 'pending' THEN
      RAISE EXCEPTION
        'Manual duplicate dry-run envelope is not exact.'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  durable_target := NEW.payload_request->'duplicate_target';
  marker_text := NEW.payload_request->>'duplicate_marker';
  canonical_name := NEW.payload_request->>'duplicate_canonical_name';
  SELECT count(*)::integer
    INTO binding_count
  FROM business_provider_accounts binding
  WHERE binding.business_id = NEW.business_id::text
    AND binding.provider = 'meta'
    AND binding.provider_account_ref_id::text =
      NEW.provider_account_ref_id::text
    AND binding.provider_account_id = NEW.provider_account_id;

  IF jsonb_typeof(NEW.payload_request) IS DISTINCT FROM 'object'
     OR NEW.payload_request->>'duplicate_attempt_contract_version'
       IS DISTINCT FROM '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
     OR NEW.payload_request->'duplicate_attempt_required'
       IS DISTINCT FROM 'true'::jsonb
     OR NEW.payload_request->'dry_run' IS DISTINCT FROM 'false'::jsonb
     OR jsonb_typeof(request_body) IS DISTINCT FROM 'object'
     OR request_body->'dry_run' IS DISTINCT FROM 'false'::jsonb
     OR NEW.payload_request->>'method' IS DISTINCT FROM 'POST'
     OR NEW.payload_request->>'endpoint' IS DISTINCT FROM
       '/act_' ||
         regexp_replace(NEW.provider_account_id, '^act_', '', 'i') ||
         '/ads'
     OR NEW.provider_account_ref_id IS NULL
     OR NULLIF(btrim(NEW.provider_account_id), '') IS NULL
     OR NULLIF(btrim(NEW.ad_id), '') IS NULL
     OR NULLIF(btrim(NEW.creative_id), '') IS NULL
     OR binding_count <> 1
     OR NEW.status IS DISTINCT FROM 'pending'
     OR NEW.payload_response IS NOT NULL
     OR NEW.error_code IS NOT NULL
     OR NEW.error_message IS NOT NULL
     OR NEW.resulting_ad_id IS NOT NULL
     OR NEW.verified_at IS NOT NULL
     OR NEW.verification_payload IS NOT NULL
     OR NEW.terminal_finalized_at IS NOT NULL
     OR jsonb_typeof(durable_target) IS DISTINCT FROM 'object'
     OR durable_target->>'businessId'
       IS DISTINCT FROM NEW.business_id::text
     OR durable_target->>'providerAccountRefId'
       IS DISTINCT FROM NEW.provider_account_ref_id::text
     OR durable_target->>'providerAccountId'
       IS DISTINCT FROM NEW.provider_account_id
     OR durable_target->>'sourceAdId' IS DISTINCT FROM NEW.ad_id
     OR durable_target->>'sourceCreativeId'
       IS DISTINCT FROM NEW.creative_id
     OR NULLIF(btrim(durable_target->>'targetAdsetId'), '') IS NULL
     OR durable_target->>'marker' IS DISTINCT FROM marker_text
     OR durable_target->>'canonicalAdName'
       IS DISTINCT FROM canonical_name
     OR durable_target->>'requestedStatus' IS DISTINCT FROM 'PAUSED'
     OR COALESCE(marker_text, '') !~
       '^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
     OR canonical_name IS NULL
     OR right(
       canonical_name,
       length(' [${META_AD_DUPLICATE_MARKER_PREFIX}:' || marker_text || ']')
     ) IS DISTINCT FROM
       ' [${META_AD_DUPLICATE_MARKER_PREFIX}:' || marker_text || ']'
     OR request_body->>'target_adset_id'
       IS DISTINCT FROM durable_target->>'targetAdsetId'
     OR request_body->>'adset_id'
       IS DISTINCT FROM durable_target->>'targetAdsetId'
     OR request_body->>'name' IS DISTINCT FROM canonical_name
     OR request_body->>'status_option' IS DISTINCT FROM 'PAUSED' THEN
    RAISE EXCEPTION
      'Live manual duplicate envelope is not exact.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$manual_meta_duplicate_insert_contract$;

DROP TRIGGER IF EXISTS trg_manual_meta_ads_duplicate_insert_contract
ON meta_ads_action_log;
CREATE TRIGGER trg_manual_meta_ads_duplicate_insert_contract
BEFORE INSERT ON meta_ads_action_log
FOR EACH ROW
EXECUTE FUNCTION enforce_manual_meta_ads_duplicate_insert_contract();

CREATE OR REPLACE FUNCTION enforce_manual_meta_ads_duplicate_preparation()
RETURNS trigger
LANGUAGE plpgsql
AS $manual_meta_duplicate_preparation$
DECLARE
  prepared_count INTEGER;
BEGIN
  IF NEW.action = 'duplicate'
     AND NEW.source = 'manual_operator_v1'
     AND NOT COALESCE(NEW.dry_run, FALSE)
     AND NEW.payload_request->>'duplicate_attempt_contract_version' =
       '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
     AND NEW.payload_request->>'duplicate_attempt_required' = 'true' THEN
    SELECT count(*)::integer
      INTO prepared_count
    FROM meta_ads_duplicate_action_attempt_events attempt_event
    WHERE attempt_event.source_action_log_id = NEW.id
      AND attempt_event.event_kind = 'attempt_prepared';
    IF prepared_count <> 1 THEN
      RAISE EXCEPTION
        'Live manual duplicate must commit with one preparation event.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NULL;
END;
$manual_meta_duplicate_preparation$;

DROP TRIGGER IF EXISTS trg_manual_meta_ads_duplicate_preparation_required
ON meta_ads_action_log;
CREATE CONSTRAINT TRIGGER
  trg_manual_meta_ads_duplicate_preparation_required
AFTER INSERT ON meta_ads_action_log
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION enforce_manual_meta_ads_duplicate_preparation();

CREATE OR REPLACE FUNCTION validate_meta_ads_duplicate_attempt_event()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_duplicate_attempt_validation$
DECLARE
  source_action meta_ads_action_log%ROWTYPE;
  prepared_event meta_ads_duplicate_action_attempt_events%ROWTYPE;
  started_event meta_ads_duplicate_action_attempt_events%ROWTYPE;
  durable_target JSONB;
  event_target JSONB;
  mutation_receipt JSONB;
  verified_creative JSONB;
BEGIN
  NEW.created_at := clock_timestamp();

  SELECT *
    INTO source_action
  FROM meta_ads_action_log
  WHERE id = NEW.source_action_log_id
  FOR UPDATE;

  durable_target := source_action.payload_request->'duplicate_target';
  event_target := NEW.evidence_json->'target';
  IF NOT FOUND
     OR source_action.source <> 'manual_operator_v1'
     OR source_action.action <> 'duplicate'
     OR source_action.status <> 'pending'
     OR source_action.provider_account_ref_id IS NULL
     OR source_action.provider_account_id IS NULL
     OR source_action.creative_id IS NULL
     OR COALESCE(source_action.dry_run, FALSE)
     OR source_action.payload_request->>'duplicate_attempt_contract_version'
       IS DISTINCT FROM '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
     OR source_action.payload_request->>'duplicate_attempt_required'
       IS DISTINCT FROM 'true'
     OR source_action.payload_request->>'duplicate_marker'
       IS DISTINCT FROM NEW.marker::text
     OR source_action.payload_request->>'duplicate_canonical_name'
       IS DISTINCT FROM NEW.canonical_ad_name
     OR jsonb_typeof(durable_target) IS DISTINCT FROM 'object'
     OR durable_target->>'businessId'
       IS DISTINCT FROM NEW.business_id::text
     OR durable_target->>'providerAccountRefId'
       IS DISTINCT FROM NEW.provider_account_ref_id::text
     OR durable_target->>'providerAccountId'
       IS DISTINCT FROM NEW.provider_account_id
     OR durable_target->>'sourceAdId'
       IS DISTINCT FROM NEW.source_ad_id
     OR durable_target->>'sourceCreativeId'
       IS DISTINCT FROM NEW.source_creative_id
     OR durable_target->>'targetAdsetId'
       IS DISTINCT FROM NEW.target_adset_id
     OR durable_target->>'marker' IS DISTINCT FROM NEW.marker::text
     OR durable_target->>'canonicalAdName'
       IS DISTINCT FROM NEW.canonical_ad_name
     OR durable_target->>'requestedStatus' IS DISTINCT FROM 'PAUSED'
     OR source_action.business_id <> NEW.business_id
     OR source_action.provider_account_ref_id <>
       NEW.provider_account_ref_id
     OR source_action.provider_account_id <> NEW.provider_account_id
     OR source_action.ad_id <> NEW.source_ad_id
     OR source_action.creative_id <> NEW.source_creative_id
     OR (
       SELECT count(*)
       FROM business_provider_accounts binding
       WHERE binding.business_id = NEW.business_id::text
         AND binding.provider = 'meta'
         AND binding.provider_account_ref_id::text =
           NEW.provider_account_ref_id::text
         AND binding.provider_account_id = NEW.provider_account_id
     ) <> 1 THEN
    RAISE EXCEPTION
      'Duplicate attempt lineage is not an exact live pending claim.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.post_path <>
       'act_' || regexp_replace(NEW.provider_account_id, '^act_', '', 'i') ||
       '/ads'
     OR NEW.prepared_at <
       date_trunc('milliseconds', source_action.requested_at)
     OR NEW.evidence_json->>'contractVersion' IS DISTINCT FROM
       '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
     OR NEW.evidence_json->>'eventKind' IS DISTINCT FROM NEW.event_kind
     OR NEW.evidence_json->>'sourceActionLogId' IS DISTINCT FROM
       NEW.source_action_log_id::text
     OR NEW.evidence_json->>'attemptId' IS DISTINCT FROM
       NEW.attempt_id::text
     OR NEW.evidence_json->>'postPath' IS DISTINCT FROM NEW.post_path
     OR NEW.evidence_json->>'preparedAt' IS DISTINCT FROM to_char(
       NEW.prepared_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR NEW.evidence_json->>'leaseDeadline' IS DISTINCT FROM to_char(
       NEW.lease_deadline AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR jsonb_typeof(event_target) IS DISTINCT FROM 'object'
     OR event_target->>'businessId'
       IS DISTINCT FROM NEW.business_id::text
     OR event_target->>'providerAccountRefId'
       IS DISTINCT FROM NEW.provider_account_ref_id::text
     OR event_target->>'providerAccountId'
       IS DISTINCT FROM NEW.provider_account_id
     OR event_target->>'sourceAdId' IS DISTINCT FROM NEW.source_ad_id
     OR event_target->>'sourceCreativeId'
       IS DISTINCT FROM NEW.source_creative_id
     OR event_target->>'targetAdsetId'
       IS DISTINCT FROM NEW.target_adset_id
     OR event_target->>'marker' IS DISTINCT FROM NEW.marker::text
     OR event_target->>'canonicalAdName'
       IS DISTINCT FROM NEW.canonical_ad_name
     OR event_target->>'requestedStatus' IS DISTINCT FROM 'PAUSED'
     OR NEW.evidence_hash <>
       encode(digest(NEW.evidence_json::text, 'sha256'), 'hex') THEN
    RAISE EXCEPTION
      'Duplicate attempt path, timing, or evidence is invalid.'
      USING ERRCODE = '23514';
  END IF;

  IF NEW.event_kind = 'attempt_prepared' THEN
    IF NEW.prepared_at < clock_timestamp() - interval '30 seconds'
       OR NEW.prepared_at > clock_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION
        'Duplicate prepared event is stale or future-dated.'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT *
      INTO prepared_event
    FROM meta_ads_duplicate_action_attempt_events
    WHERE source_action_log_id = NEW.source_action_log_id
      AND event_kind = 'attempt_prepared'
    FOR KEY SHARE;
    IF NOT FOUND
       OR prepared_event.attempt_id <> NEW.attempt_id
       OR prepared_event.business_id <> NEW.business_id
       OR prepared_event.provider_account_ref_id <>
         NEW.provider_account_ref_id
       OR prepared_event.provider_account_id <> NEW.provider_account_id
       OR prepared_event.source_ad_id <> NEW.source_ad_id
       OR prepared_event.source_creative_id <> NEW.source_creative_id
       OR prepared_event.target_adset_id <> NEW.target_adset_id
       OR prepared_event.marker <> NEW.marker
       OR prepared_event.canonical_ad_name <> NEW.canonical_ad_name
       OR prepared_event.post_path <> NEW.post_path
       OR prepared_event.prepared_at <> NEW.prepared_at
       OR prepared_event.lease_deadline <> NEW.lease_deadline THEN
      RAISE EXCEPTION
        'Duplicate attempt event does not match its immutable preparation.'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF NEW.event_kind = 'attempt_started' THEN
    IF NEW.evidence_json->>'startedAt' IS DISTINCT FROM to_char(
         NEW.started_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       OR NEW.started_at < clock_timestamp() - interval '30 seconds'
       OR NEW.started_at > clock_timestamp() + interval '5 seconds' THEN
      RAISE EXCEPTION
        'Duplicate started event is stale or future-dated.'
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW.event_kind = 'attempt_completed' THEN
    SELECT *
      INTO started_event
    FROM meta_ads_duplicate_action_attempt_events
    WHERE source_action_log_id = NEW.source_action_log_id
      AND event_kind = 'attempt_started'
    FOR KEY SHARE;
    IF NOT FOUND
       OR started_event.attempt_id <> NEW.attempt_id
       OR started_event.started_at <> NEW.started_at THEN
      RAISE EXCEPTION
        'Duplicate completion does not match one immutable start.'
        USING ERRCODE = '23514';
    END IF;

    mutation_receipt := NEW.evidence_json->'mutationReceipt';
    verified_creative := NEW.verification_json->'creative';
    IF jsonb_typeof(mutation_receipt) IS DISTINCT FROM 'object'
       OR mutation_receipt->'attemptCount' IS DISTINCT FROM '1'::jsonb
       OR mutation_receipt->>'method' IS DISTINCT FROM 'POST'
       OR mutation_receipt->>'path' IS DISTINCT FROM NEW.post_path
       OR mutation_receipt->>'attemptedAt' IS DISTINCT FROM to_char(
         NEW.attempted_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       OR mutation_receipt->>'completedAt' IS DISTINCT FROM to_char(
         NEW.completed_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       OR NEW.evidence_json->>'startedAt' IS DISTINCT FROM to_char(
         NEW.started_at AT TIME ZONE 'UTC',
         'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
       )
       OR NEW.evidence_json->>'completionOutcome'
         IS DISTINCT FROM NEW.completion_outcome
       OR NEW.evidence_json->>'resultingAdId'
         IS DISTINCT FROM NEW.resulting_ad_id
       OR NEW.evidence_json->'providerResponse'
         IS DISTINCT FROM NEW.provider_response_json
       OR NEW.evidence_json->'verification'
         IS DISTINCT FROM NEW.verification_json
       OR mutation_receipt->'providerResponseReceived'
         IS DISTINCT FROM to_jsonb(NEW.provider_response_received)
       OR mutation_receipt->'providerResponseSuccessful'
         IS DISTINCT FROM to_jsonb(NEW.provider_response_successful)
       OR mutation_receipt->'httpStatus' IS DISTINCT FROM
         COALESCE(to_jsonb(NEW.http_status), 'null'::jsonb)
       OR mutation_receipt->>'outcome'
         IS DISTINCT FROM NEW.provider_outcome
       OR mutation_receipt->'transportError'
         IS DISTINCT FROM NEW.transport_error_json
       OR mutation_receipt->'automaticRetryAttempted'
         IS DISTINCT FROM 'false'::jsonb
       OR NEW.evidence_json->'verificationObservedAt'
         IS DISTINCT FROM COALESCE(
           to_jsonb(to_char(
             NEW.verification_observed_at AT TIME ZONE 'UTC',
             'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
           )),
           'null'::jsonb
         )
       OR (
         NEW.completion_outcome = 'provider_response_verified_success'
         AND (
           NEW.provider_response_received IS DISTINCT FROM TRUE
           OR NEW.provider_response_successful IS DISTINCT FROM TRUE
           OR NEW.provider_outcome IS DISTINCT FROM
             'provider_response_received'
           OR COALESCE(NEW.transport_error_json, 'null'::jsonb)
             IS DISTINCT FROM 'null'::jsonb
           OR NEW.http_status IS NULL
           OR NEW.http_status NOT BETWEEN 200 AND 299
           OR NEW.verification_observed_at < NEW.completed_at
           OR NEW.verification_observed_at >
             clock_timestamp() + interval '5 seconds'
           OR NEW.verification_observed_at - NEW.completed_at >
             interval '60 seconds'
           OR NULLIF(btrim(NEW.resulting_ad_id), '') IS NULL
           OR btrim(NEW.provider_response_json->>'id')
             IS DISTINCT FROM NEW.resulting_ad_id
           OR btrim(NEW.verification_json->>'id')
             IS DISTINCT FROM NEW.resulting_ad_id
           OR NEW.verification_json->>'observedAt'
             IS DISTINCT FROM to_char(
               NEW.verification_observed_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
           OR regexp_replace(
             btrim(NEW.verification_json->>'account_id'),
             '^act_', '', 'i'
           ) IS DISTINCT FROM regexp_replace(
             NEW.provider_account_id, '^act_', '', 'i'
           )
           OR btrim(NEW.verification_json->>'name')
             IS DISTINCT FROM NEW.canonical_ad_name
           OR upper(btrim(NEW.verification_json->>'status'))
             IS DISTINCT FROM 'PAUSED'
           OR btrim(NEW.verification_json->>'adset_id')
             IS DISTINCT FROM NEW.target_adset_id
           OR jsonb_typeof(verified_creative) IS DISTINCT FROM 'object'
           OR btrim(verified_creative->>'id')
             IS DISTINCT FROM NEW.source_creative_id
         )
       )
       OR (
         NEW.completion_outcome =
           'provider_response_succeeded_verification_failed'
         AND (
           NEW.provider_response_received IS DISTINCT FROM TRUE
           OR NEW.provider_response_successful IS DISTINCT FROM TRUE
           OR NEW.provider_outcome IS DISTINCT FROM
             'provider_response_received'
           OR COALESCE(NEW.transport_error_json, 'null'::jsonb)
             IS DISTINCT FROM 'null'::jsonb
           OR NEW.http_status IS NULL
           OR NEW.http_status NOT BETWEEN 200 AND 299
           OR NEW.resulting_ad_id IS DISTINCT FROM (
             CASE
               WHEN jsonb_typeof(NEW.provider_response_json) = 'object'
                AND jsonb_typeof(
                  NEW.provider_response_json->'id'
                ) = 'string'
                AND NULLIF(
                  btrim(NEW.provider_response_json->>'id'),
                  ''
                ) IS NOT NULL
               THEN btrim(NEW.provider_response_json->>'id')
               ELSE NULL
             END
           )
         )
       )
       OR (
         NEW.completion_outcome = 'provider_outcome_ambiguous'
         AND (
           NEW.provider_response_successful IS DISTINCT FROM FALSE
           OR NEW.provider_outcome IS DISTINCT FROM 'outcome_ambiguous'
           OR NEW.resulting_ad_id IS NOT NULL
           OR NOT (
             COALESCE(
               (
                 NEW.provider_response_received IS NOT DISTINCT FROM FALSE
                 AND NEW.http_status IS NULL
                 AND COALESCE(
                   NEW.provider_response_json,
                   'null'::jsonb
                 ) IS NOT DISTINCT FROM 'null'::jsonb
                 AND jsonb_typeof(NEW.transport_error_json)
                   IS NOT DISTINCT FROM 'object'
               ),
               FALSE
             )
             OR COALESCE(
               (
                 NEW.provider_response_received IS NOT DISTINCT FROM TRUE
                 AND NEW.http_status IS NOT NULL
                 AND COALESCE(
                   NEW.transport_error_json,
                   'null'::jsonb
                 ) IS NOT DISTINCT FROM 'null'::jsonb
                 AND (
                   NEW.http_status IN (408, 425, 429)
                   OR NEW.http_status >= 500
                   OR (
                     NEW.http_status BETWEEN 200 AND 299
                     AND (
                       jsonb_typeof(
                         NEW.provider_response_json->'error'
                       ) IS NOT DISTINCT FROM 'object'
                       OR NEW.provider_response_json->'success'
                         IS NOT DISTINCT FROM 'false'::jsonb
                     )
                   )
                   OR (
                     NEW.http_status BETWEEN 400 AND 499
                     AND (
                       jsonb_typeof(
                         NEW.provider_response_json->'error'
                       ) IS DISTINCT FROM 'object'
                       OR NEW.provider_response_json->'error'->'is_transient'
                         IS DISTINCT FROM 'false'::jsonb
                       OR (
                         NEW.provider_response_json->'error'->>'code'
                       ) IN ('1', '2', '4', '17', '32', '341', '613')
                       OR COALESCE(
                         NEW.provider_response_json->'error'->>'code',
                         ''
                       ) !~ '^[0-9]+$'
                       OR NULLIF(btrim(
                         NEW.provider_response_json->'error'->>'message'
                       ), '') IS NULL
                     )
                   )
                 )
               ),
               FALSE
             )
           )
         )
       )
       OR (
         NEW.completion_outcome = 'provider_definite_failure'
         AND (
           NEW.provider_response_received IS DISTINCT FROM TRUE
           OR NEW.provider_response_successful IS DISTINCT FROM FALSE
           OR NEW.provider_outcome IS DISTINCT FROM
             'provider_response_received'
           OR COALESCE(NEW.transport_error_json, 'null'::jsonb)
             IS DISTINCT FROM 'null'::jsonb
           OR NEW.http_status IS NULL
           OR NOT (
             NEW.http_status BETWEEN 400 AND 499
             AND NEW.http_status NOT IN (408, 425, 429)
             AND jsonb_typeof(NEW.provider_response_json->'error')
               IS NOT DISTINCT FROM 'object'
             AND COALESCE(
               NEW.provider_response_json->'error'->>'code',
               ''
             ) ~ '^[0-9]+$'
             AND (
               NEW.provider_response_json->'error'->>'code'
             ) NOT IN ('1', '2', '4', '17', '32', '341', '613')
             AND NEW.provider_response_json->'error'->'is_transient'
               IS NOT DISTINCT FROM 'false'::jsonb
             AND NULLIF(btrim(
               NEW.provider_response_json->'error'->>'message'
             ), '') IS NOT NULL
           )
           OR NEW.resulting_ad_id IS NOT NULL
         )
       ) THEN
      RAISE EXCEPTION
        'Duplicate completion lacks an exact single-attempt receipt.'
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$meta_duplicate_attempt_validation$;

DROP TRIGGER IF EXISTS trg_meta_ads_duplicate_attempt_validate
ON meta_ads_duplicate_action_attempt_events;
CREATE TRIGGER trg_meta_ads_duplicate_attempt_validate
BEFORE INSERT ON meta_ads_duplicate_action_attempt_events
FOR EACH ROW
EXECUTE FUNCTION validate_meta_ads_duplicate_attempt_event();

CREATE OR REPLACE FUNCTION reject_meta_ads_duplicate_attempt_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_duplicate_attempt_immutable$
BEGIN
  RAISE EXCEPTION
    'meta_ads_duplicate_action_attempt_events is append-only.'
    USING ERRCODE = '55000';
END;
$meta_duplicate_attempt_immutable$;

DROP TRIGGER IF EXISTS trg_meta_ads_duplicate_attempt_immutable
ON meta_ads_duplicate_action_attempt_events;
CREATE TRIGGER trg_meta_ads_duplicate_attempt_immutable
BEFORE UPDATE OR DELETE ON meta_ads_duplicate_action_attempt_events
FOR EACH ROW
EXECUTE FUNCTION reject_meta_ads_duplicate_attempt_mutation();

CREATE OR REPLACE FUNCTION validate_meta_ads_duplicate_reconciliation_event()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_duplicate_reconciliation_validation$
DECLARE
  source_action meta_ads_action_log%ROWTYPE;
  prepared_event meta_ads_duplicate_action_attempt_events%ROWTYPE;
  started_event meta_ads_duplicate_action_attempt_events%ROWTYPE;
  completed_event meta_ads_duplicate_action_attempt_events%ROWTYPE;
  expected_authority_kind TEXT;
  expected_settlement TIMESTAMPTZ;
  durable_target JSONB;
  evidence_target JSONB;
  scan_evidence JSONB;
  provider_ad JSONB;
  scan_checkpoint JSONB;
  latest_scan meta_ads_duplicate_reconciliation_observations%ROWTYPE;
  latest_scan_checkpoint JSONB;
BEGIN
  NEW.created_at := clock_timestamp();
  SELECT *
    INTO source_action
  FROM meta_ads_action_log
  WHERE id = NEW.source_action_log_id
  FOR UPDATE;
  SELECT *
    INTO prepared_event
  FROM meta_ads_duplicate_action_attempt_events
  WHERE id = NEW.source_prepared_event_id
    AND source_action_log_id = NEW.source_action_log_id
    AND event_kind = 'attempt_prepared'
  FOR KEY SHARE;
  SELECT *
    INTO started_event
  FROM meta_ads_duplicate_action_attempt_events
  WHERE source_action_log_id = NEW.source_action_log_id
    AND event_kind = 'attempt_started'
  FOR KEY SHARE;
  SELECT *
    INTO completed_event
  FROM meta_ads_duplicate_action_attempt_events
  WHERE source_action_log_id = NEW.source_action_log_id
    AND event_kind = 'attempt_completed'
  FOR KEY SHARE;

  IF completed_event.id IS NOT NULL THEN
    expected_authority_kind := 'completed_attempt';
    expected_settlement :=
      completed_event.completed_at + interval '5 minutes';
  ELSIF started_event.id IS NOT NULL THEN
    expected_authority_kind := 'lease_expired_started';
    expected_settlement :=
      started_event.lease_deadline + interval '5 minutes';
  ELSE
    expected_authority_kind := 'expired_prepared';
    expected_settlement := prepared_event.lease_deadline;
  END IF;

  durable_target := source_action.payload_request->'duplicate_target';
  evidence_target := NEW.evidence_json->'target';
  scan_evidence := NEW.evidence_json->'scanEvidence';
  provider_ad := NEW.evidence_json->'providerAd';
  scan_checkpoint := scan_evidence->'scanCheckpoint';
  SELECT *
    INTO latest_scan
  FROM meta_ads_duplicate_reconciliation_observations
  WHERE source_action_log_id = NEW.source_action_log_id
    AND observation_method = 'account_ads_scan'
  ORDER BY attempt_ordinal DESC
  LIMIT 1
  FOR KEY SHARE;
  latest_scan_checkpoint :=
    latest_scan.evidence_json
      ->'observationEvidence'
      ->'scanCheckpoint';
  IF source_action.id IS NULL
     OR prepared_event.id IS NULL
     OR started_event.id IS NULL
     OR source_action.action <> 'duplicate'
     OR source_action.source <> 'manual_operator_v1'
     OR source_action.status NOT IN ('pending', 'silent_failure')
     OR source_action.payload_request->>'duplicate_attempt_contract_version'
       IS DISTINCT FROM '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
     OR source_action.payload_request->>'duplicate_marker'
       IS DISTINCT FROM NEW.marker::text
     OR source_action.payload_request->>'duplicate_canonical_name'
       IS DISTINCT FROM NEW.canonical_ad_name
     OR jsonb_typeof(durable_target) IS DISTINCT FROM 'object'
     OR durable_target->>'businessId'
       IS DISTINCT FROM NEW.business_id::text
     OR durable_target->>'providerAccountRefId'
       IS DISTINCT FROM NEW.provider_account_ref_id::text
     OR durable_target->>'providerAccountId'
       IS DISTINCT FROM NEW.provider_account_id
     OR durable_target->>'sourceAdId' IS DISTINCT FROM NEW.source_ad_id
     OR durable_target->>'sourceCreativeId'
       IS DISTINCT FROM NEW.source_creative_id
     OR durable_target->>'targetAdsetId'
       IS DISTINCT FROM NEW.target_adset_id
     OR durable_target->>'marker' IS DISTINCT FROM NEW.marker::text
     OR durable_target->>'canonicalAdName'
       IS DISTINCT FROM NEW.canonical_ad_name
     OR durable_target->>'requestedStatus' IS DISTINCT FROM 'PAUSED'
     OR source_action.business_id <> NEW.business_id
     OR source_action.provider_account_ref_id <>
       NEW.provider_account_ref_id
     OR source_action.provider_account_id <> NEW.provider_account_id
     OR source_action.ad_id <> NEW.source_ad_id
     OR source_action.creative_id <> NEW.source_creative_id
     OR NEW.source_attempt_id <> prepared_event.attempt_id
     OR NEW.business_id <> prepared_event.business_id
     OR NEW.provider_account_ref_id <>
       prepared_event.provider_account_ref_id
     OR NEW.provider_account_id <> prepared_event.provider_account_id
     OR NEW.source_ad_id <> prepared_event.source_ad_id
     OR NEW.source_creative_id <> prepared_event.source_creative_id
     OR NEW.target_adset_id <> prepared_event.target_adset_id
     OR NEW.marker <> prepared_event.marker
     OR NEW.canonical_ad_name <> prepared_event.canonical_ad_name
     OR NEW.authority_kind <> expected_authority_kind
     OR NEW.settlement_not_before <> expected_settlement
     OR NEW.observed_at < expected_settlement
     OR NEW.observed_at > clock_timestamp()
     OR NEW.captured_at > clock_timestamp() + interval '5 seconds'
     OR NEW.captured_at - NEW.observed_at > interval '60 seconds'
     OR NEW.evidence_json->>'contractVersion' IS DISTINCT FROM
       '${META_AD_DUPLICATE_RECONCILIATION_CONTRACT_VERSION}'
     OR NEW.evidence_json->>'sourceActionLogId' IS DISTINCT FROM
       NEW.source_action_log_id::text
     OR NEW.evidence_json->>'attemptId' IS DISTINCT FROM
       NEW.source_attempt_id::text
     OR NEW.evidence_json->>'resolution' IS DISTINCT FROM NEW.resolution
     OR NEW.evidence_json->>'authorityKind'
       IS DISTINCT FROM NEW.authority_kind
     OR NEW.evidence_json->>'settlementNotBefore' IS DISTINCT FROM to_char(
       NEW.settlement_not_before AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR NEW.evidence_json->'scanComplete'
       IS DISTINCT FROM to_jsonb(NEW.scan_complete)
     OR NEW.evidence_json->>'scannedPageCount'
       IS DISTINCT FROM NEW.scanned_page_count::text
     OR NEW.evidence_json->>'observationCount'
       IS DISTINCT FROM NEW.observation_count::text
     OR NEW.evidence_json->>'exactMatchCount'
       IS DISTINCT FROM NEW.exact_match_count::text
     OR NEW.evidence_json->>'observedAt' IS DISTINCT FROM to_char(
       NEW.observed_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR NEW.evidence_json->>'capturedAt' IS DISTINCT FROM to_char(
       NEW.captured_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR jsonb_typeof(evidence_target) IS DISTINCT FROM 'object'
     OR evidence_target IS DISTINCT FROM durable_target
     OR jsonb_typeof(scan_evidence) IS DISTINCT FROM 'object'
     OR NEW.evidence_hash <>
       encode(digest(NEW.evidence_json::text, 'sha256'), 'hex')
     OR (
       NEW.resolution = 'exact_provider_match'
       AND (
         jsonb_typeof(provider_ad) IS DISTINCT FROM 'object'
         OR btrim(provider_ad->>'id')
           IS DISTINCT FROM NEW.resulting_ad_id
         OR regexp_replace(btrim(provider_ad->>'account_id'), '^act_', '', 'i')
           IS DISTINCT FROM regexp_replace(
             NEW.provider_account_id, '^act_', '', 'i'
           )
         OR btrim(provider_ad->>'name')
           IS DISTINCT FROM NEW.canonical_ad_name
         OR upper(btrim(provider_ad->>'status'))
           IS DISTINCT FROM 'PAUSED'
         OR btrim(provider_ad->>'adset_id')
           IS DISTINCT FROM NEW.target_adset_id
         OR btrim(provider_ad->'creative'->>'id')
           IS DISTINCT FROM NEW.source_creative_id
         OR (
           NEW.scanned_page_count = 0
           AND (
             NEW.observation_count <> 1
             OR scan_evidence->>'contractVersion' IS DISTINCT FROM
               'meta-ad-duplicate-known-result-point-get.v1'
             OR scan_evidence->'complete' IS DISTINCT FROM 'true'::jsonb
             OR regexp_replace(
               scan_evidence->>'providerAccountId', '^act_', '', 'i'
             ) IS DISTINCT FROM regexp_replace(
               NEW.provider_account_id, '^act_', '', 'i'
             )
             OR scan_evidence->>'marker'
               IS DISTINCT FROM NEW.marker::text
             OR scan_evidence->>'canonicalAdName'
               IS DISTINCT FROM NEW.canonical_ad_name
             OR scan_evidence->>'targetAdsetId'
               IS DISTINCT FROM NEW.target_adset_id
             OR scan_evidence->>'creativeId'
               IS DISTINCT FROM NEW.source_creative_id
             OR scan_evidence->>'requestedStatus'
               IS DISTINCT FROM NEW.requested_status
             OR scan_evidence->>'adId'
               IS DISTINCT FROM NEW.resulting_ad_id
             OR scan_evidence->>'observedAt' IS DISTINCT FROM to_char(
               NEW.observed_at AT TIME ZONE 'UTC',
               'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
             )
           )
         )
         OR (
           NEW.scanned_page_count > 0
           AND (
             scan_evidence->>'contractVersion' IS DISTINCT FROM
               'meta-ad-duplicate-provider-scan.v1'
             OR scan_evidence->'complete' IS DISTINCT FROM 'true'::jsonb
             OR scan_evidence->'blocker' IS DISTINCT FROM 'null'::jsonb
             OR regexp_replace(
               scan_evidence->>'providerAccountId', '^act_', '', 'i'
             ) IS DISTINCT FROM regexp_replace(
               NEW.provider_account_id, '^act_', '', 'i'
             )
             OR scan_evidence->>'marker'
               IS DISTINCT FROM NEW.marker::text
             OR scan_evidence->>'canonicalAdName'
               IS DISTINCT FROM NEW.canonical_ad_name
             OR scan_evidence->>'targetAdsetId'
               IS DISTINCT FROM NEW.target_adset_id
             OR scan_evidence->>'creativeId'
               IS DISTINCT FROM NEW.source_creative_id
             OR scan_evidence->>'requestedStatus'
               IS DISTINCT FROM NEW.requested_status
             OR scan_evidence->>'pageCount'
               IS DISTINCT FROM NEW.scanned_page_count::text
             OR scan_evidence->>'observationCount'
               IS DISTINCT FROM NEW.observation_count::text
             OR jsonb_typeof(scan_evidence->'exactMatchIds')
               IS DISTINCT FROM 'array'
             OR jsonb_array_length(scan_evidence->'exactMatchIds') <> 1
             OR scan_evidence->'exactMatchIds'->>0
               IS DISTINCT FROM NEW.resulting_ad_id
             OR jsonb_typeof(scan_evidence->'scanCheckpoint')
               IS DISTINCT FROM 'object'
             OR scan_checkpoint->'cycleComplete'
               IS DISTINCT FROM 'true'::jsonb
             OR scan_checkpoint->>'segmentEndAfterCursor'
               IS NOT NULL
             OR scan_checkpoint->>'cumulativePageCount'
               IS DISTINCT FROM NEW.scanned_page_count::text
             OR scan_checkpoint->>'cumulativeObservationCount'
               IS DISTINCT FROM NEW.observation_count::text
             OR scan_checkpoint->'cumulativeExactMatchIds'
               IS DISTINCT FROM scan_evidence->'exactMatchIds'
             OR scan_checkpoint->'visitedCursorHashes'
               IS DISTINCT FROM scan_evidence->'visitedCursorHashes'
             OR scan_checkpoint->>'segmentStartCursorHash'
               IS DISTINCT FROM scan_evidence->>'segmentStartCursorHash'
             OR scan_checkpoint->>'segmentEndCursorHash'
               IS DISTINCT FROM scan_evidence->>'segmentEndCursorHash'
             OR COALESCE(scan_checkpoint->>'segmentIndex', '')
               !~ '^[0-9]+$'
             OR COALESCE(scan_checkpoint->>'cycleId', '') !~
               '^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$'
             OR jsonb_typeof(scan_checkpoint->'visitedCursorHashes')
               IS DISTINCT FROM 'array'
             OR jsonb_typeof(
               scan_checkpoint->'cumulativeExactMatchIds'
             ) IS DISTINCT FROM 'array'
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE
                   WHEN jsonb_typeof(
                     scan_checkpoint->'visitedCursorHashes'
                   ) = 'array'
                     THEN scan_checkpoint->'visitedCursorHashes'
                   ELSE '[]'::jsonb
                 END
               ) AS cursor_hash(value)
               WHERE jsonb_typeof(cursor_hash.value) <> 'string'
                  OR cursor_hash.value #>> '{}' !~ '^[0-9a-f]{64}$'
             )
             OR (
               SELECT count(*) <> count(DISTINCT value)
               FROM jsonb_array_elements_text(
                 CASE
                   WHEN jsonb_typeof(
                     scan_checkpoint->'visitedCursorHashes'
                   ) = 'array'
                     THEN scan_checkpoint->'visitedCursorHashes'
                   ELSE '[]'::jsonb
                 END
               )
             )
             OR EXISTS (
               SELECT 1
               FROM jsonb_array_elements(
                 CASE
                   WHEN jsonb_typeof(
                     scan_checkpoint->'cumulativeExactMatchIds'
                   ) = 'array'
                     THEN scan_checkpoint->'cumulativeExactMatchIds'
                   ELSE '[]'::jsonb
                 END
               ) AS exact_id(value)
               WHERE jsonb_typeof(exact_id.value) <> 'string'
                  OR NULLIF(btrim(exact_id.value #>> '{}'), '') IS NULL
             )
             OR COALESCE(scan_evidence->>'segmentPageCount', '')
               !~ '^[0-9]+$'
             OR COALESCE(
               scan_evidence->>'segmentObservationCount',
               ''
             ) !~ '^[0-9]+$'
             OR (
               CASE
                 WHEN COALESCE(
                   scan_evidence->>'segmentPageCount',
                   ''
                 ) ~ '^[0-9]+$'
                   THEN (scan_evidence->>'segmentPageCount')::integer
                 ELSE -1
               END
             ) <> CASE
               WHEN latest_scan.id IS NOT NULL
                AND latest_scan.segment_end_after_cursor IS NOT NULL
                 THEN NEW.scanned_page_count -
                   latest_scan.scanned_page_count
               ELSE NEW.scanned_page_count
             END
             OR (
               CASE
                 WHEN COALESCE(
                   scan_evidence->>'segmentObservationCount',
                   ''
                 ) ~ '^[0-9]+$'
                   THEN (
                     scan_evidence->>'segmentObservationCount'
                   )::integer
                 ELSE -1
               END
             ) <> CASE
               WHEN latest_scan.id IS NOT NULL
                AND latest_scan.segment_end_after_cursor IS NOT NULL
                 THEN NEW.observation_count -
                   latest_scan.observation_count
               ELSE NEW.observation_count
             END
             OR (
               latest_scan.id IS NULL
               AND (
                 scan_checkpoint->>'segmentIndex' <> '0'
                 OR scan_checkpoint->>'segmentStartAfterCursor' IS NOT NULL
               )
             )
             OR (
               latest_scan.id IS NOT NULL
               AND latest_scan.segment_end_after_cursor IS NULL
               AND (
                 scan_checkpoint->>'segmentIndex' <> '0'
                 OR scan_checkpoint->>'segmentStartAfterCursor' IS NOT NULL
                 OR scan_checkpoint->>'cycleId' =
                   latest_scan.scan_cycle_id::text
               )
             )
             OR (
               latest_scan.id IS NOT NULL
               AND latest_scan.segment_end_after_cursor IS NOT NULL
               AND (
                 scan_checkpoint->>'cycleId' IS DISTINCT FROM
                   latest_scan.scan_cycle_id::text
                 OR scan_checkpoint->>'segmentIndex' IS DISTINCT FROM
                   (latest_scan.scan_segment_index + 1)::text
                 OR scan_checkpoint->>'segmentStartAfterCursor'
                   IS DISTINCT FROM
                     latest_scan.segment_end_after_cursor
                 OR scan_checkpoint->>'segmentStartCursorHash'
                   IS DISTINCT FROM
                     latest_scan.segment_end_cursor_hash
                 OR NEW.scanned_page_count <
                   latest_scan.scanned_page_count
                 OR NEW.observation_count <
                   latest_scan.observation_count
                 OR NOT (
                   (latest_scan_checkpoint->'visitedCursorHashes') <@
                     (scan_checkpoint->'visitedCursorHashes')
                 )
                 OR NOT (
                   (latest_scan_checkpoint->'cumulativeExactMatchIds') <@
                     (scan_checkpoint->'cumulativeExactMatchIds')
                 )
               )
             )
             OR (
               scan_checkpoint->>'segmentStartAfterCursor' IS NOT NULL
               AND (
                 length(scan_checkpoint->>'segmentStartAfterCursor') >
                   2048
                 OR scan_checkpoint->>'segmentStartAfterCursor'
                   ~ '[[:space:]]'
                 OR scan_checkpoint->>'segmentStartAfterCursor'
                   ~* 'https?://'
                 OR scan_checkpoint->>'segmentStartAfterCursor' ~*
                       'access_?token|authorization|bearer'
                 OR scan_checkpoint->>'segmentStartCursorHash'
                   IS DISTINCT FROM encode(
                     digest(
                       'cursor:' ||
                         (scan_checkpoint->>'segmentStartAfterCursor'),
                       'sha256'
                     ),
                     'hex'
                   )
               )
             )
             OR NULLIF(scan_evidence->>'observedAt', '') IS NULL
             OR NULLIF(scan_evidence->>'observedAt', '')::timestamptz >
               NEW.observed_at
             OR NEW.observed_at -
               NULLIF(scan_evidence->>'observedAt', '')::timestamptz >
               interval '60 seconds'
           )
         )
       )
     )
     THEN
    RAISE EXCEPTION
      'Duplicate reconciliation lacks exact settled provider authority.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$meta_duplicate_reconciliation_validation$;

DROP TRIGGER IF EXISTS trg_meta_ads_duplicate_reconciliation_validate
ON meta_ads_duplicate_action_reconciliation_events;
CREATE TRIGGER trg_meta_ads_duplicate_reconciliation_validate
BEFORE INSERT ON meta_ads_duplicate_action_reconciliation_events
FOR EACH ROW
EXECUTE FUNCTION validate_meta_ads_duplicate_reconciliation_event();

CREATE OR REPLACE FUNCTION reject_meta_ads_duplicate_reconciliation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_duplicate_reconciliation_immutable$
BEGIN
  RAISE EXCEPTION
    'meta_ads_duplicate_action_reconciliation_events is append-only.'
    USING ERRCODE = '55000';
END;
$meta_duplicate_reconciliation_immutable$;

DROP TRIGGER IF EXISTS trg_meta_ads_duplicate_reconciliation_immutable
ON meta_ads_duplicate_action_reconciliation_events;
CREATE TRIGGER trg_meta_ads_duplicate_reconciliation_immutable
BEFORE UPDATE OR DELETE ON meta_ads_duplicate_action_reconciliation_events
FOR EACH ROW
EXECUTE FUNCTION reject_meta_ads_duplicate_reconciliation_mutation();

CREATE OR REPLACE FUNCTION validate_meta_ads_duplicate_reconciliation_observation()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_duplicate_observation_validation$
DECLARE
  source_action meta_ads_action_log%ROWTYPE;
  prepared_event meta_ads_duplicate_action_attempt_events%ROWTYPE;
  durable_target JSONB;
  evidence_target JSONB;
  observation_evidence JSONB;
  scan_checkpoint JSONB;
  previous_scan meta_ads_duplicate_reconciliation_observations%ROWTYPE;
  previous_checkpoint JSONB;
  expected_ordinal INTEGER;
  expected_backoff INTEGER;
BEGIN
  NEW.created_at := clock_timestamp();
  SELECT *
    INTO source_action
  FROM meta_ads_action_log
  WHERE id = NEW.source_action_log_id
  FOR UPDATE;
  SELECT *
    INTO prepared_event
  FROM meta_ads_duplicate_action_attempt_events
  WHERE id = NEW.source_prepared_event_id
    AND source_action_log_id = NEW.source_action_log_id
    AND event_kind = 'attempt_prepared'
  FOR KEY SHARE;
  SELECT count(*)::integer + 1
    INTO expected_ordinal
  FROM meta_ads_duplicate_reconciliation_observations
  WHERE source_action_log_id = NEW.source_action_log_id;
  expected_backoff := CASE
    WHEN NEW.disposition IN (
      'scan_segment_progress',
      'point_verification_pending'
    )
      THEN ${META_AD_DUPLICATE_SCAN_PROGRESS_DELAY_SECONDS}
    ELSE LEAST(
      ${META_AD_DUPLICATE_OBSERVATION_BACKOFF_CAP_SECONDS},
      (
        ${META_AD_DUPLICATE_OBSERVATION_BACKOFF_BASE_SECONDS} *
        power(2::numeric, LEAST(NEW.attempt_ordinal - 1, 8))
      )::integer
    )
  END;
  durable_target := source_action.payload_request->'duplicate_target';
  evidence_target := NEW.evidence_json->'target';
  observation_evidence := NEW.evidence_json->'observationEvidence';
  scan_checkpoint := observation_evidence->'scanCheckpoint';
  SELECT *
    INTO previous_scan
  FROM meta_ads_duplicate_reconciliation_observations
  WHERE source_action_log_id = NEW.source_action_log_id
    AND observation_method = 'account_ads_scan'
  ORDER BY attempt_ordinal DESC
  LIMIT 1
  FOR KEY SHARE;
  previous_checkpoint :=
    previous_scan.evidence_json->'observationEvidence'->'scanCheckpoint';

  IF source_action.id IS NULL
     OR prepared_event.id IS NULL
     OR source_action.action <> 'duplicate'
     OR source_action.source <> 'manual_operator_v1'
     OR source_action.status NOT IN ('pending', 'silent_failure')
     OR source_action.payload_request->>'duplicate_attempt_contract_version'
       IS DISTINCT FROM '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
     OR source_action.payload_request->>'duplicate_attempt_required'
       IS DISTINCT FROM 'true'
     OR source_action.business_id <> NEW.business_id
     OR source_action.provider_account_ref_id <>
       NEW.provider_account_ref_id
     OR source_action.provider_account_id <> NEW.provider_account_id
     OR source_action.ad_id <> NEW.source_ad_id
     OR source_action.creative_id <> NEW.source_creative_id
     OR NEW.source_attempt_id <> prepared_event.attempt_id
     OR NEW.business_id <> prepared_event.business_id
     OR NEW.provider_account_ref_id <>
       prepared_event.provider_account_ref_id
     OR NEW.provider_account_id <> prepared_event.provider_account_id
     OR NEW.source_ad_id <> prepared_event.source_ad_id
     OR NEW.source_creative_id <> prepared_event.source_creative_id
     OR NEW.target_adset_id <> prepared_event.target_adset_id
     OR NEW.marker <> prepared_event.marker
     OR NEW.canonical_ad_name <> prepared_event.canonical_ad_name
     OR NEW.requested_status <> prepared_event.requested_status
     OR jsonb_typeof(durable_target) IS DISTINCT FROM 'object'
     OR jsonb_typeof(evidence_target) IS DISTINCT FROM 'object'
     OR evidence_target IS DISTINCT FROM durable_target
     OR jsonb_typeof(observation_evidence) IS DISTINCT FROM 'object'
     OR NEW.attempt_ordinal <> expected_ordinal
     OR NEW.backoff_seconds <> expected_backoff
     OR NEW.next_attempt_not_before <>
       NEW.captured_at + make_interval(secs => expected_backoff)
     OR NEW.observed_at > clock_timestamp()
     OR NEW.captured_at > clock_timestamp() + interval '5 seconds'
     OR NEW.captured_at - NEW.observed_at > interval '60 seconds'
     OR NEW.evidence_json->>'contractVersion' IS DISTINCT FROM
       '${META_AD_DUPLICATE_OBSERVATION_CONTRACT_VERSION}'
     OR NEW.evidence_json->>'sourceActionLogId'
       IS DISTINCT FROM NEW.source_action_log_id::text
     OR NEW.evidence_json->>'attemptId'
       IS DISTINCT FROM NEW.source_attempt_id::text
     OR NEW.evidence_json->>'attemptOrdinal'
       IS DISTINCT FROM NEW.attempt_ordinal::text
     OR NEW.evidence_json->>'observationMethod'
       IS DISTINCT FROM NEW.observation_method
     OR NEW.evidence_json->>'disposition'
       IS DISTINCT FROM NEW.disposition
     OR NEW.evidence_json->>'resultingAdId'
       IS DISTINCT FROM NEW.resulting_ad_id
     OR NEW.evidence_json->'scanComplete'
       IS DISTINCT FROM to_jsonb(NEW.scan_complete)
     OR NEW.evidence_json->>'scannedPageCount'
       IS DISTINCT FROM NEW.scanned_page_count::text
     OR NEW.evidence_json->>'observationCount'
       IS DISTINCT FROM NEW.observation_count::text
     OR NEW.evidence_json->>'exactMatchCount'
       IS DISTINCT FROM NEW.exact_match_count::text
     OR NEW.evidence_json->>'observedAt' IS DISTINCT FROM to_char(
       NEW.observed_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR NEW.evidence_json->>'capturedAt' IS DISTINCT FROM to_char(
       NEW.captured_at AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR NEW.evidence_json->>'backoffSeconds'
       IS DISTINCT FROM NEW.backoff_seconds::text
     OR NEW.evidence_json->>'nextAttemptNotBefore' IS DISTINCT FROM to_char(
       NEW.next_attempt_not_before AT TIME ZONE 'UTC',
       'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
     )
     OR NEW.evidence_hash <>
       encode(digest(NEW.evidence_json::text, 'sha256'), 'hex')
     OR (
       NEW.observation_method = 'account_ads_scan'
       AND (
         jsonb_typeof(scan_checkpoint) IS DISTINCT FROM 'object'
         OR scan_checkpoint->>'cycleId'
           IS DISTINCT FROM NEW.scan_cycle_id::text
         OR scan_checkpoint->>'segmentIndex'
           IS DISTINCT FROM NEW.scan_segment_index::text
         OR scan_checkpoint->>'segmentStartAfterCursor'
           IS DISTINCT FROM NEW.segment_start_after_cursor
         OR scan_checkpoint->>'segmentStartCursorHash'
           IS DISTINCT FROM NEW.segment_start_cursor_hash
         OR scan_checkpoint->>'segmentEndAfterCursor'
           IS DISTINCT FROM NEW.segment_end_after_cursor
         OR scan_checkpoint->>'segmentEndCursorHash'
           IS DISTINCT FROM NEW.segment_end_cursor_hash
         OR scan_checkpoint->'cycleComplete'
           IS DISTINCT FROM to_jsonb(NEW.scan_cycle_complete)
         OR scan_checkpoint->>'cumulativePageCount'
           IS DISTINCT FROM NEW.scanned_page_count::text
         OR scan_checkpoint->>'cumulativeObservationCount'
           IS DISTINCT FROM NEW.observation_count::text
         OR scan_checkpoint->'cumulativeExactMatchIds'
           IS DISTINCT FROM observation_evidence->'exactMatchIds'
         OR scan_checkpoint->'visitedCursorHashes'
           IS DISTINCT FROM observation_evidence->'visitedCursorHashes'
         OR scan_checkpoint->>'segmentStartCursorHash'
           IS DISTINCT FROM observation_evidence->>'segmentStartCursorHash'
         OR scan_checkpoint->>'segmentEndCursorHash'
           IS DISTINCT FROM observation_evidence->>'segmentEndCursorHash'
         OR jsonb_typeof(scan_checkpoint->'visitedCursorHashes')
           IS DISTINCT FROM 'array'
         OR jsonb_typeof(scan_checkpoint->'cumulativeExactMatchIds')
           IS DISTINCT FROM 'array'
         OR jsonb_array_length(
           CASE
             WHEN jsonb_typeof(
               scan_checkpoint->'cumulativeExactMatchIds'
             ) = 'array'
               THEN scan_checkpoint->'cumulativeExactMatchIds'
             ELSE '[]'::jsonb
           END
         ) <> NEW.exact_match_count
         OR jsonb_array_length(
           CASE
             WHEN jsonb_typeof(
               scan_checkpoint->'cumulativeExactMatchIds'
             ) = 'array'
               THEN scan_checkpoint->'cumulativeExactMatchIds'
             ELSE '[]'::jsonb
           END
         ) > 2
         OR (
           SELECT count(DISTINCT value)
           FROM jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(
                 scan_checkpoint->'cumulativeExactMatchIds'
               ) = 'array'
                 THEN scan_checkpoint->'cumulativeExactMatchIds'
               ELSE '[]'::jsonb
             END
           )
         ) <> NEW.exact_match_count
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(
                 scan_checkpoint->'visitedCursorHashes'
               ) = 'array'
                 THEN scan_checkpoint->'visitedCursorHashes'
               ELSE '[]'::jsonb
             END
           ) AS cursor_hash(value)
           WHERE jsonb_typeof(cursor_hash.value) <> 'string'
              OR (cursor_hash.value #>> '{}') !~ '^[0-9a-f]{64}$'
         )
         OR (
           SELECT count(*) <> count(DISTINCT value)
           FROM jsonb_array_elements_text(
             CASE
               WHEN jsonb_typeof(
                 scan_checkpoint->'visitedCursorHashes'
               ) = 'array'
                 THEN scan_checkpoint->'visitedCursorHashes'
               ELSE '[]'::jsonb
             END
           )
         )
         OR EXISTS (
           SELECT 1
           FROM jsonb_array_elements(
             CASE
               WHEN jsonb_typeof(
                 scan_checkpoint->'cumulativeExactMatchIds'
               ) = 'array'
                 THEN scan_checkpoint->'cumulativeExactMatchIds'
               ELSE '[]'::jsonb
             END
           ) AS exact_id(value)
           WHERE jsonb_typeof(exact_id.value) <> 'string'
              OR NULLIF(btrim(exact_id.value #>> '{}'), '') IS NULL
         )
         OR NEW.scan_cycle_complete IS DISTINCT FROM NEW.scan_complete
         OR (
           NEW.scan_cycle_complete
           AND NEW.segment_end_after_cursor IS NOT NULL
         )
         OR (
           NEW.segment_start_after_cursor IS NOT NULL
           AND (
             length(NEW.segment_start_after_cursor) > 2048
             OR NEW.segment_start_after_cursor <> btrim(
               NEW.segment_start_after_cursor
             )
             OR NEW.segment_start_after_cursor ~ '[[:space:]]'
             OR NEW.segment_start_after_cursor ~* 'https?://'
             OR NEW.segment_start_after_cursor ~*
               'access_?token|authorization|bearer'
             OR NEW.segment_start_cursor_hash IS DISTINCT FROM encode(
               digest(
                 'cursor:' || NEW.segment_start_after_cursor,
                 'sha256'
               ),
               'hex'
             )
           )
         )
         OR (
           NEW.segment_end_after_cursor IS NOT NULL
           AND (
             length(NEW.segment_end_after_cursor) > 2048
             OR NEW.segment_end_after_cursor <> btrim(
               NEW.segment_end_after_cursor
             )
             OR NEW.segment_end_after_cursor ~ '[[:space:]]'
             OR NEW.segment_end_after_cursor ~* 'https?://'
             OR NEW.segment_end_after_cursor ~*
               'access_?token|authorization|bearer'
             OR NEW.segment_end_cursor_hash IS DISTINCT FROM encode(
               digest(
                 'cursor:' || NEW.segment_end_after_cursor,
                 'sha256'
               ),
               'hex'
             )
           )
         )
         OR (
           previous_scan.id IS NULL
           AND (
             NEW.scan_segment_index <> 0
             OR NEW.segment_start_after_cursor IS NOT NULL
           )
         )
         OR (
           previous_scan.id IS NOT NULL
           AND previous_scan.segment_end_after_cursor IS NULL
           AND (
             NEW.scan_segment_index <> 0
             OR NEW.segment_start_after_cursor IS NOT NULL
             OR NEW.scan_cycle_id = previous_scan.scan_cycle_id
           )
         )
         OR (
           previous_scan.id IS NOT NULL
           AND previous_scan.segment_end_after_cursor IS NOT NULL
           AND (
             NEW.scan_cycle_id <> previous_scan.scan_cycle_id
             OR NEW.scan_segment_index <>
               previous_scan.scan_segment_index + 1
             OR NEW.segment_start_after_cursor IS DISTINCT FROM
               previous_scan.segment_end_after_cursor
             OR NEW.segment_start_cursor_hash IS DISTINCT FROM
               previous_scan.segment_end_cursor_hash
             OR NEW.scanned_page_count <
               previous_scan.scanned_page_count
             OR NEW.observation_count <
               previous_scan.observation_count
             OR NEW.exact_match_count <
               previous_scan.exact_match_count
             OR NOT (
               (previous_checkpoint->'visitedCursorHashes') <@
                 (scan_checkpoint->'visitedCursorHashes')
             )
             OR NOT (
               (previous_checkpoint->'cumulativeExactMatchIds') <@
                 (scan_checkpoint->'cumulativeExactMatchIds')
             )
           )
         )
         OR COALESCE(observation_evidence->>'segmentPageCount', '')
           !~ '^[0-9]+$'
         OR COALESCE(
           observation_evidence->>'segmentObservationCount',
           ''
         ) !~ '^[0-9]+$'
         OR (
           CASE
             WHEN COALESCE(
               observation_evidence->>'segmentPageCount',
               ''
             ) ~ '^[0-9]+$'
               THEN (
                 observation_evidence->>'segmentPageCount'
               )::integer
             ELSE -1
           END
         ) <> CASE
           WHEN previous_scan.id IS NOT NULL
            AND previous_scan.segment_end_after_cursor IS NOT NULL
             THEN NEW.scanned_page_count -
               previous_scan.scanned_page_count
           ELSE NEW.scanned_page_count
         END
         OR (
           CASE
             WHEN COALESCE(
               observation_evidence->>'segmentObservationCount',
               ''
             ) ~ '^[0-9]+$'
               THEN (
                 observation_evidence->>'segmentObservationCount'
               )::integer
             ELSE -1
           END
         ) <> CASE
           WHEN previous_scan.id IS NOT NULL
            AND previous_scan.segment_end_after_cursor IS NOT NULL
             THEN NEW.observation_count -
               previous_scan.observation_count
           ELSE NEW.observation_count
         END
       )
     )
     OR (
       NEW.observation_method = 'account_ads_scan'
       AND (
         observation_evidence->>'contractVersion'
           IS DISTINCT FROM 'meta-ad-duplicate-provider-scan.v1'
         OR regexp_replace(
           observation_evidence->>'providerAccountId', '^act_', '', 'i'
         ) IS DISTINCT FROM regexp_replace(
           NEW.provider_account_id, '^act_', '', 'i'
         )
         OR observation_evidence->>'marker'
           IS DISTINCT FROM NEW.marker::text
         OR observation_evidence->>'canonicalAdName'
           IS DISTINCT FROM NEW.canonical_ad_name
         OR observation_evidence->>'targetAdsetId'
           IS DISTINCT FROM NEW.target_adset_id
         OR observation_evidence->>'creativeId'
           IS DISTINCT FROM NEW.source_creative_id
         OR observation_evidence->>'requestedStatus'
           IS DISTINCT FROM NEW.requested_status
         OR observation_evidence->'complete'
           IS DISTINCT FROM to_jsonb(NEW.scan_complete)
         OR observation_evidence->>'pageCount'
           IS DISTINCT FROM NEW.scanned_page_count::text
         OR observation_evidence->>'observationCount'
           IS DISTINCT FROM NEW.observation_count::text
         OR jsonb_typeof(observation_evidence->'exactMatchIds')
           IS DISTINCT FROM 'array'
         OR jsonb_array_length(observation_evidence->'exactMatchIds') <>
           NEW.exact_match_count
         OR observation_evidence->>'observedAt' IS DISTINCT FROM to_char(
           NEW.observed_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
         OR (
           NEW.scanned_page_count = 0
           AND NEW.disposition NOT IN (
             'provider_read_incomplete',
             'provider_identity_drift'
           )
         )
         OR NEW.disposition NOT IN (
           'scan_segment_progress',
           'point_verification_pending',
           'complete_scan_absence',
           'provider_read_incomplete',
           'provider_identity_drift',
           'multiple_exact_provider_matches',
           'reconciliation_persistence_unavailable'
         )
         OR (
           NEW.disposition = 'scan_segment_progress'
           AND (
             NEW.scan_complete
             OR NEW.segment_end_after_cursor IS NULL
             OR observation_evidence->>'blocker'
             IS DISTINCT FROM 'pagination_segment_limit'
           )
         )
         OR (
           NEW.disposition = 'point_verification_pending'
           AND (
             NOT NEW.scan_complete
             OR NEW.exact_match_count <> 1
             OR NEW.resulting_ad_id IS NULL
             OR observation_evidence->'blocker'
               IS DISTINCT FROM 'null'::jsonb
             OR observation_evidence->>'pointVerificationBlocker'
               IS DISTINCT FROM 'provider_deadline_exhausted'
             OR observation_evidence->'exactMatchIds'->>0
               IS DISTINCT FROM NEW.resulting_ad_id
           )
         )
         OR (
           NEW.disposition = 'complete_scan_absence'
           AND (
             NOT NEW.scan_complete
             OR NEW.exact_match_count <> 0
             OR NEW.resulting_ad_id IS NOT NULL
             OR observation_evidence->'blocker'
               IS DISTINCT FROM 'null'::jsonb
           )
         )
         OR (
           NEW.disposition = 'multiple_exact_provider_matches'
           AND (
             NOT NEW.scan_complete
             OR NEW.exact_match_count <= 1
             OR NEW.resulting_ad_id IS NOT NULL
             OR observation_evidence->'blocker'
               IS DISTINCT FROM 'null'::jsonb
           )
         )
         OR (
           NEW.disposition = 'provider_identity_drift'
           AND (
             NEW.scan_complete
             OR observation_evidence->>'blocker'
               IS DISTINCT FROM 'provider_identity_drift'
           )
         )
         OR (
           NEW.disposition = 'provider_read_incomplete'
           AND (
             NEW.scan_complete
             OR observation_evidence->>'blocker' IS NULL
             OR observation_evidence->>'blocker' NOT IN (
               'provider_read_unavailable',
               'pagination_cycle'
             )
           )
         )
         OR (
           NEW.disposition = 'reconciliation_persistence_unavailable'
           AND (
             NOT NEW.scan_complete
             OR NEW.exact_match_count <> 1
             OR NEW.resulting_ad_id IS NULL
             OR observation_evidence->'blocker'
               IS DISTINCT FROM 'null'::jsonb
           )
         )
       )
     )
     OR (
       NEW.observation_method = 'known_result_point_get'
       AND (
         observation_evidence->>'contractVersion'
           IS DISTINCT FROM 'meta-ad-duplicate-provider-point-read.v1'
         OR regexp_replace(
           observation_evidence->>'providerAccountId', '^act_', '', 'i'
         ) IS DISTINCT FROM regexp_replace(
           NEW.provider_account_id, '^act_', '', 'i'
         )
         OR observation_evidence->>'marker'
           IS DISTINCT FROM NEW.marker::text
         OR observation_evidence->>'canonicalAdName'
           IS DISTINCT FROM NEW.canonical_ad_name
         OR observation_evidence->>'targetAdsetId'
           IS DISTINCT FROM NEW.target_adset_id
         OR observation_evidence->>'creativeId'
           IS DISTINCT FROM NEW.source_creative_id
         OR observation_evidence->>'requestedStatus'
           IS DISTINCT FROM NEW.requested_status
         OR observation_evidence->>'observedAt' IS DISTINCT FROM to_char(
           NEW.observed_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
         OR NEW.scanned_page_count <> 0
         OR NEW.disposition NOT IN (
           'provider_read_incomplete',
           'provider_identity_drift',
           'reconciliation_persistence_unavailable'
         )
         OR (
           NEW.disposition = 'provider_read_incomplete'
           AND (
             NEW.scan_complete
             OR NEW.exact_match_count <> 0
             OR observation_evidence->>'blocker'
               IS DISTINCT FROM 'provider_read_unavailable'
           )
         )
         OR (
           NEW.disposition = 'provider_identity_drift'
           AND (
             NEW.scan_complete
             OR NEW.exact_match_count <> 0
             OR observation_evidence->>'blocker'
               IS DISTINCT FROM 'provider_identity_drift'
           )
         )
         OR (
           NEW.disposition = 'reconciliation_persistence_unavailable'
           AND (
             NOT NEW.scan_complete
             OR NEW.observation_count <> 1
             OR NEW.exact_match_count <> 1
             OR NEW.resulting_ad_id IS NULL
             OR observation_evidence->'blocker'
               IS DISTINCT FROM 'null'::jsonb
             OR observation_evidence->'providerEvidence'->>'id'
               IS DISTINCT FROM NEW.resulting_ad_id
             OR regexp_replace(
               observation_evidence->'providerEvidence'->>'account_id',
               '^act_',
               '',
               'i'
             ) IS DISTINCT FROM regexp_replace(
               NEW.provider_account_id,
               '^act_',
               '',
               'i'
             )
             OR observation_evidence->'providerEvidence'->>'name'
               IS DISTINCT FROM NEW.canonical_ad_name
             OR upper(
               observation_evidence->'providerEvidence'->>'status'
             ) IS DISTINCT FROM NEW.requested_status
             OR observation_evidence->'providerEvidence'->>'adset_id'
               IS DISTINCT FROM NEW.target_adset_id
             OR observation_evidence->'providerEvidence'->'creative'->>'id'
               IS DISTINCT FROM NEW.source_creative_id
           )
         )
       )
     )
     OR (
       NEW.observation_method = 'credentials'
       AND (
         NEW.disposition <> 'credentials_unavailable'
         OR NEW.scan_complete
         OR NEW.scanned_page_count <> 0
         OR NEW.observation_count <> 0
         OR NEW.exact_match_count <> 0
         OR observation_evidence->>'contractVersion'
           IS DISTINCT FROM 'meta-ad-duplicate-credentials-observation.v1'
         OR observation_evidence->>'blocker'
           IS DISTINCT FROM 'meta_credentials_unavailable'
         OR observation_evidence->>'observedAt' IS DISTINCT FROM to_char(
           NEW.observed_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
       )
     )
     OR (
       NEW.observation_method = 'internal'
       AND (
         NEW.disposition NOT IN (
           'unexpected_reconciliation_error',
           'provider_deadline_exhausted'
         )
         OR NEW.scan_complete
         OR NEW.scanned_page_count <> 0
         OR NEW.observation_count <> 0
         OR NEW.exact_match_count <> 0
         OR (
           NEW.disposition = 'unexpected_reconciliation_error'
           AND (
             observation_evidence->>'contractVersion' IS DISTINCT FROM
               'meta-ad-duplicate-internal-reconciliation-observation.v1'
             OR observation_evidence->>'blocker'
               IS DISTINCT FROM 'unexpected_reconciliation_error'
           )
         )
         OR (
           NEW.disposition = 'provider_deadline_exhausted'
           AND (
             observation_evidence->>'contractVersion' IS DISTINCT FROM
               'meta-ad-duplicate-provider-deadline-observation.v1'
             OR observation_evidence->>'blocker'
               IS DISTINCT FROM 'provider_deadline_exhausted'
           )
         )
         OR observation_evidence->>'observedAt' IS DISTINCT FROM to_char(
           NEW.observed_at AT TIME ZONE 'UTC',
           'YYYY-MM-DD"T"HH24:MI:SS.MS"Z"'
         )
       )
     ) THEN
    RAISE EXCEPTION
      'Duplicate reconciliation observation lacks exact lineage or schedule.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$meta_duplicate_observation_validation$;

DROP TRIGGER IF EXISTS trg_meta_ads_duplicate_observation_validate
ON meta_ads_duplicate_reconciliation_observations;
CREATE TRIGGER trg_meta_ads_duplicate_observation_validate
BEFORE INSERT ON meta_ads_duplicate_reconciliation_observations
FOR EACH ROW
EXECUTE FUNCTION validate_meta_ads_duplicate_reconciliation_observation();

CREATE OR REPLACE FUNCTION reject_meta_ads_duplicate_observation_mutation()
RETURNS trigger
LANGUAGE plpgsql
AS $meta_duplicate_observation_immutable$
BEGIN
  RAISE EXCEPTION
    'meta_ads_duplicate_reconciliation_observations is append-only.'
    USING ERRCODE = '55000';
END;
$meta_duplicate_observation_immutable$;

DROP TRIGGER IF EXISTS trg_meta_ads_duplicate_observation_immutable
ON meta_ads_duplicate_reconciliation_observations;
CREATE TRIGGER trg_meta_ads_duplicate_observation_immutable
BEFORE UPDATE OR DELETE ON meta_ads_duplicate_reconciliation_observations
FOR EACH ROW
EXECUTE FUNCTION reject_meta_ads_duplicate_observation_mutation();

CREATE OR REPLACE FUNCTION validate_manual_meta_ads_duplicate_terminalization()
RETURNS trigger
LANGUAGE plpgsql
AS $manual_meta_duplicate_terminal_validation$
DECLARE
  old_required BOOLEAN;
  new_required BOOLEAN;
  old_manual_live BOOLEAN;
  new_manual_live BOOLEAN;
  prepared_count INTEGER;
  started_count INTEGER;
  completed_count INTEGER;
  completed_event meta_ads_duplicate_action_attempt_events%ROWTYPE;
  reconciliation_event meta_ads_duplicate_action_reconciliation_events%ROWTYPE;
  pre_provider_proof BOOLEAN;
  completion_proof BOOLEAN;
  reconciliation_proof BOOLEAN;
BEGIN
  old_manual_live := COALESCE((
    OLD.source = 'manual_operator_v1'
    AND OLD.action = 'duplicate'
    AND NOT COALESCE(OLD.dry_run, FALSE)
  ), FALSE);
  new_manual_live := COALESCE((
    NEW.source = 'manual_operator_v1'
    AND NEW.action = 'duplicate'
    AND NOT COALESCE(NEW.dry_run, FALSE)
  ), FALSE);
  old_required := COALESCE((
    OLD.source = 'manual_operator_v1'
    AND OLD.action = 'duplicate'
    AND NOT COALESCE(OLD.dry_run, FALSE)
    AND OLD.payload_request->>'duplicate_attempt_contract_version' =
      '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
    AND OLD.payload_request->>'duplicate_attempt_required' = 'true'
  ), FALSE);
  new_required := COALESCE((
    NEW.source = 'manual_operator_v1'
    AND NEW.action = 'duplicate'
    AND NOT COALESCE(NEW.dry_run, FALSE)
    AND NEW.payload_request->>'duplicate_attempt_contract_version' =
      '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
    AND NEW.payload_request->>'duplicate_attempt_required' = 'true'
  ), FALSE);
  IF (old_manual_live OR new_manual_live)
     AND NOT old_required
     AND NOT new_required THEN
    IF old_manual_live IS DISTINCT FROM new_manual_live
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
       OR NEW.decision_episode_key IS DISTINCT FROM
         OLD.decision_episode_key
       OR NEW.decision_snapshot_id IS DISTINCT FROM
         OLD.decision_snapshot_id
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
       OR NEW.verification_status IS DISTINCT FROM
         OLD.verification_status
       OR NEW.created_at IS DISTINCT FROM OLD.created_at THEN
      RAISE EXCEPTION
        'Legacy/manual live duplicate identity cannot be created or reshaped by UPDATE.'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;
  IF NOT old_required AND NOT new_required THEN
    RETURN NEW;
  END IF;

  IF old_required IS DISTINCT FROM new_required
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
      'Journal-required duplicate claim identity and envelope are immutable.'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    count(*) FILTER (
      WHERE event_kind = 'attempt_prepared'
    )::integer,
    count(*) FILTER (
      WHERE event_kind = 'attempt_started'
    )::integer,
    count(*) FILTER (
      WHERE event_kind = 'attempt_completed'
    )::integer
  INTO prepared_count, started_count, completed_count
  FROM meta_ads_duplicate_action_attempt_events
  WHERE source_action_log_id = OLD.id;
  SELECT *
    INTO completed_event
  FROM meta_ads_duplicate_action_attempt_events
  WHERE source_action_log_id = OLD.id
    AND event_kind = 'attempt_completed';
  SELECT *
    INTO reconciliation_event
  FROM meta_ads_duplicate_action_reconciliation_events
  WHERE source_action_log_id = OLD.id;

  IF OLD.status IN ('success', 'failure') THEN
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
        'Journal-required duplicate terminal fact is immutable.'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW.status IS NOT DISTINCT FROM OLD.status
     AND NEW.payload_response IS NOT DISTINCT FROM OLD.payload_response
     AND NEW.error_code IS NOT DISTINCT FROM OLD.error_code
     AND NEW.error_message IS NOT DISTINCT FROM OLD.error_message
     AND NEW.resulting_ad_id IS NOT DISTINCT FROM OLD.resulting_ad_id
     AND NEW.duration_ms IS NOT DISTINCT FROM OLD.duration_ms
     AND NEW.verified_at IS NOT DISTINCT FROM OLD.verified_at
     AND NEW.verification_payload IS NOT DISTINCT FROM
       OLD.verification_payload
     AND NEW.terminal_finalized_at IS NOT DISTINCT FROM
       OLD.terminal_finalized_at THEN
    RETURN NEW;
  END IF;

  IF prepared_count <> 1
     OR NEW.terminal_finalized_at IS NULL
     OR (NEW.duration_ms IS NOT NULL AND NEW.duration_ms < 0) THEN
    RAISE EXCEPTION
      'Journal-required duplicate terminal common authority is invalid.'
      USING ERRCODE = '23514';
  END IF;

  pre_provider_proof :=
    OLD.status = 'pending'
    AND started_count = 0
    AND completed_count = 0
    AND reconciliation_event.id IS NULL
    AND NEW.status = 'failure'
    AND NEW.payload_response = jsonb_build_object(
      'duplicate_pre_provider_abort',
      jsonb_build_object(
        'code', NEW.error_code,
        'provider_mutation_attempted', false
      )
    )
    AND NULLIF(btrim(NEW.error_code), '') IS NOT NULL
    AND NULLIF(btrim(NEW.error_message), '') IS NOT NULL
    AND NEW.resulting_ad_id IS NULL
    AND NEW.verified_at IS NULL
    AND NEW.verification_payload IS NULL;

  completion_proof :=
    OLD.status = 'pending'
    AND started_count = 1
    AND completed_count = 1
    AND reconciliation_event.id IS NULL
    AND NEW.payload_response IS NOT DISTINCT FROM
      completed_event.provider_response_json
    AND NEW.verification_payload IS NOT DISTINCT FROM
      completed_event.verification_json
    AND NEW.resulting_ad_id IS NOT DISTINCT FROM
      completed_event.resulting_ad_id
    AND (
      (
        NEW.status = 'success'
        AND completed_event.completion_outcome =
          'provider_response_verified_success'
        AND NEW.verified_at IS NOT DISTINCT FROM
          completed_event.verification_observed_at
        AND NEW.error_code IS NULL
        AND NEW.error_message IS NULL
      ) OR (
        NEW.status = 'silent_failure'
        AND completed_event.completion_outcome IN (
          'provider_outcome_ambiguous',
          'provider_response_succeeded_verification_failed'
        )
        AND NEW.verified_at IS NULL
        AND NULLIF(btrim(NEW.error_code), '') IS NOT NULL
        AND NULLIF(btrim(NEW.error_message), '') IS NOT NULL
      ) OR (
        NEW.status = 'failure'
        AND completed_event.completion_outcome =
          'provider_definite_failure'
        AND NEW.verified_at IS NULL
        AND NULLIF(btrim(NEW.error_code), '') IS NOT NULL
        AND NULLIF(btrim(NEW.error_message), '') IS NOT NULL
      )
    );

  reconciliation_proof :=
    OLD.status IN ('pending', 'silent_failure')
    AND reconciliation_event.id IS NOT NULL
    AND reconciliation_event.resolution = 'exact_provider_match'
    AND NEW.status = 'success'
    AND NEW.payload_response = jsonb_build_object(
      'duplicate_reconciliation',
      reconciliation_event.evidence_json
    )
    AND NEW.error_code IS NULL
    AND NEW.error_message IS NULL
    AND NEW.resulting_ad_id IS NOT DISTINCT FROM
      reconciliation_event.resulting_ad_id
    AND NEW.duration_ms IS NOT DISTINCT FROM OLD.duration_ms
    AND NEW.verified_at IS NOT DISTINCT FROM
      reconciliation_event.observed_at
    AND NEW.verification_payload IS NOT DISTINCT FROM
      reconciliation_event.evidence_json;

  IF NOT (
    COALESCE(pre_provider_proof, FALSE)
    OR COALESCE(completion_proof, FALSE)
    OR COALESCE(reconciliation_proof, FALSE)
  ) THEN
    RAISE EXCEPTION
      'Journal-required duplicate terminalization lacks exact authority.'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END;
$manual_meta_duplicate_terminal_validation$;

DROP TRIGGER IF EXISTS trg_manual_meta_ads_duplicate_terminal_validate
ON meta_ads_action_log;
CREATE TRIGGER trg_manual_meta_ads_duplicate_terminal_validate
BEFORE UPDATE ON meta_ads_action_log
FOR EACH ROW
EXECUTE FUNCTION validate_manual_meta_ads_duplicate_terminalization();
`;

const READ_DUPLICATE_PREPARED_ATTEMPT_QUERY = `
SELECT
  source_action_log_id::text,
  attempt_id::text,
  business_id::text,
  provider_account_ref_id::text,
  provider_account_id,
  source_ad_id,
  source_creative_id,
  target_adset_id,
  marker::text,
  canonical_ad_name,
  requested_status,
  post_path,
  prepared_at,
  lease_deadline
FROM meta_ads_duplicate_action_attempt_events
WHERE source_action_log_id = $1::uuid
  AND event_kind = 'attempt_prepared'
LIMIT 1
`;

const READ_DUPLICATE_RECONCILIATION_CANDIDATES_QUERY = `
SELECT
  action_log.id::text AS source_action_log_id,
  action_log.business_id::text AS business_id,
  action_log.provider_account_ref_id::text AS provider_account_ref_id,
  action_log.provider_account_id,
  action_log.ad_id AS source_ad_id,
  action_log.creative_id AS source_creative_id,
  prepared.target_adset_id,
  prepared.marker::text,
  prepared.canonical_ad_name,
  prepared.requested_status,
  COALESCE(
    action_log.resulting_ad_id,
    completed.resulting_ad_id,
    latest_observation.resulting_ad_id
  ) AS resulting_ad_id,
  action_log.status,
  prepared.attempt_id::text,
  CASE
    WHEN completed.id IS NOT NULL THEN 'completed_attempt'
    WHEN started.id IS NOT NULL THEN 'lease_expired_started'
    ELSE 'expired_prepared'
  END AS authority_kind,
  CASE
    WHEN completed.id IS NOT NULL
      THEN completed.completed_at + interval '5 minutes'
    WHEN started.id IS NOT NULL
      THEN started.lease_deadline + interval '5 minutes'
    ELSE prepared.lease_deadline
  END AS settlement_not_before,
  latest_scan.scan_cycle_id::text,
  CASE
    WHEN latest_scan.segment_end_after_cursor IS NOT NULL
      THEN latest_scan.scan_segment_index + 1
    ELSE NULL
  END AS scan_segment_index,
  latest_scan.segment_end_after_cursor AS scan_after_cursor,
  latest_scan.evidence_json
    #> '{observationEvidence,scanCheckpoint,visitedCursorHashes}'
    AS scan_visited_cursor_hashes,
  latest_scan.scanned_page_count AS scan_cumulative_page_count,
  latest_scan.observation_count AS scan_cumulative_observation_count,
  latest_scan.evidence_json
    #> '{observationEvidence,scanCheckpoint,cumulativeExactMatchIds}'
    AS scan_cumulative_exact_match_ids,
  clock_timestamp() AS db_now
FROM meta_ads_action_log action_log
JOIN meta_ads_duplicate_action_attempt_events prepared
  ON prepared.source_action_log_id = action_log.id
 AND prepared.event_kind = 'attempt_prepared'
LEFT JOIN meta_ads_duplicate_action_attempt_events started
  ON started.source_action_log_id = action_log.id
 AND started.event_kind = 'attempt_started'
LEFT JOIN meta_ads_duplicate_action_attempt_events completed
  ON completed.source_action_log_id = action_log.id
 AND completed.event_kind = 'attempt_completed'
LEFT JOIN LATERAL (
  SELECT
    observation.captured_at,
    observation.next_attempt_not_before,
    observation.resulting_ad_id
  FROM meta_ads_duplicate_reconciliation_observations observation
  WHERE observation.source_action_log_id = action_log.id
  ORDER BY observation.attempt_ordinal DESC
  LIMIT 1
) latest_observation ON TRUE
LEFT JOIN LATERAL (
  SELECT
    observation.scan_cycle_id,
    observation.scan_segment_index,
    observation.segment_end_after_cursor,
    observation.scanned_page_count,
    observation.observation_count,
    observation.evidence_json
  FROM meta_ads_duplicate_reconciliation_observations observation
  WHERE observation.source_action_log_id = action_log.id
    AND observation.observation_method = 'account_ads_scan'
  ORDER BY observation.attempt_ordinal DESC
  LIMIT 1
) latest_scan ON TRUE
WHERE action_log.action = 'duplicate'
  AND action_log.source = 'manual_operator_v1'
  AND action_log.status IN ('pending', 'silent_failure')
  AND action_log.provider_account_ref_id IS NOT NULL
  AND action_log.provider_account_id IS NOT NULL
  AND action_log.creative_id IS NOT NULL
  AND NOT COALESCE(action_log.dry_run, FALSE)
  AND action_log.payload_request->>'duplicate_attempt_contract_version' =
    '${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}'
  AND action_log.payload_request->>'duplicate_attempt_required' = 'true'
  AND NOT EXISTS (
    SELECT 1
    FROM meta_ads_duplicate_action_reconciliation_events reconciliation
    WHERE reconciliation.source_action_log_id = action_log.id
  )
  AND clock_timestamp() >= CASE
    WHEN completed.id IS NOT NULL
      THEN completed.completed_at + interval '5 minutes'
    WHEN started.id IS NOT NULL
      THEN started.lease_deadline + interval '5 minutes'
    ELSE prepared.lease_deadline
  END
  AND (
    latest_observation.next_attempt_not_before IS NULL
    OR clock_timestamp() >= latest_observation.next_attempt_not_before
  )
ORDER BY
  CASE WHEN latest_observation.captured_at IS NULL THEN 0 ELSE 1 END ASC,
  COALESCE(latest_observation.captured_at, prepared.prepared_at) ASC,
  prepared.prepared_at ASC,
  action_log.id ASC
LIMIT $1::integer
`;

function targetEvidence(target: MetaAdDuplicateTarget) {
  return {
    businessId: target.businessId,
    providerAccountRefId: target.providerAccountRefId,
    providerAccountId: target.providerAccountId,
    sourceAdId: target.sourceAdId,
    sourceCreativeId: target.sourceCreativeId,
    targetAdsetId: target.targetAdsetId,
    marker: target.marker,
    canonicalAdName: target.canonicalAdName,
    requestedStatus: target.requestedStatus,
  };
}

function mapPrepared(row: DuplicateAttemptDbRow): MetaAdDuplicatePreparedAttempt {
  return {
    sourceActionLogId: row.source_action_log_id,
    attemptId: row.attempt_id,
    target: {
      businessId: row.business_id,
      providerAccountRefId: row.provider_account_ref_id,
      providerAccountId: row.provider_account_id,
      sourceAdId: row.source_ad_id,
      sourceCreativeId: row.source_creative_id,
      targetAdsetId: row.target_adset_id,
      marker: row.marker,
      canonicalAdName: row.canonical_ad_name,
      requestedStatus: row.requested_status,
    },
    postPath: row.post_path,
    preparedAt: iso(row.prepared_at),
    leaseDeadline: iso(row.lease_deadline),
  };
}

export async function prepareMetaAdDuplicateAttempt(input: {
  sourceActionLogId: string;
  target: MetaAdDuplicateTarget;
}): Promise<MetaAdDuplicatePreparedAttempt> {
  const target: MetaAdDuplicateTarget = {
    businessId: exactText(input.target.businessId, "businessId"),
    providerAccountRefId: exactText(
      input.target.providerAccountRefId,
      "providerAccountRefId",
    ),
    providerAccountId: exactText(
      input.target.providerAccountId,
      "providerAccountId",
    ),
    sourceAdId: exactText(input.target.sourceAdId, "sourceAdId"),
    sourceCreativeId: exactText(
      input.target.sourceCreativeId,
      "sourceCreativeId",
    ),
    targetAdsetId: exactText(input.target.targetAdsetId, "targetAdsetId"),
    marker: normalizeMetaAdDuplicateMarker(input.target.marker),
    canonicalAdName: exactText(
      input.target.canonicalAdName,
      "canonicalAdName",
    ),
    requestedStatus: "PAUSED",
  };
  if (
    target.canonicalAdName !==
    buildMetaAdDuplicateCanonicalName(
      target.canonicalAdName.replace(
        new RegExp(
          `\\s*\\[${META_AD_DUPLICATE_MARKER_PREFIX}:${target.marker}\\]$`,
        ),
        "",
      ),
      target.marker,
    )
  ) {
    throw new TypeError("Duplicate canonical name does not bind its marker.");
  }
  const sourceActionLogId = exactText(
    input.sourceActionLogId,
    "sourceActionLogId",
  );
  const attemptId = randomUUID();
  const postPath = `act_${target.providerAccountId.replace(/^act_/i, "")}/ads`;
  const sql = getDb();
  const dbClock = await sql.query<{ prepared_at: string | Date }>(
    "SELECT clock_timestamp() AS prepared_at",
  );
  const preparedAt = iso(dbClock[0]!.prepared_at);
  const leaseDeadline = new Date(
    new Date(preparedAt).getTime() + META_AD_DUPLICATE_ATTEMPT_LEASE_MS,
  ).toISOString();
  const evidence = {
    contractVersion: META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION,
    eventKind: "attempt_prepared",
    sourceActionLogId,
    attemptId,
    postPath,
    preparedAt,
    leaseDeadline,
    target: targetEvidence(target),
  };
  const rows = await sql.query<DuplicateAttemptDbRow>(
    `INSERT INTO meta_ads_duplicate_action_attempt_events (
       source_action_log_id, business_id, provider_account_ref_id,
       provider_account_id, source_ad_id, source_creative_id,
       target_adset_id, marker, canonical_ad_name, requested_status,
       attempt_id, event_kind, post_path, prepared_at, lease_deadline,
       evidence_json, evidence_hash
     ) VALUES (
       $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9,
       'PAUSED', $10::uuid, 'attempt_prepared', $11,
       $12::timestamptz, $13::timestamptz, $14::jsonb,
       encode(digest($14::jsonb::text, 'sha256'), 'hex')
     )
     RETURNING *`,
    [
      sourceActionLogId,
      target.businessId,
      target.providerAccountRefId,
      target.providerAccountId,
      target.sourceAdId,
      target.sourceCreativeId,
      target.targetAdsetId,
      target.marker,
      target.canonicalAdName,
      attemptId,
      postPath,
      preparedAt,
      leaseDeadline,
      JSON.stringify(evidence),
    ],
  );
  if (!rows[0]) {
    throw new Error("Failed to persist duplicate preparation.");
  }
  return mapPrepared(rows[0]);
}

async function readPreparedAttempt(sourceActionLogId: string) {
  const rows = await getDb().query<DuplicateAttemptDbRow>(
    READ_DUPLICATE_PREPARED_ATTEMPT_QUERY,
    [sourceActionLogId],
  );
  if (!rows[0]) {
    throw new Error("Duplicate preparation is missing.");
  }
  return mapPrepared(rows[0]);
}

export async function appendMetaAdDuplicateAttemptStarted(
  sourceActionLogId: string,
): Promise<MetaAdDuplicatePreparedAttempt & { startedAt: string }> {
  return runDbTransaction(async () => {
    const prepared = await readPreparedAttempt(sourceActionLogId);
    const sql = getDb();
    const dbClock = await sql.query<{ started_at: string | Date }>(
      "SELECT clock_timestamp() AS started_at",
    );
    const startedAt = iso(dbClock[0]!.started_at);
    const evidence = {
      contractVersion: META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION,
      eventKind: "attempt_started",
      sourceActionLogId: prepared.sourceActionLogId,
      attemptId: prepared.attemptId,
      postPath: prepared.postPath,
      preparedAt: prepared.preparedAt,
      leaseDeadline: prepared.leaseDeadline,
      startedAt,
      target: targetEvidence(prepared.target),
    };
    const rows = await sql.query<{ id: string }>(
      `INSERT INTO meta_ads_duplicate_action_attempt_events (
         source_action_log_id, business_id, provider_account_ref_id,
         provider_account_id, source_ad_id, source_creative_id,
         target_adset_id, marker, canonical_ad_name, requested_status,
         attempt_id, event_kind, post_path, prepared_at, lease_deadline,
         started_at, evidence_json, evidence_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9,
         'PAUSED', $10::uuid, 'attempt_started', $11,
         $12::timestamptz, $13::timestamptz, $14::timestamptz,
         $15::jsonb, encode(digest($15::jsonb::text, 'sha256'), 'hex')
       )
       ON CONFLICT (source_action_log_id, event_kind) DO NOTHING
       RETURNING id::text`,
      [
        prepared.sourceActionLogId,
        prepared.target.businessId,
        prepared.target.providerAccountRefId,
        prepared.target.providerAccountId,
        prepared.target.sourceAdId,
        prepared.target.sourceCreativeId,
        prepared.target.targetAdsetId,
        prepared.target.marker,
        prepared.target.canonicalAdName,
        prepared.attemptId,
        prepared.postPath,
        prepared.preparedAt,
        prepared.leaseDeadline,
        startedAt,
        JSON.stringify(evidence),
      ],
    );
    if (!rows[0]) {
      // A pre-existing start means one caller already acquired the only
      // provider-POST authority (or its commit acknowledgement was lost).
      // Never treat it as idempotent success: that would let a second caller
      // pass the before-POST hook under the same journal row.
      const error = new Error(
        "Duplicate attempt already has a durable start; no second provider POST is allowed.",
      ) as Error & { code: string };
      error.code = "duplicate_attempt_already_started";
      throw error;
    }
    return { ...prepared, startedAt };
  });
}

function duplicateCompletionOutcome(input: {
  successful: boolean;
  providerResponseSuccessful: boolean;
  providerOutcome: string;
}): MetaAdDuplicateCompletionOutcome {
  if (input.successful) return "provider_response_verified_success";
  if (input.providerResponseSuccessful) {
    return "provider_response_succeeded_verification_failed";
  }
  if (input.providerOutcome === "outcome_ambiguous") {
    return "provider_outcome_ambiguous";
  }
  return "provider_definite_failure";
}

export async function finalizeMetaAdDuplicateAttempt(input: {
  sourceActionLogId: string;
  successful: boolean;
  mutationReceipt: MetaAdDuplicateMutationReceipt;
  providerResponse: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  verificationObservedAt: string | null;
  resultingAdId: string | null;
  errorCode: string | null;
  errorMessage: string | null;
  durationMs: number;
}): Promise<void> {
  await runDbTransaction(async () => {
    const sql = getDb();
    const sourceRows = await sql.query<{ status: string }>(
      `SELECT status
       FROM meta_ads_action_log
       WHERE id = $1::uuid
       FOR UPDATE`,
      [input.sourceActionLogId],
    );
    if (!sourceRows[0]) {
      throw new Error("Duplicate completion source is missing.");
    }
    const prepared = await readPreparedAttempt(input.sourceActionLogId);
    const startedRows = await sql.query<{ started_at: string | Date }>(
      `SELECT started_at
       FROM meta_ads_duplicate_action_attempt_events
       WHERE source_action_log_id = $1::uuid
         AND event_kind = 'attempt_started'
       FOR KEY SHARE`,
      [prepared.sourceActionLogId],
    );
    if (!startedRows[0]) {
      throw new Error("Duplicate completion has no durable start.");
    }
    const startedAt = iso(startedRows[0].started_at);
    const receipt: MetaAdDuplicateMutationReceipt = {
      ...input.mutationReceipt,
      providerResponseSuccessful:
        input.mutationReceipt.providerResponseSuccessful === true,
      transportError: input.mutationReceipt.transportError
        ? JSON.parse(JSON.stringify(input.mutationReceipt.transportError))
        : null,
    };
    if (
      receipt.attemptCount !== 1 ||
      receipt.method !== "POST" ||
      receipt.path !== prepared.postPath ||
      receipt.automaticRetryAttempted !== false
    ) {
      throw new TypeError("Duplicate completion receipt is not exact.");
    }
    const completionOutcome = duplicateCompletionOutcome({
      successful: input.successful,
      providerResponseSuccessful:
        receipt.providerResponseSuccessful === true,
      providerOutcome: receipt.outcome,
    });
    const rawProviderResponseId = input.providerResponse?.id;
    const providerResponseId =
      typeof rawProviderResponseId === "string" &&
      rawProviderResponseId.trim().length > 0
        ? rawProviderResponseId.trim()
        : null;
    if (
      completionOutcome ===
        "provider_response_succeeded_verification_failed" &&
      input.resultingAdId !== providerResponseId
    ) {
      throw new TypeError(
        "Unverified duplicate completion must bind the exact provider response id, or carry no resulting id.",
      );
    }
    const verificationObservedAt =
      input.verificationObservedAt === null
        ? null
        : iso(input.verificationObservedAt);
    if (
      (input.successful && verificationObservedAt === null) ||
      (!input.successful && verificationObservedAt !== null)
    ) {
      throw new TypeError(
        "Only a verified duplicate success may carry a verification observation timestamp.",
      );
    }
    const evidence = {
      contractVersion: META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION,
      eventKind: "attempt_completed",
      sourceActionLogId: prepared.sourceActionLogId,
      attemptId: prepared.attemptId,
      postPath: prepared.postPath,
      preparedAt: prepared.preparedAt,
      leaseDeadline: prepared.leaseDeadline,
      startedAt,
      completionOutcome,
      mutationReceipt: receipt,
      resultingAdId: input.resultingAdId,
      providerResponse: input.providerResponse,
      verification: input.verification,
      verificationObservedAt,
      target: targetEvidence(prepared.target),
    };
    const providerResponseJson = JSON.stringify(input.providerResponse);
    const verificationJson = JSON.stringify(input.verification);
    const transportErrorJson = JSON.stringify(receipt.transportError);
    const evidenceJson = JSON.stringify(evidence);
    const exactCompletionParams = [
      prepared.sourceActionLogId,
      prepared.attemptId,
      startedAt,
      receipt.attemptedAt,
      receipt.completedAt,
      completionOutcome,
      receipt.providerResponseReceived,
      receipt.providerResponseSuccessful,
      receipt.httpStatus,
      receipt.outcome,
      input.resultingAdId,
      providerResponseJson,
      verificationJson,
      transportErrorJson,
      verificationObservedAt,
      evidenceJson,
    ];
    const readExactCompletion = () =>
      sql.query<{ id: string }>(
        `SELECT id::text
         FROM meta_ads_duplicate_action_attempt_events
         WHERE source_action_log_id = $1::uuid
           AND event_kind = 'attempt_completed'
           AND attempt_id = $2::uuid
           AND started_at = $3::timestamptz
           AND attempted_at = $4::timestamptz
           AND completed_at = $5::timestamptz
           AND completion_outcome = $6
           AND provider_response_received = $7::boolean
           AND provider_response_successful = $8::boolean
           AND http_status IS NOT DISTINCT FROM $9::integer
           AND provider_outcome = $10
           AND resulting_ad_id IS NOT DISTINCT FROM $11
           AND provider_response_json IS NOT DISTINCT FROM $12::jsonb
           AND verification_json IS NOT DISTINCT FROM $13::jsonb
           AND transport_error_json IS NOT DISTINCT FROM $14::jsonb
           AND verification_observed_at IS NOT DISTINCT FROM $15::timestamptz
           AND evidence_json = $16::jsonb
           AND evidence_hash =
             encode(digest($16::jsonb::text, 'sha256'), 'hex')
         FOR KEY SHARE`,
        exactCompletionParams,
      );
    const existingCompletion = await sql.query<{ id: string }>(
      `SELECT id::text
       FROM meta_ads_duplicate_action_attempt_events
       WHERE source_action_log_id = $1::uuid
         AND event_kind = 'attempt_completed'
       FOR KEY SHARE`,
      [prepared.sourceActionLogId],
    );
    if (existingCompletion[0]) {
      const exactExisting = await readExactCompletion();
      if (!exactExisting[0]) {
        throw new Error(
          "Duplicate completion conflicts with immutable attempt authority.",
        );
      }
    } else {
      const completedRows = await sql.query<{ id: string }>(
      `INSERT INTO meta_ads_duplicate_action_attempt_events (
         source_action_log_id, business_id, provider_account_ref_id,
         provider_account_id, source_ad_id, source_creative_id,
         target_adset_id, marker, canonical_ad_name, requested_status,
         attempt_id, event_kind, post_path, prepared_at, lease_deadline,
         started_at, attempted_at, completed_at, completion_outcome,
         provider_response_received, provider_response_successful,
         http_status, provider_outcome, resulting_ad_id,
         provider_response_json, verification_json, transport_error_json,
         verification_observed_at, evidence_json, evidence_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4, $5, $6, $7, $8::uuid, $9,
         'PAUSED', $10::uuid, 'attempt_completed', $11,
         $12::timestamptz, $13::timestamptz, $14::timestamptz,
         $15::timestamptz, $16::timestamptz, $17,
         $18::boolean, $19::boolean, $20::integer, $21, $22,
         $23::jsonb, $24::jsonb, $25::jsonb, $26::timestamptz,
         $27::jsonb, encode(digest($27::jsonb::text, 'sha256'), 'hex')
       )
       ON CONFLICT (source_action_log_id, event_kind) DO NOTHING
       RETURNING id::text`,
      [
        prepared.sourceActionLogId,
        prepared.target.businessId,
        prepared.target.providerAccountRefId,
        prepared.target.providerAccountId,
        prepared.target.sourceAdId,
        prepared.target.sourceCreativeId,
        prepared.target.targetAdsetId,
        prepared.target.marker,
        prepared.target.canonicalAdName,
        prepared.attemptId,
        prepared.postPath,
        prepared.preparedAt,
        prepared.leaseDeadline,
        startedAt,
        receipt.attemptedAt,
        receipt.completedAt,
        completionOutcome,
        receipt.providerResponseReceived,
        receipt.providerResponseSuccessful === true,
        receipt.httpStatus,
        receipt.outcome,
        input.resultingAdId,
        providerResponseJson,
        verificationJson,
        transportErrorJson,
        verificationObservedAt,
        evidenceJson,
      ],
      );
      if (!completedRows[0]) {
        const exactExisting = await readExactCompletion();
        if (!exactExisting[0]) {
          throw new Error(
            "Duplicate completion conflicts with immutable attempt authority.",
          );
        }
      }
    }
    const status = input.successful
      ? "success"
      : completionOutcome === "provider_definite_failure"
        ? "failure"
        : "silent_failure";
    const terminalErrorCode = input.successful
      ? null
      : exactText(input.errorCode ?? "", "errorCode");
    const terminalErrorMessage = input.successful
      ? null
      : exactText(input.errorMessage ?? "", "errorMessage");
    const updated = await sql.query<{ id: string }>(
      `UPDATE meta_ads_action_log
       SET status = $2,
           payload_response = $3::jsonb,
           error_code = $4,
           error_message = $5,
           resulting_ad_id = $6,
           duration_ms = $7::integer,
           verified_at = CASE
             WHEN $2 = 'success' THEN $8::timestamptz
             ELSE NULL
           END,
           verification_payload = $9::jsonb,
           terminal_finalized_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1::uuid
         AND action = 'duplicate'
         AND source = 'manual_operator_v1'
         AND status = 'pending'
       RETURNING id::text`,
      [
        prepared.sourceActionLogId,
        status,
        providerResponseJson,
        terminalErrorCode,
        terminalErrorMessage,
        input.resultingAdId,
        input.durationMs,
        verificationObservedAt,
        verificationJson,
      ],
    );
    if (!updated[0]) {
      const exactExisting = await sql.query<{ id: string }>(
        `SELECT id::text
         FROM meta_ads_action_log
         WHERE id = $1::uuid
           AND status = $2
           AND payload_response IS NOT DISTINCT FROM $3::jsonb
           AND error_code IS NOT DISTINCT FROM $4
           AND error_message IS NOT DISTINCT FROM $5
           AND resulting_ad_id IS NOT DISTINCT FROM $6
           AND duration_ms IS NOT DISTINCT FROM $7::integer
           AND verified_at IS NOT DISTINCT FROM
             CASE WHEN $2 = 'success' THEN $8::timestamptz ELSE NULL END
           AND verification_payload IS NOT DISTINCT FROM $9::jsonb
           AND terminal_finalized_at IS NOT NULL`,
        [
          prepared.sourceActionLogId,
          status,
          providerResponseJson,
          terminalErrorCode,
          terminalErrorMessage,
          input.resultingAdId,
          input.durationMs,
          verificationObservedAt,
          verificationJson,
        ],
      );
      if (!exactExisting[0]) {
        throw new Error("Duplicate terminalization did not commit atomically.");
      }
    }
  });
}

export async function finalizeMetaAdDuplicatePreProviderFailure(input: {
  sourceActionLogId: string;
  errorCode: string;
  errorMessage: string;
  durationMs: number;
}) {
  await runDbTransaction(async () => {
    const sql = getDb();
    const sourceRows = await sql.query<{ status: string }>(
      `SELECT status
       FROM meta_ads_action_log
       WHERE id = $1::uuid
       FOR UPDATE`,
      [input.sourceActionLogId],
    );
    if (!sourceRows[0]) {
      throw new Error("Duplicate pre-provider source is missing.");
    }
    const prepared = await readPreparedAttempt(input.sourceActionLogId);
    const started = await sql.query<{ id: string }>(
      `SELECT id::text
       FROM meta_ads_duplicate_action_attempt_events
       WHERE source_action_log_id = $1::uuid
         AND event_kind = 'attempt_started'`,
      [prepared.sourceActionLogId],
    );
    if (started[0]) {
      throw new Error("Started duplicate cannot be finalized as pre-provider.");
    }
    const errorCode = exactText(input.errorCode, "errorCode");
    const errorMessage = exactText(input.errorMessage, "errorMessage");
    const updated = await sql.query<{ id: string }>(
      `UPDATE meta_ads_action_log
       SET status = 'failure',
           payload_response = jsonb_build_object(
             'duplicate_pre_provider_abort',
             jsonb_build_object(
               'code', $2::text,
               'provider_mutation_attempted', false
             )
           ),
           error_code = $2::text,
           error_message = $3::text,
           duration_ms = $4::integer,
           terminal_finalized_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1::uuid
         AND action = 'duplicate'
         AND source = 'manual_operator_v1'
         AND status = 'pending'
       RETURNING id::text`,
      [
        prepared.sourceActionLogId,
        errorCode,
        errorMessage,
        input.durationMs,
      ],
    );
    if (!updated[0]) {
      const exactExisting = await sql.query<{ id: string }>(
        `SELECT id::text
         FROM meta_ads_action_log
         WHERE id = $1::uuid
           AND status = 'failure'
           AND payload_response = jsonb_build_object(
             'duplicate_pre_provider_abort',
             jsonb_build_object(
               'code', $2::text,
               'provider_mutation_attempted', false
             )
           )
           AND error_code = $2::text
           AND error_message = $3::text
           AND duration_ms = $4::integer
           AND resulting_ad_id IS NULL
           AND verified_at IS NULL
           AND verification_payload IS NULL
           AND terminal_finalized_at IS NOT NULL`,
        [
          prepared.sourceActionLogId,
          errorCode,
          errorMessage,
          input.durationMs,
        ],
      );
      if (!exactExisting[0]) {
        throw new Error("Duplicate pre-provider failure did not terminalize.");
      }
    }
  });
}

function mapCandidate(
  row: DuplicateCandidateDbRow,
): MetaAdDuplicateReconciliationCandidate {
  const settlementNotBefore = iso(row.settlement_not_before);
  let scanContinuation: MetaAdDuplicateReconciliationCandidate["scanContinuation"] =
    null;
  if (
    row.scan_cycle_id &&
    row.scan_segment_index != null &&
    row.scan_after_cursor
  ) {
    const visitedCursorHashes = normalizeHashList(
      Array.isArray(row.scan_visited_cursor_hashes)
        ? row.scan_visited_cursor_hashes.map(String)
        : [],
    );
    const cumulativeExactMatchIds = normalizeExactMatchIds(
      Array.isArray(row.scan_cumulative_exact_match_ids)
        ? row.scan_cumulative_exact_match_ids.map(String)
        : [],
    );
    scanContinuation = {
      cycleId: normalizeMetaAdDuplicateMarker(row.scan_cycle_id),
      segmentIndex: row.scan_segment_index,
      afterCursor: normalizeCheckpointCursor(
        row.scan_after_cursor,
        "scanAfterCursor",
      )!,
      visitedCursorHashes,
      cumulativePageCount: row.scan_cumulative_page_count ?? 0,
      cumulativeObservationCount:
        row.scan_cumulative_observation_count ?? 0,
      cumulativeExactMatchIds,
    };
  }
  return {
    sourceActionLogId: row.source_action_log_id,
    businessId: row.business_id,
    providerAccountRefId: row.provider_account_ref_id,
    providerAccountId: row.provider_account_id,
    sourceAdId: row.source_ad_id,
    sourceCreativeId: row.source_creative_id,
    targetAdsetId: row.target_adset_id,
    marker: row.marker,
    canonicalAdName: row.canonical_ad_name,
    requestedStatus: row.requested_status,
    resultingAdId: row.resulting_ad_id,
    status: row.status,
    attemptId: row.attempt_id,
    authorityKind: row.authority_kind,
    settlementNotBefore,
    readyForProviderRead:
      new Date(row.db_now).getTime() >= new Date(settlementNotBefore).getTime(),
    scanContinuation,
  };
}

export async function listMetaAdDuplicateReconciliationCandidates(
  limit = 3,
) {
  const boundedLimit = Math.max(1, Math.min(10, Math.floor(limit)));
  const rows = await getDb().query<DuplicateCandidateDbRow>(
    READ_DUPLICATE_RECONCILIATION_CANDIDATES_QUERY,
    [boundedLimit],
  );
  return rows.map(mapCandidate);
}

export async function recordMetaAdDuplicateReconciliationObservation(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  observationMethod: MetaAdDuplicateObservationMethod;
  disposition: MetaAdDuplicateObservationDisposition;
  resultingAdId: string | null;
  scanComplete: boolean;
  scannedPageCount: number;
  observationCount: number;
  exactMatchCount: number;
  observedAt: string;
  observationEvidence: Record<string, unknown>;
  scanCheckpoint?: MetaAdDuplicateScanCheckpoint | null;
}) {
  return runDbTransaction(async () => {
    const candidate = input.candidate;
    const sql = getDb();
    const sourceRows = await sql.query<{ id: string }>(
      `SELECT id::text
       FROM meta_ads_action_log
       WHERE id = $1::uuid
         AND status IN ('pending', 'silent_failure')
       FOR UPDATE`,
      [candidate.sourceActionLogId],
    );
    if (!sourceRows[0]) {
      throw new Error("Duplicate observation source is no longer unresolved.");
    }
    const preparedRows = await sql.query<{ id: string }>(
      `SELECT id::text
       FROM meta_ads_duplicate_action_attempt_events
       WHERE source_action_log_id = $1::uuid
         AND event_kind = 'attempt_prepared'
       FOR KEY SHARE`,
      [candidate.sourceActionLogId],
    );
    if (!preparedRows[0]) {
      throw new Error("Duplicate observation preparation is missing.");
    }
    const ordinalRows = await sql.query<{ attempt_ordinal: number }>(
      `SELECT count(*)::integer + 1 AS attempt_ordinal
       FROM meta_ads_duplicate_reconciliation_observations
       WHERE source_action_log_id = $1::uuid`,
      [candidate.sourceActionLogId],
    );
    const attemptOrdinal = ordinalRows[0]?.attempt_ordinal ?? 1;
    const backoffSeconds =
      input.disposition === "scan_segment_progress" ||
      input.disposition === "point_verification_pending"
        ? META_AD_DUPLICATE_SCAN_PROGRESS_DELAY_SECONDS
        : Math.min(
            META_AD_DUPLICATE_OBSERVATION_BACKOFF_CAP_SECONDS,
            META_AD_DUPLICATE_OBSERVATION_BACKOFF_BASE_SECONDS *
              2 ** Math.min(attemptOrdinal - 1, 8),
          );
    const clockRows = await sql.query<{ captured_at: string | Date }>(
      "SELECT clock_timestamp() AS captured_at",
    );
    const capturedAt = iso(clockRows[0]!.captured_at);
    const observedAt = iso(input.observedAt);
    const nextAttemptNotBefore = new Date(
      new Date(capturedAt).getTime() + backoffSeconds * 1_000,
    ).toISOString();
    const target = {
      businessId: candidate.businessId,
      providerAccountRefId: candidate.providerAccountRefId,
      providerAccountId: candidate.providerAccountId,
      sourceAdId: candidate.sourceAdId,
      sourceCreativeId: candidate.sourceCreativeId,
      targetAdsetId: candidate.targetAdsetId,
      marker: candidate.marker,
      canonicalAdName: candidate.canonicalAdName,
      requestedStatus: candidate.requestedStatus,
    };
    let scanCheckpoint: MetaAdDuplicateScanCheckpoint | null = null;
    if (input.observationMethod === "account_ads_scan") {
      if (!input.scanCheckpoint) {
        throw new TypeError("Account scan observation needs a checkpoint.");
      }
      const segmentStartAfterCursor = normalizeCheckpointCursor(
        input.scanCheckpoint.segmentStartAfterCursor,
        "segmentStartAfterCursor",
      );
      const segmentEndAfterCursor = normalizeCheckpointCursor(
        input.scanCheckpoint.segmentEndAfterCursor,
        "segmentEndAfterCursor",
      );
      const visitedCursorHashes = normalizeHashList(
        input.scanCheckpoint.visitedCursorHashes,
      );
      const cumulativeExactMatchIds = normalizeExactMatchIds(
        input.scanCheckpoint.cumulativeExactMatchIds,
      );
      if (
        !Number.isInteger(input.scanCheckpoint.segmentIndex) ||
        input.scanCheckpoint.segmentIndex < 0 ||
        !Number.isInteger(input.scanCheckpoint.cumulativePageCount) ||
        input.scanCheckpoint.cumulativePageCount !== input.scannedPageCount ||
        !Number.isInteger(input.scanCheckpoint.cumulativeObservationCount) ||
        input.scanCheckpoint.cumulativeObservationCount !==
          input.observationCount ||
        cumulativeExactMatchIds.length !== input.exactMatchCount ||
        input.scanCheckpoint.segmentStartCursorHash !==
          checkpointCursorHash(segmentStartAfterCursor) ||
        input.scanCheckpoint.segmentEndCursorHash !==
          checkpointCursorHash(segmentEndAfterCursor) ||
        input.scanCheckpoint.cycleComplete !== input.scanComplete ||
        (input.scanCheckpoint.cycleComplete &&
          segmentEndAfterCursor !== null)
      ) {
        throw new TypeError("Duplicate scan checkpoint geometry is invalid.");
      }
      scanCheckpoint = {
        cycleId: normalizeMetaAdDuplicateMarker(
          input.scanCheckpoint.cycleId,
        ),
        segmentIndex: input.scanCheckpoint.segmentIndex,
        segmentStartAfterCursor,
        segmentEndAfterCursor,
        segmentStartCursorHash: checkpointCursorHash(
          segmentStartAfterCursor,
        ),
        segmentEndCursorHash: checkpointCursorHash(
          segmentEndAfterCursor,
        ),
        cycleComplete: input.scanCheckpoint.cycleComplete,
        visitedCursorHashes,
        cumulativePageCount: input.scanCheckpoint.cumulativePageCount,
        cumulativeObservationCount:
          input.scanCheckpoint.cumulativeObservationCount,
        cumulativeExactMatchIds,
      };
    } else if (input.scanCheckpoint) {
      throw new TypeError("Non-scan observation cannot carry a checkpoint.");
    }
    const observationEvidence = scanCheckpoint
      ? {
          ...input.observationEvidence,
          scanCheckpoint,
        }
      : input.observationEvidence;
    const evidence = {
      contractVersion: META_AD_DUPLICATE_OBSERVATION_CONTRACT_VERSION,
      sourceActionLogId: candidate.sourceActionLogId,
      attemptId: candidate.attemptId,
      attemptOrdinal,
      observationMethod: input.observationMethod,
      disposition: input.disposition,
      resultingAdId: input.resultingAdId,
      scanComplete: input.scanComplete,
      scannedPageCount: input.scannedPageCount,
      observationCount: input.observationCount,
      exactMatchCount: input.exactMatchCount,
      observedAt,
      capturedAt,
      backoffSeconds,
      nextAttemptNotBefore,
      target,
      observationEvidence,
    };
    const rows = await sql.query<{
      id: string;
      attempt_ordinal: number;
      next_attempt_not_before: string | Date;
    }>(
      `INSERT INTO meta_ads_duplicate_reconciliation_observations (
         source_action_log_id, source_attempt_id, source_prepared_event_id,
         business_id, provider_account_ref_id, provider_account_id,
         source_ad_id, source_creative_id, target_adset_id, marker,
         canonical_ad_name, requested_status, attempt_ordinal,
         observation_method, disposition, resulting_ad_id, scan_complete,
         scanned_page_count, observation_count, exact_match_count,
         scan_cycle_id, scan_segment_index,
         segment_start_after_cursor, segment_start_cursor_hash,
         segment_end_after_cursor, segment_end_cursor_hash,
         scan_cycle_complete, observed_at, captured_at, backoff_seconds,
         next_attempt_not_before, evidence_json, evidence_hash
       ) VALUES (
         $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8,
         $9, $10::uuid, $11, 'PAUSED', $12::integer, $13, $14, $15,
         $16::boolean, $17::integer, $18::integer, $19::integer,
         $20::uuid, $21::integer, $22, $23, $24, $25, $26::boolean,
         $27::timestamptz, $28::timestamptz, $29::integer,
         $30::timestamptz, $31::jsonb,
         encode(digest($31::jsonb::text, 'sha256'), 'hex')
       )
       RETURNING
         id::text, attempt_ordinal, next_attempt_not_before`,
      [
        candidate.sourceActionLogId,
        candidate.attemptId,
        preparedRows[0].id,
        candidate.businessId,
        candidate.providerAccountRefId,
        candidate.providerAccountId,
        candidate.sourceAdId,
        candidate.sourceCreativeId,
        candidate.targetAdsetId,
        candidate.marker,
        candidate.canonicalAdName,
        attemptOrdinal,
        input.observationMethod,
        input.disposition,
        input.resultingAdId,
        input.scanComplete,
        input.scannedPageCount,
        input.observationCount,
        input.exactMatchCount,
        scanCheckpoint?.cycleId ?? null,
        scanCheckpoint?.segmentIndex ?? null,
        scanCheckpoint?.segmentStartAfterCursor ?? null,
        scanCheckpoint?.segmentStartCursorHash ?? null,
        scanCheckpoint?.segmentEndAfterCursor ?? null,
        scanCheckpoint?.segmentEndCursorHash ?? null,
        scanCheckpoint?.cycleComplete ?? null,
        observedAt,
        capturedAt,
        backoffSeconds,
        nextAttemptNotBefore,
        JSON.stringify(evidence),
      ],
    );
    if (!rows[0]) {
      throw new Error("Duplicate reconciliation observation did not persist.");
    }
    return {
      id: rows[0].id,
      attemptOrdinal: rows[0].attempt_ordinal,
      nextAttemptNotBefore: iso(rows[0].next_attempt_not_before),
    };
  });
}

export async function reconcileMetaAdDuplicateAttempt(input: {
  candidate: MetaAdDuplicateReconciliationCandidate;
  resolution: MetaAdDuplicateReconciliationResolution;
  resultingAdId: string | null;
  scanComplete: boolean;
  scannedPageCount: number;
  observationCount: number;
  exactMatchCount: number;
  observedAt: string;
  providerAd: Record<string, unknown> | null;
  scanEvidence: Record<string, unknown>;
}) {
  await runDbTransaction(async () => {
    const candidate = input.candidate;
    if (!candidate.readyForProviderRead) {
      throw new Error("Duplicate reconciliation settlement has not elapsed.");
    }
    const sql = getDb();
    const sourceRows = await sql.query<{ status: string }>(
      `SELECT status
       FROM meta_ads_action_log
       WHERE id = $1::uuid
       FOR UPDATE`,
      [candidate.sourceActionLogId],
    );
    if (!sourceRows[0]) {
      throw new Error("Duplicate reconciliation source is missing.");
    }
    const prepared = await sql.query<{ id: string }>(
      `SELECT id::text
       FROM meta_ads_duplicate_action_attempt_events
       WHERE source_action_log_id = $1::uuid
         AND event_kind = 'attempt_prepared'
       FOR KEY SHARE`,
      [candidate.sourceActionLogId],
    );
    if (!prepared[0]) {
      throw new Error("Duplicate reconciliation preparation is missing.");
    }
    const exactExistingRows = await sql.query<{
      id: string;
      observed_at: string | Date;
      evidence_json: Record<string, unknown>;
    }>(
      `SELECT id::text, observed_at, evidence_json
       FROM meta_ads_duplicate_action_reconciliation_events
       WHERE source_action_log_id = $1::uuid
         AND source_attempt_id = $2::uuid
         AND source_prepared_event_id = $3::uuid
         AND business_id = $4::uuid
         AND provider_account_ref_id = $5::uuid
         AND provider_account_id = $6
         AND source_ad_id = $7
         AND source_creative_id = $8
         AND target_adset_id = $9
         AND marker = $10::uuid
         AND canonical_ad_name = $11
         AND requested_status = 'PAUSED'
         AND authority_kind = $12
         AND settlement_not_before = $13::timestamptz
         AND resolution = 'exact_provider_match'
         AND resulting_ad_id = $14
         AND scan_complete = $15::boolean
         AND scanned_page_count = $16::integer
         AND observation_count = $17::integer
         AND exact_match_count = $18::integer
         AND observed_at = $19::timestamptz
         AND evidence_json->'providerAd' = $20::jsonb
         AND evidence_json->'scanEvidence' = $21::jsonb
         AND evidence_hash =
           encode(digest(evidence_json::text, 'sha256'), 'hex')
       FOR KEY SHARE`,
      [
        candidate.sourceActionLogId,
        candidate.attemptId,
        prepared[0].id,
        candidate.businessId,
        candidate.providerAccountRefId,
        candidate.providerAccountId,
        candidate.sourceAdId,
        candidate.sourceCreativeId,
        candidate.targetAdsetId,
        candidate.marker,
        candidate.canonicalAdName,
        candidate.authorityKind,
        candidate.settlementNotBefore,
        input.resultingAdId,
        input.scanComplete,
        input.scannedPageCount,
        input.observationCount,
        input.exactMatchCount,
        input.observedAt,
        JSON.stringify(input.providerAd),
        JSON.stringify(input.scanEvidence),
      ],
    );
    const anyExistingRows = await sql.query<{ id: string }>(
      `SELECT id::text
       FROM meta_ads_duplicate_action_reconciliation_events
       WHERE source_action_log_id = $1::uuid
       FOR KEY SHARE`,
      [candidate.sourceActionLogId],
    );
    if (anyExistingRows[0] && !exactExistingRows[0]) {
      throw new Error(
        "Duplicate reconciliation conflicts with immutable provider authority.",
      );
    }
    const clock = await sql.query<{ captured_at: string | Date }>(
      "SELECT clock_timestamp() AS captured_at",
    );
    let evidence = exactExistingRows[0]?.evidence_json;
    if (!evidence) {
      const capturedAt = iso(clock[0]!.captured_at);
      evidence = {
        contractVersion: META_AD_DUPLICATE_RECONCILIATION_CONTRACT_VERSION,
        sourceActionLogId: candidate.sourceActionLogId,
        attemptId: candidate.attemptId,
        resolution: input.resolution,
        authorityKind: candidate.authorityKind,
        settlementNotBefore: candidate.settlementNotBefore,
        target: {
          businessId: candidate.businessId,
          providerAccountRefId: candidate.providerAccountRefId,
          providerAccountId: candidate.providerAccountId,
          sourceAdId: candidate.sourceAdId,
          sourceCreativeId: candidate.sourceCreativeId,
          targetAdsetId: candidate.targetAdsetId,
          marker: candidate.marker,
          canonicalAdName: candidate.canonicalAdName,
          requestedStatus: candidate.requestedStatus,
        },
        scanComplete: input.scanComplete,
        scannedPageCount: input.scannedPageCount,
        observationCount: input.observationCount,
        exactMatchCount: input.exactMatchCount,
        observedAt: input.observedAt,
        capturedAt,
        providerAd: input.providerAd,
        scanEvidence: input.scanEvidence,
      };
      const inserted = await sql.query<{ id: string }>(
        `INSERT INTO meta_ads_duplicate_action_reconciliation_events (
           source_action_log_id, source_attempt_id, source_prepared_event_id,
           business_id, provider_account_ref_id, provider_account_id,
           source_ad_id, source_creative_id, target_adset_id, marker,
           canonical_ad_name, requested_status, authority_kind,
           settlement_not_before, resolution, resulting_ad_id,
           scan_complete, scanned_page_count, observation_count,
           exact_match_count,
           observed_at, captured_at, evidence_json, evidence_hash
         ) VALUES (
           $1::uuid, $2::uuid, $3::uuid, $4::uuid, $5::uuid, $6, $7, $8,
           $9, $10::uuid, $11, 'PAUSED', $12, $13::timestamptz, $14, $15,
           $16::boolean, $17::integer, $18::integer, $19::integer,
           $20::timestamptz, $21::timestamptz, $22::jsonb,
           encode(digest($22::jsonb::text, 'sha256'), 'hex')
         )
         RETURNING id::text`,
        [
          candidate.sourceActionLogId,
          candidate.attemptId,
          prepared[0].id,
          candidate.businessId,
          candidate.providerAccountRefId,
          candidate.providerAccountId,
          candidate.sourceAdId,
          candidate.sourceCreativeId,
          candidate.targetAdsetId,
          candidate.marker,
          candidate.canonicalAdName,
          candidate.authorityKind,
          candidate.settlementNotBefore,
          input.resolution,
          input.resultingAdId,
          input.scanComplete,
          input.scannedPageCount,
          input.observationCount,
          input.exactMatchCount,
          input.observedAt,
          capturedAt,
          JSON.stringify(evidence),
        ],
      );
      if (!inserted[0]) {
        throw new Error("Duplicate reconciliation authority did not persist.");
      }
    }
    const updated = await sql.query<{ id: string }>(
      `UPDATE meta_ads_action_log
       SET status = 'success',
           payload_response = jsonb_build_object(
             'duplicate_reconciliation',
             $2::jsonb
           ),
           error_code = NULL,
           error_message = NULL,
           resulting_ad_id = $3,
           verified_at = $4::timestamptz,
           verification_payload = $2::jsonb,
           terminal_finalized_at = clock_timestamp(),
           updated_at = clock_timestamp()
       WHERE id = $1::uuid
         AND action = 'duplicate'
         AND source = 'manual_operator_v1'
         AND status IN ('pending', 'silent_failure')
       RETURNING id::text`,
      [
        candidate.sourceActionLogId,
        JSON.stringify(evidence),
        input.resultingAdId,
        input.observedAt,
      ],
    );
    if (!updated[0]) {
      const exactTerminal = await sql.query<{ id: string }>(
        `SELECT id::text
         FROM meta_ads_action_log
         WHERE id = $1::uuid
           AND status = 'success'
           AND payload_response = jsonb_build_object(
             'duplicate_reconciliation',
             $2::jsonb
           )
           AND error_code IS NULL
           AND error_message IS NULL
           AND resulting_ad_id = $3
           AND verified_at = $4::timestamptz
           AND verification_payload = $2::jsonb
           AND terminal_finalized_at IS NOT NULL`,
        [
          candidate.sourceActionLogId,
          JSON.stringify(evidence),
          input.resultingAdId,
          input.observedAt,
        ],
      );
      if (!exactTerminal[0]) {
        throw new Error(
          "Duplicate reconciliation event and terminal fact did not commit atomically.",
        );
      }
    }
  });
}
