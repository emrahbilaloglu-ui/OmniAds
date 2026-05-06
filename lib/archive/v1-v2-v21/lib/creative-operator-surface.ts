import type {
  CreativeDecisionOsCreative,
  CreativeDecisionOsV1Response,
} from "@/lib/creative-decision-os";
import { buildOperatorInstruction } from "@/lib/operator-prescription";
import {
  buildOperatorBuckets,
  operatorConfidenceBand,
  titleFromEnum,
  type OperatorAuthorityState,
  type OperatorSurfaceItem,
  type OperatorSurfaceMetric,
  type OperatorSurfaceModel,
} from "@/lib/operator-surface";
import type {
  OperatorInstructionTargetContext,
  OperatorInstructionUrgency,
} from "@/src/types/operator-decision";

export const CREATIVE_QUICK_FILTER_ORDER = [
  "scale",
  "test_more",
  "protect",
  "refresh",
  "cut",
  "diagnose",
] as const;

export type CreativeQuickFilterKey = (typeof CREATIVE_QUICK_FILTER_ORDER)[number];

export type CreativeOperatorPrimaryDecision =
  | "scale"
  | "test_more"
  | "protect"
  | "refresh"
  | "cut"
  | "diagnose";

export type CreativeOperatorSubTone =
  | "default"
  | "review_only"
  | "queue_ready"
  | "revive"
  | "manual_review";

export type CreativeOperatorReasonTag =
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

export interface CreativeOperatorDecisionResolution {
  primary: CreativeOperatorPrimaryDecision;
  subTone: CreativeOperatorSubTone;
  reasons: CreativeOperatorReasonTag[];
}

export interface CreativeQuickFilter {
  key: CreativeQuickFilterKey;
  label: string;
  summary: string;
  count: number;
  creativeIds: string[];
  tone: OperatorAuthorityState;
  actionableCount?: number;
  reviewOnlyCount?: number;
  mutedCount?: number;
}

export interface CreativeScaleActionabilityCounts {
  total: number;
  actionable: number;
  reviewOnly: number;
  muted: number;
}

const CREATIVE_QUICK_FILTER_DEFS: Record<
  CreativeQuickFilterKey,
  Omit<CreativeQuickFilter, "count" | "creativeIds">
> = {
  scale: {
    key: "scale",
    label: "Scale",
    summary: "Scale candidates, including review-only relative winners.",
    tone: "act_now",
  },
  test_more: {
    key: "test_more",
    label: "Test More",
    summary: "Promising rows that need more evidence before a stronger move.",
    tone: "watch",
  },
  protect: {
    key: "protect",
    label: "Protect",
    summary: "Stable winners that should stay live without unnecessary changes.",
    tone: "no_action",
  },
  refresh: {
    key: "refresh",
    label: "Refresh",
    summary: "Fatigued, paused, or stale variants that need a new angle.",
    tone: "blocked",
  },
  cut: {
    key: "cut",
    label: "Cut",
    summary: "Waste or failure cases that should stop taking spend.",
    tone: "blocked",
  },
  diagnose: {
    key: "diagnose",
    label: "Diagnose",
    summary: "Rows blocked by campaign context, missing preview truth, or low evidence.",
    tone: "needs_truth",
  },
};

export interface CreativePreviewTruthSummary {
  totalCount: number;
  readyCount: number;
  degradedCount: number;
  missingCount: number;
  state: "ready" | "degraded" | "missing";
  headline: string;
  summary: string;
}

export function creativeQuickFilterShortLabel(key: CreativeQuickFilterKey) {
  return CREATIVE_QUICK_FILTER_DEFS[key]?.label ?? key;
}

export function creativeOperatorPrimaryDecisionLabel(
  primary: CreativeOperatorPrimaryDecision,
) {
  switch (primary) {
    case "scale":
      return "Scale";
    case "test_more":
      return "Test More";
    case "protect":
      return "Protect";
    case "refresh":
      return "Refresh";
    case "cut":
      return "Cut";
    case "diagnose":
      return "Diagnose";
    default:
      return titleFromEnum(primary);
  }
}

export function creativeOperatorSubToneLabel(
  subTone: CreativeOperatorSubTone,
) {
  switch (subTone) {
    case "review_only":
      return "Review only";
    case "queue_ready":
      return "Queue ready";
    case "revive":
      return "Revive";
    case "manual_review":
      return "Manual review";
    case "default":
    default:
      return null;
  }
}

export function creativeOperatorReasonTagLabel(
  reason: CreativeOperatorReasonTag,
) {
  switch (reason) {
    case "strong_relative_winner":
      return "Strong relative winner";
    case "business_validation_missing":
      return "Business target missing";
    case "commercial_truth_missing":
      return "Commercial truth missing";
    case "weak_benchmark":
      return "Thin benchmark";
    case "fatigue_pressure":
      return "Fatigue pressure";
    case "trend_collapse":
      return "Trend collapse";
    case "catastrophic_cpa":
      return "CPA blowout";
    case "below_baseline_waste":
      return "Below baseline waste";
    case "mature_zero_purchase":
      return "Mature no purchase";
    case "comeback_candidate":
      return "Comeback candidate";
    case "paused_winner":
      return "Paused winner";
    case "campaign_context_blocker":
      return "Campaign context";
    case "low_evidence":
      return "Low evidence";
    case "preview_missing":
      return "Preview missing";
    case "creative_learning_incomplete":
      return "Learning incomplete";
    default:
      return titleFromEnum(reason);
  }
}

export function creativeAuthorityStateLabel(state: OperatorAuthorityState) {
  if (state === "watch") return "Scale review-only / Test More";
  if (state === "no_action") return "Protect";
  if (state === "act_now") return "Scale";
  if (state === "needs_truth") return "Diagnose";
  return "Refresh / Cut";
}

export function creativeBenchmarkReliabilityLabel(value: string | null | undefined) {
  switch (value) {
    case "strong":
      return "Strong";
    case "medium":
      return "Medium";
    case "weak":
      return "Thin";
    default:
      return "Unavailable";
  }
}

function resolvedCreativeBenchmarkScopeLabel(creative: CreativeDecisionOsCreative) {
  if (creative.benchmarkScopeLabel?.trim()) return creative.benchmarkScopeLabel.trim();
  if (creative.relativeBaseline?.scopeLabel?.trim()) return creative.relativeBaseline.scopeLabel.trim();
  if (creative.benchmarkScope === "campaign" || creative.relativeBaseline?.scope === "campaign") {
    return "Selected campaign";
  }
  return "Account-wide";
}

function creativeNeedsBusinessValidation(creative: CreativeDecisionOsCreative) {
  const missingEvidence = creative.operatorPolicy?.missingEvidence ?? [];
  if (missingEvidence.some((item) => item.toLowerCase().includes("commercial_truth"))) {
    return true;
  }
  return (
    creative.trust.operatorDisposition === "profitable_truth_capped" ||
    creative.trust.truthState === "degraded_missing_truth"
  );
}

export function creativeBusinessValidationNote(creative: CreativeDecisionOsCreative) {
  const missingEvidence = creative.operatorPolicy?.missingEvidence ?? [];
  if (creativeNeedsBusinessValidation(creative)) {
    return "Business validation is still missing, so this stays review-only.";
  }
  if (missingEvidence.includes("business_validation")) {
    return "Business validation does not support a direct scale move yet.";
  }
  return null;
}

