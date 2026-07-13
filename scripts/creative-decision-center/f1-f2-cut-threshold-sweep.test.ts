import { describe, expect, it } from "vitest";
import {
  summarizeWindow,
  type Episode,
} from "@/scripts/creative-decision-center/f1-f2-cut-threshold-sweep";

function episode(overrides: Partial<Episode> = {}): Episode {
  return {
    variantId: "V0_current",
    business: { id: "business-1", name: "Business 1" },
    asOfDate: "2026-01-01",
    creativeId: "creative-1",
    creativeName: null,
    campaignId: "campaign-1",
    source: "ratio_loss_budget",
    spend28: 100,
    purchases28: 1,
    roas28: 0.5,
    recent7Spend: 10,
    recent7Roas: 0.5,
    targetRoas: 2,
    breakEvenRoas: 1.5,
    forward14Spend: 20,
    forward14Roas: 0,
    forward28Spend: 30,
    forward28Roas: 0,
    spendUnit: 10,
    lossBudgetMultiplier: 2,
    hardCutMultiplier: 4,
    boundary: 0.7,
    purchaseFloor: null,
    purchaseFloorUsedFallback: false,
    lossBudgetGeHardCut: false,
    boundaryFallbackReason: null,
    ...overrides,
  };
}

describe("F1/F2 forward outcome summarization", () => {
  it("treats finite zero ROAS with positive spend as a known loser", () => {
    expect(summarizeWindow([episode()], 14)).toEqual({
      knownEpisodes: 1,
      unknownEpisodes: 0,
      recoveredAboveTarget: 0,
      earlyCutRate: 0,
      trueLoserEpisodes: 1,
      savedSpend: 20,
      savedSpendUnits: 2,
    });
  });

  it("keeps missing ROAS and zero forward spend censored", () => {
    const summary = summarizeWindow(
      [episode({ forward14Roas: null }), episode({ creativeId: "creative-2", forward14Spend: 0 })],
      14,
    );

    expect(summary.knownEpisodes).toBe(0);
    expect(summary.unknownEpisodes).toBe(2);
  });
});
