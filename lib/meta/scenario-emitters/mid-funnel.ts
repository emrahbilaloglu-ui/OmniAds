import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS, type MetaCalibrationMetricName, type MetaMetricPercentiles } from "@/lib/meta/calibration";
import { META_RECOMMENDATION_ENGINE_VERSION, type MetaRecommendation } from "@/lib/meta/recommendations";
import type { AdsetScenarioInput } from "@/lib/meta/scenario-emitters/high-priority";

type MidFunnelMetricKind = "atc" | "ic" | "vc";

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function currencySymbol(currency: string | null | undefined) {
  if (currency === "TRY") return "TRY ";
  if (currency === "EUR") return "EUR ";
  return "$";
}

function fmtCurrency(value: number, currency: string | null | undefined) {
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

function confidenceFromScore(score: number): MetaRecommendation["confidence"] {
  if (score >= 0.85 || score <= 0.15) return "high";
  if ((score >= 0.7 && score < 0.85) || (score > 0.15 && score <= 0.3)) {
    return "medium";
  }
  return "low";
}

function confidenceScoreFromScore(score: number) {
  return r2(score >= 0.5 ? score : 1 - score);
}

function numberField(adset: MetaAdSetData, key: keyof MetaAdSetData) {
  const value = adset[key];
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
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

function firstThreshold(
  input: AdsetScenarioInput,
  names: MetaCalibrationMetricName[],
) {
  for (const name of names) {
    const percentiles = threshold(input, name);
    if (percentiles) return percentiles;
  }
  return null;
}

function percentileRank(input: {
  value: number;
  thresholds: MetaMetricPercentiles;
  lowerIsBetter?: boolean;
}) {
  const { value, thresholds, lowerIsBetter = false } = input;
  if (!Number.isFinite(value)) return null;
  if (thresholds.p90 === thresholds.p10) return 0.5;
  if (lowerIsBetter) {
    if (value <= thresholds.p10) return 1;
    if (value >= thresholds.p90) return 0;
    return 1 - ((value - thresholds.p10) / (thresholds.p90 - thresholds.p10));
  }
  if (value <= thresholds.p10) return 0;
  if (value >= thresholds.p90) return 1;
  return (value - thresholds.p10) / (thresholds.p90 - thresholds.p10);
}

function midFunnelMetricKind(adset: MetaAdSetData): MidFunnelMetricKind {
  const customEventType = String(adset.customEventType ?? "").toUpperCase();
  if (customEventType.includes("INITIATE_CHECKOUT")) return "ic";
  if (customEventType.includes("VIEW_CONTENT") || customEventType.includes("CONTENT_VIEW")) return "vc";
  return "atc";
}

function eventCount(adset: MetaAdSetData, kind: MidFunnelMetricKind) {
  if (kind === "ic") return numberField(adset, "initiateCheckout");
  if (kind === "vc") return numberField(adset, "viewContent");
  return numberField(adset, "addToCart");
}

function costThresholdNames(kind: MidFunnelMetricKind): MetaCalibrationMetricName[] {
  // Phase 2a calibrates IC/VC cost rows, but rate rows are still shared through the
  // mid_funnel ATC-rate distribution until dedicated IC/VC rate metrics exist.
  if (kind === "ic") return ["cost_per_ic_28d", "cost_per_atc_28d"];
  if (kind === "vc") return ["cost_per_vc_28d", "cost_per_atc_28d"];
  return ["cost_per_atc_28d"];
}

function eventLabel(kind: MidFunnelMetricKind) {
  if (kind === "ic") return "initiate checkout";
  if (kind === "vc") return "view content";
  return "add to cart";
}

function costMetricLabel(kind: MidFunnelMetricKind) {
  if (kind === "ic") return "Cost / IC";
  if (kind === "vc") return "Cost / VC";
  return "Cost / ATC";
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

function isMature(input: AdsetScenarioInput) {
  const age = ageDays(input);
  if (age == null || age < 14) return false;
  return true;
}

function adsetFrequency(adset: MetaAdSetData) {
  return numberField(adset, "frequency");
}

function hasFatigue(input: AdsetScenarioInput) {
  const frequencyThreshold = threshold(input, "freq_14d")?.p75 ?? 2.5;
  const ctrThreshold = threshold(input, "ctr_28d")?.p25 ?? LEGACY_META_CALIBRATION_THRESHOLDS.metrics.ctr_28d.p25;
  return adsetFrequency(input.adset) > frequencyThreshold && input.adset.ctr > 0 && input.adset.ctr < ctrThreshold;
}

function baseMidFunnelRecommendation(input: {
  scenarioType: MetaRecommendation["type"];
  decisionLabel: NonNullable<MetaRecommendation["decisionLabel"]>;
  decisionState: MetaRecommendation["decisionState"];
  priority: MetaRecommendation["priority"];
  input: AdsetScenarioInput;
  title: string;
  why: string;
  summary: string;
  recommendedAction: string;
  expectedImpact: string;
  score: number;
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
    lens: input.decisionLabel === "cut" ? "profitability" : "volume",
    priority: input.priority,
    confidence: confidenceFromScore(input.score),
    confidenceScore: confidenceScoreFromScore(input.score),
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
      selectedRangeOverlay: "Selected range mid-funnel metrics are compared against cohort calibration bands.",
      historicalSupport: "Uses mid_funnel cohort percentiles from Meta Engine calibration.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: input.targetValue,
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    campaignRole: input.input.campaignRole,
    bidRegime: input.input.bidRegime,
    cohort: "mid_funnel",
    calibrationScope: input.input.context?.scope ?? {},
    signalQuality: input.input.signals
      ? {
          quality_status: input.input.signals.qualityStatus,
          signal_source: "meta_entity_decision_signals_daily",
        }
      : { quality_status: "missing" },
  };
}

export function emitMidFunnelAdsetScenario(input: AdsetScenarioInput): MetaRecommendation | null {
  if (input.cohort !== "mid_funnel") return null;

  const kind = midFunnelMetricKind(input.adset);
  const count = eventCount(input.adset, kind);
  const costThreshold = firstThreshold(input, costThresholdNames(kind));
  const rateThreshold = threshold(input, "atc_rate_28d");
  const purchaseRateThreshold = threshold(input, "atc_to_purchase_rate_28d");
  if (!costThreshold || !rateThreshold || !purchaseRateThreshold) return null;
  if (input.adset.spend <= 0 || count <= 0) return null;

  const costPerEvent = input.adset.spend / count;
  const eventRate = input.adset.impressions > 0 ? (count / input.adset.impressions) * 100 : 0;
  const eventToPurchaseRate = count > 0 ? (input.adset.purchases / count) * 100 : 0;
  const costRank = percentileRank({ value: costPerEvent, thresholds: costThreshold, lowerIsBetter: true });
  const rateRank = percentileRank({ value: eventRate, thresholds: rateThreshold });
  const purchaseRank = percentileRank({ value: eventToPurchaseRate, thresholds: purchaseRateThreshold });
  if (costRank == null || rateRank == null || purchaseRank == null) return null;

  const score = r2((0.5 * costRank) + (0.2 * rateRank) + (0.3 * purchaseRank));
  const currency = (input.adset as MetaAdSetData & { currency?: string | null }).currency ?? null;
  const mature = isMature(input);
  const age = ageDays(input);
  const event = eventLabel(kind);
  const evidence: MetaRecommendation["evidence"] = [
    { label: "Mid-funnel score", value: fmtScore(score), tone: score >= 0.7 ? "positive" : score < 0.3 ? "warning" : "neutral" },
    { label: costMetricLabel(kind), value: fmtCurrency(costPerEvent, currency), tone: costRank >= 0.7 ? "positive" : costRank <= 0.3 ? "warning" : "neutral" },
    { label: `${event} rate`, value: fmtPercent(eventRate), tone: rateRank >= 0.7 ? "positive" : rateRank <= 0.3 ? "warning" : "neutral" },
    { label: `${event} to purchase`, value: fmtPercent(eventToPurchaseRate), tone: purchaseRank >= 0.7 ? "positive" : purchaseRank <= 0.3 ? "warning" : "neutral" },
  ];
  const targetValue = {
    score,
    cost_rank: costRank,
    event_rate_rank: rateRank,
    event_to_purchase_rank: purchaseRank,
    event,
    event_count: count,
    age_days: age,
  };

  if (score >= 0.7 && mature) {
    return baseMidFunnelRecommendation({
      scenarioType: "scenario_m1_mid_funnel_efficient_scale",
      decisionLabel: "scale",
      decisionState: "act",
      priority: "high",
      input,
      title: `${input.adset.name}: efficient mid-funnel scale candidate`,
      why: `The ad set scores ${fmtScore(score)} against mid_funnel cohort percentiles with mature signal age.`,
      summary: `${input.adset.name} is generating ${event} signals efficiently enough to test more budget.`,
      recommendedAction: "Scale budget",
      expectedImpact: "More mid-funnel signal volume while staying inside cohort-calibrated efficiency bands.",
      evidence,
      score,
      targetValue,
    });
  }

  if (score < 0.3 && mature && input.adset.spend > (input.context?.thresholds.hardCutSpend ?? LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend)) {
    return baseMidFunnelRecommendation({
      scenarioType: "scenario_m3_mid_funnel_inefficient_cut",
      decisionLabel: "cut",
      decisionState: "act",
      priority: "high",
      input,
      title: `${input.adset.name}: inefficient mid-funnel spend`,
      why: `The ad set scores ${fmtScore(score)} against mid_funnel cohort percentiles after meaningful spend.`,
      summary: `${input.adset.name} is expensive for ${event} signals and has weak downstream conversion rate.`,
      recommendedAction: "Pause adset",
      expectedImpact: "Stops spend from compounding into weak mid-funnel traffic.",
      evidence,
      score,
      targetValue,
    });
  }

  if (score < 0.5 && hasFatigue(input)) {
    return baseMidFunnelRecommendation({
      scenarioType: "scenario_m4_mid_funnel_refresh",
      decisionLabel: "refresh",
      decisionState: "test",
      priority: "medium",
      input,
      title: `${input.adset.name}: refresh mid-funnel creative`,
      why: `The ad set scores ${fmtScore(score)} and shows frequency/CTR fatigue signals.`,
      summary: "Refresh the creative before judging the mid-funnel event as structurally weak.",
      recommendedAction: "Refresh creative",
      expectedImpact: "Improves signal freshness without prematurely cutting the ad set.",
      evidence: [
        ...evidence,
        { label: "Frequency", value: String(r2(adsetFrequency(input.adset))), tone: "warning" },
        { label: "CTR", value: fmtPercent(input.adset.ctr), tone: "warning" },
      ],
      score,
      targetValue,
    });
  }

  if (score >= 0.5) {
    return baseMidFunnelRecommendation({
      scenarioType: "scenario_m2_mid_funnel_steady_keep",
      decisionLabel: "keep",
      decisionState: "watch",
      priority: "low",
      input,
      title: `${input.adset.name}: hold mid-funnel delivery`,
      why: `The ad set scores ${fmtScore(score)} against mid_funnel cohort percentiles but is not a mature scale candidate.`,
      summary: "Keep the ad set running and wait for stronger scale or cut evidence.",
      recommendedAction: "Hold",
      expectedImpact: "Preserves useful mid-funnel signal while avoiding premature budget moves.",
      evidence,
      score,
      targetValue,
    });
  }

  return null;
}
