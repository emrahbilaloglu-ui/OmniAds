import type { DecisionLabel } from "./types";

export const CREATIVE_OUTCOME_CLASSIFIER_VERSION =
  "creative-outcome-classifier.v2";

export type CreativeDecisionRealizedOutcome =
  | "positive"
  | "negative"
  | "neutral"
  | "unknown";

export type CreativeDecisionOutcomeSeverity =
  | "critical"
  | "high"
  | "medium"
  | "low";

export interface CreativeDecisionOutcomeClassificationInput {
  label: DecisionLabel;
  confidence: number;
  effectiveTargetRoas: number;
  baselineSpend: number | null;
  baselinePurchases: number | null;
  baselineRoas: number | null;
  outcomeSpend: number;
  outcomePurchases: number;
  outcomeRevenue: number;
  outcomeRoas: number | null;
  outcomeWindowDays: number;
}

export interface CreativeDecisionOutcomeClassification {
  realizedOutcome: CreativeDecisionRealizedOutcome;
  severity: CreativeDecisionOutcomeSeverity;
  evidence: Record<string, unknown>;
}

function finite(value: number | null | undefined): value is number {
  return typeof value === "number" && Number.isFinite(value);
}

function positive(value: number | null | undefined): value is number {
  return finite(value) && value > 0;
}

function severityFromSpend(
  outcomeSpend: number,
  baselineSpend: number | null,
): CreativeDecisionOutcomeSeverity {
  const baseline = positive(baselineSpend) ? baselineSpend : 250;
  if (outcomeSpend >= baseline) return "critical";
  if (outcomeSpend >= baseline * 0.5) return "high";
  if (outcomeSpend >= baseline * 0.25) return "medium";
  return "low";
}

function evidence(input: CreativeDecisionOutcomeClassificationInput) {
  const target = input.effectiveTargetRoas;
  return {
    classifierVersion: CREATIVE_OUTCOME_CLASSIFIER_VERSION,
    label: input.label,
    confidence: input.confidence,
    targetRoas: target,
    outcomeWindowDays: input.outcomeWindowDays,
    baseline: {
      spend: input.baselineSpend,
      purchases: input.baselinePurchases,
      roas: input.baselineRoas,
    },
    outcome: {
      spend: input.outcomeSpend,
      purchases: input.outcomePurchases,
      revenue: input.outcomeRevenue,
      roas: input.outcomeRoas,
      ratioToTarget:
        positive(input.outcomeRoas) && positive(target)
          ? Number((input.outcomeRoas / target).toFixed(4))
          : null,
    },
  };
}

export function classifyCreativeDecisionOutcome(
  input: CreativeDecisionOutcomeClassificationInput,
): CreativeDecisionOutcomeClassification {
  const baseEvidence = evidence(input);
  const severity = severityFromSpend(input.outcomeSpend, input.baselineSpend);
  const target = input.effectiveTargetRoas;
  const roas = input.outcomeRoas;

  if (!positive(input.outcomeSpend) || roas === null || !positive(target)) {
    return {
      realizedOutcome: "unknown",
      severity: "low",
      evidence: {
        ...baseEvidence,
        rule: "missing_outcome_spend_or_target",
      },
    };
  }

  if (input.label === "scale") {
    if (roas >= target && input.outcomePurchases > 0) {
      return {
        realizedOutcome: "positive",
        severity,
        evidence: { ...baseEvidence, rule: "scale_held_above_target" },
      };
    }
    if (roas < target * 0.8) {
      return {
        realizedOutcome: "negative",
        severity,
        evidence: { ...baseEvidence, rule: "scale_failed_recent_hold" },
      };
    }
    return {
      realizedOutcome: "neutral",
      severity,
      evidence: { ...baseEvidence, rule: "scale_inconclusive" },
    };
  }

  if (input.label === "cut") {
    if (input.outcomePurchases <= 0 || roas < target * 0.7) {
      return {
        realizedOutcome: "positive",
        severity,
        evidence: { ...baseEvidence, rule: "cut_loss_continued" },
      };
    }
    if (roas >= target) {
      return {
        realizedOutcome: "negative",
        severity,
        evidence: { ...baseEvidence, rule: "cut_recovered_above_target" },
      };
    }
    return {
      realizedOutcome: "neutral",
      severity,
      evidence: { ...baseEvidence, rule: "cut_still_below_target_but_not_severe" },
    };
  }

  if (input.label === "refresh") {
    const baselineRoas = input.baselineRoas;
    if (roas < target * 0.9) {
      if (!positive(baselineRoas)) {
        return {
          realizedOutcome: "neutral",
          severity,
          evidence: {
            ...baseEvidence,
            rule: "refresh_missing_baseline_inconclusive",
          },
        };
      }
      if (roas < baselineRoas * 0.85) {
        return {
          realizedOutcome: "positive",
          severity,
          evidence: { ...baseEvidence, rule: "refresh_decay_continued" },
        };
      }
    }
    if (roas >= target) {
      return {
        realizedOutcome: "negative",
        severity,
        evidence: { ...baseEvidence, rule: "refresh_signal_recovered" },
      };
    }
    return {
      realizedOutcome: "neutral",
      severity,
      evidence: { ...baseEvidence, rule: "refresh_inconclusive" },
    };
  }

  if (roas >= target * 1.3 && input.outcomePurchases >= 2) {
    return {
      realizedOutcome: "positive",
      severity,
      evidence: { ...baseEvidence, rule: "non_hard_missed_scale_opportunity" },
    };
  }

  if (input.outcomePurchases <= 0 || roas < target * 0.6) {
    return {
      realizedOutcome: "positive",
      severity,
      evidence: { ...baseEvidence, rule: "non_hard_missed_cut_opportunity" },
    };
  }

  return {
    realizedOutcome: "neutral",
    severity,
    evidence: { ...baseEvidence, rule: "non_hard_no_missed_hard_action" },
  };
}
