import { decisionLabelForMetaRec } from "@/lib/meta/rec-label-mapping";
import type { MetaEmpiricalOutcomeSummary } from "@/lib/meta/empirical-outcomes";
import type { MetaDecisionLabel, MetaRecommendation } from "@/lib/meta/recommendations";

export type MetaAutomationReadinessTier =
  | "read_only"
  | "manual_review"
  | "backtest_candidate"
  | "auto_execute";

export type MetaAutomationReadinessBlocker =
  | "no_empirical_outcome_model"
  | "unsupported_action_class"
  | "not_action_state"
  | "diagnostic_or_watch_state"
  | "low_confidence"
  | "missing_campaign_label"
  | "missing_commercial_anchor"
  | "insufficient_empirical_sample"
  | "empirical_precision_below_floor"
  | "missing_executor"
  | "missing_live_preflight"
  | "missing_rollback_plan"
  | "missing_post_action_monitor"
  | "missing_holdout_plan"
  | "missing_operator_enablement";

export interface MetaAutomationReadiness {
  contractVersion: "meta-automation-readiness.v1";
  tier: MetaAutomationReadinessTier;
  autoExecuteEligible: boolean;
  operatorReviewRequired: boolean;
  decisionLabel: MetaDecisionLabel;
  blockers: MetaAutomationReadinessBlocker[];
  missingEvidence: string[];
  requiredEvidence: string[];
  reason: string;
}

export interface MetaAutomationReadinessOptions {
  empiricalOutcomeModelAvailable?: boolean;
  empiricalOutcomeSummary?: MetaEmpiricalOutcomeSummary | null;
  livePreflightAvailable?: boolean;
  rollbackPlanAvailable?: boolean;
}

const AUTO_CANDIDATE_TYPES = new Set<MetaRecommendation["type"]>([
  "adset_scale_budget",
  "adset_cut_spend",
]);

const READ_ONLY_LABELS = new Set<MetaDecisionLabel>([
  "keep",
  "diagnose",
  "out_of_scope",
  "review_placements",
  "review_adsets",
]);

const COMMERCIAL_ACTION_LABELS = new Set<MetaDecisionLabel>([
  "scale",
  "cut",
]);

const UNLABELED_CAMPAIGN_GUARD_REASON = "unlabeled_campaign_soft_only";

function confidenceScore(rec: MetaRecommendation) {
  if (typeof rec.confidenceScore === "number" && Number.isFinite(rec.confidenceScore)) {
    return rec.confidenceScore;
  }
  if (rec.confidence === "high") return 0.8;
  if (rec.confidence === "medium") return 0.62;
  return 0.42;
}

function stringSignalQualityValue(rec: MetaRecommendation, key: string) {
  const quality = rec.signalQuality;
  if (!quality || typeof quality !== "object") return null;
  const value = quality[key];
  return typeof value === "string" && value.trim() ? value.trim() : null;
}

function isMissingCampaignLabel(rec: MetaRecommendation) {
  return (
    rec.confidenceReason === UNLABELED_CAMPAIGN_GUARD_REASON ||
    stringSignalQualityValue(rec, "label_status") === "unlabeled" ||
    stringSignalQualityValue(rec, "confidence_cap") === UNLABELED_CAMPAIGN_GUARD_REASON
  );
}

function hasCommercialAnchor(rec: MetaRecommendation) {
  return rec.evidence.some((item) =>
    item.label === "Target ROAS" ||
    item.label === "Break-even ROAS" ||
    item.label === "Target CPA" ||
    item.label === "Break-even CPA"
  );
}

function unique<T extends string>(items: T[]) {
  return Array.from(new Set(items));
}

function reasonFor(tier: MetaAutomationReadinessTier, blockers: MetaAutomationReadinessBlocker[]) {
  if (blockers.includes("missing_campaign_label")) {
    return "Campaign label is missing, so automation is blocked until Main/Test/Mixed context is explicit.";
  }
  if (blockers.includes("diagnostic_or_watch_state")) {
    return "This recommendation is diagnostic, protective, or watch-only; it is not an execution candidate.";
  }
  if (blockers.includes("not_action_state")) {
    return "This recommendation is not an act-now decision; a human should review it before any operational change.";
  }
  if (blockers.includes("unsupported_action_class")) {
    return "This action class is not mapped to a safe Meta executor.";
  }
  if (blockers.includes("missing_commercial_anchor")) {
    return "Commercial target or break-even proof is missing.";
  }
  if (blockers.includes("insufficient_empirical_sample")) {
    return "Empirical outcome sample is still too thin for automation.";
  }
  if (blockers.includes("empirical_precision_below_floor")) {
    return "Empirical outcome precision is below the automation floor.";
  }
  if (blockers.includes("missing_executor")) {
    return "No executor is enabled for this action class.";
  }
  if (blockers.includes("missing_live_preflight")) {
    return "Live provider preflight proof is missing.";
  }
  if (blockers.includes("missing_rollback_plan")) {
    return "Rollback proof is missing.";
  }
  if (blockers.includes("missing_post_action_monitor")) {
    return "Post-action monitoring proof is missing.";
  }
  if (blockers.includes("missing_holdout_plan")) {
    return "Holdout or incrementality proof is missing.";
  }
  if (blockers.includes("missing_operator_enablement")) {
    return "An explicit operator enablement gesture is required before automation.";
  }
  if (blockers.includes("low_confidence")) {
    return "Confidence is below the automation floor.";
  }
  if (blockers.includes("no_empirical_outcome_model")) {
    return tier === "backtest_candidate"
      ? "Deterministic evidence is promising, but empirical outcome backtesting is required before automation."
      : "No empirical outcome model is attached to this scenario yet.";
  }
  return "Automation readiness check completed.";
}

