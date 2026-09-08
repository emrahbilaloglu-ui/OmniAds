import type { MetaCampaignRow } from "@/app/api/meta/campaigns/route";
import { formatMoney } from "@/components/creatives/money";
import { META_CONFIDENCE_ACT_THRESHOLD } from "@/lib/meta/confidence-thresholds";
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
import { emitHighPriorityAdsetScenario } from "@/lib/meta/scenario-emitters/high-priority";
import type { MetaEntityDecisionSignal } from "@/lib/meta/entity-signals";
import { metaRecentEditAuthorityReady } from "@/lib/meta/recent-edit-authority";
import {
  isPurchaseCohort,
  resolveMetaFunnelCohort,
  type MetaFunnelCohort,
} from "@/lib/meta/funnel-cohort";
import {
  metaCutRoasReviewCeiling,
  metaLossBudgetMaturity,
  metaRelativeCutRoasCeiling,
  metaScaleRoasFloor,
  resolveMetaPurchaseValueAuthority,
  type MetaCommercialTargets,
} from "@/lib/meta/commercial-targets";
import { enforceMetaCommercialActionAuthority } from "@/lib/meta/commercial-action-authority";
import { withMetaAutomationReadiness } from "@/lib/meta/automation-readiness";
import { emitEngagementAdsetScenario } from "@/lib/meta/scenario-emitters/engagement";
import { emitLeadAdsetScenario } from "@/lib/meta/scenario-emitters/lead";
import { emitMidFunnelAdsetScenario } from "@/lib/meta/scenario-emitters/mid-funnel";
import { emitTrafficAdsetScenario } from "@/lib/meta/scenario-emitters/traffic";

export interface BuildMetaAdsetRecommendationsInput {
  adsets: MetaAdSetData[];
  campaigns?: MetaCampaignRow[];
  calibrationContext?: MetaCalibrationContext | null;
  calibrationContextByAdsetId?: Record<string, MetaCalibrationContext | null | undefined>;
  calibrationContextByCampaignId?: Record<string, MetaCalibrationContext | null | undefined>;
  entitySignalsByAdsetId?: Record<string, MetaEntityDecisionSignal | null | undefined>;
  commercialTargets?: MetaCommercialTargets | null;
}

function r2(value: number) {
  return Math.round(value * 100) / 100;
}

function fmtRoas(value: number) {
  return `${value.toFixed(2)}x`;
}

function contextForAdset(
  input: BuildMetaAdsetRecommendationsInput,
  adset: MetaAdSetData,
): MetaCalibrationContext | null {
  return input.calibrationContextByAdsetId?.[adset.id] ??
    input.calibrationContextByCampaignId?.[adset.campaignId] ??
    input.calibrationContext ??
    null;
}

function metricThresholds(
  context: MetaCalibrationContext | null,
  metric: keyof typeof LEGACY_META_CALIBRATION_THRESHOLDS.metrics,
) {
  return context?.thresholds.metrics[metric] ?? LEGACY_META_CALIBRATION_THRESHOLDS.metrics[metric];
}

function minRequiredSample(context: MetaCalibrationContext | null) {
  return context?.thresholds.minRequiredSample ??
    LEGACY_META_CALIBRATION_THRESHOLDS.minRequiredSample;
}

function commercialTargetEvidence(
  targets: MetaCommercialTargets | null | undefined,
  currency: string | null | undefined,
): MetaRecommendation["evidence"] {
  const evidence: MetaRecommendation["evidence"] = [];
  if (targets?.targetRoas) evidence.push({ label: "Target ROAS", value: fmtRoas(targets.targetRoas), tone: "neutral" });
  if (targets?.breakEvenRoas) evidence.push({ label: "Break-even ROAS", value: fmtRoas(targets.breakEvenRoas), tone: "neutral" });
  if (targets?.breakEvenCpa) evidence.push({ label: "Break-even CPA", value: formatMoney(targets.breakEvenCpa, currency, null), tone: "neutral" });
  else if (targets?.targetCpa) evidence.push({ label: "Target CPA", value: formatMoney(targets.targetCpa, currency, null), tone: "neutral" });
  return evidence;
}