function isMatureZeroPurchaseWeakWatch(creative: CreativeDecisionOsCreative) {
  return (
    creative.operatorPolicy?.segment === "hold_monitor" &&
    creative.primaryAction === "keep_in_test" &&
    creative.purchases === 0 &&
    creative.spend >= 250 &&
    creative.impressions >= 5_000 &&
    creative.creativeAgeDays > 10
  );
}

function isMatureZeroPurchaseCutReview(creative: CreativeDecisionOsCreative) {
  return (
    creative.operatorPolicy?.segment === "spend_waste" &&
    creative.primaryAction === "keep_in_test" &&
    creative.purchases === 0 &&
    creative.spend >= 250 &&
    creative.impressions >= 8_000 &&
    creative.creativeAgeDays > 10
  );
}

function isMatureBelowBaselinePurchaseCutReview(creative: CreativeDecisionOsCreative) {
  const medianRoas = creative.relativeBaseline?.medianRoas ?? null;
  const medianSpend = creative.relativeBaseline?.medianSpend ?? null;
  return (
    creative.operatorPolicy?.segment === "spend_waste" &&
    creative.primaryAction === "keep_in_test" &&
    creative.lifecycleState === "validating" &&
    creative.purchases >= 4 &&
    creative.spend >= Math.max(1_000, (medianSpend ?? 0) * 3) &&
    medianRoas != null &&
    medianRoas > 0 &&
    creative.roas <= medianRoas * 0.8 &&
    creative.creativeAgeDays > 10
  );
}

function isValidatingBelowBaselineRefreshReview(creative: CreativeDecisionOsCreative) {
  const medianRoas = creative.relativeBaseline?.medianRoas ?? null;
  return (
    creative.operatorPolicy?.segment === "needs_new_variant" &&
    creative.lifecycleState === "validating" &&
    creative.primaryAction === "keep_in_test" &&
    creative.spend >= 300 &&
    creative.purchases >= 2 &&
    creative.impressions >= 3_000 &&
    medianRoas != null &&
    medianRoas > 0 &&
    creative.roas <= medianRoas * 0.4
  );
}

function hasTestMoreFatigueCaveat(creative: CreativeDecisionOsCreative) {
  return (
    creative.operatorPolicy?.segment === "promising_under_sampled" &&
    creative.fatigue?.status === "watch"
  );
}

function isPausedHistoricalRetest(creative: CreativeDecisionOsCreative) {
  const actionCanRetest =
    creative.primaryAction === "hold_no_touch" ||
    creative.primaryAction === "keep_in_test" ||
    creative.primaryAction === "promote_to_scaling" ||
    creative.primaryAction === "retest_comeback";
  const historicalWinnerContext =
    creative.lifecycleState === "stable_winner" ||
    creative.lifecycleState === "scale_ready" ||
    creative.primaryAction === "hold_no_touch" ||
    creative.primaryAction === "promote_to_scaling" ||
    creative.primaryAction === "retest_comeback";
  return (
    creative.operatorPolicy?.segment === "needs_new_variant" &&
    actionCanRetest &&
    historicalWinnerContext &&
    creative.deliveryContext?.pausedDelivery === true
  );
}

const DIAGNOSTIC_REASON_TAGS = new Set<CreativeOperatorReasonTag>([
  "campaign_context_blocker",
  "low_evidence",
  "preview_missing",
  "creative_learning_incomplete",
]);

function uniqueReasonTags(values: CreativeOperatorReasonTag[]) {
  return Array.from(new Set(values));
}

function safeTextItems(values: Array<string | null | undefined> | null | undefined) {
  return values?.filter((value): value is string => Boolean(value?.trim())) ?? [];
}

function creativeDecisionSignalText(creative: CreativeDecisionOsCreative) {
  return [
    creative.summary,
    creative.operatorPolicy?.explanation,
    ...safeTextItems(creative.operatorPolicy?.reasons),
    ...safeTextItems(creative.operatorPolicy?.blockers),
    ...safeTextItems(creative.operatorPolicy?.missingEvidence),
    ...safeTextItems(creative.operatorPolicy?.requiredEvidence),
    ...safeTextItems(creative.deployment?.constraints),
    ...safeTextItems(creative.deployment?.compatibility?.reasons),
    ...safeTextItems(creative.fatigue?.evidence),
    ...safeTextItems(creative.fatigue?.missingContext),
    ...safeTextItems(creative.relativeBaseline?.missingContext),
    ...safeTextItems(creative.benchmark?.missingContext),
    creative.previewStatus?.reason,
  ]
    .filter(Boolean)
    .join(" ")
    .toLowerCase();
}

function hasCampaignContextBlocker(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  return (
    creative.operatorPolicy?.segment === "investigate" ||
    creative.deployment?.compatibility?.status === "blocked" ||
    creative.deployment?.compatibility?.status === "limited" ||
    text.includes("campaign_or_adset_context") ||
    text.includes("campaign or ad set") ||
    text.includes("campaign context") ||
    text.includes("ad set context")
  );
}

function hasPreviewMissingSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  return (
    creative.previewStatus?.liveDecisionWindow === "missing" ||
    text.includes("preview_truth") ||
    text.includes("preview missing") ||
    text.includes("preview truth is missing")
  );
}

function hasWeakBenchmarkSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  const reliability =
    creative.benchmarkReliability ??
    creative.relativeBaseline?.reliability ??
    "unavailable";
  return (
    reliability === "weak" ||
    reliability === "unavailable" ||
    text.includes("relative_baseline") ||
    text.includes("benchmark_context") ||
    text.includes("benchmark is still too thin") ||
    text.includes("relative benchmark is weak")
  );
}

function hasLowEvidenceSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  return (
    creative.operatorPolicy?.segment === "false_winner_low_evidence" ||
    creative.operatorPolicy?.segment === "creative_learning_incomplete" ||
    creative.trust?.evidence?.materiality === "thin_signal" ||
    creative.trust?.evidence?.materiality === "immaterial" ||
    text.includes("evidence_floor") ||
    text.includes("low_evidence") ||
    text.includes("thin signal") ||
    text.includes("under-sampled") ||
    text.includes("sample is still light") ||
    creative.spend < 120 ||
    creative.purchases < 2 ||
    creative.impressions < 5_000 ||
    creative.creativeAgeDays <= 10
  );
}

function hasStrongRelativeWinnerSignal(creative: CreativeDecisionOsCreative) {
  const medianRoas = creative.relativeBaseline?.medianRoas ?? null;
  const reliability =
    creative.benchmarkReliability ??
    creative.relativeBaseline?.reliability ??
    "unavailable";
  return (
    creative.operatorPolicy?.segment === "scale_ready" ||
    creative.operatorPolicy?.segment === "scale_review" ||
    ((reliability === "strong" || reliability === "medium") &&
      medianRoas != null &&
      medianRoas > 0 &&
      Number.isFinite(creative.roas) &&
      creative.roas >= medianRoas * 1.4)
  );
}

function hasFatiguePressureSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  return (
    creative.fatigue?.status === "fatigued" ||
    creative.fatigue?.status === "watch" ||
    (creative.fatigue?.frequencyPressure ?? 0) >= 3 ||
    text.includes("fatigue") ||
    text.includes("frequency pressure")
  );
}

function hasTrendCollapseSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  const recentRoas =
    (creative as { recentRoas?: number | null }).recentRoas ??
    (creative.report as { supportingMetrics?: { recentRoas?: number | null } } | undefined)
      ?.supportingMetrics?.recentRoas ??
    null;
  return (
    text.includes("trend_collapse") ||
    text.includes("trend collapse") ||
    text.includes("roas decay") ||
    text.includes("collapsed") ||
    (typeof recentRoas === "number" &&
      Number.isFinite(recentRoas) &&
      Number.isFinite(creative.roas) &&
      creative.roas > 0 &&
      recentRoas / creative.roas <= 0.4)
  );
}

function hasCatastrophicCpaSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  const medianCpa = creative.relativeBaseline?.medianCpa ?? null;
  return (
    text.includes("catastrophic_cpa") ||
    text.includes("cpa") && text.includes("median") ||
    (medianCpa != null &&
      medianCpa > 0 &&
      Number.isFinite(creative.cpa) &&
      creative.cpa >= medianCpa * 2)
  );
}

function hasBelowBaselineWasteSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  const medianRoas = creative.relativeBaseline?.medianRoas ?? null;
  return (
    text.includes("below_baseline") ||
    text.includes("below baseline") ||
    text.includes("below-benchmark") ||
    text.includes("spend waste") ||
    (medianRoas != null &&
      medianRoas > 0 &&
      Number.isFinite(creative.roas) &&
      creative.roas <= medianRoas * 0.8)
  );
}

function hasMatureZeroPurchaseSignal(creative: CreativeDecisionOsCreative, signalText?: string) {
  const text = signalText ?? creativeDecisionSignalText(creative);
  return (
    text.includes("zero purchase") ||
    text.includes("no purchase proof") ||
    (creative.purchases === 0 &&
      creative.spend >= 250 &&
      creative.impressions >= 5_000 &&
      creative.creativeAgeDays > 10)
  );
}

function appendDecisionReasonSignals(
  creative: CreativeDecisionOsCreative,
  reasons: CreativeOperatorReasonTag[],
  options?: { includeStrength?: boolean },
) {
  const text = creativeDecisionSignalText(creative);
  if (options?.includeStrength && hasStrongRelativeWinnerSignal(creative)) {
    reasons.push("strong_relative_winner");
  }
  if (creativeNeedsBusinessValidation(creative) || text.includes("business_validation")) {
    reasons.push("business_validation_missing");
  }
  if (text.includes("commercial_truth") || creative.trust?.truthState === "degraded_missing_truth") {
    reasons.push("commercial_truth_missing");
  }
  if (hasWeakBenchmarkSignal(creative, text)) reasons.push("weak_benchmark");
  if (hasCampaignContextBlocker(creative, text)) reasons.push("campaign_context_blocker");
  if (hasPreviewMissingSignal(creative, text)) reasons.push("preview_missing");
  if (creative.operatorPolicy?.segment === "creative_learning_incomplete") {
    reasons.push("creative_learning_incomplete");
  }
  if (hasLowEvidenceSignal(creative, text)) reasons.push("low_evidence");
  if (hasFatiguePressureSignal(creative, text)) reasons.push("fatigue_pressure");
  if (hasTrendCollapseSignal(creative, text)) reasons.push("trend_collapse");
  if (hasCatastrophicCpaSignal(creative, text)) reasons.push("catastrophic_cpa");
  if (hasBelowBaselineWasteSignal(creative, text)) reasons.push("below_baseline_waste");
  if (hasMatureZeroPurchaseSignal(creative, text)) reasons.push("mature_zero_purchase");
  if (creative.primaryAction === "retest_comeback") reasons.push("comeback_candidate");
  if (creative.deliveryContext?.pausedDelivery) reasons.push("paused_winner");
}

function rankDecisionReasons(
  primary: CreativeOperatorPrimaryDecision,
  reasons: CreativeOperatorReasonTag[],
) {
  const orderByPrimary: Record<CreativeOperatorPrimaryDecision, CreativeOperatorReasonTag[]> = {
    scale: [
      "strong_relative_winner",
      "business_validation_missing",
      "commercial_truth_missing",
      "weak_benchmark",
      "campaign_context_blocker",
    ],
    test_more: [
      "strong_relative_winner",
      "low_evidence",
      "creative_learning_incomplete",
      "weak_benchmark",
      "business_validation_missing",
    ],
    protect: [
      "strong_relative_winner",
      "fatigue_pressure",
      "trend_collapse",
      "weak_benchmark",
    ],
    refresh: [
      "paused_winner",
      "comeback_candidate",
      "trend_collapse",
      "fatigue_pressure",
      "below_baseline_waste",
    ],
    cut: [
      "catastrophic_cpa",
      "mature_zero_purchase",
      "below_baseline_waste",
      "trend_collapse",
      "campaign_context_blocker",
    ],
    diagnose: [
      "campaign_context_blocker",
      "preview_missing",
      "creative_learning_incomplete",
      "low_evidence",
      "weak_benchmark",
    ],
  };
  const uniqueReasons = uniqueReasonTags(reasons);
  const preferred = orderByPrimary[primary].filter((reason) =>
    uniqueReasons.includes(reason),
  );
  const remainder = uniqueReasons.filter((reason) => !preferred.includes(reason));
  return [...preferred, ...remainder].slice(0, 2);
}

function finalizeCreativeOperatorDecision(
  creative: CreativeDecisionOsCreative,
  primary: CreativeOperatorPrimaryDecision,
  subTone: CreativeOperatorSubTone,
  reasons: CreativeOperatorReasonTag[],
): CreativeOperatorDecisionResolution {
  const expandedReasons = [...reasons];

  if (primary === "diagnose") {
    const hasDiagnosticReason = expandedReasons.some((reason) =>
      DIAGNOSTIC_REASON_TAGS.has(reason),
    );
    if (!hasDiagnosticReason) {
      if (hasCampaignContextBlocker(creative)) {
        expandedReasons.push("campaign_context_blocker");
      } else if (hasPreviewMissingSignal(creative)) {
        expandedReasons.push("preview_missing");
      } else if (creative.operatorPolicy?.segment === "creative_learning_incomplete") {
        expandedReasons.push("creative_learning_incomplete");
      } else {
        expandedReasons.push("low_evidence");
      }
    }
  }

  const rankedReasons = rankDecisionReasons(primary, expandedReasons);
  return {
    primary,
    subTone,
    reasons: rankedReasons,
  };
}

