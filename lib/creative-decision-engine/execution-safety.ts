import type { MetaAutomationReadiness } from "@/lib/meta/automation-readiness";
import { resolveCampaignRoleStatus } from "@/lib/creative-decision-engine/campaign-label-guard";
import {
  NATIVE_AD_ENGINE_VERSION,
  type DecisionLabel,
  type DecisionOutput,
} from "./types";

export type CreativeExecutableAction = Extract<
  DecisionLabel,
  "scale" | "cut" | "refresh"
>;

export type CreativeExecutionSafetyBlocker =
  | "unsupported_action"
  | "creative_id_drift"
  | "label_drift"
  | "engine_version_drift"
  | "truth_source_drift"
  | "target_roas_drift"
  | "ratio_to_target_drift"
  | "recent_hold_drift"
  | "campaign_kind_drift"
  | "campaign_role_status_drift"
  /** @deprecated pre-D074b alias kept so persisted receipts deserialize. */
  | "campaign_label_status_drift"
  | "decision_kind_source_drift"
  | "label_transform_drift"
  | "blocked_action_drift"
  | "confidence_regressed"
  | "decision_stale"
  | "missing_idempotency_key"
  | "idempotency_key_mismatch"
  | "base_readiness_not_auto_eligible"
  | "preflight_failed"
  | "rollback_unavailable"
  | "post_action_monitor_missing"
  | "missing_prior_status"
  | "missing_prior_budget"
  | "missing_created_entity_snapshot";

export interface CreativeMutationPreflightResult {
  ok: boolean;
  blockers: CreativeExecutionSafetyBlocker[];
  drift: string[];
  currentDecisionAgeHours: number | null;
  currentDecisionAgeStatus: "fresh" | "stale" | "unparseable_timestamp";
}

export interface CreativeRollbackBeforeState {
  effectiveStatus?: string | null;
  budgetAmount?: number | null;
  budgetOwnerId?: string | null;
  createdEntityIds?: readonly string[];
}

export interface CreativeRollbackPlan {
  ok: boolean;
  action: CreativeExecutableAction;
  blockers: CreativeExecutionSafetyBlocker[];
  restoreSteps: string[];
  beforeState: CreativeRollbackBeforeState;
}

export interface CreativePostActionMonitorPlan {
  action: CreativeExecutableAction;
  businessId: string;
  creativeId: string;
  actionIdempotencyKey: string;
  startDate: string;
  outcomeWindowsDays: number[];
  metricChecks: string[];
}

export interface CreativeExecutionReadinessResult {
  ok: boolean;
  blockers: CreativeExecutionSafetyBlocker[];
  readinessBlockers: MetaAutomationReadiness["blockers"];
}

export const DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION =
  "meta-decision-origin-ad-execution.v1" as const;

/**
 * The one decision-age ceiling shared by presentation authority and the
 * mutation preflight. Keeping this exported prevents a screen from offering
 * an action under a looser clock than the write boundary will accept.
 */
export const DECISION_ORIGIN_AD_MAX_AGE_HOURS = 12;

export type DecisionOriginAdDecisionFreshnessStatus =
  | "fresh"
  | "stale"
  | "future"
  | "unavailable";

export interface DecisionOriginAdDecisionFreshness {
  status: DecisionOriginAdDecisionFreshnessStatus;
  computedAt: string | null;
  ageHours: number | null;
  maxAgeHours: number;
}

export type DecisionOriginAdAction = "pause" | "resume";

export type DecisionOriginAdExecutionBlocker =
  | "missing_business_id"
  | "missing_provider_account_id"
  | "missing_ad_id"
  | "invalid_ad_id"
  | "missing_snapshot_id"
  | "missing_evaluation_id"
  | "missing_engine_version"
  | "missing_decision_hash"
  | "invalid_decision_hash"
  | "missing_creative_id"
  | "idempotency_key_required"
  | "idempotency_key_mismatch"
  | "invalid_dry_run"
  | "unsupported_action"
  | "kill_switch_state_unavailable"
  | "kill_switch_engaged"
  | "source_pipeline_unready"
  | "meta_account_unresolved"
  | "provider_account_mismatch"
  | "ad_not_found"
  | "ad_identity_mismatch"
  | "current_hierarchy_state_unverified"
  | "current_hierarchy_identity_mismatch"
  | "current_hierarchy_state_incompatible"
  | "current_ad_state_unverified"
  | "current_ad_state_rejected"
  | "current_ad_state_stale"
  | "source_decision_not_found"
  | "source_decision_lineage_mismatch"
  | "engine_version_drift"
  | "decision_hash_mismatch"
  | "decision_stale"
  | "action_not_authorized"
  | "policy_state_unverified"
  | "policy_blocked"
  | "ad_status_incompatible"
  | "idempotency_conflict"
  | "verification_timestamp_missing"
  | "verification_ad_mismatch"
  | "verification_provider_account_mismatch"
  | "verification_creative_mismatch"
  | "verification_campaign_mismatch"
  | "verification_adset_mismatch"
  | "verification_action_mismatch";

/**
 * The execution identity is ad-owned. creativeId does not resolve the target,
 * but exact source/request/live creative equality is mandatory defense-in-depth
 * before mutating that Ad.
 */
export interface DecisionOriginAdExecutionRequest {
  contractVersion: typeof DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION;
  businessId: string;
  providerAccountId: string;
  adId: string;
  snapshotId: string;
  evaluationId: string;
  engineVersion: string;
  decisionHash: string;
  action: string;
  idempotencyKey: string;
  creativeId: string;
  dryRun?: boolean;
}

export interface DecisionOriginCurrentAccountEvidence {
  found: boolean;
  businessId: string | null;
  providerAccountId: string | null;
  writable: boolean;
}

