const ISO_DATE_PATTERN = /^(\d{4})-(\d{2})-(\d{2})$/;
const DAY_MS = 24 * 60 * 60 * 1000;

export type DefaultEvaluationFoldId =
  "development" | "calibration" | "locked_test";

export interface EvaluationFoldDefinition {
  id: string;
  decisionStartDate: string;
  decisionEndDate: string;
  /**
   * Last date whose outcome may be used by this fold. A null ceiling lets the
   * caller's observed-through receipt control maturity (appropriate for the
   * terminal locked test, which has no later selection phase to contaminate).
   */
  outcomeCeilingDate: string | null;
  role: "fit" | "select" | "evaluate";
}

export const DEFAULT_ROLLING_ORIGIN_FOLDS = [
  {
    id: "development",
    decisionStartDate: "2025-12-01",
    decisionEndDate: "2026-03-31",
    outcomeCeilingDate: "2026-03-31",
    role: "fit",
  },
  {
    id: "calibration",
    decisionStartDate: "2026-04-01",
    decisionEndDate: "2026-05-31",
    outcomeCeilingDate: "2026-05-31",
    role: "select",
  },
  {
    id: "locked_test",
    decisionStartDate: "2026-06-01",
    decisionEndDate: "2026-07-05",
    outcomeCeilingDate: null,
    role: "evaluate",
  },
] as const satisfies readonly EvaluationFoldDefinition[];

export type EvaluationFoldAssignmentReason =
  "eligible" | "outside_protocol" | "outcome_not_mature";

export interface EvaluationFoldAssignment {
  foldId: string | null;
  role: EvaluationFoldDefinition["role"] | null;
  decisionDate: string;
  outcomeWindowDays: number;
  outcomeDueDate: string;
  effectiveOutcomeCeilingDate: string | null;
  decisionEligible: boolean;
  outcomeEligible: boolean;
  eligible: boolean;
  reason: EvaluationFoldAssignmentReason;
}

export interface AssignRollingOriginFoldInput {
  decisionDate: string;
  outcomeWindowDays: number;
  /** Dated completeness receipt for the outcome source, not today's date. */
  outcomesObservedThrough: string;
  folds?: readonly EvaluationFoldDefinition[];
}

function epochDay(value: string, field: string): number {
  const match = ISO_DATE_PATTERN.exec(value);
  if (!match) throw new Error(`${field} must be an ISO calendar date`);

  const timestamp = Date.parse(`${value}T00:00:00.000Z`);
  if (
    !Number.isFinite(timestamp) ||
    new Date(timestamp).toISOString().slice(0, 10) !== value
  ) {
    throw new Error(`${field} must be a valid ISO calendar date`);
  }
  return Math.floor(timestamp / DAY_MS);
}

function isoDateFromEpochDay(value: number): string {
  return new Date(value * DAY_MS).toISOString().slice(0, 10);
}

function validatedFolds(
  folds: readonly EvaluationFoldDefinition[],
): Array<EvaluationFoldDefinition & { startDay: number; endDay: number }> {
  if (folds.length === 0) {
    throw new Error("at least one evaluation fold is required");
  }

  const ids = new Set<string>();
  const normalized = folds
    .map((fold) => {
      if (!fold.id.trim())
        throw new Error("evaluation fold id cannot be empty");
      if (ids.has(fold.id)) {
        throw new Error(`duplicate evaluation fold id: ${fold.id}`);
      }
      ids.add(fold.id);

      const startDay = epochDay(
        fold.decisionStartDate,
        `${fold.id}.decisionStartDate`,
      );
      const endDay = epochDay(
        fold.decisionEndDate,
        `${fold.id}.decisionEndDate`,
      );
      if (endDay < startDay) {
        throw new Error(`${fold.id} decision range ends before it starts`);
      }
      if (fold.outcomeCeilingDate !== null) {
        const ceilingDay = epochDay(
          fold.outcomeCeilingDate,
          `${fold.id}.outcomeCeilingDate`,
        );
        if (ceilingDay < startDay) {
          throw new Error(`${fold.id} outcome ceiling precedes its decisions`);
        }
      }

      return { ...fold, startDay, endDay };
    })
    .sort(
      (left, right) =>
        left.startDay - right.startDay || left.id.localeCompare(right.id),
    );

  for (let index = 1; index < normalized.length; index += 1) {
    if (normalized[index].startDay <= normalized[index - 1].endDay) {
      throw new Error(
        `evaluation folds overlap: ${normalized[index - 1].id} and ${normalized[index].id}`,
      );
    }
  }
  return normalized;
}

export function assignRollingOriginFold(
  input: AssignRollingOriginFoldInput,
): EvaluationFoldAssignment {
  if (
    !Number.isInteger(input.outcomeWindowDays) ||
    input.outcomeWindowDays < 0
  ) {
    throw new Error("outcomeWindowDays must be a non-negative integer");
  }

  const decisionDay = epochDay(input.decisionDate, "decisionDate");
  const observedThroughDay = epochDay(
    input.outcomesObservedThrough,
    "outcomesObservedThrough",
  );
  const outcomeDueDay = decisionDay + input.outcomeWindowDays;
  const outcomeDueDate = isoDateFromEpochDay(outcomeDueDay);
  const fold = validatedFolds(input.folds ?? DEFAULT_ROLLING_ORIGIN_FOLDS).find(
    (candidate) =>
      decisionDay >= candidate.startDay && decisionDay <= candidate.endDay,
  );

  if (!fold) {
    return {
      foldId: null,
      role: null,
      decisionDate: input.decisionDate,
      outcomeWindowDays: input.outcomeWindowDays,
      outcomeDueDate,
      effectiveOutcomeCeilingDate: null,
      decisionEligible: false,
      outcomeEligible: false,
      eligible: false,
      reason: "outside_protocol",
    };
  }

  const foldCeilingDay =
    fold.outcomeCeilingDate === null
      ? Number.POSITIVE_INFINITY
      : epochDay(fold.outcomeCeilingDate, `${fold.id}.outcomeCeilingDate`);
  const effectiveCeilingDay = Math.min(observedThroughDay, foldCeilingDay);
  const outcomeEligible = outcomeDueDay <= effectiveCeilingDay;

  return {
    foldId: fold.id,
    role: fold.role,
    decisionDate: input.decisionDate,
    outcomeWindowDays: input.outcomeWindowDays,
    outcomeDueDate,
    effectiveOutcomeCeilingDate: isoDateFromEpochDay(effectiveCeilingDay),
    decisionEligible: true,
    outcomeEligible,
    eligible: outcomeEligible,
    reason: outcomeEligible ? "eligible" : "outcome_not_mature",
  };
}