export function deriveMetaAutomationReadiness(
  rec: MetaRecommendation,
  options: MetaAutomationReadinessOptions = {},
): MetaAutomationReadiness {
  const decisionLabel = decisionLabelForMetaRec(rec);
  const blockers: MetaAutomationReadinessBlocker[] = [];
  const requiredEvidence = [
    "empirical_outcome_backtest",
    "live_preflight",
    "rollback_plan",
    "campaign_label",
  ];
  const empiricalSummary = options.empiricalOutcomeSummary ?? null;
  const empiricalOutcomeModelAvailable =
    options.empiricalOutcomeModelAvailable === true ||
    Boolean(empiricalSummary && empiricalSummary.confidenceBand !== "insufficient_sample");
  const empiricalOutcomeAutoEligible =
    empiricalSummary?.autoEligible === true ||
    (options.empiricalOutcomeModelAvailable === true && !empiricalSummary);
  const livePreflightAvailable = options.livePreflightAvailable === true;
  const rollbackPlanAvailable = options.rollbackPlanAvailable === true;
  const missingEvidence = empiricalOutcomeModelAvailable ? [] : ["empirical_outcome_backtest"];
  const readOnly =
    rec.kind === "state" ||
    rec.kind === "anomaly" ||
    rec.decisionState === "watch" ||
    READ_ONLY_LABELS.has(decisionLabel);
  const autoCandidateType = AUTO_CANDIDATE_TYPES.has(rec.type);
  const score = confidenceScore(rec);

  if (!empiricalOutcomeModelAvailable) blockers.push("no_empirical_outcome_model");
  if (empiricalSummary?.confidenceBand === "insufficient_sample") {
    blockers.push("insufficient_empirical_sample");
    missingEvidence.push("empirical_outcome_sample");
  } else if (empiricalSummary && !empiricalSummary.autoEligible) {
    blockers.push("empirical_precision_below_floor");
  }
  if (!livePreflightAvailable) {
    blockers.push("missing_live_preflight");
    missingEvidence.push("live_preflight");
  }
  if (!rollbackPlanAvailable) {
    blockers.push("missing_rollback_plan");
    missingEvidence.push("rollback_plan");
  }
  if (rec.decisionState !== "act") blockers.push("not_action_state");
  if (readOnly) blockers.push("diagnostic_or_watch_state");
  if (!autoCandidateType) blockers.push("unsupported_action_class");
  if (score < 0.7) blockers.push("low_confidence");
  if (isMissingCampaignLabel(rec)) {
    blockers.push("missing_campaign_label");
    missingEvidence.push("campaign_label");
  }
  if (COMMERCIAL_ACTION_LABELS.has(decisionLabel) && !hasCommercialAnchor(rec)) {
    blockers.push("missing_commercial_anchor");
    missingEvidence.push("commercial_target_or_breakeven");
  }

  let tier: MetaAutomationReadinessTier = "manual_review";
  const executionCandidate =
    autoCandidateType &&
    rec.decisionState === "act" &&
    score >= 0.7 &&
    !blockers.includes("missing_commercial_anchor");

  if (readOnly || blockers.includes("missing_campaign_label")) {
    tier = "read_only";
  } else if (executionCandidate) {
    tier =
      empiricalOutcomeAutoEligible && livePreflightAvailable && rollbackPlanAvailable
        ? "auto_execute"
        : "backtest_candidate";
  }

  const uniqueBlockers = unique(blockers);
  const autoExecuteEligible = tier === "auto_execute" && uniqueBlockers.length === 0;
  return {
    contractVersion: "meta-automation-readiness.v1",
    tier: autoExecuteEligible ? "auto_execute" : tier === "auto_execute" ? "backtest_candidate" : tier,
    autoExecuteEligible,
    operatorReviewRequired: tier === "manual_review" || tier === "backtest_candidate",
    decisionLabel,
    blockers: uniqueBlockers,
    missingEvidence: unique(missingEvidence),
    requiredEvidence,
    reason: reasonFor(tier, uniqueBlockers),
  };
}

export function withMetaAutomationReadiness<T extends MetaRecommendation>(
  rec: T,
): T & { automationReadiness: MetaAutomationReadiness } {
  return {
    ...rec,
    automationReadiness: deriveMetaAutomationReadiness(rec, {
      empiricalOutcomeSummary: rec.empiricalOutcomeSummary ?? null,
    }),
  };
}
