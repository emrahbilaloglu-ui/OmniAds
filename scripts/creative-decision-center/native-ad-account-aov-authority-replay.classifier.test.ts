import { describe, expect, it } from "vitest";
import {
  aboveBreakEvenCalibrationRestatement,
  aboveBreakEvenProjectionDrift,
  assertReplayCalibrationContextProofSet,
  buildReplayCalibrationContextProof,
  isOrdinaryNonHardProjection,
  REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION,
  REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION,
  replayOrdinaryProductionProjection,
  scaleRefreshCalibrationRestatement,
  scaleRefreshProfileAvailabilityRestatement,
  scaleRefreshProfileHash,
  scaleRefreshProjectionDrift,
  type ReplayCalibrationContextProofSet,
} from "@/scripts/creative-decision-center/native-ad-account-aov-authority-replay";
import { canonicalSha256 } from "@/lib/creative-decision-engine/canonical-evaluation";
import type {
  CampaignContextProvenance,
  NativeAdSoftOnlyDecisionProfile,
} from "@/lib/creative-decision-engine/canonical-evaluation";
import type {
  AccountDecisionProfile,
  AdDecisionInput,
  DataHealth,
} from "@/lib/creative-decision-engine/types";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeDataHealth,
} from "@/lib/creative-decision-engine/__tests__/helpers";

type ScaleInput = Parameters<typeof scaleRefreshProjectionDrift>[0];
type Baseline = ScaleInput["baseline"];
type Challenger = NonNullable<ScaleInput["challenger"]>;

const cohortKey = "classifier-cohort";
const accountKey = "classifier-account";
const inputManifestHash = "d".repeat(64);
const exactInput = {
  ...makeCreativeInput({
    businessId: "classifier-business",
    roas: 6.29,
    targetRoas: 3,
    breakevenRoas: 2,
    spend: 500,
    purchases: 12,
    ageDays: 13,
    ctr: 0.75,
    recent7dRoas: 4,
    dataFreshnessHours: 1,
  }),
  decisionEntityType: "ad",
  decisionEntityId: "classifier-ad",
  adId: "classifier-ad",
  providerAccountId: "act_classifier",
  providerAccountRefId: "00000000-0000-4000-8000-000000000001",
  accountTimezone: "UTC",
  accountCurrency: "USD",
  adsetId: "classifier-adset",
  campaignKind: "main",
  creativeId: "classifier-creative",
  optimizationGoal: "OFFSITE_CONVERSIONS",
  customEventType: "PURCHASE",
  metricEvidence: {
    sourceRowCount: 28,
    performanceMetricsObserved: true,
    eventMetricsObserved: true,
  },
  statusEvidence: {},
  creativeEvidence: {},
} as unknown as AdDecisionInput;
const dataHealth = makeDataHealth() as DataHealth;
const campaignContext: CampaignContextProvenance = {
  mode: "automatic",
  source: "user_override",
  campaignId: "campaign-1",
  kind: "main",
  testDimension: null,
  contextTrust: "override",
  sourceRecordType: "meta_campaign_label",
  sourceRecordId: "classifier-campaign-context",
  sourceAsOfDate: "2026-07-18",
  sourceUpdatedAt: "2026-07-18T00:00:00.000Z",
  sourceHash: "c".repeat(64),
};

function proofProfile(input: {
  matureCreativeCount: number;
  lowCtrP10: number;
  commercialMaturitySpend?: number;
}) {
  const accountBaselines = makeAccountCalibration({
    businessId: "classifier-business",
    matureCreativeCount: input.matureCreativeCount,
    lowCtrP10: input.lowCtrP10,
    winnerPurchaseP50: 10,
  });
  return makeAccountDecisionProfile({
    businessId: "classifier-business",
    asOfDate: "2026-07-18",
    accountBaselines,
    thresholds: {
      commercialMaturitySpend: input.commercialMaturitySpend ?? 300,
      recentSampleMinSpend: 30,
      scaleMinPurchases: 10,
    },
    quality: {
      commercialTruthReady: true,
      calibrationReady: false,
      metaAovQuality: accountBaselines.metaAovQuality,
      thresholdQuality: "degraded",
    },
    scope: { type: "account", id: "act_classifier" },
  }) as AccountDecisionProfile;
}

const persistedProfile = proofProfile({
  matureCreativeCount: 4,
  lowCtrP10: 1,
});
const challengerProfile = proofProfile({
  matureCreativeCount: 11,
  lowCtrP10: 0.89,
});

