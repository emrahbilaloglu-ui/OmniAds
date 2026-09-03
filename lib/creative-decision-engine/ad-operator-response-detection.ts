import { canonicalSha256 } from "./canonical-evaluation";
import { RESPONSE_WINDOW_DAYS } from "./config-values";
import { DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION } from "./execution-safety";
import { NATIVE_AD_ENGINE_VERSION } from "./types";

export const NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION =
  "meta-native-ad-operator-lineage.v1" as const;
export const NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION =
  "meta-entity-ad-delivery-observation.v1" as const;
export const NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION =
  "engine-v3-native-ad-operator-response.v3" as const;
export const NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION =
  // v3 (D075 consumer sweep): state evidence entries carry confirmedUntil —
  // the re-confirmation clock that certifies window-end truth for unchanged
  // entities under heartbeat/delta manifests.
  "engine-v3-native-ad-operator-source-proof.v3" as const;
export const AD_OPERATOR_RESPONSE_WINDOW_DAYS = RESPONSE_WINDOW_DAYS;

export type AdOperatorResponseType =
  | "verified_pause"
  | "verified_resume"
  | "duplicate_successor"
  | "rebuild_successor"
  | "budget_owner_action_context"
  | "natural_spend_cessation"
  | "no_response_observed"
  | "unknown_incomplete"
  | "ambiguous_conflicting";

export type AdOperatorResponseObservationStatus =
  | "observed_response"
  | "observed_no_response"
  | "unknown_incomplete";

export type AdOperatorActionSemantic =
  | "pause"
  | "resume"
  | "duplicate"
  | "rebuild"
  | "budget_increase"
  | "budget_decrease"
  | "budget_change";

export type AdOperatorTargetEntityType = "ad" | "adset" | "campaign";
export type AdEntityObservationCompleteness =
  | "complete"
  | "partial"
  | "point_lookup";

export interface AdRecommendationEpisodeIdentity {
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  adId: string;
  asOfDate: string;
  engineVersion: string;
  scopeType: string;
  scopeId: string;
  snapshotId: string;
  evaluationId: string;
  inputHash: string;
  decisionHash: string;
  recommendedAt: string;
}

export interface AdRecommendationEpisode
  extends AdRecommendationEpisodeIdentity {
  episodeKey: string;
  businessDisplayId: string;
  creativeId: string | null;
  decisionLabel: string;
  sourceCampaignId: string | null;
  sourceAdsetId: string | null;
}

export interface ExactMetaAdsActionLineage {
  receiptId: string;
  receiptHash: string;
  actionLogId: string;
  contractVersion:
    | typeof DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
    | typeof NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  sourceAdId: string;
  sourceSnapshotId: string;
  sourceEvaluationId: string;
  sourceEngineVersion: string;
  sourceDecisionHash: string;
  targetEntityType: AdOperatorTargetEntityType;
  targetEntityId: string;
  action: AdOperatorActionSemantic;
  successorKind: "duplicate" | "rebuild" | null;
  resultingAdId: string | null;
  idempotencyKey: string;
  status: "success" | "failure" | "silent_failure";
  dryRun: boolean;
  providerVerified: boolean;
  requestedAt: string;
  verifiedAt: string | null;
  finalizedAt: string;
  capturedAt: string;
  verificationEntityId: string | null;
  verificationStatus: string | null;
  verificationLineage: {
    sourceCreativeId: string | null;
    sourceCampaignId: string | null;
    sourceAdsetId: string | null;
    verifiedProviderAccountId: string | null;
    verifiedCreativeId: string | null;
    verifiedCampaignId: string | null;
    verifiedAdsetId: string | null;
  } | null;
}

export interface AdDeliveryObservation {
  contractVersion: typeof NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION;
  priorWindowSpend: number | null;
  currentWindowSpend: number;
  windowStart: string;
  windowEnd: string;
}

export interface AdEntityStateObservation {
  stateHistoryId: string;
  runId: string;
  runHash: string;
  runCompleteness: AdEntityObservationCompleteness;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  entityType: AdOperatorTargetEntityType;
  entityId: string;
  campaignId: string | null;
  adsetId: string | null;
  adId: string | null;
  creativeId: string | null;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  campaignDailyBudgetRaw: string | null;
  campaignLifetimeBudgetRaw: string | null;
  adsetDailyBudgetRaw: string | null;
  adsetLifetimeBudgetRaw: string | null;
  budgetOrigin: "campaign" | "adset" | "not_observed" | "not_applicable";
  presence: "present" | "absent_unconfirmed";
  fieldCoverage: Record<string, unknown>;
  observedAt: string;
  capturedAt: string;
  /**
   * D075 consumer sweep: the as-of-cutoff re-confirmation clock — the run
   * heartbeat and later same-scope delta manifests keep confirming an
   * unchanged winner while its own captured_at freezes at first capture.
   * Optional for legacy fixtures; absent means capturedAt.
   */
  confirmedUntil?: string;
  stateHash: string;
  delivery: AdDeliveryObservation | null;
}

export interface AdEntityTombstoneObservation {
  tombstoneId: string;
  runId: string;
  runHash: string;
  runCompleteness: Extract<
    AdEntityObservationCompleteness,
    "complete" | "point_lookup"
  >;
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  entityType: AdOperatorTargetEntityType;
  entityId: string;
  reason: "explicit_deleted" | "explicit_not_found";
  providerEvidence: Record<string, unknown>;
  observedAt: string;
  capturedAt: string;
  tombstoneHash: string;
}

export interface AdOperatorResponseSourceReads {
  actionReceiptsComplete: boolean;
  stateHistoryComplete: boolean;
  tombstonesComplete: boolean;
}

export interface AdOperatorResponseSourceProof {
  contractVersion: typeof NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION;
  windowStart: string;
  windowEnd: string;
  windowClosed: boolean;
  actionReceiptsComplete: boolean;
  stateHistoryComplete: boolean;
  tombstonesComplete: boolean;
  requiredStateTargetCount: number;
  completeStateTargetCount: number;
  actionReceiptCount: number;
  stateObservationCount: number;
  tombstoneObservationCount: number;
  sourceComplete: boolean;
  sourceSetHash: string;
}

export type AdOperatorResponseDiagnosticCode =
  | "ignored_action_lineage_mismatch"
  | "ignored_action_outside_episode_window"
  | "receipt_integrity_mismatch"
  | "dry_run_action_log"
  | "failed_action_log"
  | "unverified_action_log"
  | "action_state_observation_missing"
  | "action_state_observation_conflict"
  | "budget_owner_not_proven_by_source_decision"
  | "budget_change_not_observed"
  | "budget_change_direction_conflict"
  | "unlogged_ad_status_change"
  | "unlogged_hierarchy_change"
  | "zero_spend_without_positive_baseline"
  | "natural_spend_cessation_is_not_treatment"
  | "budget_owner_action_is_context_only"
  | "multiple_verified_responses"
  | "attribution_window_open"
  | "source_read_incomplete"
  | "state_coverage_incomplete"
  | "explicit_tombstone_without_typed_receipt"
  | "complete_window_no_typed_response";

export interface AdOperatorResponseDiagnostic {
  code: AdOperatorResponseDiagnosticCode;
  evidenceId: string | null;
  detail: string;
}

export interface AdOperatorResponseEvidenceRef {
  kind:
    | "engine_v3_ad_operator_action_receipt"
    | "meta_entity_state_history"
    | "meta_entity_tombstones";
  sourceId: string;
  role:
    | "non_treatment_diagnostic"
    | "action_receipt"
    | "pre_action_state"
    | "post_action_state"
    | "successor_state"
    | "budget_owner_state"
    | "delivery_cessation_state"
    | "window_start_state"
    | "window_end_state"
    | "entity_tombstone";
  observedAt: string;
  capturedAt: string;
  treatmentEligible: boolean;
  diagnosticCode: AdOperatorResponseDiagnosticCode | null;
  payload: Record<string, unknown>;
}

export interface AdOperatorResponseResult {
  contractVersion: typeof NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION;
  episodeKey: string;
  observationStatus: AdOperatorResponseObservationStatus;
  responseType: AdOperatorResponseType;
  operatorResponseDetected: boolean;
  adTreatmentDetected: boolean;
  detectedAt: string | null;
  actionReceiptId: string | null;
  actionLogId: string | null;
  successorAdId: string | null;
  successorKind: "duplicate" | "rebuild" | null;
  budgetOwnerType: "campaign" | "adset" | null;
  budgetOwnerId: string | null;
  sourceProof: AdOperatorResponseSourceProof;
  diagnostics: AdOperatorResponseDiagnostic[];
  evidence: AdOperatorResponseEvidenceRef[];
  responseHash: string;
}

