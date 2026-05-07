import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import type { MetaAdSetData } from "@/lib/api/meta";
import type {
  MetaCalibrationContext,
  MetaRecommendation,
} from "@/lib/meta/recommendations";
import {
  calculateMetaStatisticalConfidence,
  META_RECOMMENDATION_ENGINE_VERSION,
} from "@/lib/meta/recommendations";
import { LEGACY_META_CALIBRATION_THRESHOLDS } from "@/lib/meta/calibration";
import {
  inferBidRegime,
  inferCampaignRole,
} from "@/lib/meta/campaign-roles";
import { buildMetaCampaignLaneSignals } from "@/lib/meta/campaign-lanes";
import type { MetaBidRegime, MetaCampaignRole } from "@/lib/meta/types";

export interface BuildMetaAdsetRecommendationsInput {
  adsets: MetaAdSetData[];
  campaigns?: MetaCampaignRow[];
  calibrationContext?: MetaCalibrationContext | null;
  calibrationContextByCampaignId?: Record<string, MetaCalibrationContext | null | undefined>;
}

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function currencySymbol(currency: string | null | undefined) {
  if (currency === "TRY") return "TRY ";
  if (currency === "EUR") return "EUR ";
  return "$";
}

function fmtCurrency(value: number, currency: string | null | undefined) {
  const symbol = currencySymbol(currency);
  return `${symbol}${value.toLocaleString(undefined, {
    minimumFractionDigits: 2,
    maximumFractionDigits: 2,
  })}`;
}

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

function contextForAdset(
  input: BuildMetaAdsetRecommendationsInput,
  adset: MetaAdSetData,
): MetaCalibrationContext | null {
  return input.calibrationContextByCampaignId?.[adset.campaignId] ??
    input.calibrationContext ??
    null;
}

function metricThresholds(
  context: MetaCalibrationContext | null,
  metric: keyof typeof LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
) {
  return context?.thresholds.metrics[metric] ?? LEGACY_META_CALIBRATION_THRESHOLDS.metrics[metric];
}

function hardCutSpend(context: MetaCalibrationContext | null) {
  return context?.thresholds.hardCutSpend ?? LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend;
}

function minRequiredSample(context: MetaCalibrationContext | null) {
  return context?.thresholds.minRequiredSample ??
    LEGACY_META_CALIBRATION_THRESHOLDS.minRequiredSample;
}

