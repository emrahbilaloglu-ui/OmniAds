import { describe, expect, it } from "vitest";
import {
  computeFatigue,
  type FatigueInput,
  type HistoricalWindow,
} from "../fatigue";

const strongWindow: HistoricalWindow = {
  spend: 500,
  ctr: 2.0,
  roas: 4.0,
  clickToPurchaseRate: 0.08,
  purchases: 4,
};

function makeInput(overrides: Partial<FatigueInput> = {}): FatigueInput {
  return {
    ctr: 2.0,
    roas: 4.0,
    clickToPurchaseRate: 0.08,
    historicalWindows: {},
    spendConcentration: null,
    frequency: 1.5,
    benchmarkRoasStatus: null,
    benchmarkClickToPurchaseStatus: null,
    ...overrides,
  };
}

describe("computeFatigue", () => {
  it("returns unknown when all historical windows are unavailable", () => {
    const output = computeFatigue(
      makeInput({
        frequency: null,
        historicalWindows: {
          last14: null,
          last30: null,
          last90: null,
          allHistory: null,
        },
      }),
    );

    expect(output.status).toBe("unknown");
    expect(output.winnerMemory).toBe(false);
    expect(output.missingContext).toContain(
      "Historical winner window unavailable",
    );
  });

  it("returns fatigued for winner memory, composite decay, and pressure", () => {
    const output = computeFatigue(
      makeInput({
        ctr: 1.2,
        roas: 2.6,
        clickToPurchaseRate: 0.04,
        spendConcentration: 0.6,
        historicalWindows: {
          last30: strongWindow,
          last90: {
            ...strongWindow,
            roas: 3.5,
            ctr: 1.8,
            clickToPurchaseRate: 0.07,
          },
        },
      }),
    );

    expect(output.status).toBe("fatigued");
    expect(output.winnerMemory).toBe(true);
    expect(output.confidence).toBeGreaterThan(0.7);
  });

  it("returns watch for winner memory and one decay signal", () => {
    const output = computeFatigue(
      makeInput({
        ctr: 1.5,
        roas: 4.0,
        clickToPurchaseRate: 0.08,
        historicalWindows: {
          last30: strongWindow,
          last90: {
            ...strongWindow,
            roas: 3.6,
          },
        },
      }),
    );

    expect(output.status).toBe("watch");
    expect(output.ctrDecay).toBe(0.25);
  });

  it("keeps two decay signals at watch without pressure or benchmark weakening", () => {
    const output = computeFatigue(
      makeInput({
        ctr: 1.2,
        roas: 2.6,
        clickToPurchaseRate: 0.08,
        spendConcentration: 0.3,
        frequency: 1.4,
        historicalWindows: {
          last30: strongWindow,
          last90: {
            ...strongWindow,
            roas: 3.5,
          },
        },
      }),
    );

    expect(output.status).toBe("watch");
    expect(output.ctrDecay).toBeGreaterThan(0.18);
    expect(output.roasDecay).toBeGreaterThan(0.18);
  });

  it("ignores last3 when selecting bestWindow", () => {
    const output = computeFatigue(
      makeInput({
        ctr: 2.0,
        roas: 5.0,
        clickToPurchaseRate: 0.08,
        spendConcentration: 0.8,
        frequency: 3.0,
        historicalWindows: {
          last3: {
            ...strongWindow,
            roas: 9.0,
          },
          last30: {
            ...strongWindow,
            roas: 5.0,
          },
        },
      }),
    );

    expect(output.roasDecay).toBe(0);
    expect(output.status).not.toBe("fatigued");
  });

  it("records missing frequency and reduces confidence", () => {
    const withFrequency = computeFatigue(
      makeInput({
        ctr: 1.2,
        roas: 2.6,
        clickToPurchaseRate: 0.04,
        spendConcentration: 0.6,
        frequency: 2.6,
        historicalWindows: {
          last30: strongWindow,
          last90: {
            ...strongWindow,
            roas: 3.5,
          },
        },
      }),
    );
    const missingFrequency = computeFatigue(
      makeInput({
        ctr: 1.2,
        roas: 2.6,
        clickToPurchaseRate: 0.04,
        spendConcentration: 0.6,
        frequency: null,
        historicalWindows: {
          last30: strongWindow,
          last90: {
            ...strongWindow,
            roas: 3.5,
          },
        },
      }),
    );

    expect(missingFrequency.missingContext).toContain("Frequency unavailable");
    expect(missingFrequency.confidence).toBeLessThan(withFrequency.confidence);
  });

  it("returns none when eligible windows exist but decay signals are unavailable", () => {
    const output = computeFatigue(
      makeInput({
        ctr: null,
        roas: null,
        clickToPurchaseRate: null,
        historicalWindows: {
          last14: {
            spend: 0,
            ctr: 0,
            roas: 0,
            clickToPurchaseRate: 0,
            purchases: 0,
          },
        },
      }),
    );

    expect(output.status).toBe("none");
    expect(output.ctrDecay).toBeNull();
    expect(output.clickToPurchaseDecay).toBeNull();
    expect(output.roasDecay).toBeNull();
  });

  it("returns unknown when winnerMemory is false and no eligible windows exist", () => {
    const output = computeFatigue(
      makeInput({
        historicalWindows: {},
      }),
    );

    expect(output.status).toBe("unknown");
    expect(output.winnerMemory).toBe(false);
  });
});
