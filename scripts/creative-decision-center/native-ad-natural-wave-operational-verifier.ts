import { createHash } from "node:crypto";
import { writeFile } from "node:fs/promises";
import { basename, dirname, resolve } from "node:path";
import { pathToFileURL } from "node:url";

import { Client, type QueryResultRow } from "pg";

import {
  NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
  NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION,
  buildAdRecommendationEpisode,
  type AdOperatorResponseDiagnosticCode,
  type AdOperatorResponseObservationStatus,
  type AdOperatorResponseType,
} from "@/lib/creative-decision-engine/ad-operator-response-detection";
import {
  AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
  hashAdDecisionIdentityManifest,
} from "@/lib/creative-decision-engine/data-source";
import {
  canonicalSha256,
  stableCanonicalJson,
  type CanonicalJsonObject,
} from "@/lib/creative-decision-engine/canonical-evaluation";
import {
  AD_DECISION_EVALUATION_CONTRACT_VERSION,
} from "@/lib/creative-decision-engine/evaluation-store";
import {
  AD_CALIBRATION_JOB_NAME,
  NATIVE_AD_CALIBRATION_POLICY_VERSION,
  computeNativeAdCalibrationCellSetHash,
  type NativeAdCalibrationCellKey,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { AD_DECISIONS_JOB_NAME } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { AD_OPERATOR_RESPONSE_JOB_NAME } from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

export const LIVE_TUNNEL_HOST = "127.0.0.1";
export const LIVE_TUNNEL_PORT = "15432";
export const READ_ONLY_BEGIN_SQL =
  "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY";
export const READ_ONLY_TIMEOUT_SQL =
  "SET LOCAL statement_timeout = '30s'";
export const READ_ONLY_ROLLBACK_SQL = "ROLLBACK";
export const NATIVE_AD_NATURAL_WAVE_UTC_HOUR = 3;
export const NATIVE_AD_SCHEDULER_MANIFEST_LIMIT = 500;

const OPERATOR_RESPONSE_DIAGNOSTIC_CODES: Record<
  AdOperatorResponseDiagnosticCode,
  true
> = {
  ignored_action_lineage_mismatch: true,
  ignored_action_outside_episode_window: true,
  receipt_integrity_mismatch: true,
  dry_run_action_log: true,
  failed_action_log: true,
  unverified_action_log: true,
  action_state_observation_missing: true,
  action_state_observation_conflict: true,
  budget_owner_not_proven_by_source_decision: true,
  budget_change_not_observed: true,
  budget_change_direction_conflict: true,
  unlogged_ad_status_change: true,
  unlogged_hierarchy_change: true,
  zero_spend_without_positive_baseline: true,
  natural_spend_cessation_is_not_treatment: true,
  budget_owner_action_is_context_only: true,
  multiple_verified_responses: true,
  attribution_window_open: true,
  source_read_incomplete: true,
  state_coverage_incomplete: true,
  explicit_tombstone_without_typed_receipt: true,
  complete_window_no_typed_response: true,
};

const OPERATOR_RESPONSE_AUTHORITY_CONTRADICTION_CODES = new Set<
  AdOperatorResponseDiagnosticCode
>([
  "ignored_action_lineage_mismatch",
  "receipt_integrity_mismatch",
  "action_state_observation_conflict",
  "budget_owner_not_proven_by_source_decision",
  "budget_change_direction_conflict",
  "unlogged_ad_status_change",
  "unlogged_hierarchy_change",
  "multiple_verified_responses",
  "explicit_tombstone_without_typed_receipt",
]);

const OPERATOR_RESPONSE_OBSERVATION_BY_TYPE: Record<
  AdOperatorResponseType,
  AdOperatorResponseObservationStatus
> = {
  verified_pause: "observed_response",
  verified_resume: "observed_response",
  duplicate_successor: "observed_response",
  rebuild_successor: "observed_response",
  budget_owner_action_context: "observed_response",
  natural_spend_cessation: "observed_no_response",
  no_response_observed: "observed_no_response",
  unknown_incomplete: "unknown_incomplete",
  ambiguous_conflicting: "unknown_incomplete",
};

export const NATIVE_AD_OPERATIONAL_JOB_NAMES = [
  AD_CALIBRATION_JOB_NAME,
  AD_DECISIONS_JOB_NAME,
  AD_OPERATOR_RESPONSE_JOB_NAME,
] as const;

type NativeJobName = (typeof NATIVE_AD_OPERATIONAL_JOB_NAMES)[number];
type JsonObject = Record<string, unknown>;

export interface VerifierArgs {
  asOf: string;
  deployAnchor: string;
  expectedBusinessCount: number;
  expectedProviderAccountCount: number;
  expectedUnbound: string[];
  envDefaultEnabled: boolean;
  outputPath: string;
}

export interface SchedulerManifestFact {
  businessId: string;
  businessName: string;
  createdAt: string;
  providerAccountRefId: string | null;
  providerAccountId: string | null;
}

export interface JobRunFact {
  id: string;
  jobName: string;
  businessRefId: string;
  businessId: string | null;
  asOf: string;
  engineVersion: string;
  status: string;
  dependencyRunId: string | null;
  startedAt: string;
  finishedAt: string | null;
  rowCount: number | null;
  errorCode: string | null;
  errorMessage: string | null;
  errorJson: unknown;
}

interface NativeLineageBase {
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  asOf: string;
  engineVersion: string;
  scopeType: string;
  scopeId: string;
  contractVersion?: string;
  jobRunId: string;
}

export interface DecisionContextFact extends NativeLineageBase {
  id: string;
  contractVersion: string;
  contextJson: unknown;
  accountProfileJson: unknown;
  dataHealthJson: unknown;
  flagsJson: unknown;
  contextHash: string;
}

export interface DecisionEvaluationFact extends NativeLineageBase {
  id: string;
  contextId: string;
  decisionEntityType: string;
  decisionEntityId: string;
  adId: string;
  creativeId: string | null;
  creativeInputJson: unknown;
  campaignContextJson: unknown;
  priorHysteresisJson: unknown;
  decisionOutputJson: unknown;
  rawLabel: string;
  hysteresisSuppressed: boolean;
  inputHash: string;
  decisionHash: string;
  contractVersion: string;
}

export interface DecisionSnapshotFact extends NativeLineageBase {
  id: string;
  evaluationId: string;
  decisionEntityType: string;
  decisionEntityId: string;
  adId: string;
  creativeId: string | null;
  inputHash: string;
  decisionHash: string;
  label: string;
  rawLabel: string;
  preAuthorityLabel: string | null;
  authorityBlocker: string | null;
  confidence: number;
  truthSource: string;
  effectiveTargetRoas: number;
  ratioToTarget: number | null;
  badges: unknown;
  reason: string;
  spend: number | null;
  purchases: number | null;
  roas: number | null;
  recent7dRoas: number | null;
  labelTransform: string | null;
  blockedActionType: string | null;
  authorizedAction: string | null;
  calibrationRowId: string | null;
}

export interface SourceRunFact {
  id: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  entityType: string;
  completeness: string;
  observedAt: string;
  capturedAt: string;
  runHash: string | null;
  payloadHash: string | null;
  expectedRowCount: number | null;
  persistedRowCount: number;
}

export interface SourceManifestFact {
  jobRunId: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceRunId: string | null;
  sourceObservedAt: string | null;
  sourceCapturedAt: string | null;
  sourceRunHash: string | null;
  sourcePayloadHash: string | null;
  sourceExpectedRowCount: number | null;
  sourcePersistedRowCount: number | null;
  expectedAdIds: string[];
  identityShapeValid: boolean;
}

export interface CalibrationCellFact {
  id: string;
  batchId: string;
  jobRunId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  cellScope: string;
  objective: string;
  funnelCohort: string;
  optimizationContext: string;
  batchInputManifestHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
}

export interface CalibrationBatchFact {
  id: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  asOf: string;
  asOfCutoff: string;
  transactionIsolation: string;
  engineVersion: string;
  policyVersion: string;
  sourceMode: string;
  sourceProvenance: unknown;
  expectedCellCount: number;
  generationContentHash: string;
  inputManifestHash: string;
  sourceManifestHash: string;
  cellSetHash: string;
  completenessStatus: string;
  jobRunId: string;
  computedAt: string;
  completedAt: string | null;
  cells: CalibrationCellFact[];
}

export interface OperatorResponseProofFact {
  jobRunId: string;
  responseCount: number;
  lineageContradictionCount: number;
  episodes: OperatorEpisodeFact[];
  events: OperatorEventFact[];
  responses: OperatorResponseFact[];
}

export interface OperatorEpisodeFact {
  episodeKey: string;
  contractVersion: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  decisionEntityType: string;
  decisionEntityId: string;
  adId: string;
  creativeId: string | null;
  asOf: string;
  engineVersion: string;
  scopeType: string;
  scopeId: string;
  decisionSnapshotId: string;
  evaluationId: string;
  inputHash: string;
  decisionHash: string;
  decisionLabel: string;
  sourceCampaignId: string | null;
  sourceAdsetId: string | null;
  parentSnapshotCreativeId: string | null;
  parentSnapshotLabel: string | null;
  parentEvaluationCreativeId: string | null;
  parentInputCampaignId: string | null;
  parentInputAdsetId: string | null;
  parentContextCampaignId: string | null;
  recommendedAt: string;
  jobRunId: string;
  lineageValid: boolean;
}

export interface OperatorEventFact {
  jobRunId: string;
  episodeKey: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  responseCutoff: string;
  contractVersion: string;
  evidenceKind: string;
  evidenceSourceId: string;
  actionReceiptId: string | null;
  stateHistoryId: string | null;
  tombstoneId: string | null;
  evidenceObservedAt: string;
  evidenceCapturedAt: string;
  treatmentEligible: boolean;
  diagnosticCode: string | null;
  evidenceJson: unknown;
  evidenceHash: string;
}

export interface OperatorResponseFact {
  jobRunId: string;
  episodeKey: string;
  businessRefId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  contractVersion: string;
  responseCutoff: string;
  observationStatus: string;
  responseType: string;
  operatorResponseDetected: boolean;
  adTreatmentDetected: boolean;
  detectedAt: string | null;
  actionReceiptId: string | null;
  actionLogId: string | null;
  successorAdId: string | null;
  successorKind: string | null;
  budgetOwnerType: string | null;
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
  diagnosticsJson: unknown;
  evidenceHashesJson: unknown;
  evidenceCount: number;
  evidenceSetHash: string;
  replacementSetHash: string;
  responseHash: string;
}

export interface ReadOnlySessionProof {
  observedAt: string;
  transactionReadOnly: string;
  defaultTransactionReadOnly: string;
  transactionIsolation: string;
  statementTimeout: string;
  applicationName: string;
}

export interface OperationalFacts {
  readOnlySession: ReadOnlySessionProof;
  envEnabledDefault: boolean;
  manifest: SchedulerManifestFact[];
  jobs: JobRunFact[];
  contexts: DecisionContextFact[];
  evaluations: DecisionEvaluationFact[];
  snapshots: DecisionSnapshotFact[];
  sourceManifests: SourceManifestFact[];
  sourceRuns: SourceRunFact[];
  calibrationBatches: CalibrationBatchFact[];
  operatorResponses: OperatorResponseProofFact[];
}

interface JobSummary {
  id: string | null;
  status: string | null;
  startedAt: string | null;
  finishedAt: string | null;
  rowCount: number | null;
}

interface BusinessVerification {
  businessId: string;
  businessName: string;
  bindings: Array<{
    providerAccountRefId: string;
    providerAccountId: string;
  }>;
  jobs: Record<NativeJobName, JobSummary>;
  decisionProof: {
    snapshots: number;
    evaluations: number;
    contexts: number;
    distinctReferencedContexts: number;
    hydrationReceipts: number;
    expectedAds: number;
    hydratedAds: number;
    receiptManifests: Array<{
      providerAccountRefId: string;
      providerAccountId: string;
      expectedCount: number | null;
      hydratedCount: number | null;
      recomputedExpectedHash: string | null;
      recomputedHydratedHash: string | null;
    }>;
  } | null;
  calibrationProof: {
    batches: number;
    cells: number;
    rowsWritten: number | null;
  } | null;
  operatorProof: {
    episodesCaptured: number;
    episodesEvaluated: number;
    evidenceEvents: number;
    responses: number;
  } | null;
  blockers: string[];
}

export interface OperationalVerificationReport {
  schemaVersion: "native-ad-natural-wave-operational-verification.v1";
  result: "pass" | "fail";
  parameters: {
    asOf: string;
    deployAnchor: string;
    waveStart: string;
    engineVersion: typeof NATIVE_AD_ENGINE_VERSION;
    expectedBusinessCount: number;
    expectedProviderAccountCount: number;
    expectedUnbound: string[];
    envDefaultEnabled: boolean;
  };
  session: ReadOnlySessionProof;
  schedulerManifest: {
    limit: typeof NATIVE_AD_SCHEDULER_MANIFEST_LIMIT;
    envEnabledDefault: boolean;
    businessCount: number;
    boundBusinessCount: number;
    boundAccountCount: number;
    unboundBusinesses: Array<{ businessId: string; businessName: string }>;
  };
  businesses: BusinessVerification[];
  proofInventory: {
    schedulerManifestHash: string;
    jobRowsLoaded: number;
    contexts: number;
    evaluations: number;
    snapshots: number;
    sourceManifests: number;
    sourceRuns: number;
    calibrationBatches: number;
    calibrationCells: number;
    operatorEpisodes: number;
    operatorEvents: number;
    operatorResponses: number;
  };
  failureInventory: {
    count: number;
    codes: Array<{ code: string; count: number }>;
  };
  blockers: string[];
}

const SCHEDULER_MANIFEST_SQL = `
WITH active_businesses AS MATERIALIZED (
  SELECT id, name, created_at
  FROM businesses
  WHERE is_demo_business = FALSE
  ORDER BY created_at
  LIMIT 500
), enabled_businesses AS (
  SELECT active.id, active.name, active.created_at
  FROM active_businesses active
  LEFT JOIN business_engine_v3_flags flags
    ON flags.business_id = active.id
  WHERE COALESCE(flags.enabled, $1::boolean) = TRUE
)
SELECT
  enabled.id::text AS business_id,
  enabled.name AS business_name,
  enabled.created_at::text AS created_at,
  binding.provider_account_ref_id::text AS provider_account_ref_id,
  binding.provider_account_id
FROM enabled_businesses enabled
LEFT JOIN business_provider_accounts binding
  ON binding.business_id = enabled.id::text
 AND binding.provider = 'meta'
ORDER BY enabled.created_at, enabled.id, binding.provider_account_ref_id,
  binding.provider_account_id
`;

const JOB_RUNS_SQL = `
SELECT
  id::text AS id,
  job_name,
  business_ref_id::text AS business_ref_id,
  business_id,
  as_of_date::text AS as_of_date,
  engine_version,
  status,
  dependency_run_id::text AS dependency_run_id,
  started_at::text AS started_at,
  finished_at::text AS finished_at,
  row_count,
  error_code,
  error_message,
  error_json
FROM engine_v3_job_runs
WHERE business_ref_id::text = ANY($1::text[])
  AND job_name = ANY($2::text[])
  AND (as_of_date = $3::date OR started_at >= $4::timestamptz)
ORDER BY business_ref_id, job_name, started_at, id
`;

const CONTEXTS_SQL = `
SELECT
  id::text AS id, business_ref_id::text AS business_ref_id, business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, as_of_date::text AS as_of_date, engine_version,
  scope_type, scope_id, contract_version, context_json,
  account_profile_json, data_health_json, flags_json, context_hash,
  job_run_id::text AS job_run_id
FROM engine_v3_ad_decision_evaluation_contexts
WHERE job_run_id = ANY($1::uuid[])
ORDER BY job_run_id, id
`;

const EVALUATIONS_SQL = `
SELECT
  id::text AS id, context_id::text AS context_id,
  business_ref_id::text AS business_ref_id, business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, decision_entity_type, decision_entity_id, ad_id,
  creative_id,
  as_of_date::text AS as_of_date, engine_version, scope_type, scope_id,
  contract_version, creative_input_json, campaign_context_json,
  prior_hysteresis_json, decision_output_json, raw_label,
  hysteresis_suppressed, input_hash, decision_hash,
  job_run_id::text AS job_run_id
FROM engine_v3_ad_decision_evaluations
WHERE job_run_id = ANY($1::uuid[])
ORDER BY job_run_id, provider_account_ref_id, provider_account_id, ad_id, id
`;

const SNAPSHOTS_SQL = `
SELECT
  id::text AS id, evaluation_id::text AS evaluation_id,
  business_ref_id::text AS business_ref_id, business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, decision_entity_type, decision_entity_id, ad_id,
  creative_id,
  as_of_date::text AS as_of_date, engine_version, scope_type, scope_id,
  input_hash, decision_hash, label, raw_label, pre_authority_label,
  authority_blocker, confidence, truth_source, effective_target_roas,
  ratio_to_target, badges, reason, spend, purchases, roas, recent7d_roas,
  label_transform, blocked_action_type, authorized_action,
  calibration_row_id::text AS calibration_row_id,
  job_run_id::text AS job_run_id
FROM engine_v3_ad_decision_snapshots_daily
WHERE job_run_id = ANY($1::uuid[])
ORDER BY job_run_id, provider_account_ref_id, provider_account_id, ad_id, id
`;

// Exported so the real-Postgres consumer-sweep seam can prove the
// manifest-kind-aware membership count against actual delta runs.
export const SOURCE_RUNS_SQL = `
SELECT
  run.id::text AS id,
  run.business_ref_id::text AS business_ref_id,
  run.business_id,
  run.provider_account_ref_id::text AS provider_account_ref_id,
  run.provider_account_id,
  run.entity_type,
  run.completeness,
  run.observed_at::text AS observed_at,
  run.captured_at::text AS captured_at,
  run.run_hash,
  run.payload_hash,
  run.row_count AS expected_row_count,
  -- D075 consumer sweep: manifest membership is kind-aware, mirroring the
  -- hydration receipt (lib/creative-decision-engine/data-source.ts
  -- member_states). Legacy/full runs stay run-bound; a delta run's members
  -- are the reconstructed complete lane (latest complete-lane row per
  -- entity at or before the run's payload capture clock, endpoint-scoped,
  -- present winners only). Counting a delta run by its run-bound rows made
  -- this verifier flag every delta manifest as under-persisted.
  CASE
    WHEN run.manifest_kind = 'delta' THEN recon.member_count
    ELSE bound.member_count
  END AS persisted_row_count
FROM meta_entity_observation_runs run
LEFT JOIN LATERAL (
  SELECT COUNT(state.id)::integer AS member_count
  FROM meta_entity_state_history state
  WHERE run.manifest_kind IS DISTINCT FROM 'delta'
    AND state.run_id = run.id
    AND state.business_ref_id = run.business_ref_id
    AND state.business_id = run.business_id
    AND state.provider_account_ref_id = run.provider_account_ref_id
    AND state.provider_account_id = run.provider_account_id
    AND state.entity_type = run.entity_type
    AND state.presence = 'present'
) bound ON TRUE
LEFT JOIN LATERAL (
  SELECT COUNT(*)::integer AS member_count
  FROM (
    SELECT DISTINCT ON (state.entity_id) state.presence
    FROM meta_entity_state_history state
    WHERE run.manifest_kind = 'delta'
      AND state.business_ref_id = run.business_ref_id
      AND state.business_id = run.business_id
      AND state.provider_account_ref_id = run.provider_account_ref_id
      AND state.provider_account_id = run.provider_account_id
      AND state.entity_type = run.entity_type
      AND state.run_completeness = 'complete'
      AND EXISTS (
        SELECT 1
        FROM meta_entity_observation_runs scope_run
        WHERE scope_run.id = state.run_id
          AND scope_run.endpoint = run.endpoint
      )
      AND state.captured_at <= run.captured_at
    ORDER BY state.entity_id, state.captured_at DESC, state.created_at DESC,
      state.id DESC
  ) latest
  WHERE latest.presence = 'present'
) recon ON TRUE
WHERE run.id = ANY($1::uuid[])
ORDER BY run.id
`;

const CALIBRATION_BATCHES_SQL = `
SELECT
  id::text AS id, business_ref_id::text AS business_ref_id, business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, as_of_date::text AS as_of_date,
  as_of_cutoff::text AS as_of_cutoff, transaction_isolation, engine_version,
  policy_version, source_mode, source_provenance_json, expected_cell_count,
  generation_content_hash, input_manifest_hash, source_manifest_hash, cell_set_hash,
  completeness_status, job_run_id::text AS job_run_id,
  computed_at::text AS computed_at, completed_at::text AS completed_at
FROM engine_v3_ad_account_calibration_batches
WHERE id = ANY($1::uuid[])
ORDER BY id
`;

const CALIBRATION_CELLS_SQL = `
SELECT
  id::text AS id, batch_id::text AS batch_id, job_run_id::text AS job_run_id,
  business_id, provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, account_timezone, account_currency, cell_scope,
  objective, funnel_cohort, optimization_context,
  batch_input_manifest_hash, input_manifest_hash, source_manifest_hash
FROM engine_v3_ad_account_calibration_daily
WHERE batch_id = ANY($1::uuid[])
ORDER BY batch_id, provider_account_id, account_timezone, account_currency,
  cell_scope, objective, funnel_cohort, optimization_context
`;

const OPERATOR_RESPONSES_SQL = `
SELECT
  run.id::text AS job_run_id,
  COUNT(response.id)::integer AS response_count,
  COUNT(response.id) FILTER (
    WHERE response.business_ref_id <> run.business_ref_id
       OR response.business_id IS DISTINCT FROM run.business_id
  )::integer AS lineage_contradiction_count
FROM engine_v3_job_runs run
LEFT JOIN engine_v3_ad_operator_responses response
  ON response.job_run_id = run.id
WHERE run.id = ANY($1::uuid[])
GROUP BY run.id
ORDER BY run.id
`;

const OPERATOR_EPISODES_SQL = `
SELECT DISTINCT
  episode.episode_key, episode.contract_version,
  episode.business_ref_id::text AS business_ref_id, episode.business_id,
  episode.provider_account_ref_id::text AS provider_account_ref_id,
  episode.provider_account_id, episode.decision_entity_type,
  episode.decision_entity_id, episode.ad_id, episode.creative_id,
  episode.as_of_date::text AS as_of_date, episode.engine_version,
  episode.scope_type, episode.scope_id,
  episode.decision_snapshot_id::text AS decision_snapshot_id,
  episode.evaluation_id::text AS evaluation_id,
  episode.input_hash, episode.decision_hash, episode.decision_label,
  episode.source_campaign_id, episode.source_adset_id,
  snapshot.creative_id AS parent_snapshot_creative_id,
  snapshot.label AS parent_snapshot_label,
  evaluation.creative_id AS parent_evaluation_creative_id,
  NULLIF(evaluation.creative_input_json->>'campaignId', '')
    AS parent_input_campaign_id,
  NULLIF(evaluation.creative_input_json->>'adsetId', '')
    AS parent_input_adset_id,
  NULLIF(evaluation.campaign_context_json->>'campaignId', '')
    AS parent_context_campaign_id,
  episode.recommended_at::text AS recommended_at,
  episode.job_run_id::text AS job_run_id,
  (
    snapshot.id IS NOT NULL
    AND evaluation.id IS NOT NULL
    AND episode.creative_id IS NOT DISTINCT FROM snapshot.creative_id
    AND episode.creative_id IS NOT DISTINCT FROM evaluation.creative_id
    AND episode.decision_label = snapshot.label
    AND episode.source_campaign_id IS NOT DISTINCT FROM
      NULLIF(evaluation.creative_input_json->>'campaignId', '')
    AND episode.source_campaign_id IS NOT DISTINCT FROM
      NULLIF(evaluation.campaign_context_json->>'campaignId', '')
    AND episode.source_adset_id IS NOT DISTINCT FROM
      NULLIF(evaluation.creative_input_json->>'adsetId', '')
  ) AS lineage_valid
FROM engine_v3_ad_operator_responses response
JOIN engine_v3_ad_recommendation_episodes episode
  ON episode.episode_key = response.episode_key
 AND episode.business_ref_id = response.business_ref_id
 AND episode.business_id = response.business_id
 AND episode.provider_account_ref_id = response.provider_account_ref_id
 AND episode.provider_account_id = response.provider_account_id
LEFT JOIN engine_v3_ad_decision_snapshots_daily snapshot
  ON snapshot.id = episode.decision_snapshot_id
 AND snapshot.business_ref_id = episode.business_ref_id
 AND snapshot.business_id = episode.business_id
 AND snapshot.provider_account_ref_id = episode.provider_account_ref_id
 AND snapshot.provider_account_id = episode.provider_account_id
 AND snapshot.decision_entity_type = episode.decision_entity_type
 AND snapshot.decision_entity_id = episode.decision_entity_id
 AND snapshot.ad_id = episode.ad_id
 AND snapshot.as_of_date = episode.as_of_date
 AND snapshot.engine_version = episode.engine_version
 AND snapshot.scope_type = episode.scope_type
 AND snapshot.scope_id = episode.scope_id
 AND snapshot.evaluation_id = episode.evaluation_id
 AND snapshot.input_hash = episode.input_hash
 AND snapshot.decision_hash = episode.decision_hash
LEFT JOIN engine_v3_ad_decision_evaluations evaluation
  ON evaluation.id = episode.evaluation_id
 AND evaluation.business_ref_id = episode.business_ref_id
 AND evaluation.business_id = episode.business_id
 AND evaluation.provider_account_ref_id = episode.provider_account_ref_id
 AND evaluation.provider_account_id = episode.provider_account_id
 AND evaluation.decision_entity_type = episode.decision_entity_type
 AND evaluation.decision_entity_id = episode.decision_entity_id
 AND evaluation.ad_id = episode.ad_id
 AND evaluation.as_of_date = episode.as_of_date
 AND evaluation.engine_version = episode.engine_version
 AND evaluation.scope_type = episode.scope_type
 AND evaluation.scope_id = episode.scope_id
 AND evaluation.input_hash = episode.input_hash
 AND evaluation.decision_hash = episode.decision_hash
WHERE response.job_run_id = ANY($1::uuid[])
ORDER BY episode.episode_key
`;

const OPERATOR_EVENTS_SQL = `
SELECT
  job_run_id::text AS job_run_id, episode_key,
  business_ref_id::text AS business_ref_id, business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, response_cutoff::text AS response_cutoff,
  contract_version, evidence_kind, evidence_source_id,
  action_receipt_id::text AS action_receipt_id,
  state_history_id::text AS state_history_id,
  tombstone_id::text AS tombstone_id,
  evidence_observed_at::text AS evidence_observed_at,
  evidence_captured_at::text AS evidence_captured_at,
  treatment_eligible, diagnostic_code, evidence_json, evidence_hash
FROM engine_v3_ad_operator_response_events
WHERE job_run_id = ANY($1::uuid[])
ORDER BY job_run_id, episode_key, response_cutoff, evidence_hash
`;

const OPERATOR_RESPONSE_ROWS_SQL = `
SELECT
  job_run_id::text AS job_run_id, episode_key,
  business_ref_id::text AS business_ref_id, business_id,
  provider_account_ref_id::text AS provider_account_ref_id,
  provider_account_id, contract_version,
  response_cutoff::text AS response_cutoff, observation_status, response_type,
  operator_response_detected, ad_treatment_detected,
  detected_at::text AS detected_at,
  action_receipt_id::text AS action_receipt_id,
  action_log_id::text AS action_log_id,
  successor_ad_id, successor_kind, budget_owner_type, budget_owner_id,
  window_start::text AS window_start, window_end::text AS window_end,
  window_closed, source_complete, source_set_hash, action_receipt_count,
  state_observation_count, tombstone_observation_count,
  required_state_target_count, complete_state_target_count,
  diagnostics_json, evidence_hashes_json, evidence_count, evidence_set_hash,
  replacement_set_hash, response_hash
FROM engine_v3_ad_operator_responses
WHERE job_run_id = ANY($1::uuid[])
ORDER BY job_run_id, episode_key, response_cutoff
`;

const SESSION_PROOF_SQL = `
SELECT
  transaction_timestamp()::text AS observed_at,
  current_setting('transaction_read_only') AS transaction_read_only,
  current_setting('default_transaction_read_only') AS default_transaction_read_only,
  lower(current_setting('transaction_isolation')) AS transaction_isolation,
  current_setting('statement_timeout') AS statement_timeout,
  current_setting('application_name') AS application_name
`;

export const OPERATIONAL_SELECT_QUERIES = [
  SCHEDULER_MANIFEST_SQL,
  JOB_RUNS_SQL,
  CONTEXTS_SQL,
  EVALUATIONS_SQL,
  SNAPSHOTS_SQL,
  SOURCE_RUNS_SQL,
  CALIBRATION_BATCHES_SQL,
  CALIBRATION_CELLS_SQL,
  OPERATOR_RESPONSES_SQL,
  OPERATOR_EPISODES_SQL,
  OPERATOR_EVENTS_SQL,
  OPERATOR_RESPONSE_ROWS_SQL,
  SESSION_PROOF_SQL,
  READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
] as const;

function requiredString(value: unknown, label: string): string {
  if (typeof value !== "string" || value.trim() === "") {
    throw new TypeError(`${label} must be a non-empty string.`);
  }
  return value.trim();
}

function nullableString(value: unknown): string | null {
  return typeof value === "string" && value.trim() !== ""
    ? value.trim()
    : null;
}

function exactInteger(value: unknown): number | null {
  const parsed =
    typeof value === "number"
      ? value
      : typeof value === "string" && value.trim() !== ""
        ? Number(value)
        : Number.NaN;
  return Number.isSafeInteger(parsed) ? parsed : null;
}

function nullableNumber(value: unknown): number | null {
  if (value === null || value === undefined) return null;
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function requiredNonNegativeInteger(value: string, label: string): number {
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new TypeError(`${label} must be a non-negative integer.`);
  }
  return parsed;
}

function normalizeDate(value: string, label: string): string {
  const trimmed = value.trim();
  const parsed = new Date(`${trimmed}T00:00:00.000Z`);
  if (
    !/^\d{4}-\d{2}-\d{2}$/.test(trimmed) ||
    Number.isNaN(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== trimmed
  ) {
    throw new TypeError(`${label} must be a real YYYY-MM-DD date.`);
  }
  return trimmed;
}

function normalizeTimestamp(value: string, label: string): string {
  const parsed = new Date(value);
  if (Number.isNaN(parsed.getTime())) {
    throw new TypeError(`${label} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

function safeOutputPath(value: string | undefined, asOf: string): string {
  const candidate =
    value ??
    `/private/tmp/native-ad-natural-wave-operational-verification-${asOf}.json`;
  const absolute = resolve(candidate);
  if (
    !absolute.endsWith(".json") ||
    !(
      absolute.startsWith("/private/tmp/") ||
      absolute.startsWith("/tmp/")
    )
  ) {
    throw new TypeError(
      "--output must be a .json file directly beneath /tmp or /private/tmp.",
    );
  }
  return absolute;
}

export function parseVerifierArgs(argv: readonly string[]): VerifierArgs {
  const singles = new Map<string, string>();
  const expectedUnbound: string[] = [];
  const known = new Set([
    "as-of",
    "deploy-anchor",
    "expected-business-count",
    "expected-provider-account-count",
    "expected-unbound",
    "env-default-enabled",
    "output",
  ]);
  for (const argument of argv) {
    const match = /^--([^=]+)=(.*)$/.exec(argument);
    if (!match || !known.has(match[1] ?? "")) {
      throw new TypeError(`Unknown or malformed argument: ${argument}`);
    }
    const key = match[1] as string;
    const value = requiredString(match[2], `--${key}`);
    if (key === "expected-unbound") {
      expectedUnbound.push(value);
      continue;
    }
    if (singles.has(key)) {
      throw new TypeError(`--${key} may be supplied only once.`);
    }
    singles.set(key, value);
  }
  const asOf = normalizeDate(
    requiredString(singles.get("as-of"), "--as-of"),
    "--as-of",
  );
  const deployAnchor = normalizeTimestamp(
    requiredString(singles.get("deploy-anchor"), "--deploy-anchor"),
    "--deploy-anchor",
  );
  const expectedBusinessCount = requiredNonNegativeInteger(
    requiredString(
      singles.get("expected-business-count"),
      "--expected-business-count",
    ),
    "--expected-business-count",
  );
  const expectedProviderAccountCount = requiredNonNegativeInteger(
    requiredString(
      singles.get("expected-provider-account-count"),
      "--expected-provider-account-count",
    ),
    "--expected-provider-account-count",
  );
  if (expectedBusinessCount === 0 || expectedProviderAccountCount === 0) {
    throw new TypeError("Expected bound counts must be greater than zero.");
  }
  const envDefaultEnabledText = requiredString(
    singles.get("env-default-enabled"),
    "--env-default-enabled",
  ).toLowerCase();
  if (
    envDefaultEnabledText !== "true" &&
    envDefaultEnabledText !== "false"
  ) {
    throw new TypeError("--env-default-enabled must be true or false.");
  }
  const waveStart = Date.parse(
    `${asOf}T${String(NATIVE_AD_NATURAL_WAVE_UTC_HOUR).padStart(2, "0")}:00:00.000Z`,
  );
  if (Date.parse(deployAnchor) >= waveStart) {
    throw new TypeError(
      "--deploy-anchor must be before the requested natural 03:00 UTC wave.",
    );
  }
  return {
    asOf,
    deployAnchor,
    expectedBusinessCount,
    expectedProviderAccountCount,
    expectedUnbound,
    envDefaultEnabled: envDefaultEnabledText === "true",
    outputPath: safeOutputPath(singles.get("output"), asOf),
  };
}

export function assertLiveReadOnlyEnvironment(
  env: Readonly<Record<string, string | undefined>>,
): { connectionString: string; applicationName: string } {
  const connectionString = requiredString(env.DATABASE_URL, "DATABASE_URL");
  const url = new URL(connectionString);
  if (url.hostname !== LIVE_TUNNEL_HOST || url.port !== LIVE_TUNNEL_PORT) {
    throw new Error(
      `DATABASE_URL must use the existing ${LIVE_TUNNEL_HOST}:${LIVE_TUNNEL_PORT} live tunnel.`,
    );
  }
  const applicationName = requiredString(env.PGAPPNAME, "PGAPPNAME");
  const pgOptions = requiredString(env.PGOPTIONS, "PGOPTIONS");
  if (
    !/default_transaction_read_only\s*=\s*on/i.test(pgOptions) ||
    /default_transaction_read_only\s*=\s*(?:off|false|0)/i.test(pgOptions)
  ) {
    throw new Error(
      "PGOPTIONS must contain default_transaction_read_only=on and no disabling override.",
    );
  }
  return { connectionString, applicationName };
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function objectAt(value: unknown, ...path: string[]): JsonObject | null {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return isObject(current) ? current : null;
}

function arrayAt(value: unknown, ...path: string[]): unknown[] | null {
  let current = value;
  for (const key of path) {
    if (!isObject(current)) return null;
    current = current[key];
  }
  return Array.isArray(current) ? current : null;
}

function metadataInteger(
  metadata: JsonObject | null,
  key: string,
): number | null {
  return exactInteger(metadata?.[key]);
}

function isSha256(value: unknown): value is string {
  return typeof value === "string" && /^[0-9a-f]{64}$/.test(value);
}

function timestampMs(value: string | null): number | null {
  if (value === null) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function sameTimestamp(left: unknown, right: string): boolean {
  return (
    typeof left === "string" &&
    timestampMs(left) !== null &&
    timestampMs(left) === timestampMs(right)
  );
}

function setKey(...values: string[]): string {
  return values.join("\u0000");
}

function bindingKey(
  providerAccountRefId: string,
  providerAccountId: string,
): string {
  return setKey(providerAccountRefId, providerAccountId);
}

function append(
  global: string[],
  business: string[],
  businessId: string,
  code: string,
) {
  const detail = `${businessId}:${code}`;
  business.push(code);
  global.push(detail);
}

function hasBadge(value: unknown, type: string): boolean {
  return (
    Array.isArray(value) &&
    value.some((badge) => isObject(badge) && badge.type === type)
  );
}

function authorityContradiction(snapshot: DecisionSnapshotFact): boolean {
  const hard = new Set(["scale", "cut", "refresh"]);
  const soft = new Set(["diagnose", "out_of_scope", "keep"]);
  if (snapshot.calibrationRowId === null) {
    return !(
      soft.has(snapshot.label) &&
      soft.has(snapshot.rawLabel) &&
      snapshot.confidence <= 40 &&
      snapshot.authorizedAction === null &&
      snapshot.blockedActionType === null &&
      hasBadge(snapshot.badges, "native_calibration_unavailable")
    );
  }
  if (snapshot.authorityBlocker !== null) {
    return !(
      snapshot.authorizedAction === null &&
      (!hard.has(snapshot.label) || snapshot.label === snapshot.rawLabel)
    );
  }
  if (hard.has(snapshot.rawLabel)) {
    const directlyAuthorized =
      snapshot.label === snapshot.rawLabel &&
      snapshot.authorizedAction === snapshot.rawLabel &&
      snapshot.blockedActionType === null;
    const pendingTransition =
      !hard.has(snapshot.label) &&
      snapshot.authorizedAction === null &&
      snapshot.blockedActionType === snapshot.rawLabel &&
      hasBadge(snapshot.badges, "pending_transition");
    return !(directlyAuthorized || pendingTransition);
  }
  return !(
    !hard.has(snapshot.label) &&
    snapshot.authorizedAction === null &&
    snapshot.blockedActionType === null
  );
}

function provenAdvisorySkip(
  skipped: JobRunFact,
  jobs: readonly JobRunFact[],
): boolean {
  if (
    skipped.status !== "skipped" ||
    !skipped.errorMessage?.startsWith("Advisory lock not acquired")
  ) {
    return false;
  }
  const skippedStarted = timestampMs(skipped.startedAt);
  const skippedFinished = timestampMs(skipped.finishedAt);
  if (skippedStarted === null || skippedFinished === null) return false;
  return jobs.some((holder) => {
    const holderStarted = timestampMs(holder.startedAt);
    const holderFinished = timestampMs(holder.finishedAt);
    return (
      holder.id !== skipped.id &&
      holder.businessRefId === skipped.businessRefId &&
      holder.jobName === skipped.jobName &&
      holder.asOf === skipped.asOf &&
      holder.engineVersion === skipped.engineVersion &&
      holder.status === "success" &&
      holderStarted !== null &&
      holderFinished !== null &&
      holderStarted <= skippedFinished &&
      holderFinished >= skippedStarted
    );
  });
}

function latestSelectedJob(
  jobs: readonly JobRunFact[],
  businessId: string,
  jobName: NativeJobName,
  asOf: string,
  waveStartMs: number,
): JobRunFact | null {
  return (
    jobs
      .filter(
        (job) =>
          job.businessRefId === businessId &&
          job.jobName === jobName &&
          job.asOf === asOf &&
          job.engineVersion === NATIVE_AD_ENGINE_VERSION &&
          (timestampMs(job.startedAt) ?? -Infinity) >= waveStartMs &&
          !provenAdvisorySkip(job, jobs),
      )
      .sort(
        (left, right) =>
          (timestampMs(right.startedAt) ?? -Infinity) -
            (timestampMs(left.startedAt) ?? -Infinity) ||
          right.id.localeCompare(left.id),
      )[0] ?? null
  );
}

function exactLineageMatch(
  snapshot: DecisionSnapshotFact,
  evaluation: DecisionEvaluationFact,
): boolean {
  return (
    snapshot.evaluationId === evaluation.id &&
    snapshot.businessRefId === evaluation.businessRefId &&
    snapshot.businessId === evaluation.businessId &&
    snapshot.providerAccountRefId === evaluation.providerAccountRefId &&
    snapshot.providerAccountId === evaluation.providerAccountId &&
    snapshot.decisionEntityType === evaluation.decisionEntityType &&
    snapshot.decisionEntityId === evaluation.decisionEntityId &&
    snapshot.adId === evaluation.adId &&
    snapshot.asOf === evaluation.asOf &&
    snapshot.engineVersion === evaluation.engineVersion &&
    snapshot.scopeType === evaluation.scopeType &&
    snapshot.scopeId === evaluation.scopeId &&
    snapshot.inputHash === evaluation.inputHash &&
    snapshot.decisionHash === evaluation.decisionHash &&
    snapshot.jobRunId === evaluation.jobRunId
  );
}

function exactContextMatch(
  evaluation: DecisionEvaluationFact,
  context: DecisionContextFact,
): boolean {
  return (
    evaluation.contextId === context.id &&
    evaluation.businessRefId === context.businessRefId &&
    evaluation.businessId === context.businessId &&
    evaluation.providerAccountRefId === context.providerAccountRefId &&
    evaluation.providerAccountId === context.providerAccountId &&
    evaluation.asOf === context.asOf &&
    evaluation.engineVersion === context.engineVersion &&
    evaluation.scopeType === context.scopeType &&
    evaluation.scopeId === context.scopeId &&
    evaluation.contractVersion === context.contractVersion &&
    evaluation.jobRunId === context.jobRunId
  );
}

function canonicalEqual(left: unknown, right: unknown): boolean {
  if (
    (!isObject(left) && !Array.isArray(left) && left !== null) ||
    (!isObject(right) && !Array.isArray(right) && right !== null)
  ) {
    return left === right;
  }
  try {
    return (
      stableCanonicalJson(left as CanonicalJsonObject) ===
      stableCanonicalJson(right as CanonicalJsonObject)
    );
  } catch {
    return false;
  }
}

function canonicalEvaluationProofValid(
  context: DecisionContextFact,
  evaluation: DecisionEvaluationFact,
  snapshot: DecisionSnapshotFact,
): boolean {
  if (
    context.contractVersion !== AD_DECISION_EVALUATION_CONTRACT_VERSION ||
    evaluation.contractVersion !==
      AD_DECISION_EVALUATION_CONTRACT_VERSION ||
    !isObject(context.contextJson) ||
    !isObject(context.accountProfileJson) ||
    !isObject(context.dataHealthJson) ||
    !isObject(context.flagsJson) ||
    !isObject(evaluation.creativeInputJson) ||
    !isObject(evaluation.campaignContextJson) ||
    !isObject(evaluation.priorHysteresisJson) ||
    !isObject(evaluation.decisionOutputJson)
  ) {
    return false;
  }
  const scope = objectAt(context.contextJson, "scope");
  if (
    context.contextJson.contractVersion !== context.contractVersion ||
    context.contextJson.envelopeType !== "context" ||
    context.contextJson.engineVersion !== context.engineVersion ||
    scope?.type !== context.scopeType ||
    scope?.id !== context.scopeId ||
    !canonicalEqual(
      context.contextJson.accountProfile,
      context.accountProfileJson,
    ) ||
    !canonicalEqual(context.contextJson.dataHealth, context.dataHealthJson) ||
    !canonicalEqual(context.contextJson.flags, context.flagsJson) ||
    !isSha256(context.contextHash) ||
    canonicalSha256(context.contextJson as CanonicalJsonObject) !==
      context.contextHash
  ) {
    return false;
  }
  const inputPayload = {
    contractVersion: evaluation.contractVersion,
    envelopeType: "input",
    engineVersion: evaluation.engineVersion,
    contextHash: context.contextHash,
    creativeInput: evaluation.creativeInputJson,
    campaignContext: evaluation.campaignContextJson,
    priorHysteresis: evaluation.priorHysteresisJson,
    decisionIdentity: {
      decisionEntityType: evaluation.decisionEntityType,
      decisionEntityId: evaluation.decisionEntityId,
      adId: evaluation.adId,
      providerAccountId: evaluation.providerAccountId,
      providerAccountRefId: evaluation.providerAccountRefId,
      creativeGroupingId: evaluation.creativeId,
    },
  } as unknown as CanonicalJsonObject;
  const decisionPayload = {
    contractVersion: evaluation.contractVersion,
    envelopeType: "decision",
    engineVersion: evaluation.engineVersion,
    inputHash: evaluation.inputHash,
    decision: evaluation.decisionOutputJson,
    rawLabel: evaluation.rawLabel,
    publishedLabel: snapshot.label,
    hysteresisSuppressed: evaluation.hysteresisSuppressed,
  } as unknown as CanonicalJsonObject;
  const creativeInput = evaluation.creativeInputJson;
  const decision = evaluation.decisionOutputJson;
  const profileScope = objectAt(context.accountProfileJson, "scope");
  const hardActionEligibility = objectAt(
    context.accountProfileJson,
    "hardActionEligibility",
  );
  return (
    isSha256(evaluation.inputHash) &&
    isSha256(evaluation.decisionHash) &&
    typeof context.accountProfileJson.businessId === "string" &&
    context.accountProfileJson.businessId === creativeInput.businessId &&
    String(context.flagsJson.businessId) ===
      context.accountProfileJson.businessId &&
    profileScope?.type === context.scopeType &&
    profileScope?.id === context.scopeId &&
    evaluation.campaignContextJson.campaignId === creativeInput.campaignId &&
    canonicalSha256(inputPayload) === evaluation.inputHash &&
    canonicalSha256(decisionPayload) === evaluation.decisionHash &&
    snapshot.rawLabel === evaluation.rawLabel &&
    snapshot.creativeId === evaluation.creativeId &&
    creativeInput.businessId === snapshot.businessId &&
    creativeInput.decisionEntityType === "ad" &&
    creativeInput.decisionEntityId === snapshot.decisionEntityId &&
    creativeInput.adId === snapshot.adId &&
    creativeInput.providerAccountId === snapshot.providerAccountId &&
    nullableString(creativeInput.creativeId) === snapshot.creativeId &&
    nullableNumber(creativeInput.spend) === snapshot.spend &&
    nullableNumber(creativeInput.purchases) === snapshot.purchases &&
    nullableNumber(creativeInput.roas) === snapshot.roas &&
    nullableNumber(creativeInput.recent7dRoas) === snapshot.recent7dRoas &&
    decision.decisionEntityType === "ad" &&
    decision.decisionEntityId === snapshot.decisionEntityId &&
    decision.adId === snapshot.adId &&
    decision.providerAccountId === snapshot.providerAccountId &&
    nullableString(decision.creativeId) === snapshot.creativeId &&
    decision.engineVersion === snapshot.engineVersion &&
    decision.label === snapshot.label &&
    nullableString(decision.preAuthorityLabel) ===
      snapshot.preAuthorityLabel &&
    nullableString(decision.authorityBlocker) ===
      snapshot.authorityBlocker &&
    Math.max(
      0,
      Math.min(100, Math.round(nullableNumber(decision.confidence) ?? -1)),
    ) === snapshot.confidence &&
    decision.truthSource === snapshot.truthSource &&
    nullableNumber(decision.effectiveTargetRoas) ===
      snapshot.effectiveTargetRoas &&
    nullableNumber(decision.ratioToTarget) === snapshot.ratioToTarget &&
    canonicalEqual(decision.badges, snapshot.badges) &&
    decision.reason === snapshot.reason &&
    (snapshot.authorizedAction === null ||
      (["scale", "cut", "refresh"].includes(snapshot.authorizedAction) &&
        hardActionEligibility?.[snapshot.authorizedAction] === true)) &&
    nullableString(decision.blockedActionType) ===
      snapshot.blockedActionType &&
    nullableString(decision.labelTransform) === snapshot.labelTransform
  );
}

function operatorEpisodeProofValid(episode: OperatorEpisodeFact): boolean {
  try {
    const rebuilt = buildAdRecommendationEpisode({
      businessId: episode.businessRefId,
      businessDisplayId: episode.businessId,
      providerAccountRefId: episode.providerAccountRefId,
      providerAccountId: episode.providerAccountId,
      adId: episode.adId,
      creativeId: episode.creativeId,
      asOfDate: episode.asOf,
      engineVersion: episode.engineVersion,
      scopeType: episode.scopeType,
      scopeId: episode.scopeId,
      snapshotId: episode.decisionSnapshotId,
      evaluationId: episode.evaluationId,
      inputHash: episode.inputHash,
      decisionHash: episode.decisionHash,
      decisionLabel: episode.decisionLabel,
      sourceCampaignId: episode.sourceCampaignId,
      sourceAdsetId: episode.sourceAdsetId,
      recommendedAt: episode.recommendedAt,
    });
    return (
      episode.contractVersion ===
        NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION &&
      episode.businessId === episode.businessRefId &&
      episode.decisionEntityType === "ad" &&
      episode.decisionEntityId === episode.adId &&
      episode.lineageValid &&
      episode.creativeId === episode.parentSnapshotCreativeId &&
      episode.creativeId === episode.parentEvaluationCreativeId &&
      episode.decisionLabel === episode.parentSnapshotLabel &&
      episode.sourceCampaignId === episode.parentInputCampaignId &&
      episode.sourceCampaignId === episode.parentContextCampaignId &&
      episode.sourceAdsetId === episode.parentInputAdsetId &&
      isSha256(episode.inputHash) &&
      isSha256(episode.decisionHash) &&
      rebuilt.episodeKey === episode.episodeKey
    );
  } catch {
    return false;
  }
}

function operatorDiagnosticsProofValid(
  diagnostics: readonly unknown[],
): boolean {
  const seen = new Set<string>();
  let previous:
    | { code: string; evidenceId: string; detail: string }
    | undefined;
  for (const value of diagnostics) {
    if (!isObject(value)) return false;
    const keys = Object.keys(value).sort();
    if (
      keys.length !== 3 ||
      keys[0] !== "code" ||
      keys[1] !== "detail" ||
      keys[2] !== "evidenceId"
    ) {
      return false;
    }
    const code = nullableString(value.code);
    const detail = nullableString(value.detail);
    const evidenceId =
      value.evidenceId === null ? "" : nullableString(value.evidenceId);
    if (
      code === null ||
      !Object.prototype.hasOwnProperty.call(
        OPERATOR_RESPONSE_DIAGNOSTIC_CODES,
        code,
      ) ||
      detail === null ||
      evidenceId === null ||
      OPERATOR_RESPONSE_AUTHORITY_CONTRADICTION_CODES.has(
        code as AdOperatorResponseDiagnosticCode,
      )
    ) {
      return false;
    }
    const normalized = { code, evidenceId, detail };
    const uniqueKey = setKey(code, evidenceId, detail);
    if (seen.has(uniqueKey)) return false;
    seen.add(uniqueKey);
    if (
      previous &&
      (previous.code.localeCompare(code) > 0 ||
        (previous.code === code &&
          previous.evidenceId.localeCompare(evidenceId) > 0) ||
        (previous.code === code &&
          previous.evidenceId === evidenceId &&
          previous.detail.localeCompare(detail) > 0))
    ) {
      return false;
    }
    previous = normalized;
  }
  return true;
}

function operatorResponseProofValid(
  response: OperatorResponseFact,
  episode: OperatorEpisodeFact | undefined,
  events: readonly OperatorEventFact[],
): boolean {
  const requiredStateTargetCount = episode
    ? 1 +
      (episode.sourceCampaignId === null ? 0 : 1) +
      (episode.sourceAdsetId === null ? 0 : 1)
    : -1;
  const responseType = Object.prototype.hasOwnProperty.call(
    OPERATOR_RESPONSE_OBSERVATION_BY_TYPE,
    response.responseType,
  )
    ? (response.responseType as AdOperatorResponseType)
    : null;
  const expectedObservationStatus = responseType
    ? OPERATOR_RESPONSE_OBSERVATION_BY_TYPE[responseType]
    : null;
  const expectedAdTreatmentDetected =
    responseType !== null &&
    [
      "verified_pause",
      "verified_resume",
      "duplicate_successor",
      "rebuild_successor",
    ].includes(responseType);
  if (
    !episode ||
    !operatorEpisodeProofValid(episode) ||
    response.contractVersion !==
      NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION ||
    response.businessRefId !== episode.businessRefId ||
    response.businessId !== episode.businessId ||
    response.providerAccountRefId !== episode.providerAccountRefId ||
    response.providerAccountId !== episode.providerAccountId ||
    response.episodeKey !== episode.episodeKey ||
    responseType === null ||
    responseType === "ambiguous_conflicting" ||
    response.observationStatus !== expectedObservationStatus ||
    response.operatorResponseDetected !==
      (expectedObservationStatus === "observed_response") ||
    response.adTreatmentDetected !== expectedAdTreatmentDetected ||
    !sameTimestamp(response.windowStart, episode.recommendedAt) ||
    response.requiredStateTargetCount !== requiredStateTargetCount ||
    response.completeStateTargetCount < 0 ||
    response.completeStateTargetCount > requiredStateTargetCount ||
    !isSha256(response.sourceSetHash) ||
    !isSha256(response.evidenceSetHash) ||
    !isSha256(response.replacementSetHash) ||
    !isSha256(response.responseHash) ||
    !Array.isArray(response.diagnosticsJson) ||
    !operatorDiagnosticsProofValid(response.diagnosticsJson) ||
    !Array.isArray(response.evidenceHashesJson)
  ) {
    return false;
  }
  const evidence = [];
  const evidenceHashes: string[] = [];
  const evidenceKeys = new Set<string>();
  for (const event of events) {
    if (
      event.jobRunId !== response.jobRunId ||
      event.episodeKey !== response.episodeKey ||
      timestampMs(event.responseCutoff) !==
        timestampMs(response.responseCutoff) ||
      event.businessRefId !== response.businessRefId ||
      event.businessId !== response.businessId ||
      event.providerAccountRefId !== response.providerAccountRefId ||
      event.providerAccountId !== response.providerAccountId ||
      event.contractVersion !==
        NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION ||
      !isObject(event.evidenceJson)
    ) {
      return false;
    }
    const exactSource =
      (event.evidenceKind ===
        "engine_v3_ad_operator_action_receipt" &&
        event.actionReceiptId !== null &&
        event.stateHistoryId === null &&
        event.tombstoneId === null &&
        event.evidenceSourceId === event.actionReceiptId) ||
      (event.evidenceKind === "meta_entity_state_history" &&
        event.actionReceiptId === null &&
        event.stateHistoryId !== null &&
        event.tombstoneId === null &&
        event.evidenceSourceId === event.stateHistoryId) ||
      (event.evidenceKind === "meta_entity_tombstones" &&
        event.actionReceiptId === null &&
        event.stateHistoryId === null &&
        event.tombstoneId !== null &&
        event.evidenceSourceId === event.tombstoneId);
    const expectedEventHash = canonicalSha256({
      episodeKey: event.episodeKey,
      responseCutoff: response.responseCutoff,
      kind: event.evidenceKind,
      sourceId: event.evidenceSourceId,
      observedAt: event.evidenceObservedAt,
      capturedAt: event.evidenceCapturedAt,
      treatmentEligible: event.treatmentEligible,
      evidenceJson: event.evidenceJson,
    });
    const role = nullableString(event.evidenceJson.role);
    const payload = event.evidenceJson.payload;
    if (
      !exactSource ||
      (event.treatmentEligible && event.actionReceiptId === null) ||
      role === null ||
      !isObject(payload) ||
      nullableString(event.evidenceJson.diagnosticCode) !==
        event.diagnosticCode ||
      expectedEventHash !== event.evidenceHash
    ) {
      return false;
    }
    const evidenceKey = setKey(event.evidenceKind, event.evidenceSourceId, role);
    if (evidenceKeys.has(evidenceKey)) return false;
    evidenceKeys.add(evidenceKey);
    evidenceHashes.push(event.evidenceHash);
    evidence.push({
      kind: event.evidenceKind,
      sourceId: event.evidenceSourceId,
      role,
      observedAt: event.evidenceObservedAt,
      capturedAt: event.evidenceCapturedAt,
      treatmentEligible: event.treatmentEligible,
      diagnosticCode: nullableString(event.evidenceJson.diagnosticCode),
      payload,
    });
  }
  evidence.sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.kind.localeCompare(right.kind) ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.role.localeCompare(right.role),
  );
  evidenceHashes.sort();
  const storedEvidenceHashes = response.evidenceHashesJson
    .filter((value): value is string => typeof value === "string")
    .sort();
  const evidenceSetHash = canonicalSha256({
    episodeKey: response.episodeKey,
    responseCutoff: response.responseCutoff,
    evidenceHashes,
  });
  const replacementSetHash = canonicalSha256({
    episodeKey: response.episodeKey,
    responseCutoff: response.responseCutoff,
    responseHash: response.responseHash,
    sourceSetHash: response.sourceSetHash,
    evidenceSetHash,
    evidenceCount: evidenceHashes.length,
  });
  const sourceProof = {
    contractVersion: NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION,
    windowStart: response.windowStart,
    windowEnd: response.windowEnd,
    windowClosed: response.windowClosed,
    actionReceiptsComplete: true,
    stateHistoryComplete: true,
    tombstonesComplete: true,
    requiredStateTargetCount: response.requiredStateTargetCount,
    completeStateTargetCount: response.completeStateTargetCount,
    actionReceiptCount: response.actionReceiptCount,
    stateObservationCount: response.stateObservationCount,
    tombstoneObservationCount: response.tombstoneObservationCount,
    sourceComplete: response.sourceComplete,
    sourceSetHash: response.sourceSetHash,
  };
  const base = {
    contractVersion: response.contractVersion,
    episodeKey: response.episodeKey,
    observationStatus: response.observationStatus,
    responseType: response.responseType,
    operatorResponseDetected: response.operatorResponseDetected,
    adTreatmentDetected: response.adTreatmentDetected,
    detectedAt: response.detectedAt,
    actionReceiptId: response.actionReceiptId,
    actionLogId: response.actionLogId,
    successorAdId: response.successorAdId,
    successorKind: response.successorKind,
    budgetOwnerType: response.budgetOwnerType,
    budgetOwnerId: response.budgetOwnerId,
    sourceProof,
    diagnostics: response.diagnosticsJson,
    evidence,
  };
  return (
    storedEvidenceHashes.length === response.evidenceHashesJson.length &&
    canonicalSha256(storedEvidenceHashes) ===
      canonicalSha256(evidenceHashes) &&
    response.evidenceCount === evidenceHashes.length &&
    response.evidenceSetHash === evidenceSetHash &&
    response.replacementSetHash === replacementSetHash &&
    response.responseHash === canonicalSha256(base) &&
    (response.observationStatus === "observed_response") ===
      response.operatorResponseDetected &&
    (!response.adTreatmentDetected || response.operatorResponseDetected)
  );
}

function calibrationCellSetHash(batch: CalibrationBatchFact): string {
  return computeNativeAdCalibrationCellSetHash(
    batch.cells.map((cell) => ({
      key: {
        businessId: cell.businessId,
        providerAccountRefId: cell.providerAccountRefId,
        providerAccountId: cell.providerAccountId,
        accountTimezone: cell.accountTimezone,
        accountCurrency: cell.accountCurrency,
        cellScope:
          cell.cellScope as NativeAdCalibrationCellKey["cellScope"],
        objective: cell.objective,
        cohort: cell.funnelCohort as NativeAdCalibrationCellKey["cohort"],
        optimizationContext: cell.optimizationContext,
      },
      inputManifestHash: cell.inputManifestHash,
      sourceManifestHash: cell.sourceManifestHash,
    })),
  );
}

function nativeJobSummary(job: JobRunFact | null): JobSummary {
  return {
    id: job?.id ?? null,
    status: job?.status ?? null,
    startedAt: job?.startedAt ?? null,
    finishedAt: job?.finishedAt ?? null,
    rowCount: job?.rowCount ?? null,
  };
}

export function evaluateOperationalFacts(
  args: VerifierArgs,
  facts: OperationalFacts,
): OperationalVerificationReport {
  const blockers: string[] = [];
  const observedAtMs = timestampMs(facts.readOnlySession.observedAt);
  const deployAnchorMs = Date.parse(args.deployAnchor);
  const waveStart = `${args.asOf}T${String(
    NATIVE_AD_NATURAL_WAVE_UTC_HOUR,
  ).padStart(2, "0")}:00:00.000Z`;
  const waveStartMs = Date.parse(waveStart);

  if (
    facts.readOnlySession.transactionReadOnly !== "on" ||
    facts.readOnlySession.defaultTransactionReadOnly !== "on" ||
    facts.readOnlySession.transactionIsolation !== "repeatable read" ||
    facts.readOnlySession.statementTimeout !== "30s" ||
    facts.readOnlySession.applicationName.trim() === ""
  ) {
    blockers.push("session:read_only_contract_invalid");
  }
  if (observedAtMs === null || observedAtMs < waveStartMs) {
    blockers.push("session:natural_wave_not_yet_reached");
  }
  if (facts.envEnabledDefault !== args.envDefaultEnabled) {
    blockers.push("manifest:explicit_env_default_mismatch");
  }

  const manifestBusinesses = new Map<
    string,
    {
      businessId: string;
      businessName: string;
      createdAt: string;
      bindings: Map<
        string,
        { providerAccountRefId: string; providerAccountId: string }
      >;
    }
  >();
  for (const row of facts.manifest) {
    const current = manifestBusinesses.get(row.businessId) ?? {
      businessId: row.businessId,
      businessName: row.businessName,
      createdAt: row.createdAt,
      bindings: new Map(),
    };
    if (
      current.businessName !== row.businessName ||
      current.createdAt !== row.createdAt
    ) {
      blockers.push(`${row.businessId}:manifest_business_contradiction`);
    }
    if (
      (row.providerAccountRefId === null) !==
      (row.providerAccountId === null)
    ) {
      blockers.push(`${row.businessId}:partial_meta_binding_identity`);
    } else if (
      row.providerAccountRefId !== null &&
      row.providerAccountId !== null
    ) {
      const key = bindingKey(
        row.providerAccountRefId,
        row.providerAccountId,
      );
      if (current.bindings.has(key)) {
        blockers.push(`${row.businessId}:duplicate_meta_binding_identity`);
      }
      current.bindings.set(
        key,
        {
          providerAccountRefId: row.providerAccountRefId,
          providerAccountId: row.providerAccountId,
        },
      );
    }
    manifestBusinesses.set(row.businessId, current);
  }
  const allBusinesses = [...manifestBusinesses.values()].sort((left, right) =>
    left.businessId.localeCompare(right.businessId),
  );
  const bound = allBusinesses.filter((business) => business.bindings.size > 0);
  const unbound = allBusinesses.filter(
    (business) => business.bindings.size === 0,
  );
  const boundAccountCount = bound.reduce(
    (sum, business) => sum + business.bindings.size,
    0,
  );
  if (bound.length !== args.expectedBusinessCount) {
    blockers.push(
      `manifest:bound_business_count:${bound.length}:expected:${args.expectedBusinessCount}`,
    );
  }
  if (boundAccountCount !== args.expectedProviderAccountCount) {
    blockers.push(
      `manifest:bound_account_count:${boundAccountCount}:expected:${args.expectedProviderAccountCount}`,
    );
  }

  const selectorMatches = new Map<string, string>();
  const matchedUnboundIds = new Set<string>();
  for (const selector of args.expectedUnbound) {
    if (selectorMatches.has(selector)) {
      blockers.push(`manifest:duplicate_expected_unbound_selector:${selector}`);
      continue;
    }
    const matches = unbound.filter(
      (business) =>
        business.businessId === selector || business.businessName === selector,
    );
    if (matches.length !== 1) {
      blockers.push(
        `manifest:expected_unbound_selector_match_count:${selector}:${matches.length}`,
      );
      continue;
    }
    const businessId = matches[0]!.businessId;
    if (matchedUnboundIds.has(businessId)) {
      blockers.push(
        `manifest:expected_unbound_business_matched_twice:${businessId}`,
      );
    }
    selectorMatches.set(selector, businessId);
    matchedUnboundIds.add(businessId);
  }
  for (const business of unbound) {
    if (!matchedUnboundIds.has(business.businessId)) {
      blockers.push(
        `manifest:unexpected_unbound_business:${business.businessId}`,
      );
    }
  }
  if (matchedUnboundIds.size !== unbound.length) {
    blockers.push("manifest:expected_unbound_set_not_exact");
  }

  const businessReports: BusinessVerification[] = [];
  const manifestIds = new Set(allBusinesses.map((business) => business.businessId));
  const boundIds = new Set(bound.map((business) => business.businessId));
  const unboundIds = new Set(unbound.map((business) => business.businessId));

  for (const job of facts.jobs) {
    const started = timestampMs(job.startedAt);
    if (
      !manifestIds.has(job.businessRefId) ||
      started === null ||
      started < deployAnchorMs
    ) {
      continue;
    }
    if (unboundIds.has(job.businessRefId)) {
      blockers.push(`${job.businessRefId}:unbound_native_job_after_deploy`);
      continue;
    }
    if (!boundIds.has(job.businessRefId)) continue;
    if (
      job.businessId !== job.businessRefId ||
      job.asOf !== args.asOf ||
      job.engineVersion !== NATIVE_AD_ENGINE_VERSION
    ) {
      blockers.push(`${job.businessRefId}:post_deploy_job_epoch_or_lineage`);
    }
    const errorText = `${job.errorCode ?? ""} ${job.errorMessage ?? ""} ${JSON.stringify(
      job.errorJson ?? null,
    )}`;
    if (/statement[ _-]?timeout|canceling statement due to statement timeout/i.test(errorText)) {
      blockers.push(`${job.businessRefId}:statement_timeout_row`);
    }
    if (job.status === "failed" || job.status === "running") {
      blockers.push(`${job.businessRefId}:nonterminal_or_failed_job:${job.jobName}`);
    }
    if (job.status === "skipped" && !provenAdvisorySkip(job, facts.jobs)) {
      blockers.push(`${job.businessRefId}:unproven_skipped_job:${job.jobName}`);
    }
    const finished = timestampMs(job.finishedAt);
    if (
      !["running", "success", "failed", "skipped"].includes(job.status) ||
      (job.status !== "running" && finished === null) ||
      (job.status === "running" && finished !== null) ||
      (finished !== null && finished < started) ||
      (job.status === "success" &&
        (job.rowCount === null || job.rowCount < 0))
    ) {
      blockers.push(
        `${job.businessRefId}:malformed_or_stuck_job_terminal:${job.jobName}`,
      );
    }
  }

  const jobsById = new Map(facts.jobs.map((job) => [job.id, job]));
  const sourceRunsById = new Map(
    facts.sourceRuns.map((source) => [source.id, source]),
  );
  const batchesById = new Map(
    facts.calibrationBatches.map((batch) => [batch.id, batch]),
  );
  const operatorByJob = new Map(
    facts.operatorResponses.map((proof) => [proof.jobRunId, proof]),
  );

  for (const business of bound) {
    const businessBlockers: string[] = [];
    const bindings = [...business.bindings.values()].sort((left, right) =>
      bindingKey(
        left.providerAccountRefId,
        left.providerAccountId,
      ).localeCompare(
        bindingKey(right.providerAccountRefId, right.providerAccountId),
      ),
    );
    const bindingKeys = new Set(
      bindings.map((binding) =>
        bindingKey(binding.providerAccountRefId, binding.providerAccountId),
      ),
    );
    const calibration = latestSelectedJob(
      facts.jobs,
      business.businessId,
      AD_CALIBRATION_JOB_NAME,
      args.asOf,
      waveStartMs,
    );
    const decisions = latestSelectedJob(
      facts.jobs,
      business.businessId,
      AD_DECISIONS_JOB_NAME,
      args.asOf,
      waveStartMs,
    );
    const operator = latestSelectedJob(
      facts.jobs,
      business.businessId,
      AD_OPERATOR_RESPONSE_JOB_NAME,
      args.asOf,
      waveStartMs,
    );
    const selectedCalibrationCells = new Map<string, CalibrationCellFact>();
    if (calibration) {
      for (const receipt of (
        arrayAt(calibration.errorJson, "metadata", "batches") ?? []
      ).filter(isObject)) {
        const batchId = nullableString(receipt.batch_id);
        const batch = batchId ? batchesById.get(batchId) : null;
        if (!batch) continue;
        for (const cell of batch.cells) {
          selectedCalibrationCells.set(cell.id, cell);
        }
      }
    }
    for (const [name, job] of [
      [AD_CALIBRATION_JOB_NAME, calibration],
      [AD_DECISIONS_JOB_NAME, decisions],
      [AD_OPERATOR_RESPONSE_JOB_NAME, operator],
    ] as const) {
      if (
        job === null ||
        job.status !== "success" ||
        job.finishedAt === null ||
        job.rowCount === null ||
        job.rowCount < 0
      ) {
        append(
          blockers,
          businessBlockers,
          business.businessId,
          `latest_job_not_terminal_success:${name}`,
        );
      }
    }
    const calibrationFinished = timestampMs(calibration?.finishedAt ?? null);
    const decisionsStarted = timestampMs(decisions?.startedAt ?? null);
    const decisionsFinished = timestampMs(decisions?.finishedAt ?? null);
    const operatorStarted = timestampMs(operator?.startedAt ?? null);
    if (
      !calibration ||
      !decisions ||
      decisions.dependencyRunId !== calibration.id ||
      calibrationFinished === null ||
      decisionsStarted === null ||
      decisionsStarted < calibrationFinished
    ) {
      append(
        blockers,
        businessBlockers,
        business.businessId,
        "calibration_to_decisions_chain_invalid",
      );
    }
    if (
      !operator ||
      operator.dependencyRunId !== null ||
      decisionsFinished === null ||
      operatorStarted === null ||
      operatorStarted < decisionsFinished
    ) {
      append(
        blockers,
        businessBlockers,
        business.businessId,
        "decisions_to_operator_order_invalid",
      );
    }

    let decisionProof: BusinessVerification["decisionProof"] = null;
    if (decisions) {
      const snapshots = facts.snapshots.filter(
        (row) => row.jobRunId === decisions.id,
      );
      const evaluations = facts.evaluations.filter(
        (row) => row.jobRunId === decisions.id,
      );
      const contexts = facts.contexts.filter(
        (row) => row.jobRunId === decisions.id,
      );
      const evaluationsById = new Map(
        evaluations.map((row) => [row.id, row]),
      );
      const contextsById = new Map(contexts.map((row) => [row.id, row]));
      const snapshotEvaluationIds = new Set<string>();
      const referencedContextIds = new Set<string>();
      let lineageContradictions = 0;
      for (const snapshot of snapshots) {
        const evaluation = evaluationsById.get(snapshot.evaluationId);
        if (!evaluation || !exactLineageMatch(snapshot, evaluation)) {
          lineageContradictions += 1;
        } else {
          snapshotEvaluationIds.add(evaluation.id);
          const context = contextsById.get(evaluation.contextId);
          if (
            !context ||
            !canonicalEvaluationProofValid(context, evaluation, snapshot)
          ) {
            lineageContradictions += 1;
          }
        }
        if (
          !bindingKeys.has(
            bindingKey(
              snapshot.providerAccountRefId,
              snapshot.providerAccountId,
            ),
          ) ||
          snapshot.businessRefId !== business.businessId ||
          snapshot.businessId !== business.businessId ||
          snapshot.asOf !== args.asOf ||
          snapshot.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
          snapshot.decisionEntityType !== "ad" ||
          snapshot.decisionEntityId !== snapshot.adId ||
          (snapshot.calibrationRowId !== null &&
            (() => {
              const cell = selectedCalibrationCells.get(
                snapshot.calibrationRowId,
              );
              return (
                cell === undefined ||
                cell.businessId !== business.businessId ||
                cell.providerAccountRefId !==
                  snapshot.providerAccountRefId ||
                cell.providerAccountId !== snapshot.providerAccountId
              );
            })()) ||
          authorityContradiction(snapshot)
        ) {
          lineageContradictions += 1;
        }
      }
      for (const evaluation of evaluations) {
        const context = contextsById.get(evaluation.contextId);
        if (!context || !exactContextMatch(evaluation, context)) {
          lineageContradictions += 1;
        } else {
          referencedContextIds.add(context.id);
        }
        if (!snapshotEvaluationIds.has(evaluation.id)) {
          lineageContradictions += 1;
        }
      }
      for (const context of contexts) {
        if (!referencedContextIds.has(context.id)) {
          lineageContradictions += 1;
        }
      }
      if (
        decisions.rowCount !== snapshots.length ||
        decisions.rowCount !== evaluations.length ||
        snapshotEvaluationIds.size !== evaluations.length ||
        contexts.length !== referencedContextIds.size ||
        lineageContradictions !== 0
      ) {
        append(
          blockers,
          businessBlockers,
          business.businessId,
          "decision_snapshot_evaluation_context_lineage_invalid",
        );
      }

      const metadata = objectAt(decisions.errorJson, "metadata");
      const receiptValues = arrayAt(
        decisions.errorJson,
        "metadata",
        "hydration_receipts",
      );
      const receipts = (receiptValues ?? []).filter(isObject);
      const receiptManifests: NonNullable<
        BusinessVerification["decisionProof"]
      >["receiptManifests"] = [];
      let expectedAds = 0;
      let hydratedAds = 0;
      if (
        receiptValues === null ||
        receipts.length !== receiptValues.length ||
        receipts.length !== bindings.length
      ) {
        append(
          blockers,
          businessBlockers,
          business.businessId,
          "hydration_receipt_cardinality_invalid",
        );
      }
      const seenReceipts = new Set<string>();
      for (const receipt of receipts) {
        const accountRef = nullableString(
          receipt.provider_account_ref_id,
        );
        const accountId = nullableString(receipt.provider_account_id);
        const receiptKey =
          accountRef && accountId ? bindingKey(accountRef, accountId) : null;
        if (
          accountRef === null ||
          accountId === null ||
          receiptKey === null ||
          !bindingKeys.has(receiptKey) ||
          seenReceipts.has(receiptKey)
        ) {
          append(
            blockers,
            businessBlockers,
            business.businessId,
            "hydration_receipt_binding_invalid",
          );
          continue;
        }
        seenReceipts.add(receiptKey);
        const accountSnapshots = snapshots.filter(
          (snapshot) =>
            snapshot.providerAccountRefId === accountRef &&
            snapshot.providerAccountId === accountId,
        );
        const adIds = accountSnapshots.map((snapshot) => snapshot.adId).sort();
        const uniqueAdIds = new Set(adIds);
        const sourceManifestMatches = facts.sourceManifests.filter(
          (manifest) =>
            manifest.jobRunId === decisions.id &&
            manifest.businessRefId === business.businessId &&
            manifest.businessId === business.businessId &&
            manifest.providerAccountRefId === accountRef &&
            manifest.providerAccountId === accountId,
        );
        const sourceManifest =
          sourceManifestMatches.length === 1
            ? sourceManifestMatches[0]!
            : null;
        const expectedAdIds = sourceManifest?.expectedAdIds ?? [];
        let expectedManifestHash: string | null = null;
        let hydratedManifestHash: string | null = null;
        try {
          expectedManifestHash = hashAdDecisionIdentityManifest({
            businessId: business.businessId,
            providerAccountId: accountId,
            asOfDate: args.asOf,
            adIds: expectedAdIds,
          });
          hydratedManifestHash = hashAdDecisionIdentityManifest({
            businessId: business.businessId,
            providerAccountId: accountId,
            asOfDate: args.asOf,
            adIds,
          });
        } catch {
          expectedManifestHash = null;
          hydratedManifestHash = null;
        }
        const expectedCount = exactInteger(receipt.expected_ad_count);
        const hydratedCount = exactInteger(receipt.hydrated_ad_count);
        const sourceRunId = nullableString(receipt.source_run_id);
        const source = sourceRunId
          ? sourceRunsById.get(sourceRunId) ?? null
          : null;
        const decisionCutoff = nullableString(receipt.decision_cutoff);
        const cutoffMs = timestampMs(decisionCutoff);
        const decisionStarted = timestampMs(decisions.startedAt);
        const decisionFinished = timestampMs(decisions.finishedAt);
        const sourceExpected = exactInteger(
          receipt.source_expected_row_count,
        );
        const sourcePersisted = exactInteger(
          receipt.source_persisted_row_count,
        );
        expectedAds += expectedCount ?? 0;
        hydratedAds += hydratedCount ?? 0;
        receiptManifests.push({
          providerAccountRefId: accountRef,
          providerAccountId: accountId,
          expectedCount,
          hydratedCount,
          recomputedExpectedHash: expectedManifestHash,
          recomputedHydratedHash: hydratedManifestHash,
        });
        const receiptValid =
          uniqueAdIds.size === adIds.length &&
          new Set(expectedAdIds).size === expectedAdIds.length &&
          sourceManifest !== null &&
          sourceManifest.identityShapeValid &&
          expectedCount === expectedAdIds.length &&
          hydratedCount === adIds.length &&
          expectedManifestHash !== null &&
          hydratedManifestHash !== null &&
          receipt.expected_manifest_hash === expectedManifestHash &&
          receipt.hydrated_manifest_hash === hydratedManifestHash &&
          expectedManifestHash === hydratedManifestHash &&
          receipt.contract_version ===
            AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION &&
          receipt.authoritative_for_prune === true &&
          receipt.source_complete === true &&
          receipt.hydration_complete === true &&
          receipt.reason === null &&
          source !== null &&
          source.businessRefId === business.businessId &&
          source.businessId === business.businessId &&
          source.providerAccountRefId === accountRef &&
          source.providerAccountId === accountId &&
          source.entityType === "ad" &&
          source.completeness === "complete" &&
          sourceManifest.sourceRunId === source.id &&
          sameTimestamp(
            sourceManifest.sourceObservedAt,
            source.observedAt,
          ) &&
          sameTimestamp(
            sourceManifest.sourceCapturedAt,
            source.capturedAt,
          ) &&
          sourceManifest.sourceRunHash === source.runHash &&
          sourceManifest.sourcePayloadHash === source.payloadHash &&
          sourceManifest.sourceExpectedRowCount ===
            source.expectedRowCount &&
          sourceManifest.sourcePersistedRowCount ===
            source.persistedRowCount &&
          isSha256(source.runHash) &&
          receipt.source_run_hash === source.runHash &&
          receipt.source_payload_hash === source.payloadHash &&
          sourceExpected === source.expectedRowCount &&
          sourcePersisted === source.persistedRowCount &&
          sourceExpected === sourcePersisted &&
          sameTimestamp(receipt.source_observed_at, source.observedAt) &&
          sameTimestamp(receipt.source_captured_at, source.capturedAt) &&
          cutoffMs !== null &&
          decisionStarted !== null &&
          decisionFinished !== null &&
          cutoffMs >= decisionStarted &&
          cutoffMs <= decisionFinished &&
          timestampMs(source.observedAt)! <= cutoffMs &&
          timestampMs(source.capturedAt)! <= cutoffMs;
        if (!receiptValid) {
          append(
            blockers,
            businessBlockers,
            business.businessId,
            `hydration_receipt_proof_invalid:${accountId}`,
          );
        }
      }
      if (
        seenReceipts.size !== bindings.length ||
        metadataInteger(metadata, "authoritative_prune_receipt_count") !==
          bindings.length ||
        metadataInteger(metadata, "prune_skipped_unproven_receipt_count") !== 0
      ) {
        append(
          blockers,
          businessBlockers,
          business.businessId,
          "hydration_authority_totals_invalid",
        );
      }
      decisionProof = {
        snapshots: snapshots.length,
        evaluations: evaluations.length,
        contexts: contexts.length,
        distinctReferencedContexts: referencedContextIds.size,
        hydrationReceipts: receipts.length,
        expectedAds,
        hydratedAds,
        receiptManifests: receiptManifests.sort((left, right) =>
          bindingKey(
            left.providerAccountRefId,
            left.providerAccountId,
          ).localeCompare(
            bindingKey(
              right.providerAccountRefId,
              right.providerAccountId,
            ),
          ),
        ),
      };
    }

    let calibrationProof: BusinessVerification["calibrationProof"] = null;
    if (calibration) {
      const metadata = objectAt(calibration.errorJson, "metadata");
      const receiptValues = arrayAt(
        calibration.errorJson,
        "metadata",
        "batches",
      );
      const receipts = (receiptValues ?? []).filter(isObject);
      let totalExpectedCells = 0;
      let rowsWritten = 0;
      const seenBatches = new Set<string>();
      const seenBindings = new Set<string>();
      let calibrationInvalid =
        receiptValues === null ||
        receipts.length !== receiptValues.length ||
        receipts.length !== bindings.length;
      for (const receipt of receipts) {
        const batchId = nullableString(receipt.batch_id);
        const accountRef = nullableString(
          receipt.provider_account_ref_id,
        );
        const accountId = nullableString(receipt.provider_account_id);
        const batch = batchId ? batchesById.get(batchId) ?? null : null;
        const owner = batch ? jobsById.get(batch.jobRunId) ?? null : null;
        const receiptKey =
          accountRef && accountId ? bindingKey(accountRef, accountId) : null;
        if (
          batchId === null ||
          seenBatches.has(batchId) ||
          receiptKey === null ||
          seenBindings.has(receiptKey) ||
          !bindingKeys.has(receiptKey) ||
          batch === null ||
          owner === null
        ) {
          calibrationInvalid = true;
          continue;
        }
        seenBatches.add(batchId);
        seenBindings.add(receiptKey);
        totalExpectedCells += batch.expectedCellCount;
        if (batch.jobRunId === calibration.id) {
          rowsWritten += batch.expectedCellCount;
        }
        const ownerFinished = timestampMs(owner.finishedAt);
        const ownerStarted = timestampMs(owner.startedAt);
        const batchCutoff = timestampMs(batch.asOfCutoff);
        const batchCompleted = timestampMs(batch.completedAt);
        const selectedStarted = timestampMs(calibration.startedAt);
        const sourceProvenance = isObject(batch.sourceProvenance)
          ? batch.sourceProvenance
          : null;
        const batchValid =
          batch.businessRefId === business.businessId &&
          batch.businessId === business.businessId &&
          batch.providerAccountRefId === accountRef &&
          batch.providerAccountId === accountId &&
          batch.asOf === args.asOf &&
          batch.engineVersion === NATIVE_AD_ENGINE_VERSION &&
          batch.policyVersion === NATIVE_AD_CALIBRATION_POLICY_VERSION &&
          batch.transactionIsolation === "repeatable read" &&
          batch.sourceMode === "current_transaction_snapshot" &&
          sourceProvenance?.mode === batch.sourceMode &&
          sourceProvenance?.providerAccountRefId === accountRef &&
          sourceProvenance?.providerAccountId === accountId &&
          sourceProvenance?.transactionIsolation ===
            batch.transactionIsolation &&
          typeof sourceProvenance?.transactionCutoff === "string" &&
          sameTimestamp(
            sourceProvenance.transactionCutoff,
            batch.asOfCutoff,
          ) &&
          batch.completenessStatus === "complete" &&
          batch.completedAt !== null &&
          sameTimestamp(batch.computedAt, batch.asOfCutoff) &&
          isSha256(batch.generationContentHash) &&
          isSha256(batch.inputManifestHash) &&
          isSha256(batch.sourceManifestHash) &&
          isSha256(batch.cellSetHash) &&
          receipt.generation_content_hash === batch.generationContentHash &&
          receipt.input_manifest_hash === batch.inputManifestHash &&
          receipt.source_manifest_hash === batch.sourceManifestHash &&
          receipt.cell_set_hash === batch.cellSetHash &&
          batch.expectedCellCount === batch.cells.length &&
          calibrationCellSetHash(batch) === batch.cellSetHash &&
          owner.jobName === AD_CALIBRATION_JOB_NAME &&
          owner.businessRefId === business.businessId &&
          owner.businessId === business.businessId &&
          owner.asOf === args.asOf &&
          owner.engineVersion === NATIVE_AD_ENGINE_VERSION &&
          owner.status === "success" &&
          ownerFinished !== null &&
          ownerStarted !== null &&
          batchCutoff !== null &&
          batchCompleted !== null &&
          batchCutoff <= ownerFinished &&
          batchCompleted <= ownerFinished &&
          batchCompleted >= batchCutoff &&
          batch.asOfCutoff.slice(0, 10) === args.asOf &&
          (owner.id === calibration.id ||
            (selectedStarted !== null && ownerFinished <= selectedStarted)) &&
          batch.cells.every(
            (cell) =>
              cell.batchId === batch.id &&
              cell.jobRunId === batch.jobRunId &&
              cell.businessId === business.businessId &&
              cell.providerAccountRefId === accountRef &&
              cell.providerAccountId === accountId &&
              cell.batchInputManifestHash === batch.inputManifestHash &&
              cell.sourceManifestHash === batch.sourceManifestHash &&
              isSha256(cell.inputManifestHash),
          );
        if (!batchValid) calibrationInvalid = true;
      }
      if (
        seenBatches.size !== bindings.length ||
        seenBindings.size !== bindings.length ||
        totalExpectedCells !== calibration.rowCount ||
        metadataInteger(metadata, "provider_account_count") !==
          bindings.length ||
        metadataInteger(metadata, "expected_cell_count") !==
          totalExpectedCells ||
        metadataInteger(metadata, "rows_written") !== rowsWritten
      ) {
        calibrationInvalid = true;
      }
      if (calibrationInvalid) {
        append(
          blockers,
          businessBlockers,
          business.businessId,
          "calibration_receipt_batch_cell_proof_invalid",
        );
      }
      calibrationProof = {
        batches: seenBatches.size,
        cells: totalExpectedCells,
        rowsWritten: metadataInteger(metadata, "rows_written"),
      };
    }

    let operatorProof: BusinessVerification["operatorProof"] = null;
    if (operator) {
      const metadata = objectAt(operator.errorJson, "metadata");
      const proof = operatorByJob.get(operator.id);
      const episodesByKey = new Map(
        (proof?.episodes ?? []).map((episode) => [
          episode.episodeKey,
          episode,
        ]),
      );
      const responseKeys = new Set<string>();
      let operatorHashOrLineageInvalid = false;
      for (const response of proof?.responses ?? []) {
        const key = setKey(response.episodeKey, response.responseCutoff);
        if (responseKeys.has(key)) operatorHashOrLineageInvalid = true;
        responseKeys.add(key);
        const responseEvents = (proof?.events ?? []).filter(
          (event) =>
            event.episodeKey === response.episodeKey &&
            timestampMs(event.responseCutoff) ===
              timestampMs(response.responseCutoff),
        );
        if (
          !operatorResponseProofValid(
            response,
            episodesByKey.get(response.episodeKey),
            responseEvents,
          )
        ) {
          operatorHashOrLineageInvalid = true;
        }
      }
      const referencedEpisodeKeys = new Set(
        (proof?.responses ?? []).map((response) => response.episodeKey),
      );
      const episodesCaptured =
        proof?.episodes.filter((episode) => episode.jobRunId === operator.id)
          .length ?? -1;
      const episodesEvaluated = proof?.responses.length ?? -1;
      const evidenceEvents = proof?.events.length ?? -1;
      if (
        proof === undefined ||
        proof.lineageContradictionCount !== 0 ||
        proof.responseCount !== proof.responses.length ||
        proof.responseCount !== operator.rowCount ||
        proof.episodes.some(
          (episode) =>
            !referencedEpisodeKeys.has(episode.episodeKey) ||
            !operatorEpisodeProofValid(episode),
        ) ||
        proof.events.some(
          (event) =>
            !responseKeys.has(
              setKey(event.episodeKey, event.responseCutoff),
            ),
        ) ||
        operatorHashOrLineageInvalid ||
        metadataInteger(metadata, "episodes_captured") !== episodesCaptured ||
        metadataInteger(metadata, "episodes_evaluated") !==
          episodesEvaluated ||
        metadataInteger(metadata, "evidence_events_written") !==
          evidenceEvents ||
        (metadataInteger(metadata, "evidence_events_pruned") ?? -1) < 0 ||
        metadataInteger(metadata, "responses_written") !== proof.responseCount
      ) {
        append(
          blockers,
          businessBlockers,
          business.businessId,
          "operator_response_count_or_lineage_invalid",
        );
      }
      operatorProof = {
        episodesCaptured,
        episodesEvaluated,
        evidenceEvents,
        responses: proof?.responseCount ?? -1,
      };
    }

    businessReports.push({
      businessId: business.businessId,
      businessName: business.businessName,
      bindings,
      jobs: {
        [AD_CALIBRATION_JOB_NAME]: nativeJobSummary(calibration),
        [AD_DECISIONS_JOB_NAME]: nativeJobSummary(decisions),
        [AD_OPERATOR_RESPONSE_JOB_NAME]: nativeJobSummary(operator),
      },
      decisionProof,
      calibrationProof,
      operatorProof,
      blockers: [...new Set(businessBlockers)].sort(),
    });
  }

  const uniqueBlockers = [...new Set(blockers)].sort();
  const schedulerManifestHash = canonicalSha256({
    limit: NATIVE_AD_SCHEDULER_MANIFEST_LIMIT,
    envDefaultEnabled: args.envDefaultEnabled,
    rows: facts.manifest
      .map((row) => ({
        businessId: row.businessId,
        businessName: row.businessName,
        createdAt: row.createdAt,
        providerAccountRefId: row.providerAccountRefId,
        providerAccountId: row.providerAccountId,
      }))
      .sort((left, right) =>
        setKey(
          left.businessId,
          left.providerAccountRefId ?? "",
          left.providerAccountId ?? "",
        ).localeCompare(
          setKey(
            right.businessId,
            right.providerAccountRefId ?? "",
            right.providerAccountId ?? "",
          ),
        ),
      ),
  });
  const failureCounts = new Map<string, number>();
  for (const blocker of uniqueBlockers) {
    const segments = blocker.split(":");
    const code =
      segments[0] === "manifest" || segments[0] === "session"
        ? segments.slice(0, 2).join(":")
        : (segments[1] ?? blocker);
    failureCounts.set(code, (failureCounts.get(code) ?? 0) + 1);
  }
  return {
    schemaVersion: "native-ad-natural-wave-operational-verification.v1",
    result: uniqueBlockers.length === 0 ? "pass" : "fail",
    parameters: {
      asOf: args.asOf,
      deployAnchor: args.deployAnchor,
      waveStart,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      expectedBusinessCount: args.expectedBusinessCount,
      expectedProviderAccountCount: args.expectedProviderAccountCount,
      expectedUnbound: [...args.expectedUnbound].sort(),
      envDefaultEnabled: args.envDefaultEnabled,
    },
    session: facts.readOnlySession,
    schedulerManifest: {
      limit: NATIVE_AD_SCHEDULER_MANIFEST_LIMIT,
      envEnabledDefault: facts.envEnabledDefault,
      businessCount: allBusinesses.length,
      boundBusinessCount: bound.length,
      boundAccountCount,
      unboundBusinesses: unbound
        .map((business) => ({
          businessId: business.businessId,
          businessName: business.businessName,
        }))
        .sort((left, right) => left.businessId.localeCompare(right.businessId)),
    },
    businesses: businessReports.sort((left, right) =>
      left.businessId.localeCompare(right.businessId),
    ),
    proofInventory: {
      schedulerManifestHash,
      jobRowsLoaded: facts.jobs.length,
      contexts: facts.contexts.length,
      evaluations: facts.evaluations.length,
      snapshots: facts.snapshots.length,
      sourceManifests: facts.sourceManifests.length,
      sourceRuns: facts.sourceRuns.length,
      calibrationBatches: facts.calibrationBatches.length,
      calibrationCells: facts.calibrationBatches.reduce(
        (sum, batch) => sum + batch.cells.length,
        0,
      ),
      operatorEpisodes: facts.operatorResponses.reduce(
        (sum, proof) => sum + proof.episodes.length,
        0,
      ),
      operatorEvents: facts.operatorResponses.reduce(
        (sum, proof) => sum + proof.events.length,
        0,
      ),
      operatorResponses: facts.operatorResponses.reduce(
        (sum, proof) => sum + proof.responses.length,
        0,
      ),
    },
    failureInventory: {
      count: uniqueBlockers.length,
      codes: [...failureCounts.entries()]
        .map(([code, count]) => ({ code, count }))
        .sort((left, right) => left.code.localeCompare(right.code)),
    },
    blockers: uniqueBlockers,
  };
}

function stringRow(row: QueryResultRow, key: string): string {
  return requiredString(row[key], key);
}

function queryRows<TResult extends QueryResultRow>(
  client: Client,
  sql: string,
  parameters: unknown[],
): Promise<TResult[]> {
  return client.query<TResult>(sql, parameters).then((result) => result.rows);
}

function successJobIds(
  jobs: readonly JobRunFact[],
  jobName: NativeJobName,
  asOf: string,
): string[] {
  return jobs
    .filter(
      (job) =>
        job.jobName === jobName &&
        job.asOf === asOf &&
        job.engineVersion === NATIVE_AD_ENGINE_VERSION &&
        job.status === "success",
    )
    .map((job) => job.id)
    .sort();
}

function receiptIds(
  jobs: readonly JobRunFact[],
  jobName: NativeJobName,
  path: string[],
  key: string,
): string[] {
  const ids = new Set<string>();
  for (const job of jobs) {
    if (
      job.jobName !== jobName ||
      job.engineVersion !== NATIVE_AD_ENGINE_VERSION ||
      job.status !== "success"
    ) {
      continue;
    }
    for (const receipt of arrayAt(job.errorJson, ...path) ?? []) {
      if (!isObject(receipt)) continue;
      const id = nullableString(receipt[key]);
      if (id) ids.add(id);
    }
  }
  return [...ids].sort();
}

export async function loadOperationalFacts(
  client: Client,
  args: VerifierArgs,
  envEnabledDefault: boolean,
): Promise<OperationalFacts> {
  const [sessionRow] = await queryRows(client, SESSION_PROOF_SQL, []);
  if (!sessionRow) throw new Error("Read-only session proof returned no row.");
  const manifestRows = await queryRows(
    client,
    SCHEDULER_MANIFEST_SQL,
    [envEnabledDefault],
  );
  const manifest: SchedulerManifestFact[] = manifestRows.map((row) => ({
    businessId: stringRow(row, "business_id"),
    businessName: stringRow(row, "business_name"),
    createdAt: stringRow(row, "created_at"),
    providerAccountRefId: nullableString(row.provider_account_ref_id),
    providerAccountId: nullableString(row.provider_account_id),
  }));
  const businessIds = [...new Set(manifest.map((row) => row.businessId))];
  const jobRows =
    businessIds.length === 0
      ? []
      : await queryRows(client, JOB_RUNS_SQL, [
          businessIds,
          NATIVE_AD_OPERATIONAL_JOB_NAMES,
          args.asOf,
          args.deployAnchor,
        ]);
  const jobs: JobRunFact[] = jobRows.map((row) => ({
    id: stringRow(row, "id"),
    jobName: stringRow(row, "job_name"),
    businessRefId: stringRow(row, "business_ref_id"),
    businessId: nullableString(row.business_id),
    asOf: stringRow(row, "as_of_date"),
    engineVersion: stringRow(row, "engine_version"),
    status: stringRow(row, "status"),
    dependencyRunId: nullableString(row.dependency_run_id),
    startedAt: stringRow(row, "started_at"),
    finishedAt: nullableString(row.finished_at),
    rowCount: exactInteger(row.row_count),
    errorCode: nullableString(row.error_code),
    errorMessage: nullableString(row.error_message),
    errorJson: row.error_json,
  }));

  const decisionIds = successJobIds(jobs, AD_DECISIONS_JOB_NAME, args.asOf);
  const [contextRows, evaluationRows, snapshotRows] =
    decisionIds.length === 0
      ? [[], [], []]
      : await Promise.all([
          queryRows(client, CONTEXTS_SQL, [decisionIds]),
          queryRows(client, EVALUATIONS_SQL, [decisionIds]),
          queryRows(client, SNAPSHOTS_SQL, [decisionIds]),
        ]);
  const contexts: DecisionContextFact[] = contextRows.map((row) => ({
    id: stringRow(row, "id"),
    businessRefId: stringRow(row, "business_ref_id"),
    businessId: stringRow(row, "business_id"),
    providerAccountRefId: stringRow(row, "provider_account_ref_id"),
    providerAccountId: stringRow(row, "provider_account_id"),
    asOf: stringRow(row, "as_of_date"),
    engineVersion: stringRow(row, "engine_version"),
    scopeType: stringRow(row, "scope_type"),
    scopeId: stringRow(row, "scope_id"),
    contractVersion: stringRow(row, "contract_version"),
    contextJson: row.context_json,
    accountProfileJson: row.account_profile_json,
    dataHealthJson: row.data_health_json,
    flagsJson: row.flags_json,
    contextHash: stringRow(row, "context_hash"),
    jobRunId: stringRow(row, "job_run_id"),
  }));
  const evaluations: DecisionEvaluationFact[] = evaluationRows.map((row) => ({
    id: stringRow(row, "id"),
    contextId: stringRow(row, "context_id"),
    businessRefId: stringRow(row, "business_ref_id"),
    businessId: stringRow(row, "business_id"),
    providerAccountRefId: stringRow(row, "provider_account_ref_id"),
    providerAccountId: stringRow(row, "provider_account_id"),
    decisionEntityType: stringRow(row, "decision_entity_type"),
    decisionEntityId: stringRow(row, "decision_entity_id"),
    adId: stringRow(row, "ad_id"),
    creativeId: nullableString(row.creative_id),
    asOf: stringRow(row, "as_of_date"),
    engineVersion: stringRow(row, "engine_version"),
    scopeType: stringRow(row, "scope_type"),
    scopeId: stringRow(row, "scope_id"),
    contractVersion: stringRow(row, "contract_version"),
    creativeInputJson: row.creative_input_json,
    campaignContextJson: row.campaign_context_json,
    priorHysteresisJson: row.prior_hysteresis_json,
    decisionOutputJson: row.decision_output_json,
    rawLabel: stringRow(row, "raw_label"),
    hysteresisSuppressed: row.hysteresis_suppressed === true,
    inputHash: stringRow(row, "input_hash"),
    decisionHash: stringRow(row, "decision_hash"),
    jobRunId: stringRow(row, "job_run_id"),
  }));
  const snapshots: DecisionSnapshotFact[] = snapshotRows.map((row) => ({
    id: stringRow(row, "id"),
    evaluationId: stringRow(row, "evaluation_id"),
    businessRefId: stringRow(row, "business_ref_id"),
    businessId: stringRow(row, "business_id"),
    providerAccountRefId: stringRow(row, "provider_account_ref_id"),
    providerAccountId: stringRow(row, "provider_account_id"),
    decisionEntityType: stringRow(row, "decision_entity_type"),
    decisionEntityId: stringRow(row, "decision_entity_id"),
    adId: stringRow(row, "ad_id"),
    creativeId: nullableString(row.creative_id),
    asOf: stringRow(row, "as_of_date"),
    engineVersion: stringRow(row, "engine_version"),
    scopeType: stringRow(row, "scope_type"),
    scopeId: stringRow(row, "scope_id"),
    inputHash: stringRow(row, "input_hash"),
    decisionHash: stringRow(row, "decision_hash"),
    label: stringRow(row, "label"),
    rawLabel: stringRow(row, "raw_label"),
    preAuthorityLabel: nullableString(row.pre_authority_label),
    authorityBlocker: nullableString(row.authority_blocker),
    confidence: exactInteger(row.confidence) ?? -1,
    truthSource: stringRow(row, "truth_source"),
    effectiveTargetRoas: nullableNumber(row.effective_target_roas) ?? -1,
    ratioToTarget: nullableNumber(row.ratio_to_target),
    badges: row.badges,
    reason: stringRow(row, "reason"),
    spend: nullableNumber(row.spend),
    purchases: nullableNumber(row.purchases),
    roas: nullableNumber(row.roas),
    recent7dRoas: nullableNumber(row.recent7d_roas),
    labelTransform: nullableString(row.label_transform),
    blockedActionType: nullableString(row.blocked_action_type),
    authorizedAction: nullableString(row.authorized_action),
    calibrationRowId: nullableString(row.calibration_row_id),
    jobRunId: stringRow(row, "job_run_id"),
  }));

  const sourceManifests: SourceManifestFact[] = [];
  for (const decisionJob of jobs.filter(
    (job) =>
      job.jobName === AD_DECISIONS_JOB_NAME &&
      job.asOf === args.asOf &&
      job.engineVersion === NATIVE_AD_ENGINE_VERSION &&
      job.status === "success",
  )) {
    const receipts =
      arrayAt(
        decisionJob.errorJson,
        "metadata",
        "hydration_receipts",
      )?.filter(isObject) ?? [];
    const cutoffs = new Set(
      receipts.flatMap((receipt) => {
        const cutoff = nullableString(receipt.decision_cutoff);
        return cutoff ? [cutoff] : [];
      }),
    );
    if (receipts.length === 0 || cutoffs.size !== 1) continue;
    const cutoff = [...cutoffs][0]!;
    const rows = await queryRows(
      client,
      READ_AD_HYDRATION_COMPLETENESS_RECEIPTS_QUERY,
      [decisionJob.businessRefId, args.asOf, cutoff, [], false],
    );
    for (const row of rows) {
      const rawAdIds = row.expected_ad_ids;
      const identityShapeValid =
        Array.isArray(rawAdIds) &&
        rawAdIds.every(
          (value) => typeof value === "string" && value.trim() !== "",
        );
      sourceManifests.push({
        jobRunId: decisionJob.id,
        businessRefId: stringRow(row, "business_ref_id"),
        businessId: stringRow(row, "business_id"),
        providerAccountRefId: stringRow(
          row,
          "provider_account_ref_id",
        ),
        providerAccountId: stringRow(row, "provider_account_id"),
        sourceRunId: nullableString(row.source_run_id),
        sourceObservedAt: nullableString(row.source_observed_at),
        sourceCapturedAt: nullableString(row.source_captured_at),
        sourceRunHash: nullableString(row.source_run_hash),
        sourcePayloadHash: nullableString(row.source_payload_hash),
        sourceExpectedRowCount: exactInteger(
          row.source_expected_row_count,
        ),
        sourcePersistedRowCount: exactInteger(
          row.source_persisted_row_count,
        ),
        expectedAdIds: identityShapeValid
          ? (rawAdIds as string[]).map((value) => value.trim())
          : [],
        identityShapeValid,
      });
    }
  }

  const sourceRunIds = receiptIds(
    jobs,
    AD_DECISIONS_JOB_NAME,
    ["metadata", "hydration_receipts"],
    "source_run_id",
  );
  const sourceRows =
    sourceRunIds.length === 0
      ? []
      : await queryRows(client, SOURCE_RUNS_SQL, [sourceRunIds]);
  const sourceRuns: SourceRunFact[] = sourceRows.map((row) => ({
    id: stringRow(row, "id"),
    businessRefId: stringRow(row, "business_ref_id"),
    businessId: stringRow(row, "business_id"),
    providerAccountRefId: stringRow(row, "provider_account_ref_id"),
    providerAccountId: stringRow(row, "provider_account_id"),
    entityType: stringRow(row, "entity_type"),
    completeness: stringRow(row, "completeness"),
    observedAt: stringRow(row, "observed_at"),
    capturedAt: stringRow(row, "captured_at"),
    runHash: nullableString(row.run_hash),
    payloadHash: nullableString(row.payload_hash),
    expectedRowCount: exactInteger(row.expected_row_count),
    persistedRowCount: exactInteger(row.persisted_row_count) ?? -1,
  }));

  const batchIds = receiptIds(
    jobs,
    AD_CALIBRATION_JOB_NAME,
    ["metadata", "batches"],
    "batch_id",
  );
  const [batchRows, cellRows] =
    batchIds.length === 0
      ? [[], []]
      : await Promise.all([
          queryRows(client, CALIBRATION_BATCHES_SQL, [batchIds]),
          queryRows(client, CALIBRATION_CELLS_SQL, [batchIds]),
        ]);
  const cells: CalibrationCellFact[] = cellRows.map((row) => ({
    id: stringRow(row, "id"),
    batchId: stringRow(row, "batch_id"),
    jobRunId: stringRow(row, "job_run_id"),
    businessId: stringRow(row, "business_id"),
    providerAccountRefId: stringRow(row, "provider_account_ref_id"),
    providerAccountId: stringRow(row, "provider_account_id"),
    accountTimezone: stringRow(row, "account_timezone"),
    accountCurrency: stringRow(row, "account_currency"),
    cellScope: stringRow(row, "cell_scope"),
    objective: stringRow(row, "objective"),
    funnelCohort: stringRow(row, "funnel_cohort"),
    optimizationContext: stringRow(row, "optimization_context"),
    batchInputManifestHash: stringRow(row, "batch_input_manifest_hash"),
    inputManifestHash: stringRow(row, "input_manifest_hash"),
    sourceManifestHash: stringRow(row, "source_manifest_hash"),
  }));
  const calibrationBatches: CalibrationBatchFact[] = batchRows.map((row) => {
    const id = stringRow(row, "id");
    return {
      id,
      businessRefId: stringRow(row, "business_ref_id"),
      businessId: stringRow(row, "business_id"),
      providerAccountRefId: stringRow(row, "provider_account_ref_id"),
      providerAccountId: stringRow(row, "provider_account_id"),
      asOf: stringRow(row, "as_of_date"),
      asOfCutoff: stringRow(row, "as_of_cutoff"),
      transactionIsolation: stringRow(row, "transaction_isolation"),
      engineVersion: stringRow(row, "engine_version"),
      policyVersion: stringRow(row, "policy_version"),
      sourceMode: stringRow(row, "source_mode"),
      sourceProvenance: row.source_provenance_json,
      expectedCellCount: exactInteger(row.expected_cell_count) ?? -1,
      generationContentHash: stringRow(row, "generation_content_hash"),
      inputManifestHash: stringRow(row, "input_manifest_hash"),
      sourceManifestHash: stringRow(row, "source_manifest_hash"),
      cellSetHash: stringRow(row, "cell_set_hash"),
      completenessStatus: stringRow(row, "completeness_status"),
      jobRunId: stringRow(row, "job_run_id"),
      computedAt: stringRow(row, "computed_at"),
      completedAt: nullableString(row.completed_at),
      cells: cells.filter((cell) => cell.batchId === id),
    };
  });

  const operatorIds = successJobIds(
    jobs,
    AD_OPERATOR_RESPONSE_JOB_NAME,
    args.asOf,
  );
  const [operatorRows, episodeRows, eventRows, responseRows] =
    operatorIds.length === 0
      ? [[], [], [], []]
      : await Promise.all([
          queryRows(client, OPERATOR_RESPONSES_SQL, [operatorIds]),
          queryRows(client, OPERATOR_EPISODES_SQL, [operatorIds]),
          queryRows(client, OPERATOR_EVENTS_SQL, [operatorIds]),
          queryRows(client, OPERATOR_RESPONSE_ROWS_SQL, [operatorIds]),
        ]);
  const operatorEpisodes: OperatorEpisodeFact[] = episodeRows.map((row) => ({
    episodeKey: stringRow(row, "episode_key"),
    contractVersion: stringRow(row, "contract_version"),
    businessRefId: stringRow(row, "business_ref_id"),
    businessId: stringRow(row, "business_id"),
    providerAccountRefId: stringRow(row, "provider_account_ref_id"),
    providerAccountId: stringRow(row, "provider_account_id"),
    decisionEntityType: stringRow(row, "decision_entity_type"),
    decisionEntityId: stringRow(row, "decision_entity_id"),
    adId: stringRow(row, "ad_id"),
    creativeId: nullableString(row.creative_id),
    asOf: stringRow(row, "as_of_date"),
    engineVersion: stringRow(row, "engine_version"),
    scopeType: stringRow(row, "scope_type"),
    scopeId: stringRow(row, "scope_id"),
    decisionSnapshotId: stringRow(row, "decision_snapshot_id"),
    evaluationId: stringRow(row, "evaluation_id"),
    inputHash: stringRow(row, "input_hash"),
    decisionHash: stringRow(row, "decision_hash"),
    decisionLabel: stringRow(row, "decision_label"),
    sourceCampaignId: nullableString(row.source_campaign_id),
    sourceAdsetId: nullableString(row.source_adset_id),
    parentSnapshotCreativeId: nullableString(
      row.parent_snapshot_creative_id,
    ),
    parentSnapshotLabel: nullableString(row.parent_snapshot_label),
    parentEvaluationCreativeId: nullableString(
      row.parent_evaluation_creative_id,
    ),
    parentInputCampaignId: nullableString(
      row.parent_input_campaign_id,
    ),
    parentInputAdsetId: nullableString(row.parent_input_adset_id),
    parentContextCampaignId: nullableString(
      row.parent_context_campaign_id,
    ),
    recommendedAt: normalizeTimestamp(
      stringRow(row, "recommended_at"),
      "recommended_at",
    ),
    jobRunId: stringRow(row, "job_run_id"),
    lineageValid: row.lineage_valid === true,
  }));
  const operatorEvents: OperatorEventFact[] = eventRows.map((row) => ({
    jobRunId: stringRow(row, "job_run_id"),
    episodeKey: stringRow(row, "episode_key"),
    businessRefId: stringRow(row, "business_ref_id"),
    businessId: stringRow(row, "business_id"),
    providerAccountRefId: stringRow(row, "provider_account_ref_id"),
    providerAccountId: stringRow(row, "provider_account_id"),
    responseCutoff: normalizeTimestamp(
      stringRow(row, "response_cutoff"),
      "response_cutoff",
    ),
    contractVersion: stringRow(row, "contract_version"),
    evidenceKind: stringRow(row, "evidence_kind"),
    evidenceSourceId: stringRow(row, "evidence_source_id"),
    actionReceiptId: nullableString(row.action_receipt_id),
    stateHistoryId: nullableString(row.state_history_id),
    tombstoneId: nullableString(row.tombstone_id),
    evidenceObservedAt: normalizeTimestamp(
      stringRow(row, "evidence_observed_at"),
      "evidence_observed_at",
    ),
    evidenceCapturedAt: normalizeTimestamp(
      stringRow(row, "evidence_captured_at"),
      "evidence_captured_at",
    ),
    treatmentEligible: row.treatment_eligible === true,
    diagnosticCode: nullableString(row.diagnostic_code),
    evidenceJson: row.evidence_json,
    evidenceHash: stringRow(row, "evidence_hash"),
  }));
  const operatorResponseRows: OperatorResponseFact[] = responseRows.map(
    (row) => ({
      jobRunId: stringRow(row, "job_run_id"),
      episodeKey: stringRow(row, "episode_key"),
      businessRefId: stringRow(row, "business_ref_id"),
      businessId: stringRow(row, "business_id"),
      providerAccountRefId: stringRow(row, "provider_account_ref_id"),
      providerAccountId: stringRow(row, "provider_account_id"),
      contractVersion: stringRow(row, "contract_version"),
      responseCutoff: normalizeTimestamp(
        stringRow(row, "response_cutoff"),
        "response_cutoff",
      ),
      observationStatus: stringRow(row, "observation_status"),
      responseType: stringRow(row, "response_type"),
      operatorResponseDetected: row.operator_response_detected === true,
      adTreatmentDetected: row.ad_treatment_detected === true,
      detectedAt: nullableString(row.detected_at)
        ? normalizeTimestamp(stringRow(row, "detected_at"), "detected_at")
        : null,
      actionReceiptId: nullableString(row.action_receipt_id),
      actionLogId: nullableString(row.action_log_id),
      successorAdId: nullableString(row.successor_ad_id),
      successorKind: nullableString(row.successor_kind),
      budgetOwnerType: nullableString(row.budget_owner_type),
      budgetOwnerId: nullableString(row.budget_owner_id),
      windowStart: normalizeTimestamp(
        stringRow(row, "window_start"),
        "window_start",
      ),
      windowEnd: normalizeTimestamp(
        stringRow(row, "window_end"),
        "window_end",
      ),
      windowClosed: row.window_closed === true,
      sourceComplete: row.source_complete === true,
      sourceSetHash: stringRow(row, "source_set_hash"),
      actionReceiptCount: exactInteger(row.action_receipt_count) ?? -1,
      stateObservationCount:
        exactInteger(row.state_observation_count) ?? -1,
      tombstoneObservationCount:
        exactInteger(row.tombstone_observation_count) ?? -1,
      requiredStateTargetCount:
        exactInteger(row.required_state_target_count) ?? -1,
      completeStateTargetCount:
        exactInteger(row.complete_state_target_count) ?? -1,
      diagnosticsJson: row.diagnostics_json,
      evidenceHashesJson: row.evidence_hashes_json,
      evidenceCount: exactInteger(row.evidence_count) ?? -1,
      evidenceSetHash: stringRow(row, "evidence_set_hash"),
      replacementSetHash: stringRow(row, "replacement_set_hash"),
      responseHash: stringRow(row, "response_hash"),
    }),
  );
  const operatorResponses: OperatorResponseProofFact[] = operatorRows.map(
    (row) => ({
      jobRunId: stringRow(row, "job_run_id"),
      responseCount: exactInteger(row.response_count) ?? -1,
      lineageContradictionCount:
        exactInteger(row.lineage_contradiction_count) ?? -1,
      episodes: operatorEpisodes.filter((episode) =>
        operatorResponseRows.some(
          (response) =>
            response.jobRunId === stringRow(row, "job_run_id") &&
            response.episodeKey === episode.episodeKey,
        ),
      ),
      events: operatorEvents.filter(
        (event) => event.jobRunId === stringRow(row, "job_run_id"),
      ),
      responses: operatorResponseRows.filter(
        (response) => response.jobRunId === stringRow(row, "job_run_id"),
      ),
    }),
  );

  return {
    readOnlySession: {
      observedAt: stringRow(sessionRow, "observed_at"),
      transactionReadOnly: stringRow(sessionRow, "transaction_read_only"),
      defaultTransactionReadOnly: stringRow(
        sessionRow,
        "default_transaction_read_only",
      ),
      transactionIsolation: stringRow(
        sessionRow,
        "transaction_isolation",
      ),
      statementTimeout: stringRow(sessionRow, "statement_timeout"),
      applicationName: stringRow(sessionRow, "application_name"),
    },
    envEnabledDefault,
    manifest,
    jobs,
    contexts,
    evaluations,
    snapshots,
    sourceManifests,
    sourceRuns,
    calibrationBatches,
    operatorResponses,
  };
}

function stableJsonValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableJsonValue);
  if (isObject(value)) {
    return Object.fromEntries(
      Object.keys(value)
        .sort()
        .map((key) => [key, stableJsonValue(value[key])]),
    );
  }
  return value;
}

export function deterministicJson(value: unknown): string {
  return `${JSON.stringify(stableJsonValue(value), null, 2)}\n`;
}

export async function writeVerificationArtifact(
  outputPath: string,
  report: OperationalVerificationReport,
): Promise<{ outputPath: string; sidecarPath: string; sha256: string }> {
  const safePath = safeOutputPath(outputPath, report.parameters.asOf);
  const json = deterministicJson(report);
  const sha256 = createHash("sha256").update(json).digest("hex");
  const sidecarPath = `${safePath}.sha256`;
  await writeFile(safePath, json, { encoding: "utf8", flag: "w" });
  await writeFile(sidecarPath, `${sha256}  ${basename(safePath)}\n`, {
    encoding: "utf8",
    flag: "w",
  });
  return { outputPath: safePath, sidecarPath, sha256 };
}

async function main() {
  const args = parseVerifierArgs(process.argv.slice(2));
  const environment = assertLiveReadOnlyEnvironment(process.env);
  if (dirname(args.outputPath) === "/") {
    throw new Error("Refusing unsafe output directory.");
  }
  const client = new Client({
    connectionString: environment.connectionString,
    application_name: environment.applicationName,
  });
  let transactionOpen = false;
  try {
    await client.connect();
    await client.query(READ_ONLY_BEGIN_SQL);
    transactionOpen = true;
    await client.query(READ_ONLY_TIMEOUT_SQL);
    const facts = await loadOperationalFacts(
      client,
      args,
      args.envDefaultEnabled,
    );
    await client.query(READ_ONLY_ROLLBACK_SQL);
    transactionOpen = false;
    const report = evaluateOperationalFacts(args, facts);
    const artifact = await writeVerificationArtifact(args.outputPath, report);
    process.stdout.write(
      `${JSON.stringify({
        result: report.result,
        blockerCount: report.blockers.length,
        ...artifact,
      })}\n`,
    );
    if (report.result !== "pass") process.exitCode = 1;
  } finally {
    if (transactionOpen) {
      await client.query(READ_ONLY_ROLLBACK_SQL).catch(() => undefined);
    }
    await client.end().catch(() => undefined);
  }
}

const invokedPath = process.argv[1]
  ? pathToFileURL(resolve(process.argv[1])).href
  : null;
if (invokedPath === import.meta.url) {
  main().catch((error) => {
    process.stderr.write(
      `[native-ad-natural-wave-operational-verifier] ${
        error instanceof Error ? error.message : String(error)
      }\n`,
    );
    process.exitCode = 1;
  });
}
