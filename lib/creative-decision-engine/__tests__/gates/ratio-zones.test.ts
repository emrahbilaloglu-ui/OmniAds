import { describe, expect, it } from "vitest";
import { defaultBusinessConfig } from "../../config";
import { ratioZonesGate } from "../../gates/ratio-zones";
import type { GateContext } from "../../gates/types";
import type {
  AccountCalibration,
  BusinessConfig,
  CreativeInput,
} from "../../types";
import {
  makeAccountCalibration,
  makeCreativeInput,
  makeGateContext,
} from "../helpers";

const TARGET_ROAS = 2.0;

function ratioContext(
  ratio: number | null,
  overrides: {
    input?: Partial<CreativeInput>;
    businessConfig?: Partial<BusinessConfig>;
    calibration?: Partial<AccountCalibration>;
    gate?: Partial<
      Omit<GateContext, "input" | "businessConfig" | "calibration">
    >;
  } = {},
): GateContext {
  const businessConfig = {
    ...defaultBusinessConfig("biz-1"),
    ...overrides.businessConfig,
  };
  const roas = ratio === null ? null : TARGET_ROAS * ratio;
  const input = makeCreativeInput({
    spend: 600,
    purchases: 10,
    roas,
    recent7dSpend: 80,
    recent7dRoas: TARGET_ROAS,
    fatigueStatus: "none",
    targetRoas: TARGET_ROAS,
    lifecyclePosition: "past_peak_natural",
    daysSincePeak: 4,
    ...overrides.input,
  });

  return makeGateContext({
    input,
    businessConfig,
    calibration: makeAccountCalibration(overrides.calibration),
    gate: {
      effectiveTargetRoas: TARGET_ROAS,
      truthSource: "commercial_truth",
      ratioToTarget: ratio,
      ...overrides.gate,
    },
  });
}

function terminalOutput(result: ReturnType<typeof ratioZonesGate>) {
  if (result.kind !== "terminal") {
    throw new Error("Expected terminal ratio zones result.");
  }
  return result.output;
}

describe("ratioZonesGate - scale zone", () => {
  it("scales mature winners with recent 7d holding", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.reason).toBe(
      "ROAS 3.00 (28d) = 150% of target 2.00 with 15 purchases (28d) and recent 7d holding at 2.20 — scale the ad set budget.",
    );
  });

  it("keeps scale-zone creatives without enough purchases for scale", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 8,
            recent7dRoas: 2.2,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[near scale] ROAS 3.00 (28d) = 150% of target — only 8 purchases (28d), need ≥10 for scale; observe.",
    );
    expect(output.reason.startsWith("[near scale]")).toBe(true);
    expect(output.reason).toContain("only 8 purchases");
  });

  it("keeps scale-zone creatives when recent 7d ROAS is missing", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason.startsWith("[near scale]")).toBe(true);
    expect(output.reason).toContain("recent 7d ROAS missing");
  });

  it("keeps scale label unchanged and adds fatigued badge", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
            fatigueStatus: "fatigued",
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.badges).toEqual([
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });
});

describe("ratioZonesGate - target band", () => {
  it("keeps creatives at target without fatigue", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(1.0)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[at target] ROAS 2.00 (28d) at/around target 2.00 (100%) — stable, let it run.",
    );
    expect(output.reason.startsWith("[at target]")).toBe(true);
    expect(output.badges).toEqual([]);
  });

  it("keeps creatives at target and adds fatigue watch badge", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "watch",
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[at target] ROAS 2.00 (28d) at/around target 2.00 (100%) — stable, let it run; fatigue watch — monitor for refresh signal.",
    );
    expect(output.reason.startsWith("[at target]")).toBe(true);
    expect(output.badges).toEqual([
      {
        type: "fatigue_watch",
        label: "Fatigue watch",
        severity: "warning",
      },
    ]);
  });

  it("refreshes fatigued creatives when recent 7d ROAS has decayed", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.4,
            recent7dSpend: 80,
            lifecyclePosition: "plateau",
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toBe(
      "Fatigued + recent 7d ROAS 1.40 dropped to 70% of ROAS 2.00 (28d) — replace creative with new iteration.",
    );
  });

  it("keeps fatigued creatives when recent 7d ROAS is holding", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.9,
            recent7dSpend: 80,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.badges).toEqual([
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });

  it("keeps fatigued creatives when recent sample size is insufficient", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.4,
            recent7dSpend: 20,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
  });
});

