import type {
  BusinessTargetPack,
  CampaignCalibrationLookup,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "./data-source";
import { MIN_CAMPAIGN_CALIBRATION_SAMPLE } from "./config";
import { ENGINE_PRESET_MULTIPLIERS } from "./engine-presets";
import {
  classifyMetaAovQuality,
  resolveSpendUnit,
} from "./spend-unit-resolver";
import {
  resolveEngineV3Flags,
  type EngineV3Flags,
} from "./feature-flags";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  CalibrationCampaignKind,
  DecisionProfileScope,
  EngineMultiplierSet,
  EngineRiskPreset,
  EngineThresholdSet,
  HardActionEligibility,
  MetaAovQuality,
  SpendUnitProfile,
  ThresholdQuality,
} from "./types";

const CALIBRATION_CAMPAIGN_KINDS: CalibrationCampaignKind[] = [
  "all",
  "main",
  "test",
  "mixed",
];

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function overrideMultiplier(
  fallback: number,
  override: number | null | undefined,
): number {
  return positiveFinite(override) ? override : fallback;
}

function resolvePreset(input: {
  targetPack: BusinessTargetPack | null;
  profileConfig: DecisionCalibrationProfileConfig | null;
  presetOverride?: EngineRiskPreset | null;
}): {
  preset: EngineRiskPreset;
  presetSource: AccountDecisionProfile["presetSource"];
} {
  if (input.presetOverride) {
    return {
      preset: input.presetOverride,
      presetSource: "business_engine_v3_flags_override",
    };
  }
  if (input.profileConfig?.enginePresetLabel) {
    return {
      preset: input.profileConfig.enginePresetLabel,
      presetSource: "business_decision_calibration_profile",
    };
  }
  if (input.targetPack?.defaultRiskPosture) {
    return {
      preset: input.targetPack.defaultRiskPosture,
      presetSource: "target_pack_risk_posture",
    };
  }
  return { preset: "balanced", presetSource: "default" };
}

function mergeMultipliers(input: {
  preset: EngineRiskPreset;
  profileConfig: DecisionCalibrationProfileConfig | null;
}): EngineMultiplierSet {
  const defaults = ENGINE_PRESET_MULTIPLIERS[input.preset];
  const overrides = input.profileConfig;

  return {
    zeroConvBurner: overrideMultiplier(
      defaults.zeroConvBurner,
      overrides?.zeroConvBurnerMultiplier,
    ),
    cutCandidate: overrideMultiplier(
      defaults.cutCandidate,
      overrides?.cutCandidateMultiplier,
    ),
    sustainedLoser: overrideMultiplier(
      defaults.sustainedLoser,
      overrides?.sustainedLoserMultiplier,
    ),
    lossBudget: defaults.lossBudget,
    hardCut: overrideMultiplier(defaults.hardCut, overrides?.hardCutMultiplier),
    scalePurchase: overrideMultiplier(
      defaults.scalePurchase,
      overrides?.scalePurchaseMultiplier,
    ),
    winnerMemory: overrideMultiplier(
      defaults.winnerMemory,
      overrides?.winnerMemoryMultiplier,
    ),
    recentSample: overrideMultiplier(
      defaults.recentSample,
      overrides?.recentSampleMultiplier,
    ),
    weakFunnelRate: overrideMultiplier(
      defaults.weakFunnelRate,
      overrides?.weakFunnelRateMultiplier,
    ),
  };
}

function spendThreshold(
  spendUnit: number | null,
  multiplier: number,
): number | null {
  return positiveFinite(spendUnit) ? spendUnit * multiplier : null;
}

function purchaseThreshold(
  baseline: number | null,
  multiplier: number,
): number {
  const raw = positiveFinite(baseline) ? baseline : 1;
  return Math.max(1, Math.ceil(raw * multiplier));
}

function emptyByKind<T>(): Record<CalibrationCampaignKind, T | null> {
  return {
    all: null,
    main: null,
    test: null,
    mixed: null,
  };
}

function buildEngineThresholds(input: {
  spendUnit: number | null;
  multipliers: EngineMultiplierSet;
  accountBaselines: AccountCalibration;
}): EngineThresholdSet {
  return {
    zeroConvBurnerSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.zeroConvBurner,
    ),
    cutCandidateSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.cutCandidate,
    ),
    sustainedLoserSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.sustainedLoser,
    ),
    commercialMaturitySpend: spendThreshold(
      input.spendUnit,
      input.multipliers.lossBudget,
    ),
    hardCutSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.hardCut,
    ),
    recentSampleMinSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.recentSample,
    ),
    winnerMemoryMinSpend: spendThreshold(
      input.spendUnit,
      input.multipliers.winnerMemory,
    ),
    scaleMinPurchases: purchaseThreshold(
      input.accountBaselines.winnerPurchaseP50,
      input.multipliers.scalePurchase,
    ),
    winnerMemoryMinPurchases: purchaseThreshold(
      input.accountBaselines.winnerPurchaseP50,
      input.multipliers.winnerMemory,
    ),
    bottomQuartileRatio: input.accountBaselines.roasRatioP25,
    severeLoserRatio: input.accountBaselines.roasRatioP10,
  };
}

