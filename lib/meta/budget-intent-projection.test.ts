import { describe, expect, it } from "vitest";

import { META_BUDGET_INTENT_CONTRACT_VERSION } from "@/lib/meta/budget-intent-contract";
import { BUDGET_SIZING_POLICY_VERSION } from "@/lib/meta/budget-sizing-policy";
import {
  projectBudgetIntents,
  type BudgetIntentEntityContext,
} from "@/lib/meta/budget-intent-projection";
import type { MetaRecommendation } from "@/lib/meta/recommendations";

function context(
  overrides: Partial<BudgetIntentEntityContext> = {},
): BudgetIntentEntityContext {
  return {
    currentMinorUnits: 5000,
    budgetUniverse: "applicable",
    isBudgetMixed: false,
    funnelCohort: "purchase",
    roleAuthoritySatisfied: true,
    maturityOk: true,
    roas28d: 2.85,
    spend28d: 4200,
    purchases28d: 41,
    calibrationSampleSize: 64,
    hoursSinceLastChange: 96,
    changesLast7d: 0,
    accountShareBefore: 0.12,
    providerBaselineKnown: true,
    ...overrides,
  };
}

const POLICY = {
  maxBudgetIncreasePct: 15,
  perActionSpendCeilingMinor: 8000,
  perActionSpendCeilingCurrency: "USD",
  budgetMinHoursBetweenChanges: 24,
  budgetMaxChangesPer7d: 2,
  budgetMaxAccountConcentrationPct: 40,
  budgetSizingPolicyVersion: BUDGET_SIZING_POLICY_VERSION,
};

function rec(overrides: Partial<MetaRecommendation> = {}): MetaRecommendation {
  return {
    id: "rec-1",
    level: "adset",
    adsetId: "adset-1",
    campaignId: "camp-1",
    type: "adset_scale_budget",
    decisionState: "act",
    decisionLabel: "scale",
    recommendedAction: "Increase ad set budget 10-15% and watch CPA and ROAS.",
    ...overrides,
  } as MetaRecommendation;
}

