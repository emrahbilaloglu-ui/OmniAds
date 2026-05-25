import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import {
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE as publicMinAccountScaleCalibrationSample,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE as publicMinCampaignCalibrationSample,
  SCALE_RATIO_BY_PRESET as publicScaleRatioByPreset,
  defaultBusinessConfig,
} from "../config";
import {
  CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP as publicCreativeCampaignLabelConfidenceCap,
} from "../campaign-label-guard";
import {
  AGGREGATE_AFFECTED_CREATIVE_ID_CAP,
  AT_TARGET_MAX_RATIO,
  BRIEFING_PRIORITY_SCORE_ACTION_WEIGHTS,
  BRIEFING_PRIORITY_SCORE_BANDS,
  BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS,
  BRIEFING_PRIORITY_SPEND_EXPOSURE_FLOOR_RATIO,
  CREATIVE_DECISION_ENGINE_CONFIG_VERSION,
  CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
  DEFAULT_BUSINESS_CONFIG_VALUES,
  ENGINE_PRESET_MULTIPLIERS,
  FATIGUE_FREQUENCY_PRESSURE_THRESHOLD,
  FATIGUE_SIGNIFICANT_DECAY_THRESHOLD,
  FATIGUE_SPEND_CONCENTRATION_THRESHOLD,
  FATIGUE_STRONG_WINDOW_FALLBACK_ROAS,
  LAUNCH_MONITOR_WINDOW_DAYS,
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
  MIN_KIND_CALIBRATION_MATURE_COUNT,
  REFRESH_RATIO_FALLBACK,
  RESPONSE_WINDOW_DAYS,
  SAMPLE_WINDOW_DAYS,
  SCALE_RATIO_BY_PRESET,
  STALE_TIER_NONE_MAX_HOURS,
  STALE_TIER_WARNING_MAX_HOURS,
  TARGET_BAND_MIN_RATIO,
  UNUSED_APPROVED_LOOKBACK_DAYS,
  WEAK_TARGET_MAX_RATIO,
  WINNER_GAP_FRESHNESS_MAX_DAYS,
  WINNER_GAP_LOOKBACK_DAYS,
  WINNER_GAP_MIN_DEPTH_DAYS,
  WINNER_GAP_MIN_SAMPLED_DAYS,
  ZERO_CONV_MIN_AGE_DAYS,
} from "../config-values";
import {
  STALE_TIER_NONE_MAX_HOURS as publicStaleTierNoneMaxHours,
  STALE_TIER_WARNING_MAX_HOURS as publicStaleTierWarningMaxHours,
} from "../data-health";
import {
  ENGINE_PRESET_MULTIPLIERS as publicEnginePresetMultipliers,
} from "../engine-presets";
import {
  ZERO_CONV_MIN_AGE_DAYS as publicZeroConvMinAgeDays,
} from "../gates/zero-conv-burner";
import {
  MIN_KIND_CALIBRATION_MATURE_COUNT as publicMinKindCalibrationMatureCount,
} from "../kind-aware-profile";
import {
  RESPONSE_WINDOW_DAYS as publicResponseWindowDays,
} from "../jobs/operator-response-job";

