import type {
  CreativeDecisionCenterAggregateDecision,
  CreativeDecisionCenterRowDecision,
  DecisionCenterSnapshot,
} from "./contracts";

export interface CreativeDecisionCenterInvariantViolation {
  id: string;
  path: string;
  message: string;
}

function hasMissingData(row: CreativeDecisionCenterRowDecision): boolean {
  return row.missingData.length > 0 || row.engine.missingData.length > 0;
}

export function auditCreativeDecisionCenterRowInvariants(
  row: CreativeDecisionCenterRowDecision,
  path = "rowDecision",
): CreativeDecisionCenterInvariantViolation[] {
  const violations: CreativeDecisionCenterInvariantViolation[] = [];
  const rowWithUnknownAction = row as Omit<
    CreativeDecisionCenterRowDecision,
    "buyerAction" | "uiBucket"
  > & {
    buyerAction?: string;
    uiBucket?: string;
  };

  if (
    rowWithUnknownAction.buyerAction === "brief_variation" ||
    rowWithUnknownAction.uiBucket === "brief_variation"
  ) {
    violations.push({
      id: "I04:row_level_brief_variation",
      path,
      message: "brief_variation is aggregate-only and must not appear on row decisions.",
    });
  }

  if (row.confidenceBand === "high" && hasMissingData(row)) {
    violations.push({
      id: "I20:missing_data_with_high_confidence",
      path,
      message: "Rows with missing required data must diagnose or cap confidence.",
    });
  }

  // I22 (D019): executionAction must only ride on a scale row. The audit
  // helper enforces this structurally so any consumer that constructs row
  // decisions sees the violation even if a future adapter forgets the guard.
  if (
    row.executionAction !== null &&
    row.executionAction !== undefined &&
    row.buyerAction !== "scale"
  ) {
    violations.push({
      id: "I22:execution_action_outside_scale_buyer_action",
      path,
      message:
        "executionAction is only valid when buyerAction is 'scale'; non-scale rows must leave executionAction null/undefined.",
    });
  }

  return violations;
}

export function auditCreativeDecisionCenterAggregateInvariants(
  aggregate: CreativeDecisionCenterAggregateDecision,
  path = "aggregateDecision",
): CreativeDecisionCenterInvariantViolation[] {
  const aggregateWithUnknownFields =
    aggregate as CreativeDecisionCenterAggregateDecision & { creativeId?: unknown };

  if (aggregateWithUnknownFields.creativeId !== undefined) {
    return [
      {
        id: "I21:aggregate_decision_attached_to_creative_id",
        path,
        message: "Aggregate decisions must not attach to a random creativeId.",
      },
    ];
  }

  return [];
}

export function auditDecisionCenterSnapshotInvariants(
  snapshot: DecisionCenterSnapshot,
  path = "snapshot",
): CreativeDecisionCenterInvariantViolation[] {
  return [
    ...snapshot.rowDecisions.flatMap((row, index) =>
      auditCreativeDecisionCenterRowInvariants(row, `${path}.rowDecisions.${index}`),
    ),
    ...snapshot.aggregateDecisions.flatMap((aggregate, index) =>
      auditCreativeDecisionCenterAggregateInvariants(
        aggregate,
        `${path}.aggregateDecisions.${index}`,
      ),
    ),
  ];
}
