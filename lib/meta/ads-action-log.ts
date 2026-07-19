import { randomUUID } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { getDb, runDbTransaction, type DbClient } from "@/lib/db";
import {
  assertExactMetaAdsActionReceiptForEpisode,
  buildAdRecommendationEpisode,
  buildExactMetaAdsActionReceiptHash,
  type AdRecommendationEpisode,
  type ExactMetaAdsActionLineage,
} from "@/lib/creative-decision-engine/ad-operator-response-detection";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  isExactMetaProviderEntityId,
  validateDecisionOriginAdExecutionRequest,
  validateDecisionOriginProviderVerification,
  type DecisionOriginAdAction,
  type DecisionOriginAdExecutionRequest,
  type DecisionOriginIdempotencyReceipt,
  type DecisionOriginSourceDecisionEvidence,
} from "@/lib/creative-decision-engine/execution-safety";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";
import {
  META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION,
  prepareMetaAdDuplicateAttempt,
  type MetaAdDuplicateTarget,
} from "@/lib/meta/duplicate-ad-reconciliation-store";

export type MetaAdsActionKind =
  | "pause"
  | "resume"
  | "duplicate"
  | "launch_campaign"
  | "launch_adset"
  | "launch_ad";
export type MetaAdsActionStatus =
  | "pending"
  | "success"
  | "failure"
  | "silent_failure";

export const DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE =
  "provider_verification_persistence_failed" as const;
export const DECISION_ORIGIN_PENDING_RECONCILIATION_CODE =
  "decision_origin_pending_reconciliation_required" as const;
export const DECISION_ORIGIN_PROVIDER_VERIFICATION_MISMATCH_CODE =
  "decision_origin_provider_verification_mismatch" as const;
export const META_AD_STATUS_ACTION_IN_FLIGHT_CODE = "action_in_flight" as const;
export const META_AD_STATUS_RECONCILIATION_REQUIRED_CODE =
  "meta_ad_status_reconciliation_required" as const;
export const MANUAL_META_AD_STATUS_RECONCILIATION_CONTRACT_VERSION =
  "meta-manual-ad-status-reconciliation.v1" as const;
// A provider-generic settlement floor for an ambiguous Meta status write.
export const MANUAL_META_AD_STATUS_RECONCILIATION_MIN_SETTLEMENT_MS =
  5 * 60_000;
export const MANUAL_META_AD_STATUS_RECONCILIATION_MAX_OBSERVATION_AGE_MS =
  60_000;
export const MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION =
  "meta-manual-ad-status-mutation-attempt.v1" as const;
export const MANUAL_META_AD_STATUS_WRITE_VERIFICATION_CONTRACT_VERSION =
  "meta-ad-status-write-verification.v1" as const;
export const MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_LEASE_MS =
  2 * 60_000;
export const MANUAL_META_AD_STATUS_LEGACY_QUARANTINE_MS =
  7 * 24 * 60 * 60_000;

export type MetaAdStatusActionOrigin =
  | "manual_operator_v1"
  | "native_decision_v1";
export type ManualMetaAdStatusReconciliationResolution =
  | "current_state_matches_requested"
  | "current_state_matches_precondition";
export type ManualMetaAdStatusReconciliationSourceOutcome =
  | "provider_outcome_ambiguous"
  | "provider_response_succeeded_verification_failed"
  | "provider_response_verified_success"
  | "provider_definite_failure"
  | "attempt_lease_expired_without_completion"
  | "pre_provider_no_mutation_attempt"
  | "legacy_precontract_quarantine_elapsed";
export type ManualMetaAdStatusReconciliationAuthorityKind =
  | "completed_attempt"
  | "lease_expired_started"
  | "pre_provider_no_attempt"
  | "legacy_quarantine";
export type ManualMetaAdConfiguredStatus = "ACTIVE" | "PAUSED";

export class MetaAdStatusActionClaimConflictError extends Error {
  readonly code:
    | typeof META_AD_STATUS_ACTION_IN_FLIGHT_CODE
    | typeof META_AD_STATUS_RECONCILIATION_REQUIRED_CODE
    | typeof DECISION_ORIGIN_PENDING_RECONCILIATION_CODE
    | typeof DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE;
  readonly blockingActionLogId: string;
  readonly blockingOrigin: string;
  readonly reconciliationRequired: boolean;
  readonly reconciliationReceipt: DecisionOriginIdempotencyReceipt | null;

  constructor(input: {
    code:
      | typeof META_AD_STATUS_ACTION_IN_FLIGHT_CODE
      | typeof META_AD_STATUS_RECONCILIATION_REQUIRED_CODE
      | typeof DECISION_ORIGIN_PENDING_RECONCILIATION_CODE
      | typeof DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE;
    blockingActionLogId: string;
    blockingOrigin: string;
    reconciliationRequired: boolean;
    reconciliationReceipt?: DecisionOriginIdempotencyReceipt | null;
  }) {
    super(input.code);
    this.name = "MetaAdStatusActionClaimConflictError";
    this.code = input.code;
    this.blockingActionLogId = input.blockingActionLogId;
    this.blockingOrigin = input.blockingOrigin;
    this.reconciliationRequired = input.reconciliationRequired;
    this.reconciliationReceipt = input.reconciliationReceipt ?? null;
  }
}

export type DecisionOriginReconciliationOutcome =
  | "provider_outcome_ambiguous"
  | "provider_response_succeeded_verification_failed"
  | "provider_write_verified_receipt_persistence_failed"
  | "dry_run_terminal_persistence_failed"
  | "provider_rejection_terminal_persistence_failed"
  | "pre_provider_terminal_persistence_failed";

export class DecisionOriginProviderVerificationMismatchError extends Error {
  readonly code = DECISION_ORIGIN_PROVIDER_VERIFICATION_MISMATCH_CODE;
  readonly blockers: string[];

  constructor(blockers: string[]) {
    super(
      `Provider verification did not match the exact DB-bound ad/action (${blockers.join(", ")}).`,
    );
    this.name = "DecisionOriginProviderVerificationMismatchError";
    this.blockers = blockers;
  }
}

export function providerActionForNativeAuthorization(
  value: unknown,
): DecisionOriginAdAction | null {
  if (value === "cut") return "pause";
  if (value === "scale") return "resume";
  return null;
}

export interface MetaAdsActionLogRow {
  id: string;
  businessId: string;
  adId: string;
  creativeId: string | null;
  action: MetaAdsActionKind;
  source: string;
  requestedBy: string | null;
  requestedAt: string;
  payloadRequest: Record<string, unknown> | null;
  payloadResponse: Record<string, unknown> | null;
  status: MetaAdsActionStatus;
  errorCode: string | null;
  errorMessage: string | null;
  resultingAdId: string | null;
  durationMs: number | null;
  verifiedAt: string | null;
  verificationPayload: Record<string, unknown> | null;
  recIdOrigin: string | null;
  launchIntentId: string | null;
  providerAccountRefId: string | null;
  providerAccountId: string | null;
  decisionEpisodeKey: string | null;
  decisionSnapshotId: string | null;
  decisionEvaluationId: string | null;
  decisionEngineVersion: string | null;
  decisionHash: string | null;
  idempotencyKey: string | null;
  decisionOrigin: DecisionOriginAdExecutionRequest | null;
  dryRun: boolean;
  providerVerified: boolean;
  verificationEntityId: string | null;
  verificationStatus: string | null;
  terminalFinalizedAt: string | null;
  treatmentEligible: boolean;
  idempotentReplay?: boolean;
  createdAt: string;
  updatedAt: string;
}

export interface MetaAdActionTarget {
  businessId: string;
  adId: string;
  creativeId: string | null;
  providerAccountId: string | null;
}

export interface ManualMetaAdStatusReconciliationEvent {
  id: string;
  contractVersion:
    typeof MANUAL_META_AD_STATUS_RECONCILIATION_CONTRACT_VERSION;
  sourceActionLogId: string;
  sourceAttemptId: string | null;
  sourceAttemptCompletedEventId: string | null;
  businessId: string;
  providerAccountRefId: string;
  sourceProviderAccountId: string | null;
  providerAccountId: string;
  adId: string;
  creativeId: string;
  campaignId: string;
  adsetId: string;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  sourceAuthorityKind: ManualMetaAdStatusReconciliationAuthorityKind;
  sourceOutcome: ManualMetaAdStatusReconciliationSourceOutcome;
  sourceRequestedAt: string;
  sourceLeaseDeadline: string | null;
  sourceAttemptedAt: string | null;
  sourceCompletedAt: string | null;
  sourceTerminalFinalizedAt: string | null;
  sourceLegacyAnchorAt: string | null;
  settlementNotBefore: string;
  resolution: ManualMetaAdStatusReconciliationResolution;
  requestedStatus: ManualMetaAdConfiguredStatus;
  observedStatus: ManualMetaAdConfiguredStatus;
  observedEffectiveStatus: string;
  observedCampaignStatus: ManualMetaAdConfiguredStatus;
  observedCampaignEffectiveStatus: ManualMetaAdConfiguredStatus;
  observedAdsetStatus: ManualMetaAdConfiguredStatus;
  observedAdsetEffectiveStatus: ManualMetaAdConfiguredStatus;
  policyEligible: true;
  reviewStatus: null;
  observedAt: string;
  capturedAt: string;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  createdAt: string;
  idempotentReplay?: boolean;
}

export interface AppendManualMetaAdStatusReconciliationInput {
  sourceActionLogId: string;
  businessId: string;
  providerAccountId: string;
  adId: string;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  resolution: ManualMetaAdStatusReconciliationResolution;
  observedStatus: ManualMetaAdConfiguredStatus;
  observedEffectiveStatus: string;
  observedAt: string | Date;
  resolvedTarget: {
    businessId: string;
    providerAccountId: string;
    adId: string;
    creativeId: string;
    campaignId: string;
    adsetId: string;
  };
  /**
   * The unmodified JSON object returned by the exact provider GET. At minimum
   * Meta's id, account_id, status, and effective_status fields are required.
   */
  providerGetEvidence: Record<string, unknown>;
}

export type ManualMetaAdStatusReconciliationCandidateBlocker =
  | "no_unresolved_manual_source"
  | "multiple_unresolved_manual_sources"
  | "source_lineage_not_exact"
  | "attempt_journal_contradictory"
  | "provider_binding_missing"
  | "durable_target_not_exact"
  | "legacy_target_not_unique"
  | "authority_not_supported"
  | "settlement_not_elapsed";

export interface ManualMetaAdStatusReconciliationCandidate {
  businessId: string;
  providerAccountId: string;
  adId: string;
  unresolvedSourceCount: number;
  sourceActionLogId: string | null;
  action: Extract<MetaAdsActionKind, "pause" | "resume"> | null;
  creativeId: string | null;
  readyForProviderRead: boolean;
  settlementNotBefore: string | null;
  authorityKind: ManualMetaAdStatusReconciliationAuthorityKind | null;
  outcome: ManualMetaAdStatusReconciliationSourceOutcome | null;
  providerAccountRefId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  blockerReason: ManualMetaAdStatusReconciliationCandidateBlocker | null;
}

export interface ManualMetaAdStatusMutationTarget {
  businessId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string;
  campaignId: string;
  adsetId: string;
}

export type ManualMetaAdStatusMutationCompletionOutcome =
  | "provider_outcome_ambiguous"
  | "provider_response_succeeded_verification_failed"
  | "provider_response_verified_success"
  | "provider_definite_failure";

export interface ManualMetaAdStatusMutationAttemptEvent {
  id: string;
  contractVersion:
    typeof MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION;
  sourceActionLogId: string;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string;
  campaignId: string;
  adsetId: string;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  attemptId: string;
  eventKind: "attempt_started" | "attempt_completed";
  postPath: string;
  startedAt: string;
  leaseDeadline: string;
  attemptedAt: string | null;
  completedAt: string | null;
  completionOutcome: ManualMetaAdStatusMutationCompletionOutcome | null;
  providerResponseReceived: boolean | null;
  providerResponseSuccessful: boolean | null;
  httpStatus: number | null;
  providerOutcome:
    | "outcome_ambiguous"
    | "definite_failure"
    | "provider_response_succeeded"
    | "verified_success"
    | null;
  providerResponse: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
  transportError: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
  evidenceHash: string;
  createdAt: string;
  idempotentReplay?: boolean;
}

export interface AppendManualMetaAdStatusMutationAttemptStartedInput {
  sourceActionLogId: string;
  target: ManualMetaAdStatusMutationTarget;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  postPath: string;
}

export interface ManualMetaProviderMutationAttemptReceipt {
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

export interface AppendManualMetaAdStatusMutationAttemptCompletedInput {
  sourceActionLogId: string;
  attemptId: string;
  completionOutcome: ManualMetaAdStatusMutationCompletionOutcome;
  mutationAttempt: ManualMetaProviderMutationAttemptReceipt;
  providerResponse?: Record<string, unknown> | null;
  verification?: Record<string, unknown> | null;
}

interface MetaAdsActionLogDbRow {
  id: string;
  business_id: string;
  ad_id: string;
  creative_id: string | null;
  action: MetaAdsActionKind;
  source: string;
  requested_by: string | null;
  requested_at: string | Date;
  payload_request: Record<string, unknown> | null;
  payload_response: Record<string, unknown> | null;
  status: MetaAdsActionStatus;
  error_code: string | null;
  error_message: string | null;
  resulting_ad_id: string | null;
  duration_ms: number | null;
  verified_at: string | Date | null;
  verification_payload: Record<string, unknown> | null;
  rec_id_origin: string | null;
  launch_intent_id: string | null;
  decision_contract_version: string | null;
  provider_account_ref_id: string | null;
  provider_account_id: string | null;
  decision_episode_key: string | null;
  decision_snapshot_id: string | null;
  decision_evaluation_id: string | null;
  decision_engine_version: string | null;
  decision_hash: string | null;
  idempotency_key: string | null;
  dry_run: boolean | null;
  provider_verified: boolean | null;
  verification_entity_id: string | null;
  verification_status: string | null;
  terminal_finalized_at: string | Date | null;
  created_at: string | Date;
  updated_at: string | Date;
  episode_creative_id?: string | null;
  episode_business_id?: string | null;
  episode_as_of_date?: string | Date | null;
  episode_scope_type?: string | null;
  episode_scope_id?: string | null;
  episode_input_hash?: string | null;
  episode_decision_label?: string | null;
  episode_source_campaign_id?: string | null;
  episode_source_adset_id?: string | null;
  episode_recommended_at?: string | Date | null;
  authority_snapshot_id?: string | null;
  authority_evaluation_id?: string | null;
  existing_receipt_id?: string | null;
  existing_receipt_hash?: string | null;
  existing_receipt_captured_at?: string | Date | null;
}

interface ManualMetaAdStatusReconciliationDbRow {
  id: string;
  contract_version: string;
  source_action_log_id: string;
  source_attempt_id: string | null;
  source_attempt_completed_event_id: string | null;
  business_id: string;
  provider_account_ref_id: string;
  source_provider_account_id: string | null;
  provider_account_id: string;
  ad_id: string;
  creative_id: string;
  campaign_id: string;
  adset_id: string;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  source_authority_kind: ManualMetaAdStatusReconciliationAuthorityKind;
  source_outcome: ManualMetaAdStatusReconciliationSourceOutcome;
  source_requested_at: string | Date;
  source_lease_deadline: string | Date | null;
  source_attempted_at: string | Date | null;
  source_completed_at: string | Date | null;
  source_terminal_finalized_at: string | Date | null;
  source_legacy_anchor_at: string | Date | null;
  settlement_not_before: string | Date;
  resolution: ManualMetaAdStatusReconciliationResolution;
  requested_status: ManualMetaAdConfiguredStatus;
  observed_status: ManualMetaAdConfiguredStatus;
  observed_effective_status: string;
  observed_campaign_status: ManualMetaAdConfiguredStatus;
  observed_campaign_effective_status: ManualMetaAdConfiguredStatus;
  observed_adset_status: ManualMetaAdConfiguredStatus;
  observed_adset_effective_status: ManualMetaAdConfiguredStatus;
  policy_eligible: boolean;
  review_status: string | null;
  observed_at: string | Date;
  captured_at: string | Date;
  evidence_json: Record<string, unknown>;
  evidence_hash: string;
  created_at: string | Date;
}

interface ManualMetaAdStatusMutationAttemptDbRow {
  id: string;
  contract_version: string;
  source_action_log_id: string;
  business_id: string;
  provider_account_ref_id: string;
  provider_account_id: string;
  ad_id: string;
  creative_id: string;
  campaign_id: string;
  adset_id: string;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  attempt_id: string;
  event_kind: "attempt_started" | "attempt_completed";
  post_path: string;
  started_at: string | Date;
  lease_deadline: string | Date;
  attempted_at: string | Date | null;
  completed_at: string | Date | null;
  completion_outcome: ManualMetaAdStatusMutationCompletionOutcome | null;
  provider_response_received: boolean | null;
  provider_response_successful: boolean | null;
  http_status: number | null;
  provider_outcome:
    | "outcome_ambiguous"
    | "definite_failure"
    | "provider_response_succeeded"
    | "verified_success"
    | null;
  provider_response_json: Record<string, unknown> | null;
  verification_json: Record<string, unknown> | null;
  transport_error_json: Record<string, unknown> | null;
  evidence_json: Record<string, unknown>;
  evidence_hash: string;
  created_at: string | Date;
}

interface ManualMetaAdStatusReconciliationSourceRow {
  id: string;
  business_id: string;
  provider_account_id: string | null;
  ad_id: string;
  creative_id: string | null;
  action: MetaAdsActionKind;
  source: string;
  requested_at: string | Date;
  updated_at?: string | Date;
  verified_at?: string | Date | null;
  payload_request: Record<string, unknown> | null;
  status: MetaAdsActionStatus;
  dry_run: boolean | null;
  terminal_finalized_at: string | Date | null;
  reconciliation_event_id?: string | null;
  bound_provider_account_ref_id?: string | null;
  bound_provider_account_count?: number;
  db_now: string | Date;
}

interface ManualMetaAdStatusReconciliationCandidateSourceRow
  extends ManualMetaAdStatusReconciliationSourceRow {
  unresolved_source_count: number;
}

function canonicalIsoTimestamp(value: unknown, field: string) {
  const parsed =
    value instanceof Date
      ? value
      : typeof value === "string" && value.trim()
        ? new Date(value)
        : null;
  if (!parsed || !Number.isFinite(parsed.getTime())) {
    throw new TypeError(`${field} must be a valid timestamp.`);
  }
  return parsed.toISOString();
}

function nullableCanonicalIsoTimestamp(value: unknown, field: string) {
  return value == null ? null : canonicalIsoTimestamp(value, field);
}

function decisionOriginFromRow(
  row: MetaAdsActionLogDbRow,
): DecisionOriginAdExecutionRequest | null {
  if (
    row.source !== "decision_origin" ||
    row.decision_contract_version !==
      DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
  ) {
    return null;
  }
  const request: DecisionOriginAdExecutionRequest = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id ?? "",
    adId: row.ad_id,
    snapshotId: row.decision_snapshot_id ?? "",
    evaluationId: row.decision_evaluation_id ?? "",
    engineVersion: row.decision_engine_version ?? "",
    decisionHash: row.decision_hash ?? "",
    action: row.action,
    idempotencyKey: row.idempotency_key ?? "",
    creativeId: row.creative_id ?? "",
    ...(row.dry_run === true ? { dryRun: true } : {}),
  };
  return validateDecisionOriginAdExecutionRequest(request).length === 0
    ? request
    : null;
}

function mapActionLogRow(row: MetaAdsActionLogDbRow): MetaAdsActionLogRow {
  const decisionOrigin = decisionOriginFromRow(row);
  const verifiedAt = nullableCanonicalIsoTimestamp(
    row.verified_at,
    "verified_at",
  );
  const authorityEpisode = replayAuthorityEpisodeFromRow(row);
  const expectedLineage =
    decisionOrigin &&
    authorityEpisode?.creativeId &&
    authorityEpisode.sourceCampaignId &&
    authorityEpisode.sourceAdsetId
      ? {
          providerAccountId: authorityEpisode.providerAccountId,
          creativeId: authorityEpisode.creativeId,
          campaignId: authorityEpisode.sourceCampaignId,
          adsetId: authorityEpisode.sourceAdsetId,
        }
      : null;
  const verification = decisionOrigin && expectedLineage
    ? validateDecisionOriginProviderVerification({
        request: decisionOrigin,
        expectedLineage,
        verifiedAt,
        providerCompletedAt:
          row.verification_payload?.contractVersion ===
          MANUAL_META_AD_STATUS_WRITE_VERIFICATION_CONTRACT_VERSION
            ? nullableText(
                row.verification_payload.providerCompletedAt,
              )
            : null,
        verificationPayload: row.verification_payload,
      })
    : null;
  let exactImmutableReceipt = false;
  if (
    decisionOrigin &&
    authorityEpisode &&
    row.authority_snapshot_id &&
    row.authority_evaluation_id &&
    row.existing_receipt_id &&
    row.existing_receipt_hash &&
    row.existing_receipt_captured_at
  ) {
    try {
      const derivedReceipt = deriveExactReceiptFromDbAuthority({
        row,
        request: decisionOrigin,
        episode: authorityEpisode,
        receiptId: row.existing_receipt_id,
        capturedAt: row.existing_receipt_captured_at,
      });
      exactImmutableReceipt =
        derivedReceipt.receiptHash === row.existing_receipt_hash;
    } catch {
      exactImmutableReceipt = false;
    }
  }
  return {
    id: row.id,
    businessId: row.business_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    action: row.action,
    source: row.source,
    requestedBy: row.requested_by,
    requestedAt: canonicalIsoTimestamp(row.requested_at, "requested_at"),
    payloadRequest: row.payload_request,
    payloadResponse: row.payload_response,
    status: row.status,
    errorCode: row.error_code,
    errorMessage: row.error_message,
    resultingAdId: row.resulting_ad_id,
    durationMs: row.duration_ms,
    verifiedAt,
    verificationPayload: row.verification_payload,
    recIdOrigin: row.rec_id_origin,
    launchIntentId: row.launch_intent_id ?? null,
    providerAccountRefId: row.provider_account_ref_id ?? null,
    providerAccountId: row.provider_account_id ?? null,
    decisionEpisodeKey: row.decision_episode_key ?? null,
    decisionSnapshotId: row.decision_snapshot_id ?? null,
    decisionEvaluationId: row.decision_evaluation_id ?? null,
    decisionEngineVersion: row.decision_engine_version ?? null,
    decisionHash: row.decision_hash ?? null,
    idempotencyKey: row.idempotency_key ?? null,
    decisionOrigin,
    dryRun: row.dry_run === true,
    providerVerified: row.provider_verified === true,
    verificationEntityId: row.verification_entity_id ?? null,
    verificationStatus: row.verification_status ?? null,
    terminalFinalizedAt: nullableCanonicalIsoTimestamp(
      row.terminal_finalized_at,
      "terminal_finalized_at",
    ),
    treatmentEligible:
      row.status === "success" &&
      row.provider_verified === true &&
      row.dry_run !== true &&
      exactImmutableReceipt &&
      verification?.treatmentEligible === true,
    createdAt: canonicalIsoTimestamp(row.created_at, "created_at"),
    updatedAt: canonicalIsoTimestamp(row.updated_at, "updated_at"),
  };
}

