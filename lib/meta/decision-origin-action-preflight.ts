import {
  runDecisionOriginAdExecutionPreflight,
  validateDecisionOriginAdExecutionRequest,
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
import {
  buildMetaDecisionPipelineHealth,
  readMetaDecisionPipelineOperationalHealth,
} from "@/lib/meta/decision-pipeline-health";
import { readMetaDecisionsWorkspaceReadModel } from "@/lib/meta/decisions-workspace-read-model";

function unavailableEvidence(
  receipt: DecisionOriginAdExecutionEvidence["idempotencyReceipt"],
): DecisionOriginAdExecutionEvidence {
  return {
    killSwitch: { verified: false, engaged: false },
    pipeline: { verified: false, executionReady: false },
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
      creativeId: null,
      campaignId: null,
      campaignConfiguredStatus: null,
      campaignEffectiveStatus: null,
      adsetId: null,
      adsetConfiguredStatus: null,
      adsetEffectiveStatus: null,
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
  ignorePendingReceiptActionLogId?: string;
}): Promise<DecisionOriginAdExecutionPreflightResult> {
  const requestBlockers =
    validateDecisionOriginAdExecutionRequest(input.request);
  if (requestBlockers.length > 0) {
    return {
      ok: false,
      disposition: "reject",
      shouldMutate: false,
      blockers: requestBlockers,
      errorCode: requestBlockers[0] ?? null,
      duplicateReceipt: null,
      decisionAgeHours: null,
      currentAdStateAgeMinutes: null,
    };
  }
  const idempotencyReceipt = await findDecisionOriginActionByIdempotency({
    businessId: input.request.businessId,
    idempotencyKey: input.request.idempotencyKey,
  });
  if (
    idempotencyReceipt &&
    idempotencyReceipt.actionLogId !== input.ignorePendingReceiptActionLogId
  ) {
    return runDecisionOriginAdExecutionPreflight({
      request: input.request,
      rereadEvidence: async () => unavailableEvidence(idempotencyReceipt),
      now: input.now,
    });
  }

  const now = input.now ?? new Date();
  const pipelineEvidencePromise = Promise.all([
    readMetaDecisionPipelineOperationalHealth({
      businessId: input.request.businessId,
      providerAccountId: input.request.providerAccountId,
      now,
    }),
    readMetaDecisionsWorkspaceReadModel({
      businessId: input.request.businessId,
      providerAccountId: input.request.providerAccountId,
      adIds: [input.request.adId],
      generatedAt: now.toISOString(),
    }),
  ])
    .then(([operational, decisionReadModel]) => {
      const health = buildMetaDecisionPipelineHealth({
        operational,
        decisionReadModel,
        now,
      });
      return {
        verified: health.overall !== "unavailable",
        executionReady: health.executionReady,
      };
    })
    .catch(() => ({ verified: false, executionReady: false }));
  const [writeBlock, currentAd, sourceDecision, pipeline] = await Promise.all([
    getMetaWriteBlockState({ businessId: input.request.businessId }),
    readMetaAdExecutionState(input.ctx, input.request.adId),
    readDecisionOriginSourceDecision({
      snapshotId: input.request.snapshotId,
      evaluationId: input.request.evaluationId,
    }),
    pipelineEvidencePromise,
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
    pipeline,
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
          providerAccountId: currentAd.providerAccountId,
          adId: currentAd.adId,
          creativeId: currentAd.creativeId,
          campaignId: currentAd.campaignId,
          campaignConfiguredStatus: currentAd.campaignConfiguredStatus,
          campaignEffectiveStatus: currentAd.campaignEffectiveStatus,
          adsetId: currentAd.adsetId,
          adsetConfiguredStatus: currentAd.adsetConfiguredStatus,
          adsetEffectiveStatus: currentAd.adsetEffectiveStatus,
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
          providerAccountId: null,
          adId: currentAd.adId ?? input.request.adId,
          creativeId: null,
          campaignId: null,
          campaignConfiguredStatus: null,
          campaignEffectiveStatus: null,
          adsetId: null,
          adsetConfiguredStatus: null,
          adsetEffectiveStatus: null,
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
    now,
  });
}
