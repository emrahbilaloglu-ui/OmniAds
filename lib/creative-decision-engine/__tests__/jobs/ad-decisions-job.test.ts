import { readFileSync } from "node:fs";
import { describe, expect, it, vi } from "vitest";

import type { DbClient } from "@/lib/db";
import { NATIVE_AD_DB_BATCH_SIZE } from "../../batching";
import type { CampaignContextLabelMap } from "../../campaign-context/source";
import {
  AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
  hashAdDecisionIdentityManifest,
  type AdDecisionHydrationReceipt,
} from "../../data-source";
import { READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY } from "../../decision-stability";
import {
  INSERT_NATIVE_AD_DECISION_CHANGE_EVENTS_QUERY,
  PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY,
  UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY,
  assertEmptyNativeAdHydrationIsAuthoritative,
  buildNativeAdDecisionChangeEvents,
  buildNativeAdDataHealth,
  computeNativeAdDecisions,
  computeSoftOnlyNativeAdDecisions,
  pruneStaleNativeAdSnapshots,
  reconcileNativeAdDecisionChangeEvents,
  resolveNativeAdDecisionProfileGroups,
  toNativeSnapshotPayload,
  upsertNativeAdDecisionSnapshots,
  type NativeSnapshotPayloadRow,
} from "../../jobs/ad-decisions-job";
import {
  buildNativeAdOptimizationContext,
  NATIVE_AD_CALIBRATION_POLICY_VERSION,
  resolveNativeAdCalibrationCutoff,
  resolveNativeAdCalibrationActionReadiness,
  resolveNativeAdTargetAuthority,
  type NativeAdCalibrationCell,
  type NativeAdTargetAuthorityInput,
} from "../../jobs/ad-calibration-job";
import type { EngineV3Flags } from "../../feature-flags";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AdDecisionInput,
  type DecisionOutput,
} from "../../types";
import {
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "../helpers";

const BUSINESS_ID = "biz-1";
const AS_OF = "2026-07-12";
const NATIVE_CALIBRATION_ROW_ID = "00000000-0000-4000-8000-000000000744";
const PROVIDER_ACCOUNT_REF_ID = "00000000-0000-4000-8000-000000000740";
const TARGET_AUTHORITY: NativeAdTargetAuthorityInput = {
  sourceRowId: "00000000-0000-4000-8000-000000000745",
  operation: "upsert",
  targetCpa: 50,
  targetRoas: 2,
  breakEvenCpa: 70,
  breakEvenRoas: 1.5,
  operatorAovAssumption: 100,
  defaultRiskPosture: "balanced",
  effectiveAt: "2026-07-01T00:00:00.000Z",
  recordedAt: "2026-07-01T00:00:01.000Z",
};

function nativeFlags(): EngineV3Flags {
  return {
    businessId: BUSINESS_ID,
    enabled: true,
    surfaceVisible: false,
    shadowOnly: true,
    presetOverride: null,
    source: {
      enabled: "env",
      surfaceVisible: "env",
      shadowOnly: "env",
      presetOverride: null,
    },
    envDefaults: {
      enabled: true,
      surfaceVisible: false,
      shadowOnly: true,
    },
  };
}

function readyNativeCalibrationCell(): NativeAdCalibrationCell {
  const profile = makeAccountDecisionProfile({
    businessId: BUSINESS_ID,
    asOfDate: AS_OF,
    scope: { type: "account", id: "act-1" },
  });
  const cutoff = resolveNativeAdCalibrationCutoff(
    AS_OF,
    `${AS_OF}T03:05:00.000Z`,
  );
  const key = {
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-1",
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    cellScope: "objective_cohort_context" as const,
    objective: "OUTCOME_SALES",
    cohort: "purchase" as const,
    optimizationContext: buildNativeAdOptimizationContext(
      "PURCHASE",
      "PURCHASE",
    )!,
  };
  const metricSampleCounts = {
    roas: 50,
    roasRatio: 50,
    cpa: 50,
    winner: 50,
    refreshRatio: 50,
    lowCtr: 50,
    ctr: 50,
    cpm: 50,
    thumbstop: 50,
    linkToLpv: 50,
    linkToAtc: 50,
    lpvToAtc: 50,
    atcToIc: 50,
    icToPurchase: 50,
    clickToPurchase: 50,
  };
  const targetAuthority = resolveNativeAdTargetAuthority(
    TARGET_AUTHORITY,
    cutoff.asOfCutoff,
  );
  const accountCalibration = {
    ...profile.accountBaselines,
    businessId: BUSINESS_ID,
    computedAt: `${AS_OF}T03:05:00.000Z`,
    matureCreativeCount: 50,
  };
  return {
    batchId: "00000000-0000-4000-8000-000000000746",
    batchCompleteness: "complete",
    batchCellCount: 1,
    batchCellSetHash: "9".repeat(64),
    key,
    asOfDate: AS_OF,
    asOfCutoff: cutoff.asOfCutoff,
    sampleWindowStart: cutoff.sampleWindowStart,
    sampleWindowEnd: cutoff.sampleWindowEnd,
    sampleWindowDays: 90,
    computedAt: `${AS_OF}T03:05:00.000Z`,
    engineVersion: NATIVE_AD_ENGINE_VERSION,
    policyVersion: NATIVE_AD_CALIBRATION_POLICY_VERSION,
    qualityStatus: "ready",
    sourceAdCount: 50,
    sourceDayCount: 50,
    eligibleAdCount: 50,
    matureAdCount: 50,
    zeroConversionAdCount: 0,
    metricSampleCounts,
    actionReadiness: resolveNativeAdCalibrationActionReadiness({
      key,
      matureAdCount: 50,
      metricSampleCounts,
      targetAuthority,
      accountCalibration,
    }),
    sourceMinDate: cutoff.sampleWindowStart,
    sourceMaxDate: cutoff.sampleWindowEnd,
    sourceMaxUpdatedAt: `${AS_OF}T02:00:00.000Z`,
    targetAuthority,
    accountCalibration,
    funnelCalibration: profile.funnelCalibration,
    batchInputManifestHash: "8".repeat(64),
    inputManifestHash: "7".repeat(64),
    sourceManifestHash: "6".repeat(64),
    qualityCounts: {
      candidateSourceRowCount: 50,
      cutoffSafeSourceRowCount: 50,
      candidateAdCount: 50,
      eligibleAdObservationCount: 50,
      identitySourceRowExclusionCount: 0,
      duplicateSourceRowExclusionCount: 0,
      duplicateConflictAdExclusionCount: 0,
      missingContextAdExclusionCount: 0,
      mixedContextAdExclusionCount: 0,
      mixedCurrencyAdExclusionCount: 0,
      mixedObjectiveAdExclusionCount: 0,
      mixedCohortAdExclusionCount: 0,
      censoredSourceRowExclusionCount: 0,
      censoredAdExclusionCount: 0,
      freshnessSourceRowExclusionCount: 0,
      freshnessAdExclusionCount: 0,
      commercialAuthorityAdExclusionCount: 0,
    },
  };
}

function adInput(input: {
  adId: string;
  campaignId: string;
  creativeId?: string | null;
  metricsObserved?: boolean;
  objective?: AdDecisionInput["objective"];
  effectiveCohort?: AdDecisionInput["effectiveCohort"];
  optimizationGoal?: string | null;
  customEventType?: string | null;
}): AdDecisionInput {
  const creative = makeCreativeInput({
    businessId: BUSINESS_ID,
    creativeId:
      input.creativeId === null ? "resolver-placeholder" : "shared-creative",
    campaignId: input.campaignId,
    objective: input.objective ?? "OUTCOME_SALES",
    effectiveCohort: input.effectiveCohort ?? "purchase",
    contextGrain: {
      providerAccountCount: 1,
      campaignCount: 1,
      adsetCount: 1,
      optimizationContextCount: 1,
      objectiveCount: 1,
      contextIdentityUnknown: false,
    },
  });
  return {
    ...creative,
    decisionEntityType: "ad",
    decisionEntityId: input.adId,
    adId: input.adId,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-1",
    accountTimezone: "Europe/Istanbul",
    accountCurrency: "USD",
    adsetId: `adset-${input.adId}`,
    creativeId:
      input.creativeId === undefined ? "shared-creative" : input.creativeId,
    optimizationGoal:
      input.optimizationGoal === undefined
        ? "PURCHASE"
        : input.optimizationGoal,
    customEventType:
      input.customEventType === undefined ? "PURCHASE" : input.customEventType,
    metricEvidence: {
      sourceRowCount: input.metricsObserved === false ? 0 : 28,
      performanceMetricsObserved: input.metricsObserved !== false,
      eventMetricsObserved: input.metricsObserved !== false,
    },
    statusEvidence: {
      source: "entity_state_history",
      sourceRecordId: `state-${input.adId}`,
      observedAt: `${AS_OF}T02:00:00.000Z`,
      capturedAt: `${AS_OF}T02:01:00.000Z`,
    },
    creativeEvidence: {
      sourceLifecycleRowId:
        input.creativeId === null ? null : `lifecycle-${input.adId}`,
      sourceAsOfDate: input.creativeId === null ? null : AS_OF,
      sourceComputedAt:
        input.creativeId === null ? null : `${AS_OF}T02:30:00.000Z`,
      sourceMaxUpdatedAt:
        input.creativeId === null ? null : `${AS_OF}T02:00:00.000Z`,
      lifecyclePosition: creative.lifecyclePosition ?? null,
      daysSincePeak: creative.daysSincePeak ?? null,
      peakRoas30d: creative.peakRoas30d ?? null,
      peakConfidence: creative.peakConfidence ?? null,
      spendTrajectory30d: creative.spendTrajectory30d ?? null,
      spendSlope7d: creative.spendSlope7d ?? null,
      spendSlope30d: creative.spendSlope30d ?? null,
      roasSlope7d: creative.roasSlope7d ?? null,
      roasSlope30d: creative.roasSlope30d ?? null,
      fatigueStatus: creative.fatigueStatus,
      qualityRanking: creative.qualityRanking,
      engagementRateRanking: creative.engagementRateRanking,
      conversionRateRanking: creative.conversionRateRanking,
      creativeFormat: creative.creativeFormat,
    },
  };
}

function campaignContext(): CampaignContextLabelMap {
  return new Map(
    ["campaign-a", "campaign-b"].map((campaignId) => [
      campaignId,
      {
        kind: "main" as const,
        testDimension: null,
        provenance: {
          mode: "legacy_labels" as const,
          source: "legacy_label" as const,
          campaignId,
          kind: "main" as const,
          testDimension: null,
          contextTrust: null,
          sourceRecordType: "meta_campaign_label" as const,
          sourceRecordId: `label-${campaignId}`,
          sourceAsOfDate: AS_OF,
          sourceUpdatedAt: `${AS_OF}T01:00:00.000Z`,
          sourceHash:
            campaignId === "campaign-a" ? "a".repeat(64) : "b".repeat(64),
        },
      },
    ]),
  );
}

function hydrationReceipt(input: {
  adIds: string[];
  authoritative?: boolean;
}): AdDecisionHydrationReceipt {
  const adIds = [...input.adIds].sort();
  const manifestHash = hashAdDecisionIdentityManifest({
    businessId: BUSINESS_ID,
    providerAccountId: "act-1",
    asOfDate: AS_OF,
    adIds,
  });
  const authoritative = input.authoritative ?? true;
  return {
    contractVersion: AD_DECISION_HYDRATION_RECEIPT_CONTRACT_VERSION,
    businessId: BUSINESS_ID,
    providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
    providerAccountId: "act-1",
    scopeType: "account",
    scopeId: "act-1",
    asOfDate: AS_OF,
    decisionCutoff: `${AS_OF}T03:10:00.000Z`,
    sourceRunId: "00000000-0000-4000-8000-000000000749",
    sourceObservedAt: `${AS_OF}T02:00:00.000Z`,
    sourceCapturedAt: `${AS_OF}T02:01:00.000Z`,
    sourceRunHash: "a".repeat(64),
    sourcePayloadHash: "b".repeat(64),
    sourceExpectedRowCount: adIds.length,
    sourcePersistedRowCount: adIds.length,
    expectedAdCount: adIds.length,
    expectedAdIds: adIds,
    expectedManifestHash: manifestHash,
    hydratedAdCount: adIds.length,
    hydratedManifestHash: manifestHash,
    sourceComplete: authoritative,
    hydrationComplete: authoritative,
    authoritativeForPrune: authoritative,
    reason: authoritative ? null : "source_receipt_unproven",
  };
}

function hardScaleDecision(input: { creativeId: string }): DecisionOutput {
  return {
    creativeId: input.creativeId,
    creativeName: "Shared creative",
    label: "scale",
    reason: "Controlled native-ad producer test decision.",
    confidence: 80,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 1.5,
    badges: [
      {
        type: "pending_transition",
        label: "Hard action pending.",
        severity: "info",
      },
    ],
    metrics: { spend: 100, purchases: 4, roas: 3, recent7dRoas: 3 },
    preAuthorityLabel: "scale",
    authorityBlocker: null,
    engineVersion: "legacy-resolver-epoch",
    generatedAt: `${AS_OF}T03:00:00.000Z`,
  };
}

function hardCutDecision(input: { creativeId: string }): DecisionOutput {
  return {
    creativeId: input.creativeId,
    creativeName: "Shared creative",
    label: "cut",
    reason: "Mature target-relative loss.",
    confidence: 80,
    truthSource: "commercial_truth",
    effectiveTargetRoas: 2,
    ratioToTarget: 0.4,
    badges: [],
    metrics: { spend: 500, purchases: 4, roas: 0.8, recent7dRoas: 0.8 },
    preAuthorityLabel: "cut",
    authorityBlocker: null,
    blockedActionType: null,
    engineVersion: "legacy-resolver-epoch",
    generatedAt: `${AS_OF}T03:00:00.000Z`,
  };
}

describe("native ad decision computation", () => {
  it("persists an engine-authorized cut when target age is the only advisory", () => {
    const adId = "ad-old-target-cut";
    const profile = makeAccountDecisionProfile({
      asOfDate: AS_OF,
      quality: {
        commercialTruthReady: true,
        commercialTruthFreshness: "stale",
        calibrationReady: true,
        metaAovQuality: "ready",
        thresholdQuality: "ready",
      },
    });
    const previousLabels = new Map([
      [
        `${BUSINESS_ID}\u0000${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000${adId}\u0000account\u0000*`,
        {
          businessId: BUSINESS_ID,
          providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
          providerAccountId: "act-1",
          decisionEntityType: "ad" as const,
          decisionEntityId: adId,
          sourceSnapshotId: "snapshot-prior-cut",
          sourceEvaluationId: "evaluation-prior-cut",
          sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
          sourceAsOfDate: "2026-07-11",
          sourceComputedAt: "2026-07-11T03:15:00.000Z",
          sourceInputHash: "a".repeat(64),
          sourceDecisionHash: "b".repeat(64),
          publishedLabel: "keep" as const,
          rawLabel: "cut" as const,
        },
      ],
    ]);
    const [computation] = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [adInput({ adId, campaignId: "campaign-a" })],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels,
      resolveDecision: (resolverInput) =>
        hardCutDecision({ creativeId: resolverInput.creativeId }),
    });
    if (!computation) throw new Error("Expected native Ad computation.");

    const payload = toNativeSnapshotPayload({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "00000000-0000-4000-8000-000000000741",
      scope: profile.scope,
      computation,
      stored: {
        evaluationId: "00000000-0000-4000-8000-000000000742",
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-1",
        decisionEntityId: adId,
        inputHash: "1".repeat(64),
        decisionHash: "2".repeat(64),
      },
      calibrationRowId: NATIVE_CALIBRATION_ROW_ID,
      hardActionEligibility: profile.hardActionEligibility,
      computedAt: `${AS_OF}T03:10:00.000Z`,
    });

    expect(payload).toMatchObject({
      label: "cut",
      raw_label: "cut",
      pre_authority_label: "cut",
      authority_blocker: null,
      blocked_action_type: null,
      authorized_action: "cut",
    });
  });

  it("publishes a low-peer commercial stop-loss only after a later-date confirmation", () => {
    const adId = "ad-commercial-stop-loss";
    const baseProfile = makeAccountDecisionProfile({
      asOfDate: AS_OF,
      scope: { type: "account", id: "act-1" },
      thresholds: { bottomQuartileRatio: null },
      hardActionEligibility: {
        scale: false,
        cut: true,
        refresh: false,
        reason: "scale calibration remains below its action floor",
        reasons: {
          scale: "scale calibration remains below its action floor",
          cut: null,
          refresh: "refresh calibration remains below its action floor",
        },
      },
    });
    const profile = {
      ...baseProfile,
      spendUnitEvidence: {
        ...baseProfile.spendUnitEvidence,
        targetRoas: 2,
        breakEvenRoas: 1.5,
      },
    };
    const input = {
      ...adInput({ adId, campaignId: "campaign-a" }),
      spend: 900,
      purchases: 3,
      purchaseValue: 540,
      roas: 0.6,
      cpa: 300,
      linkClicks: 200,
      landingPageViews: 180,
      addToCart: 30,
      initiateCheckout: 9,
      recent7dSpend: 210,
      recent7dPurchases: 1,
      recent7dRoas: 0.55,
      targetRoas: 2,
      breakevenRoas: 1.5,
    };
    const first = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [input],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
    })[0];
    if (!first) throw new Error("Expected first stop-loss computation.");

    expect(first).toMatchObject({
      rawLabel: "cut",
      hysteresisSuppressed: true,
      decision: {
        label: "keep",
        preAuthorityLabel: "cut",
        authorityBlocker: null,
        blockedActionType: "cut",
      },
    });
    const firstPayload = toNativeSnapshotPayload({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "00000000-0000-4000-8000-000000000761",
      scope: profile.scope,
      computation: first,
      stored: {
        evaluationId: "00000000-0000-4000-8000-000000000762",
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-1",
        decisionEntityId: adId,
        inputHash: "5".repeat(64),
        decisionHash: "6".repeat(64),
      },
      calibrationRowId: NATIVE_CALIBRATION_ROW_ID,
      hardActionEligibility: profile.hardActionEligibility,
      computedAt: `${AS_OF}T03:10:00.000Z`,
    });
    expect(firstPayload).toMatchObject({
      label: "keep",
      raw_label: "cut",
      blocked_action_type: "cut",
      authorized_action: null,
    });

    const stabilityKey = `${BUSINESS_ID}\u0000${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000${adId}\u0000account\u0000act-1`;
    const second = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [input],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map([
        [
          stabilityKey,
          {
            businessId: BUSINESS_ID,
            providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
            providerAccountId: "act-1",
            decisionEntityType: "ad" as const,
            decisionEntityId: adId,
            sourceSnapshotId: "snapshot-prior-stop-loss",
            sourceEvaluationId: "evaluation-prior-stop-loss",
            sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
            sourceAsOfDate: "2026-07-11",
            sourceComputedAt: "2026-07-11T03:15:00.000Z",
            sourceInputHash: "7".repeat(64),
            sourceDecisionHash: "8".repeat(64),
            publishedLabel: "keep" as const,
            rawLabel: "cut" as const,
          },
        ],
      ]),
    })[0];
    if (!second) throw new Error("Expected confirmed stop-loss computation.");
    expect(second).toMatchObject({
      rawLabel: "cut",
      hysteresisSuppressed: false,
      decision: {
        label: "cut",
        preAuthorityLabel: "cut",
        authorityBlocker: null,
        blockedActionType: null,
      },
    });
    const secondPayload = toNativeSnapshotPayload({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "00000000-0000-4000-8000-000000000763",
      scope: profile.scope,
      computation: second,
      stored: {
        evaluationId: "00000000-0000-4000-8000-000000000764",
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-1",
        decisionEntityId: adId,
        inputHash: "9".repeat(64),
        decisionHash: "a".repeat(64),
      },
      calibrationRowId: NATIVE_CALIBRATION_ROW_ID,
      hardActionEligibility: profile.hardActionEligibility,
      computedAt: `${AS_OF}T03:20:00.000Z`,
    });
    expect(secondPayload).toMatchObject({
      label: "cut",
      raw_label: "cut",
      blocked_action_type: null,
      authorized_action: "cut",
    });
    expect(READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY).toContain(
      "snapshot.as_of_date < $4::date",
    );
  });

  it("keeps a present-day dimension-only ad when profile context is incomplete", async () => {
    const groups = await resolveNativeAdDecisionProfileGroups({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      adInputs: [
        adInput({
          adId: "ad-no-profile-context",
          campaignId: "campaign-a",
          metricsObserved: false,
          optimizationGoal: null,
          customEventType: null,
        }),
      ],
      flags: nativeFlags(),
      dataSource: {
        async getNativeAdCalibrationCell() {
          throw new Error("Calibration lookup must not run without context.");
        },
        async getNativeTargetAuthorityAsOf() {
          throw new Error("Target lookup must not run without context.");
        },
        async getNativeCalibrationRowId() {
          throw new Error("Lineage lookup must not run without context.");
        },
      },
    });

    expect(groups).toHaveLength(1);
    expect(groups[0]).toMatchObject({
      calibrationRowId: null,
      blocker: "native_ad_profile_context_missing:optimization_context",
      profile: { profileType: "native_ad_soft_only" },
      adInputs: [{ adId: "ad-no-profile-context" }],
    });
  });

  it("classifies non-purchase optimization as out of scope without a calibration lookup", async () => {
    const getNativeAdCalibrationCell = vi.fn(async () => null);
    const groups = await resolveNativeAdDecisionProfileGroups({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      adInputs: [
        adInput({
          adId: "ad-traffic",
          campaignId: "campaign-traffic",
          objective: "OUTCOME_TRAFFIC",
          optimizationGoal: "LINK_CLICKS",
          customEventType: null,
          effectiveCohort: "traffic",
        }),
      ],
      flags: nativeFlags(),
      dataSource: {
        getNativeAdCalibrationCell,
        async getNativeTargetAuthorityAsOf() {
          throw new Error("Target lookup must not run outside purchase scope.");
        },
        async getNativeCalibrationRowId() {
          throw new Error(
            "Lineage lookup must not run outside purchase scope.",
          );
        },
      },
    });
    expect(getNativeAdCalibrationCell).not.toHaveBeenCalled();
    expect(groups).toHaveLength(1);
    const group = groups[0]!;
    expect(group.blocker).toBe(
      "native_ad_profile_unready:native_non_purchase_roas_unsupported",
    );
    const decisions = computeSoftOnlyNativeAdDecisions({
      businessId: BUSINESS_ID,
      blocker: group.blocker!,
      profile: group.profile,
      adInputs: group.adInputs,
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      evaluatedAt: `${AS_OF}T03:10:00.000Z`,
    });
    expect(decisions[0]?.decision).toMatchObject({
      label: "out_of_scope",
      preAuthorityLabel: "out_of_scope",
      authorityBlocker: null,
      confidence: 40,
      blockedActionType: null,
      blockers: [
        expect.objectContaining({ predicate: "native_ad_purchase_roas_scope" }),
      ],
    });
  });

  it("persists ready groups while emitting an explicit non-hard row for an unready dimension-only group", async () => {
    const readyCell = readyNativeCalibrationCell();
    const calibrationCalls: string[] = [];
    const profileDataSource = {
      async getNativeAdCalibrationCell(query: { optimizationContext: string }) {
        calibrationCalls.push(query.optimizationContext);
        return query.optimizationContext === readyCell?.key.optimizationContext
          ? readyCell
          : null;
      },
      async getNativeTargetAuthorityAsOf() {
        return TARGET_AUTHORITY;
      },
      async getNativeCalibrationRowId() {
        return NATIVE_CALIBRATION_ROW_ID;
      },
    };
    const inputs = [
      adInput({ adId: "ad-ready", campaignId: "campaign-a" }),
      adInput({
        adId: "ad-unready",
        campaignId: "campaign-b",
        metricsObserved: false,
        optimizationGoal: "VALUE",
      }),
    ];

    const groups = await resolveNativeAdDecisionProfileGroups({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      adInputs: inputs,
      flags: nativeFlags(),
      dataSource: profileDataSource,
    });
    const readyGroup = groups.find((group) => group.blocker === null);
    const softGroup = groups.find((group) => group.blocker !== null);
    expect(readyGroup).toMatchObject({
      calibrationRowId: NATIVE_CALIBRATION_ROW_ID,
      blocker: null,
    });
    expect(softGroup).toMatchObject({
      calibrationRowId: null,
      blocker: "native_ad_profile_unready:native_calibration_missing",
      profile: {
        profileType: "native_ad_soft_only",
        hardActionEligibility: {
          scale: false,
          cut: false,
          refresh: false,
        },
      },
    });
    expect(calibrationCalls).toHaveLength(2);
    if (!readyGroup || "profileType" in readyGroup.profile || !readyCell) {
      throw new Error("Ready native profile fixture did not resolve.");
    }
    if (!softGroup || !("profileType" in softGroup.profile)) {
      throw new Error("Soft-only native profile fixture did not resolve.");
    }
    const previousLabels = new Map<string, never>();
    const readyDecisions = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile: readyGroup.profile,
      dataHealth: buildNativeAdDataHealth({
        calibrationCell: readyGroup.calibrationCell,
        blocker: readyGroup.blocker,
        adInputs: readyGroup.adInputs,
        previousLabels,
        scope: readyGroup.profile.scope,
        evaluatedAt: `${AS_OF}T03:10:00.000Z`,
      }),
      adInputs: readyGroup.adInputs,
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels,
      resolveDecision: (resolverInput) => ({
        ...hardScaleDecision({ creativeId: resolverInput.creativeId }),
        label: "keep",
        preAuthorityLabel: "keep",
        confidence: 60,
      }),
    });
    const siteIssueDecisions = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile: readyGroup.profile,
      dataHealth: buildNativeAdDataHealth({
        calibrationCell: readyGroup.calibrationCell,
        blocker: readyGroup.blocker,
        adInputs: readyGroup.adInputs,
        previousLabels,
        scope: readyGroup.profile.scope,
        evaluatedAt: `${AS_OF}T03:10:00.000Z`,
      }),
      adInputs: readyGroup.adInputs,
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels,
      resolveDecision: (resolverInput) => ({
        ...hardScaleDecision({ creativeId: resolverInput.creativeId }),
        label: "diagnose",
        preAuthorityLabel: "diagnose",
        reason: "Landing page issue: Link-to-LPV collapsed.",
        badges: [
          {
            type: "landing_page_issue",
            label: "Landing page issue",
            severity: "warning",
          },
        ],
      }),
    });
    expect(siteIssueDecisions[0]?.decision).toMatchObject({
      label: "keep",
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      reason:
        "[Keep Ad; fix landing page] Landing page issue: Link-to-LPV collapsed.",
    });
    const softDecisions = computeSoftOnlyNativeAdDecisions({
      businessId: BUSINESS_ID,
      blocker: softGroup.blocker!,
      profile: softGroup.profile,
      adInputs: softGroup.adInputs,
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels,
      evaluatedAt: `${AS_OF}T03:10:00.000Z`,
    });
    expect(softDecisions).toHaveLength(1);
    expect(softDecisions[0]?.decision).toMatchObject({
      label: "diagnose",
      preAuthorityLabel: "diagnose",
      authorityBlocker: "native_profile_unavailable",
      confidence: 0,
      blockedActionType: null,
      blockers: [
        expect.objectContaining({ predicate: "native_ad_profile_ready" }),
      ],
    });
    expect(softDecisions[0]?.decision.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "native_calibration_unavailable" }),
        expect.objectContaining({ type: "ad_metrics_unavailable" }),
      ]),
    );

    const snapshotRows = [
      toNativeSnapshotPayload({
        businessId: BUSINESS_ID,
        asOf: AS_OF,
        jobRunId: "00000000-0000-4000-8000-000000000741",
        scope: readyGroup.profile.scope,
        computation: readyDecisions[0]!,
        stored: {
          evaluationId: "00000000-0000-4000-8000-000000000742",
          providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
          providerAccountId: "act-1",
          decisionEntityId: "ad-ready",
          inputHash: "1".repeat(64),
          decisionHash: "2".repeat(64),
        },
        calibrationRowId: readyGroup.calibrationRowId,
        hardActionEligibility: readyGroup.profile.hardActionEligibility,
        computedAt: `${AS_OF}T03:10:00.000Z`,
      }),
      toNativeSnapshotPayload({
        businessId: BUSINESS_ID,
        asOf: AS_OF,
        jobRunId: "00000000-0000-4000-8000-000000000741",
        scope: softGroup.profile.scope,
        computation: softDecisions[0]!,
        stored: {
          evaluationId: "00000000-0000-4000-8000-000000000743",
          providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
          providerAccountId: "act-1",
          decisionEntityId: "ad-unready",
          inputHash: "3".repeat(64),
          decisionHash: "4".repeat(64),
        },
        calibrationRowId: softGroup.calibrationRowId,
        hardActionEligibility: softGroup.profile.hardActionEligibility,
        computedAt: `${AS_OF}T03:10:00.000Z`,
      }),
    ];
    expect(snapshotRows.map((row) => row.calibration_row_id)).toEqual([
      NATIVE_CALIBRATION_ROW_ID,
      null,
    ]);
    expect(snapshotRows).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          pre_authority_label: "keep",
          authority_blocker: null,
        }),
        expect.objectContaining({
          pre_authority_label: "diagnose",
          authority_blocker: "native_profile_unavailable",
        }),
      ]),
    );
    const persisted = await upsertNativeAdDecisionSnapshots(
      snapshotRows,
      fakeDb([
        {
          id: "snapshot-ready",
          provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
          provider_account_id: "act-1",
          decision_entity_type: "ad",
          decision_entity_id: "ad-ready",
          scope_type: "account",
          scope_id: "act-1",
          label: readyDecisions[0]!.decision.label,
          confidence: readyDecisions[0]!.decision.confidence,
        },
        {
          id: "snapshot-unready",
          provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
          provider_account_id: "act-1",
          decision_entity_type: "ad",
          decision_entity_id: "ad-unready",
          scope_type: "account",
          scope_id: "act-1",
          label: "diagnose",
          confidence: 0,
        },
      ]),
    );
    expect(Array.from(persisted.keys()).sort()).toEqual([
      `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-ready\u0000account\u0000act-1`,
      `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-unready\u0000account\u0000act-1`,
    ]);
  });

  it("keeps shared-creative ads separate across context and hysteresis memory", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const previousLabels = new Map([
      [
        `${BUSINESS_ID}\u0000${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-a\u0000account\u0000*`,
        {
          businessId: BUSINESS_ID,
          providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
          providerAccountId: "act-1",
          decisionEntityType: "ad" as const,
          decisionEntityId: "ad-a",
          sourceSnapshotId: "snapshot-a",
          sourceEvaluationId: "evaluation-a",
          sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
          sourceAsOfDate: "2026-07-11",
          sourceComputedAt: "2026-07-11T03:15:00.000Z",
          sourceInputHash: "1".repeat(64),
          sourceDecisionHash: "2".repeat(64),
          publishedLabel: "keep" as const,
          rawLabel: "scale" as const,
        },
      ],
    ]);

    const result = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [
        adInput({ adId: "ad-b", campaignId: "campaign-b" }),
        adInput({ adId: "ad-a", campaignId: "campaign-a" }),
      ],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels,
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });

    expect(result.map((row) => row.input.adId)).toEqual(["ad-a", "ad-b"]);
    expect(result.map((row) => row.input.creativeId)).toEqual([
      "shared-creative",
      "shared-creative",
    ]);
    expect(result[0]).toMatchObject({
      decision: { decisionEntityId: "ad-a", label: "scale" },
      hysteresisSuppressed: false,
      campaignContext: { sourceRecordId: "label-campaign-a" },
      priorHysteresis: {
        source: "persisted_evaluation",
        sourceDecisionEntityId: "ad-a",
      },
    });
    expect(result[1]).toMatchObject({
      decision: {
        decisionEntityId: "ad-b",
        label: "keep",
        blockedActionType: "scale",
      },
      hysteresisSuppressed: true,
      campaignContext: { sourceRecordId: "label-campaign-b" },
      priorHysteresis: { source: "none", sourceDecisionEntityId: "ad-b" },
    });
  });

  it("keeps an ad with no creative grouping and fails missing metrics closed", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const [result] = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [
        adInput({
          adId: "ad-no-creative",
          campaignId: "campaign-a",
          creativeId: null,
          metricsObserved: false,
        }),
      ],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });

    expect(result?.input.creativeId).toBeNull();
    expect(result?.decision).toMatchObject({
      decisionEntityId: "ad-no-creative",
      creativeId: null,
      label: "diagnose",
      preAuthorityLabel: "scale",
      authorityBlocker: "native_metrics_unavailable",
      blockedActionType: "scale",
      engineVersion: NATIVE_AD_ENGINE_VERSION,
    });
    expect(result?.decision.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "ad_metrics_unavailable" }),
      ]),
    );
  });

  it("preserves the first campaign authority blocker when metrics are also unavailable", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const [result] = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [
        adInput({
          adId: "ad-multi-blocked",
          campaignId: "campaign-unclassified",
          metricsObserved: false,
        }),
      ],
      campaignContextMode: "legacy_labels",
      campaignContextById: new Map(),
      previousLabels: new Map(),
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });

    expect(result?.decision).toMatchObject({
      label: "diagnose",
      preAuthorityLabel: "scale",
      authorityBlocker: "campaign_context",
      blockedActionType: "scale",
    });
  });

  it("does not turn a hard pre-authority label into executable authority", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const [computation] = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [
        adInput({
          adId: "ad-review-only",
          campaignId: "campaign-unclassified",
        }),
      ],
      campaignContextMode: "legacy_labels",
      campaignContextById: new Map(),
      previousLabels: new Map(),
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });
    if (!computation) throw new Error("Expected native Ad computation.");
    const heldHardComputation = {
      ...computation,
      rawLabel: "scale" as const,
      decision: {
        ...computation.decision,
        label: "diagnose" as const,
        preAuthorityLabel: "scale" as const,
        authorityBlocker: "campaign_context" as const,
        blockedActionType: "scale" as const,
      },
    };

    const payload = toNativeSnapshotPayload({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "00000000-0000-4000-8000-000000000741",
      scope: profile.scope,
      computation: heldHardComputation,
      stored: {
        evaluationId: "00000000-0000-4000-8000-000000000742",
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-1",
        decisionEntityId: "ad-review-only",
        inputHash: "1".repeat(64),
        decisionHash: "2".repeat(64),
      },
      calibrationRowId: NATIVE_CALIBRATION_ROW_ID,
      hardActionEligibility: profile.hardActionEligibility,
      computedAt: `${AS_OF}T03:10:00.000Z`,
    });

    expect(payload).toMatchObject({
      pre_authority_label: "scale",
      authority_blocker: "campaign_context",
      raw_label: "scale",
      authorized_action: null,
    });
  });

  it("does not authorize a hard raw label while hysteresis publishes keep", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const [computation] = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [adInput({ adId: "ad-pending", campaignId: "campaign-a" })],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });
    if (!computation) throw new Error("Expected native Ad computation.");

    const payload = toNativeSnapshotPayload({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "00000000-0000-4000-8000-000000000751",
      scope: profile.scope,
      computation,
      stored: {
        evaluationId: "00000000-0000-4000-8000-000000000752",
        providerAccountRefId: PROVIDER_ACCOUNT_REF_ID,
        providerAccountId: "act-1",
        decisionEntityId: "ad-pending",
        inputHash: "3".repeat(64),
        decisionHash: "4".repeat(64),
      },
      calibrationRowId: NATIVE_CALIBRATION_ROW_ID,
      hardActionEligibility: profile.hardActionEligibility,
      computedAt: `${AS_OF}T03:10:00.000Z`,
    });

    expect(payload).toMatchObject({
      label: "keep",
      raw_label: "scale",
      authority_blocker: null,
      blocked_action_type: "scale",
      authorized_action: null,
    });
    expect(payload.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: "pending_transition" }),
      ]),
    );
  });

  it("keeps legacy creative lifecycle and ranking overlays out of resolver authority", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const source = adInput({ adId: "ad-overlay", campaignId: "campaign-a" });
    const resolveDecision = vi.fn((resolverInput) => {
      expect(resolverInput).toMatchObject({
        fatigueStatus: null,
        lifecyclePosition: null,
        daysSincePeak: null,
        peakRoas30d: null,
        qualityRanking: null,
        engagementRateRanking: null,
        conversionRateRanking: null,
        creativeFormat: null,
      });
      return hardScaleDecision({ creativeId: resolverInput.creativeId });
    });
    const dataHealth = buildNativeAdDataHealth({
      calibrationCell: readyNativeCalibrationCell(),
      blocker: null,
      adInputs: [source],
      previousLabels: new Map(),
      scope: { type: "account", id: "act-1" },
      evaluatedAt: `${AS_OF}T03:10:00.000Z`,
    });

    computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth,
      adInputs: [source],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      resolveDecision,
    });

    expect(resolveDecision).toHaveBeenCalledOnce();
    expect(dataHealth.lifecycle).toMatchObject({
      fallbackMode: "insufficient",
    });
    expect(dataHealth.lifecycle.note).toContain("explanation-only");
  });

  it("builds independent change events for ads that share one creative", () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const decisions = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [
        adInput({ adId: "ad-a", campaignId: "campaign-a" }),
        adInput({ adId: "ad-b", campaignId: "campaign-b" }),
      ],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });
    const previousSnapshots = new Map([
      [
        `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-a\u0000account\u0000${profile.scope.id}`,
        { id: "old-a", label: "diagnose" as const, confidence: 40 },
      ],
      [
        `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-b\u0000account\u0000${profile.scope.id}`,
        { id: "old-b", label: "diagnose" as const, confidence: 40 },
      ],
    ]);
    const currentSnapshots = new Map([
      [
        `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-a\u0000account\u0000${profile.scope.id}`,
        { id: "new-a", label: "keep" as const, confidence: 80 },
      ],
      [
        `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-b\u0000account\u0000${profile.scope.id}`,
        { id: "new-b", label: "keep" as const, confidence: 80 },
      ],
    ]);

    const events = buildNativeAdDecisionChangeEvents({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "job-1",
      scope: profile.scope,
      decisions,
      previousSnapshots,
      currentSnapshots,
    });

    expect(events.map((event) => event.decision_entity_id)).toEqual([
      "ad-a",
      "ad-b",
    ]);
    expect(events.map((event) => event.creative_id)).toEqual([
      "shared-creative",
      "shared-creative",
    ]);
    expect(new Set(events.map((event) => event.decision_snapshot_id))).toEqual(
      new Set(["new-a", "new-b"]),
    );
  });
});