export async function resolveExactMetaAdActionTarget(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}): Promise<
  | { ok: true; target: MetaAdActionTarget }
  | { ok: false; reason: "business_not_found" | "ad_not_found" }
> {
  if (!isExactMetaProviderEntityId(input.adId)) {
    return { ok: false, reason: "ad_not_found" };
  }
  const sql = getDb();
  const businessRows = (await sql`
    SELECT id
    FROM businesses
    WHERE id = ${input.businessId}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (!businessRows[0]) return { ok: false, reason: "business_not_found" };

  const adRows = (await sql`
    SELECT provider_account_id, ad_id, creative_id
    FROM (
      SELECT provider_account_id, ad_id, creative_id, 1 AS source_priority, updated_at
      FROM meta_ad_dimensions
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND ad_id = ${input.adId}
      UNION ALL
      SELECT provider_account_id, ad_id, NULL::text AS creative_id, 2 AS source_priority, updated_at
      FROM meta_ad_daily
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND ad_id = ${input.adId}
      UNION ALL
      SELECT provider_account_id, ad_id, creative_id, 3 AS source_priority, updated_at
      FROM meta_creative_daily
      WHERE business_id = ${input.businessId}
        AND provider_account_id = ${input.providerAccountId}
        AND ad_id = ${input.adId}
    ) exact_ad
    ORDER BY source_priority, updated_at DESC
    LIMIT 1
  `) as Array<{
    provider_account_id: string | null;
    ad_id: string | null;
    creative_id: string | null;
  }>;
  const adRow = adRows[0];
  if (
    !adRow?.provider_account_id ||
    adRow.provider_account_id !== input.providerAccountId ||
    !adRow.ad_id ||
    adRow.ad_id !== input.adId
  ) {
    return { ok: false, reason: "ad_not_found" };
  }
  return {
    ok: true,
    target: {
      businessId: input.businessId,
      providerAccountId: adRow.provider_account_id,
      adId: adRow.ad_id,
      creativeId: adRow.creative_id ?? null,
    },
  };
}

/** Read-only discovery/history resolver. Never use its fallbacks for a write. */
export async function resolveManualMetaAdActionTarget(input: {
  businessId: string;
  adId: string;
}): Promise<
  | { ok: true; target: MetaAdActionTarget }
  | { ok: false; reason: "business_not_found" | "ad_not_found" }
> {
  const sql = getDb();
  const businessRows = (await sql`
    SELECT id
    FROM businesses
    WHERE id = ${input.businessId}
    LIMIT 1
  `) as Array<{ id: string }>;
  if (!businessRows[0]) return { ok: false, reason: "business_not_found" };

  // The client may send either a real Meta ad_id or a value that the warehouse uses as
  // a synthesized identifier (e.g. meta_creative_daily.ad_id "creative_..." when the
  // upstream sync only had creative-level facts). Resolve via several paths:
  //   1) direct ad_id match in dimensions / daily (real Meta ad_id)
  //   2) treat the input as a creative_id and resolve real ad_id from dimensions
  //   3) fall back to meta_creative_daily lookup, then creative_id → dimensions
  //   4) use recent successful launch/duplicate action logs before warehouse sync catches up
  const adRows = (await sql`
    SELECT
      COALESCE(
        dim_direct.provider_account_id,
        daily_direct.provider_account_id,
        creative_daily_direct.provider_account_id,
        dim_by_creative.provider_account_id,
        creative_daily_by_creative.provider_account_id,
        dim_by_warehouse_creative.provider_account_id,
        action_result.provider_account_id
      ) AS provider_account_id,
      COALESCE(
        dim_direct.ad_id,
        daily_direct.ad_id,
        creative_daily_direct.ad_id,
        dim_by_creative.ad_id,
        creative_daily_by_creative.ad_id,
        dim_by_warehouse_creative.ad_id,
        action_result.resolved_ad_id
      ) AS resolved_ad_id,
      COALESCE(
        dim_direct.creative_id,
        daily_direct.creative_id,
        creative_daily_direct.creative_id,
        dim_by_creative.creative_id,
        creative_daily_by_creative.creative_id,
        dim_by_warehouse_creative.creative_id,
        warehouse_creative.creative_id,
        action_result.creative_id
      ) AS creative_id
    FROM (
      SELECT
        ${input.businessId}::text AS business_id_text,
        ${input.businessId}::uuid AS business_id_uuid,
        ${input.adId}::text AS input_id
    ) target
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id_text AND ad_id = target.input_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, NULL::text AS creative_id
      FROM meta_ad_daily
      WHERE business_id = target.business_id_text AND ad_id = target.input_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) daily_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_creative_daily
      WHERE business_id = target.business_id_text
        AND ad_id = target.input_id
        AND ad_id ~ '^[0-9]+$'
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) creative_daily_direct ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id_text AND creative_id = target.input_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_by_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_creative_daily
      WHERE business_id = target.business_id_text
        AND creative_id = target.input_id
        AND ad_id ~ '^[0-9]+$'
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) creative_daily_by_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT creative_id
      FROM meta_creative_daily
      WHERE business_id = target.business_id_text AND ad_id = target.input_id
      ORDER BY date DESC, updated_at DESC
      LIMIT 1
    ) warehouse_creative ON TRUE
    LEFT JOIN LATERAL (
      SELECT provider_account_id, ad_id, creative_id
      FROM meta_ad_dimensions
      WHERE business_id = target.business_id_text
        AND creative_id = warehouse_creative.creative_id
      ORDER BY updated_at DESC
      LIMIT 1
    ) dim_by_warehouse_creative ON TRUE
    LEFT JOIN LATERAL (
      -- Newly written ads can be actionable before the next warehouse sync materializes dimensions.
      SELECT
        COALESCE(
          CASE
            WHEN substring(COALESCE(log.payload_request->>'endpoint', '') FROM '^/act_([^/]+)/ads$') IS NOT NULL
            THEN 'act_' || substring(COALESCE(log.payload_request->>'endpoint', '') FROM '^/act_([^/]+)/ads$')
            ELSE NULL
          END,
          action_adset.provider_account_id
        ) AS provider_account_id,
        log.resulting_ad_id AS resolved_ad_id,
        COALESCE(
          log.creative_id,
          NULLIF(log.payload_request->'body'->>'source_creative_id', '')
        ) AS creative_id
      FROM meta_ads_action_log log
      LEFT JOIN LATERAL (
        SELECT provider_account_id
        FROM meta_adset_dimensions
        WHERE business_id = target.business_id_text
          AND adset_id = COALESCE(
            NULLIF(log.payload_request->>'target_adset_id', ''),
            NULLIF(log.payload_request->'body'->>'target_adset_id', ''),
            NULLIF(log.payload_request->'body'->>'adset_id', '')
          )
        ORDER BY updated_at DESC
        LIMIT 1
      ) action_adset ON TRUE
      WHERE log.business_id = target.business_id_uuid
        AND log.resulting_ad_id = target.input_id
        AND log.action IN ('launch_ad', 'duplicate')
        AND log.status IN ('success', 'silent_failure')
      ORDER BY log.verified_at DESC NULLS LAST, log.requested_at DESC
      LIMIT 1
    ) action_result ON TRUE
    WHERE COALESCE(
      dim_direct.provider_account_id,
      daily_direct.provider_account_id,
      creative_daily_direct.provider_account_id,
      dim_by_creative.provider_account_id,
      creative_daily_by_creative.provider_account_id,
      dim_by_warehouse_creative.provider_account_id,
      action_result.provider_account_id
    ) IS NOT NULL
    LIMIT 1
  `) as Array<{
    provider_account_id: string | null;
    resolved_ad_id: string | null;
    creative_id: string | null;
  }>;
  const adRow = adRows[0];
  if (!adRow?.provider_account_id || !adRow?.resolved_ad_id) {
    return { ok: false, reason: "ad_not_found" };
  }

  return {
    ok: true,
    target: {
      businessId: input.businessId,
      adId: adRow.resolved_ad_id,
      creativeId: adRow.creative_id ?? null,
      providerAccountId: adRow.provider_account_id,
    },
  };
}

/** @deprecated Read-only discovery/history compatibility only. */
export const resolveMetaAdActionTarget = resolveManualMetaAdActionTarget;

export async function readDecisionOriginSourceDecision(input: {
  snapshotId: string;
  evaluationId: string;
}): Promise<DecisionOriginSourceDecisionEvidence> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      snapshot.business_ref_id::text AS business_id,
      snapshot.provider_account_id,
      snapshot.decision_entity_type,
      snapshot.decision_entity_id,
      snapshot.ad_id,
      evaluation.creative_input_json->>'campaignId' AS campaign_id,
      evaluation.creative_input_json->>'adsetId' AS adset_id,
      snapshot.creative_id,
      snapshot.id::text AS snapshot_id,
      evaluation.id::text AS evaluation_id,
      snapshot.engine_version,
      snapshot.decision_hash::text AS decision_hash,
      snapshot.label AS decision_label,
      snapshot.blocked_action_type,
      snapshot.authorized_action AS native_authorized_action,
      snapshot.computed_at::text AS computed_at
    FROM engine_v3_ad_decision_snapshots_daily snapshot
    INNER JOIN engine_v3_ad_decision_evaluations evaluation
      ON evaluation.id = snapshot.evaluation_id
     AND evaluation.business_ref_id = snapshot.business_ref_id
     AND evaluation.provider_account_id = snapshot.provider_account_id
     AND evaluation.decision_entity_type = snapshot.decision_entity_type
     AND evaluation.decision_entity_id = snapshot.decision_entity_id
     AND evaluation.ad_id = snapshot.ad_id
     AND evaluation.engine_version = snapshot.engine_version
     AND evaluation.scope_type = snapshot.scope_type
     AND evaluation.scope_id = snapshot.scope_id
     AND evaluation.input_hash = snapshot.input_hash
     AND evaluation.decision_hash = snapshot.decision_hash
    WHERE snapshot.id = ${input.snapshotId}
      AND evaluation.id = ${input.evaluationId}
    LIMIT 1
  `) as Array<{
    business_id: string | null;
    provider_account_id: string | null;
    decision_entity_type: string | null;
    decision_entity_id: string | null;
    ad_id: string | null;
    campaign_id: string | null;
    adset_id: string | null;
    creative_id: string | null;
    snapshot_id: string | null;
    evaluation_id: string | null;
    engine_version: string | null;
    decision_hash: string | null;
    decision_label: string | null;
    blocked_action_type: string | null;
    native_authorized_action: string | null;
    computed_at: string | null;
  }>;
  const row = rows[0];
  if (!row) {
    return {
      found: false,
      businessId: null,
      providerAccountId: null,
      decisionEntityType: null,
      decisionEntityId: null,
      adId: null,
      campaignId: null,
      adsetId: null,
      creativeId: null,
      snapshotId: null,
      evaluationId: null,
      engineVersion: null,
      decisionHash: null,
      decisionLabel: null,
      blockedActionType: null,
      explicitAuthorizedAction: null,
      computedAt: null,
    };
  }
  const explicitAuthorizedAction = providerActionForNativeAuthorization(
    row.native_authorized_action,
  );
  return {
    found: true,
    businessId: row.business_id,
    providerAccountId: row.provider_account_id,
    decisionEntityType: row.decision_entity_type,
    decisionEntityId: row.decision_entity_id,
    adId: row.ad_id,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    creativeId: requiredText(row.creative_id, "creative_id"),
    snapshotId: row.snapshot_id,
    evaluationId: row.evaluation_id,
    engineVersion: row.engine_version,
    decisionHash: row.decision_hash,
    decisionLabel: row.decision_label,
    blockedActionType: row.blocked_action_type,
    explicitAuthorizedAction,
    computedAt: row.computed_at,
  };
}

export function decisionOriginIdempotencyReceiptFromLog(
  row: MetaAdsActionLogRow,
  fallbackIdempotencyKey = "",
): DecisionOriginIdempotencyReceipt {
  const origin = row.decisionOrigin;
  const reconciliationMarker =
    row.payloadResponse?.decision_origin_reconciliation;
  const markerRecord =
    reconciliationMarker !== null &&
    typeof reconciliationMarker === "object" &&
    !Array.isArray(reconciliationMarker)
      ? (reconciliationMarker as Record<string, unknown>)
      : null;
  const reconciliationRequired =
    row.status === "pending" &&
    row.errorCode === DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE &&
    markerRecord?.reconciliation_required === true;
  return {
    actionLogId: row.id,
    businessId: row.businessId,
    providerAccountId: origin?.providerAccountId ?? row.providerAccountId,
    adId: row.adId,
    creativeId: origin?.creativeId ?? row.creativeId,
    snapshotId: origin?.snapshotId ?? null,
    evaluationId: origin?.evaluationId ?? null,
    engineVersion: origin?.engineVersion ?? null,
    decisionHash: origin?.decisionHash ?? null,
    action: row.action,
    idempotencyKey:
      origin?.idempotencyKey ?? row.idempotencyKey ?? fallbackIdempotencyKey,
    status: row.status,
    dryRun: row.dryRun,
    providerVerified: row.providerVerified,
    treatmentEligible: row.treatmentEligible,
    errorCode: row.errorCode,
    reconciliationRequired,
    retryAllowed: reconciliationRequired ? false : null,
    ...(typeof markerRecord?.outcome === "string"
      ? { reconciliationOutcome: markerRecord.outcome }
      : {}),
    ...(typeof markerRecord?.provider_mutation_attempted === "boolean"
      ? {
          providerMutationAttempted:
            markerRecord.provider_mutation_attempted,
        }
      : {}),
    ...(typeof markerRecord?.provider_mutation_succeeded === "boolean"
      ? {
          providerMutationSucceeded:
            markerRecord.provider_mutation_succeeded,
        }
      : {}),
    ...(typeof markerRecord?.provider_outcome_ambiguous === "boolean"
      ? {
          providerOutcomeAmbiguous:
            markerRecord.provider_outcome_ambiguous,
        }
      : {}),
  };
}

async function findDecisionOriginActionLogByIdempotency(input: {
  businessId: string;
  idempotencyKey: string;
}): Promise<MetaAdsActionLogRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT
      action_log.*,
      episode.business_id AS episode_business_id,
      episode.creative_id AS episode_creative_id,
      episode.as_of_date AS episode_as_of_date,
      episode.scope_type AS episode_scope_type,
      episode.scope_id AS episode_scope_id,
      episode.input_hash AS episode_input_hash,
      episode.decision_label AS episode_decision_label,
      episode.source_campaign_id AS episode_source_campaign_id,
      episode.source_adset_id AS episode_source_adset_id,
      episode.recommended_at AS episode_recommended_at,
      snapshot.id::text AS authority_snapshot_id,
      evaluation.id::text AS authority_evaluation_id,
      receipt.id::text AS existing_receipt_id,
      receipt.receipt_hash AS existing_receipt_hash,
      receipt.captured_at AS existing_receipt_captured_at
    FROM meta_ads_action_log action_log
    LEFT JOIN engine_v3_ad_recommendation_episodes episode
      ON episode.episode_key = action_log.decision_episode_key
     AND episode.business_ref_id = action_log.business_id
     AND episode.business_id = action_log.business_id::text
     AND episode.provider_account_ref_id = action_log.provider_account_ref_id
     AND episode.provider_account_id = action_log.provider_account_id
     AND episode.ad_id = action_log.ad_id
     AND episode.decision_snapshot_id = action_log.decision_snapshot_id
     AND episode.evaluation_id = action_log.decision_evaluation_id
     AND episode.engine_version = action_log.decision_engine_version
     AND episode.decision_hash = action_log.decision_hash
    LEFT JOIN engine_v3_ad_decision_snapshots_daily snapshot
      ON snapshot.id = episode.decision_snapshot_id
     AND snapshot.business_ref_id = episode.business_ref_id
     AND snapshot.business_id = episode.business_id
     AND snapshot.provider_account_id = episode.provider_account_id
     AND snapshot.decision_entity_type = 'ad'
     AND snapshot.decision_entity_id = episode.ad_id
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
     AND evaluation.provider_account_id = episode.provider_account_id
     AND evaluation.decision_entity_type = 'ad'
     AND evaluation.decision_entity_id = episode.ad_id
     AND evaluation.ad_id = episode.ad_id
     AND evaluation.as_of_date = episode.as_of_date
     AND evaluation.engine_version = episode.engine_version
     AND evaluation.scope_type = episode.scope_type
     AND evaluation.scope_id = episode.scope_id
     AND evaluation.input_hash = episode.input_hash
     AND evaluation.decision_hash = episode.decision_hash
    LEFT JOIN engine_v3_ad_operator_action_receipts receipt
      ON receipt.source_action_log_id = action_log.id
     AND receipt.contract_version = action_log.decision_contract_version
     AND receipt.episode_key = action_log.decision_episode_key
     AND receipt.business_ref_id = action_log.business_id
     AND receipt.business_id = action_log.business_id::text
     AND receipt.provider_account_ref_id = action_log.provider_account_ref_id
     AND receipt.provider_account_id = action_log.provider_account_id
     AND receipt.source_ad_id = action_log.ad_id
     AND receipt.source_snapshot_id = action_log.decision_snapshot_id
     AND receipt.source_evaluation_id = action_log.decision_evaluation_id
     AND receipt.source_engine_version = action_log.decision_engine_version
     AND receipt.source_decision_hash = action_log.decision_hash
     AND receipt.target_entity_type = 'ad'
     AND receipt.target_entity_id = action_log.ad_id
     AND receipt.operator_action = action_log.action
     AND receipt.successor_kind IS NULL
     AND receipt.resulting_ad_id IS NULL
     AND receipt.idempotency_key = action_log.idempotency_key
     AND receipt.action_status = action_log.status
     AND receipt.dry_run = action_log.dry_run
     AND receipt.provider_verified = action_log.provider_verified
     AND receipt.requested_at = action_log.requested_at
     AND receipt.verified_at IS NOT DISTINCT FROM action_log.verified_at
     AND receipt.finalized_at = action_log.terminal_finalized_at
     AND receipt.captured_at = action_log.terminal_finalized_at
     AND receipt.verification_entity_id IS NOT DISTINCT FROM
       action_log.verification_entity_id
     AND receipt.verification_status IS NOT DISTINCT FROM
       action_log.verification_status
     AND receipt.verification_lineage = jsonb_build_object(
       'sourceCreativeId', episode.creative_id,
       'sourceCampaignId', episode.source_campaign_id,
       'sourceAdsetId', episode.source_adset_id,
       'verifiedProviderAccountId', episode.provider_account_id,
       'verifiedCreativeId', episode.creative_id,
       'verifiedCampaignId', episode.source_campaign_id,
       'verifiedAdsetId', episode.source_adset_id
     )
    WHERE action_log.business_id = ${input.businessId}
      AND action_log.source = 'decision_origin'
      AND action_log.idempotency_key = ${input.idempotencyKey}
    ORDER BY action_log.requested_at DESC
    LIMIT 1
  `) as MetaAdsActionLogDbRow[];
  return rows[0] ? mapActionLogRow(rows[0]) : null;
}

export async function findDecisionOriginActionByIdempotency(input: {
  businessId: string;
  idempotencyKey: string;
}): Promise<DecisionOriginIdempotencyReceipt | null> {
  const row = await findDecisionOriginActionLogByIdempotency(input);
  return row
    ? decisionOriginIdempotencyReceiptFromLog(row, input.idempotencyKey)
    : null;
}

export async function findUnresolvedDecisionOriginPendingAction(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}): Promise<DecisionOriginIdempotencyReceipt | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND provider_account_id = ${input.providerAccountId}
      AND ad_id = ${input.adId}
      AND source = 'decision_origin'
      AND status = 'pending'
      AND terminal_finalized_at IS NULL
    ORDER BY requested_at ASC
    LIMIT 1
  `) as MetaAdsActionLogDbRow[];
  return rows[0]
    ? decisionOriginIdempotencyReceiptFromLog(mapActionLogRow(rows[0]))
    : null;
}