function resolveThresholdQuality(input: {
  spendUnit: number | null;
  confidence: AccountDecisionProfile["spendUnitConfidence"];
}): ThresholdQuality {
  if (!positiveFinite(input.spendUnit)) return "insufficient";
  return input.confidence === "high" || input.confidence === "medium"
    ? "ready"
    : "degraded";
}

function hardActionReason(input: {
  source: AccountDecisionProfile["spendUnitSource"];
  confidence: AccountDecisionProfile["spendUnitConfidence"];
  metaAovQuality: MetaAovQuality;
}): string {
  return `threshold baseline ${input.source} has ${input.confidence} confidence (meta AOV ${input.metaAovQuality})`;
}

function resolveSpendUnitProfile(input: {
  targetPack: BusinessTargetPack | null;
  accountBaselines: AccountCalibration;
  attributionAovAdjustmentMultiplier: number;
}): SpendUnitProfile {
  const resolution = resolveSpendUnit({
    targetCpa: input.targetPack?.targetCpa ?? null,
    operatorAovAssumption: input.targetPack?.operatorAovAssumption ?? null,
    metaAttributedAovMean90d: input.accountBaselines.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d:
      input.accountBaselines.metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d: input.accountBaselines.metaAttributedRevenue90d,
    targetRoas: input.targetPack?.targetRoas ?? null,
    breakEvenRoas: input.targetPack?.breakEvenRoas ?? null,
    accountCpaP50: input.accountBaselines.accountCpaP50,
    accountCpaSampleCount: input.accountBaselines.accountCpaSampleCount,
    attributionAovAdjustmentMultiplier:
      input.attributionAovAdjustmentMultiplier,
  });

  return {
    spendUnit: resolution.spendUnit,
    spendUnitSource: resolution.source,
    spendUnitConfidence: resolution.confidence,
    spendUnitEvidence: resolution.evidence,
    hardEligibleByDefault: resolution.hardEligibleByDefault,
  };
}

function resolveHardActionEligibility(input: {
  spendUnitProfile: SpendUnitProfile;
  metaAovQuality: MetaAovQuality;
  shadowOnly: boolean;
}): HardActionEligibility {
  if (input.shadowOnly) {
    return {
      scale: false,
      cut: false,
      refresh: false,
      reason: "shadow_only",
    };
  }

  const hardEligible =
    input.spendUnitProfile.hardEligibleByDefault &&
    (input.spendUnitProfile.spendUnitConfidence === "high" ||
      (input.spendUnitProfile.spendUnitConfidence === "medium" &&
        input.metaAovQuality === "ready"));

  return {
    scale: hardEligible,
    cut: hardEligible,
    refresh: hardEligible,
    reason: hardEligible
      ? null
      : hardActionReason({
          source: input.spendUnitProfile.spendUnitSource,
          confidence: input.spendUnitProfile.spendUnitConfidence,
          metaAovQuality: input.metaAovQuality,
        }),
  };
}

function withAovFallback(input: {
  calibration: AccountCalibration;
  fallback: AccountCalibration;
}): AccountCalibration {
  const purchaseCount =
    input.calibration.metaAttributedAovPurchaseCount90d ||
    input.fallback.metaAttributedAovPurchaseCount90d;
  return {
    ...input.calibration,
    metaAttributedAovMean90d:
      input.calibration.metaAttributedAovMean90d ??
      input.fallback.metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d: purchaseCount,
    metaAttributedRevenue90d:
      input.calibration.metaAttributedRevenue90d ||
      input.fallback.metaAttributedRevenue90d,
    metaAovQuality:
      input.calibration.metaAovQuality !== "unavailable"
        ? input.calibration.metaAovQuality
        : classifyMetaAovQuality(purchaseCount),
  };
}

