import { formatMoney } from "@/components/creatives/money";
import type { MetaAdSetData } from "@/lib/api/meta";
import { LEGACY_META_CALIBRATION_THRESHOLDS, type MetaCalibrationMetricName, type MetaMetricPercentiles } from "@/lib/meta/calibration";
import { META_RECOMMENDATION_ENGINE_VERSION, type MetaRecommendation } from "@/lib/meta/recommendations";
import {
  evaluateCohortEvidence,
  hasCohortFatigueEvidence,
  type CohortEvidenceProfile,
} from "@/lib/meta/scenario-emitters/cohort-evidence";
import type { AdsetScenarioInput } from "@/lib/meta/scenario-emitters/high-priority";
import { percentileRank, percentileRankInverted } from "@/lib/meta/scenario-emitters/scoring-utils";

type MidFunnelMetricKind = "atc" | "ic" | "vc";

function r2(value: number) {
  return Math.round(value * 100) / 100;
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

function midFunnelMetricKind(adset: MetaAdSetData): MidFunnelMetricKind {
  const customEventType = String(adset.customEventType ?? "").toUpperCase();
  if (customEventType.includes("INITIATE_CHECKOUT")) return "ic";
  if (customEventType.includes("VIEW_CONTENT") || customEventType.includes("CONTENT_VIEW")) return "vc";
  return "atc";
}

function eventCount(adset: MetaAdSetData, kind: MidFunnelMetricKind) {
  if (kind === "ic") return observedNumberField(adset, "initiateCheckout");
  if (kind === "vc") return observedNumberField(adset, "viewContent");
  return observedNumberField(adset, "addToCart");
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
    lens: input.decisionLabel === "cut" ? "profitability" : "volume",
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
  if (count == null) return null;
  const costThreshold = firstThreshold(input, costThresholdNames(kind));
  const rateThreshold = threshold(input, "atc_rate_28d");
  const purchaseRateThreshold = threshold(input, "atc_to_purchase_rate_28d");
  if (!costThreshold || !rateThreshold || !purchaseRateThreshold) return null;
  if (input.adset.spend <= 0) return null;

  const costPerEvent = count > 0 ? input.adset.spend / count : Number.POSITIVE_INFINITY;
  const eventRate = input.adset.impressions > 0 ? (count / input.adset.impressions) * 100 : 0;
  const eventToPurchaseRate = count > 0 ? (input.adset.purchases / count) * 100 : 0;
  const costRank = count > 0 ? percentileRankInverted(costPerEvent, costThreshold) : 0;
  const rateRank = percentileRank(eventRate, rateThreshold);
  const purchaseRank = percentileRank(eventToPurchaseRate, purchaseRateThreshold);
  if (costRank == null || rateRank == null || purchaseRank == null) return null;

  const score = r2((0.5 * costRank) + (0.2 * rateRank) + (0.3 * purchaseRank));
  const currency = (input.adset as MetaAdSetData & { currency?: string | null }).currency ?? null;
  const age = ageDays(input);
  const evidenceProfile = evaluateCohortEvidence({
    context: input.context,
    score,
    eventCount: count,
    spend: input.adset.spend,
    ageDays: age,
  });
  const event = eventLabel(kind);
  const evidence: MetaRecommendation["evidence"] = [
    { label: "Mid-funnel score", value: fmtScore(score), tone: score >= 0.7 ? "positive" : score < 0.3 ? "warning" : "neutral" },
    { label: costMetricLabel(kind), value: Number.isFinite(costPerEvent) ? formatMoney(costPerEvent, currency, null) : "No events", tone: costRank >= 0.7 ? "positive" : costRank <= 0.3 ? "warning" : "neutral" },
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

  if (score >= 0.7 && evidenceProfile.scaleMature) {
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
      evidenceProfile,
      targetValue,
    });
  }

  if (score < 0.3 && evidenceProfile.cutMature) {
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
      evidenceProfile,
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
      evidenceProfile,
      targetValue,
    });
  }

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
      evidenceProfile,
      targetValue,
  });
}
