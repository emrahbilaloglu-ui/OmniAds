import { describe, expect, it } from "vitest";
import { scopeGate } from "../../gates/scope";
import { makeCreativeInput, makeGateContext } from "../helpers";

describe("scopeGate", () => {
  const pureContextGrain = {
    providerAccountCount: 1,
    campaignCount: 1,
    adsetCount: 1,
    optimizationContextCount: 1,
    objectiveCount: 1,
    contextIdentityUnknown: false,
  } as const;

  it("advances OUTCOME_SALES creatives", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({ objective: "OUTCOME_SALES" }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances a known, singular purchase decision grain", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_SALES",
          effectiveCohort: "purchase",
          contextGrain: pureContextGrain,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it.each([
    "campaignCount",
    "adsetCount",
    "optimizationContextCount",
  ] as const)("blocks mixed %s at creative grain", (field) => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_SALES",
          effectiveCohort: "purchase",
          contextGrain: { ...pureContextGrain, [field]: 2 },
        }),
      }),
    );

    if (result.kind !== "terminal") {
      throw new Error("Expected terminal scope result.");
    }
    expect(result.output.label).toBe("out_of_scope");
    expect(result.output.reason).toBe(
      "mixed decision context; evaluate at ad grain",
    );
  });

  it("blocks unavailable required context identity", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_SALES",
          effectiveCohort: "purchase",
          contextGrain: {
            ...pureContextGrain,
            contextIdentityUnknown: true,
          },
        }),
      }),
    );

    if (result.kind !== "terminal") {
      throw new Error("Expected terminal scope result.");
    }
    expect(result.output.label).toBe("out_of_scope");
    expect(result.output.reason).toBe(
      "decision context identity unavailable; evaluate at ad grain",
    );
  });

  it("blocks a zero required context cardinality even without the unknown flag", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_SALES",
          effectiveCohort: "purchase",
          contextGrain: {
            ...pureContextGrain,
            adsetCount: 0,
          },
        }),
      }),
    );

    if (result.kind !== "terminal") {
      throw new Error("Expected terminal scope result.");
    }
    expect(result.output.reason).toBe(
      "decision context identity unavailable; evaluate at ad grain",
    );
  });

  it("blocks an unresolved cohort when production grain metadata is present", () => {
    const result = scopeGate(
      makeGateContext({
        input: makeCreativeInput({
          objective: "OUTCOME_SALES",
          effectiveCohort: null,
          contextGrain: pureContextGrain,
        }),
      }),
    );

    if (result.kind !== "terminal") {
      throw new Error("Expected terminal scope result.");
    }
    expect(result.output.reason).toBe(
      "mixed/unresolved optimization cohort; purchase decision engine does not evaluate it.",
    );
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
      "mixed/unresolved optimization cohort; purchase decision engine does not evaluate it.",
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