export function resolveCreativeOperatorDecision(
  creative: CreativeDecisionOsCreative,
): CreativeOperatorDecisionResolution {
  const segment = creative.operatorPolicy?.segment ?? null;
  const reasons: CreativeOperatorReasonTag[] = [];
  appendDecisionReasonSignals(creative, reasons, { includeStrength: true });

  if (segment === "scale_ready") {
    return finalizeCreativeOperatorDecision(
      creative,
      "scale",
      creative.operatorPolicy?.queueEligible || creative.operatorPolicy?.pushReadiness === "safe_to_queue"
        ? "queue_ready"
        : "default",
      reasons,
    );
  }

  if (segment === "scale_review") {
    reasons.push("strong_relative_winner", "business_validation_missing");
    return finalizeCreativeOperatorDecision(creative, "scale", "review_only", reasons);
  }

  if (segment === "promising_under_sampled") {
    return finalizeCreativeOperatorDecision(creative, "test_more", "default", reasons);
  }

  if (segment === "protected_winner" || segment === "no_touch") {
    return finalizeCreativeOperatorDecision(creative, "protect", "default", reasons);
  }

  if (segment === "fatigued_winner") {
    return finalizeCreativeOperatorDecision(creative, "refresh", "default", reasons);
  }

  if (segment === "needs_new_variant") {
    const revive = isPausedHistoricalRetest(creative) || creative.primaryAction === "retest_comeback";
    if (revive) {
      reasons.push(
        creative.deliveryContext?.pausedDelivery ? "paused_winner" : "comeback_candidate",
      );
    }
    return finalizeCreativeOperatorDecision(
      creative,
      "refresh",
      revive ? "revive" : "default",
      reasons,
    );
  }

  if (segment === "kill_candidate" || segment === "spend_waste") {
    return finalizeCreativeOperatorDecision(creative, "cut", "manual_review", reasons);
  }

  if (segment === "investigate") {
    reasons.push("campaign_context_blocker");
    return finalizeCreativeOperatorDecision(creative, "diagnose", "manual_review", reasons);
  }

  if (segment === "contextual_only" || segment === "blocked") {
    return finalizeCreativeOperatorDecision(creative, "diagnose", "manual_review", reasons);
  }

  if (segment === "false_winner_low_evidence" || segment === "creative_learning_incomplete") {
    reasons.push(
      segment === "creative_learning_incomplete"
        ? "creative_learning_incomplete"
        : "low_evidence",
    );
    return finalizeCreativeOperatorDecision(creative, "diagnose", "manual_review", reasons);
  }

  if (segment === "hold_monitor") {
    if (hasCampaignContextBlocker(creative)) {
      reasons.push("campaign_context_blocker");
      return finalizeCreativeOperatorDecision(creative, "diagnose", "manual_review", reasons);
    }
    if (hasPreviewMissingSignal(creative) || hasWeakBenchmarkSignal(creative)) {
      return finalizeCreativeOperatorDecision(creative, "diagnose", "manual_review", reasons);
    }
    if (
      hasCatastrophicCpaSignal(creative) ||
      hasMatureZeroPurchaseSignal(creative) ||
      (hasBelowBaselineWasteSignal(creative) && creative.spend >= 250)
    ) {
      return finalizeCreativeOperatorDecision(creative, "cut", "manual_review", reasons);
    }
    if (hasTrendCollapseSignal(creative) || hasFatiguePressureSignal(creative)) {
      return finalizeCreativeOperatorDecision(creative, "refresh", "default", reasons);
    }
    return finalizeCreativeOperatorDecision(creative, "test_more", "default", reasons);
  }

  if (hasCampaignContextBlocker(creative) || hasPreviewMissingSignal(creative)) {
    if (hasCampaignContextBlocker(creative)) reasons.push("campaign_context_blocker");
    if (hasPreviewMissingSignal(creative)) reasons.push("preview_missing");
    return finalizeCreativeOperatorDecision(creative, "diagnose", "manual_review", reasons);
  }

  if (creative.primaryAction === "promote_to_scaling") {
    return finalizeCreativeOperatorDecision(
      creative,
      "scale",
      creativeNeedsBusinessValidation(creative) ? "review_only" : "default",
      reasons,
    );
  }
  if (creative.primaryAction === "hold_no_touch") {
    return finalizeCreativeOperatorDecision(creative, "protect", "default", reasons);
  }
  if (
    creative.primaryAction === "refresh_replace" ||
    creative.primaryAction === "retest_comeback"
  ) {
    const revive = creative.primaryAction === "retest_comeback";
    if (revive) reasons.push("comeback_candidate");
    return finalizeCreativeOperatorDecision(
      creative,
      "refresh",
      revive ? "revive" : "default",
      reasons,
    );
  }
  if (creative.primaryAction === "block_deploy") {
    return finalizeCreativeOperatorDecision(creative, "cut", "manual_review", reasons);
  }

  return finalizeCreativeOperatorDecision(creative, "diagnose", "manual_review", reasons);
}

export function creativeOperatorSegmentLabel(creative: CreativeDecisionOsCreative) {
  return creativeOperatorPrimaryDecisionLabel(resolveCreativeOperatorDecision(creative).primary);
}

function formatMoney(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `$${value.toLocaleString(undefined, {
    minimumFractionDigits: value >= 100 ? 0 : 2,
    maximumFractionDigits: value >= 100 ? 0 : 2,
  })}`;
}

function formatRatio(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return `${value.toFixed(2)}x`;
}

function formatInteger(value: number | null | undefined) {
  if (value === null || value === undefined || !Number.isFinite(value)) return "n/a";
  return value.toLocaleString();
}

function lifecycleLabel(value: CreativeDecisionOsCreative["lifecycleState"]) {
  switch (value) {
    case "incubating":
    case "validating":
      return "Test More";
    case "scale_ready":
      return "Scale";
    case "stable_winner":
      return "Protect";
    case "fatigued_winner":
      return "Refresh";
    case "blocked":
      return "Diagnose";
    case "retired":
      return "Cut";
    case "comeback_candidate":
      return "Refresh";
    default:
      return titleFromEnum(value);
  }
}

function previewLabel(creative: CreativeDecisionOsCreative) {
  if (creative.previewStatus?.liveDecisionWindow === "missing") return "Preview missing";
  if (creative.previewStatus?.liveDecisionWindow === "metrics_only_degraded") return "Preview degraded";
  return "Preview ready";
}

function isCreativeMuted(creative: CreativeDecisionOsCreative) {
  const materiality = creative.trust.evidence?.materiality;
  return materiality === "thin_signal" || materiality === "immaterial" || creative.trust.surfaceLane === "archive_context";
}

function isLiveCreativeEvidence(creative: CreativeDecisionOsCreative) {
  return creative.evidenceSource === undefined || creative.evidenceSource === "live";
}

function isCreativeActionableScale(
  creative: CreativeDecisionOsCreative,
  decision: CreativeOperatorDecisionResolution = resolveCreativeOperatorDecision(creative),
) {
  if (decision.primary !== "scale") return false;
  if (decision.subTone === "review_only") return false;
  if (isCreativeMuted(creative) || !isLiveCreativeEvidence(creative)) return false;

  const policy = creative.operatorPolicy;
  if (!policy || policy.segment !== "scale_ready") return false;
  if (policy.queueEligible || policy.canApply) return true;
  return (
    policy.pushReadiness === "safe_to_queue" ||
    policy.pushReadiness === "eligible_for_push_when_enabled"
  );
}

function scaleActionabilityBucket(
  creative: CreativeDecisionOsCreative,
  decision: CreativeOperatorDecisionResolution = resolveCreativeOperatorDecision(creative),
) {
  if (decision.primary !== "scale") return null;
  if (isCreativeActionableScale(creative, decision)) return "actionable" as const;
  if (isCreativeMuted(creative) || !isLiveCreativeEvidence(creative)) return "muted" as const;
  return "reviewOnly" as const;
}