export interface DecisionOriginCurrentAdEvidence {
  found: boolean;
  businessId: string | null;
  providerAccountId: string | null;
  adId: string | null;
  creativeId?: string | null;
  campaignId: string | null;
  campaignConfiguredStatus: string | null;
  campaignEffectiveStatus: string | null;
  adsetId: string | null;
  adsetConfiguredStatus: string | null;
  adsetEffectiveStatus: string | null;
  configuredStatus: string | null;
  effectiveStatus: string | null;
  policyEligible: boolean | null;
  reviewStatus: string | null;
  observedAt: string | null;
  readBlocker?: Extract<
    DecisionOriginAdExecutionBlocker,
    | "ad_not_found"
    | "ad_identity_mismatch"
    | "current_ad_state_unverified"
    | "current_ad_state_rejected"
    | "meta_account_unresolved"
    | "provider_account_mismatch"
  > | null;
}

export interface DecisionOriginSourceDecisionEvidence {
  found: boolean;
  businessId: string | null;
  providerAccountId: string | null;
  decisionEntityType: string | null;
  decisionEntityId: string | null;
  adId: string | null;
  campaignId: string | null;
  adsetId: string | null;
  creativeId: string | null;
  snapshotId: string | null;
  evaluationId: string | null;
  engineVersion: string | null;
  decisionHash: string | null;
  decisionLabel: string | null;
  blockedActionType?: string | null;
  explicitAuthorizedAction?: DecisionOriginAdAction | null;
  computedAt: string | null;
}

export interface DecisionOriginIdempotencyReceipt {
  actionLogId: string;
  businessId: string;
  providerAccountId: string | null;
  adId: string;
  creativeId: string | null;
  snapshotId: string | null;
  evaluationId: string | null;
  engineVersion: string | null;
  decisionHash: string | null;
  action: string;
  idempotencyKey: string;
  status: string;
  dryRun: boolean;
  providerVerified: boolean;
  treatmentEligible: boolean;
  errorCode?: string | null;
  reconciliationRequired?: boolean;
  retryAllowed?: boolean | null;
  reconciliationOutcome?: string | null;
  providerMutationAttempted?: boolean | null;
  providerMutationSucceeded?: boolean | null;
  providerOutcomeAmbiguous?: boolean | null;
}

export interface DecisionOriginAdExecutionEvidence {
  killSwitch: {
    verified: boolean;
    engaged: boolean;
  };
  pipeline: {
    verified: boolean;
    executionReady: boolean;
  };
  currentAccount: DecisionOriginCurrentAccountEvidence;
  currentAd: DecisionOriginCurrentAdEvidence;
  sourceDecision: DecisionOriginSourceDecisionEvidence;
  idempotencyReceipt: DecisionOriginIdempotencyReceipt | null;
}

export interface DecisionOriginAdExecutionPreflightResult {
  ok: boolean;
  disposition: "proceed" | "duplicate" | "reject";
  shouldMutate: boolean;
  blockers: DecisionOriginAdExecutionBlocker[];
  errorCode: DecisionOriginAdExecutionBlocker | null;
  duplicateReceipt: DecisionOriginIdempotencyReceipt | null;
  decisionAgeHours: number | null;
  currentAdStateAgeMinutes: number | null;
}

export interface DecisionOriginProviderVerificationResult {
  providerVerified: boolean;
  treatmentEligible: boolean;
  blockers: DecisionOriginAdExecutionBlocker[];
  verificationAdId: string | null;
  verificationProviderAccountId: string | null;
  verificationCreativeId: string | null;
  verificationCampaignId: string | null;
  verificationAdsetId: string | null;
  verificationStatus: string | null;
  expectedStatus: "ACTIVE" | "PAUSED" | null;
}

export interface DecisionOriginProviderVerificationLineage {
  providerAccountId: string;
  creativeId: string;
  campaignId: string;
  adsetId: string;
}

const HARD_ACTIONS = new Set<DecisionLabel>(["scale", "cut", "refresh"]);
const DECISION_HASH_PATTERN = /^[a-f0-9]{64}$/;
const META_PROVIDER_ENTITY_ID_PATTERN = /^\d+$/;

function normalizedPart(value: string | number | null | undefined): string {
  const raw = value == null || value === "" ? "unknown" : String(value);
  return raw.replace(/[^a-zA-Z0-9_.-]+/g, "_");
}

export function isExactMetaProviderEntityId(value: unknown): value is string {
  return (
    typeof value === "string" &&
    META_PROVIDER_ENTITY_ID_PATTERN.test(value.trim())
  );
}

function unique<T extends string>(values: readonly T[]): T[] {
  return Array.from(new Set(values));
}

function trimmed(value: string | null | undefined): string {
  return value?.trim() ?? "";
}

function upper(value: string | null | undefined): string {
  return trimmed(value).toUpperCase();
}

function ageHours(generatedAt: string, now: Date): number | null {
  const generated = new Date(generatedAt);
  if (!Number.isFinite(generated.getTime())) return null;
  return (now.getTime() - generated.getTime()) / (60 * 60 * 1000);
}

/**
 * Evaluate the deterministic decision-age subset of the exact-Ad execution
 * preflight. Future timestamps beyond the existing one-minute skew tolerance
 * and unreadable timestamps fail closed just like an old decision.
 */
export function evaluateDecisionOriginAdDecisionFreshness(input: {
  computedAt: string | null | undefined;
  now?: Date;
  maxAgeHours?: number;
}): DecisionOriginAdDecisionFreshness {
  const computedAt = trimmed(input.computedAt) || null;
  const now = input.now ?? new Date();
  const configuredMaximum = input.maxAgeHours;
  const maxAgeHours =
    configuredMaximum === undefined
      ? DECISION_ORIGIN_AD_MAX_AGE_HOURS
      : typeof configuredMaximum === "number" &&
          Number.isFinite(configuredMaximum) &&
          configuredMaximum >= 0
        ? configuredMaximum
        : 0;
  const age =
    computedAt && Number.isFinite(now.getTime())
      ? ageHours(computedAt, now)
      : null;
  const status: DecisionOriginAdDecisionFreshnessStatus =
    age === null
      ? "unavailable"
      : age < -(1 / 60)
        ? "future"
        : age > maxAgeHours
          ? "stale"
          : "fresh";
  return {
    status,
    computedAt,
    ageHours: age,
    maxAgeHours,
  };
}

