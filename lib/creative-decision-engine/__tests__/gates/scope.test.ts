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