export async function findUnresolvedMetaAdStatusActionLog(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}): Promise<MetaAdsActionLogRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT action_log.*
    FROM meta_ads_action_log action_log
    WHERE action_log.business_id = ${input.businessId}
      AND action_log.ad_id = ${input.adId}
      AND action_log.action IN ('pause', 'resume')
      AND (
        action_log.status = 'pending'
        OR (
          action_log.source <> 'decision_origin'
          AND action_log.status = 'silent_failure'
          AND NOT COALESCE(
            action_log.payload_request->>'dry_run' = 'true',
            action_log.dry_run,
            false
          )
        )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM meta_ads_action_reconciliation_events reconciliation
        WHERE reconciliation.source_action_log_id = action_log.id
          AND reconciliation.business_id = action_log.business_id
          AND reconciliation.ad_id = action_log.ad_id
          AND reconciliation.action = action_log.action
          AND (
            action_log.provider_account_id IS NULL
            OR reconciliation.provider_account_id =
              action_log.provider_account_id
          )
      )
      AND (
        action_log.provider_account_id = ${input.providerAccountId}
        OR (
          action_log.provider_account_id IS NULL
          AND action_log.source <> 'decision_origin'
        )
      )
    ORDER BY action_log.requested_at ASC
    LIMIT 1
  `) as MetaAdsActionLogDbRow[];
  return rows[0] ? mapActionLogRow(rows[0]) : null;
}

export async function hasUnresolvedMetaAdStatusAction(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}): Promise<boolean> {
  return Boolean(await findUnresolvedMetaAdStatusActionLog(input));
}

export async function hasRecentPendingMetaAdsAction(input: {
  businessId: string;
  adId: string;
  sinceSeconds?: number;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND ad_id = ${input.adId}
      AND status = 'pending'
      AND NOT (
        COALESCE(dry_run, FALSE)
        OR COALESCE(payload_request->>'dry_run', 'false') = 'true'
        OR COALESCE(payload_request->'body'->>'dry_run', 'false') = 'true'
      )
      AND requested_at > NOW() - (${input.sinceSeconds ?? 30}::int * interval '1 second')
    LIMIT 1
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function hasRecentPendingMetaLaunchAction(input: {
  businessId: string;
  idempotencyKey: string;
  sinceSeconds?: number;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND action IN ('launch_campaign', 'launch_adset', 'launch_ad')
      AND status = 'pending'
      AND COALESCE(payload_request->>'idempotency_key', payload_request->>'idempotencyKey') = ${input.idempotencyKey}
      AND requested_at > NOW() - (${input.sinceSeconds ?? 30}::int * interval '1 second')
    LIMIT 1
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function hasRecentPendingMetaAddToExistingAction(input: {
  businessId: string;
  idempotencyKey: string;
  targetAdsetId: string;
  sinceSeconds?: number;
}): Promise<boolean> {
  const sql = getDb();
  const rows = (await sql`
    SELECT id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND action = 'launch_ad'
      AND status = 'pending'
      AND COALESCE(payload_request->>'idempotency_key', payload_request->>'idempotencyKey') = ${input.idempotencyKey}
      AND COALESCE(
        payload_request->>'target_adset_id',
        payload_request->'body'->>'target_adset_id',
        payload_request->'body'->>'adset_id'
      ) = ${input.targetAdsetId}
      AND requested_at > NOW() - (${input.sinceSeconds ?? 30}::int * interval '1 second')
    LIMIT 1
  `) as Array<{ id: string }>;
  return Boolean(rows[0]);
}

export async function findRecentDuplicateActionResult(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
  targetAdsetId: string;
  sinceMinutes?: number;
}): Promise<MetaAdsActionLogRow | null> {
  const sql = getDb();
  const rows = (await sql`
    SELECT *
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND (
        provider_account_id = ${input.providerAccountId}
        OR provider_account_id IS NULL
      )
      AND ad_id = ${input.adId}
      AND action = 'duplicate'
      AND (
        status IN ('pending', 'success', 'silent_failure')
        OR (
          status = 'failure'
          AND NOT COALESCE(
            provider_account_ref_id IS NOT NULL
            AND NULLIF(btrim(provider_account_id), '') IS NOT NULL
            AND payload_request->>'duplicate_attempt_contract_version' =
              ${META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION}
            AND payload_request->'duplicate_attempt_required'
              IS NOT DISTINCT FROM 'true'::jsonb,
            FALSE
          )
        )
      )
      AND NOT (
        COALESCE(dry_run, FALSE)
        OR COALESCE(payload_request->>'dry_run', 'false') = 'true'
        OR COALESCE(payload_request->'body'->>'dry_run', 'false') = 'true'
      )
      AND COALESCE(
        payload_request->'body'->>'target_adset_id',
        payload_request->>'target_adset_id'
      ) = ${input.targetAdsetId}
      AND (
        (
          status = 'success'
          AND requested_at > NOW() - (${input.sinceMinutes ?? 10}::int * interval '1 minute')
        )
        OR status = 'pending'
        OR status = 'silent_failure'
        OR status = 'failure'
      )
    ORDER BY requested_at DESC
    LIMIT 1
  `) as MetaAdsActionLogDbRow[];
  return rows[0] ? mapActionLogRow(rows[0]) : null;
}

export interface MetaAdDuplicateActionClaimInput {
  businessId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string | null;
  targetAdsetId: string;
  dryRun: boolean;
  requestedBy: string | null;
  payloadRequest: Record<string, unknown>;
  recIdOrigin: string | null;
  marker: string;
  canonicalAdName: string;
  sinceMinutes?: number;
}

export type MetaAdDuplicateActionClaimResult =
  | {
      claimed: true;
      log: MetaAdsActionLogRow;
    }
  | {
      claimed: false;
      existing: MetaAdsActionLogRow;
    };

function metaAdDuplicateActionClaimKey(
  input: Pick<
    MetaAdDuplicateActionClaimInput,
    "businessId" | "providerAccountId" | "adId" | "targetAdsetId"
  >,
) {
  return JSON.stringify([
    "duplicate",
    input.businessId,
    input.providerAccountId,
    input.adId,
    input.targetAdsetId,
  ]);
}

/**
 * Serializes the exact duplicate tuple, rechecks every durable unresolved
 * outcome, and inserts the pending row before releasing the transaction lock.
 * The provider call intentionally remains outside this DB transaction.
 */
export async function claimMetaAdDuplicateAction(
  input: MetaAdDuplicateActionClaimInput,
): Promise<MetaAdDuplicateActionClaimResult> {
  const identity = [
    input.businessId,
    input.providerAccountId,
    input.adId,
    input.targetAdsetId,
  ];
  if (identity.some((value) => value.trim() === "")) {
    throw new TypeError(
      "Meta Ad duplicate claims require exact business, provider-account, source-Ad, and target-ad-set identity.",
    );
  }
  return runDbTransaction(async () => {
    const sql = getDb();
    await sql.query(LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY, [
      metaAdDuplicateActionClaimKey(input),
    ]);
    const existing = input.dryRun
      ? null
      : await findRecentDuplicateActionResult({
          businessId: input.businessId,
          providerAccountId: input.providerAccountId,
          adId: input.adId,
          targetAdsetId: input.targetAdsetId,
          sinceMinutes: input.sinceMinutes,
        });
    if (existing) return { claimed: false, existing };
    let providerAccountRefId: string | null = null;
    let durablePayload = input.payloadRequest;
    let duplicateTarget: MetaAdDuplicateTarget | null = null;
    if (!input.dryRun) {
      if (!input.creativeId?.trim()) {
        throw new TypeError(
          "Live Meta Ad duplicate claims require exact creative identity.",
        );
      }
      const bindingRows = await sql.query<{
        provider_account_ref_id: string;
        binding_count: number;
      }>(
        `SELECT
           max(provider_account_ref_id::text) AS provider_account_ref_id,
           count(*)::integer AS binding_count
         FROM business_provider_accounts
         WHERE business_id = $1
           AND provider = 'meta'
           AND provider_account_id = $2`,
        [input.businessId, input.providerAccountId],
      );
      if (
        bindingRows[0]?.binding_count !== 1 ||
        !bindingRows[0].provider_account_ref_id
      ) {
        throw new Error(
          "Live Meta Ad duplicate claim has no single physical account binding.",
        );
      }
      providerAccountRefId = bindingRows[0].provider_account_ref_id;
      duplicateTarget = {
        businessId: input.businessId,
        providerAccountRefId,
        providerAccountId: input.providerAccountId,
        sourceAdId: input.adId,
        sourceCreativeId: input.creativeId,
        targetAdsetId: input.targetAdsetId,
        marker: input.marker,
        canonicalAdName: input.canonicalAdName,
        requestedStatus: "PAUSED",
      };
      durablePayload = {
        ...input.payloadRequest,
        duplicate_attempt_contract_version:
          META_AD_DUPLICATE_ATTEMPT_CONTRACT_VERSION,
        duplicate_attempt_required: true,
        duplicate_marker: input.marker,
        duplicate_canonical_name: input.canonicalAdName,
        duplicate_target: duplicateTarget,
      };
    }
    const log = await insertMetaAdsActionLog({
      businessId: input.businessId,
      providerAccountRefId,
      providerAccountId: input.providerAccountId,
      adId: input.adId,
      creativeId: input.creativeId,
      action: "duplicate",
      source: "manual_operator_v1",
      requestedBy: input.requestedBy,
      payloadRequest: durablePayload,
      recIdOrigin: input.recIdOrigin,
    });
    if (duplicateTarget) {
      await prepareMetaAdDuplicateAttempt({
        sourceActionLogId: log.id,
        target: duplicateTarget,
      });
    }
    return { claimed: true, log };
  });
}

interface CreateMetaAdsActionLogInput {
  businessId: string;
  adId: string;
  creativeId?: string | null;
  providerAccountRefId?: string | null;
  providerAccountId?: string | null;
  action: MetaAdsActionKind;
  source?: string;
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
  recIdOrigin?: string | null;
  launchIntentId?: string | null;
}

async function insertMetaAdsActionLog(
  input: CreateMetaAdsActionLogInput,
): Promise<MetaAdsActionLogRow> {
  const sql = getDb();
  const rows = (await sql`
    INSERT INTO meta_ads_action_log (
      business_id,
      provider_account_ref_id,
      provider_account_id,
      ad_id,
      creative_id,
      action,
      source,
      requested_by,
      payload_request,
      rec_id_origin,
      launch_intent_id,
      dry_run,
      status
    ) VALUES (
      ${input.businessId},
      ${input.providerAccountRefId ?? null},
      ${input.providerAccountId ?? null},
      ${input.adId},
      ${input.creativeId ?? null},
      ${input.action},
      ${input.source ?? "ui_manual"},
      ${input.requestedBy ?? null},
      ${JSON.stringify(input.payloadRequest ?? null)}::jsonb,
      ${input.recIdOrigin ?? null},
      ${input.launchIntentId ?? null},
      ${input.payloadRequest?.dry_run === true},
      'pending'
    )
    RETURNING *
  `) as MetaAdsActionLogDbRow[];
  const row = rows[0];
  if (!row) throw new Error("Failed to create Meta ads action log row.");
  return mapActionLogRow(row);
}

export async function createMetaAdsActionLog(
  input: CreateMetaAdsActionLogInput,
): Promise<MetaAdsActionLogRow> {
  const manualScopeType =
    typeof input.payloadRequest?.scope_type === "string"
      ? input.payloadRequest.scope_type
      : null;
  if (
    input.source === "manual_operator_v1" &&
    (input.action === "pause" || input.action === "resume") &&
    manualScopeType !== "campaign" &&
    manualScopeType !== "adset"
  ) {
    if (!input.providerAccountId?.trim()) {
      throw new TypeError(
        "Manual Meta Ad status claims require exact provider_account_id.",
      );
    }
    return createMetaAdStatusActionClaim({
      actionOrigin: "manual_operator_v1",
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      adId: input.adId,
      creativeId: input.creativeId ?? null,
      action: input.action,
      requestedBy: input.requestedBy ?? null,
      payloadRequest: input.payloadRequest ?? null,
      recIdOrigin: input.recIdOrigin ?? null,
    });
  }
  return insertMetaAdsActionLog(input);
}

export const CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY = `
WITH source_lineage AS (
  SELECT
    episode.episode_key,
    episode.business_ref_id,
    episode.provider_account_ref_id,
    episode.provider_account_id,
    episode.ad_id,
    episode.creative_id,
    episode.decision_snapshot_id,
    episode.evaluation_id,
    episode.engine_version,
    episode.decision_hash
  FROM engine_v3_ad_recommendation_episodes episode
  INNER JOIN engine_v3_ad_decision_snapshots_daily snapshot
    ON snapshot.id = episode.decision_snapshot_id
   AND snapshot.business_ref_id = episode.business_ref_id
   AND snapshot.business_id = episode.business_id
   AND snapshot.provider_account_id = episode.provider_account_id
   AND snapshot.decision_entity_type = 'ad'
   AND snapshot.decision_entity_id = episode.ad_id
   AND snapshot.ad_id = episode.ad_id
   AND snapshot.as_of_date = episode.as_of_date
   AND snapshot.engine_version = episode.engine_version
   AND snapshot.scope_type = episode.scope_type
   AND snapshot.scope_id = episode.scope_id
   AND snapshot.evaluation_id = episode.evaluation_id
   AND snapshot.input_hash = episode.input_hash
   AND snapshot.decision_hash = episode.decision_hash
  INNER JOIN engine_v3_ad_decision_evaluations evaluation
    ON evaluation.id = episode.evaluation_id
   AND evaluation.business_ref_id = episode.business_ref_id
   AND evaluation.provider_account_id = episode.provider_account_id
   AND evaluation.decision_entity_type = 'ad'
   AND evaluation.decision_entity_id = episode.ad_id
   AND evaluation.ad_id = episode.ad_id
   AND evaluation.as_of_date = episode.as_of_date
   AND evaluation.engine_version = episode.engine_version
   AND evaluation.scope_type = episode.scope_type
   AND evaluation.scope_id = episode.scope_id
   AND evaluation.input_hash = episode.input_hash
   AND evaluation.decision_hash = episode.decision_hash
  WHERE episode.business_ref_id = $1::uuid
    AND episode.business_id = $1::uuid::text
    AND episode.provider_account_id = $2
    AND episode.ad_id = $3
    AND episode.decision_snapshot_id = $4::uuid
    AND episode.evaluation_id = $5::uuid
    AND episode.engine_version = $6
    AND episode.engine_version = '${NATIVE_AD_ENGINE_VERSION}'
    AND episode.decision_hash = $7
    AND snapshot.blocked_action_type IS NULL
    AND snapshot.authorized_action = CASE $8
      WHEN 'pause' THEN 'cut'
      WHEN 'resume' THEN 'scale'
      ELSE NULL
    END
)
INSERT INTO meta_ads_action_log (
  business_id, ad_id, creative_id, action, source, requested_by,
  payload_request, status, decision_contract_version,
  provider_account_ref_id, provider_account_id, decision_episode_key,
  decision_snapshot_id, decision_evaluation_id, decision_engine_version,
  decision_hash, idempotency_key, dry_run, provider_verified
)
SELECT
  source_lineage.business_ref_id, source_lineage.ad_id,
  source_lineage.creative_id, $8, 'decision_origin', $9::uuid,
  $10::jsonb, 'pending', '${DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION}',
  source_lineage.provider_account_ref_id,
  source_lineage.provider_account_id, source_lineage.episode_key,
  source_lineage.decision_snapshot_id, source_lineage.evaluation_id,
  source_lineage.engine_version, source_lineage.decision_hash,
  $11, $12::boolean, false
FROM source_lineage
ON CONFLICT (business_id, idempotency_key)
  WHERE source = 'decision_origin'
DO NOTHING
RETURNING *
`;

export const LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY = `
SELECT pg_advisory_xact_lock(hashtextextended($1, 0))
`;
export const LOCK_DECISION_ORIGIN_AD_ACTION_CLAIM_QUERY =
  LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY;

export const READ_MANUAL_META_AD_STATUS_MUTATION_SOURCE_QUERY = `
SELECT
  action_log.id::text,
  action_log.business_id::text,
  action_log.provider_account_id,
  action_log.ad_id,
  action_log.creative_id,
  action_log.action,
  action_log.source,
  action_log.requested_at,
  action_log.payload_request,
  action_log.status,
  action_log.dry_run,
  action_log.terminal_finalized_at,
  reconciliation.id::text AS reconciliation_event_id,
  binding.provider_account_ref_id::text AS bound_provider_account_ref_id,
  binding.binding_count::integer AS bound_provider_account_count,
  clock_timestamp() AS db_now
FROM meta_ads_action_log action_log
LEFT JOIN LATERAL (
  SELECT
    max(candidate.provider_account_ref_id::text) AS provider_account_ref_id,
    count(*)::integer AS binding_count
  FROM business_provider_accounts candidate
  WHERE candidate.business_id = action_log.business_id::text
    AND candidate.provider = 'meta'
    AND candidate.provider_account_id = action_log.provider_account_id
) binding ON true
LEFT JOIN LATERAL (
  SELECT event.id
  FROM meta_ads_action_reconciliation_events event
  WHERE event.source_action_log_id = action_log.id
  LIMIT 1
) reconciliation ON true
WHERE action_log.id = $1::uuid
FOR UPDATE OF action_log
`;

export const READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY = `
SELECT *
FROM meta_ads_action_mutation_attempt_events
WHERE source_action_log_id = $1::uuid
ORDER BY
  CASE event_kind WHEN 'attempt_started' THEN 0 ELSE 1 END,
    created_at ASC
`;

export const READ_MANUAL_META_AD_STATUS_MUTATION_SOURCE_IDENTITY_QUERY = `
SELECT
  action_log.business_id::text,
  action_log.provider_account_id,
  action_log.ad_id,
  action_log.creative_id,
  action_log.action,
  action_log.source
FROM meta_ads_action_log action_log
WHERE action_log.id = $1::uuid
`;

export const INSERT_MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_QUERY = `
INSERT INTO meta_ads_action_mutation_attempt_events (
  source_action_log_id,
  business_id,
  provider_account_ref_id,
  provider_account_id,
  ad_id,
  creative_id,
  campaign_id,
  adset_id,
  action,
  attempt_id,
  event_kind,
  post_path,
  started_at,
  lease_deadline,
  attempted_at,
  completed_at,
  completion_outcome,
  provider_response_received,
  provider_response_successful,
  http_status,
  provider_outcome,
  provider_response_json,
  verification_json,
  transport_error_json,
  evidence_json,
  evidence_hash
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4,
  $5,
  $6,
  $7,
  $8,
  $9,
  $10::uuid,
  $11,
  $12,
  $13::timestamptz,
  $14::timestamptz,
  $15::timestamptz,
  $16::timestamptz,
  $17,
  $18::boolean,
  $19::boolean,
  $20::integer,
  $21,
  $22::jsonb,
  $23::jsonb,
  $24::jsonb,
  $25::jsonb,
  encode(digest($25::jsonb::text, 'sha256'), 'hex')
)
ON CONFLICT (source_action_log_id, event_kind) DO NOTHING
RETURNING *
`;

export const READ_MANUAL_META_AD_STATUS_RECONCILIATION_SOURCE_QUERY = `
SELECT
  action_log.id::text,
  action_log.business_id::text,
  action_log.provider_account_id,
  action_log.ad_id,
  action_log.creative_id,
  action_log.action,
  action_log.source,
  action_log.requested_at,
  action_log.updated_at,
  action_log.verified_at,
  action_log.payload_request,
  action_log.status,
  action_log.dry_run,
  action_log.terminal_finalized_at,
  binding.provider_account_ref_id::text AS bound_provider_account_ref_id,
  binding.binding_count::integer AS bound_provider_account_count,
  clock_timestamp() AS db_now
FROM meta_ads_action_log action_log
LEFT JOIN LATERAL (
  SELECT
    max(candidate.provider_account_ref_id::text) AS provider_account_ref_id,
    count(*)::integer AS binding_count
  FROM business_provider_accounts candidate
  WHERE candidate.business_id = action_log.business_id::text
    AND candidate.provider = 'meta'
    AND candidate.provider_account_id = $2
) binding ON true
WHERE action_log.id = $1::uuid
FOR UPDATE OF action_log
`;

export const READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY = `
SELECT
  action_log.id::text,
  action_log.business_id::text,
  action_log.provider_account_id,
  action_log.ad_id,
  action_log.creative_id,
  action_log.action,
  action_log.source,
  action_log.requested_at,
  action_log.updated_at,
  action_log.verified_at,
  action_log.payload_request,
  action_log.status,
  action_log.dry_run,
  action_log.terminal_finalized_at,
  binding.provider_account_ref_id::text AS bound_provider_account_ref_id,
  binding.binding_count::integer AS bound_provider_account_count,
  clock_timestamp() AS db_now,
  count(*) OVER ()::integer AS unresolved_source_count
FROM meta_ads_action_log action_log
LEFT JOIN LATERAL (
  SELECT
    max(candidate.provider_account_ref_id::text) AS provider_account_ref_id,
    count(*)::integer AS binding_count
  FROM business_provider_accounts candidate
  WHERE candidate.business_id = action_log.business_id::text
    AND candidate.provider = 'meta'
    AND candidate.provider_account_id = $2
) binding ON true
WHERE action_log.business_id = $1::uuid
  AND action_log.ad_id = $3
  AND action_log.source <> 'decision_origin'
  AND action_log.action IN ('pause', 'resume')
  AND action_log.status IN ('pending', 'silent_failure')
  AND NOT COALESCE(
    action_log.payload_request->>'dry_run' = 'true',
    action_log.dry_run,
    false
  )
  AND (
    action_log.provider_account_id = $2
    OR action_log.provider_account_id IS NULL
  )
  AND NOT EXISTS (
    SELECT 1
    FROM meta_ads_action_reconciliation_events reconciliation
    WHERE reconciliation.source_action_log_id = action_log.id
      AND reconciliation.business_id = action_log.business_id
      AND reconciliation.provider_account_id = $2
      AND reconciliation.ad_id = action_log.ad_id
      AND reconciliation.action = action_log.action
  )
ORDER BY action_log.requested_at ASC, action_log.id ASC
LIMIT 1
`;

export const READ_LEGACY_MANUAL_META_AD_STATUS_TARGET_QUERY = `
SELECT
  count(*)::integer AS target_count,
  max(provider_account_ref_id::text) AS provider_account_ref_id,
  max(provider_account_id) AS provider_account_id,
  max(creative_id) AS creative_id,
  max(campaign_id) AS campaign_id,
  max(adset_id) AS adset_id
FROM meta_ad_dimensions
WHERE business_id = $1::uuid::text
  AND ad_id = $2