function ageMinutes(observedAt: string, now: Date): number | null {
  const observed = new Date(observedAt);
  if (!Number.isFinite(observed.getTime())) return null;
  return (now.getTime() - observed.getTime()) / (60 * 1000);
}

function requestContractBlockers(
  input: DecisionOriginAdExecutionRequest,
): DecisionOriginAdExecutionBlocker[] {
  const blockers: DecisionOriginAdExecutionBlocker[] = [];
  if (!trimmed(input.businessId)) blockers.push("missing_business_id");
  if (!trimmed(input.providerAccountId)) {
    blockers.push("missing_provider_account_id");
  }
  if (!trimmed(input.adId)) {
    blockers.push("missing_ad_id");
  } else if (!isExactMetaProviderEntityId(input.adId)) {
    blockers.push("invalid_ad_id");
  }
  if (!trimmed(input.snapshotId)) blockers.push("missing_snapshot_id");
  if (!trimmed(input.evaluationId)) blockers.push("missing_evaluation_id");
  if (!trimmed(input.engineVersion)) blockers.push("missing_engine_version");
  if (!trimmed(input.creativeId)) blockers.push("missing_creative_id");
  if (!trimmed(input.decisionHash)) {
    blockers.push("missing_decision_hash");
  } else if (!DECISION_HASH_PATTERN.test(trimmed(input.decisionHash))) {
    blockers.push("invalid_decision_hash");
  }
  if (!trimmed(input.idempotencyKey)) {
    blockers.push("idempotency_key_required");
  }
  if (
    input.dryRun !== undefined &&
    typeof input.dryRun !== "boolean"
  ) {
    blockers.push("invalid_dry_run");
  }
  if (input.action !== "pause" && input.action !== "resume") {
    blockers.push("unsupported_action");
  }
  const exactTupleComplete =
    trimmed(input.businessId) !== "" &&
    trimmed(input.providerAccountId) !== "" &&
    isExactMetaProviderEntityId(input.adId) &&
    trimmed(input.snapshotId) !== "" &&
    trimmed(input.evaluationId) !== "" &&
    trimmed(input.engineVersion) !== "" &&
    DECISION_HASH_PATTERN.test(trimmed(input.decisionHash)) &&
    trimmed(input.creativeId) !== "" &&
    (input.action === "pause" || input.action === "resume");
  if (
    exactTupleComplete &&
    trimmed(input.idempotencyKey) !== "" &&
    trimmed(input.idempotencyKey) !==
      createDecisionOriginAdActionIdempotencyKey(input)
  ) {
    blockers.push("idempotency_key_mismatch");
  }
  return unique(blockers);
}

function receiptMatchesRequest(
  receipt: DecisionOriginIdempotencyReceipt,
  request: DecisionOriginAdExecutionRequest,
): boolean {
  return (
    receipt.businessId === trimmed(request.businessId) &&
    receipt.providerAccountId === trimmed(request.providerAccountId) &&
    receipt.adId === trimmed(request.adId) &&
    receipt.creativeId === trimmed(request.creativeId) &&
    receipt.snapshotId === trimmed(request.snapshotId) &&
    receipt.evaluationId === trimmed(request.evaluationId) &&
    receipt.engineVersion === trimmed(request.engineVersion) &&
    receipt.decisionHash === trimmed(request.decisionHash) &&
    receipt.action === request.action &&
    receipt.idempotencyKey === trimmed(request.idempotencyKey) &&
    receipt.dryRun === (request.dryRun === true)
  );
}

function rejectedDecisionOriginPreflight(input: {
  blockers: readonly DecisionOriginAdExecutionBlocker[];
  decisionAgeHours?: number | null;
  currentAdStateAgeMinutes?: number | null;
}): DecisionOriginAdExecutionPreflightResult {
  const blockers = unique(input.blockers);
  return {
    ok: false,
    disposition: "reject",
    shouldMutate: false,
    blockers,
    errorCode: blockers[0] ?? null,
    duplicateReceipt: null,
    decisionAgeHours: input.decisionAgeHours ?? null,
    currentAdStateAgeMinutes: input.currentAdStateAgeMinutes ?? null,
  };
}

function sameNullable(left: unknown, right: unknown): boolean {
  return (left ?? null) === (right ?? null);
}

function materialNumericDrift(
  left: number | null | undefined,
  right: number | null | undefined,
  tolerance: number,
): boolean {
  const normalizedLeft = left ?? null;
  const normalizedRight = right ?? null;
  if (normalizedLeft === null || normalizedRight === null) {
    return normalizedLeft !== normalizedRight;
  }
  if (!Number.isFinite(normalizedLeft) || !Number.isFinite(normalizedRight)) {
    return normalizedLeft !== normalizedRight;
  }
  return Math.abs(normalizedLeft - normalizedRight) > tolerance;
}

function recentHoldRatio(decision: DecisionOutput): number | null {
  const recentRoas = decision.metrics.recent7dRoas;
  const targetRoas = decision.effectiveTargetRoas;
  if (
    typeof recentRoas !== "number" ||
    !Number.isFinite(recentRoas) ||
    targetRoas <= 0 ||
    !Number.isFinite(targetRoas)
  ) {
    return null;
  }
  return recentRoas / targetRoas;
}