function adsetFrequency(adset: MetaAdSetData) {
  const value = (adset as MetaAdSetData & { frequency?: number | null }).frequency;
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

function hasRangeAlignedCohortConfig(adset: MetaAdSetData) {
  return !adset.isOptimizationGoalMixed && !adset.isCustomEventTypeMixed;
}

function signalRecord(
  signals: MetaEntityDecisionSignal | null | undefined,
  key: string,
) {
  const value = signals?.sourceJson?.[key];
  return value && typeof value === "object" && !Array.isArray(value)
    ? value as Record<string, unknown>
    : null;
}

function textFromSignalRecord(
  signals: MetaEntityDecisionSignal | null | undefined,
  recordKey: string,
  valueKey: string,
) {
  const text = String(signalRecord(signals, recordKey)?.[valueKey] ?? "").trim();
  return text.length > 0 ? text : null;
}

function blocksPurchaseHardAction(signals: MetaEntityDecisionSignal | null | undefined) {
  if (!signals || signals.qualityStatus !== "ready") return true;
  /*
    ── ROUND 12: AN UNKNOWN EDIT AGE IS NOT A PASSING ONE ────────────────────

    The line below tests `daysSinceSignificantEdit != null && < 7`, so a NULL
    day count falls straight through it. That is correct when the count is null
    because the account's 60-day config history was read and held no significant
    edit — a real observation, and one that must keep authorising actions. It is
    NOT correct when the count is null because the entity had no resolvable
    provider account, no trusted IANA timezone, or its history read threw: there
    the recent-edit veto was never evaluated at all.

    Both cases wrote the same three nulls, so this gate could not tell them
    apart, and `qualityStatusFor` does not close the gap either — it calls a
    pack "ready" at any three non-null signals out of six, and the edit is only
    one of the six. An ad set with a learning state, a frequency and a CTR decay
    reached "ready" with an unmeasured edit age and authorised purchase-budget
    Scale / Cut / Refresh.

    The authority answers "was this knowable" as its own recorded fact, so the
    day-count test below can go on meaning only what it says.
  */
  if (!metaRecentEditAuthorityReady(signals)) return true;
  if (signals.daysSinceSignificantEdit != null && signals.daysSinceSignificantEdit < 7) return true;
  if (signals.trackingQualityStatus === "lpv_drop_suspected") return true;
  return textFromSignalRecord(signals, "monthly_pacing", "status") === "overpaced";
}

type AdsetHardActionBlocker =
  | "inactive_adset"
  | "signal_quality_not_ready"
  | "uncalibrated_context";

function adsetHardActionBlocker(input: {
  adset: MetaAdSetData;
  signals: MetaEntityDecisionSignal | null | undefined;
  context: MetaCalibrationContext | null;
}): AdsetHardActionBlocker | null {
  if (String(input.adset.status ?? "").toUpperCase() !== "ACTIVE") {
    return "inactive_adset";
  }
  if (!input.signals || input.signals.qualityStatus !== "ready") {
    return "signal_quality_not_ready";
  }
  if (input.context?.thresholds.source !== "calibrated") {
    return "uncalibrated_context";
  }
  return null;
}

function hardActionBlockerMessage(blocker: AdsetHardActionBlocker) {
  if (blocker === "inactive_adset") {
    return "the ad set is not ACTIVE";
  }
  if (blocker === "signal_quality_not_ready") {
    return "the entity signal pack is missing, stale, or incomplete";
  }
  return "the account or campaign comparison cohort is not calibrated";
}

function enforceAdsetHardActionAuthority(input: {
  recommendation: MetaRecommendation;
  adset: MetaAdSetData;
  signals: MetaEntityDecisionSignal | null | undefined;
  context: MetaCalibrationContext | null;
}): MetaRecommendation {
  if (input.recommendation.decisionState !== "act") {
    return input.recommendation;
  }
  const blocker = adsetHardActionBlocker(input);
  if (!blocker) return input.recommendation;
  const message = hardActionBlockerMessage(blocker);
  return {
    ...input.recommendation,
    decisionState: "watch",
    stateReason: `Hard action blocked because ${message}.`,
    recommendedAction: `Do not execute this change while ${message}. Re-evaluate after the authority condition is restored.`,
    signalQuality: {
      ...(input.recommendation.signalQuality ?? {}),
      hard_action_authority: "blocked",
      hard_action_blocker: blocker,
    },
  };
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
  cohort: MetaFunnelCohort;
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
    cohort: input.cohort,
  };
}