function adsetFrequency(adset: MetaAdSetData) {
  const value = (adset as MetaAdSetData & { frequency?: number | null }).frequency;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function confidence(input: {
  context: MetaCalibrationContext | null;
  metricValue: number;
  threshold: number;
  severeLoser?: boolean;
}) {
  const roas = metricThresholds(input.context, "roas_28d");
  return calculateMetaStatisticalConfidence({
    level: "adset",
    metricValue: input.metricValue,
    threshold: input.threshold,
    sampleSize: roas.sampleSize,
    minRequiredSample: minRequiredSample(input.context),
    severeLoser: input.severeLoser,
  });
}

function baseAdsetRecommendation(input: {
  adset: MetaAdSetData;
  type: MetaRecommendation["type"];
  lens: MetaRecommendation["lens"];
  priority: MetaRecommendation["priority"];
  confidence: ReturnType<typeof calculateMetaStatisticalConfidence>;
  decisionState: MetaRecommendation["decisionState"];
  decision: string;
  title: string;
  why: string;
  summary: string;
  recommendedAction: string;
  expectedImpact: string;
  evidence: MetaRecommendation["evidence"];
  campaignName?: string;
  campaignRole?: MetaCampaignRole;
  bidRegime?: MetaBidRegime;
}): MetaRecommendation {
  return {
    id: `${input.type}-${input.adset.id}`,
    level: "adset",
    campaignId: input.adset.campaignId,
    campaignName: input.campaignName,
    adsetId: input.adset.id,
    adsetName: input.adset.name,
    type: input.type,
    lens: input.lens,
    priority: input.priority,
    confidence: input.confidence.label,
    confidenceScore: input.confidence.score,
    confidenceReason: input.confidence.reason ?? null,
    decisionState: input.decisionState,
    decision: input.decision,
    title: input.title,
    why: input.why,
    summary: input.summary,
    recommendedAction: input.recommendedAction,
    expectedImpact: input.expectedImpact,
    evidence: input.evidence,
    timeframeContext: {
      coreVerdict: "Ad set verdict is based on calibrated account or campaign ad set percentiles.",
      selectedRangeOverlay: "Selected range ad set metrics are compared against the calibrated distribution.",
      historicalSupport: "Calibration uses recent mature ad set samples from the Meta warehouse.",
      seasonalityFlag: "none",
      note: null,
    },
    engineVersion: META_RECOMMENDATION_ENGINE_VERSION,
    campaignRole: input.campaignRole,
    bidRegime: input.bidRegime,
  };
}

export function buildMetaAdsetRecommendations(
  input: BuildMetaAdsetRecommendationsInput,
): MetaRecommendation[] {
  const activeAdsets = input.adsets.filter((adset) => adset.status === "ACTIVE");
  const campaigns = input.campaigns ?? [];
  const campaignsById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const laneSignals = buildMetaCampaignLaneSignals(campaigns);
  const recommendations: MetaRecommendation[] = [];

  for (const adset of activeAdsets) {
    const context = contextForAdset(input, adset);
    const campaign = campaignsById.get(adset.campaignId) ?? null;
    const taxonomyFields = {
      campaignName: campaign?.name,
      campaignRole: campaign
        ? inferCampaignRole(campaign, { campaigns, laneSignals })
        : undefined,
      bidRegime: inferBidRegime(adset, campaign),
    };
    const roas = metricThresholds(context, "roas_28d");
    const cpa = metricThresholds(context, "cpa_28d");
    const ctr = metricThresholds(context, "ctr_28d");
    const frequency = metricThresholds(context, "freq_14d");
    const cpm = metricThresholds(context, "cpm_14d");

    const scaleThreshold = context ? roas.p75 : Math.max(roas.p75, 2.5);
    const weakThreshold = context ? roas.p25 : Math.max(roas.p25, 1.5);
    const severeLoser = adset.roas < roas.p10 && adset.spend > hardCutSpend(context);
    const currency = (adset as MetaAdSetData & { currency?: string | null }).currency ?? null;

    if (
      adset.purchases >= 8 &&
      adset.roas >= scaleThreshold &&
      (adset.cpa <= 0 || adset.cpa <= cpa.p75)
    ) {
      const confidenceResult = confidence({
        context,
        metricValue: adset.roas,
        threshold: scaleThreshold,
      });
      recommendations.push(baseAdsetRecommendation({
        adset,
        ...taxonomyFields,
        type: "adset_scale_budget",
        lens: "volume",
        priority: "high",
        confidence: confidenceResult,
        decisionState: confidenceResult.score >= 0.7 ? "act" : "test",
        decision: "Scale this ad set carefully",
        title: `${adset.name}: ad set can absorb more budget`,
        why: "The ad set is above the calibrated ROAS line with enough purchase depth to justify a controlled scale test.",
        summary: `${adset.name} is at ${fmtRoas(adset.roas)} ROAS on ${adset.purchases} purchases.`,
        recommendedAction: "Increase ad set budget 10-15% and watch CPA, ROAS, and delivery for the next 48-72 hours.",
        expectedImpact: "More conversion volume while keeping the scale move bounded.",
        evidence: [
          { label: "Ad set ROAS", value: fmtRoas(adset.roas), tone: "positive" },
          { label: "ROAS p75", value: fmtRoas(roas.p75), tone: "neutral" },
          { label: "Purchases", value: String(adset.purchases), tone: "positive" },
        ],
      }));
      continue;
    }

    if (adset.spend >= hardCutSpend(context) && adset.roas < weakThreshold) {
      const confidenceResult = confidence({
        context,
        metricValue: adset.roas,
        threshold: weakThreshold,
        severeLoser,
      });
      recommendations.push(baseAdsetRecommendation({
        adset,
        ...taxonomyFields,
        type: "adset_cut_spend",
        lens: "profitability",
        priority: severeLoser ? "high" : "medium",
        confidence: confidenceResult,
        decisionState: severeLoser || confidenceResult.score >= 0.7 ? "act" : "test",
        decision: "Cut or cap this ad set",
        title: `${adset.name}: ad set is below the calibrated efficiency line`,
        why: "The ad set is consuming meaningful spend while trailing calibrated ROAS expectations.",
        summary: `${adset.name} has spent ${fmtCurrency(adset.spend, currency)} at ${fmtRoas(adset.roas)} ROAS.`,
        recommendedAction: "Reduce budget pressure or pause the ad set, then reallocate spend toward stronger ad sets in the same campaign.",
        expectedImpact: "Lower waste and cleaner campaign-level budget allocation.",
        evidence: [
          { label: "Ad set spend", value: fmtCurrency(adset.spend, currency), tone: "warning" },
          { label: "Ad set ROAS", value: fmtRoas(adset.roas), tone: "warning" },
          { label: "ROAS p25", value: fmtRoas(roas.p25), tone: "neutral" },
          ...(severeLoser
            ? [{ label: "Severe loser bypass", value: "active", tone: "warning" as const }]
            : []),
        ],
      }));
      continue;
    }

    if (
      adsetFrequency(adset) >= frequency.p75 &&
      adset.ctr > 0 &&
      adset.ctr <= ctr.p25 &&
      adset.cpm >= cpm.p50
    ) {
      const confidenceResult = confidence({
        context,
        metricValue: adset.ctr,
        threshold: ctr.p25,
      });
      recommendations.push(baseAdsetRecommendation({
        adset,
        ...taxonomyFields,
        type: "adset_watch_learning",
        lens: "structure",
        priority: "low",
        confidence: confidenceResult,
        decisionState: "watch",
        decision: "Watch fatigue before scaling",
        title: `${adset.name}: delivery looks fatigue-prone`,
        why: "Frequency is high while CTR is below the calibrated lower quartile.",
        summary: `${adset.name} is at ${r2(adsetFrequency(adset))} frequency and ${r2(adset.ctr)}% CTR.`,
        recommendedAction: "Hold budget increases and refresh creative or audience pressure before trying to scale this ad set.",
        expectedImpact: "Lower risk of scaling into stale delivery.",
        evidence: [
          { label: "Frequency", value: String(r2(adsetFrequency(adset))), tone: "warning" },
          { label: "CTR", value: `${r2(adset.ctr)}%`, tone: "warning" },
          { label: "CTR p25", value: `${r2(ctr.p25)}%`, tone: "neutral" },
        ],
      }));
    }
  }

  return recommendations
    .sort((left, right) => (right.confidenceScore ?? 0) - (left.confidenceScore ?? 0))
    .slice(0, 5);
}