const EXPECTED_ENGINE_PRESET_MULTIPLIERS = {
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

describe("creative decision engine config-as-data values", () => {
  it("keeps moved public constants in lockstep with the central config values", () => {
    expect(publicMinCampaignCalibrationSample).toBe(
      MIN_CAMPAIGN_CALIBRATION_SAMPLE,
    );
    expect(publicMinAccountScaleCalibrationSample).toBe(
      MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
    );
    expect(publicScaleRatioByPreset).toBe(SCALE_RATIO_BY_PRESET);
    expect(publicStaleTierNoneMaxHours).toBe(STALE_TIER_NONE_MAX_HOURS);
    expect(publicStaleTierWarningMaxHours).toBe(
      STALE_TIER_WARNING_MAX_HOURS,
    );
    expect(publicZeroConvMinAgeDays).toBe(ZERO_CONV_MIN_AGE_DAYS);
    expect(publicMinKindCalibrationMatureCount).toBe(
      MIN_KIND_CALIBRATION_MATURE_COUNT,
    );
    expect(publicCreativeCampaignLabelConfidenceCap).toBe(
      CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
    );
    expect(publicResponseWindowDays).toBe(RESPONSE_WINDOW_DAYS);
    expect(publicEnginePresetMultipliers).toBe(ENGINE_PRESET_MULTIPLIERS);
  });

  it("freezes the PR5-alpha behavior-equivalent values", () => {
    expect(CREATIVE_DECISION_ENGINE_CONFIG_VERSION).toBe(
      "creative-decision-engine.config.v1",
    );
    expect(MIN_CAMPAIGN_CALIBRATION_SAMPLE).toBe(8);
    expect(MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE).toBe(30);
    expect(SCALE_RATIO_BY_PRESET).toEqual({
      aggressive: 1.2,
      balanced: 1.3,
      conservative: 1.4,
    });
    expect(DEFAULT_BUSINESS_CONFIG_VALUES).toEqual({
      aggression: "balanced",
      scaleRatioThreshold: 1.3,
      recentSampleMinSpend: 50,
      accountBaselineQuantile: 0.75,
      truthPenaltyForDegraded: 10,
      globalDefaultTargetRoas: 2.0,
      lowCtrThresholdFallback: 1.0,
    });
    expect(STALE_TIER_NONE_MAX_HOURS).toBe(36);
    expect(STALE_TIER_WARNING_MAX_HOURS).toBe(72);
    expect(ZERO_CONV_MIN_AGE_DAYS).toBe(7);
    expect(MIN_KIND_CALIBRATION_MATURE_COUNT).toBe(10);
    expect(CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP).toBe(50);
    expect(FATIGUE_SIGNIFICANT_DECAY_THRESHOLD).toBe(0.18);
    expect(FATIGUE_SPEND_CONCENTRATION_THRESHOLD).toBe(0.55);
    expect(FATIGUE_FREQUENCY_PRESSURE_THRESHOLD).toBe(2.5);
    expect(FATIGUE_STRONG_WINDOW_FALLBACK_ROAS).toBe(1.5);
    expect(LAUNCH_MONITOR_WINDOW_DAYS).toBe(3);
    expect(TARGET_BAND_MIN_RATIO).toBe(0.85);
    expect(WEAK_TARGET_MAX_RATIO).toBe(0.95);
    expect(AT_TARGET_MAX_RATIO).toBe(1.15);
    expect(REFRESH_RATIO_FALLBACK).toBe(0.75);
    expect(WINNER_GAP_LOOKBACK_DAYS).toBe(90);
    expect(WINNER_GAP_FRESHNESS_MAX_DAYS).toBe(2);
    expect(WINNER_GAP_MIN_DEPTH_DAYS).toBe(14);
    expect(WINNER_GAP_MIN_SAMPLED_DAYS).toBe(14);
    expect(UNUSED_APPROVED_LOOKBACK_DAYS).toBe(90);
    expect(AGGREGATE_AFFECTED_CREATIVE_ID_CAP).toBe(20);
    expect(BRIEFING_PRIORITY_SCORE_ACTION_WEIGHTS).toEqual({
      scale: 0.9,
      keep: 0.1,
      refresh: 0.75,
      cut: 1,
      test_more: 0.35,
      diagnose: 0.55,
      out_of_scope: 0.1,
    });
    expect(BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS).toEqual({
      stopLossOrDeliveryBlocker: 1.3,
      weakPerformanceOrScaleBlocker: 1.15,
      launchMonitoring: 0.7,
      default: 1,
    });
    expect(BRIEFING_PRIORITY_SCORE_BANDS).toEqual([
      { band: "critical", minScore: 500 },
      { band: "high", minScore: 150 },
      { band: "medium", minScore: 40 },
      { band: "low", minScore: 0 },
    ]);
    expect(BRIEFING_PRIORITY_SPEND_EXPOSURE_FLOOR_RATIO).toBe(0.05);
    expect(RESPONSE_WINDOW_DAYS).toBe(30);
    expect(SAMPLE_WINDOW_DAYS).toBe(90);
    expect(ENGINE_PRESET_MULTIPLIERS).toEqual(
      EXPECTED_ENGINE_PRESET_MULTIPLIERS,
    );
  });

  it("keeps defaultBusinessConfig output unchanged", () => {
    expect(defaultBusinessConfig("biz_123")).toEqual({
      businessId: "biz_123",
      aggression: "balanced",
      scaleRatioThreshold: 1.3,
      recentSampleMinSpend: 50,
      accountBaselineQuantile: 0.75,
      truthPenaltyForDegraded: 10,
      globalDefaultTargetRoas: 2.0,
      lowCtrThresholdFallback: 1.0,
    });
  });

  it("keeps moved values defined only in the central config module", () => {
    const sourceByPath = new Map(
      [
        "lib/creative-decision-engine/config.ts",
        "lib/creative-decision-engine/engine-presets.ts",
        "lib/creative-decision-engine/data-health.ts",
        "lib/creative-decision-engine/gates/zero-conv-burner.ts",
        "lib/creative-decision-engine/kind-aware-profile.ts",
        "lib/creative-decision-engine/campaign-label-guard.ts",
        "lib/creative-decision-engine/jobs/operator-response-job.ts",
        "lib/creative-decision-engine/jobs/calibration-job.ts",
        "lib/creative-decision-engine/gates/ratio-zones.ts",
        "app/api/creatives/briefing/card-serialization.ts",
        "app/api/creatives/briefing/route.ts",
      ].map((path) => [path, readFileSync(path, "utf8")]),
    );

    const forbiddenDefinitions = [
      "MIN_CAMPAIGN_CALIBRATION_SAMPLE",
      "MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE",
      "SCALE_RATIO_BY_PRESET",
      "ENGINE_PRESET_MULTIPLIERS",
      "STALE_TIER_NONE_MAX_HOURS",
      "STALE_TIER_WARNING_MAX_HOURS",
      "ZERO_CONV_MIN_AGE_DAYS",
      "MIN_KIND_CALIBRATION_MATURE_COUNT",
      "CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP",
      "TARGET_BAND_MIN_RATIO",
      "WEAK_TARGET_MAX_RATIO",
      "AT_TARGET_MAX_RATIO",
      "REFRESH_RATIO_FALLBACK",
      "WINNER_GAP_LOOKBACK_DAYS",
      "WINNER_GAP_FRESHNESS_MAX_DAYS",
      "WINNER_GAP_MIN_DEPTH_DAYS",
      "WINNER_GAP_MIN_SAMPLED_DAYS",
      "UNUSED_APPROVED_LOOKBACK_DAYS",
      "AGGREGATE_AFFECTED_CREATIVE_ID_CAP",
      "BRIEFING_PRIORITY_SCORE_ACTION_WEIGHTS",
      "BRIEFING_PRIORITY_SCORE_SEVERITY_WEIGHTS",
      "BRIEFING_PRIORITY_SCORE_BANDS",
      "BRIEFING_PRIORITY_SPEND_EXPOSURE_FLOOR_RATIO",
      "RESPONSE_WINDOW_DAYS",
      "SAMPLE_WINDOW_DAYS",
    ];

    for (const [path, source] of sourceByPath) {
      for (const name of forbiddenDefinitions) {
        expect(source, `${path} should not redefine ${name}`).not.toMatch(
          new RegExp(`(?:export\\s+)?const\\s+${name}\\s*=`),
        );
      }
    }
  });
});