function metricChecksFor(action: CreativeExecutableAction): string[] {
  // P2 scaffold only. Before an executor consumes this plan, convert these
  // tokens to typed checks with metric names, predicates, and fail severities.
  if (action === "scale") {
    return [
      "spend_change_after_action",
      "roas_or_cpa_hold_after_scale",
      "purchase_volume_after_scale",
    ];
  }
  if (action === "cut") {
    return [
      "delivery_status_after_cut",
      "spend_leak_after_cut",
      "replacement_capacity_after_cut",
    ];
  }
  return [
    "new_test_delivery_after_refresh",
    "new_variant_delivery_after_refresh",
    "ctr_cvr_roas_after_refresh",
  ];
}

export function isCreativeExecutableAction(
  label: DecisionLabel,
): label is CreativeExecutableAction {
  return HARD_ACTIONS.has(label);
}

export function validateDecisionOriginAdExecutionRequest(
  input: DecisionOriginAdExecutionRequest,
): DecisionOriginAdExecutionBlocker[] {
  return requestContractBlockers(input);
}

export function createDecisionOriginAdActionIdempotencyKey(input: {
  businessId: string;
  providerAccountId: string;
  adId: string;
  snapshotId: string;
  evaluationId: string;
  engineVersion: string;
  decisionHash: string;
  action: string;
  dryRun?: boolean;
}): string {
  return [
    "decision-ad-action",
    normalizedPart(input.businessId),
    normalizedPart(input.providerAccountId),
    normalizedPart(input.adId),
    normalizedPart(input.action),
    normalizedPart(input.snapshotId),
    normalizedPart(input.evaluationId),
    normalizedPart(input.engineVersion),
    normalizedPart(input.decisionHash),
    input.dryRun === true ? "dry-run" : "execute",
  ].join(":");
}