export function buildCreativeScaleActionabilityCounts(
  creatives: CreativeDecisionOsCreative[],
): CreativeScaleActionabilityCounts {
  return creatives.reduce(
    (acc, creative) => {
      const decision = resolveCreativeOperatorDecision(creative);
      const bucket = scaleActionabilityBucket(creative, decision);
      if (!bucket) return acc;
      acc.total += 1;
      acc[bucket] += 1;
      return acc;
    },
    { total: 0, actionable: 0, reviewOnly: 0, muted: 0 },
  );
}

export function resolveCreativeAuthorityState(creative: CreativeDecisionOsCreative) {
  if (creative.operatorPolicy) {
    if (
      creative.operatorPolicy.segment === "protected_winner" ||
      creative.operatorPolicy.segment === "no_touch" ||
      creative.operatorPolicy.state === "do_not_touch"
    ) {
      return "no_action" satisfies OperatorAuthorityState;
    }
    if (
      creative.operatorPolicy.segment === "fatigued_winner" ||
      creative.operatorPolicy.segment === "kill_candidate" ||
      creative.operatorPolicy.segment === "needs_new_variant" ||
      creative.operatorPolicy.segment === "spend_waste"
    ) {
      return "blocked" satisfies OperatorAuthorityState;
    }
    if (creative.operatorPolicy.segment === "investigate") {
      return "blocked" satisfies OperatorAuthorityState;
    }
    if (
      creative.operatorPolicy.state === "blocked" ||
      creative.operatorPolicy.state === "contextual_only"
    ) {
      return "needs_truth" satisfies OperatorAuthorityState;
    }
    if (creative.operatorPolicy.state === "watch" || creative.operatorPolicy.state === "investigate") {
      return "watch" satisfies OperatorAuthorityState;
    }
    if (creative.operatorPolicy.state === "do_now") {
      return "act_now" satisfies OperatorAuthorityState;
    }
  }
  if (creative.primaryAction === "hold_no_touch") {
    return "no_action" satisfies OperatorAuthorityState;
  }
  if (
    creative.trust.operatorDisposition === "profitable_truth_capped" ||
    creative.previewStatus?.liveDecisionWindow === "missing" ||
    creative.previewStatus?.liveDecisionWindow === "metrics_only_degraded" ||
    creative.primaryAction === "block_deploy"
  ) {
    return "needs_truth" satisfies OperatorAuthorityState;
  }
  if (creative.primaryAction === "refresh_replace") {
    return "blocked" satisfies OperatorAuthorityState;
  }
  if (creative.primaryAction === "keep_in_test" || creative.primaryAction === "retest_comeback") {
    return "watch" satisfies OperatorAuthorityState;
  }
  return "act_now" satisfies OperatorAuthorityState;
}

function creativeBlocker(creative: CreativeDecisionOsCreative, state: OperatorAuthorityState) {
  if (creative.operatorPolicy?.blockers?.[0]) {
    return creative.operatorPolicy.blockers[0];
  }
  if (creative.previewStatus?.liveDecisionWindow === "missing") {
    return creative.previewStatus.reason ?? "Preview truth is missing for this creative.";
  }
  if (creative.previewStatus?.liveDecisionWindow === "metrics_only_degraded") {
    return creative.previewStatus.reason ?? "Preview review is degraded, so decisive action stays softened.";
  }
  if (state === "needs_truth") {
    return (
      creative.trust.evidence?.aggressiveActionBlockReasons?.[0] ??
      creative.trust.reasons?.find((reason) => reason.toLowerCase().includes("truth")) ??
      creative.economics.reasons?.[0] ??
      "Missing commercial truth is capping a stronger creative move."
    );
  }
  if (creative.trust.evidence?.materiality === "thin_signal") {
    return "Signal is still too thin to promote, replace, or protect this row authoritatively.";
  }
  return (
    creative.deployment.constraints?.[0] ??
    creative.deployment.compatibility.reasons?.[0] ??
    creative.economics.reasons?.[0] ??
    null
  );
}

function creativeActionLabel(creative: CreativeDecisionOsCreative) {
  return creativeOperatorPrimaryDecisionLabel(resolveCreativeOperatorDecision(creative).primary);
}

function creativeReason(creative: CreativeDecisionOsCreative, state: OperatorAuthorityState, muted: boolean, blocker: string | null) {
  if (creative.operatorPolicy?.segment === "scale_ready") {
    const scopeLabel = resolvedCreativeBenchmarkScopeLabel(creative);
    return `Strong relative performer against the ${scopeLabel} benchmark. Business validation supports a controlled scale move.`;
  }
  if (creative.operatorPolicy?.segment === "scale_review") {
    const scopeLabel = resolvedCreativeBenchmarkScopeLabel(creative);
    const businessValidationNote = creativeBusinessValidationNote(creative);
    if (businessValidationNote) {
      return `Strong relative performer against the ${scopeLabel} benchmark. ${businessValidationNote}`;
    }
    if (creative.benchmarkReliability && creative.benchmarkReliability !== "strong") {
      return `Strong relative performer against the ${scopeLabel} benchmark, but ${creativeBenchmarkReliabilityLabel(creative.benchmarkReliability).toLowerCase()} benchmark reliability keeps this review-only.`;
    }
    if (
      creative.operatorPolicy?.missingEvidence.some((item) =>
        item.toLowerCase().includes("campaign") || item.toLowerCase().includes("adset"),
      ) ||
      creative.deployment.compatibility.status === "limited" ||
      creative.deployment.compatibility.status === "blocked"
    ) {
      return `Strong relative performer against the ${scopeLabel} benchmark, but campaign placement still needs review.`;
    }
    return `Strong relative performer against the ${scopeLabel} benchmark. Keep it in review until the scale target is confirmed.`;
  }
  if (
    creative.operatorPolicy?.segment === "hold_monitor" &&
    creative.primaryAction === "promote_to_scaling" &&
    creative.relativeBaseline
  ) {
    const scopeLabel = resolvedCreativeBenchmarkScopeLabel(creative);
    const businessValidationNote = creativeBusinessValidationNote(creative);
    if (businessValidationNote) {
      return `Promising relative performer against the ${scopeLabel} benchmark. ${businessValidationNote}`;
    }
    if (
      creative.operatorPolicy.missingEvidence.includes("relative_baseline") ||
      creative.benchmarkReliability === "weak" ||
      creative.benchmarkReliability === "unavailable"
    ) {
      return `Promising creative, but the ${scopeLabel.toLowerCase()} benchmark is still too thin for a scale call.`;
    }
  }
  if (creative.operatorPolicy?.segment === "promising_under_sampled") {
    if (hasTestMoreFatigueCaveat(creative)) {
      return "Promising relative signal, but the sample is still light. Keep testing while monitoring fatigue pressure.";
    }
    return "Promising relative signal, but the sample is still light. Keep testing until the evidence matures.";
  }
  if (isPausedHistoricalRetest(creative)) {
    return "This paused creative has enough historical winner evidence to review a controlled comeback refresh, not protect current delivery.";
  }
  if (isMatureZeroPurchaseWeakWatch(creative)) {
    return "Spend is already meaningful enough to move past early learning, but there is still no purchase proof. Diagnose before extending this test.";
  }
  if (isMatureZeroPurchaseCutReview(creative)) {
    return "Spend is already meaningful enough to move past early learning, and there is still no purchase proof. Treat this as a Cut candidate for operator review.";
  }
  if (isMatureBelowBaselinePurchaseCutReview(creative)) {
    const scopeLabel = resolvedCreativeBenchmarkScopeLabel(creative);
    return `Spend and purchase volume are already meaningful, but ROAS is materially below the ${scopeLabel} benchmark. Treat this as a Cut candidate for operator review.`;
  }
  if (isValidatingBelowBaselineRefreshReview(creative)) {
    const scopeLabel = resolvedCreativeBenchmarkScopeLabel(creative);
    return `Recent performance collapsed while 30-day ROAS is materially below the ${scopeLabel} benchmark. Treat this as a Refresh candidate for operator review, not passive Watch.`;
  }
  if (state === "needs_truth" && creative.previewStatus?.liveDecisionWindow === "missing") {
    return "Preview truth is missing, so this creative cannot headline an authoritative action yet.";
  }
  if (state === "needs_truth" && creative.previewStatus?.liveDecisionWindow === "metrics_only_degraded") {
    return "Preview truth is degraded, so this row stays metrics-only instead of reading like clean execute-now work.";
  }
  if (state === "needs_truth" && blocker) {
    return `Promising, but ${blocker.charAt(0).toLowerCase()}${blocker.slice(1)}`;
  }
  if (muted) {
    return "Signal is still too thin for a headline creative action.";
  }
  return creative.summary;
}

