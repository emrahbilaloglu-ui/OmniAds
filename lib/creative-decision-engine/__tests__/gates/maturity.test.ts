import { describe, expect, it } from "vitest";
import { defaultBusinessConfig } from "../../config";
import { maturityGate } from "../../gates/maturity";
import {
  makeAccountCalibration,
  makeAccountDecisionProfile,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

function terminalOutput(result: ReturnType<typeof maturityGate>) {
  if (result.kind !== "terminal") {
    throw new Error("Expected terminal maturity result.");
  }
  return result.output;
}

function severeLoserBypassProfile(
  overrides: {
    matureSpendP50?: number | null;
    winnerPurchaseP50?: number | null;
    hardCutSpend?: number | null;
    severeLoserRatio?: number | null;
  } = {},
) {
  return makeAccountDecisionProfile({
    accountBaselines: makeAccountCalibration({
      matureSpendP50:
        overrides.matureSpendP50 === undefined
          ? 500
          : overrides.matureSpendP50,
      winnerPurchaseP50:
        overrides.winnerPurchaseP50 === undefined
          ? 10
          : overrides.winnerPurchaseP50,
    }),
    thresholds: {
      hardCutSpend:
        overrides.hardCutSpend === undefined ? 250 : overrides.hardCutSpend,
      severeLoserRatio:
        overrides.severeLoserRatio === undefined
          ? 0.27
          : overrides.severeLoserRatio,
    },
  });
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

  it("cuts severe losers that exceed hard-cut spend despite thin sample", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 323,
            purchases: 3,
            roas: 0.87,
            targetRoas: 3.5,
          }),
          profile: severeLoserBypassProfile(),
          gate: {
            effectiveTargetRoas: 3.5,
            ratioToTarget: 0.25,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toMatch(/^Severe loser at scale/);
    expect(output.reason).toContain(
      "decisive cut despite young age / thin sample",
    );
  });

  it("does not bypass thin data when spend is below hard-cut spend", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 249,
            purchases: 3,
            roas: 0.87,
            targetRoas: 3.5,
          }),
          profile: severeLoserBypassProfile(),
          gate: {
            effectiveTargetRoas: 3.5,
            ratioToTarget: 0.25,
          },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toMatch(/^Thin data/);
  });

  it("does not bypass thin data when ratio is not severe", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 323,
            purchases: 3,
            roas: 1.4,
            targetRoas: 3.5,
          }),
          profile: severeLoserBypassProfile(),
          gate: {
            effectiveTargetRoas: 3.5,
            ratioToTarget: 0.4,
          },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toMatch(/^Thin data/);
  });

  it("does not bypass thin data without severe-loser calibration", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 323,
            purchases: 3,
            roas: 0.87,
            targetRoas: 3.5,
          }),
          profile: severeLoserBypassProfile({
            severeLoserRatio: null,
          }),
          gate: {
            effectiveTargetRoas: 3.5,
            ratioToTarget: 0.25,
          },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toMatch(/^Thin data/);
  });

  it("does not bypass thin data without hard-cut spend calibration", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 323,
            purchases: 3,
            roas: 0.87,
            targetRoas: 3.5,
          }),
          profile: severeLoserBypassProfile({
            hardCutSpend: null,
          }),
          gate: {
            effectiveTargetRoas: 3.5,
            ratioToTarget: 0.25,
          },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toMatch(/^Thin data/);
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