export function evaluateDecisionOriginAdExecutionPreflight(input: {
  request: DecisionOriginAdExecutionRequest;
  evidence: DecisionOriginAdExecutionEvidence;
  now?: Date;
  maxDecisionAgeHours?: number;
  maxCurrentAdStateAgeMinutes?: number;
  requiredEngineVersion?: string;
}): DecisionOriginAdExecutionPreflightResult {
  const requestBlockers = requestContractBlockers(input.request);
  if (requestBlockers.length > 0) {
    return rejectedDecisionOriginPreflight({ blockers: requestBlockers });
  }

  const request = {
    ...input.request,
    businessId: trimmed(input.request.businessId),
    providerAccountId: trimmed(input.request.providerAccountId),
    adId: trimmed(input.request.adId),
    snapshotId: trimmed(input.request.snapshotId),
    evaluationId: trimmed(input.request.evaluationId),
    engineVersion: trimmed(input.request.engineVersion),
    decisionHash: trimmed(input.request.decisionHash),
    idempotencyKey: trimmed(input.request.idempotencyKey),
    creativeId: trimmed(input.request.creativeId),
  };
  const existingReceipt = input.evidence.idempotencyReceipt;
  if (existingReceipt) {
    if (!receiptMatchesRequest(existingReceipt, request)) {
      return rejectedDecisionOriginPreflight({
        blockers: ["idempotency_conflict"],
      });
    }
    return {
      ok: true,
      disposition: "duplicate",
      shouldMutate: false,
      blockers: [],
      errorCode: null,
      duplicateReceipt: existingReceipt,
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    };
  }

  const blockers: DecisionOriginAdExecutionBlocker[] = [];
  const now = input.now ?? new Date();
  const maxDecisionAgeHours =
    input.maxDecisionAgeHours ?? DECISION_ORIGIN_AD_MAX_AGE_HOURS;
  const maxCurrentAdStateAgeMinutes =
    input.maxCurrentAdStateAgeMinutes ?? 5;
  const requiredEngineVersion =
    input.requiredEngineVersion ?? NATIVE_AD_ENGINE_VERSION;

  if (request.engineVersion !== requiredEngineVersion) {
    blockers.push("engine_version_drift");
  }

  if (!input.evidence.killSwitch.verified) {
    blockers.push("kill_switch_state_unavailable");
  } else if (input.evidence.killSwitch.engaged) {
    blockers.push("kill_switch_engaged");
  }

  if (
    !input.evidence.pipeline.verified ||
    !input.evidence.pipeline.executionReady
  ) {
    blockers.push("source_pipeline_unready");
  }

  const account = input.evidence.currentAccount;
  if (!account.found || !account.writable) {
    blockers.push("meta_account_unresolved");
  } else if (
    account.businessId !== request.businessId ||
    account.providerAccountId !== request.providerAccountId
  ) {
    blockers.push("provider_account_mismatch");
  }

  const currentAd = input.evidence.currentAd;
  const currentAdReadBlocker = currentAd.readBlocker ?? null;
  if (currentAdReadBlocker) {
    blockers.push(currentAdReadBlocker);
  } else {
    if (!currentAd.found) {
      blockers.push("ad_not_found");
    } else {
      if (currentAd.businessId !== request.businessId) {
        blockers.push("ad_identity_mismatch");
      }
      if (currentAd.providerAccountId !== request.providerAccountId) {
        blockers.push("provider_account_mismatch");
      }
      if (currentAd.adId !== request.adId) {
        blockers.push("ad_identity_mismatch");
      }
      if (
        request.creativeId &&
        currentAd.creativeId !== request.creativeId
      ) {
        blockers.push("ad_identity_mismatch");
      }
    }
  }

  const currentAdStateAgeMinutes = !currentAdReadBlocker && currentAd.observedAt
    ? ageMinutes(currentAd.observedAt, now)
    : null;
  if (!currentAdReadBlocker) {
    if (currentAdStateAgeMinutes === null) {
      blockers.push("current_ad_state_unverified");
    } else if (
      currentAdStateAgeMinutes < -1 ||
      currentAdStateAgeMinutes > maxCurrentAdStateAgeMinutes
    ) {
      blockers.push("current_ad_state_stale");
    }
  }

  const source = input.evidence.sourceDecision;
  if (!source.found) {
    blockers.push("source_decision_not_found");
  } else {
    if (
      source.businessId !== request.businessId ||
      source.providerAccountId !== request.providerAccountId ||
      source.decisionEntityType !== "ad" ||
      source.decisionEntityId !== request.adId ||
      source.adId !== request.adId ||
      (request.creativeId != null &&
        source.creativeId !== request.creativeId) ||
      source.snapshotId !== request.snapshotId ||
      source.evaluationId !== request.evaluationId
    ) {
      blockers.push("source_decision_lineage_mismatch");
    }
    if (
      source.creativeId &&
      currentAd.found &&
      !currentAdReadBlocker &&
      currentAd.creativeId !== source.creativeId
    ) {
      blockers.push("ad_identity_mismatch");
    }
    if (source.engineVersion !== request.engineVersion) {
      blockers.push("engine_version_drift");
    }
    if (source.decisionHash !== request.decisionHash) {
      blockers.push("decision_hash_mismatch");
    }
  }

  const decisionFreshness = evaluateDecisionOriginAdDecisionFreshness({
    computedAt: source.computedAt,
    now,
    maxAgeHours: maxDecisionAgeHours,
  });
  const decisionAgeHours = decisionFreshness.ageHours;
  if (decisionFreshness.status !== "fresh") {
    blockers.push("decision_stale");
  }

  if (request.action === "pause") {
    if (
      source.decisionLabel !== "cut" ||
      source.blockedActionType != null ||
      source.explicitAuthorizedAction !== "pause"
    ) {
      blockers.push("action_not_authorized");
    }
  } else if (request.action === "resume") {
    if (
      source.decisionLabel !== "scale" ||
      source.blockedActionType != null ||
      source.explicitAuthorizedAction !== "resume"
    ) {
      blockers.push("action_not_authorized");
    }
  }

  if (!currentAdReadBlocker) {
    if (currentAd.policyEligible === null) {
      blockers.push("policy_state_unverified");
    } else if (!currentAd.policyEligible) {
      blockers.push("policy_blocked");
    }

    const configuredStatus = upper(currentAd.configuredStatus);
    const effectiveStatus = upper(currentAd.effectiveStatus);
    const campaignConfiguredStatus = upper(
      currentAd.campaignConfiguredStatus,
    );
    const campaignEffectiveStatus = upper(currentAd.campaignEffectiveStatus);
    const adsetConfiguredStatus = upper(currentAd.adsetConfiguredStatus);
    const adsetEffectiveStatus = upper(currentAd.adsetEffectiveStatus);
    const sourceCampaignId = trimmed(source.campaignId);
    const sourceAdsetId = trimmed(source.adsetId);
    const currentCampaignId = trimmed(currentAd.campaignId);
    const currentAdsetId = trimmed(currentAd.adsetId);
    const hierarchyStateUnverified =
      !sourceCampaignId ||
      !sourceAdsetId ||
      !currentCampaignId ||
      !currentAdsetId ||
      !campaignConfiguredStatus ||
      !campaignEffectiveStatus ||
      !adsetConfiguredStatus ||
      !adsetEffectiveStatus;
    if (hierarchyStateUnverified) {
      blockers.push("current_hierarchy_state_unverified");
    } else if (
      sourceCampaignId !== currentCampaignId ||
      sourceAdsetId !== currentAdsetId
    ) {
      blockers.push("current_hierarchy_identity_mismatch");
    }
    if (
      !hierarchyStateUnverified &&
      (campaignConfiguredStatus !== "ACTIVE" ||
        campaignEffectiveStatus !== "ACTIVE" ||
        adsetConfiguredStatus !== "ACTIVE" ||
        adsetEffectiveStatus !== "ACTIVE")
    ) {
      blockers.push("current_hierarchy_state_incompatible");
    }
    if (
      (request.action === "pause" &&
        (configuredStatus !== "ACTIVE" || effectiveStatus !== "ACTIVE")) ||
      (request.action === "resume" &&
        (configuredStatus !== "PAUSED" || effectiveStatus !== "PAUSED"))
    ) {
      blockers.push("ad_status_incompatible");
    }
  }

  if (blockers.length > 0) {
    return rejectedDecisionOriginPreflight({
      blockers,
      decisionAgeHours,
      currentAdStateAgeMinutes,
    });
  }
  return {
    ok: true,
    disposition: "proceed",
    shouldMutate: true,
    blockers: [],
    errorCode: null,
    duplicateReceipt: null,
    decisionAgeHours,
    currentAdStateAgeMinutes,
  };
}

export async function runDecisionOriginAdExecutionPreflight(input: {
  request: DecisionOriginAdExecutionRequest;
  rereadEvidence: (
    request: DecisionOriginAdExecutionRequest,
  ) => Promise<DecisionOriginAdExecutionEvidence>;
  now?: Date;
  maxDecisionAgeHours?: number;
  maxCurrentAdStateAgeMinutes?: number;
  requiredEngineVersion?: string;
}): Promise<DecisionOriginAdExecutionPreflightResult> {
  const requestBlockers = requestContractBlockers(input.request);
  if (requestBlockers.length > 0) {
    return rejectedDecisionOriginPreflight({ blockers: requestBlockers });
  }
  const evidence = await input.rereadEvidence(input.request);
  return evaluateDecisionOriginAdExecutionPreflight({
    request: input.request,
    evidence,
    now: input.now,
    maxDecisionAgeHours: input.maxDecisionAgeHours,
    maxCurrentAdStateAgeMinutes: input.maxCurrentAdStateAgeMinutes,
    requiredEngineVersion: input.requiredEngineVersion,
  });
}

