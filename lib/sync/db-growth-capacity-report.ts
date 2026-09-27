import { FENCED_TABLES, type DbGrowthFenceDecision } from "./db-growth-fence";

function capacity(bytes: number | undefined | null, budget: number | undefined) {
  const measured = typeof bytes === "number" && Number.isFinite(bytes) && bytes >= 0;
  const configured = typeof budget === "number" && Number.isFinite(budget) && budget > 0;
  return {
    measuredBytes: measured ? bytes : null,
    budgetBytes: configured ? budget : null,
    remainingBytes: measured && configured ? budget - bytes : null,
    utilization: measured && configured ? bytes / budget : null,
  };
}

/** Describe an evaluation; never re-evaluate authority or extrapolate an ETA. */
export function describeDbGrowthFenceCapacity(decision: DbGrowthFenceDecision) {
  return {
    evaluatedAt: decision.evaluatedAt,
    allowed: decision.allowed,
    reason: decision.reason,
    overrideApplied: decision.overridden,
    database: capacity(
      decision.databaseBytes,
      decision.reason === "measurement_invalid" ? undefined : decision.databaseBudgetBytes,
    ),
    tables: FENCED_TABLES.map((table) => ({
      table,
      ...capacity(decision.tableBytes[table], decision.tableBudgetBytes?.[table]),
      measurementBasis: table === "meta_entity_state_history" && decision.stateHistoryEffective
        ? decision.stateHistoryEffective.metric
        : "raw_relation_bytes",
    })),
    physical: decision.physical,
    note: "Logical sync limits and physical capacity are separate. Missing measurements are unknown; remaining bytes do not establish a time to exhaustion.",
  };
}