interface ResponseCandidate {
  responseType: Extract<
    AdOperatorResponseType,
    | "verified_pause"
    | "verified_resume"
    | "duplicate_successor"
    | "rebuild_successor"
    | "budget_owner_action_context"
  >;
  action: ExactMetaAdsActionLineage;
  evidence: AdOperatorResponseEvidenceRef[];
  successorAdId: string | null;
  successorKind: "duplicate" | "rebuild" | null;
  budgetOwnerType: "campaign" | "adset" | null;
  budgetOwnerId: string | null;
}

interface RequiredStateTarget {
  entityType: AdOperatorTargetEntityType;
  entityId: string;
}

function required(value: string, field: string): string {
  const normalized = value.trim();
  if (!normalized) throw new TypeError(`${field} must be a non-empty string.`);
  return normalized;
}

function requiredHash(value: string, field: string): string {
  const normalized = required(value, field).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(normalized)) {
    throw new TypeError(`${field} must be a lowercase SHA-256 hash.`);
  }
  return normalized;
}

function optional(value: string | null | undefined): string | null {
  const normalized = value?.trim() ?? "";
  return normalized || null;
}

function normalizedProviderAccountId(value: string | null | undefined) {
  const normalized = optional(value);
  return normalized
    ? `act_${normalized.replace(/^act[_-]/, "")}`
    : null;
}

function timestamp(value: string, field: string): number {
  const parsed = Date.parse(value);
  if (!Number.isFinite(parsed)) {
    throw new TypeError(`${field} must be a valid timestamp.`);
  }
  return parsed;
}

function maybeTimestamp(value: string | null | undefined): number | null {
  if (!value) return null;
  const parsed = Date.parse(value);
  return Number.isFinite(parsed) ? parsed : null;
}

function normalizeStatus(value: string | null): string | null {
  const normalized = value?.trim().toUpperCase().replaceAll("-", "_") ?? "";
  return normalized || null;
}

function isActiveState(state: AdEntityStateObservation): boolean {
  return (
    normalizeStatus(state.configuredStatus) === "ACTIVE" &&
    normalizeStatus(state.effectiveStatus) === "ACTIVE"
  );
}

function stateConfirmsAction(
  state: AdEntityStateObservation,
  action: "pause" | "resume",
): boolean {
  const expected = action === "pause" ? "PAUSED" : "ACTIVE";
  return (
    normalizeStatus(state.configuredStatus) === expected &&
    (normalizeStatus(state.effectiveStatus) === expected ||
      (action === "pause" && state.effectiveStatus == null))
  );
}

function stateAllowsActionBefore(
  state: AdEntityStateObservation,
  action: "pause" | "resume",
): boolean {
  return action === "pause"
    ? isActiveState(state)
    : normalizeStatus(state.configuredStatus) === "PAUSED";
}

function sameStateIdentity(
  state: AdEntityStateObservation,
  entityType: AdOperatorTargetEntityType,
  entityId: string,
): boolean {
  if (state.entityType !== entityType || state.entityId !== entityId) return false;
  if (entityType === "ad") return state.adId === entityId;
  if (entityType === "adset") return state.adsetId === entityId;
  return state.campaignId === entityId;
}

function isCompleteState(state: AdEntityStateObservation): boolean {
  return (
    (state.runCompleteness === "complete" ||
      state.runCompleteness === "point_lookup") &&
    /^[0-9a-f]{64}$/.test(state.runHash) &&
    /^[0-9a-f]{64}$/.test(state.stateHash) &&
    state.presence === "present"
  );
}

function fieldObserved(state: AdEntityStateObservation, field: string): boolean {
  return state.fieldCoverage[field] === true;
}

function isCompleteStateForTarget(
  state: AdEntityStateObservation,
  entityType: AdOperatorTargetEntityType,
): boolean {
  if (
    !isCompleteState(state) ||
    state.configuredStatus == null ||
    state.effectiveStatus == null ||
    !fieldObserved(state, "configuredStatus") ||
    !fieldObserved(state, "effectiveStatus")
  ) {
    return false;
  }
  if (entityType === "ad") return state.budgetOrigin === "not_applicable";
  if (entityType === "campaign") {
    const budgetFieldsObserved =
      fieldObserved(state, "campaignDailyBudgetRaw") &&
      fieldObserved(state, "campaignLifetimeBudgetRaw");
    const budgetValueConsistent =
      state.budgetOrigin === "not_applicable" ||
      (state.budgetOrigin === "campaign" &&
        (state.campaignDailyBudgetRaw != null ||
          state.campaignLifetimeBudgetRaw != null));
    return budgetFieldsObserved && budgetValueConsistent;
  }
  const budgetFieldsObserved =
    fieldObserved(state, "adsetDailyBudgetRaw") &&
    fieldObserved(state, "adsetLifetimeBudgetRaw");
  const budgetValueConsistent =
    state.budgetOrigin === "not_applicable" ||
    (state.budgetOrigin === "adset" &&
      (state.adsetDailyBudgetRaw != null ||
        state.adsetLifetimeBudgetRaw != null));
  return budgetFieldsObserved && budgetValueConsistent;
}

export function resolveAdOperatorResponseWindow(input: {
  recommendedAt: string;
  responseWindowDays?: number;
}): { start: string; end: string; startTime: number; endTime: number } {
  const startTime = timestamp(input.recommendedAt, "recommendedAt");
  const responseWindowDays =
    input.responseWindowDays ?? AD_OPERATOR_RESPONSE_WINDOW_DAYS;
  if (
    !Number.isInteger(responseWindowDays) ||
    responseWindowDays < 1 ||
    responseWindowDays > 90
  ) {
    throw new TypeError("responseWindowDays must be an integer from 1 to 90.");
  }
  const endTime = startTime + responseWindowDays * 24 * 60 * 60 * 1_000;
  return {
    start: new Date(startTime).toISOString(),
    end: new Date(endTime).toISOString(),
    startTime,
    endTime,
  };
}

export function buildAdRecommendationEpisodeKey(
  input: AdRecommendationEpisodeIdentity,
): string {
  if (required(input.engineVersion, "engineVersion") !== NATIVE_AD_ENGINE_VERSION) {
    throw new TypeError(
      `engineVersion must equal the native ad epoch ${NATIVE_AD_ENGINE_VERSION}.`,
    );
  }
  timestamp(input.recommendedAt, "recommendedAt");
  return canonicalSha256({
    contractVersion: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
    businessId: required(input.businessId, "businessId"),
    providerAccountRefId: required(
      input.providerAccountRefId,
      "providerAccountRefId",
    ),
    providerAccountId: required(input.providerAccountId, "providerAccountId"),
    adId: required(input.adId, "adId"),
    asOfDate: required(input.asOfDate, "asOfDate"),
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    scopeType: required(input.scopeType, "scopeType"),
    scopeId: required(input.scopeId, "scopeId"),
    snapshotId: required(input.snapshotId, "snapshotId"),
    evaluationId: required(input.evaluationId, "evaluationId"),
    inputHash: requiredHash(input.inputHash, "inputHash"),
    decisionHash: requiredHash(input.decisionHash, "decisionHash"),
    recommendedAt: new Date(
      timestamp(input.recommendedAt, "recommendedAt"),
    ).toISOString(),
  });
}

export function buildAdRecommendationEpisode(
  input: Omit<AdRecommendationEpisode, "episodeKey">,
): AdRecommendationEpisode {
  const normalized: Omit<AdRecommendationEpisode, "episodeKey"> = {
    ...input,
    businessId: required(input.businessId, "businessId"),
    businessDisplayId: required(input.businessDisplayId, "businessDisplayId"),
    providerAccountRefId: required(
      input.providerAccountRefId,
      "providerAccountRefId",
    ),
    providerAccountId: required(input.providerAccountId, "providerAccountId"),
    adId: required(input.adId, "adId"),
    asOfDate: required(input.asOfDate, "asOfDate"),
    engineVersion: required(input.engineVersion, "engineVersion"),
    scopeType: required(input.scopeType, "scopeType"),
    scopeId: required(input.scopeId, "scopeId"),
    snapshotId: required(input.snapshotId, "snapshotId"),
    evaluationId: required(input.evaluationId, "evaluationId"),
    inputHash: requiredHash(input.inputHash, "inputHash"),
    decisionHash: requiredHash(input.decisionHash, "decisionHash"),
    decisionLabel: required(input.decisionLabel, "decisionLabel"),
    creativeId: optional(input.creativeId),
    sourceCampaignId: optional(input.sourceCampaignId),
    sourceAdsetId: optional(input.sourceAdsetId),
    recommendedAt: new Date(
      timestamp(input.recommendedAt, "recommendedAt"),
    ).toISOString(),
  };
  return {
    ...normalized,
    episodeKey: buildAdRecommendationEpisodeKey(normalized),
  };
}