function challengerFromProjection(input: {
  projection: NonNullable<
    ReturnType<typeof replayOrdinaryProductionProjection>
  >;
  persisted: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  next: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  exact: AdDecisionInput;
  overrides?: Partial<Challenger>;
}): Challenger {
  const { projection } = input;
  const targetRoas =
    typeof input.exact.targetRoas === "number"
      ? input.exact.targetRoas
      : null;
  return {
    preAuthorityLabel: projection.preAuthorityLabel,
    authorityBlocker: projection.authorityBlocker,
    rawLabel: projection.rawLabel,
    publishedLabel: projection.publishedLabel,
    blockedActionType: projection.blockedActionType,
    simulatedAuthorizedAction: projection.authorizedAction,
    hysteresisSuppressed: projection.hysteresisSuppressed,
    confidence: projection.confidence,
    reason: projection.reason,
    badges: projection.badges,
    priorHysteresisStatus: "epoch_mismatch",
    cohortKey,
    accountKey,
    inputManifestHash,
    persistedScaleRefreshProfileHash:
      scaleRefreshProfileHash(input.persisted),
    challengerScaleRefreshProfileHash:
      scaleRefreshProfileHash(input.next),
    persistedDataHealthHash: canonicalSha256(dataHealth),
    challengerDataHealthHash: canonicalSha256(dataHealth),
    calibrationContextProof: null,
    effectiveTargetRoas: targetRoas,
    ratioToTarget:
      input.exact.roas === null ||
      targetRoas === null ||
      targetRoas <= 0
        ? null
        : input.exact.roas / targetRoas,
    roas: input.exact.roas,
    breakEvenRoas: input.exact.breakevenRoas,
    ...input.overrides,
  } as Challenger;
}

function provenInput(input: {
  baselineOverrides?: Partial<Baseline>;
  challengerOverrides?: Partial<Challenger>;
  persisted?: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  challenger?: AccountDecisionProfile | NativeAdSoftOnlyDecisionProfile;
  exact?: AdDecisionInput;
  persistedExact?: AdDecisionInput;
  challengerExact?: AdDecisionInput;
  persistedCampaignContext?: CampaignContextProvenance;
  challengerCampaignContext?: CampaignContextProvenance;
} = {}) {
  const persisted = input.persisted ?? persistedProfile;
  const next = input.challenger ?? challengerProfile;
  const persistedExact = input.persistedExact ?? input.exact ?? exactInput;
  const challengerExact = input.challengerExact ?? input.exact ?? exactInput;
  const persistedContext =
    input.persistedCampaignContext ?? campaignContext;
  const challengerContext =
    input.challengerCampaignContext ?? campaignContext;
  const persistedProjection = replayOrdinaryProductionProjection({
    exactInput: persistedExact,
    profile: persisted,
    dataHealth,
    campaignContext: persistedContext,
  });
  const challengerProjection = replayOrdinaryProductionProjection({
    exactInput: challengerExact,
    profile: next,
    dataHealth,
    campaignContext: challengerContext,
  });
  if (persistedProjection === null || challengerProjection === null) {
    throw new Error("test fixture requires ready production projections");
  }
  const baselineRow = {
    ...persistedProjection,
    ...input.baselineOverrides,
  } as Baseline;
  const challengerRow = challengerFromProjection({
    projection: challengerProjection,
    persisted,
    next,
    exact: challengerExact,
    overrides: input.challengerOverrides,
  });
  challengerRow.calibrationContextProof =
    buildReplayCalibrationContextProof({
      cohortKey,
      accountKey,
      inputManifestHash,
      persistedInput: persistedExact,
      challengerInput: challengerExact,
      persistedProjection: baselineRow,
      challengerProjection: {
        preAuthorityLabel: challengerRow.preAuthorityLabel!,
        authorityBlocker: challengerRow.authorityBlocker,
        rawLabel: challengerRow.rawLabel!,
        publishedLabel: challengerRow.publishedLabel!,
        blockedActionType: challengerRow.blockedActionType,
        authorizedAction: challengerRow.simulatedAuthorizedAction,
        hysteresisSuppressed: challengerRow.hysteresisSuppressed!,
        confidence: challengerRow.confidence!,
        reason: challengerRow.reason!,
        badges: challengerRow.badges!,
      },
      persistedProfile: persisted,
      challengerProfile: next,
      persistedDataHealth: dataHealth,
      challengerDataHealth: dataHealth,
      persistedCampaignContext: persistedContext,
      challengerCampaignContext: challengerContext,
    });
  return { baseline: baselineRow, challenger: challengerRow };
}