function snapshotPayload(): NativeSnapshotPayloadRow {
  return {
    business_ref_id: "00000000-0000-4000-8000-000000000001",
    business_id: BUSINESS_ID,
    provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
    provider_account_id: "act-1",
    decision_entity_type: "ad",
    decision_entity_id: "ad-a",
    ad_id: "ad-a",
    creative_id: "shared-creative",
    as_of_date: AS_OF,
    engine_version: NATIVE_AD_ENGINE_VERSION,
    scope_type: "account",
    scope_id: "act-1",
    label: "keep",
    raw_label: "scale",
    pre_authority_label: "scale",
    authority_blocker: null,
    confidence: 70,
    truth_source: "commercial_truth",
    effective_target_roas: 2,
    ratio_to_target: 1.5,
    badges: [],
    reason: "Pending hard action.",
    spend: 100,
    purchases: 4,
    roas: 3,
    recent7d_roas: 3,
    label_transform: null,
    blocked_action_type: "scale",
    authorized_action: null,
    job_run_id: "00000000-0000-4000-8000-000000000002",
    creative_evidence_lifecycle_row_id: null,
    calibration_row_id: "00000000-0000-4000-8000-000000000004",
    evaluation_id: "00000000-0000-4000-8000-000000000003",
    input_hash: "1".repeat(64),
    decision_hash: "2".repeat(64),
    computed_at: `${AS_OF}T03:00:00.000Z`,
  };
}

