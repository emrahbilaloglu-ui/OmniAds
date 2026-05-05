import type { CreativeDecisionPrimaryAction } from "@/lib/creative-decision-os";
import type {
  CreativeEvidenceSource,
  CreativeOperatorPolicyInput,
  CreativeOperatorSegment,
  CreativeRelativeBaselineReliability,
} from "@/lib/creative-operator-policy";

export const CREATIVE_MEDIA_BUYER_SCORING_VERSION =
  "creative-media-buyer-scoring.v1";

export type CreativeMediaBuyerRelativePerformanceClass =
  | "strong"
  | "above_baseline"
  | "near_baseline"
  | "below_baseline"
  | "weak"
  | "unknown";

export type CreativeMediaBuyerEvidenceMaturity =
  | "high"
  | "medium"
  | "low"
  | "insufficient";

export type CreativeMediaBuyerTrendState =
  | "accelerating"
  | "stable"
  | "declining"
  | "collapsed"
  | "unknown";

export type CreativeMediaBuyerEfficiencyRisk =
  | "none"
  | "moderate"
  | "high"
  | "catastrophic"
  | "unknown";

export type CreativeMediaBuyerWinnerSignal =
  | "none"
  | "promising"
  | "strong"
  | "scale_review"
  | "scale";

export type CreativeMediaBuyerLoserSignal =
  | "none"
  | "watch"
  | "refresh"
  | "cut";

export type CreativeMediaBuyerContextState =
  | "clear"
  | "campaign_blocked"
  | "data_blocked"
  | "benchmark_weak"
  | "unknown";

export type CreativeMediaBuyerBusinessValidation =
  | "favorable"
  | "missing"
  | "unfavorable"
  | "unknown";

export type CreativeMediaBuyerRecommendedSegment =
  | "Scale"
  | "Scale Review"
  | "Test More"
  | "Protect"
  | "Refresh"
  | "Retest"
  | "Cut"
  | "Campaign Check"
  | "Not Enough Data"
  | "Watch";

export type CreativeMediaBuyerReasonTag =
  | "strong_relative_winner"
  | "business_validation_missing"
  | "commercial_truth_missing"
  | "weak_benchmark"
  | "fatigue_pressure"
  | "trend_collapse"
  | "catastrophic_cpa"
  | "below_baseline_waste"
  | "mature_zero_purchase"
  | "comeback_candidate"
  | "paused_winner"
  | "campaign_context_blocker"
  | "low_evidence"
  | "preview_missing"
  | "creative_learning_incomplete";

export interface CreativeMediaBuyerScorecard {
  version: typeof CREATIVE_MEDIA_BUYER_SCORING_VERSION;
  relativePerformanceClass: CreativeMediaBuyerRelativePerformanceClass;
  evidenceMaturity: CreativeMediaBuyerEvidenceMaturity;
  trendState: CreativeMediaBuyerTrendState;
  efficiencyRisk: CreativeMediaBuyerEfficiencyRisk;
  winnerSignal: CreativeMediaBuyerWinnerSignal;
  loserSignal: CreativeMediaBuyerLoserSignal;
  contextState: CreativeMediaBuyerContextState;
  businessValidation: CreativeMediaBuyerBusinessValidation;
  recommendedSegment: CreativeMediaBuyerRecommendedSegment;
  operatorSegment: CreativeOperatorSegment;
  confidence: number;
  reasons: CreativeMediaBuyerReasonTag[];
  blockedActions: string[];
  reviewOnly: boolean;
  pushSafetyUnchanged: true;
  metrics: {
    roasToBenchmark: number | null;
    cpaToBenchmark: number | null;
    trendRoasRatio: number | null;
    spendToMedian: number | null;
  };
}

type CreativeBusinessValidationStatus =
  | "favorable"
  | "missing"
  | "unfavorable";

interface Recommendation {
  operatorSegment: CreativeOperatorSegment;
  recommendedSegment: CreativeMediaBuyerRecommendedSegment;
  reasons: CreativeMediaBuyerReasonTag[];
  reviewOnly?: boolean;
}

const SCALE_ACTIONS = new Set<CreativeDecisionPrimaryAction>([
  "promote_to_scaling",
]);
const KILL_OR_REFRESH_ACTIONS = new Set<CreativeDecisionPrimaryAction>([
  "block_deploy",
  "refresh_replace",
]);
const AGGRESSIVE_ACTIONS = new Set<CreativeDecisionPrimaryAction>([
  "promote_to_scaling",
  "block_deploy",
  "refresh_replace",
]);

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function safeRatio(
  numerator: number | null | undefined,
  denominator: number | null | undefined,
) {
  if (!hasNumber(numerator) || !hasNumber(denominator) || denominator <= 0) {
    return null;
  }
  return numerator / denominator;
}

function uniqueReasonTags(values: Array<CreativeMediaBuyerReasonTag | null | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is CreativeMediaBuyerReasonTag => Boolean(value))),
  );
}

function evidenceSource(input: CreativeOperatorPolicyInput): CreativeEvidenceSource {
  return input.evidenceSource ?? "unknown";
}

function hasScaleEvidence(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  return (
    hasNumber(metrics.spend) &&
    metrics.spend >= 250 &&
    hasNumber(metrics.purchases) &&
    metrics.purchases >= 5 &&
    input.economics?.status === "eligible"
  );
}

function isScaleIntent(input: CreativeOperatorPolicyInput) {
  return (
    input.primaryAction === "promote_to_scaling" ||
    input.lifecycleState === "scale_ready"
  );
}

function hasRelativeBaselineContext(input: CreativeOperatorPolicyInput) {
  const baseline = input.relativeBaseline ?? null;
  const reliability = baseline?.reliability ?? "unavailable";
  const reliable = reliability === "strong" || reliability === "medium";
  return (
    Boolean(baseline) &&
    reliable &&
    (baseline?.sampleSize ?? 0) >= 3 &&
    (baseline?.eligibleCreativeCount ?? 0) >= 3 &&
    hasNumber(baseline?.spendBasis) &&
    (baseline?.spendBasis ?? 0) >= 150 &&
    hasNumber(baseline?.purchaseBasis) &&
    (baseline?.purchaseBasis ?? 0) >= 3 &&
    hasNumber(baseline?.medianRoas) &&
    (baseline?.medianRoas ?? 0) > 0 &&
    hasNumber(baseline?.medianSpend) &&
    (baseline?.medianSpend ?? 0) > 0
  );
}