export function buildExactMetaAdsActionReceiptHash(
  action: Omit<ExactMetaAdsActionLineage, "receiptHash">,
): string {
  return canonicalSha256({
    receiptContract: "engine-v3-native-ad-operator-action-receipt.v1",
    receiptId: required(action.receiptId, "receiptId"),
    actionLogId: required(action.actionLogId, "actionLogId"),
    contractVersion: action.contractVersion,
    businessId: required(action.businessId, "businessId"),
    providerAccountRefId: required(
      action.providerAccountRefId,
      "providerAccountRefId",
    ),
    providerAccountId: required(
      action.providerAccountId,
      "providerAccountId",
    ),
    sourceAdId: required(action.sourceAdId, "sourceAdId"),
    sourceSnapshotId: required(action.sourceSnapshotId, "sourceSnapshotId"),
    sourceEvaluationId: required(
      action.sourceEvaluationId,
      "sourceEvaluationId",
    ),
    sourceEngineVersion: required(
      action.sourceEngineVersion,
      "sourceEngineVersion",
    ),
    sourceDecisionHash: requiredHash(
      action.sourceDecisionHash,
      "sourceDecisionHash",
    ),
    targetEntityType: action.targetEntityType,
    targetEntityId: required(action.targetEntityId, "targetEntityId"),
    action: action.action,
    successorKind: action.successorKind,
    resultingAdId: optional(action.resultingAdId),
    idempotencyKey: required(action.idempotencyKey, "idempotencyKey"),
    status: action.status,
    dryRun: action.dryRun,
    providerVerified: action.providerVerified,
    requestedAt: new Date(
      timestamp(action.requestedAt, "requestedAt"),
    ).toISOString(),
    verifiedAt:
      action.verifiedAt == null
        ? null
        : new Date(timestamp(action.verifiedAt, "verifiedAt")).toISOString(),
    finalizedAt: new Date(
      timestamp(action.finalizedAt, "finalizedAt"),
    ).toISOString(),
    capturedAt: new Date(
      timestamp(action.capturedAt, "capturedAt"),
    ).toISOString(),
    verificationEntityId: optional(action.verificationEntityId),
    verificationStatus: optional(action.verificationStatus),
    ...(action.verificationLineage
      ? {
          verificationLineage: {
            sourceCreativeId: optional(
              action.verificationLineage.sourceCreativeId,
            ),
            sourceCampaignId: optional(
              action.verificationLineage.sourceCampaignId,
            ),
            sourceAdsetId: optional(
              action.verificationLineage.sourceAdsetId,
            ),
            verifiedProviderAccountId: optional(
              action.verificationLineage.verifiedProviderAccountId,
            ),
            verifiedCreativeId: optional(
              action.verificationLineage.verifiedCreativeId,
            ),
            verifiedCampaignId: optional(
              action.verificationLineage.verifiedCampaignId,
            ),
            verifiedAdsetId: optional(
              action.verificationLineage.verifiedAdsetId,
            ),
          },
        }
      : {}),
  });
}

function receiptIntegrityValid(action: ExactMetaAdsActionLineage): boolean {
  try {
    const { receiptHash, ...withoutHash } = action;
    const finalized = timestamp(action.finalizedAt, "finalizedAt");
    const captured = timestamp(action.capturedAt, "capturedAt");
    const lineage = action.verificationLineage;
    const exactStatusLineageRequired =
      action.providerVerified &&
      action.contractVersion ===
        DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION &&
      (action.action === "pause" || action.action === "resume") &&
      lineage !== null;
    const providerLineageValid =
      !exactStatusLineageRequired ||
      (lineage !== null &&
        optional(lineage.sourceCreativeId) !== null &&
        optional(lineage.sourceCampaignId) !== null &&
        optional(lineage.sourceAdsetId) !== null &&
        normalizedProviderAccountId(lineage.verifiedProviderAccountId) ===
          normalizedProviderAccountId(action.providerAccountId) &&
        optional(lineage.verifiedCreativeId) ===
          optional(lineage.sourceCreativeId) &&
        optional(lineage.verifiedCampaignId) ===
          optional(lineage.sourceCampaignId) &&
        optional(lineage.verifiedAdsetId) ===
          optional(lineage.sourceAdsetId) &&
        optional(action.verificationEntityId) === action.sourceAdId);
    return (
      requiredHash(receiptHash, "receiptHash") ===
        buildExactMetaAdsActionReceiptHash(withoutHash) &&
      captured >= finalized &&
      providerLineageValid
    );
  } catch {
    return false;
  }
}

function actionMatchesEpisode(
  action: ExactMetaAdsActionLineage,
  episode: AdRecommendationEpisode,
): boolean {
  const contractAllowsAction =
    action.contractVersion === NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION ||
    (action.contractVersion ===
      DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION &&
      (action.action === "pause" || action.action === "resume"));
  return (
    contractAllowsAction &&
    action.businessId === episode.businessId &&
    action.providerAccountRefId === episode.providerAccountRefId &&
    action.providerAccountId === episode.providerAccountId &&
    action.sourceAdId === episode.adId &&
    action.sourceSnapshotId === episode.snapshotId &&
    action.sourceEvaluationId === episode.evaluationId &&
    action.sourceEngineVersion === NATIVE_AD_ENGINE_VERSION &&
    action.sourceEngineVersion === episode.engineVersion &&
    action.sourceDecisionHash === episode.decisionHash &&
    (action.verificationLineage === null ||
      (action.verificationLineage.sourceCreativeId === episode.creativeId &&
        action.verificationLineage.sourceCampaignId ===
          episode.sourceCampaignId &&
        action.verificationLineage.sourceAdsetId === episode.sourceAdsetId))
  );
}

export function assertExactMetaAdsActionReceiptForEpisode(input: {
  action: ExactMetaAdsActionLineage;
  episode: AdRecommendationEpisode;
}): void {
  if (
    input.episode.episodeKey !==
    buildAdRecommendationEpisodeKey(input.episode)
  ) {
    throw new TypeError("Episode key does not match its immutable lineage.");
  }
  if (!receiptIntegrityValid(input.action)) {
    throw new TypeError(
      "Immutable action receipt hash or finalization chronology is invalid.",
    );
  }
  if (!actionMatchesEpisode(input.action, input.episode)) {
    throw new TypeError(
      "Immutable action receipt does not match the exact native episode lineage.",
    );
  }
}

function actionInsideWindow(
  action: ExactMetaAdsActionLineage,
  recommendationTime: number,
  windowEndTime: number,
  cutoffTime: number,
): boolean {
  const requested = maybeTimestamp(action.requestedAt);
  const finalized = maybeTimestamp(action.finalizedAt);
  const captured = maybeTimestamp(action.capturedAt);
  return (
    requested != null &&
    finalized != null &&
    captured != null &&
    requested > recommendationTime &&
    requested <= windowEndTime &&
    finalized >= requested &&
    finalized <= windowEndTime &&
    captured >= finalized &&
    captured <= cutoffTime
  );
}

function cutoffSafeStates(input: {
  episode: AdRecommendationEpisode;
  states: readonly AdEntityStateObservation[];
  windowEndTime: number;
  cutoffTime: number;
}) {
  return input.states
    .filter((state) => {
      const observed = maybeTimestamp(state.observedAt);
      const captured = maybeTimestamp(state.capturedAt);
      return (
        state.businessId === input.episode.businessId &&
        state.providerAccountRefId === input.episode.providerAccountRefId &&
        state.providerAccountId === input.episode.providerAccountId &&
        sameStateIdentity(state, state.entityType, state.entityId) &&
        observed != null &&
        captured != null &&
        captured >= observed &&
        observed <= input.windowEndTime &&
        captured <= input.cutoffTime
      );
    })
    .sort(
      (left, right) =>
        timestamp(left.observedAt, "observedAt") -
          timestamp(right.observedAt, "observedAt") ||
        timestamp(left.capturedAt, "capturedAt") -
          timestamp(right.capturedAt, "capturedAt") ||
        left.stateHistoryId.localeCompare(right.stateHistoryId),
    );
}

function cutoffSafeTombstones(input: {
  episode: AdRecommendationEpisode;
  tombstones: readonly AdEntityTombstoneObservation[];
  windowEndTime: number;
  cutoffTime: number;
}) {
  return input.tombstones
    .filter((tombstone) => {
      const observed = maybeTimestamp(tombstone.observedAt);
      const captured = maybeTimestamp(tombstone.capturedAt);
      return (
        tombstone.businessId === input.episode.businessId &&
        tombstone.providerAccountRefId === input.episode.providerAccountRefId &&
        tombstone.providerAccountId === input.episode.providerAccountId &&
        observed != null &&
        captured != null &&
        captured >= observed &&
        observed <= input.windowEndTime &&
        captured <= input.cutoffTime
      );
    })
    .sort(
      (left, right) =>
        timestamp(left.observedAt, "observedAt") -
          timestamp(right.observedAt, "observedAt") ||
        timestamp(left.capturedAt, "capturedAt") -
          timestamp(right.capturedAt, "capturedAt") ||
        left.tombstoneId.localeCompare(right.tombstoneId),
    );
}

