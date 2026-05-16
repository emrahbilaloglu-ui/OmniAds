import type {
  AccountCalibration,
  AccountDecisionProfile,
  AccountFunnelCalibration,
  CalibrationCampaignKind,
  CreativeFormat,
  CreativeInput,
  DecisionKindSource,
  FormatFunnelBaseline,
} from "./types";
import { MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE } from "./config";

export const MIN_KIND_CALIBRATION_MATURE_COUNT = 10;

function positiveFinite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value) && value > 0;
}

function isCalibrationCampaignKind(
  value: CreativeInput["campaignKind"],
): value is Exclude<CalibrationCampaignKind, "all"> {
  return value === "main" || value === "test" || value === "mixed";
}

function hasRequiredKindCalibrationFields(
  calibration: AccountCalibration,
): boolean {
  return (
    calibration.matureCreativeCount >= MIN_KIND_CALIBRATION_MATURE_COUNT &&
    positiveFinite(calibration.accountCpaP50) &&
    calibration.accountCpaSampleCount >= 20 &&
    positiveFinite(calibration.metaAttributedAovMean90d) &&
    calibration.metaAttributedAovPurchaseCount90d > 0 &&
    positiveFinite(calibration.matureSpendP50) &&
    positiveFinite(calibration.winnerPurchaseP50) &&
    positiveFinite(calibration.roasRatioP10) &&
    positiveFinite(calibration.roasRatioP25) &&
    positiveFinite(calibration.refreshRatioP10)
  );
}

function hasUsableFunnelBaseline(
  baseline: FormatFunnelBaseline | undefined,
): baseline is FormatFunnelBaseline {
  return baseline !== undefined && baseline.qualityStatus !== "insufficient";
}

function selectKindFunnelCalibration(input: {
  canonical: AccountFunnelCalibration;
  kindSpecific: AccountFunnelCalibration | null | undefined;
  creativeFormat: CreativeFormat | null;
}): AccountFunnelCalibration | null {
  const kindSpecific = input.kindSpecific;
  if (!kindSpecific) return null;

  const format = input.creativeFormat ?? "overall";
  const kindFormat = kindSpecific.byFormat[format];
  const kindOverall = kindSpecific.byFormat.overall;
  if (
    !hasUsableFunnelBaseline(kindFormat) &&
    !hasUsableFunnelBaseline(kindOverall)
  ) {
    return null;
  }

  const byFormat: AccountFunnelCalibration["byFormat"] = {
    ...input.canonical.byFormat,
  };

  for (const [formatKey, baseline] of Object.entries(kindSpecific.byFormat)) {
    if (hasUsableFunnelBaseline(baseline)) {
      byFormat[formatKey] = baseline;
    }
  }

  return {
    campaignKind: kindSpecific.campaignKind,
    byFormat,
  };
}

export function selectKindAwareDecisionProfile(
  input: CreativeInput,
  profile: AccountDecisionProfile,
): {
  profile: AccountDecisionProfile;
  decisionKindSource: DecisionKindSource;
} {
  if (!isCalibrationCampaignKind(input.campaignKind)) {
    return {
      profile,
      decisionKindSource: "all_fallback",
    };
  }

  const campaignKind = input.campaignKind;
  const accountBaselines =
    profile.accountBaselinesByKind?.[campaignKind] ?? null;
  const spendUnitProfile = profile.spendUnitByKind?.[campaignKind] ?? null;
  const thresholds = profile.thresholdsByKind?.[campaignKind] ?? null;
  const hardActionEligibility =
    profile.hardActionEligibilityByKind?.[campaignKind] ?? null;
  const funnelCalibration = selectKindFunnelCalibration({
    canonical: profile.funnelCalibration,
    kindSpecific: profile.funnelCalibrationByKind?.[campaignKind] ?? null,
    creativeFormat: input.creativeFormat,
  });

  if (
    accountBaselines === null ||
    spendUnitProfile === null ||
    thresholds === null ||
    hardActionEligibility === null ||
    funnelCalibration === null ||
    !hasRequiredKindCalibrationFields(accountBaselines)
  ) {
    return {
      profile,
      decisionKindSource: "all_fallback",
    };
  }

  return {
    profile: {
      ...profile,
      spendUnit: spendUnitProfile.spendUnit,
      spendUnitSource: spendUnitProfile.spendUnitSource,
      spendUnitConfidence: spendUnitProfile.spendUnitConfidence,
      spendUnitEvidence: spendUnitProfile.spendUnitEvidence,
      thresholds,
      accountBaselines,
      funnelCalibration,
      hardActionEligibility,
      quality: {
        ...profile.quality,
        calibrationReady:
          accountBaselines.matureCreativeCount >=
          MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
        metaAovQuality: accountBaselines.metaAovQuality,
      },
    },
    decisionKindSource: `kind_${campaignKind}`,
  };
}
