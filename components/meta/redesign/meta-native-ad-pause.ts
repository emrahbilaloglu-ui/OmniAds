import type { MetaCanonicalDecision } from "@/lib/meta/decisions-workspace-contract";
import { isExactActiveMetaDecisionDeliveryScope } from "@/lib/meta/decisions-workspace-contract";
import type { MetaOsAdDecision } from "@/lib/meta/decisions-os-contract";
import {
  DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
  createDecisionOriginAdActionIdempotencyKey,
  validateDecisionOriginAdExecutionRequest,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";

export const META_DECISION_NATIVE_ACTION_ORIGIN = "native_decision_v1" as const;

export type MetaNativeAdPauseAuthorization =
  | {
      ok: true;
      request: DecisionOriginAdExecutionRequest;
      refusalReason: null;
    }
  | {
      ok: false;
      request: null;
      refusalReason: string;
    };

function nonBlank(value: string | null | undefined): string | null {
  const normalized = value?.trim();
  return normalized ? normalized : null;
}

function sha256(value: string | null | undefined): string | null {
  const normalized = nonBlank(value)?.toLowerCase() ?? null;
  return normalized && /^[a-f0-9]{64}$/.test(normalized) ? normalized : null;
}

function refused(reason: string): MetaNativeAdPauseAuthorization {
  return { ok: false, request: null, refusalReason: reason };
}

/**
 * Validates agreement between the served operator action and the immutable
 * canonical decision lineage. It never derives a verdict or buyer action.
 *
 * The server repeats every authority check immediately before mutation. This
 * client-side law only decides whether the Decision page may offer the
 * confirmation control; a forged/stale client payload still gains nothing.
 */
export function authorizeMetaNativeAdPause(input: {
  businessId: string;
  providerAccountId: string | null;
  decision: MetaOsAdDecision | null;
  canonical: MetaCanonicalDecision | null;
}): MetaNativeAdPauseAuthorization {
  const businessId = nonBlank(input.businessId);
  const providerAccountId = nonBlank(input.providerAccountId);
  const decision = input.decision;
  const canonical = input.canonical;
  if (!businessId) return refused("Business scope is unavailable.");
  if (!providerAccountId) return refused("Meta account scope is unavailable.");
  if (!decision || !canonical) {
    return refused(
      "Both the served Ad decision and its canonical authority envelope are required.",
    );
  }

  const action = decision.action;
  if (
    action.code !== "cut" ||
    action.intent !== "execute" ||
    action.targetLevel !== "ad" ||
    action.providerMutation !== "pause"
  ) {
    return refused("The served action does not authorize an exact-Ad pause.");
  }
  if (
    decision.lane !== "act" ||
    decision.decisionAvailability !== "available" ||
    decision.blockers.length > 0 ||
    decision.resolution !== null
  ) {
    return refused("The served Ad decision is held, blocked, or unavailable.");
  }

  const authority = canonical.sourceAuthority;
  const canonicalAdId = nonBlank(canonical.parentChain.ad?.id);
  const canonicalCreativeId = nonBlank(canonical.parentChain.creative?.id);
  if (
    canonical.identityGrain !== "ad" ||
    canonical.identityResolution?.basis !== "native_ad_exact" ||
    canonical.identityResolution.adActionEligible !== true ||
    authority?.status !== "native_exact" ||
    authority.actionEligible !== true ||
    authority.reviewOnlyReason !== null ||
    authority.authorizedAction !== "cut" ||
    nonBlank(canonical.sourceDecision.label)?.toLowerCase() !== "cut" ||
    canonical.classification.decisionState !== "act" ||
    canonical.classification.buyerAction !== "cut" ||
    canonical.classification.heldAction !== null ||
    canonical.classification.blockers.length > 0 ||
    canonical.classification.resolution !== null ||
    canonical.sourceDecision.authorityBlocker !== null ||
    !isExactActiveMetaDecisionDeliveryScope(canonical.deliveryScope)
  ) {
    return refused(
      "The canonical decision does not carry exact native eligible Cut authority.",
    );
  }

  if (
    canonical.providerAccountId !== providerAccountId ||
    decision.providerAccountId !== providerAccountId ||
    decision.decisionId !== canonical.decisionId ||
    decision.sourceSnapshotId !== canonical.sourceSnapshotId ||
    authority.snapshotId !== canonical.sourceSnapshotId ||
    !canonicalAdId ||
    authority.realAdId !== canonicalAdId ||
    decision.adId !== canonicalAdId ||
    !canonicalCreativeId ||
    decision.creativeId !== canonicalCreativeId
  ) {
    return refused(
      "The served and canonical Ad identities or lineage do not match.",
    );
  }

  const evaluationId = nonBlank(authority.evaluationId);
  const engineVersion = nonBlank(authority.engineVersion);
  const decisionHash = sha256(authority.decisionHash);
  if (!evaluationId || !engineVersion || !decisionHash) {
    return refused("Immutable evaluation lineage is incomplete.");
  }
  if (engineVersion !== canonical.sourceDecision.engineVersion) {
    return refused(
      "The canonical engine version does not match its authority envelope.",
    );
  }

  const requestBase = {
    contractVersion: DECISION_ORIGIN_AD_EXECUTION_CONTRACT_VERSION,
    businessId,
    providerAccountId,
    adId: canonicalAdId,
    snapshotId: canonical.sourceSnapshotId,
    evaluationId,
    engineVersion,
    decisionHash,
    action: "pause",
    creativeId: canonicalCreativeId,
  };
  const request: DecisionOriginAdExecutionRequest = {
    ...requestBase,
    idempotencyKey: createDecisionOriginAdActionIdempotencyKey(requestBase),
  };
  const blockers = validateDecisionOriginAdExecutionRequest(request);
  if (blockers.length > 0) {
    return refused(`Execution request is incomplete (${blockers.join(", ")}).`);
  }
  return { ok: true, request, refusalReason: null };
}

export type MetaNativeAdPauseResult =
  | {
      ok: true;
      status: string;
      duplicate: boolean;
      message: string;
      payload: Record<string, unknown>;
    }
  | {
      ok: false;
      code: string | null;
      message: string;
      reconciliationRequired: boolean;
      retryAllowed: boolean | null;
      providerMutationSucceeded: boolean | null;
      providerOutcomeAmbiguous: boolean | null;
      payload: Record<string, unknown> | null;
    };

export type MetaNativeAdPauseFailure = Extract<
  MetaNativeAdPauseResult,
  { ok: false }
>;

/**
 * States only the provider evidence returned by the server.
 *
 * A reconciliation response can carry `providerMutationSucceeded: true` when
 * Meta accepted and verified the mutation but the durable receipt could not be
 * completed. Dropping that field made a "no new write" sentence read as if no
 * provider mutation had ever succeeded.
 */
export function describeMetaNativeAdPauseFailure(
  result: MetaNativeAdPauseFailure,
): string {
  const details = [result.message];
  if (result.providerMutationSucceeded === true) {
    details.push(
      "Provider mutation status: succeeded. Durable verification or receipt reconciliation is still incomplete.",
    );
  } else if (result.providerOutcomeAmbiguous === true) {
    details.push(
      "Provider mutation status: unknown. Meta may have received the request, but the final provider state is not verified.",
    );
  }
  if (result.reconciliationRequired) {
    details.push(
      "Provider outcome requires reconciliation. Do not retry this action automatically.",
    );
  } else if (result.retryAllowed === false) {
    details.push(
      "This response is non-retryable. Wait for a fresh server read-back before acting again.",
    );
  }
  return details.join(" ");
}

type FetchLike = typeof fetch;

function record(value: unknown): Record<string, unknown> | null {
  return value && typeof value === "object"
    ? (value as Record<string, unknown>)
    : null;
}

/** One HTTP attempt, no automatic retry and no optimistic success. */
export async function executeMetaNativeAdPause(input: {
  request: DecisionOriginAdExecutionRequest;
  fetchImpl?: FetchLike;
}): Promise<MetaNativeAdPauseResult> {
  const fetcher = input.fetchImpl ?? fetch;
  let response: Response;
  try {
    response = await fetcher(
      `/api/meta/ads/${encodeURIComponent(input.request.adId)}/pause`,
      {
        method: "POST",
        headers: {
          Accept: "application/json",
          "Content-Type": "application/json",
        },
        cache: "no-store",
        body: JSON.stringify({
          ...input.request,
          actionOrigin: META_DECISION_NATIVE_ACTION_ORIGIN,
        }),
      },
    );
  } catch (error) {
    const failureDetail =
      error instanceof Error ? error.message : "The response was not received.";
    return {
      ok: false,
      code: "network_outcome_unknown",
      message: `The request outcome is unknown because no server response was received. ${failureDetail}`,
      reconciliationRequired: true,
      retryAllowed: false,
      providerMutationSucceeded: null,
      providerOutcomeAmbiguous: true,
      payload: null,
    };
  }

  const payload = record(await response.json().catch(() => null));
  const status =
    typeof payload?.status === "string" ? payload.status.trim() : "";
  const normalizedStatus = status.toUpperCase();
  if (
    response.ok &&
    payload?.ok === true &&
    payload.action === "pause" &&
    payload.adId === input.request.adId &&
    normalizedStatus === "PAUSED" &&
    payload.dryRun !== true
  ) {
    const duplicate = payload.duplicate === true;
    return {
      ok: true,
      status: normalizedStatus,
      duplicate,
      message: duplicate
        ? `Meta already verified this Ad as ${normalizedStatus}.`
        : `Meta verified this Ad as ${normalizedStatus}.`,
      payload,
    };
  }

  const nestedError = record(payload?.error);
  const code =
    typeof nestedError?.code === "string"
      ? nestedError.code
      : typeof payload?.code === "string"
        ? payload.code
        : response.ok
          ? "invalid_response"
          : null;
  const message =
    (typeof nestedError?.message === "string" && nestedError.message.trim()) ||
    (typeof payload?.message === "string" && payload.message.trim()) ||
    (response.ok
      ? "Meta returned an invalid pause response."
      : `Meta pause failed (${response.status}).`);
  return {
    ok: false,
    code,
    message,
    reconciliationRequired: payload?.reconciliationRequired === true,
    retryAllowed:
      typeof payload?.retryAllowed === "boolean" ? payload.retryAllowed : null,
    providerMutationSucceeded:
      typeof payload?.providerMutationSucceeded === "boolean"
        ? payload.providerMutationSucceeded
        : null,
    providerOutcomeAmbiguous:
      typeof payload?.providerOutcomeAmbiguous === "boolean"
        ? payload.providerOutcomeAmbiguous
        : null,
    payload,
  };
}