function statesFor(
  states: readonly AdEntityStateObservation[],
  entityType: AdOperatorTargetEntityType,
  entityId: string,
) {
  return states.filter((state) => sameStateIdentity(state, entityType, entityId));
}

function tombstonesFor(
  tombstones: readonly AdEntityTombstoneObservation[],
  entityType: AdOperatorTargetEntityType,
  entityId: string,
) {
  return tombstones.filter(
    (tombstone) =>
      tombstone.entityType === entityType && tombstone.entityId === entityId,
  );
}

type EntityTruth =
  | { kind: "state"; value: AdEntityStateObservation }
  | { kind: "tombstone"; value: AdEntityTombstoneObservation };

function truthObservedAt(truth: EntityTruth) {
  return timestamp(truth.value.observedAt, "observedAt");
}

function truthCapturedAt(truth: EntityTruth) {
  return timestamp(truth.value.capturedAt, "capturedAt");
}

// D075 consumer sweep: window-end truth is certified by the re-confirmation
// clock, not the frozen first-capture clock — see confirmedUntil on
// AdEntityStateObservation. Tombstones carry no heartbeat.
function truthConfirmedUntil(truth: EntityTruth) {
  if (truth.kind === "state" && truth.value.confirmedUntil) {
    return Math.max(
      timestamp(truth.value.confirmedUntil, "confirmedUntil"),
      truthCapturedAt(truth),
    );
  }
  return truthCapturedAt(truth);
}

function truthId(truth: EntityTruth) {
  return truth.kind === "state"
    ? truth.value.stateHistoryId
    : truth.value.tombstoneId;
}

function latestVisibleTruthAtOrBefore(
  states: readonly AdEntityStateObservation[],
  tombstones: readonly AdEntityTombstoneObservation[],
  observedAt: number,
  capturedAt = observedAt,
): EntityTruth | undefined {
  const candidates: EntityTruth[] = [
    ...states.map((value) => ({ kind: "state" as const, value })),
    ...tombstones.map((value) => ({ kind: "tombstone" as const, value })),
  ];
  return candidates
    .filter(
      (truth) =>
        truthObservedAt(truth) <= observedAt &&
        truthCapturedAt(truth) <= capturedAt,
    )
    .sort(
      (left, right) =>
        truthObservedAt(right) - truthObservedAt(left) ||
        truthCapturedAt(right) - truthCapturedAt(left) ||
        Number(right.kind === "tombstone") - Number(left.kind === "tombstone") ||
        truthId(right).localeCompare(truthId(left)),
    )[0];
}

function latestVisibleAtOrBefore(
  states: readonly AdEntityStateObservation[],
  at: number,
  tombstones: readonly AdEntityTombstoneObservation[] = [],
) {
  const truth = latestVisibleTruthAtOrBefore(states, tombstones, at);
  return truth?.kind === "state" ? truth.value : undefined;
}

function firstObservedTruthAtOrAfter(
  states: readonly AdEntityStateObservation[],
  tombstones: readonly AdEntityTombstoneObservation[],
  at: number,
): EntityTruth | undefined {
  const candidates: EntityTruth[] = [
    ...states.map((value) => ({ kind: "state" as const, value })),
    ...tombstones.map((value) => ({ kind: "tombstone" as const, value })),
  ];
  return candidates
    .filter(
      (truth) =>
        truthObservedAt(truth) >= at && truthCapturedAt(truth) >= at,
    )
    .sort(
      (left, right) =>
        truthObservedAt(left) - truthObservedAt(right) ||
        truthCapturedAt(left) - truthCapturedAt(right) ||
        Number(right.kind === "tombstone") - Number(left.kind === "tombstone") ||
        truthId(left).localeCompare(truthId(right)),
    )[0];
}

function firstObservedAtOrAfter(
  states: readonly AdEntityStateObservation[],
  at: number,
  tombstones: readonly AdEntityTombstoneObservation[] = [],
) {
  const truth = firstObservedTruthAtOrAfter(states, tombstones, at);
  return truth?.kind === "state" ? truth.value : undefined;
}

function latestObservedTruthAfter(
  states: readonly AdEntityStateObservation[],
  tombstones: readonly AdEntityTombstoneObservation[],
  at: number,
): EntityTruth | undefined {
  const candidates: EntityTruth[] = [
    ...states.map((value) => ({ kind: "state" as const, value })),
    ...tombstones.map((value) => ({ kind: "tombstone" as const, value })),
  ];
  return candidates
    .filter((truth) => truthObservedAt(truth) > at)
    .sort(
      (left, right) =>
        truthObservedAt(right) - truthObservedAt(left) ||
        truthCapturedAt(right) - truthCapturedAt(left) ||
        Number(right.kind === "tombstone") - Number(left.kind === "tombstone") ||
        truthId(right).localeCompare(truthId(left)),
    )[0];
}

function latestObservedAfter(
  states: readonly AdEntityStateObservation[],
  at: number,
  tombstones: readonly AdEntityTombstoneObservation[] = [],
) {
  const truth = latestObservedTruthAfter(states, tombstones, at);
  return truth?.kind === "state" ? truth.value : undefined;
}

function terminalTruth(
  states: readonly AdEntityStateObservation[],
  tombstones: readonly AdEntityTombstoneObservation[],
  windowEndTime: number,
  cutoffTime: number,
): EntityTruth | undefined {
  const candidates: EntityTruth[] = [
    ...states.map((value) => ({ kind: "state" as const, value })),
    ...tombstones.map((value) => ({ kind: "tombstone" as const, value })),
  ];
  return candidates
    .filter(
      (truth) =>
        truthObservedAt(truth) <= windowEndTime &&
        truthConfirmedUntil(truth) >= windowEndTime &&
        truthCapturedAt(truth) <= cutoffTime,
    )
    .sort(
      (left, right) =>
        truthCapturedAt(right) - truthCapturedAt(left) ||
        truthObservedAt(right) - truthObservedAt(left) ||
        Number(right.kind === "tombstone") - Number(left.kind === "tombstone") ||
        truthId(right).localeCompare(truthId(left)),
    )[0];
}

function terminalConfirmation(
  states: readonly AdEntityStateObservation[],
  windowEndTime: number,
  cutoffTime: number,
  tombstones: readonly AdEntityTombstoneObservation[] = [],
) {
  const truth = terminalTruth(states, tombstones, windowEndTime, cutoffTime);
  return truth?.kind === "state" ? truth.value : undefined;
}

function actionEvidence(
  action: ExactMetaAdsActionLineage,
  input: {
    treatmentEligible: boolean;
    diagnosticCode: AdOperatorResponseDiagnosticCode | null;
  },
): AdOperatorResponseEvidenceRef {
  return {
    kind: "engine_v3_ad_operator_action_receipt",
    sourceId: action.receiptId,
    role: input.treatmentEligible
      ? "action_receipt"
      : "non_treatment_diagnostic",
    observedAt: action.verifiedAt ?? action.requestedAt,
    capturedAt: action.capturedAt,
    treatmentEligible: input.treatmentEligible,
    diagnosticCode: input.diagnosticCode,
    payload: {
      receiptHash: action.receiptHash,
      actionLogId: action.actionLogId,
      contractVersion: action.contractVersion,
      action: action.action,
      targetEntityType: action.targetEntityType,
      targetEntityId: action.targetEntityId,
      resultingAdId: action.resultingAdId,
      status: action.status,
      dryRun: action.dryRun,
      providerVerified: action.providerVerified,
      idempotencyKey: action.idempotencyKey,
      finalizedAt: action.finalizedAt,
    },
  };
}

function stateEvidence(
  state: AdEntityStateObservation,
  role: Exclude<
    AdOperatorResponseEvidenceRef["role"],
    "non_treatment_diagnostic" | "action_receipt" | "entity_tombstone"
  >,
): AdOperatorResponseEvidenceRef {
  return {
    kind: "meta_entity_state_history",
    sourceId: state.stateHistoryId,
    role,
    observedAt: state.observedAt,
    capturedAt: state.capturedAt,
    treatmentEligible: false,
    diagnosticCode: null,
    payload: {
      runId: state.runId,
      runHash: state.runHash,
      runCompleteness: state.runCompleteness,
      entityType: state.entityType,
      entityId: state.entityId,
      configuredStatus: state.configuredStatus,
      effectiveStatus: state.effectiveStatus,
      presence: state.presence,
      budgetOrigin: state.budgetOrigin,
      fieldCoverage: state.fieldCoverage,
      stateHash: state.stateHash,
      delivery: state.delivery,
    },
  };
}

