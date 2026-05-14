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
  if (value == null || !Number.isFinite(value)) return "No leads";
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

function ageDays(input: AdsetScenarioInput) {
  const explicitAge = (input.adset as MetaAdSetData & { ageDays?: unknown }).ageDays;
  if (typeof explicitAge === "number" && Number.isFinite(explicitAge)) return explicitAge;
  const sourceAge = input.signals?.sourceJson?.age_days;
  if (typeof sourceAge === "number" && Number.isFinite(sourceAge)) return sourceAge;
  const parsedSourceAge = sourceAge == null ? null : Number(sourceAge);
  if (parsedSourceAge != null && Number.isFinite(parsedSourceAge)) return parsedSourceAge;
  return null;
}

function spendMaturityFloor(input: AdsetScenarioInput) {
  const metrics = input.context?.thresholds.metrics as
    | Record<string, MetaMetricPercentiles | undefined>
    | undefined;
  const spendThreshold = metrics?.spend_28d;
  return spendThreshold ? spendThreshold.p50 * 0.3 : 0;
}

function isMature(input: AdsetScenarioInput) {
  const age = ageDays(input);
  if (age == null || age < 14) return false;
  return input.adset.spend >= spendMaturityFloor(input);
}

function adsetFrequency(adset: MetaAdSetData) {
  return numberField(adset, "frequency");
}

function hasFatigue(input: AdsetScenarioInput) {
  const frequencyThreshold = threshold(input, "freq_14d")?.p75 ?? 2.5;
  const ctrThreshold =
    threshold(input, "ctr_28d")?.p25 ??
    LEGACY_META_CALIBRATION_THRESHOLDS.metrics.ctr_28d.p25;
  const frequencyFatigue = adsetFrequency(input.adset) > frequencyThreshold;
  const ctrFatigue = input.adset.ctr > 0 && input.adset.ctr < ctrThreshold;
  return frequencyFatigue || ctrFatigue;
}

function baseLeadRecommendation(input: {
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
    confidence: confidenceFromScore(input.score),
    confidenceScore: r2(input.score),
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
      selectedRangeOverlay: "Selected range lead metrics are compared against cohort calibration bands.",
      historicalSupport: "Uses lead cohort percentiles from Meta Engine calibration.",
      seasonalityFlag: "none",
      note: null,
    },
    targetValue: input.targetValue,
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    campaignRole: input.input.campaignRole,
    bidRegime: input.input.bidRegime,
    cohort: "lead",
    calibrationScope: input.input.context?.scope ?? {},
    signalQuality: input.input.signals
      ? {
          quality_status: input.input.signals.qualityStatus,
          signal_source: "meta_entity_decision_signals_daily",
        }
      : { quality_status: "missing" },
  };
}