function creativeTargetContext(
  creative: CreativeDecisionOsCreative,
): OperatorInstructionTargetContext {
  const preferredAdSet = creative.deployment.preferredAdSetNames?.[0] ?? null;
  const preferredCampaign = creative.deployment.preferredCampaignNames?.[0] ?? null;
  if (
    creative.operatorPolicy?.segment === "scale_ready" ||
    creative.operatorPolicy?.segment === "scale_review"
  ) {
    if (preferredAdSet) {
      return {
        status: "available",
        label: `Target ad set: ${preferredAdSet}${preferredCampaign ? ` · ${preferredCampaign}` : ""}`,
        reason: "Creative deployment data names a preferred ad set for the scale review.",
        targetScope: "adset",
        targetEntity: preferredAdSet,
        parentEntity: preferredCampaign,
      };
    }
    if (preferredCampaign) {
      return {
        status: "review_required",
        label: `Campaign context: ${preferredCampaign}`,
        reason:
          "A campaign context is available, but no preferred ad set is exposed for this creative.",
        targetScope: "campaign",
        targetEntity: preferredCampaign,
        parentEntity: creative.familyLabel,
      };
    }
    return {
      status: "unavailable",
      label: "Target ad set unavailable",
      reason:
        "The source row does not expose a preferred ad set; review deployment context before scaling.",
      targetScope: "adset",
      targetEntity: null,
      parentEntity: creative.familyLabel,
    };
  }

  const lane = creative.deployment.targetLane ?? creative.deployment.metaFamilyLabel ?? null;
  return {
    status: lane ? "available" : "review_required",
    label: lane ? `Context: ${lane}` : "Deployment context requires review",
    reason: lane
      ? "Target context comes from the deterministic deployment recommendation."
      : "No stable deployment lane is exposed for this creative.",
    targetScope: "creative",
    targetEntity: creative.name,
    parentEntity: creative.familyLabel,
  };
}

function creativeUrgencyOverride(
  creative: CreativeDecisionOsCreative,
): { urgency?: OperatorInstructionUrgency; reason?: string } {
  if (
    creative.operatorPolicy?.segment === "fatigued_winner" &&
    creative.fatigue?.frequencyPressure != null &&
    creative.fatigue.frequencyPressure >= 3
  ) {
    return {
      urgency: "high",
      reason: "Frequency pressure supports prioritizing a refresh review.",
    };
  }
  if (creative.operatorPolicy?.segment === "promising_under_sampled") {
    return {
      urgency: "watch",
      reason: "The creative is promising but under-sampled, so urgency stays observational.",
    };
  }
  if (creative.operatorPolicy?.segment === "protected_winner") {
    return {
      urgency: "low",
      reason: "Protected winners should stay stable unless sustained fatigue appears.",
    };
  }
  return {};
}

function compactMetrics(metrics: OperatorSurfaceMetric[]) {
  return metrics.filter((metric) => Boolean(metric.value) && metric.value !== "n/a").slice(0, 5);
}

function resolveCreativePrimaryAuthorityState(
  creative: CreativeDecisionOsCreative,
  decision: CreativeOperatorDecisionResolution,
): OperatorAuthorityState {
  switch (decision.primary) {
    case "scale":
      return isCreativeActionableScale(creative, decision) ? "act_now" : "watch";
    case "test_more":
      return "watch";
    case "protect":
      return "no_action";
    case "refresh":
    case "cut":
      return "blocked";
    case "diagnose":
    default:
      return "needs_truth";
  }
}

