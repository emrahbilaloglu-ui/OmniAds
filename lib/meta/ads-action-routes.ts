import { NextRequest, NextResponse } from "next/server";
import { requireBusinessAccess } from "@/lib/access";
import { getIntegration } from "@/lib/integrations";
import { rejectIfMetaWritesBlocked } from "@/lib/meta/automation-write-guard";
import { rejectIfReviewerReadOnly } from "@/lib/meta/reviewer-write-guard";
import {
  DECISION_ORIGIN_PENDING_RECONCILIATION_CODE,
  DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
  META_AD_STATUS_RECONCILIATION_REQUIRED_CODE,
  appendManualMetaAdStatusMutationAttemptCompleted,
  appendManualMetaAdStatusMutationAttemptStarted,
  claimMetaAdDuplicateAction,
  completeDecisionOriginMetaAdsActionLog,
  completeMetaAdsActionLog,
  createDecisionOriginMetaAdsActionLog,
  createMetaAdsActionLog,
  decisionOriginIdempotencyReceiptFromLog,
  findUnresolvedDecisionOriginPendingAction,
  hasRecentPendingMetaAdsAction,
  listRecentMetaAdsActionLogs,
  markDecisionOriginActionReconciliationRequired,
  resolveExactMetaAdActionTarget,
  resolveMetaAdActionTarget,
  type MetaAdsActionKind,
  type MetaAdsActionLogRow,
  type MetaAdsActionStatus,
  type DecisionOriginReconciliationOutcome,
  type ManualMetaAdStatusMutationAttemptEvent,
  type ManualMetaAdStatusMutationCompletionOutcome,
  type ManualMetaAdStatusMutationTarget,
  type ManualMetaProviderMutationAttemptReceipt,
} from "@/lib/meta/ads-action-log";
import { runServerDecisionOriginAdActionPreflight } from "@/lib/meta/decision-origin-action-preflight";
import { reconcileManualMetaAdStatusBlocker } from "@/lib/meta/manual-ad-status-reconciliation";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  validateDecisionOriginAdExecutionRequest,
  type DecisionOriginAdExecutionRequest,
  type DecisionOriginIdempotencyReceipt,
} from "@/lib/creative-decision-engine/execution-safety";
import {
  duplicateAd,
  hasSuccessfulMetaProviderMutationAttempt,
  pauseAd,
  redactMetaAdDuplicateProviderEvidence,
  readMetaAdExecutionState,
  readMetaEntityExecutionState,
  resumeAd,
  type MetaAdExecutionStateRead,
  type MetaAdStatusMutationBaseline,
  type MetaAdStatusWriteSuccess,
  type MetaAdsWriteContext,
  type MetaAdsWriteFailure,
  type MetaProviderMutationAttemptReceipt,
} from "@/lib/meta/ads-write";
import {
  appendMetaAdDuplicateAttemptStarted,
  buildMetaAdDuplicateCanonicalName,
  createMetaAdDuplicateMarker,
  finalizeMetaAdDuplicateAttempt,
  finalizeMetaAdDuplicatePreProviderFailure,
  type MetaAdDuplicateMutationReceipt,
} from "@/lib/meta/duplicate-ad-reconciliation-store";
import {
  META_ACTION_ORIGIN_ALIAS_FIELDS,
  META_MANUAL_EXECUTION_FIELDS,
  META_NATIVE_LINEAGE_FIELDS,
  hasInvalidMetaDryRunField,
  presentMetaActionContractFields,
} from "@/lib/launchpad/meta-manual-authority";

type RouteParams = { params: Promise<{ adId: string }> };
export const META_AD_ACTION_ORIGINS = {
  nativeDecision: "native_decision_v1",
  manualOperator: "manual_operator_v1",
} as const;
type MetaAdActionOrigin =
  (typeof META_AD_ACTION_ORIGINS)[keyof typeof META_AD_ACTION_ORIGINS];

interface ActionBody {
  actionOrigin?: string;
  manualConfirmation?: string;
  contractVersion?: string;
  businessId?: string;
  providerAccountId?: string;
  adId?: string;
  snapshotId?: string;
  evaluationId?: string;
  engineVersion?: string;
  decisionHash?: string;
  action?: string;
  idempotencyKey?: string;
  creativeId?: string | null;
  targetAdsetId?: string;
  name?: string;
  activateAfterCreate?: boolean;
  recId?: string;
  recIdOrigin?: string;
  dryRun?: unknown;
}

function stringField(value: unknown) {
  return typeof value === "string" ? value.trim() : "";
}

function jsonError(
  status: number,
  code: string,
  message: string,
  extra?: Record<string, unknown>,
) {
  return NextResponse.json(
    { ok: false, error: { code, message, ...(extra ?? {}) } },
    { status },
  );
}

function sanitizeErrorMessage(error: unknown) {
  return (error instanceof Error ? error.message : String(error))
    .replace(/access_token=[^&\s]+/gi, "access_token=[redacted]")
    .replace(/Bearer\s+[A-Za-z0-9._~-]+/gi, "Bearer [redacted]");
}

function ensureRecord(value: Record<string, unknown> | null | undefined) {
  return value ?? null;
}

function recIdOriginFromBody(body: ActionBody | null) {
  return body?.recIdOrigin?.trim() || body?.recId?.trim() || null;
}

function dryRunFromBody(body: ActionBody | null) {
  return body?.dryRun === true;
}

function decisionOriginFieldsPresent(body: ActionBody | null) {
  return (
    presentMetaActionContractFields(body, META_NATIVE_LINEAGE_FIELDS).length >
    0
  );
}

function parseDecisionOriginRequest(input: {
  body: ActionBody | null;
  pathAdId: string;
  action: MetaAdsActionKind;
}):
  | {
      ok: true;
      actionOrigin: MetaAdActionOrigin;
      request: DecisionOriginAdExecutionRequest | null;
    }
  | { ok: false; response: NextResponse } {
  const body = input.body;
  const actionOrigin = stringField(body?.actionOrigin);
  if (hasInvalidMetaDryRunField(body)) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_dry_run",
        "dryRun must be a JSON boolean when provided.",
      ),
    };
  }
  if (
    presentMetaActionContractFields(
      body,
      META_ACTION_ORIGIN_ALIAS_FIELDS,
    ).length > 0
  ) {
    return {
      ok: false,
      response: jsonError(
        400,
        "mixed_action_origin_contract",
        "The request must carry exactly one canonical, non-conflicting action origin.",
      ),
    };
  }
  if (
    actionOrigin !== META_AD_ACTION_ORIGINS.nativeDecision &&
    actionOrigin !== META_AD_ACTION_ORIGINS.manualOperator
  ) {
    return {
      ok: false,
      response: jsonError(
        400,
        "action_origin_required",
        "actionOrigin must explicitly select the native-decision or manual-operator contract.",
      ),
    };
  }
  if (
    actionOrigin === META_AD_ACTION_ORIGINS.nativeDecision &&
    presentMetaActionContractFields(body, META_MANUAL_EXECUTION_FIELDS).length >
      0
  ) {
    return {
      ok: false,
      response: jsonError(
        400,
        "mixed_action_origin_contract",
        "Native-decision actions cannot carry manual execution fields.",
      ),
    };
  }
  if (actionOrigin === META_AD_ACTION_ORIGINS.manualOperator) {
    if (decisionOriginFieldsPresent(body)) {
      return {
        ok: false,
        response: jsonError(
          400,
          "mixed_action_origin_contract",
          "Manual-operator actions cannot carry partial decision-origin fields.",
        ),
      };
    }
    if (body?.manualConfirmation !== "explicit_operator_confirmation") {
      return {
        ok: false,
        response: jsonError(
          400,
          "manual_confirmation_required",
          "Manual-operator actions require explicit operator confirmation.",
        ),
      };
    }
    if (
      !body?.providerAccountId?.trim() ||
      !body?.adId?.trim() ||
      !body?.creativeId?.trim()
    ) {
      return {
        ok: false,
        response: jsonError(
          400,
          "exact_ad_authority_required",
          "Manual-operator actions require the server-presented providerAccountId, adId, and creativeId.",
        ),
      };
    }
    if (body.adId.trim() !== input.pathAdId) {
      return {
        ok: false,
        response: jsonError(
          400,
          "ad_identity_mismatch",
          "Manual-operator adId must exactly match the route ad.",
        ),
      };
    }
    return { ok: true, actionOrigin, request: null };
  }
  if (
    body?.contractVersion !== DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION
  ) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_decision_origin_contract",
        "Decision-origin fields require the exact supported contractVersion.",
      ),
    };
  }
  const request: DecisionOriginAdExecutionRequest = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId: body.businessId?.trim() ?? "",
    providerAccountId: body.providerAccountId?.trim() ?? "",
    adId: body.adId?.trim() ?? "",
    snapshotId: body.snapshotId?.trim() ?? "",
    evaluationId: body.evaluationId?.trim() ?? "",
    engineVersion: body.engineVersion?.trim() ?? "",
    decisionHash: body.decisionHash?.trim() ?? "",
    action: body.action?.trim() ?? "",
    idempotencyKey: body.idempotencyKey?.trim() ?? "",
    creativeId: body.creativeId?.trim() || "",
    ...(body.dryRun === true ? { dryRun: true } : {}),
  };
  const blockers = validateDecisionOriginAdExecutionRequest(request);
  if (
    blockers.length > 0 ||
    request.adId !== input.pathAdId ||
    request.action !== input.action
  ) {
    return {
      ok: false,
      response: jsonError(
        400,
        "invalid_decision_origin_lineage",
        "Decision-origin request does not match the exact route ad/action lineage.",
        {
          blockers: [
            ...blockers,
            ...(request.adId !== input.pathAdId ? ["route_ad_mismatch"] : []),
            ...(request.action !== input.action
              ? ["route_action_mismatch"]
              : []),
          ],
        },
      ),
    };
  }
  return { ok: true, actionOrigin, request };
}