export function emitLeadAdsetScenario(input: AdsetScenarioInput): MetaRecommendation | null {
  if (input.cohort !== "lead") return null;

  const costThreshold = threshold(input, "cost_per_lead_28d");
  if (!costThreshold) return null;

  const leads = numberField(input.adset, "leads");
  const purchases = numberField(input.adset, "purchases");
  const costPerLead = leads > 0 ? input.adset.spend / leads : Number.POSITIVE_INFINITY;
  const baseRank = leads > 0 ? percentileRankInverted(costPerLead, costThreshold) : 0;
  if (baseRank == null) return null;

  const leadToPurchaseThreshold = threshold(input, "lead_to_purchase_rate_28d");
  const hasPixelPurchaseBonus = purchases > 0 && leads > 0 && Boolean(leadToPurchaseThreshold);
  const leadToPurchaseRate = hasPixelPurchaseBonus ? (purchases / leads) * 100 : 0;
  const leadToPurchaseRank =
    hasPixelPurchaseBonus && leadToPurchaseThreshold
      ? percentileRank(leadToPurchaseRate, leadToPurchaseThreshold)
      : null;
  if (hasPixelPurchaseBonus && leadToPurchaseRank == null) return null;

  const score = r2(
    hasPixelPurchaseBonus && leadToPurchaseRank != null
      ? (0.7 * baseRank) + (0.3 * leadToPurchaseRank)
      : baseRank,
  );
  const currency = (input.adset as MetaAdSetData & { currency?: string | null }).currency ?? null;
  const mature = isMature(input);
  const age = ageDays(input);
  const evidence: MetaRecommendation["evidence"] = [
    { label: "Lead score", value: fmtScore(score), tone: score >= 0.7 ? "positive" : score < 0.3 ? "warning" : "neutral" },
    { label: "Cost / lead", value: fmtCurrency(Number.isFinite(costPerLead) ? costPerLead : null, currency), tone: baseRank >= 0.7 ? "positive" : baseRank <= 0.3 ? "warning" : "neutral" },
    { label: "Leads", value: String(leads), tone: leads > 0 ? "positive" : "warning" },
    ...(hasPixelPurchaseBonus && leadToPurchaseRank != null
      ? [
          {
            label: "Lead to purchase",
            value: fmtPercent(leadToPurchaseRate),
            tone: leadToPurchaseRank >= 0.7 ? "positive" : leadToPurchaseRank <= 0.3 ? "warning" : "neutral",
          } as const,
        ]
      : []),
  ];
  const targetValue = {
    score,
    base_rank: baseRank,
    lead_to_purchase_rank: leadToPurchaseRank,
    lead_to_purchase_rate: hasPixelPurchaseBonus ? leadToPurchaseRate : null,
    pixel_purchase_bonus_applied: hasPixelPurchaseBonus,
    cost_per_lead: Number.isFinite(costPerLead) ? costPerLead : null,
    leads,
    purchases,
    age_days: age,
  };

  if (score >= 0.7 && mature) {
    return baseLeadRecommendation({
      scenarioType: "scenario_l1_lead_efficient_scale",
      decisionLabel: "scale",
      decisionState: "act",
      priority: "high",
      lens: "volume",
      input,
      title: `${input.adset.name}: efficient lead scale candidate`,
      why: `The ad set scores ${fmtScore(score)} against lead cohort percentiles with mature signal age.`,
      summary: `${input.adset.name} is generating leads efficiently enough to test more budget.`,
      recommendedAction: "Scale budget",
      expectedImpact: "More lead volume while staying inside cohort-calibrated CPL bands.",
      evidence,
      score,
      targetValue,
    });
  }

  if (
    score < 0.3 &&
    mature &&
    input.adset.spend > (input.context?.thresholds.hardCutSpend ?? LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend)
  ) {
    return baseLeadRecommendation({
      scenarioType: "scenario_l3_lead_inefficient_cut",
      decisionLabel: "cut",
      decisionState: "act",
      priority: "high",
      lens: "profitability",
      input,
      title: `${input.adset.name}: inefficient lead spend`,
      why: `The ad set scores ${fmtScore(score)} against lead cohort percentiles after meaningful spend.`,
      summary: `${input.adset.name} is expensive for lead volume and lacks enough downstream purchase credit.`,
      recommendedAction: "Pause adset",
      expectedImpact: "Stops spend from compounding into weak lead acquisition.",
      evidence,
      score,
      targetValue,
    });
  }

  if (score < 0.5 && hasFatigue(input)) {
    return baseLeadRecommendation({
      scenarioType: "scenario_l4_lead_refresh",
      decisionLabel: "refresh",
      decisionState: "test",
      priority: "medium",
      lens: "volume",
      input,
      title: `${input.adset.name}: refresh lead creative`,
      why: `The ad set scores ${fmtScore(score)} and shows frequency or CTR fatigue signals.`,
      summary: "Refresh the creative before judging the lead offer as structurally weak.",
      recommendedAction: "Refresh creative",
      expectedImpact: "Improves lead capture freshness without prematurely cutting the ad set.",
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
    return baseLeadRecommendation({
      scenarioType: "scenario_l2_lead_steady_keep",
      decisionLabel: "keep",
      decisionState: "watch",
      priority: "low",
      lens: "volume",
      input,
      title: `${input.adset.name}: hold lead delivery`,
      why: `The ad set scores ${fmtScore(score)} against lead cohort percentiles but is not a mature scale candidate.`,
      summary: "Keep the lead ad set running and wait for stronger scale or cut evidence.",
      recommendedAction: "Hold",
      expectedImpact: "Preserves useful lead volume while avoiding premature budget moves.",
      evidence,
      score,
      targetValue,
    });
  }

  return null;
}