export function buildCreativeOperatorItem(creative: CreativeDecisionOsCreative): OperatorSurfaceItem {
  const decision = resolveCreativeOperatorDecision(creative);
  const authorityState = resolveCreativePrimaryAuthorityState(creative, decision);
  const muted = isCreativeMuted(creative);
  const blocker = creativeBlocker(creative, authorityState);
  const primaryAction = creativeActionLabel(creative);
  const subToneLabel = creativeOperatorSubToneLabel(decision.subTone);
  const reasonLabels = decision.reasons.map(creativeOperatorReasonTagLabel);
  const instructionActionLabel =
    decision.primary === "scale" && decision.subTone === "review_only"
      ? "Scale Review"
      : primaryAction;
  const reason = creativeReason(creative, authorityState, muted, blocker);
  const campaignContextLimited =
    creative.deployment.compatibility.status === "limited" ||
    creative.deployment.compatibility.status === "blocked";
  const urgencyOverride = creativeUrgencyOverride(creative);
  const nextObservation = [
    hasTestMoreFatigueCaveat(creative)
      ? "Monitor fatigue pressure while the sample is still maturing."
      : null,
    isPausedHistoricalRetest(creative)
      ? "Review reactivation in a controlled test before restoring spend."
      : null,
    isMatureZeroPurchaseCutReview(creative)
      ? "Confirm there is no purchase evidence before stopping this test creative."
      : null,
    isMatureBelowBaselinePurchaseCutReview(creative)
      ? "Confirm no campaign blocker explains the below-benchmark read before stopping or replacing this test creative."
      : null,
    isValidatingBelowBaselineRefreshReview(creative)
      ? "Confirm no campaign blocker explains the below-benchmark collapse before replacing this test creative."
      : null,
    isMatureZeroPurchaseWeakWatch(creative)
      ? "Confirm purchase evidence before extending this test."
      : null,
    ...(creative.deployment.whatWouldChangeThisDecision ?? []),
    ...(creative.deployment.constraints ?? []),
    ...(creative.deployment.compatibility.reasons ?? []),
    ...(creative.fatigue?.missingContext ?? []),
    ...(creative.benchmark?.missingContext ?? []),
  ].filter(Boolean) as string[];

  return {
    id: creative.creativeId,
    title: creative.name,
    subtitle: creative.familyLabel,
    primaryAction,
    authorityState,
    authorityLabel: subToneLabel ?? primaryAction,
    reason,
    blocker,
    confidence: operatorConfidenceBand(creative.confidence),
    secondaryLabels: [
      subToneLabel,
      ...reasonLabels,
      `Benchmark: ${resolvedCreativeBenchmarkScopeLabel(creative)}`,
      creative.operatorPolicy?.pushReadiness.replaceAll("_", " ") ?? null,
      previewLabel(creative),
    ].filter(Boolean) as string[],
    metrics: compactMetrics([
      { label: "Spend", value: formatMoney(creative.spend) },
      { label: "ROAS", value: formatRatio(creative.roas) },
      { label: "Purchases", value: formatInteger(creative.purchases) },
      { label: "CTR", value: `${creative.ctr.toFixed(2)}%` },
    ]),
    muted,
    mutedReason: muted ? "Thin-signal or inactive creatives stay out of the headline action surface." : null,
    instruction: buildOperatorInstruction({
      sourceSystem: "creative",
      sourceLabel: "Creative Decision OS",
      policy: creative.operatorPolicy ?? null,
      policyVersion: creative.operatorPolicy?.policyVersion ?? null,
      targetScope: "creative",
      targetEntity: creative.name,
      parentEntity: creative.familyLabel,
      actionLabel: instructionActionLabel,
      reason,
      blocker,
      confidenceScore: creative.confidence,
      evidenceSource: creative.evidenceSource,
      trustState: creative.trust.truthState,
      operatorDisposition: creative.trust.operatorDisposition,
      provenance:
        (creative as { provenance?: CreativeDecisionOsCreative["provenance"] | null })
          .provenance ?? null,
      evidenceHash: (creative as { evidenceHash?: string | null }).evidenceHash ?? null,
      actionFingerprint:
        (creative as { actionFingerprint?: string | null }).actionFingerprint ?? null,
      targetContext: creativeTargetContext(creative),
      ...(urgencyOverride.urgency
        ? { urgency: urgencyOverride.urgency }
        : {}),
      ...(urgencyOverride.reason
        ? { urgencyReason: urgencyOverride.reason }
        : {}),
      nextObservation,
      invalidActions: [
        campaignContextLimited
          ? "Do not blame the creative before the limiting campaign or ad set context is reviewed."
          : null,
        creative.operatorPolicy?.segment === "false_winner_low_evidence"
          ? "Do not scale from ROAS alone."
          : null,
        creative.operatorPolicy?.segment === "scale_review"
          ? "Do not scale until business targets are validated."
          : null,
        creative.operatorPolicy?.segment === "protected_winner"
          ? "Do not cut a protected winner because of short-term volatility."
          : null,
      ].filter(Boolean) as string[],
    }),
  };
}

export function resolveCreativeQuickFilterKey(
  creative: CreativeDecisionOsCreative,
): CreativeQuickFilterKey | null {
  return resolveCreativeOperatorDecision(creative).primary;
}

export function buildCreativeQuickFilters(
  decisionOs: CreativeDecisionOsV1Response | null | undefined,
  options?: {
    visibleIds?: Set<string> | null;
    includeZeroCounts?: boolean;
  },
): CreativeQuickFilter[] {
  if (!decisionOs) return [];

  const visibleIds = options?.visibleIds ?? null;
  const includeZeroCounts = options?.includeZeroCounts ?? false;
  const creativeIdsByFilter = new Map<CreativeQuickFilterKey, string[]>();
  for (const key of CREATIVE_QUICK_FILTER_ORDER) {
    creativeIdsByFilter.set(key, []);
  }
  const scaleCreatives: CreativeDecisionOsCreative[] = [];

  for (const creative of decisionOs.creatives) {
    if (visibleIds && !visibleIds.has(creative.creativeId)) continue;
    const decision = resolveCreativeOperatorDecision(creative);
    const filterKey = decision.primary;
    if (filterKey) {
      creativeIdsByFilter.get(filterKey)?.push(creative.creativeId);
      if (filterKey === "scale") scaleCreatives.push(creative);
    }
  }

  const scaleActionability = buildCreativeScaleActionabilityCounts(scaleCreatives);

  return CREATIVE_QUICK_FILTER_ORDER
    .map((key) => {
      const creativeIds = creativeIdsByFilter.get(key) ?? [];
      const base = CREATIVE_QUICK_FILTER_DEFS[key];
      const scaleSummary =
        key === "scale" && creativeIds.length > 0
          ? scaleActionability.actionable > 0
            ? `${scaleActionability.actionable} direct-scale ready; ${scaleActionability.reviewOnly + scaleActionability.muted} require review before action.`
            : "Scale candidates require operator review before action."
          : base.summary;
      const scaleTone =
        key === "scale"
          ? scaleActionability.actionable > 0
            ? "act_now"
            : scaleActionability.total > 0
              ? "watch"
              : base.tone
          : base.tone;

      return {
        ...base,
        summary: scaleSummary,
        tone: scaleTone,
        count: creativeIds.length,
        creativeIds,
        ...(key === "scale"
          ? {
              actionableCount: scaleActionability.actionable,
              reviewOnlyCount: scaleActionability.reviewOnly,
              mutedCount: scaleActionability.muted,
            }
          : {}),
      } satisfies CreativeQuickFilter;
    })
    .filter((filter) => includeZeroCounts || filter.count > 0);
}

export function buildCreativeTaxonomyCounts(
  decisionOs: CreativeDecisionOsV1Response | null | undefined,
  options?: {
    visibleIds?: Set<string> | null;
    quickFilters?: CreativeQuickFilter[] | null;
  },
): CreativeQuickFilter[] {
  const baseFilters = buildCreativeQuickFilters(decisionOs, {
    visibleIds: options?.visibleIds,
    includeZeroCounts: true,
  });
  const overrideCountsByKey = new Map(
    (options?.quickFilters ?? []).map((filter) => [
      filter.key,
      {
        count: filter.count,
        creativeIds: filter.creativeIds,
        actionableCount: filter.actionableCount,
        reviewOnlyCount: filter.reviewOnlyCount,
        mutedCount: filter.mutedCount,
      },
    ]),
  );

  return baseFilters.map((filter) => {
    const override = overrideCountsByKey.get(filter.key);
    if (!override) return filter;
    return {
      ...filter,
      count: override.count,
      creativeIds: override.creativeIds,
      ...(override.actionableCount !== undefined
        ? { actionableCount: override.actionableCount }
        : {}),
      ...(override.reviewOnlyCount !== undefined
        ? { reviewOnlyCount: override.reviewOnlyCount }
        : {}),
      ...(override.mutedCount !== undefined
        ? { mutedCount: override.mutedCount }
        : {}),
    };
  });
}