describe("ratioZonesGate - cut zone", () => {
  it("cuts clear losers at scale", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 1500,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toBe(
      "ROAS 1.00 (28d) = 50% of target after $1,500 spend (28d) — clear loser at scale.",
    );
  });

  it("cuts sustained losers before full cut maturity", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.3, {
          input: {
            spend: 700,
          },
        }),
      ),
    );

    expect(output.label).toBe("cut");
    expect(output.reason).toBe(
      "ROAS 0.60 (28d) = 30% of target after $700 spend (28d) — sustained loser.",
    );
  });

  it("returns test_more below cut maturity without fatigue", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 700,
          },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "ROAS 1.00 (28d) = 50% of target after $700 spend (28d) — underperforming but spend not yet mature for hard cut, observe or pause manually.",
    );
  });

  it("refreshes below cut maturity when fatigued", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.5, {
          input: {
            spend: 700,
            fatigueStatus: "fatigued",
            lifecyclePosition: "plateau",
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toBe(
      "ROAS 1.00 (28d) = 50% of target and fatigued — replace with fresh iteration.",
    );
  });
});

describe("ratioZonesGate - working zone", () => {
  it("keeps working-zone creatives and adds weak performance badge", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(0.75)));

    expect(output.label).toBe("keep");
    expect(output.reason).toBe(
      "[weak zone] ROAS 1.50 (28d) = 75% of target — below target but in working zone, no aggressive action; revisit if ROAS drifts further.",
    );
    expect(output.reason.startsWith("[weak zone]")).toBe(true);
    expect(output.badges).toEqual([
      {
        type: "weak_performance",
        label: "Below target",
        severity: "warning",
      },
    ]);
  });

  it("refreshes fatigued working-zone creatives when recent decay fires", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.05,
            recent7dSpend: 80,
            lifecyclePosition: "plateau",
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toBe(
      "ROAS 1.50 (28d) = 75% of target and fatigued with recent 7d ROAS 1.05 decaying — iterate.",
    );
  });

  it("keeps fatigued working-zone creatives without recent decay", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.43,
            recent7dSpend: 80,
          },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.badges).toEqual([
      {
        type: "weak_performance",
        label: "Below target",
        severity: "warning",
      },
      {
        type: "fatigue_fatigued",
        label: "Fatigued",
        severity: "warning",
      },
    ]);
  });
});

describe("ratioZonesGate - edge cases", () => {
  it("returns test_more when ratioToTarget is null", () => {
    const output = terminalOutput(ratioZonesGate(ratioContext(null)));

    expect(output.label).toBe("test_more");
    expect(output.reason).toBe(
      "ROAS unavailable (28d) — cannot evaluate against target.",
    );
  });

  it("uses refresh ratio fallback when calibration is unavailable", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.6,
            recent7dSpend: 80,
          },
          calibration: {
            refreshRatioP10: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
  });
});

describe("ratioZonesGate - lifecycle reason hints", () => {
  it("appends a momentum hint for rising scale decisions", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
            lifecyclePosition: "rising",
            daysSincePeak: 2,
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.reason).toContain("; momentum: rising (peak 2d ago)");
  });

  it("leaves scale reasons unchanged when lifecycle is null", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.5, {
          input: {
            purchases: 15,
            recent7dRoas: 2.2,
            lifecyclePosition: null,
          },
        }),
      ),
    );

    expect(output.label).toBe("scale");
    expect(output.reason).toBe(
      "ROAS 3.00 (28d) = 150% of target 2.00 with 15 purchases (28d) and recent 7d holding at 2.20 — scale the ad set budget.",
    );
  });

  it("appends an operator review hint for at-target unclear post-peak keep decisions", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(1.0, {
          input: { lifecyclePosition: "past_peak_unclear" },
        }),
      ),
    );

    expect(output.label).toBe("keep");
    expect(output.reason).toContain("; lifecycle: past_peak_unclear");
  });

  it("appends lifecycle context for natural post-peak refresh decisions", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(0.75, {
          input: {
            fatigueStatus: "fatigued",
            recent7dRoas: 1.05,
            recent7dSpend: 80,
            lifecyclePosition: "past_peak_natural",
          },
        }),
      ),
    );

    expect(output.label).toBe("refresh");
    expect(output.reason).toContain("; lifecycle: past_peak_natural");
  });

  it("does not append lifecycle hints to test_more reasons", () => {
    const output = terminalOutput(
      ratioZonesGate(
        ratioContext(null, {
          input: { lifecyclePosition: "rising" },
        }),
      ),
    );

    expect(output.label).toBe("test_more");
    expect(output.reason).not.toContain("; lifecycle:");
    expect(output.reason).not.toContain("; momentum:");
  });
});
