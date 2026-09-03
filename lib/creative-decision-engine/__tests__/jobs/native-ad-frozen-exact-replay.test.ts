import { describe, expect, it } from "vitest";
import { type NativeAdCalibrationCellQuery } from "../../ad-account-decision-profile";
import type { CampaignContextLabelMap } from "../../campaign-context/source";
import type { NativeAdSoftOnlyDecisionProfile } from "../../canonical-evaluation";
import { hashAdDecisionIdentityManifest } from "../../data-source";
import {
  READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY,
  adDecisionStabilityKey,
  PENDING_TRANSITION_BADGE,
  type PreviousAdPublishedLabel,
} from "../../decision-stability";
import { ENGINE_PRESET_MULTIPLIERS } from "../../engine-presets";
import type { EngineV3Flags } from "../../feature-flags";
import {
  computeNativeAdCalibrationBatch,
  type NativeAdCalibrationCell,
  type NativeAdCalibrationSourceRow,
  type NativeAdTargetAuthorityInput,
} from "../../jobs/ad-calibration-job";
import {
  buildNativeAdDataHealth,
  computeNativeAdDecisions,
  resolveNativeAdDecisionProfileGroups,
  toNativeSnapshotPayload,
  type AdDecisionComputation,
  type NativeAdDecisionProfileGroup,
  type NativeAdProfileRuntimeDataSource,
} from "../../jobs/ad-decisions-job";
import { NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION } from "../../jobs/ad-operator-response-job";
import {
  NATIVE_AD_ENGINE_VERSION,
  type AccountDecisionProfile,
  type AdDecisionInput,
  type CreativeInput,
} from "../../types";
import { makeCreativeInput } from "../helpers";
import rawFixture from "../fixtures/native-ad-frozen-exact-replay.v1.json";
import {
  evaluateReplayReleaseGate,
  assessReplayAnchorDimensions,
  assertReplayOutputPlan,
  assertCurrentUtcReplayDate,
  aovPositiveControlFailure,
  aboveBreakEvenCutProjectionViolation,
  aboveBreakEvenCalibrationRestatement,
  aboveBreakEvenProfileAvailabilityRestatement,
  aboveBreakEvenProjectionDrift,
  aboveBreakEvenSafetyRepair,
  buildD063ExactMediaBuyerAudit,
  buildD063ReplayPolicyAudit,
  buildCurrentScd0DimensionDriftProof,
  buildSchedulerPopulationCoverage,
  buildCompactReplayProof,
  buildRequestedScopeCoverage,
  buildWaveCoverageProof,
  canonicalContextScopeMatchesAccountProfile,
  d036HardActionTupleValid,
  d036PendingCutTupleValid,
  d063ExpandedStripSemanticViolation,
  exactMediaBuyerScopeRequested,
  mediaBuyerExactInputMetrics,
  mediaBuyerProfileBoundaryProjection,
  nativeSnapshotProjectionProof,
  parseArgs,
  priorHysteresisMap,
  READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL,
  READ_FIXED_BASELINE_ANCHORS_SQL,
  READ_FIXED_BASELINE_ANCHOR_PROOF_SQL,
  READ_FIXED_BASELINE_IDENTITIES_SQL,
  READ_FIXED_BASELINE_ROW_PAYLOAD_SQL,
  READ_SCHEDULER_POPULATION_MANIFEST_SQL,
  rebindFixedBaselineCohortRows,
  replayPreparedAccountSlice,
  replayNativeProfileConfig,
  scaleRefreshCalibrationRestatement,
  scaleRefreshProfileAvailabilityRestatement,
  scaleRefreshProjectionDrift,
  type BaselineRow,
  type ChallengerRow,
  type NativeSnapshotProjection,
  type PreparedAccountSlice,
  type ReplayReleaseGateChecks,
} from "@/scripts/creative-decision-center/native-ad-account-aov-authority-replay";

type FrozenMetrics = Pick<
  CreativeInput,
  | "spend"
  | "purchases"
  | "purchaseValue"
  | "roas"
  | "cpa"
  | "recent7dSpend"
  | "recent7dPurchases"
  | "recent7dRoas"
>;

interface FrozenFixture {
  contractVersion: "native-ad-frozen-exact-replay.v1";
  sourceMode: "anonymized_frozen_acceptance_fixture";
  sourceProvenance: {
    mode: "synthetic_anonymized_production_contract_fixture";
    productionFunctions: string[];
    containsLiveIdentifiers: false;
    containsLiveMetrics: false;
  };
  businessId: string;
  providerAccountRefId: string;
  providerAccountId: string;
  accountTimezone: string;
  accountCurrency: string;
  objective: "OUTCOME_SALES";
  optimizationGoal: string;
  customEventType: string;
  firstAsOfDate: string;
  confirmationAsOfDate: string;
  sourceFactDate: string;
  sourceFactFinalizedAt: string;
  sourceFactCreatedAt: string;
  sourceFactUpdatedAt: string;
  targetAuthority: NativeAdTargetAuthorityInput;
  calibrationEvidence: {
    exactContextPurchaseFacts: number;
    accountOnlyPurchaseFacts: number;
    exactContextRevenuePerPurchase: number;
    accountOnlyRevenuePerPurchase: number;
    expectedExactAov: number;
    expectedAccountPurchaseCount: number;
    expectedAccountRevenue: number;
    expectedAccountAov: number;
  };
  archetypes: {
    belowBreakEvenLoss: FrozenNativeArchetype & {
      expected: {
        rawLabel: "cut";
        firstPublishedLabel: "keep";
        sameDayRetryPublishedLabel: "keep";
        confirmationPublishedLabel: "cut";
        pendingBlockedActionType: "cut";
        firstAuthorizedAction: null;
        confirmationAuthorizedAction: "cut";
      };
    };
    aboveBreakEven: FrozenNativeArchetype & {
      expected: FrozenSoftExpectation;
    };
    recoveryHold: FrozenNativeArchetype & {
      expected: FrozenSoftExpectation & { reasonFragment: string };
    };
    scaleRefreshIsolation: {
      nativeScaleCandidate: FrozenNativeArchetype & {
        expected: FrozenSoftExpectation & { reasonFragment: string };
      };
      nativeRefreshCandidate: FrozenNativeArchetype & {
        expected: {
          preAuthorityLabel: "keep";
          publishedLabel: "keep";
          blockedActionType: null;
        };
      };
      expectedEligibility: {
        scale: false;
        cut: true;
        refresh: false;
      };
    };
  };
}

interface FrozenNativeArchetype {
  adId: string;
  campaignId: string;
  metrics: FrozenMetrics;
}

interface FrozenSoftExpectation {
  rawLabel: "keep";
  publishedLabel: "keep";
  blockedActionType: null;
}

const fixture = rawFixture as unknown as FrozenFixture;
const CALIBRATION_ROW_ID = "00000000-0000-4000-8000-000000000864";
const JOB_RUN_ID = "00000000-0000-4000-8000-000000000865";

class FrozenNativeProfileDataSource implements NativeAdProfileRuntimeDataSource {
  constructor(
    private readonly cells: NativeAdCalibrationCell[],
    private readonly targetAuthority: NativeAdTargetAuthorityInput,
  ) {}

  async getNativeAdCalibrationCell(input: NativeAdCalibrationCellQuery) {
    return (
      this.cells.find(
        (cell) =>
          cell.key.businessId === input.businessId &&
          cell.key.providerAccountId === input.providerAccountId &&
          cell.key.accountTimezone === input.accountTimezone &&
          cell.key.accountCurrency === input.accountCurrency &&
          cell.key.cellScope === input.cellScope &&
          cell.key.objective === input.objective &&
          cell.key.cohort === input.cohort &&
          cell.key.optimizationContext === input.optimizationContext &&
          cell.asOfDate === input.asOfDate,
      ) ?? null
    );
  }

  async getNativeTargetAuthorityAsOf() {
    return this.targetAuthority;
  }

  async getNativeDecisionCalibrationProfileAsOf() {
    return null;
  }

  async getNativeCalibrationRowId(cell: NativeAdCalibrationCell) {
    if (!this.cells.includes(cell)) {
      throw new Error("Frozen profile resolver escaped fixture cell set.");
    }
    return CALIBRATION_ROW_ID;
  }
}

function flags(): EngineV3Flags {
  return {
    businessId: fixture.businessId,
    enabled: true,
    surfaceVisible: false,
    shadowOnly: false,
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
      shadowOnly: false,
    },
  };
}

function makeCalibrationSourceRow(input: {
  index: number;
  accountOnly: boolean;
}): NativeAdCalibrationSourceRow {
  const prefix = input.accountOnly ? "account-only" : "exact-context";
  const adId = `${prefix}-${String(input.index).padStart(2, "0")}`;
  const revenue = input.accountOnly
    ? fixture.calibrationEvidence.accountOnlyRevenuePerPurchase
    : fixture.calibrationEvidence.exactContextRevenuePerPurchase;
  return {
    sourceRowId: `source-${adId}`,
    businessId: fixture.businessId,
    providerAccountRefId: fixture.providerAccountRefId,
    providerAccountId: fixture.providerAccountId,
    date: fixture.sourceFactDate,
    campaignId: input.accountOnly ? null : "campaign-calibration-anonymous",
    adsetId: input.accountOnly ? null : "adset-calibration-anonymous",
    adId,
    accountTimezone: fixture.accountTimezone,
    accountCurrency: fixture.accountCurrency,
    sourceAccountTimezone: fixture.accountTimezone,
    sourceAccountCurrency: fixture.accountCurrency,
    metricSchemaVersion: 2,
    objective: fixture.objective,
    optimizationGoal: fixture.optimizationGoal,
    customEventType: fixture.customEventType,
    spend: 120 + input.index,
    impressions: 10_000,
    clicks: 300,
    linkClicks: 250,
    conversions: 1,
    revenue,
    landingPageViews: 220,
    addToCart: 50,
    initiateCheckout: 20,
    thumbstop: 0.3,
    truthState: "finalized",
    validationStatus: "passed",
    finalizedAt: fixture.sourceFactFinalizedAt,
    createdAt: fixture.sourceFactCreatedAt,
    updatedAt: fixture.sourceFactUpdatedAt,
    campaignSourceRowId: input.accountOnly ? null : "campaign-source",
    campaignTruthState: input.accountOnly ? null : "finalized",
    campaignValidationStatus: input.accountOnly ? null : "passed",
    campaignCreatedAt: input.accountOnly ? null : fixture.sourceFactCreatedAt,
    campaignUpdatedAt: input.accountOnly ? null : fixture.sourceFactUpdatedAt,
    adsetSourceRowId: input.accountOnly ? null : "adset-source",
    adsetTruthState: input.accountOnly ? null : "finalized",
    adsetValidationStatus: input.accountOnly ? null : "passed",
    adsetCreatedAt: input.accountOnly ? null : fixture.sourceFactCreatedAt,
    adsetUpdatedAt: input.accountOnly ? null : fixture.sourceFactUpdatedAt,
  };
}

function calibrationSourceRows(
  accountTimezone = fixture.accountTimezone,
  accountCurrency = fixture.accountCurrency,
): NativeAdCalibrationSourceRow[] {
  return [
    ...Array.from(
      { length: fixture.calibrationEvidence.exactContextPurchaseFacts },
      (_, index) =>
        makeCalibrationSourceRow({ index: index + 1, accountOnly: false }),
    ),
    ...Array.from(
      { length: fixture.calibrationEvidence.accountOnlyPurchaseFacts },
      (_, index) =>
        makeCalibrationSourceRow({ index: index + 1, accountOnly: true }),
    ),
  ].map((row) => ({
    ...row,
    accountTimezone,
    accountCurrency,
    sourceAccountTimezone: accountTimezone,
    sourceAccountCurrency: accountCurrency,
  }));
}

function makeFrozenCalibrationBatch(
  asOfDate: string,
  accountTimezone = fixture.accountTimezone,
  accountCurrency = fixture.accountCurrency,
) {
  const batch = computeNativeAdCalibrationBatch({
    businessId: fixture.businessId,
    providerAccountRefId: fixture.providerAccountRefId,
    providerAccountId: fixture.providerAccountId,
    asOf: asOfDate,
    computationCutoff: `${asOfDate}T03:05:00.000Z`,
    sourceRows: calibrationSourceRows(accountTimezone, accountCurrency),
    targetAuthority: fixture.targetAuthority,
  });
  const cells = batch.cells.map((cell) => ({
    ...cell,
    batchId: "00000000-0000-4000-8000-000000000866",
    batchCompleteness: "complete" as const,
  }));
  return { batch, cells };
}

async function resolveFrozenGroup(
  asOfDate: string,
  adInputs: AdDecisionInput[],
): Promise<NativeAdDecisionProfileGroup> {
  const { cells } = makeFrozenCalibrationBatch(asOfDate);
  const groups = await resolveNativeAdDecisionProfileGroups({
    businessId: fixture.businessId,
    asOf: asOfDate,
    adInputs,
    dataSource: new FrozenNativeProfileDataSource(
      cells,
      fixture.targetAuthority,
    ),
    flags: flags(),
  });
  if (groups.length !== 1) {
    throw new Error(
      `Frozen native profile split into ${groups.length} groups.`,
    );
  }
  const group = groups[0]!;
  if (
    group.blocker !== null ||
    group.calibrationCell === null ||
    group.calibrationRowId !== CALIBRATION_ROW_ID ||
    "profileType" in group.profile
  ) {
    throw new Error(`Frozen native profile failed closed: ${group.blocker}`);
  }
  return group;
}

function makeNativeInput(archetype: FrozenNativeArchetype): AdDecisionInput {
  const creative = makeCreativeInput({
    businessId: fixture.businessId,
    creativeId: `creative-for-${archetype.adId}`,
    campaignId: archetype.campaignId,
    objective: fixture.objective,
    effectiveCohort: "purchase",
    targetRoas: fixture.targetAuthority.targetRoas,
    breakevenRoas: fixture.targetAuthority.breakEvenRoas,
    contextGrain: {
      providerAccountCount: 1,
      campaignCount: 1,
      adsetCount: 1,
      optimizationContextCount: 1,
      objectiveCount: 1,
      contextIdentityUnknown: false,
    },
    linkClicks: 200,
    landingPageViews: 180,
    addToCart: 30,
    initiateCheckout: 10,
    ageDays: 21,
    dataFreshnessHours: 1,
    ...archetype.metrics,
  });
  return {
    ...creative,
    decisionEntityType: "ad",
    decisionEntityId: archetype.adId,
    adId: archetype.adId,
    providerAccountRefId: fixture.providerAccountRefId,
    providerAccountId: fixture.providerAccountId,
    accountTimezone: fixture.accountTimezone,
    accountCurrency: fixture.accountCurrency,
    adsetId: `adset-for-${archetype.adId}`,
    optimizationGoal: fixture.optimizationGoal,
    customEventType: fixture.customEventType,
    metricEvidence: {
      sourceRowCount: 28,
      performanceMetricsObserved: true,
      eventMetricsObserved: true,
    },
    statusEvidence: {
      source: "entity_state_history",
      sourceRecordId: `state-${archetype.adId}`,
      observedAt: `${fixture.firstAsOfDate}T02:00:00.000Z`,
      capturedAt: `${fixture.firstAsOfDate}T02:01:00.000Z`,
    },
    creativeEvidence: {
      sourceLifecycleRowId: null,
      sourceAsOfDate: null,
      sourceComputedAt: null,
      sourceMaxUpdatedAt: null,
      lifecyclePosition: null,
      daysSincePeak: null,
      peakRoas30d: null,
      peakConfidence: null,
      spendTrajectory30d: null,
      spendSlope7d: null,
      spendSlope30d: null,
      roasSlope7d: null,
      roasSlope30d: null,
      fatigueStatus: null,
      qualityRanking: null,
      engagementRateRanking: null,
      conversionRateRanking: null,
      creativeFormat: creative.creativeFormat,
    },
  };
}