`;

export const READ_MANUAL_META_AD_STATUS_RECONCILIATION_EVENT_QUERY = `
SELECT *
FROM meta_ads_action_reconciliation_events
WHERE source_action_log_id = $1::uuid
LIMIT 1
`;

export const INSERT_MANUAL_META_AD_STATUS_RECONCILIATION_EVENT_QUERY = `
INSERT INTO meta_ads_action_reconciliation_events (
  source_action_log_id,
  source_attempt_id,
  source_attempt_completed_event_id,
  business_id,
  provider_account_ref_id,
  source_provider_account_id,
  provider_account_id,
  ad_id,
  creative_id,
  campaign_id,
  adset_id,
  action,
  source_authority_kind,
  source_outcome,
  source_requested_at,
  source_lease_deadline,
  source_attempted_at,
  source_completed_at,
  source_terminal_finalized_at,
  source_legacy_anchor_at,
  settlement_not_before,
  resolution,
  requested_status,
  observed_status,
  observed_effective_status,
  observed_campaign_status,
  observed_campaign_effective_status,
  observed_adset_status,
  observed_adset_effective_status,
  policy_eligible,
  review_status,
  observed_at,
  captured_at,
  evidence_json,
  evidence_hash
) VALUES (
  $1::uuid,
  $2::uuid,
  $3::uuid,
  $4::uuid,
  $5::uuid,
  $6,
  $7,
  $8,
  $9,
  $10,
  $11,
  $12,
  $13,
  $14,
  $15::timestamptz,
  $16::timestamptz,
  $17::timestamptz,
  $18::timestamptz,
  $19::timestamptz,
  $20::timestamptz,
  $21::timestamptz,
  $22,
  $23,
  $24,
  $25,
  $26,
  $27,
  $28,
  $29,
  $30::boolean,
  $31,
  $32::timestamptz,
  $33::timestamptz,
  $34::jsonb,
  encode(digest($34::jsonb::text, 'sha256'), 'hex')
)
ON CONFLICT (source_action_log_id) DO NOTHING
RETURNING *
`;

function metaAdStatusActionClaimKey(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}) {
  return JSON.stringify([
    input.businessId,
    input.providerAccountId,
    input.adId,
  ]);
}

function manualMetaAdRequestedStatus(
  action: Extract<MetaAdsActionKind, "pause" | "resume">,
): ManualMetaAdConfiguredStatus {
  return action === "pause" ? "PAUSED" : "ACTIVE";
}

function cloneJsonRecord(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> {
  let cloned: unknown;
  try {
    cloned = JSON.parse(JSON.stringify(value));
  } catch {
    throw new TypeError(`${field} must be a JSON-serializable object.`);
  }
  if (!cloned || typeof cloned !== "object" || Array.isArray(cloned)) {
    throw new TypeError(`${field} must be a JSON-serializable object.`);
  }
  return cloned as Record<string, unknown>;
}

function normalizedProviderAccountEvidenceId(value: string) {
  return value.trim().replace(/^act_/i, "");
}

function jsonRecordField(
  value: Record<string, unknown>,
  field: string,
): Record<string, unknown> | null {
  const nested = value[field];
  return nested != null &&
    typeof nested === "object" &&
    !Array.isArray(nested)
    ? (nested as Record<string, unknown>)
    : null;
}

function normalizedEvidenceString(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function normalizedEvidenceStatus(value: unknown) {
  return normalizedEvidenceString(value).toUpperCase();
}

function manualMetaAdStatusWriteVerificationIsExact(input: {
  verification: Record<string, unknown> | null;
  target: ManualMetaAdStatusMutationTarget;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  providerCompletedAt: string;
  dbNow: string;
}) {
  const verification = input.verification;
  if (!verification) return false;
  const providerGet = jsonRecordField(
    verification,
    "providerGetEvidence",
  );
  const creative = providerGet
    ? jsonRecordField(providerGet, "creative")
    : null;
  const campaign = providerGet
    ? jsonRecordField(providerGet, "campaign")
    : null;
  const adset = providerGet
    ? jsonRecordField(providerGet, "adset")
    : null;
  const observedAt = normalizedEvidenceString(verification.observedAt);
  const observedAtMs = Date.parse(observedAt);
  const requestedStatus = manualMetaAdRequestedStatus(input.action);
  return Boolean(
    verification.contractVersion ===
      MANUAL_META_AD_STATUS_WRITE_VERIFICATION_CONTRACT_VERSION &&
      normalizedEvidenceString(verification.adId) === input.target.adId &&
      normalizedEvidenceString(verification.providerAccountId) ===
        input.target.providerAccountId &&
      normalizedEvidenceString(verification.creativeId) ===
        input.target.creativeId &&
      normalizedEvidenceString(verification.campaignId) ===
        input.target.campaignId &&
      normalizedEvidenceString(verification.adsetId) ===
        input.target.adsetId &&
      normalizedEvidenceStatus(verification.configuredStatus) ===
        requestedStatus &&
      normalizedEvidenceStatus(verification.effectiveStatus) ===
        requestedStatus &&
      normalizedEvidenceStatus(
        verification.campaignConfiguredStatus,
      ) === "ACTIVE" &&
      normalizedEvidenceStatus(
        verification.campaignEffectiveStatus,
      ) === "ACTIVE" &&
      normalizedEvidenceStatus(
        verification.adsetConfiguredStatus,
      ) === "ACTIVE" &&
      normalizedEvidenceStatus(
        verification.adsetEffectiveStatus,
      ) === "ACTIVE" &&
      verification.policyEligible === true &&
      Object.prototype.hasOwnProperty.call(
        verification,
        "reviewStatus",
      ) &&
      verification.reviewStatus === null &&
      Number.isFinite(observedAtMs) &&
      observedAtMs >= Date.parse(input.providerCompletedAt) &&
      observedAtMs <= Date.parse(input.dbNow) &&
      providerGet &&
      normalizedEvidenceString(providerGet.id) === input.target.adId &&
      normalizedProviderAccountEvidenceId(
        normalizedEvidenceString(providerGet.account_id),
      ) ===
        normalizedProviderAccountEvidenceId(
          input.target.providerAccountId,
        ) &&
      normalizedEvidenceStatus(providerGet.status) === requestedStatus &&
      normalizedEvidenceStatus(providerGet.effective_status) ===
        requestedStatus &&
      creative &&
      normalizedEvidenceString(creative.id) === input.target.creativeId &&
      campaign &&
      normalizedEvidenceString(campaign.id) === input.target.campaignId &&
      normalizedEvidenceStatus(campaign.status) === "ACTIVE" &&
      normalizedEvidenceStatus(campaign.effective_status) === "ACTIVE" &&
      adset &&
      normalizedEvidenceString(adset.id) === input.target.adsetId &&
      normalizedEvidenceStatus(adset.status) === "ACTIVE" &&
      normalizedEvidenceStatus(adset.effective_status) === "ACTIVE",
  );
}

function mapManualMetaAdStatusMutationAttemptEvent(
  row: ManualMetaAdStatusMutationAttemptDbRow,
): ManualMetaAdStatusMutationAttemptEvent {
  if (
    row.contract_version !==
    MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION
  ) {
    throw new Error(
      "Manual Meta status mutation attempt contract version is unsupported.",
    );
  }
  return {
    id: row.id,
    contractVersion:
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
    sourceActionLogId: row.source_action_log_id,
    businessId: row.business_id,
    providerAccountRefId: row.provider_account_ref_id,
    providerAccountId: row.provider_account_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    action: row.action,
    attemptId: row.attempt_id,
    eventKind: row.event_kind,
    postPath: row.post_path,
    startedAt: canonicalIsoTimestamp(row.started_at, "started_at"),
    leaseDeadline: canonicalIsoTimestamp(
      row.lease_deadline,
      "lease_deadline",
    ),
    attemptedAt: nullableCanonicalIsoTimestamp(
      row.attempted_at,
      "attempted_at",
    ),
    completedAt: nullableCanonicalIsoTimestamp(
      row.completed_at,
      "completed_at",
    ),
    completionOutcome: row.completion_outcome,
    providerResponseReceived: row.provider_response_received,
    providerResponseSuccessful: row.provider_response_successful,
    httpStatus: row.http_status,
    providerOutcome: row.provider_outcome,
    providerResponse: row.provider_response_json,
    verification: row.verification_json,
    transportError: row.transport_error_json,
    evidence: row.evidence_json,
    evidenceHash: row.evidence_hash,
    createdAt: canonicalIsoTimestamp(row.created_at, "created_at"),
  };
}

function validateManualMetaAdStatusMutationTarget(
  target: ManualMetaAdStatusMutationTarget,
) {
  const normalized = {
    businessId: target.businessId.trim(),
    providerAccountId: target.providerAccountId.trim(),
    adId: target.adId.trim(),
    creativeId: target.creativeId.trim(),
    campaignId: target.campaignId.trim(),
    adsetId: target.adsetId.trim(),
  };
  if (
    !normalized.businessId ||
    !normalized.providerAccountId ||
    !isExactMetaProviderEntityId(normalized.adId) ||
    !normalized.creativeId ||
    !normalized.campaignId ||
    !normalized.adsetId
  ) {
    throw new TypeError(
      "Manual Meta mutation attempts require an exact target hierarchy.",
    );
  }
  return normalized;
}

function manualMutationAttemptEvidence(input: {
  sourceActionLogId: string;
  eventKind: "attempt_started" | "attempt_completed";
  attemptId: string;
  target: ManualMetaAdStatusMutationTarget & {
    providerAccountRefId: string;
  };
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  postPath: string;
  startedAt: string;
  leaseDeadline: string;
  completion?: {
    outcome: ManualMetaAdStatusMutationCompletionOutcome;
    mutationAttempt: ManualMetaProviderMutationAttemptReceipt;
    providerOutcome:
      | "outcome_ambiguous"
      | "definite_failure"
      | "provider_response_succeeded"
      | "verified_success";
    providerResponse: Record<string, unknown> | null;
    verification: Record<string, unknown> | null;
  };
}) {
  return {
    contractVersion:
      MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
    eventKind: input.eventKind,
    sourceActionLogId: input.sourceActionLogId,
    attemptId: input.attemptId,
    target: {
      businessId: input.target.businessId,
      providerAccountRefId: input.target.providerAccountRefId,
      providerAccountId: input.target.providerAccountId,
      adId: input.target.adId,
      creativeId: input.target.creativeId,
      campaignId: input.target.campaignId,
      adsetId: input.target.adsetId,
    },
    action: input.action,
    postPath: input.postPath,
    startedAt: input.startedAt,
    leaseDeadline: input.leaseDeadline,
    ...(input.completion
      ? {
          completionOutcome: input.completion.outcome,
          mutationAttempt: input.completion.mutationAttempt,
          providerOutcome: input.completion.providerOutcome,
          providerResponse: input.completion.providerResponse,
          verification: input.completion.verification,
        }
      : {}),
  };
}

function manualMutationAttemptBaseParams(input: {
  sourceActionLogId: string;
  target: ManualMetaAdStatusMutationTarget & {
    providerAccountRefId: string;
  };
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  attemptId: string;
  eventKind: "attempt_started" | "attempt_completed";
  postPath: string;
  startedAt: string;
  leaseDeadline: string;
  attemptedAt?: string | null;
  completedAt?: string | null;
  completionOutcome?: ManualMetaAdStatusMutationCompletionOutcome | null;
  providerResponseReceived?: boolean | null;
  providerResponseSuccessful?: boolean | null;
  httpStatus?: number | null;
  providerOutcome?:
    | "outcome_ambiguous"
    | "definite_failure"
    | "provider_response_succeeded"
    | "verified_success"
    | null;
  providerResponse?: Record<string, unknown> | null;
  verification?: Record<string, unknown> | null;
  transportError?: Record<string, unknown> | null;
  evidence: Record<string, unknown>;
}) {
  return [
    input.sourceActionLogId,
    input.target.businessId,
    input.target.providerAccountRefId,
    input.target.providerAccountId,
    input.target.adId,
    input.target.creativeId,
    input.target.campaignId,
    input.target.adsetId,
    input.action,
    input.attemptId,
    input.eventKind,
    input.postPath,
    input.startedAt,
    input.leaseDeadline,
    input.attemptedAt ?? null,
    input.completedAt ?? null,
    input.completionOutcome ?? null,
    input.providerResponseReceived ?? null,
    input.providerResponseSuccessful ?? null,
    input.httpStatus ?? null,
    input.providerOutcome ?? null,
    input.providerResponse == null
      ? null
      : JSON.stringify(input.providerResponse),
    input.verification == null
      ? null
      : JSON.stringify(input.verification),
    input.transportError == null
      ? null
      : JSON.stringify(input.transportError),
    JSON.stringify(input.evidence),
  ];
}

function mutationAttemptEventMatches(
  existing: ManualMetaAdStatusMutationAttemptEvent,
  evidence: Record<string, unknown>,
) {
  return isDeepStrictEqual(existing.evidence, evidence);
}

export async function appendManualMetaAdStatusMutationAttemptStarted(
  input: AppendManualMetaAdStatusMutationAttemptStartedInput,
): Promise<ManualMetaAdStatusMutationAttemptEvent> {
  const sourceActionLogId = input.sourceActionLogId.trim();
  const target = validateManualMetaAdStatusMutationTarget(input.target);
  const postPath = input.postPath.trim();
  if (
    !sourceActionLogId ||
    (input.action !== "pause" && input.action !== "resume") ||
    postPath.replace(/^\/+|\/+$/g, "") !== target.adId
  ) {
    throw new TypeError(
      "Manual Meta mutation attempt start requires an exact source, action, and POST path.",
    );
  }
  return runDbTransaction(async () => {
    const sql = getDb();
    await sql.query(LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY, [
      metaAdStatusActionClaimKey(target),
    ]);
    const sourceRows =
      await sql.query<ManualMetaAdStatusReconciliationSourceRow>(
        READ_MANUAL_META_AD_STATUS_MUTATION_SOURCE_QUERY,
        [sourceActionLogId],
      );
    const source = sourceRows[0];
    const durableTarget =
      source?.creative_id != null
        ? exactDurableManualMetaTarget(
            source.payload_request?.manual_status_mutation_target,
            {
              businessId: source.business_id,
              providerAccountId: source.provider_account_id ?? "",
              adId: source.ad_id,
              creativeId: source.creative_id,
            },
          )
        : null;
    if (
      !source ||
      source.source === "decision_origin" ||
      source.status !== "pending" ||
      manualMetaAdSourceIsDryRun(source) ||
      source.business_id !== target.businessId ||
      source.provider_account_id !== target.providerAccountId ||
      source.ad_id !== target.adId ||
      source.creative_id !== target.creativeId ||
      source.action !== input.action ||
      source.payload_request?.mutation_journal_contract_version !==
        MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION ||
      source.payload_request?.mutation_journal_required !== true ||
      !durableTarget ||
      durableTarget.campaignId !== target.campaignId ||
      durableTarget.adsetId !== target.adsetId ||
      source.reconciliation_event_id != null ||
      !source.bound_provider_account_ref_id ||
      Number(source.bound_provider_account_count) !== 1
    ) {
      throw new Error(
        "Manual Meta mutation attempt start source lineage is not exact.",
      );
    }
    const existingRows =
      await sql.query<ManualMetaAdStatusMutationAttemptDbRow>(
        READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY,
        [sourceActionLogId],
      );
    const existingStarted = existingRows
      .map(mapManualMetaAdStatusMutationAttemptEvent)
      .find((event) => event.eventKind === "attempt_started");
    if (existingStarted) {
      const existingTarget = {
        businessId: existingStarted.businessId,
        providerAccountRefId: existingStarted.providerAccountRefId,
        providerAccountId: existingStarted.providerAccountId,
        adId: existingStarted.adId,
        creativeId: existingStarted.creativeId,
        campaignId: existingStarted.campaignId,
        adsetId: existingStarted.adsetId,
      };
      const expectedEvidence = manualMutationAttemptEvidence({
        sourceActionLogId,
        eventKind: "attempt_started",
        attemptId: existingStarted.attemptId,
        target: existingTarget,
        action: input.action,
        postPath,
        startedAt: existingStarted.startedAt,
        leaseDeadline: existingStarted.leaseDeadline,
      });
      if (
        existingTarget.providerAccountRefId !==
          source.bound_provider_account_ref_id ||
        !mutationAttemptEventMatches(existingStarted, expectedEvidence)
      ) {
        throw new Error(
          "Manual Meta mutation attempt source already has a different start.",
        );
      }
      return { ...existingStarted, idempotentReplay: true };
    }

    const attemptId = randomUUID();
    const startedAt = canonicalIsoTimestamp(source.db_now, "db_now");
    const leaseDeadline = new Date(
      Date.parse(startedAt) +
        MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_LEASE_MS,
    ).toISOString();
    const exactTarget = {
      ...target,
      providerAccountRefId: source.bound_provider_account_ref_id,
    };
    const evidence = manualMutationAttemptEvidence({
      sourceActionLogId,
      eventKind: "attempt_started",
      attemptId,
      target: exactTarget,
      action: input.action,
      postPath,
      startedAt,
      leaseDeadline,
    });
    const insertedRows =
      await sql.query<ManualMetaAdStatusMutationAttemptDbRow>(
        INSERT_MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_QUERY,
        manualMutationAttemptBaseParams({
          sourceActionLogId,
          target: exactTarget,
          action: input.action,
          attemptId,
          eventKind: "attempt_started",
          postPath,
          startedAt,
          leaseDeadline,
          evidence,
        }),
      );
    if (!insertedRows[0]) {
      throw new Error(
        "Manual Meta mutation attempt start lost its unique source claim.",
      );
    }
    return mapManualMetaAdStatusMutationAttemptEvent(insertedRows[0]);
  });
}

export async function appendManualMetaAdStatusMutationAttemptCompleted(
  input: AppendManualMetaAdStatusMutationAttemptCompletedInput,
): Promise<ManualMetaAdStatusMutationAttemptEvent> {
  const sourceActionLogId = input.sourceActionLogId.trim();
  const attemptId = input.attemptId.trim();
  if (!sourceActionLogId || !attemptId) {
    throw new TypeError(
      "Manual Meta mutation attempt completion requires exact source and attempt identity.",
    );
  }
  const clonedMutationAttempt = cloneJsonRecord(
    input.mutationAttempt as unknown as Record<string, unknown>,
    "mutationAttempt",
  ) as unknown as ManualMetaProviderMutationAttemptReceipt;
  const mutationAttempt: ManualMetaProviderMutationAttemptReceipt = {
    ...clonedMutationAttempt,
    providerResponseSuccessful:
      clonedMutationAttempt.providerResponseSuccessful === true,
  };
  const providerResponse =
    input.providerResponse == null
      ? null
      : cloneJsonRecord(input.providerResponse, "providerResponse");
  const verification =
    input.verification == null
      ? null
      : cloneJsonRecord(input.verification, "verification");
  const transportError =
    mutationAttempt.transportError == null
      ? null
      : cloneJsonRecord(
          mutationAttempt.transportError,
          "mutationAttempt.transportError",
        );
  return runDbTransaction(async () => {
    const sql = getDb();
    const sourceRows = await sql.query<{
      business_id: string;
      provider_account_id: string | null;
      ad_id: string;
      creative_id: string | null;
      action: MetaAdsActionKind;
      source: string;
    }>(
        READ_MANUAL_META_AD_STATUS_MUTATION_SOURCE_IDENTITY_QUERY,
        [sourceActionLogId],
      );
    const unlockedSource = sourceRows[0];
    if (!unlockedSource?.provider_account_id) {
      throw new Error(
        "Manual Meta mutation attempt completion source was not found.",
      );
    }
    await sql.query(LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY, [
      metaAdStatusActionClaimKey({
        businessId: unlockedSource.business_id,
        providerAccountId: unlockedSource.provider_account_id,
        adId: unlockedSource.ad_id,
      }),
    ]);
    const lockedSourceRows =
      await sql.query<ManualMetaAdStatusReconciliationSourceRow>(
        READ_MANUAL_META_AD_STATUS_MUTATION_SOURCE_QUERY,
        [sourceActionLogId],
      );
    const source = lockedSourceRows[0];
    if (
      !source?.provider_account_id ||
      source.business_id !== unlockedSource.business_id ||
      source.provider_account_id !== unlockedSource.provider_account_id ||
      source.ad_id !== unlockedSource.ad_id ||
      source.creative_id !== unlockedSource.creative_id ||
      source.action !== unlockedSource.action ||
      source.source !== unlockedSource.source ||
      source.reconciliation_event_id != null ||
      !source.bound_provider_account_ref_id ||
      Number(source.bound_provider_account_count) !== 1
    ) {
      throw new Error(
        "Manual Meta mutation attempt completion source changed before lock acquisition.",
      );
    }
    const attemptRows =
      await sql.query<ManualMetaAdStatusMutationAttemptDbRow>(
        READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY,
        [sourceActionLogId],
      );
    const events = attemptRows.map(
      mapManualMetaAdStatusMutationAttemptEvent,
    );
    const started = events.find(
      (event) => event.eventKind === "attempt_started",
    );
    const existingCompleted = events.find(
      (event) => event.eventKind === "attempt_completed",
    );
    if (!started || started.attemptId !== attemptId) {
      throw new Error(
        "Manual Meta mutation attempt completion has no exact immutable start.",
      );
    }
    const attemptedAt = canonicalIsoTimestamp(
      mutationAttempt.attemptedAt,
      "mutationAttempt.attemptedAt",
    );
    const completedAt = canonicalIsoTimestamp(
      mutationAttempt.completedAt,
      "mutationAttempt.completedAt",
    );
    if (
      mutationAttempt.attemptCount !== 1 ||
      mutationAttempt.method !== "POST" ||
      mutationAttempt.automaticRetryAttempted !== false ||
      mutationAttempt.path.trim() !== started.postPath ||
      Date.parse(attemptedAt) < Date.parse(started.startedAt) ||
      Date.parse(completedAt) < Date.parse(attemptedAt) ||
      Date.parse(completedAt) > Date.parse(started.leaseDeadline)
    ) {
      throw new Error(
        "Manual Meta mutation attempt completion geometry is contradictory.",
      );
    }

    const target = {
      businessId: started.businessId,
      providerAccountRefId: started.providerAccountRefId,
      providerAccountId: started.providerAccountId,
      adId: started.adId,
      creativeId: started.creativeId,
      campaignId: started.campaignId,
      adsetId: started.adsetId,
    };
    const exactVerifiedWrite = manualMetaAdStatusWriteVerificationIsExact({
      verification,
      target,
      action: started.action,
      providerCompletedAt: completedAt,
      dbNow: canonicalIsoTimestamp(source.db_now, "source.db_now"),
    });
    const responseSuccessful =
      mutationAttempt.providerResponseSuccessful === true;
    let providerOutcome:
      | "outcome_ambiguous"
      | "definite_failure"
      | "provider_response_succeeded"
      | "verified_success";
    if (input.completionOutcome === "provider_outcome_ambiguous") {
      providerOutcome = "outcome_ambiguous";
      if (
        mutationAttempt.providerResponseReceived ||
        responseSuccessful ||
        mutationAttempt.httpStatus !== null ||
        mutationAttempt.outcome !== "outcome_ambiguous" ||
        !transportError ||
        providerResponse !== null ||
        verification !== null
      ) {
        throw new Error(
          "Manual Meta ambiguous mutation completion geometry is invalid.",
        );
      }
    } else if (
      input.completionOutcome ===
      "provider_response_succeeded_verification_failed"
    ) {
      providerOutcome = "provider_response_succeeded";
      if (
        !mutationAttempt.providerResponseReceived ||
        !responseSuccessful ||
        mutationAttempt.outcome !== "provider_response_received" ||
        mutationAttempt.httpStatus == null ||
        mutationAttempt.httpStatus < 200 ||
        mutationAttempt.httpStatus >= 300 ||
        transportError !== null ||
        providerResponse?.success !== true ||
        !verification ||
        Object.keys(verification).length === 0 ||
        exactVerifiedWrite
      ) {
        throw new Error(
          "Manual Meta verification-failed mutation completion geometry is invalid.",
        );
      }
    } else if (
      input.completionOutcome === "provider_response_verified_success"
    ) {
      providerOutcome = "verified_success";
      if (
        !mutationAttempt.providerResponseReceived ||
        !responseSuccessful ||
        mutationAttempt.outcome !== "provider_response_received" ||
        mutationAttempt.httpStatus == null ||
        mutationAttempt.httpStatus < 200 ||
        mutationAttempt.httpStatus >= 300 ||
        transportError !== null ||
        providerResponse?.success !== true ||
        !exactVerifiedWrite
      ) {
        throw new Error(
          "Manual Meta verified mutation completion geometry is invalid.",
        );
      }
    } else {
      providerOutcome = "definite_failure";
      const providerError =
        providerResponse?.error &&
        typeof providerResponse.error === "object" &&
        !Array.isArray(providerResponse.error);
      if (
        !mutationAttempt.providerResponseReceived ||
        responseSuccessful ||
        mutationAttempt.outcome !== "provider_response_received" ||
        mutationAttempt.httpStatus == null ||
        (mutationAttempt.httpStatus < 400 && !providerError) ||
        transportError !== null ||
        !providerResponse ||
        verification !== null
      ) {
        throw new Error(
          "Manual Meta definite-failure mutation completion geometry is invalid.",
        );
      }
    }

    const evidence = manualMutationAttemptEvidence({
      sourceActionLogId,
      eventKind: "attempt_completed",
      attemptId,
      target,
      action: started.action,
      postPath: started.postPath,
      startedAt: started.startedAt,
      leaseDeadline: started.leaseDeadline,
      completion: {
        outcome: input.completionOutcome,
        mutationAttempt,
        providerOutcome,
        providerResponse,
        verification,
      },
    });
    if (existingCompleted) {
      if (!mutationAttemptEventMatches(existingCompleted, evidence)) {
        throw new Error(
          "Manual Meta mutation attempt already has a different completion.",
        );
      }
      return { ...existingCompleted, idempotentReplay: true };
    }
    if (source.status !== "pending") {
      throw new Error(
        "Manual Meta mutation attempt completion requires its source to remain pending.",
      );
    }
    const insertedRows =
      await sql.query<ManualMetaAdStatusMutationAttemptDbRow>(
        INSERT_MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_QUERY,
        manualMutationAttemptBaseParams({
          sourceActionLogId,
          target,
          action: started.action,
          attemptId,
          eventKind: "attempt_completed",
          postPath: started.postPath,
          startedAt: started.startedAt,
          leaseDeadline: started.leaseDeadline,
          attemptedAt,
          completedAt,
          completionOutcome: input.completionOutcome,
          providerResponseReceived:
            mutationAttempt.providerResponseReceived,
          providerResponseSuccessful: responseSuccessful,
          httpStatus: mutationAttempt.httpStatus,
          providerOutcome,
          providerResponse,
          verification,
          transportError,
          evidence,
        }),
      );
    if (!insertedRows[0]) {
      throw new Error(
        "Manual Meta mutation attempt completion lost its unique source claim.",
      );
    }
    return mapManualMetaAdStatusMutationAttemptEvent(insertedRows[0]);
  });
}

function manualMetaAdSourceIsDryRun(
  source: ManualMetaAdStatusReconciliationSourceRow,
) {
  const payload = source.payload_request;
  const payloadHasDryRun =
    payload != null &&
    Object.prototype.hasOwnProperty.call(payload, "dry_run");
  return payloadHasDryRun
    ? String(payload?.dry_run) === "true"
    : source.dry_run === true;
}

function manualMetaAdReconciliationCandidateBase(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
  source?: ManualMetaAdStatusReconciliationCandidateSourceRow;
}): ManualMetaAdStatusReconciliationCandidate {
  return {
    businessId: input.businessId,
    providerAccountId: input.providerAccountId,
    adId: input.adId,
    unresolvedSourceCount: input.source?.unresolved_source_count ?? 0,
    sourceActionLogId: input.source?.id ?? null,
    action:
      input.source?.action === "pause" || input.source?.action === "resume"
        ? input.source.action
        : null,
    creativeId: input.source?.creative_id ?? null,
    readyForProviderRead: false,
    settlementNotBefore: null,
    authorityKind: null,
    outcome: null,
    providerAccountRefId: null,
    campaignId: null,
    adsetId: null,
    blockerReason: null,
  };
}

function addMilliseconds(value: string, milliseconds: number) {
  return new Date(Date.parse(value) + milliseconds).toISOString();
}

function exactDurableManualMetaTarget(
  value: unknown,
  identity: {
    businessId: string;
    providerAccountId: string;
    adId: string;
    creativeId: string;
  },
): ManualMetaAdStatusMutationTarget | null {
  if (!value || typeof value !== "object" || Array.isArray(value)) return null;
  const target = value as Record<string, unknown>;
  if (
    target.businessId !== identity.businessId ||
    target.providerAccountId !== identity.providerAccountId ||
    target.adId !== identity.adId ||
    target.creativeId !== identity.creativeId ||
    typeof target.campaignId !== "string" ||
    !target.campaignId.trim() ||
    typeof target.adsetId !== "string" ||
    !target.adsetId.trim()
  ) {
    return null;
  }
  return {
    businessId: identity.businessId,
    providerAccountId: identity.providerAccountId,
    adId: identity.adId,
    creativeId: identity.creativeId,
    campaignId: target.campaignId.trim(),
    adsetId: target.adsetId.trim(),
  };
}

/**
 * Read-only, network-free readiness inspection. Callers must not perform the
 * provider GET unless readyForProviderRead is true. Event append revalidates
 * the same lineage under the shared advisory lock.
 */
export async function readManualMetaAdStatusReconciliationCandidate(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
}): Promise<ManualMetaAdStatusReconciliationCandidate> {
  const businessId = input.businessId.trim();
  const providerAccountId = input.providerAccountId.trim();
  const adId = input.adId.trim();
  if (
    !businessId ||
    !providerAccountId ||
    !isExactMetaProviderEntityId(adId)
  ) {
    throw new TypeError(
      "Manual Meta status reconciliation inspection requires exact business, provider-account, and Ad identity.",
    );
  }

  const sql = getDb();
  const sourceRows =
    await sql.query<ManualMetaAdStatusReconciliationCandidateSourceRow>(
      READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY,
      [businessId, providerAccountId, adId],
    );
  const source = sourceRows[0];
  const candidate = manualMetaAdReconciliationCandidateBase({
    businessId,
    providerAccountId,
    adId,
    source,
  });
  if (!source) {
    return {
      ...candidate,
      blockerReason: "no_unresolved_manual_source",
    };
  }
  const unresolvedSourceCount = Number(source.unresolved_source_count);
  if (!Number.isInteger(unresolvedSourceCount) || unresolvedSourceCount > 1) {
    return {
      ...candidate,
      unresolvedSourceCount:
        Number.isInteger(unresolvedSourceCount) && unresolvedSourceCount > 0
          ? unresolvedSourceCount
          : 2,
      blockerReason: "multiple_unresolved_manual_sources",
    };
  }
  if (
    source.source === "decision_origin" ||
    (source.action !== "pause" && source.action !== "resume") ||
    !source.creative_id ||
    !["pending", "silent_failure"].includes(source.status) ||
    manualMetaAdSourceIsDryRun(source)
  ) {
    return {
      ...candidate,
      blockerReason: "source_lineage_not_exact",
    };
  }

  const attempts =
    (
      await sql.query<ManualMetaAdStatusMutationAttemptDbRow>(
        READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY,
        [source.id],
      )
    ).map(mapManualMetaAdStatusMutationAttemptEvent);
  const started = attempts.find(
    (event) => event.eventKind === "attempt_started",
  );
  const completed = attempts.find(
    (event) => event.eventKind === "attempt_completed",
  );
  if (
    attempts.length > 2 ||
    (completed != null &&
      (started == null ||
        completed.attemptId !== started.attemptId ||
        completed.completionOutcome == null ||
        completed.completedAt == null))
  ) {
    return {
      ...candidate,
      blockerReason: "attempt_journal_contradictory",
    };
  }

  let authorityKind: ManualMetaAdStatusReconciliationAuthorityKind;
  let outcome: ManualMetaAdStatusReconciliationSourceOutcome;
  let settlementNotBefore: string;
  let providerAccountRefId: string | null;
  let target: ManualMetaAdStatusMutationTarget | null;

  if (completed && started) {
    authorityKind = "completed_attempt";
    outcome = completed.completionOutcome!;
    settlementNotBefore = addMilliseconds(
      completed.completedAt!,
      MANUAL_META_AD_STATUS_RECONCILIATION_MIN_SETTLEMENT_MS,
    );
    providerAccountRefId = completed.providerAccountRefId;
    target = {
      businessId: completed.businessId,
      providerAccountId: completed.providerAccountId,
      adId: completed.adId,
      creativeId: completed.creativeId,
      campaignId: completed.campaignId,
      adsetId: completed.adsetId,
    };
  } else if (started) {
    authorityKind = "lease_expired_started";
    outcome = "attempt_lease_expired_without_completion";
    settlementNotBefore = addMilliseconds(
      started.leaseDeadline,
      MANUAL_META_AD_STATUS_RECONCILIATION_MIN_SETTLEMENT_MS,
    );
    providerAccountRefId = started.providerAccountRefId;
    target = {
      businessId: started.businessId,
      providerAccountId: started.providerAccountId,
      adId: started.adId,
      creativeId: started.creativeId,
      campaignId: started.campaignId,
      adsetId: started.adsetId,
    };
    if (source.terminal_finalized_at != null) {
      return {
        ...candidate,
        authorityKind,
        outcome,
        settlementNotBefore,
        providerAccountRefId,
        campaignId: target.campaignId,
        adsetId: target.adsetId,
        blockerReason: "source_lineage_not_exact",
      };
    }
  } else {
    const durableTarget = exactDurableManualMetaTarget(
      source.payload_request?.manual_status_mutation_target,
      {
        businessId,
        providerAccountId,
        adId,
        creativeId: source.creative_id,
      },
    );
    const hasJournalContract =
      source.payload_request?.mutation_journal_contract_version ===
        MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION &&
      source.payload_request?.mutation_journal_required === true;
    if (hasJournalContract) {
      authorityKind = "pre_provider_no_attempt";
      outcome = "pre_provider_no_mutation_attempt";
      settlementNotBefore = addMilliseconds(
        canonicalIsoTimestamp(source.requested_at, "source.requested_at"),
        MANUAL_META_AD_STATUS_RECONCILIATION_MIN_SETTLEMENT_MS,
      );
      providerAccountRefId =
        source.bound_provider_account_ref_id ?? null;
      target = durableTarget;
      if (
        source.status !== "pending" ||
        source.provider_account_id !== providerAccountId ||
        source.terminal_finalized_at != null ||
        !target
      ) {
        return {
          ...candidate,
          authorityKind,
          outcome,
          settlementNotBefore,
          providerAccountRefId,
          campaignId: target?.campaignId ?? null,
          adsetId: target?.adsetId ?? null,
          blockerReason: "durable_target_not_exact",
        };
      }
    } else if (
      source.status === "silent_failure" &&
      source.provider_account_id == null &&
      source.terminal_finalized_at == null
    ) {
      authorityKind = "legacy_quarantine";
      outcome = "legacy_precontract_quarantine_elapsed";
      const legacyRows = await sql.query<{
        target_count: number;
        provider_account_ref_id: string | null;
        provider_account_id: string | null;
        creative_id: string | null;
        campaign_id: string | null;
        adset_id: string | null;
      }>(READ_LEGACY_MANUAL_META_AD_STATUS_TARGET_QUERY, [
        businessId,
        adId,
      ]);
      const legacy = legacyRows[0];
      const requestedAt = canonicalIsoTimestamp(
        source.requested_at,
        "source.requested_at",
      );
      const updatedAt = canonicalIsoTimestamp(
        source.updated_at,
        "source.updated_at",
      );
      const verifiedAt = nullableCanonicalIsoTimestamp(
        source.verified_at,
        "source.verified_at",
      );
      const legacyAnchorAt = new Date(
        Math.max(
          Date.parse(requestedAt),
          Date.parse(updatedAt),
          verifiedAt
            ? Date.parse(verifiedAt)
            : Number.NEGATIVE_INFINITY,
        ),
      ).toISOString();
      settlementNotBefore = addMilliseconds(
        legacyAnchorAt,
        MANUAL_META_AD_STATUS_LEGACY_QUARANTINE_MS,
      );
      providerAccountRefId = legacy?.provider_account_ref_id ?? null;
      target =
        legacy?.target_count === 1 &&
        legacy.provider_account_id === providerAccountId &&
        legacy.creative_id === source.creative_id &&
        legacy.campaign_id &&
        legacy.adset_id
          ? {
              businessId,
              providerAccountId,
              adId,
              creativeId: source.creative_id,
              campaignId: legacy.campaign_id,
              adsetId: legacy.adset_id,
            }
          : null;
      if (!target) {
        return {
          ...candidate,
          authorityKind,
          outcome,
          settlementNotBefore,
          providerAccountRefId,
          blockerReason: "legacy_target_not_unique",
        };
      }
    } else {
      return {
        ...candidate,
        blockerReason: "authority_not_supported",
      };
    }
  }

  if (
    !target ||
    target.businessId !== businessId ||
    target.providerAccountId !== providerAccountId ||
    target.adId !== adId ||
    target.creativeId !== source.creative_id
  ) {
    return {
      ...candidate,
      authorityKind,
      outcome,
      settlementNotBefore,
      providerAccountRefId,
      campaignId: target?.campaignId ?? null,
      adsetId: target?.adsetId ?? null,
      blockerReason: "durable_target_not_exact",
    };
  }
  if (
    !providerAccountRefId ||
    Number(source.bound_provider_account_count) !== 1 ||
    source.bound_provider_account_ref_id !== providerAccountRefId
  ) {
    return {
      ...candidate,
      authorityKind,
      outcome,
      settlementNotBefore,
      providerAccountRefId,
      campaignId: target.campaignId,
      adsetId: target.adsetId,
      blockerReason: "provider_binding_missing",
    };
  }
  const dbNow = canonicalIsoTimestamp(source.db_now, "db_now");
  const terminalFinalizedAt = nullableCanonicalIsoTimestamp(
    source.terminal_finalized_at,
    "source.terminal_finalized_at",
  );
  const effectiveReadNotBefore =
    terminalFinalizedAt &&
    Date.parse(terminalFinalizedAt) > Date.parse(settlementNotBefore)
      ? terminalFinalizedAt
      : settlementNotBefore;
  const readyForProviderRead =
    Date.parse(dbNow) >= Date.parse(effectiveReadNotBefore);
  return {
    ...candidate,
    authorityKind,
    outcome,
    providerAccountRefId,
    campaignId: target.campaignId,
    adsetId: target.adsetId,
    settlementNotBefore: effectiveReadNotBefore,
    readyForProviderRead,
    blockerReason: readyForProviderRead
      ? null
      : "settlement_not_elapsed",
  };
}

function mapManualMetaAdStatusReconciliationEvent(
  row: ManualMetaAdStatusReconciliationDbRow,
): ManualMetaAdStatusReconciliationEvent {
  if (
    row.contract_version !==
    MANUAL_META_AD_STATUS_RECONCILIATION_CONTRACT_VERSION
  ) {
    throw new Error(
      "Manual Meta status reconciliation contract version is unsupported.",
    );
  }
  return {
    id: row.id,
    contractVersion:
      MANUAL_META_AD_STATUS_RECONCILIATION_CONTRACT_VERSION,
    sourceActionLogId: row.source_action_log_id,
    sourceAttemptId: row.source_attempt_id,
    sourceAttemptCompletedEventId:
      row.source_attempt_completed_event_id,
    businessId: row.business_id,
    providerAccountRefId: row.provider_account_ref_id,
    sourceProviderAccountId: row.source_provider_account_id,
    providerAccountId: row.provider_account_id,
    adId: row.ad_id,
    creativeId: row.creative_id,
    campaignId: row.campaign_id,
    adsetId: row.adset_id,
    action: row.action,
    sourceAuthorityKind: row.source_authority_kind,
    sourceOutcome: row.source_outcome,
    sourceRequestedAt: canonicalIsoTimestamp(
      row.source_requested_at,
      "source_requested_at",
    ),
    sourceLeaseDeadline: nullableCanonicalIsoTimestamp(
      row.source_lease_deadline,
      "source_lease_deadline",
    ),
    sourceAttemptedAt: nullableCanonicalIsoTimestamp(
      row.source_attempted_at,
      "source_attempted_at",
    ),
    sourceCompletedAt: nullableCanonicalIsoTimestamp(
      row.source_completed_at,
      "source_completed_at",
    ),
    sourceTerminalFinalizedAt: nullableCanonicalIsoTimestamp(
      row.source_terminal_finalized_at,
      "source_terminal_finalized_at",
    ),
    sourceLegacyAnchorAt: nullableCanonicalIsoTimestamp(
      row.source_legacy_anchor_at,
      "source_legacy_anchor_at",
    ),
    settlementNotBefore: canonicalIsoTimestamp(
      row.settlement_not_before,
      "settlement_not_before",
    ),
    resolution: row.resolution,
    requestedStatus: row.requested_status,
    observedStatus: row.observed_status,
    observedEffectiveStatus: row.observed_effective_status,
    observedCampaignStatus: row.observed_campaign_status,
    observedCampaignEffectiveStatus:
      row.observed_campaign_effective_status,
    observedAdsetStatus: row.observed_adset_status,
    observedAdsetEffectiveStatus:
      row.observed_adset_effective_status,
    policyEligible: true,
    reviewStatus: null,
    observedAt: canonicalIsoTimestamp(row.observed_at, "observed_at"),
    capturedAt: canonicalIsoTimestamp(row.captured_at, "captured_at"),
    evidence: row.evidence_json,
    evidenceHash: row.evidence_hash,
    createdAt: canonicalIsoTimestamp(row.created_at, "created_at"),
  };
}

function manualMetaAdReconciliationMatches(
  existing: ManualMetaAdStatusReconciliationEvent,
  input: {
    sourceActionLogId: string;
    resolution: ManualMetaAdStatusReconciliationResolution;
    observedAt: string;
    evidence: Record<string, unknown>;
  },
) {
  return (
    existing.sourceActionLogId === input.sourceActionLogId &&
    existing.resolution === input.resolution &&
    existing.observedAt === input.observedAt &&
    isDeepStrictEqual(existing.evidence, input.evidence)
  );
}

function reconciliationEvidenceRecord(
  value: Record<string, unknown>,
  field: string,
) {
  const candidate = value[field];
  if (!candidate || typeof candidate !== "object" || Array.isArray(candidate)) {
    throw new TypeError(
      `Manual Meta status reconciliation provider GET omitted ${field}.`,
    );
  }
  return candidate as Record<string, unknown>;
}

export async function appendManualMetaAdStatusReconciliationEvent(
  input: AppendManualMetaAdStatusReconciliationInput,
): Promise<ManualMetaAdStatusReconciliationEvent> {
  const sourceActionLogId = input.sourceActionLogId.trim();
  const businessId = input.businessId.trim();
  const providerAccountId = input.providerAccountId.trim();
  const adId = input.adId.trim();
  if (
    !sourceActionLogId ||
    !businessId ||
    !providerAccountId ||
    !isExactMetaProviderEntityId(adId)
  ) {
    throw new TypeError(
      "Manual Meta status reconciliation requires exact source, business, provider-account, and Ad identity.",
    );
  }
  if (input.action !== "pause" && input.action !== "resume") {
    throw new TypeError(
      "Manual Meta status reconciliation requires pause or resume.",
    );
  }
  if (
    input.observedStatus !== "ACTIVE" &&
    input.observedStatus !== "PAUSED"
  ) {
    throw new TypeError(
      "Manual Meta status reconciliation requires ACTIVE or PAUSED observed status.",
    );
  }
  const observedEffectiveStatus =
    input.observedEffectiveStatus.trim().toUpperCase();
  if (
    observedEffectiveStatus !== "ACTIVE" &&
    observedEffectiveStatus !== "PAUSED"
  ) {
    throw new TypeError(
      "Manual Meta status reconciliation requires ACTIVE or PAUSED effective status.",
    );
  }
  if (
    input.resolvedTarget.businessId !== businessId ||
    input.resolvedTarget.providerAccountId !== providerAccountId ||
    input.resolvedTarget.adId !== adId ||
    !input.resolvedTarget.creativeId.trim() ||
    !input.resolvedTarget.campaignId.trim() ||
    !input.resolvedTarget.adsetId.trim()
  ) {
    throw new TypeError(
      "Manual Meta status reconciliation resolved target is not exact.",
    );
  }

  const providerGetEvidence = cloneJsonRecord(
    input.providerGetEvidence,
    "providerGetEvidence",
  );
  const providerAdId =
    typeof providerGetEvidence.id === "string"
      ? providerGetEvidence.id.trim()
      : "";
  const providerEvidenceAccountId =
    typeof providerGetEvidence.account_id === "string"
      ? providerGetEvidence.account_id.trim()
      : "";
  const providerObservedStatus =
    typeof providerGetEvidence.status === "string"
      ? providerGetEvidence.status.trim().toUpperCase()
      : "";
  const providerObservedEffectiveStatus =
    typeof providerGetEvidence.effective_status === "string"
      ? providerGetEvidence.effective_status.trim().toUpperCase()
      : "";
  const providerCreative = reconciliationEvidenceRecord(
    providerGetEvidence,
    "creative",
  );
  const providerCampaign = reconciliationEvidenceRecord(
    providerGetEvidence,
    "campaign",
  );
  const providerAdset = reconciliationEvidenceRecord(
    providerGetEvidence,
    "adset",
  );
  const providerCreativeId =
    typeof providerCreative.id === "string"
      ? providerCreative.id.trim()
      : "";
  const providerCampaignId =
    typeof providerCampaign.id === "string"
      ? providerCampaign.id.trim()
      : "";
  const providerCampaignStatus =
    typeof providerCampaign.status === "string"
      ? providerCampaign.status.trim().toUpperCase()
      : "";
  const providerCampaignEffectiveStatus =
    typeof providerCampaign.effective_status === "string"
      ? providerCampaign.effective_status.trim().toUpperCase()
      : "";
  const providerAdsetId =
    typeof providerAdset.id === "string" ? providerAdset.id.trim() : "";
  const providerAdsetStatus =
    typeof providerAdset.status === "string"
      ? providerAdset.status.trim().toUpperCase()
      : "";
  const providerAdsetEffectiveStatus =
    typeof providerAdset.effective_status === "string"
      ? providerAdset.effective_status.trim().toUpperCase()
      : "";
  if (
    providerAdId !== adId ||
    !providerEvidenceAccountId ||
    normalizedProviderAccountEvidenceId(providerEvidenceAccountId) !==
      normalizedProviderAccountEvidenceId(providerAccountId) ||
    providerObservedStatus !== input.observedStatus ||
    providerObservedEffectiveStatus !== observedEffectiveStatus ||
    providerObservedStatus !== providerObservedEffectiveStatus ||
    providerCreativeId !== input.resolvedTarget.creativeId ||
    providerCampaignId !== input.resolvedTarget.campaignId ||
    providerCampaignStatus !== "ACTIVE" ||
    providerCampaignEffectiveStatus !== "ACTIVE" ||
    providerAdsetId !== input.resolvedTarget.adsetId ||
    providerAdsetStatus !== "ACTIVE" ||
    providerAdsetEffectiveStatus !== "ACTIVE"
  ) {
    throw new TypeError(
      "Manual Meta status reconciliation provider GET evidence is not exact.",
    );
  }

  const requestedStatus = manualMetaAdRequestedStatus(input.action);
  const derivedResolution: ManualMetaAdStatusReconciliationResolution =
    input.observedStatus === requestedStatus
      ? "current_state_matches_requested"
      : "current_state_matches_precondition";
  if (input.resolution !== derivedResolution) {
    throw new TypeError(
      "Manual Meta status reconciliation resolution contradicts provider status.",
    );
  }
  const observedAt = canonicalIsoTimestamp(input.observedAt, "observedAt");

  return runDbTransaction(async () => {
    const sql = getDb();
    await sql.query(LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY, [
      metaAdStatusActionClaimKey({
        businessId,
        providerAccountId,
        adId,
      }),
    ]);
    const existingRows =
      await sql.query<ManualMetaAdStatusReconciliationDbRow>(
        READ_MANUAL_META_AD_STATUS_RECONCILIATION_EVENT_QUERY,
        [sourceActionLogId],
      );
    const existingRow = existingRows[0];
    if (existingRow) {
      const existing =
        mapManualMetaAdStatusReconciliationEvent(existingRow);
      const existingSourceMutation = existing.evidence.sourceMutation;
      if (
        !existingSourceMutation ||
        typeof existingSourceMutation !== "object" ||
        Array.isArray(existingSourceMutation)
      ) {
        throw new Error(
          "Manual Meta status reconciliation stored evidence is invalid.",
        );
      }
      const replayEvidence = {
        contractVersion:
          MANUAL_META_AD_STATUS_RECONCILIATION_CONTRACT_VERSION,
        sourceMutation: existingSourceMutation,
        resolvedTarget: {
          businessId,
          providerAccountId,
          adId,
          creativeId: input.resolvedTarget.creativeId,
          campaignId: input.resolvedTarget.campaignId,
          adsetId: input.resolvedTarget.adsetId,
        },
        policyProof: {
          eligible: true,
          reviewStatus: null,
          basis: "exact_configured_effective_statuses",
        },
        providerGet: providerGetEvidence,
      };
      if (
        manualMetaAdReconciliationMatches(existing, {
          sourceActionLogId,
          resolution: input.resolution,
          observedAt,
          evidence: replayEvidence,
        })
      ) {
        return { ...existing, idempotentReplay: true };
      }
      throw new Error(
        "Manual Meta status reconciliation source already has a different resolution.",
      );
    }
    const candidateRows =
      await sql.query<ManualMetaAdStatusReconciliationCandidateSourceRow>(
        READ_MANUAL_META_AD_STATUS_RECONCILIATION_CANDIDATE_QUERY,
        [businessId, providerAccountId, adId],
      );
    const candidateSource = candidateRows[0];
    if (
      !candidateSource ||
      Number(candidateSource.unresolved_source_count) !== 1 ||
      candidateSource.id !== sourceActionLogId
    ) {
      throw new Error(
        "Manual Meta status reconciliation requires exactly one unresolved source.",
      );
    }
    const sourceRows =
      await sql.query<ManualMetaAdStatusReconciliationSourceRow>(
        READ_MANUAL_META_AD_STATUS_RECONCILIATION_SOURCE_QUERY,
        [sourceActionLogId, providerAccountId],
      );
    const source = sourceRows[0];
    if (!source) {
      throw new Error(
        "Manual Meta status reconciliation source action was not found.",
      );
    }
    if (
      source.source === "decision_origin" ||
      (source.action !== "pause" && source.action !== "resume") ||
      !["pending", "silent_failure"].includes(source.status) ||
      manualMetaAdSourceIsDryRun(source)
    ) {
      throw new Error(
        "Manual Meta status reconciliation requires a live unresolved manual source.",
      );
    }
    if (
      source.business_id !== businessId ||
      source.ad_id !== adId ||
      source.creative_id !== input.resolvedTarget.creativeId ||
      source.action !== input.action ||
      Number(source.bound_provider_account_count) !== 1 ||
      (source.provider_account_id != null &&
        source.provider_account_id !== providerAccountId)
    ) {
      throw new Error(
        "Manual Meta status reconciliation source lineage is not exact.",
      );
    }

    const sourceRequestedAt = canonicalIsoTimestamp(
      source.requested_at,
      "source.requested_at",
    );
    const dbNow = canonicalIsoTimestamp(source.db_now, "db_now");
    const attempts =
      (
        await sql.query<ManualMetaAdStatusMutationAttemptDbRow>(
          READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY,
          [sourceActionLogId],
        )
      ).map(mapManualMetaAdStatusMutationAttemptEvent);
    const started = attempts.find(
      (event) => event.eventKind === "attempt_started",
    );
    const completed = attempts.find(
      (event) => event.eventKind === "attempt_completed",
    );
    let sourceAuthorityKind: ManualMetaAdStatusReconciliationAuthorityKind;
    let sourceOutcome: ManualMetaAdStatusReconciliationSourceOutcome;
    let sourceAttemptId: string | null = null;
    let sourceAttemptCompletedEventId: string | null = null;
    let sourceLeaseDeadline: string | null = null;
    let sourceAttemptedAt: string | null = null;
    let sourceCompletedAt: string | null = null;
    let sourceLegacyAnchorAt: string | null = null;
    let settlementNotBefore: string;
    let providerAccountRefId: string;
    let sourceMutation: Record<string, unknown>;

    if (completed) {
      if (
        !started ||
        completed.attemptId !== started.attemptId ||
        completed.completionOutcome == null ||
        completed.attemptedAt == null ||
        completed.completedAt == null
      ) {
        throw new Error(
          "Manual Meta status reconciliation attempt journal is contradictory.",
        );
      }
      sourceAuthorityKind = "completed_attempt";
      sourceOutcome = completed.completionOutcome;
      sourceAttemptId = completed.attemptId;
      sourceAttemptCompletedEventId = completed.id;
      sourceLeaseDeadline = completed.leaseDeadline;
      sourceAttemptedAt = completed.attemptedAt;
      sourceCompletedAt = completed.completedAt;
      settlementNotBefore = new Date(
        Date.parse(completed.completedAt) +
          MANUAL_META_AD_STATUS_RECONCILIATION_MIN_SETTLEMENT_MS,
      ).toISOString();
      providerAccountRefId = completed.providerAccountRefId;
      sourceMutation = completed.evidence;
      if (Date.parse(observedAt) < Date.parse(completed.createdAt)) {
        throw new Error(
          "Manual Meta status reconciliation observation predates completed-attempt authority.",
        );
      }
      if (
        completed.businessId !== businessId ||
        completed.providerAccountId !== providerAccountId ||
        completed.adId !== adId ||
        completed.creativeId !== input.resolvedTarget.creativeId ||
        completed.campaignId !== input.resolvedTarget.campaignId ||
        completed.adsetId !== input.resolvedTarget.adsetId ||
        completed.action !== input.action
      ) {
        throw new Error(
          "Manual Meta status reconciliation completed attempt target is not exact.",
        );
      }
    } else if (started) {
      sourceAuthorityKind = "lease_expired_started";
      sourceOutcome = "attempt_lease_expired_without_completion";
      sourceAttemptId = started.attemptId;
      sourceLeaseDeadline = started.leaseDeadline;
      settlementNotBefore = new Date(
        Date.parse(started.leaseDeadline) +
          MANUAL_META_AD_STATUS_RECONCILIATION_MIN_SETTLEMENT_MS,
      ).toISOString();
      providerAccountRefId = started.providerAccountRefId;
      sourceMutation = started.evidence;
      if (
        started.businessId !== businessId ||
        started.providerAccountId !== providerAccountId ||
        started.adId !== adId ||
        started.creativeId !== input.resolvedTarget.creativeId ||
        started.campaignId !== input.resolvedTarget.campaignId ||
        started.adsetId !== input.resolvedTarget.adsetId ||
        started.action !== input.action
      ) {
        throw new Error(
          "Manual Meta status reconciliation started attempt target is not exact.",
        );
      }
    } else {
      const journalContract =
        source.payload_request?.mutation_journal_contract_version;
      const journalRequired =
        source.payload_request?.mutation_journal_required === true;
      const durableTarget =
        source.payload_request?.manual_status_mutation_target;
      const targetRecord =
        durableTarget &&
        typeof durableTarget === "object" &&
        !Array.isArray(durableTarget)
          ? (durableTarget as Record<string, unknown>)
          : null;
      if (
        journalContract ===
          MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION &&
        journalRequired &&
        source.status === "pending" &&
        source.provider_account_id === providerAccountId &&
        targetRecord?.businessId === businessId &&
        targetRecord.providerAccountId === providerAccountId &&
        targetRecord.adId === adId &&
        targetRecord.creativeId === input.resolvedTarget.creativeId &&
        targetRecord.campaignId === input.resolvedTarget.campaignId &&
        targetRecord.adsetId === input.resolvedTarget.adsetId &&
        source.bound_provider_account_ref_id &&
        Number(source.bound_provider_account_count) === 1
      ) {
        sourceAuthorityKind = "pre_provider_no_attempt";
        sourceOutcome = "pre_provider_no_mutation_attempt";
        settlementNotBefore = new Date(
          Date.parse(sourceRequestedAt) +
            MANUAL_META_AD_STATUS_RECONCILIATION_MIN_SETTLEMENT_MS,
        ).toISOString();
        providerAccountRefId = source.bound_provider_account_ref_id;
        sourceMutation = {
          contractVersion:
            MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
          authority: "pre_provider_no_attempt",
          sourceActionLogId,
          target: targetRecord,
        };
      } else {
        const targetRows = await sql.query<{
          target_count: number;
          provider_account_ref_id: string | null;
          provider_account_id: string | null;
          creative_id: string | null;
          campaign_id: string | null;
          adset_id: string | null;
        }>(READ_LEGACY_MANUAL_META_AD_STATUS_TARGET_QUERY, [
          businessId,
          adId,
        ]);
        const legacyTarget = targetRows[0];
        const updatedAt = canonicalIsoTimestamp(
          source.updated_at,
          "source.updated_at",
        );
        const verifiedAt = nullableCanonicalIsoTimestamp(
          source.verified_at,
          "source.verified_at",
        );
        const legacyAnchorMs = Math.max(
          Date.parse(sourceRequestedAt),
          Date.parse(updatedAt),
          verifiedAt ? Date.parse(verifiedAt) : Number.NEGATIVE_INFINITY,
        );
        sourceLegacyAnchorAt = new Date(legacyAnchorMs).toISOString();
        settlementNotBefore = new Date(
          legacyAnchorMs +
            MANUAL_META_AD_STATUS_LEGACY_QUARANTINE_MS,
        ).toISOString();
        if (
          source.status !== "silent_failure" ||
          source.provider_account_id !== null ||
          source.terminal_finalized_at !== null ||
          legacyTarget?.target_count !== 1 ||
          !legacyTarget.provider_account_ref_id ||
          legacyTarget.provider_account_id !== providerAccountId ||
          legacyTarget.creative_id !== input.resolvedTarget.creativeId ||
          legacyTarget.campaign_id !== input.resolvedTarget.campaignId ||
          legacyTarget.adset_id !== input.resolvedTarget.adsetId ||
          Number(source.bound_provider_account_count) !== 1 ||
          source.bound_provider_account_ref_id !==
            legacyTarget.provider_account_ref_id
        ) {
          throw new Error(
            "Legacy manual Meta reconciliation lacks one exact DB target.",
          );
        }
        sourceAuthorityKind = "legacy_quarantine";
        sourceOutcome = "legacy_precontract_quarantine_elapsed";
        providerAccountRefId = legacyTarget.provider_account_ref_id;
        sourceMutation = {
          contractVersion:
            "meta-manual-ad-status-legacy-quarantine.v1",
          authority: "legacy_quarantine",
          sourceActionLogId,
          anchorAt: sourceLegacyAnchorAt,
          settlementNotBefore,
          target: {
            businessId,
            providerAccountRefId,
            providerAccountId,
            adId,
            creativeId: input.resolvedTarget.creativeId,
            campaignId: input.resolvedTarget.campaignId,
            adsetId: input.resolvedTarget.adsetId,
          },
        };
      }
    }

    const sourceTerminalFinalizedAt = nullableCanonicalIsoTimestamp(
      source.terminal_finalized_at,
      "source.terminal_finalized_at",
    );
    const evidence = {
      contractVersion:
        MANUAL_META_AD_STATUS_RECONCILIATION_CONTRACT_VERSION,
      sourceMutation,
      resolvedTarget: {
        businessId,
        providerAccountId,
        adId,
        creativeId: input.resolvedTarget.creativeId,
        campaignId: input.resolvedTarget.campaignId,
        adsetId: input.resolvedTarget.adsetId,
      },
      policyProof: {
        eligible: true,
        reviewStatus: null,
        basis: "exact_configured_effective_statuses",
      },
      providerGet: providerGetEvidence,
    };
    const semanticEvent = {
      sourceActionLogId,
      resolution: input.resolution,
      observedAt,
      evidence,
    };
    const observedAtMs = Date.parse(observedAt);
    const dbNowMs = Date.parse(dbNow);
    if (observedAtMs < Date.parse(settlementNotBefore)) {
      throw new Error(
        "Manual Meta status reconciliation observation predates the settlement floor.",
      );
    }
    if (
      observedAtMs > dbNowMs ||
      dbNowMs - observedAtMs >
        MANUAL_META_AD_STATUS_RECONCILIATION_MAX_OBSERVATION_AGE_MS
    ) {
      throw new Error(
        "Manual Meta status reconciliation requires a fresh provider observation.",
      );
    }

    const params = [
      sourceActionLogId,
      sourceAttemptId,
      sourceAttemptCompletedEventId,
      businessId,
      providerAccountRefId,
      source.provider_account_id,
      providerAccountId,
      adId,
      input.resolvedTarget.creativeId,
      input.resolvedTarget.campaignId,
      input.resolvedTarget.adsetId,
      input.action,
      sourceAuthorityKind,
      sourceOutcome,
      sourceRequestedAt,
      sourceLeaseDeadline,
      sourceAttemptedAt,
      sourceCompletedAt,
      sourceTerminalFinalizedAt,
      sourceLegacyAnchorAt,
      settlementNotBefore,
      input.resolution,
      requestedStatus,
      input.observedStatus,
      observedEffectiveStatus,
      providerCampaignStatus,
      providerCampaignEffectiveStatus,
      providerAdsetStatus,
      providerAdsetEffectiveStatus,
      true,
      null,
      observedAt,
      dbNow,
      JSON.stringify(evidence),
    ];
    const insertedRows =
      await sql.query<ManualMetaAdStatusReconciliationDbRow>(
        INSERT_MANUAL_META_AD_STATUS_RECONCILIATION_EVENT_QUERY,
        params,
      );
    if (insertedRows[0]) {
      return mapManualMetaAdStatusReconciliationEvent(insertedRows[0]);
    }

    const racedRows =
      await sql.query<ManualMetaAdStatusReconciliationDbRow>(
        READ_MANUAL_META_AD_STATUS_RECONCILIATION_EVENT_QUERY,
        [sourceActionLogId],
      );
    const racedRow = racedRows[0];
    if (racedRow) {
      const raced = mapManualMetaAdStatusReconciliationEvent(racedRow);
      if (manualMetaAdReconciliationMatches(raced, semanticEvent)) {
        return { ...raced, idempotentReplay: true };
      }
    }
    throw new Error(
      "Manual Meta status reconciliation source already has a different resolution.",
    );
  });
}

function decisionOriginLogMatchesRequest(
  row: MetaAdsActionLogRow,
  request: DecisionOriginAdExecutionRequest,
) {
  const origin = row.decisionOrigin;
  return Boolean(
    origin &&
      origin.businessId === request.businessId &&
      origin.providerAccountId === request.providerAccountId &&
      origin.adId === request.adId &&
      origin.creativeId === request.creativeId &&
      origin.snapshotId === request.snapshotId &&
      origin.evaluationId === request.evaluationId &&
      origin.engineVersion === request.engineVersion &&
      origin.decisionHash === request.decisionHash &&
      origin.action === request.action &&
      origin.idempotencyKey === request.idempotencyKey &&
      (origin.dryRun === true) === (request.dryRun === true),
  );
}

type NativeMetaAdStatusActionClaimInput = {
  actionOrigin: "native_decision_v1";
  request: DecisionOriginAdExecutionRequest;
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
};

type ManualMetaAdStatusActionClaimInput = {
  actionOrigin: "manual_operator_v1";
  businessId: string;
  providerAccountId: string;
  adId: string;
  creativeId: string | null;
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
  recIdOrigin?: string | null;
};

export type MetaAdStatusActionClaimInput =
  | NativeMetaAdStatusActionClaimInput
  | ManualMetaAdStatusActionClaimInput;

function statusActionClaimIdentity(input: MetaAdStatusActionClaimInput) {
  return input.actionOrigin === "native_decision_v1"
    ? {
        businessId: input.request.businessId,
        providerAccountId: input.request.providerAccountId,
        adId: input.request.adId,
      }
    : {
        businessId: input.businessId,
        providerAccountId: input.providerAccountId,
        adId: input.adId,
      };
}

function blockingStatusActionOrigin(row: MetaAdsActionLogRow) {
  if (row.source === "decision_origin") return "native_decision_v1";
  return row.source || "manual_operator_v1";
}

function statusActionClaimConflict(input: {
  requestedOrigin: MetaAdStatusActionOrigin;
  pending: MetaAdsActionLogRow;
}) {
  const reconciliationReceipt =
    input.pending.source === "decision_origin"
      ? decisionOriginIdempotencyReceiptFromLog(input.pending)
      : null;
  const markerRequiresReconciliation =
    reconciliationReceipt?.reconciliationRequired === true;
  const manualTerminalRequiresReconciliation =
    input.pending.source !== "decision_origin" &&
    input.pending.status === "silent_failure" &&
    input.pending.dryRun !== true;
  const code =
    manualTerminalRequiresReconciliation
      ? META_AD_STATUS_RECONCILIATION_REQUIRED_CODE
      : input.requestedOrigin === "native_decision_v1" &&
          input.pending.source === "decision_origin"
      ? DECISION_ORIGIN_PENDING_RECONCILIATION_CODE
      : META_AD_STATUS_ACTION_IN_FLIGHT_CODE;
  return new MetaAdStatusActionClaimConflictError({
    code,
    blockingActionLogId: input.pending.id,
    blockingOrigin: blockingStatusActionOrigin(input.pending),
    reconciliationRequired:
      markerRequiresReconciliation ||
      manualTerminalRequiresReconciliation ||
      code === DECISION_ORIGIN_PENDING_RECONCILIATION_CODE,
    reconciliationReceipt,
  });
}

async function insertDecisionOriginMetaAdsActionLog(input: {
  request: DecisionOriginAdExecutionRequest;
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
}) {
  const blockers = validateDecisionOriginAdExecutionRequest(input.request);
  if (blockers.length > 0) {
    throw new TypeError(
      `Invalid decision-origin action log contract: ${blockers.join(", ")}`,
    );
  }
  if (input.request.action !== "pause" && input.request.action !== "resume") {
    throw new TypeError("Decision-origin ad logs support pause or resume only.");
  }
  const payloadRequest = {
    ...(input.payloadRequest ?? {}),
    contract_version: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    execution_origin: "decision_origin",
    provider_account_id: input.request.providerAccountId,
    source_snapshot_id: input.request.snapshotId,
    source_evaluation_id: input.request.evaluationId,
    engine_version: input.request.engineVersion,
    decision_hash: input.request.decisionHash,
    idempotency_key: input.request.idempotencyKey,
    dry_run: input.request.dryRun === true,
  };
  const sql = getDb();
  const rows = await sql.query<MetaAdsActionLogDbRow>(
    CREATE_DECISION_ORIGIN_META_ADS_ACTION_LOG_QUERY,
    [
      input.request.businessId,
      input.request.providerAccountId,
      input.request.adId,
      input.request.snapshotId,
      input.request.evaluationId,
      input.request.engineVersion,
      input.request.decisionHash,
      input.request.action,
      input.requestedBy ?? null,
      JSON.stringify(payloadRequest),
      input.request.idempotencyKey,
      input.request.dryRun === true,
    ],
  );
  const row = rows[0];
  if (row) return mapActionLogRow(row);

  const existing = await findDecisionOriginActionLogByIdempotency({
    businessId: input.request.businessId,
    idempotencyKey: input.request.idempotencyKey,
  });
  if (existing) {
    if (!decisionOriginLogMatchesRequest(existing, input.request)) {
      throw new Error(
        "Decision-origin idempotency key conflicts with an existing action lineage.",
      );
    }
    return { ...existing, idempotentReplay: true };
  }
  throw new Error(
    "Decision-origin log creation found no exact authorized native ad episode.",
  );
}

export async function createMetaAdStatusActionClaim(
  input: MetaAdStatusActionClaimInput,
): Promise<MetaAdsActionLogRow> {
  const identity = statusActionClaimIdentity(input);
  if (
    !identity.businessId.trim() ||
    !identity.providerAccountId.trim() ||
    !identity.adId.trim()
  ) {
    throw new TypeError(
      "Meta Ad status claims require exact business, provider-account, and Ad identity.",
    );
  }
  return runDbTransaction(async () => {
    const sql = getDb();
    await sql.query(LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY, [
      metaAdStatusActionClaimKey(identity),
    ]);
    const unresolved = await findUnresolvedMetaAdStatusActionLog(identity);
    if (unresolved) {
      if (
        input.actionOrigin === "native_decision_v1" &&
        unresolved.source === "decision_origin" &&
        unresolved.idempotencyKey === input.request.idempotencyKey
      ) {
        const existing = await findDecisionOriginActionLogByIdempotency({
          businessId: input.request.businessId,
          idempotencyKey: input.request.idempotencyKey,
        });
        if (
          !existing ||
          !decisionOriginLogMatchesRequest(existing, input.request)
        ) {
          throw new Error(
            "Decision-origin idempotency key conflicts with an existing action lineage.",
          );
        }
        return { ...existing, idempotentReplay: true };
      }
      throw statusActionClaimConflict({
        requestedOrigin: input.actionOrigin,
        pending: unresolved,
      });
    }
    if (input.actionOrigin === "native_decision_v1") {
      return insertDecisionOriginMetaAdsActionLog(input);
    }
    return insertMetaAdsActionLog({
      businessId: input.businessId,
      providerAccountId: input.providerAccountId,
      adId: input.adId,
      creativeId: input.creativeId,
      action: input.action,
      source: "manual_operator_v1",
      requestedBy: input.requestedBy ?? null,
      payloadRequest: input.payloadRequest ?? null,
      recIdOrigin: input.recIdOrigin ?? null,
    });
  });
}

export async function reconcileManualMetaAdStatusAndCreateClaim(input: {
  reconciliation: AppendManualMetaAdStatusReconciliationInput;
  nextClaim: MetaAdStatusActionClaimInput;
}): Promise<{
  reconciliation: ManualMetaAdStatusReconciliationEvent;
  claim: MetaAdsActionLogRow;
}> {
  const nextIdentity = statusActionClaimIdentity(input.nextClaim);
  if (
    nextIdentity.businessId !== input.reconciliation.businessId ||
    nextIdentity.providerAccountId !==
      input.reconciliation.providerAccountId ||
    nextIdentity.adId !== input.reconciliation.adId
  ) {
    throw new TypeError(
      "Manual Meta reconciliation and replacement claim identities must be exact.",
    );
  }
  return runDbTransaction(async () => {
    const reconciliation =
      await appendManualMetaAdStatusReconciliationEvent(
        input.reconciliation,
      );
    const claim = await createMetaAdStatusActionClaim(input.nextClaim);
    return { reconciliation, claim };
  });
}

export async function createDecisionOriginMetaAdsActionLog(input: {
  request: DecisionOriginAdExecutionRequest;
  requestedBy?: string | null;
  payloadRequest?: Record<string, unknown> | null;
}): Promise<MetaAdsActionLogRow> {
  return createMetaAdStatusActionClaim({
    actionOrigin: "native_decision_v1",
    ...input,
  });
}

function manualMetaPreProviderTerminalProofMatches(input: {
  payloadResponse: Record<string, unknown> | null;
  errorCode: string | null;
}) {
  if (!input.errorCode) return false;
  return (
    isDeepStrictEqual(input.payloadResponse, {
      post_claim_preflight: {
        should_mutate: false,
        blocker: input.errorCode,
      },
    }) ||
    isDeepStrictEqual(input.payloadResponse, {
      bulk_pre_provider_abort: {
        code: input.errorCode,
        provider_mutation_attempted: false,
      },
    }) ||
    isDeepStrictEqual(input.payloadResponse, {
      adapter_pre_provider_abort: {
        code: input.errorCode,
        provider_mutation_attempted: false,
      },
    }) ||
    (input.errorCode ===
      "manual_mutation_attempt_start_persistence_failed" &&
      isDeepStrictEqual(input.payloadResponse, {
        mutation_attempt_journal: {
          started: false,
          provider_write_attempted: false,
        },
      }))
  );
}

function manualMetaTerminalOutcomeMatches(input: {
  existing: MetaAdsActionLogDbRow;
  status: Exclude<MetaAdsActionStatus, "pending">;
  payloadResponse: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultingAdId: string | null;
  durationMs: number | null;
  verifiedAt: string | null;
  verificationPayload: Record<string, unknown> | null;
}) {
  const existingVerifiedAt = nullableCanonicalIsoTimestamp(
    input.existing.verified_at,
    "existing.verified_at",
  );
  return (
    input.existing.status === input.status &&
    isDeepStrictEqual(
      input.existing.payload_response ?? null,
      input.payloadResponse,
    ) &&
    input.existing.error_code === input.errorCode &&
    input.existing.error_message === input.errorMessage &&
    input.existing.resulting_ad_id === input.resultingAdId &&
    input.existing.duration_ms === input.durationMs &&
    existingVerifiedAt === input.verifiedAt &&
    isDeepStrictEqual(
      input.existing.verification_payload ?? null,
      input.verificationPayload,
    )
  );
}

function assertManualMetaJournalTerminalAuthority(input: {
  source: ManualMetaAdStatusReconciliationSourceRow;
  attempts: ManualMetaAdStatusMutationAttemptEvent[];
  status: Exclude<MetaAdsActionStatus, "pending">;
  payloadResponse: Record<string, unknown> | null;
  errorCode: string | null;
  errorMessage: string | null;
  resultingAdId: string | null;
  durationMs: number | null;
  verifiedAt: string | null;
  verificationPayload: Record<string, unknown> | null;
}) {
  const durableTarget =
    input.source.creative_id != null &&
    input.source.provider_account_id != null
      ? exactDurableManualMetaTarget(
          input.source.payload_request?.manual_status_mutation_target,
          {
            businessId: input.source.business_id,
            providerAccountId: input.source.provider_account_id,
            adId: input.source.ad_id,
            creativeId: input.source.creative_id,
          },
        )
      : null;
  if (
    input.source.reconciliation_event_id != null ||
    !durableTarget ||
    !input.source.bound_provider_account_ref_id ||
    Number(input.source.bound_provider_account_count) !== 1
  ) {
    throw new Error(
      "Journal-required manual Meta terminalization source is not exact.",
    );
  }
  const started = input.attempts.filter(
    (event) => event.eventKind === "attempt_started",
  );
  const completed = input.attempts.filter(
    (event) => event.eventKind === "attempt_completed",
  );
  const completedOutcome = completed[0]?.completionOutcome ?? null;
  const completedEvent = completed[0] ?? null;
  const exactCompletedAttempt =
    input.attempts.length === 2 &&
    started.length === 1 &&
    completed.length === 1 &&
    started[0]!.attemptId === completed[0]!.attemptId;
  const exactCompletedProviderFields =
    completedEvent != null &&
    isDeepStrictEqual(
      input.payloadResponse,
      completedEvent.providerResponse,
    ) &&
    isDeepStrictEqual(
      input.verificationPayload,
      completedEvent.verification,
    );
  const verificationObservedAt =
    completedEvent?.verification &&
    typeof completedEvent.verification.observedAt === "string"
      ? canonicalIsoTimestamp(
          completedEvent.verification.observedAt,
          "completed.verification.observedAt",
        )
      : null;
  const exactFailureShape =
    input.verifiedAt == null &&
    input.resultingAdId == null &&
    Boolean(input.errorCode?.trim()) &&
    Boolean(input.errorMessage?.trim());
  const exactCommonShape =
    input.resultingAdId == null &&
    (input.durationMs == null ||
      (Number.isInteger(input.durationMs) && input.durationMs >= 0));
  const authorized =
    (input.status === "success" &&
      exactCompletedAttempt &&
      completedOutcome === "provider_response_verified_success" &&
      exactCompletedProviderFields &&
      verificationObservedAt != null &&
      input.verifiedAt === verificationObservedAt &&
      input.errorCode == null &&
      input.errorMessage == null &&
      exactCommonShape) ||
    (input.status === "silent_failure" &&
      exactCompletedAttempt &&
      (completedOutcome === "provider_outcome_ambiguous" ||
        completedOutcome ===
          "provider_response_succeeded_verification_failed") &&
      exactCompletedProviderFields &&
      exactFailureShape &&
      exactCommonShape) ||
    (input.status === "failure" &&
      exactCompletedAttempt &&
      completedOutcome === "provider_definite_failure" &&
      exactCompletedProviderFields &&
      input.verificationPayload == null &&
      exactFailureShape &&
      exactCommonShape) ||
    (input.attempts.length === 0 &&
      input.status === "failure" &&
      manualMetaPreProviderTerminalProofMatches({
        payloadResponse: input.payloadResponse,
        errorCode: input.errorCode,
      }) &&
      input.verificationPayload == null &&
      exactFailureShape &&
      exactCommonShape);
  if (!authorized) {
    throw new Error(
      "Journal-required manual Meta terminalization lacks exact attempt authority.",
    );
  }
}

export async function completeMetaAdsActionLog(input: {
  id: string;
  status: Exclude<MetaAdsActionStatus, "pending">;
  payloadResponse?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  resultingAdId?: string | null;
  durationMs?: number | null;
  verifiedAt?: string | null;
  verificationPayload?: Record<string, unknown> | null;
}): Promise<MetaAdsActionLogRow> {
  if (
    !["success", "failure", "silent_failure"].includes(
      input.status as MetaAdsActionStatus,
    )
  ) {
    throw new TypeError("Manual action completion requires a terminal status.");
  }
  const payloadResponse =
    input.payloadResponse == null
      ? null
      : (JSON.parse(
          JSON.stringify(input.payloadResponse),
        ) as Record<string, unknown>);
  const verificationPayload =
    input.verificationPayload == null
      ? null
      : (JSON.parse(
          JSON.stringify(input.verificationPayload),
        ) as Record<string, unknown>);
  const durationMs = input.durationMs ?? null;
  if (
    durationMs != null &&
    (!Number.isInteger(durationMs) || durationMs < 0)
  ) {
    throw new TypeError(
      "Manual action completion duration must be a non-negative integer.",
    );
  }
  const verifiedAt =
    input.verifiedAt == null
      ? null
      : canonicalIsoTimestamp(input.verifiedAt, "verifiedAt");
  const serializedPayloadResponse =
    payloadResponse == null ? null : JSON.stringify(payloadResponse);
  const serializedVerificationPayload =
    verificationPayload == null ? null : JSON.stringify(verificationPayload);
  return runDbTransaction(async () => {
    const sql = getDb();
    const initialRows = (await sql`
      SELECT *
      FROM meta_ads_action_log
      WHERE id = ${input.id}
        AND source <> 'decision_origin'
      LIMIT 1
    `) as MetaAdsActionLogDbRow[];
    const initial = initialRows[0];
    if (!initial) {
      throw new Error(
        "Failed to update Meta ads action log row; decision-origin rows require atomic receipt finalization.",
      );
    }
    if (initial.status !== "pending") {
      if (
        !manualMetaTerminalOutcomeMatches({
          existing: initial,
          status: input.status,
          payloadResponse,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          resultingAdId: input.resultingAdId ?? null,
          durationMs,
          verifiedAt,
          verificationPayload,
        })
      ) {
        throw new Error(
          "Meta ads action log already has a different terminal outcome.",
        );
      }
      return mapActionLogRow(initial);
    }
    const journalRequired =
      initial.action !== "duplicate" &&
      initial.dry_run !== true &&
      initial.payload_request?.mutation_journal_contract_version ===
        MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION &&
      initial.payload_request?.mutation_journal_required === true;
    if (journalRequired) {
      if (!initial.provider_account_id) {
        throw new Error(
          "Journal-required manual Meta terminalization source is not exact.",
        );
      }
      await sql.query(LOCK_META_AD_STATUS_ACTION_CLAIM_QUERY, [
        metaAdStatusActionClaimKey({
          businessId: initial.business_id,
          providerAccountId: initial.provider_account_id,
          adId: initial.ad_id,
        }),
      ]);
      const sourceRows =
        await sql.query<ManualMetaAdStatusReconciliationSourceRow>(
          READ_MANUAL_META_AD_STATUS_MUTATION_SOURCE_QUERY,
          [input.id],
        );
      const source = sourceRows[0];
      if (!source) {
        throw new Error(
          "Journal-required manual Meta terminalization source is not exact.",
        );
      }
      if (
        source.business_id !== initial.business_id ||
        source.provider_account_id !== initial.provider_account_id ||
        source.ad_id !== initial.ad_id ||
        source.creative_id !== initial.creative_id ||
        source.action !== initial.action ||
        source.source !== initial.source
      ) {
        throw new Error(
          "Journal-required manual Meta terminalization source changed before lock acquisition.",
        );
      }
      if (source.status === "pending") {
        const attempts =
          (
            await sql.query<ManualMetaAdStatusMutationAttemptDbRow>(
              READ_MANUAL_META_AD_STATUS_MUTATION_ATTEMPTS_QUERY,
              [input.id],
            )
          ).map(mapManualMetaAdStatusMutationAttemptEvent);
        assertManualMetaJournalTerminalAuthority({
          source,
          attempts,
          status: input.status,
          payloadResponse,
          errorCode: input.errorCode ?? null,
          errorMessage: input.errorMessage ?? null,
          resultingAdId: input.resultingAdId ?? null,
          durationMs,
          verifiedAt,
          verificationPayload,
        });
      }
    }

    const rows = (await sql`
      UPDATE meta_ads_action_log
      SET
        status = ${input.status},
        payload_response = ${serializedPayloadResponse}::jsonb,
        error_code = ${input.errorCode ?? null},
        error_message = ${input.errorMessage ?? null},
        resulting_ad_id = ${input.resultingAdId ?? null},
        duration_ms = ${durationMs},
        verified_at = ${verifiedAt},
        verification_payload = ${serializedVerificationPayload}::jsonb,
        terminal_finalized_at = clock_timestamp(),
        updated_at = NOW()
      WHERE id = ${input.id}
        AND source <> 'decision_origin'
        AND status = 'pending'
      RETURNING *
    `) as MetaAdsActionLogDbRow[];
    const row = rows[0];
    if (row) {
      return mapActionLogRow(row);
    }

    const existingRows = (await sql`
      SELECT *
      FROM meta_ads_action_log
      WHERE id = ${input.id}
        AND source <> 'decision_origin'
      LIMIT 1
    `) as MetaAdsActionLogDbRow[];
    const existing = existingRows[0];
    if (!existing) {
      throw new Error(
        "Failed to update Meta ads action log row; decision-origin rows require atomic receipt finalization.",
      );
    }

    const matchesExistingTerminal = manualMetaTerminalOutcomeMatches({
      existing,
      status: input.status,
      payloadResponse,
      errorCode: input.errorCode ?? null,
      errorMessage: input.errorMessage ?? null,
      resultingAdId: input.resultingAdId ?? null,
      durationMs,
      verifiedAt,
      verificationPayload,
    });
    if (!matchesExistingTerminal) {
      throw new Error(
        "Meta ads action log already has a different terminal outcome.",
      );
    }
    return mapActionLogRow(existing);
  });
}

interface LockedDecisionOriginActionRow extends MetaAdsActionLogDbRow {
  db_now: string;
  episode_business_id: string;
  episode_creative_id: string | null;
  episode_as_of_date: string;
  episode_scope_type: string;
  episode_scope_id: string;
  episode_input_hash: string;
  episode_decision_label: string;
  episode_source_campaign_id: string | null;
  episode_source_adset_id: string | null;
  episode_recommended_at: string;
  existing_receipt_id: string | null;
  existing_receipt_hash: string | null;
  existing_receipt_captured_at: string | null;
}

interface StoredNativeReceiptRow {
  receipt_id: string;
  action_log_id: string;
  receipt_hash: string;
}

export const LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY = `
SELECT
  action_log.*,
  clock_timestamp()::text AS db_now,
  episode.business_id AS episode_business_id,
  episode.creative_id AS episode_creative_id,
  episode.as_of_date::text AS episode_as_of_date,
  episode.scope_type AS episode_scope_type,
  episode.scope_id AS episode_scope_id,
  episode.input_hash AS episode_input_hash,
  episode.decision_label AS episode_decision_label,
  episode.source_campaign_id AS episode_source_campaign_id,
  episode.source_adset_id AS episode_source_adset_id,
  episode.recommended_at::text AS episode_recommended_at,
  snapshot.id::text AS authority_snapshot_id,
  evaluation.id::text AS authority_evaluation_id,
  receipt.id::text AS existing_receipt_id,
  receipt.receipt_hash AS existing_receipt_hash,
  receipt.captured_at::text AS existing_receipt_captured_at
