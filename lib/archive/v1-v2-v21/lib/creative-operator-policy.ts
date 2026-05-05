import type {
  CreativeDecisionBenchmark,
  CreativeDecisionDeploymentRecommendation,
  CreativeDecisionEconomics,
  CreativeDecisionFatigue,
  CreativeDecisionLifecycleState,
  CreativeDecisionPreviewStatus,
  CreativeDecisionPrimaryAction,
} from "@/lib/creative-decision-os";
import type { DecisionTrustMetadata } from "@/src/types/decision-trust";
import type {
  OperatorDecisionProvenance,
  OperatorPolicyAssessment,
  OperatorPolicyState,
} from "@/src/types/operator-decision";
import {
  buildCreativeMediaBuyerScorecard,
  type CreativeMediaBuyerScorecard,
} from "@/lib/creative-media-buyer-scoring";

export const CREATIVE_OPERATOR_POLICY_VERSION = "creative-operator-policy.v1";

export const CREATIVE_OPERATOR_SEGMENTS = [
  "scale_ready",
  "scale_review",
  "promising_under_sampled",
  "false_winner_low_evidence",
  "fatigued_winner",
  "kill_candidate",
  "protected_winner",
  "hold_monitor",
  "needs_new_variant",
  "creative_learning_incomplete",
  "spend_waste",
  "no_touch",
  "investigate",
  "contextual_only",
  "blocked",
] as const;

export type CreativeOperatorSegment =
  (typeof CREATIVE_OPERATOR_SEGMENTS)[number];

export type CreativeEvidenceSource =
  | "live"
  | "demo"
  | "snapshot"
  | "fallback"
  | "unknown";

export type CreativeRelativeBaselineReliability =
  | "strong"
  | "medium"
  | "weak"
  | "unavailable";

type CreativeBusinessValidationStatus =
  | "favorable"
  | "missing"
  | "unfavorable";

export interface CreativeOperatorRelativeBaseline {
  scope: "account" | "campaign";
  benchmarkKey?: string | null;
  scopeId?: string | null;
  scopeLabel?: string | null;
  source?: string | null;
  reliability?: CreativeRelativeBaselineReliability;
  sampleSize: number;
  creativeCount?: number;
  eligibleCreativeCount?: number;
  spendBasis?: number | null;
  purchaseBasis?: number | null;
  weightedRoas?: number | null;
  weightedCpa?: number | null;
  medianRoas?: number | null;
  medianCpa?: number | null;
  medianSpend?: number | null;
  missingContext?: string[];
}

export type CreativeOperatorActionClass =
  | "scale"
  | "kill"
  | "refresh"
  | "protect"
  | "test"
  | "variant"
  | "monitor"
  | "contextual"
  | "unknown";

export interface CreativeOperatorPolicyAssessment
  extends OperatorPolicyAssessment {
  policyVersion: typeof CREATIVE_OPERATOR_POLICY_VERSION;
  segment: CreativeOperatorSegment;
  actionClass: CreativeOperatorActionClass;
  evidenceSource: CreativeEvidenceSource;
  mediaBuyerScorecard?: CreativeMediaBuyerScorecard;
}

