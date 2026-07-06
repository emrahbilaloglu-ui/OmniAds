import type {
  AggressionPreset,
  BusinessConfig,
  DecisionLabel,
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
export const STALE_PIPELINE_AGE_HOURS = 24;
export const STALE_SOURCE_UPDATED_AT_HOURS = 48;
export const RECENT_SIGNAL_FRESHNESS_HOURS = 36;
export const PREFLIGHT_FRESHNESS_HOURS = 12;
export const STALE_CONFIDENCE_CAP = 65;

// F2: the cut-zone boundary is the account-relative roasRatioP25. In strong
// accounts that percentile can exceed 1.0, which would put profitable
// near-target creatives inside the hard-cut zone. Clamp the boundary so a
// creative at or above target ratio can never be zone-cut by curve grading.
export const CUT_BOUNDARY_RATIO_CLAMP = 1.0;

export const ZERO_CONV_MIN_AGE_DAYS = 7;
export const LAUNCH_MONITOR_WINDOW_DAYS = 3;
export const MIN_KIND_CALIBRATION_MATURE_COUNT = 10;
export const CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP = 50;
export const FATIGUE_SIGNIFICANT_DECAY_THRESHOLD = 0.18;
export const FATIGUE_SPEND_CONCENTRATION_THRESHOLD = 0.55;
export const FATIGUE_FREQUENCY_PRESSURE_THRESHOLD = 2.5;
export const FATIGUE_STRONG_WINDOW_FALLBACK_ROAS = 1.5;

export const TARGET_BAND_MIN_RATIO = 0.85;
export const WEAK_TARGET_MAX_RATIO = 0.95;
export const AT_TARGET_MAX_RATIO = 1.15;
export const REFRESH_RATIO_FALLBACK = 0.75;

export const WINNER_GAP_LOOKBACK_DAYS = 90;
export const WINNER_GAP_FRESHNESS_MAX_DAYS = 2;
export const WINNER_GAP_MIN_DEPTH_DAYS = 14;
export const WINNER_GAP_MIN_SAMPLED_DAYS = 14;
export const UNUSED_APPROVED_LOOKBACK_DAYS = 90;
export const AGGREGATE_AFFECTED_CREATIVE_ID_CAP = 20;
export const CALIBRATION_REFIT_INTERVAL_DAYS = 90;

export const BRIEFING_PRIORITY_SCORE_ACTION_WEIGHTS = {
  scale: 0.9,
  keep: 0.1,
  refresh: 0.75,
  cut: 1,
  test_more: 0.35,
  diagnose: 0.55,
  out_of_scope: 0.1,
} as const satisfies Record<DecisionLabel, number>;

export const BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS = {
  stopLossOrDeliveryBlocker: 1.3,
  weakPerformanceOrScaleBlocker: 1.15,
  launchMonitoring: 0.7,
  default: 1,
} as const;

export const BRIEFING_PRIORITY_SCORE_BANDS = [
  { band: "critical", minScore: 500 },
  { band: "high", minScore: 150 },
  { band: "medium", minScore: 40 },
  { band: "low", minScore: 0 },
] as const;

export const BRIEFING_PRIORITY_SPEND_EXPOSURE_FLOOR_RATIO = 0.05;
export const BRIEFING_NEAR_MISS_MAX_COUNT = 3;

export const FUNNEL_FALLBACK_DENOMINATOR_P50 = {
  upperFunnel: 1_000,
  landingPage: 50,
  checkout: 10,
} as const;

export const QUALITY_ONLY_COMPONENT_WEIGHTS = {
  hook: 0.05,
  ctr: 0.1,
  cpmEfficiency: 0.1,
  clickToLpv: 0.15,
  lpvToAtc: 0.2,
  atcToIc: 0.25,
} as const;

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