FROM meta_ads_action_log action_log
INNER JOIN engine_v3_ad_recommendation_episodes episode
  ON episode.episode_key = action_log.decision_episode_key
 AND episode.business_ref_id = action_log.business_id
 AND episode.business_id = action_log.business_id::text
 AND episode.provider_account_ref_id = action_log.provider_account_ref_id
 AND episode.provider_account_id = action_log.provider_account_id
 AND episode.ad_id = action_log.ad_id
 AND episode.decision_snapshot_id = action_log.decision_snapshot_id
 AND episode.evaluation_id = action_log.decision_evaluation_id
 AND episode.engine_version = action_log.decision_engine_version
 AND episode.decision_hash = action_log.decision_hash
INNER JOIN engine_v3_ad_decision_snapshots_daily snapshot
  ON snapshot.id = episode.decision_snapshot_id
 AND snapshot.business_ref_id = episode.business_ref_id
 AND snapshot.business_id = episode.business_id
 AND snapshot.provider_account_id = episode.provider_account_id
 AND snapshot.decision_entity_type = 'ad'
 AND snapshot.decision_entity_id = episode.ad_id
 AND snapshot.ad_id = episode.ad_id
 AND snapshot.as_of_date = episode.as_of_date
 AND snapshot.engine_version = episode.engine_version
 AND snapshot.scope_type = episode.scope_type
 AND snapshot.scope_id = episode.scope_id
 AND snapshot.evaluation_id = episode.evaluation_id
 AND snapshot.input_hash = episode.input_hash
 AND snapshot.decision_hash = episode.decision_hash
