import { describe, expect, it } from "vitest";
import { buildCreativeOldRuleChallenger } from "@/lib/creative-old-rule-challenger";
import type { CreativeDecisionInputRow } from "@/lib/ai/generate-creative-decisions";

function row(overrides: Partial<CreativeDecisionInputRow>): CreativeDecisionInputRow {
  return {
    creativeId: "creative",
    name: "Creative",
    creativeFormat: "image",
    creativeAgeDays: 24,
    spendVelocity: 20,
    frequency: 1.4,
    spend: 200,
    purchaseValue: 300,
    roas: 1.5,
    cpa: 50,
    ctr: 1.2,
    cpm: 12,
    cpc: 0.8,
    purchases: 4,
    impressions: 12_000,
    linkClicks: 220,
    hookRate: 0,
    holdRate: 0,
    video25Rate: 0,
    watchRate: 0,
    video75Rate: 0,
    clickToPurchaseRate: 1.8,
    atcToPurchaseRate: 0.2,
    ...overrides,
  };
}

describe("buildCreativeOldRuleChallenger", () => {
  it("produces independent read-only challenger output", () => {
    const result = buildCreativeOldRuleChallenger([
      row({
        creativeId: "winner",
        spend: 420,
        purchaseValue: 1680,
        roas: 4,
        cpa: 30,
        purchases: 14,
        clickToPurchaseRate: 3.3,
      }),
      row({
        creativeId: "middle",
        spend: 280,
        purchaseValue: 420,
        roas: 1.5,
        cpa: 56,
        purchases: 5,
        clickToPurchaseRate: 1.7,
      }),
      row({
        creativeId: "weak",
        spend: 360,
        purchaseValue: 180,
        roas: 0.5,
        cpa: 180,
        purchases: 2,
        clickToPurchaseRate: 0.7,
      }),
    ]);

    const winner = result.find((item) => item.creativeId === "winner");

    expect(winner?.source).toBe("legacy_rule_challenger");
    expect(winner?.challengerAction).toMatch(/scale/);
    expect(winner?.metricsUsed.join(" ")).toContain("ROAS");
    expect(winner?.notPolicyAuthoritative).toBe(true);
  });

  it("cannot become push, queue, or apply eligible", () => {
    const result = buildCreativeOldRuleChallenger([
      row({
        creativeId: "winner",
        spend: 500,
        purchaseValue: 2000,
        roas: 4,
        purchases: 20,
        clickToPurchaseRate: 3.4,
      }),
      row({ creativeId: "peer", roas: 1.2, purchaseValue: 240 }),
    ]);

    expect(result[0]).toMatchObject({
      notPolicyAuthoritative: true,
      queueEligible: false,
      canApply: false,
    });
    expect(result[0]).not.toHaveProperty("pushReadiness");
  });
});
