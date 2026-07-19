import { describe, expect, it } from "vitest";

import {
  NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
  NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION,
  buildAdRecommendationEpisode,
} from "@/lib/creative-decision-engine/ad-operator-response-detection";
import { hashAdDecisionIdentityManifest } from "@/lib/creative-decision-engine/data-source";
import { canonicalSha256 } from "@/lib/creative-decision-engine/canonical-evaluation";
import { AD_DECISION_EVALUATION_CONTRACT_VERSION } from "@/lib/creative-decision-engine/evaluation-store";
import {
  AD_CALIBRATION_JOB_NAME,
  computeNativeAdCalibrationCellSetHash,
  type NativeAdCalibrationCellKey,
} from "@/lib/creative-decision-engine/jobs/ad-calibration-job";
import { AD_DECISIONS_JOB_NAME } from "@/lib/creative-decision-engine/jobs/ad-decisions-job";
import { AD_OPERATOR_RESPONSE_JOB_NAME } from "@/lib/creative-decision-engine/jobs/ad-operator-response-job";
import { NATIVE_AD_ENGINE_VERSION } from "@/lib/creative-decision-engine/types";

import {
  LIVE_TUNNEL_HOST,
  LIVE_TUNNEL_PORT,
  OPERATIONAL_SELECT_QUERIES,
  READ_ONLY_BEGIN_SQL,
  READ_ONLY_ROLLBACK_SQL,
  READ_ONLY_TIMEOUT_SQL,
  assertLiveReadOnlyEnvironment,
  deterministicJson,
  evaluateOperationalFacts,
  parseVerifierArgs,
  type CalibrationBatchFact,
  type JobRunFact,
  type OperationalFacts,
  type VerifierArgs,
} from "./native-ad-natural-wave-operational-verifier";

const BUSINESS_ID = "11111111-1111-4111-8111-111111111111";
const UNBOUND_ID = "22222222-2222-4222-8222-222222222222";
const ACCOUNT_REF = "33333333-3333-4333-8333-333333333333";
const ACCOUNT_ID = "act_123";
const SOURCE_RUN_ID = "44444444-4444-4444-8444-444444444444";
const PRIOR_CALIBRATION_ID = "55555555-5555-4555-8555-555555555555";
const CALIBRATION_ID = "66666666-6666-4666-8666-666666666666";
const DECISIONS_ID = "77777777-7777-4777-8777-777777777777";
const OPERATOR_ID = "88888888-8888-4888-8888-888888888888";
const BATCH_ID = "99999999-9999-4999-8999-999999999999";
const CALIBRATION_CELL_ID = "dddddddd-dddd-4ddd-8ddd-dddddddddddd";
const CONTEXT_ID = "aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa";
const AS_OF = "2026-07-20";
const SHA_A = "a".repeat(64);
const SHA_B = "b".repeat(64);
const SHA_C = "c".repeat(64);
const SHA_D = "d".repeat(64);

const args: VerifierArgs = {
  asOf: AS_OF,
  deployAnchor: "2026-07-19T05:00:00.000Z",
  expectedBusinessCount: 1,
  expectedProviderAccountCount: 1,
  expectedUnbound: ["Enise"],
  envDefaultEnabled: true,
  outputPath: `/private/tmp/native-ad-natural-wave-${AS_OF}.json`,
};

function job(
  input: Partial<JobRunFact> & Pick<JobRunFact, "id" | "jobName">,
): JobRunFact {
  return {
    id: input.id,
    jobName: input.jobName,
    businessRefId: input.businessRefId ?? BUSINESS_ID,
    businessId: input.businessId ?? BUSINESS_ID,
    asOf: input.asOf ?? AS_OF,
    engineVersion: input.engineVersion ?? NATIVE_AD_ENGINE_VERSION,
    status: input.status ?? "success",
    dependencyRunId: input.dependencyRunId ?? null,
    startedAt: input.startedAt ?? "2026-07-20T03:00:00.000Z",
    finishedAt: input.finishedAt ?? "2026-07-20T03:01:00.000Z",
    rowCount: input.rowCount ?? 0,
    errorCode: input.errorCode ?? null,
    errorMessage: input.errorMessage ?? null,
    errorJson: input.errorJson ?? { metadata: {} },
  };
}