function hasStrongRelativeBaselineContext(input: CreativeOperatorPolicyInput) {
  const baseline = input.relativeBaseline ?? null;
  return (
    hasRelativeBaselineContext(input) &&
    baseline?.reliability === "strong" &&
    (baseline?.sampleSize ?? 0) >= 6 &&
    (baseline?.eligibleCreativeCount ?? 0) >= 6 &&
    (baseline?.spendBasis ?? 0) >= 500 &&
    (baseline?.purchaseBasis ?? 0) >= 8
  );
}

function resolveBusinessValidationStatus(
  input: CreativeOperatorPolicyInput,
): CreativeBusinessValidationStatus {
  if (
    !input.commercialTruthConfigured ||
    input.trust?.truthState === "degraded_missing_truth" ||
    input.trust?.operatorDisposition === "profitable_truth_capped"
  ) {
    return "missing";
  }

  if (
    input.economics?.status !== "eligible" ||
    input.trust?.truthState !== "live_confident" ||
    input.trust?.evidence?.aggressiveActionBlocked === true ||
    input.trust?.evidence?.suppressed === true
  ) {
    return "unfavorable";
  }

  return "favorable";
}

function hasRelativeScaleReviewEvidence(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  if (!hasRelativeBaselineContext(input) || !baseline) return false;

  const medianSpend = baseline.medianSpend ?? 0;
  const medianRoas = baseline.medianRoas ?? 0;
  const medianCpa = baseline.medianCpa ?? null;

  if (!hasNumber(metrics.spend) || !hasNumber(metrics.purchases) || !hasNumber(metrics.roas)) {
    return false;
  }
  if (metrics.spend < Math.max(80, medianSpend * 0.2)) return false;
  if (metrics.purchases < 2) return false;
  if (metrics.roas < medianRoas * 1.4) return false;
  if (
    hasNumber(metrics.cpa) &&
    metrics.cpa > 0 &&
    hasNumber(medianCpa) &&
    medianCpa > 0 &&
    metrics.cpa > medianCpa * 1.2
  ) {
    return false;
  }
  return true;
}

function hasMeaningfulCreativeRead(
  input: CreativeOperatorPolicyInput,
  options?: { minimumSpend?: number; minimumPurchases?: number; minimumImpressions?: number },
) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const spendFloor = Math.max(
    options?.minimumSpend ?? 300,
    hasNumber(baseline?.medianSpend) ? baseline!.medianSpend! : 0,
  );
  return (
    hasNumber(metrics.spend) &&
    metrics.spend >= spendFloor &&
    hasNumber(metrics.impressions) &&
    metrics.impressions >= (options?.minimumImpressions ?? 5_000) &&
    hasNumber(metrics.creativeAgeDays) &&
    metrics.creativeAgeDays > 10 &&
    hasNumber(metrics.purchases) &&
    metrics.purchases >= (options?.minimumPurchases ?? 1)
  );
}

function hasTrueScaleEvidence(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;
  const medianSpend = baseline?.medianSpend ?? 0;

  if (!hasScaleEvidence(input)) return false;
  if (!hasRelativeScaleReviewEvidence(input)) return false;
  if (!hasStrongRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(300, medianSpend * 1.3)) {
    return false;
  }
  if (!hasNumber(metrics.purchases) || metrics.purchases < 6) return false;
  if (!hasNumber(metrics.roas) || metrics.roas < medianRoas * 1.6) return false;
  if (
    hasNumber(metrics.cpa) &&
    metrics.cpa > 0 &&
    hasNumber(medianCpa) &&
    medianCpa > 0 &&
    metrics.cpa > medianCpa
  ) {
    return false;
  }
  return true;
}

function isActiveTestCampaign(input: CreativeOperatorPolicyInput) {
  const context = input.deliveryContext ?? null;
  return Boolean(
    context?.campaignIsTestLike &&
      (context.activeDelivery ||
        context.campaignStatus?.trim().toUpperCase() === "ACTIVE") &&
      !context.pausedDelivery,
  );
}

function isActiveTestStrongRelativeReviewCandidate(input: CreativeOperatorPolicyInput) {
  if (!isActiveTestCampaign(input)) return false;
  if (!hasRelativeScaleReviewEvidence(input)) return false;
  return (
    input.primaryAction === "hold_no_touch" ||
    input.primaryAction === "keep_in_test" ||
    input.primaryAction === "promote_to_scaling" ||
    input.primaryAction === "refresh_replace"
  );
}

function isActiveTestStrongRelativeTestMoreCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;

  if (!isActiveTestCampaign(input)) return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (
    input.primaryAction !== "hold_no_touch" &&
    input.primaryAction !== "keep_in_test"
  ) {
    return false;
  }
  if (!hasMeaningfulCreativeRead(input, { minimumSpend: 250, minimumPurchases: 2 })) {
    return false;
  }
  if (!hasNumber(metrics.roas) || metrics.roas < medianRoas * 1.2) return false;
  if (
    hasNumber(metrics.cpa) &&
    metrics.cpa > 0 &&
    hasNumber(medianCpa) &&
    medianCpa > 0 &&
    metrics.cpa > medianCpa * 1.25
  ) {
    return false;
  }
  return true;
}

function isReviewOnlyScaleCandidate(
  input: CreativeOperatorPolicyInput,
  businessValidationStatus: CreativeBusinessValidationStatus,
) {
  return (
    businessValidationStatus === "missing" &&
    hasTrueScaleEvidence(input) &&
    input.primaryAction !== "refresh_replace" &&
    input.primaryAction !== "block_deploy" &&
    input.lifecycleState !== "fatigued_winner" &&
    input.fatigue?.status !== "fatigued"
  );
}