function campaignContext(): CampaignContextLabelMap {
  const campaignIds = [
    fixture.archetypes.belowBreakEvenLoss.campaignId,
    fixture.archetypes.aboveBreakEven.campaignId,
    fixture.archetypes.recoveryHold.campaignId,
    fixture.archetypes.scaleRefreshIsolation.nativeScaleCandidate.campaignId,
    fixture.archetypes.scaleRefreshIsolation.nativeRefreshCandidate.campaignId,
  ];
  return new Map(
    campaignIds.map((campaignId, index) => [
      campaignId,
      {
        kind: "main" as const,
        testDimension: null,
        contextTrust: "high" as const,
        provenance: {
          // D074: runtime context is automatic-only; the frozen archetypes
          // represent the fully trusted high-confidence validated state.
          mode: "automatic" as const,
          source: "system_inferred" as const,
          campaignId,
          kind: "main" as const,
          testDimension: null,
          contextTrust: "high" as const,
          sourceRecordType: "engine_v3_campaign_context_daily" as const,
          sourceRecordId: `anonymous-label-${index}`,
          sourceAsOfDate: fixture.firstAsOfDate,
          sourceUpdatedAt: `${fixture.firstAsOfDate}T01:00:00.000Z`,
          sourceHash: String(index + 1).repeat(64),
        },
      },
    ]),
  );
}

function frozenNativeDataHealth(input: {
  calibrationCell: NativeAdCalibrationCell;
  adInputs: AdDecisionInput[];
  previousLabels?: Map<string, PreviousAdPublishedLabel>;
  scope: AccountDecisionProfile["scope"];
  evaluatedAt?: string;
}) {
  return buildNativeAdDataHealth({
    calibrationCell: input.calibrationCell,
    blocker: null,
    adInputs: input.adInputs,
    previousLabels: input.previousLabels ?? new Map(),
    scope: input.scope,
    evaluatedAt: input.evaluatedAt ?? `${fixture.firstAsOfDate}T03:10:00.000Z`,
  });
}

function compute(
  group: NativeAdDecisionProfileGroup,
  adInputs: AdDecisionInput[],
  previousLabels = new Map<string, PreviousAdPublishedLabel>(),
) {
  if (
    group.blocker !== null ||
    group.calibrationCell === null ||
    "profileType" in group.profile
  ) {
    throw new Error("Frozen compute requires a ready native profile group.");
  }
  const dataHealth = frozenNativeDataHealth({
    calibrationCell: group.calibrationCell,
    adInputs,
    previousLabels,
    scope: group.profile.scope,
  });
  return computeNativeAdDecisions({
    businessId: fixture.businessId,
    profile: group.profile,
    dataHealth,
    adInputs,
    campaignContextMode: "automatic",
    campaignContextById: campaignContext(),
    previousLabels,
  });
}

function byAdId(computations: AdDecisionComputation[], adId: string) {
  const computation = computations.find((item) => item.input.adId === adId);
  if (!computation) throw new Error(`Frozen replay omitted ${adId}.`);
  return computation;
}

function nextDayPrior(
  first: AdDecisionComputation,
): Map<string, PreviousAdPublishedLabel> {
  const prior: PreviousAdPublishedLabel = {
    businessId: fixture.businessId,
    providerAccountRefId: fixture.providerAccountRefId,
    providerAccountId: fixture.providerAccountId,
    decisionEntityType: "ad",
    decisionEntityId: first.input.adId,
    sourceSnapshotId: "00000000-0000-4000-8000-000000000867",
    sourceEvaluationId: "00000000-0000-4000-8000-000000000868",
    sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
    sourceAsOfDate: fixture.firstAsOfDate,
    sourceComputedAt: `${fixture.firstAsOfDate}T03:10:00.000Z`,
    sourceInputHash: "a".repeat(64),
    sourceDecisionHash: "b".repeat(64),
    publishedLabel: first.decision.label,
    rawLabel: first.rawLabel,
  };
  return new Map([
    [
      adDecisionStabilityKey({
        businessId: fixture.businessId,
        providerAccountRefId: fixture.providerAccountRefId,
        providerAccountId: fixture.providerAccountId,
        decisionEntityType: "ad",
        decisionEntityId: first.input.adId,
        scopeType: "account",
        scopeId: fixture.providerAccountId,
      }),
      prior,
    ],
  ]);
}

function snapshotPayload(input: {
  asOfDate: string;
  computation: AdDecisionComputation;
  profile: AccountDecisionProfile;
  suffix: string;
}) {
  return toNativeSnapshotPayload({
    businessId: fixture.businessId,
    asOf: input.asOfDate,
    jobRunId: JOB_RUN_ID,
    scope: input.profile.scope,
    computation: input.computation,
    stored: {
      evaluationId: `00000000-0000-4000-8000-0000000008${input.suffix}`,
      providerAccountRefId: fixture.providerAccountRefId,
      providerAccountId: fixture.providerAccountId,
      decisionEntityId: input.computation.input.adId,
      inputHash: "c".repeat(64),
      decisionHash: "d".repeat(64),
    },
    calibrationRowId: CALIBRATION_ROW_ID,
    hardActionEligibility: input.profile.hardActionEligibility,
    computedAt: `${input.asOfDate}T03:10:00.000Z`,
  });
}

function fixedReplayCohortKey(adId: string) {
  return [
    fixture.businessId,
    fixture.providerAccountRefId,
    fixture.providerAccountId,
    "ad",
    adId,
    "account",
    fixture.providerAccountId,
  ].join("\u0000");
}

function makeReplayBaselineRow(input: {
  adInput: AdDecisionInput;
  accountProfile: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  index: number;
}): BaselineRow {
  const adId = input.adInput.adId;
  const campaignId = input.adInput.campaignId;
  const hashCharacter = String((input.index % 9) + 1);
  const frozenCells = makeFrozenCalibrationBatch(fixture.firstAsOfDate).cells;
  const calibrationCell =
    frozenCells.find(
      (cell) =>
        cell.key.objective === input.adInput.objective &&
        cell.key.cohort === input.adInput.effectiveCohort,
    ) ?? frozenCells[0];
  if (!calibrationCell) throw new Error("Frozen calibration cell missing.");
  const dataHealth = frozenNativeDataHealth({
    calibrationCell,
    adInputs: [input.adInput],
    scope: input.accountProfile.scope,
  });
  return {
    cohortKey: fixedReplayCohortKey(adId),
    businessId: fixture.businessId,
    businessName: "Frozen Replay Business",
    providerAccountRefId: fixture.providerAccountRefId,
    providerAccountId: fixture.providerAccountId,
    currentProviderAccountName: "Main",
    currentAccountTimezone: fixture.accountTimezone,
    currentAccountCurrency: fixture.accountCurrency,
    accountTimezone: fixture.accountTimezone,
    accountCurrency: fixture.accountCurrency,
    asOfDate: fixture.firstAsOfDate,
    calibrationCutoff: `${fixture.firstAsOfDate}T03:05:00.000Z`,
    calibrationCutoffSource: "persisted_calibration_batch",
    snapshotId: `snapshot-${input.index}`,
    evaluationId: `evaluation-${input.index}`,
    contextId: `context-${input.index}`,
    jobRunId: "decision-job",
    anchorDecisionRowCount: 4,
    anchorActualSnapshotCount: 4,
    anchorSelectedScopeSnapshotCount: 4,
    calibrationJobRunId: "calibration-job",
    calibrationJobRowCount: frozenCells.length,
    calibrationJobExpectedCellCount: frozenCells.length,
    calibrationJobRowsWritten: frozenCells.length,
    calibrationJobProviderAccountCount: 1,
    calibrationWaveReceiptCount: 1,
    calibrationWaveBatchCount: 1,
    calibrationWaveExpectedCellCount: frozenCells.length,
    calibrationWaveActualCellCount: frozenCells.length,
    calibrationWaveReceiptContradictions: 0,
    calibrationBatchId: "00000000-0000-4000-8000-000000000866",
    calibrationBatchJobRunId: "calibration-job",
    calibrationBatchExpectedCellCount: frozenCells.length,
    calibrationBatchActualCellCount: frozenCells.length,
    calibrationBatchGenerationContentHash: "a".repeat(64),
    calibrationBatchInputManifestHash: "b".repeat(64),
    calibrationBatchSourceManifestHash: "c".repeat(64),
    calibrationBatchCellSetHash: "d".repeat(64),
    calibrationReceiptCount: 1,
    calibrationReceiptGenerationContentHash: "a".repeat(64),
    calibrationReceiptInputManifestHash: "b".repeat(64),
    calibrationReceiptSourceManifestHash: "c".repeat(64),
    calibrationReceiptCellSetHash: "d".repeat(64),
    calibrationLineageValid: true,
    hydrationReceiptCount: 1,
    hydrationExpectedAdCount: 4,
    hydrationExpectedManifestHash: null,
    hydrationHydratedAdCount: 4,
    hydrationHydratedManifestHash: null,
    hydrationAuthoritativeForPrune: true,
    engineVersion: NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
    scopeType: "account",
    scopeId: fixture.providerAccountId,
    inputHash: hashCharacter.repeat(64),
    decisionHash: String(((input.index + 1) % 9) + 1).repeat(64),
    contextHash: String(((input.index + 2) % 9) + 1).repeat(64),
    recomputedContextHash: String(((input.index + 2) % 9) + 1).repeat(64),
    recomputedInputHash: hashCharacter.repeat(64),
    recomputedDecisionHash: String(((input.index + 1) % 9) + 1).repeat(64),
    snapshotProjectionHash: String(((input.index + 3) % 9) + 1).repeat(64),
    recomputedSnapshotProjectionHash: String(
      ((input.index + 3) % 9) + 1,
    ).repeat(64),
    snapshotProjectionValid: true,
    canonicalEnvelopeValid: true,
    contextContractVersion: "engine-v3-canonical-ad-evaluation.v7",
    evaluationContractVersion: "engine-v3-canonical-ad-evaluation.v7",
    contextJson: {},
    decisionOutput: {},
    creativeId: input.adInput.creativeId,
    calibrationRowId:
      "profileType" in input.accountProfile ? null : CALIBRATION_ROW_ID,
    persistedProfileStatus:
      "profileType" in input.accountProfile ? "soft_only" : "ready",
    evaluatedAt: `${fixture.firstAsOfDate}T03:10:00.000Z`,
    creativeInput: input.adInput,
    campaignContext: {
      mode: "automatic",
      source: "system_inferred",
      campaignId,
      kind: "main",
      testDimension: null,
      contextTrust: "high",
      sourceRecordType: "engine_v3_campaign_context_daily",
      sourceRecordId: `label-${input.index}`,
      sourceAsOfDate: fixture.firstAsOfDate,
      sourceUpdatedAt: `${fixture.firstAsOfDate}T02:00:00.000Z`,
      sourceHash: hashCharacter.repeat(64),
    },
    priorHysteresis: { source: "none" },
    priorHysteresisLineageValid: true,
    priorHysteresisSourceComputedAt: null,
    accountProfile: input.accountProfile,
    dataHealth,
    flags: flags(),
    baseline: {
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      rawLabel: "keep",
      publishedLabel: "keep",
      blockedActionType: null,
      authorizedAction: null,
      hysteresisSuppressed: false,
      confidence: 60,
      reason: "Frozen baseline keep",
      badges: [],
    },
  };
}

function withReplayIdentity(
  input: AdDecisionInput,
  adId: string,
  campaignId: string,
): AdDecisionInput {
  return {
    ...input,
    creativeId: `creative-${adId}`,
    creativeName: `Creative ${adId}`,
    campaignId,
    decisionEntityId: adId,
    adId,
  };
}

function makeReplayCalibrationGeneration(
  sourceRows: NativeAdCalibrationSourceRow[],
) {
  const batch = computeNativeAdCalibrationBatch({
    businessId: fixture.businessId,
    providerAccountRefId: fixture.providerAccountRefId,
    providerAccountId: fixture.providerAccountId,
    asOf: fixture.firstAsOfDate,
    computationCutoff: `${fixture.firstAsOfDate}T03:05:00.000Z`,
    sourceRows,
    targetAuthority: fixture.targetAuthority,
  });
  return {
    batch,
    cells: batch.cells.map((cell) => ({
      ...cell,
      batchId: "00000000-0000-4000-8000-000000000866",
      batchCompleteness: "complete" as const,
    })),
  };
}

async function replayOneFromGeneration(input: {
  adInput: AdDecisionInput;
  batch: ReturnType<typeof computeNativeAdCalibrationBatch>;
  cells: NativeAdCalibrationCell[];
  rawSourceRowCount: number;
  index: number;
}) {
  const persisted = await resolveFrozenGroup(fixture.firstAsOfDate, [
    input.adInput,
  ]);
  const row = makeReplayBaselineRow({
    adInput: input.adInput,
    accountProfile: persisted.profile,
    index: input.index,
  });
  const stableAccountKey = [
    fixture.businessId,
    fixture.providerAccountRefId,
    fixture.providerAccountId,
  ].join("\u0000");
  const [challenger] = await replayPreparedAccountSlice({
    sliceKey: `${stableAccountKey}\u0000${fixture.firstAsOfDate}T03:05:00.000Z`,
    accountKey: stableAccountKey,
    businessId: fixture.businessId,
    businessName: "Frozen Replay Business",
    providerAccountRefId: fixture.providerAccountRefId,
    providerAccountId: fixture.providerAccountId,
    accountTimezone: fixture.accountTimezone,
    accountCurrency: fixture.accountCurrency,
    calibrationCutoff: `${fixture.firstAsOfDate}T03:05:00.000Z`,
    cutoffSource: "persisted_calibration_batch",
    rows: [row],
    batch: input.batch,
    cells: input.cells,
    targetAuthority: fixture.targetAuthority,
    profileConfig: null,
    rawSourceRowCount: input.rawSourceRowCount,
    rawReceiptHash: "e".repeat(64),
    authorityProofContradictions: 0,
    dimensionProofContradictions: 0,
    sourceDimensionProof: {
      sourceAccountCurrency: fixture.accountCurrency,
      sourceAccountTimezone: fixture.accountTimezone,
      sourceTimezoneSelectionDate: fixture.sourceFactDate,
      anchoredAccountCurrency: fixture.accountCurrency,
      anchoredAccountTimezone: fixture.accountTimezone,
      currencyDriftedFromAnchor: false,
      timezoneDriftedFromAnchor: false,
      driftContradictions: 0,
    },
  });
  if (!challenger) throw new Error("Replay omitted the frozen identity.");
  return challenger;
}

