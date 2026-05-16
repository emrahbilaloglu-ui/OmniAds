import { describe, expect, it } from "vitest";
import { zeroConvBurnerGate } from "../../gates/zero-conv-burner";
import { makeCreativeInput, makeGateContext } from "../helpers";

function terminalOutput(result: ReturnType<typeof zeroConvBurnerGate>) {
  if (result.kind !== "terminal") {
    throw new Error("Expected terminal zero-conv burner result.");
  }
  return result.output;
}

describe("zeroConvBurnerGate", () => {
  it("cuts zero-purchase creatives with sustained burn", () => {
    const output = terminalOutput(
      zeroConvBurnerGate(
        makeGateContext({
          input: makeCreativeInput({
            purchases: 0,
            spend: 300,
            ageDays: 14,
          }),
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toBe(
      "0 purchases on $300 spend (28d cumulative, age 14d) — sustained zero-conversion burn past CPA-anchored maturity threshold $200.",
    );
    expect(output.confidence).toBe(80);
  });

  it("advances zero-purchase creatives below minimum spend", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: makeCreativeInput({
          purchases: 0,
          spend: 150,
          ageDays: 14,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances zero-purchase creatives below minimum age", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: makeCreativeInput({
          purchases: 0,
          spend: 300,
          ageDays: 5,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("advances creatives with at least one purchase", () => {
    const result = zeroConvBurnerGate(
      makeGateContext({
        input: makeCreativeInput({
          purchases: 1,
          spend: 300,
          ageDays: 14,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });
});