export function evaluateManualMetaAdStatusPreflight(input: {
  action: Extract<MetaAdsActionKind, "pause" | "resume">;
  state: MetaAdExecutionStateRead;
  expectedAdId: string;
  expectedCreativeId: string;
  expectedProviderAccountId: string;
}) {
  if (!input.state.ok) {
    return {
      ok: false as const,
      blocker:
        input.state.preflightBlocker ?? "current_ad_state_unverified",
    };
  }
  const normalized = (value: string | null) =>
    value?.trim().toUpperCase() || null;
  const normalizedAccount = (value: string | null) => {
    const numeric = value?.trim().replace(/^act_/, "") ?? "";
    return numeric ? `act_${numeric}` : null;
  };
  if (
    input.state.adId !== input.expectedAdId ||
    input.state.creativeId !== input.expectedCreativeId
  ) {
    return {
      ok: false as const,
      blocker: "ad_identity_mismatch" as const,
    };
  }
  if (
    normalizedAccount(input.state.providerAccountId) !==
    normalizedAccount(input.expectedProviderAccountId)
  ) {
    return {
      ok: false as const,
      blocker: "provider_account_mismatch" as const,
    };
  }
  if (
    !input.state.campaignId ||
    !input.state.adsetId ||
    !normalized(input.state.campaignConfiguredStatus) ||
    !normalized(input.state.campaignEffectiveStatus) ||
    !normalized(input.state.adsetConfiguredStatus) ||
    !normalized(input.state.adsetEffectiveStatus)
  ) {
    return {
      ok: false as const,
      blocker: "current_hierarchy_state_unverified" as const,
    };
  }
  if (
    normalized(input.state.campaignConfiguredStatus) !== "ACTIVE" ||
    normalized(input.state.campaignEffectiveStatus) !== "ACTIVE" ||
    normalized(input.state.adsetConfiguredStatus) !== "ACTIVE" ||
    normalized(input.state.adsetEffectiveStatus) !== "ACTIVE"
  ) {
    return {
      ok: false as const,
      blocker: "current_hierarchy_state_incompatible" as const,
    };
  }
  if (input.state.policyEligible !== true) {
    return {
      ok: false as const,
      blocker:
        input.state.policyEligible === null
          ? ("policy_state_unverified" as const)
          : ("policy_blocked" as const),
    };
  }
  const expectedStatus = input.action === "pause" ? "ACTIVE" : "PAUSED";
  if (
    normalized(input.state.configuredStatus) !== expectedStatus ||
    normalized(input.state.effectiveStatus) !== expectedStatus
  ) {
    return {
      ok: false as const,
      blocker: "ad_status_incompatible" as const,
    };
  }
  return { ok: true as const, blocker: null };
}

export function evaluateManualMetaAdDuplicatePreflight(input: {
  sourceState: MetaAdExecutionStateRead;
  targetState: Awaited<ReturnType<typeof readMetaEntityExecutionState>>;
  expectedAdId: string;
  expectedCreativeId: string;
  expectedProviderAccountId: string;
  expectedTargetAdsetId: string;
}) {
  if (!input.sourceState.ok) {
    return {
      ok: false as const,
      blocker:
        input.sourceState.preflightBlocker ?? "current_ad_state_unverified",
    };
  }
  const normalizedAccount = (value: string | null) => {
    const numeric = value?.trim().replace(/^act_/, "") ?? "";
    return numeric ? `act_${numeric}` : null;
  };
  if (
    input.sourceState.adId !== input.expectedAdId ||
    input.sourceState.creativeId !== input.expectedCreativeId
  ) {
    return {
      ok: false as const,
      blocker: "ad_identity_mismatch" as const,
    };
  }
  if (
    normalizedAccount(input.sourceState.providerAccountId) !==
      normalizedAccount(input.expectedProviderAccountId)
  ) {
    return {
      ok: false as const,
      blocker: "provider_account_mismatch" as const,
    };
  }
  if (!input.targetState.ok) {
    return {
      ok: false as const,
      blocker:
        input.targetState.error.code === "provider_account_mismatch"
          ? ("provider_account_mismatch" as const)
          : input.targetState.error.code === "entity_identity_mismatch"
            ? ("current_hierarchy_identity_mismatch" as const)
            : ("current_hierarchy_state_unverified" as const),
    };
  }
  if (
    normalizedAccount(input.targetState.providerAccountId) !==
      normalizedAccount(input.expectedProviderAccountId)
  ) {
    return {
      ok: false as const,
      blocker: "provider_account_mismatch" as const,
    };
  }
  if (input.sourceState.policyEligible !== true) {
    return {
      ok: false as const,
      blocker:
        input.sourceState.policyEligible === null
          ? ("policy_state_unverified" as const)
          : ("policy_blocked" as const),
    };
  }
  const upper = (value: string | null) =>
    value?.trim().toUpperCase() || null;
  if (
    input.targetState.entityId !== input.expectedTargetAdsetId ||
    !input.targetState.campaignId
  ) {
    return {
      ok: false as const,
      blocker: "current_hierarchy_identity_mismatch" as const,
    };
  }
  if (
    upper(input.targetState.configuredStatus) !== "ACTIVE" ||
    upper(input.targetState.effectiveStatus) !== "ACTIVE" ||
    upper(input.targetState.campaignConfiguredStatus) !== "ACTIVE" ||
    upper(input.targetState.campaignEffectiveStatus) !== "ACTIVE" ||
    normalizedAccount(input.targetState.campaignProviderAccountId) !==
      normalizedAccount(input.expectedProviderAccountId)
  ) {
    return {
      ok: false as const,
      blocker: "current_hierarchy_state_incompatible" as const,
    };
  }
  return { ok: true as const, blocker: null };
}

function adsManagerAdUrl(accountNumericId: string, adId: string | null | undefined) {
  const selectedAdId = adId?.trim();
  if (!selectedAdId) return null;
  return `https://adsmanager.facebook.com/adsmanager/manage/ads/edit?act=${encodeURIComponent(
    accountNumericId,
  )}&selected_ad_ids=${encodeURIComponent(selectedAdId)}`;
}

async function readActionBody(request: NextRequest): Promise<ActionBody | null> {
  const body = (await request.json().catch(() => null)) as ActionBody | null;
  return body && typeof body === "object" ? body : null;
}

async function resolveWriteContext(input: {
  businessId: string;
  providerAccountId: string | null;
}): Promise<
  | { ok: true; ctx: MetaAdsWriteContext }
  | { ok: false; response: NextResponse }
> {
  const integration = await getIntegration(input.businessId, "meta").catch(
    () => null,
  );
  if (integration?.status !== "connected" || !integration.access_token) {
    return {
      ok: false,
      response: jsonError(
        502,
        "meta_not_connected",
        "Meta integration is not connected or has no usable access token.",
      ),
    };
  }
  const providerAccountId =
    input.providerAccountId ?? integration.provider_account_id ?? null;
  if (!providerAccountId) {
    return {
      ok: false,
      response: jsonError(
        502,
        "meta_account_unresolved",
        "Could not resolve the Meta ad account for this ad.",
      ),
    };
  }
  return {
    ok: true,
    ctx: {
      businessId: input.businessId,
      providerAccountId,
      accessToken: integration.access_token,
    },
  };
}

function reconciliationReceiptProvesProviderMutationSucceeded(
  receipt: DecisionOriginIdempotencyReceipt | null | undefined,
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

function decisionOriginReplayResponse(input: {
  action: MetaAdsActionKind;
  adId: string;
  receipt: DecisionOriginIdempotencyReceipt;
}) {
  const succeeded =
    input.receipt.status === "success" &&
    input.receipt.providerVerified === true &&
    input.receipt.treatmentEligible === true;
  const pending = input.receipt.status === "pending";
  const reconciliationRequired =
    pending && input.receipt.reconciliationRequired === true;
  const providerMutationSucceeded =
    reconciliationReceiptProvesProviderMutationSucceeded(input.receipt);
  const providerOutcomeAmbiguous =
    input.receipt.providerOutcomeAmbiguous === true;
  return NextResponse.json(
    {
      ok: succeeded,
      action: input.action,
      adId: input.adId,
      status:
        succeeded && input.action === "pause"
          ? "PAUSED"
          : succeeded && input.action === "resume"
            ? "ACTIVE"
            : null,
      duplicate: true,
      receipt: input.receipt,
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
          }
        : {}),
      ...(!succeeded
        ? {
            error: {
              code: reconciliationRequired
                ? DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
                : pending
                  ? "action_in_flight"
                  : input.receipt.status === "success"
                    ? "idempotent_receipt_not_treatment_eligible"
                    : "idempotent_action_failed",
              message: reconciliationRequired
                ? "The prior provider outcome or durable terminal state still requires exact reconciliation; no new provider write was attempted."
                : `The existing idempotent action is ${input.receipt.status}; no new provider write was attempted.`,
            },
          }
        : {}),
    },
    { status: pending ? 409 : 200 },
  );
}

