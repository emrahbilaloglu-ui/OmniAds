import { NextRequest, NextResponse } from "next/server";
import { isMetaWriteBlockedCode } from "@/lib/meta/write-blocked-codes";
import {
  DECISION_ORIGIN_PENDING_RECONCILIATION_CODE,
  DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
  completeDecisionOriginMetaAdsActionLog,
  completeMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  createMetaAdsActionLog,
  decisionOriginIdempotencyReceiptFromLog,
  findUnresolvedMetaAdStatusActionLog,
  markDecisionOriginActionReconciliationRequired,
  appendManualMetaAdStatusMutationAttemptCompleted,
  appendManualMetaAdStatusMutationAttemptStarted,
  META_AD_STATUS_ACTION_IN_FLIGHT_CODE,
  META_AD_STATUS_RECONCILIATION_REQUIRED_CODE,
  readLaunchpadCreatedAdIds,
  resolveExactMetaAdActionTarget,
  type ManualMetaAdStatusMutationAttemptEvent,
  type ManualMetaAdStatusMutationTarget,
  type MetaAdsActionStatus,
  type MetaAdsActionLogRow,
  type DecisionOriginReconciliationOutcome,
} from "@/lib/meta/ads-action-log";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  validateDecisionOriginAdExecutionRequest,
  type DecisionOriginAdExecutionRequest,
  type DecisionOriginIdempotencyReceipt,
} from "@/lib/creative-decision-engine/execution-safety";
import {
  hasSuccessfulMetaProviderMutationAttempt,
  pauseAd,
  readMetaAdExecutionState,
  resumeAd,
  type MetaAdStatusMutationBaseline,
  type MetaAdsWouldHaveWritten,
  type MetaAdsWriteFailure,
  type MetaProviderMutationAttemptReceipt,
} from "@/lib/meta/ads-write";
import {
  reconcileManualMetaAdStatusBlocker,
  type ManualMetaAdStatusReconciliationResult,
} from "@/lib/meta/manual-ad-status-reconciliation";
import { runServerDecisionOriginAdActionPreflight } from "@/lib/meta/decision-origin-action-preflight";
import {
  evaluateManualMetaAdStatusPreflight,
  metaAdStatusActionClaimConflict,
} from "@/lib/meta/ads-action-routes";
import {
  META_ACTION_ORIGIN_ALIAS_FIELDS,
  META_MANUAL_EXECUTION_FIELDS,
  META_NATIVE_LINEAGE_FIELDS,
  hasInvalidMetaDryRunField,
  presentMetaActionContractFields,
} from "@/lib/launchpad/meta-manual-authority";
import {
  metaWriteBlockedResponse,
  readMetaWritePosture,
} from "@/lib/meta/automation-write-guard";
import { adsManagerUrl } from "@/lib/launchpad/meta";
import {
  metaLaunchAccountBlockerHttpStatus,
  normalizeMetaLaunchProviderAccountId,
  resolveAssignedMetaLaunchAccount,
  resolveMetaLaunchWriteContext,
  validateMetaBulkResumePreflight,
} from "@/lib/launchpad/meta-validation";
import {
  jsonError,
  readJsonBody,
  rejectIfLaunchpadReviewerReadOnly,
  requireLaunchpadBusinessAccess,
  sanitizeErrorMessage,
} from "../route-utils";
import { rejectIfLaunchpadDemoWrite } from "../demo-write-authority";

type BulkAdStatusAction = "pause" | "resume";

type BulkAdStatusItem = {
  contractVersion?: string;
  adId?: string | null;
  providerAccountId?: string | null;
  snapshotId?: string | null;
  evaluationId?: string | null;
  engineVersion?: string | null;
  decisionHash?: string | null;
  action?: string | null;
  idempotencyKey?: string | null;
  dryRun?: unknown;
  candidateAdIds?: Array<string | null | undefined> | null;
  creativeId?: string | null;
  name?: string | null;
};

type BulkAdStatusBody = {
  actionOrigin?: string;
  manualConfirmation?: string;
  contractVersion?: string;
  businessId?: string;
  providerAccountId?: string;
  action?: BulkAdStatusAction;
  ads?: Array<BulkAdStatusItem | null>;
  idempotencyKey?: string;
};

type NormalizedBulkAd = {
  adId: string;
  candidateAdIds: string[];
  creativeId: string | null;
  name: string | null;
  dryRun: boolean;
  decisionOriginRequest: DecisionOriginAdExecutionRequest | null;
  decisionOriginPayload: BulkAdStatusItem;
};

export const dynamic = "force-dynamic";
const MAX_BULK_ADS = 20;
const BULK_ACTION_ORIGINS = {
  nativeDecision: "native_decision_v1",
  manualOperator: "manual_operator_v1",
} as const;
const BULK_ITEM_ACTION_ORIGIN_FIELDS = [
  "actionOrigin",
  ...META_ACTION_ORIGIN_ALIAS_FIELDS,
] as const;

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

function uniqueIds(ids: unknown[]) {
  const seen = new Set<string>();
  return ids.flatMap((id) => {
    const normalized = typeof id === "string" ? id.trim() : "";
    if (!normalized || seen.has(normalized)) return [];
    seen.add(normalized);
    return [normalized];
  });
}

function expectedAdStatusWrite(
  adId: string,
  status: "ACTIVE" | "PAUSED",
): MetaAdsWouldHaveWritten {
  return {
    method: "POST",
    path: adId,
    body: { status },
  };
}

function getFailureLogStatus(result: MetaAdsWriteFailure): Exclude<MetaAdsActionStatus, "pending" | "success"> {
  return result.error.code === "silent_failure" ||
    hasSuccessfulMetaProviderMutationAttempt(result) ||
    result.error.code === "provider_outcome_ambiguous" ||
    result.providerOutcome === "outcome_ambiguous"
    ? "silent_failure"
    : "failure";
}

function isProviderOutcomeAmbiguous(result: MetaAdsWriteFailure) {
  return (
    result.error.code === "provider_outcome_ambiguous" ||
    result.providerOutcome === "outcome_ambiguous"
  );
}

function shouldSuppressProviderRetry(result: MetaAdsWriteFailure) {
  return (
    isProviderOutcomeAmbiguous(result) ||
    hasSuccessfulMetaProviderMutationAttempt(result)
  );
}

function manualTerminalReconciliationMetadata(
  result: MetaAdsWriteFailure,
  dryRun: boolean,
) {
  if (dryRun || getFailureLogStatus(result) !== "silent_failure") return {};
  return {
    reconciliationRequired: true as const,
    retryAllowed: false as const,
    ...(isProviderOutcomeAmbiguous(result)
      ? { providerOutcomeAmbiguous: true as const }
      : {}),
    ...(hasSuccessfulMetaProviderMutationAttempt(result)
      ? { providerMutationSucceeded: true as const }
      : {}),
  };
}

function reconciliationOutcomeForProviderWriteFailure(
  result: MetaAdsWriteFailure,
  dryRun: boolean,
): DecisionOriginReconciliationOutcome | null {
  if (dryRun) return null;
  if (isProviderOutcomeAmbiguous(result)) {
    return "provider_outcome_ambiguous";
  }
  if (hasSuccessfulMetaProviderMutationAttempt(result)) {
    return "provider_response_succeeded_verification_failed";
  }
  return null;
}

function reconciliationResponseMetadata(input: {
  outcome: DecisionOriginReconciliationOutcome;
  markerPersisted: boolean;
}) {
  const providerMutationSucceeded =
    input.outcome ===
      "provider_response_succeeded_verification_failed" ||
    input.outcome ===
      "provider_write_verified_receipt_persistence_failed";
  return {
    reconciliationRequired: true as const,
    retryAllowed: false as const,
    markerPersisted: input.markerPersisted,
    ...(providerMutationSucceeded
      ? { providerMutationSucceeded: true as const }
      : {}),
    ...(input.outcome === "provider_outcome_ambiguous"
      ? { providerOutcomeAmbiguous: true as const }
      : {}),
  };
}

function isDecisionOriginVerificationMismatchError(
  error: unknown,
): error is { code: string } {
  return (
    error !== null &&
    typeof error === "object" &&
    "code" in error &&
    (error as { code?: unknown }).code ===
      "decision_origin_provider_verification_mismatch"
  );
}

function isDecisionOriginReconciliationReceipt(
  receipt:
    | {
        status?: string | null;
        errorCode?: string | null;
        reconciliationRequired?: boolean;
        reconciliationOutcome?: string | null;
        providerMutationSucceeded?: boolean | null;
        providerOutcomeAmbiguous?: boolean | null;
        payloadResponse?: Record<string, unknown> | null;
      }
    | null
    | undefined,
) {
  if (
    receipt?.status !== "pending" ||
    receipt.errorCode !== DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
  ) {
    return false;
  }
  if (receipt.reconciliationRequired === true) return true;
  const marker = receipt.payloadResponse?.decision_origin_reconciliation;
  return (
    marker !== null &&
    typeof marker === "object" &&
    !Array.isArray(marker) &&
    (marker as Record<string, unknown>).reconciliation_required === true
  );
}

function reconciliationReceiptProviderMutationSucceeded(
  receipt:
    | {
        status?: string;
        errorCode?: string | null;
        reconciliationRequired?: boolean;
        retryAllowed?: boolean | null;
        reconciliationOutcome?: string | null;
        providerMutationAttempted?: boolean | null;
        providerMutationSucceeded?: boolean | null;
        providerOutcomeAmbiguous?: boolean | null;
      }
    | null
    | undefined,
) {
  return (
    receipt?.status === "pending" &&
    receipt.errorCode === DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE &&
    receipt.reconciliationRequired === true &&
    receipt.retryAllowed === false &&
    receipt.providerMutationAttempted === true &&
    receipt.providerMutationSucceeded === true &&
    receipt.providerOutcomeAmbiguous === false &&
    (receipt.reconciliationOutcome ===
      "provider_response_succeeded_verification_failed" ||
      receipt.reconciliationOutcome ===
        "provider_write_verified_receipt_persistence_failed")
  );
}

async function completeFailure(input: {
  logId: string;
  durationMs: number;
  result: MetaAdsWriteFailure;
  decisionOrigin: boolean;
  dryRun: boolean;
  manualMutationCompletion?: {
    providerResponse: Record<string, unknown> | null;
    verification: Record<string, unknown> | null;
  } | null;
}) {
  const manualCompletion = input.manualMutationCompletion ?? null;
  const manualAdapterPreProviderAbort =
    !input.decisionOrigin &&
    !input.dryRun &&
    manualCompletion === null &&
    input.result.providerMutationAttempted === false
      ? {
          adapter_pre_provider_abort: {
            code: input.result.error.code,
            provider_mutation_attempted: false,
          },
        }
      : null;
  const completion = {
    id: input.logId,
    status: getFailureLogStatus(input.result),
    payloadResponse:
      manualCompletion
        ? manualCompletion.providerResponse
        : manualAdapterPreProviderAbort ??
          ensureRecord(input.result.responsePayload),
    errorCode: input.result.error.code,
    errorMessage: input.result.error.message,
    resultingAdId: input.result.resultingAdId ?? null,
    durationMs: input.durationMs,
    verificationPayload:
      manualCompletion
        ? manualCompletion.verification
        : manualAdapterPreProviderAbort
          ? null
          : ensureRecord(input.result.verificationPayload),
  };
  return input.decisionOrigin
    ? completeDecisionOriginMetaAdsActionLog(completion)
    : completeMetaAdsActionLog({
        ...completion,
        verifiedAt: null,
      });
}

async function completeManualTerminalWithRetry<T>(
  completion: () => Promise<T>,
): Promise<T> {
  let completionError: unknown = null;
  for (let attempt = 0; attempt < 2; attempt += 1) {
    try {
      return await completion();
    } catch (error) {
      completionError = error;
    }
  }
  throw completionError ?? new Error("Manual terminal persistence failed.");
}

function manualProviderMutationAttemptReceipt(
  receipt: MetaProviderMutationAttemptReceipt,
) {
  return {
    attemptCount: receipt.attemptCount,
    method: receipt.method,
    path: receipt.path,
    attemptedAt: receipt.attemptedAt,
    completedAt: receipt.completedAt,
    providerResponseReceived: receipt.providerResponseReceived,
    ...(typeof receipt.providerResponseSuccessful === "boolean"
      ? {
          providerResponseSuccessful:
            receipt.providerResponseSuccessful,
        }
      : {}),
    httpStatus: receipt.httpStatus,
    outcome: receipt.outcome,
    automaticRetryAttempted: receipt.automaticRetryAttempted,
    transportError: receipt.transportError
      ? {
          code: receipt.transportError.code,
          message: receipt.transportError.message,
        }
      : null,
  };
}