export interface CreativeOperatorPolicyInput {
  lifecycleState: CreativeDecisionLifecycleState;
  primaryAction: CreativeDecisionPrimaryAction;
  trust?: DecisionTrustMetadata | null;
  provenance?: OperatorDecisionProvenance | null;
  evidenceSource?: CreativeEvidenceSource;
  commercialTruthConfigured?: boolean;
  commercialMissingInputs?: string[];
  relativeBaseline?: CreativeOperatorRelativeBaseline | null;
  benchmark?: Pick<CreativeDecisionBenchmark, "sampleSize" | "missingContext"> | null;
  fatigue?: Pick<CreativeDecisionFatigue, "status" | "confidence" | "evidence"> | null;
  economics?: Pick<CreativeDecisionEconomics, "status" | "reasons"> | null;
  deployment?: {
    compatibility: Pick<
      CreativeDecisionDeploymentRecommendation["compatibility"],
      "status" | "reasons"
    >;
    constraints: CreativeDecisionDeploymentRecommendation["constraints"];
    targetLane: string | null;
    queueVerdict?: CreativeDecisionDeploymentRecommendation["queueVerdict"];
  } | null;
  deliveryContext?: {
    campaignStatus?: string | null;
    adSetStatus?: string | null;
    campaignName?: string | null;
    adSetName?: string | null;
    campaignIsTestLike?: boolean;
    activeDelivery?: boolean;
    pausedDelivery?: boolean;
  } | null;
  previewStatus?: CreativeDecisionPreviewStatus | null;
  supportingMetrics?: {
    spend?: number | null;
    purchases?: number | null;
    impressions?: number | null;
    roas?: number | null;
    cpa?: number | null;
    frequency?: number | null;
    creativeAgeDays?: number | null;
    recentSpend?: number | null;
    recentPurchases?: number | null;
    recentRoas?: number | null;
  } | null;
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

function unique(values: Array<string | null | undefined>) {
  return Array.from(
    new Set(values.filter((value): value is string => Boolean(value?.trim()))),
  );
}

function hasNumber(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function classifyActionClass(
  action: CreativeDecisionPrimaryAction,
): CreativeOperatorActionClass {
  if (action === "promote_to_scaling") return "scale";
  if (action === "block_deploy") return "kill";
  if (action === "refresh_replace") return "refresh";
  if (action === "hold_no_touch") return "protect";
  if (action === "keep_in_test") return "test";
  if (action === "retest_comeback") return "variant";
  return "unknown";
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

function hasRelativeScaleReviewEvidence(input: CreativeOperatorPolicyInput) {
  const metrics = input.supportingMetrics ?? {};
  const baseline = input.relativeBaseline ?? null;
  if (!hasRelativeBaselineContext(input)) return false;
  if (!baseline) return false;
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

function hasRelativeBaselineContext(input: CreativeOperatorPolicyInput) {
  const baseline = input.relativeBaseline ?? null;
  const reliability = baseline?.reliability ?? "unavailable";
  const reliable =
    reliability === "strong" ||
    reliability === "medium";
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

function isRelativeScaleReviewIntent(input: CreativeOperatorPolicyInput) {
  return (
    !input.commercialTruthConfigured &&
    (input.primaryAction === "promote_to_scaling" ||
      input.lifecycleState === "scale_ready")
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
  if (
    input.primaryAction !== "hold_no_touch" &&
    input.primaryAction !== "keep_in_test" &&
    input.primaryAction !== "promote_to_scaling" &&
    input.primaryAction !== "refresh_replace"
  ) {
    return false;
  }
  return true;
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
  const spend = metrics.spend ?? null;
  const purchases = metrics.purchases ?? null;
  const impressions = metrics.impressions ?? null;
  return (
    hasNumber(spend) &&
    spend >= 250 &&
    ((hasNumber(purchases) && purchases >= 4) ||
      (hasNumber(impressions) && impressions >= 8_000))
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
  const meaningfulPurchaseEvidence = purchaseCount >= 2;
  return (
    hasNumber(metrics.roas) &&
    metrics.roas >= 2 &&
    !meaningfulPurchaseEvidence &&
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

function isFatiguedHighSpendBelowBaselineCutCandidate(input: CreativeOperatorPolicyInput) {
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
  if (!hasNumber(metrics.creativeAgeDays) || metrics.creativeAgeDays <= 10) return false;
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

function hasWeakCampaignContext(input: CreativeOperatorPolicyInput) {
  return input.deployment?.compatibility.status === "blocked";
}

function resolveSegment(params: {
  policyInput: CreativeOperatorPolicyInput;
  evidenceSource: CreativeEvidenceSource;
  blockers: string[];
  missingEvidence: string[];
  aggressive: boolean;
  scorecard?: CreativeMediaBuyerScorecard;
}): CreativeOperatorSegment {
  const { policyInput: input } = params;
  const scorecard = params.scorecard ?? buildCreativeMediaBuyerScorecard(input);
  return scorecard.operatorSegment;
}

function resolveState(input: {
  segment: CreativeOperatorSegment;
  primaryAction: CreativeDecisionPrimaryAction;
  blockers: string[];
  evidenceSource: CreativeEvidenceSource;
  aggressive: boolean;
}): OperatorPolicyState {
  if (input.evidenceSource !== "live") return "contextual_only";
  if (input.segment === "blocked") return "blocked";
  if (input.segment === "contextual_only") return "contextual_only";
  if (input.segment === "protected_winner" || input.segment === "no_touch") {
    return "do_not_touch";
  }
  if (input.segment === "scale_review") {
    return "investigate";
  }
  if (
    input.segment === "false_winner_low_evidence" ||
    input.segment === "promising_under_sampled" ||
    input.segment === "creative_learning_incomplete" ||
    input.segment === "hold_monitor"
  ) {
    return "watch";
  }
  if (input.blockers.length > 0) {
    return input.aggressive ? "blocked" : "investigate";
  }
  if (input.segment === "scale_ready" || input.segment === "kill_candidate") {
    return "do_now";
  }
  if (
    input.segment === "fatigued_winner" ||
    input.segment === "needs_new_variant" ||
    input.segment === "spend_waste" ||
    input.segment === "investigate"
  ) {
    return "investigate";
  }
  return "investigate";
}

function resolvePushReadiness(input: {
  state: OperatorPolicyState;
  segment: CreativeOperatorSegment;
  actionClass: CreativeOperatorActionClass;
  provenance: OperatorDecisionProvenance | null;
  blockers: string[];
  hardBlockers: string[];
}) {
  if (!input.provenance || input.state === "blocked") {
    return "blocked_from_push" as const;
  }
  if (input.hardBlockers.length > 0) {
    return "blocked_from_push" as const;
  }
  if (input.segment === "scale_review") {
    return "operator_review_required" as const;
  }
  if (input.blockers.length > 0) {
    return "blocked_from_push" as const;
  }
  if (input.state === "contextual_only" || input.state === "do_not_touch") {
    return "blocked_from_push" as const;
  }
  if (input.state === "watch") return "read_only_insight" as const;
  if (input.actionClass === "kill" || input.actionClass === "refresh") {
    return "operator_review_required" as const;
  }
  if (input.state === "do_now" && input.segment === "scale_ready") {
    return "safe_to_queue" as const;
  }
  return "operator_review_required" as const;
}

export function assessCreativeOperatorPolicy(
  input: CreativeOperatorPolicyInput,
): CreativeOperatorPolicyAssessment {
  const mediaBuyerScorecard = buildCreativeMediaBuyerScorecard(input);
  const trust = input.trust ?? null;
  const provenance = input.provenance ?? null;
  const evidenceSource = input.evidenceSource ?? "unknown";
  const actionClass = classifyActionClass(input.primaryAction);
  const aggressive = AGGRESSIVE_ACTIONS.has(input.primaryAction);
  const commercialTruthConfigured = Boolean(input.commercialTruthConfigured);
  const businessValidationStatus = resolveBusinessValidationStatus(input);
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
  const previewState = input.previewStatus?.liveDecisionWindow ?? "missing";
  const weakCampaignContext = hasWeakCampaignContext(input);
  const lowEvidence = isUnderSampled(input);
  const roasOnly = hasRoasOnlyPositiveSignal(input);
  const scaleAction =
    SCALE_ACTIONS.has(input.primaryAction) ||
    reviewOnlyScaleCandidate ||
    activeTestScaleReviewCandidate;
  const relativeScaleReviewIntent =
    isRelativeScaleReviewIntent(input) ||
    reviewOnlyScaleCandidate ||
    activeTestScaleReviewCandidate ||
    nonTestHighRelativeReviewCandidate;
  const killOrRefreshAction = KILL_OR_REFRESH_ACTIONS.has(input.primaryAction);
  const matureZeroPurchaseCutCandidate = isMatureZeroPurchaseCutCandidate(input);
  const matureBelowBaselinePurchaseLoser = isMatureBelowBaselinePurchaseLoser(input);
  const matureTrendCollapseLoser = isMatureTrendCollapseLoser(input);
  const matureCpaRatioLoser = isMatureCpaRatioLoser(input);
  const protectedTrendCollapseRefreshCandidate =
    isProtectedTrendCollapseRefreshCandidate(input);
  const fatiguedHighSpendBelowBaselineCutCandidate =
    isFatiguedHighSpendBelowBaselineCutCandidate(input);
  const fatiguedCpaRatioCutCandidate = isFatiguedCpaRatioCutCandidate(input);
  const blockedCpaRatioLoser = isBlockedCpaRatioLoser(input);
  const lowPurchaseCatastrophicCpaLoser =
    isLowPurchaseCatastrophicCpaLoser(input);
  const highSpendBelowBaselineCutCandidate =
    isHighSpendBelowBaselineCutCandidate(input);
  const validatingTrendCollapseRefreshCandidate =
    isValidatingTrendCollapseRefreshCandidate(input);
  const validatingBelowBaselineCollapseRefreshCandidate =
    isValidatingBelowBaselineCollapseRefreshCandidate(input);
  const negativeActionIntent =
    killOrRefreshAction ||
    matureZeroPurchaseCutCandidate ||
    matureBelowBaselinePurchaseLoser ||
    matureTrendCollapseLoser ||
    matureCpaRatioLoser ||
    protectedTrendCollapseRefreshCandidate ||
    fatiguedHighSpendBelowBaselineCutCandidate ||
    fatiguedCpaRatioCutCandidate ||
    blockedCpaRatioLoser ||
    lowPurchaseCatastrophicCpaLoser ||
    highSpendBelowBaselineCutCandidate ||
    validatingTrendCollapseRefreshCandidate ||
    validatingBelowBaselineCollapseRefreshCandidate;
  const requiresCommercialTruth = scaleAction;
  const needsRelativeBaseline = scaleIntent && !hasRelativeBaselineContext(input);
  const requiresCampaignContext =
    scaleIntent ||
    nonTestHighRelativeReviewCandidate ||
    matureZeroPurchaseCutCandidate ||
    matureBelowBaselinePurchaseLoser ||
    matureTrendCollapseLoser ||
    matureCpaRatioLoser ||
    protectedTrendCollapseRefreshCandidate ||
    fatiguedHighSpendBelowBaselineCutCandidate ||
    fatiguedCpaRatioCutCandidate ||
    blockedCpaRatioLoser ||
    lowPurchaseCatastrophicCpaLoser ||
    highSpendBelowBaselineCutCandidate ||
    validatingTrendCollapseRefreshCandidate ||
    validatingBelowBaselineCollapseRefreshCandidate;
  const businessValidationMissing =
    (scaleIntent || nonTestHighRelativeReviewCandidate) &&
    businessValidationStatus === "missing";
  const businessValidationUnfavorable =
    scaleIntent && businessValidationStatus === "unfavorable";

  const requiredEvidence = unique([
    "stable_operator_decision_context",
    "evidence_source",
    "row_provenance",
    "row_trust",
    "preview_truth",
    requiresCommercialTruth ? "commercial_truth" : null,
    scaleIntent || nonTestHighRelativeReviewCandidate ? "relative_baseline" : null,
    scaleIntent || nonTestHighRelativeReviewCandidate ? "business_validation" : null,
    scaleIntent || negativeActionIntent ? "evidence_floor" : null,
    requiresCampaignContext ? "campaign_or_adset_context" : null,
    negativeActionIntent ? "sufficient_negative_evidence" : null,
  ]);

  const missingEvidence = unique([
    !provenance ? "row_provenance" : null,
    evidenceSource === "unknown" ? "evidence_source" : null,
    !trust ? "row_trust" : null,
    previewState === "missing" ? "preview_truth" : null,
    requiresCommercialTruth && !commercialTruthConfigured ? "commercial_truth" : null,
    needsRelativeBaseline ? "relative_baseline" : null,
    businessValidationMissing && !requiresCommercialTruth ? "business_validation" : null,
    businessValidationUnfavorable ? "business_validation" : null,
    (scaleIntent || killOrRefreshAction) && lowEvidence ? "evidence_floor" : null,
    matureZeroPurchaseCutCandidate && !hasKillEvidence(input) ? "evidence_floor" : null,
    (matureTrendCollapseLoser ||
      matureCpaRatioLoser ||
      protectedTrendCollapseRefreshCandidate ||
      fatiguedHighSpendBelowBaselineCutCandidate ||
      fatiguedCpaRatioCutCandidate ||
      blockedCpaRatioLoser ||
      lowPurchaseCatastrophicCpaLoser ||
      highSpendBelowBaselineCutCandidate ||
      validatingTrendCollapseRefreshCandidate ||
      validatingBelowBaselineCollapseRefreshCandidate) &&
    !hasKillEvidence(input)
      ? "evidence_floor"
      : null,
    roasOnly ? "non_roas_evidence" : null,
    requiresCampaignContext && weakCampaignContext ? "campaign_or_adset_context" : null,
    input.benchmark?.sampleSize === 0 ? "benchmark_context" : null,
  ]);

  const blockers = unique([
    !provenance ? "Missing decision provenance." : null,
    evidenceSource === "unknown"
      ? "Evidence source is missing, so Creative action remains contextual."
      : null,
    evidenceSource !== "live" && evidenceSource !== "unknown"
      ? `${evidenceSource} evidence is contextual and cannot authorize primary Creative action.`
      : null,
    !trust ? "Decision trust metadata is missing." : null,
    trust?.truthState === "degraded_missing_truth" && requiresCommercialTruth
      ? "Commercial truth is degraded or missing, so aggressive Creative action is blocked."
      : null,
    trust?.truthState === "inactive_or_immaterial"
      ? "Creative is inactive or immaterial for primary action."
      : null,
    trust?.evidence?.aggressiveActionBlocked && requiresCommercialTruth
      ? trust.evidence.aggressiveActionBlockReasons[0] ??
        "Aggressive Creative action is blocked by trust metadata."
      : null,
    trust?.evidence?.suppressed
      ? trust.evidence.suppressionReasons[0] ??
        "Creative decision is suppressed from primary action."
      : null,
    previewState === "missing"
      ? "Preview truth is missing, so queue and push eligibility are blocked."
      : null,
    previewState === "metrics_only_degraded" && aggressive
      ? "Preview truth is degraded, so aggressive Creative action requires review."
      : null,
    requiresCommercialTruth && !commercialTruthConfigured
      ? "Configured commercial truth is required before Creative scale decisions can be validated."
      : null,
    needsRelativeBaseline
      ? "Account or campaign relative baseline is missing, so Scale Review cannot be inferred."
      : null,
    businessValidationMissing && !requiresCommercialTruth
      ? "Business validation is still missing, so this creative stays review-only."
      : null,
    businessValidationUnfavorable
      ? "Business validation does not yet support a direct scale move."
      : null,
    scaleAction && !hasScaleEvidence(input)
      ? "Scale evidence floor is not met; ROAS alone is not enough."
      : null,
    negativeActionIntent && !hasKillEvidence(input)
      ? "Kill or refresh evidence floor is not met."
      : null,
    requiresCampaignContext && weakCampaignContext
      ? "Campaign or ad set context limits this creative interpretation."
      : null,
  ]);
  const hardBlockers = unique([
    !provenance ? "Missing decision provenance." : null,
    evidenceSource !== "live"
      ? evidenceSource === "unknown"
        ? "Evidence source is missing, so Creative action remains contextual."
        : `${evidenceSource} evidence is contextual and cannot authorize primary Creative action.`
      : null,
    !trust ? "Decision trust metadata is missing." : null,
    previewState === "missing"
      ? "Preview truth is missing, so queue and push eligibility are blocked."
      : null,
    previewState === "metrics_only_degraded" && relativeScaleReviewIntent
      ? "Preview truth is degraded, so relative Scale Review cannot become push-review ready."
      : null,
    trust?.truthState === "inactive_or_immaterial"
      ? "Creative is inactive or immaterial for primary action."
      : null,
    trust?.operatorDisposition === "archive_only"
      ? "Creative is archive-only and not eligible for live evaluation."
      : null,
    trust?.evidence?.suppressed
      ? trust.evidence.suppressionReasons[0] ??
        "Creative decision is suppressed from primary action."
      : null,
    requiresCampaignContext && weakCampaignContext
      ? "Campaign or ad set context limits this creative interpretation."
      : null,
  ]);

  const segment = resolveSegment({
    policyInput: input,
    evidenceSource,
    blockers,
    missingEvidence,
    aggressive,
    scorecard: mediaBuyerScorecard,
  });
  const state = resolveState({
    segment,
    primaryAction: input.primaryAction,
    blockers,
    evidenceSource,
    aggressive,
  });
  const pushReadiness = resolvePushReadiness({
    state,
    segment,
    actionClass,
    provenance,
    blockers,
    hardBlockers,
  });
  const queueEligible = pushReadiness === "safe_to_queue";
  const reasons = unique([
    trust?.reasons[0],
    input.fatigue?.evidence?.[0],
    input.economics?.reasons?.[0],
    input.deployment?.constraints?.[0],
    ...(input.commercialMissingInputs ?? []).map((field) => `Missing commercial input: ${field}`),
    blockers[0],
    missingEvidence.length > 0
      ? `Missing evidence: ${missingEvidence.join(", ")}.`
      : null,
  ]);

  return {
    contractVersion: "operator-policy.v1",
    policyVersion: CREATIVE_OPERATOR_POLICY_VERSION,
    state,
    segment,
    actionClass,
    evidenceSource,
    mediaBuyerScorecard,
    pushReadiness,
    queueEligible,
    canApply: false,
    reasons: reasons.length > 0 ? reasons : ["Creative operator policy check completed."],
    blockers,
    missingEvidence,
    requiredEvidence,
    explanation:
      blockers.length > 0
        ? blockers[0]
        : state === "do_now"
          ? "Deterministic Creative policy allows this as operator work, but provider push remains disabled."
          : state === "do_not_touch"
            ? "Deterministic Creative policy marks this creative as protected."
            : "Deterministic Creative policy keeps this as review, watch, or context.",
  };
}