function isNonTestHighRelativeReviewCandidate(
  input: CreativeOperatorPolicyInput,
  businessValidationStatus: CreativeBusinessValidationStatus,
) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;
  const medianSpend = baseline?.medianSpend ?? 0;

  if (businessValidationStatus === "unfavorable") return false;
  if (isActiveTestCampaign(input)) return false;
  if (input.lifecycleState !== "validating") return false;
  if (input.primaryAction !== "keep_in_test") return false;
  if (!hasStrongRelativeBaselineContext(input)) return false;
  if (!hasRelativeScaleReviewEvidence(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(500, medianSpend * 0.75)) {
    return false;
  }
  if (!hasNumber(metrics.purchases) || metrics.purchases < 6) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 20_000) return false;
  if (!hasNumber(metrics.creativeAgeDays) || metrics.creativeAgeDays <= 10) return false;
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  if (metrics.roas < medianRoas * 2.5) return false;
  if (
    hasNumber(metrics.cpa) &&
    metrics.cpa > 0 &&
    hasNumber(medianCpa) &&
    medianCpa > 0 &&
    metrics.cpa > medianCpa
  ) {
    return false;
  }
  return true;
}

function hasKillEvidence(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  return (
    hasNumber(metrics.spend) &&
    metrics.spend >= 250 &&
    ((hasNumber(metrics.purchases) && metrics.purchases >= 4) ||
      (hasNumber(metrics.impressions) && metrics.impressions >= 8_000))
  );
}

function isUnderSampled(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  return (
    (hasNumber(metrics.spend) && metrics.spend < 120) ||
    (hasNumber(metrics.purchases) && metrics.purchases < 2) ||
    (hasNumber(metrics.impressions) && metrics.impressions < 5_000) ||
    (hasNumber(metrics.creativeAgeDays) && metrics.creativeAgeDays <= 10)
  );
}

function hasRoasOnlyPositiveSignal(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const purchaseCount = hasNumber(metrics.purchases) ? metrics.purchases : 0;
  return (
    hasNumber(metrics.roas) &&
    metrics.roas >= 2 &&
    purchaseCount < 2 &&
    ((hasNumber(metrics.spend) && metrics.spend < 120) ||
      (hasNumber(metrics.purchases) && metrics.purchases < 2))
  );
}

function hasMeaningfulPositiveSupport(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  return (
    hasNumber(metrics.purchases) &&
    metrics.purchases >= 2 &&
    hasNumber(metrics.roas) &&
    metrics.roas > 0
  );
}

function hasUnderSampledTestMoreEvidence(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianSpend = baseline?.medianSpend ?? 0;
  const medianRoas = baseline?.medianRoas ?? 0;

  if (!hasMeaningfulPositiveSupport(input)) return false;
  if (hasRelativeScaleReviewEvidence(input)) return true;
  if (!hasRelativeBaselineContext(input)) return true;
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(60, medianSpend * 0.5)) {
    return false;
  }
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  return metrics.roas >= medianRoas * 0.8;
}

function isMatureZeroPurchaseWeakCase(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  return (
    input.primaryAction === "keep_in_test" &&
    hasNumber(metrics.spend) &&
    metrics.spend >= 250 &&
    hasNumber(metrics.purchases) &&
    metrics.purchases === 0 &&
    hasNumber(metrics.impressions) &&
    metrics.impressions >= 5_000 &&
    hasNumber(metrics.creativeAgeDays) &&
    metrics.creativeAgeDays > 10
  );
}

function isMatureZeroPurchaseCutCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  return (
    isMatureZeroPurchaseWeakCase(input) &&
    hasNumber(metrics.impressions) &&
    metrics.impressions >= 8_000
  );
}

function isMatureBelowBaselinePurchaseLoser(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianSpend = baseline?.medianSpend ?? 0;

  return (
    input.primaryAction === "keep_in_test" &&
    input.lifecycleState === "validating" &&
    hasRelativeBaselineContext(input) &&
    hasNumber(metrics.spend) &&
    metrics.spend >= Math.max(1_000, medianSpend * 3) &&
    hasNumber(metrics.purchases) &&
    metrics.purchases >= 4 &&
    hasNumber(metrics.roas) &&
    metrics.roas <= medianRoas * 0.8 &&
    hasNumber(metrics.impressions) &&
    metrics.impressions >= 8_000 &&
    hasNumber(metrics.creativeAgeDays) &&
    metrics.creativeAgeDays > 10
  );
}

function isMatureTrendCollapseLoser(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;

  if (input.primaryAction !== "keep_in_test") return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasMeaningfulCreativeRead(input)) return false;
  if (!hasNumber(metrics.roas) || metrics.roas <= 0) return false;
  if (!hasNumber(metrics.recentRoas) || metrics.recentRoas < 0) return false;
  if (!hasNumber(medianRoas) || medianRoas <= 0) return false;
  if (metrics.roas >= medianRoas) return false;
  return metrics.recentRoas / metrics.roas <= 0.4;
}

function isMatureCpaRatioLoser(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;

  if (input.primaryAction !== "keep_in_test") return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasMeaningfulCreativeRead(input)) return false;
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) return false;
  if (metrics.roas >= medianRoas) return false;
  if (!hasNumber(metrics.cpa) || metrics.cpa <= 0) return false;
  if (!hasNumber(medianCpa) || medianCpa <= 0) return false;
  return metrics.cpa >= medianCpa * 1.5;
}

function isProtectedTrendCollapseRefreshCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;

  if (
    input.lifecycleState !== "stable_winner" &&
    input.lifecycleState !== "fatigued_winner"
  ) {
    return false;
  }
  if (
    input.primaryAction !== "hold_no_touch" &&
    input.primaryAction !== "refresh_replace"
  ) {
    return false;
  }
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < 200) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 5_000) return false;
  if (!hasNumber(metrics.roas) || metrics.roas <= 0) return false;
  if (!hasNumber(metrics.recentRoas) || metrics.recentRoas < 0) return false;
  if (!hasNumber(medianRoas) || medianRoas <= 0) return false;
  if (metrics.recentRoas >= medianRoas) return false;

  const benchmarkRatio = metrics.roas / medianRoas;
  const trendRatio = metrics.recentRoas / metrics.roas;
  if (input.lifecycleState === "stable_winner" && benchmarkRatio >= 1 && benchmarkRatio < 1.4) {
    return trendRatio <= 0.5;
  }
  return trendRatio <= 0.4;
}

function hasWeakCampaignContext(input: CreativeOperatorPolicyInput) {
  return input.deployment?.compatibility.status === "blocked";
}

function isProtectedBelowBaselineMonitorCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;
  const medianSpend = baseline?.medianSpend ?? 0;

  if (input.lifecycleState !== "stable_winner") return false;
  if (input.primaryAction !== "hold_no_touch") return false;
  if (input.trust?.operatorDisposition === "protected_watchlist") return false;
  if (hasWeakCampaignContext(input)) return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(1_000, medianSpend * 1.25)) {
    return false;
  }
  if (!hasNumber(metrics.purchases) || metrics.purchases < 4) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 8_000) return false;
  if (!hasNumber(metrics.creativeAgeDays) || metrics.creativeAgeDays <= 10) return false;
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  if (metrics.roas > medianRoas * 0.9) return false;
  if (!hasNumber(metrics.cpa) || metrics.cpa <= 0) return false;
  if (!hasNumber(medianCpa) || medianCpa <= 0) return false;
  return metrics.cpa >= medianCpa * 1.5;
}

function isFatiguedCpaRatioCutCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;
  const medianSpend = baseline?.medianSpend ?? 0;

  const fatigueOrRefreshContext =
    input.lifecycleState === "fatigued_winner" ||
    input.fatigue?.status === "fatigued" ||
    input.primaryAction === "refresh_replace";

  if (!fatigueOrRefreshContext) return false;
  if (input.primaryAction !== "refresh_replace") return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(500, medianSpend * 1.5)) {
    return false;
  }
  if (!hasNumber(metrics.purchases) || metrics.purchases < 1) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 8_000) return false;
  if (!hasNumber(metrics.roas) || metrics.roas <= 0 || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  if (!hasNumber(metrics.cpa) || metrics.cpa <= 0) return false;
  if (!hasNumber(medianCpa) || medianCpa <= 0) return false;
  if (metrics.cpa < medianCpa * 2) return false;

  const belowBaselineFailure = metrics.roas <= medianRoas * 0.5;
  const zeroRecentCpaBlowout =
    hasNumber(metrics.recentRoas) &&
    metrics.recentRoas >= 0 &&
    metrics.recentRoas / metrics.roas <= 0.2 &&
    metrics.cpa >= medianCpa * 2.5 &&
    metrics.roas <= medianRoas * 0.8 &&
    metrics.spend >= Math.max(2_000, medianSpend * 10);

  return belowBaselineFailure || zeroRecentCpaBlowout;
}

function isFatiguedHighSpendBelowBaselineCutCandidate(
  input: CreativeOperatorPolicyInput,
) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianSpend = baseline?.medianSpend ?? 0;
  const refreshPath =
    input.primaryAction === "refresh_replace" ||
    (input.primaryAction === "hold_no_touch" &&
      input.lifecycleState === "fatigued_winner" &&
      input.fatigue?.status === "fatigued" &&
      input.trust?.operatorDisposition !== "protected_watchlist");

  if (input.lifecycleState !== "fatigued_winner" && input.fatigue?.status !== "fatigued") {
    return false;
  }
  if (!refreshPath) return false;
  if (input.trust?.operatorDisposition === "protected_watchlist") return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(1_500, medianSpend * 3)) {
    return false;
  }
  if (!hasNumber(metrics.purchases) || metrics.purchases < 1) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 8_000) return false;
  if (!hasNumber(metrics.creativeAgeDays) || metrics.creativeAgeDays <= 10) return false;
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  return metrics.roas <= medianRoas * 0.8;
}

function isBlockedCpaRatioLoser(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;

  if (input.lifecycleState !== "blocked") return false;
  if (
    input.primaryAction !== "block_deploy" &&
    input.primaryAction !== "keep_in_test"
  ) {
    return false;
  }
  if (hasNumber(metrics.purchases) && metrics.purchases >= 4) return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < 250) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 8_000) return false;
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  if (metrics.roas > medianRoas * 0.5) return false;
  if (!hasNumber(metrics.cpa) || metrics.cpa <= 0) return false;
  if (!hasNumber(medianCpa) || medianCpa <= 0) return false;
  return metrics.cpa >= medianCpa * 2;
}

function isLowPurchaseCatastrophicCpaLoser(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;
  const medianSpend = baseline?.medianSpend ?? 0;

  if (
    input.lifecycleState !== "blocked" &&
    input.lifecycleState !== "validating"
  ) {
    return false;
  }
  if (
    input.primaryAction !== "block_deploy" &&
    input.primaryAction !== "keep_in_test"
  ) {
    return false;
  }
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.purchases) || metrics.purchases < 1 || metrics.purchases >= 4) {
    return false;
  }
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(300, medianSpend * 2)) {
    return false;
  }
  if (!hasNumber(metrics.impressions) || metrics.impressions < 8_000) return false;
  if (!hasNumber(metrics.creativeAgeDays) || metrics.creativeAgeDays <= 10) {
    return false;
  }
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  if (metrics.roas > medianRoas * 0.4) return false;
  if (!hasNumber(metrics.cpa) || metrics.cpa <= 0) return false;
  if (!hasNumber(medianCpa) || medianCpa <= 0) return false;
  return metrics.cpa >= medianCpa * 3;
}

function isHighSpendBelowBaselineCutCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianSpend = baseline?.medianSpend ?? 0;

  if (input.primaryAction !== "keep_in_test") return false;
  if (input.lifecycleState !== "validating") return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < Math.max(5_000, medianSpend * 5)) {
    return false;
  }
  if (!hasNumber(metrics.purchases) || metrics.purchases < 4) return false;
  if (!hasNumber(metrics.roas) || !hasNumber(medianRoas) || medianRoas <= 0) {
    return false;
  }
  if (metrics.roas > medianRoas * 0.8) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 8_000) return false;
  return true;
}

function isValidatingTrendCollapseRefreshCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;

  if (input.lifecycleState !== "validating") return false;
  if (input.primaryAction !== "keep_in_test") return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (
    !hasMeaningfulCreativeRead(input, {
      minimumSpend: 250,
      minimumPurchases: 2,
      minimumImpressions: 5_000,
    })
  ) {
    return false;
  }
  if (!hasNumber(metrics.spend) || metrics.spend < 250) return false;
  if (!hasNumber(metrics.purchases) || metrics.purchases < 2) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 5_000) return false;
  if (!hasNumber(metrics.roas) || metrics.roas <= 0) return false;
  if (!hasNumber(metrics.recentRoas) || metrics.recentRoas < 0) return false;
  if (!hasNumber(medianRoas) || medianRoas <= 0) return false;
  if (metrics.roas < medianRoas * 0.95) return false;
  return metrics.recentRoas / metrics.roas <= 0.25;
}

