import { describe, expect, it } from "vitest";
import { defaultBusinessConfig } from "../../config";
import { maturityGate } from "../../gates/maturity";
import { makeCreativeInput, makeGateContext } from "../helpers";

function terminalOutput(result: ReturnType<typeof maturityGate>) {
  if (result.kind !== "terminal") {
    throw new Error("Expected terminal maturity result.");
  }
  return result.output;
}

describe("maturityGate", () => {
  it("returns test_more below spend threshold", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 200,
            purchases: 10,
          }),
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "Thin data (28d spend $200, 10 purchases, age 21d) — let the creative accumulate signal.",
    );
  });

  it("returns test_more below purchase threshold", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 500,
            purchases: 3,
          }),
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "Thin data (28d spend $500, 3 purchases, age 21d) — let the creative accumulate signal.",
    );
  });

  it("omits the age suffix when creative age is unavailable", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 200,
            purchases: 10,
            ageDays: null,
          }),
        }),
      ),
    );

    expect(output.reason).toBe(
      "Thin data (28d spend $200, 10 purchases) — let the creative accumulate signal.",
    );
  });

  it("advances mature creatives", () => {
    const result = maturityGate(
      makeGateContext({
        input: makeCreativeInput({
          spend: 500,
          purchases: 5,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("uses custom businessConfig thresholds", () => {
    const businessConfig = {
      ...defaultBusinessConfig("biz-1"),
      maturitySpendThreshold: 1000,
    };
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 500,
            purchases: 10,
          }),
          businessConfig,
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "Thin data (28d spend $500, 10 purchases, age 21d) — let the creative accumulate signal.",
    );
  });
});