export function buildCreativeOperatorSurfaceModel(
  decisionOs: CreativeDecisionOsV1Response | null | undefined,
  options?: {
    visibleIds?: Set<string> | null;
  },
): OperatorSurfaceModel | null {
  if (!decisionOs) return null;

  const visibleIds = options?.visibleIds ?? null;
  const creatives = visibleIds
    ? decisionOs.creatives.filter((creative) => visibleIds.has(creative.creativeId))
    : decisionOs.creatives;
  if (creatives.length === 0) return null;

  const items = creatives.map(buildCreativeOperatorItem);
  const previewTruth = buildCreativePreviewTruthSummary({ creatives });
  const primaryCounts = CREATIVE_QUICK_FILTER_ORDER.reduce(
    (acc, key) => {
      acc[key] = 0;
      return acc;
    },
    {} as Record<CreativeQuickFilterKey, number>,
  );
  for (const creative of creatives) {
    primaryCounts[resolveCreativeOperatorDecision(creative).primary] += 1;
  }
  const buckets = buildOperatorBuckets(items, {
    labels: {
      watch: "Scale review-only / Test More",
      blocked: "Refresh / Cut",
      needs_truth: "Diagnose",
      no_action: "Protect",
    },
    summaries: {
      act_now: "Winner signals are strong enough for the next controlled scale move.",
      watch: "Rows need review-only scale confirmation or more testing.",
      blocked: "Rows need a refresh or cut decision before more spend.",
      needs_truth: "Rows need campaign, preview, benchmark, or evidence diagnosis.",
      no_action: "Stable winners to protect without forcing them back into churn.",
    },
    order: ["act_now", "watch", "blocked", "needs_truth", "no_action"],
  });

  const mutedCount = buckets.reduce((sum, bucket) => sum + bucket.mutedCount, 0);
  const previewMissing = creatives.filter(
    (creative) => creative.previewStatus?.liveDecisionWindow === "missing",
  ).length;
  const scaleActionability = buildCreativeScaleActionabilityCounts(creatives);
  const scaleReviewRequiredCount =
    scaleActionability.reviewOnly + scaleActionability.muted;
  const scaleActionabilityNote =
    scaleActionability.total > 0
      ? scaleActionability.actionable > 0
        ? `${scaleActionability.actionable} Scale ${scaleActionability.actionable === 1 ? "row is" : "rows are"} direct-action ready; ${scaleReviewRequiredCount} ${scaleReviewRequiredCount === 1 ? "Scale row needs" : "Scale rows need"} operator review first.`
        : `No creatives are ready for direct Scale; ${scaleActionability.total} Scale ${scaleActionability.total === 1 ? "candidate needs" : "candidates need"} operator review first.`
      : null;

  let emphasis: OperatorAuthorityState = "no_action";
  let headline = "No material creative move is ready yet.";
  if (scaleActionability.actionable > 0) {
    emphasis = "act_now";
    headline = `${scaleActionability.actionable} creative ${scaleActionability.actionable === 1 ? "is" : "are"} ready for direct Scale.`;
  } else if (primaryCounts.scale > 0) {
    emphasis = "watch";
    headline = `${primaryCounts.scale} Scale ${primaryCounts.scale === 1 ? "candidate needs" : "candidates need"} operator review before action.`;
  } else if (primaryCounts.cut + primaryCounts.refresh > 0) {
    emphasis = "blocked";
    const count = primaryCounts.cut + primaryCounts.refresh;
    headline = `${count} creative ${count === 1 ? "needs" : "need"} Refresh or Cut decisions.`;
  } else if (primaryCounts.test_more > 0) {
    emphasis = "watch";
    headline = `${primaryCounts.test_more} creative ${primaryCounts.test_more === 1 ? "needs" : "need"} more testing.`;
  } else if (primaryCounts.diagnose > 0) {
    emphasis = "needs_truth";
    headline = `${primaryCounts.diagnose} creative ${primaryCounts.diagnose === 1 ? "needs" : "need"} diagnosis before a clean action.`;
  } else if (primaryCounts.protect > 0) {
    headline = `${primaryCounts.protect} creative ${primaryCounts.protect === 1 ? "is" : "are"} protected.`;
  }

  const decisionSummary =
    decisionOs.summary.message ??
    "Selected range remains analysis context only.";
  const note = previewTruth
    ? [previewTruth.summary, scaleActionabilityNote, decisionSummary].filter(Boolean).join(" ")
    : [
        scaleActionabilityNote,
        decisionOs.summary.message ??
          "Preview readiness gates authoritative creative action; selected range remains analysis context.",
      ]
        .filter(Boolean)
        .join(" ");

  return {
    surfaceLabel: "Creative",
    heading: "Primary Decisions",
    headline,
    note,
    emphasis,
    authorityLabels: {
      act_now: "Scale",
      watch: "Scale review-only / Test More",
      blocked: "Refresh / Cut",
      needs_truth: "Diagnose",
      no_action: "Protect",
    },
    blocker:
      emphasis === "needs_truth" && previewMissing > 0
        ? `${previewMissing} ${previewMissing === 1 ? "row needs" : "rows need"} trustworthy preview media.`
        : null,
    buckets,
    hiddenSummary:
      mutedCount > 0
        ? `${mutedCount} thin-signal or inactive ${mutedCount === 1 ? "creative stays" : "creatives stay"} off the headline action surface.`
        : null,
  };
}

export function buildCreativePreviewTruthSummary(
  decisionOs: Pick<CreativeDecisionOsV1Response, "creatives"> | null | undefined,
  options?: { creativeIds?: Iterable<string> | null },
): CreativePreviewTruthSummary | null {
  if (!decisionOs?.creatives?.length) return null;

  const scopedIds = options?.creativeIds ? new Set(options.creativeIds) : null;
  const creatives = scopedIds
    ? decisionOs.creatives.filter((creative) => scopedIds.has(creative.creativeId))
    : decisionOs.creatives;

  if (creatives.length === 0) return null;

  const readyCount = creatives.filter(
    (creative) => creative.previewStatus?.liveDecisionWindow === "ready",
  ).length;
  const degradedCount = creatives.filter(
    (creative) => creative.previewStatus?.liveDecisionWindow === "metrics_only_degraded",
  ).length;
  const missingCount = creatives.filter(
    (creative) => creative.previewStatus?.liveDecisionWindow === "missing",
  ).length;
  const totalCount = creatives.length;

  const state: CreativePreviewTruthSummary["state"] =
    readyCount === totalCount
      ? "ready"
      : missingCount === totalCount
        ? "missing"
        : "degraded";

  if (state === "ready") {
    return {
      totalCount,
      readyCount,
      degradedCount,
      missingCount,
      state,
      headline: "Preview truth is ready across this review scope.",
      summary:
        `${readyCount} ready · ${degradedCount} degraded · ${missingCount} missing. ` +
        "Decisive operator wording can stay active where preview truth is ready.",
    };
  }

  if (state === "missing") {
    return {
      totalCount,
      readyCount,
      degradedCount,
      missingCount,
      state,
      headline: "Preview truth is missing across this review scope.",
      summary:
        `${readyCount} ready · ${degradedCount} degraded · ${missingCount} missing. ` +
        "Missing preview truth blocks authoritative action until media resolves.",
    };
  }

  return {
    totalCount,
    readyCount,
    degradedCount,
    missingCount,
    state,
    headline: "Preview truth is mixed across this review scope.",
    summary:
      `${readyCount} ready · ${degradedCount} degraded · ${missingCount} missing. ` +
      "Ready rows can read decisively, degraded rows stay metrics-only, and missing rows stay blocked.",
  };
}