function isValidatingBelowBaselineCollapseRefreshCandidate(
  input: CreativeOperatorPolicyInput,
) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;

  if (input.lifecycleState !== "validating") return false;
  if (input.primaryAction !== "keep_in_test") return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!hasNumber(metrics.spend) || metrics.spend < 300) return false;
  if (!hasNumber(metrics.purchases) || metrics.purchases < 2) return false;
  if (!hasNumber(metrics.impressions) || metrics.impressions < 3_000) return false;
  if (!hasNumber(metrics.creativeAgeDays) || metrics.creativeAgeDays < 7) {
    return false;
  }
  if (!hasNumber(metrics.roas) || metrics.roas <= 0) return false;
  if (!hasNumber(metrics.recentRoas) || metrics.recentRoas < 0) return false;
  if (!hasNumber(medianRoas) || medianRoas <= 0) return false;
  if (metrics.roas > medianRoas * 0.4) return false;
  return metrics.recentRoas === 0 || metrics.recentRoas / metrics.roas <= 0.3;
}

function shouldRefreshMatureLoser(input: CreativeOperatorPolicyInput) {
  return (
    input.primaryAction === "refresh_replace" ||
    input.lifecycleState === "fatigued_winner" ||
    input.fatigue?.status === "fatigued" ||
    input.fatigue?.status === "watch"
  );
}

function isPausedHistoricalWinnerRetestCandidate(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  const medianRoas = baseline?.medianRoas ?? 0;
  const medianCpa = baseline?.medianCpa ?? null;
  const actionCanRetest =
    input.primaryAction === "hold_no_touch" ||
    input.primaryAction === "keep_in_test" ||
    input.primaryAction === "promote_to_scaling" ||
    input.primaryAction === "retest_comeback";
  const historicalWinnerContext =
    input.lifecycleState === "stable_winner" ||
    input.lifecycleState === "scale_ready" ||
    input.primaryAction === "hold_no_touch" ||
    input.primaryAction === "promote_to_scaling" ||
    input.primaryAction === "retest_comeback";

  if (!input.deliveryContext?.pausedDelivery) return false;
  if (hasWeakCampaignContext(input)) return false;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!actionCanRetest || !historicalWinnerContext) return false;
  if (!hasMeaningfulCreativeRead(input, { minimumSpend: 250, minimumPurchases: 3 })) {
    return false;
  }
  if (!hasNumber(metrics.roas) || metrics.roas < medianRoas * 1.1) return false;
  if (
    hasNumber(metrics.cpa) &&
    metrics.cpa > 0 &&
    hasNumber(medianCpa) &&
    medianCpa > 0 &&
    metrics.cpa > medianCpa * 1.25
  ) {
    return false;
  }
  return true;
}

function classifyRelativePerformance(input: CreativeOperatorPolicyInput) {
  const roasRatio = safeRatio(
    input.supportingMetrics?.roas,
    input.relativeBaseline?.medianRoas,
  );
  const cpaRatio = safeRatio(
    input.supportingMetrics?.cpa,
    input.relativeBaseline?.medianCpa,
  );

  if (!hasRelativeBaselineContext(input) || roasRatio === null) {
    return "unknown" satisfies CreativeMediaBuyerRelativePerformanceClass;
  }
  if (roasRatio >= 1.6 && (cpaRatio === null || cpaRatio <= 1.2)) {
    return "strong" satisfies CreativeMediaBuyerRelativePerformanceClass;
  }
  if (roasRatio >= 1.15) {
    return "above_baseline" satisfies CreativeMediaBuyerRelativePerformanceClass;
  }
  if (roasRatio >= 0.85) {
    return "near_baseline" satisfies CreativeMediaBuyerRelativePerformanceClass;
  }
  if (roasRatio >= 0.5) {
    return "below_baseline" satisfies CreativeMediaBuyerRelativePerformanceClass;
  }
  return "weak" satisfies CreativeMediaBuyerRelativePerformanceClass;
}

function classifyEvidenceMaturity(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const medianSpend = input.relativeBaseline?.medianSpend ?? 0;
  const spend = metrics.spend ?? null;
  const purchases = metrics.purchases ?? null;
  const impressions = metrics.impressions ?? null;
  const age = metrics.creativeAgeDays ?? null;

  if (
    hasNumber(spend) &&
    spend >= Math.max(1_000, medianSpend * 3) &&
    hasNumber(purchases) &&
    purchases >= 4 &&
    hasNumber(impressions) &&
    impressions >= 8_000 &&
    hasNumber(age) &&
    age > 10
  ) {
    return "high" satisfies CreativeMediaBuyerEvidenceMaturity;
  }
  if (
    hasNumber(spend) &&
    spend >= 300 &&
    hasNumber(purchases) &&
    purchases >= 2 &&
    hasNumber(impressions) &&
    impressions >= 3_000 &&
    hasNumber(age) &&
    age >= 7
  ) {
    return "medium" satisfies CreativeMediaBuyerEvidenceMaturity;
  }
  if (
    (hasNumber(spend) && spend >= 120) ||
    (hasNumber(purchases) && purchases >= 1) ||
    (hasNumber(impressions) && impressions >= 2_000)
  ) {
    return "low" satisfies CreativeMediaBuyerEvidenceMaturity;
  }
  return "insufficient" satisfies CreativeMediaBuyerEvidenceMaturity;
}

function classifyTrendState(input: CreativeOperatorPolicyInput) {
  const trendRatio = safeRatio(
    input.supportingMetrics?.recentRoas,
    input.supportingMetrics?.roas,
  );
  if (trendRatio === null) {
    return "unknown" satisfies CreativeMediaBuyerTrendState;
  }
  if (trendRatio <= 0.3) return "collapsed" satisfies CreativeMediaBuyerTrendState;
  if (trendRatio <= 0.65) return "declining" satisfies CreativeMediaBuyerTrendState;
  if (trendRatio >= 1.25) return "accelerating" satisfies CreativeMediaBuyerTrendState;
  return "stable" satisfies CreativeMediaBuyerTrendState;
}

