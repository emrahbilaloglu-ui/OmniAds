import { describe, expect, it } from "vitest";
import {
  DEFAULT_ROLLING_ORIGIN_FOLDS,
  assignRollingOriginFold,
  type EvaluationFoldDefinition,
} from "./evaluation-folds";

describe("assignRollingOriginFold", () => {
  it.each([
    ["2025-12-01", "development", "fit"],
    ["2026-03-31", "development", "fit"],
    ["2026-04-01", "calibration", "select"],
    ["2026-05-31", "calibration", "select"],
    ["2026-06-01", "locked_test", "evaluate"],
    ["2026-07-05", "locked_test", "evaluate"],
  ])("assigns %s to the deterministic %s fold", (date, foldId, role) => {
    const result = assignRollingOriginFold({
      decisionDate: date,
      outcomeWindowDays: 0,
      outcomesObservedThrough: "2026-07-20",
    });

    expect(result).toMatchObject({
      foldId,
      role,
      decisionEligible: true,
      outcomeEligible: true,
      eligible: true,
      reason: "eligible",
    });
  });

  it("prevents development and calibration outcomes from crossing selection boundaries", () => {
    const development = assignRollingOriginFold({
      decisionDate: "2026-03-25",
      outcomeWindowDays: 7,
      outcomesObservedThrough: "2026-07-20",
    });
    const calibration = assignRollingOriginFold({
      decisionDate: "2026-05-25",
      outcomeWindowDays: 7,
      outcomesObservedThrough: "2026-07-20",
    });

    expect(development).toMatchObject({
      foldId: "development",
      outcomeDueDate: "2026-04-01",
      effectiveOutcomeCeilingDate: "2026-03-31",
      outcomeEligible: false,
      reason: "outcome_not_mature",
    });
    expect(calibration).toMatchObject({
      foldId: "calibration",
      outcomeDueDate: "2026-06-01",
      effectiveOutcomeCeilingDate: "2026-05-31",
      outcomeEligible: false,
      reason: "outcome_not_mature",
    });
  });

  it("uses the dated completeness receipt as the terminal test ceiling", () => {
    const mature = assignRollingOriginFold({
      decisionDate: "2026-07-04",
      outcomeWindowDays: 7,
      outcomesObservedThrough: "2026-07-11",
    });
    const immature = assignRollingOriginFold({
      decisionDate: "2026-07-05",
      outcomeWindowDays: 7,
      outcomesObservedThrough: "2026-07-11",
    });

    expect(mature).toMatchObject({
      foldId: "locked_test",
      outcomeDueDate: "2026-07-11",
      effectiveOutcomeCeilingDate: "2026-07-11",
      eligible: true,
    });
    expect(immature).toMatchObject({
      foldId: "locked_test",
      outcomeDueDate: "2026-07-12",
      effectiveOutcomeCeilingDate: "2026-07-11",
      eligible: false,
      reason: "outcome_not_mature",
    });
  });

  it("returns an explicit outside-protocol assignment", () => {
    expect(
      assignRollingOriginFold({
        decisionDate: "2025-11-30",
        outcomeWindowDays: 7,
        outcomesObservedThrough: "2026-07-11",
      }),
    ).toMatchObject({
      foldId: null,
      decisionEligible: false,
      outcomeEligible: false,
      eligible: false,
      reason: "outside_protocol",
    });
  });

  it("is independent of custom fold input order", () => {
    const reversed = [...DEFAULT_ROLLING_ORIGIN_FOLDS].reverse();
    expect(
      assignRollingOriginFold({
        decisionDate: "2026-04-15",
        outcomeWindowDays: 7,
        outcomesObservedThrough: "2026-05-31",
        folds: reversed,
      }),
    ).toMatchObject({ foldId: "calibration", eligible: true });
  });

  it("rejects malformed, duplicate, or overlapping fold contracts", () => {
    const overlapping: EvaluationFoldDefinition[] = [
      {
        id: "one",
        decisionStartDate: "2026-01-01",
        decisionEndDate: "2026-01-10",
        outcomeCeilingDate: "2026-01-10",
        role: "fit",
      },
      {
        id: "two",
        decisionStartDate: "2026-01-10",
        decisionEndDate: "2026-01-20",
        outcomeCeilingDate: "2026-01-20",
        role: "select",
      },
    ];

    expect(() =>
      assignRollingOriginFold({
        decisionDate: "2026-01-05",
        outcomeWindowDays: 7,
        outcomesObservedThrough: "2026-02-01",
        folds: overlapping,
      }),
    ).toThrow("evaluation folds overlap");
    expect(() =>
      assignRollingOriginFold({
        decisionDate: "2026-02-30",
        outcomeWindowDays: 7,
        outcomesObservedThrough: "2026-07-11",
      }),
    ).toThrow("decisionDate must be a valid ISO calendar date");
    expect(() =>
      assignRollingOriginFold({
        decisionDate: "2026-01-01",
        outcomeWindowDays: 1.5,
        outcomesObservedThrough: "2026-07-11",
      }),
    ).toThrow("outcomeWindowDays must be a non-negative integer");
  });
});