const unavailableProfile: NativeAdSoftOnlyDecisionProfile = {
  profileType: "native_ad_soft_only",
  businessId: "classifier-business",
  asOfDate: "2026-07-18",
  channel: "meta",
  objectiveFamily: "sales",
  scope: { type: "account", id: "act_classifier" },
  blocker: "native_ad_profile_unready:native_calibration_missing",
  calibrationSource: null,
  selectedCell: null,
  hardActionEligibility: {
    scale: false,
    cut: false,
    refresh: false,
    reason:
      "hard_actions_blocked:native_ad_profile_unready:native_calibration_missing",
    reasons: {
      scale:
        "hard_actions_blocked:native_ad_profile_unready:native_calibration_missing",
      cut:
        "hard_actions_blocked:native_ad_profile_unready:native_calibration_missing",
      refresh:
        "hard_actions_blocked:native_ad_profile_unready:native_calibration_missing",
    },
  },
};

function nonHardAvailabilityProfile(
  overrides: Partial<AccountDecisionProfile> = {},
) {
  const accountBaselines = makeAccountCalibration({
    businessId: "classifier-business",
    matureCreativeCount: 20,
    roasP60: 2.5,
    roasP75: 2.5,
  });
  return {
    ...makeAccountDecisionProfile({
      businessId: "classifier-business",
      asOfDate: "2026-07-18",
      accountBaselines,
      scope: { type: "account", id: "act_classifier" },
      spendUnit: null,
      spendUnitSource: "insufficient",
      spendUnitConfidence: "insufficient",
      spendUnitEvidence: {
        targetCpa: null,
        operatorAovAssumption: null,
        metaAttributedAovMean90d: null,
        metaAttributedAovPurchaseCount90d: 0,
        metaAttributedRevenue90d: 0,
        targetRoas: null,
        breakEvenRoas: null,
        accountCpaP50: null,
        accountCpaSampleCount: 0,
        warnings: ["spend_unit_unavailable"],
      },
      hardActionEligibility: {
        scale: false,
        cut: false,
        refresh: false,
        reason: "threshold_authority_insufficient",
        reasons: {
          scale: "threshold_authority_insufficient",
          cut: "threshold_authority_insufficient",
          refresh: "threshold_authority_insufficient",
        },
      },
      quality: {
        commercialTruthReady: false,
        calibrationReady: false,
        metaAovQuality: "unavailable",
        thresholdQuality: "insufficient",
      },
    }),
    hardActionEligibilityByKind: null,
    commercialStopLossSpendUnit: null,
    commercialStopLossThresholds: null,
    commercialStopLossCanonicalHardActionEligibility: null,
    expandedEconomicCutAuthority: {
      eligible: false,
      authorityBasis: null,
      reason: "economic_spend_unit_authority_missing",
    },
    ...overrides,
  } as unknown as AccountDecisionProfile;
}

const availabilityExactInput = {
  ...exactInput,
  targetRoas: null,
  breakevenRoas: null,
  roas: 3,
  recent7dRoas: 3,
  spend: 722,
  purchases: 43,
} as AdDecisionInput;

function proofSetFrom(
  input: ReturnType<typeof provenInput>,
): ReplayCalibrationContextProofSet {
  const proof = input.challenger.calibrationContextProof;
  if (proof === null) throw new Error("test proof missing");
  const contexts = [
    {
      contextMaterialHash: proof.contextMaterialHash,
      persistedProfile: proof.persistedProfile,
      challengerProfile: proof.challengerProfile,
      persistedDataHealth: proof.persistedDataHealth,
      challengerDataHealth: proof.challengerDataHealth,
      persistedCampaignContext: proof.persistedCampaignContext,
      challengerCampaignContext: proof.challengerCampaignContext,
      profileDiffPaths: proof.profileDiffPaths,
      dataHealthDiffPaths: proof.dataHealthDiffPaths,
      inputDiffPaths: proof.inputDiffPaths,
      persistedScaleRefreshProfileHash:
        input.challenger.persistedScaleRefreshProfileHash,
      challengerScaleRefreshProfileHash:
        input.challenger.challengerScaleRefreshProfileHash!,
      persistedDataHealthHash:
        input.challenger.persistedDataHealthHash,
      challengerDataHealthHash:
        input.challenger.challengerDataHealthHash!,
    },
  ];
  const associations = [
    {
      cohortKey: proof.cohortKey,
      cohortKeyHash: canonicalSha256(proof.cohortKey),
      accountKey: proof.accountKey,
      accountKeyHash: canonicalSha256(proof.accountKey),
      inputManifestHash: proof.inputManifestHash,
      persistedInput: proof.persistedInput,
      challengerInput: proof.challengerInput,
      persistedProjection: proof.persistedProjection,
      challengerProjection: proof.challengerProjection,
      contextMaterialHash: proof.contextMaterialHash,
      proofHash: proof.proofHash,
    },
  ];
  const withoutHash = {
    contractVersion:
      REPLAY_CALIBRATION_CONTEXT_PROOF_SET_CONTRACT_VERSION,
    proofContractVersion:
      REPLAY_CALIBRATION_CONTEXT_PROOF_CONTRACT_VERSION,
    contextCount: contexts.length,
    associationCount: associations.length,
    contexts,
    associations,
  };
  return {
    ...withoutHash,
    proofSetHash: canonicalSha256(withoutHash),
  };
}

