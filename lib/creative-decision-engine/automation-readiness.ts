import type { MetaAutomationReadiness } from "@/lib/meta/automation-readiness";
import type { DecisionOutput } from "./types";
import type { DecisionBacktestSummary } from "./backtest";

export const CREATIVE_AUTOMATION_READINESS_THRESHOLDS = {
  hardActionPrecision: 0.9,
  hardActionRecall: 0.85,
  expectedCalibrationError: 0.05,
  criticalFalsePositiveRate: 0.01,
  highSeverityMissedOpportunityRate: 0.05,
  activeDecisionCoverage: 0.95,
} as const;

function below(
  value: number | null,
  threshold: number,
): boolean {
  return value === null || value < threshold;
}

function above(
  value: number | null,
  threshold: number,
): boolean {
  return value === null || value > threshold;
}

export function creativeAutomationReadiness(input: {
  decision: DecisionOutput;
  backtestSummary?: DecisionBacktestSummary | null;
  executorAvailable?: boolean;
  livePreflightAvailable?: boolean;
  rollbackPlanAvailable?: boolean;
  postActionMonitorAvailable?: boolean;
  holdoutPlanAvailable?: boolean;
  operatorEnablementRecorded?: boolean;
}): MetaAutomationReadiness {
  const blockers: MetaAutomationReadiness["blockers"] = [];
  const missingEvidence: string[] = [];
  const summary = input.backtestSummary ?? null;

  if (!summary) {
    blockers.push("no_empirical_outcome_model");
    missingEvidence.push("creative_empirical_outcome_model");
  } else {
    if (
      below(
        summary.hardActionPrecision,
        CREATIVE_AUTOMATION_READINESS_THRESHOLDS.hardActionPrecision,
      )
    ) {
      blockers.push("empirical_precision_below_floor");
    }
    if (
      below(
        summary.hardActionRecall,
        CREATIVE_AUTOMATION_READINESS_THRESHOLDS.hardActionRecall,
      )
    ) {
      blockers.push("insufficient_empirical_sample");
    }
    if (
      above(
        summary.expectedCalibrationError,
        CREATIVE_AUTOMATION_READINESS_THRESHOLDS.expectedCalibrationError,
      ) ||
      above(
        summary.criticalFalsePositiveRate,
        CREATIVE_AUTOMATION_READINESS_THRESHOLDS.criticalFalsePositiveRate,
      ) ||
      above(
        summary.highSeverityMissedOpportunityRate,
        CREATIVE_AUTOMATION_READINESS_THRESHOLDS.highSeverityMissedOpportunityRate,
      ) ||
      !summary.persistedCoveragePass ||
      !summary.conflictFreePass ||
      !summary.dataFreshnessPass
    ) {
      blockers.push("no_empirical_outcome_model");
    }
  }

  if (!input.executorAvailable) {
    blockers.push("missing_executor");
    missingEvidence.push("creative_executor");
  }
  if (!input.livePreflightAvailable) {
    blockers.push("missing_live_preflight");
    missingEvidence.push("creative_live_preflight");
  }
  if (!input.rollbackPlanAvailable) {
    blockers.push("missing_rollback_plan");
    missingEvidence.push("creative_rollback_plan");
  }
  if (!input.postActionMonitorAvailable) {
    blockers.push("missing_post_action_monitor");
    missingEvidence.push("creative_post_action_monitor");
  }
  if (!input.holdoutPlanAvailable) {
    blockers.push("missing_holdout_plan");
    missingEvidence.push("creative_holdout_plan");
  }
  if (!input.operatorEnablementRecorded) {
    blockers.push("missing_operator_enablement");
    missingEvidence.push("creative_operator_enablement");
  }

  const uniqueBlockers = Array.from(new Set(blockers));
  const uniqueMissingEvidence = Array.from(new Set(missingEvidence));

  return {
    contractVersion: "meta-automation-readiness.v1",
    tier: "read_only",
    autoExecuteEligible: false,
    operatorReviewRequired: true,
    decisionLabel: input.decision.label as MetaAutomationReadiness["decisionLabel"],
    blockers: uniqueBlockers,
    missingEvidence: uniqueMissingEvidence,
    requiredEvidence: [
      "creative_empirical_outcome_model",
      "creative_executor",
      "creative_live_preflight",
      "creative_rollback_plan",
      "creative_post_action_monitor",
      "creative_holdout_plan",
      "creative_operator_enablement",
    ],
    reason:
      uniqueBlockers.length > 0
        ? "Creative automation remains blocked until backtest, executor, preflight, rollback, holdout, operator enablement, and post-action monitoring pass the 9/10 thresholds."
        : "Creative automation is still read-only until an explicit operator enablement decision.",
  };
}