function fakeDb(rows: Record<string, unknown>[]): DbClient {
  const query = vi.fn(async () => rows);
  return Object.assign(vi.fn(), { query }) as unknown as DbClient;
}

describe("native ad producer persistence contract", () => {
  it("rejects empty hydration unless every assigned account proves an authoritative zero set", () => {
    expect(() =>
      assertEmptyNativeAdHydrationIsAuthoritative({
        inputs: [],
        receipts: [],
        accountCoverageComplete: false,
      }),
    ).toThrow("authoritative zero-ad receipts");
    expect(() =>
      assertEmptyNativeAdHydrationIsAuthoritative({
        inputs: [],
        receipts: [hydrationReceipt({ adIds: [], authoritative: false })],
        accountCoverageComplete: false,
      }),
    ).toThrow("authoritative zero-ad receipts");
    expect(() =>
      assertEmptyNativeAdHydrationIsAuthoritative({
        inputs: [],
        receipts: [hydrationReceipt({ adIds: [] })],
        accountCoverageComplete: true,
      }),
    ).not.toThrow();
  });

  it("never prunes on an unproven receipt and accepts a proven true-empty manifest", async () => {
    const unprovenDb = fakeDb([]);
    await expect(
      pruneStaleNativeAdSnapshots(
        {
          businessId: BUSINESS_ID,
          asOf: AS_OF,
          scope: { type: "account", id: "act-1" },
          currentInputs: [],
          receipt: hydrationReceipt({ adIds: [], authoritative: false }),
        },
        unprovenDb,
      ),
    ).resolves.toMatchObject({
      prunedSnapshots: 0,
      skippedUnprovenReceiptCount: 1,
      authoritativeReceiptCount: 0,
    });
    expect(unprovenDb.query).not.toHaveBeenCalled();

    const completeDb = fakeDb([
      { pruned_snapshot_count: 2, pruned_event_count: 1 },
    ]);
    await expect(
      pruneStaleNativeAdSnapshots(
        {
          businessId: BUSINESS_ID,
          asOf: AS_OF,
          scope: { type: "account", id: "act-1" },
          currentInputs: [],
          receipt: hydrationReceipt({ adIds: [] }),
        },
        completeDb,
      ),
    ).resolves.toMatchObject({
      prunedSnapshots: 2,
      prunedEvents: 1,
      authoritativeReceiptCount: 1,
    });
    expect(completeDb.query).toHaveBeenCalledOnce();
    expect(vi.mocked(completeDb.query).mock.calls[0]?.[1]?.[6]).toBe(
      PROVIDER_ACCOUNT_REF_ID,
    );
  });

  it("reconciles the full same-day identity set even when no change remains", async () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const decisions = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: [adInput({ adId: "ad-a", campaignId: "campaign-a" })],
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });
    const db = fakeDb([]);
    await expect(
      reconcileNativeAdDecisionChangeEvents(
        {
          businessId: BUSINESS_ID,
          asOf: AS_OF,
          scope: { type: "account", id: "act-1" },
          decisions,
          rows: [],
        },
        db,
      ),
    ).resolves.toBe(0);
    const [, params] = vi.mocked(db.query).mock.calls[0]!;
    expect(params?.[0]).toBe("[]");
    expect(JSON.parse(String(params?.[1]))).toEqual([
      expect.objectContaining({
        provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
        provider_account_id: "act-1",
        decision_entity_id: "ad-a",
        event_date: AS_OF,
      }),
    ]);
    expect(INSERT_NATIVE_AD_DECISION_CHANGE_EVENTS_QUERY).toContain(
      "DELETE FROM engine_v3_ad_decision_events",
    );
  });

  it("reconciles large same-day identity sets in bounded SQL batches", async () => {
    const profile = makeAccountDecisionProfile({ asOfDate: AS_OF });
    const decisions = computeNativeAdDecisions({
      businessId: BUSINESS_ID,
      profile,
      dataHealth: makeDataHealth(),
      adInputs: Array.from(
        { length: NATIVE_AD_DB_BATCH_SIZE + 1 },
        (_, index) =>
          adInput({ adId: `ad-${index + 1}`, campaignId: "campaign-a" }),
      ),
      campaignContextMode: "legacy_labels",
      campaignContextById: campaignContext(),
      previousLabels: new Map(),
      resolveDecision: (resolverInput) =>
        hardScaleDecision({ creativeId: resolverInput.creativeId }),
    });
    const previousSnapshots = new Map(
      decisions.map((decision, index) => [
        `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000${decision.input.decisionEntityId}\u0000account\u0000${profile.scope.id}`,
        {
          id: `old-${index + 1}`,
          label: "diagnose" as const,
          confidence: 40,
        },
      ]),
    );
    const currentSnapshots = new Map(
      decisions.map((decision, index) => [
        `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000${decision.input.decisionEntityId}\u0000account\u0000${profile.scope.id}`,
        {
          id: `new-${index + 1}`,
          label: "keep" as const,
          confidence: 80,
        },
      ]),
    );
    const rows = buildNativeAdDecisionChangeEvents({
      businessId: BUSINESS_ID,
      asOf: AS_OF,
      jobRunId: "job-1",
      scope: profile.scope,
      decisions,
      previousSnapshots,
      currentSnapshots,
    });
    const routedRowIds: string[] = [];
    const query = vi.fn(async (_query: string, params?: unknown[]) => {
      const routedRows = JSON.parse(String(params?.[0])) as Array<{
        decision_entity_id: string;
      }>;
      routedRowIds.push(...routedRows.map((row) => row.decision_entity_id));
      return routedRows.map((row) => ({ id: row.decision_entity_id }));
    });
    const db = Object.assign(vi.fn(), { query }) as unknown as DbClient;

    await expect(
      reconcileNativeAdDecisionChangeEvents(
        {
          businessId: BUSINESS_ID,
          asOf: AS_OF,
          scope: profile.scope,
          decisions,
          rows,
        },
        db,
      ),
    ).resolves.toBe(NATIVE_AD_DB_BATCH_SIZE + 1);
    expect(query).toHaveBeenCalledTimes(2);
    expect(
      query.mock.calls.map(
        ([, params]) => JSON.parse(String(params?.[1])).length,
      ),
    ).toEqual([NATIVE_AD_DB_BATCH_SIZE, 1]);
    expect(routedRowIds).toHaveLength(NATIVE_AD_DB_BATCH_SIZE + 1);
    expect(routedRowIds.at(-1)).toBe(decisions.at(-1)?.input.decisionEntityId);
  });

  it("fails the snapshot materialization when an evaluation link resolves no row", async () => {
    await expect(
      upsertNativeAdDecisionSnapshots([snapshotPayload()], fakeDb([])),
    ).rejects.toThrow(
      "Native ad snapshot linkage incomplete: expected 1, wrote 0.",
    );
  });

  it("materializes large native snapshot sets in bounded SQL batches", async () => {
    const batchSizes: number[] = [];
    const query = vi.fn(async (_sql: string, params?: unknown[]) => {
      const payload = JSON.parse(String(params?.[0])) as Array<
        Record<string, unknown>
      >;
      batchSizes.push(payload.length);
      return payload.map((row) => ({
        id: `snapshot-${String(row.decision_entity_id)}`,
        provider_account_ref_id: row.provider_account_ref_id,
        provider_account_id: row.provider_account_id,
        decision_entity_type: "ad",
        decision_entity_id: row.decision_entity_id,
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        label: row.label,
        confidence: row.confidence,
      }));
    });
    const db = Object.assign(vi.fn(), { query }) as unknown as DbClient;
    const rows = Array.from(
      { length: NATIVE_AD_DB_BATCH_SIZE + 1 },
      (_, index) => ({
        ...snapshotPayload(),
        decision_entity_id: `ad-${index + 1}`,
        ad_id: `ad-${index + 1}`,
      }),
    );

    const stored = await upsertNativeAdDecisionSnapshots(rows, db);

    expect(batchSizes).toEqual([NATIVE_AD_DB_BATCH_SIZE, 1]);
    expect(stored.size).toBe(rows.length);
  });

  it("keeps snapshot identities distinct across provider references", async () => {
    const secondProviderRefId = "00000000-0000-4000-8000-000000000741";
    const rows = [
      snapshotPayload(),
      {
        ...snapshotPayload(),
        provider_account_ref_id: secondProviderRefId,
      },
    ];
    const query = vi.fn(async (_sql: string, params?: unknown[]) => {
      const payload = JSON.parse(String(params?.[0])) as Array<
        Record<string, unknown>
      >;
      return payload.map((row, index) => ({
        id: `snapshot-${index + 1}`,
        provider_account_ref_id: row.provider_account_ref_id,
        provider_account_id: row.provider_account_id,
        decision_entity_type: row.decision_entity_type,
        decision_entity_id: row.decision_entity_id,
        scope_type: row.scope_type,
        scope_id: row.scope_id,
        label: row.label,
        confidence: row.confidence,
      }));
    });
    const db = Object.assign(vi.fn(), { query }) as unknown as DbClient;

    const stored = await upsertNativeAdDecisionSnapshots(rows, db);

    expect(stored.size).toBe(2);
    expect(
      stored.get(
        `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-a\u0000account\u0000act-1`,
      )?.id,
    ).toBe("snapshot-1");
    expect(
      stored.get(
        `${secondProviderRefId}\u0000act-1\u0000ad\u0000ad-a\u0000account\u0000act-1`,
      )?.id,
    ).toBe("snapshot-2");
  });

  it("is same-row idempotent across same-day retry materialization", async () => {
    const db = fakeDb([
      {
        id: "snapshot-a",
        provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
        provider_account_id: "act-1",
        decision_entity_type: "ad",
        decision_entity_id: "ad-a",
        scope_type: "account",
        scope_id: "act-1",
        label: "keep",
        confidence: 70,
      },
    ]);

    const first = await upsertNativeAdDecisionSnapshots(
      [snapshotPayload()],
      db,
    );
    const second = await upsertNativeAdDecisionSnapshots(
      [snapshotPayload()],
      db,
    );

    const key = `${PROVIDER_ACCOUNT_REF_ID}\u0000act-1\u0000ad\u0000ad-a\u0000account\u0000act-1`;
    expect(first.get(key)?.id).toBe("snapshot-a");
    expect(second.get(key)?.id).toBe("snapshot-a");
    expect(db.query).toHaveBeenCalledTimes(2);
  });

  it("round-trips authority provenance through the native snapshot payload", async () => {
    const row = snapshotPayload();
    row.authority_blocker = "campaign_context";
    row.authorized_action = null;
    row.raw_label = "diagnose";
    const db = fakeDb([
      {
        id: "snapshot-a",
        provider_account_ref_id: PROVIDER_ACCOUNT_REF_ID,
        provider_account_id: "act-1",
        decision_entity_type: "ad",
        decision_entity_id: "ad-a",
        scope_type: "account",
        scope_id: "act-1",
        label: "keep",
        confidence: 70,
      },
    ]);

    await upsertNativeAdDecisionSnapshots([row], db);

    const [, params] = vi.mocked(db.query).mock.calls[0]!;
    expect(JSON.parse(String(params?.[0]))).toEqual([
      expect.objectContaining({
        pre_authority_label: "scale",
        authority_blocker: "campaign_context",
        raw_label: "diagnose",
        authorized_action: null,
      }),
    ]);
  });

  it("uses only parallel native tables and validates full evaluation lineage", () => {
    for (const sql of [
      UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY,
      PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY,
      INSERT_NATIVE_AD_DECISION_CHANGE_EVENTS_QUERY,
      READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY,
    ]) {
      expect(sql).toContain("engine_v3_ad_decision_");
      expect(sql).not.toMatch(
        /engine_v3_decision_(snapshots|evaluations|events)/,
      );
    }
    expect(UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "evaluation.provider_account_id = payload.provider_account_id",
    );
    expect(UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "evaluation.decision_entity_id = payload.decision_entity_id",
    );
    expect(UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "evaluation.input_hash = payload.input_hash",
    );
    expect(UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "evaluation.decision_hash = payload.decision_hash",
    );
    expect(UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "pre_authority_label",
    );
    expect(UPSERT_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "authority_blocker",
    );
    expect(PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).not.toContain(
      "creative_id = ANY",
    );
    expect(PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "SELECT snapshot.id, snapshot.provider_account_ref_id",
    );
    expect(PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "snapshot.provider_account_ref_id = $7::uuid",
    );
    expect(PRUNE_STALE_NATIVE_AD_DECISION_SNAPSHOTS_QUERY).toContain(
      "event.provider_account_ref_id = stale.provider_account_ref_id",
    );
  });

  it("leaves the legacy producer source unchanged and separately callable", () => {
    const legacy = readFileSync(
      "lib/creative-decision-engine/jobs/decisions-job.ts",
      "utf8",
    );
    expect(legacy).not.toContain("runAdDecisionsJob");
    expect(legacy).not.toContain("engine_v3_ad_decision_");
  });

  it("uses only the native account profile resolver and native calibration lineage", () => {
    const native = readFileSync(
      "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
      "utf8",
    );
    expect(native).toContain("resolveNativeAdAccountDecisionProfile");
    expect(native).toContain("WarehouseNativeAdAccountProfileDataSource");
    expect(native).toContain("group.calibrationRowId");
    expect(native).not.toContain("resolveAccountDecisionProfile");
    expect(native).not.toContain("engine_v3_account_calibration_daily");
    expect(native).not.toContain("dataSource.getDataHealth");
  });

  it("persists the attempt before native preflight and rolls work failures to the savepoint", () => {
    const native = readFileSync(
      "lib/creative-decision-engine/jobs/ad-decisions-job.ts",
      "utf8",
    );
    const capability = native.indexOf(
      "inspectEvaluationStoreSchemaCapability(db)",
    );
    const profileCapability = native.indexOf(
      "options.inspectProfileSchema ?? inspectNativeAdProfileSchemaCapability",
    );
    const jobInsert = native.indexOf("const jobRunId = await insertAdJobRun");
    const transaction = native.indexOf("const transaction =", jobInsert);
    const repeatableRead = native.indexOf(
      "SET TRANSACTION ISOLATION LEVEL REPEATABLE READ",
    );
    const savepoint = native.indexOf(
      "SAVEPOINT engine_v3_ad_decisions_job_work",
    );
    const evaluationWrite = native.indexOf("persistAdDecisionEvaluations(");
    const snapshotWrite = native.indexOf("upsertNativeAdDecisionSnapshots(");
    const rollback = native.indexOf(
      "ROLLBACK TO SAVEPOINT engine_v3_ad_decisions_job_work",
    );

    expect(capability).toBeGreaterThan(-1);
    expect(profileCapability).toBeGreaterThan(-1);
    expect(jobInsert).toBeLessThan(transaction);
    expect(transaction).toBeLessThan(repeatableRead);
    expect(repeatableRead).toBeLessThan(capability);
    expect(transaction).toBeLessThan(capability);
    expect(transaction).toBeLessThan(profileCapability);
    expect(capability).toBeLessThan(savepoint);
    expect(profileCapability).toBeLessThan(savepoint);
    expect(savepoint).toBeLessThan(evaluationWrite);
    expect(evaluationWrite).toBeLessThan(snapshotWrite);
    expect(snapshotWrite).toBeLessThan(rollback);
  });
});
