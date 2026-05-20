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
  CREATIVE_DECISION_ENGINE_CONFIG_VERSION,
  CREATIVE_CAMPAIGN_LABEL_CONFIDENCE_CAP,
  DEFAULT_BUSINESS_CONFIG_VALUES,
  ENGINE_PRESET_MULTIPLIERS,
  MIN_ACCOUNT_SCALE_CALIBRATION_SAMPLE,
  MIN_CAMPAIGN_CALIBRATION_SAMPLE,
  MIN_KIND_CALIBRATION_MATURE_COUNT,
  RESPONSE_WINDOW_DAYS,
  SAMPLE_WINDOW_DAYS,
  SCALE_RATIO_BY_PRESET,
  STALE_TIER_NONE_MAX_HOURS,
  STALE_TIER_WARNING_MAX_HOURS,
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