describe("native-ad replay semantic drift classifier", () => {
  it("permits only bounded numeric calibration evidence restatement for an unchanged action tuple", () => {
    const input = provenInput();

    expect(scaleRefreshProjectionDrift(input)).toBe(false);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(true);
  });

  it("does not hide a Keep to Test More buyer decision regression behind changed hashes", () => {
    const input = provenInput({
      challengerOverrides: {
        preAuthorityLabel: "test_more",
        rawLabel: "test_more",
        publishedLabel: "test_more",
        confidence: 40,
        reason: "Arbitrary replacement decision.",
        badges: [],
      },
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(false);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(false);
  });

  it("does not hide arbitrary reason or badge changes when the labels remain Keep", () => {
    const input = provenInput({
      challengerOverrides: {
        reason: "[near scale] Arbitrary replacement decision.",
        badges: [
          {
            type: "tracking_anomaly",
            label: "Unrelated warning",
            severity: "warning",
          },
        ],
      },
      persisted: proofProfile({
        matureCreativeCount: 4,
        lowCtrP10: 0.5,
      }),
      challenger: proofProfile({
        matureCreativeCount: 11,
        lowCtrP10: 0.5,
      }),
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(false);
  });

  it("recomputes campaign-context wrappers instead of accepting symmetric fabricated badges", () => {
    const fabricatedBadge = {
      type: "campaign_context_unresolved" as const,
      label: "Campaign context unresolved",
      severity: "warning" as const,
    };
    const seed = provenInput();
    const input = provenInput({
      baselineOverrides: {
        badges: [...seed.baseline.badges, fabricatedBadge],
      },
      challengerOverrides: {
        badges: [...seed.challenger.badges!, fabricatedBadge],
      },
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(false);
  });

  it("reconstructs automatic unknown context as the production unresolved entry", () => {
    const automaticUnknown: CampaignContextProvenance = {
      mode: "automatic",
      source: "unknown",
      campaignId: "campaign-1",
      kind: null,
      testDimension: null,
      contextTrust: null,
      sourceRecordType: null,
      sourceRecordId: null,
      sourceAsOfDate: null,
      sourceUpdatedAt: null,
      sourceHash: null,
    };
    const input = provenInput({
      persistedCampaignContext: automaticUnknown,
      challengerCampaignContext: automaticUnknown,
      exact: {
        ...exactInput,
        campaignKind: null,
      },
    });

    expect(input.baseline.badges).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          type: "campaign_context_unresolved",
        }),
      ]),
    );
    expect(scaleRefreshProjectionDrift(input)).toBe(false);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(true);
  });

  it("rejects an otherwise production-replayable campaign-context provenance drift", () => {
    const input = provenInput({
      challengerCampaignContext: {
        ...campaignContext,
        sourceRecordId: "different-context-record",
        sourceHash: "e".repeat(64),
      },
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(false);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(false);
  });

  it("fails closed for input drift and malformed proof material", () => {
    const inputDrift = provenInput({
      challengerExact: {
        ...exactInput,
        campaignId: "different-campaign",
      },
    });
    expect(scaleRefreshProjectionDrift(inputDrift)).toBe(true);

    const malformed = provenInput();
    malformed.challenger.calibrationContextProof = {
      ...malformed.challenger.calibrationContextProof!,
      challengerInput: undefined,
    } as unknown as NonNullable<
      Challenger["calibrationContextProof"]
    >;
    expect(() => scaleRefreshProjectionDrift(malformed)).not.toThrow();
    expect(scaleRefreshProjectionDrift(malformed)).toBe(true);
  });

  it("serializes a round-trip-verifiable proof set and rejects material tampering", () => {
    const set = proofSetFrom(provenInput());
    const roundTripped = JSON.parse(
      JSON.stringify(set),
    ) as ReplayCalibrationContextProofSet;

    expect(() =>
      assertReplayCalibrationContextProofSet(roundTripped),
    ).not.toThrow();

    const tamperedContext = structuredClone(roundTripped);
    const firstContext = tamperedContext.contexts[0]!;
    if ("thresholds" in firstContext.challengerProfile) {
      firstContext.challengerProfile.thresholds = {
        ...firstContext.challengerProfile.thresholds,
        commercialMaturitySpend:
          (firstContext.challengerProfile.thresholds
            .commercialMaturitySpend ?? 0) + 1,
      };
    }
    expect(() =>
      assertReplayCalibrationContextProofSet(tamperedContext),
    ).toThrow(/context_material/);

    const tamperedProjection = structuredClone(roundTripped);
    tamperedProjection.associations[0]!.challengerProjection.reason =
      "tampered";
    expect(() =>
      assertReplayCalibrationContextProofSet(tamperedProjection),
    ).toThrow(/association_proof|proof_set_hash/);
  });

  it("accepts only the explicit forward maturity-to-Keep non-hard transition", () => {
    const input = provenInput({
      persisted: proofProfile({
        matureCreativeCount: 4,
        lowCtrP10: 0.5,
        commercialMaturitySpend: 300,
      }),
      challenger: proofProfile({
        matureCreativeCount: 11,
        lowCtrP10: 0.5,
        commercialMaturitySpend: 100,
      }),
      exact: {
        ...exactInput,
        spend: 180,
        purchases: 3,
      },
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(false);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(true);
  });

  it("accepts an exact soft-only unavailable to non-hard profile availability transition", () => {
    const input = provenInput({
      persisted: unavailableProfile,
      challenger: nonHardAvailabilityProfile(),
      exact: availabilityExactInput,
    });

    expect(input.baseline).toMatchObject({
      preAuthorityLabel: "diagnose",
      authorityBlocker: "native_profile_unavailable",
      rawLabel: "diagnose",
      publishedLabel: "diagnose",
      confidence: 0,
    });
    expect(input.challenger.reason).toMatch(/^\[near scale\]/);
    expect(scaleRefreshProjectionDrift(input)).toBe(false);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(false);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(true);
  });

  it("rejects a soft-only availability proof whose profile identity does not match the exact input", () => {
    const wrongBusiness = provenInput({
      persisted: {
        ...unavailableProfile,
        businessId: "different-business",
      },
      challenger: nonHardAvailabilityProfile({
        businessId: "different-business",
      }),
      exact: availabilityExactInput,
    });
    const wrongAccount = provenInput({
      persisted: {
        ...unavailableProfile,
        scope: { type: "account", id: "act_different" },
      },
      challenger: nonHardAvailabilityProfile({
        scope: { type: "account", id: "act_different" },
      }),
      exact: availabilityExactInput,
    });

    expect(scaleRefreshProjectionDrift(wrongBusiness)).toBe(true);
    expect(
      scaleRefreshProfileAvailabilityRestatement(wrongBusiness),
    ).toBe(false);
    expect(scaleRefreshProjectionDrift(wrongAccount)).toBe(true);
    expect(
      scaleRefreshProfileAvailabilityRestatement(wrongAccount),
    ).toBe(false);
  });

  it("rejects a soft-only availability transition when any hard-action eligibility is opened", () => {
    const profile = nonHardAvailabilityProfile();
    const input = provenInput({
      persisted: unavailableProfile,
      challenger: nonHardAvailabilityProfile({
        hardActionEligibility: {
          ...profile.hardActionEligibility,
          scale: true,
          reason: null,
          reasons: {
            ...profile.hardActionEligibility.reasons,
            scale: null,
          },
        },
      }),
      exact: availabilityExactInput,
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(false);
  });

  it("rejects an internally contradictory disabled expanded-economic authority tuple", () => {
    const input = provenInput({
      persisted: unavailableProfile,
      challenger: nonHardAvailabilityProfile({
        expandedEconomicCutAuthority: {
          eligible: false,
          authorityBasis: "commercial_stop_loss",
          reason: null,
        },
      }),
      exact: availabilityExactInput,
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(false);
  });

  it("rejects a ready profile that retains a soft-only shape field", () => {
    const hybridProfile = Object.assign(
      nonHardAvailabilityProfile(),
      { calibrationSource: null as null },
    );
    const input = provenInput({
      persisted: unavailableProfile,
      challenger: hybridProfile,
      exact: availabilityExactInput,
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(false);
  });

  it("does not treat a cut-candidate advisory as an ordinary non-hard availability transition", () => {
    const ordinary = replayOrdinaryProductionProjection({
      exactInput: availabilityExactInput,
      profile: nonHardAvailabilityProfile(),
      dataHealth,
      campaignContext,
    });
    if (ordinary === null) throw new Error("ordinary fixture is missing");
    const cutCandidate = {
      ...ordinary,
      badges: [
        ...(ordinary.badges ?? []),
        {
          type: "cut_candidate" as const,
          label: "Cut candidate",
          severity: "warning" as const,
        },
      ],
    };

    expect(isOrdinaryNonHardProjection(ordinary)).toBe(true);
    expect(isOrdinaryNonHardProjection(cutCandidate)).toBe(false);
  });

  it("treats the reverse non-hard profile to soft-only unavailable transition as drift", () => {
    const input = provenInput({
      persisted: nonHardAvailabilityProfile(),
      challenger: unavailableProfile,
      exact: availabilityExactInput,
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
    expect(scaleRefreshCalibrationRestatement(input)).toBe(false);
    expect(scaleRefreshProfileAvailabilityRestatement(input)).toBe(false);
  });

  it("treats working-zone Keep and Test More profile loss as drift even without Scale or Refresh artifacts", () => {
    const workingKeep = provenInput({
      persisted: nonHardAvailabilityProfile(),
      challenger: unavailableProfile,
      exact: {
        ...availabilityExactInput,
        roas: 2.5,
        recent7dRoas: 2.5,
      },
    });
    const collectingProfile = nonHardAvailabilityProfile();
    collectingProfile.thresholds = {
      ...collectingProfile.thresholds,
      commercialMaturitySpend: 300,
    };
    const collecting = provenInput({
      persisted: collectingProfile,
      challenger: unavailableProfile,
      exact: {
        ...availabilityExactInput,
        spend: 180,
        purchases: 3,
        purchaseValue: 450,
        roas: 2.5,
        cpa: 60,
        recent7dSpend: 30,
        recent7dPurchases: 1,
        recent7dRoas: 2.5,
        ageDays: 13,
      },
    });

    expect(workingKeep.baseline.publishedLabel).toBe("keep");
    expect(workingKeep.baseline.reason).not.toContain("[near scale]");
    expect(scaleRefreshProjectionDrift(workingKeep)).toBe(true);
    expect(collecting.baseline.publishedLabel).toBe("test_more");
    expect(scaleRefreshProjectionDrift(collecting)).toBe(true);
  });

  it("treats loss of a previously available non-hard profile as drift", () => {
    const input = provenInput({
      challengerOverrides: {
        preAuthorityLabel: "diagnose",
        rawLabel: "diagnose",
        publishedLabel: "diagnose",
        authorityBlocker: "native_profile_unavailable",
        confidence: 0,
        reason:
          "[Native calibration unavailable - hard actions blocked] No exact profile.",
        badges: [
          {
            type: "native_calibration_unavailable",
            label: "Native calibration unavailable",
            severity: "warning",
          },
        ],
      },
    });

    expect(scaleRefreshProjectionDrift(input)).toBe(true);
  });

  it("applies the same strict classifier to above-break-even safety proof", () => {
    const proven = provenInput();
    const safe = {
      baseline: proven.baseline,
      baselineRoas: 6.29,
      baselineBreakEvenRoas: 2,
      challenger: proven.challenger,
    };
    const unsafeProven = provenInput({
      challengerOverrides: {
        reason: "[near scale] Arbitrary replacement decision.",
      },
    });
    const unsafe = {
      ...safe,
      challenger: unsafeProven.challenger,
    };

    expect(aboveBreakEvenProjectionDrift(safe)).toBe(false);
    expect(aboveBreakEvenCalibrationRestatement(safe)).toBe(true);
    expect(aboveBreakEvenProjectionDrift(unsafe)).toBe(true);
  });
});