export interface MetaAdStatusActionClaimConflictLike {
  code:
    | "action_in_flight"
    | typeof META_AD_STATUS_RECONCILIATION_REQUIRED_CODE
    | typeof DECISION_ORIGIN_PENDING_RECONCILIATION_CODE
    | typeof DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE;
  blockingActionLogId: string;
  blockingOrigin: string;
  reconciliationRequired: boolean;
  reconciliationReceipt: DecisionOriginIdempotencyReceipt | null;
}

export function metaAdStatusActionClaimConflict(
  error: unknown,
): MetaAdStatusActionClaimConflictLike | null {
  if (!error || typeof error !== "object") return null;
  const candidate = error as Partial<MetaAdStatusActionClaimConflictLike>;
  if (
    candidate.code !== "action_in_flight" &&
    candidate.code !== META_AD_STATUS_RECONCILIATION_REQUIRED_CODE &&
    candidate.code !== DECISION_ORIGIN_PENDING_RECONCILIATION_CODE &&
    candidate.code !== DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
  ) {
    return null;
  }
  if (
    typeof candidate.blockingActionLogId !== "string" ||
    !candidate.blockingActionLogId ||
    typeof candidate.blockingOrigin !== "string" ||
    !candidate.blockingOrigin ||
    typeof candidate.reconciliationRequired !== "boolean"
  ) {
    return null;
  }
  return {
    code: candidate.code,
    blockingActionLogId: candidate.blockingActionLogId,
    blockingOrigin: candidate.blockingOrigin,
    reconciliationRequired: candidate.reconciliationRequired,
    reconciliationReceipt: candidate.reconciliationReceipt ?? null,
  };
}

function metaAdStatusActionClaimConflictResponse(input: {
  action: MetaAdsActionKind;
  adId: string;
  conflict: MetaAdStatusActionClaimConflictLike;
}) {
  const receipt = input.conflict.reconciliationReceipt;
  const providerMutationSucceeded =
    reconciliationReceiptProvesProviderMutationSucceeded(receipt);
  return NextResponse.json(
    {
      ok: false,
      action: input.action,
      adId: input.adId,
      error: {
        code: input.conflict.code,
        message:
          input.conflict.code === "action_in_flight"
            ? "Another exact Meta Ad status action already holds the durable claim; no provider write was attempted."
            : "An exact Meta Ad status action requires reconciliation; no provider write was attempted.",
      },
      blockingActionLogId: input.conflict.blockingActionLogId,
      blockingOrigin: input.conflict.blockingOrigin,
      retryAllowed: false,
      ...(input.conflict.reconciliationRequired
        ? { reconciliationRequired: true }
        : {}),
      ...(providerMutationSucceeded
        ? { providerMutationSucceeded: true }
        : {}),
      ...(receipt?.providerOutcomeAmbiguous === true
        ? { providerOutcomeAmbiguous: true }
        : {}),
      ...(receipt ? { receipt } : {}),
    },
    { status: 409 },
  );
}

function decisionOriginPreflightStatus(errorCode: string | null) {
  if (
    errorCode === "kill_switch_engaged" ||
    errorCode === "kill_switch_state_unavailable" ||
    errorCode === "current_ad_state_unverified" ||
    errorCode === "current_hierarchy_state_unverified" ||
    errorCode === "current_ad_state_stale"
  ) {
    return 503;
  }
  if (errorCode === "ad_not_found") return 404;
  return 409;
}

async function prepareAction(input: {
  request: NextRequest;
  adId: string;
  body: ActionBody | null;
  action: MetaAdsActionKind;
}) {
  const businessId = input.body?.businessId?.trim() ?? "";
  if (!businessId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_business_id", "businessId is required."),
    };
  }
  if (!input.adId) {
    return {
      ok: false as const,
      response: jsonError(400, "missing_ad_id", "adId is required."),
    };
  }
  const parsedDecisionOrigin = parseDecisionOriginRequest({
    body: input.body,
    pathAdId: input.adId,
    action: input.action,
  });
  if (!parsedDecisionOrigin.ok) {
    return { ok: false as const, response: parsedDecisionOrigin.response };
  }

  const access = await requireBusinessAccess({
    request: input.request,
    businessId,
    minRole: "collaborator",
  });
  if ("error" in access) {
    return { ok: false as const, response: access.error };
  }
  const reviewerBlocked = rejectIfReviewerReadOnly(access, `ad_${input.action}`);
  if (reviewerBlocked) return { ok: false as const, response: reviewerBlocked };

  const blocked = await rejectIfMetaWritesBlocked({
    businessId: access.membership.businessId,
  });
  if (blocked) return { ok: false as const, response: blocked };

  const exactProviderAccountId =
    parsedDecisionOrigin.request?.providerAccountId ??
    input.body?.providerAccountId?.trim() ??
    "";
  const exactAdId =
    parsedDecisionOrigin.request?.adId ?? input.body?.adId?.trim() ?? "";
  const targetResult = await resolveExactMetaAdActionTarget({
    businessId: access.membership.businessId,
    providerAccountId: exactProviderAccountId,
    adId: exactAdId,
  });
  if (!targetResult.ok) {
    return {
      ok: false as const,
      response:
        targetResult.reason === "business_not_found"
          ? jsonError(404, "business_not_found", "Business not found.")
          : jsonError(404, "ad_not_found", "Ad not found for this business."),
    };
  }
  if (
    !parsedDecisionOrigin.request &&
    (!targetResult.target.creativeId ||
      targetResult.target.creativeId !== input.body?.creativeId?.trim())
  ) {
    return {
      ok: false as const,
      response: jsonError(
        409,
        "creative_identity_mismatch",
        "The server-presented creative identity no longer matches the exact ad target.",
      ),
    };
  }

  const ctxResult = await resolveWriteContext({
    businessId: access.membership.businessId,
    providerAccountId: targetResult.target.providerAccountId,
  });
  if (!ctxResult.ok) return { ok: false as const, response: ctxResult.response };

  if (input.action === "pause" || input.action === "resume") {
    const reconciliation = await reconcileManualMetaAdStatusBlocker({
      businessId: access.membership.businessId,
      providerAccountId: ctxResult.ctx.providerAccountId,
      adId: targetResult.target.adId,
      expectedCreativeId: targetResult.target.creativeId ?? "",
      ctx: ctxResult.ctx,
    }).catch(() => ({
      disposition: "unavailable" as const,
      candidate: null,
      blocker: "reconciliation_state_unavailable" as const,
    }));
    if (reconciliation.disposition === "unavailable") {
      return {
        ok: false as const,
        response: NextResponse.json(
          {
            ok: false,
            error: {
              code: "reconciliation_state_unavailable",
              message:
                "The durable manual Ad-status reconciliation state is temporarily unavailable; no provider write was attempted.",
            },
            reconciliationRequired: true,
            retryAllowed: false,
          },
          { status: 503 },
        ),
      };
    }
    if (reconciliation.disposition === "waiting") {
      return {
        ok: false as const,
        response: NextResponse.json(
          {
            ok: false,
            error: {
              code: "meta_ad_status_reconciliation_waiting",
              message:
                "A prior manual Ad-status attempt has not reached its provider settlement floor; no provider read or write was attempted.",
            },
            reconciliationRequired: true,
            retryAllowed: false,
            ...(reconciliation.candidate.settlementNotBefore
              ? {
                  settlementNotBefore:
                  reconciliation.candidate.settlementNotBefore,
                }
              : {}),
          },
          { status: 409 },
        ),
      };
    }
    if (reconciliation.disposition === "blocked") {
      return {
        ok: false as const,
        response: NextResponse.json(
          {
            ok: false,
            error: {
              code: META_AD_STATUS_RECONCILIATION_REQUIRED_CODE,
              message:
                "A prior manual Ad-status attempt could not be reconciled exactly; no provider write was attempted.",
            },
            reconciliationRequired: true,
            retryAllowed: false,
            blocker: reconciliation.blocker,
          },
          { status: 409 },
        ),
      };
    }
    if (
      reconciliation.disposition === "reconciled" &&
      !parsedDecisionOrigin.request &&
      reconciliation.state.configuredStatus?.trim().toUpperCase() ===
        (input.action === "pause" ? "PAUSED" : "ACTIVE") &&
      reconciliation.state.effectiveStatus?.trim().toUpperCase() ===
        (input.action === "pause" ? "PAUSED" : "ACTIVE")
    ) {
      return {
        ok: false as const,
        response: NextResponse.json({
          ok: true,
          action: input.action,
          adId: targetResult.target.adId,
          status: input.action === "pause" ? "PAUSED" : "ACTIVE",
          reconciled: true,
          noOp: true,
          providerWriteAttempted: false,
        }),
      };
    }
  }

  // Pause/resume claims use the shared all-origin transactional guard below.
  // Keep this legacy pre-claim shortcut only for duplicate, which is not an Ad
  // status claim and therefore does not participate in that shared classifier.
  if (input.action === "duplicate" && !dryRunFromBody(input.body)) {
    let reconciliationReceipt: DecisionOriginIdempotencyReceipt | null;
    try {
      reconciliationReceipt =
        await findUnresolvedDecisionOriginPendingAction({
          businessId: access.membership.businessId,
          providerAccountId: ctxResult.ctx.providerAccountId,
          adId: targetResult.target.adId,
        });
    } catch {
      return {
        ok: false as const,
        response: jsonError(
          503,
          "reconciliation_state_unavailable",
          "The durable Ad-action reconciliation state is temporarily unavailable.",
        ),
      };
    }
    if (reconciliationReceipt) {
      const providerMutationSucceeded =
        reconciliationReceiptProvesProviderMutationSucceeded(
          reconciliationReceipt,
        );
      const providerOutcomeAmbiguous =
        reconciliationReceipt.providerOutcomeAmbiguous === true;
      return {
        ok: false as const,
        response: NextResponse.json(
          {
            ok: false,
            action: input.action,
            adId: targetResult.target.adId,
            error: {
              code: providerMutationSucceeded
                ? DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE
                : DECISION_ORIGIN_PENDING_RECONCILIATION_CODE,
              message: providerMutationSucceeded
                ? "A prior verified provider write for this exact Ad still requires durable receipt reconciliation; no provider write was attempted."
                : "A prior decision-origin attempt for this exact Ad has unresolved provider or durable terminal state; exact reconciliation is required and no provider write was attempted.",
            },
            reconciliationRequired: true,
            retryAllowed: false,
            ...(providerMutationSucceeded
              ? { providerMutationSucceeded: true }
              : {}),
            ...(providerOutcomeAmbiguous
              ? { providerOutcomeAmbiguous: true }
              : {}),
            receipt: reconciliationReceipt,
          },
          { status: 409 },
        ),
      };
    }
  }

  let manualStatusMutationTarget: ManualMetaAdStatusMutationTarget | null =
    null;
  if (
    !parsedDecisionOrigin.request &&
    (input.action === "pause" || input.action === "resume")
  ) {
    const currentState = await readMetaAdExecutionState(
      ctxResult.ctx,
      targetResult.target.adId,
    ).catch(() => null);
    const manualPreflight = currentState
      ? evaluateManualMetaAdStatusPreflight({
          action: input.action,
          state: currentState,
          expectedAdId: targetResult.target.adId,
          expectedCreativeId: targetResult.target.creativeId ?? "",
          expectedProviderAccountId: ctxResult.ctx.providerAccountId,
        })
      : {
          ok: false as const,
          blocker: "current_ad_state_unverified" as const,
        };
    if (!manualPreflight.ok) {
      return {
        ok: false as const,
        response: jsonError(
          decisionOriginPreflightStatus(manualPreflight.blocker),
          manualPreflight.blocker,
          `Manual-operator preflight blocked the provider write (${manualPreflight.blocker}).`,
        ),
      };
    }
    if (
      !currentState?.ok ||
      !currentState.creativeId ||
      !currentState.campaignId ||
      !currentState.adsetId
    ) {
      return {
        ok: false as const,
        response: jsonError(
          503,
          "current_hierarchy_state_unverified",
          "Manual-operator preflight did not resolve one exact Ad hierarchy.",
        ),
      };
    }
    manualStatusMutationTarget = {
      businessId: access.membership.businessId,
      providerAccountId: ctxResult.ctx.providerAccountId,
      adId: targetResult.target.adId,
      creativeId: currentState.creativeId,
      campaignId: currentState.campaignId,
      adsetId: currentState.adsetId,
    };
  }

  if (parsedDecisionOrigin.request) {
    let preflight;
    try {
      preflight = await runServerDecisionOriginAdActionPreflight({
        request: parsedDecisionOrigin.request,
        ctx: ctxResult.ctx,
      });
    } catch (error) {
      return {
        ok: false as const,
        response: jsonError(
          503,
          "decision_preflight_unavailable",
          sanitizeErrorMessage(error),
        ),
      };
    }
    if (preflight.disposition === "duplicate" && preflight.duplicateReceipt) {
      return {
        ok: false as const,
        response: decisionOriginReplayResponse({
          action: input.action,
          adId: targetResult.target.adId,
          receipt: preflight.duplicateReceipt,
        }),
      };
    }
    if (!preflight.shouldMutate) {
      return {
        ok: false as const,
        response: jsonError(
          decisionOriginPreflightStatus(preflight.errorCode),
          preflight.errorCode ?? "decision_preflight_blocked",
          `Decision-origin preflight blocked the provider write (${preflight.blockers.join(", ")}).`,
          { blockers: preflight.blockers },
        ),
      };
    }
  }

  if (input.action === "duplicate" && !dryRunFromBody(input.body)) {
    const pending = await hasRecentPendingMetaAdsAction({
      businessId: access.membership.businessId,
      adId: targetResult.target.adId,
      sinceSeconds: 30,
    });
    if (pending) {
      return {
        ok: false as const,
        response: jsonError(
          409,
          "action_in_flight",
          "A Meta ad action is already pending for this ad.",
        ),
      };
    }
  }

  return {
    ok: true as const,
    businessId: access.membership.businessId,
    userId: access.session.user.id,
    target: targetResult.target,
    ctx: ctxResult.ctx,
    decisionOriginRequest: parsedDecisionOrigin.request,
    manualStatusMutationTarget,
  };
}