function classifyEfficiencyRisk(input: CreativeOperatorPolicyInput) {
  const roasRatio = safeRatio(
    input.supportingMetrics?.roas,
    input.relativeBaseline?.medianRoas,
  );
  const cpaRatio = safeRatio(
    input.supportingMetrics?.cpa,
    input.relativeBaseline?.medianCpa,
  );
  const maturity = classifyEvidenceMaturity(input);

  if (!hasRelativeBaselineContext(input)) {
    return "unknown" satisfies CreativeMediaBuyerEfficiencyRisk;
  }
  if (
    isFatiguedCpaRatioCutCandidate(input) ||
    isBlockedCpaRatioLoser(input) ||
    isLowPurchaseCatastrophicCpaLoser(input) ||
    isHighSpendBelowBaselineCutCandidate(input) ||
    isMatureBelowBaselinePurchaseLoser(input) ||
    (cpaRatio !== null && cpaRatio >= 3 && roasRatio !== null && roasRatio <= 0.4)
  ) {
    return "catastrophic" satisfies CreativeMediaBuyerEfficiencyRisk;
  }
  if (
    isMatureTrendCollapseLoser(input) ||
    isMatureCpaRatioLoser(input) ||
    (cpaRatio !== null && cpaRatio >= 1.5 && roasRatio !== null && roasRatio <= 0.8)
  ) {
    return "high" satisfies CreativeMediaBuyerEfficiencyRisk;
  }
  if (
    maturity !== "insufficient" &&
    ((roasRatio !== null && roasRatio < 0.9) ||
      (cpaRatio !== null && cpaRatio > 1.2))
  ) {
    return "moderate" satisfies CreativeMediaBuyerEfficiencyRisk;
  }
  return "none" satisfies CreativeMediaBuyerEfficiencyRisk;
}

function classifyWinnerSignal(
  input: CreativeOperatorPolicyInput,
  businessValidationStatus: CreativeBusinessValidationStatus,
) {
  if (
    businessValidationStatus === "favorable" &&
    isScaleIntent(input) &&
    hasTrueScaleEvidence(input)
  ) {
    return "scale" satisfies CreativeMediaBuyerWinnerSignal;
  }
  if (
    isReviewOnlyScaleCandidate(input, businessValidationStatus) ||
    isActiveTestStrongRelativeReviewCandidate(input) ||
    isNonTestHighRelativeReviewCandidate(input, businessValidationStatus) ||
    (isScaleIntent(input) && hasRelativeScaleReviewEvidence(input))
  ) {
    return "scale_review" satisfies CreativeMediaBuyerWinnerSignal;
  }
  if (hasRelativeScaleReviewEvidence(input)) {
    return "strong" satisfies CreativeMediaBuyerWinnerSignal;
  }
  if (hasUnderSampledTestMoreEvidence(input)) {
    return "promising" satisfies CreativeMediaBuyerWinnerSignal;
  }
  return "none" satisfies CreativeMediaBuyerWinnerSignal;
}

function classifyLoserSignal(input: CreativeOperatorPolicyInput) {
  if (
    isFatiguedHighSpendBelowBaselineCutCandidate(input) ||
    isFatiguedCpaRatioCutCandidate(input) ||
    isBlockedCpaRatioLoser(input) ||
    isLowPurchaseCatastrophicCpaLoser(input) ||
    isMatureZeroPurchaseCutCandidate(input) ||
    isMatureBelowBaselinePurchaseLoser(input) ||
    isHighSpendBelowBaselineCutCandidate(input) ||
    (!shouldRefreshMatureLoser(input) &&
      (isMatureTrendCollapseLoser(input) || isMatureCpaRatioLoser(input)))
  ) {
    return "cut" satisfies CreativeMediaBuyerLoserSignal;
  }
  if (
    isProtectedTrendCollapseRefreshCandidate(input) ||
    isValidatingTrendCollapseRefreshCandidate(input) ||
    isValidatingBelowBaselineCollapseRefreshCandidate(input) ||
    (shouldRefreshMatureLoser(input) &&
      (isMatureTrendCollapseLoser(input) || isMatureCpaRatioLoser(input)))
  ) {
    return "refresh" satisfies CreativeMediaBuyerLoserSignal;
  }
  if (
    isMatureZeroPurchaseWeakCase(input) ||
    isProtectedBelowBaselineMonitorCandidate(input)
  ) {
    return "watch" satisfies CreativeMediaBuyerLoserSignal;
  }
  return "none" satisfies CreativeMediaBuyerLoserSignal;
}

function classifyContextState(input: CreativeOperatorPolicyInput) {
  if (hasWeakCampaignContext(input)) {
    return "campaign_blocked" satisfies CreativeMediaBuyerContextState;
  }
  if (!input.provenance || !input.trust || input.previewStatus?.liveDecisionWindow === "missing") {
    return "data_blocked" satisfies CreativeMediaBuyerContextState;
  }
  if (input.relativeBaseline && !hasRelativeBaselineContext(input)) {
    return "benchmark_weak" satisfies CreativeMediaBuyerContextState;
  }
  if (!input.relativeBaseline) {
    return "unknown" satisfies CreativeMediaBuyerContextState;
  }
  return "clear" satisfies CreativeMediaBuyerContextState;
}

function decide(
  operatorSegment: CreativeOperatorSegment,
  recommendedSegment: CreativeMediaBuyerRecommendedSegment,
  reasons: CreativeMediaBuyerReasonTag[] = [],
  reviewOnly = false,
): Recommendation {
  return {
    operatorSegment,
    recommendedSegment,
    reasons,
    reviewOnly,
  };
}