function tombstoneEvidence(
  tombstone: AdEntityTombstoneObservation,
): AdOperatorResponseEvidenceRef {
  return {
    kind: "meta_entity_tombstones",
    sourceId: tombstone.tombstoneId,
    role: "entity_tombstone",
    observedAt: tombstone.observedAt,
    capturedAt: tombstone.capturedAt,
    treatmentEligible: false,
    diagnosticCode: "explicit_tombstone_without_typed_receipt",
    payload: {
      runId: tombstone.runId,
      runHash: tombstone.runHash,
      runCompleteness: tombstone.runCompleteness,
      entityType: tombstone.entityType,
      entityId: tombstone.entityId,
      reason: tombstone.reason,
      providerEvidence: tombstone.providerEvidence,
      tombstoneHash: tombstone.tombstoneHash,
    },
  };
}

function addDiagnostic(
  diagnostics: AdOperatorResponseDiagnostic[],
  code: AdOperatorResponseDiagnosticCode,
  detail: string,
  evidenceId: string | null = null,
) {
  diagnostics.push({ code, evidenceId, detail });
}

function verifiedTimeFor(
  action: ExactMetaAdsActionLineage,
  windowEndTime: number,
  cutoffTime: number,
): number | null {
  const requested = maybeTimestamp(action.requestedAt);
  const verified = maybeTimestamp(action.verifiedAt);
  const finalized = maybeTimestamp(action.finalizedAt);
  const captured = maybeTimestamp(action.capturedAt);
  if (
    !action.providerVerified ||
    requested == null ||
    verified == null ||
    finalized == null ||
    captured == null ||
    verified < requested ||
    finalized < verified ||
    captured < finalized ||
    verified > windowEndTime ||
    finalized > windowEndTime ||
    captured > cutoffTime
  ) {
    return null;
  }
  return verified;
}

function budgetValues(
  state: AdEntityStateObservation,
  ownerType: "campaign" | "adset",
) {
  return ownerType === "campaign"
    ? [state.campaignDailyBudgetRaw, state.campaignLifetimeBudgetRaw]
    : [state.adsetDailyBudgetRaw, state.adsetLifetimeBudgetRaw];
}

function budgetChangeDirection(
  before: AdEntityStateObservation,
  after: AdEntityStateObservation,
  ownerType: "campaign" | "adset",
): "increase" | "decrease" | "mixed" | null {
  const beforeValues = budgetValues(before, ownerType);
  const afterValues = budgetValues(after, ownerType);
  const deltas = beforeValues.flatMap((beforeValue, index) => {
    const afterValue = afterValues[index];
    if (beforeValue == null || afterValue == null) return [];
    const beforeNumber = Number(beforeValue);
    const afterNumber = Number(afterValue);
    if (!Number.isFinite(beforeNumber) || !Number.isFinite(afterNumber)) return [];
    const delta = afterNumber - beforeNumber;
    return delta === 0 ? [] : [delta];
  });
  if (deltas.length === 0) return null;
  if (deltas.every((delta) => delta > 0)) return "increase";
  if (deltas.every((delta) => delta < 0)) return "decrease";
  return "mixed";
}

function candidateSignature(candidate: ResponseCandidate): string {
  return [
    candidate.responseType,
    candidate.successorAdId ?? "",
    candidate.budgetOwnerType ?? "",
    candidate.budgetOwnerId ?? "",
  ].join(":");
}

function canCollapseIdempotentCandidates(
  candidates: readonly ResponseCandidate[],
): boolean {
  if (candidates.length <= 1) return true;
  const signatures = new Set(candidates.map(candidateSignature));
  const idempotencyKeys = new Set(
    candidates.map((candidate) => candidate.action.idempotencyKey),
  );
  return (
    signatures.size === 1 &&
    idempotencyKeys.size === 1
  );
}

function uniqueEvidence(
  evidence: readonly AdOperatorResponseEvidenceRef[],
): AdOperatorResponseEvidenceRef[] {
  const byKey = new Map<string, AdOperatorResponseEvidenceRef>();
  for (const entry of evidence) {
    const key = `${entry.kind}\u0000${entry.sourceId}\u0000${entry.role}`;
    const current = byKey.get(key);
    if (!current || (!current.treatmentEligible && entry.treatmentEligible)) {
      byKey.set(key, entry);
    }
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.observedAt.localeCompare(right.observedAt) ||
      left.kind.localeCompare(right.kind) ||
      left.sourceId.localeCompare(right.sourceId) ||
      left.role.localeCompare(right.role),
  );
}

function uniqueDiagnostics(
  diagnostics: readonly AdOperatorResponseDiagnostic[],
): AdOperatorResponseDiagnostic[] {
  const byKey = new Map<string, AdOperatorResponseDiagnostic>();
  for (const diagnostic of diagnostics) {
    const key = `${diagnostic.code}\u0000${diagnostic.evidenceId ?? ""}\u0000${diagnostic.detail}`;
    byKey.set(key, diagnostic);
  }
  return [...byKey.values()].sort(
    (left, right) =>
      left.code.localeCompare(right.code) ||
      (left.evidenceId ?? "").localeCompare(right.evidenceId ?? "") ||
      left.detail.localeCompare(right.detail),
  );
}

function requiredStateTargets(episode: AdRecommendationEpisode): {
  targets: RequiredStateTarget[];
  missingHierarchy: boolean;
} {
  const targets: RequiredStateTarget[] = [
    { entityType: "ad", entityId: episode.adId },
  ];
  if (episode.sourceCampaignId) {
    targets.push({ entityType: "campaign", entityId: episode.sourceCampaignId });
  }
  if (episode.sourceAdsetId) {
    targets.push({ entityType: "adset", entityId: episode.sourceAdsetId });
  }
  return {
    targets,
    missingHierarchy: !episode.sourceCampaignId || !episode.sourceAdsetId,
  };
}

function buildSourceProof(input: {
  episode: AdRecommendationEpisode;
  actions: readonly ExactMetaAdsActionLineage[];
  states: readonly AdEntityStateObservation[];
  tombstones: readonly AdEntityTombstoneObservation[];
  sourceReads: AdOperatorResponseSourceReads;
  windowStart: string;
  windowEnd: string;
  windowEndTime: number;
  cutoffTime: number;
}): {
  proof: AdOperatorResponseSourceProof;
  coverageEvidence: AdOperatorResponseEvidenceRef[];
} {
  const requiredTargets = requiredStateTargets(input.episode);
  const coverageEvidence: AdOperatorResponseEvidenceRef[] = [];
  let completeStateTargetCount = 0;
  for (const target of requiredTargets.targets) {
    const targetStates = statesFor(
      input.states,
      target.entityType,
      target.entityId,
    );
    const targetTombstones = tombstonesFor(
      input.tombstones,
      target.entityType,
      target.entityId,
    );
    const baselineTruth = latestVisibleTruthAtOrBefore(
      targetStates,
      targetTombstones,
      timestamp(input.windowStart, "windowStart"),
    );
    const terminalTruthRow = terminalTruth(
      targetStates,
      targetTombstones,
      input.windowEndTime,
      input.cutoffTime,
    );
    const baseline =
      baselineTruth?.kind === "state" ? baselineTruth.value : undefined;
    const terminal =
      terminalTruthRow?.kind === "state" ? terminalTruthRow.value : undefined;
    if (baselineTruth?.kind === "tombstone") {
      coverageEvidence.push(tombstoneEvidence(baselineTruth.value));
    }
    if (terminalTruthRow?.kind === "tombstone") {
      coverageEvidence.push(tombstoneEvidence(terminalTruthRow.value));
    }
    if (baseline && isCompleteStateForTarget(baseline, target.entityType)) {
      coverageEvidence.push(stateEvidence(baseline, "window_start_state"));
    }
    if (terminal && isCompleteStateForTarget(terminal, target.entityType)) {
      coverageEvidence.push(stateEvidence(terminal, "window_end_state"));
    }
    if (
      baseline &&
      terminal &&
      isCompleteStateForTarget(baseline, target.entityType) &&
      isCompleteStateForTarget(terminal, target.entityType)
    ) {
      completeStateTargetCount += 1;
    }
  }
  const windowClosed = input.cutoffTime >= input.windowEndTime;
  const sourceComplete =
    windowClosed &&
    input.sourceReads.actionReceiptsComplete &&
    input.sourceReads.stateHistoryComplete &&
    input.sourceReads.tombstonesComplete &&
    !requiredTargets.missingHierarchy &&
    completeStateTargetCount === requiredTargets.targets.length;
  const sourceSetHash = canonicalSha256({
    contractVersion: NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION,
    episodeKey: input.episode.episodeKey,
    windowStart: input.windowStart,
    windowEnd: input.windowEnd,
    windowClosed,
    sourceReads: input.sourceReads,
    requiredTargets: requiredTargets.targets,
    missingHierarchy: requiredTargets.missingHierarchy,
    actions: input.actions
      .map((action) => ({ receiptId: action.receiptId, receiptHash: action.receiptHash }))
      .sort((left, right) => left.receiptId.localeCompare(right.receiptId)),
    states: input.states
      .map((state) => ({
        stateHistoryId: state.stateHistoryId,
        runId: state.runId,
        runHash: state.runHash,
        stateHash: state.stateHash,
        observedAt: state.observedAt,
        capturedAt: state.capturedAt,
        confirmedUntil: state.confirmedUntil ?? state.capturedAt,
      }))
      .sort((left, right) =>
        left.stateHistoryId.localeCompare(right.stateHistoryId),
      ),
    tombstones: input.tombstones
      .map((tombstone) => ({
        tombstoneId: tombstone.tombstoneId,
        runId: tombstone.runId,
        runHash: tombstone.runHash,
        tombstoneHash: tombstone.tombstoneHash,
        observedAt: tombstone.observedAt,
        capturedAt: tombstone.capturedAt,
        reason: tombstone.reason,
      }))
      .sort((left, right) =>
        left.tombstoneId.localeCompare(right.tombstoneId),
      ),
    completeStateTargetCount,
  });
  return {
    proof: {
      contractVersion: NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION,
      windowStart: input.windowStart,
      windowEnd: input.windowEnd,
      windowClosed,
      actionReceiptsComplete: input.sourceReads.actionReceiptsComplete,
      stateHistoryComplete: input.sourceReads.stateHistoryComplete,
      tombstonesComplete: input.sourceReads.tombstonesComplete,
      requiredStateTargetCount: requiredTargets.targets.length,
      completeStateTargetCount,
      actionReceiptCount: input.actions.length,
      stateObservationCount: input.states.length,
      tombstoneObservationCount: input.tombstones.length,
      sourceComplete,
      sourceSetHash,
    },
    coverageEvidence,
  };
}

