import { describe, expect, it } from "vitest";
import {
  computeFatigue,
  deriveDisjointWindows,
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

  it("requires target-relative ROAS for strong historical windows", () => {
    const targetLightWindow: HistoricalWindow = {
      ...strongWindow,
      spend: 300,
      purchases: 5,
      roas: 1.6,
    };
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: 2.2,
        historicalWindows: {
          last30: targetLightWindow,
          last90: targetLightWindow,
        },
      }),
    );

    expect(output.winnerMemory).toBe(false);
  });

  it("accepts target-relative ROAS once the historical window clears the target floor", () => {
    const targetStrongWindow: HistoricalWindow = {
      ...strongWindow,
      spend: 300,
      purchases: 5,
      roas: 2.0,
    };
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: 2.2,
        historicalWindows: {
          last30: targetStrongWindow,
          last90: targetStrongWindow,
        },
      }),
    );

    expect(output.winnerMemory).toBe(true);
  });

  it("uses the absolute ROAS fallback when no target context is available", () => {
    const fallbackStrongWindow: HistoricalWindow = {
      ...strongWindow,
      spend: 300,
      purchases: 5,
      roas: 1.5,
    };
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: null,
        breakevenRoas: null,
        historicalWindows: {
          last30: fallbackStrongWindow,
          last90: fallbackStrongWindow,
        },
      }),
    );

    expect(output.winnerMemory).toBe(true);
  });

  it("uses breakeven-relative ROAS when target context is unavailable", () => {
    const breakevenStrongWindow: HistoricalWindow = {
      ...strongWindow,
      spend: 300,
      purchases: 5,
      roas: 2.21,
    };
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: null,
        breakevenRoas: 2.0,
        historicalWindows: {
          last30: breakevenStrongWindow,
          last90: breakevenStrongWindow,
        },
      }),
    );

    expect(output.winnerMemory).toBe(true);
  });

  it("requires configured purchase depth for strong historical windows", () => {
    const lowPurchaseWindow: HistoricalWindow = {
      ...strongWindow,
      spend: 300,
      purchases: 2,
      roas: 10,
    };
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: 2.2,
        winnerMemoryMinPurchases: 3,
        historicalWindows: {
          last30: lowPurchaseWindow,
          last90: lowPurchaseWindow,
        },
      }),
    );

    expect(output.winnerMemory).toBe(false);
  });

  it("requires configured spend depth for strong historical windows", () => {
    const lowSpendWindow: HistoricalWindow = {
      ...strongWindow,
      spend: 100,
      purchases: 5,
      roas: 10,
    };
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: 2.2,
        winnerMemoryMinSpend: 150,
        historicalWindows: {
          last30: lowSpendWindow,
          last90: lowSpendWindow,
        },
      }),
    );

    expect(output.winnerMemory).toBe(false);
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

  it("watches non-winners when composite decay and pressure are present", () => {
    const weakHistoricalWindow: HistoricalWindow = {
      ...strongWindow,
      spend: 500,
      purchases: 4,
      roas: 1.2,
    };
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: 2.2,
        ctr: 1.1,
        roas: 0.8,
        clickToPurchaseRate: 0.03,
        spendConcentration: 0.7,
        historicalWindows: {
          last30: weakHistoricalWindow,
          last90: { ...weakHistoricalWindow, ctr: 1.9, clickToPurchaseRate: 0.07 },
        },
      }),
    );

    expect(output.winnerMemory).toBe(false);
    expect(output.status).toBe("watch");
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

describe("decay baseline spend floor", () => {
  it("ignores lucky low-spend windows as decay baseline when floors are set", () => {
    const luckyLowSpend: HistoricalWindow = {
      spend: 30,
      ctr: 5.0,
      roas: 9.0,
      clickToPurchaseRate: 0.2,
      purchases: 1,
    };
    const output = computeFatigue(
      makeInput({
        ctr: 2.0,
        roas: 4.0,
        winnerMemoryMinSpend: 150,
        winnerMemoryMinPurchases: 2,
        historicalWindows: {
          last14: luckyLowSpend,
          last30: strongWindow,
        },
      }),
    );
    // Baseline must be the floor-clearing window (roas 4.0), so current 4.0
    // shows no decay - the lucky 9.0 window would have faked ~55% decay.
    expect(output.roasDecay).toBe(0);
    expect(output.status).toBe("none");
  });

  it("reports decay as not assessable when no window clears the floor", () => {
    const output = computeFatigue(
      makeInput({
        winnerMemoryMinSpend: 1000,
        winnerMemoryMinPurchases: 10,
        historicalWindows: { last30: strongWindow },
      }),
    );
    expect(output.roasDecay).toBeNull();
    expect(
      output.missingContext.some((item) => item.includes("winner-memory")),
    ).toBe(true);
  });
});

describe("disjoint winner-memory shadow metric", () => {
  const window = (spend: number, purchases: number, roas: number): HistoricalWindow => ({
    spend,
    purchases,
    roas,
    ctr: 1,
    clickToPurchaseRate: 0.05,
  });

  it("derives disjoint bands from cumulative windows", () => {
    const bands = deriveDisjointWindows({
      last14: window(200, 2, 4.0),
      last30: window(500, 5, 3.0),
      last90: window(500, 5, 3.0),
    });
    // Band 1 = last14 itself; band 2 = 15..30 (spend 300, purchases 3,
    // revenue 1500-800=700 -> roas ~2.33); identical last90 adds nothing.
    expect(bands).toHaveLength(2);
    expect(bands[1].spend).toBe(300);
    expect(bands[1].purchases).toBe(3);
    expect(bands[1].roas).toBeCloseTo(700 / 300, 4);
  });

  it("a single strong stretch no longer double-counts via nesting in the shadow metric", () => {
    // One strong 14-day burst, nothing before it: cumulative windows
    // last14/last30/last90 all look strong (nested), but disjoint bands
    // beyond the burst have no purchases.
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: 2.0,
        winnerMemoryMinSpend: 100,
        winnerMemoryMinPurchases: 2,
        historicalWindows: {
          last14: window(400, 4, 4.0),
          last30: window(400, 4, 4.0),
          last90: window(400, 4, 4.0),
        },
      }),
    );
    // The LIVE metric counts all three nested windows as separate strong
    // windows - the exact double-count defect; the shadow metric does not.
    expect(output.winnerMemory).toBe(true);
    expect(output.disjointStrongWindows).toBe(1);
    expect(output.disjointWinnerMemory).toBe(false);
  });

  it("recognizes genuinely sustained strength across disjoint bands", () => {
    const output = computeFatigue(
      makeInput({
        effectiveTargetRoas: 2.0,
        winnerMemoryMinSpend: 100,
        winnerMemoryMinPurchases: 2,
        historicalWindows: {
          last14: window(400, 4, 4.0),
          last30: window(900, 9, 3.8),
        },
      }),
    );
    expect(output.disjointStrongWindows).toBe(2);
    expect(output.disjointWinnerMemory).toBe(true);
  });
});
