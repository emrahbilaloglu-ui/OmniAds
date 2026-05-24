import type {
  AggressionPreset,
  BusinessConfig,
  EngineMultiplierSet,
  EngineRiskPreset,
} from "./types";

export const CREATIVE_DECISION_ENGINE_CONFIG_VERSION =
  "creative-decision-engine.config.v1";

export const MIN_CAMPAIGN_CALIBRATION_SAMPLE = 8;
export const MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE = 30;

export const SCALE_RATIO_BY_PRESET: Record<AggressionPreset, number> = {
  aggressive: 1.2,
  balanced: 1.3,
  conservative: 1.4,
};

export const DEFAULT_BUSINESS_CONFIG_VALUES = {
  aggression: "balanced",
  scaleRatioThreshold: SCALE_RATIO_BY_PRESET.balanced,
  recentSampleMinSpend: 50,
  accountBaselineQuantile: 0.75,
  truthPenaltyForDegraded: 10,
  globalDefaultTargetRoas: 2.0,
  lowCtrThresholdFallback: 1.0,
} as const satisfies Omit<BusinessConfig, "businessId">;

export const STALE_TIER_NONE_MAX_HOURS = 36;
export const STALE_TIER_WARNING_MAX_HOURS = 72;

export const ZERO_CONV_MIN_AGE_DAYS = 7;
export const MIN_KIND_CALIBRATION_MATURE_COUNT = 10;
export const CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP = 50;
export const FATIGUE_SIGNIFICANT_DECAY_THRESHOLD = 0.18;
export const FATIGUE_SPEND_CONCENTRATION_THRESHOLD = 0.55;
export const FATIGUE_FREQUENCY_PRESSURE_THRESHOLD = 2.5;
export const FATIGUE_STRONG_WINDOW_FALLBACK_ROAS = 1.5;

export const RESPONSE_WINDOW_DAYS = 30;
export const SAMPLE_WINDOW_DAYS = 90;

export const ENGINE_PRESET_MULTIPLIERS: Record<
  EngineRiskPreset,
  EngineMultiplierSet
> = {
  aggressive: {
    zeroConvBurner: 2.0,
    cutCandidate: 1.5,
    sustainedLoser: 2.0,
    lossBudget: 1.5,
    hardCut: 3.0,
    scalePurchase: 0.7,
    winnerMemory: 1.0,
    recentSample: 0.25,
    weakFunnelRate: 0.65,
  },
  balanced: {
    zeroConvBurner: 3.0,
    cutCandidate: 2.0,
    sustainedLoser: 3.0,
    lossBudget: 2.0,
    hardCut: 5.0,
    scalePurchase: 1.0,
    winnerMemory: 1.5,
    recentSample: 0.5,
    weakFunnelRate: 0.5,
  },
  conservative: {
    zeroConvBurner: 5.0,
    cutCandidate: 3.0,
    sustainedLoser: 5.0,
    lossBudget: 2.5,
    hardCut: 8.0,
    scalePurchase: 1.5,
    winnerMemory: 2.0,
    recentSample: 1.0,
    weakFunnelRate: 0.35,
  },
};