function manualMutationCompletionForResult(
  result: Awaited<ReturnType<typeof pauseAd>>,
) {
  const mutationAttempt = result.mutationAttempt;
  if (!mutationAttempt) return null;
  const providerResponse = ensureRecord(result.responsePayload);
  if (
    mutationAttempt.outcome === "outcome_ambiguous" ||
    (result.ok === false &&
      (result.error.code === "provider_outcome_ambiguous" ||
        result.providerOutcome === "outcome_ambiguous"))
  ) {
    return {
      completionOutcome: "provider_outcome_ambiguous" as const,
      mutationAttempt: manualProviderMutationAttemptReceipt(
        mutationAttempt,
      ),
      providerResponse: null,
      verification: null,
    };
  }
  if (result.ok) {
    return {
      completionOutcome: "provider_response_verified_success" as const,
      mutationAttempt: manualProviderMutationAttemptReceipt(
        mutationAttempt,
      ),
      providerResponse,
      verification: ensureRecord(result.verificationPayload),
    };
  }
  if (hasSuccessfulMetaProviderMutationAttempt(result)) {
    return {
      completionOutcome:
        "provider_response_succeeded_verification_failed" as const,
      mutationAttempt: manualProviderMutationAttemptReceipt(
        mutationAttempt,
      ),
      providerResponse,
      verification:
        ensureRecord(result.verificationPayload) ?? {
          verification_error: {
            code: result.error.code,
            message: result.error.message,
          },
        },
    };
  }
  return {
    completionOutcome: "provider_definite_failure" as const,
    mutationAttempt: manualProviderMutationAttemptReceipt(
      mutationAttempt,
    ),
    providerResponse:
      providerResponse ?? {
        provider_response_evidence: {
          code: result.error.code,
          message: result.error.message,
          httpStatus: result.httpStatus,
          bodyPresent: false,
        },
      },
    verification: null,
  };
}

function manualReconciliationBlocker(input: {
  adId: string;
  result: ManualMetaAdStatusReconciliationResult;
}) {
  const { adId, result } = input;
  if (result.disposition === "waiting") {
    return {
      adId,
      code: "meta_ad_status_reconciliation_waiting",
      blocker: "settlement_not_elapsed",
      reconciliationRequired: true as const,
      retryAllowed: false as const,
      ...(result.candidate.settlementNotBefore
        ? {
            settlementNotBefore: result.candidate.settlementNotBefore,
          }
        : {}),
    };
  }
  if (result.disposition === "blocked") {
    return {
      adId,
      code: META_AD_STATUS_RECONCILIATION_REQUIRED_CODE,
      blocker: result.blocker,
      reconciliationRequired: true as const,
      retryAllowed: false as const,
    };
  }
  if (result.disposition === "unavailable") {
    return {
      adId,
      code: "reconciliation_state_unavailable",
      blocker: result.blocker,
      reconciliationRequired: true as const,
      retryAllowed: false as const,
      unavailable: true as const,
    };
  }
  return null;
}

function manualClaimOwnsExactUnresolvedSource(input: {
  unresolved: MetaAdsActionLogRow | null;
  log: MetaAdsActionLogRow;
  target: ManualMetaAdStatusMutationTarget;
  action: Extract<MetaAdsActionLogRow["action"], "pause" | "resume">;
}) {
  const { unresolved, log, target, action } = input;
  return Boolean(
    unresolved &&
      unresolved.id === log.id &&
      unresolved.status === "pending" &&
      unresolved.source !== "decision_origin" &&
      unresolved.businessId === target.businessId &&
      unresolved.providerAccountId === target.providerAccountId &&
      unresolved.adId === target.adId &&
      unresolved.creativeId === target.creativeId &&
      unresolved.action === action &&
      unresolved.dryRun !== true,
  );
}

function nativeClaimOwnsExactUnresolvedSource(input: {
  unresolved: MetaAdsActionLogRow | null;
  log: MetaAdsActionLogRow;
  request: DecisionOriginAdExecutionRequest;
}) {
  const { unresolved, log, request } = input;
  return Boolean(
    unresolved &&
      unresolved.id === log.id &&
      unresolved.status === "pending" &&
      unresolved.source === "decision_origin" &&
      unresolved.businessId === request.businessId &&
      unresolved.providerAccountId === request.providerAccountId &&
      unresolved.adId === request.adId &&
      unresolved.creativeId === request.creativeId &&
      unresolved.action === request.action &&
      unresolved.idempotencyKey === request.idempotencyKey &&
      unresolved.decisionSnapshotId === request.snapshotId &&
      unresolved.decisionEvaluationId === request.evaluationId &&
      unresolved.decisionEngineVersion === request.engineVersion &&
      unresolved.decisionHash === request.decisionHash &&
      unresolved.dryRun === (request.dryRun === true),
  );
}

function normalizeAds(body: BulkAdStatusBody | null): {
  ads: NormalizedBulkAd[];
  blockers: Array<Record<string, unknown>>;
} {
  if (body?.ads !== undefined && !Array.isArray(body.ads)) {
    return {
      ads: [],
      blockers: [{ code: "invalid_ads_shape" }],
    };
  }
  const ads: NormalizedBulkAd[] = [];
  const blockers: Array<Record<string, unknown>> = [];
  const firstIndexByAdId = new Map<string, number>();
  (body?.ads ?? []).forEach((ad, index) => {
    if (!ad || typeof ad !== "object" || Array.isArray(ad)) {
      blockers.push({ index, adId: null, code: "invalid_bulk_item" });
      return;
    }
    const explicitAdId = stringField(ad.adId);
    if (!explicitAdId) {
      blockers.push({ index, adId: null, code: "missing_ad_id" });
      return;
    }
    const candidateAdIds = uniqueIds([
      explicitAdId,
      ...(Array.isArray(ad.candidateAdIds) ? ad.candidateAdIds : []),
    ]);
    const adId = explicitAdId;
    if (hasInvalidMetaDryRunField(ad)) {
      blockers.push({ index, adId, code: "invalid_dry_run" });
    }
    const firstIndex = firstIndexByAdId.get(adId);
    if (firstIndex !== undefined) {
      blockers.push({
        index,
        firstIndex,
        adId,
        code: "duplicate_ad_target",
      });
      return;
    }
    firstIndexByAdId.set(adId, index);
    ads.push({
      adId,
      candidateAdIds,
      creativeId: stringField(ad.creativeId) || null,
      name: stringField(ad.name) || null,
      dryRun: ad.dryRun === true,
      decisionOriginRequest: null,
      decisionOriginPayload: ad,
    });
  });
  return { ads, blockers };
}

function bindDecisionOriginRequests(input: {
  body: BulkAdStatusBody | null;
  businessId: string;
  action: BulkAdStatusAction;
  ads: NormalizedBulkAd[];
}):
  | { ok: true; decisionOrigin: boolean }
  | { ok: false; blockers: Array<Record<string, unknown>> } {
  const actionOrigin = stringField(input.body?.actionOrigin);
  const itemOriginBlockers = input.ads.flatMap((ad) => {
    const fields = presentMetaActionContractFields(
      ad.decisionOriginPayload,
      BULK_ITEM_ACTION_ORIGIN_FIELDS,
    );
    return fields.length > 0
      ? [
          {
            adId: ad.adId,
            code: "mixed_action_origin_contract",
            fields,
          },
        ]
      : [];
  });
  if (itemOriginBlockers.length > 0) {
    return {
      ok: false,
      blockers: itemOriginBlockers,
    };
  }
  if (
    presentMetaActionContractFields(
      input.body,
      META_ACTION_ORIGIN_ALIAS_FIELDS,
    ).length > 0
  ) {
    return {
      ok: false,
      blockers: [{ code: "mixed_action_origin_contract" }],
    };
  }
  if (
    actionOrigin !== BULK_ACTION_ORIGINS.nativeDecision &&
    actionOrigin !== BULK_ACTION_ORIGINS.manualOperator
  ) {
    return {
      ok: false,
      blockers: [{ code: "action_origin_required" }],
    };
  }
  const decisionOrigin = actionOrigin === BULK_ACTION_ORIGINS.nativeDecision;
  if (!decisionOrigin) {
    const mixedDecisionFields =
      presentMetaActionContractFields(
        input.body,
        META_NATIVE_LINEAGE_FIELDS,
      ).length > 0 ||
      input.ads.some((ad) => {
        const payload = ad.decisionOriginPayload;
        return (
          presentMetaActionContractFields(
            payload,
            META_NATIVE_LINEAGE_FIELDS,
          ).length > 0
        );
      });
    if (mixedDecisionFields) {
      return {
        ok: false,
        blockers: [{ code: "mixed_action_origin_contract" }],
      };
    }
    if (
      input.body?.manualConfirmation !== "explicit_operator_confirmation"
    ) {
      return {
        ok: false,
        blockers: [{ code: "manual_confirmation_required" }],
      };
    }
    const exactTargetBlockers = input.ads.flatMap((ad) => {
      const payload = ad.decisionOriginPayload;
      const providerAccountId = payload.providerAccountId?.trim() ?? "";
      const creativeId = payload.creativeId?.trim() ?? "";
      if (
        ad.candidateAdIds.length === 1 &&
        ad.candidateAdIds[0] === payload.adId?.trim() &&
        providerAccountId &&
        creativeId
      ) {
        return [];
      }
      return [
        {
          adId: ad.adId,
          code: "exact_ad_authority_required",
        },
      ];
    });
    if (exactTargetBlockers.length > 0) {
      return { ok: false, blockers: exactTargetBlockers };
    }
    return { ok: true, decisionOrigin: false };
  }
  if (
    presentMetaActionContractFields(
      input.body,
      META_MANUAL_EXECUTION_FIELDS,
    ).length > 0 ||
    input.ads.some(
      (ad) =>
        presentMetaActionContractFields(
          ad.decisionOriginPayload,
          META_MANUAL_EXECUTION_FIELDS,
        ).length > 0,
    )
  ) {
    return {
      ok: false,
      blockers: [{ code: "mixed_action_origin_contract" }],
    };
  }
  const blockers: Array<Record<string, unknown>> = [];
  if (
    input.body?.contractVersion !==
    DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
  ) {
    blockers.push({ code: "invalid_bulk_contract_version" });
  }
  const seen = new Map<string, string>();
  input.ads.forEach((ad) => {
    const payload = ad.decisionOriginPayload;
    const request: DecisionOriginAdExecutionRequest = {
      contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
      businessId: input.businessId,
      providerAccountId:
        payload.providerAccountId?.trim() ||
        input.body?.providerAccountId?.trim() ||
        "",
      adId: payload.adId?.trim() || "",
      snapshotId: payload.snapshotId?.trim() || "",
      evaluationId: payload.evaluationId?.trim() || "",
      engineVersion: payload.engineVersion?.trim() || "",
      decisionHash: payload.decisionHash?.trim() || "",
      action: payload.action?.trim() || "",
      idempotencyKey: payload.idempotencyKey?.trim() || "",
      creativeId: payload.creativeId?.trim() || "",
      ...(ad.dryRun ? { dryRun: true } : {}),
    };
    const requestBlockers = validateDecisionOriginAdExecutionRequest(request);
    if (
      payload.contractVersion !==
      DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
    ) {
      requestBlockers.push("unsupported_action");
    }
    if (request.action !== input.action) {
      requestBlockers.push("unsupported_action");
    }
    if (
      ad.candidateAdIds.length !== 1 ||
      ad.candidateAdIds[0] !== request.adId
    ) {
      blockers.push({
        adId: ad.adId,
        code: "decision_origin_candidate_fallback_forbidden",
      });
    }
    const priorKey = seen.get(request.adId);
    if (priorKey && priorKey !== request.idempotencyKey) {
      blockers.push({
        adId: request.adId,
        code: "conflicting_decision_lineage",
      });
    }
    seen.set(request.adId, request.idempotencyKey);
    if (requestBlockers.length > 0) {
      blockers.push({
        adId: ad.adId,
        code: "invalid_decision_origin_lineage",
        blockers: Array.from(new Set(requestBlockers)),
      });
      return;
    }
    ad.decisionOriginRequest = request;
  });
  return blockers.length > 0
    ? { ok: false, blockers }
    : { ok: true, decisionOrigin: true };
}

async function resolveBulkAdActionTarget(input: {
  businessId: string;
  candidateAdIds: string[];
  decisionOriginRequest?: DecisionOriginAdExecutionRequest | null;
  manualProviderAccountId?: string | null;
}) {
  const adId =
    input.decisionOriginRequest?.adId ?? input.candidateAdIds[0] ?? "";
  const providerAccountId =
    input.decisionOriginRequest?.providerAccountId ??
    input.manualProviderAccountId?.trim() ??
    "";
  const targetResult = await resolveExactMetaAdActionTarget({
    businessId: input.businessId,
    providerAccountId,
    adId,
  });
  return targetResult.ok
    ? {
        ok: true as const,
        inputAdId: adId,
        attemptedIds: [adId],
        target: targetResult.target,
      }
    : {
        ok: false as const,
        attemptedIds: [adId],
      };
}

