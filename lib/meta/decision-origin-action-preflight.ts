import {
  runDecisionOriginAdExecutionPreflight,
  type DecisionOriginAdExecutionEvidence,
  type DecisionOriginAdExecutionPreflightResult,
  type DecisionOriginAdExecutionRequest,
} from "@/lib/creative-decision-engine/execution-safety";
import {
  findDecisionOriginActionByIdempotency,
  readDecisionOriginSourceDecision,
} from "@/lib/meta/ads-action-log";
import { getMetaWriteBlockState } from "@/lib/meta/automation-control-plane";
import {
  readMetaAdExecutionState,
  type MetaAdsWriteContext,
} from "@/lib/meta/ads-write";

function unavailableEvidence(
  receipt: DecisionOriginAdExecutionEvidence["idempotencyReceipt"],
): DecisionOriginAdExecutionEvidence {
  return {
    killSwitch: { verified: false, engaged: false },
    currentAccount: {
      found: false,
      businessId: null,
      providerAccountId: null,
      writable: false,
    },
    currentAd: {
      found: false,
      businessId: null,
      providerAccountId: null,
      adId: null,
      configuredStatus: null,
      effectiveStatus: null,
      policyEligible: null,
      reviewStatus: null,
      observedAt: null,
    },
    sourceDecision: {
      found: false,
      businessId: null,
      providerAccountId: null,
      decisionEntityType: null,
      decisionEntityId: null,
      adId: null,
      creativeId: null,
      snapshotId: null,
      evaluationId: null,
      engineVersion: null,
      decisionHash: null,
      decisionLabel: null,
      blockedActionType: null,
      explicitAuthorizedAction: null,
      computedAt: null,
    },
    idempotencyReceipt: receipt,
  };
}

/**
 * Re-reads every mutable authority immediately before an exact provider write.
 * An idempotent replay exits before the provider GET and never mutates again.
 */
export async function runServerDecisionOriginAdActionPreflight(input: {
  request: DecisionOriginAdExecutionRequest;
  ctx: MetaAdsWriteContext;
  now?: Date;
}): Promise<DecisionOriginAdExecutionPreflightResult> {
  const idempotencyReceipt = await findDecisionOriginActionByIdempotency({
    businessId: input.request.businessId,
    idempotencyKey: input.request.idempotencyKey,
  });
  if (idempotencyReceipt) {
    return runDecisionOriginAdExecutionPreflight({
      request: input.request,
      rereadEvidence: async () => unavailableEvidence(idempotencyReceipt),
      now: input.now,
    });
  }

  const [writeBlock, currentAd, sourceDecision] = await Promise.all([
    getMetaWriteBlockState({ businessId: input.request.businessId }),
    readMetaAdExecutionState(input.ctx, input.request.adId),
    readDecisionOriginSourceDecision({
      snapshotId: input.request.snapshotId,
      evaluationId: input.request.evaluationId,
    }),
  ]);
  const killSwitchVerified = writeBlock.reason !== "control_state_unavailable";
  const contextMatches =
    input.ctx.businessId === input.request.businessId &&
    input.ctx.providerAccountId === input.request.providerAccountId;
  const evidence: DecisionOriginAdExecutionEvidence = {
    killSwitch: {
      verified: killSwitchVerified,
      engaged: killSwitchVerified && writeBlock.blocked,
    },
    currentAccount: {
      found: true,
      businessId: input.ctx.businessId,
      providerAccountId: input.ctx.providerAccountId,
      writable: contextMatches,
    },
    currentAd: currentAd.ok
      ? {
          found: true,
          businessId: input.ctx.businessId,
          providerAccountId: input.ctx.providerAccountId,
          adId: currentAd.adId,
          configuredStatus: currentAd.configuredStatus,
          effectiveStatus: currentAd.effectiveStatus,
          policyEligible: currentAd.policyEligible,
          reviewStatus: currentAd.reviewStatus,
          observedAt: currentAd.observedAt,
        }
      : {
          found:
            currentAd.preflightBlocker !== "ad_not_found" &&
            currentAd.preflightBlocker !== "meta_account_unresolved",
          businessId: input.ctx.businessId,
          providerAccountId: input.ctx.providerAccountId,
          adId: currentAd.adId ?? input.request.adId,
          configuredStatus: null,
          effectiveStatus: null,
          policyEligible: null,
          reviewStatus: null,
          observedAt: null,
          readBlocker: currentAd.preflightBlocker,
        },
    sourceDecision,
    idempotencyReceipt: null,
  };

  return runDecisionOriginAdExecutionPreflight({
    request: input.request,
    rereadEvidence: async () => evidence,
    now: input.now,
  });
}