export async function resolveAccountDecisionProfile(input: {
  businessId: string;
  asOf: string;
  dataSource: CreativeDecisionDataSource;
  flags?: EngineV3Flags;
  campaignId?: string;
}): Promise<AccountDecisionProfile> {
  const targetPack = await input.dataSource.getBusinessTargetPack({
    businessId: input.businessId,
  });
  const profileConfig = await input.dataSource.getDecisionCalibrationProfile({
    businessId: input.businessId,
    channel: "meta",
    objectiveFamily: "sales",
  });
  const accountCalibration = await input.dataSource.getAccountCalibration({
    businessId: input.businessId,
    asOf: input.asOf,
  });
  const funnelCalibration = await input.dataSource.getAccountFunnelCalibration({
    businessId: input.businessId,
    asOf: input.asOf,
  });
  const accountBaselinesByKindPromise =
    input.dataSource.getAccountCalibrationAllKinds
      ? input.dataSource
          .getAccountCalibrationAllKinds({
            businessId: input.businessId,
            asOf: input.asOf,
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
  const funnelCalibrationByKindPromise =
    input.dataSource.getAccountFunnelCalibrationAllKinds
      ? input.dataSource
          .getAccountFunnelCalibrationAllKinds({
            businessId: input.businessId,
            asOf: input.asOf,
          })
          .catch(() => undefined)
      : Promise.resolve(undefined);
  const [accountBaselinesByKind, funnelCalibrationByKind] = await Promise.all([
    accountBaselinesByKindPromise,
    funnelCalibrationByKindPromise,
  ]);

  const needsLiveMetaAov =
    accountCalibration.metaAttributedAovMean90d === null ||
    accountCalibration.metaAttributedAovPurchaseCount90d === 0;
  const liveMetaAov = needsLiveMetaAov
    ? await input.dataSource
        .getMetaAttributedAov({
          businessId: input.businessId,
          asOf: input.asOf,
          windowDays: 90,
        })
        .catch(() => null)
    : null;

  const metaAttributedAovMean90d =
    accountCalibration.metaAttributedAovMean90d ?? liveMetaAov?.aovMean ?? null;
  const metaAttributedAovPurchaseCount90d =
    accountCalibration.metaAttributedAovPurchaseCount90d ||
    liveMetaAov?.purchaseCount ||
    0;
  const metaAttributedRevenue90d =
    accountCalibration.metaAttributedRevenue90d ||
    liveMetaAov?.totalRevenue ||
    0;
  const metaAovQuality =
    accountCalibration.metaAovQuality !== "unavailable"
      ? accountCalibration.metaAovQuality
      : classifyMetaAovQuality(metaAttributedAovPurchaseCount90d);

  const accountBaselinesWithAov: AccountCalibration = {
    ...accountCalibration,
    metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d,
    metaAovQuality,
  };
  const resolvedAccountBaselinesByKind = accountBaselinesByKind
    ? CALIBRATION_CAMPAIGN_KINDS.reduce<
        Record<CalibrationCampaignKind, AccountCalibration | null>
      >((acc, campaignKind) => {
        const calibration = accountBaselinesByKind[campaignKind];
        acc[campaignKind] = calibration
          ? withAovFallback({
              calibration,
              fallback: accountBaselinesWithAov,
            })
          : null;
        return acc;
      }, emptyByKind<AccountCalibration>())
    : undefined;
  const scopedCalibration = await resolveScopedCalibration({
    businessId: input.businessId,
    asOf: input.asOf,
    campaignId: input.campaignId,
    dataSource: input.dataSource,
    accountBaselines: accountBaselinesWithAov,
  });
  const accountBaselines = scopedCalibration.accountBaselines;

  const attributionAovAdjustmentMultiplier = overrideMultiplier(
    1.0,
    profileConfig?.attributionAovAdjustmentMultiplier,
  );
  const canonicalSpendUnitProfile = resolveSpendUnitProfile({
    targetPack,
    accountBaselines,
    attributionAovAdjustmentMultiplier,
  });
  const flags =
    input.flags ?? (await resolveEngineV3Flags(input.businessId));

  const { preset, presetSource } = resolvePreset({
    targetPack,
    profileConfig,
    presetOverride: flags.presetOverride ?? null,
  });
  const multipliers = mergeMultipliers({ preset, profileConfig });
  const thresholds = buildEngineThresholds({
    spendUnit: canonicalSpendUnitProfile.spendUnit,
    multipliers,
    accountBaselines,
  });
  const finalHardActionEligibility = resolveHardActionEligibility({
    spendUnitProfile: canonicalSpendUnitProfile,
    metaAovQuality,
    shadowOnly: flags.shadowOnly,
  });
  const spendUnitByKind =
    resolvedAccountBaselinesByKind === undefined
      ? undefined
      : emptyByKind<SpendUnitProfile>();
  const thresholdsByKind =
    resolvedAccountBaselinesByKind === undefined
      ? undefined
      : emptyByKind<EngineThresholdSet>();
  const hardActionEligibilityByKind =
    resolvedAccountBaselinesByKind === undefined
      ? undefined
      : emptyByKind<HardActionEligibility>();

  if (
    resolvedAccountBaselinesByKind !== undefined &&
    spendUnitByKind !== undefined &&
    thresholdsByKind !== undefined &&
    hardActionEligibilityByKind !== undefined
  ) {
    for (const campaignKind of CALIBRATION_CAMPAIGN_KINDS) {
      const calibration =
        campaignKind === "all"
          ? accountBaselines
          : resolvedAccountBaselinesByKind[campaignKind];
      if (calibration === null) continue;
      const spendUnitProfile = resolveSpendUnitProfile({
        targetPack,
        accountBaselines: calibration,
        attributionAovAdjustmentMultiplier,
      });
      spendUnitByKind[campaignKind] = spendUnitProfile;
      thresholdsByKind[campaignKind] = buildEngineThresholds({
        spendUnit: spendUnitProfile.spendUnit,
        multipliers,
        accountBaselines: calibration,
      });
      hardActionEligibilityByKind[campaignKind] =
        resolveHardActionEligibility({
          spendUnitProfile,
          metaAovQuality: calibration.metaAovQuality,
          shadowOnly: flags.shadowOnly,
        });
    }
  }

  return {
    businessId: input.businessId,
    asOfDate: input.asOf,
    channel: "meta",
    objectiveFamily: "sales",
    preset,
    presetSource,
    spendUnit: canonicalSpendUnitProfile.spendUnit,
    spendUnitSource: canonicalSpendUnitProfile.spendUnitSource,
    spendUnitConfidence: canonicalSpendUnitProfile.spendUnitConfidence,
    spendUnitEvidence: canonicalSpendUnitProfile.spendUnitEvidence,
    multipliers,
    thresholds,
    accountBaselines,
    funnelCalibration,
    accountBaselinesByKind: resolvedAccountBaselinesByKind,
    spendUnitByKind,
    thresholdsByKind,
    hardActionEligibilityByKind,
    funnelCalibrationByKind,
    scope: scopedCalibration.scope,
    hardActionEligibility: finalHardActionEligibility,
    quality: {
      commercialTruthReady: positiveFinite(targetPack?.targetRoas ?? null),
      calibrationReady: accountBaselines.matureCreativeCount >= 30,
      metaAovQuality,
      thresholdQuality: resolveThresholdQuality({
        spendUnit: canonicalSpendUnitProfile.spendUnit,
        confidence: canonicalSpendUnitProfile.spendUnitConfidence,
      }),
    },
  };
}

async function resolveScopedCalibration(input: {
  businessId: string;
  asOf: string;
  campaignId?: string;
  dataSource: CreativeDecisionDataSource;
  accountBaselines: AccountCalibration;
}): Promise<{
  accountBaselines: AccountCalibration;
  scope: DecisionProfileScope;
}> {
  const campaignId = input.campaignId?.trim();
  if (!campaignId) {
    return {
      accountBaselines: input.accountBaselines,
      scope: { type: "account", id: "*" },
    };
  }

  const campaignLookup: CampaignCalibrationLookup =
    await input.dataSource.getCampaignCalibration({
      businessId: input.businessId,
      asOf: input.asOf,
      campaignId,
    });
  const campaignMatureCount =
    campaignLookup.calibration?.matureCreativeCount ??
    campaignLookup.matureCreativeCount;

  if (
    campaignMatureCount !== null &&
    campaignMatureCount < MIN_CAMPAIGN_CALIBRATION_SAMPLE
  ) {
    return {
      accountBaselines: input.accountBaselines,
      scope: {
        type: "account",
        id: "*",
        fallbackReason: "campaign_sample_below_threshold",
      },
    };
  }

  if (campaignLookup.calibration === null) {
    return {
      accountBaselines: input.accountBaselines,
      scope: {
        type: "account",
        id: "*",
        fallbackReason: "campaign_calibration_missing",
      },
    };
  }

  return {
    accountBaselines: {
      ...input.accountBaselines,
      roasRatioP10: campaignLookup.calibration.roasRatioP10,
      roasRatioP25: campaignLookup.calibration.roasRatioP25,
      roasRatioP50: campaignLookup.calibration.roasRatioP50,
      roasRatioP75: campaignLookup.calibration.roasRatioP75,
    },
    scope: { type: "campaign", id: campaignId },
  };
}