export async function POST(request: NextRequest) {
  const body = await readJsonBody<BulkAdStatusBody>(request);
  const businessId = body?.businessId?.trim() ?? "";
  const action = body?.action;
  const idempotencyKey = body?.idempotencyKey?.trim() ?? "";
  const normalizedAds = normalizeAds(body);
  if (normalizedAds.blockers.length > 0) {
    return jsonError(
      400,
      "invalid_decision_origin_batch",
      "Every bulk item must declare one unique, exact ad target and a boolean dryRun mode.",
      { blockers: normalizedAds.blockers },
    );
  }
  const ads = normalizedAds.ads;

  const access = await requireLaunchpadBusinessAccess({ request, businessId });
  if (!access.ok) return access.response;
  const reviewerBlocked = rejectIfLaunchpadReviewerReadOnly(access, "launchpad_bulk_ad_status");
  if (reviewerBlocked) return reviewerBlocked;
  // Canonical invariant: "Demo businesses have zero Meta write authority even
  // if a presentation defect supplies an action." The reviewer gate above does
  // not cover this — `/api/auth/demo-login` opens a session as an ADMIN of the
  // demo business under a non-reviewer email, so it passes both the role check
  // and the reviewer check. The refusal has to live on the server or it does
  // not exist.
  const demoBlocked = await rejectIfLaunchpadDemoWrite(
    access.businessId,
    "launchpad_bulk_ad_status",
  );
  if (demoBlocked) return demoBlocked;
  const posture = await readMetaWritePosture({ businessId: access.businessId });
  if (posture.blocked) return metaWriteBlockedResponse(posture);
  /*
    THE SERVER'S REHEARSAL, applied to every item in the batch.

    Each ad carries its own `dryRun`, and every one of them was the client's
    word alone — a batch that omitted the flag reached real provider POSTs
    while the business's persisted guardrail said rehearse. Raising it here,
    once, makes every downstream read of `ad.dryRun` correct by construction.
    One-way: this can only turn rehearsal on.
  */
  if (posture.rehearsal) {
    for (const ad of ads) {
      if (ad && typeof ad === "object") (ad as { dryRun?: unknown }).dryRun = true;
    }
  }
  if (action !== "pause" && action !== "resume") {
    return jsonError(400, "invalid_action", "action must be pause or resume.");
  }
  if (!idempotencyKey) {
    return jsonError(400, "idempotency_key_required", "idempotencyKey is required.");
  }
  if (ads.length === 0) {
    return jsonError(400, "ads_required", "At least one ad is required.");
  }
  if (ads.length > MAX_BULK_ADS) {
    return jsonError(
      400,
      "bulk_limit_exceeded",
      `At most ${MAX_BULK_ADS} ads can be changed in one request.`,
    );
  }
  const decisionOriginBinding = bindDecisionOriginRequests({
    body,
    businessId: access.businessId,
    action,
    ads,
  });
  if (!decisionOriginBinding.ok) {
    return jsonError(
      400,
      "invalid_decision_origin_batch",
      "Every decision-origin ad must carry one exact native lineage.",
      { blockers: decisionOriginBinding.blockers },
    );
  }

  const account = await resolveAssignedMetaLaunchAccount({
    businessId: access.businessId,
    providerAccountId: body?.providerAccountId,
  });
  if (!account.ok) {
    return jsonError(
      metaLaunchAccountBlockerHttpStatus(account.blocker.code),
      account.blocker.code,
      account.blocker.message,
    );
  }
  const providerAccountId = account.providerAccountId;
  if (
    ads.some(
      (ad) =>
        (ad.decisionOriginRequest?.providerAccountId ??
          ad.decisionOriginPayload.providerAccountId?.trim()) !==
        providerAccountId,
    )
  ) {
    return jsonError(
      400,
      "provider_account_mismatch",
      "Batch target identity does not match the selected Meta account.",
    );
  }
  const ctxResult = await resolveMetaLaunchWriteContext(
    access.businessId,
    providerAccountId,
  );
  if (!ctxResult.ok) {
    return NextResponse.json(
      { ok: false, error: ctxResult.blocker },
      { status: 502 },
    );
  }

  const statusOption = action === "pause" ? "PAUSED" : "ACTIVE";
  const resolvedBatch = await Promise.all(
    ads.map(async (ad) => ({
      ad,
      result: await resolveBulkAdActionTarget({
        businessId: access.businessId,
        candidateAdIds: ad.candidateAdIds,
        decisionOriginRequest: ad.decisionOriginRequest,
        manualProviderAccountId:
          ad.decisionOriginPayload.providerAccountId,
      }),
    })),
  );
  const targetBlockers = resolvedBatch.flatMap(({ ad, result }) => {
    if (!result.ok) {
      return [
        {
          adId: ad.adId,
          code: "ad_not_found",
          attemptedIds: result.attemptedIds,
        },
      ];
    }
    const expectedCreativeId =
      ad.decisionOriginRequest?.creativeId ?? ad.creativeId;
    if (
      normalizeMetaLaunchProviderAccountId(
        result.target.providerAccountId,
      ) !== providerAccountId
    ) {
      return [{ adId: ad.adId, code: "provider_account_mismatch" }];
    }
    if (
      expectedCreativeId &&
      result.target.creativeId !== expectedCreativeId
    ) {
      return [{ adId: ad.adId, code: "creative_identity_mismatch" }];
    }
    return [];
  });
  if (targetBlockers.length > 0) {
    return jsonError(
      409,
      "bulk_target_preflight_blocked",
      "Every bulk target must retain exact ad, creative, and provider-account identity.",
      { blockers: targetBlockers },
    );
  }
  const resolvedTargets = new Map(
    resolvedBatch.flatMap(({ ad, result }) =>
      result.ok ? [[ad.adId, result] as const] : [],
    ),
  );
  const manualReconciliations = new Map<
    string,
    ManualMetaAdStatusReconciliationResult
  >();
  const reconciliationChecks = await Promise.all(
    ads
      .filter((ad) => !ad.dryRun)
      .map(async (ad) => {
        const resolved = resolvedTargets.get(ad.adId)!;
        const result = await reconcileManualMetaAdStatusBlocker({
          businessId: access.businessId,
          providerAccountId: ctxResult.ctx.providerAccountId,
          adId: resolved.target.adId,
          expectedCreativeId:
            resolved.target.creativeId ?? ad.creativeId ?? "",
          ctx: ctxResult.ctx,
        }).catch(
          () =>
            ({
              disposition: "unavailable",
              candidate: null,
              blocker: "reconciliation_state_unavailable",
            }) as const,
        );
        manualReconciliations.set(ad.adId, result);
        return { ad, result };
      }),
  );
  const reconciliationBlockers = reconciliationChecks.flatMap(
    ({ ad, result }) => {
      const blocker = manualReconciliationBlocker({
        adId: ad.adId,
        result,
      });
      return blocker ? [blocker] : [];
    },
  );
  if (reconciliationBlockers.length > 0) {
    const unavailable = reconciliationBlockers.some(
      (blocker) => blocker.unavailable === true,
    );
    const waiting = reconciliationBlockers.every(
      (blocker) =>
        blocker.code === "meta_ad_status_reconciliation_waiting",
    );
    return jsonError(
      unavailable ? 503 : 409,
      unavailable
        ? "reconciliation_state_unavailable"
        : waiting
          ? "meta_ad_status_reconciliation_waiting"
          : "bulk_reconciliation_required",
      unavailable
        ? "The durable Ad-action reconciliation state is temporarily unavailable."
        : waiting
          ? "A prior manual status action is still inside its settlement window; no provider write was attempted."
          : "At least one exact Ad could not be conclusively reconciled; no provider write was attempted.",
      {
        blockers: reconciliationBlockers.map(
          ({ unavailable: _unavailable, ...blocker }) => blocker,
        ),
        reconciliationRequired: true,
        retryAllowed: false,
      },
    );
  }
  const manualReconciledNoOps = new Set(
    ads.flatMap((ad) => {
      if (ad.decisionOriginRequest || ad.dryRun) return [];
      const reconciliation = manualReconciliations.get(ad.adId);
      return reconciliation?.disposition === "reconciled" &&
        reconciliation.state.configuredStatus
          ?.trim()
          .toUpperCase() === statusOption &&
        reconciliation.state.effectiveStatus
          ?.trim()
          .toUpperCase() === statusOption
        ? [ad.adId]
        : [];
    }),
  );
  let unresolvedPendingActions;
  try {
    unresolvedPendingActions = await Promise.all(
      ads.map(async (ad) => {
        const resolved = resolvedTargets.get(ad.adId)!;
        const pending = await findUnresolvedMetaAdStatusActionLog({
          businessId: access.businessId,
          providerAccountId: ctxResult.ctx.providerAccountId,
          adId: resolved.target.adId,
        });
        return { ad, pending };
      }),
    );
  } catch {
    return jsonError(
      503,
      "reconciliation_state_unavailable",
      "The durable Ad-action reconciliation state is temporarily unavailable.",
    );
  }
  const unresolvedPendingBlockers = unresolvedPendingActions.flatMap(
    ({ ad, pending }) => {
      if (!pending) return [];
      const receipt =
        pending.source === "decision_origin"
          ? decisionOriginIdempotencyReceiptFromLog(pending)
          : null;
      const nativeRequest = ad.decisionOriginRequest;
      const nativeSameKey =
        nativeRequest !== null &&
        pending.source === "decision_origin" &&
        pending.idempotencyKey === nativeRequest.idempotencyKey;
      const markerRequiresReconciliation =
        isDecisionOriginReconciliationReceipt(receipt);
      const manualTerminalRequiresReconciliation =
        pending.source !== "decision_origin" &&
        pending.status === "silent_failure" &&
        pending.dryRun !== true;
      const nativeDifferentKey =
        nativeRequest !== null &&
        pending.source === "decision_origin" &&
        !nativeSameKey;
      const code =
        manualTerminalRequiresReconciliation
          ? META_AD_STATUS_RECONCILIATION_REQUIRED_CODE
          : nativeSameKey && markerRequiresReconciliation
          ? DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
          : nativeDifferentKey
            ? DECISION_ORIGIN_PENDING_RECONCILIATION_CODE
            : META_AD_STATUS_ACTION_IN_FLIGHT_CODE;
      const reconciliationRequired =
        manualTerminalRequiresReconciliation ||
        markerRequiresReconciliation ||
        nativeDifferentKey;
      const providerMutationSucceeded =
        reconciliationReceiptProviderMutationSucceeded(receipt);
      return [
        {
          adId: ad.adId,
          code,
          retryAllowed: false,
          blockingActionLogId: pending.id,
          blockingOrigin:
            pending.source === "decision_origin"
              ? BULK_ACTION_ORIGINS.nativeDecision
              : pending.source || BULK_ACTION_ORIGINS.manualOperator,
          ...(reconciliationRequired
            ? { reconciliationRequired: true }
            : {}),
          ...(providerMutationSucceeded
            ? { providerMutationSucceeded: true }
            : {}),
          ...(receipt?.providerOutcomeAmbiguous === true
            ? { providerOutcomeAmbiguous: true }
            : manualTerminalRequiresReconciliation &&
                pending.errorCode === "provider_outcome_ambiguous"
              ? { providerOutcomeAmbiguous: true }
            : {}),
          ...(receipt ? { receipt } : {}),
        },
      ];
    },
  );
  if (unresolvedPendingBlockers.length > 0) {
    const reconciliationRequired = unresolvedPendingBlockers.some(
      (blocker) => blocker.reconciliationRequired === true,
    );
    const reconciliationCodePresent = unresolvedPendingBlockers.some(
      (blocker) =>
        blocker.code === DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE ||
        blocker.code === DECISION_ORIGIN_PENDING_RECONCILIATION_CODE ||
        blocker.code === META_AD_STATUS_RECONCILIATION_REQUIRED_CODE,
    );
    const providerMutationSucceeded = unresolvedPendingBlockers.some(
      (blocker) => blocker.providerMutationSucceeded === true,
    );
    const providerOutcomeAmbiguous = unresolvedPendingBlockers.some(
      (blocker) => blocker.providerOutcomeAmbiguous === true,
    );
    return jsonError(
      409,
      reconciliationCodePresent
        ? "bulk_reconciliation_required"
        : "bulk_action_in_flight",
      "At least one exact Ad has an unresolved status action; no provider write was attempted.",
      {
        blockers: unresolvedPendingBlockers,
        retryAllowed: false,
        ...(reconciliationRequired
          ? { reconciliationRequired: true }
          : {}),
        ...(providerMutationSucceeded
          ? { providerMutationSucceeded: true }
          : {}),
        ...(providerOutcomeAmbiguous
          ? { providerOutcomeAmbiguous: true }
          : {}),
      },
    );
  }
  const nativePreflights = new Map<
    string,
    Awaited<ReturnType<typeof runServerDecisionOriginAdActionPreflight>>
  >();
  const manualInitialStates = new Map<
    string,
    Awaited<ReturnType<typeof readMetaAdExecutionState>>
  >();
  const livePreflightBlockers: Array<Record<string, unknown>> = [];
  if (decisionOriginBinding.decisionOrigin) {
    const preflights = await Promise.all(
      ads.map(async (ad) => ({
        ad,
        result: await runServerDecisionOriginAdActionPreflight({
          request: ad.decisionOriginRequest!,
          ctx: ctxResult.ctx,
        }).catch(() => null),
      })),
    );
    preflights.forEach(({ ad, result }) => {
      if (result) nativePreflights.set(ad.adId, result);
      if (!result) {
        livePreflightBlockers.push({
          adId: ad.adId,
          code: "decision_preflight_unavailable",
        });
      } else if (
        !result.shouldMutate &&
        !(
          result.disposition === "duplicate" &&
          result.duplicateReceipt?.status === "success" &&
          result.duplicateReceipt.providerVerified === true &&
          result.duplicateReceipt.treatmentEligible === true
        )
      ) {
        const reconciliationRequired =
          result.disposition === "duplicate" &&
          isDecisionOriginReconciliationReceipt(result.duplicateReceipt);
        const nonTreatmentDuplicate =
          result.disposition === "duplicate" &&
          result.duplicateReceipt?.status === "success" &&
          (result.duplicateReceipt.providerVerified !== true ||
            result.duplicateReceipt.treatmentEligible !== true);
        const providerMutationSucceeded =
          reconciliationRequired &&
          reconciliationReceiptProviderMutationSucceeded(
            result.duplicateReceipt,
          );
        livePreflightBlockers.push({
          adId: ad.adId,
          code: reconciliationRequired
            ? DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
            : nonTreatmentDuplicate
              ? "idempotent_receipt_not_treatment_eligible"
            : result.errorCode ?? "decision_preflight_blocked",
          blockers: result.blockers,
          ...(reconciliationRequired
            ? {
                reconciliationRequired: true,
                retryAllowed: false,
                ...(providerMutationSucceeded
                  ? { providerMutationSucceeded: true }
                  : {}),
                ...(result.duplicateReceipt?.providerOutcomeAmbiguous === true
                  ? { providerOutcomeAmbiguous: true }
                  : {}),
                markerPersisted: true,
              }
            : {}),
        });
      }
    });
  } else {
    const currentStates = await Promise.all(
      ads
        .filter((ad) => !manualReconciledNoOps.has(ad.adId))
        .map(async (ad) => {
          const reconciliation = manualReconciliations.get(ad.adId);
          const state =
            reconciliation?.disposition === "reconciled"
              ? reconciliation.state
              : await readMetaAdExecutionState(
                  ctxResult.ctx,
                  ad.adId,
                ).catch(() => null);
          return { ad, state };
        }),
    );
    currentStates.forEach(({ ad, state }) => {
      if (state) manualInitialStates.set(ad.adId, state);
      const preflight = state
        ? evaluateManualMetaAdStatusPreflight({
            action,
            state,
            expectedAdId: ad.adId,
            expectedCreativeId: ad.creativeId ?? "",
            expectedProviderAccountId: providerAccountId,
          })
        : {
            ok: false as const,
            blocker: "current_ad_state_unverified" as const,
          };
      if (!preflight.ok) {
        livePreflightBlockers.push({
          adId: ad.adId,
          code: preflight.blocker,
        });
      }
    });
  }
  if (livePreflightBlockers.length > 0) {
    const reconciliationRequired = livePreflightBlockers.some(
      (blocker) => blocker.reconciliationRequired === true,
    );
    const providerMutationSucceeded = livePreflightBlockers.some(
      (blocker) => blocker.providerMutationSucceeded === true,
    );
    const providerOutcomeAmbiguous = livePreflightBlockers.some(
      (blocker) => blocker.providerOutcomeAmbiguous === true,
    );
    const retryable = livePreflightBlockers.some((blocker) =>
      [
        "current_ad_state_unverified",
        "current_hierarchy_state_unverified",
        "decision_preflight_unavailable",
        "kill_switch_state_unavailable",
      ].includes(String(blocker.code ?? "")),
    );
    return jsonError(
      retryable ? 503 : 409,
      "bulk_live_preflight_blocked",
      "Every bulk target must pass exact live preflight before the first provider write.",
      {
        blockers: livePreflightBlockers,
        ...(reconciliationRequired
          ? {
              reconciliationRequired: true,
              retryAllowed: false,
              ...(providerMutationSucceeded
                ? { providerMutationSucceeded: true }
                : {}),
              ...(providerOutcomeAmbiguous
                ? { providerOutcomeAmbiguous: true }
                : {}),
              markerPersisted: true,
            }
          : {}),
      },
    );
  }
  const resumeTargets = new Map<
    string,
    Extract<
      Awaited<ReturnType<typeof resolveBulkAdActionTarget>>,
      { ok: true }
    >
  >();
  if (action === "resume") {
    resolvedBatch.forEach(({ ad, result }) => {
      if (result.ok && !manualReconciledNoOps.has(ad.adId)) {
        resumeTargets.set(ad.adId, result);
      }
    });
    const createdAdIds = await readLaunchpadCreatedAdIds({
      businessId: access.businessId,
      adIds: Array.from(resumeTargets.values()).map(
        (target) => target.target.adId,
      ),
    });
    const outOfScope = Array.from(resumeTargets.values()).filter(
      (target) => !createdAdIds.has(target.target.adId),
    );
    if (outOfScope.length > 0) {
      return jsonError(
        403,
        "resume_scope_blocked",
        "Bulk resume is limited to ads created and verified by Launchpad.",
        {
          blockers: outOfScope.map((target) => ({
            adId: target.target.adId,
            code: "not_launchpad_created",
          })),
        },
      );
    }
    if (resumeTargets.size > 0) {
      const preflight = await validateMetaBulkResumePreflight({
        ctx: ctxResult.ctx,
        targets: Array.from(resumeTargets.values()).map((target) => ({
          adId: target.target.adId,
          creativeId: target.target.creativeId,
          providerAccountId: target.target.providerAccountId,
        })),
      });
      if (!preflight.ok) {
        return jsonError(
          400,
          "resume_preflight_blocked",
          "Bulk resume preflight failed. No ads were changed.",
          { blockers: preflight.blockers },
        );
      }
    }
  }
  const ctx = ctxResult.ctx;
  const results: Array<{
    inputAdId: string;
    adId?: string;
    creativeId?: string | null;
    ok: boolean;
    status?: string;
    attemptedIds?: string[];
    dryRun?: true;
    wouldHaveWritten?: MetaAdsWouldHaveWritten;
    providerOutcome?: "definite_failure" | "outcome_ambiguous";
    mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
    retryAllowed?: false;
    reconciliationRequired?: true;
    providerMutationSucceeded?: true;
    providerOutcomeAmbiguous?: true;
    reconciled?: true;
    noOp?: true;
    providerWriteAttempted?: false;
    reconciliationOutcome?: DecisionOriginReconciliationOutcome;
    markerPersisted?: boolean;
    blockingActionLogId?: string;
    blockingOrigin?: string;
    receipt?: DecisionOriginIdempotencyReceipt;
    error?: { code: string; message: string };
  }> = [];
  const steps: Array<{
    kind: "ad";
    index: number;
    name: string;
    status: "success" | "failure" | "silent_failure";
    id?: string;
    creativeId?: string;
    dryRun?: true;
    wouldHaveWritten?: MetaAdsWouldHaveWritten;
    providerOutcome?: "definite_failure" | "outcome_ambiguous";
    mutationAttempt?: MetaProviderMutationAttemptReceipt | null;
    retryAllowed?: false;
    reconciliationRequired?: true;
    providerMutationSucceeded?: true;
    providerOutcomeAmbiguous?: true;
    reconciled?: true;
    noOp?: true;
    providerWriteAttempted?: false;
    reconciliationOutcome?: DecisionOriginReconciliationOutcome;
    markerPersisted?: boolean;
    blockingActionLogId?: string;
    blockingOrigin?: string;
    receipt?: DecisionOriginIdempotencyReceipt;
    adsManagerUrl?: string;
    error?: { code: string; message: string };
  }> = [];
  let haltedReason: {
    code: string;
    message: string;
    reconciliationRequired?: true;
    retryAllowed?: false;
    providerMutationSucceeded?: true;
    providerOutcomeAmbiguous?: true;
    reconciliationOutcome?: DecisionOriginReconciliationOutcome;
    markerPersisted?: boolean;
    blockingActionLogId?: string;
    blockingOrigin?: string;
    receipt?: DecisionOriginIdempotencyReceipt;
  } | null = null;
  let haltedHttpStatus: 409 | 502 | 503 | null = null;
  const preparedClaims = new Map<
    string,
    {
      ad: NormalizedBulkAd;
      log: MetaAdsActionLogRow;
      newlyClaimed: boolean;
    }
  >();
  const manualLiveTargets = new Map<
    string,
    ManualMetaAdStatusMutationTarget
  >();
  const abortedPreparedClaimIds = new Set<string>();
  const abortPreparedClaims = async (input: {
    code: string;
    message: string;
    excludeActionLogIds?: ReadonlySet<string>;
  }) => {
    const outcomes = await Promise.allSettled(
      Array.from(preparedClaims.values())
        .filter(
          (prepared) =>
            prepared.newlyClaimed &&
            !abortedPreparedClaimIds.has(prepared.log.id) &&
            !input.excludeActionLogIds?.has(prepared.log.id),
        )
        .map(async ({ ad, log }) => {
          const completion = {
            id: log.id,
            status: "failure" as const,
            payloadResponse: {
              bulk_pre_provider_abort: {
                code: input.code,
                provider_mutation_attempted: false,
              },
            },
            errorCode: input.code,
            errorMessage: input.message,
          };
          if (ad.decisionOriginRequest) {
            let lastError: unknown = null;
            for (let attempt = 0; attempt < 2; attempt += 1) {
              try {
                await completeDecisionOriginMetaAdsActionLog(completion);
                abortedPreparedClaimIds.add(log.id);
                return;
              } catch (error) {
                lastError = error;
              }
            }
            throw lastError;
          }
          await completeManualTerminalWithRetry(() =>
            completeMetaAdsActionLog(completion),
          );
          abortedPreparedClaimIds.add(log.id);
        }),
    );
    return outcomes.some((outcome) => outcome.status === "rejected");
  };
  const abortPreparedClaimsFromIndex = async (input: {
    index: number;
    includeCurrent: boolean;
    code: string;
    message: string;
  }) => {
    const firstIndex = input.index + (input.includeCurrent ? 0 : 1);
    const includedActionLogIds = new Set(
      ads
        .slice(firstIndex)
        .flatMap((candidate) => {
          const prepared = preparedClaims.get(candidate.adId);
          return prepared?.newlyClaimed ? [prepared.log.id] : [];
        }),
    );
    const excludedActionLogIds = new Set(
      Array.from(preparedClaims.values()).flatMap((prepared) =>
        includedActionLogIds.has(prepared.log.id)
          ? []
          : [prepared.log.id],
      ),
    );
    return abortPreparedClaims({
      code: input.code,
      message: input.message,
      excludeActionLogIds: excludedActionLogIds,
    });
  };

  for (const ad of ads) {
    if (manualReconciledNoOps.has(ad.adId)) continue;
    const nativePreflight = ad.decisionOriginRequest
      ? nativePreflights.get(ad.adId)
      : null;
    if (nativePreflight && !nativePreflight.shouldMutate) {
      continue;
    }
    const targetResult = resolvedTargets.get(ad.adId)!;
    const resolvedAdId = targetResult.target.adId;
    const resolvedCreativeId =
      targetResult.target.creativeId ?? ad.creativeId;
    const manualState = manualInitialStates.get(ad.adId);
    const manualLiveTarget:
      | ManualMetaAdStatusMutationTarget
      | null =
      !ad.decisionOriginRequest && !ad.dryRun && manualState?.ok
        ? {
            businessId: access.businessId,
            providerAccountId: ctx.providerAccountId,
            adId: resolvedAdId,
            creativeId: resolvedCreativeId ?? "",
            campaignId: manualState.campaignId ?? "",
            adsetId: manualState.adsetId ?? "",
          }
        : null;
    if (
      !ad.decisionOriginRequest &&
      !ad.dryRun &&
      (!manualLiveTarget?.creativeId ||
        !manualLiveTarget.campaignId ||
        !manualLiveTarget.adsetId)
    ) {
      const cleanupFailed = await abortPreparedClaims({
        code: "manual_mutation_target_unavailable",
        message:
          "The exact manual mutation target became unavailable before provider execution.",
      });
      return jsonError(
        503,
        "manual_mutation_target_unavailable",
        "The exact manual mutation target is temporarily unavailable; no provider write was attempted.",
        {
          blockers: [
            {
              adId: ad.adId,
              code: "manual_mutation_target_unavailable",
            },
          ],
          retryAllowed: false,
          ...(cleanupFailed
            ? { reconciliationRequired: true }
            : {}),
        },
      );
    }
    if (manualLiveTarget) {
      manualLiveTargets.set(ad.adId, manualLiveTarget);
    }
    const payloadRequest = {
      idempotency_key: idempotencyKey,
      method: "POST",
      endpoint: `/${resolvedAdId}`,
      body: { status: statusOption },
      dry_run: ad.dryRun,
      input_ad_id: ad.adId,
      resolved_from_input_id: targetResult.inputAdId,
      candidate_ad_ids: ad.candidateAdIds,
      ...(!ad.decisionOriginRequest
        ? {
            action_origin: BULK_ACTION_ORIGINS.manualOperator,
            manual_confirmation: "explicit_operator_confirmation",
            ...(!ad.dryRun
              ? {
                  mutation_journal_contract_version:
                    MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
                  mutation_journal_required: true,
                  manual_status_mutation_target: manualLiveTarget!,
                }
              : {}),
          }
        : {}),
    };
    let log: MetaAdsActionLogRow;
    try {
      log = ad.decisionOriginRequest
        ? await createDecisionOriginMetaAdsActionLog({
            request: ad.decisionOriginRequest,
            requestedBy: access.userId,
            payloadRequest,
          })
        : await createMetaAdsActionLog({
            businessId: access.businessId,
            providerAccountId: ctx.providerAccountId,
            adId: resolvedAdId,
            creativeId: resolvedCreativeId,
            action,
            source: "manual_operator_v1",
            requestedBy: access.userId,
            payloadRequest,
          });
    } catch (error) {
      const conflict = metaAdStatusActionClaimConflict(error);
      const cleanupFailed = await abortPreparedClaims({
        code: conflict?.code ?? "bulk_action_claim_unavailable",
        message:
          "Bulk execution stopped before provider mutation because an exact durable claim could not be created.",
      });
      if (conflict) {
        return jsonError(
          cleanupFailed ? 503 : 409,
          conflict.reconciliationRequired
            ? "bulk_reconciliation_required"
            : "bulk_action_in_flight",
          "At least one exact Ad could not obtain its durable claim; no provider write was attempted.",
          {
            blockers: [
              {
                adId: ad.adId,
                code: conflict.code,
                blockingActionLogId:
                  conflict.blockingActionLogId,
                blockingOrigin: conflict.blockingOrigin,
                retryAllowed: false,
                ...(conflict.reconciliationRequired
                  ? { reconciliationRequired: true }
                  : {}),
              },
            ],
            retryAllowed: false,
            ...(conflict.reconciliationRequired || cleanupFailed
              ? { reconciliationRequired: true }
              : {}),
          },
        );
      }
      return jsonError(
        503,
        "bulk_action_claim_unavailable",
        "The durable Ad-action claim state is temporarily unavailable; no provider write was attempted.",
        {
          blockers: [
            {
              adId: ad.adId,
              code: "bulk_action_claim_unavailable",
            },
          ],
          retryAllowed: false,
          ...(cleanupFailed
            ? { reconciliationRequired: true }
            : {}),
        },
      );
    }
    preparedClaims.set(ad.adId, {
      ad,
      log,
      newlyClaimed: log.idempotentReplay !== true,
    });
    if (ad.decisionOriginRequest && log.idempotentReplay) {
      const receipt = decisionOriginIdempotencyReceiptFromLog(
        log,
        ad.decisionOriginRequest.idempotencyKey,
      );
      const replaySucceeded =
        log.status === "success" &&
        receipt.providerVerified === true &&
        receipt.treatmentEligible === true;
      if (!replaySucceeded) {
        const cleanupFailed = await abortPreparedClaims({
          code: "idempotent_action_not_treatment_eligible",
          message:
            "Bulk execution stopped before provider mutation because an idempotent native receipt was not treatment eligible.",
        });
        const reconciliationRequired =
          isDecisionOriginReconciliationReceipt(receipt);
        const providerMutationSucceeded =
          reconciliationRequired &&
          reconciliationReceiptProviderMutationSucceeded(receipt);
        const providerOutcomeAmbiguous =
          reconciliationRequired &&
          receipt.providerOutcomeAmbiguous === true;
        const replayErrorCode = reconciliationRequired
          ? DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
          : log.status === "pending"
            ? META_AD_STATUS_ACTION_IN_FLIGHT_CODE
            : log.status === "failure" ||
                log.status === "silent_failure"
              ? "idempotent_action_failed"
              : "idempotent_receipt_not_treatment_eligible";
        return jsonError(
          cleanupFailed || reconciliationRequired ? 503 : 409,
          reconciliationRequired
            ? "bulk_reconciliation_required"
            : "bulk_action_in_flight",
          "An idempotent native action is not eligible for provider execution; no provider write was attempted.",
          {
            blockers: [
              {
                adId: ad.adId,
                code: replayErrorCode,
                retryAllowed: false,
                ...(reconciliationRequired
                  ? {
                      reconciliationRequired: true,
                      markerPersisted: true,
                    }
                  : {}),
                ...(providerMutationSucceeded
                  ? { providerMutationSucceeded: true }
                  : {}),
                ...(providerOutcomeAmbiguous
                  ? { providerOutcomeAmbiguous: true }
                  : {}),
              },
            ],
            retryAllowed: false,
            ...(reconciliationRequired || cleanupFailed
              ? { reconciliationRequired: true }
              : {}),
            ...(reconciliationRequired
              ? { markerPersisted: true }
              : {}),
            ...(providerMutationSucceeded
              ? { providerMutationSucceeded: true }
              : {}),
            ...(providerOutcomeAmbiguous
              ? { providerOutcomeAmbiguous: true }
              : {}),
          },
        );
      }
    }
  }

  const postClaimChecks = await Promise.all(
    Array.from(preparedClaims.values())
      .filter(
        ({ ad, log }) =>
          !(
            ad.decisionOriginRequest &&
            log.idempotentReplay === true
          ),
      )
      .map(async ({ ad, log }) => {
        const targetResult = resolvedTargets.get(ad.adId)!;
        if (!ad.decisionOriginRequest) {
          const state = await readMetaAdExecutionState(
            ctx,
            targetResult.target.adId,
          ).catch(() => null);
          const preflight = state
            ? evaluateManualMetaAdStatusPreflight({
                action,
                state,
                expectedAdId: targetResult.target.adId,
                expectedCreativeId:
                  targetResult.target.creativeId ??
                  ad.creativeId ??
                  "",
                expectedProviderAccountId:
                  ctx.providerAccountId,
              })
            : {
                ok: false as const,
                blocker:
                  "current_ad_state_unverified" as const,
              };
          const durableTarget = manualLiveTargets.get(ad.adId);
          const targetRemainsExact =
            !durableTarget ||
            (state?.ok === true &&
              state.adId === durableTarget.adId &&
              state.providerAccountId ===
                durableTarget.providerAccountId &&
              state.creativeId === durableTarget.creativeId &&
              state.campaignId === durableTarget.campaignId &&
              state.adsetId === durableTarget.adsetId);
          return {
            ad,
            ok: preflight.ok && targetRemainsExact,
            blocker:
              preflight.ok && !targetRemainsExact
                ? "manual_mutation_target_changed"
                : preflight.ok
                  ? null
                  : preflight.blocker,
          };
        }
        const preflight =
          await runServerDecisionOriginAdActionPreflight({
            request: ad.decisionOriginRequest,
            ctx,
            ignorePendingReceiptActionLogId: log.id,
          }).catch(() => null);
        return {
          ad,
          ok: preflight?.shouldMutate === true,
          blocker:
            preflight?.errorCode ??
            (preflight
              ? "decision_preflight_blocked"
              : "decision_preflight_unavailable"),
        };
      }),
  );
  const postClaimBlockers = postClaimChecks.flatMap(
    ({ ad, ok, blocker }) =>
      ok
        ? []
        : [
            {
              adId: ad.adId,
              code:
                blocker ??
                "post_claim_preflight_blocked",
            },
          ],
  );
  if (postClaimBlockers.length > 0) {
    const cleanupFailed = await abortPreparedClaims({
      code: "bulk_post_claim_preflight_blocked",
      message:
        "Bulk execution stopped before provider mutation because a post-claim preflight failed.",
    });
    const unavailable = postClaimBlockers.some((blocker) =>
      [
        "current_ad_state_unverified",
        "current_hierarchy_state_unverified",
        "decision_preflight_unavailable",
        "kill_switch_state_unavailable",
      ].includes(blocker.code),
    );
    return jsonError(
      cleanupFailed || unavailable ? 503 : 409,
      "bulk_post_claim_preflight_blocked",
      "Every claimed bulk target must pass exact post-claim preflight before the first provider write.",
      {
        blockers: postClaimBlockers,
        retryAllowed: false,
        ...(cleanupFailed
          ? { reconciliationRequired: true }
          : {}),
      },
    );
  }

  let executionCursorIndex = -1;
  let currentProviderMutationMayHaveStarted = false;
  try {
    for (let index = 0; index < ads.length; index += 1) {
      executionCursorIndex = index;
      currentProviderMutationMayHaveStarted = false;
      const ad = ads[index];
      if (!ad) continue;
      const stepName = ad.name || ad.adId;
      const targetResult =
        action === "resume" &&
        !manualReconciledNoOps.has(ad.adId)
          ? resumeTargets.get(ad.adId)!
          : resolvedTargets.get(ad.adId)!;
      if (!targetResult.ok) {
        const error = {
          code: "ad_not_found",
          message: "Ad was not found for this business.",
        };
        results.push({
          inputAdId: ad.adId,
          creativeId: ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "failure",
          creativeId: ad.creativeId ?? undefined,
          error,
        });
        continue;
      }

      const resolvedAdId = targetResult.target.adId;
      const dryRunMetadata = ad.dryRun
        ? {
            dryRun: true as const,
            wouldHaveWritten: expectedAdStatusWrite(
              resolvedAdId,
              statusOption,
            ),
          }
        : {};
      if (
        normalizeMetaLaunchProviderAccountId(
          targetResult.target.providerAccountId,
        ) !== providerAccountId
      ) {
        const error = {
          code: "provider_account_mismatch",
          message: "Ad does not belong to the selected Meta ad account.",
        };
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "failure",
          id: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId ?? undefined,
          error,
        });
        continue;
      }
      if (manualReconciledNoOps.has(ad.adId)) {
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ?? ad.creativeId,
          ok: true,
          status: statusOption,
          attemptedIds: targetResult.attemptedIds,
          reconciled: true,
          noOp: true,
          providerWriteAttempted: false,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "success",
          id: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ??
            ad.creativeId ??
            undefined,
          reconciled: true,
          noOp: true,
          providerWriteAttempted: false,
        });
        continue;
      }
      if (ad.decisionOriginRequest) {
        const preflight = nativePreflights.get(ad.adId)!;
        if (!preflight.shouldMutate) {
          const receipt = preflight.duplicateReceipt;
          const replaySucceeded =
            preflight.disposition === "duplicate" &&
            receipt?.status === "success" &&
            receipt.providerVerified === true &&
            receipt.treatmentEligible === true;
          const error = replaySucceeded
            ? null
            : {
                code:
                  preflight.disposition === "duplicate"
                    ? receipt?.status === "pending"
                      ? "action_in_flight"
                      : receipt?.status === "success"
                        ? "idempotent_receipt_not_treatment_eligible"
                        : "idempotent_action_failed"
                    : preflight.errorCode ?? "decision_preflight_blocked",
                message:
                  preflight.disposition === "duplicate"
                    ? `The existing idempotent action is ${receipt?.status ?? "unavailable"}; no new provider write was attempted.`
                    : `Decision-origin preflight blocked the provider write (${preflight.blockers.join(", ")}).`,
              };
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId: targetResult.target.creativeId ?? ad.creativeId,
            ok: replaySucceeded,
            status:
              replaySucceeded && receipt?.dryRun !== true
                ? statusOption
                : undefined,
            attemptedIds: targetResult.attemptedIds,
            ...(receipt?.dryRun === true ? dryRunMetadata : {}),
            ...(error ? { error } : {}),
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: replaySucceeded ? "success" : "failure",
            id: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId ?? undefined,
            ...(receipt?.dryRun === true ? dryRunMetadata : {}),
            ...(replaySucceeded
              ? receipt?.dryRun === true
                ? {}
                : {
                  adsManagerUrl: adsManagerUrl(
                    ctx.providerAccountId,
                    "ad",
                    resolvedAdId,
                  ),
                  }
              : { error: error! }),
          });
          if (isMetaWriteBlockedCode(error?.code)) {
            haltedReason = error;
            break;
          }
          continue;
        }
      }
      const log = preparedClaims.get(ad.adId)!.log;

      if (ad.decisionOriginRequest && log.idempotentReplay) {
        const replayReceipt = decisionOriginIdempotencyReceiptFromLog(
          log,
          ad.decisionOriginRequest.idempotencyKey,
        );
        const replaySucceeded =
          log.status === "success" &&
          replayReceipt.providerVerified === true &&
          replayReceipt.treatmentEligible === true;
        const reconciliationRequired =
          isDecisionOriginReconciliationReceipt(replayReceipt);
        const providerMutationSucceeded =
          reconciliationRequired &&
          reconciliationReceiptProviderMutationSucceeded(replayReceipt);
        const error = replaySucceeded
          ? null
          : {
              code:
                reconciliationRequired
                  ? DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
                  : log.status === "pending"
                    ? "action_in_flight"
                    : log.status === "success"
                      ? "idempotent_receipt_not_treatment_eligible"
                      : "idempotent_action_failed",
              message: reconciliationRequired
                ? "The prior provider outcome or durable terminal state requires exact reconciliation. No new provider write was attempted."
                : `The existing idempotent action is ${log.status}; no new provider write was attempted.`,
            };
        const reconciliationMetadata = reconciliationRequired
          ? {
              reconciliationRequired: true as const,
              retryAllowed: false as const,
              ...(providerMutationSucceeded
                ? { providerMutationSucceeded: true as const }
                : {}),
              ...(replayReceipt.providerOutcomeAmbiguous === true
                ? { providerOutcomeAmbiguous: true as const }
                : {}),
              markerPersisted: true,
            }
          : {};
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: replaySucceeded,
          status: replaySucceeded && !ad.dryRun ? statusOption : undefined,
          attemptedIds: targetResult.attemptedIds,
          ...dryRunMetadata,
          ...reconciliationMetadata,
          ...(error ? { error } : {}),
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: replaySucceeded ? "success" : "failure",
          id: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ?? ad.creativeId ?? undefined,
          ...dryRunMetadata,
          ...reconciliationMetadata,
          ...(replaySucceeded
            ? ad.dryRun
              ? {}
              : {
                adsManagerUrl: adsManagerUrl(
                  ctx.providerAccountId,
                  "ad",
                  resolvedAdId,
                ),
              }
            : { error: error! }),
        });
        if (!replaySucceeded) {
          haltedReason = {
            ...error!,
            ...reconciliationMetadata,
          };
          if (!reconciliationRequired) {
            haltedHttpStatus = 409;
          }
          break;
        }
        continue;
      }

      if (ad.decisionOriginRequest && !ad.dryRun) {
        const request = ad.decisionOriginRequest;
        const freshPreflight =
          await runServerDecisionOriginAdActionPreflight({
            request,
            ctx,
            ignorePendingReceiptActionLogId: log.id,
          }).catch(() => null);
        let unresolvedOwner: MetaAdsActionLogRow | null = null;
        let ownershipStateAvailable = true;
        try {
          unresolvedOwner =
            await findUnresolvedMetaAdStatusActionLog({
              businessId: request.businessId,
              providerAccountId: request.providerAccountId,
              adId: request.adId,
            });
        } catch {
          ownershipStateAvailable = false;
        }
        const ownsExactUnresolvedSource =
          ownershipStateAvailable &&
          nativeClaimOwnsExactUnresolvedSource({
            unresolved: unresolvedOwner,
            log,
            request,
          });
        if (
          freshPreflight?.shouldMutate !== true ||
          !ownsExactUnresolvedSource
        ) {
          const blockerCode = !ownershipStateAvailable
            ? "reconciliation_state_unavailable"
            : !ownsExactUnresolvedSource
              ? "native_action_claim_ownership_changed"
              : freshPreflight?.errorCode ??
                (freshPreflight
                  ? "decision_preflight_blocked"
                  : "decision_preflight_unavailable");
          const receipt = freshPreflight?.duplicateReceipt ?? null;
          const receiptRequiresReconciliation =
            isDecisionOriginReconciliationReceipt(receipt);
          const reconciliationRequired =
            !ownershipStateAvailable ||
            !ownsExactUnresolvedSource ||
            receiptRequiresReconciliation;
          const cleanupFailed =
            await abortPreparedClaimsFromIndex({
              index,
              includeCurrent: ownsExactUnresolvedSource,
              code: blockerCode,
              message:
                "Bulk execution stopped before the next native provider mutation because its just-in-time authority check failed.",
            });
          const error = {
            code: blockerCode,
            message:
              "The exact native decision authority or claim changed before provider execution; no additional provider write was attempted.",
          };
          const failureMetadata = {
            retryAllowed: false as const,
            providerWriteAttempted: false as const,
            ...(reconciliationRequired || cleanupFailed
              ? { reconciliationRequired: true as const }
              : {}),
            ...(receiptRequiresReconciliation &&
            reconciliationReceiptProviderMutationSucceeded(receipt)
              ? { providerMutationSucceeded: true as const }
              : {}),
            ...(receiptRequiresReconciliation &&
            receipt?.providerOutcomeAmbiguous === true
              ? { providerOutcomeAmbiguous: true as const }
              : {}),
          };
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId,
            ok: false,
            attemptedIds: targetResult.attemptedIds,
            ...failureMetadata,
            error,
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: "failure",
            id: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ??
              ad.creativeId ??
              undefined,
            ...failureMetadata,
            error,
          });
          haltedReason = {
            ...error,
            ...failureMetadata,
          };
          const unavailable =
            !freshPreflight ||
            !ownershipStateAvailable ||
            [
              "decision_preflight_unavailable",
              "kill_switch_state_unavailable",
              "reconciliation_state_unavailable",
            ].includes(blockerCode);
          haltedHttpStatus =
            cleanupFailed || unavailable ? 503 : 409;
          break;
        }
      }

      const startedAt = Date.now();
      const manualAttemptState: {
        started: ManualMetaAdStatusMutationAttemptEvent | null;
      } = { started: null };
      let manualMutationAttemptStartBlocker:
        | "persistence_failed"
        | "idempotent_replay"
        | "target_mismatch"
        | null = null;
      let beforeManualMutationAttempt:
        | ((
            baseline: MetaAdStatusMutationBaseline,
          ) => Promise<void>)
        | undefined;
      if (!ad.decisionOriginRequest && !ad.dryRun) {
        const durableTarget = manualLiveTargets.get(ad.adId)!;
        const freshState = await readMetaAdExecutionState(
          ctx,
          resolvedAdId,
        ).catch(() => null);
        const freshPreflight = freshState
          ? evaluateManualMetaAdStatusPreflight({
              action,
              state: freshState,
              expectedAdId: durableTarget.adId,
              expectedCreativeId: durableTarget.creativeId,
              expectedProviderAccountId:
                durableTarget.providerAccountId,
            })
          : {
              ok: false as const,
              blocker: "current_ad_state_unverified" as const,
            };
        const targetRemainsExact =
          freshState?.ok === true &&
          freshState.adId === durableTarget.adId &&
          freshState.providerAccountId ===
            durableTarget.providerAccountId &&
          freshState.creativeId === durableTarget.creativeId &&
          freshState.campaignId === durableTarget.campaignId &&
          freshState.adsetId === durableTarget.adsetId;
        let unresolvedOwner: MetaAdsActionLogRow | null = null;
        let ownershipStateAvailable = true;
        try {
          unresolvedOwner =
            await findUnresolvedMetaAdStatusActionLog({
              businessId: durableTarget.businessId,
              providerAccountId: durableTarget.providerAccountId,
              adId: durableTarget.adId,
            });
        } catch {
          ownershipStateAvailable = false;
        }
        const ownsExactUnresolvedSource =
          ownershipStateAvailable &&
          manualClaimOwnsExactUnresolvedSource({
            unresolved: unresolvedOwner,
            log,
            target: durableTarget,
            action,
          });
        if (
          !freshPreflight.ok ||
          !targetRemainsExact ||
          !ownsExactUnresolvedSource
        ) {
          const blockerCode = !ownershipStateAvailable
            ? "reconciliation_state_unavailable"
            : !ownsExactUnresolvedSource
              ? "manual_action_claim_ownership_changed"
              : !freshPreflight.ok
                ? freshPreflight.blocker
                : "manual_mutation_target_changed";
          const reconciliationRequired =
            !ownershipStateAvailable ||
            !ownsExactUnresolvedSource;
          const cleanupFailed =
            await abortPreparedClaimsFromIndex({
              index,
              includeCurrent: ownsExactUnresolvedSource,
              code: blockerCode,
              message:
                "Bulk execution stopped before the next provider mutation because its just-in-time authority check failed.",
            });
          const error = {
            code: blockerCode,
            message:
              "The exact manual mutation authority changed before provider execution; no additional provider write was attempted.",
          };
          const failureMetadata = {
            retryAllowed: false as const,
            providerWriteAttempted: false as const,
            ...(reconciliationRequired || cleanupFailed
              ? { reconciliationRequired: true as const }
              : {}),
          };
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId,
            ok: false,
            attemptedIds: targetResult.attemptedIds,
            ...failureMetadata,
            error,
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: "failure",
            id: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ??
              ad.creativeId ??
              undefined,
            ...failureMetadata,
            error,
          });
          haltedReason = {
            ...error,
            retryAllowed: false,
            ...(reconciliationRequired || cleanupFailed
              ? { reconciliationRequired: true }
              : {}),
          };
          haltedHttpStatus =
            !ownershipStateAvailable || cleanupFailed ? 503 : 409;
          break;
        }
        beforeManualMutationAttempt = async (
          baseline: MetaAdStatusMutationBaseline,
        ) => {
          try {
            if (
              baseline.businessId !== durableTarget.businessId ||
              baseline.providerAccountId !==
                durableTarget.providerAccountId ||
              baseline.adId !== durableTarget.adId ||
              baseline.creativeId !== durableTarget.creativeId ||
              baseline.campaignId !== durableTarget.campaignId ||
              baseline.adsetId !== durableTarget.adsetId
            ) {
              manualMutationAttemptStartBlocker =
                "target_mismatch";
              throw Object.assign(
                new Error(
                  "The immediate pre-POST Meta Ad hierarchy differs from the durable manual mutation target.",
                ),
                { code: "manual_mutation_target_drift" },
              );
            }
            const started =
              await appendManualMetaAdStatusMutationAttemptStarted({
                sourceActionLogId: log.id,
                target: durableTarget,
                action,
                postPath: resolvedAdId,
              });
            if (started.idempotentReplay === true) {
              manualMutationAttemptStartBlocker =
                "idempotent_replay";
              throw Object.assign(
                new Error(
                  "An immutable provider-attempt start already exists.",
                ),
                {
                  code:
                    "manual_mutation_attempt_replay_requires_reconciliation",
                },
              );
            }
            manualAttemptState.started = started;
            currentProviderMutationMayHaveStarted = true;
          } catch (error) {
            if (manualMutationAttemptStartBlocker === null) {
              manualMutationAttemptStartBlocker =
                "persistence_failed";
            }
            throw error;
          }
        };
      }
      let result: Awaited<ReturnType<typeof pauseAd>>;
      try {
        currentProviderMutationMayHaveStarted =
          !ad.dryRun && !beforeManualMutationAttempt;
        result =
          action === "pause"
            ? ad.dryRun
              ? await pauseAd(ctx, resolvedAdId, { dryRun: true })
              : beforeManualMutationAttempt
                ? await pauseAd(ctx, resolvedAdId, {
                    beforeMutationAttempt:
                      beforeManualMutationAttempt,
                  })
                : await pauseAd(ctx, resolvedAdId)
            : ad.dryRun
              ? await resumeAd(ctx, resolvedAdId, { dryRun: true })
              : beforeManualMutationAttempt
                ? await resumeAd(ctx, resolvedAdId, {
                    beforeMutationAttempt:
                      beforeManualMutationAttempt,
                  })
                : await resumeAd(ctx, resolvedAdId);
      } catch (providerError) {
        const providerErrorMessage = sanitizeErrorMessage(providerError);
        const providerErrorCode = "provider_write_unexpected_exception";
        if (!ad.decisionOriginRequest) {
          if (!ad.dryRun && manualAttemptState.started) {
            const error = {
              code: "provider_outcome_ambiguous",
              message:
                "The single provider call threw after its immutable attempt start; the action remains quarantined for exact reconciliation.",
            };
            const reconciliationMetadata = {
              reconciliationRequired: true as const,
              retryAllowed: false as const,
              providerOutcomeAmbiguous: true as const,
            };
            results.push({
              inputAdId: ad.adId,
              adId: resolvedAdId,
              creativeId:
                targetResult.target.creativeId ?? ad.creativeId,
              ok: false,
              attemptedIds: targetResult.attemptedIds,
              providerOutcome: "outcome_ambiguous",
              ...reconciliationMetadata,
              error,
            });
            steps.push({
              kind: "ad",
              index,
              name: stepName,
              status: "silent_failure",
              id: resolvedAdId,
              creativeId:
                targetResult.target.creativeId ??
                ad.creativeId ??
                undefined,
              providerOutcome: "outcome_ambiguous",
              ...reconciliationMetadata,
              error,
            });
            haltedReason = {
              ...error,
              ...reconciliationMetadata,
            };
            haltedHttpStatus = 503;
            break;
          }
          if (!ad.dryRun) {
            currentProviderMutationMayHaveStarted = false;
            const terminalCompletion = {
              id: log.id,
              status: "failure" as const,
              payloadResponse: {
                adapter_pre_provider_abort: {
                  code: providerErrorCode,
                  provider_mutation_attempted: false,
                },
              },
              errorCode: providerErrorCode,
              errorMessage: providerErrorMessage,
              durationMs: Date.now() - startedAt,
              verificationPayload: null,
              verifiedAt: null,
            };
            let completionError: unknown = null;
            try {
              await completeManualTerminalWithRetry(() =>
                completeMetaAdsActionLog(terminalCompletion),
              );
            } catch (error) {
              completionError = error;
            }
            const error = completionError
              ? {
                  code:
                    "manual_failure_terminal_persistence_failed",
                  message:
                    "The zero-write adapter failure could not be durably terminalized; no later bulk item was attempted.",
                }
              : {
                  code: providerErrorCode,
                  message: providerErrorMessage,
                };
            const failureMetadata = {
              providerWriteAttempted: false as const,
              retryAllowed: false as const,
              ...(completionError
                ? { reconciliationRequired: true as const }
                : {}),
            };
            results.push({
              inputAdId: ad.adId,
              adId: resolvedAdId,
              creativeId:
                targetResult.target.creativeId ?? ad.creativeId,
              ok: false,
              attemptedIds: targetResult.attemptedIds,
              ...failureMetadata,
              error,
            });
            steps.push({
              kind: "ad",
              index,
              name: stepName,
              status: "failure",
              id: resolvedAdId,
              creativeId:
                targetResult.target.creativeId ??
                ad.creativeId ??
                undefined,
              ...failureMetadata,
              error,
            });
            haltedReason = {
              ...error,
              retryAllowed: false,
              ...(completionError
                ? { reconciliationRequired: true }
                : {}),
            };
            haltedHttpStatus = completionError ? 503 : 502;
            break;
          }
          const ambiguous = !ad.dryRun;
          const terminalStatus = ambiguous
            ? ("silent_failure" as const)
            : ("failure" as const);
          const terminalErrorCode = ambiguous
            ? "provider_outcome_ambiguous"
            : providerErrorCode;
          const terminalCompletion = {
            id: log.id,
            status: terminalStatus,
            payloadResponse: {
              provider_write_exception: {
                mutation_attempted: ambiguous ? null : false,
                outcome: ambiguous
                  ? "outcome_ambiguous"
                  : "definite_failure",
                message: providerErrorMessage,
              },
              ...(ambiguous
                ? {
                    provider_outcome: "outcome_ambiguous",
                    reconciliation_required: true,
                    retry_disposition:
                      "do_not_retry_before_exact_provider_reconciliation",
                  }
                : {}),
            },
            errorCode: terminalErrorCode,
            errorMessage: providerErrorMessage,
            durationMs: Date.now() - startedAt,
          };
          let completionError: unknown = null;
          try {
            await completeManualTerminalWithRetry(() =>
              completeMetaAdsActionLog(terminalCompletion),
            );
          } catch (error) {
            completionError = error;
          }
          const error = completionError
            ? {
                code: ambiguous
                  ? "manual_ambiguous_terminal_persistence_failed"
                  : "manual_failure_terminal_persistence_failed",
                message:
                  "The manual provider outcome could not be durably terminalized; no later bulk item was attempted.",
              }
            : {
                code: terminalErrorCode,
                message: providerErrorMessage,
              };
          const failureMetadata = completionError
            ? {
                reconciliationRequired: true as const,
                retryAllowed: false as const,
                ...(ambiguous
                  ? { providerOutcomeAmbiguous: true as const }
                  : {}),
              }
            : ambiguous
              ? {
                  providerOutcome: "outcome_ambiguous" as const,
                  providerOutcomeAmbiguous: true as const,
                  reconciliationRequired: true as const,
                  retryAllowed: false as const,
                }
              : {};
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId: targetResult.target.creativeId ?? ad.creativeId,
            ok: false,
            attemptedIds: targetResult.attemptedIds,
            ...dryRunMetadata,
            ...failureMetadata,
            error,
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: terminalStatus,
            id: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId ?? undefined,
            ...dryRunMetadata,
            ...failureMetadata,
            error,
          });
          haltedReason = {
            ...error,
            ...(completionError
              ? {
                  reconciliationRequired: true as const,
                  retryAllowed: false as const,
                }
              : ambiguous
                ? {
                    providerOutcomeAmbiguous: true as const,
                    reconciliationRequired: true as const,
                    retryAllowed: false as const,
                  }
                : {}),
          };
          if (completionError) {
            haltedHttpStatus = 503;
          } else if (ambiguous) {
            haltedHttpStatus = 502;
          }
          break;
        }
        let outcome: DecisionOriginReconciliationOutcome | null = null;
        let markerPersisted = false;
        if (ad.dryRun) {
          let completionError: unknown = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await completeDecisionOriginMetaAdsActionLog({
                id: log.id,
                status: "failure",
                payloadResponse: {
                  provider_write_exception: {
                    mutation_attempted: false,
                    message: providerErrorMessage,
                  },
                },
                errorCode: providerErrorCode,
                errorMessage: providerErrorMessage,
                durationMs: Date.now() - startedAt,
              });
              completionError = null;
              break;
            } catch (error) {
              completionError = error;
            }
          }
          if (completionError) {
            outcome = "dry_run_terminal_persistence_failed";
            const marker = await markDecisionOriginActionReconciliationRequired({
              id: log.id,
              outcome,
              providerErrorCode,
              errorMessage: sanitizeErrorMessage(completionError),
              durationMs: Date.now() - startedAt,
            }).catch(() => null);
            markerPersisted = Boolean(marker);
          }
        } else {
          outcome = "provider_outcome_ambiguous";
          const marker = await markDecisionOriginActionReconciliationRequired({
            id: log.id,
            outcome,
            providerErrorCode,
            errorMessage: providerErrorMessage,
            durationMs: Date.now() - startedAt,
          }).catch(() => null);
          markerPersisted = Boolean(marker);
        }
        const error = outcome
          ? {
              code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
              message:
                "The provider call threw unexpectedly and the exact outcome remains quarantined; no later bulk item was attempted.",
            }
          : {
              code: providerErrorCode,
              message: providerErrorMessage,
            };
        const reconciliationMetadata = outcome
          ? {
              reconciliationOutcome: outcome,
              ...reconciliationResponseMetadata({
                outcome,
                markerPersisted,
              }),
            }
          : {};
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
          ...dryRunMetadata,
          ...reconciliationMetadata,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "failure",
          id: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ?? ad.creativeId ?? undefined,
          ...dryRunMetadata,
          ...reconciliationMetadata,
          error,
        });
        haltedReason = {
          ...error,
          ...reconciliationMetadata,
        };
        break;
      }

      currentProviderMutationMayHaveStarted =
        (result.mutationAttempt !== null &&
          result.mutationAttempt !== undefined) ||
        (!result.ok &&
          result.providerMutationAttempted === true) ||
        manualAttemptState.started !== null;

      if (
        !result.ok &&
        manualMutationAttemptStartBlocker ===
          "persistence_failed"
      ) {
        const cleanupFailed =
          await abortPreparedClaimsFromIndex({
            index,
            includeCurrent: true,
            code:
              "manual_mutation_attempt_start_persistence_failed",
            message:
              "Bulk execution stopped before provider mutation because an immutable attempt start could not be persisted.",
          });
        const error = {
          code:
            "manual_mutation_attempt_start_persistence_failed",
          message:
            "The immutable provider-attempt start could not be persisted; no provider write was attempted.",
        };
        const failureMetadata = {
          retryAllowed: false as const,
          providerWriteAttempted: false as const,
          ...(cleanupFailed
            ? { reconciliationRequired: true as const }
            : {}),
        };
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
          ...failureMetadata,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "failure",
          id: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ??
            ad.creativeId ??
            undefined,
          ...failureMetadata,
          error,
        });
        haltedReason = {
          ...error,
          retryAllowed: false,
          ...(cleanupFailed
            ? { reconciliationRequired: true }
            : {}),
        };
        haltedHttpStatus = 503;
        break;
      }

      if (
        !result.ok &&
        manualMutationAttemptStartBlocker ===
          "idempotent_replay"
      ) {
        const cleanupFailed =
          await abortPreparedClaimsFromIndex({
            index,
            includeCurrent: false,
            code:
              "manual_mutation_attempt_replay_requires_reconciliation",
            message:
              "Bulk execution stopped before provider mutation because the immutable attempt start already existed.",
          });
        const error = {
          code:
            "manual_mutation_attempt_replay_requires_reconciliation",
          message:
            "An immutable provider-attempt start already exists for this action; no provider write was attempted.",
        };
        const reconciliationMetadata = {
          reconciliationRequired: true as const,
          retryAllowed: false as const,
          providerWriteAttempted: false as const,
        };
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
          ...reconciliationMetadata,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "failure",
          id: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ??
            ad.creativeId ??
            undefined,
          ...reconciliationMetadata,
          error,
        });
        haltedReason = {
          ...error,
          reconciliationRequired: true,
          retryAllowed: false,
        };
        haltedHttpStatus = cleanupFailed ? 503 : 409;
        break;
      }

      let manualMutationCompletion:
        | ReturnType<typeof manualMutationCompletionForResult>
        | null = null;
      if (!ad.decisionOriginRequest && !ad.dryRun) {
        manualMutationCompletion =
          manualMutationCompletionForResult(result);
        let journalCompletionFailed = false;
        if (manualAttemptState.started) {
          if (!manualMutationCompletion) {
            journalCompletionFailed = true;
          } else {
            try {
              await appendManualMetaAdStatusMutationAttemptCompleted({
                sourceActionLogId: log.id,
                attemptId: manualAttemptState.started.attemptId,
                completionOutcome:
                  manualMutationCompletion.completionOutcome,
                mutationAttempt:
                  manualMutationCompletion.mutationAttempt,
                providerResponse:
                  manualMutationCompletion.providerResponse,
                verification:
                  manualMutationCompletion.verification,
              });
            } catch {
              journalCompletionFailed = true;
            }
          }
        } else if (
          result.ok ||
          result.providerMutationAttempted !== false
        ) {
          // A live result that does not prove a pre-provider stop is a
          // contradiction: never terminalize it as a retryable no-attempt.
          journalCompletionFailed = true;
        }
        if (journalCompletionFailed) {
          const providerMutationSucceeded =
            result.ok ||
            (!result.ok &&
              hasSuccessfulMetaProviderMutationAttempt(result));
          const providerOutcomeAmbiguous =
            !result.ok &&
            (result.error.code === "provider_outcome_ambiguous" ||
              result.providerOutcome === "outcome_ambiguous");
          const error = {
            code:
              "manual_mutation_attempt_completion_persistence_failed",
            message:
              "The provider call was attempted, but its immutable completion could not be persisted; no retry is allowed before exact reconciliation.",
          };
          const reconciliationMetadata = {
            reconciliationRequired: true as const,
            retryAllowed: false as const,
            ...(providerMutationSucceeded
              ? { providerMutationSucceeded: true as const }
              : {}),
            ...(providerOutcomeAmbiguous
              ? { providerOutcomeAmbiguous: true as const }
              : {}),
          };
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId,
            ok: false,
            attemptedIds: targetResult.attemptedIds,
            ...(result.mutationAttempt
              ? { mutationAttempt: result.mutationAttempt }
              : {}),
            ...(result.ok
              ? {}
              : result.providerOutcome
                ? { providerOutcome: result.providerOutcome }
                : {}),
            ...reconciliationMetadata,
            error,
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: "silent_failure",
            id: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ??
              ad.creativeId ??
              undefined,
            ...(result.mutationAttempt
              ? { mutationAttempt: result.mutationAttempt }
              : {}),
            ...(result.ok
              ? {}
              : result.providerOutcome
                ? { providerOutcome: result.providerOutcome }
                : {}),
            ...reconciliationMetadata,
            error,
          });
          haltedReason = {
            ...error,
            ...reconciliationMetadata,
          };
          haltedHttpStatus = 503;
          break;
        }
      }

      if (!result.ok) {
        const failureDurationMs = Date.now() - startedAt;
        const reconciliationOutcome = ad.decisionOriginRequest
          ? reconciliationOutcomeForProviderWriteFailure(result, ad.dryRun)
          : null;
        if (reconciliationOutcome) {
          const marker =
            await markDecisionOriginActionReconciliationRequired({
              id: log.id,
              outcome: reconciliationOutcome,
              providerErrorCode: result.error.code,
              errorMessage: result.error.message,
              mutationAttempt: result.mutationAttempt ?? null,
              providerResponsePayload: ensureRecord(result.responsePayload),
              durationMs: Date.now() - startedAt,
              verificationPayload: ensureRecord(result.verificationPayload),
            }).catch(() => null);
          const error = {
            code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
            message:
              "The provider outcome requires exact reconciliation; the decision-origin action remains pending and no retry is allowed.",
          };
          const reconciliationMetadata = {
            reconciliationOutcome,
            ...reconciliationResponseMetadata({
              outcome: reconciliationOutcome,
              markerPersisted: Boolean(marker),
            }),
          };
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId: targetResult.target.creativeId ?? ad.creativeId,
            ok: false,
            attemptedIds: targetResult.attemptedIds,
            ...dryRunMetadata,
            ...(result.providerOutcome
              ? { providerOutcome: result.providerOutcome }
              : {}),
            ...(result.mutationAttempt
              ? { mutationAttempt: result.mutationAttempt }
              : {}),
            ...reconciliationMetadata,
            error,
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: "failure",
            id: result.resultingAdId ?? resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId ?? undefined,
            ...dryRunMetadata,
            ...(result.providerOutcome
              ? { providerOutcome: result.providerOutcome }
              : {}),
            ...(result.mutationAttempt
              ? { mutationAttempt: result.mutationAttempt }
              : {}),
            ...reconciliationMetadata,
            error,
          });
          haltedReason = {
            ...error,
            ...reconciliationMetadata,
          };
          break;
        }
        if (ad.decisionOriginRequest) {
          let completionError: unknown = null;
          for (let attempt = 0; attempt < 2; attempt += 1) {
            try {
              await completeFailure({
                logId: log.id,
                durationMs: failureDurationMs,
                result,
                decisionOrigin: true,
                dryRun: true,
              });
              completionError = null;
              break;
            } catch (error) {
              completionError = error;
            }
          }
          if (completionError) {
            const outcome: DecisionOriginReconciliationOutcome = ad.dryRun
              ? "dry_run_terminal_persistence_failed"
              : result.mutationAttempt
                ? "provider_rejection_terminal_persistence_failed"
                : "pre_provider_terminal_persistence_failed";
            const marker =
              await markDecisionOriginActionReconciliationRequired({
                id: log.id,
                outcome,
                providerErrorCode: result.error.code,
                errorMessage: sanitizeErrorMessage(completionError),
                mutationAttempt: result.mutationAttempt ?? null,
                providerResponsePayload: ensureRecord(result.responsePayload),
                durationMs: Date.now() - startedAt,
                verificationPayload: ensureRecord(
                  result.verificationPayload,
                ),
              }).catch(() => null);
            const error = {
              code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
              message:
                "Provider-safe terminal persistence failed twice; the action remains pending for reconciliation without another provider write.",
            };
            const reconciliationMetadata = {
              reconciliationOutcome: outcome,
              ...reconciliationResponseMetadata({
                outcome,
                markerPersisted: Boolean(marker),
              }),
            };
            results.push({
              inputAdId: ad.adId,
              adId: resolvedAdId,
              creativeId: targetResult.target.creativeId ?? ad.creativeId,
              ok: false,
              attemptedIds: targetResult.attemptedIds,
              ...dryRunMetadata,
              ...reconciliationMetadata,
              error,
            });
            steps.push({
              kind: "ad",
              index,
              name: stepName,
              status: "failure",
              id: resolvedAdId,
              creativeId:
                targetResult.target.creativeId ??
                ad.creativeId ??
                undefined,
              ...dryRunMetadata,
              ...reconciliationMetadata,
              error,
            });
            haltedReason = {
              ...error,
              ...reconciliationMetadata,
            };
            break;
          }
        } else {
          let completionError: unknown = null;
          try {
            await completeManualTerminalWithRetry(() =>
              completeFailure({
                logId: log.id,
                durationMs: failureDurationMs,
                result,
                decisionOrigin: false,
                dryRun: ad.dryRun,
                manualMutationCompletion,
              }),
            );
          } catch (error) {
            completionError = error;
          }
          if (completionError) {
            const error = {
              code: "manual_failure_terminal_persistence_failed",
              message:
                "The provider failure could not be durably terminalized; no later bulk item was attempted.",
            };
            const failureMetadata = {
              reconciliationRequired: true as const,
              retryAllowed: false as const,
            };
            results.push({
              inputAdId: ad.adId,
              adId: resolvedAdId,
              creativeId: targetResult.target.creativeId ?? ad.creativeId,
              ok: false,
              attemptedIds: targetResult.attemptedIds,
              ...dryRunMetadata,
              ...failureMetadata,
              error,
            });
            steps.push({
              kind: "ad",
              index,
              name: stepName,
              status: "failure",
              id: resolvedAdId,
              creativeId:
                targetResult.target.creativeId ??
                ad.creativeId ??
                undefined,
              ...dryRunMetadata,
              ...failureMetadata,
              error,
            });
            haltedReason = {
              ...error,
              ...failureMetadata,
            };
            haltedHttpStatus = 503;
            break;
          }
        }
        const status = getFailureLogStatus(result);
        const manualReconciliationMetadata =
          !ad.decisionOriginRequest
            ? manualTerminalReconciliationMetadata(result, ad.dryRun)
            : {};
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
          ...dryRunMetadata,
          ...(result.providerOutcome
            ? { providerOutcome: result.providerOutcome }
            : {}),
          ...(result.mutationAttempt
            ? { mutationAttempt: result.mutationAttempt }
            : {}),
          ...(shouldSuppressProviderRetry(result)
            ? { retryAllowed: false as const }
            : {}),
          ...manualReconciliationMetadata,
          error: result.error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status,
          id: result.resultingAdId ?? resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId ?? undefined,
          ...dryRunMetadata,
          ...(result.providerOutcome
            ? { providerOutcome: result.providerOutcome }
            : {}),
          ...(result.mutationAttempt
            ? { mutationAttempt: result.mutationAttempt }
            : {}),
          ...(shouldSuppressProviderRetry(result)
            ? { retryAllowed: false as const }
            : {}),
          ...manualReconciliationMetadata,
          error: result.error,
        });
        // D065: every just-in-time item failure stops the remaining chain.
        // A pre-provider read/preflight failure is still unsafe to step over
        // because a later item may otherwise perform a provider mutation.
        haltedReason = {
          ...result.error,
          ...manualReconciliationMetadata,
        };
        if (
          !ad.decisionOriginRequest &&
          !ad.dryRun &&
          status === "silent_failure"
        ) {
          haltedHttpStatus = 502;
        }
        break;
      }

      const successCompletion = {
        id: log.id,
        status: "success" as const,
        payloadResponse:
          manualMutationCompletion
            ? manualMutationCompletion.providerResponse
            : ensureRecord(result.responsePayload),
        durationMs: Date.now() - startedAt,
        providerCompletedAt: result.mutationAttempt?.completedAt ?? null,
        verificationPayload:
          manualMutationCompletion
            ? manualMutationCompletion.verification
            : ensureRecord(result.verificationPayload),
      };
      let completedLog = null;
      if (ad.decisionOriginRequest) {
        let completionError: unknown = null;
        const completionAttempts = ad.dryRun ? 2 : 1;
        for (let attempt = 0; attempt < completionAttempts; attempt += 1) {
          try {
            completedLog =
              await completeDecisionOriginMetaAdsActionLog(successCompletion);
            completionError = null;
            break;
          } catch (error) {
            completionError = error;
          }
        }
        if (completionError) {
          const outcome: DecisionOriginReconciliationOutcome = ad.dryRun
            ? "dry_run_terminal_persistence_failed"
            : isDecisionOriginVerificationMismatchError(completionError)
              ? "provider_response_succeeded_verification_failed"
              : "provider_write_verified_receipt_persistence_failed";
          const error = {
            code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
            message:
              ad.dryRun
                ? "Dry-run terminal persistence failed twice; the non-mutation action remains pending for reconciliation."
                : "The provider write or its exact verification requires durable reconciliation before any retry.",
          };
          const marker = await markDecisionOriginActionReconciliationRequired({
            id: log.id,
            outcome,
            providerErrorCode:
              isDecisionOriginVerificationMismatchError(completionError)
                ? completionError.code
                : "receipt_persistence_failed",
            errorMessage: sanitizeErrorMessage(completionError),
            providerResponsePayload: ensureRecord(result.responsePayload),
            durationMs: Date.now() - startedAt,
            verificationPayload: ensureRecord(result.verificationPayload),
            providerCompletedAt:
              result.mutationAttempt?.completedAt ?? null,
            mutationAttempt: result.mutationAttempt ?? null,
          }).catch(() => null);
          const reconciliationMetadata = {
            reconciliationOutcome: outcome,
            ...reconciliationResponseMetadata({
              outcome,
              markerPersisted: Boolean(marker),
            }),
          };
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId: targetResult.target.creativeId ?? ad.creativeId,
            ok: false,
            attemptedIds: targetResult.attemptedIds,
            ...reconciliationMetadata,
            error,
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: "failure",
            id: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId ?? undefined,
            ...reconciliationMetadata,
            error,
          });
          haltedReason = {
            ...error,
            ...reconciliationMetadata,
          };
          break;
        }
      }
      if (!ad.decisionOriginRequest) {
        const exactObservedAt =
          manualMutationCompletion?.verification &&
          typeof manualMutationCompletion.verification.observedAt ===
            "string"
            ? manualMutationCompletion.verification.observedAt
            : null;
        const verifiedAt = ad.dryRun ? null : exactObservedAt;
        let completionError: unknown = null;
        try {
          await completeManualTerminalWithRetry(() =>
            completeMetaAdsActionLog({
              ...successCompletion,
              verifiedAt,
            }),
          );
        } catch (error) {
          completionError = error;
        }
        if (completionError) {
          const error = {
            code: "manual_success_terminal_persistence_failed",
            message: ad.dryRun
              ? "The dry-run success could not be durably terminalized; no later bulk item was attempted."
              : "The provider write was verified, but its durable terminal success could not be confirmed. Do not retry before exact reconciliation.",
          };
          const reconciliationMetadata = {
            reconciliationRequired: true as const,
            retryAllowed: false as const,
            ...(!ad.dryRun
              ? { providerMutationSucceeded: true as const }
              : {}),
          };
          results.push({
            inputAdId: ad.adId,
            adId: resolvedAdId,
            creativeId: targetResult.target.creativeId ?? ad.creativeId,
            ok: false,
            attemptedIds: targetResult.attemptedIds,
            ...dryRunMetadata,
            ...reconciliationMetadata,
            error,
          });
          steps.push({
            kind: "ad",
            index,
            name: stepName,
            status: "failure",
            id: resolvedAdId,
            creativeId:
              targetResult.target.creativeId ?? ad.creativeId ?? undefined,
            ...dryRunMetadata,
            ...reconciliationMetadata,
            error,
          });
          haltedReason = {
            ...error,
            ...reconciliationMetadata,
          };
          haltedHttpStatus = 503;
          break;
        }
      }
      if (
        completedLog &&
        (completedLog.status === "failure" ||
          completedLog.status === "silent_failure")
      ) {
        const error = {
          code: completedLog.errorCode ?? "silent_failure",
          message:
            completedLog.errorMessage ??
            "Provider verification did not preserve the exact native Ad lineage.",
        };
        results.push({
          inputAdId: ad.adId,
          adId: resolvedAdId,
          creativeId: targetResult.target.creativeId ?? ad.creativeId,
          ok: false,
          attemptedIds: targetResult.attemptedIds,
          error,
        });
        steps.push({
          kind: "ad",
          index,
          name: stepName,
          status: "silent_failure",
          id: resolvedAdId,
          creativeId:
            targetResult.target.creativeId ?? ad.creativeId ?? undefined,
          error,
        });
        haltedReason = error;
        break;
      }
      results.push({
        inputAdId: ad.adId,
        adId: resolvedAdId,
        creativeId: targetResult.target.creativeId ?? ad.creativeId,
        ok: true,
        status: ad.dryRun ? undefined : result.verifiedStatus,
        attemptedIds: targetResult.attemptedIds,
        ...(ad.dryRun
          ? {
              dryRun: true as const,
              wouldHaveWritten:
                result.wouldHaveWritten ??
                expectedAdStatusWrite(resolvedAdId, statusOption),
            }
          : {}),
      });
      steps.push({
        kind: "ad",
        index,
        name: stepName,
        status: "success",
        id: resolvedAdId,
        creativeId: targetResult.target.creativeId ?? ad.creativeId ?? undefined,
        ...(ad.dryRun
          ? {
              dryRun: true as const,
              wouldHaveWritten:
                result.wouldHaveWritten ??
                expectedAdStatusWrite(resolvedAdId, statusOption),
            }
          : {
              adsManagerUrl: adsManagerUrl(
                ctx.providerAccountId,
                "ad",
                resolvedAdId,
              ),
            }),
      });
    }

    if (haltedReason && executionCursorIndex >= 0) {
      const cleanupFailed = await abortPreparedClaimsFromIndex({
        index: executionCursorIndex,
        includeCurrent: false,
        code: "bulk_execution_halted_before_provider",
        message:
          "Bulk execution halted after an earlier item; this prepared claim never reached a provider mutation.",
      });
      if (cleanupFailed) {
        haltedReason = {
          ...haltedReason,
          message:
            `${haltedReason.message} ` +
            "At least one untouched later claim could not be durably aborted.",
          reconciliationRequired: true,
          retryAllowed: false,
        };
        haltedHttpStatus = 503;
      }
    }

    const failedCount = results.filter((result) => !result.ok).length;
    const successCount = results.length - failedCount;
    const hasDryRun = ads.some((ad) => ad?.dryRun === true);
    const allDryRun =
      ads.length > 0 && ads.every((ad) => ad?.dryRun === true);
    return NextResponse.json(
      {
        ok: failedCount === 0 && !haltedReason,
        action,
        status: hasDryRun ? null : statusOption,
        ...(hasDryRun
          ? {
              dryRun: allDryRun,
              executionMode: allDryRun ? "dry_run" : "mixed",
            }
          : {}),
        results,
        steps,
        successCount,
        failedCount,
        halted: Boolean(haltedReason),
        haltedReason,
        omittedCount: ads.length - results.length,
        adIds: results.flatMap((result) => result.adId ?? []),
      },
      {
        status:
          haltedHttpStatus ??
          (haltedReason?.code ===
          DECISION_ORIGIN_PENDING_RECONCILIATION_CODE
            ? 409
            : isMetaWriteBlockedCode(haltedReason?.code) ||
          haltedReason?.reconciliationRequired === true
            ? 503
            : haltedReason
              ? 502
              : 200),
      },
    );
  } catch (error) {
    const cleanupFailed =
      executionCursorIndex >= 0
        ? await abortPreparedClaimsFromIndex({
            index: executionCursorIndex,
            includeCurrent: !currentProviderMutationMayHaveStarted,
            code: "bulk_execution_exception_before_provider",
            message:
              "Bulk execution stopped unexpectedly before these prepared claims reached a provider mutation.",
          })
        : await abortPreparedClaims({
            code: "bulk_execution_exception_before_provider",
            message:
              "Bulk execution stopped unexpectedly before these prepared claims reached a provider mutation.",
          });
    return jsonError(
      cleanupFailed ? 503 : 500,
      "bulk_ad_status_failed",
      sanitizeErrorMessage(error),
      {
      action,
      results,
      steps,
      successCount: results.filter((result) => result.ok).length,
      failedCount: results.filter((result) => !result.ok).length,
      adIds: results.flatMap((result) => result.adId ?? []),
        ...(cleanupFailed
          ? {
              reconciliationRequired: true,
              retryAllowed: false,
            }
          : {}),
      },
    );
  }
}
