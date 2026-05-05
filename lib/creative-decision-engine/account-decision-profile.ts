import type {
  BusinessTargetPack,
  CreativeDecisionDataSource,
  DecisionCalibrationProfileConfig,
} from "./data-source";
import { ENGINE_PRESET_MULTIPLIERS } from "./engine-presets";
import {
  classifyMetaAovQuality,
  resolveSpendUnit,
} from "./spend-unit-resolver";
import type {
  AccountCalibration,
  AccountDecisionProfile,
  EngineMultiplierSet,
  EngineRiskPreset,
  EngineThresholdSet,
  MetaAovQuality,
  ThresholdQuality,
} from "./types";

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
}): {
  preset: EngineRiskPreset;
  presetSource: AccountDecisionProfile["presetSource"];
} {
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
    hardCut: overrideMultiplier(defaults.hardCut, overrides?.hardCutMultiplier),
    scaleEvidence: overrideMultiplier(
      defaults.scaleEvidence,
      overrides?.scaleEvidenceMultiplier,
    ),
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

export async function resolveAccountDecisionProfile(input: {
  businessId: string;
  asOf: string;
  dataSource: CreativeDecisionDataSource;
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

  const accountBaselines: AccountCalibration = {
    ...accountCalibration,
    metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d,
    metaAovQuality,
  };

  const attributionAovAdjustmentMultiplier = overrideMultiplier(
    1.0,
    profileConfig?.attributionAovAdjustmentMultiplier,
  );
  const spendUnitResolution = resolveSpendUnit({
    targetCpa: targetPack?.targetCpa ?? null,
    operatorAovAssumption: targetPack?.operatorAovAssumption ?? null,
    metaAttributedAovMean90d,
    metaAttributedAovPurchaseCount90d,
    metaAttributedRevenue90d,
    targetRoas: targetPack?.targetRoas ?? null,
    breakEvenRoas: targetPack?.breakEvenRoas ?? null,
    accountCpaP50: accountBaselines.accountCpaP50,
    accountCpaSampleCount: accountBaselines.accountCpaSampleCount,
    attributionAovAdjustmentMultiplier,
  });

  const { preset, presetSource } = resolvePreset({
    targetPack,
    profileConfig,
  });
  const multipliers = mergeMultipliers({ preset, profileConfig });
  const thresholds: EngineThresholdSet = {
    zeroConvBurnerSpend: spendThreshold(
      spendUnitResolution.spendUnit,
      multipliers.zeroConvBurner,
    ),
    cutCandidateSpend: spendThreshold(
      spendUnitResolution.spendUnit,
      multipliers.cutCandidate,
    ),
    sustainedLoserSpend: spendThreshold(
      spendUnitResolution.spendUnit,
      multipliers.sustainedLoser,
    ),
    hardCutSpend: spendThreshold(
      spendUnitResolution.spendUnit,
      multipliers.hardCut,
    ),
    recentSampleMinSpend: spendThreshold(
      spendUnitResolution.spendUnit,
      multipliers.recentSample,
    ),
    scaleMinEvidenceSpend: spendThreshold(
      spendUnitResolution.spendUnit,
      multipliers.scaleEvidence,
    ),
    winnerMemoryMinSpend: spendThreshold(
      spendUnitResolution.spendUnit,
      multipliers.winnerMemory,
    ),
    scaleMinPurchases: purchaseThreshold(
      accountBaselines.winnerPurchaseP50,
      multipliers.scalePurchase,
    ),
    winnerMemoryMinPurchases: purchaseThreshold(
      accountBaselines.winnerPurchaseP50,
      multipliers.winnerMemory,
    ),
    bottomQuartileRatio: accountBaselines.roasRatioP25,
    severeLoserRatio: accountBaselines.roasRatioP10,
  };

  const hardEligible =
    spendUnitResolution.hardEligibleByDefault &&
    (spendUnitResolution.confidence === "high" ||
      (spendUnitResolution.confidence === "medium" &&
        metaAovQuality === "ready"));
  const hardActionEligibility = {
    scale: hardEligible,
    cut: hardEligible,
    refresh: hardEligible,
    reason: hardEligible
      ? null
      : hardActionReason({
          source: spendUnitResolution.source,
          confidence: spendUnitResolution.confidence,
          metaAovQuality,
        }),
  };

  return {
    businessId: input.businessId,
    asOfDate: input.asOf,
    channel: "meta",
    objectiveFamily: "sales",
    preset,
    presetSource,
    spendUnit: spendUnitResolution.spendUnit,
    spendUnitSource: spendUnitResolution.source,
    spendUnitConfidence: spendUnitResolution.confidence,
    spendUnitEvidence: spendUnitResolution.evidence,
    multipliers,
    thresholds,
    accountBaselines,
    funnelCalibration,
    hardActionEligibility,
    quality: {
      commercialTruthReady: positiveFinite(targetPack?.targetRoas ?? null),
      calibrationReady: accountBaselines.matureCreativeCount >= 30,
      metaAovQuality,
      thresholdQuality: resolveThresholdQuality({
        spendUnit: spendUnitResolution.spendUnit,
        confidence: spendUnitResolution.confidence,
      }),
    },
  };
}
