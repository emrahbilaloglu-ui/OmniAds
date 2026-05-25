import { describe, expect, it } from "vitest";
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
    commercialMaturitySpend?: number | null;
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
      commercialMaturitySpend:
        overrides.commercialMaturitySpend === undefined
          ? 500
          : overrides.commercialMaturitySpend,
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
            spend: 150,
            purchases: 10,
          }),
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "Below commercial maturity (28d spend $150 < $200 loss-budget floor, 10 purchases, age 21d) — let the creative accumulate signal.",
    );
  });

  it("advances loss-budget mature creatives even below scale purchase depth", () => {
    const result = maturityGate(
      makeGateContext({
        input: makeCreativeInput({
          spend: 500,
          purchases: 1,
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });

  it("omits the age suffix when creative age is unavailable", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 150,
            purchases: 10,
            ageDays: null,
          }),
        }),
      ),
    );

    expect(output.reason).toBe(
      "Below commercial maturity (28d spend $150 < $200 loss-budget floor, 10 purchases) — let the creative accumulate signal.",
    );
  });

  it("marks below-maturity creatives as launch monitoring only with explicit launch basis", () => {
    const output = terminalOutput(
      maturityGate(
        makeGateContext({
          input: makeCreativeInput({
            spend: 150,
            purchases: 0,
            firstSpendAt: "2026-05-04T00:00:00.000Z",
          }),
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.badges).toContainEqual({
      type: "launch_monitoring",
      label:
        "Inside 3d launch window (explicit first-spend/first-seen basis, age 0d)",
      severity: "info",
    });
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
    expect(output.reason).toMatch(/^Below commercial maturity/);
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
    expect(output.reason).toMatch(/^Below commercial maturity/);
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
    expect(output.reason).toMatch(/^Below commercial maturity/);
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
    expect(output.reason).toMatch(/^Below commercial maturity/);
  });

  it("uses loss-budget maturity instead of hard-cut x8 maturity", () => {
    const result = maturityGate(
      makeGateContext({
        input: makeCreativeInput({
          spend: 250,
          purchases: 1,
        }),
        profile: makeAccountDecisionProfile({
          accountBaselines: makeAccountCalibration({
            accountCpaP50: 100,
            matureSpendP50: 100,
            winnerPurchaseP50: 10,
          }),
          multipliers: {
            hardCut: 8,
            lossBudget: 2,
          },
          thresholds: {
            commercialMaturitySpend: null,
          },
        }),
      }),
    );

    expect(result.kind).toBe("advance");
  });
});