export function expectedProviderStatusForDecisionOriginAction(
  action: string,
): "ACTIVE" | "PAUSED" | null {
  if (action === "pause") return "PAUSED";
  if (action === "resume") return "ACTIVE";
  return null;
}

export function validateDecisionOriginProviderVerification(input: {
  request: DecisionOriginAdExecutionRequest;
  expectedLineage: DecisionOriginProviderVerificationLineage;
  verifiedAt: string | null | undefined;
  providerCompletedAt?: string | null | undefined;
  verificationPayload: Record<string, unknown> | null | undefined;
}): DecisionOriginProviderVerificationResult {
  const blockers: DecisionOriginAdExecutionBlocker[] = [];
  const expectedStatus = expectedProviderStatusForDecisionOriginAction(
    input.request.action,
  );
  const hasDeclaredVerificationContract =
    input.verificationPayload !== null &&
    input.verificationPayload !== undefined &&
    Object.prototype.hasOwnProperty.call(
      input.verificationPayload,
      "contractVersion",
    );
  const usesExactStatusEnvelope =
    input.verificationPayload?.contractVersion ===
    "meta-ad-status-write-verification.v1";
  const envelopeString = (key: string) => {
    const value = input.verificationPayload?.[key];
    return typeof value === "string" ? value.trim() || null : null;
  };
  const verificationAdId =
    usesExactStatusEnvelope
      ? envelopeString("adId")
      : typeof input.verificationPayload?.id === "string"
      ? input.verificationPayload.id.trim() || null
      : null;
  const normalizedProviderAccountId = (value: unknown) => {
    const normalized = typeof value === "string" ? value.trim() : "";
    if (!normalized) return null;
    return `act_${normalized.replace(/^act[_-]/, "")}`;
  };
  const nestedId = (key: "creative" | "campaign" | "adset") => {
    const value = input.verificationPayload?.[key];
    return value &&
      typeof value === "object" &&
      !Array.isArray(value) &&
      typeof (value as Record<string, unknown>).id === "string"
      ? ((value as Record<string, unknown>).id as string).trim() || null
      : null;
  };
  const nestedRecord = (
    value: Record<string, unknown> | null,
    key: "creative" | "campaign" | "adset",
  ) => {
    const nested = value?.[key];
    return nested &&
      typeof nested === "object" &&
      !Array.isArray(nested)
      ? (nested as Record<string, unknown>)
      : null;
  };
  const recordString = (
    value: Record<string, unknown> | null,
    key: string,
  ) => {
    const field = value?.[key];
    return typeof field === "string" ? field.trim() || null : null;
  };
  const verificationProviderAccountId = normalizedProviderAccountId(
    usesExactStatusEnvelope
      ? envelopeString("providerAccountId")
      : input.verificationPayload?.account_id,
  );
  const verificationCreativeId = usesExactStatusEnvelope
    ? envelopeString("creativeId")
    : nestedId("creative");
  const verificationCampaignId = usesExactStatusEnvelope
    ? envelopeString("campaignId")
    : nestedId("campaign");
  const verificationAdsetId = usesExactStatusEnvelope
    ? envelopeString("adsetId")
    : nestedId("adset");
  const rawStatus = usesExactStatusEnvelope
    ? input.verificationPayload?.configuredStatus
    : input.verificationPayload?.status ??
      input.verificationPayload?.effective_status;
  const verificationStatus =
    typeof rawStatus === "string" ? rawStatus.trim().toUpperCase() || null : null;
  const verifiedTime = input.verifiedAt ? new Date(input.verifiedAt) : null;

  if (!verifiedTime || !Number.isFinite(verifiedTime.getTime())) {
    blockers.push("verification_timestamp_missing");
  }
  if (verificationAdId !== trimmed(input.request.adId)) {
    blockers.push("verification_ad_mismatch");
  }
  if (
    verificationProviderAccountId !==
      normalizedProviderAccountId(input.expectedLineage.providerAccountId) ||
    verificationProviderAccountId !==
      normalizedProviderAccountId(input.request.providerAccountId)
  ) {
    blockers.push("verification_provider_account_mismatch");
  }
  if (
    verificationCreativeId !== trimmed(input.expectedLineage.creativeId) ||
    verificationCreativeId !== trimmed(input.request.creativeId)
  ) {
    blockers.push("verification_creative_mismatch");
  }
  if (verificationCampaignId !== trimmed(input.expectedLineage.campaignId)) {
    blockers.push("verification_campaign_mismatch");
  }
  if (verificationAdsetId !== trimmed(input.expectedLineage.adsetId)) {
    blockers.push("verification_adset_mismatch");
  }
  if (expectedStatus === null || verificationStatus !== expectedStatus) {
    blockers.push("verification_action_mismatch");
  }
  if (hasDeclaredVerificationContract && !usesExactStatusEnvelope) {
    blockers.push("verification_action_mismatch");
  }
  if (usesExactStatusEnvelope) {
    const exactStatus = (key: string, expected: string) =>
      envelopeString(key)?.toUpperCase() === expected;
    const providerGet =
      input.verificationPayload?.providerGetEvidence &&
      typeof input.verificationPayload.providerGetEvidence === "object" &&
      !Array.isArray(input.verificationPayload.providerGetEvidence)
        ? (input.verificationPayload
            .providerGetEvidence as Record<string, unknown>)
        : null;
    const providerGetCreative = nestedRecord(providerGet, "creative");
    const providerGetCampaign = nestedRecord(providerGet, "campaign");
    const providerGetAdset = nestedRecord(providerGet, "adset");
    const observedAt = envelopeString("observedAt");
    const observedAtMs = observedAt ? Date.parse(observedAt) : Number.NaN;
    const verifiedAtMs = input.verifiedAt
      ? Date.parse(input.verifiedAt)
      : Number.NaN;
    const providerCompletedAtMs = input.providerCompletedAt
      ? Date.parse(input.providerCompletedAt)
      : Number.NaN;
    if (
      !exactStatus("configuredStatus", expectedStatus ?? "") ||
      !exactStatus("effectiveStatus", expectedStatus ?? "") ||
      !exactStatus("campaignConfiguredStatus", "ACTIVE") ||
      !exactStatus("campaignEffectiveStatus", "ACTIVE") ||
      !exactStatus("adsetConfiguredStatus", "ACTIVE") ||
      !exactStatus("adsetEffectiveStatus", "ACTIVE") ||
      input.verificationPayload?.policyEligible !== true ||
      !Object.prototype.hasOwnProperty.call(
        input.verificationPayload,
        "reviewStatus",
      ) ||
      input.verificationPayload.reviewStatus !== null ||
      !Number.isFinite(observedAtMs) ||
      !Number.isFinite(verifiedAtMs) ||
      observedAtMs > verifiedAtMs ||
      (input.request.dryRun !== true &&
        (!Number.isFinite(providerCompletedAtMs) ||
          observedAtMs < providerCompletedAtMs)) ||
      providerGet === null ||
      recordString(providerGet, "id") !== trimmed(input.request.adId) ||
      normalizedProviderAccountId(recordString(providerGet, "account_id")) !==
        normalizedProviderAccountId(input.request.providerAccountId) ||
      recordString(providerGet, "status")?.toUpperCase() !== expectedStatus ||
      recordString(providerGet, "effective_status")?.toUpperCase() !==
        expectedStatus ||
      recordString(providerGetCreative, "id") !==
        trimmed(input.expectedLineage.creativeId) ||
      recordString(providerGetCampaign, "id") !==
        trimmed(input.expectedLineage.campaignId) ||
      recordString(providerGetCampaign, "status")?.toUpperCase() !==
        "ACTIVE" ||
      recordString(
        providerGetCampaign,
        "effective_status",
      )?.toUpperCase() !== "ACTIVE" ||
      recordString(providerGetAdset, "id") !==
        trimmed(input.expectedLineage.adsetId) ||
      recordString(providerGetAdset, "status")?.toUpperCase() !== "ACTIVE" ||
      recordString(
        providerGetAdset,
        "effective_status",
      )?.toUpperCase() !== "ACTIVE"
    ) {
      blockers.push("verification_action_mismatch");
    }
  }

  const providerVerified =
    input.request.dryRun !== true && blockers.length === 0;
  return {
    providerVerified,
    treatmentEligible: providerVerified,
    blockers: unique(blockers),
    verificationAdId,
    verificationProviderAccountId,
    verificationCreativeId,
    verificationCampaignId,
    verificationAdsetId,
    verificationStatus,
    expectedStatus,
  };
}

