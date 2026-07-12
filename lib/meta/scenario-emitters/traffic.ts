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

type TrafficPrimaryMetric = "cost_per_link_click_28d" | "cost_per_lpv_28d";

function r2(value: number) {
  return Math.round((value + Number.EPSILON) * 100) / 100;
}

function currencySymbol(currency: string | null | undefined) {
  if (currency === "TRY") return "TRY ";
  if (currency === "EUR") return "EUR ";
  return "$";
}

function fmtCurrency(value: number | null, currency: string | null | undefined) {
  if (value == null || !Number.isFinite(value)) return "No events";
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

function primaryMetric(adset: MetaAdSetData): TrafficPrimaryMetric {
  const optimizationGoal = String(adset.optimizationGoal ?? "").toUpperCase();
  const customEventType = String(adset.customEventType ?? "").toUpperCase();
  // Dispatch is deterministic from adset configuration: LPV-optimized traffic uses
  // LPV cost calibration; all other traffic adsets use link-click cost calibration.
  if (
    optimizationGoal.includes("LANDING_PAGE_VIEW") ||
    customEventType.includes("LANDING_PAGE_VIEW")
  ) {
    return "cost_per_lpv_28d";
  }
  return "cost_per_link_click_28d";
}

function primaryCount(adset: MetaAdSetData, metric: TrafficPrimaryMetric) {
  if (metric === "cost_per_lpv_28d") return observedNumberField(adset, "landingPageViews");
  return observedNumberField(adset, "linkClicks");
}

function primaryLabel(metric: TrafficPrimaryMetric) {
  return metric === "cost_per_lpv_28d" ? "Cost / LPV" : "Cost / link click";
}

function primaryEvent(metric: TrafficPrimaryMetric) {
  return metric === "cost_per_lpv_28d" ? "landing page views" : "link clicks";
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

function adsetFrequency(adset: MetaAdSetData) {
  return numberField(adset, "frequency");
}

function hasFatigue(input: AdsetScenarioInput) {
  return hasCohortFatigueEvidence({
    context: input.context,
    frequency: adsetFrequency(input.adset),
    ctrDecayPct: input.signals?.ctrDecayPct,
  });
}

function baseTrafficRecommendation(input: {
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
      selectedRangeOverlay: "Selected range traffic metrics are compared against cohort calibration bands.",
      historicalSupport: "Uses traffic cohort percentiles from Meta Engine calibration.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: input.targetValue,
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    campaignRole: input.input.campaignRole,
    bidRegime: input.input.bidRegime,
    cohort: "traffic",
    calibrationScope: input.input.context?.scope ?? {},
    signalQuality: input.input.signals
      ? {
          quality_status: input.input.signals.qualityStatus,
          signal_source: "meta_entity_decision_signals_daily",
        }
      : { quality_status: "missing" },
  };
}

export function emitTrafficAdsetScenario(input: AdsetScenarioInput): MetaRecommendation | null {
  if (input.cohort !== "traffic") return null;

  const metric = primaryMetric(input.adset);
  const primaryThreshold = threshold(input, metric);
  if (!primaryThreshold) return null;

  const count = primaryCount(input.adset, metric);
  if (count == null) return null;

  const primaryValue = count > 0 ? input.adset.spend / count : Number.POSITIVE_INFINITY;
  const primaryRank = count > 0 ? percentileRankInverted(primaryValue, primaryThreshold) : 0;
  if (primaryRank == null) return null;

  const ctrThreshold = threshold(input, "ctr_28d");
  const ctrRank = ctrThreshold ? percentileRank(input.adset.ctr, ctrThreshold) : null;
  if (ctrThreshold && ctrRank == null) return null;

  const score = r2(ctrRank == null ? primaryRank : (0.7 * primaryRank) + (0.3 * ctrRank));
  const currency = (input.adset as MetaAdSetData & { currency?: string | null }).currency ?? null;
  const age = ageDays(input);
  const evidenceProfile = evaluateCohortEvidence({
    context: input.context,
    score,
    eventCount: count,
    spend: input.adset.spend,
    ageDays: age,
  });
  const event = primaryEvent(metric);
  const evidence: MetaRecommendation["evidence"] = [
    { label: "Traffic score", value: fmtScore(score), tone: score >= 0.7 ? "positive" : score < 0.3 ? "warning" : "neutral" },
    { label: primaryLabel(metric), value: fmtCurrency(Number.isFinite(primaryValue) ? primaryValue : null, currency), tone: primaryRank >= 0.7 ? "positive" : primaryRank <= 0.3 ? "warning" : "neutral" },
    { label: "CTR", value: fmtPercent(input.adset.ctr), tone: ctrRank == null ? "neutral" : ctrRank >= 0.7 ? "positive" : ctrRank <= 0.3 ? "warning" : "neutral" },
    { label: event, value: String(count), tone: count > 0 ? "positive" : "warning" },
  ];
  const targetValue = {
    score,
    primary_metric: metric,
    primary_rank: primaryRank,
    primary_value: Number.isFinite(primaryValue) ? primaryValue : null,
    ctr_rank: ctrRank,
    event_count: count,
    age_days: age,
  };

  if (score >= 0.7 && evidenceProfile.scaleMature) {
    return baseTrafficRecommendation({
      scenarioType: "scenario_t1_traffic_efficient_scale",
      decisionLabel: "scale",
      decisionState: "act",
      priority: "high",
      lens: "volume",
      input,
      title: `${input.adset.name}: efficient traffic scale candidate`,
      why: `The ad set scores ${fmtScore(score)} against traffic cohort percentiles with mature signal age.`,
      summary: `${input.adset.name} is buying ${event} efficiently with healthy click quality.`,
      recommendedAction: "Scale budget",
      expectedImpact: "More traffic volume while staying inside cohort-calibrated cost and CTR bands.",
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
    return baseTrafficRecommendation({
      scenarioType: "scenario_t3_traffic_inefficient_cut",
      decisionLabel: "cut",
      decisionState: "act",
      priority: "high",
      lens: "profitability",
      input,
      title: `${input.adset.name}: inefficient traffic spend`,
      why: `The ad set scores ${fmtScore(score)} against traffic cohort percentiles after meaningful spend.`,
      summary: `${input.adset.name} is expensive for ${event} and has weak CTR quality.`,
      recommendedAction: "Pause adset",
      expectedImpact: "Stops spend from compounding into low-quality traffic.",
      evidence,
      score,
      evidenceProfile,
      targetValue,
    });
  }

  if (score < 0.5 && hasFatigue(input)) {
    return baseTrafficRecommendation({
      scenarioType: "scenario_t4_traffic_refresh",
      decisionLabel: "refresh",
      decisionState: "test",
      priority: "medium",
      lens: "volume",
      input,
      title: `${input.adset.name}: refresh traffic creative`,
      why: `The ad set scores ${fmtScore(score)} and shows traffic fatigue signals.`,
      summary: "Refresh the creative before judging the traffic audience as structurally weak.",
      recommendedAction: "Refresh creative",
      expectedImpact: "Improves traffic quality without prematurely cutting the ad set.",
      evidence: [
        ...evidence,
        { label: "Frequency", value: String(r2(adsetFrequency(input.adset))), tone: "warning" },
      ],
      score,
      evidenceProfile,
      targetValue,
    });
  }

  return baseTrafficRecommendation({
      scenarioType: "scenario_t2_traffic_steady_keep",
      decisionLabel: "keep",
      decisionState: "watch",
      priority: "low",
      lens: "volume",
      input,
      title: `${input.adset.name}: hold traffic delivery`,
      why: `The ad set scores ${fmtScore(score)} against traffic cohort percentiles but is not a mature scale candidate.`,
      summary: "Keep the traffic ad set running and wait for stronger scale or cut evidence.",
      recommendedAction: "Hold",
      expectedImpact: "Preserves useful traffic volume while avoiding premature budget moves.",
      evidence,
      score,
      evidenceProfile,
      targetValue,
  });
}