function observationStatusFor(
  responseType: AdOperatorResponseType,
): AdOperatorResponseObservationStatus {
  if (
    responseType === "verified_pause" ||
    responseType === "verified_resume" ||
    responseType === "duplicate_successor" ||
    responseType === "rebuild_successor" ||
    responseType === "budget_owner_action_context"
  ) {
    return "observed_response";
  }
  if (
    responseType === "natural_spend_cessation" ||
    responseType === "no_response_observed"
  ) {
    return "observed_no_response";
  }
  return "unknown_incomplete";
}

function result(input: {
  episode: AdRecommendationEpisode;
  responseType: AdOperatorResponseType;
  detectedAt: string | null;
  actionReceiptId: string | null;
  actionLogId: string | null;
  successorAdId?: string | null;
  successorKind?: "duplicate" | "rebuild" | null;
  budgetOwnerType?: "campaign" | "adset" | null;
  budgetOwnerId?: string | null;
  sourceProof: AdOperatorResponseSourceProof;
  diagnostics: readonly AdOperatorResponseDiagnostic[];
  evidence: readonly AdOperatorResponseEvidenceRef[];
}): AdOperatorResponseResult {
  const observationStatus = observationStatusFor(input.responseType);
  const operatorResponseDetected = observationStatus === "observed_response";
  const adTreatmentDetected = [
    "verified_pause",
    "verified_resume",
    "duplicate_successor",
    "rebuild_successor",
  ].includes(input.responseType);
  const base = {
    contractVersion: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
    episodeKey: input.episode.episodeKey,
    observationStatus,
    responseType: input.responseType,
    operatorResponseDetected,
    adTreatmentDetected,
    detectedAt: input.detectedAt,
    actionReceiptId: input.actionReceiptId,
    actionLogId: input.actionLogId,
    successorAdId: input.successorAdId ?? null,
    successorKind: input.successorKind ?? null,
    budgetOwnerType: input.budgetOwnerType ?? null,
    budgetOwnerId: input.budgetOwnerId ?? null,
    sourceProof: input.sourceProof,
    diagnostics: uniqueDiagnostics(input.diagnostics),
    evidence: uniqueEvidence(input.evidence),
  };
  return { ...base, responseHash: canonicalSha256(base) };
}

function stateChanged(
  before: AdEntityStateObservation,
  after: AdEntityStateObservation,
): boolean {
  return (
    normalizeStatus(before.configuredStatus) !==
      normalizeStatus(after.configuredStatus) ||
    normalizeStatus(before.effectiveStatus) !==
      normalizeStatus(after.effectiveStatus)
  );
}