export function createCreativeActionIdempotencyKey(input: {
  businessId: string;
  creativeId: string;
  targetEntityId?: string | null;
  action: CreativeExecutableAction;
  asOfDate: string;
  engineVersion: string;
}): string {
  const mutationTargetId = input.targetEntityId ?? input.creativeId;
  return [
    "creative-action",
    normalizedPart(input.businessId),
    normalizedPart(mutationTargetId),
    normalizedPart(input.action),
    normalizedPart(input.asOfDate.slice(0, 10)),
    normalizedPart(input.engineVersion),
  ].join(":");
}

export function evaluateCreativeMutationPreflight(input: {
  scheduledDecision: DecisionOutput;
  currentDecision: DecisionOutput;
  now?: Date;
  maxDecisionAgeHours?: number;
  maxConfidenceRegressionPoints?: number;
  maxRatioToTargetDrift?: number;
  maxRecentHoldDrift?: number;
}): CreativeMutationPreflightResult {
  const blockers: CreativeExecutionSafetyBlocker[] = [];
  const drift: string[] = [];
  const maxDecisionAgeHours = input.maxDecisionAgeHours ?? 12;
  const maxConfidenceRegressionPoints =
    input.maxConfidenceRegressionPoints ?? 5;
  const maxRatioToTargetDrift = input.maxRatioToTargetDrift ?? 0.1;
  const maxRecentHoldDrift = input.maxRecentHoldDrift ?? 0.1;
  const now = input.now ?? new Date();

  if (!isCreativeExecutableAction(input.scheduledDecision.label)) {
    blockers.push("unsupported_action");
  }
  if (input.currentDecision.creativeId !== input.scheduledDecision.creativeId) {
    blockers.push("creative_id_drift");
    drift.push("creative_id");
  }
  if (input.currentDecision.label !== input.scheduledDecision.label) {
    blockers.push("label_drift");
    drift.push("label");
  }
  if (
    !sameNullable(
      input.currentDecision.engineVersion,
      input.scheduledDecision.engineVersion,
    )
  ) {
    blockers.push("engine_version_drift");
    drift.push("engine_version");
  }
  if (
    !sameNullable(
      input.currentDecision.truthSource,
      input.scheduledDecision.truthSource,
    )
  ) {
    blockers.push("truth_source_drift");
    drift.push("truth_source");
  }
  if (
    materialNumericDrift(
      input.currentDecision.effectiveTargetRoas,
      input.scheduledDecision.effectiveTargetRoas,
      0.000001,
    )
  ) {
    blockers.push("target_roas_drift");
    drift.push("effective_target_roas");
  }
  if (
    materialNumericDrift(
      input.currentDecision.ratioToTarget,
      input.scheduledDecision.ratioToTarget,
      maxRatioToTargetDrift,
    )
  ) {
    blockers.push("ratio_to_target_drift");
    drift.push("ratio_to_target");
  }
  if (
    materialNumericDrift(
      recentHoldRatio(input.currentDecision),
      recentHoldRatio(input.scheduledDecision),
      maxRecentHoldDrift,
    )
  ) {
    blockers.push("recent_hold_drift");
    drift.push("recent_hold");
  }
  if (
    !sameNullable(
      input.currentDecision.campaignKind,
      input.scheduledDecision.campaignKind,
    )
  ) {
    blockers.push("campaign_kind_drift");
    drift.push("campaign_kind");
  }
  if (
    !sameNullable(
      resolveCampaignRoleStatus(input.currentDecision),
      resolveCampaignRoleStatus(input.scheduledDecision),
    )
  ) {
    blockers.push("campaign_role_status_drift");
    drift.push("campaign_role_status");
  }
  if (
    !sameNullable(
      input.currentDecision.decisionKindSource,
      input.scheduledDecision.decisionKindSource,
    )
  ) {
    blockers.push("decision_kind_source_drift");
    drift.push("decision_kind_source");
  }
  if (
    !sameNullable(
      input.currentDecision.labelTransform,
      input.scheduledDecision.labelTransform,
    )
  ) {
    blockers.push("label_transform_drift");
    drift.push("label_transform");
  }
  if (
    !sameNullable(
      input.currentDecision.blockedActionType,
      input.scheduledDecision.blockedActionType,
    )
  ) {
    blockers.push("blocked_action_drift");
    drift.push("blocked_action_type");
  }
  if (
    input.currentDecision.confidence <
    input.scheduledDecision.confidence - maxConfidenceRegressionPoints
  ) {
    blockers.push("confidence_regressed");
    drift.push("confidence");
  }

  const currentDecisionAgeHours = ageHours(input.currentDecision.generatedAt, now);
  const currentDecisionAgeStatus =
    currentDecisionAgeHours === null
      ? "unparseable_timestamp"
      : currentDecisionAgeHours > maxDecisionAgeHours
        ? "stale"
        : "fresh";
  if (
    currentDecisionAgeHours === null ||
    currentDecisionAgeHours > maxDecisionAgeHours
  ) {
    blockers.push("decision_stale");
    drift.push("generated_at");
  }

  return {
    ok: blockers.length === 0,
    blockers: unique(blockers),
    drift: unique(drift),
    currentDecisionAgeHours,
    currentDecisionAgeStatus,
  };
}