export function buildMetaAdsetRecommendations(
  input: BuildMetaAdsetRecommendationsInput,
): MetaRecommendation[] {
  const activeAdsets = input.adsets.filter((adset) => {
    const status = String(adset.status ?? "").toUpperCase();
    return status === "ACTIVE" || status === "WITH_ISSUES" || status === "UNKNOWN" || adset.spend > 0;
  });
  const campaigns = input.campaigns ?? [];
  const campaignsById = new Map(campaigns.map((campaign) => [campaign.id, campaign]));
  const laneSignals = buildMetaCampaignLaneSignals(campaigns);
  const recommendations: MetaRecommendation[] = [];

  for (const adset of activeAdsets) {
    const campaign = campaignsById.get(adset.campaignId) ?? null;
    const cohort = resolveMetaFunnelCohort({
      optimizationGoal: adset.optimizationGoal,
      customEventType: adset.customEventType,
      objective: campaign?.objective,
      purchases: adset.purchases,
      revenue: adset.revenue,
    });
    const context = contextForAdset(input, adset);
    const signals = input.entitySignalsByAdsetId?.[adset.id] ?? null;
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

    const scenario = emitHighPriorityAdsetScenario({
      adset,
      campaign,
      context,
      cohort,
      ...taxonomyFields,
      signals,
    });
    if (scenario) {
      recommendations.push(enforceAdsetHardActionAuthority({
        recommendation: scenario,
        adset,
        signals,
        context,
      }));
      continue;
    }

    if (cohort === "mid_funnel") {
      const midFunnelScenario = emitMidFunnelAdsetScenario({
        adset,
        campaign,
        context,
        cohort,
        ...taxonomyFields,
        signals,
      });
      if (midFunnelScenario) {
        recommendations.push(enforceAdsetHardActionAuthority({
          recommendation: midFunnelScenario,
          adset,
          signals,
          context,
        }));
        continue;
      }
    }

    if (cohort === "lead") {
      const leadScenario = emitLeadAdsetScenario({
        adset,
        campaign,
        context,
        cohort,
        ...taxonomyFields,
        signals,
      });
      if (leadScenario) {
        recommendations.push(enforceAdsetHardActionAuthority({
          recommendation: leadScenario,
          adset,
          signals,
          context,
        }));
        continue;
      }
    }

    if (cohort === "traffic") {
      const trafficScenario = emitTrafficAdsetScenario({
        adset,
        campaign,
        context,
        cohort,
        ...taxonomyFields,
        signals,
      });
      if (trafficScenario) {
        recommendations.push(enforceAdsetHardActionAuthority({
          recommendation: trafficScenario,
          adset,
          signals,
          context,
        }));
        continue;
      }
    }

    if (cohort === "engagement") {
      const engagementScenario = emitEngagementAdsetScenario({
        adset,
        campaign,
        context,
        cohort,
        ...taxonomyFields,
        signals,
      });
      if (engagementScenario) {
        recommendations.push(enforceAdsetHardActionAuthority({
          recommendation: engagementScenario,
          adset,
          signals,
          context,
        }));
        continue;
      }
    }

    const scaleFloor = metaScaleRoasFloor(input.commercialTargets);
    /*
      TWO CUT ANCHORS, AND THEY ARE NOT THE SAME QUESTION.

      `cutCeiling` (break-even ROAS) is the ECONOMIC-LOSS anchor and stays
      exactly as it was: the severe-loser bypass below reads it alone.
      `relativeCutCeiling` is the anchor the RELATIVE path compares against, and
      it is the TARGET ROAS whenever there is one — break-even is used only when
      no Target ROAS exists at all.

      This comment used to say the opposite ("break-even when the operator
      configured one, the Target ROAS otherwise"), which described the pre-Round
      8 `breakEvenRoas ?? targetRoas` order. That order silently replaced the
      configured operating line: two accounts with the same Target ROAS made
      different relative decisions because one had also typed a break-even, and
      editing only the break-even moved a boundary the operator never meant to
      touch. Requiring break-even for the relative path would ALSO have made it
      a second mandatory user target. @see metaRelativeCutRoasCeiling
    */
    const cutCeiling = metaCutRoasReviewCeiling(input.commercialTargets);
    const relativeCutCeiling = metaRelativeCutRoasCeiling(input.commercialTargets);
    /*
      The purchase-VALUE budget authority, asked ONCE for this account.

      Scale used to gate on `adset.cpa <= cpa.p75` — the account's own measured
      cost-per-purchase distribution. Under a positive Target ROAS that is an
      unauthoritative CPA deciding a purchase-value budget increase, which is
      the substitution the canonical rule forbids; and it is the reason a
      thin-sample account could still be scaled. When the authority is granted
      the gate becomes the canonical unit itself (READY Meta AOV / Target
      ROAS). When there is no positive Target ROAS at all, the legacy p75 gate
      is preserved verbatim for compatibility.
    */
    const purchaseValueAuthority = resolveMetaPurchaseValueAuthority(
      input.commercialTargets,
    );
    const targetRoasGoverns =
      metaScaleRoasFloor(input.commercialTargets) !== null &&
      Number(input.commercialTargets?.targetRoas ?? 0) > 0;
    const scaleThreshold = scaleFloor ? (context ? Math.max(roas.p75, scaleFloor) : Math.max(roas.p75, scaleFloor)) : null;
    const weakThreshold = context ? roas.p25 : Math.max(roas.p25, 1.5);
    const currency =
      (adset as MetaAdSetData & { currency?: string | null }).currency ?? null;
    const maturity = metaLossBudgetMaturity({
      targets: input.commercialTargets,
      accountCpaBaseline: cpa.p50,
      calibratedHardCutSpend:
        context?.thresholds.hardCutSpend ??
        LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend,
    });
    const severeLoser = Boolean(
      cutCeiling &&
      maturity &&
      adset.roas < Math.min(roas.p10, cutCeiling) &&
      adset.spend >= maturity.spendThreshold,
    );
    const hardActionBlocker = adsetHardActionBlocker({ adset, signals, context });
    const roasSampleReady =
      context != null && roas.sampleSize >= minRequiredSample(context);
    const cpaSampleReady =
      context != null && cpa.sampleSize >= minRequiredSample(context);

    if (
      isPurchaseCohort(cohort) &&
      hasRangeAlignedCohortConfig(adset) &&
      hardActionBlocker === null &&
      roasSampleReady &&
      !blocksPurchaseHardAction(signals)
    ) {
      /*
        THE AUTHORITY, NOT A SECOND CPA COMPARISON.

        Under a governing Target ROAS the requirement is that a purchase-value
        unit EXISTS — a ready, same-account Meta-attributed AOV over that ratio
        — and the ratio gate above is what tests this ad set against it. The
        account's `cpa.p75` is not consulted, and neither is the unit itself as
        a ceiling: the unit is an ACCOUNT allowance while `adset.cpa` is one ad
        set's measured cost per purchase, so an ad set whose own basket is
        larger than the account average carries a higher CPA at the same ROAS
        and would be refused for being better than its peers.

        Without a positive Target ROAS the legacy `cpa.p75` gate is preserved
        verbatim, sample requirement included.
      */
      const scaleUnitGateSatisfied = targetRoasGoverns
        ? // `cpa > 0` stays as a COHERENCE check, not a threshold: a zero
          // cost-per-purchase beside twelve purchases and positive spend is an
          // uncomputed metric, and an ad set whose delivery evidence is
          // incomplete is not scaled on the rest of it.
          purchaseValueAuthority.authorized && adset.cpa > 0
        : cpaSampleReady && adset.cpa > 0 && adset.cpa <= cpa.p75;
      if (
        scaleThreshold != null &&
        adset.purchases >= 8 &&
        adset.roas >= scaleThreshold &&
        scaleUnitGateSatisfied
      ) {
        const confidenceResult = confidence({
          context,
          metricValue: adset.roas,
          threshold: scaleThreshold,
        });
        recommendations.push(baseAdsetRecommendation({
          adset,
          cohort,
          ...taxonomyFields,
          type: "adset_scale_budget",
          lens: "volume",
          priority: "high",
          confidence: confidenceResult,
          decisionState: confidenceResult.score >= META_CONFIDENCE_ACT_THRESHOLD ? "act" : "test",
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
            ...commercialTargetEvidence(input.commercialTargets, currency),
          ],
        }));
        continue;
      }

      /*
        THE SPEND FLOOR IS THE CANONICAL MATURITY, OR THERE IS NO CUT.

        The previous shape fell back to the calibrated `hardCutSpend` whenever
        `maturity` was null. Under a positive Target ROAS `maturity` is null
        for exactly one reason — the Meta sample is missing or thin — so that
        fallback re-opened a purchase-budget spend action on an account with no
        authoritative money-per-purchase, sized from a calibrated spend
        percentile instead. A calibrated floor is not a substitute for the
        unit; it is a different quantity that happens to be a number.

        So the floor is `maturity.spendThreshold` (itself
        `max(calibratedFloor, unit * riskMultiplier)`) when a Target ROAS
        governs, and the legacy calibrated floor only where no positive Target
        ROAS exists — the compatibility case in which `metaLossBudgetMaturity`
        answers from the CPA ladder anyway.

        The CEILING is the Target ROAS when no break-even is configured
        (`metaRelativeCutRoasCeiling`), so break-even stays a separately
        identified economic stop-loss signal — `cutCeiling` and the
        severe-loser bypass below still read it alone — and never becomes a
        second mandatory user target.
      */
      const relativeCutSpendFloor = targetRoasGoverns
        ? (maturity?.spendThreshold ?? null)
        : (maturity?.spendThreshold ??
          context?.thresholds.hardCutSpend ??
          LEGACY_META_CALIBRATION_THRESHOLDS.hardCutSpend);
      if (
        relativeCutCeiling != null &&
        // Under a governing Target ROAS this also requires the READY sample,
        // because that is what `metaLossBudgetMaturity` refuses without.
        relativeCutSpendFloor != null &&
        adset.spend >= relativeCutSpendFloor &&
        adset.roas < weakThreshold &&
        adset.roas < relativeCutCeiling
      ) {
        const confidenceResult = confidence({
          context,
          metricValue: adset.roas,
          threshold: weakThreshold,
          severeLoser,
        });
        recommendations.push(baseAdsetRecommendation({
          adset,
          cohort,
          ...taxonomyFields,
          type: "adset_cut_spend",
          lens: "profitability",
          priority: severeLoser ? "high" : "medium",
          confidence: confidenceResult,
          decisionState: confidenceResult.score >= META_CONFIDENCE_ACT_THRESHOLD ? "act" : "test",
          decision: "Cut or cap this ad set",
          title: `${adset.name}: ad set is below the calibrated efficiency line`,
          why: "The ad set is consuming meaningful spend while trailing calibrated ROAS expectations.",
          summary: `${adset.name} has spent ${formatMoney(adset.spend, currency, null)} at ${fmtRoas(adset.roas)} ROAS.`,
          recommendedAction: "Reduce budget pressure or pause the ad set, then reallocate spend toward stronger ad sets in the same campaign.",
          expectedImpact: "Lower waste and cleaner campaign-level budget allocation.",
          evidence: [
            { label: "Ad set spend", value: formatMoney(adset.spend, currency, null), tone: "warning" },
            { label: "Ad set ROAS", value: fmtRoas(adset.roas), tone: "warning" },
            { label: "ROAS p25", value: fmtRoas(roas.p25), tone: "neutral" },
            { label: "Loss maturity spend", value: formatMoney(relativeCutSpendFloor, currency, null), tone: "neutral" },
            ...commercialTargetEvidence(input.commercialTargets, currency),
            ...(severeLoser
              ? [{ label: "Severe loser bypass", value: "active", tone: "warning" as const }]
              : []),
          ],
        }));
        continue;
      }
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
        cohort,
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
    .slice(0, 250)
    .map((recommendation) =>
      enforceMetaCommercialActionAuthority(
        recommendation,
        input.commercialTargets,
      ),
    )
    .map(withMetaAutomationReadiness);
}
