import { describe, expect, it } from "vitest";
import {
  adChallengerFamilyCounts,
  buildAdChallengerGrid,
  buildAdSmokeGrid,
} from "./ad-challenger-grid";

describe("ad challenger grid", () => {
  it("enumerates the complete bounded ad decision matrix", () => {
    const grid = buildAdChallengerGrid();
    expect(grid).toHaveLength(499);
    expect(adChallengerFamilyCounts(grid)).toEqual({
      V0: 1,
      H1: 144,
      H2: 100,
      H3: 16,
      H4: 60,
      H5: 120,
      H6: 36,
      H8: 16,
      HC: 6,
    });
    expect(new Set(grid.map((candidate) => candidate.id)).size).toBe(
      grid.length,
    );
  });

  it("keeps each family single-axis relative to the baseline", () => {
    const grid = buildAdChallengerGrid();
    const baseline = grid[0]!;
    const allowedByFamily: Record<string, Set<string>> = {
      H1: new Set([
        "calibrationHalfLifeDays",
        "calibrationShrinkageKappa",
        "calibrationQuantile",
      ]),
      H2: new Set([
        "lossBudgetMultiplier",
        "zeroConvBurnerMultiplier",
        "hardCutMultiplier",
      ]),
      H3: new Set(["cutBoundaryMode", "cutPurchaseFloorMode"]),
      H4: new Set([
        "relativeWinnerQuantile",
        "budgetScaleTargetRatio",
        "scalePurchaseMultiplier",
        "cutBoundaryMode",
      ]),
      H5: new Set([
        "fatigueDecayThreshold",
        "fatigueConcentrationThreshold",
        "fatigueFrequencyQuantile",
        "fatigueRequiredDecayCount",
      ]),
      H6: new Set([
        "funnelWeakMultiplier",
        "funnelConfidenceFloor",
        "funnelEffectiveSampleFloor",
      ]),
      H8: new Set(["nonPurchaseWeightMode", "nonPurchaseDepthGate"]),
    };
    for (const candidate of grid.slice(1)) {
      if (candidate.family === "HC") continue;
      const changed = Object.keys(candidate).filter(
        (key) =>
          !["id", "family", "label"].includes(key) &&
          candidate[key as keyof typeof candidate] !==
            baseline[key as keyof typeof baseline],
      );
      expect(
        changed.every((field) => allowedByFamily[candidate.family]!.has(field)),
        `${candidate.id}: ${changed.join(", ")}`,
      ).toBe(true);
    }
  });

  it("provides one deterministic smoke representative per implemented family", () => {
    const smoke = buildAdSmokeGrid();
    expect(smoke.map((candidate) => candidate.id)).toEqual([
      "V0_current",
      "H1_hl28_k16_q0p25",
      "H2_loss1p5_zero3_hard4",
      "H2_loss2p5_zero3_hard4",
      "H3_below_both_none",
      "H3_below_both_half_winner_p50",
      "H4_rel0p75_target1p2_purchase1",
      "H5_decay0p15_con0p55_freq0p7_count2",
      "H5_decay0p25_con0p7_freq0p8_count2",
      "H6_weak0p5_confidence0p65_sample20",
      "H8_goal_result_depth3",
    ]);
  });
});
