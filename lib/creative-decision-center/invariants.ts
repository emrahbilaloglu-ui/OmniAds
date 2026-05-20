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
