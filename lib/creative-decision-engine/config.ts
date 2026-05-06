import type {
  AggressionPreset,
  BusinessConfig,
  CampaignObjective,
} from "./types";

export const SUPPORTED_OBJECTIVES: ReadonlySet<CampaignObjective> = new Set([
  "OUTCOME_SALES",
]);

// Below 8 mature creatives, campaign percentile estimates are too noisy to use.
// Campaign scope falls back to account scope; per-business overrides are future work.
export const MIN_CAMPAIGN_CALIBRATION_SAMPLE = 8;

export const SCALE_RATIO_BY_PRESET: Record<AggressionPreset, number> = {
  aggressive: 1.2,
  balanced: 1.3,
  conservative: 1.4,
};

export function defaultBusinessConfig(businessId: string): BusinessConfig {
  return {
    businessId,
    aggression: "balanced",
    scaleRatioThreshold: SCALE_RATIO_BY_PRESET.balanced,
    maturitySpendThreshold: 300,
    maturityPurchasesThreshold: 5,
    cutMaturitySpendThreshold: 1000,
    recentSampleMinSpend: 50,
    accountBaselineQuantile: 0.75,
    truthPenaltyForDegraded: 10,
    globalDefaultTargetRoas: 2.0,
    lowCtrThresholdFallback: 1.0,
  };
}