function calibrationHash(batch: CalibrationBatchFact): string {
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

function validFacts(): OperationalFacts {
  const adIds = ["ad-1", "ad-2"];
  const adManifestHash = hashAdDecisionIdentityManifest({
    businessId: BUSINESS_ID,
    providerAccountId: ACCOUNT_ID,
    asOfDate: AS_OF,
    adIds,
  });
  const batch: CalibrationBatchFact = {
    id: BATCH_ID,
    businessRefId: BUSINESS_ID,
    businessId: BUSINESS_ID,
    providerAccountRefId: ACCOUNT_REF,
    providerAccountId: ACCOUNT_ID,
    asOf: AS_OF,
    asOfCutoff: "2026-07-20T02:00:00.000Z",
    transactionIsolation: "repeatable read",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    policyVersion: `retained-account-calibration.${NATIVE_AD_ENGINE_VERSION}`,
    sourceMode: "current_transaction_snapshot",
    sourceProvenance: {
      mode: "current_transaction_snapshot",
      providerAccountRefId: ACCOUNT_REF,
      providerAccountId: ACCOUNT_ID,
      transactionCutoff: "2026-07-20T02:00:00.000Z",
      transactionIsolation: "repeatable read",
    },
    expectedCellCount: 1,
    generationContentHash: SHA_A,
    inputManifestHash: SHA_B,
    sourceManifestHash: SHA_C,
    cellSetHash: "",
    completenessStatus: "complete",
    jobRunId: PRIOR_CALIBRATION_ID,
    computedAt: "2026-07-20T02:00:00.000Z",
    completedAt: "2026-07-20T02:00:30.000Z",
    cells: [
      {
        id: CALIBRATION_CELL_ID,
        batchId: BATCH_ID,
        jobRunId: PRIOR_CALIBRATION_ID,
        businessId: BUSINESS_ID,
        providerAccountRefId: ACCOUNT_REF,
        providerAccountId: ACCOUNT_ID,
        accountTimezone: "UTC",
        accountCurrency: "USD",
        cellScope: "objective_cohort_context",
        objective: "OUTCOME_SALES",
        funnelCohort: "purchase",
        optimizationContext: "offsite_conversion.purchase",
        batchInputManifestHash: SHA_B,
        inputManifestHash: SHA_D,
        sourceManifestHash: SHA_C,
      },
    ],
  };
  batch.cellSetHash = calibrationHash(batch);
  const contextJson = {
    contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
    envelopeType: "context",
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    scope: { type: "account", id: ACCOUNT_ID },
    accountProfile: {
      businessId: BUSINESS_ID,
      scope: { type: "account", id: ACCOUNT_ID },
      hardActionEligibility: { scale: true, cut: true, refresh: true },
    },
    dataHealth: { source: "test" },
    flags: { businessId: BUSINESS_ID, enabled: true },
  };
  const contextHash = canonicalSha256(contextJson);
  const evaluations = adIds.map((adId, index) => {
    const creativeInputJson = {
      businessId: BUSINESS_ID,
      creativeId: null,
      decisionEntityType: "ad",
      decisionEntityId: adId,
      adId,
      providerAccountId: ACCOUNT_ID,
      campaignId: "campaign-1",
      adsetId: "adset-1",
      spend: 10 + index,
      purchases: 1,
      roas: 2,
      recent7dRoas: 2,
    };
    const campaignContextJson = {
      source: "test",
      campaignId: "campaign-1",
    };
    const priorHysteresisJson = { source: "none" };
    const decisionOutputJson = {
      creativeId: null,
      decisionEntityType: "ad",
      decisionEntityId: adId,
      adId,
      providerAccountId: ACCOUNT_ID,
      label: "keep",
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      confidence: 70,
      truthSource: "commercial_truth",
      effectiveTargetRoas: 2,
      ratioToTarget: 1,
      badges: [],
      reason: "Exact test decision",
      blockedActionType: null,
      labelTransform: null,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
    };
    const inputHash = canonicalSha256({
      contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
      envelopeType: "input",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      contextHash,
      creativeInput: creativeInputJson,
      campaignContext: campaignContextJson,
      priorHysteresis: priorHysteresisJson,
      decisionIdentity: {
        decisionEntityType: "ad",
        decisionEntityId: adId,
        adId,
        providerAccountId: ACCOUNT_ID,
        providerAccountRefId: ACCOUNT_REF,
        creativeGroupingId: null,
      },
    });
    const decisionHash = canonicalSha256({
      contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
      envelopeType: "decision",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      inputHash,
      decision: decisionOutputJson,
      rawLabel: "keep",
      publishedLabel: "keep",
      hysteresisSuppressed: false,
    });
    return {
      id: `bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbb${index}`,
      contextId: CONTEXT_ID,
      businessRefId: BUSINESS_ID,
      businessId: BUSINESS_ID,
      providerAccountRefId: ACCOUNT_REF,
      providerAccountId: ACCOUNT_ID,
      decisionEntityType: "ad",
      decisionEntityId: adId,
      adId,
      creativeId: null,
      asOf: AS_OF,
      engineVersion: NATIVE_AD_ENGINE_VERSION,
      scopeType: "account",
      scopeId: ACCOUNT_ID,
      contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
      creativeInputJson,
      campaignContextJson,
      priorHysteresisJson,
      decisionOutputJson,
      rawLabel: "keep",
      hysteresisSuppressed: false,
      inputHash,
      decisionHash,
      jobRunId: DECISIONS_ID,
    };
  });
  const snapshots = evaluations.map((evaluation, index) => ({
    id: `cccccccc-cccc-4ccc-8ccc-ccccccccccc${index}`,
    evaluationId: evaluation.id,
    businessRefId: BUSINESS_ID,
    businessId: BUSINESS_ID,
    providerAccountRefId: ACCOUNT_REF,
    providerAccountId: ACCOUNT_ID,
    decisionEntityType: "ad",
    decisionEntityId: evaluation.adId,
    adId: evaluation.adId,
    creativeId: null,
    asOf: AS_OF,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    scopeType: "account",
    scopeId: ACCOUNT_ID,
    inputHash: evaluation.inputHash,
    decisionHash: evaluation.decisionHash,
    label: "keep",
    rawLabel: "keep",
    preAuthorityLabel: "keep",
    authorityBlocker: null,
    confidence: 70,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1,
    badges: [],
    reason: "Exact test decision",
    spend: 10 + index,
    purchases: 1,
    roas: 2,
    recent7dRoas: 2,
    labelTransform: null,
    blockedActionType: null,
    authorizedAction: null,
    calibrationRowId: CALIBRATION_CELL_ID,
    jobRunId: DECISIONS_ID,
  }));
  const hydrationReceipt = {
    contract_version: "native-ad-hydration-receipt.v1",
    provider_account_ref_id: ACCOUNT_REF,
    provider_account_id: ACCOUNT_ID,
    decision_cutoff: "2026-07-20T03:06:30.000Z",
    source_run_id: SOURCE_RUN_ID,
    source_observed_at: "2026-07-20T03:00:00.000Z",
    source_captured_at: "2026-07-20T03:01:00.000Z",
    source_run_hash: SHA_A,
    source_payload_hash: SHA_B,
    source_expected_row_count: 2,
    source_persisted_row_count: 2,
    expected_ad_count: 2,
    expected_manifest_hash: adManifestHash,
    hydrated_ad_count: 2,
    hydrated_manifest_hash: adManifestHash,
    source_complete: true,
    hydration_complete: true,
    authoritative_for_prune: true,
    reason: null,
  };
  const episode = buildAdRecommendationEpisode({
    businessId: BUSINESS_ID,
    businessDisplayId: BUSINESS_ID,
    providerAccountRefId: ACCOUNT_REF,
    providerAccountId: ACCOUNT_ID,
    adId: "ad-1",
    creativeId: null,
    asOfDate: AS_OF,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    scopeType: "account",
    scopeId: ACCOUNT_ID,
    snapshotId: snapshots[0]!.id,
    evaluationId: evaluations[0]!.id,
    inputHash: evaluations[0]!.inputHash,
    decisionHash: evaluations[0]!.decisionHash,
    decisionLabel: "keep",
    sourceCampaignId: "campaign-1",
    sourceAdsetId: "adset-1",
    recommendedAt: "2026-07-20T03:07:00.000Z",
  });
  const responseCutoff = "2026-07-20T03:08:00.000Z";
  const sourceProof = {
    contractVersion: NATIVE_AD_OPERATOR_SOURCE_PROOF_CONTRACT_VERSION,
    windowStart: "2026-07-20T03:07:00.000Z",
    windowEnd: "2026-07-27T03:07:00.000Z",
    windowClosed: false,
    actionReceiptsComplete: true,
    stateHistoryComplete: true,
    tombstonesComplete: true,
    requiredStateTargetCount: 3,
    completeStateTargetCount: 0,
    actionReceiptCount: 0,
    stateObservationCount: 0,
    tombstoneObservationCount: 0,
    sourceComplete: false,
    sourceSetHash: SHA_C,
  };
  const responseBase = {
    contractVersion: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
    episodeKey: episode.episodeKey,
    observationStatus: "unknown_incomplete",
    responseType: "unknown_incomplete",
    operatorResponseDetected: false,
    adTreatmentDetected: false,
    detectedAt: null,
    actionReceiptId: null,
    actionLogId: null,
    successorAdId: null,
    successorKind: null,
    budgetOwnerType: null,
    budgetOwnerId: null,
    sourceProof,
    diagnostics: [],
    evidence: [],
  };
  const responseHash = canonicalSha256(responseBase);
  const evidenceSetHash = canonicalSha256({
    episodeKey: episode.episodeKey,
    responseCutoff,
    evidenceHashes: [],
  });
  const replacementSetHash = canonicalSha256({
    episodeKey: episode.episodeKey,
    responseCutoff,
    responseHash,
    sourceSetHash: sourceProof.sourceSetHash,
    evidenceSetHash,
    evidenceCount: 0,
  });
  return {
    readOnlySession: {
      observedAt: "2026-07-20T04:00:00.000Z",
      transactionReadOnly: "on",
      defaultTransactionReadOnly: "on",
      transactionIsolation: "repeatable read",
      statementTimeout: "30s",
      applicationName: "adsecute-native-wave-verifier-test",
    },
    envEnabledDefault: true,
    manifest: [
      {
        businessId: BUSINESS_ID,
        businessName: "Iwa Store",
        createdAt: "2026-01-01T00:00:00.000Z",
        providerAccountRefId: ACCOUNT_REF,
        providerAccountId: ACCOUNT_ID,
      },
      {
        businessId: UNBOUND_ID,
        businessName: "Enise",
        createdAt: "2026-01-02T00:00:00.000Z",
        providerAccountRefId: null,
        providerAccountId: null,
      },
    ],
    jobs: [
      job({
        id: PRIOR_CALIBRATION_ID,
        jobName: AD_CALIBRATION_JOB_NAME,
        startedAt: "2026-07-20T02:00:00.000Z",
        finishedAt: "2026-07-20T02:01:00.000Z",
        rowCount: 1,
      }),
      job({
        id: CALIBRATION_ID,
        jobName: AD_CALIBRATION_JOB_NAME,
        startedAt: "2026-07-20T03:03:00.000Z",
        finishedAt: "2026-07-20T03:05:00.000Z",
        rowCount: 1,
        errorJson: {
          metadata: {
            provider_account_count: 1,
            expected_cell_count: 1,
            rows_written: 0,
            batches: [
              {
                provider_account_ref_id: ACCOUNT_REF,
                provider_account_id: ACCOUNT_ID,
                batch_id: BATCH_ID,
                generation_content_hash: SHA_A,
                input_manifest_hash: SHA_B,
                source_manifest_hash: SHA_C,
                cell_set_hash: batch.cellSetHash,
              },
            ],
          },
        },
      }),
      job({
        id: DECISIONS_ID,
        jobName: AD_DECISIONS_JOB_NAME,
        dependencyRunId: CALIBRATION_ID,
        startedAt: "2026-07-20T03:06:00.000Z",
        finishedAt: "2026-07-20T03:07:00.000Z",
        rowCount: 2,
        errorJson: {
          metadata: {
            authoritative_prune_receipt_count: 1,
            prune_skipped_unproven_receipt_count: 0,
            hydration_receipts: [hydrationReceipt],
          },
        },
      }),
      job({
        id: OPERATOR_ID,
        jobName: AD_OPERATOR_RESPONSE_JOB_NAME,
        startedAt: "2026-07-20T03:08:00.000Z",
        finishedAt: "2026-07-20T03:09:00.000Z",
        rowCount: 1,
        errorJson: {
          metadata: {
            episodes_captured: 1,
            episodes_evaluated: 1,
            evidence_events_written: 0,
            evidence_events_pruned: 0,
            responses_written: 1,
          },
        },
      }),
    ],
    contexts: [
      {
        id: CONTEXT_ID,
        businessRefId: BUSINESS_ID,
        businessId: BUSINESS_ID,
        providerAccountRefId: ACCOUNT_REF,
        providerAccountId: ACCOUNT_ID,
        asOf: AS_OF,
        engineVersion: NATIVE_AD_ENGINE_VERSION,
        scopeType: "account",
        scopeId: ACCOUNT_ID,
        contractVersion: AD_DECISION_EVALUATION_CONTRACT_VERSION,
        contextJson,
        accountProfileJson: contextJson.accountProfile,
        dataHealthJson: contextJson.dataHealth,
        flagsJson: contextJson.flags,
        contextHash,
        jobRunId: DECISIONS_ID,
      },
    ],
    evaluations,
    snapshots,
    sourceManifests: [
      {
        jobRunId: DECISIONS_ID,
        businessRefId: BUSINESS_ID,
        businessId: BUSINESS_ID,
        providerAccountRefId: ACCOUNT_REF,
        providerAccountId: ACCOUNT_ID,
        sourceRunId: SOURCE_RUN_ID,
        sourceObservedAt: "2026-07-20T03:00:00.000Z",
        sourceCapturedAt: "2026-07-20T03:01:00.000Z",
        sourceRunHash: SHA_A,
        sourcePayloadHash: SHA_B,
        sourceExpectedRowCount: 2,
        sourcePersistedRowCount: 2,
        expectedAdIds: adIds,
        identityShapeValid: true,
      },
    ],
    sourceRuns: [
      {
        id: SOURCE_RUN_ID,
        businessRefId: BUSINESS_ID,
        businessId: BUSINESS_ID,
        providerAccountRefId: ACCOUNT_REF,
        providerAccountId: ACCOUNT_ID,
        entityType: "ad",
        completeness: "complete",
        observedAt: "2026-07-20T03:00:00.000Z",
        capturedAt: "2026-07-20T03:01:00.000Z",
        runHash: SHA_A,
        payloadHash: SHA_B,
        expectedRowCount: 2,
        persistedRowCount: 2,
      },
    ],
    calibrationBatches: [batch],
    operatorResponses: [
      {
        jobRunId: OPERATOR_ID,
        responseCount: 1,
        lineageContradictionCount: 0,
        episodes: [
          {
            episodeKey: episode.episodeKey,
            contractVersion: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
            businessRefId: BUSINESS_ID,
            businessId: BUSINESS_ID,
            providerAccountRefId: ACCOUNT_REF,
            providerAccountId: ACCOUNT_ID,
            decisionEntityType: "ad",
            decisionEntityId: episode.adId,
            adId: episode.adId,
            creativeId: episode.creativeId,
            asOf: episode.asOfDate,
            engineVersion: episode.engineVersion,
            scopeType: episode.scopeType,
            scopeId: episode.scopeId,
            decisionSnapshotId: episode.snapshotId,
            evaluationId: episode.evaluationId,
            inputHash: episode.inputHash,
            decisionHash: episode.decisionHash,
            decisionLabel: episode.decisionLabel,
            sourceCampaignId: episode.sourceCampaignId,
            sourceAdsetId: episode.sourceAdsetId,
            parentSnapshotCreativeId: snapshots[0]!.creativeId,
            parentSnapshotLabel: snapshots[0]!.label,
            parentEvaluationCreativeId: evaluations[0]!.creativeId,
            parentInputCampaignId: "campaign-1",
            parentInputAdsetId: "adset-1",
            parentContextCampaignId: "campaign-1",
            recommendedAt: episode.recommendedAt,
            jobRunId: OPERATOR_ID,
            lineageValid: true,
          },
        ],
        events: [],
        responses: [
          {
            jobRunId: OPERATOR_ID,
            episodeKey: episode.episodeKey,
            businessRefId: BUSINESS_ID,
            businessId: BUSINESS_ID,
            providerAccountRefId: ACCOUNT_REF,
            providerAccountId: ACCOUNT_ID,
            contractVersion: NATIVE_AD_OPERATOR_RESPONSE_CONTRACT_VERSION,
            responseCutoff,
            observationStatus: "unknown_incomplete",
            responseType: "unknown_incomplete",
            operatorResponseDetected: false,
            adTreatmentDetected: false,
            detectedAt: null,
            actionReceiptId: null,
            actionLogId: null,
            successorAdId: null,
            successorKind: null,
            budgetOwnerType: null,
            budgetOwnerId: null,
            windowStart: sourceProof.windowStart,
            windowEnd: sourceProof.windowEnd,
            windowClosed: sourceProof.windowClosed,
            sourceComplete: sourceProof.sourceComplete,
            sourceSetHash: sourceProof.sourceSetHash,
            actionReceiptCount: sourceProof.actionReceiptCount,
            stateObservationCount: sourceProof.stateObservationCount,
            tombstoneObservationCount:
              sourceProof.tombstoneObservationCount,
            requiredStateTargetCount: sourceProof.requiredStateTargetCount,
            completeStateTargetCount: sourceProof.completeStateTargetCount,
            diagnosticsJson: [],
            evidenceHashesJson: [],
            evidenceCount: 0,
            evidenceSetHash,
            replacementSetHash,
            responseHash,
          },
        ],
      },
    ],
  };
}

function clonedFacts(): OperationalFacts {
  return structuredClone(validFacts());
}

function rebuildCanonicalHashes(facts: OperationalFacts) {
  const context = facts.contexts[0]!;
  context.contextHash = canonicalSha256(
    context.contextJson as Record<string, unknown>,
  );
  for (const evaluation of facts.evaluations) {
    const snapshot = facts.snapshots.find(
      (row) => row.evaluationId === evaluation.id,
    )!;
    evaluation.inputHash = canonicalSha256({
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
    });
    evaluation.decisionHash = canonicalSha256({
      contractVersion: evaluation.contractVersion,
      envelopeType: "decision",
      engineVersion: evaluation.engineVersion,
      inputHash: evaluation.inputHash,
      decision: evaluation.decisionOutputJson,
      rawLabel: evaluation.rawLabel,
      publishedLabel: snapshot.label,
      hysteresisSuppressed: evaluation.hysteresisSuppressed,
    });
    snapshot.inputHash = evaluation.inputHash;
    snapshot.decisionHash = evaluation.decisionHash;
  }
}

function rebuildOperatorResponseHashes(facts: OperationalFacts) {
  for (const proof of facts.operatorResponses) {
    for (const response of proof.responses) {
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
      response.responseHash = canonicalSha256({
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
        evidence: [],
      });
      response.replacementSetHash = canonicalSha256({
        episodeKey: response.episodeKey,
        responseCutoff: response.responseCutoff,
        responseHash: response.responseHash,
        sourceSetHash: response.sourceSetHash,
        evidenceSetHash: response.evidenceSetHash,
        evidenceCount: response.evidenceCount,
      });
    }
  }
}

function rebuildSingleOperatorEpisodeKey(facts: OperationalFacts) {
  const episode = facts.operatorResponses[0]!.episodes[0]!;
  episode.episodeKey = buildAdRecommendationEpisode({
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
  }).episodeKey;
  const response = facts.operatorResponses[0]!.responses[0]!;
  response.episodeKey = episode.episodeKey;
  response.sourceSetHash = canonicalSha256({
    episodeKey: episode.episodeKey,
    testSourceSet: true,
  });
  rebuildOperatorResponseHashes(facts);
}

describe("native ad natural-wave operational evaluator", () => {
  it("passes exact current-epoch proofs while deduplicating shared contexts", () => {
    const report = evaluateOperationalFacts(args, validFacts());
    expect(report.result).toBe("pass");
    expect(report.blockers).toEqual([]);
    expect(report.businesses[0]?.decisionProof).toMatchObject({
      snapshots: 2,
      evaluations: 2,
      contexts: 1,
      distinctReferencedContexts: 1,
    });
    expect(report.businesses[0]?.calibrationProof).toMatchObject({
      batches: 1,
      cells: 1,
      rowsWritten: 0,
    });
  });

  it("accepts a current response that evaluates an exact episode captured by an earlier operator job", () => {
    const facts = clonedFacts();
    facts.operatorResponses[0]!.episodes[0]!.jobRunId =
      "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
    const operator = facts.jobs.find((row) => row.id === OPERATOR_ID)!;
    (
      operator.errorJson as {
        metadata: Record<string, unknown>;
      }
    ).metadata.episodes_captured = 0;

    expect(evaluateOperationalFacts(args, facts).result).toBe("pass");
  });

  it("accepts a fully authoritative zero-ad receipt", () => {
    const facts = clonedFacts();
    facts.snapshots = [];
    facts.evaluations = [];
    facts.contexts = [];
    facts.sourceManifests[0]!.expectedAdIds = [];
    const decisions = facts.jobs.find((row) => row.id === DECISIONS_ID)!;
    decisions.rowCount = 0;
    const receipt = (
      (decisions.errorJson as {
        metadata: { hydration_receipts: Record<string, unknown>[] };
      }).metadata.hydration_receipts[0]!
    );
    const emptyHash = hashAdDecisionIdentityManifest({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      asOfDate: AS_OF,
      adIds: [],
    });
    receipt.source_expected_row_count = 2;
    receipt.source_persisted_row_count = 2;
    receipt.expected_ad_count = 0;
    receipt.hydrated_ad_count = 0;
    receipt.expected_manifest_hash = emptyHash;
    receipt.hydrated_manifest_hash = emptyHash;
    expect(evaluateOperationalFacts(args, facts).result).toBe("pass");
  });

  it("rejects a false empty receipt when independent source truth still has an Ad", () => {
    const facts = clonedFacts();
    facts.snapshots = [];
    facts.evaluations = [];
    facts.contexts = [];
    const decisions = facts.jobs.find((row) => row.id === DECISIONS_ID)!;
    decisions.rowCount = 0;
    const receipt = (
      decisions.errorJson as {
        metadata: { hydration_receipts: Record<string, unknown>[] };
      }
    ).metadata.hydration_receipts[0]!;
    const emptyHash = hashAdDecisionIdentityManifest({
      businessId: BUSINESS_ID,
      providerAccountId: ACCOUNT_ID,
      asOfDate: AS_OF,
      adIds: [],
    });
    receipt.expected_ad_count = 0;
    receipt.hydrated_ad_count = 0;
    receipt.expected_manifest_hash = emptyHash;
    receipt.hydrated_manifest_hash = emptyHash;
    const report = evaluateOperationalFacts(args, facts);
    expect(report.result).toBe("fail");
    expect(
      report.blockers.some((blocker) =>
        blocker.includes("hydration_receipt_proof_invalid"),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "orphan context",
      (facts: OperationalFacts) => {
        facts.contexts.push({
          ...facts.contexts[0]!,
          id: "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee",
        });
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "canonical context hash tamper",
      (facts: OperationalFacts) => {
        (
          facts.contexts[0]!.contextJson as Record<string, unknown>
        ).engineVersion = "tampered";
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "canonical account profile business lineage drift",
      (facts: OperationalFacts) => {
        const context = facts.contexts[0]!;
        (
          context.accountProfileJson as Record<string, unknown>
        ).businessId = UNBOUND_ID;
        (
          (context.contextJson as Record<string, unknown>)
            .accountProfile as Record<string, unknown>
        ).businessId = UNBOUND_ID;
        rebuildCanonicalHashes(facts);
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "canonical flags business lineage drift",
      (facts: OperationalFacts) => {
        const context = facts.contexts[0]!;
        (context.flagsJson as Record<string, unknown>).businessId =
          UNBOUND_ID;
        (
          (context.contextJson as Record<string, unknown>).flags as Record<
            string,
            unknown
          >
        ).businessId = UNBOUND_ID;
        rebuildCanonicalHashes(facts);
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "canonical profile scope lineage drift",
      (facts: OperationalFacts) => {
        const context = facts.contexts[0]!;
        const profileScope = {
          type: "account",
          id: "different-account",
        };
        (
          context.accountProfileJson as Record<string, unknown>
        ).scope = profileScope;
        (
          (context.contextJson as Record<string, unknown>)
            .accountProfile as Record<string, unknown>
        ).scope = profileScope;
        rebuildCanonicalHashes(facts);
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "canonical campaign lineage drift",
      (facts: OperationalFacts) => {
        (
          facts.evaluations[0]!.campaignContextJson as Record<
            string,
            unknown
          >
        ).campaignId = "different-campaign";
        rebuildCanonicalHashes(facts);
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "authorized hard action denied by its canonical profile",
      (facts: OperationalFacts) => {
        const context = facts.contexts[0]!;
        const contextJson = context.contextJson as Record<string, unknown>;
        const accountProfile = context.accountProfileJson as Record<
          string,
          unknown
        >;
        const contextAccountProfile = contextJson.accountProfile as Record<
          string,
          unknown
        >;
        (
          accountProfile.hardActionEligibility as Record<string, unknown>
        ).cut = false;
        (
          contextAccountProfile.hardActionEligibility as Record<
            string,
            unknown
          >
        ).cut = false;
        const cutSnapshot = facts.snapshots[0]!;
        const cutEvaluation = facts.evaluations.find(
          (row) => row.id === cutSnapshot.evaluationId,
        )!;
        const cutDecision = cutEvaluation.decisionOutputJson as Record<
          string,
          unknown
        >;
        cutSnapshot.label = "cut";
        cutSnapshot.rawLabel = "cut";
        cutSnapshot.preAuthorityLabel = "cut";
        cutSnapshot.authorizedAction = "cut";
        cutDecision.label = "cut";
        cutDecision.preAuthorityLabel = "cut";
        cutEvaluation.rawLabel = "cut";
        rebuildCanonicalHashes(facts);
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "hydration count mismatch",
      (facts: OperationalFacts) => {
        const decision = facts.jobs.find((row) => row.id === DECISIONS_ID)!;
        const receipt = (
          decision.errorJson as {
            metadata: { hydration_receipts: Record<string, unknown>[] };
          }
        ).metadata.hydration_receipts[0]!;
        receipt.hydrated_ad_count = 1;
      },
      "hydration_receipt_proof_invalid",
    ],
    [
      "wrong hydration contract",
      (facts: OperationalFacts) => {
        const decision = facts.jobs.find((row) => row.id === DECISIONS_ID)!;
        const receipt = (
          decision.errorJson as {
            metadata: { hydration_receipts: Record<string, unknown>[] };
          }
        ).metadata.hydration_receipts[0]!;
        receipt.contract_version = "wrong-contract";
      },
      "hydration_receipt_proof_invalid",
    ],
    [
      "calibration reuse from wrong epoch",
      (facts: OperationalFacts) => {
        facts.jobs.find(
          (row) => row.id === PRIOR_CALIBRATION_ID,
        )!.engineVersion = "wrong-epoch";
      },
      "calibration_receipt_batch_cell_proof_invalid",
    ],
    [
      "snapshot calibration row from an unreceipted batch",
      (facts: OperationalFacts) => {
        const foreignCellId = "eeeeeeee-eeee-4eee-8eee-eeeeeeeeeeee";
        const foreignBatch = structuredClone(facts.calibrationBatches[0]!);
        foreignBatch.id = "ffffffff-ffff-4fff-8fff-ffffffffffff";
        foreignBatch.cells[0]!.id = foreignCellId;
        foreignBatch.cells[0]!.batchId = foreignBatch.id;
        foreignBatch.cellSetHash = calibrationHash(foreignBatch);
        facts.calibrationBatches.push(foreignBatch);
        facts.snapshots[0]!.calibrationRowId = foreignCellId;
      },
      "decision_snapshot_evaluation_context_lineage_invalid",
    ],
    [
      "operator row count mismatch",
      (facts: OperationalFacts) => {
        facts.operatorResponses[0]!.responseCount = 0;
      },
      "operator_response_count_or_lineage_invalid",
    ],
    [
      "operator response hash tamper",
      (facts: OperationalFacts) => {
        facts.operatorResponses[0]!.responses[0]!.responseHash = SHA_A;
      },
      "operator_response_count_or_lineage_invalid",
    ],
    [
      "malformed terminal success",
      (facts: OperationalFacts) => {
        facts.jobs.find((row) => row.id === DECISIONS_ID)!.finishedAt = null;
      },
      "malformed_or_stuck_job_terminal",
    ],
    [
      "unbound native run",
      (facts: OperationalFacts) => {
        facts.jobs.push(
          job({
            id: "ffffffff-ffff-4fff-8fff-ffffffffffff",
            jobName: AD_DECISIONS_JOB_NAME,
            businessRefId: UNBOUND_ID,
            businessId: UNBOUND_ID,
            dependencyRunId: null,
            startedAt: "2026-07-20T03:10:00.000Z",
          }),
        );
      },
      "unbound_native_job_after_deploy",
    ],
    [
      "statement timeout evidence",
      (facts: OperationalFacts) => {
        facts.jobs.find((row) => row.id === DECISIONS_ID)!.errorMessage =
          "canceling statement due to statement timeout";
      },
      "statement_timeout_row",
    ],
  ])("fails closed for %s", (_name, mutate, expectedBlocker) => {
    const facts = clonedFacts();
    mutate(facts);
    const report = evaluateOperationalFacts(args, facts);
    expect(report.result).toBe("fail");
    expect(
      report.blockers.some((blocker) => blocker.includes(expectedBlocker)),
    ).toBe(true);
  });

  it.each([
    "ignored_action_lineage_mismatch",
    "receipt_integrity_mismatch",
    "action_state_observation_conflict",
    "multiple_verified_responses",
  ])(
    "rejects coherently rehashed operator authority contradiction %s",
    (code) => {
      const facts = clonedFacts();
      facts.operatorResponses[0]!.responses[0]!.diagnosticsJson = [
        {
          code,
          evidenceId: null,
          detail: "Coherent but release-blocking operator contradiction.",
        },
      ];
      rebuildOperatorResponseHashes(facts);

      const report = evaluateOperationalFacts(args, facts);
      expect(report.result).toBe("fail");
      expect(
        report.blockers.some((blocker) =>
          blocker.includes(
            "operator_response_count_or_lineage_invalid",
          ),
        ),
      ).toBe(true);
    },
  );

  it("rejects a coherently rehashed ambiguous conflict even when its diagnostic code is otherwise incomplete", () => {
    const facts = clonedFacts();
    const response = facts.operatorResponses[0]!.responses[0]!;
    response.responseType = "ambiguous_conflicting";
    response.diagnosticsJson = [
      {
        code: "unverified_action_log",
        evidenceId: null,
        detail: "Successor exact lineage contradicted the episode.",
      },
    ];
    rebuildOperatorResponseHashes(facts);

    const report = evaluateOperationalFacts(args, facts);
    expect(report.result).toBe("fail");
    expect(
      report.blockers.some((blocker) =>
        blocker.includes("operator_response_count_or_lineage_invalid"),
      ),
    ).toBe(true);
  });

  it.each([
    [
      "creative",
      (facts: OperationalFacts) => {
        facts.operatorResponses[0]!.episodes[0]!.creativeId =
          "different-creative";
      },
    ],
    [
      "decision label",
      (facts: OperationalFacts) => {
        facts.operatorResponses[0]!.episodes[0]!.decisionLabel = "cut";
      },
    ],
    [
      "source campaign",
      (facts: OperationalFacts) => {
        facts.operatorResponses[0]!.episodes[0]!.sourceCampaignId =
          "different-campaign";
      },
    ],
    [
      "source ad set",
      (facts: OperationalFacts) => {
        facts.operatorResponses[0]!.episodes[0]!.sourceAdsetId =
          "different-adset";
      },
    ],
  ])(
    "rejects a self-consistent operator episode with wrong parent %s lineage",
    (_name, mutate) => {
      const facts = clonedFacts();
      mutate(facts);
      rebuildSingleOperatorEpisodeKey(facts);

      const report = evaluateOperationalFacts(args, facts);
      expect(report.result).toBe("fail");
      expect(
        report.blockers.some((blocker) =>
          blocker.includes(
            "operator_response_count_or_lineage_invalid",
          ),
        ),
      ).toBe(true);
    },
  );

  it("requires the exact unbound selector set", () => {
    const report = evaluateOperationalFacts(
      { ...args, expectedUnbound: [] },
      validFacts(),
    );
    expect(report.result).toBe("fail");
    expect(report.blockers).toContain(
      `manifest:unexpected_unbound_business:${UNBOUND_ID}`,
    );
  });
});

describe("native ad natural-wave verifier safety boundary", () => {
  it("requires the tunnel, PGAPPNAME, and read-only PGOPTIONS", () => {
    expect(
      assertLiveReadOnlyEnvironment({
        DATABASE_URL: `postgresql://user:pass@${LIVE_TUNNEL_HOST}:${LIVE_TUNNEL_PORT}/db`,
        PGAPPNAME: "native-wave-proof",
        PGOPTIONS: "-c default_transaction_read_only=on",
      }),
    ).toEqual({
      connectionString: `postgresql://user:pass@${LIVE_TUNNEL_HOST}:${LIVE_TUNNEL_PORT}/db`,
      applicationName: "native-wave-proof",
    });
    expect(() =>
      assertLiveReadOnlyEnvironment({
        DATABASE_URL: "postgresql://user:pass@localhost:5432/db",
        PGAPPNAME: "native-wave-proof",
        PGOPTIONS: "-c default_transaction_read_only=on",
      }),
    ).toThrow(/existing 127\.0\.0\.1:15432 live tunnel/);
    expect(() =>
      assertLiveReadOnlyEnvironment({
        DATABASE_URL: `postgresql://user:pass@${LIVE_TUNNEL_HOST}:${LIVE_TUNNEL_PORT}/db`,
        PGAPPNAME: "native-wave-proof",
        PGOPTIONS: "-c default_transaction_read_only=off",
      }),
    ).toThrow(/default_transaction_read_only=on/);
  });

  it("contains only SELECT CTEs and the explicit read-only transaction", () => {
    expect(READ_ONLY_BEGIN_SQL).toBe(
      "BEGIN TRANSACTION ISOLATION LEVEL REPEATABLE READ READ ONLY",
    );
    expect(READ_ONLY_TIMEOUT_SQL).toBe(
      "SET LOCAL statement_timeout = '30s'",
    );
    expect(READ_ONLY_ROLLBACK_SQL).toBe("ROLLBACK");
    for (const sql of OPERATIONAL_SELECT_QUERIES) {
      expect(sql.trim()).toMatch(
        /^(?:(?:\/\*[\s\S]*?\*\/)\s*)?(?:SELECT|WITH)\b/,
      );
      expect(sql).not.toMatch(
        /\b(?:INSERT|UPDATE|DELETE|MERGE|ALTER|CREATE|DROP|TRUNCATE|CALL|COPY)\b/i,
      );
    }
  });

  it("parses required release anchors and repeatable exact selectors", () => {
    expect(
      parseVerifierArgs([
        `--as-of=${AS_OF}`,
        "--deploy-anchor=2026-07-19T05:00:00Z",
        "--expected-business-count=12",
        "--expected-provider-account-count=13",
        "--expected-unbound=Enise",
        `--expected-unbound=${UNBOUND_ID}`,
        "--env-default-enabled=true",
      ]),
    ).toMatchObject({
      asOf: AS_OF,
      deployAnchor: "2026-07-19T05:00:00.000Z",
      expectedBusinessCount: 12,
      expectedProviderAccountCount: 13,
      expectedUnbound: ["Enise", UNBOUND_ID],
      envDefaultEnabled: true,
    });
    expect(() =>
      parseVerifierArgs([
        `--as-of=${AS_OF}`,
        "--deploy-anchor=2026-07-20T03:00:00Z",
        "--expected-business-count=12",
        "--expected-provider-account-count=13",
        "--env-default-enabled=true",
      ]),
    ).toThrow(/before the requested natural 03:00 UTC wave/);
  });

  it("serializes reports deterministically", () => {
    const left = deterministicJson({ z: 1, a: { y: 2, b: 3 } });
    const right = deterministicJson({ a: { b: 3, y: 2 }, z: 1 });
    expect(left).toBe(right);
  });
});
