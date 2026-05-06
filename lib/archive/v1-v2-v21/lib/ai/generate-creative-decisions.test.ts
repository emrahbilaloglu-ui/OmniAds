import { describe, expect, it } from "vitest";
import {
  buildHeuristicCreativeDecisions,
  type CreativeDecisionInputRow,
} from "@/lib/ai/generate-creative-decisions";

function creative(overrides: Partial<CreativeDecisionInputRow> = {}): CreativeDecisionInputRow {
  return {
    creativeId: "cr-1",
    name: "Creative 1",
    creativeFormat: "image",
    creativeAgeDays: 14,
    spendVelocity: 20,
    frequency: 1.2,
    spend: 300,
    purchaseValue: 1200,
    roas: 4,
    cpa: 30,
    ctr: 2.5,
    cpm: 12,
    cpc: 1.1,
    purchases: 10,
    impressions: 10000,
    linkClicks: 400,
    hookRate: 20,
    holdRate: 0,
    video25Rate: 0,
    watchRate: 0,
    video75Rate: 0,
    clickToPurchaseRate: 2.5,
    atcToPurchaseRate: 30,
    historicalWindows: null,
    ...overrides,
  };
}

describe("buildHeuristicCreativeDecisions", () => {
  it("avoids scale hard when selected strength lacks historical support", () => {
    const rows = [
      creative({
        creativeId: "spike",
        name: "Spike",
        spend: 500,
        purchaseValue: 2500,
        roas: 5,
        purchases: 8,
        historicalWindows: {
          last7: { spend: 180, purchaseValue: 200, roas: 1.11, cpa: 90, ctr: 1.2, purchases: 2, impressions: 5000, linkClicks: 120, hookRate: 12, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 0.8, atcToPurchaseRate: 10 },
          last30: { spend: 220, purchaseValue: 260, roas: 1.18, cpa: 95, ctr: 1.1, purchases: 2, impressions: 6000, linkClicks: 130, hookRate: 11, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 0.9, atcToPurchaseRate: 12 },
          allHistory: { spend: 250, purchaseValue: 300, roas: 1.2, cpa: 100, ctr: 1.05, purchases: 2, impressions: 6500, linkClicks: 140, hookRate: 10, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 1, atcToPurchaseRate: 12 },
        },
      }),
      creative({ creativeId: "peer-1", name: "Peer 1", roas: 2.2, spend: 400, purchaseValue: 1200, purchases: 7, cpa: 57 }),
      creative({ creativeId: "peer-2", name: "Peer 2", roas: 2, spend: 350, purchaseValue: 1050, purchases: 6, cpa: 58 }),
    ];

    const decision = buildHeuristicCreativeDecisions(rows).find((item) => item.creativeId === "spike");
    expect(decision?.action).not.toBe("scale_hard");
  });

  it("keeps comeback-style failures in test_more when historical windows show the creative used to work", () => {
    const rows = [
      creative({
        creativeId: "fatigue",
        name: "Fatigue",
        spend: 600,
        purchaseValue: 0,
        roas: 0,
        purchases: 0,
        cpa: 0,
        historicalWindows: {
          last14: { spend: 400, purchaseValue: 1200, roas: 3, cpa: 40, ctr: 2.2, purchases: 10, impressions: 9000, linkClicks: 330, hookRate: 18, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 2.4, atcToPurchaseRate: 28 },
          last30: { spend: 450, purchaseValue: 1350, roas: 3, cpa: 42, ctr: 2.1, purchases: 10, impressions: 9500, linkClicks: 340, hookRate: 18, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 2.3, atcToPurchaseRate: 27 },
          last90: { spend: 500, purchaseValue: 1500, roas: 3, cpa: 45, ctr: 2, purchases: 11, impressions: 11000, linkClicks: 370, hookRate: 17, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 2.2, atcToPurchaseRate: 26 },
        },
      }),
      creative({ creativeId: "peer-a", roas: 2.1, spend: 420, purchaseValue: 1000, purchases: 6, cpa: 70 }),
      creative({ creativeId: "peer-b", roas: 2.0, spend: 380, purchaseValue: 950, purchases: 6, cpa: 63 }),
    ];

    const decision = buildHeuristicCreativeDecisions(rows).find((item) => item.creativeId === "fatigue");
    expect(decision?.action).toBe("test_more");
  });

  it("keeps light selected-range rows in test_more when historical support is strong", () => {
    const rows = [
      creative({
        creativeId: "light",
        spend: 40,
        purchaseValue: 120,
        roas: 3,
        purchases: 1,
        historicalWindows: {
          last7: { spend: 300, purchaseValue: 900, roas: 3, cpa: 50, ctr: 2, purchases: 6, impressions: 8000, linkClicks: 250, hookRate: 15, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 2, atcToPurchaseRate: 24 },
          last30: { spend: 320, purchaseValue: 960, roas: 3, cpa: 53, ctr: 1.9, purchases: 6, impressions: 8500, linkClicks: 260, hookRate: 14, holdRate: 0, video25Rate: 0, watchRate: 0, video75Rate: 0, clickToPurchaseRate: 1.9, atcToPurchaseRate: 23 },
        },
      }),
      creative({ creativeId: "peer-x", spend: 500, purchaseValue: 1000, roas: 2, purchases: 5, cpa: 100 }),
      creative({ creativeId: "peer-y", spend: 520, purchaseValue: 1040, roas: 2, purchases: 5, cpa: 104 }),
    ];

    const decision = buildHeuristicCreativeDecisions(rows).find((item) => item.creativeId === "light");
    expect(decision?.action).toBe("test_more");
  });
});