export function detectAdOperatorResponse(input: {
  episode: AdRecommendationEpisode;
  cutoff: string;
  actions: readonly ExactMetaAdsActionLineage[];
  states: readonly AdEntityStateObservation[];
  tombstones?: readonly AdEntityTombstoneObservation[];
  sourceReads?: AdOperatorResponseSourceReads;
  responseWindowDays?: number;
}): AdOperatorResponseResult {
  const expectedEpisodeKey = buildAdRecommendationEpisodeKey(input.episode);
  if (input.episode.episodeKey !== expectedEpisodeKey) {
    throw new TypeError("episodeKey does not match the exact episode identity.");
  }
  const window = resolveAdOperatorResponseWindow({
    recommendedAt: input.episode.recommendedAt,
    responseWindowDays: input.responseWindowDays,
  });
  const cutoffTime = timestamp(input.cutoff, "cutoff");
  if (cutoffTime < window.startTime) {
    throw new TypeError("cutoff must not precede the recommendation episode.");
  }
  const sourceReads = input.sourceReads ?? {
    actionReceiptsComplete: false,
    stateHistoryComplete: false,
    tombstonesComplete: false,
  };
  const diagnostics: AdOperatorResponseDiagnostic[] = [];
  const evidence: AdOperatorResponseEvidenceRef[] = [];
  const candidates: ResponseCandidate[] = [];
  let conflictingEvidence = false;
  let incompleteEvidence = false;

  const states = cutoffSafeStates({
    episode: input.episode,
    states: input.states,
    windowEndTime: window.endTime,
    cutoffTime,
  });
  const tombstones = cutoffSafeTombstones({
    episode: input.episode,
    tombstones: input.tombstones ?? [],
    windowEndTime: window.endTime,
    cutoffTime,
  });
  const source = buildSourceProof({
    episode: input.episode,
    actions: input.actions,
    states,
    tombstones,
    sourceReads,
    windowStart: window.start,
    windowEnd: window.end,
    windowEndTime: window.endTime,
    cutoffTime,
  });

  const exactActions: ExactMetaAdsActionLineage[] = [];
  for (const action of input.actions) {
    if (!receiptIntegrityValid(action)) {
      conflictingEvidence = true;
      addDiagnostic(
        diagnostics,
        "receipt_integrity_mismatch",
        "Typed action receipt hash or immutable finalization chronology did not validate.",
        action.receiptId,
      );
      continue;
    }
    if (!actionMatchesEpisode(action, input.episode)) {
      addDiagnostic(
        diagnostics,
        "ignored_action_lineage_mismatch",
        "Typed receipt did not match the exact business/account/ad/snapshot/evaluation/native-epoch lineage.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "ignored_action_lineage_mismatch",
        }),
      );
      continue;
    }
    if (
      !actionInsideWindow(
        action,
        window.startTime,
        window.endTime,
        cutoffTime,
      )
    ) {
      addDiagnostic(
        diagnostics,
        "ignored_action_outside_episode_window",
        "Receipt request/finalization was outside the exact attribution window or was not cutoff-visible.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "ignored_action_outside_episode_window",
        }),
      );
      continue;
    }
    exactActions.push(action);
  }

  for (const action of exactActions) {
    if (action.dryRun) {
      addDiagnostic(
        diagnostics,
        "dry_run_action_log",
        "Dry-run receipt is diagnostic only and cannot be treatment.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "dry_run_action_log",
        }),
      );
      continue;
    }
    if (action.status !== "success") {
      addDiagnostic(
        diagnostics,
        "failed_action_log",
        "Failed and silent-failure immutable receipts are diagnostic only.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "failed_action_log",
        }),
      );
      continue;
    }
    const verifiedTime = verifiedTimeFor(
      action,
      window.endTime,
      cutoffTime,
    );
    if (verifiedTime == null) {
      incompleteEvidence = true;
      addDiagnostic(
        diagnostics,
        "unverified_action_log",
        "Successful receipt lacked a cutoff-visible exact provider verification.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "unverified_action_log",
        }),
      );
      continue;
    }

    if (action.action === "pause" || action.action === "resume") {
      if (
        action.targetEntityType !== "ad" ||
        action.targetEntityId !== input.episode.adId ||
        action.verificationEntityId !== input.episode.adId ||
        normalizeStatus(action.verificationStatus) !==
          (action.action === "pause" ? "PAUSED" : "ACTIVE")
      ) {
        conflictingEvidence = true;
        addDiagnostic(
          diagnostics,
          "action_state_observation_conflict",
          "Provider verification did not identify the exact source ad and expected status.",
          action.receiptId,
        );
        evidence.push(
          actionEvidence(action, {
            treatmentEligible: false,
            diagnosticCode: "action_state_observation_conflict",
          }),
        );
        continue;
      }
      const adStates = statesFor(states, "ad", input.episode.adId);
      const adTombstones = tombstonesFor(
        tombstones,
        "ad",
        input.episode.adId,
      );
      const before = latestVisibleAtOrBefore(
        adStates,
        timestamp(action.requestedAt, "action.requestedAt"),
        adTombstones,
      );
      const after = firstObservedAtOrAfter(
        adStates,
        verifiedTime,
        adTombstones,
      );
      if (!before || !after) {
        incompleteEvidence = true;
        addDiagnostic(
          diagnostics,
          "action_state_observation_missing",
          "Exact pre/post ad state observations were not cutoff-visible.",
          action.receiptId,
        );
        evidence.push(
          actionEvidence(action, {
            treatmentEligible: false,
            diagnosticCode: "action_state_observation_missing",
          }),
        );
        continue;
      }
      if (
        !stateAllowsActionBefore(before, action.action) ||
        !stateConfirmsAction(after, action.action)
      ) {
        conflictingEvidence = true;
        addDiagnostic(
          diagnostics,
          "action_state_observation_conflict",
          "Cutoff-safe ad state history conflicted with the verified action transition.",
          action.receiptId,
        );
        evidence.push(
          actionEvidence(action, {
            treatmentEligible: false,
            diagnosticCode: "action_state_observation_conflict",
          }),
          stateEvidence(before, "pre_action_state"),
          stateEvidence(after, "post_action_state"),
        );
        continue;
      }
      candidates.push({
        responseType:
          action.action === "pause" ? "verified_pause" : "verified_resume",
        action,
        evidence: [
          actionEvidence(action, {
            treatmentEligible: true,
            diagnosticCode: null,
          }),
          stateEvidence(before, "pre_action_state"),
          stateEvidence(after, "post_action_state"),
        ],
        successorAdId: null,
        successorKind: null,
        budgetOwnerType: null,
        budgetOwnerId: null,
      });
      continue;
    }

    if (action.action === "duplicate" || action.action === "rebuild") {
      const expectedSuccessorKind =
        action.action === "rebuild" ? "rebuild" : "duplicate";
      const successorAdId = optional(action.resultingAdId);
      if (
        action.contractVersion !== NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION ||
        action.targetEntityType !== "ad" ||
        action.successorKind !== expectedSuccessorKind ||
        !successorAdId ||
        action.targetEntityId !== successorAdId ||
        action.verificationEntityId !== successorAdId
      ) {
        conflictingEvidence = true;
        addDiagnostic(
          diagnostics,
          "unverified_action_log",
          "Successor receipt lacked exact typed source-to-resulting-ad lineage.",
          action.receiptId,
        );
        evidence.push(
          actionEvidence(action, {
            treatmentEligible: false,
            diagnosticCode: "unverified_action_log",
          }),
        );
        continue;
      }
      const successorState = firstObservedAtOrAfter(
        statesFor(states, "ad", successorAdId),
        verifiedTime,
        tombstonesFor(tombstones, "ad", successorAdId),
      );
      const expectedSuccessorStatus = normalizeStatus(action.verificationStatus);
      if (
        !successorState ||
        successorState.presence !== "present" ||
        !expectedSuccessorStatus ||
        (normalizeStatus(successorState.configuredStatus) !==
          expectedSuccessorStatus &&
          normalizeStatus(successorState.effectiveStatus) !==
            expectedSuccessorStatus)
      ) {
        incompleteEvidence = true;
        addDiagnostic(
          diagnostics,
          "action_state_observation_missing",
          "Resulting ad was not exactly confirmed in cutoff-safe entity state history.",
          action.receiptId,
        );
        evidence.push(
          actionEvidence(action, {
            treatmentEligible: false,
            diagnosticCode: "action_state_observation_missing",
          }),
        );
        continue;
      }
      candidates.push({
        responseType:
          expectedSuccessorKind === "rebuild"
            ? "rebuild_successor"
            : "duplicate_successor",
        action,
        evidence: [
          actionEvidence(action, {
            treatmentEligible: true,
            diagnosticCode: null,
          }),
          stateEvidence(successorState, "successor_state"),
        ],
        successorAdId,
        successorKind: expectedSuccessorKind,
        budgetOwnerType: null,
        budgetOwnerId: null,
      });
      continue;
    }

    const ownerType = action.targetEntityType;
    if (ownerType !== "campaign" && ownerType !== "adset") continue;
    const sourceOwnerId =
      ownerType === "campaign"
        ? input.episode.sourceCampaignId
        : input.episode.sourceAdsetId;
    if (
      action.contractVersion !== NATIVE_AD_OPERATOR_LINEAGE_CONTRACT_VERSION ||
      !sourceOwnerId ||
      action.targetEntityId !== sourceOwnerId ||
      action.verificationEntityId !== sourceOwnerId
    ) {
      conflictingEvidence = true;
      addDiagnostic(
        diagnostics,
        "budget_owner_not_proven_by_source_decision",
        "Campaign/adset context did not match the immutable source evaluation hierarchy.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "budget_owner_not_proven_by_source_decision",
        }),
      );
      continue;
    }
    const ownerStates = statesFor(states, ownerType, sourceOwnerId);
    const ownerTombstones = tombstonesFor(
      tombstones,
      ownerType,
      sourceOwnerId,
    );
    const before = latestVisibleAtOrBefore(
      ownerStates,
      timestamp(action.requestedAt, "action.requestedAt"),
      ownerTombstones,
    );
    const after = firstObservedAtOrAfter(
      ownerStates,
      verifiedTime,
      ownerTombstones,
    );
    if (!before || !after) {
      incompleteEvidence = true;
      addDiagnostic(
        diagnostics,
        "budget_change_not_observed",
        "Exact owner state history did not prove a budget change after the linked action.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "budget_change_not_observed",
        }),
      );
      continue;
    }
    const direction = budgetChangeDirection(before, after, ownerType);
    if (direction == null) {
      incompleteEvidence = true;
      addDiagnostic(
        diagnostics,
        "budget_change_not_observed",
        "Comparable owner budget fields did not change after the linked action.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "budget_change_not_observed",
        }),
      );
      continue;
    }
    if (
      direction === "mixed" ||
      (action.action === "budget_increase" && direction !== "increase") ||
      (action.action === "budget_decrease" && direction !== "decrease")
    ) {
      conflictingEvidence = true;
      addDiagnostic(
        diagnostics,
        "budget_change_direction_conflict",
        "Observed owner budget direction conflicted with the typed receipt.",
        action.receiptId,
      );
      evidence.push(
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "budget_change_direction_conflict",
        }),
        stateEvidence(before, "budget_owner_state"),
        stateEvidence(after, "budget_owner_state"),
      );
      continue;
    }
    addDiagnostic(
      diagnostics,
      "budget_owner_action_is_context_only",
      "Verified campaign/adset budget ownership is context, never an ad treatment.",
      action.receiptId,
    );
    candidates.push({
      responseType: "budget_owner_action_context",
      action,
      evidence: [
        actionEvidence(action, {
          treatmentEligible: false,
          diagnosticCode: "budget_owner_action_is_context_only",
        }),
        stateEvidence(before, "budget_owner_state"),
        stateEvidence(after, "budget_owner_state"),
      ],
      successorAdId: null,
      successorKind: null,
      budgetOwnerType: ownerType,
      budgetOwnerId: sourceOwnerId,
    });
  }

  if (candidates.length > 0 && canCollapseIdempotentCandidates(candidates)) {
    const selected = [...candidates].sort((left, right) =>
      left.action.requestedAt.localeCompare(right.action.requestedAt),
    )[0] as ResponseCandidate;
    const sourceStates = statesFor(states, "ad", input.episode.adId);
    const sourceTombstones = tombstonesFor(
      tombstones,
      "ad",
      input.episode.adId,
    );
    const latestSourceTruth = latestObservedTruthAfter(
      sourceStates,
      sourceTombstones,
      timestamp(selected.action.verifiedAt ?? selected.action.requestedAt, "verifiedAt"),
    );
    const latestSourceState =
      latestSourceTruth?.kind === "state" ? latestSourceTruth.value : undefined;
    if (latestSourceTruth?.kind === "tombstone") {
      incompleteEvidence = true;
      addDiagnostic(
        diagnostics,
        "explicit_tombstone_without_typed_receipt",
        "A later explicit tombstone superseded state evidence without a matching typed action receipt.",
        latestSourceTruth.value.tombstoneId,
      );
      evidence.push(tombstoneEvidence(latestSourceTruth.value));
    }
    if (
      latestSourceState &&
      ((selected.responseType === "verified_pause" &&
        !stateConfirmsAction(latestSourceState, "pause")) ||
        (selected.responseType === "verified_resume" &&
          !stateConfirmsAction(latestSourceState, "resume")))
    ) {
      conflictingEvidence = true;
      addDiagnostic(
        diagnostics,
        "action_state_observation_conflict",
        "A later cutoff-safe ad state reversed the linked action without matching receipt lineage.",
        latestSourceState.stateHistoryId,
      );
      evidence.push(stateEvidence(latestSourceState, "post_action_state"));
    }
    if (!conflictingEvidence && !incompleteEvidence) {
      return result({
        episode: input.episode,
        responseType: selected.responseType,
        detectedAt: selected.action.verifiedAt,
        actionReceiptId: selected.action.receiptId,
        actionLogId: selected.action.actionLogId,
        successorAdId: selected.successorAdId,
        successorKind: selected.successorKind,
        budgetOwnerType: selected.budgetOwnerType,
        budgetOwnerId: selected.budgetOwnerId,
        sourceProof: source.proof,
        diagnostics,
        evidence: [...evidence, ...selected.evidence],
      });
    }
  } else if (candidates.length > 1) {
    conflictingEvidence = true;
    addDiagnostic(
      diagnostics,
      "multiple_verified_responses",
      "Multiple non-idempotent verified response receipts matched one exact episode.",
    );
    evidence.push(...candidates.flatMap((candidate) => candidate.evidence));
  }

  const requiredTargets = requiredStateTargets(input.episode).targets;
  for (const target of requiredTargets) {
    const targetStates = statesFor(states, target.entityType, target.entityId);
    const targetTombstones = tombstonesFor(
      tombstones,
      target.entityType,
      target.entityId,
    );
    const baselineState = latestVisibleAtOrBefore(
      targetStates,
      window.startTime,
      targetTombstones,
    );
    const latestTruth = latestObservedTruthAfter(
      targetStates,
      targetTombstones,
      window.startTime,
    );
    if (latestTruth?.kind === "tombstone") {
      conflictingEvidence = true;
      addDiagnostic(
        diagnostics,
        "explicit_tombstone_without_typed_receipt",
        "An explicit entity tombstone superseded prior state without exact typed receipt lineage.",
        latestTruth.value.tombstoneId,
      );
      evidence.push(tombstoneEvidence(latestTruth.value));
      continue;
    }
    const latestState = latestTruth?.value;
    if (!baselineState || !latestState) continue;
    const hierarchyBudgetChanged =
      target.entityType !== "ad" &&
      budgetChangeDirection(baselineState, latestState, target.entityType) != null;
    if (target.entityType === "ad" && stateChanged(baselineState, latestState)) {
      conflictingEvidence = true;
      addDiagnostic(
        diagnostics,
        "unlogged_ad_status_change",
        "Exact ad status changed without one verified typed receipt for this episode.",
        latestState.stateHistoryId,
      );
      evidence.push(
        stateEvidence(baselineState, "pre_action_state"),
        stateEvidence(latestState, "post_action_state"),
      );
    } else if (
      target.entityType !== "ad" &&
      (stateChanged(baselineState, latestState) || hierarchyBudgetChanged)
    ) {
      conflictingEvidence = true;
      addDiagnostic(
        diagnostics,
        "unlogged_hierarchy_change",
        "Source campaign/adset status or budget changed without exact typed receipt lineage.",
        latestState.stateHistoryId,
      );
      evidence.push(
        stateEvidence(baselineState, "budget_owner_state"),
        stateEvidence(latestState, "budget_owner_state"),
      );
    }
  }

  if (conflictingEvidence) {
    return result({
      episode: input.episode,
      responseType: "ambiguous_conflicting",
      detectedAt: null,
      actionReceiptId: null,
      actionLogId: null,
      sourceProof: source.proof,
      diagnostics,
      evidence,
    });
  }

  if (incompleteEvidence) {
    return result({
      episode: input.episode,
      responseType: "unknown_incomplete",
      detectedAt: null,
      actionReceiptId: null,
      actionLogId: null,
      sourceProof: source.proof,
      diagnostics,
      evidence: [...evidence, ...source.coverageEvidence],
    });
  }

  const sourceStates = statesFor(states, "ad", input.episode.adId);
  const sourceTombstones = tombstonesFor(
    tombstones,
    "ad",
    input.episode.adId,
  );
  const baselineState = latestVisibleAtOrBefore(
    sourceStates,
    window.startTime,
    sourceTombstones,
  );
  const deliveryState = [...sourceStates]
    .reverse()
    .find(
      (state) =>
        timestamp(state.observedAt, "observedAt") > window.startTime &&
        state.delivery?.contractVersion ===
          NATIVE_AD_DELIVERY_OBSERVATION_CONTRACT_VERSION &&
        maybeTimestamp(state.delivery.windowStart) != null &&
        maybeTimestamp(state.delivery.windowEnd) != null &&
        (maybeTimestamp(state.delivery.windowStart) as number) > window.startTime &&
        (maybeTimestamp(state.delivery.windowEnd) as number) >
          (maybeTimestamp(state.delivery.windowStart) as number) &&
        (maybeTimestamp(state.delivery.windowEnd) as number) <= window.endTime &&
        timestamp(state.capturedAt, "capturedAt") <= cutoffTime,
    );
  if (
    baselineState &&
    deliveryState &&
    isActiveState(baselineState) &&
    isActiveState(deliveryState) &&
    deliveryState.delivery?.currentWindowSpend === 0
  ) {
    if (
      deliveryState.delivery.priorWindowSpend != null &&
      Number.isFinite(deliveryState.delivery.priorWindowSpend) &&
      deliveryState.delivery.priorWindowSpend > 0
    ) {
      addDiagnostic(
        diagnostics,
        "natural_spend_cessation_is_not_treatment",
        "Spend ceased while the exact ad remained active and no linked treatment receipt existed.",
        deliveryState.stateHistoryId,
      );
      return result({
        episode: input.episode,
        responseType: "natural_spend_cessation",
        detectedAt: deliveryState.delivery.windowEnd,
        actionReceiptId: null,
        actionLogId: null,
        sourceProof: source.proof,
        diagnostics,
        evidence: [
          ...evidence,
          stateEvidence(deliveryState, "delivery_cessation_state"),
        ],
      });
    }
    addDiagnostic(
      diagnostics,
      "zero_spend_without_positive_baseline",
      "Zero spend alone does not prove cessation or operator response.",
      deliveryState.stateHistoryId,
    );
    evidence.push(stateEvidence(deliveryState, "delivery_cessation_state"));
  }

  if (source.proof.sourceComplete) {
    addDiagnostic(
      diagnostics,
      "complete_window_no_typed_response",
      "The closed attribution window has complete typed-receipt and state-history coverage with no observed response.",
    );
    return result({
      episode: input.episode,
      responseType: "no_response_observed",
      detectedAt: null,
      actionReceiptId: null,
      actionLogId: null,
      sourceProof: source.proof,
      diagnostics,
      evidence: [...evidence, ...source.coverageEvidence],
    });
  }

  if (!source.proof.windowClosed) {
    addDiagnostic(
      diagnostics,
      "attribution_window_open",
      "The attribution window is still open; absence cannot be classified as no response.",
    );
  }
  if (
    !source.proof.actionReceiptsComplete ||
    !source.proof.stateHistoryComplete ||
    !source.proof.tombstonesComplete
  ) {
    addDiagnostic(
      diagnostics,
      "source_read_incomplete",
      "At least one typed source read did not carry a complete query receipt.",
    );
  }
  if (
    source.proof.completeStateTargetCount !==
    source.proof.requiredStateTargetCount
  ) {
    addDiagnostic(
      diagnostics,
      "state_coverage_incomplete",
      "Complete start/end state coverage was unavailable for every exact ad/campaign/adset target.",
    );
  }
  return result({
    episode: input.episode,
    responseType: "unknown_incomplete",
    detectedAt: null,
    actionReceiptId: null,
    actionLogId: null,
    sourceProof: source.proof,
    diagnostics,
    evidence: [...evidence, ...source.coverageEvidence],
  });
}