INNER JOIN engine_v3_ad_decision_evaluations evaluation
  ON evaluation.id = episode.evaluation_id
 AND evaluation.business_ref_id = episode.business_ref_id
 AND evaluation.provider_account_id = episode.provider_account_id
 AND evaluation.decision_entity_type = 'ad'
 AND evaluation.decision_entity_id = episode.ad_id
 AND evaluation.ad_id = episode.ad_id
 AND evaluation.as_of_date = episode.as_of_date
 AND evaluation.engine_version = episode.engine_version
 AND evaluation.scope_type = episode.scope_type
 AND evaluation.scope_id = episode.scope_id
 AND evaluation.input_hash = episode.input_hash
 AND evaluation.decision_hash = episode.decision_hash
LEFT JOIN engine_v3_ad_operator_action_receipts receipt
  ON receipt.source_action_log_id = action_log.id
 AND receipt.episode_key = action_log.decision_episode_key
 AND receipt.business_ref_id = action_log.business_id
 AND receipt.provider_account_ref_id = action_log.provider_account_ref_id
 AND receipt.provider_account_id = action_log.provider_account_id
 AND receipt.source_ad_id = action_log.ad_id
 AND receipt.operator_action = action_log.action
 AND receipt.source_snapshot_id = action_log.decision_snapshot_id
 AND receipt.source_evaluation_id = action_log.decision_evaluation_id
 AND receipt.source_engine_version = action_log.decision_engine_version
 AND receipt.source_decision_hash = action_log.decision_hash
 AND receipt.idempotency_key = action_log.idempotency_key
 AND receipt.dry_run = action_log.dry_run