/**
 * Builds a rollback recipe for the current P2 semantics.
 * Scale rollback assumes budget-only mutation; extend this if a later executor
 * changes bid strategy, bid caps, targeting, or other ad set/campaign fields.
 */
export function buildCreativeRollbackPlan(input: {
  action: CreativeExecutableAction;
  beforeState: CreativeRollbackBeforeState;
}): CreativeRollbackPlan {
  const blockers: CreativeExecutionSafetyBlocker[] = [];
  const restoreSteps: string[] = [];

  if (!input.beforeState.effectiveStatus) {
    blockers.push("missing_prior_status");
  } else {
    restoreSteps.push(`restore_effective_status:${input.beforeState.effectiveStatus}`);
  }

  if (input.action === "scale") {
    if (
      typeof input.beforeState.budgetAmount !== "number" ||
      !Number.isFinite(input.beforeState.budgetAmount) ||
      !input.beforeState.budgetOwnerId
    ) {
      blockers.push("missing_prior_budget");
    } else {
      restoreSteps.push(
        `restore_budget:${input.beforeState.budgetOwnerId}:${input.beforeState.budgetAmount}`,
      );
    }
  }

  if (
    input.action === "refresh" &&
    (input.beforeState.createdEntityIds ?? []).length === 0
  ) {
    blockers.push("missing_created_entity_snapshot");
  } else if (input.action === "refresh") {
    restoreSteps.push(
      `delete_created_entities:${(input.beforeState.createdEntityIds ?? []).join(",")}`,
    );
  }

  return {
    ok: blockers.length === 0,
    action: input.action,
    blockers: unique(blockers),
    restoreSteps,
    beforeState: input.beforeState,
  };
}

export function createCreativePostActionMonitorPlan(input: {
  businessId: string;
  creativeId: string;
  action: CreativeExecutableAction;
  actionIdempotencyKey: string;
  startDate: string;
  outcomeWindowsDays?: readonly number[];
}): CreativePostActionMonitorPlan {
  return {
    action: input.action,
    businessId: input.businessId,
    creativeId: input.creativeId,
    actionIdempotencyKey: input.actionIdempotencyKey,
    startDate: input.startDate,
    outcomeWindowsDays: [...(input.outcomeWindowsDays ?? [1, 3, 7, 14])],
    metricChecks: metricChecksFor(input.action),
  };
}

export function evaluateCreativeExecutionReadiness(input: {
  readiness: MetaAutomationReadiness;
  preflight: CreativeMutationPreflightResult;
  rollbackPlan: CreativeRollbackPlan;
  postActionMonitorPlan?: CreativePostActionMonitorPlan | null;
  idempotencyKey?: string | null;
  expectedIdempotencyKey?: string | null;
}): CreativeExecutionReadinessResult {
  const blockers: CreativeExecutionSafetyBlocker[] = [];

  if (!input.idempotencyKey?.trim()) blockers.push("missing_idempotency_key");
  if (
    input.idempotencyKey?.trim() &&
    input.expectedIdempotencyKey?.trim() &&
    input.idempotencyKey !== input.expectedIdempotencyKey
  ) {
    blockers.push("idempotency_key_mismatch");
  }
  if (!input.readiness.autoExecuteEligible) {
    blockers.push("base_readiness_not_auto_eligible");
  }
  if (!input.preflight.ok) blockers.push("preflight_failed");
  if (!input.rollbackPlan.ok) blockers.push("rollback_unavailable");
  if (!input.postActionMonitorPlan) {
    blockers.push("post_action_monitor_missing");
  }

  return {
    ok: blockers.length === 0 && input.readiness.blockers.length === 0,
    blockers: unique(blockers),
    readinessBlockers: input.readiness.blockers,
  };
}