describe("native Ad frozen exact replay acceptance", () => {
  it("delegates replay currency admission to the production fail-closed receipt", () => {
    const row = {
      ...makeCalibrationSourceRow({ index: 1, accountOnly: false }),
      accountCurrency: "EUR",
      sourceAccountCurrency: "USD",
    };
    const batch = computeNativeAdCalibrationBatch({
      businessId: fixture.businessId,
      providerAccountRefId: fixture.providerAccountRefId,
      providerAccountId: fixture.providerAccountId,
      asOf: fixture.firstAsOfDate,
      computationCutoff: `${fixture.firstAsOfDate}T03:05:00.000Z`,
      sourceRows: [row],
      targetAuthority: fixture.targetAuthority,
    });

    expect(batch.sourceProvenance.currencyAdmission).toMatchObject({
      status: "blocked",
      reason: "resolved_source_currency_mismatch",
      admittedRowCount: 0,
    });
    expect(batch.cells).toEqual([]);
  });

  it("uses the production latest-source-date timezone receipt and blocks a mixed latest date", () => {
    const prior = {
      ...makeCalibrationSourceRow({ index: 1, accountOnly: false }),
      date: "2026-07-17",
      sourceAccountTimezone: "UTC",
      sourceAccountCurrency: "TRY",
    };
    const latest = {
      ...makeCalibrationSourceRow({ index: 2, accountOnly: false }),
      date: "2026-07-18",
      sourceAccountTimezone: "Europe/Istanbul",
      sourceAccountCurrency: "TRY",
    };
    const ready = computeNativeAdCalibrationBatch({
      businessId: fixture.businessId,
      providerAccountRefId: fixture.providerAccountRefId,
      providerAccountId: fixture.providerAccountId,
      asOf: "2026-07-18",
      computationCutoff: "2026-07-18T03:05:00.000Z",
      sourceRows: [prior, latest],
      targetAuthority: fixture.targetAuthority,
    });
    expect(ready.sourceProvenance.timezoneAdmission).toMatchObject({
      status: "ready",
      keyBasis: "immutable_latest_source_date",
      accountTimezone: "Europe/Istanbul",
      latestSourceDate: "2026-07-18",
    });
    expect(
      ready.cells.every(
        (cell) => cell.key.accountTimezone === "Europe/Istanbul",
      ),
    ).toBe(true);

    const blocked = computeNativeAdCalibrationBatch({
      businessId: fixture.businessId,
      providerAccountRefId: fixture.providerAccountRefId,
      providerAccountId: fixture.providerAccountId,
      asOf: "2026-07-18",
      computationCutoff: "2026-07-18T03:05:00.000Z",
      sourceRows: [
        latest,
        {
          ...latest,
          sourceRowId: "timezone-conflict",
          sourceAccountTimezone: "UTC",
        },
      ],
      targetAuthority: fixture.targetAuthority,
    });
    expect(blocked.sourceProvenance.timezoneAdmission).toMatchObject({
      status: "blocked",
      reason: "mixed_latest_source_timezone",
      admittedRowCount: 0,
    });
    expect(blocked.cells).toEqual([]);
  });

  it("binds thin exact calibration to cutoff-safe account/currency AOV for Cut only", async () => {
    expect(fixture.contractVersion).toBe("native-ad-frozen-exact-replay.v1");
    expect(fixture.sourceMode).toBe("anonymized_frozen_acceptance_fixture");
    expect(fixture.sourceProvenance).toMatchObject({
      mode: "synthetic_anonymized_production_contract_fixture",
      containsLiveIdentifiers: false,
      containsLiveMetrics: false,
    });
    expect(fixture.sourceProvenance.productionFunctions).toEqual(
      expect.arrayContaining([
        "resolveNativeAdDecisionProfileGroups",
        "buildNativeAdDataHealth",
        "toNativeSnapshotPayload",
      ]),
    );

    const result = await resolveFrozenGroup(fixture.firstAsOfDate, [
      makeNativeInput(fixture.archetypes.aboveBreakEven),
    ]);
    const proof = result.calibrationCell?.actionReadiness.spendUnitAuthority;
    expect(result.calibrationCell?.accountCalibration).toMatchObject({
      metaAttributedAovMean90d: fixture.calibrationEvidence.expectedExactAov,
      metaAttributedAovPurchaseCount90d:
        fixture.calibrationEvidence.exactContextPurchaseFacts,
      metaAovQuality: "low_sample",
    });
    expect(proof).toMatchObject({
      status: "ready",
      basis: "physical_account_purchase_aov_90d",
      accountCurrency: fixture.accountCurrency,
      accountAovEvidence: {
        status: "ready",
        observedPurchaseCount:
          fixture.calibrationEvidence.expectedAccountPurchaseCount,
        totalRevenue: fixture.calibrationEvidence.expectedAccountRevenue,
        meanAov: fixture.calibrationEvidence.expectedAccountAov,
      },
    });
    expect(result.profile.hardActionEligibility).toMatchObject(
      fixture.archetypes.scaleRefreshIsolation.expectedEligibility,
    );
    const readyProfile = result.profile as AccountDecisionProfile;
    expect(readyProfile.commercialStopLossThresholds).not.toEqual(
      readyProfile.thresholds,
    );
    expect(replayNativeProfileConfig()).toBeNull();
    expect(result.profile).toMatchObject({
      preset: "balanced",
      presetSource: "target_pack_risk_posture",
      multipliers: ENGINE_PRESET_MULTIPLIERS.balanced,
    });
  });

  it("replays native media-buyer archetypes through production decisions and D036", async () => {
    const loss = fixture.archetypes.belowBreakEvenLoss;
    const aboveBreakEven = fixture.archetypes.aboveBreakEven;
    const recovery = fixture.archetypes.recoveryHold;
    const scale = fixture.archetypes.scaleRefreshIsolation.nativeScaleCandidate;
    const refresh =
      fixture.archetypes.scaleRefreshIsolation.nativeRefreshCandidate;
    const refreshInput = {
      ...makeNativeInput(refresh),
      fatigueStatus: "fatigued" as const,
      creativeEvidence: {
        ...makeNativeInput(refresh).creativeEvidence,
        fatigueStatus: "fatigued" as const,
      },
    };
    const nativeInputs = [loss, aboveBreakEven, recovery, scale].map(
      makeNativeInput,
    );
    nativeInputs.push(refreshInput);
    const firstProfileResult = await resolveFrozenGroup(
      fixture.firstAsOfDate,
      nativeInputs,
    );
    const confirmationInput = makeNativeInput(loss);
    const confirmationProfileResult = await resolveFrozenGroup(
      fixture.confirmationAsOfDate,
      [confirmationInput],
    );
    const firstProfile = firstProfileResult.profile as AccountDecisionProfile;
    const confirmationProfile =
      confirmationProfileResult.profile as AccountDecisionProfile;

    const rollbackEpochPrior = priorHysteresisMap({
      priorHysteresis: {
        source: "persisted_snapshot",
        publishedLabel: "cut",
        rawLabel: "cut",
        sourceEngineVersion: NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
      },
    } as unknown as Parameters<typeof priorHysteresisMap>[0]);
    expect(rollbackEpochPrior).toMatchObject({
      replayable: false,
      status: "epoch_mismatch",
      sourceEngineVersion: NATIVE_AD_OPERATOR_ROLLBACK_ENGINE_VERSION,
    });
    expect(rollbackEpochPrior.map.size).toBe(0);

    const firstRun = compute(
      firstProfileResult,
      nativeInputs,
      rollbackEpochPrior.map,
    );
    const sameDayRetry = compute(firstProfileResult, nativeInputs);
    const firstLoss = byAdId(firstRun, loss.adId);
    const retriedLoss = byAdId(sameDayRetry, loss.adId);

    expect(firstLoss).toMatchObject({
      rawLabel: loss.expected.rawLabel,
      hysteresisSuppressed: true,
      decision: {
        label: loss.expected.firstPublishedLabel,
        blockedActionType: loss.expected.pendingBlockedActionType,
        authorityBlocker: null,
      },
    });
    expect(retriedLoss).toMatchObject({
      rawLabel: loss.expected.rawLabel,
      hysteresisSuppressed: true,
      decision: {
        label: loss.expected.sameDayRetryPublishedLabel,
        blockedActionType: loss.expected.pendingBlockedActionType,
      },
    });
    expect(READ_PREVIOUS_PUBLISHED_AD_LABELS_QUERY).toContain(
      "snapshot.as_of_date < $4::date",
    );

    const confirmation = compute(
      confirmationProfileResult,
      [confirmationInput],
      nextDayPrior(firstLoss),
    )[0];
    if (!confirmation) throw new Error("Confirmation replay omitted loss Ad.");
    expect(confirmation).toMatchObject({
      rawLabel: loss.expected.rawLabel,
      hysteresisSuppressed: false,
      decision: {
        label: loss.expected.confirmationPublishedLabel,
        blockedActionType: null,
        authorityBlocker: null,
      },
    });

    const aboveBreakEvenResult = byAdId(firstRun, aboveBreakEven.adId);
    expect(aboveBreakEvenResult).toMatchObject({
      rawLabel: aboveBreakEven.expected.rawLabel,
      decision: {
        label: aboveBreakEven.expected.publishedLabel,
        blockedActionType: aboveBreakEven.expected.blockedActionType,
      },
    });
    expect(
      aboveBreakEvenResult.decision.badges.map((badge) => badge.type),
    ).not.toContain("cut_candidate");
    expect(
      aboveBreakEvenCutProjectionViolation({
        roas: aboveBreakEvenResult.input.roas,
        breakEvenRoas: aboveBreakEvenResult.input.breakevenRoas,
        labels: [
          aboveBreakEvenResult.decision.preAuthorityLabel,
          aboveBreakEvenResult.rawLabel,
          aboveBreakEvenResult.decision.label,
        ],
        blockedActionType:
          aboveBreakEvenResult.decision.blockedActionType === "scale" ||
          aboveBreakEvenResult.decision.blockedActionType === "cut" ||
          aboveBreakEvenResult.decision.blockedActionType === "refresh"
            ? aboveBreakEvenResult.decision.blockedActionType
            : null,
        authorizedAction: null,
        badges: aboveBreakEvenResult.decision.badges,
      }),
    ).toBe(false);
    const recoveryResult = byAdId(firstRun, recovery.adId);
    expect(recoveryResult).toMatchObject({
      rawLabel: recovery.expected.rawLabel,
      decision: {
        label: recovery.expected.publishedLabel,
        blockedActionType: recovery.expected.blockedActionType,
      },
    });
    expect(recoveryResult.decision.reason).toContain(
      recovery.expected.reasonFragment,
    );
    const scaleResult = byAdId(firstRun, scale.adId);
    expect(scaleResult.decision).toMatchObject({
      label: scale.expected.publishedLabel,
      blockedActionType: scale.expected.blockedActionType,
    });
    expect(scaleResult.decision.reason).toContain(
      scale.expected.reasonFragment,
    );

    const refreshDecision = byAdId(firstRun, refresh.adId);
    expect(refreshDecision.decision).toMatchObject({
      preAuthorityLabel: refresh.expected.preAuthorityLabel,
      label: refresh.expected.publishedLabel,
      blockedActionType: refresh.expected.blockedActionType,
      authorityBlocker: null,
    });

    const pendingPayload = snapshotPayload({
      asOfDate: fixture.firstAsOfDate,
      computation: firstLoss,
      profile: firstProfile,
      suffix: "69",
    });
    const confirmedPayload = snapshotPayload({
      asOfDate: fixture.confirmationAsOfDate,
      computation: confirmation,
      profile: confirmationProfile,
      suffix: "70",
    });
    expect(pendingPayload.authorized_action).toBe(
      loss.expected.firstAuthorizedAction,
    );
    expect(confirmedPayload.authorized_action).toBe(
      loss.expected.confirmationAuthorizedAction,
    );
  });
});

