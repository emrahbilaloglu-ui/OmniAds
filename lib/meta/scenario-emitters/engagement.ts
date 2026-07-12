import type { MetaAdSetData } from "@/lib/api/meta";
import {
  LEGACY_META_CALIBRATION_THRESHOLDS,
  type MetaCalibrationMetricName,
  type MetaMetricPercentiles,
} from "@/lib/meta/calibration";
import {
  META_RECOMMENDATION_ENGINE_VERSION,
  type MetaRecommendation,
} from "@/lib/meta/recommendations";
import {
  evaluateCohortEvidence,
  hasCohortFatigueEvidence,
  type CohortEvidenceProfile,
} from "@/lib/meta/scenario-emitters/cohort-evidence";
import type { AdsetScenarioInput } from "@/lib/meta/scenario-emitters/high-priority";
import {
  percentileRank,
  percentileRankInverted,
} from "@/lib/meta/scenario-emitters/scoring-utils";

function r2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function currencySymbol(currency: string | null | undefined) {
  if (currency === "TRY") return "TRY ";
  if (currency === "EUR") return "EUR ";
  return "$";
}

function fmtCurrency(value: number | null, currency: string | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "No engagements";
  return `${currencySymbol(currency)}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtPercent(value: number) {
  return `${r2(value)}%`;
}

function fmtScore(value: number) {
  return `${Math.round(value * 100)}%`;
}

function numberField(adset: MetaAdSetData, key: keyof MetaAdSetData) {
  const value = adset[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function observedNumberField(adset: MetaAdSetData, key: keyof MetaAdSetData) {
  const value = adset[key];
  return typeof value === "number" && Number.isFinite(value) ? value : null;
}

function threshold(
  input: AdsetScenarioInput,
  name: MetaCalibrationMetricName,
): MetaMetricPercentiles | null {
  const percentiles = input.context?.thresholds.metrics[name] ?? null;
  const minRequired =
    input.context?.thresholds.minRequiredSample ??
    LEGACY_META_CALIBRATION_THRESHOLDS.minRequiredSample;
  if (!percentiles || percentiles.sampleSize < minRequired) return null;
  return percentiles;
}

function ageDays(input: AdsetScenarioInput) {
  const explicitAge = (input.adset as MetaAdSetData & { ageDays?: unknown }).ageDays;
  if (typeof explicitAge === "number" && Number.isFinite(explicitAge)) return explicitAge;
  const sourceAge = input.signals?.sourceJson?.age_days;
  if (typeof sourceAge === "number" && Number.isFinite(sourceAge)) return sourceAge;
  const parsedSourceAge = sourceAge == null ? null : Number(sourceAge);
  if (parsedSourceAge != null && Number.isFinite(parsedSourceAge)) return parsedSourceAge;
  return null;
}

function frequencyValue(input: AdsetScenarioInput) {
  const signalFrequency = input.signals?.frequencyP80;
  if (typeof signalFrequency === "number" && Number.isFinite(signalFrequency)) {
    return signalFrequency;
  }
  return numberField(input.adset, "frequency");
}

function hasFatigue(input: AdsetScenarioInput) {
  return hasCohortFatigueEvidence({
    context: input.context,
    frequency: frequencyValue(input),
    ctrDecayPct: input.signals?.ctrDecayPct,
  });
}

function baseEngagementRecommendation(input: {
  scenarioType: MetaRecommendation["type"];
  decisionLabel: NonNullable<MetaRecommendation["decisionLabel"]>;
  decisionState: MetaRecommendation["decisionState"];
  priority: MetaRecommendation["priority"];
  lens: MetaRecommendation["lens"];
  input: AdsetScenarioInput;
  title: string;
  why: string;
  summary: string;
  recommendedAction: string;
  expectedImpact: string;
  score: number;
  evidenceProfile: CohortEvidenceProfile;
  evidence: MetaRecommendation["evidence"];
  targetValue?: unknown;
}): MetaRecommendation {
  return {
    id: `${input.scenarioType}-${input.input.adset.id}`,
    level: "adset",
    campaignId: input.input.adset.campaignId,
    campaignName: input.input.campaign?.name,
    adsetId: input.input.adset.id,
    adsetName: input.input.adset.name,
    type: input.scenarioType,
    kind: "recommendation",
    decisionLabel: input.decisionLabel,
    lens: input.lens,
    priority: input.priority,
    confidence: input.evidenceProfile.confidence,
    confidenceScore: input.evidenceProfile.confidenceScore,
    confidenceReason: null,
    decisionState: input.decisionState,
    decision: input.title,
    title: input.title,
    why: input.why,
    summary: input.summary,
    recommendedAction: input.recommendedAction,
    expectedImpact: input.expectedImpact,
    evidence: input.evidence,
    timeframeContext: {
      coreVerdict: input.why,
      selectedRangeOverlay: "Selected range engagement metrics are compared against cohort calibration bands.",
      historicalSupport: "Uses engagement cohort percentiles from Meta Engine calibration.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: input.targetValue,
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    campaignRole: input.input.campaignRole,
    bidRegime: input.input.bidRegime,
    cohort: "engagement",
    calibrationScope: input.input.context?.scope ?? {},
    signalQuality: input.input.signals
      ? {
          quality_status: input.input.signals.qualityStatus,
          signal_source: "meta_entity_decision_signals_daily",
        }
      : { quality_status: "missing" },
  };
}

export function emitEngagementAdsetScenario(input: AdsetScenarioInput): MetaRecommendation | null {
  if (input.cohort !== "engagement") return null;

  const costThreshold = threshold(input, "cost_per_engagement_28d");
  if (!costThreshold) return null;

  const postEngagement = observedNumberField(input.adset, "postEngagement");
  if (postEngagement == null) return null;

  const costPerEngagement =
    postEngagement > 0 ? input.adset.spend / postEngagement : Number.POSITIVE_INFINITY;
  const costRank =
    postEngagement > 0 ? percentileRankInverted(costPerEngagement, costThreshold) : 0;
  if (costRank == null) return null;

  const engagementRateThreshold = threshold(input, "engagement_rate_28d");
  const engagementRate =
    input.adset.impressions > 0 ? (postEngagement / input.adset.impressions) * 100 : 0;
  const qualityRank = engagementRateThreshold
    ? percentileRank(engagementRate, engagementRateThreshold)
    : null;
  if (engagementRateThreshold && qualityRank == null) return null;

  const hasQualityCalibration = qualityRank != null;
  const score = r2(hasQualityCalibration ? (0.6 * costRank) + (0.4 * qualityRank) : 0.5);
  const currency = (input.adset as MetaAdSetData & { currency?: string | null }).currency ?? null;
  const age = ageDays(input);
  const evidenceProfile = evaluateCohortEvidence({
    context: input.context,
    score,
    eventCount: postEngagement,
    spend: input.adset.spend,
    ageDays: age,
  });
  const evidence: MetaRecommendation["evidence"] = [
    { label: "Engagement score", value: fmtScore(score), tone: score >= 0.7 ? "positive" : score < 0.3 ? "warning" : "neutral" },
    { label: "Cost / engagement", value: fmtCurrency(Number.isFinite(costPerEngagement) ? costPerEngagement : null, currency), tone: costRank >= 0.7 ? "positive" : costRank <= 0.3 ? "warning" : "neutral" },
    { label: "Engagement rate", value: fmtPercent(engagementRate), tone: qualityRank == null ? "neutral" : qualityRank >= 0.7 ? "positive" : qualityRank <= 0.3 ? "warning" : "neutral" },
    { label: "Post engagement", value: String(postEngagement), tone: postEngagement > 0 ? "positive" : "warning" },
  ];
  const targetValue = {
    score,
    cost_rank: costRank,
    quality_rank: qualityRank,
    cost_per_engagement: Number.isFinite(costPerEngagement) ? costPerEngagement : null,
    engagement_rate: engagementRate,
    post_engagement: postEngagement,
    age_days: age,
  };

  if (!hasQualityCalibration) {
    return baseEngagementRecommendation({
      scenarioType: "scenario_eg2_engagement_steady_keep",
      decisionLabel: "keep",
      decisionState: "watch",
      priority: "low",
      lens: "volume",
      input,
      title: `${input.adset.name}: hold engagement delivery`,
      why: "Cost-per-engagement data is present, but required engagement-rate calibration is missing.",
      summary: "Keep the engagement ad set in watch mode until quality-rate calibration is available.",
      recommendedAction: "Hold",
      expectedImpact: "Avoids scaling or cutting from cost-only engagement evidence.",
      evidence,
      score,
      evidenceProfile,
      targetValue,
    });
  }

  if (score >= 0.7 && evidenceProfile.scaleMature) {
    return baseEngagementRecommendation({
      scenarioType: "scenario_eg1_engagement_efficient_scale",
      decisionLabel: "scale",
      decisionState: "act",
      priority: "high",
      lens: "volume",
      input,
      title: `${input.adset.name}: efficient engagement scale candidate`,
      why: `The ad set scores ${fmtScore(score)} against engagement cohort percentiles with mature signal age.`,
      summary: `${input.adset.name} is buying engagement efficiently with healthy quality rate.`,
      recommendedAction: "Scale budget",
      expectedImpact: "More engagement volume while staying inside cohort-calibrated cost and quality bands.",
      evidence,
      score,
      evidenceProfile,
      targetValue,
    });
  }

  if (
    score < 0.3 &&
    evidenceProfile.cutMature
  ) {
    return baseEngagementRecommendation({
      scenarioType: "scenario_eg3_engagement_inefficient_cut",
      decisionLabel: "cut",
      decisionState: "act",
      priority: "high",
      lens: "profitability",
      input,
      title: `${input.adset.name}: inefficient engagement spend`,
      why: `The ad set scores ${fmtScore(score)} against engagement cohort percentiles after meaningful spend.`,
      summary: `${input.adset.name} is expensive for engagement and has weak quality rate.`,
      recommendedAction: "Pause adset",
      expectedImpact: "Stops spend from compounding into low-quality engagement.",
      evidence,
      score,
      evidenceProfile,
      targetValue,
    });
  }

  if (score < 0.5 && hasFatigue(input)) {
    return baseEngagementRecommendation({
      scenarioType: "scenario_eg4_engagement_refresh",
      decisionLabel: "refresh",
      decisionState: "test",
      priority: "medium",
      lens: "volume",
      input,
      title: `${input.adset.name}: refresh engagement creative`,
      why: `The ad set scores ${fmtScore(score)} and shows engagement fatigue signals.`,
      summary: "Refresh the creative before judging the engagement audience as structurally weak.",
      recommendedAction: "Refresh creative",
      expectedImpact: "Improves engagement quality without prematurely cutting the ad set.",
      evidence: [
        ...evidence,
        { label: "Frequency", value: String(r2(frequencyValue(input))), tone: "warning" },
      ],
      score,
      evidenceProfile,
      targetValue,
    });
  }

  return baseEngagementRecommendation({
      scenarioType: "scenario_eg2_engagement_steady_keep",
      decisionLabel: "keep",
      decisionState: "watch",
      priority: "low",
      lens: "volume",
      input,
      title: `${input.adset.name}: hold engagement delivery`,
      why: `The ad set scores ${fmtScore(score)} against engagement cohort percentiles but is not a mature scale candidate.`,
      summary: "Keep the engagement ad set running and wait for stronger scale or cut evidence.",
      recommendedAction: "Hold",
      expectedImpact: "Preserves useful engagement volume while avoiding premature budget moves.",
      evidence,
      score,
      evidenceProfile,
      targetValue,
  });
}