describe("projecting a sized budget intent onto a decision", () => {
  it("writes the typed payload the candidate query matches on", () => {
    const result = projectBudgetIntents({
      recommendations: [rec()],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
    });

    expect(result.sized).toBe(1);
    expect(result.recommendations[0].targetValue).toMatchObject({
      contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
      direction: "increase",
      percent: 15,
      amountMinor: 5750,
      currentMinorUnits: 5000,
      sizingPolicyVersion: BUDGET_SIZING_POLICY_VERSION,
    });
  });

  it("carries the reason, not just the number", () => {
    // "15%" is not a reason, and a constraint is not evidence for an amount.
    const result = projectBudgetIntents({
      recommendations: [rec()],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
    });
    const value = result.recommendations[0].targetValue as {
      rationale: string[];
    };
    expect(value.rationale[0]).toMatch(/target/);
  });

  it("leaves the recommendation untouched when nothing can be sized", () => {
    const original = rec();
    const result = projectBudgetIntents({
      recommendations: [original],
      targetRoas: null,
      breakEvenRoas: null,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
    });
    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(original);
    // Counted by reason, so a surface can say why rather than showing nothing.
    expect(result.withheldByCode).toEqual({ target_roas_missing: 1 });
  });

  it("lets a produced pause own the entity", () => {
    const result = projectBudgetIntents({
      recommendations: [
        rec({
          type: "adset_cut_spend",
          decisionLabel: undefined,
        }),
      ],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context({ roas28d: 1.2 })]]),
    });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.pause_takes_precedence).toBe(1);
  });

  it("does not let a held cut suppress an executable scale on the same entity", () => {
    const heldCut = rec({
      id: "held-cut",
      type: "adset_cut_spend",
      decisionLabel: "cut",
      decisionState: "watch",
    });
    const scale = rec({ id: "act-scale", type: "adset_scale_budget" });
    const result = projectBudgetIntents({
      recommendations: [heldCut, scale],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
    });

    expect(result.sized).toBe(1);
    expect(result.recommendations[0]).toBe(heldCut);
    expect(result.recommendations[1]?.targetValue).toMatchObject({
      contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
      direction: "increase",
    });
    expect(result.withheldByCode.pause_takes_precedence).toBeUndefined();
  });

  it("never touches anomaly or state rows", () => {
    const rows = [
      rec({ kind: "anomaly" } as never),
      rec({ kind: "state" } as never),
    ];
    const result = projectBudgetIntents({
      recommendations: rows,
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
    });
    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(rows[0]);
    expect(result.recommendations[1]).toBe(rows[1]);
  });

  it("never gives watch, test, or missing-state rows a typed budget intent", () => {
    const rows = [
      rec({ id: "watch", decisionState: "watch" }),
      rec({ id: "test", decisionState: "test" }),
      rec({ id: "legacy", decisionState: undefined } as never),
    ];
    const result = projectBudgetIntents({
      recommendations: rows,
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
    });

    expect(result.sized).toBe(0);
    expect(result.withheldByCode).toEqual({});
    expect(result.recommendations).toHaveLength(rows.length);
    result.recommendations.forEach((row, index) => {
      expect(row).toBe(rows[index]);
      expect(row.targetValue).toBeUndefined();
    });
  });

  it("skips an entity it was given no context for", () => {
    // No context means nothing was read about this entity, which is not the
    // same as reading that it is ineligible.
    const result = projectBudgetIntents({
      recommendations: [rec({ adsetId: "adset-unknown" })],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map(),
    });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode).toEqual({});
  });

  it("refuses to type an act row when target provenance is unknown", () => {
    const original = rec();
    const result = projectBudgetIntents({
      recommendations: [original],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: false,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
    });

    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(original);
    expect(result.recommendations[0]?.targetValue).toBeUndefined();
    expect(result.withheldByCode).toEqual({ commercial_target_unknown: 1 });
  });

  it("never converts a bid-strategy tune into a budget decrease", () => {
    const original = rec({
      id: "bid-strategy-fit",
      level: "campaign",
      campaignId: "camp-1",
      adsetId: undefined,
      type: "bid_strategy_fit",
      decisionLabel: "tune",
      recommendedAction: "Loosen the bid constraint by 10%.",
    });
    const result = projectBudgetIntents({
      recommendations: [original],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["camp-1", context({ roas28d: 1.8 })]]),
    });

    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(original);
    expect(result.recommendations[0]?.targetValue).toBeUndefined();
    expect(result.withheldByCode).toEqual({ budget_action_type_ineligible: 1 });
  });

  it("lets an executable Cut own the entity even above break-even", () => {
    const original = rec({
      type: "adset_cut_spend",
      decisionLabel: undefined,
    });
    const result = projectBudgetIntents({
      recommendations: [original],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context({ roas28d: 1.8 })]]),
    });

    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(original);
    expect(result.withheldByCode).toEqual({ pause_takes_precedence: 1 });
  });

  it("sizes the explicit controlled-scale campaign type", () => {
    const result = projectBudgetIntents({
      recommendations: [rec({
        level: "campaign",
        campaignId: "camp-1",
        adsetId: undefined,
        type: "scenario_c1_controlled_scale",
      })],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["camp-1", context()]]),
    });

    expect(result.sized).toBe(1);
    expect(result.recommendations[0]?.targetValue).toMatchObject({
      contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
      direction: "increase",
    });
  });

  it("sizes only the volume branch whose type explicitly requests a campaign budget increase", () => {
    const eligible = rec({
      id: "lowest-cost-volume",
      level: "campaign",
      campaignId: "camp-1",
      adsetId: undefined,
      type: "scale_for_volume_budget_increase",
    });
    const constrained = ["target-roas", "cost-cap", "bid-cap", "manual-bid"].map(
      (id) => rec({
        id,
        level: "campaign",
        campaignId: id,
        adsetId: undefined,
        type: "scale_for_volume",
      }),
    );
    const result = projectBudgetIntents({
      recommendations: [eligible, ...constrained],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([
        ["camp-1", context()],
        ...constrained.map((row) => [row.campaignId!, context()] as const),
      ]),
    });

    expect(result.sized).toBe(1);
    expect(result.recommendations[0]?.targetValue).toMatchObject({
      contractVersion: META_BUDGET_INTENT_CONTRACT_VERSION,
      direction: "increase",
    });
    for (const row of result.recommendations.slice(1)) {
      expect(row.targetValue).toBeUndefined();
    }
    expect(result.withheldByCode).toEqual({
      budget_action_type_ineligible: 4,
    });
  });

  it.each([
    ["campaign-only controlled scale at ad-set grain", rec({
      type: "scenario_c1_controlled_scale",
    })],
    ["ad-set scale at campaign grain", rec({
      level: "campaign",
      campaignId: "camp-1",
      adsetId: undefined,
      type: "adset_scale_budget",
    })],
  ])("refuses the crossed semantic tuple: %s", (_label, original) => {
    const result = projectBudgetIntents({
      recommendations: [original],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      budgetActionAuthority: true,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([
        ["adset-1", context()],
        ["camp-1", context()],
      ]),
    });

    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(original);
    expect(result.recommendations[0]?.targetValue).toBeUndefined();
    expect(result.withheldByCode).toEqual({
      budget_action_semantic_mismatch: 1,
    });
  });
});