WHERE action_log.id = $1::uuid
  AND action_log.source = 'decision_origin'
  AND action_log.decision_contract_version =
    '${DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION}'
  AND action_log.decision_engine_version = '${NATIVE_AD_ENGINE_VERSION}'
FOR UPDATE OF action_log
`;

export const UPDATE_DECISION_ORIGIN_ACTION_TERMINAL_QUERY = `
UPDATE meta_ads_action_log
SET
  status = $2,
  payload_response = $3::jsonb,
  error_code = $4,
  error_message = $5,
  resulting_ad_id = NULL,
  duration_ms = $6::integer,
  verified_at = CASE WHEN $7::boolean THEN $8::timestamptz ELSE NULL END,
  verification_payload = $9::jsonb,
  provider_verified = $7::boolean,
  verification_entity_id = $10,
  verification_status = $11,
  terminal_finalized_at = $8::timestamptz,
  updated_at = $8::timestamptz
WHERE id = $1::uuid
  AND source = 'decision_origin'
  AND status = 'pending'
RETURNING *
`;

export const MARK_DECISION_ORIGIN_RECONCILIATION_REQUIRED_QUERY = `
UPDATE meta_ads_action_log
SET
  payload_response =
    COALESCE(payload_response, '{}'::jsonb) ||
    jsonb_build_object('decision_origin_reconciliation', $2::jsonb),
  error_code = '${DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE}',
  error_message = $3,
  duration_ms = COALESCE($4::integer, duration_ms),
  verification_payload = COALESCE($5::jsonb, verification_payload),
  updated_at = $6::timestamptz
WHERE id = $1::uuid
  AND source = 'decision_origin'
  AND status = 'pending'
  AND provider_verified = false
  AND verified_at IS NULL
  AND terminal_finalized_at IS NULL
RETURNING *
`;

export const INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY = `
WITH payload AS (
  SELECT *
  FROM jsonb_to_record($1::jsonb) AS row(
    id uuid,
    receipt_hash text,
    source_action_log_id uuid,
    contract_version text,
    episode_key text,
    business_ref_id uuid,
    business_id text,
    provider_account_ref_id uuid,
    provider_account_id text,
    source_ad_id text,
    source_snapshot_id uuid,
    source_evaluation_id uuid,
    source_engine_version text,
    source_decision_hash text,
    target_entity_type text,
    target_entity_id text,
    operator_action text,
    successor_kind text,
    resulting_ad_id text,
    idempotency_key text,
    action_status text,
    dry_run boolean,
    provider_verified boolean,
    requested_at timestamptz,
    verified_at timestamptz,
    finalized_at timestamptz,
    captured_at timestamptz,
    verification_entity_id text,
    verification_status text,
    verification_lineage jsonb
  )
), inserted AS (
  INSERT INTO engine_v3_ad_operator_action_receipts (
    id, receipt_hash, source_action_log_id, contract_version, episode_key,
    business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, source_ad_id, source_snapshot_id,
    source_evaluation_id, source_engine_version, source_decision_hash,
    target_entity_type, target_entity_id, operator_action, successor_kind,
    resulting_ad_id, idempotency_key, action_status, dry_run,
    provider_verified, requested_at, verified_at, finalized_at, captured_at,
    verification_entity_id, verification_status, verification_lineage
  )
  SELECT
    id, receipt_hash, source_action_log_id, contract_version, episode_key,
    business_ref_id, business_id, provider_account_ref_id,
    provider_account_id, source_ad_id, source_snapshot_id,
    source_evaluation_id, source_engine_version, source_decision_hash,
    target_entity_type, target_entity_id, operator_action, successor_kind,
    resulting_ad_id, idempotency_key, action_status, dry_run,
    provider_verified, requested_at, verified_at, finalized_at, captured_at,
    verification_entity_id, verification_status, verification_lineage
  FROM payload
  ON CONFLICT (source_action_log_id) DO NOTHING
  RETURNING id::text AS receipt_id,
    source_action_log_id::text AS action_log_id, receipt_hash
)
SELECT receipt_id, action_log_id, receipt_hash
FROM inserted
UNION ALL
SELECT existing.id::text, existing.source_action_log_id::text,
  existing.receipt_hash
