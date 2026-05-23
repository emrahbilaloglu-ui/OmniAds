import {
  type CreativeDecisionCenterAggregateAction,
  type CreativeDecisionCenterAggregateDecision,
  type CreativeDecisionCenterPriority,
} from "./contracts";

export const CREATIVE_DECISION_CENTER_AGGREGATE_BUILDER_VERSION =
  "creative-decision-center.aggregate-builder.v1";

export const REQUIRED_AGGREGATE_DATA = {
  brief_variation: [
    "family_winner_fatigue",
    "backup_variant_status",
    "creative_supply_backlog",
  ],
  creative_supply_warning: [
    "creative_supply_backlog",
    "recent_launches",
    "production_state",
  ],
  winner_gap: ["last_winner_date", "historical_snapshot_window"],
  fatigue_cluster: [
    "fatigue_trend_window",
    "cluster_definition",
    "performance_trend",
  ],
  unused_approved_creatives: [
    "creative_review_status",
    "delivery_proof",
    "lifetime_delivery",
  ],
} as const satisfies Record<CreativeDecisionCenterAggregateAction, readonly string[]>;

export type DecisionCenterAggregateSuppressionReason =
  | "candidate_missing_data"
  | "missing_family_id"
  | "missing_required_data";

export interface CreativeDecisionCenterAggregateCandidate {
  scope: "page" | "family";
  familyId?: string | null;
  action: CreativeDecisionCenterAggregateAction;
  priority: CreativeDecisionCenterPriority;
  confidence: number;
  oneLine: string;
  reasons: readonly string[];
  affectedCreativeIds: readonly string[];
  nextStep: string;
  missingData?: readonly string[];
  availableData?: readonly string[];
}

export interface DecisionCenterAggregateSuppression {
  index: number;
  action: CreativeDecisionCenterAggregateAction;
  scope: "page" | "family";
  familyId?: string | null;
  reason: DecisionCenterAggregateSuppressionReason;
  missingRequiredData: string[];
  candidateMissingData: string[];
}

export interface DecisionCenterAggregateBuildTrace {
  candidateCount: number;
  emittedCount: number;
  suppressedCount: number;
  suppressed: DecisionCenterAggregateSuppression[];
}

export interface DecisionCenterAggregateBuilderInput {
  candidates?: readonly CreativeDecisionCenterAggregateCandidate[];
}

export interface DecisionCenterAggregateBuilderResult {
  aggregateDecisions: CreativeDecisionCenterAggregateDecision[];
  trace: DecisionCenterAggregateBuildTrace;
}

function missingRequiredDataFor(
  candidate: CreativeDecisionCenterAggregateCandidate,
): string[] {
  const availableData = new Set(candidate.availableData ?? []);
  return REQUIRED_AGGREGATE_DATA[candidate.action].filter(
    (field) => !availableData.has(field),
  );
}

export function buildDecisionCenterAggregateDecisions(
  input: DecisionCenterAggregateBuilderInput = {},
): DecisionCenterAggregateBuilderResult {
  const candidates = input.candidates ?? [];
  const aggregateDecisions: CreativeDecisionCenterAggregateDecision[] = [];
  const suppressed: DecisionCenterAggregateSuppression[] = [];

  candidates.forEach((candidate, index) => {
    const candidateMissingData = [...(candidate.missingData ?? [])];
    const missingRequiredData = missingRequiredDataFor(candidate);
    let reason: DecisionCenterAggregateSuppressionReason | null = null;

    if (candidate.scope === "family" && !candidate.familyId?.trim()) {
      reason = "missing_family_id";
    } else if (candidateMissingData.length > 0) {
      reason = "candidate_missing_data";
    } else if (missingRequiredData.length > 0) {
      reason = "missing_required_data";
    }

    if (reason) {
      suppressed.push({
        index,
        action: candidate.action,
        scope: candidate.scope,
        familyId: candidate.familyId ?? null,
        reason,
        missingRequiredData,
        candidateMissingData,
      });
      return;
    }

    aggregateDecisions.push({
      scope: candidate.scope,
      familyId: candidate.familyId ?? null,
      action: candidate.action,
      priority: candidate.priority,
      confidence: candidate.confidence,
      oneLine: candidate.oneLine,
      reasons: [...candidate.reasons],
      affectedCreativeIds: [...candidate.affectedCreativeIds],
      nextStep: candidate.nextStep,
      missingData: [],
    });
  });

  return {
    aggregateDecisions,
    trace: {
      candidateCount: candidates.length,
      emittedCount: aggregateDecisions.length,
      suppressedCount: suppressed.length,
      suppressed,
    },
  };
}