function getFailureLogStatus(
  result: MetaAdsWriteFailure,
): Exclude<MetaAdsActionStatus, "pending" | "success"> {
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

async function completeFailure(input: {
  logId: string;
  startedAt: number;
  durationMs?: number;
  result: MetaAdsWriteFailure;
  decisionOrigin: boolean;
  dryRun: boolean;
  verificationPayload?: Record<string, unknown> | null;
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
    durationMs: input.durationMs ?? Date.now() - input.startedAt,
    verificationPayload:
      manualCompletion
        ? manualCompletion.verification
        : manualAdapterPreProviderAbort
          ? null
        : input.verificationPayload === undefined
        ? ensureRecord(input.result.verificationPayload)
        : input.verificationPayload,
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

function manualMutationAttemptReceipt(
  receipt: MetaProviderMutationAttemptReceipt,
): ManualMetaProviderMutationAttemptReceipt {
  return {
    attemptCount: receipt.attemptCount,
    method: receipt.method,
    path: receipt.path,
    attemptedAt: receipt.attemptedAt,
    completedAt: receipt.completedAt,
    providerResponseReceived: receipt.providerResponseReceived,
    ...(receipt.providerResponseSuccessful === undefined
      ? {}
      : {
          providerResponseSuccessful:
            receipt.providerResponseSuccessful,
        }),
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

function duplicateMutationAttemptReceipt(
  receipt: MetaProviderMutationAttemptReceipt,
  accessToken: string,
): MetaAdDuplicateMutationReceipt {
  const sanitizedTransportError = receipt.transportError
    ? redactMetaAdDuplicateProviderEvidence(
        {
          code: receipt.transportError.code,
          message: receipt.transportError.message,
        },
        accessToken,
      )
    : null;
  return {
    attemptCount: receipt.attemptCount,
    method: receipt.method,
    path: receipt.path,
    attemptedAt: receipt.attemptedAt,
    completedAt: receipt.completedAt,
    providerResponseReceived: receipt.providerResponseReceived,
    ...(receipt.providerResponseSuccessful === undefined
      ? {}
      : {
          providerResponseSuccessful:
            receipt.providerResponseSuccessful,
        }),
    httpStatus: receipt.httpStatus,
    outcome: receipt.outcome,
    automaticRetryAttempted: receipt.automaticRetryAttempted,
    transportError: sanitizedTransportError,
  };
}

function manualMutationCompletionEvidence(
  result: MetaAdStatusWriteSuccess | MetaAdsWriteFailure,
): {
  outcome: ManualMetaAdStatusMutationCompletionOutcome;
  providerResponse: Record<string, unknown> | null;
  verification: Record<string, unknown> | null;
} {
  const providerResponse = ensureRecord(result.responsePayload);
  const verification = ensureRecord(result.verificationPayload);
  if (result.ok) {
    if (providerResponse?.success === true && verification) {
      return {
        outcome: "provider_response_verified_success",
        providerResponse,
        verification,
      };
    }
    return {
      outcome: "provider_response_succeeded_verification_failed",
      providerResponse,
      verification:
        verification ?? {
          verification_error: {
            code: "provider_verification_evidence_missing",
            message:
              "The provider adapter returned success without exact verification evidence.",
          },
        },
    };
  }
  if (isProviderOutcomeAmbiguous(result)) {
    return {
      outcome: "provider_outcome_ambiguous",
      providerResponse: null,
      verification: null,
    };
  }
  if (hasSuccessfulMetaProviderMutationAttempt(result)) {
    return {
      outcome: "provider_response_succeeded_verification_failed",
      providerResponse,
      verification:
        verification ?? {
          verification_error: {
            code: result.error.code,
            message: result.error.message,
            httpStatus: result.httpStatus,
          },
        },
    };
  }
  return {
    outcome: "provider_definite_failure",
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

async function appendManualMutationAttemptCompletion(input: {
  logId: string;
  started: ManualMetaAdStatusMutationAttemptEvent;
  result: MetaAdStatusWriteSuccess | MetaAdsWriteFailure;
}) {
  const mutationAttempt = input.result.mutationAttempt;
  if (!mutationAttempt) {
    throw new Error(
      "The provider adapter returned no exact mutation-attempt receipt.",
    );
  }
  const evidence = manualMutationCompletionEvidence(input.result);
  return {
    event: await appendManualMetaAdStatusMutationAttemptCompleted({
      sourceActionLogId: input.logId,
      attemptId: input.started.attemptId,
      completionOutcome: evidence.outcome,
      mutationAttempt: manualMutationAttemptReceipt(mutationAttempt),
      providerResponse: evidence.providerResponse,
      verification: evidence.verification,
    }),
    outcome: evidence.outcome,
    providerResponse: evidence.providerResponse,
    verification: evidence.verification,
  };
}

export async function handleMetaAdStatusAction(
  request: NextRequest,
  context: RouteParams,
  action: Extract<MetaAdsActionKind, "pause" | "resume">,
) {
  const { adId: rawAdId } = await context.params;
  const inputAdId = rawAdId?.trim() ?? "";
  const body = await readActionBody(request);
  const prepared = await prepareAction({ request, adId: inputAdId, body, action });
  if (!prepared.ok) return prepared.response;

  // The executable target is an exact, business-owned provider ad. Synthetic
  // and creative-level discovery identifiers are rejected before this point.
  const resolvedAdId = prepared.target.adId;
  const status = action === "pause" ? "PAUSED" : "ACTIVE";
  if (
    !prepared.decisionOriginRequest &&
    !dryRunFromBody(body) &&
    !prepared.manualStatusMutationTarget
  ) {
    return jsonError(
      503,
      "manual_status_mutation_target_unavailable",
      "The exact manual Ad-status mutation target is unavailable; no provider write was attempted.",
    );
  }
  const payloadRequest = {
    method: "POST",
    endpoint: `/${resolvedAdId}`,
    body: { status },
    dry_run: dryRunFromBody(body),
    input_ad_id: inputAdId,
    rec_id_origin: recIdOriginFromBody(body),
    ...(!prepared.decisionOriginRequest
      ? {
          action_origin: META_AD_ACTION_ORIGINS.manualOperator,
          manual_confirmation: "explicit_operator_confirmation",
          ...(!dryRunFromBody(body)
            ? {
                mutation_journal_contract_version:
                  MANUAL_META_AD_STATUS_MUTATION_ATTEMPT_CONTRACT_VERSION,
                mutation_journal_required: true,
                manual_status_mutation_target:
                  prepared.manualStatusMutationTarget,
              }
            : {}),
        }
      : {}),
  };
  let log: MetaAdsActionLogRow;
  try {
    log = prepared.decisionOriginRequest
      ? await createDecisionOriginMetaAdsActionLog({
          request: prepared.decisionOriginRequest,
          requestedBy: prepared.userId,
          payloadRequest,
        })
      : await createMetaAdsActionLog({
          businessId: prepared.businessId,
          providerAccountId: prepared.ctx.providerAccountId,
          adId: resolvedAdId,
          creativeId: prepared.target.creativeId,
          action,
          source: META_AD_ACTION_ORIGINS.manualOperator,
          requestedBy: prepared.userId,
          recIdOrigin: recIdOriginFromBody(body),
          payloadRequest,
        });
  } catch (error) {
    const conflict = metaAdStatusActionClaimConflict(error);
    if (conflict) {
      return metaAdStatusActionClaimConflictResponse({
        action,
        adId: resolvedAdId,
        conflict,
      });
    }
    throw error;
  }

  if (prepared.decisionOriginRequest && log.idempotentReplay) {
    return decisionOriginReplayResponse({
      action,
      adId: resolvedAdId,
      receipt: decisionOriginIdempotencyReceiptFromLog(
        log,
        prepared.decisionOriginRequest.idempotencyKey,
      ),
    });
  }

  if (!prepared.decisionOriginRequest) {
    const currentState = await readMetaAdExecutionState(
      prepared.ctx,
      resolvedAdId,
    ).catch(() => null);
    const evaluatedPostClaimPreflight = currentState
      ? evaluateManualMetaAdStatusPreflight({
          action,
          state: currentState,
          expectedAdId: resolvedAdId,
          expectedCreativeId: prepared.target.creativeId ?? "",
          expectedProviderAccountId: prepared.ctx.providerAccountId,
        })
      : {
          ok: false as const,
          blocker: "current_ad_state_unverified" as const,
        };
    const postClaimPreflight =
      evaluatedPostClaimPreflight.ok &&
      currentState?.ok &&
      prepared.manualStatusMutationTarget &&
      (currentState.campaignId !==
        prepared.manualStatusMutationTarget.campaignId ||
        currentState.adsetId !==
          prepared.manualStatusMutationTarget.adsetId)
        ? {
            ok: false as const,
            blocker: "current_hierarchy_identity_mismatch" as const,
          }
        : evaluatedPostClaimPreflight;
    if (!postClaimPreflight.ok) {
      const errorCode = postClaimPreflight.blocker;
      const errorMessage = `Post-claim manual-operator preflight blocked the provider write (${errorCode}).`;
      let completionError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await completeMetaAdsActionLog({
            id: log.id,
            status: "failure",
            payloadResponse: {
              post_claim_preflight: {
                should_mutate: false,
                blocker: errorCode,
              },
            },
            errorCode,
            errorMessage,
          });
          completionError = null;
          break;
        } catch (error) {
          completionError = error;
        }
      }
      if (completionError) {
        return jsonError(
          503,
          "manual_preflight_terminal_persistence_failed",
          "Manual post-claim preflight blocked the provider write, but its durable DB-only failure could not be persisted.",
          {
            actionLogId: log.id,
            retryAllowed: false,
          },
        );
      }
      return jsonError(
        decisionOriginPreflightStatus(errorCode),
        errorCode,
        errorMessage,
        { actionLogId: log.id },
      );
    }
  }

  if (prepared.decisionOriginRequest) {
    let postClaimPreflight;
    try {
      postClaimPreflight = await runServerDecisionOriginAdActionPreflight({
        request: prepared.decisionOriginRequest,
        ctx: prepared.ctx,
        ignorePendingReceiptActionLogId: log.id,
      });
    } catch (error) {
      postClaimPreflight = {
        shouldMutate: false,
        blockers: ["decision_preflight_unavailable"],
        errorCode: "decision_preflight_unavailable",
        errorMessage: sanitizeErrorMessage(error),
      };
    }
    if (!postClaimPreflight.shouldMutate) {
      const errorCode =
        postClaimPreflight.errorCode ?? "decision_preflight_blocked";
      const errorMessage =
        "errorMessage" in postClaimPreflight
          ? postClaimPreflight.errorMessage
          : `Post-claim decision-origin preflight blocked the provider write (${postClaimPreflight.blockers.join(", ")}).`;
      let completionError: unknown = null;
      for (let attempt = 0; attempt < 2; attempt += 1) {
        try {
          await completeDecisionOriginMetaAdsActionLog({
            id: log.id,
            status: "failure",
            payloadResponse: {
              post_claim_preflight: {
                should_mutate: false,
                blockers: postClaimPreflight.blockers,
              },
            },
            errorCode,
            errorMessage,
          });
          completionError = null;
          break;
        } catch (error) {
          completionError = error;
        }
      }
      if (completionError) {
        const outcome = "pre_provider_terminal_persistence_failed" as const;
        const marker =
          await markDecisionOriginActionReconciliationRequired({
            id: log.id,
            outcome,
            providerErrorCode: errorCode,
            errorMessage: sanitizeErrorMessage(completionError),
          }).catch(() => null);
        return NextResponse.json(
          {
            ok: false,
            action,
            adId: resolvedAdId,
            error: {
              code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
              message:
                "Post-claim preflight blocked the provider write, but durable terminal persistence failed twice.",
            },
            reconciliationOutcome: outcome,
            ...reconciliationResponseMetadata({
              outcome,
              markerPersisted: Boolean(marker),
            }),
          },
          { status: 503 },
        );
      }
      return jsonError(
        decisionOriginPreflightStatus(errorCode),
        errorCode,
        errorMessage,
        { blockers: postClaimPreflight.blockers },
      );
    }
  }

  let manualMutationAttemptStarted: ManualMetaAdStatusMutationAttemptEvent | null =
    null;
  let manualMutationAttemptStartBlocker:
    | "persistence_failed"
    | "idempotent_replay"
    | "target_mismatch"
    | null = null;
  const beforeManualMutationAttempt =
    !prepared.decisionOriginRequest && !dryRunFromBody(body)
      ? async (baseline: MetaAdStatusMutationBaseline) => {
          try {
            const durableTarget = prepared.manualStatusMutationTarget!;
            if (
              baseline.businessId !== durableTarget.businessId ||
              baseline.providerAccountId !==
                durableTarget.providerAccountId ||
              baseline.adId !== durableTarget.adId ||
              baseline.creativeId !== durableTarget.creativeId ||
              baseline.campaignId !== durableTarget.campaignId ||
              baseline.adsetId !== durableTarget.adsetId
            ) {
              manualMutationAttemptStartBlocker = "target_mismatch";
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
              manualMutationAttemptStartBlocker = "idempotent_replay";
              throw new Error(
                "An immutable provider-attempt start already exists.",
              );
            }
            manualMutationAttemptStarted = started;
          } catch (error) {
            if (manualMutationAttemptStartBlocker === null) {
              manualMutationAttemptStartBlocker = "persistence_failed";
            }
            throw error;
          }
        }
      : undefined;

  const startedAt = Date.now();
  try {
    const result =
      action === "pause"
        ? dryRunFromBody(body)
          ? await pauseAd(prepared.ctx, resolvedAdId, { dryRun: true })
          : await pauseAd(
              prepared.ctx,
              resolvedAdId,
              beforeManualMutationAttempt
                ? { beforeMutationAttempt: beforeManualMutationAttempt }
                : {},
            )
        : dryRunFromBody(body)
          ? await resumeAd(prepared.ctx, resolvedAdId, { dryRun: true })
          : await resumeAd(
              prepared.ctx,
              resolvedAdId,
              beforeManualMutationAttempt
                ? { beforeMutationAttempt: beforeManualMutationAttempt }
                : {},
            );

    if (
      !result.ok &&
      manualMutationAttemptStartBlocker === "persistence_failed"
    ) {
      try {
        await completeManualTerminalWithRetry(() =>
          completeMetaAdsActionLog({
            id: log.id,
            status: "failure",
            payloadResponse: {
              mutation_attempt_journal: {
                started: false,
                provider_write_attempted: false,
              },
            },
            errorCode: "manual_mutation_attempt_start_persistence_failed",
            errorMessage:
              "The immutable provider-attempt start could not be persisted.",
          }),
        );
        return NextResponse.json(
          {
            ok: false,
            action,
            adId: resolvedAdId,
            error: {
              code: "manual_mutation_attempt_start_persistence_failed",
              message:
                "The immutable provider-attempt start could not be persisted; no provider write was attempted.",
            },
            actionLogId: log.id,
            providerWriteAttempted: false,
          },
          { status: 503 },
        );
      } catch {
        // The pending row carries the durable no-attempt contract and exact
        // target. It becomes eligible for DB-gated reconciliation only after
        // the generic settlement floor; never issue a provider POST here.
      }
      return NextResponse.json(
        {
          ok: false,
          action,
          adId: resolvedAdId,
          error: {
            code: "manual_mutation_attempt_start_persistence_failed",
            message:
              "The immutable provider-attempt start could not be persisted; no provider write was attempted.",
          },
          actionLogId: log.id,
          reconciliationRequired: true,
          retryAllowed: false,
          providerWriteAttempted: false,
        },
        { status: 503 },
      );
    }
    if (
      !result.ok &&
      manualMutationAttemptStartBlocker === "idempotent_replay"
    ) {
      return NextResponse.json(
        {
          ok: false,
          action,
          adId: resolvedAdId,
          error: {
            code: META_AD_STATUS_RECONCILIATION_REQUIRED_CODE,
            message:
              "This action already has an immutable provider-attempt start; no second provider write was attempted.",
          },
          actionLogId: log.id,
          reconciliationRequired: true,
          retryAllowed: false,
          providerWriteAttempted: false,
        },
        { status: 409 },
      );
    }

    let manualMutationCompletion:
      | {
          event: ManualMetaAdStatusMutationAttemptEvent;
          outcome: ManualMetaAdStatusMutationCompletionOutcome;
          providerResponse: Record<string, unknown> | null;
          verification: Record<string, unknown> | null;
        }
      | null = null;
    if (manualMutationAttemptStarted) {
      try {
        const completion = await appendManualMutationAttemptCompletion({
          logId: log.id,
          started: manualMutationAttemptStarted,
          result,
        });
        manualMutationCompletion = completion;
      } catch {
        return NextResponse.json(
          {
            ok: false,
            action,
            adId: resolvedAdId,
            error: {
              code: "manual_mutation_attempt_completion_persistence_failed",
              message:
                "The provider attempt could not be durably completed; no retry is allowed before exact reconciliation.",
            },
            actionLogId: log.id,
            reconciliationRequired: true,
            retryAllowed: false,
            providerWriteAttempted: true,
          },
          { status: 503 },
        );
      }
      if (
        result.ok &&
        manualMutationCompletion?.outcome !==
          "provider_response_verified_success"
      ) {
        return NextResponse.json(
          {
            ok: false,
            action,
            adId: resolvedAdId,
            error: {
              code: META_AD_STATUS_RECONCILIATION_REQUIRED_CODE,
              message:
                "The provider response lacks exact verification evidence; no retry is allowed before reconciliation.",
            },
            actionLogId: log.id,
            providerMutationSucceeded: true,
            reconciliationRequired: true,
            retryAllowed: false,
          },
          { status: 503 },
        );
      }
    }

    if (!result.ok) {
      const dryRun = dryRunFromBody(body);
      const failureDurationMs = Date.now() - startedAt;
      const reconciliationOutcome = prepared.decisionOriginRequest
        ? reconciliationOutcomeForProviderWriteFailure(result, dryRun)
        : null;
      if (reconciliationOutcome) {
        const marker =
          await markDecisionOriginActionReconciliationRequired({
            id: log.id,
            outcome: reconciliationOutcome,
            providerErrorCode: result.error.code,
            errorMessage: result.error.message,
            providerResponsePayload: ensureRecord(result.responsePayload),
            durationMs: Date.now() - startedAt,
            verificationPayload: ensureRecord(result.verificationPayload),
            providerCompletedAt:
              result.mutationAttempt?.completedAt ?? null,
            mutationAttempt: result.mutationAttempt ?? null,
          }).catch(() => null);
        return NextResponse.json(
          {
            ok: false,
            action,
            adId: resolvedAdId,
            error: {
              code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
              message:
                "The provider outcome requires exact reconciliation; the decision-origin action remains pending and no retry is allowed.",
            },
            providerError: result.error,
            metaHttpStatus: result.httpStatus,
            providerOutcome: result.providerOutcome ?? null,
            mutationAttempt: result.mutationAttempt ?? null,
            reconciliationOutcome,
            ...reconciliationResponseMetadata({
              outcome: reconciliationOutcome,
              markerPersisted: Boolean(marker),
            }),
          },
          { status: 503 },
        );
      }
      if (prepared.decisionOriginRequest) {
        let completionError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await completeFailure({
              logId: log.id,
              startedAt,
              durationMs: failureDurationMs,
              result,
              decisionOrigin: true,
              dryRun,
            });
            completionError = null;
            break;
          } catch (error) {
            completionError = error;
          }
        }
        if (completionError) {
          const outcome: DecisionOriginReconciliationOutcome = dryRun
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
              durationMs: failureDurationMs,
              verificationPayload: ensureRecord(result.verificationPayload),
            }).catch(() => null);
          return NextResponse.json(
            {
              ok: false,
              action,
              adId: resolvedAdId,
              error: {
                code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
                message:
                  "Provider-safe terminal persistence failed twice; the action remains pending for reconciliation without another provider write.",
              },
              reconciliationOutcome: outcome,
              ...reconciliationResponseMetadata({
                outcome,
                markerPersisted: Boolean(marker),
              }),
            },
            { status: 503 },
          );
        }
      } else {
        try {
          await completeManualTerminalWithRetry(() =>
            completeFailure({
              logId: log.id,
              startedAt,
              durationMs: failureDurationMs,
              result,
              decisionOrigin: false,
              dryRun,
              manualMutationCompletion:
                manualMutationCompletion ?? null,
            }),
          );
        } catch {
          return NextResponse.json(
            {
              ok: false,
              action,
              adId: resolvedAdId,
              error: {
                code: "manual_failure_terminal_persistence_failed",
                message:
                  "The provider failure could not be durably terminalized; no retry is allowed until the pending action log is reconciled.",
              },
              actionLogId: log.id,
              reconciliationRequired: true,
              retryAllowed: false,
              providerError: result.error,
            },
            { status: 503 },
          );
        }
      }
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          metaHttpStatus: result.httpStatus,
          providerOutcome: result.providerOutcome ?? null,
          mutationAttempt: result.mutationAttempt ?? null,
          retryAllowed:
            isProviderOutcomeAmbiguous(result) ||
            hasSuccessfulMetaProviderMutationAttempt(result)
              ? false
              : null,
          ...(!prepared.decisionOriginRequest
            ? manualTerminalReconciliationMetadata(result, dryRun)
            : {}),
        },
        { status: result.error.code === "kill_switch_engaged" ? 503 : 502 },
      );
    }

    const successCompletion = {
      id: log.id,
      status: "success" as const,
      payloadResponse:
        manualMutationCompletion?.providerResponse ??
        ensureRecord(result.responsePayload),
      durationMs: Date.now() - startedAt,
      providerCompletedAt: result.mutationAttempt?.completedAt ?? null,
      verificationPayload:
        manualMutationCompletion?.verification ??
        ensureRecord(result.verificationPayload),
    };
    let completedLog = null;
    if (prepared.decisionOriginRequest) {
      let completionError: unknown = null;
      const completionAttempts = result.dryRun === true ? 2 : 1;
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
        const outcome: DecisionOriginReconciliationOutcome =
          result.dryRun === true
            ? "dry_run_terminal_persistence_failed"
            : isDecisionOriginVerificationMismatchError(completionError)
              ? "provider_response_succeeded_verification_failed"
              : "provider_write_verified_receipt_persistence_failed";
        const message = sanitizeErrorMessage(completionError);
        const marker =
          await markDecisionOriginActionReconciliationRequired({
            id: log.id,
            outcome,
            errorMessage: message,
            providerErrorCode:
              isDecisionOriginVerificationMismatchError(completionError)
                ? completionError.code
                : "receipt_persistence_failed",
            providerResponsePayload: ensureRecord(result.responsePayload),
            durationMs: Date.now() - startedAt,
            verificationPayload: ensureRecord(result.verificationPayload),
            providerCompletedAt:
              result.mutationAttempt?.completedAt ?? null,
            mutationAttempt: result.mutationAttempt ?? null,
          }).catch(() => null);
        return NextResponse.json(
          {
            ok: false,
            action,
            adId: resolvedAdId,
            error: {
              code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
              message:
                result.dryRun === true
                  ? "Dry-run terminal persistence failed twice; the non-mutation action remains pending for reconciliation."
                  : "The provider write or its exact verification requires durable reconciliation before any retry.",
            },
            reconciliationOutcome: outcome,
            ...reconciliationResponseMetadata({
              outcome,
              markerPersisted: Boolean(marker),
            }),
          },
          { status: 503 },
        );
      }
    }
    if (!prepared.decisionOriginRequest) {
      const exactObservedAt =
        manualMutationCompletion?.verification &&
        typeof manualMutationCompletion.verification.observedAt === "string"
          ? manualMutationCompletion.verification.observedAt
          : null;
      const verifiedAt =
        result.dryRun === true ? null : exactObservedAt;
      try {
        await completeManualTerminalWithRetry(() =>
          completeMetaAdsActionLog({
            ...successCompletion,
            verifiedAt,
          }),
        );
      } catch {
        return NextResponse.json(
          {
            ok: false,
            action,
            adId: resolvedAdId,
            error: {
              code: "manual_success_terminal_persistence_failed",
              message:
                result.dryRun === true
                  ? "The dry-run success could not be durably terminalized."
                  : "The provider write was verified, but its durable terminal success could not be confirmed. Do not retry before exact reconciliation.",
            },
            actionLogId: log.id,
            ...(result.dryRun === true
              ? {}
              : { providerMutationSucceeded: true }),
            reconciliationRequired: true,
            retryAllowed: false,
          },
          { status: 503 },
        );
      }
    }
    if (
      completedLog &&
      (completedLog.status === "failure" ||
        completedLog.status === "silent_failure")
    ) {
      return jsonError(
        502,
        completedLog.errorCode ?? "silent_failure",
        completedLog.errorMessage ??
          "Provider verification did not preserve the exact native Ad lineage.",
      );
    }

    return NextResponse.json({
      ok: true,
      action,
      adId: resolvedAdId,
      status: result.verifiedStatus,
      dryRun: result.dryRun === true,
      wouldHaveWritten: result.wouldHaveWritten ?? null,
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    if (prepared.decisionOriginRequest) {
      const dryRun = dryRunFromBody(body);
      if (dryRun) {
        let completionError: unknown = null;
        for (let attempt = 0; attempt < 2; attempt += 1) {
          try {
            await completeDecisionOriginMetaAdsActionLog({
              id: log.id,
              status: "failure",
              payloadResponse: {
                provider_write_exception: {
                  mutation_attempted: false,
                  message,
                },
              },
              errorCode: "provider_write_unexpected_exception",
              errorMessage: message,
              durationMs: Date.now() - startedAt,
            });
            completionError = null;
            break;
          } catch (terminalError) {
            completionError = terminalError;
          }
        }
        if (!completionError) {
          return jsonError(
            500,
            "provider_write_unexpected_exception",
            message,
          );
        }
      }
      const outcome: DecisionOriginReconciliationOutcome = dryRun
        ? "dry_run_terminal_persistence_failed"
        : "provider_outcome_ambiguous";
      const marker =
        await markDecisionOriginActionReconciliationRequired({
          id: log.id,
          outcome,
          errorMessage: message,
          providerErrorCode: "internal_error",
          durationMs: Date.now() - startedAt,
        }).catch(() => null);
      return NextResponse.json(
        {
          ok: false,
          action,
          adId: resolvedAdId,
          error: {
            code: DECISION_ORIGIN_RECONCILIATION_REQUIRED_CODE,
            message:
              "The decision-origin attempt remains pending because its provider or durable terminal outcome could not be proven.",
          },
          reconciliationOutcome: outcome,
          ...reconciliationResponseMetadata({
            outcome,
            markerPersisted: Boolean(marker),
          }),
        },
        { status: 503 },
      );
    }
    if (manualMutationAttemptStarted) {
      return NextResponse.json(
        {
          ok: false,
          action,
          adId: resolvedAdId,
          error: {
            code: "provider_outcome_ambiguous",
            message:
              "The provider adapter threw after the immutable attempt start; the attempt remains pending for exact reconciliation.",
          },
          actionLogId: log.id,
          providerOutcome: "outcome_ambiguous",
          providerOutcomeAmbiguous: true,
          reconciliationRequired: true,
          retryAllowed: false,
          providerWriteAttempted: true,
        },
        { status: 503 },
      );
    }
    const manualDryRun = dryRunFromBody(body);
    const errorCode = "provider_write_unexpected_exception";
    const manualExceptionCompletion = {
      id: log.id,
      status: "failure" as const,
      payloadResponse: manualDryRun
        ? {
            provider_write_exception: {
              mutation_attempted: false,
              outcome: "definite_failure",
              message,
            },
          }
        : {
            adapter_pre_provider_abort: {
              code: errorCode,
              provider_mutation_attempted: false,
            },
          },
      errorCode,
      errorMessage: message,
      durationMs: Date.now() - startedAt,
    };
    try {
      await completeManualTerminalWithRetry(() =>
        completeMetaAdsActionLog(manualExceptionCompletion),
      );
    } catch {
      return NextResponse.json(
        {
          ok: false,
          action,
          adId: resolvedAdId,
          error: {
            code: "manual_failure_terminal_persistence_failed",
            message:
              "The pre-provider adapter failure could not be durably terminalized. Do not retry before exact reconciliation.",
          },
          actionLogId: log.id,
          providerWriteAttempted: false,
          reconciliationRequired: true,
          retryAllowed: false,
        },
        { status: 503 },
      );
    }
    return NextResponse.json(
      {
        ok: false,
        action,
        adId: resolvedAdId,
        error: {
          code: errorCode,
          message,
        },
        actionLogId: log.id,
        providerWriteAttempted: false,
        ...(manualDryRun ? { dryRun: true } : {}),
      },
      { status: 502 },
    );
  }
}