FROM engine_v3_ad_operator_action_receipts existing
INNER JOIN payload
  ON payload.source_action_log_id = existing.source_action_log_id
WHERE NOT EXISTS (SELECT 1 FROM inserted)
LIMIT 1
`;

function requiredText(value: unknown, field: string) {
  const normalized = typeof value === "string" ? value.trim() : "";
  if (!normalized) throw new TypeError(`${field} must be a non-empty string.`);
  return normalized;
}

function nullableText(value: unknown) {
  const normalized = typeof value === "string" ? value.trim() : "";
  return normalized || null;
}

function nestedVerificationId(
  payload: Record<string, unknown> | null,
  key: "creative" | "campaign" | "adset",
) {
  const value = payload?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? nullableText((value as Record<string, unknown>).id)
    : null;
}

function normalizedVerificationProviderAccountId(value: unknown) {
  const normalized = nullableText(value);
  if (!normalized) return null;
  return `act_${normalized.replace(/^act[_-]/, "")}`;
}

function receiptVerificationLineage(
  payload: Record<string, unknown> | null,
) {
  if (
    payload?.contractVersion ===
    MANUAL_META_AD_STATUS_WRITE_VERIFICATION_CONTRACT_VERSION
  ) {
    const providerGet = jsonRecordField(payload, "providerGetEvidence");
    return {
      providerAccountId: providerGet?.account_id,
      creativeId: nestedVerificationId(providerGet, "creative"),
      campaignId: nestedVerificationId(providerGet, "campaign"),
      adsetId: nestedVerificationId(providerGet, "adset"),
    };
  }
  return {
    providerAccountId: payload?.account_id,
    creativeId: nestedVerificationId(payload, "creative"),
    campaignId: nestedVerificationId(payload, "campaign"),
    adsetId: nestedVerificationId(payload, "adset"),
  };
}

function withPersistedProviderCompletedAt(
  payload: Record<string, unknown> | null | undefined,
  providerCompletedAt: string | null | undefined,
) {
  return payload?.contractVersion ===
    MANUAL_META_AD_STATUS_WRITE_VERIFICATION_CONTRACT_VERSION &&
    providerCompletedAt
    ? {
        ...payload,
        providerCompletedAt: canonicalIsoTimestamp(
          providerCompletedAt,
          "provider_completed_at",
        ),
      }
    : payload;
}

function canonicalDateOnly(value: unknown, field: string) {
  if (value instanceof Date) return value.toISOString().slice(0, 10);
  const normalized = requiredText(value, field);
  const parsed = new Date(`${normalized.slice(0, 10)}T00:00:00.000Z`);
  if (
    !Number.isFinite(parsed.getTime()) ||
    parsed.toISOString().slice(0, 10) !== normalized.slice(0, 10)
  ) {
    throw new TypeError(`${field} must be a valid date.`);
  }
  return normalized.slice(0, 10);
}

function replayAuthorityEpisodeFromRow(
  row: MetaAdsActionLogDbRow,
): AdRecommendationEpisode | null {
  try {
    const episode = buildAdRecommendationEpisode({
      businessId: requiredText(row.business_id, "business_id"),
      businessDisplayId: requiredText(
        row.episode_business_id,
        "episode_business_id",
      ),
      providerAccountRefId: requiredText(
        row.provider_account_ref_id,
        "provider_account_ref_id",
      ),
      providerAccountId: requiredText(
        row.provider_account_id,
        "provider_account_id",
      ),
      adId: requiredText(row.ad_id, "ad_id"),
      creativeId: nullableText(row.episode_creative_id),
      asOfDate: canonicalDateOnly(
        row.episode_as_of_date,
        "episode_as_of_date",
      ),
      engineVersion: requiredText(
        row.decision_engine_version,
        "decision_engine_version",
      ),
      scopeType: requiredText(row.episode_scope_type, "episode_scope_type"),
      scopeId: requiredText(row.episode_scope_id, "episode_scope_id"),
      snapshotId: requiredText(
        row.decision_snapshot_id,
        "decision_snapshot_id",
      ),
      evaluationId: requiredText(
        row.decision_evaluation_id,
        "decision_evaluation_id",
      ),
      inputHash: requiredText(row.episode_input_hash, "episode_input_hash"),
      decisionHash: requiredText(row.decision_hash, "decision_hash"),
      decisionLabel: requiredText(
        row.episode_decision_label,
        "episode_decision_label",
      ),
      sourceCampaignId: nullableText(row.episode_source_campaign_id),
      sourceAdsetId: nullableText(row.episode_source_adset_id),
      recommendedAt: canonicalIsoTimestamp(
        row.episode_recommended_at,
        "episode_recommended_at",
      ),
    });
    return episode.episodeKey === row.decision_episode_key ? episode : null;
  } catch {
    return null;
  }
}

function deriveExactReceiptFromDbAuthority(input: {
  row: MetaAdsActionLogDbRow;
  request: DecisionOriginAdExecutionRequest;
  episode: AdRecommendationEpisode;
  receiptId: string;
  capturedAt: string | Date;
}): ExactMetaAdsActionLineage {
  const { row, request, episode } = input;
  if (row.status === "pending" || !row.terminal_finalized_at) {
    throw new Error("A pending decision-origin action cannot emit a receipt.");
  }
  if (
    episode.episodeKey !== row.decision_episode_key ||
    request.engineVersion !== NATIVE_AD_ENGINE_VERSION
  ) {
    throw new Error("Decision-origin receipt authority lineage is invalid.");
  }
  const finalizedAt = canonicalIsoTimestamp(
    row.terminal_finalized_at,
    "terminal_finalized_at",
  );
  const capturedAt = canonicalIsoTimestamp(input.capturedAt, "captured_at");
  if (capturedAt !== finalizedAt) {
    throw new Error(
      "Immutable receipt capture time does not match atomic finalization.",
    );
  }
  const verifiedLineage = receiptVerificationLineage(
    row.verification_payload,
  );
  const actionWithoutHash: Omit<ExactMetaAdsActionLineage, "receiptHash"> = {
    receiptId: requiredText(input.receiptId, "receipt_id"),
    actionLogId: requiredText(row.id, "action_log_id"),
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: episode.businessId,
    providerAccountRefId: episode.providerAccountRefId,
    providerAccountId: episode.providerAccountId,
    sourceAdId: episode.adId,
    sourceSnapshotId: episode.snapshotId,
    sourceEvaluationId: episode.evaluationId,
    sourceEngineVersion: episode.engineVersion,
    sourceDecisionHash: episode.decisionHash,
    targetEntityType: "ad",
    targetEntityId: episode.adId,
    action: request.action as DecisionOriginAdAction,
    successorKind: null,
    resultingAdId: null,
    idempotencyKey: request.idempotencyKey,
    status: row.status as Exclude<MetaAdsActionStatus, "pending">,
    dryRun: row.dry_run === true,
    providerVerified: row.provider_verified === true,
    requestedAt: canonicalIsoTimestamp(row.requested_at, "requested_at"),
    verifiedAt: nullableCanonicalIsoTimestamp(row.verified_at, "verified_at"),
    finalizedAt,
    capturedAt,
    verificationEntityId: row.verification_entity_id,
    verificationStatus: row.verification_status,
    verificationLineage: {
      sourceCreativeId: episode.creativeId,
      sourceCampaignId: episode.sourceCampaignId,
      sourceAdsetId: episode.sourceAdsetId,
      verifiedProviderAccountId:
        normalizedVerificationProviderAccountId(
          verifiedLineage.providerAccountId,
        ) === normalizedVerificationProviderAccountId(episode.providerAccountId)
          ? episode.providerAccountId
          : normalizedVerificationProviderAccountId(
              verifiedLineage.providerAccountId,
            ),
      verifiedCreativeId: verifiedLineage.creativeId,
      verifiedCampaignId: verifiedLineage.campaignId,
      verifiedAdsetId: verifiedLineage.adsetId,
    },
  };
  const action: ExactMetaAdsActionLineage = {
    ...actionWithoutHash,
    receiptHash: buildExactMetaAdsActionReceiptHash(actionWithoutHash),
  };
  assertExactMetaAdsActionReceiptForEpisode({ episode, action });
  return action;
}

function lockedDecisionOriginRequest(
  row: LockedDecisionOriginActionRow,
): DecisionOriginAdExecutionRequest {
  const request: DecisionOriginAdExecutionRequest = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: requiredText(row.business_id, "business_id"),
    providerAccountId: requiredText(
      row.provider_account_id,
      "provider_account_id",
    ),
    adId: requiredText(row.ad_id, "ad_id"),
    snapshotId: requiredText(row.decision_snapshot_id, "decision_snapshot_id"),
    evaluationId: requiredText(
      row.decision_evaluation_id,
      "decision_evaluation_id",
    ),
    engineVersion: requiredText(
      row.decision_engine_version,
      "decision_engine_version",
    ),
    decisionHash: requiredText(row.decision_hash, "decision_hash"),
    action: requiredText(row.action, "action"),
    idempotencyKey: requiredText(row.idempotency_key, "idempotency_key"),
    creativeId: requiredText(row.creative_id, "creative_id"),
    ...(row.dry_run === true ? { dryRun: true } : {}),
  };
  const blockers = validateDecisionOriginAdExecutionRequest(request);
  if (blockers.length > 0 || request.engineVersion !== NATIVE_AD_ENGINE_VERSION) {
    throw new Error(
      `Locked decision-origin lineage is invalid (${blockers.join(", ") || "native_engine_version_mismatch"}).`,
    );
  }
  return request;
}

function episodeFromLockedAction(row: LockedDecisionOriginActionRow) {
  return buildAdRecommendationEpisode({
    businessId: requiredText(row.business_id, "business_id"),
    businessDisplayId: requiredText(
      row.episode_business_id,
      "episode_business_id",
    ),
    providerAccountRefId: requiredText(
      row.provider_account_ref_id,
      "provider_account_ref_id",
    ),
    providerAccountId: requiredText(
      row.provider_account_id,
      "provider_account_id",
    ),
    adId: requiredText(row.ad_id, "ad_id"),
    creativeId: row.episode_creative_id,
    asOfDate: requiredText(row.episode_as_of_date, "episode_as_of_date"),
    engineVersion: requiredText(
      row.decision_engine_version,
      "decision_engine_version",
    ),
    scopeType: requiredText(row.episode_scope_type, "episode_scope_type"),
    scopeId: requiredText(row.episode_scope_id, "episode_scope_id"),
    snapshotId: requiredText(row.decision_snapshot_id, "decision_snapshot_id"),
    evaluationId: requiredText(
      row.decision_evaluation_id,
      "decision_evaluation_id",
    ),
    inputHash: requiredText(row.episode_input_hash, "episode_input_hash"),
    decisionHash: requiredText(row.decision_hash, "decision_hash"),
    decisionLabel: requiredText(
      row.episode_decision_label,
      "episode_decision_label",
    ),
    sourceCampaignId: row.episode_source_campaign_id,
    sourceAdsetId: row.episode_source_adset_id,
    recommendedAt: requiredText(
      row.episode_recommended_at,
      "episode_recommended_at",
    ),
  });
}

async function lockDecisionOriginAction(
  actionLogId: string,
  db: DbClient,
) {
  const rows = await db.query<LockedDecisionOriginActionRow>(
    LOCK_DECISION_ORIGIN_ACTION_FOR_FINALIZATION_QUERY,
    [actionLogId],
  );
  const row = rows[0];
  if (!row) {
    throw new Error(
      "Decision-origin action log did not resolve through exact native episode/evaluation/snapshot lineage.",
    );
  }
  if (rows.length !== 1) {
    throw new Error("Decision-origin action lock returned non-unique lineage.");
  }
  return row;
}

async function persistImmutableReceiptFromLockedDbRow(
  row: LockedDecisionOriginActionRow,
  db: DbClient,
) {
  if (row.status === "pending" || !row.terminal_finalized_at) {
    throw new Error("A pending decision-origin action cannot emit a receipt.");
  }
  const request = lockedDecisionOriginRequest(row);
  const episode = episodeFromLockedAction(row);
  if (episode.episodeKey !== row.decision_episode_key) {
    throw new Error("Locked decision-origin episode key failed reconciliation.");
  }
  const receiptId = row.existing_receipt_id ?? randomUUID();
  const capturedAt = canonicalIsoTimestamp(
    row.existing_receipt_captured_at ?? row.terminal_finalized_at,
    "captured_at",
  );
  const action = deriveExactReceiptFromDbAuthority({
    row,
    request,
    episode,
    receiptId,
    capturedAt,
  });
  if (
    row.existing_receipt_hash &&
    row.existing_receipt_hash !== action.receiptHash
  ) {
    throw new Error("Stored immutable receipt conflicts with DB-derived lineage.");
  }
  const rows = await db.query<StoredNativeReceiptRow>(
    INSERT_IMMUTABLE_AD_OPERATOR_ACTION_RECEIPT_QUERY,
    [
      JSON.stringify({
        id: action.receiptId,
        receipt_hash: action.receiptHash,
        source_action_log_id: action.actionLogId,
        contract_version: action.contractVersion,
        episode_key: episode.episodeKey,
        business_ref_id: episode.businessId,
        business_id: episode.businessDisplayId,
        provider_account_ref_id: episode.providerAccountRefId,
        provider_account_id: episode.providerAccountId,
        source_ad_id: action.sourceAdId,
        source_snapshot_id: action.sourceSnapshotId,
        source_evaluation_id: action.sourceEvaluationId,
        source_engine_version: action.sourceEngineVersion,
        source_decision_hash: action.sourceDecisionHash,
        target_entity_type: action.targetEntityType,
        target_entity_id: action.targetEntityId,
        operator_action: action.action,
        successor_kind: null,
        resulting_ad_id: null,
        idempotency_key: action.idempotencyKey,
        action_status: action.status,
        dry_run: action.dryRun,
        provider_verified: action.providerVerified,
        requested_at: action.requestedAt,
        verified_at: action.verifiedAt,
        finalized_at: action.finalizedAt,
        captured_at: action.capturedAt,
        verification_entity_id: action.verificationEntityId,
        verification_status: action.verificationStatus,
        verification_lineage: action.verificationLineage,
      }),
    ],
  );
  const persisted = rows[0];
  if (
    rows.length !== 1 ||
    persisted?.receipt_id !== action.receiptId ||
    persisted.action_log_id !== action.actionLogId ||
    persisted.receipt_hash !== action.receiptHash
  ) {
    throw new Error(
      "Immutable native receipt did not reconcile exactly with its locked action row.",
    );
  }
  return {
    receiptId: persisted.receipt_id,
    actionLogId: persisted.action_log_id,
    receiptHash: persisted.receipt_hash,
  };
}

export async function persistImmutableAdOperatorActionReceipt(input: {
  actionLogId: string;
  db?: DbClient;
}) {
  if (input.db) {
    const row = await lockDecisionOriginAction(input.actionLogId, input.db);
    return persistImmutableReceiptFromLockedDbRow(row, input.db);
  }
  return runDbTransaction(async () => {
    const db = getDb();
    const row = await lockDecisionOriginAction(input.actionLogId, db);
    return persistImmutableReceiptFromLockedDbRow(row, db);
  });
}

export async function completeDecisionOriginMetaAdsActionLog(input: {
  id: string;
  status: MetaAdsActionStatus;
  payloadResponse?: Record<string, unknown> | null;
  errorCode?: string | null;
  errorMessage?: string | null;
  durationMs?: number | null;
  providerCompletedAt?: string | null;
  verificationPayload?: Record<string, unknown> | null;
}): Promise<MetaAdsActionLogRow> {
  if (input.status === "pending") {
    throw new TypeError("Decision-origin completion requires a terminal status.");
  }
  return runDbTransaction(async () => {
    const db = getDb();
    const locked = await lockDecisionOriginAction(input.id, db);
    if (locked.status !== "pending") {
      if (!locked.existing_receipt_id) {
        throw new Error(
          "Decision-origin action is terminal without its mandatory immutable receipt.",
        );
      }
      await persistImmutableReceiptFromLockedDbRow(locked, db);
      return mapActionLogRow(locked);
    }

    const request = lockedDecisionOriginRequest(locked);
    const dbNow = requiredText(locked.db_now, "db_now");
    const expectedLineage = {
      providerAccountId: request.providerAccountId,
      creativeId: requiredText(
        locked.episode_creative_id,
        "episode_creative_id",
      ),
      campaignId: requiredText(
        locked.episode_source_campaign_id,
        "episode_source_campaign_id",
      ),
      adsetId: requiredText(
        locked.episode_source_adset_id,
        "episode_source_adset_id",
      ),
    };
    if (expectedLineage.creativeId !== request.creativeId) {
      throw new Error(
        "Locked decision-origin creative identity does not match its episode.",
      );
    }
    const persistedVerificationPayload = withPersistedProviderCompletedAt(
      input.verificationPayload,
      input.providerCompletedAt,
    );
    const verification = validateDecisionOriginProviderVerification({
      request,
      expectedLineage,
      verifiedAt: dbNow,
      providerCompletedAt: input.providerCompletedAt,
      verificationPayload: persistedVerificationPayload,
    });
    const verificationMismatch =
      input.status === "success" &&
      request.dryRun !== true &&
      !verification.providerVerified;
    if (verificationMismatch) {
      throw new DecisionOriginProviderVerificationMismatchError(
        verification.blockers,
      );
    }
    const payloadResponse = {
      ...(input.payloadResponse ?? {}),
      decision_origin_verification: {
        provider_verified: verification.providerVerified,
        treatment_eligible: verification.treatmentEligible,
        blockers: verification.blockers,
      },
    };
    const updatedRows = await db.query<MetaAdsActionLogDbRow>(
      UPDATE_DECISION_ORIGIN_ACTION_TERMINAL_QUERY,
      [
        input.id,
        input.status,
        JSON.stringify(payloadResponse),
        input.errorCode ?? null,
        input.errorMessage ?? null,
        input.durationMs ?? null,
        verification.providerVerified,
        dbNow,
        JSON.stringify(persistedVerificationPayload ?? null),
        verification.verificationAdId,
        verification.verificationStatus,
      ],
    );
    if (updatedRows.length !== 1) {
      throw new Error(
        "Decision-origin terminal update did not affect exactly one locked pending row.",
      );
    }
    const finalized = await lockDecisionOriginAction(input.id, db);
    const receipt = await persistImmutableReceiptFromLockedDbRow(finalized, db);
    if (receipt.actionLogId !== input.id) {
      throw new Error("Decision-origin terminal update returned no exact receipt.");
    }
    const reconciled = await lockDecisionOriginAction(input.id, db);
    if (reconciled.existing_receipt_id !== receipt.receiptId) {
      throw new Error(
        "Decision-origin terminal row and immutable receipt did not reconcile.",
      );
    }
    return mapActionLogRow(reconciled);
  });
}

export async function markDecisionOriginActionReconciliationRequired(input: {
  id: string;
  errorMessage: string;
  outcome?: DecisionOriginReconciliationOutcome;
  providerErrorCode?: string | null;
  mutationAttempt?: unknown;
  providerResponsePayload?: Record<string, unknown> | null;
  durationMs?: number | null;
  verificationPayload?: Record<string, unknown> | null;
  providerCompletedAt?: string | null;
  observedAt?: string;
}): Promise<MetaAdsActionLogRow | null> {
  const observedAt = input.observedAt ?? new Date().toISOString();
  const outcome =
    input.outcome ??
    "provider_write_verified_receipt_persistence_failed";
  const providerMutationAttempted =
    outcome === "provider_outcome_ambiguous" ||
    outcome === "provider_response_succeeded_verification_failed" ||
    outcome === "provider_write_verified_receipt_persistence_failed" ||
    outcome === "provider_rejection_terminal_persistence_failed";
  const providerMutationSucceeded =
    outcome === "provider_response_succeeded_verification_failed" ||
    outcome === "provider_write_verified_receipt_persistence_failed";
  const persistedVerificationPayload = withPersistedProviderCompletedAt(
    input.verificationPayload,
    input.providerCompletedAt,
  );
  const reconciliationMarker = {
    reconciliation_required: true,
    retry_allowed: false,
    outcome,
    provider_mutation_attempted: providerMutationAttempted,
    provider_mutation_succeeded: providerMutationSucceeded,
    provider_outcome_ambiguous:
      outcome === "provider_outcome_ambiguous",
    provider_error_code: input.providerErrorCode ?? null,
    mutation_attempt: input.mutationAttempt ?? null,
    provider_response_payload: input.providerResponsePayload ?? null,
    verification_payload_captured: Boolean(persistedVerificationPayload),
    observed_at: observedAt,
  };
  const sql = getDb();
  const rows = await sql.query<MetaAdsActionLogDbRow>(
    MARK_DECISION_ORIGIN_RECONCILIATION_REQUIRED_QUERY,
    [
      input.id,
      JSON.stringify(reconciliationMarker),
      input.errorMessage,
      input.durationMs ?? null,
      persistedVerificationPayload
        ? JSON.stringify(persistedVerificationPayload)
        : null,
      observedAt,
    ],
  );
  return rows[0] ? mapActionLogRow(rows[0]) : null;
}

export async function listRecentMetaAdsActionLogs(input: {
  businessId: string;
  adId: string;
  limit?: number;
}): Promise<MetaAdsActionLogRow[]> {
  const sql = getDb();
  const limit = Math.max(1, Math.min(input.limit ?? 10, 50));
  const rows = (await sql`
    SELECT *
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND ad_id = ${input.adId}
    ORDER BY requested_at DESC
    LIMIT ${limit}
  `) as MetaAdsActionLogDbRow[];
  return rows.map(mapActionLogRow);
}

export async function readLaunchpadCreatedAdIds(input: {
  businessId: string;
  adIds: string[];
}): Promise<Set<string>> {
  const adIds = Array.from(
    new Set(input.adIds.map((adId) => adId.trim()).filter(Boolean)),
  );
  if (adIds.length === 0) return new Set();
  const sql = getDb();
  const rows = (await sql`
    SELECT DISTINCT resulting_ad_id
    FROM meta_ads_action_log
    WHERE business_id = ${input.businessId}
      AND action IN ('launch_ad', 'duplicate')
      AND status = 'success'
      AND resulting_ad_id = ANY(${adIds}::text[])
  `) as Array<{ resulting_ad_id: string | null }>;
  return new Set(
    rows.flatMap((row) => row.resulting_ad_id?.trim() || []),
  );
}