describe("native Ad fixed-cohort replay parity", () => {
  it("rejects a stale as-of date because the lane is current-day parity only", () => {
    const now = new Date("2026-07-16T23:59:59.000Z");
    expect(() => assertCurrentUtcReplayDate("2026-07-16", now)).not.toThrow();
    expect(() => assertCurrentUtcReplayDate("2026-07-15", now)).toThrow(
      "Current-day production parity requires --as-of=2026-07-16",
    );
  });

  it("fails closed when the scheduler population is missing an enabled business or exact account identity", () => {
    expect(READ_SCHEDULER_POPULATION_MANIFEST_SQL).toContain(
      "WHERE business.is_demo_business = FALSE",
    );
    expect(READ_SCHEDULER_POPULATION_MANIFEST_SQL).toContain("LIMIT 500");
    expect(READ_SCHEDULER_POPULATION_MANIFEST_SQL).toContain(
      "COALESCE(flags.enabled, $1::boolean) = TRUE",
    );
    expect(READ_SCHEDULER_POPULATION_MANIFEST_SQL).toContain(
      "binding.provider = 'meta'",
    );
    const businessOne = "00000000-0000-4000-8000-000000000101";
    const businessTwo = "00000000-0000-4000-8000-000000000102";
    const refOne = "00000000-0000-4000-8000-000000000201";
    const refTwo = "00000000-0000-4000-8000-000000000202";
    const manifestRows = [
      {
        schedulerPosition: 1,
        businessId: businessOne,
        businessName: "First",
        providerAccountRefId: refOne,
        providerAccountId: "act_first",
      },
      {
        schedulerPosition: 2,
        businessId: businessTwo,
        businessName: "Second",
        providerAccountRefId: refTwo,
        providerAccountId: "act_second",
      },
    ];
    const proof = buildSchedulerPopulationCoverage({
      required: true,
      envDefaultEnabled: true,
      manifestRows,
      observedAnchors: [
        {
          jobRunId: "00000000-0000-4000-8000-000000000301",
          businessId: businessOne,
          businessName: "First",
        },
      ],
      observedIdentities: [
        {
          jobRunId: "00000000-0000-4000-8000-000000000301",
          businessId: businessOne,
          snapshotId: "00000000-0000-4000-8000-000000000401",
          providerAccountRefId: refOne,
          providerAccountId: "act_first",
        },
      ],
    });
    expect(proof).toMatchObject({
      required: true,
      expectedBusinessCount: 2,
      expectedProviderAccountCount: 2,
      missingBusinessAnchors: [businessTwo],
      missingProviderAccountIdentities: [
        {
          businessId: businessTwo,
          providerAccountRefId: refTwo,
          providerAccountId: "act_second",
        },
      ],
      contradictions: 2,
    });

    const missingSecondAccount = buildSchedulerPopulationCoverage({
      required: true,
      envDefaultEnabled: true,
      manifestRows: [
        manifestRows[0]!,
        {
          ...manifestRows[0]!,
          providerAccountRefId: refTwo,
          providerAccountId: "act_second",
        },
      ],
      observedAnchors: [
        {
          jobRunId: "00000000-0000-4000-8000-000000000301",
          businessId: businessOne,
          businessName: "First",
        },
      ],
      observedIdentities: [
        {
          jobRunId: "00000000-0000-4000-8000-000000000301",
          businessId: businessOne,
          snapshotId: "00000000-0000-4000-8000-000000000401",
          providerAccountRefId: refOne,
          providerAccountId: "act_first",
        },
      ],
    });
    expect(missingSecondAccount.missingBusinessAnchors).toEqual([]);
    expect(missingSecondAccount.missingProviderAccountIdentities).toEqual([
      {
        businessId: businessOne,
        providerAccountRefId: refTwo,
        providerAccountId: "act_second",
      },
    ]);
    expect(missingSecondAccount.contradictions).toBe(1);
  });

  it("decomposes the frozen cohort into bounded exact-identity reads", () => {
    expect(READ_FIXED_BASELINE_ANCHORS_SQL).toContain(
      "WITH expected_provider_scope AS MATERIALIZED",
    );
    expect(READ_FIXED_BASELINE_ANCHORS_SQL).toContain("decision_anchor AS (");
    expect(READ_FIXED_BASELINE_ANCHORS_SQL).toContain(
      "calibration_job.id = decision_anchor.dependency_run_id",
    );
    expect(READ_FIXED_BASELINE_ANCHORS_SQL).toContain(
      "expected_scope.business_selector = job.business_ref_id::text",
    );
    expect(READ_FIXED_BASELINE_ANCHORS_SQL).not.toContain(
      "engine_v3_ad_decision_snapshots_daily",
    );

    expect(READ_FIXED_BASELINE_IDENTITIES_SQL).toContain(
      "snapshot.job_run_id = $1::uuid",
    );
    expect(READ_FIXED_BASELINE_IDENTITIES_SQL).toContain(
      "snapshot.business_ref_id = $2::uuid",
    );
    expect(READ_FIXED_BASELINE_IDENTITIES_SQL).toContain(
      "snapshot.provider_account_id = ANY($5::text[])",
    );
    expect(READ_FIXED_BASELINE_IDENTITIES_SQL).not.toContain(
      "engine_v3_ad_decision_evaluations",
    );

    expect(READ_FIXED_BASELINE_ANCHOR_PROOF_SQL).toContain(
      "WHERE job.id = $1::uuid",
    );
    expect(READ_FIXED_BASELINE_ANCHOR_PROOF_SQL).toContain(
      "unnest($2::uuid[]) AS requested(snapshot_id)",
    );
    expect(READ_FIXED_BASELINE_ANCHOR_PROOF_SQL).toContain(
      "anchor.calibration_error_json #> '{metadata,batches}'",
    );
    expect(READ_FIXED_BASELINE_ANCHOR_PROOF_SQL).toContain(
      "receipt.generation_content_hash IS DISTINCT FROM",
    );

    expect(READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL).toContain(
      "WHERE job.id = $1::uuid",
    );
    expect(READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL).toContain(
      "value->>'provider_account_ref_id' = $2::uuid::text",
    );
    expect(READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL).toContain(
      "value->>'provider_account_id' = $3",
    );
    expect(READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL).not.toContain(
      "LEFT JOIN LATERAL",
    );

    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "WHERE snapshot.id = ANY($1::uuid[])",
    );
    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "snapshot.job_run_id = $2::uuid",
    );
    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "snapshot.provider_account_ref_id = $4::uuid",
    );
    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "snapshot.provider_account_id = $5",
    );
    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "THEN (evaluation.prior_hysteresis_json->>'sourceSnapshotId')::uuid",
    );
    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "THEN (evaluation.prior_hysteresis_json->>'sourceEvaluationId')::uuid",
    );
    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "prior_snapshot.id::text =\n       evaluation.prior_hysteresis_json->>'sourceSnapshotId'",
    );
    expect(READ_FIXED_BASELINE_ROW_PAYLOAD_SQL).toContain(
      "prior_evaluation.id::text =\n       evaluation.prior_hysteresis_json->>'sourceEvaluationId'",
    );

    for (const sql of [
      READ_FIXED_BASELINE_ANCHORS_SQL,
      READ_FIXED_BASELINE_IDENTITIES_SQL,
      READ_FIXED_BASELINE_ANCHOR_PROOF_SQL,
      READ_FIXED_BASELINE_ACCOUNT_PROOF_SQL,
      READ_FIXED_BASELINE_ROW_PAYLOAD_SQL,
    ]) {
      expect(sql).not.toContain("LIMIT 1");
      expect(sql).not.toContain("latest_batch");
      expect(sql).not.toContain("evaluation_fallback");
      expect(sql).not.toMatch(/provider_account_id\s*=\s*'[^']+'/);
    }
  });

  it("rebinds independently read proofs and payloads with exact row equality", () => {
    const anchor = {
      job_run_id: "00000000-0000-4000-8000-000000000001",
      business_id: "00000000-0000-4000-8000-000000000002",
      business_name: "Anonymous Shop",
    };
    const identity = {
      job_run_id: anchor.job_run_id,
      business_id: anchor.business_id,
      snapshot_id: "00000000-0000-4000-8000-000000000003",
      provider_account_ref_id: "00000000-0000-4000-8000-000000000004",
      provider_account_id: "act-anonymous-frozen",
    };
    const anchorProof = {
      ...anchor,
      anchor_selected_scope_snapshot_count: 1,
      anchor_actual_snapshot_count: 7,
      anchor_proof_marker: "anchor-proof",
    };
    const accountProof = {
      job_run_id: identity.job_run_id,
      business_id: identity.business_id,
      provider_account_ref_id: identity.provider_account_ref_id,
      provider_account_id: identity.provider_account_id,
      account_proof_marker: "account-proof",
    };
    const payload = {
      ...identity,
      payload_marker: "payload",
    };

    expect(
      rebindFixedBaselineCohortRows({
        anchorRows: [anchor],
        identityRows: [identity],
        anchorProofRows: [anchorProof],
        accountProofRows: [accountProof],
        payloadRows: [payload],
      }),
    ).toEqual([
      expect.objectContaining({
        ...identity,
        business_name: anchor.business_name,
        anchor_proof_marker: "anchor-proof",
        account_proof_marker: "account-proof",
        payload_marker: "payload",
      }),
    ]);

    expect(() =>
      rebindFixedBaselineCohortRows({
        anchorRows: [anchor],
        identityRows: [identity],
        anchorProofRows: [
          { ...anchorProof, anchor_selected_scope_snapshot_count: 0 },
        ],
        accountProofRows: [accountProof],
        payloadRows: [payload],
      }),
    ).toThrow("selected cardinality changed");
    expect(() =>
      rebindFixedBaselineCohortRows({
        anchorRows: [anchor],
        identityRows: [identity],
        anchorProofRows: [anchorProof],
        accountProofRows: [accountProof],
        payloadRows: [],
      }),
    ).toThrow("Payload cardinality mismatch");
  });

  it("parses generic provider-account scopes without firm-specific policy", () => {
    expect(
      parseArgs([
        "--as-of=2026-07-16",
        "--business=Anonymous Shop",
        "--provider-account=Anonymous Shop:act-anonymous-frozen",
        "--audit-provider-account=Audit Shop:act-audit-frozen",
      ]),
    ).toMatchObject({
      asOfDate: "2026-07-16",
      businesses: ["Anonymous Shop"],
      providerAccounts: [
        {
          businessSelector: "Anonymous Shop",
          providerAccountId: "act-anonymous-frozen",
        },
      ],
      auditProviderAccounts: [
        {
          businessSelector: "Audit Shop",
          providerAccountId: "act-audit-frozen",
        },
      ],
    });
    expect(() =>
      parseArgs(["--as-of=2026-07-16", "--provider-account=missing-separator"]),
    ).toThrow("--provider-account must be");
    expect(() =>
      parseArgs([
        "--as-of=2026-07-16",
        "--audit-provider-account=missing-separator",
      ]),
    ).toThrow("--audit-provider-account must be");
  });

  it("projects exact persisted media-buyer evidence without deriving metrics or boundaries", () => {
    expect(
      mediaBuyerExactInputMetrics({
        spend: 501,
        purchases: 4,
        purchaseValue: 401,
        roas: 0.8,
        recent7dSpend: 77,
        recent7dPurchases: 1,
        recent7dRoas: 0.55,
        ageDays: 19,
        effectiveStatus: "ACTIVE",
        dataFreshnessHours: 3,
      } as AdDecisionInput),
    ).toEqual({
      spend: 501,
      purchases: 4,
      purchaseValue: 401,
      roas: 0.8,
      recent7dSpend: 77,
      recent7dPurchases: 1,
      recent7dRoas: 0.55,
      ageDays: 19,
      effectiveStatus: "ACTIVE",
      dataFreshnessHours: 3,
    });

    const readyProjection = mediaBuyerProfileBoundaryProjection({
      thresholds: {
        bottomQuartileRatio: 0.61,
        commercialMaturitySpend: 120,
        hardCutSpend: 240,
        recentSampleMinSpend: 50,
      },
      commercialStopLossThresholds: {
        bottomQuartileRatio: 0.52,
        commercialMaturitySpend: 90,
        hardCutSpend: 180,
        recentSampleMinSpend: 45,
      },
    } as unknown as AccountDecisionProfile);
    expect(readyProjection).toEqual({
      profileKind: "account_decision_profile",
      boundarySemantics:
        "canonical_ratio_boundary; commercial_stop-loss overlay is Cut spend-depth only",
      canonical: {
        bottomQuartileRatio: 0.61,
        commercialMaturitySpend: 120,
        hardCutSpend: 240,
        recentSampleMinSpend: 50,
      },
      commercialStopLossOverlay: {
        bottomQuartileRatio: 0.52,
        commercialMaturitySpend: 90,
        hardCutSpend: 180,
        recentSampleMinSpend: 45,
      },
    });
    expect(
      mediaBuyerProfileBoundaryProjection({
        profileType: "native_ad_soft_only",
      } as NativeAdSoftOnlyDecisionProfile),
    ).toEqual({
      profileKind: "native_ad_soft_only",
      boundarySemantics:
        "canonical_ratio_boundary; commercial_stop-loss overlay is Cut spend-depth only",
      canonical: null,
      commercialStopLossOverlay: null,
    });
  });

  it("writes full and deterministic compact proof artifacts to separate output lanes", () => {
    const parsed = parseArgs([
      "--as-of=2026-07-16",
      "--json-out=/tmp/full-replay.json",
      "--compact-json-out=docs/creative-decision-center/generated/compact.json",
      "--stdout=compact",
    ]);
    expect(parsed).toMatchObject({
      jsonOut: "/tmp/full-replay.json",
      compactJsonOut: "docs/creative-decision-center/generated/compact.json",
      stdoutMode: "compact",
    });
    expect(() => assertReplayOutputPlan(parsed)).not.toThrow();
    expect(() =>
      assertReplayOutputPlan({
        jsonOut: "same.json",
        compactJsonOut: "./same.json",
        stdoutMode: "compact",
      }),
    ).toThrow("must use different files");
    expect(() =>
      assertReplayOutputPlan({
        jsonOut: null,
        compactJsonOut: null,
        stdoutMode: "none",
      }),
    ).toThrow("requires --json-out or --compact-json-out");
    expect(() =>
      assertReplayOutputPlan(
        {
          jsonOut: "/repo/docs/full-row-artifact.json",
          compactJsonOut: "/repo/docs/compact-proof.json",
          stdoutMode: "compact",
        },
        "/repo",
      ),
    ).toThrow("must stay outside the git worktree");
    expect(() => parseArgs(["--as-of=2026-07-16", "--stdout=invalid"])).toThrow(
      "--stdout must be",
    );

    const report = {
      contractVersion: "source.v1",
      generatedAt: "2026-07-16T00:00:00.000Z",
      releaseGate: { passed: true },
      schedulerPopulationCoverage: {
        manifestHash: "f".repeat(64),
        expectedBusinessCount: 12,
        expectedProviderAccountCount: 13,
        contradictions: 0,
      },
      calibrationContextProofSet: {
        contractVersion:
          "native-ad-replay-calibration-context-proof-set.v1",
        proofContractVersion:
          "native-ad-replay-calibration-context-proof.v1",
        contextCount: 1,
        associationCount: 2,
        contexts: [{ omittedFromCompact: true }],
        associations: [{ omittedFromCompact: true }],
        proofSetHash: "e".repeat(64),
      },
      mediaBuyerRowAudit: {
        selection: "exact requested scope",
        rowCount: 2,
        rows: [
          { cohortKeyHash: "cohort-b", identityHash: "identity-b", value: 2 },
          { cohortKeyHash: "cohort-a", identityHash: "identity-a", value: 1 },
        ],
      },
    } as unknown as Parameters<typeof buildCompactReplayProof>[0];
    const fullJson = `${JSON.stringify(report, null, 2)}\n`;
    const first = buildCompactReplayProof(report, fullJson);
    const second = buildCompactReplayProof(report, fullJson);
    expect(first).toEqual(second);
    expect(first.mediaBuyerRowAudit).toEqual({
      selection: "exact requested scope",
      rowCount: 2,
      rowsOmitted: true,
    });
    expect(first.artifactProjection).toMatchObject({
      projectionMode:
        "full_release_proof_with_media_buyer_rows_omitted_and_hash_bound",
      fullArtifactBytes: Buffer.byteLength(fullJson, "utf8"),
      omittedMediaBuyerRowCount: 2,
      schedulerPopulationManifestHash: "f".repeat(64),
      schedulerPopulationExpectedBusinessCount: 12,
      schedulerPopulationExpectedProviderAccountCount: 13,
      schedulerPopulationContradictions: 0,
      calibrationContextProofSetCommitment: {
        contractVersion:
          "native-ad-replay-calibration-context-proof-set.v1",
        proofContractVersion:
          "native-ad-replay-calibration-context-proof.v1",
        contextCount: 1,
        associationCount: 2,
        proofSetHash: "e".repeat(64),
        fullMaterialOmitted: true,
      },
      fullRowsRequiredForDrilldown: true,
    });
    expect(first.artifactProjection.fullArtifactSha256).toHaveLength(64);
    expect(
      first.artifactProjection.omittedMediaBuyerRowsCanonicalSha256,
    ).toHaveLength(64);
    expect(JSON.stringify(first)).not.toContain('"rows"');
    expect(() =>
      buildCompactReplayProof(
        {
          ...report,
          mediaBuyerRowAudit: {
            ...report.mediaBuyerRowAudit,
            rowCount: 3,
          },
        },
        fullJson,
      ),
    ).toThrow("row audit cardinality mismatch");
  });

  it("rejects wrong-lineage same-epoch prior evidence before D036 confirmation", async () => {
    const lossInput = withReplayIdentity(
      makeNativeInput(fixture.archetypes.belowBreakEvenLoss),
      "replay-wrong-prior",
      fixture.archetypes.belowBreakEvenLoss.campaignId,
    );
    const profileResult = await resolveFrozenGroup(fixture.firstAsOfDate, [
      lossInput,
    ]);
    const readyProfile = profileResult.profile as AccountDecisionProfile;
    const row = makeReplayBaselineRow({
      adInput: lossInput,
      accountProfile: readyProfile,
      index: 8,
    });
    row.priorHysteresis = {
      source: "persisted_evaluation",
      sourceBusinessId: "wrong-business",
      sourceProviderAccountId: fixture.providerAccountId,
      sourceDecisionEntityType: "ad",
      sourceDecisionEntityId: lossInput.decisionEntityId,
      sourceEvaluationId: "00000000-0000-4000-8000-000000000881",
      sourceSnapshotId: "00000000-0000-4000-8000-000000000882",
      sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
      sourceAsOfDate: "2026-07-14",
      sourceInputHash: "a".repeat(64),
      sourceDecisionHash: "b".repeat(64),
      publishedLabel: "cut",
      rawLabel: "cut",
    };
    row.priorHysteresisLineageValid = true;
    row.priorHysteresisSourceComputedAt = "2026-07-14T03:10:00.000Z";

    const wrongIdentityPrior = priorHysteresisMap(row);
    expect(wrongIdentityPrior).toMatchObject({
      replayable: false,
      status: "incomplete_lineage",
      sourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
    });
    expect(wrongIdentityPrior.map.size).toBe(0);
    const [decision] = compute(
      profileResult,
      [lossInput],
      wrongIdentityPrior.map,
    );
    expect(decision).toMatchObject({
      rawLabel: "cut",
      hysteresisSuppressed: true,
      decision: { label: "keep", blockedActionType: "cut" },
    });

    row.priorHysteresis.sourceBusinessId = fixture.businessId;
    row.priorHysteresisLineageValid = false;
    const unprovedDbLineage = priorHysteresisMap(row);
    expect(unprovedDbLineage.status).toBe("incomplete_lineage");
    expect(unprovedDbLineage.map.size).toBe(0);
  });

  it("keeps mixed ready, context-missing, calibration-missing and non-purchase identities computed", async () => {
    const readyBase = makeNativeInput(fixture.archetypes.aboveBreakEven);
    const ready = withReplayIdentity(
      readyBase,
      "replay-ready",
      "campaign-ready",
    );
    const missingObjective = {
      ...withReplayIdentity(
        readyBase,
        "replay-missing-objective",
        "campaign-missing-objective",
      ),
      objective: null,
    } satisfies AdDecisionInput;
    const missingCalibration = {
      ...withReplayIdentity(
        readyBase,
        "replay-missing-calibration",
        "campaign-missing-calibration",
      ),
      optimizationGoal: "IMPRESSIONS",
      customEventType: null,
    } satisfies AdDecisionInput;
    const nonPurchase = {
      ...withReplayIdentity(
        readyBase,
        "replay-non-purchase",
        "campaign-non-purchase",
      ),
      objective: "OUTCOME_TRAFFIC",
      optimizationGoal: "LINK_CLICKS",
      customEventType: null,
      effectiveCohort: "traffic",
    } satisfies AdDecisionInput;
    const persistedInputs = [
      ready,
      missingObjective,
      missingCalibration,
      nonPurchase,
    ];
    const { batch, cells } = makeFrozenCalibrationBatch(fixture.firstAsOfDate);
    const persistedGroups = await resolveNativeAdDecisionProfileGroups({
      businessId: fixture.businessId,
      asOf: fixture.firstAsOfDate,
      adInputs: persistedInputs,
      dataSource: new FrozenNativeProfileDataSource(
        cells,
        fixture.targetAuthority,
      ),
      flags: flags(),
    });
    const persistedProfileByAdId = new Map(
      persistedGroups.flatMap((group) =>
        group.adInputs.map((adInput) => [adInput.adId, group.profile] as const),
      ),
    );
    const rows = persistedInputs
      .map((adInput, index) => {
        const accountProfile = persistedProfileByAdId.get(adInput.adId);
        if (!accountProfile) {
          throw new Error(`Persisted group omitted ${adInput.adId}.`);
        }
        return makeReplayBaselineRow({
          adInput,
          accountProfile,
          index: index + 1,
        });
      })
      .sort((left, right) => left.cohortKey.localeCompare(right.cohortKey));
    const stableAccountKey = [
      fixture.businessId,
      fixture.providerAccountRefId,
      fixture.providerAccountId,
    ].join("\u0000");
    const slice: PreparedAccountSlice = {
      sliceKey: `${stableAccountKey}\u0000${fixture.firstAsOfDate}T03:05:00.000Z`,
      accountKey: stableAccountKey,
      businessId: fixture.businessId,
      businessName: "Frozen Replay Business",
      providerAccountRefId: fixture.providerAccountRefId,
      providerAccountId: fixture.providerAccountId,
      accountTimezone: fixture.accountTimezone,
      accountCurrency: fixture.accountCurrency,
      calibrationCutoff: `${fixture.firstAsOfDate}T03:05:00.000Z`,
      cutoffSource: "persisted_calibration_batch",
      rows,
      batch,
      cells,
      targetAuthority: fixture.targetAuthority,
      profileConfig: null,
      rawSourceRowCount: calibrationSourceRows().length,
      rawReceiptHash: "e".repeat(64),
      authorityProofContradictions: 0,
      dimensionProofContradictions: 0,
      sourceDimensionProof: {
        sourceAccountCurrency: fixture.accountCurrency,
        sourceAccountTimezone: fixture.accountTimezone,
        sourceTimezoneSelectionDate: fixture.sourceFactDate,
        anchoredAccountCurrency: fixture.accountCurrency,
        anchoredAccountTimezone: fixture.accountTimezone,
        currencyDriftedFromAnchor: false,
        timezoneDriftedFromAnchor: false,
        driftContradictions: 0,
      },
    };

    const challengers = await replayPreparedAccountSlice(slice);
    expect(challengers).toHaveLength(rows.length);
    expect(challengers.filter((row) => row.status === "failed")).toHaveLength(
      0,
    );
    expect(new Set(challengers.map((row) => row.cohortKey))).toEqual(
      new Set(rows.map((row) => row.cohortKey)),
    );
    expect(
      assessReplayAnchorDimensions({
        slice,
        frozenAnchorProofValid: true,
      }),
    ).toMatchObject({
      status: "exact",
      observedDriftDimensions: 0,
      authenticatedRepairDimensions: 0,
      unresolvedContradictions: 0,
    });
    const timezoneDriftGeneration = makeFrozenCalibrationBatch(
      fixture.firstAsOfDate,
      "UTC",
    );
    const timezoneDriftSlice: PreparedAccountSlice = {
      ...slice,
      batch: timezoneDriftGeneration.batch,
      cells: timezoneDriftGeneration.cells,
      sourceDimensionProof: {
        ...slice.sourceDimensionProof,
        sourceAccountTimezone: "UTC",
        timezoneDriftedFromAnchor: true,
        driftContradictions: 1,
      },
    };
    expect(
      assessReplayAnchorDimensions({
        slice: timezoneDriftSlice,
        frozenAnchorProofValid: true,
      }),
    ).toMatchObject({
      status: "authenticated_source_repair",
      observedDriftDimensions: 1,
      authenticatedRepairDimensions: 1,
      unresolvedContradictions: 0,
    });
    expect(
      assessReplayAnchorDimensions({
        slice: {
          ...timezoneDriftSlice,
          sourceDimensionProof: {
            ...timezoneDriftSlice.sourceDimensionProof,
            timezoneDriftedFromAnchor: false,
            driftContradictions: 0,
          },
        },
        frozenAnchorProofValid: true,
      }),
    ).toMatchObject({
      status: "unresolved_contradiction",
      authenticatedRepairDimensions: 0,
      contradictionCodes: ["declared_anchor_drift_mismatch"],
      unresolvedContradictions: 1,
    });
    const timezoneDriftChallengers =
      await replayPreparedAccountSlice(timezoneDriftSlice);
    expect(
      timezoneDriftChallengers
        .filter((row) => row.status === "failed")
        .map((row) => row.error),
    ).toEqual([]);
    const currencyDriftGeneration = makeFrozenCalibrationBatch(
      fixture.firstAsOfDate,
      fixture.accountTimezone,
      "TRY",
    );
    const currencyDriftSlice: PreparedAccountSlice = {
      ...slice,
      batch: currencyDriftGeneration.batch,
      cells: currencyDriftGeneration.cells,
      sourceDimensionProof: {
        ...slice.sourceDimensionProof,
        sourceAccountCurrency: "TRY",
        currencyDriftedFromAnchor: true,
        driftContradictions: 1,
      },
    };
    expect(
      assessReplayAnchorDimensions({
        slice: currencyDriftSlice,
        frozenAnchorProofValid: true,
      }),
    ).toMatchObject({
      status: "authenticated_source_repair",
      observedDriftDimensions: 1,
      authenticatedRepairDimensions: 1,
      unresolvedContradictions: 0,
    });
    expect(
      assessReplayAnchorDimensions({
        slice: {
          ...currencyDriftSlice,
          cells: currencyDriftSlice.cells.slice(1),
        },
        frozenAnchorProofValid: true,
      }),
    ).toMatchObject({
      status: "unresolved_contradiction",
      authenticatedRepairDimensions: 0,
      contradictionCodes: ["replay_cell_generation_mismatch"],
      unresolvedContradictions: 1,
    });
    const currencyDriftChallengers =
      await replayPreparedAccountSlice(currencyDriftSlice);
    expect(
      currencyDriftChallengers
        .filter((row) => row.status === "failed")
        .map((row) => row.error),
    ).toEqual([]);
    const readyRow = rows.find(
      (row) => row.creativeInput.adId === "replay-ready",
    );
    if (!readyRow) throw new Error("Frozen ready replay row missing.");
    const [missingExactChallenger] = await replayPreparedAccountSlice({
      ...slice,
      rows: [readyRow],
      cells: slice.cells.filter(
        (cell) => cell.key.cellScope !== "objective_cohort_context",
      ),
    });
    expect(missingExactChallenger?.error).toBeNull();
    expect(missingExactChallenger).toMatchObject({
      status: "computed",
      profileStatus: "soft_only",
      profileReason: "native_ad_profile_unready:native_calibration_missing",
      calibrationRowId: null,
      authorityBlocker: "native_profile_unavailable",
      simulatedAuthorizedAction: null,
    });
    expect(buildWaveCoverageProof(rows).businesses[0]?.valid).toBe(true);
    expect(buildWaveCoverageProof(rows.slice(1)).businesses[0]).toMatchObject({
      selectedScopeSnapshotRows: 4,
      selectedFrozenSnapshotRows: 3,
      valid: false,
    });
    const anchoredManifestHash = hashAdDecisionIdentityManifest({
      businessId: fixture.businessId,
      providerAccountId: fixture.providerAccountId,
      asOfDate: fixture.firstAsOfDate,
      adIds: rows.map((row) => row.creativeInput.adId),
    });
    const currentScd0TimezoneDriftRows = rows.map((row) => ({
      ...row,
      hydrationExpectedManifestHash: anchoredManifestHash,
      hydrationHydratedManifestHash: anchoredManifestHash,
      currentAccountTimezone: "UTC",
    }));
    expect(
      buildWaveCoverageProof(currentScd0TimezoneDriftRows).accounts[0]?.valid,
    ).toBe(true);
    expect(
      buildCurrentScd0DimensionDriftProof(currentScd0TimezoneDriftRows),
    ).toMatchObject({
      observedAccounts: 1,
      driftAccounts: 1,
      driftRows: 4,
      accounts: [
        {
          anchoredTimezones: [fixture.accountTimezone],
          currentTimezones: ["UTC"],
          timezoneDriftRows: 4,
          currencyDriftRows: 0,
          reasons: ["timezone_changed_after_anchor"],
          drifted: true,
        },
      ],
    });
    expect(
      buildRequestedScopeCoverage({
        args: {
          businesses: ["Frozen Replay Business"],
          providerAccounts: [
            {
              businessSelector: "Frozen Replay Business",
              providerAccountId: fixture.providerAccountId,
            },
          ],
        },
        rows,
      }),
    ).toMatchObject({ contradictions: 0 });
    expect(
      buildRequestedScopeCoverage({
        args: {
          businesses: ["Frozen Replay Business", "Missing Business"],
          providerAccounts: [
            {
              businessSelector: "Frozen Replay Business",
              providerAccountId: fixture.providerAccountId,
            },
            {
              businessSelector: "Frozen Replay Business",
              providerAccountId: "act-missing-anonymous",
            },
          ],
        },
        rows,
      }),
    ).toMatchObject({
      businessContradictions: 1,
      providerAccountContradictions: 1,
      contradictions: 2,
    });

    const byReplayAdId = (adId: string) => {
      const result = challengers.find(
        (row) => row.cohortKey === fixedReplayCohortKey(adId),
      );
      if (!result) throw new Error(`Replay omitted ${adId}.`);
      return result;
    };
    expect(byReplayAdId("replay-ready")).toMatchObject({
      status: "computed",
      profileStatus: "ready",
    });
    expect(byReplayAdId("replay-ready").challengerDataHealthHash).toBe(
      byReplayAdId("replay-ready").persistedDataHealthHash,
    );
    expect(byReplayAdId("replay-ready").challengerScaleRefreshProfileHash).toBe(
      byReplayAdId("replay-ready").persistedScaleRefreshProfileHash,
    );
    expect(byReplayAdId("replay-missing-objective")).toMatchObject({
      status: "computed",
      profileStatus: "soft_only",
      profileReason: "native_ad_profile_context_missing:objective",
      rawLabel: "diagnose",
      publishedLabel: "diagnose",
      authorityBlocker: "native_profile_unavailable",
      simulatedAuthorizedAction: null,
    });
    expect(byReplayAdId("replay-missing-calibration")).toMatchObject({
      status: "computed",
      profileStatus: "soft_only",
      profileReason: "native_ad_profile_unready:native_calibration_missing",
      rawLabel: "diagnose",
      publishedLabel: "diagnose",
      authorityBlocker: "native_profile_unavailable",
      simulatedAuthorizedAction: null,
    });
    expect(byReplayAdId("replay-non-purchase")).toMatchObject({
      status: "computed",
      profileStatus: "soft_only",
      profileReason:
        "native_ad_profile_unready:native_non_purchase_roas_unsupported",
      rawLabel: "out_of_scope",
      publishedLabel: "out_of_scope",
      authorityBlocker: null,
      simulatedAuthorizedAction: null,
    });

    const inconsistentRows = rows.map((row) => ({
      ...row,
      flags: {
        ...row.flags,
        source: { ...row.flags.source },
        envDefaults: { ...row.flags.envDefaults },
      },
    }));
    inconsistentRows[0]!.flags.shadowOnly =
      !inconsistentRows[0]!.flags.shadowOnly;
    const failed = await replayPreparedAccountSlice({
      ...slice,
      rows: inconsistentRows,
    });
    expect(failed).toHaveLength(rows.length);
    expect(failed.every((row) => row.status === "failed")).toBe(true);
    expect(failed[0]?.error).toContain("persisted flags differ");
  });

  it("rebuilds a P25-backed PURCHASE profile despite an unrelated VALUE account-AOV contradiction", async () => {
    const purchaseRows = Array.from({ length: 30 }, (_, index) =>
      makeCalibrationSourceRow({ index: index + 1, accountOnly: false }),
    );
    const contradictoryValueRow = {
      ...makeCalibrationSourceRow({ index: 901, accountOnly: true }),
      sourceRowId: "source-unrelated-value-contradiction",
      adId: "unrelated-value-contradiction",
      optimizationGoal: "VALUE",
      customEventType: "VALUE",
      conversions: 0,
      revenue: 100,
    };
    const sourceRows = [...purchaseRows, contradictoryValueRow];
    const generation = makeReplayCalibrationGeneration(sourceRows);
    const exact = generation.cells.find(
      (cell) =>
        cell.key.cellScope === "objective_cohort_context" &&
        cell.key.optimizationContext === "goal=PURCHASE|event=PURCHASE",
    );
    expect(generation.batch.spendUnitAuthority.accountAovEvidence.status).toBe(
      "contradictory_purchase_truth",
    );
    expect(exact?.accountCalibration.roasRatioP25).toBeGreaterThan(0);
    expect(exact?.actionReadiness.cut).toMatchObject({
      ready: true,
      authorityBasis: "calibrated_relative_with_economic_stop_loss",
    });

    const legacySafeLossInput = {
      ...makeNativeInput(fixture.archetypes.belowBreakEvenLoss),
      purchaseValue: 60,
      roas: 0.2,
      recent7dRoas: 0.2,
    };
    const challenger = await replayOneFromGeneration({
      adInput: withReplayIdentity(
        legacySafeLossInput,
        "replay-p25-backed-unrelated-value-contradiction",
        "campaign-p25-backed-unrelated-value-contradiction",
      ),
      ...generation,
      rawSourceRowCount: sourceRows.length,
      index: 31,
    });

    expect(challenger).toMatchObject({
      status: "computed",
      selectedCellCutAuthorityBasis:
        "calibrated_relative_with_economic_stop_loss",
      repairAuthoritySelected: false,
      preAuthorityLabel: "cut",
      authorityBlocker: null,
      rawLabel: "cut",
      publishedLabel: "keep",
      blockedActionType: "cut",
      simulatedAuthorizedAction: null,
    });
    expect(challenger.policyAudit?.zone).toBe("legacy_safe_loss");
  });

  it("keeps a P25-null PURCHASE profile fail-closed when account-AOV proof is contradictory", async () => {
    const purchaseRows = Array.from({ length: 5 }, (_, index) =>
      makeCalibrationSourceRow({ index: index + 1, accountOnly: false }),
    );
    const contradictoryValueRow = {
      ...makeCalibrationSourceRow({ index: 902, accountOnly: true }),
      sourceRowId: "source-p25-null-value-contradiction",
      adId: "p25-null-value-contradiction",
      optimizationGoal: "VALUE",
      customEventType: "VALUE",
      conversions: 0,
      revenue: 100,
    };
    const sourceRows = [...purchaseRows, contradictoryValueRow];
    const generation = makeReplayCalibrationGeneration(sourceRows);
    const exact = generation.cells.find(
      (cell) =>
        cell.key.cellScope === "objective_cohort_context" &&
        cell.key.optimizationContext === "goal=PURCHASE|event=PURCHASE",
    );
    expect(generation.batch.spendUnitAuthority.accountAovEvidence.status).toBe(
      "contradictory_purchase_truth",
    );
    expect(exact?.accountCalibration.roasRatioP25).toBeNull();
    expect(exact?.actionReadiness.cut).toMatchObject({
      ready: false,
      reason: "commercial_spend_unit_authority_missing",
      authorityBasis: null,
    });

    const challenger = await replayOneFromGeneration({
      adInput: withReplayIdentity(
        makeNativeInput(fixture.archetypes.belowBreakEvenLoss),
        "replay-p25-null-value-contradiction",
        "campaign-p25-null-value-contradiction",
      ),
      ...generation,
      rawSourceRowCount: sourceRows.length,
      index: 32,
    });

    expect(challenger).toMatchObject({
      status: "computed",
      selectedCellCutAuthorityBasis: null,
      repairAuthoritySelected: false,
      preAuthorityLabel: "cut",
      authorityBlocker: "profile_hard_action_ineligible",
      rawLabel: "test_more",
      publishedLabel: "test_more",
      blockedActionType: "cut",
      simulatedAuthorizedAction: null,
    });
  });

  it("rebuilds above-break-even maturity from the production challenger profile", async () => {
    const baseInput = withReplayIdentity(
      makeNativeInput(fixture.archetypes.aboveBreakEven),
      "replay-non-cut-maturity-boundary",
      "campaign-non-cut-maturity-boundary",
    );
    const probeGroup = await resolveFrozenGroup(fixture.firstAsOfDate, [
      baseInput,
    ]);
    const probeProfile = probeGroup.profile as AccountDecisionProfile;
    const restatedMaturityFloor =
      probeProfile.thresholds.commercialMaturitySpend;
    const recentFloor = probeProfile.thresholds.recentSampleMinSpend ?? 0;
    if (
      restatedMaturityFloor === null ||
      restatedMaturityFloor - 1 <= recentFloor
    ) {
      throw new Error("Frozen profile lacks a usable maturity boundary.");
    }
    const boundarySpend = restatedMaturityFloor - 1;
    const boundaryInput: AdDecisionInput = {
      ...baseInput,
      spend: boundarySpend,
      purchases: 3,
      purchaseValue: boundarySpend * 1.8,
      roas: 1.8,
      cpa: boundarySpend / 3,
    };
    const currentGroup = await resolveFrozenGroup(fixture.firstAsOfDate, [
      boundaryInput,
    ]);
    expect(compute(currentGroup, [boundaryInput])[0]?.rawLabel).toBe(
      "test_more",
    );

    const persistedProfile: AccountDecisionProfile = {
      ...(currentGroup.profile as AccountDecisionProfile),
      scope: {
        ...(currentGroup.profile as AccountDecisionProfile).scope,
        fallbackReason: null,
      } as unknown as AccountDecisionProfile["scope"],
      thresholds: {
        ...(currentGroup.profile as AccountDecisionProfile).thresholds,
        commercialMaturitySpend: restatedMaturityFloor - 2,
      },
    };
    const row = makeReplayBaselineRow({
      adInput: boundaryInput,
      accountProfile: persistedProfile,
      index: 9,
    });
    const { batch, cells } = makeFrozenCalibrationBatch(fixture.firstAsOfDate);
    const stableAccountKey = [
      fixture.businessId,
      fixture.providerAccountRefId,
      fixture.providerAccountId,
    ].join("\u0000");
    const [challenger] = await replayPreparedAccountSlice({
      sliceKey: `${stableAccountKey}\u0000${fixture.firstAsOfDate}T03:05:00.000Z`,
      accountKey: stableAccountKey,
      businessId: fixture.businessId,
      businessName: "Frozen Replay Business",
      providerAccountRefId: fixture.providerAccountRefId,
      providerAccountId: fixture.providerAccountId,
      accountTimezone: fixture.accountTimezone,
      accountCurrency: fixture.accountCurrency,
      calibrationCutoff: `${fixture.firstAsOfDate}T03:05:00.000Z`,
      cutoffSource: "persisted_calibration_batch",
      rows: [row],
      batch,
      cells,
      targetAuthority: fixture.targetAuthority,
      profileConfig: null,
      rawSourceRowCount: calibrationSourceRows().length,
      rawReceiptHash: "e".repeat(64),
      authorityProofContradictions: 0,
      dimensionProofContradictions: 0,
      sourceDimensionProof: {
        sourceAccountCurrency: fixture.accountCurrency,
        sourceAccountTimezone: fixture.accountTimezone,
        sourceTimezoneSelectionDate: fixture.sourceFactDate,
        anchoredAccountCurrency: fixture.accountCurrency,
        anchoredAccountTimezone: fixture.accountTimezone,
        currencyDriftedFromAnchor: false,
        timezoneDriftedFromAnchor: false,
        driftContradictions: 0,
      },
    });

    expect(challenger).toMatchObject({
      status: "computed",
      preAuthorityLabel: "test_more",
      rawLabel: "test_more",
      publishedLabel: "test_more",
      blockedActionType: null,
      simulatedAuthorizedAction: null,
    });
    expect(challenger?.challengerScaleRefreshProfileHash).not.toBe(
      challenger?.persistedScaleRefreshProfileHash,
    );
    expect(challenger?.challengerDataHealthHash).toBe(
      challenger?.persistedDataHealthHash,
    );
  });

  it("audits D063 legacy compatibility, expanded tri-state and AOV overlay isolation", () => {
    const policyAudit = (input: {
      zone: "legacy_safe_loss" | "expanded_economic_loss";
      recent: "confirmed_loss" | "recovery" | "thin" | "unverifiable" | null;
      p25: number | null;
      overlayInstalled?: boolean;
      overlayActivated?: boolean;
      legacyDrift?: boolean;
    }) =>
      ({
        zone: input.zone,
        matureForCut: true,
        recentEvidenceStatus: input.recent,
        canonicalBottomQuartileRatio: input.p25,
        accountAovOverlayInstalled: input.overlayInstalled ?? false,
        accountAovOverlayActivated: input.overlayActivated ?? false,
        legacySafeZoneProjectionDrift: input.legacyDrift ?? false,
      }) as ChallengerRow["policyAudit"];
    const base = {
      status: "computed",
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      rawLabel: "keep",
      publishedLabel: "keep",
      blockedActionType: null,
      simulatedAuthorizedAction: null,
      hysteresisSuppressed: false,
      badges: [],
      priorHysteresisStatus: "none",
      priorHysteresisSourceEngineVersion: null,
      priorRawLabel: null,
    } as unknown as ChallengerRow;
    const confirmed = {
      ...base,
      preAuthorityLabel: "cut",
      rawLabel: "cut",
      publishedLabel: "keep",
      blockedActionType: "cut",
      hysteresisSuppressed: true,
      badges: [PENDING_TRANSITION_BADGE],
      reason:
        "[Pending hard action: cut] No hard action is published until this signal repeats on the next evaluation. Current evidence: confirmed loss",
      policyAudit: policyAudit({
        zone: "expanded_economic_loss",
        recent: "confirmed_loss",
        p25: null,
        overlayInstalled: true,
        overlayActivated: true,
      }),
    } as unknown as ChallengerRow;
    const recovery = {
      ...base,
      policyAudit: policyAudit({
        zone: "expanded_economic_loss",
        recent: "recovery",
        p25: 0.28,
      }),
    } as ChallengerRow;
    const held = {
      ...base,
      preAuthorityLabel: "cut",
      authorityBlocker: "recent_recovery_unverifiable",
      rawLabel: "test_more",
      publishedLabel: "test_more",
      blockedActionType: "cut",
      policyAudit: policyAudit({
        zone: "expanded_economic_loss",
        recent: "thin",
        p25: 0.28,
      }),
    } as ChallengerRow;
    const contextHeldConfirmedLoss = {
      ...confirmed,
      authorityBlocker: "campaign_context",
      blockedActionType: "cut",
      hysteresisSuppressed: false,
      badges: [],
    } as ChallengerRow;
    const diagnosticContextHold = {
      ...contextHeldConfirmedLoss,
      rawLabel: "diagnose",
      publishedLabel: "diagnose",
      reason: "[Stop-loss review - label campaign before cut]",
    } as ChallengerRow;
    const legacy = {
      ...base,
      policyAudit: policyAudit({
        zone: "legacy_safe_loss",
        recent: null,
        p25: 0.28,
      }),
    } as ChallengerRow;

    expect(d063ExpandedStripSemanticViolation(confirmed)).toBe(false);
    expect(d063ExpandedStripSemanticViolation(contextHeldConfirmedLoss)).toBe(
      false,
    );
    expect(d063ExpandedStripSemanticViolation(diagnosticContextHold)).toBe(
      false,
    );
    expect(d063ExpandedStripSemanticViolation(recovery)).toBe(false);
    expect(d063ExpandedStripSemanticViolation(held)).toBe(false);
    const audit = buildD063ReplayPolicyAudit([
      legacy,
      confirmed,
      recovery,
      held,
    ]);
    expect(audit).toMatchObject({
      compatibilityControl: {
        legacySafeZoneRows: 1,
        legacySafeZoneProjectionDriftRows: 0,
      },
      expandedStrip: {
        rows: 3,
        matureRows: 3,
        confirmedLoss: { rows: 1, rawCutRows: 1, d036PendingRows: 1 },
        recovery: { rows: 1, keepRows: 1 },
        thin: { rows: 1 },
        held: { rows: 1, authorizedCutRows: 0, pendingRows: 0 },
        semanticViolationRows: 0,
      },
      accountAovOverlay: {
        p25NullInstalledRows: 1,
        p25NullActivatedRows: 1,
        p25BackedInstalledRows: 0,
        p25NullReachabilityFailure: 0,
      },
    });

    const invalidHeld = {
      ...held,
      hysteresisSuppressed: true,
      simulatedAuthorizedAction: "cut",
      badges: [PENDING_TRANSITION_BADGE],
    } as ChallengerRow;
    const invalidRecovery = {
      ...recovery,
      preAuthorityLabel: "cut",
      rawLabel: "cut",
    } as ChallengerRow;
    expect(d063ExpandedStripSemanticViolation(invalidHeld)).toBe(true);
    expect(d063ExpandedStripSemanticViolation(invalidRecovery)).toBe(true);
    expect(
      buildD063ReplayPolicyAudit([
        {
          ...legacy,
          policyAudit: {
            ...legacy.policyAudit!,
            legacySafeZoneProjectionDrift: true,
          },
        },
        invalidHeld,
        invalidRecovery,
        {
          ...base,
          policyAudit: policyAudit({
            zone: "expanded_economic_loss",
            recent: "confirmed_loss",
            p25: 0.28,
            overlayInstalled: true,
          }),
        } as ChallengerRow,
      ]),
    ).toMatchObject({
      compatibilityControl: { legacySafeZoneProjectionDriftRows: 1 },
      expandedStrip: {
        held: { authorizedCutRows: 1, pendingRows: 1 },
        semanticViolationRows: 3,
      },
      accountAovOverlay: {
        p25BackedInstalledRows: 1,
        p25NullReachabilityFailure: 1,
      },
    });
  });

  it("gates the exact four-account media-buyer identities and paused TheSwaf semantics", () => {
    const scope = [
      "822913786458311",
      "1087566732415606",
      "1054905059780305",
      "805150454596350",
    ].map((providerAccountId) => ({
      businessSelector: `business-${providerAccountId}`,
      providerAccountId,
    }));
    const baseline = (
      providerAccountId: string,
      adId: string,
      effectiveStatus: "ACTIVE" | "PAUSED",
    ) =>
      ({
        businessId: `business-${providerAccountId}`,
        businessName: `business-${providerAccountId}`,
        providerAccountRefId: `ref-${providerAccountId}`,
        providerAccountId,
        creativeInput: { adId, effectiveStatus },
      }) as unknown as BaselineRow;
    const expandedAudit = (
      recentEvidenceStatus: "confirmed_loss" | "recovery",
    ) =>
      ({
        zone: "expanded_economic_loss",
        matureForCut: true,
        recentEvidenceStatus,
      }) as ChallengerRow["policyAudit"];
    const claude = {
      preAuthorityLabel: "cut",
      authorityBlocker: null,
      rawLabel: "cut",
      publishedLabel: "keep",
      blockedActionType: "cut",
      hysteresisSuppressed: true,
      simulatedAuthorizedAction: null,
      badges: [PENDING_TRANSITION_BADGE],
      reason:
        "[Pending hard action: cut] No hard action is published until this signal repeats on the next evaluation. Current evidence: confirmed loss",
      priorHysteresisStatus: "none",
      priorHysteresisSourceEngineVersion: null,
      priorRawLabel: null,
      policyAudit: expandedAudit("confirmed_loss"),
    } as ChallengerRow;
    const shipping = {
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      rawLabel: "keep",
      publishedLabel: "keep",
      blockedActionType: null,
      hysteresisSuppressed: false,
      simulatedAuthorizedAction: null,
      policyAudit: expandedAudit("recovery"),
    } as ChallengerRow;
    const emolosReadyCut = {
      preAuthorityLabel: "cut",
      authorityBlocker: null,
      rawLabel: "cut",
      publishedLabel: "keep",
      blockedActionType: "cut",
      hysteresisSuppressed: true,
      simulatedAuthorizedAction: null,
      selectedCellCutAuthorityBasis: "commercial_stop_loss",
      selectedCellMetaAovPurchaseCount: 38,
      selectedCellMetaAovQuality: "ready",
      selectedCellMatureAdCount: 12,
      spendUnitAuthorityBasis: "physical_account_purchase_aov_90d",
      spendUnitAuthorityStatus: "ready",
      accountAovEvidenceStatus: "ready",
    } as ChallengerRow;
    const pairs = [
      {
        baseline: baseline("805150454596350", "120247018755120316", "ACTIVE"),
        challenger: claude,
      },
      {
        baseline: baseline("805150454596350", "120249371633480316", "ACTIVE"),
        challenger: shipping,
      },
      {
        baseline: baseline("822913786458311", "the-swaf-ad", "PAUSED"),
        challenger: {
          simulatedAuthorizedAction: null,
        } as ChallengerRow,
      },
      {
        baseline: baseline("1087566732415606", "iwa-ad", "ACTIVE"),
        challenger: null,
      },
      {
        baseline: baseline("1054905059780305", "emolos-ad", "ACTIVE"),
        challenger: emolosReadyCut,
      },
    ];
    expect(
      exactMediaBuyerScopeRequested({ auditProviderAccounts: scope }),
    ).toBe(true);
    expect(
      exactMediaBuyerScopeRequested({
        auditProviderAccounts: [
          ...scope,
          {
            businessSelector: "second-the-swaf",
            providerAccountId: "act_921275999286619",
          },
        ],
      }),
    ).toBe(true);
    expect(
      buildD063ExactMediaBuyerAudit({
        args: { auditProviderAccounts: scope },
        pairedRows: pairs,
      }),
    ).toMatchObject({
      required: true,
      contradictions: 0,
      grandmix: {
        claudeBathroomMeta: {
          evidenceState: "expanded_confirmed_loss",
          projectionValid: true,
        },
        bathroomMetaShipping: {
          evidenceState: "expanded_recovery",
          projectionValid: true,
        },
      },
      theSwafMain: { rows: 1, pausedRows: 1, actionableRows: 0 },
      activeCutReachability: {
        physicalAccountReadyPreAuthorityCutRows: 1,
        cutReadyPreAuthorityRows: 1,
        profileBlockedRows: 0,
        missingCutAuthorityBasisRows: 0,
      },
    });

    const aboveBreakEvenKeep = {
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      rawLabel: "keep",
      publishedLabel: "keep",
      blockedActionType: null,
      hysteresisSuppressed: false,
      simulatedAuthorizedAction: null,
      badges: [],
      policyAudit: {
        zone: null,
        matureForCut: false,
        recentEvidenceStatus: null,
      },
    } as unknown as ChallengerRow;
    const evidenceChanged = buildD063ExactMediaBuyerAudit({
      args: { auditProviderAccounts: scope },
      pairedRows: pairs.map((pair) =>
        pair.baseline.creativeInput.adId === "120247018755120316"
          ? {
              baseline: {
                ...pair.baseline,
                creativeInput: {
                  ...pair.baseline.creativeInput,
                  roas: 1.99,
                  breakevenRoas: 1.8,
                },
              },
              challenger: aboveBreakEvenKeep,
            }
          : pair,
      ),
    });
    expect(evidenceChanged).toMatchObject({
      contradictions: 0,
      grandmix: {
        claudeBathroomMeta: {
          evidenceState: "at_or_above_breakeven",
          projectionValid: true,
        },
      },
    });

    const extraScope = buildD063ExactMediaBuyerAudit({
      args: {
        auditProviderAccounts: [
          ...scope,
          {
            businessSelector: "second-the-swaf",
            providerAccountId: "act_921275999286619",
          },
        ],
      },
      pairedRows: pairs,
    });
    expect(extraScope.required).toBe(true);
    expect(extraScope.violations).toContain(
      "unexpected_exact_scope_provider_accounts:act_921275999286619",
    );

    const staleProfileBlocker = buildD063ExactMediaBuyerAudit({
      args: { auditProviderAccounts: scope },
      pairedRows: pairs.map((pair) =>
        pair.baseline.providerAccountId === "1054905059780305"
          ? {
              ...pair,
              challenger: {
                ...emolosReadyCut,
                authorityBlocker: "profile_hard_action_ineligible",
              },
            }
          : pair,
      ),
    });
    expect(staleProfileBlocker.violations).toContain(
      "exact_active_cut_ready_profile_blocked_rows:1",
    );

    const missingCutAuthorityBasis = buildD063ExactMediaBuyerAudit({
      args: { auditProviderAccounts: scope },
      pairedRows: pairs.map((pair) =>
        pair.baseline.providerAccountId === "1054905059780305"
          ? {
              ...pair,
              challenger: {
                ...emolosReadyCut,
                selectedCellCutAuthorityBasis: null,
              },
            }
          : pair,
      ),
    });
    expect(missingCutAuthorityBasis.violations).toContain(
      "exact_active_physical_account_ready_cut_authority_basis_missing_rows:1",
    );

    const broken = buildD063ExactMediaBuyerAudit({
      args: { auditProviderAccounts: scope },
      pairedRows: pairs.map((pair) =>
        pair.baseline.providerAccountId === "822913786458311"
          ? {
              ...pair,
              challenger: {
                simulatedAuthorizedAction: "cut",
              } as ChallengerRow,
            }
          : pair,
      ),
    });
    expect(broken.contradictions).toBe(1);
    expect(broken.violations).toContain(
      "theswaf_main_non_active_actionable_rows:1",
    );
    expect(
      buildD063ExactMediaBuyerAudit({
        args: { auditProviderAccounts: scope.slice(0, 1) },
        pairedRows: [],
      }),
    ).toMatchObject({ required: false, contradictions: 0 });
    expect(
      buildD063ExactMediaBuyerAudit({
        args: { auditProviderAccounts: [] },
        requireAudit: true,
        pairedRows: pairs,
      }),
    ).toMatchObject({
      required: true,
      declaredScopeComplete: false,
      contradictions: 1,
      violations: ["exact_media_buyer_audit_scope_incomplete"],
    });
  });

  it("closes zero-opportunity, per-row D036 and full Scale/Refresh tuple false greens", () => {
    expect(aovPositiveControlFailure(0, 0)).toBe(0);
    expect(aovPositiveControlFailure(1, 0)).toBe(1);
    expect(aovPositiveControlFailure(1, 1)).toBe(0);

    const pending = {
      authorityBlocker: null,
      rawLabel: "cut",
      publishedLabel: "keep",
      hysteresisSuppressed: true,
      blockedActionType: "cut",
      simulatedAuthorizedAction: null,
      priorHysteresisStatus: "none",
      priorHysteresisSourceEngineVersion: null,
      priorRawLabel: null,
      badges: [PENDING_TRANSITION_BADGE],
      reason:
        "[Pending hard action: cut] No hard action is published until this signal repeats on the next evaluation. Current evidence: confirmed loss",
    } as ChallengerRow;
    expect(d036HardActionTupleValid(pending)).toBe(true);
    expect(d036PendingCutTupleValid(pending)).toBe(true);
    expect(d036PendingCutTupleValid({ ...pending, badges: [] })).toBe(false);
    expect(
      d036PendingCutTupleValid({ ...pending, publishedLabel: "cut" }),
    ).toBe(false);
    expect(
      d036PendingCutTupleValid({
        ...pending,
        priorHysteresisStatus: "current_epoch_replayed",
        priorHysteresisSourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
        priorRawLabel: "keep",
      }),
    ).toBe(true);
    expect(
      d036HardActionTupleValid({
        ...pending,
        rawLabel: "keep",
        publishedLabel: "keep",
      }),
    ).toBe(false);
    const pendingScale = {
      ...pending,
      rawLabel: "scale",
      blockedActionType: "scale",
      reason:
        "[Pending hard action: scale] No hard action is published until this signal repeats on the next evaluation. Current evidence: scale candidate",
    } as ChallengerRow;
    expect(d036HardActionTupleValid(pendingScale)).toBe(true);
    expect(
      d036HardActionTupleValid({
        ...pendingScale,
        badges: [],
      }),
    ).toBe(false);
    expect(
      d036HardActionTupleValid({
        ...pendingScale,
        rawLabel: "refresh",
        blockedActionType: "refresh",
        reason:
          "[Pending hard action: refresh] No hard action is published until this signal repeats on the next evaluation. Current evidence: fatigue",
      }),
    ).toBe(true);
    expect(
      d036PendingCutTupleValid({
        ...pending,
        priorHysteresisStatus: "current_epoch_replayed",
        priorHysteresisSourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
        priorRawLabel: "cut",
      }),
    ).toBe(false);
    expect(
      d036PendingCutTupleValid({
        ...pending,
        publishedLabel: "cut",
        hysteresisSuppressed: false,
        blockedActionType: null,
        simulatedAuthorizedAction: "cut",
        badges: [],
        reason: "Confirmed Cut",
        priorHysteresisStatus: "current_epoch_replayed",
        priorHysteresisSourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
        priorRawLabel: "cut",
      }),
    ).toBe(true);
    expect(
      d036PendingCutTupleValid({
        ...pending,
        authorityBlocker: "campaign_context",
        publishedLabel: "cut",
        hysteresisSuppressed: false,
        blockedActionType: "cut",
        simulatedAuthorizedAction: null,
        badges: [],
        reason: "Confirmed review-only Cut",
        priorHysteresisStatus: "current_epoch_replayed",
        priorHysteresisSourceEngineVersion: NATIVE_AD_ENGINE_VERSION,
        priorRawLabel: "cut",
      }),
    ).toBe(true);

    const baseline: BaselineRow["baseline"] = {
      preAuthorityLabel: "scale",
      authorityBlocker: "profile_hard_action_ineligible",
      rawLabel: "keep",
      publishedLabel: "keep",
      blockedActionType: "scale",
      authorizedAction: null,
      hysteresisSuppressed: false,
      confidence: 77,
      reason: "same projection",
      badges: [],
    };
    const challenger = {
      preAuthorityLabel: baseline.preAuthorityLabel,
      authorityBlocker: baseline.authorityBlocker,
      rawLabel: baseline.rawLabel,
      publishedLabel: baseline.publishedLabel,
      blockedActionType: baseline.blockedActionType,
      simulatedAuthorizedAction: baseline.authorizedAction,
      hysteresisSuppressed: baseline.hysteresisSuppressed,
      confidence: baseline.confidence,
      reason: baseline.reason,
      badges: baseline.badges,
    } as ChallengerRow;
    expect(scaleRefreshProjectionDrift({ baseline, challenger })).toBe(false);
    expect(
      scaleRefreshProjectionDrift({
        baseline,
        challenger: { ...challenger, confidence: 76 },
      }),
    ).toBe(true);

    const confirmedScale: BaselineRow["baseline"] = {
      ...baseline,
      authorityBlocker: null,
      rawLabel: "scale",
      publishedLabel: "scale",
      blockedActionType: null,
      authorizedAction: "scale",
      reason: "[near scale] exact underlying evidence",
    };
    const epochResetPendingScale = {
      preAuthorityLabel: "scale",
      authorityBlocker: null,
      rawLabel: "scale",
      publishedLabel: "keep",
      blockedActionType: "scale",
      simulatedAuthorizedAction: null,
      hysteresisSuppressed: true,
      confidence: confirmedScale.confidence,
      reason: `[Pending hard action: scale] No hard action is published until this signal repeats on the next evaluation. Current evidence: ${confirmedScale.reason}`,
      badges: [...confirmedScale.badges, PENDING_TRANSITION_BADGE],
      priorHysteresisStatus: "epoch_mismatch",
    } as ChallengerRow;
    expect(
      scaleRefreshProjectionDrift({
        baseline: confirmedScale,
        challenger: epochResetPendingScale,
      }),
    ).toBe(false);
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: confirmedScale,
        baselineRoas: 3,
        baselineBreakEvenRoas: 1.5,
        challenger: {
          ...epochResetPendingScale,
          roas: 3,
          breakEvenRoas: 1.5,
        },
      }),
    ).toBe(false);
    expect(
      scaleRefreshProjectionDrift({
        baseline: confirmedScale,
        challenger: {
          ...epochResetPendingScale,
          confidence: confirmedScale.confidence - 1,
        },
      }),
    ).toBe(true);
    expect(
      scaleRefreshProjectionDrift({
        baseline: {
          ...epochResetPendingScale,
          authorizedAction: null,
        } as BaselineRow["baseline"],
        challenger: {
          ...epochResetPendingScale,
          badges: [],
          reason: "Scale pending provenance was stripped",
          persistedScaleRefreshProfileHash: "1".repeat(64),
          challengerScaleRefreshProfileHash: "2".repeat(64),
          persistedDataHealthHash: "3".repeat(64),
          challengerDataHealthHash: "4".repeat(64),
        },
      }),
    ).toBe(true);

    const authorityBlockedScale: BaselineRow["baseline"] = {
      ...confirmedScale,
      authorityBlocker: "campaign_context",
      blockedActionType: "scale",
      authorizedAction: null,
    };
    expect(
      scaleRefreshProjectionDrift({
        baseline: authorityBlockedScale,
        challenger: {
          ...epochResetPendingScale,
          authorityBlocker: authorityBlockedScale.authorityBlocker,
          reason: `[Pending hard action: scale] No hard action is published until this signal repeats on the next evaluation. Current evidence: ${authorityBlockedScale.reason}`,
          badges: [...authorityBlockedScale.badges, PENDING_TRANSITION_BADGE],
        },
      }),
    ).toBe(false);

    const nearScaleKeep: BaselineRow["baseline"] = {
      ...baseline,
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      rawLabel: "keep",
      publishedLabel: "keep",
      blockedActionType: null,
      authorizedAction: null,
      reason: "[near scale] exact keep tuple",
    };
    expect(
      scaleRefreshProjectionDrift({
        baseline: nearScaleKeep,
        challenger: {
          ...nearScaleKeep,
          simulatedAuthorizedAction: null,
          reason: "[near scale] drifted keep tuple",
        } as unknown as ChallengerRow,
      }),
    ).toBe(true);

    const unprovenCalibrationRestatedNearScale = {
      ...nearScaleKeep,
      simulatedAuthorizedAction: null,
      confidence: nearScaleKeep.confidence + 10,
      persistedScaleRefreshProfileHash: "1".repeat(64),
      challengerScaleRefreshProfileHash: "2".repeat(64),
      persistedDataHealthHash: "3".repeat(64),
      challengerDataHealthHash: "4".repeat(64),
    } as unknown as ChallengerRow;
    expect(
      scaleRefreshProjectionDrift({
        baseline: nearScaleKeep,
        challenger: unprovenCalibrationRestatedNearScale,
      }),
    ).toBe(true);
    expect(
      scaleRefreshCalibrationRestatement({
        baseline: nearScaleKeep,
        challenger: unprovenCalibrationRestatedNearScale,
      }),
    ).toBe(false);
    const nonHardLabelRestatement = {
      ...unprovenCalibrationRestatedNearScale,
      preAuthorityLabel: "test_more",
      rawLabel: "test_more",
      publishedLabel: "test_more",
      reason: "Current exact profile is still below commercial maturity.",
    } as unknown as ChallengerRow;
    expect(
      scaleRefreshProjectionDrift({
        baseline: nearScaleKeep,
        challenger: nonHardLabelRestatement,
      }),
    ).toBe(true);
    expect(
      scaleRefreshCalibrationRestatement({
        baseline: nearScaleKeep,
        challenger: nonHardLabelRestatement,
      }),
    ).toBe(false);

    const nativeProfileUnavailable = {
      ...unprovenCalibrationRestatedNearScale,
      preAuthorityLabel: "diagnose",
      authorityBlocker: "native_profile_unavailable",
      rawLabel: "diagnose",
      publishedLabel: "diagnose",
      confidence: 0,
      reason:
        "[Native calibration unavailable - hard actions blocked] native_ad_profile_unready:native_calibration_missing",
      badges: [
        {
          type: "native_calibration_unavailable",
          label:
            "Native calibration unavailable (native_ad_profile_unready:native_calibration_missing); scale, cut and refresh are blocked.",
          severity: "warning",
        },
      ],
    } as unknown as ChallengerRow;
    expect(
      scaleRefreshProjectionDrift({
        baseline: nearScaleKeep,
        challenger: nativeProfileUnavailable,
      }),
    ).toBe(true);
    expect(
      scaleRefreshProfileAvailabilityRestatement({
        baseline: nearScaleKeep,
        challenger: nativeProfileUnavailable,
      }),
    ).toBe(false);
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: {
          ...nativeProfileUnavailable,
          roas: 2,
          breakEvenRoas: 1.5,
        },
      }),
    ).toBe(true);
    expect(
      aboveBreakEvenProfileAvailabilityRestatement({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: {
          ...nativeProfileUnavailable,
          roas: 2,
          breakEvenRoas: 1.5,
        },
      }),
    ).toBe(false);
    expect(
      scaleRefreshProjectionDrift({
        baseline: nearScaleKeep,
        challenger: {
          ...nativeProfileUnavailable,
          authorityBlocker: null,
        },
      }),
    ).toBe(true);
    expect(
      scaleRefreshProjectionDrift({
        baseline: {
          ...nativeProfileUnavailable,
          authorizedAction: null,
        } as BaselineRow["baseline"],
        challenger: unprovenCalibrationRestatedNearScale,
      }),
    ).toBe(true);
    expect(
      scaleRefreshProfileAvailabilityRestatement({
        baseline: {
          ...nativeProfileUnavailable,
          authorizedAction: null,
        } as BaselineRow["baseline"],
        challenger: unprovenCalibrationRestatedNearScale,
      }),
    ).toBe(false);
    expect(
      scaleRefreshProjectionDrift({
        baseline: confirmedScale,
        challenger: {
          ...unprovenCalibrationRestatedNearScale,
          preAuthorityLabel: "keep",
          rawLabel: "keep",
          publishedLabel: "keep",
        },
      }),
    ).toBe(true);

    const ordinaryRefreshCopy: BaselineRow["baseline"] = {
      ...nearScaleKeep,
      reason: "Consider demoting placement or refresh creative concept.",
    };
    expect(
      scaleRefreshProjectionDrift({
        baseline: ordinaryRefreshCopy,
        challenger: {
          ...ordinaryRefreshCopy,
          simulatedAuthorizedAction: null,
          reason: "Working zone; revisit later.",
        } as unknown as ChallengerRow,
      }),
    ).toBe(false);

    const aboveBreakEvenChallenger = {
      ...nearScaleKeep,
      simulatedAuthorizedAction: null,
      roas: 2,
      breakEvenRoas: 1.5,
    } as unknown as ChallengerRow;
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: aboveBreakEvenChallenger,
      }),
    ).toBe(false);
    const unsafeBaselineCut: BaselineRow["baseline"] = {
      ...nearScaleKeep,
      preAuthorityLabel: "cut",
      rawLabel: "test_more",
      publishedLabel: "test_more",
      blockedActionType: "cut",
      badges: [
        {
          type: "cut_candidate",
          label: "Soft-cut candidate",
          severity: "warning",
        },
      ],
    };
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: unsafeBaselineCut,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: aboveBreakEvenChallenger,
      }),
    ).toBe(false);
    expect(
      aboveBreakEvenSafetyRepair({
        baseline: unsafeBaselineCut,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: aboveBreakEvenChallenger,
      }),
    ).toBe(true);
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: {
          ...aboveBreakEvenChallenger,
          confidence: 1,
          reason: "Unproven presentation drift",
        },
      }),
    ).toBe(true);
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: {
          ...aboveBreakEvenChallenger,
          badges: [
            {
              type: "fatigue_watch",
              label: "Changed badge",
              severity: "warning",
            },
          ],
        },
      }),
    ).toBe(true);
    const restatedAboveBreakEven = {
      ...aboveBreakEvenChallenger,
      badges: [
        {
          type: "fatigue_watch",
          label: "Changed badge",
          severity: "warning",
        },
      ],
      persistedScaleRefreshProfileHash: "5".repeat(64),
      challengerScaleRefreshProfileHash: "6".repeat(64),
      persistedDataHealthHash: "7".repeat(64),
      challengerDataHealthHash: "8".repeat(64),
    } as unknown as ChallengerRow;
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: restatedAboveBreakEven,
      }),
    ).toBe(true);
    expect(
      aboveBreakEvenCalibrationRestatement({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: restatedAboveBreakEven,
      }),
    ).toBe(false);
    const maturityRestatedAboveBreakEven = {
      ...aboveBreakEvenChallenger,
      preAuthorityLabel: "test_more",
      rawLabel: "test_more",
      publishedLabel: "test_more",
      reason: "Current exact profile is still below commercial maturity.",
      persistedScaleRefreshProfileHash: "9".repeat(64),
      challengerScaleRefreshProfileHash: "a".repeat(64),
      persistedDataHealthHash: "b".repeat(64),
      challengerDataHealthHash: "b".repeat(64),
    } as unknown as ChallengerRow;
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: maturityRestatedAboveBreakEven,
      }),
    ).toBe(true);
    expect(
      aboveBreakEvenCalibrationRestatement({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: maturityRestatedAboveBreakEven,
      }),
    ).toBe(false);
    expect(
      aboveBreakEvenProjectionDrift({
        baseline: nearScaleKeep,
        baselineRoas: 2,
        baselineBreakEvenRoas: 1.5,
        challenger: {
          ...maturityRestatedAboveBreakEven,
          authorityBlocker: "profile_hard_action_ineligible",
        },
      }),
    ).toBe(true);
  });

  it("binds canonical context scope to the exact persisted profile scope", () => {
    const accountProfile = {
      scope: {
        type: "account",
        id: "act_fixture",
        fallbackReason: null,
      },
    } as unknown as AccountDecisionProfile;
    expect(
      canonicalContextScopeMatchesAccountProfile({
        contextScope: accountProfile.scope,
        accountProfile,
        expectedScopeId: "act_fixture",
      }),
    ).toBe(true);
    expect(
      canonicalContextScopeMatchesAccountProfile({
        contextScope: { type: "account", id: "act_fixture" },
        accountProfile,
        expectedScopeId: "act_fixture",
      }),
    ).toBe(false);
    expect(
      canonicalContextScopeMatchesAccountProfile({
        contextScope: accountProfile.scope,
        accountProfile,
        expectedScopeId: "act_other",
      }),
    ).toBe(false);
  });

  it("binds the full persisted snapshot projection to its canonical evaluation", () => {
    const projection: NativeSnapshotProjection = {
      publishedLabel: "keep",
      rawLabel: "keep",
      preAuthorityLabel: "keep",
      authorityBlocker: null,
      blockedActionType: null,
      authorizedAction: null,
      confidence: 72,
      truthSource: "engine_v3",
      effectiveTargetRoas: 2,
      ratioToTarget: 1.1,
      badges: [],
      reason: "Canonical keep",
      spend: 100,
      purchases: 2,
      roas: 2.2,
      recent7dRoas: 2.1,
      labelTransform: null,
      creativeEvidenceLifecycleRowId: null,
      computedAt: "2026-07-16T03:10:00.000Z",
    };
    expect(
      nativeSnapshotProjectionProof({
        actual: projection,
        expected: projection,
        decisionMetricsMatchCreativeInput: true,
        authorityProjectionValid: true,
      }),
    ).toMatchObject({ valid: true });
    expect(
      nativeSnapshotProjectionProof({
        actual: { ...projection, reason: "Corrupt snapshot reason" },
        expected: projection,
        decisionMetricsMatchCreativeInput: true,
        authorityProjectionValid: true,
      }),
    ).toMatchObject({ valid: false });
    expect(
      nativeSnapshotProjectionProof({
        actual: projection,
        expected: projection,
        decisionMetricsMatchCreativeInput: false,
        authorityProjectionValid: true,
      }),
    ).toMatchObject({ valid: false });
    expect(
      nativeSnapshotProjectionProof({
        actual: projection,
        expected: projection,
        decisionMetricsMatchCreativeInput: true,
        authorityProjectionValid: false,
      }),
    ).toMatchObject({ valid: false });
  });

  it("fails the release gate for every execution, safety, parity, lineage or cutoff defect", () => {
    const passing: ReplayReleaseGateChecks = {
      executionFailures: 0,
      schedulerPopulationContradictions: 0,
      authorityProofOrLineageContradictions: 0,
      canonicalEnvelopeContradictions: 0,
      currentDayRestatementContradictions: 0,
      unresolvedSourceDimensionContradictions: 0,
      profileCalibrationParityContradictions: 0,
      requestedScopeCoverageContradictions: 0,
      aboveBreakEvenCutProjectionViolations: 0,
      aboveBreakEvenProjectionDriftRows: 0,
      scaleRefreshIdentityDriftRows: 0,
      calibrationCutoffFallbackSlices: 0,
      waveOrHydrationCoverageContradictions: 0,
      aovPositiveControlFailures: 0,
      d036PerRowTransitionViolations: 0,
      d063LegacySafeZoneProjectionDriftRows: 0,
      d063ExpandedStripSemanticViolationRows: 0,
      d063ExpandedHeldAuthorizedCutRows: 0,
      d063ExpandedHeldPendingRows: 0,
      d063AccountAovP25NullReachabilityFailures: 0,
      d063AccountAovP25BackedOverlayRows: 0,
      d063ExactMediaBuyerContradictions: 0,
    };
    expect(evaluateReplayReleaseGate(passing)).toMatchObject({
      passed: true,
      exitCode: 0,
      failures: [],
    });
    for (const key of Object.keys(passing) as Array<
      keyof ReplayReleaseGateChecks
    >) {
      const failed = evaluateReplayReleaseGate({ ...passing, [key]: 1 });
      expect(failed.passed, key).toBe(false);
      expect(failed.exitCode, key).toBe(2);
      expect(failed.failures, key).toHaveLength(1);
    }
  });
});
