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
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
      pausedEntityIds: new Set(),
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
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
      pausedEntityIds: new Set(),
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
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
      pausedEntityIds: new Set(),
    });
    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(original);
    // Counted by reason, so a surface can say why rather than showing nothing.
    expect(result.withheldByCode).toEqual({ target_roas_missing: 1 });
  });

  it("lets a produced pause own the entity", () => {
    const result = projectBudgetIntents({
      recommendations: [rec({ decisionLabel: "cut", roas28d: 1.2 } as never)],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context({ roas28d: 1.2 })]]),
      pausedEntityIds: new Set(["adset-1"]),
    });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode.pause_takes_precedence).toBe(1);
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
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map([["adset-1", context()]]),
      pausedEntityIds: new Set(),
    });
    expect(result.sized).toBe(0);
    expect(result.recommendations[0]).toBe(rows[0]);
    expect(result.recommendations[1]).toBe(rows[1]);
  });

  it("skips an entity it was given no context for", () => {
    // No context means nothing was read about this entity, which is not the
    // same as reading that it is ineligible.
    const result = projectBudgetIntents({
      recommendations: [rec({ adsetId: "adset-unknown" })],
      targetRoas: 2,
      breakEvenRoas: 1.6,
      accountCurrency: "USD",
      policy: POLICY,
      contextByEntityId: new Map(),
      pausedEntityIds: new Set(),
    });
    expect(result.sized).toBe(0);
    expect(result.withheldByCode).toEqual({});
  });
});
