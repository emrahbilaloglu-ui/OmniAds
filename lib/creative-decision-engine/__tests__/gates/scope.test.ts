import { describe, expect, it } from "vitest";
import { scopeGate } from "../../gates/scope";
import { makeCreativeInput, makeGateContext } from "../helpers";

describe("scopeGate", () => {
  it("advances OUTCOME_SALES creatives", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({ objective: "OUTCOME_SALES" }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances OUTCOME_SALES creatives with null effective cohort", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_SALES",
          effectiveCohort: null,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances purchase-cohort OUTCOME_SALES creatives", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_SALES",
          effectiveCohort: "purchase",
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it.each([
    [
      "mid_funnel",
      "Creative runs in mid_funnel adsets; purchase decision engine does not evaluate it.",
    ],
    [
      "upper_funnel",
      "Creative runs in upper_funnel adsets; purchase decision engine does not evaluate it.",
    ],
    [
      "unknown",
      "Creative runs in unknown adsets; purchase decision engine does not evaluate it.",
    ],
  ] as const)(
    "returns out_of_scope for OUTCOME_SALES creatives with %s cohort",
    (effectiveCohort, reason) => {
      const result = scopeGate(
        makeGateContext({
          input: makeCreativeInput({
            objective: "OUTCOME_SALES",
            effectiveCohort,
          }),
        }),
      );

      if (result.kind !== "terminal") {
        throw new Error("Expected terminal scope result.");
      }

      expect(result.output.label).toBe("out_of_scope");
      expect(result.output.reason).toBe(reason);
    },
  );

  it("returns out_of_scope for OUTCOME_ENGAGEMENT", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({ objective: "OUTCOME_ENGAGEMENT" }),
      }),
    );

    if (result.kind !== "terminal") {
      throw new Error("Expected terminal scope result.");
    }

    expect(result.output.label).toBe("out_of_scope");
    expect(result.output.reason).toBe(
      "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_ENGAGEMENT.",
    );
    expect(result.output.confidence).toBe(60);
    expect(result.output.truthSource).toBe("global_default");
    expect(result.output.ratioToTarget).toBeNull();
    expect(result.output.badges).toEqual([]);
  });

  it("returns objective-scope wording before cohort wording for non-sales objectives", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_AWARENESS",
          effectiveCohort: "purchase",
        }),
      }),
    );

    if (result.kind !== "terminal") {
      throw new Error("Expected terminal scope result.");
    }

    expect(result.output.label).toBe("out_of_scope");
    expect(result.output.reason).toBe(
      "Engine currently supports OUTCOME_SALES only; this creative is OUTCOME_AWARENESS.",
    );
  });

  it("returns out_of_scope for null objective", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({ objective: null }),
      }),
    );

    if (result.kind !== "terminal") {
      throw new Error("Expected terminal scope result.");
    }

    expect(result.output.label).toBe("out_of_scope");
    expect(result.output.reason).toBe(
      "Engine currently supports OUTCOME_SALES only; this creative is unknown.",
    );
  });
});