export async function handleMetaAdDuplicateAction(
  request: NextRequest,
  context: RouteParams,
) {
  const { adId: rawAdId } = await context.params;
  const inputAdId = rawAdId?.trim() ?? "";
  const body = await readActionBody(request);
  const targetAdsetId = body?.targetAdsetId?.trim() ?? "";
  if (!targetAdsetId) {
    return jsonError(
      400,
      "missing_target_adset_id",
      "targetAdsetId is required.",
    );
  }
  if (body?.activateAfterCreate === true) {
    return jsonError(
      400,
      "active_create_not_supported",
      "Duplicate ads must be created PAUSED and resumed separately.",
    );
  }

  const prepared = await prepareAction({ request, adId: inputAdId, body, action: "duplicate" });
  if (!prepared.ok) return prepared.response;

  const resolvedAdId = prepared.target.adId;
  const [sourceState, targetState] = await Promise.all([
    readMetaAdExecutionState(prepared.ctx, resolvedAdId).catch(() => null),
    readMetaEntityExecutionState(
      prepared.ctx,
      "adset",
      targetAdsetId,
    ).catch(() => null),
  ]);
  const duplicatePreflight =
    sourceState && targetState
      ? evaluateManualMetaAdDuplicatePreflight({
          sourceState,
          targetState,
          expectedAdId: resolvedAdId,
          expectedCreativeId: prepared.target.creativeId ?? "",
          expectedProviderAccountId: prepared.ctx.providerAccountId,
          expectedTargetAdsetId: targetAdsetId,
        })
      : {
          ok: false as const,
          blocker: "current_ad_state_unverified" as const,
        };
  if (!duplicatePreflight.ok) {
    return jsonError(
      decisionOriginPreflightStatus(duplicatePreflight.blocker),
      duplicatePreflight.blocker,
      `Manual duplicate preflight blocked the provider write (${duplicatePreflight.blocker}).`,
    );
  }
  const trimmedName =
    typeof body?.name === "string" && body.name.trim().length > 0
      ? body.name.trim()
      : undefined;
  const duplicateMarker = createMetaAdDuplicateMarker();
  const canonicalDuplicateName = dryRunFromBody(body)
    ? trimmedName
    : buildMetaAdDuplicateCanonicalName(trimmedName, duplicateMarker);
  const accountNumericId = prepared.ctx.providerAccountId.replace(/^act_/, "");
  const payloadRequest = {
    method: "POST",
    endpoint: `/act_${accountNumericId}/ads`,
    body: {
      adset_id: targetAdsetId,
      target_adset_id: targetAdsetId,
      status_option: "PAUSED",
      name: canonicalDuplicateName ?? null,
      dry_run: dryRunFromBody(body),
    },
    input_ad_id: inputAdId,
    rec_id_origin: recIdOriginFromBody(body),
    action_origin: META_AD_ACTION_ORIGINS.manualOperator,
    manual_confirmation: "explicit_operator_confirmation",
    dry_run: dryRunFromBody(body),
  };
  let duplicateClaim: Awaited<ReturnType<typeof claimMetaAdDuplicateAction>>;
  try {
    duplicateClaim = await claimMetaAdDuplicateAction({
      businessId: prepared.businessId,
      providerAccountId: prepared.ctx.providerAccountId,
      adId: resolvedAdId,
      creativeId: prepared.target.creativeId,
      targetAdsetId,
      dryRun: dryRunFromBody(body),
      requestedBy: prepared.userId,
      recIdOrigin: recIdOriginFromBody(body),
      payloadRequest,
      marker: duplicateMarker,
      canonicalAdName:
        canonicalDuplicateName ??
        buildMetaAdDuplicateCanonicalName(null, duplicateMarker),
      sinceMinutes: 10,
    });
  } catch {
    return jsonError(
      503,
      "duplicate_claim_state_unavailable",
      "The durable duplicate-action claim state is temporarily unavailable; no provider write was attempted.",
      {
        reconciliationRequired: true,
        retryAllowed: false,
      },
    );
  }
  if (!duplicateClaim.claimed) {
    const existingDuplicate = duplicateClaim.existing;
    if (!existingDuplicate.resultingAdId) {
      return jsonError(
        409,
        "duplicate_reconciliation_required",
        "A prior duplicate attempt has unresolved durable or provider state. Reconcile it before retrying.",
        {
          reconciliationRequired: true,
          retryAllowed: false,
        },
      );
    }
    return jsonError(
      409,
      "duplicate_already_attempted",
      "A recent duplicate attempt already produced an ad for this source and target.",
      { existingAdId: existingDuplicate.resultingAdId },
    );
  }
  const log = duplicateClaim.log;

  const startedAt = Date.now();
  let duplicateAttemptStarted = false;
  try {
    const result = await duplicateAd(prepared.ctx, {
      adId: resolvedAdId,
      targetAdsetId,
      expectedSourceCreativeId: prepared.target.creativeId ?? undefined,
      name: canonicalDuplicateName,
      beforeMutationAttempt: dryRunFromBody(body)
        ? undefined
        : async () => {
            await appendMetaAdDuplicateAttemptStarted(log.id);
            duplicateAttemptStarted = true;
          },
      ...(dryRunFromBody(body) ? { dryRun: true } : {}),
    });

    if (!result.ok) {
      const terminalDurationMs = Date.now() - startedAt;
      try {
        if (dryRunFromBody(body)) {
          await completeManualTerminalWithRetry(() =>
            completeFailure({
              logId: log.id,
              startedAt,
              durationMs: terminalDurationMs,
              result,
              decisionOrigin: false,
              dryRun: true,
              verificationPayload: {
                sourceIdentity: result.sourceIdentity ?? null,
                targetVerification: ensureRecord(
                  result.verificationPayload,
                ),
              },
            }),
          );
        } else if (result.mutationAttempt) {
          await completeManualTerminalWithRetry(() =>
            finalizeMetaAdDuplicateAttempt({
              sourceActionLogId: log.id,
              successful: false,
              mutationReceipt: duplicateMutationAttemptReceipt(
                result.mutationAttempt!,
                prepared.ctx.accessToken,
              ),
              providerResponse:
                result.mutationAttempt?.providerResponseReceived === false
                  ? null
                  : redactMetaAdDuplicateProviderEvidence(
                      ensureRecord(result.responsePayload),
                      prepared.ctx.accessToken,
                    ),
              verification: redactMetaAdDuplicateProviderEvidence(
                ensureRecord(result.verificationPayload),
                prepared.ctx.accessToken,
              ),
              verificationObservedAt: null,
              resultingAdId: result.resultingAdId ?? null,
              errorCode: result.error.code,
              errorMessage: result.error.message,
              durationMs: terminalDurationMs,
            }),
          );
        } else {
          await completeManualTerminalWithRetry(() =>
            finalizeMetaAdDuplicatePreProviderFailure({
              sourceActionLogId: log.id,
              errorCode: result.error.code,
              errorMessage: result.error.message,
              durationMs: terminalDurationMs,
            }),
          );
        }
      } catch {
        return NextResponse.json(
          {
            ok: false,
            action: "duplicate",
            adId: resolvedAdId,
            resultingAdId: result.resultingAdId ?? null,
            error: {
              code: "duplicate_terminal_persistence_failed",
              message:
                "The provider attempt could not be terminalized durably. Exact reconciliation is required and no retry is allowed.",
            },
            reconciliationRequired: true,
            retryAllowed: false,
          },
          { status: 503 },
        );
      }
      return NextResponse.json(
        {
          ok: false,
          error: result.error,
          metaHttpStatus: result.httpStatus,
          resultingAdId: result.resultingAdId ?? null,
          providerOutcome: result.providerOutcome ?? null,
          mutationAttempt: result.mutationAttempt ?? null,
          retryAllowed:
            isProviderOutcomeAmbiguous(result) ||
            hasSuccessfulMetaProviderMutationAttempt(result)
              ? false
              : null,
        },
        { status: result.error.code === "kill_switch_engaged" ? 503 : 502 },
      );
    }

    const resultingAdId = result.dryRun === true ? null : result.newAdId;
    const terminalDurationMs = Date.now() - startedAt;
    const terminalVerifiedAt = new Date().toISOString();
    try {
      if (result.dryRun === true) {
        await completeManualTerminalWithRetry(() =>
          completeMetaAdsActionLog({
            id: log.id,
            status: "success",
            payloadResponse: ensureRecord(result.responsePayload),
            resultingAdId,
            durationMs: terminalDurationMs,
            verifiedAt: terminalVerifiedAt,
            verificationPayload: {
              sourceIdentity: result.sourceIdentity,
              targetVerification: ensureRecord(
                result.verificationPayload,
              ),
            },
          }),
        );
      } else {
        await completeManualTerminalWithRetry(() =>
          finalizeMetaAdDuplicateAttempt({
            sourceActionLogId: log.id,
            successful: true,
            mutationReceipt: duplicateMutationAttemptReceipt(
              result.mutationAttempt,
              prepared.ctx.accessToken,
            ),
            providerResponse: redactMetaAdDuplicateProviderEvidence(
              ensureRecord(result.responsePayload),
              prepared.ctx.accessToken,
            ),
            verification: redactMetaAdDuplicateProviderEvidence(
              ensureRecord(result.verificationPayload),
              prepared.ctx.accessToken,
            ),
            verificationObservedAt: result.verificationObservedAt,
            resultingAdId,
            errorCode: null,
            errorMessage: null,
            durationMs: terminalDurationMs,
          }),
        );
      }
    } catch {
      return NextResponse.json(
        {
          ok: false,
          action: "duplicate",
          adId: resolvedAdId,
          resultingAdId,
          error: {
            code: "duplicate_terminal_persistence_failed",
            message:
              "The verified provider success could not be terminalized durably. Exact reconciliation is required and no retry is allowed.",
          },
          reconciliationRequired: true,
          retryAllowed: false,
          ...(result.dryRun === true
            ? {}
            : { providerMutationSucceeded: true }),
        },
        { status: 503 },
      );
    }

    return NextResponse.json({
      ok: true,
      action: "duplicate",
      adId: resolvedAdId,
      newAdId: resultingAdId,
      status: result.verifiedStatus,
      dryRun: result.dryRun === true,
      wouldHaveWritten: result.wouldHaveWritten ?? null,
      adsManagerUrl: adsManagerAdUrl(accountNumericId, resultingAdId),
    });
  } catch (error) {
    const message = sanitizeErrorMessage(error);
    if (dryRunFromBody(body)) {
      await completeManualTerminalWithRetry(() =>
        completeMetaAdsActionLog({
          id: log.id,
          status: "failure",
          errorCode: "internal_error",
          errorMessage: message,
          durationMs: Date.now() - startedAt,
        }),
      ).catch(() => null);
      return jsonError(500, "internal_error", message);
    }
    if (!duplicateAttemptStarted) {
      await completeManualTerminalWithRetry(() =>
        finalizeMetaAdDuplicatePreProviderFailure({
          sourceActionLogId: log.id,
          errorCode: "duplicate_pre_provider_exception",
          errorMessage: message,
          durationMs: Date.now() - startedAt,
        }),
      ).catch(() => null);
    }
    // A live duplicate adapter exception cannot prove whether its one provider
    // POST occurred. Preserve the durable pending claim so another request
    // cannot issue a second write.
    return NextResponse.json(
      {
        ok: false,
        action: "duplicate",
        adId: resolvedAdId,
        error: {
          code: "duplicate_provider_outcome_unresolved",
          message:
            "The live duplicate attempt ended without exact provider outcome proof. Reconciliation is required and no retry is allowed.",
        },
        reconciliationRequired: true,
        retryAllowed: false,
      },
      { status: 503 },
    );
  }
}

export async function handleMetaAdActionsHistory(
  request: NextRequest,
  context: RouteParams,
) {
  const { adId: rawAdId } = await context.params;
  const inputAdId = rawAdId?.trim() ?? "";
  const businessId = request.nextUrl.searchParams.get("businessId")?.trim() ?? "";
  if (!inputAdId) return jsonError(400, "missing_ad_id", "adId is required.");
  if (!businessId) {
    return jsonError(400, "missing_business_id", "businessId is required.");
  }
  const access = await requireBusinessAccess({
    request,
    businessId,
    minRole: "guest",
  });
  if ("error" in access) return access.error;
  const targetResult = await resolveMetaAdActionTarget({
    businessId: access.membership.businessId,
    adId: inputAdId,
  });
  if (!targetResult.ok) {
    return targetResult.reason === "business_not_found"
      ? jsonError(404, "business_not_found", "Business not found.")
      : jsonError(404, "ad_not_found", "Ad not found for this business.");
  }
  const rows = await listRecentMetaAdsActionLogs({
    businessId: access.membership.businessId,
    adId: targetResult.target.adId,
    limit: 10,
  });
  return NextResponse.json({ ok: true, rows });
}