function resolveRecommendation(
  input: CreativeOperatorPolicyInput,
  businessValidationStatus: CreativeBusinessValidationStatus,
): Recommendation {
  const trust = input.trust ?? null;
  const source = evidenceSource(input);
  const aggressive = AGGRESSIVE_ACTIONS.has(input.primaryAction);
  const reviewOnlyScaleCandidate = isReviewOnlyScaleCandidate(
    input,
    businessValidationStatus,
  );
  const activeTestScaleReviewCandidate =
    isActiveTestStrongRelativeReviewCandidate(input);
  const nonTestHighRelativeReviewCandidate =
    isNonTestHighRelativeReviewCandidate(input, businessValidationStatus);
  const scaleIntent =
    isScaleIntent(input) ||
    reviewOnlyScaleCandidate ||
    activeTestScaleReviewCandidate;
  const relativeScaleReviewIntent =
    (!input.commercialTruthConfigured &&
      (input.primaryAction === "promote_to_scaling" ||
        input.lifecycleState === "scale_ready")) ||
    reviewOnlyScaleCandidate ||
    activeTestScaleReviewCandidate ||
    nonTestHighRelativeReviewCandidate;

  if (!input.provenance) {
    return decide("blocked", "Not Enough Data", ["low_evidence"], true);
  }
  if (!trust) {
    return decide("blocked", "Not Enough Data", ["low_evidence"], true);
  }
  if (source !== "live") {
    return decide("contextual_only", "Not Enough Data", ["low_evidence"], true);
  }
  if (input.previewStatus?.liveDecisionWindow === "missing") {
    return decide("blocked", "Not Enough Data", ["preview_missing"], true);
  }
  if (
    input.previewStatus?.liveDecisionWindow === "metrics_only_degraded" &&
    (aggressive || relativeScaleReviewIntent)
  ) {
    return decide("investigate", "Campaign Check", ["preview_missing"], true);
  }
  if (trust.truthState === "inactive_or_immaterial") {
    return decide("contextual_only", "Not Enough Data", ["low_evidence"], true);
  }
  if (trust.operatorDisposition === "archive_only") {
    return decide("contextual_only", "Not Enough Data", ["low_evidence"], true);
  }
  if (
    hasWeakCampaignContext(input) &&
    (isActiveTestStrongRelativeReviewCandidate(input) ||
      isActiveTestStrongRelativeTestMoreCandidate(input))
  ) {
    return decide("investigate", "Campaign Check", ["campaign_context_blocker"], true);
  }
  if (scaleIntent && hasWeakCampaignContext(input)) {
    return decide("investigate", "Campaign Check", ["campaign_context_blocker"], true);
  }
  if (
    scaleIntent &&
    businessValidationStatus === "favorable" &&
    hasTrueScaleEvidence(input)
  ) {
    return decide("scale_ready", "Scale", ["strong_relative_winner"]);
  }
  if (activeTestScaleReviewCandidate) {
    if (businessValidationStatus === "unfavorable") {
      return decide("hold_monitor", "Watch", ["business_validation_missing"], true);
    }
    return decide(
      "scale_review",
      "Scale Review",
      ["strong_relative_winner", "business_validation_missing"],
      true,
    );
  }
  if (nonTestHighRelativeReviewCandidate) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide(
          "scale_review",
          "Scale Review",
          ["strong_relative_winner", "business_validation_missing"],
          true,
        );
  }
  if (isActiveTestStrongRelativeTestMoreCandidate(input)) {
    return decide("promising_under_sampled", "Test More", ["strong_relative_winner"], true);
  }
  if (isPausedHistoricalWinnerRetestCandidate(input)) {
    return decide("needs_new_variant", "Retest", ["paused_winner", "comeback_candidate"], true);
  }
  if (isFatiguedHighSpendBelowBaselineCutCandidate(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("spend_waste", "Cut", ["below_baseline_waste", "fatigue_pressure"], true);
  }
  if (isFatiguedCpaRatioCutCandidate(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("spend_waste", "Cut", ["catastrophic_cpa", "fatigue_pressure"], true);
  }
  if (isProtectedTrendCollapseRefreshCandidate(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("needs_new_variant", "Refresh", ["trend_collapse", "fatigue_pressure"], true);
  }
  if (isBlockedCpaRatioLoser(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("spend_waste", "Cut", ["catastrophic_cpa"], true);
  }
  if (isLowPurchaseCatastrophicCpaLoser(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("spend_waste", "Cut", ["catastrophic_cpa", "below_baseline_waste"], true);
  }
  if (isProtectedBelowBaselineMonitorCandidate(input)) {
    return decide("hold_monitor", "Watch", ["below_baseline_waste"], true);
  }
  if (input.primaryAction === "hold_no_touch" && !reviewOnlyScaleCandidate) {
    return decide("protected_winner", "Protect", ["strong_relative_winner"], true);
  }
  if (trust.operatorDisposition === "protected_watchlist" && !reviewOnlyScaleCandidate) {
    return decide("protected_winner", "Protect", ["strong_relative_winner"], true);
  }
  if (scaleIntent && hasRelativeScaleReviewEvidence(input)) {
    if (businessValidationStatus === "unfavorable") {
      return decide("hold_monitor", "Watch", ["business_validation_missing"], true);
    }
    return decide(
      "scale_review",
      "Scale Review",
      ["strong_relative_winner", "business_validation_missing"],
      true,
    );
  }
  if (hasRoasOnlyPositiveSignal(input)) {
    return decide("false_winner_low_evidence", "Not Enough Data", ["low_evidence"], true);
  }
  if (isMatureTrendCollapseLoser(input) || isMatureCpaRatioLoser(input)) {
    if (hasWeakCampaignContext(input)) {
      return decide("investigate", "Campaign Check", ["campaign_context_blocker"], true);
    }
    return shouldRefreshMatureLoser(input)
      ? decide("needs_new_variant", "Refresh", ["trend_collapse", "fatigue_pressure"], true)
      : decide("spend_waste", "Cut", ["below_baseline_waste"], true);
  }
  if (isMatureZeroPurchaseCutCandidate(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("spend_waste", "Cut", ["mature_zero_purchase", "below_baseline_waste"], true);
  }
  if (isMatureZeroPurchaseWeakCase(input)) {
    return decide("hold_monitor", "Watch", ["mature_zero_purchase"], true);
  }
  if (isValidatingTrendCollapseRefreshCandidate(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("needs_new_variant", "Refresh", ["trend_collapse"], true);
  }
  if (isValidatingBelowBaselineCollapseRefreshCandidate(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("needs_new_variant", "Refresh", ["trend_collapse", "below_baseline_waste"], true);
  }
  if (isUnderSampled(input)) {
    if (!hasMeaningfulPositiveSupport(input) || input.lifecycleState === "incubating") {
      return decide(
        "creative_learning_incomplete",
        "Not Enough Data",
        ["low_evidence", "creative_learning_incomplete"],
        true,
      );
    }
    if (!hasUnderSampledTestMoreEvidence(input)) {
      return decide(
        "creative_learning_incomplete",
        "Not Enough Data",
        ["low_evidence"],
        true,
      );
    }
    return decide("promising_under_sampled", "Test More", ["low_evidence"], true);
  }
  if (isMatureBelowBaselinePurchaseLoser(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("spend_waste", "Cut", ["below_baseline_waste"], true);
  }
  if (isHighSpendBelowBaselineCutCandidate(input)) {
    return hasWeakCampaignContext(input)
      ? decide("investigate", "Campaign Check", ["campaign_context_blocker"], true)
      : decide("spend_waste", "Cut", ["below_baseline_waste"], true);
  }
  if (scaleIntent && hasRelativeBaselineContext(input) && !hasRelativeScaleReviewEvidence(input)) {
    return decide("hold_monitor", "Watch", ["weak_benchmark"], true);
  }
  if (input.primaryAction === "promote_to_scaling" && !hasScaleEvidence(input)) {
    return input.commercialTruthConfigured
      ? decide("promising_under_sampled", "Test More", ["low_evidence"], true)
      : decide("blocked", "Not Enough Data", ["commercial_truth_missing"], true);
  }
  if (input.primaryAction === "promote_to_scaling") {
    if (!input.commercialTruthConfigured && !hasRelativeBaselineContext(input)) {
      return decide("blocked", "Not Enough Data", ["weak_benchmark"], true);
    }
    return decide("hold_monitor", "Watch", ["weak_benchmark"], true);
  }
  if (input.lifecycleState === "fatigued_winner" || input.fatigue?.status === "fatigued") {
    return input.primaryAction === "refresh_replace"
      ? decide("fatigued_winner", "Refresh", ["fatigue_pressure"], true)
      : decide("needs_new_variant", "Refresh", ["fatigue_pressure"], true);
  }
  if (input.primaryAction === "block_deploy") {
    if (hasKillEvidence(input)) {
      return decide("kill_candidate", "Cut", ["below_baseline_waste"], true);
    }
    if (hasNumber(input.supportingMetrics?.spend) && input.supportingMetrics!.spend! >= 250) {
      return decide("spend_waste", "Cut", ["below_baseline_waste"], true);
    }
    return decide(
      "creative_learning_incomplete",
      "Not Enough Data",
      ["low_evidence"],
      true,
    );
  }
  if (input.primaryAction === "retest_comeback") {
    return decide("needs_new_variant", "Retest", ["comeback_candidate"], true);
  }
  if (input.primaryAction === "keep_in_test") {
    return decide("hold_monitor", "Watch", [], true);
  }
  return decide("investigate", "Campaign Check", ["campaign_context_blocker"], true);
}

function confidenceForRecommendation(
  recommendation: Recommendation,
  evidenceMaturity: CreativeMediaBuyerEvidenceMaturity,
  contextState: CreativeMediaBuyerContextState,
) {
  if (contextState === "campaign_blocked" || contextState === "data_blocked") return 0.72;
  if (evidenceMaturity === "high") return 0.88;
  if (evidenceMaturity === "medium") return 0.78;
  if (recommendation.operatorSegment === "hold_monitor") return 0.58;
  if (evidenceMaturity === "low") return 0.62;
  return 0.48;
}

function blockedActionsForRecommendation(
  recommendation: Recommendation,
  input: CreativeOperatorPolicyInput,
) {
  if (
    recommendation.operatorSegment === "scale_ready" &&
    resolveBusinessValidationStatus(input) === "favorable" &&
    input.evidenceSource === "live"
  ) {
    return ["apply"];
  }
  if (recommendation.operatorSegment === "contextual_only") {
    return ["queue", "push", "apply"];
  }
  if (recommendation.operatorSegment === "blocked") {
    return ["queue", "push", "apply"];
  }
  return ["push", "apply"];
}

function mapBusinessValidation(
  status: CreativeBusinessValidationStatus,
): CreativeMediaBuyerBusinessValidation {
  return status;
}

export function buildCreativeMediaBuyerScorecard(
  input: CreativeOperatorPolicyInput,
): CreativeMediaBuyerScorecard {
  const businessValidationStatus = resolveBusinessValidationStatus(input);
  const recommendation = resolveRecommendation(input, businessValidationStatus);
  const relativePerformanceClass = classifyRelativePerformance(input);
  const evidenceMaturity = classifyEvidenceMaturity(input);
  const trendState = classifyTrendState(input);
  const efficiencyRisk = classifyEfficiencyRisk(input);
  const winnerSignal = classifyWinnerSignal(input, businessValidationStatus);
  const loserSignal = classifyLoserSignal(input);
  const contextState = classifyContextState(input);
  const reasons = uniqueReasonTags([
    ...recommendation.reasons,
    contextState === "benchmark_weak" ? "weak_benchmark" : null,
    businessValidationStatus === "missing" && winnerSignal !== "none"
      ? "business_validation_missing"
      : null,
    !input.commercialTruthConfigured && winnerSignal !== "none"
      ? "commercial_truth_missing"
      : null,
  ]).slice(0, 2);

  return {
    version: CREATIVE_MEDIA_BUYER_SCORING_VERSION,
    relativePerformanceClass,
    evidenceMaturity,
    trendState,
    efficiencyRisk,
    winnerSignal,
    loserSignal,
    contextState,
    businessValidation: mapBusinessValidation(businessValidationStatus),
    recommendedSegment: recommendation.recommendedSegment,
    operatorSegment: recommendation.operatorSegment,
    confidence: confidenceForRecommendation(recommendation, evidenceMaturity, contextState),
    reasons,
    blockedActions: blockedActionsForRecommendation(recommendation, input),
    reviewOnly:
      recommendation.reviewOnly === true ||
      recommendation.operatorSegment !== "scale_ready" ||
      businessValidationStatus !== "favorable",
    pushSafetyUnchanged: true,
    metrics: {
      roasToBenchmark: safeRatio(
        input.supportingMetrics?.roas,
        input.relativeBaseline?.medianRoas,
      ),
      cpaToBenchmark: safeRatio(
        input.supportingMetrics?.cpa,
        input.relativeBaseline?.medianCpa,
      ),
      trendRoasRatio: safeRatio(
        input.supportingMetrics?.recentRoas,
        input.supportingMetrics?.roas,
      ),
      spendToMedian: safeRatio(
        input.supportingMetrics?.spend,
        input.relativeBaseline?.medianSpend,
      ),
    },
  };
}

export function isCreativeBenchmarkReliableForMediaBuyerScorecard(
  reliability: CreativeRelativeBaselineReliability | null | undefined,
) {
  return reliability === "strong" || reliability === "medium";
}
